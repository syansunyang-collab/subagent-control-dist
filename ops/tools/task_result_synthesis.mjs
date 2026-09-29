#!/usr/bin/env node
/**
 * 普通（非 structured review）任务的结构化交付：task_result_v1 → canonical report + FINAL_HANDOFF。
 *
 * submit_task_result 工具（pi_task_result_extension.mjs）与 runner 共用本模块：参数即 schema，
 * 提交时按任务包校验（verdict 闭集、required_sections 全覆盖、业务门取值、引用路径存在），
 * 通过后由单一渲染器写出报告与 handoff，再交 subagent_handoff_check.py 复验。
 * 校验口径与 checker 对齐但不替代 checker：checker 仍是 mechanical_check 的唯一真源。
 *
 * 输入层与持久合同分层：
 * - 模型输入层（TASK_RESULT_V1_JSON_SCHEMA + normalizeTaskResultArguments，经 SDK prepareArguments 生效）：
 *   schema_version 可省略，已观察到的 JSON 字符串包装无损还原，形状无法解释时给有界短错误，
 *   避免 SDK 校验错误把整份长报告回显给模型。
 * - 持久化合同（validateTaskResultPayload）：schema_version 必须是数字 1，业务语义判定不变。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const TASK_RESULT_TOOL_NAME = "submit_task_result";
export const TASK_RESULT_SCHEMA_VERSION = 1;
// 未完成收口的 verdict：checker 对这些值不强求业务门与报告必填段（subagent_handoff_check.py incomplete_exit）。
const INCOMPLETE_VERDICTS = new Set(["needs_owner", "partial", "needs_split"]);
const RESERVED_OUTPUT_KEYS = ["target_repo", "file_path", "resolved_file_path", "handoff_file", "resolved_handoff_file"];
const YAML_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NON_PATH_PREFIXES = ["http://", "https://", "command:", "cmd:", "shell:", "powershell:", "bash:"];
const PATH_SUFFIXES = [".md", ".json", ".yaml", ".yml", ".txt", ".csv"];

export const TASK_RESULT_V1_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: true,
  required: ["verdict", "summary", "sections"],
  properties: {
    // 输入层不写 const：模型可省略固定版本（工具补数字 1），显式写出的非 1 值由
    // validateTaskResultPayload 明确拒绝；落盘记录的 schema_version 始终是数字 1。
    schema_version: { type: "number", description: "可省略：固定协议版本，工具会补成数字 1；显式写出时只接受 1（\"1\" 会被无损归一为 1）" },
    verdict: { type: "string", minLength: 1, description: "必填；只取 task_package.handoff_contract.accept_verdicts 之一" },
    summary: { type: "string", minLength: 1, description: "必填；一行结论，不含换行" },
    title: { type: "string", description: "报告标题；缺省取任务包 title 或 package_id" },
    sections: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "必填；报告章节：键为 task_package.expected_output.required_sections 里的章节名，值为该节 Markdown 正文；每个必需章节都要非空，可追加额外章节；整体写成 JSON 字符串会被无损还原",
    },
    output: {
      type: "object",
      description: "FINAL_HANDOFF.output 的业务字段：expected_output.business_gate 指定的门字段与能力提示词要求的字段；路径类五个保留键由渲染器填写",
    },
    scope_actual: {
      type: "object",
      properties: {
        read: { type: "array", items: { type: "string" } },
        written: { type: "array", items: { type: "string" } },
        deleted: { type: "array", items: { type: "string" } },
      },
      description: "实际读、写、删的路径；报告与 handoff 路径由渲染器补入 written",
    },
    evidence_refs: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "支撑结论的引用（路径、path:line、URL 或 command: 前缀的命令）；路径类引用必须真实存在",
    },
  },
});

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArray(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`task_result_v1 ${label} must be a string array`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`task_result_v1 ${label} must not contain empty items`);
    return item.trim();
  });
}

// ---------- 模型输入便利层（SDK prepareArguments 与直接 execute 共用） ----------

const INPUT_ERROR_PREFIX = "submit_task_result input error:";
const ERROR_LIST_LIMIT = 8;
// 已观察到的包装：模型把整个对象/数组字段 JSON.stringify 后当字符串传入（sections、schema_version）。
const JSON_WRAPPED_OBJECT_FIELDS = ["sections", "output", "scope_actual"];
const SCOPE_ACTUAL_KEYS = ["read", "written", "deleted"];

// 只报类型与长度，不回显内容：错误消息长度必须与报告长度无关。
function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length} items)`;
  if (typeof value === "string") return `string(${value.length} chars)`;
  if (typeof value === "number" || typeof value === "boolean") return `${typeof value}(${String(value)})`;
  return typeof value;
}

// 错误消息里的列表上限：字段反馈有界，不随任务包或引用数量膨胀。
function boundedList(items, limit = ERROR_LIST_LIMIT) {
  const list = [...items].map(String);
  if (list.length <= limit) return list.join(", ");
  return `${list.slice(0, limit).join(", ")} (+${list.length - limit} more)`;
}

function inputError(message) {
  return new Error(`${INPUT_ERROR_PREFIX} ${message}`);
}

function jsonWrapped(value, field, expected) {
  try {
    return JSON.parse(value);
  } catch {
    throw inputError(`${field} is a JSON string that does not parse (${describeValue(value)}); pass ${expected}.`);
  }
}

function objectField(value, field) {
  if (value === undefined || value === null) return value;
  const parsed = typeof value === "string" ? jsonWrapped(value, field, "an object") : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw inputError(`${field} must be an object; received ${describeValue(parsed)}.`);
  }
  return parsed;
}

function stringArrayField(value, field) {
  if (value === undefined || value === null) return value;
  const parsed = typeof value === "string" ? jsonWrapped(value, field, "a string array") : value;
  if (!Array.isArray(parsed)) throw inputError(`${field} must be a string array; received ${describeValue(parsed)}.`);
  parsed.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw inputError(`${field}[${index}] must be a non-empty string; received ${describeValue(item)}.`);
    }
  });
  return parsed;
}

/**
 * 输入便利层：SDK 在 schema 校验与 execute 之前调用（prepareArguments），直接 execute 的调用方也走同一层。
 *
 * - 省略 schema_version 时补数字 1；整数字符串（"1"）无损归一为数字；其他显式值原样保留，
 *   交给 validateTaskResultPayload 明确拒绝——这里不静默忽略未知版本。
 * - 只还原已观察到的 JSON 字符串包装（sections/output/scope_actual/evidence_refs 整体被 stringify）；
 *   无法无损解释的输入给具体短错误，不猜业务含义。
 * - 错误只报字段名、期望类型、实参类型与长度，避免 SDK 校验错误把整份长报告回显给模型。
 */
export function normalizeTaskResultArguments(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw inputError(`arguments must be a JSON object with verdict, summary and sections; received ${describeValue(raw)}.`);
  }
  const args = { ...raw };

  const version = args.schema_version;
  if (version === undefined || version === null) {
    args.schema_version = TASK_RESULT_SCHEMA_VERSION;
  } else if (typeof version === "number" && Number.isInteger(version)) {
    // 显式版本原样保留：未知版本由 validateTaskResultPayload 拒绝，不在这里静默改写。
  } else if (typeof version === "string" && /^\d+$/.test(version.trim())) {
    args.schema_version = Number(version.trim());
  } else {
    throw inputError(`schema_version must be the number ${TASK_RESULT_SCHEMA_VERSION} or omitted; received ${describeValue(version)}.`);
  }

  for (const field of JSON_WRAPPED_OBJECT_FIELDS) args[field] = objectField(args[field], field);
  args.evidence_refs = stringArrayField(args.evidence_refs, "evidence_refs");

  for (const field of ["verdict", "summary"]) {
    if (args[field] === undefined || args[field] === null) throw inputError(`${field} is required; received ${describeValue(args[field])}.`);
    if (typeof args[field] !== "string" || !args[field].trim()) {
      throw inputError(`${field} must be a non-empty string; received ${describeValue(args[field])}.`);
    }
  }
  if (args.title !== undefined && args.title !== null && typeof args.title !== "string") {
    throw inputError(`title must be a string; received ${describeValue(args.title)}.`);
  }
  if (args.sections === undefined || args.sections === null) {
    throw inputError("sections is required; pass an object of section name -> markdown body (keys are task_package.expected_output.required_sections).");
  }
  for (const [name, body] of Object.entries(args.sections)) {
    if (typeof body !== "string") {
      throw inputError(`sections["${String(name).slice(0, 60)}"] must be a markdown string; received ${describeValue(body)}.`);
    }
  }
  const scopeActual = args.scope_actual;
  if (scopeActual !== undefined && scopeActual !== null) {
    // 只保留显式给出的键：值不变的浅拷不污染 SDK 传入的嵌套对象，也不留下 undefined 键。
    const normalized = {};
    for (const key of SCOPE_ACTUAL_KEYS) {
      const list = stringArrayField(scopeActual[key], `scope_actual.${key}`);
      if (list !== undefined && list !== null) normalized[key] = list;
    }
    args.scope_actual = normalized;
  }
  return args;
}

// 与 subagent_handoff_check.py normalize_section 同口径：casefold 后只留字母数字。
export function normalizeSectionName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function resolvedOutputPath(taskPackage, value, fallbackRoot) {
  const raw = String(value || "").trim();
  if (!raw || raw === "null") return null;
  if (path.isAbsolute(raw)) return path.resolve(raw);
  const runtime = object(taskPackage.runtime_context);
  return path.resolve(String(runtime.output_root || fallbackRoot), raw);
}

export function taskResultOutputPaths(taskPackage, fallbackRoot) {
  const expected = object(taskPackage?.expected_output);
  const handoff = object(taskPackage?.handoff_contract);
  return {
    reportPath: resolvedOutputPath(taskPackage, expected.resolved_file_path || expected.file_path, fallbackRoot),
    handoffPath: resolvedOutputPath(taskPackage, handoff.resolved_handoff_file || handoff.handoff_file, fallbackRoot),
  };
}

export function requiredSections(taskPackage) {
  const sections = object(taskPackage?.expected_output).required_sections;
  if (!Array.isArray(sections)) return [];
  return sections.map((item) => String(item || "").trim()).filter(Boolean);
}

export function acceptVerdicts(taskPackage) {
  const values = object(taskPackage?.handoff_contract).accept_verdicts;
  if (!Array.isArray(values)) return [];
  return values.map((item) => String(item || "").trim()).filter(Boolean);
}

function businessGate(taskPackage) {
  return String(object(taskPackage?.expected_output).business_gate || "").replace(/^FINAL_HANDOFF\.output\./, "").trim();
}

// 与 checker task_gate_values 同口径：capability_contract 任一槽位的 "a|b" 枚举。
function gateValues(taskPackage) {
  const contracts = object(object(taskPackage?.extensions).capability_contract);
  for (const slot of Object.values(contracts)) {
    const raw = String(object(slot).gate_values || "");
    if (raw) return raw.split("|").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

// 与 checker looks_like_path / normalize_ref_path 同口径的路径类引用识别与归一。
function referencePath(value) {
  let text = String(value || "").trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!text || text === "FINAL_HANDOFF" || text === "-") return null;
  const lowered = text.toLowerCase();
  if (NON_PATH_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return null;
  if (text.startsWith("`") || text.startsWith("$")) return null;
  if (/^[A-Za-z][A-Za-z0-9_-]*\|/.test(text)) return null;
  if (!(text.includes("/") || text.includes("\\") || PATH_SUFFIXES.some((suffix) => text.endsWith(suffix)))) return null;
  const label = /^[A-Za-z][\w-]*:\s+(\S.*)$/.exec(text);
  if (label) text = label[1].trim().replace(/^["'`]+|["'`]+$/g, "");
  const line = /^(.*):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/.exec(text);
  if (line) text = line[1];
  return text;
}

function referenceRoots(taskPackage, fallbackRoot) {
  const runtime = object(taskPackage?.runtime_context);
  return [...new Set([runtime.output_root, runtime.target_repo, fallbackRoot].map((item) => String(item || "").trim()).filter(Boolean))];
}

function referenceExists(candidate, roots) {
  if (path.isAbsolute(candidate)) return existsSync(candidate);
  return roots.some((root) => existsSync(path.resolve(root, candidate)));
}

export function validateTaskResultPayload(payload, taskPackage, { fallbackRoot = process.cwd() } = {}) {
  const raw = object(payload);
  if (raw.schema_version !== TASK_RESULT_SCHEMA_VERSION) {
    throw new Error(`task_result_v1 schema_version must be the number ${TASK_RESULT_SCHEMA_VERSION} (omit the field to let the tool fill it in); got ${describeValue(raw.schema_version)}`);
  }
  const accepted = acceptVerdicts(taskPackage);
  const verdict = String(raw.verdict || "").trim();
  if (!verdict) throw new Error("task_result_v1 verdict is required");
  if (accepted.length && !accepted.includes(verdict)) {
    throw new Error(`task_result_v1 verdict must be one of ${accepted.join(" | ")}; got ${verdict}`);
  }
  const summary = String(raw.summary ?? "").trim();
  if (!summary) throw new Error("task_result_v1 summary is required");
  if (/[\r\n]/.test(summary)) throw new Error("task_result_v1 summary must be a single line");
  const title = String(raw.title ?? "").trim();

  const sectionsInput = raw.sections;
  if (!sectionsInput || typeof sectionsInput !== "object" || Array.isArray(sectionsInput)) {
    throw new Error("task_result_v1 sections must be an object of section name -> markdown body");
  }
  const sections = new Map();
  for (const [name, body] of Object.entries(sectionsInput)) {
    const key = normalizeSectionName(name);
    if (!key) throw new Error("task_result_v1 sections contain an empty section name");
    if (typeof body !== "string") throw new Error(`task_result_v1 sections[${name}] must be a markdown string`);
    if (sections.has(key)) throw new Error(`task_result_v1 sections contain duplicate section ${name}`);
    sections.set(key, { name: String(name).trim(), body: body.replace(/\r\n?/g, "\n").trim() });
  }
  const required = requiredSections(taskPackage);
  const missing = required.filter((name) => !sections.get(normalizeSectionName(name))?.body);
  if (missing.length && !INCOMPLETE_VERDICTS.has(verdict)) {
    throw new Error(`task_result_v1 sections are missing or empty for required_sections: ${boundedList(missing)}`);
  }

  const output = object(raw.output);
  for (const [key, value] of Object.entries(output)) {
    if (!YAML_KEY.test(key)) throw new Error(`task_result_v1 output key is not a plain identifier: ${key}`);
    if (typeof value === "function" || (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error(`task_result_v1 output.${key} is not JSON-serializable`);
    }
  }
  const gate = businessGate(taskPackage);
  if (gate && !INCOMPLETE_VERDICTS.has(verdict)) {
    const value = output[gate];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`task_result_v1 output.${gate} is required by expected_output.business_gate`);
    }
    const allowed = gateValues(taskPackage);
    if (allowed.length && !allowed.includes(value.trim())) {
      throw new Error(`task_result_v1 output.${gate} must be one of ${allowed.join(" | ")}; got ${value}`);
    }
  }

  const scopeInput = object(raw.scope_actual);
  const scopeActual = {
    read: stringArray(scopeInput.read, "scope_actual.read"),
    written: stringArray(scopeInput.written, "scope_actual.written"),
    deleted: stringArray(scopeInput.deleted, "scope_actual.deleted"),
  };
  const evidenceRefs = stringArray(raw.evidence_refs, "evidence_refs");
  const roots = referenceRoots(taskPackage, fallbackRoot);
  const missingRefs = [];
  for (const ref of evidenceRefs) {
    const candidate = referencePath(ref);
    if (candidate && !referenceExists(candidate, roots) && !missingRefs.includes(candidate)) missingRefs.push(candidate);
  }
  if (missingRefs.length) {
    throw new Error(`task_result_v1 evidence_refs reference missing paths: ${boundedList(missingRefs)}`);
  }

  return {
    schema_version: TASK_RESULT_SCHEMA_VERSION,
    verdict,
    summary,
    title,
    sections: [...sections.values()],
    output: JSON.parse(JSON.stringify(output)),
    scope_actual: scopeActual,
    evidence_refs: evidenceRefs,
  };
}

// ---------- 渲染 ----------

const YAML_SPECIAL_WORDS = new Set(["", "~", "null", "true", "false", "yes", "no", "on", "off", "y", "n"]);

function yamlQuote(text) {
  return `'${text.replace(/'/g, "''")}'`;
}

function yamlScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  const text = String(value);
  if (YAML_SPECIAL_WORDS.has(text.trim().toLowerCase())) return yamlQuote(text);
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text) || /\s$/.test(text) || /^\s/.test(text)) return yamlQuote(text);
  if (text.includes(": ") || text.includes(" #") || text.endsWith(":")) return yamlQuote(text);
  if (/^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(text) || /^0x[0-9a-fA-F]+$/.test(text)) return yamlQuote(text);
  return text;
}

function yamlLines(value, indent) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}[]`];
    return value.flatMap((item) => {
      if (item && typeof item === "object") {
        const nested = yamlLines(item, indent + 2);
        return [`${pad}- ${nested[0].trimStart()}`, ...nested.slice(1)];
      }
      return [`${pad}- ${yamlScalar(item)}`];
    });
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([key]) => YAML_KEY.test(key));
    if (!entries.length) return [`${pad}{}`];
    return entries.flatMap(([key, item]) => yamlEntry(key, item, indent));
  }
  return [`${pad}${yamlScalar(value)}`];
}

function yamlEntry(key, value, indent) {
  const pad = " ".repeat(indent);
  if (typeof value === "string" && value.includes("\n")) {
    const body = value.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    return [`${pad}${key}: |-`, ...body.split("\n").map((line) => (line ? `${pad}  ${line}` : ""))];
  }
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}${key}: []`];
    return [`${pad}${key}:`, ...yamlLines(value, indent + 2)];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([item]) => YAML_KEY.test(item));
    if (!entries.length) return [`${pad}${key}: {}`];
    return [`${pad}${key}:`, ...yamlLines(value, indent + 2)];
  }
  return [`${pad}${key}: ${yamlScalar(value)}`];
}

export function reportTitle(result, taskPackage) {
  const title = String(result.title || "").trim();
  if (title) return title;
  const packageTitle = String(taskPackage?.title || "").trim();
  if (packageTitle) return packageTitle;
  return String(taskPackage?.package_id || "Task Report").trim();
}

export function renderTaskReport(result, taskPackage) {
  const ordered = [];
  const seen = new Set();
  for (const name of requiredSections(taskPackage)) {
    const key = normalizeSectionName(name);
    const section = result.sections.find((item) => normalizeSectionName(item.name) === key);
    if (!section || seen.has(key)) continue;
    seen.add(key);
    ordered.push({ name, body: section.body });
  }
  for (const section of result.sections) {
    const key = normalizeSectionName(section.name);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(section);
  }
  const lines = [`# ${reportTitle(result, taskPackage)}`, "", `- verdict: ${result.verdict}`, `- summary: ${result.summary}`, ""];
  for (const section of ordered) {
    lines.push(`## ${section.name}`, "", section.body || "无", "");
  }
  return lines.join("\n");
}

export function renderTaskHandoff(result, taskPackage, { reportPath, handoffPath, scopeValidation = null }) {
  const expected = object(taskPackage.expected_output);
  const handoff = object(taskPackage.handoff_contract);
  const runtime = object(taskPackage.runtime_context);
  const declaredReport = expected.file_path || reportPath;
  const declaredHandoff = handoff.handoff_file || handoffPath;
  const written = [...result.scope_actual.written];
  for (const item of [declaredReport, declaredHandoff]) {
    if (item && !written.includes(item)) written.push(item);
  }
  // checker 逐行扫描 output 块、取首个命中的 key：业务门与单行标量排在最前，嵌套对象、列表与
  // `|-` 块标量放最后，块正文里出现的同名 "key: value" 行不会遮蔽真实字段。
  const gate = businessGate(taskPackage);
  const rank = (key, value) => {
    if (key === gate) return 0;
    if (typeof value === "string" && value.includes("\n")) return 3;
    if (value && typeof value === "object") return 2;
    return 1;
  };
  const customOutput = Object.entries(result.output)
    .filter(([key]) => !RESERVED_OUTPUT_KEYS.includes(key))
    .map(([key, value], index) => ({ key, value, index, rank: rank(key, value) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
  const output = {
    target_repo: runtime.target_repo || null,
    file_path: declaredReport,
    resolved_file_path: expected.resolved_file_path || reportPath,
    handoff_file: declaredHandoff,
    resolved_handoff_file: handoff.resolved_handoff_file || handoffPath,
    ...Object.fromEntries(customOutput.map(({ key, value }) => [key, value])),
  };
  const evidenceRefs = [...result.evidence_refs];
  for (const item of [expected.resolved_file_path || reportPath, handoff.resolved_handoff_file || handoffPath]) {
    if (item && !evidenceRefs.includes(item)) evidenceRefs.push(item);
  }
  const scopeCompliant = scopeValidation?.compliant === true;
  const scopeComplianceSource = String(scopeValidation?.source || "write_domain_unavailable");
  const writeDomainViolationCount = Math.max(0, Number(scopeValidation?.violation_count) || 0);
  const writeDomainAuditComplete = scopeValidation?.audit_complete === true;
  const lines = [
    "FINAL_HANDOFF:",
    ...yamlEntry("package_id", taskPackage.package_id ?? null, 2),
    ...yamlEntry("verdict", result.verdict, 2),
    ...yamlEntry("summary", result.summary, 2),
    ...yamlEntry("output", output, 2),
    ...yamlEntry("scope_actual", { read: result.scope_actual.read, written, deleted: result.scope_actual.deleted }, 2),
    "  validation:",
    "    required_files_loaded: true",
    "    required_files_loaded_detail: provided",
    "    expected_output_satisfied: true",
    `    scope_compliant: ${scopeCompliant}`,
    `    scope_compliance_source: ${yamlScalar(scopeComplianceSource)}`,
    `    write_domain_audit_complete: ${writeDomainAuditComplete}`,
    `    write_domain_violation_count: ${writeDomainViolationCount}`,
    "    mechanical_check: pass",
    ...yamlEntry("evidence_refs", evidenceRefs, 2),
    "",
  ];
  return lines.join("\n");
}

function write(pathname, content) {
  mkdirSync(path.dirname(pathname), { recursive: true });
  writeFileSync(pathname, content, "utf8");
}

export function writeTaskResultOutputs({ payload, taskPackage, reportPath, handoffPath, fallbackRoot, scopeValidation = null }) {
  const result = validateTaskResultPayload(payload, taskPackage, { fallbackRoot });
  const report = renderTaskReport(result, taskPackage);
  const handoff = renderTaskHandoff(result, taskPackage, { reportPath, handoffPath, scopeValidation });
  write(reportPath, report);
  write(handoffPath, handoff);
  return { result, report, handoff };
}

// runtime 以 --handoffCheck 下发的 checker 规格：{argv, cwd, env}；argv 已含 --format json。
// 空规格表示未配置；已给出但无法解释的规格直接失败，不当成未配置。
export function parseHandoffCheckSpec(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  const spec = object(parsed);
  if (!Array.isArray(spec.argv) || spec.argv.length < 2 || spec.argv.some((item) => typeof item !== "string" || !item)) {
    throw new Error("handoff check spec is present but not a usable {argv, cwd, env} object");
  }
  return {
    argv: [...spec.argv],
    cwd: String(spec.cwd || "") || null,
    env: Object.fromEntries(Object.entries(object(spec.env)).map(([key, value]) => [key, String(value)])),
  };
}

export function runHandoffCheck(spec, { spawn = spawnSync, baseEnv = process.env } = {}) {
  if (!spec) return { checked: false, status: "not_configured", issues: [] };
  const run = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd || undefined,
    env: { ...baseEnv, ...spec.env },
    encoding: "utf8",
    windowsHide: true,
  });
  const stdout = String(run.stdout || "").trim();
  if (run.error || !stdout) {
    return {
      checked: true,
      status: "error",
      exit_code: run.status ?? null,
      issues: [run.error ? `handoff_check_spawn_failed=${run.error.message}` : "handoff_check_no_output"],
      stderr: String(run.stderr || "").trim().slice(0, 2000),
    };
  }
  try {
    const parsed = JSON.parse(stdout);
    return {
      checked: true,
      status: String(parsed.status || (run.status === 0 ? "pass" : "fail")),
      exit_code: run.status ?? null,
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    };
  } catch {
    return {
      checked: true,
      status: "error",
      exit_code: run.status ?? null,
      issues: ["handoff_check_output_parse_failed"],
      stdout: stdout.slice(0, 2000),
    };
  }
}

if (process.argv[1] && path.basename(process.argv[1]).toLowerCase() === "task_result_synthesis.mjs") {
  if (process.argv[2] !== "self-test") {
    console.error("usage: node ops/tools/task_result_synthesis.mjs self-test");
    process.exit(2);
  }
  // 说明符走变量：esbuild 只内联字面量动态 import，自测代码不进 ops/dist 运行时 bundle。
  const selfTestModule = "./task_result_synthesis.selftest.mjs";
  import(selfTestModule).then((module) => {
    module.selfTest();
    console.log("task_result_synthesis self-test: pass");
  }).catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
