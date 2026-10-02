// fleet_scheduler.mjs 按职责拆出的 cancel。只搬移代码，不改行为。
import { api } from "./api.mjs";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { isRecord, loadJson as readJson, ROOT, ToolError, utcNow } from "../_tool_common.mjs";
import { HOST_REBOOT_MARGIN_MS } from "../../async-core/runtime/shared.mjs";
import { ACTIVE_STATES, ASYNC_TERMINAL_STATES, TERMINAL_STATES } from "./constants.mjs";
import { deps } from "./deps.mjs";
import { hostPaths } from "./host-paths.mjs";
import { runMutationLock } from "./locks.mjs";
import { driverStatusPath, requireRepoInternal, runDir, statePath, writeJson } from "./paths.mjs";

/** Emit one settlement for each changed terminal driver outcome. */
export function settleFleetIfNeeded(state) {
  const terminal = (Array.isArray(state.nodes) ? state.nodes : []).every(
    (node) => isRecord(node) && TERMINAL_STATES.has(node.state),
  );
  if (!terminal) return false;
  const outcomeState = api.driverOutcome(state);
  state.run_state = outcomeState;
  let previousOutcome = null;
  const events = state.events;
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (isRecord(event) && event.type === "fleet_settled") {
        previousOutcome = event.business_state ?? null;
        break;
      }
    }
  }
  if (previousOutcome === outcomeState) {
    state.fleet_settled_emitted = true;
    return false;
  }
  api.appendFleetEvent(state, "fleet_settled", null, {
    businessState: outcomeState,
    incrementNodeRevision: false,
    counts: api.stateCounts(state),
  });
  state.fleet_settled_emitted = true;
  return true;
}

export function cancellationPath(root, runId) {
  return path.join(runDir(root, runId), "cancel-request.json");
}

export function cancelRun(runId, root, reason) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  if (!String(reason || "").trim()) throw new ToolError("cancellation reason is required");
  readJson(statePath(resolvedRoot, runId));
  // 独立于 tick 锁落盘；同步 command 的监督进程也消费此标记。
  try {
    writeFileSync(cancellationPath(resolvedRoot, runId), JSON.stringify({ reason, requested_at: utcNow() }), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  try {
    return runMutationLock(resolvedRoot, runId, () => {
      const state = readJson(statePath(resolvedRoot, runId));
      return settleCancellation(state);
    }, { timeoutSeconds: 5 });
  } catch (error) {
    if (!String(error.message).startsWith("fleet run mutation lock busy:")) throw error;
    return { status: "cancelling", run_id: runId, reason: "waiting_for_inflight_operation", submitted: [] };
  }
}

// A missing task record is not a completion receipt. Only a host reboot after the
// bound dispatch can establish that its former process tree no longer exists.
export function missingTaskStoppedByReboot(state, node, taskRoot, failures) {
  if (failures.length !== 1) return false;
  let lookup;
  try { lookup = JSON.parse(failures[0]); } catch { return false; }
  if (lookup?.error !== `Unknown task_id: ${node.task_id}`) return false;
  if (existsSync(path.join(taskRoot, node.task_id))) return false;
  const started = (state.events || []).filter((event) =>
    event.type === "agent_started" && event.node_id === node.id && event.task_id === node.task_id);
  if (started.length !== 1) return false;
  const dispatchedAt = Date.parse(started[0].at || started[0].timestamp || "");
  const bootTime = Number(deps.bootTimeMs());
  return Number.isFinite(dispatchedAt) && Number.isFinite(bootTime)
    && dispatchedAt + HOST_REBOOT_MARGIN_MS < bootTime
    && !(state.events || []).some((event) => event.node_id === node.id
      && event.task_id === node.task_id
      && event.type !== "agent_started"
      && Date.parse(event.at || event.timestamp || "") >= bootTime);
}

export function settleCancellation(state) {
  const errors = [];
  for (const node of state.nodes || []) {
    if ((ACTIVE_STATES.has(node.state) || node.state === "paused" || node.resource_quarantined) && node.task_id) {
      const taskRoot = api.nodeTaskRoot(state, node);
      try {
        node.cancel_reason = "user_requested";
        const [statuses, failures] = api.asyncInternalBatch("get", taskRoot, [node.task_id]);
        let status = statuses[node.task_id];
        if (!status && missingTaskStoppedByReboot(state, node, taskRoot, failures)) {
          api.setNodeState(state, node, "cancelled", { eventType: "agent_settled", businessState: "unknown",
            source: "host_reboot_missing_task" });
          node.missing_task_evidence = { task_id: node.task_id, source: "host_reboot", outcome: "unknown" };
          node.resource_quarantined = false;
          continue;
        }
        errors.push(...failures);
        if (!status) continue;
        if (!ASYNC_TERMINAL_STATES.has(status.state) || node.resource_quarantined) {
          const result = deps.runCommand([
            process.execPath, hostPaths.ASYNC_SERVICE_PATH, "internal", "cancel",
            "--task-root", taskRoot, "--task-id", node.task_id,
            "--expected-revision", String(status.revision), "--reason", "user_requested",
          ], ROOT);
          if (result.exit_code !== 0) errors.push((result.stderr || result.stdout).slice(0, 600));
          const [latest, refreshErrors] = api.asyncInternalBatch("get", taskRoot, [node.task_id]);
          errors.push(...refreshErrors);
          status = latest[node.task_id];
        }
        if (status) api.applyAsyncStatus(node, status, "fleet_cancel", state);
      } catch (error) {
        errors.push(`${node.id}: ${error.message}`);
      }
    } else if (ACTIVE_STATES.has(node.state) || node.resource_quarantined) {
      errors.push(`${node.id}: active execution has no confirmed termination`);
    } else if (node.state === "paused") {
      errors.push(`${node.id}: paused execution has no task_id; not marked cancelled`);
    } else if (!TERMINAL_STATES.has(node.state)) {
      api.setNodeState(state, node, "cancelled", { eventType: "agent_settled", businessState: "cancelled" });
      node.cancel_reason = "user_requested";
      node.not_executed = true;
    }
  }
  state.ready_queue = [];
  const active = (state.nodes || []).filter((node) => ACTIVE_STATES.has(node.state) || node.resource_quarantined);
  state.run_state = active.length || errors.length ? "cancelling" : "cancelled";
  state.cancellation = { ...readJson(cancellationPath(state.state_root, state.run_id)), errors };
  state.updated_at = utcNow();
  writeJson(statePath(state.state_root, state.run_id), state);
  if (state.run_state === "cancelled") {
    const driverFile = driverStatusPath(state.state_root, state.run_id);
    const driver = existsSync(driverFile) ? readJson(driverFile) : {};
    writeJson(driverFile, { ...driver, run_id: state.run_id, status: "cancelled",
      counts: api.stateCounts(state), updated_at: utcNow() });
  }
  return { status: state.run_state, run_id: state.run_id, active: active.map((node) => node.id), errors, submitted: [] };
}

Object.assign(api, {
  settleFleetIfNeeded,
  cancellationPath,
  cancelRun,
  missingTaskStoppedByReboot,
  settleCancellation,
});
