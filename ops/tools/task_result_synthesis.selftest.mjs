#!/usr/bin/env node
/** task_result_synthesis 的机械自测实现，经 task_result_synthesis.mjs self-test 调用。 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeSectionName,
  normalizeTaskResultArguments,
  parseHandoffCheckSpec,
  renderTaskHandoff,
  renderTaskReport,
  runHandoffCheck,
  taskResultOutputPaths,
  validateTaskResultPayload,
  writeTaskResultOutputs,
} from "./task_result_synthesis.mjs";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(TOOLS_DIR));
const CHECKER = path.join(TOOLS_DIR, "subagent_handoff_check.mjs");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function expectThrow(fn, pattern, label) {
  try {
    fn();
  } catch (error) {
    check(pattern.test(String(error?.message || error)), `${label}: unexpected error ${error?.message || error}`);
    return;
  }
  throw new Error(`${label}: expected an error matching ${pattern}`);
}

function fixture() {
  const root = path.join(REPO_ROOT, "tmp", `task-result-synthesis-self-test-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const evidencePath = path.join(root, "evidence.txt");
  writeFileSync(evidencePath, "evidence\n", "utf8");
  const reportPath = path.join(root, "notes", "general", "report.md");
  const handoffPath = path.join(root, "notes", "handoffs", "handoff.md");
  const taskPackage = {
    package_id: "pkg-selftest-task-result",
    title: "结构化交付自测",
    runtime_context: { output_root: root, target_repo: root },
    expected_output: {
      mode: "file",
      file_path: "notes/general/report.md",
      resolved_file_path: reportPath,
      required_sections: ["Evidence", "Commit Draft", "Residuals"],
      business_gate: "verdict",
    },
    handoff_contract: {
      handoff_file: "notes/handoffs/handoff.md",
      resolved_handoff_file: handoffPath,
      accept_verdicts: ["done", "partial", "needs_owner", "failed"],
      require_final_handoff: true,
    },
    extensions: { capability_contract: { scoped_execution: { gate_values: "pass|fail" } } },
  };
  const payload = {
    schema_version: 1,
    verdict: "done",
    summary: "自测：报告与 handoff 由渲染器生成",
    sections: {
      Evidence: "- evidence.txt 存在\n- 命令 `python -c \"print(1)\"` 退出码 0",
      "Commit Draft": "chore(selftest): render task result\n\n正文含冒号: 与 # 号",
      Residuals: "无",
    },
    output: {
      // 块标量正文含 "verdict: invalid" 且键序在业务门之前：渲染器必须把业务门排到最前（sol 审查 finding 3）。
      preface: "line one\nverdict: invalid",
      result: { created_file: "evidence.txt", first_line: "evidence" },
      verdict: "pass",
      commit_msg_draft: "chore(selftest): render task result\n\n第二段。",
      notes: ["a: b", "yes", "12"],
    },
    scope_actual: { read: ["evidence.txt"], written: [], deleted: [] },
    evidence_refs: ["evidence.txt", "location: evidence.txt:1", "command: python -c print(1)", "https://example.invalid/x"],
  };
  return { root, evidencePath, reportPath, handoffPath, taskPackage, payload };
}

function runChecker(taskPackagePath, handoffPath, root) {
  // 与 runtime checkerRootEnvironment 同款：checker 以 producer root 为仓根解析任务包与相对声明路径。
  // checker 的 projectRoot() 优先读 SUBAGENT_PROJECT_ROOT（高于 SUBAGENT_CONTROL_REPO_ROOT 与 cwd 上溯），
  // 两个键都显式指向 producer root：否则在 runner 注入的 child 里跑自测时，继承来的 SUBAGENT_PROJECT_ROOT
  // （控制仓）会把 tmp fixture 判为 escapes repository。
  const spec = parseHandoffCheckSpec(JSON.stringify({
    argv: [process.execPath, CHECKER, "--task-package", taskPackagePath, "--handoff-file", handoffPath, "--format", "json"],
    cwd: REPO_ROOT,
    env: { SUBAGENT_CONTROL_REPO_ROOT: root, SUBAGENT_PROJECT_ROOT: root },
  }));
  return runHandoffCheck(spec);
}

export function selfTest() {
  const fx = fixture();
  try {
    // 输入便利层：省略版本、已观察到的 JSON 字符串包装、无法解释时的有界短错误。
    const normalized = normalizeTaskResultArguments({
      verdict: "done",
      summary: "输入层自测",
      sections: JSON.stringify(fx.payload.sections),
      output: JSON.stringify(fx.payload.output),
      scope_actual: JSON.stringify({ read: ["evidence.txt"] }),
      evidence_refs: JSON.stringify(["evidence.txt"]),
    });
    check(normalized.schema_version === 1, "omitted schema_version is filled with the number 1");
    check(typeof normalized.sections === "object" && normalized.sections.Evidence === fx.payload.sections.Evidence, "JSON-wrapped sections restored losslessly");
    check(normalized.output.verdict === "pass" && normalized.evidence_refs.length === 1 && normalized.scope_actual.read.length === 1, "JSON-wrapped object/array fields restored");
    check(normalizeTaskResultArguments(normalized).schema_version === 1, "input layer is idempotent");
    check(normalizeTaskResultArguments({ schema_version: "1", verdict: "done", summary: "s", sections: { Evidence: "x" } }).schema_version === 1, "numeric string version normalizes losslessly");
    check(normalizeTaskResultArguments({ schema_version: 2, verdict: "done", summary: "s", sections: { Evidence: "x" } }).schema_version === 2, "unknown explicit version is kept for validation to reject");
    check(normalizeSectionName("Commit Draft") === "commitdraft" && normalizeSectionName("结论前置") === "结论前置", "section normalization");
    const paths = taskResultOutputPaths(fx.taskPackage, fx.root);
    check(paths.reportPath === fx.reportPath && paths.handoffPath === fx.handoffPath, "declared output paths resolve");
    check(taskResultOutputPaths({ expected_output: { file_path: "notes/x.md" }, handoff_contract: {} }, fx.root).reportPath === path.join(fx.root, "notes", "x.md"), "relative report resolves against fallback root");

    // 校验负例
    expectThrow(() => validateTaskResultPayload({ ...fx.payload, verdict: "surprise" }, fx.taskPackage, { fallbackRoot: fx.root }), /verdict must be one of/, "verdict closed set");
    expectThrow(() => validateTaskResultPayload({ ...fx.payload, sections: { Evidence: "x" } }, fx.taskPackage, { fallbackRoot: fx.root }), /required_sections: Commit Draft, Residuals/, "missing sections");
    expectThrow(() => validateTaskResultPayload({ ...fx.payload, sections: { ...fx.payload.sections, Residuals: "  " } }, fx.taskPackage, { fallbackRoot: fx.root }), /required_sections: Residuals/, "empty section");
    expectThrow(() => validateTaskResultPayload({ ...fx.payload, output: { verdict: "maybe" } }, fx.taskPackage, { fallbackRoot: fx.root }), /output\.verdict must be one of pass \| fail/, "gate values");
    expectThrow(() => validateTaskResultPayload({ ...fx.payload, output: {} }, fx.taskPackage, { fallbackRoot: fx.root }), /output\.verdict is required/, "gate required");
    expectThrow(() => validateTaskResultPayload({ ...fx.payload, output: { verdict: "pass", "bad-key": 1 } }, fx.taskPackage, { fallbackRoot: fx.root }), /not a plain identifier/, "output key");
    expectThrow(() => validateTaskResultPayload({ ...fx.payload, evidence_refs: ["notes/missing.md"] }, fx.taskPackage, { fallbackRoot: fx.root }), /missing paths: notes\/missing\.md/, "missing evidence ref");
    expectThrow(() => validateTaskResultPayload({ ...fx.payload, summary: "a\nb" }, fx.taskPackage, { fallbackRoot: fx.root }), /single line/, "summary single line");
    expectThrow(() => validateTaskResultPayload({ ...fx.payload, schema_version: 2 }, fx.taskPackage, { fallbackRoot: fx.root }), /schema_version/, "schema version");
    // needs_owner 不强求业务门与必填章节（与 checker incomplete_exit 一致）。
    const incomplete = validateTaskResultPayload({ ...fx.payload, verdict: "needs_owner", output: {}, sections: { Evidence: "缺输入" } }, fx.taskPackage, { fallbackRoot: fx.root });
    check(incomplete.verdict === "needs_owner" && incomplete.sections.length === 1, "needs_owner relaxes gate and sections");

    // 正例：渲染 + 真 checker 复验
    const taskPackagePath = path.join(fx.root, "task-package.json");
    writeFileSync(taskPackagePath, `${JSON.stringify({ task_package: fx.taskPackage }, null, 2)}\n`, "utf8");
    const written = writeTaskResultOutputs({
      payload: fx.payload,
      taskPackage: fx.taskPackage,
      reportPath: fx.reportPath,
      handoffPath: fx.handoffPath,
      fallbackRoot: fx.root,
    });
    check(existsSync(fx.reportPath) && existsSync(fx.handoffPath), "report and handoff written");
    const report = readFileSync(fx.reportPath, "utf8");
    check(report.startsWith("# 结构化交付自测\n"), "report title from task package");
    check(report.includes("## Evidence\n") && report.includes("## Commit Draft\n") && report.includes("## Residuals\n"), "report sections rendered in required order");
    const handoff = readFileSync(fx.handoffPath, "utf8");
    check(handoff.includes("    resolved_handoff_file: ") && handoff.indexOf("    verdict: pass\n") < handoff.indexOf("    result:\n") && handoff.indexOf("    result:\n") < handoff.indexOf("    preface: |-\n"), "business gate precedes nested and block-scalar output entries");
    check(handoff.includes("    verdict: pass\n"), "business gate rendered under output");
    // 省略版本经输入层后落盘仍是数字 1，渲染结果与显式写 1 完全一致。
    const { schema_version: explicitVersion, ...payloadWithoutVersion } = fx.payload;
    const writtenWithoutVersion = writeTaskResultOutputs({
      payload: normalizeTaskResultArguments(payloadWithoutVersion),
      taskPackage: fx.taskPackage,
      reportPath: fx.reportPath,
      handoffPath: fx.handoffPath,
      fallbackRoot: fx.root,
    });
    check(writtenWithoutVersion.result.schema_version === 1 && typeof writtenWithoutVersion.result.schema_version === "number", "omitted version persists as the number 1");
    check(readFileSync(fx.handoffPath, "utf8") === handoff && readFileSync(fx.reportPath, "utf8") === report, "omitted version renders the same handoff as explicit 1");
    const checked = runChecker(taskPackagePath, fx.handoffPath, fx.root);
    check(checked.checked === true && checked.status === "pass", `real checker must pass the rendered handoff: ${JSON.stringify(checked)}`);

    // 负例：手工把 verdict 改坏，checker 失败要能被 runHandoffCheck 反映。
    writeFileSync(fx.handoffPath, handoff.replace("  verdict: done\n", "  verdict: surprise\n"), "utf8");
    const failed = runChecker(taskPackagePath, fx.handoffPath, fx.root);
    check(failed.status === "fail" && failed.issues.some((item) => item.includes("verdict_invalid=surprise")), `checker failure surfaces issues: ${JSON.stringify(failed)}`);
    check(runHandoffCheck(null).checked === false, "missing spec is not_configured");
    const spawnFailure = runHandoffCheck({ argv: ["definitely-missing-binary-xyz", "x"], cwd: fx.root, env: {} }, {
      spawn: () => ({ error: new Error("ENOENT"), stdout: "", stderr: "", status: null }),
    });
    check(spawnFailure.status === "error" && spawnFailure.issues[0].startsWith("handoff_check_spawn_failed="), "spawn failure is an error status");
  } finally {
    rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// 直接运行本文件时也执行自测：任务包的 verify_commands 用的是 `node ops/tools/task_result_synthesis.selftest.mjs`。
// 经 task_result_synthesis.mjs self-test 导入时不重复执行。
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  selfTest();
  console.log("task_result_synthesis self-test: pass");
}
