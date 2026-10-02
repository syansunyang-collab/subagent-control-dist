// fleet_scheduler.mjs 按职责拆出的 review。只搬移代码，不改行为。
import { existsSync } from "node:fs";
import { pyStr, pyStrip } from "../_py.mjs";
import { loadJson as readJson, rel, ROOT, ToolError, utcNow } from "../_tool_common.mjs";
import { cancellationPath } from "./cancel.mjs";
import { runMutationLock } from "./locks.mjs";
import { requireRepoInternal, statePath, writeJson } from "./paths.mjs";
import { positiveInt, resolveUnder } from "./py-utils.mjs";
import { appendFleetEvent, indexNodes, rebuildReadyQueue, setNodeState } from "./state.mjs";
import { loadManifestSnapshotForStatus } from "./summary.mjs";

export function reviewEvidencePath(value) {
  if (!pyStrip(value)) throw new ToolError("review evidence is required");
  const resolved = requireRepoInternal(resolveUnder(pyStrip(value), ROOT), "review evidence");
  if (!existsSync(resolved)) throw new ToolError(`review evidence does not exist: ${rel(resolved)}`);
  return rel(resolved);
}

export function appendReviewRecord(node, record) {
  if (!Object.hasOwn(node, "review_history")) node.review_history = [];
  const history = node.review_history;
  if (Array.isArray(history)) {
    history.push(record);
    if (history.length > 20) history.splice(0, history.length - 20);
  }
  node.review = record;
  node.review_decision = record.decision;
  node.review_required = false;
  node.reviewed_at = record.reviewed_at;
  return null;
}

export function reviewRun(runId, root, nodeIdValue, decision, evidence, reason) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  return runMutationLock(resolvedRoot, runId, () =>
    reviewRunLocked(runId, resolvedRoot, nodeIdValue, decision, evidence, reason));
}

export function reviewRunLocked(runId, root, nodeIdValue, decision, evidence, reason) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const target = statePath(resolvedRoot, runId);
  const state = readJson(target);
  const node = indexNodes(state)[nodeIdValue];
  if (!node) throw new ToolError(`node not found: ${nodeIdValue}`);
  if (existsSync(cancellationPath(resolvedRoot, runId))) throw new ToolError("fleet cancellation requested; start a new run instead of reviewing this run");
  const currentState = node.state;
  const settledRequeue = decision === "requeued" && ["done", "blocked", "failed", "cancelled"].includes(currentState);
  if (node.resource_quarantined || (currentState !== "needs_parent_review" && !settledRequeue)) {
    throw new ToolError(`node is not waiting for parent review: ${nodeIdValue} state=${pyStr(node.state ?? null)}`);
  }
  const evidencePath = decision === "requeued" && !pyStrip(evidence) ? null : reviewEvidencePath(evidence);
  const record = {
    decision,
    evidence_path: evidencePath,
    reason: pyStrip(reason),
    reviewed_at: utcNow(),
    previous_state: node.state ?? null,
    previous_task_id: node.task_id ?? null,
  };
  let reviewRound = positiveInt(node.review_round);
  if (decision !== "accepted") reviewRound += 1;
  node.review_round = reviewRound;
  record.round = reviewRound;
  appendReviewRecord(node, record);
  const fuseTripped = false;
  if (decision === "accepted") {
    setNodeState(state, node, "done", { eventType: "agent_settled", businessState: "completed" });
    delete node.blocked_by;
  } else if (decision === "blocked") {
    setNodeState(state, node, "blocked", { eventType: "agent_settled", businessState: "blocked" });
    node.blocked_by = "parent_review";
  } else if (decision === "requeued") {
    const previousTaskId = pyStr(node.task_id || "");
    if (previousTaskId) {
      if (!Object.hasOwn(node, "superseded_task_ids")) node.superseded_task_ids = [];
      const superseded = node.superseded_task_ids;
      if (Array.isArray(superseded) && !superseded.includes(previousTaskId)) {
        superseded.push(previousTaskId);
        if (superseded.length > 20) superseded.splice(0, superseded.length - 20);
      }
    }
    node.task_id = null;
    node.receipt_task_id = null;
    node.dispatch = null;
    node.last_status = null;
    node.review_required = false;
    node.review_decision = null;
    node.review = null;
    delete node.reviewed_at;
    delete node.next_liveness_check_at;
    delete node.blocked_by;
    setNodeState(state, node, "pending", { eventType: "agent_progress", businessState: "queued" });
  } else {
    throw new ToolError("review decision must be accepted, blocked or requeued");
  }
  node.updated_at = utcNow();
  state.updated_at = utcNow();
  appendFleetEvent(state, "review", node, {
    incrementNodeRevision: false,
    decision,
    evidence_path: evidencePath,
    review_round: reviewRound,
    fuse_tripped: fuseTripped,
  });
  const manifest = loadManifestSnapshotForStatus(state);
  if (manifest) rebuildReadyQueue(state, Array.isArray(manifest.nodes) ? [...manifest.nodes] : []);
  writeJson(target, state);
  return {
    status: "ok",
    run_id: runId,
    node_id: nodeIdValue,
    decision,
    node_state: node.state,
    review_round: reviewRound,
    fuse_tripped: fuseTripped,
    state_path: rel(target),
  };
}
