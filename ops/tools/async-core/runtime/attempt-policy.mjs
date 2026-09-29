import path from "node:path";
import {
  RETIRED_SALVAGE_REPORT_PATH,
} from "./shared.mjs";

export function createAttemptPolicy(ctx, rt) {
  const isoNow = (...args) => rt.isoNow(...args);

  function attemptLogPath(task, kind, attemptNumber) {
    return path.join(task.task_dir, `child-runner.attempt-${attemptNumber}.${kind}.log`);
  }

  function runningAttempt(task, attempt) {
    return {
      ...attempt,
      state: "running",
      contract_state: null,
      business_state: null,
      business_state_raw: null,
      requires_parent_review: false,
      salvage_report_path: RETIRED_SALVAGE_REPORT_PATH,
      salvage_evidence_paths: [],
      cancel_reason: null,
      started_at: isoNow(),
      stdout_path: attemptLogPath(task, "stdout", attempt.attempt),
      stderr_path: attemptLogPath(task, "stderr", attempt.attempt),
      failure_type: null,
      turn_status: null,
      error: null,
    };
  }

  function fallbackFailureType(childResult, exit) {
    return String(childResult?.failure_type || childResult?.failureType || (exit.code === 0 ? "none" : "child_runner_failed"));
  }

  // 真失败场景下暴露 child 卡在哪句话，避免主代理只看到泛化失败消息。
  function lastProgressLine(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.length ? lines[lines.length - 1].slice(0, 500) : "";
  }

  // status.json 的 attempts 只存标量与路径；child_result / final_text 留在磁盘文件，
  // status attempts 只保留标量与路径，终态 collect 再读取 handoff / report。
  function slimAttempt(outcome) {
    const { child_result, final_text, ...slim } = outcome;
    return {
      ...slim,
      error: typeof slim.error === "string" ? slim.error.split("\n")[0].slice(0, 300) : slim.error,
    };
  }

  return {
    attemptLogPath,
    runningAttempt,
    fallbackFailureType,
    lastProgressLine,
    slimAttempt,
  };
}
