/**
 * Pi 子代理扩展：注册 submit_task_result 工具，让普通任务的报告与 FINAL_HANDOFF 经单一渲染器
 * 落盘并当场跑 handoff 机械自检，替代"子代理手写 YAML handoff 再用 bash 调 checker"的链路。
 *
 * 运行约定（由 run-pi-task.mjs 注入）：
 * - PI_TASK_RESULT_TASK_PACKAGE_PATH：任务包 JSON（verdict 闭集、required_sections、业务门取值的真源）。
 * - PI_TASK_RESULT_REPORT_PATH / PI_TASK_RESULT_HANDOFF_PATH：canonical 报告与 handoff 的绝对路径。
 * - PI_TASK_RESULT_PAYLOAD_PATH：提交负载与自检结果的落盘路径（outDir/task-result.json，runner 事后读取）。
 * - PI_TASK_RESULT_HANDOFF_CHECK：可选，runtime 下发的 checker 规格 JSON {argv, cwd, env}；缺省只渲染不复验。
 * - PI_WRITE_DOMAIN：可选，runner 注入的路径型写工具审计规格；存在时由审计生成 scope_compliant。
 * 校验与渲染实现见 task_result_synthesis.mjs，单一真源。
 * 模型输入便利层：本工具把 prepareTaskResultArguments 挂到 SDK 的 prepareArguments（schema 校验与 execute 之前生效）：
 * payload_path 指向的 JSON 文件读入后与内联参数走同一条归一；schema_version 可省略（工具补数字 1），已观察到的
 * JSON 字符串包装无损还原，verdict 越出本任务闭集时给短错误，形状无法解释时给有界短错误，避免 SDK 校验错误把整份
 * 长报告回显给模型。参数 schema 按本任务包生成：verdict 列出本任务闭集，sections 列出本任务必需章节。
 * 业务语义（必需章节、业务门、引用路径）仍在 execute 里判定。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  TASK_RESULT_TOOL_NAME,
  TASK_RESULT_V1_JSON_SCHEMA,
  acceptVerdicts,
  normalizeTaskResultArguments,
  requiredSections,
  parseHandoffCheckSpec,
  runHandoffCheck,
  writeTaskResultOutputs,
} from "./task_result_synthesis.mjs";
import {
  PI_CHILD_WRITE_DOMAIN_PROFILE,
  WRITE_DOMAIN_ENV,
  evaluateReportedWriteScope,
  evaluateWriteDomain,
  normalizeDomainPath,
  parseWriteDomainSpec,
  summarizeWriteDomainAudit,
} from "./pi_write_domain_extension.mjs";

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}

function taskPackageFromFile(taskPackagePath) {
  const parsed = JSON.parse(readFileSync(taskPackagePath, "utf8"));
  const body = parsed && typeof parsed === "object" && parsed.task_package && typeof parsed.task_package === "object"
    ? parsed.task_package
    : parsed;
  if (!body || typeof body !== "object" || !body.package_id) throw new Error("task package JSON has no task package body");
  return body;
}

// 参数 schema 按本任务包生成：模型直接看到本任务的 verdict 取值与必需章节，不必去任务卡里对照。
// 必需章节不进 required：未完成类 verdict 允许缺节，由 execute 的校验器按 verdict 判定。
export function taskResultParameterSchema(taskPackage) {
  const schema = JSON.parse(JSON.stringify(TASK_RESULT_V1_JSON_SCHEMA));
  schema.required = [];
  schema.properties.payload_path = {
    type: "string",
    description: "可选：交卷内容已写成 JSON 文件时只传这个路径（相对当前工作目录或绝对路径），文件里的字段与内联参数相同；用它时不要再传其他字段",
  };
  const verdicts = taskPackage ? acceptVerdicts(taskPackage) : [];
  if (verdicts.length) {
    schema.properties.verdict = {
      type: "string",
      enum: verdicts,
      description: `必填（用 payload_path 时写在文件里）；本任务取 ${verdicts.join(" | ")} 之一`,
    };
  }
  const sections = taskPackage ? requiredSections(taskPackage) : [];
  if (sections.length) {
    schema.properties.sections.properties = Object.fromEntries(sections.map((name) => [name, { type: "string", description: `「${name}」一节的 Markdown 正文` }]));
    schema.properties.sections.description = `必填（用 payload_path 时写在文件里）；本任务必需章节：${sections.join("、")}。partial、needs_owner、needs_split 可缺节，其余 verdict 每节都要非空；键为章节名，值为 Markdown 正文，可追加额外章节`;
  }
  schema.properties.summary = { ...schema.properties.summary, description: `${schema.properties.summary.description}（用 payload_path 时写在文件里）` };
  return schema;
}

// payload_path 读入后与内联参数走同一条归一；verdict 越出本任务闭集时在 SDK 校验之前给短错误。
export function prepareTaskResultArguments(raw, taskPackage = null, cwd = process.cwd()) {
  let input = raw;
  if (input && typeof input === "object" && !Array.isArray(input) && input.payload_path !== undefined) {
    const { payload_path: payloadFile, schema_version: _version, ...inline } = input;
    if (typeof payloadFile !== "string" || !payloadFile.trim()) {
      throw new Error("submit_task_result input error: payload_path must be a non-empty file path string.");
    }
    if (Object.keys(inline).length) {
      throw new Error(`submit_task_result input error: pass payload_path alone; also received ${Object.keys(inline).slice(0, 8).join(", ")}.`);
    }
    const file = path.resolve(cwd, payloadFile.trim());
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`submit_task_result input error: payload_path cannot be read: ${file} (${error?.code || error?.message || error}).`);
    }
    try {
      input = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new Error(`submit_task_result input error: payload_path is not valid JSON: ${file} (${String(error?.message || error).slice(0, 160)}).`);
    }
  }
  const normalized = normalizeTaskResultArguments(input);
  const verdicts = taskPackage ? acceptVerdicts(taskPackage) : [];
  const verdict = String(normalized.verdict || "").trim();
  if (verdicts.length && !verdicts.includes(verdict)) {
    throw new Error(`submit_task_result input error: verdict must be one of ${verdicts.join(" | ")}; received ${JSON.stringify(verdict).slice(0, 40)}.`);
  }
  return normalized;
}

function scopeValidation(taskPackage, candidate, reportPath, handoffPath, spec, cwd) {
  // 未下发写域规格是未配置，不是越界：compliant 为 null，不触发父级复核。
  if (!spec) {
    return {
      compliant: null,
      source: "not_configured",
      audit_complete: null,
      violation_count: 0,
      blocked_count: 0,
      reported_violation_count: 0,
      reported_violations: [],
      audit_errors: [],
      audit_path: null,
    };
  }
  const runtime = taskPackage?.runtime_context && typeof taskPackage.runtime_context === "object"
    ? taskPackage.runtime_context
    : {};
  const baseDirs = [...new Set([
    cwd,
    runtime.target_repo,
    runtime.output_root,
    runtime.cwd,
  ].map((item) => String(item || "")).filter(Boolean))];
  const trustedOutputViolations = [reportPath, handoffPath].filter((outputPath) => {
    const resolved = normalizeDomainPath(outputPath, cwd, spec.caseInsensitive);
    return !evaluateWriteDomain(resolved, spec).allowed;
  });
  if (trustedOutputViolations.length) {
    throw new Error(`submit_task_result output is outside the Core direct write domain: ${trustedOutputViolations.join(", ")}`);
  }
  const audit = summarizeWriteDomainAudit({ logPath: spec.log });
  const reportedViolations = evaluateReportedWriteScope(candidate?.scope_actual, spec, baseDirs);
  return {
    compliant: audit.scope_compliant && reportedViolations.length === 0,
    source: PI_CHILD_WRITE_DOMAIN_PROFILE,
    audit_complete: audit.audit_complete,
    violation_count: audit.blocked_count + reportedViolations.length,
    blocked_count: audit.blocked_count,
    reported_violation_count: reportedViolations.length,
    reported_violations: reportedViolations,
    audit_errors: audit.audit_errors,
    audit_path: spec.log,
  };
}

// 一次交卷：归一参数、写域审计、渲染报告与 FINAL_HANDOFF、handoff 自检、落交卷记录。
// 工具 execute 与 runner 代收交卷文件共用这一条路径，返回给模型或 runner 的是同一份结果。
export function submitTaskResult({ raw, taskPackagePath, reportPath, handoffPath, payloadPath, checkSpec, writeDomainSpec, cwd = process.cwd() }) {
  // pi 可能复用参数对象引用；校验会归一化，先深拷隔离。
  const candidate = JSON.parse(JSON.stringify(raw ?? {}));
  let taskPackage;
  try {
    taskPackage = taskPackageFromFile(taskPackagePath);
  } catch (error) {
    return { ok: false, saved: false, errors: [`task package unavailable: ${error?.message || error}`] };
  }
  let written;
  let writeScopeValidation;
  try {
    // 直接 execute 的调用方（测试、复用入口）与 SDK prepareArguments 走同一输入层：
    // 补固定版本、还原 JSON 字符串包装、给有界短错误；重复归一化是幂等的。
    const normalized = prepareTaskResultArguments(candidate, taskPackage, cwd);
    writeScopeValidation = scopeValidation(taskPackage, normalized, reportPath, handoffPath, writeDomainSpec, cwd);
    written = writeTaskResultOutputs({
      payload: normalized,
      taskPackage,
      reportPath,
      handoffPath,
      fallbackRoot: cwd,
      scopeValidation: writeScopeValidation,
    });
  } catch (error) {
    return {
      ok: false,
      saved: false,
      errors: [String(error?.message || error)],
      hint: "结果未保存。修正上述字段后再提交一次。",
    };
  }
  const handoffCheck = runHandoffCheck(checkSpec);
  const record = {
    submitted_at: new Date().toISOString(),
    report_path: reportPath,
    handoff_path: handoffPath,
    handoff_check: handoffCheck,
    scope_validation: writeScopeValidation,
    result: written.result,
  };
  mkdirSync(path.dirname(payloadPath), { recursive: true });
  writeFileSync(payloadPath, `${JSON.stringify(record, null, 2)}
`, "utf8");
  // checker 自身故障（spawn 失败、无输出、输出无法解析）记为 error：结果已保存，由父级重新校验，不让模型重交。
  if (handoffCheck.checked && !["pass", "error"].includes(handoffCheck.status)) {
    return {
      ok: false,
      saved: true,
      report_path: reportPath,
      handoff_path: handoffPath,
      handoff_check: handoffCheck,
      hint: "报告与 handoff 已写出但机械自检未通过。按 issues 修正后再提交一次。",
    };
  }
  const scopeViolation = writeScopeValidation?.compliant === false;
  const checkNote = {
    pass: "交付完成",
    not_configured: "交付完成；本任务未配置 handoff 自检，结果已保存但未经机械校验",
    error: "结果已保存；handoff 自检器本身运行失败，与结果内容无关，父级会重新校验，无需再提交",
  }[handoffCheck.status];
  return {
    ok: true,
    saved: true,
    report_path: reportPath,
    handoff_path: handoffPath,
    verdict: written.result.verdict,
    handoff_check: handoffCheck,
    handoff_check_status: handoffCheck.status,
    scope_compliant: writeScopeValidation?.compliant ?? null,
    write_domain_violation_count: writeScopeValidation?.violation_count ?? 0,
    requires_parent_review: scopeViolation || handoffCheck.status === "error",
    note: scopeViolation
      ? `${checkNote}；写域证据不合规，父级必须复核。最终回复一句话写明任务状态、报告路径和越界事实。`
      : `${checkNote}。最终回复一句话写明任务状态与报告路径即可，不再重写报告正文。`,
  };
}

export default function (pi) {
  const env = (name) => String(process.env[name] || "").trim();
  const taskPackagePath = env("PI_TASK_RESULT_TASK_PACKAGE_PATH");
  const reportPath = env("PI_TASK_RESULT_REPORT_PATH");
  const handoffPath = env("PI_TASK_RESULT_HANDOFF_PATH");
  const payloadPath = env("PI_TASK_RESULT_PAYLOAD_PATH");
  if (!taskPackagePath || !reportPath || !handoffPath || !payloadPath) return;
  const checkSpec = parseHandoffCheckSpec(env("PI_TASK_RESULT_HANDOFF_CHECK"));
  const writeDomainSpec = env(WRITE_DOMAIN_ENV) ? parseWriteDomainSpec(env(WRITE_DOMAIN_ENV)) : null;
  // 注册时读一次任务包生成本任务的参数 schema；读不到直接抛出，扩展加载失败可见，不注册缺闭集的通用 schema。
  const registeredTaskPackage = taskPackageFromFile(taskPackagePath);

  pi.registerTool({
    name: TASK_RESULT_TOOL_NAME,
    label: "Submit Task Result",
    // 自定义工具不设 promptSnippet 就不进系统提示词的工具清单（Pi docs/extensions.md）。09-25 grok 截断续跑：
    // 缺清单条目时长上下文下交卷调用 3/3 被 shell 空转吸走，补上后 2/2 自行交卷，其余条件不变。
    promptSnippet: "Submit the task result from a JSON file (payload_path); this is how the task is delivered",
    promptGuidelines: ["When the work is done, deliver it by calling submit_task_result with payload_path set to the result JSON file you wrote (without a file-writing tool, pass the fields inline); submit_task_result is a tool call, not a shell command."],
    description: [
      "提交本任务结果：工具按任务包校验（verdict 取值、必需章节、业务门、引用路径存在），通过后写出报告与 FINAL_HANDOFF ",
      "并运行 handoff 自检。先用写文件工具把参数写成 JSON 文件，再只传 payload_path 提交；没有写文件工具时直接内联传参。",
      "返回 ok:false 时按 errors/issues 修正后再提交一次。scope_compliant 由写域审计生成，不接受自报。",
      "返回 ok:true 即交付完成；最终回复一句话写明任务状态与报告路径，不再重写报告正文。",
    ].join(""),
    parameters: taskResultParameterSchema(registeredTaskPackage),
    // SDK 在 schema 校验与 execute 之前调用本钩子：读 payload_path、补固定版本、还原 JSON 字符串包装、
    // 核对 verdict 闭集，形状无法解释时抛短错误，避免 SDK 校验错误把整份长报告回显给模型。
    prepareArguments: (raw) => prepareTaskResultArguments(raw, registeredTaskPackage),
    execute: async (_toolCallId, params) => textResult(submitTaskResult({
      raw: params,
      taskPackagePath,
      reportPath,
      handoffPath,
      payloadPath,
      checkSpec,
      writeDomainSpec,
    })),
  });
}
