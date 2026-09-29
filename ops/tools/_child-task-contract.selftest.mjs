#!/usr/bin/env node
/** _child-task-contract 的机械自测实现，经 _child-task-contract.mjs --self-test 调用。 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  LIVE_FLUSH_INTERVAL_MS,
  analyzeTaskResult,
  applyReviewGate,
  classifyFinalResult,
  classifyLiveWrite,
  escapeRegex,
  fillTemplate,
  headingStatus,
  literalReplaceAll,
  makeLiveWriter,
  normalizeFinalText,
  normalizeTaskStatus,
  parseSimulationProfile,
  parseTaskStatus,
  readTaskText,
  sectionText,
} from "./_child-task-contract.mjs";

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function finalDoc(statusWord, overrides = {}) {
  return [
    "## 结论",
    `任务状态:${statusWord}`,
    "## 事实与证据",
    "- 已读 A 文件",
    "## 已检查内容",
    "- self-test",
    "## 失败检查",
    overrides.failure ?? "无",
    "## 不确定项",
    overrides.uncertainty ?? "无",
    "## 边界",
    "- 无",
  ].join("\n");
}

export function selfTest() {
  // normalizeTaskStatus 同义词表
  check(normalizeTaskStatus("Done") === "completed", "normalizeTaskStatus: 英文同义词大小写不敏感");
  check(normalizeTaskStatus("已完成") === "completed", "normalizeTaskStatus: 中文同义词");
  check(normalizeTaskStatus("部分完成") === "partial", "normalizeTaskStatus: partial 同义词");
  check(normalizeTaskStatus("受阻") === "blocked", "normalizeTaskStatus: blocked 同义词");
  check(normalizeTaskStatus("出错") === "failed", "normalizeTaskStatus: failed 同义词");
  check(normalizeTaskStatus("bogus") === null && normalizeTaskStatus("") === null, "normalizeTaskStatus: 未知词必须归 null");

  // parseTaskStatus 六段解析
  const okDoc = finalDoc("completed");
  check(parseTaskStatus(okDoc)?.canonical === "completed", "parseTaskStatus: 六段文本首行状态");
  check(sectionText(okDoc, "## 已检查内容") === "- self-test", "sectionText: 段落切分");
  check(parseTaskStatus(finalDoc("完成"))?.raw === "完成", "parseTaskStatus: 保留原词");
  check(parseTaskStatus("## 结论\n没有状态行") === null, "parseTaskStatus: 无状态行必须 null");

  // analyzeTaskResult 四态分类
  const doneTask = analyzeTaskResult(okDoc);
  check(doneTask.ok === true && doneTask.status === "completed" && doneTask.failure_type === "none", "analyzeTaskResult: completed");
  check(analyzeTaskResult(finalDoc("partial")).failure_type === "task_partial", "analyzeTaskResult: partial");
  check(analyzeTaskResult(finalDoc("blocked")).failure_type === "task_blocked", "analyzeTaskResult: blocked");
  check(analyzeTaskResult(finalDoc("failed")).failure_type === "task_failed", "analyzeTaskResult: failed");
  const unresolved = analyzeTaskResult(finalDoc("completed", { uncertainty: "- 权限不足,无法执行 X" }));
  check(
    unresolved.ok === false && unresolved.failure_type === "completed_with_unresolved_failures",
    "analyzeTaskResult: completed 带未解释受阻信号必须降级",
  );

  // 机械信号门:业务段职业性讨论失败(审查/测试设计类)不再被全文正则误伤
  const discussDoc = finalDoc("completed", {}) .replace("- 已读 A 文件", "- 设计场景:stub 令命令执行失败,断言请求被策略拦截后的分类");
  const cleanMech = { deniedPermissions: 0, failedToolCalls: 0, errorTurns: 0 };
  const dirtyMech = { deniedPermissions: 1, failedToolCalls: 0, errorTurns: 0 };
  const suppressed = analyzeTaskResult(discussDoc, { mechanicalSignals: cleanMech });
  check(
    suppressed.ok === true && suppressed.status === "completed" && suppressed.requiresParentReview === false &&
      suppressed.sections.diagnosticSignals.suppressedBlockedSignals.length > 0 &&
      suppressed.verdictBasis === "suppressed_text_hits",
    "机械信号门: 业务段命中+信号干净不降级不触发 review,压制记录保留",
  );
  const selfReportDoc = finalDoc("completed", { failure: "- 有一条命令执行失败未解决" });
  const selfReported = analyzeTaskResult(selfReportDoc, { mechanicalSignals: cleanMech });
  check(
    selfReported.status === "completed_with_recorded_failures" && selfReported.requiresParentReview === true &&
      selfReported.blockedSignals.length > 0 && selfReported.verdictBasis === "self_report",
    "机械信号门: 自报段命中无论信号如何照旧进 review 门(如实自报走 recorded_failures)",
  );
  const dirtySuppress = analyzeTaskResult(discussDoc, { mechanicalSignals: dirtyMech });
  check(
    dirtySuppress.ok === false && dirtySuppress.status === "completed_with_unresolved_failures" &&
      dirtySuppress.verdictBasis === "mechanical_evidence",
    "机械信号门: 业务段命中+信号脏照旧降级",
  );
  const legacy = analyzeTaskResult(discussDoc);
  check(legacy.ok === false && legacy.status === "completed_with_unresolved_failures", "机械信号门: 未提供信号时保持历来行为");

  // applyReviewGate 两档
  const gatePass = applyReviewGate(analyzeTaskResult(finalDoc("partial")), { applied: true, gate: "pass" });
  check(gatePass.ok === true && gatePass.status === "completed" && gatePass.reviewGate === "pass", "applyReviewGate: pass 档");
  const gateFail = applyReviewGate(analyzeTaskResult(finalDoc("completed")), { applied: true, gate: "fail" });
  check(gateFail.ok === true && gateFail.status === "failed" && gateFail.requiresParentReview === true, "applyReviewGate: fail 档");
  check(applyReviewGate(doneTask, { applied: false, gate: "pass" }) === doneTask, "applyReviewGate: 未启用时原样返回");

  // classifyFinalResult 两级优先级:运输失败 > 业务状态;正文格式不进终态。
  const headingsOk = headingStatus(okDoc);
  const badOrchestration = classifyFinalResult({ ok: false, failure_type: "child_turn_failed" }, doneTask);
  check(
    badOrchestration.ok === false && badOrchestration.status === "failed" && badOrchestration.failure_type === "child_turn_failed",
    "classifyFinalResult: 运输失败优先",
  );
  const badTask = classifyFinalResult({ ok: true, failure_type: "none" }, analyzeTaskResult(finalDoc("partial")));
  check(badTask.status === "partial" && badTask.failure_type === "task_partial", "classifyFinalResult: 业务状态其次，partial 不折成 blocked");
  const allOk = classifyFinalResult({ ok: true, failure_type: "none" }, doneTask);
  check(allOk.ok === true && allOk.status === "completed" && allOk.failure_type === "none", "classifyFinalResult: 两级全过");
  const gateFailed = classifyFinalResult({ ok: true, failure_type: "none" }, gateFail);
  check(gateFailed.ok === true && gateFailed.status === "failed", "classifyFinalResult: review gate fail 的 task.ok=true 不得把顶层投成 completed");
  const gateOwner = applyReviewGate(doneTask, { applied: true, gate: "needs_owner" });
  check(classifyFinalResult({ ok: true, failure_type: "none" }, gateOwner).status === "partial", "classifyFinalResult: review gate needs_owner 顶层投 partial");

  // headingStatus 缺段与顺序检测
  check(headingsOk.ok === true && headingsOk.missing.length === 0, "headingStatus: 合规文本必须通过");
  const missingBoundary = headingStatus(okDoc.replace("## 边界\n- 无", ""));
  check(
    missingBoundary.ok === false && missingBoundary.missing.includes("## 边界"),
    "headingStatus: 缺段必须被点名",
  );
  check(headingStatus(`前言\n${okDoc}`).conclusionIsFirst === false, "headingStatus: 游离前言必须拦下");
  check(headingStatus(`${okDoc}\n## 边界\n- 重复`).duplicateHeadings.includes("## 边界"), "headingStatus: 重复标题必须点名");

  // structured review 豁免:结论状态行缺失只记 warning,不进 headingStatus.ok;
  // 默认(FINAL_HANDOFF 轨)headingStatus.ok 仍要求状态行(观测口径,不再是终态硬闸)。
  const noStatusDoc = okDoc.replace(/任务状态[:：]\s*\S+\n/, "");
  const relaxed = headingStatus(noStatusDoc, undefined, { conclusionStatusRequired: false });
  check(
    relaxed.ok === true && relaxed.conclusionStatusOk === false &&
      relaxed.warnings.some((line) => line.includes("任务状态")),
    "headingStatus: structured review 豁免下状态行缺失不硬闸且保留提示",
  );
  check(headingStatus(noStatusDoc).ok === false, "headingStatus: 默认轨状态行缺失仍记为不合规");

  // parseSimulationProfile 合法/非法
  check(parseSimulationProfile("") === null, "parseSimulationProfile: 空串返回 null");
  check(parseSimulationProfile('{"role":"reviewer"}').role === "reviewer", "parseSimulationProfile: 合法对象");

  // fillTemplate 占位替换
  const template = [
    "GOAL={{GOAL}}",
    "EVIDENCE={{EVIDENCE_DIR}}",
    "ARTIFACTS={{ARTIFACTS_DIR}}",
    "CTX={{RUNTIME_CONTEXT}}",
    "REMINDER={{TASK_REMINDER}}",
  ].join("\n");
  const rendered = fillTemplate(template, "目标里含 {{EVIDENCE_DIR}} 字面量", {
    contextMode: "isolated",
    childCwd: "/w/child",
    targetCwd: "/w/target",
    artifactsDir: "/w/artifacts",
    outDir: "/w/out",
    runtimeName: "Probe",
    taskReminder: "再次确认：本次任务是「探针」。",
  });
  check(rendered.includes("GOAL=目标里含 {{EVIDENCE_DIR}} 字面量"), "fillTemplate: GOAL 最后替换,不得二次展开");
  check(rendered.includes("EVIDENCE=/w/out") && rendered.includes("ARTIFACTS=/w/artifacts"), "fillTemplate: 目录占位替换");
  check(rendered.includes("child Probe 当前工作目录:/w/child") && rendered.includes("上下文模式:isolated"), "fillTemplate: 运行上下文按模式生成");
  check(rendered.includes("REMINDER=再次确认：本次任务是「探针」。"), "fillTemplate: 末尾复述");
  check(!/\{\{[A-Z_]+\}\}/.test(rendered.replace("目标里含 {{EVIDENCE_DIR}} 字面量", "")), "fillTemplate: 模板占位必须全部落地");

  // 观测节流与工厂
  const terminal = classifyLiveWrite({ prevPhase: "turn_wait", nextPhase: "finished", event: "finished", status: "completed" }, 0, LIVE_FLUSH_INTERVAL_MS);
  check(terminal.flushLive && terminal.recordEvent, "classifyLiveWrite: 终态必须记事件并落盘");
  const toolCall = classifyLiveWrite({ prevPhase: "tool_call", nextPhase: "tool_call", event: "notification", status: "running" }, 0, LIVE_FLUSH_INTERVAL_MS);
  check(toolCall.recordEvent && !toolCall.flushLive, "classifyLiveWrite: tool_call 记事件但不落盘");

  const tmp = mkdtempSync(path.join(tmpdir(), "child-task-contract-"));
  try {
    const livePath = path.join(tmp, "child-task-live.json");
    const eventsPath = path.join(tmp, "child-task-events.jsonl");
    const live = makeLiveWriter({
      outDir: tmp,
      livePath,
      eventsPath,
      initialState: { run_id: "self-test", status: "starting", phase: "bootstrap", last_tool_call: null },
    });
    live.writeLive({ status: "running", phase: "turn_wait", event: "turn_start" });
    live.writeLive({ event: "extension_ui_request", force_record_event: true, event_extra: { allow: true } });
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    check(events[1].allow === true, "makeLiveWriter: event_extra 必须合并进事件行");
    const snapshot = JSON.parse(readFileSync(livePath, "utf8"));
    check(snapshot.phase === "turn_wait" && snapshot.rev === 1, "makeLiveWriter: phase 变化时落盘一次");
    check(!("token_usage" in snapshot), "makeLiveWriter: token_usage 无来源时必须删字段");

    const taskPath = path.join(tmp, "task.md");
    writeFileSync(taskPath, "  文件里的任务  \n", "utf8");
    check(readTaskText({ taskFile: taskPath }) === "文件里的任务", "readTaskText: taskFile 优先且去空白");
    check(readTaskText({ task: "  内联任务 " }) === "内联任务", "readTaskText: 内联任务去空白");
    check(readTaskText({}) === "", "readTaskText: 无输入返回空串");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  check(normalizeFinalText("  最终文本  ") === "最终文本", "normalizeFinalText: 去首尾空白");
  check(escapeRegex("a.b*c") === "a\\.b\\*c", "escapeRegex: 元字符转义");
  check(literalReplaceAll("x{{A}}y{{A}}", "{{A}}", "$&") === "x$&y$&", "literalReplaceAll: 替换值按字面量处理");
}
