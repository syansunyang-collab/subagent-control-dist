import { readFileSync } from "node:fs";
import path from "node:path";

const GATES = new Set(["pass", "fail", "needs_owner"]);

// Read-only display projection. Legacy business_state and all scheduling/ack gates remain authoritative.
// Missing evidence is unknown, never inferred from the agent role or transport success alone.
export function projectTaskOutcome(status = {}, child = {}, taskPackage = {}) {
  const failure = status.failure_type && status.failure_type !== "none";
  // Persisted orchestration describes execution; process exit may instead encode a partial business verdict.
  const orchestration = child?.orchestration;
  const execution = status.state === "cancelled" || status.turn_status === "cancelled" ? "cancelled"
    : orchestration?.ok === true && orchestration.status === "completed" && orchestration.failure_type === "none" ? "completed"
    : orchestration?.ok === false || failure || (status.exit_code != null && status.exit_code !== 0)
      || ["failed", "error"].includes(status.turn_status) ? "failed"
    : status.exit_code === 0 && ["completed", "done"].includes(status.turn_status) ? "completed" : "unknown";
  const business = child?.task?.agentDeclaredStatus ?? child?.task?.status ?? status.business_state ?? "unknown";
  const delivery = status.contract_state === "ok" ? "delivered"
    : status.contract_state ? "unconfirmed" : "unknown";
  const gate = GATES.has(child?.task?.reviewGate) ? child.task.reviewGate
    : child?.review_synthesis?.applied === true && GATES.has(child.review_synthesis.gate)
      ? child.review_synthesis.gate : "unknown";
  const name = typeof taskPackage?.expected_output?.business_gate === "string"
    ? taskPackage.expected_output.business_gate.replace(/^FINAL_HANDOFF\.output\./, "") : null;
  const parent = status.requires_parent_review === true ? "required"
    : status.requires_parent_review === false ? "not_required" : "unknown";
  const outcome = {
    execution,
    business,
    delivery,
    object_gate: { name, value: gate, source: gate === "unknown" ? null
      : GATES.has(child?.task?.reviewGate) ? "child-task-result.json:task.reviewGate" : "child-task-result.json:review_synthesis.gate" },
    parent_review: parent,
  };
  return { ...outcome, summary: summarizeTaskOutcome(outcome) };
}

// Render the same facts even when a bounded receipt has omitted its redundant summary.
export function summarizeTaskOutcome(outcome = {}) {
  const executionText = { completed: "运行结束", failed: "运行失败", cancelled: "运行已取消", unknown: "运行结果未知" }[outcome.execution];
  const deliveryText = { delivered: "合同产物已交付", unconfirmed: "合同交付未确认", unknown: "合同交付未知" }[outcome.delivery];
  const gateText = { pass: "通过", fail: "不通过", needs_owner: "待负责人裁决", unknown: "未知" }[outcome.object_gate?.value];
  return [executionText, deliveryText,
    outcome.business === "partial" ? "任务部分完成"
      : outcome.business === "failed" && outcome.object_gate?.value !== "fail" ? "任务失败"
      : ["blocked", "needs_owner"].includes(outcome.business) ? "任务受阻" : null,
    GATES.has(outcome.object_gate?.value) || outcome.object_gate?.name
      ? `对象门${gateText}${outcome.object_gate?.name ? `（${outcome.object_gate.name}）` : ""}` : null,
    outcome.parent_review === "required" ? "待主代理处置" : null].filter(Boolean).join("；");
}

function readObject(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return {}; } // Legacy/missing/malformed display evidence remains unknown; never changes task state.
}

export function readTaskOutcome(status = {}, taskDir = status.task_dir) {
  if (!taskDir) return projectTaskOutcome(status);
  return projectTaskOutcome(status,
    readObject(path.join(taskDir, "child-task-result.json")),
    readObject(path.join(taskDir, "task-package.json")));
}
