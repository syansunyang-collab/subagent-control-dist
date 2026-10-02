// fleet_scheduler.mjs 按职责拆出的 driver。只搬移代码，不改行为。
import { api } from "./api.mjs";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pyStr } from "../_py.mjs";
import { isRecord, loadJson as readJson, rel, ROOT, ToolError, utcNow } from "../_tool_common.mjs";
import {
  effectiveReviewPolicy,
  nodeDependencyPolicy,
  nodeFailurePolicy,
  nodeId,
  nodeIsReducer,
  nodeResourceLocks,
  nodeWriteScope,
  sortedStrings,
  topologicalLayers,
  validateManifest,
} from "../fleet_manifest_check.mjs";
import { ACTIVE_STATES, TERMINAL_STATES } from "./constants.mjs";
import { deps } from "./deps.mjs";
import { hostPaths } from "./host-paths.mjs";
import { acquireRunLockAsync, releaseRunLock, runMutationLock } from "./locks.mjs";
import { driverLogPath, driverStatusPath, requireRepoInternal, statePath, writeJson } from "./paths.mjs";
import { positiveInt, truthyList } from "./py-utils.mjs";
import { routeMatchesManifest, routeSnapshot } from "./route.mjs";

export function tickRun(runId, root, dryRun, verbose = false, { forceReconcile = false } = {}) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  return runMutationLock(resolvedRoot, runId, () =>
    tickRunLocked(runId, resolvedRoot, dryRun, verbose, { forceReconcile }));
}

export function tickRunLocked(runId, root, dryRun, verbose = false, { forceReconcile = false } = {}) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const target = statePath(resolvedRoot, runId);
  const state = readJson(target);
  if (existsSync(api.cancellationPath(resolvedRoot, runId))) {
    return dryRun ? { status: "cancelling", run_id: runId, submitted: [], dry_run: true } : api.settleCancellation(state);
  }
  const manifestSnapshot = pyStr(state.manifest_snapshot);
  const manifest = readJson(manifestSnapshot);
  const validation = validateManifest(manifest);
  if (validation.status !== "ok") {
    throw new ToolError(`fleet manifest no longer validates: ${validation.errors.join("; ")}`);
  }
  const manifestById = Object.create(null);
  for (const node of (Array.isArray(manifest.nodes) ? manifest.nodes : [])) {
    if (isRecord(node)) manifestById[nodeId(node)] = node;
  }
  const byId = api.indexNodes(state);
  for (const [nid, manifestNode] of Object.entries(manifestById)) {
    if (Object.hasOwn(byId, nid)) {
      if (!routeMatchesManifest(byId[nid], manifestNode)) {
        throw new ToolError(`frozen route identity changed for node ${nid}`);
      }
      byId[nid].dependency_policy = nodeDependencyPolicy(manifestNode);
      byId[nid].failure_policy = nodeFailurePolicy(manifestNode);
      byId[nid].resource_locks = nodeResourceLocks(manifestNode);
      byId[nid].is_reducer = nodeIsReducer(manifestNode);
      byId[nid].write_scope = nodeWriteScope(manifestNode);
    }
  }
  state.review_policy = effectiveReviewPolicy(manifest);
  state.run_state = "running";
  const refreshSummary = api.refreshActiveNodes(state, { forceReconcile });
  const acceptanceGateActions = api.enforceAcceptanceResultsGate(state, manifestById);
  if (acceptanceGateActions.length) refreshSummary.acceptance_results_gate = acceptanceGateActions;
  const allSettledUpdates = api.registerAllSettledConsumers(state);
  if (allSettledUpdates.length) refreshSummary.all_settled_updates = allSettledUpdates;
  const promotedDispatchFailures = api.promoteLegacyDispatchFailureBlocks(state);
  if (promotedDispatchFailures.length) refreshSummary.promoted_dispatch_failures = promotedDispatchFailures;
  const releasedDependencyBlocks = api.releaseResolvedDependencyBlocks(state, byId);
  if (releasedDependencyBlocks.length) refreshSummary.released_dependency_blocks = releasedDependencyBlocks;
  for (const node of (Array.isArray(state.nodes) ? state.nodes : [])) {
    if (!isRecord(node) || node.state !== "pending") continue;
    const badDep = api.blockedByFailedDependency(node, byId);
    if (badDep) {
      api.setNodeState(state, node, "blocked", {
        eventType: "agent_settled",
        businessState: "blocked",
        blocked_by: badDep,
        failure_fuse: true,
      });
      node.blocked_by = badDep;
      node.failure_fuse = { status: "tripped", blocked_by: badDep };
      api.setFailureFuse(state, {
        nodeIdValue: pyStr(node.id || ""),
        reason: "failed_dependency",
        blocker: badDep,
      });
    }
  }

  const submitted = [];
  const skipped = [];
  const activeScopes = api.activeWriteScopes(state);
  const activeResources = api.activeResourceLocks(state);
  let submittedThisTick = 0;
  const [layers] = topologicalLayers(Object.values(manifestById));
  const orderedIds = layers.flat();
  const readyIds = api.rebuildReadyQueue(state, Object.values(manifestById));
  const readySet = new Set(readyIds);
  for (const nid of orderedIds) {
    const node = byId[nid];
    if (!node || node.state !== "pending") continue;
    if (!readySet.has(nid)) skipped.push({ node_id: nid, reason: "waiting_for_dependencies" });
  }
  const queueWorking = [...readyIds];
  if (!dryRun && state.resume_pending && existsSync(api.pauseRequestPath(resolvedRoot, runId))) {
    const resumeInfo = api.resumePausedTasks(state, api.readPauseIntent(resolvedRoot, runId));
    state.resume_status = resumeInfo;
    if (!resumeInfo.pending_task_ids.length) {
      rmSync(api.pauseRequestPath(resolvedRoot, runId), { force: true });
      state.resume_pending = false;
      state.resume_status = null;
      state.pause_request = null;
      for (const node of state.nodes || []) {
        node.pause_requested = false;
        node.pause_request_reason = null;
      }
      writeJson(target, state);
      return tickRunLocked(runId, resolvedRoot, false, verbose, { forceReconcile: true });
    }
  }
  if (existsSync(api.pauseRequestPath(resolvedRoot, runId))) {
    // run级停派：意图文件在锁内重新读取，pending 节点保持原图与依赖，不标 cancelled/not_executed。
    const intent = api.readPauseIntent(resolvedRoot, runId);
    const receipt = dryRun
      ? { run_id: runId, accepted: true, state: "pausing", reason: "dry_run", paused_task_ids: [], pending_task_ids: [] }
      : state.resume_pending
        ? { run_id: runId, accepted: true, state: "pausing", reason: "resume_pending", ...state.resume_status, next_step: api.RESUME_SEAM_NEXT_STEP }
        : api.settlePause(state, { reason: intent?.reason ?? null });
    state.run_state = receipt.state;
    state.ready_queue = [...(state.ready_queue || [])].filter((nid) => (byId[nid] ?? {}).state === "pending");
    state.updated_at = utcNow();
    const pausedSkipped = (state.ready_queue || []).map((nid) => ({ node_id: nid, reason: "run_paused" }));
    if (dryRun) {
      return {
        status: "ok", dry_run: true, run_id: runId, paused: true, submitted: [], skipped: pausedSkipped,
        pause: receipt, ready_queue: [...(state.ready_queue || [])], state_path: rel(target),
      };
    }
    api.appendFleetEvent(state, "run_pause", null, {
      incrementNodeRevision: false,
      pause: receipt,
      skipped: pausedSkipped,
    });
    writeJson(target, state);
    return {
      status: "ok", dry_run: false, run_id: runId, paused: true, submitted: [], skipped: pausedSkipped,
      pause: receipt, ready_queue: [...(state.ready_queue || [])], state_path: rel(target),
    };
  }
  for (const nid of readyIds) {
    if (existsSync(api.cancellationPath(resolvedRoot, runId)) || existsSync(api.pauseRequestPath(resolvedRoot, runId))) break;
    const node = byId[nid];
    if (!node || node.state !== "pending") continue;
    const resourceOwner = api.resourceLocked(node, activeResources);
    if (resourceOwner) {
      skipped.push({ node_id: nid, reason: `resource_locked_by:${resourceOwner}` });
      continue;
    }
    const lockedBy = api.writeLocked(node, activeScopes);
    if (lockedBy) {
      skipped.push({ node_id: nid, reason: `write_locked_by:${lockedBy}` });
      continue;
    }
    const [ok, reason] = api.budgetAllows(node, state, submittedThisTick);
    if (!ok) {
      skipped.push({ node_id: nid, reason });
      continue;
    }
    const outcome = deps.dispatchNode(state, manifest, node, manifestById[nid], { dryRun });
    if (outcome.status === "needs_parent_review") {
      if (node.resource_quarantined) {
        activeScopes.push([nid, [...(node.write_scope || [])]]);
        activeResources.push([nid, [...(node.resource_locks || [])]]);
      }
      skipped.push({ node_id: nid, reason: Object.hasOwn(outcome, "reason") ? outcome.reason : "requires_parent_review" });
      const index = queueWorking.indexOf(nid);
      if (index !== -1) queueWorking.splice(index, 1);
      continue;
    }
    submitted.push(outcome);
    submittedThisTick += 1;
    const index = queueWorking.indexOf(nid);
    if (index !== -1 && (dryRun || outcome.status === "ok")) queueWorking.splice(index, 1);
    if (!dryRun && outcome.status === "ok" && !outcome.terminal) {
      activeScopes.push([nid, [...(node.write_scope || [])]]);
      activeResources.push([nid, [...(node.resource_locks || [])]]);
    }
  }

  state.ready_queue = queueWorking.filter((nid) => (byId[nid] ?? {}).state === "pending");
  state.ready_queue_revision = positiveInt(state.revision);
  state.updated_at = utcNow();
  const routeProvenanceUpdates = [];
  for (const node of (Array.isArray(state.nodes) ? state.nodes : [])) {
    if (!isRecord(node) || !TERMINAL_STATES.has(node.state)) continue;
    if (api.enrichTerminalRouteFromRuntime(node)) {
      const nodeIdValue = pyStr(node.id || "");
      routeProvenanceUpdates.push(nodeIdValue);
      api.appendFleetEvent(state, "route_provenance", node, {
        incrementNodeRevision: false,
        source: "terminal_runtime_artifacts",
        route: routeSnapshot(node),
      });
    }
  }
  if (routeProvenanceUpdates.length) refreshSummary.route_provenance_updates = routeProvenanceUpdates;
  api.settleFleetIfNeeded(state);
  const compactSubmitted = submitted.map((item) => api.compactDispatchOutcome(item));
  const returnedSubmitted = verbose ? submitted : compactSubmitted;
  let data;
  if (dryRun) {
    data = {
      status: "ok",
      dry_run: true,
      run_id: runId,
      detail_level: verbose ? "full" : "compact",
      submitted: returnedSubmitted,
      skipped,
      ready_queue: [...(state.ready_queue || [])],
      state_path: rel(target),
    };
  } else {
    api.appendFleetEvent(state, "tick", null, {
      incrementNodeRevision: false,
      refresh: refreshSummary,
      submitted: compactSubmitted,
      skipped,
    });
    state.ready_queue_revision = positiveInt(state.revision);
    writeJson(target, state);
    data = {
      status: "ok",
      dry_run: false,
      run_id: runId,
      detail_level: verbose ? "full" : "compact",
      refresh: refreshSummary,
      submitted: returnedSubmitted,
      skipped,
      ready_queue: [...(state.ready_queue || [])],
      event_cursor: `${runId}+${positiveInt(state.event_revision)}`,
      state_path: rel(target),
    };
  }
  return data;
}

export function waitRun(runId, root, waitMs, { verbose = false } = {}) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const target = statePath(resolvedRoot, runId);
  const state = readJson(target);
  const waited = api.waitForCompletionNotices(state, waitMs);
  const data = { run_id: runId, state_path: rel(target), ...waited };
  if (waited.event === "completion_notice") {
    data.tick = tickRun(runId, resolvedRoot, false, verbose);
  }
  return data;
}

/**
 * Reconcile existing task identities before rebuilding and draining ready_queue.
 * 存在 run级停派意图时先解除意图并恢复本次 pause 记录的任务，再继续既有 DAG。
 */
export function resumeRun(runId, root, { dryRun = false, verbose = false } = {}) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  return runMutationLock(resolvedRoot, runId, () => {
    const before = readJson(statePath(resolvedRoot, runId));
    const activeBefore = sortedStrings(
      (Array.isArray(before.nodes) ? before.nodes : [])
        .filter((node) => isRecord(node) && ACTIVE_STATES.has(node.state) && node.task_id)
        .map((node) => pyStr(node.id || "")),
    );
    const intent = api.readPauseIntent(resolvedRoot, runId);
    let resumeInfo = null;
    if (intent && dryRun) return {
      ...api.buildStatusSummary(before), accepted: false, state: before.run_state, reason: "dry_run", resumed: false,
    };
    if (intent && (existsSync(api.cancellationPath(resolvedRoot, runId)) || before.cancel_request)) return {
      ...tickRunLocked(runId, resolvedRoot, false, verbose),
      accepted: false, state: "cancelling", reason: "cancel_priority", resumed: false,
    };
    if (intent) {
      resumeInfo = api.resumePausedTasks(before, intent);
      if (resumeInfo.pending_task_ids.length) {
        before.run_state = "pausing";
        before.resume_pending = true;
        before.resume_status = resumeInfo;
        writeJson(statePath(resolvedRoot, runId), before);
        return {
          run_id: runId, accepted: true, resumed: false, state: "pausing", reason: "resume_pending",
          pending_task_ids: resumeInfo.pending_task_ids, errors: resumeInfo.errors,
          paused_task_ids: before.nodes.filter((node) => node.state === "paused").map((node) => node.task_id),
          next_step: api.RESUME_SEAM_NEXT_STEP,
        };
      }
      rmSync(api.pauseRequestPath(resolvedRoot, runId), { force: true });
      before.run_state = "running";
      before.resume_pending = false;
      before.resume_status = null;
      before.pause_request = null;
      for (const node of (Array.isArray(before.nodes) ? before.nodes : [])) {
        if (!isRecord(node)) continue;
        node.pause_requested = false;
        node.pause_request_reason = null;
      }
      // 先落盘解除意图，避免并发 tick 的旧快照把停派意图写回来。
      writeJson(statePath(resolvedRoot, runId), before);
    }
    const data = tickRunLocked(runId, resolvedRoot, dryRun, verbose, { forceReconcile: true });
    data.resumed = true;
    data.active_before = activeBefore;
    data.reconcile_requested = Boolean(activeBefore.length);
    data.duplicate_submission_guard = true;
    const after = readJson(statePath(resolvedRoot, runId));
    const afterRunState = pyStr(after.run_state || "");
    const pendingTaskIds = resumeInfo?.pending_task_ids ?? [];
    Object.assign(data, {
      run_id: runId,
      accepted: true,
      state: ["cancelled", "cancelling", "completed", "blocked", "needs_parent_review", "failed"].includes(afterRunState)
        ? afterRunState
        : pendingTaskIds.length ? "paused" : "running",
      reason: intent ? (pendingTaskIds.length ? "resume_pending" : "resume_accepted") : "no_pause_request",
      paused_task_ids: (Array.isArray(after.nodes) ? after.nodes : [])
        .filter((node) => isRecord(node) && node.state === "paused" && pyStr(node.task_id || ""))
        .map((node) => pyStr(node.task_id)),
      pending_task_ids: pendingTaskIds,
    });
    if (resumeInfo?.errors.length) {
      data.errors = resumeInfo.errors.slice(0, 20);
      data.next_step = api.RESUME_SEAM_NEXT_STEP;
    }
    return data;
  });
}

export function driverOutcome(state) {
  if (["cancelled", "cancelling"].includes(state.run_state)) return state.run_state;
  const nodes = (Array.isArray(state.nodes) ? state.nodes : []).filter((node) => isRecord(node));
  // run级停派意图：还有未终态节点时保持 pausing/paused，driver 不派节点也不判卡死；
  // 全部节点已终态时仍按实际终态收口，不把 done/failed/cancelled 改成 paused。
  if (["paused", "pausing"].includes(state.run_state)
    && nodes.some((node) => !TERMINAL_STATES.has(node.state))) {
    return state.run_state;
  }
  if (nodes.some((node) => ACTIVE_STATES.has(node.state))) return "running";
  const pausedHold = nodes.some((node) => node.state === "paused");
  if (nodes.some((node) => !TERMINAL_STATES.has(node.state))) {
    if (nodes.some((node) => node.state === "needs_parent_review" && !truthyList(node.all_settled_consumers))) {
      return "needs_parent_review";
    }
    if (pausedHold && !nodes.some((node) => node.state === "pending" || node.state === "ready")) {
      return "paused";
    }
    return "ready";
  }
  if (nodes.some((node) => node.state === "needs_parent_review" && !truthyList(node.all_settled_consumers))) {
    return "needs_parent_review";
  }
  if (nodes.some((node) => ["failed", "cancelled", "blocked"].includes(node.state)
    && !truthyList(node.all_settled_consumers))) {
    return "blocked";
  }
  return "completed";
}

export function writeDriverStatus(root, runId, data) {
  const currentPath = driverStatusPath(root, runId);
  const previous = existsSync(currentPath) ? readJson(currentPath) : {};
  writeJson(currentPath, {
    ...previous,
    run_id: runId,
    pid: process.pid,
    updated_at: utcNow(),
    ...data,
  });
  return null;
}

export function persistDriverOutcome(root, runId, outcome, error = null) {
  runMutationLock(root, runId, () => {
    const target = statePath(root, runId);
    const state = readJson(target);
    const changed = state.run_state !== outcome || state.driver_error !== error;
    state.run_state = outcome;
    state.driver_error = error;
    if (changed) api.appendFleetEvent(state, "driver_status", null, {
      incrementNodeRevision: false, error, attention_required: outcome !== "completed",
    });
    writeJson(target, state);
  });
}

export function driveRun(runId, root, waitMs) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  if (waitMs < 1000 || waitMs > 600000) throw new ToolError("driver wait_ms must be between 1000 and 600000");
  const target = statePath(resolvedRoot, runId);
  readJson(target);
  writeDriverStatus(resolvedRoot, runId, { status: "running", started_at: utcNow(), error: null });
  let ticks = 0;
  let idleReadyTicks = 0;
  try {
    for (;;) {
      const tickData = tickRun(runId, resolvedRoot, false);
      ticks += 1;
      const state = readJson(target);
      const outcome = driverOutcome(state);
      if (["completed", "blocked", "needs_parent_review", "cancelled"].includes(outcome)) {
        const data = {
          status: outcome,
          run_id: runId,
          ticks,
          counts: api.stateCounts(state),
          state_path: rel(target),
          driver_status_path: rel(driverStatusPath(resolvedRoot, runId)),
          finished_at: utcNow(),
        };
        persistDriverOutcome(resolvedRoot, runId, outcome);
        writeDriverStatus(resolvedRoot, runId, data);
        return data;
      }
      if (outcome === "running") {
        writeDriverStatus(resolvedRoot, runId, { status: "running", resume_pending: false, pause: null });
        idleReadyTicks = 0;
        waitRun(runId, resolvedRoot, waitMs);
        continue;
      }
      if (outcome === "cancelling") {
        writeDriverStatus(resolvedRoot, runId, { status: outcome, ticks, counts: api.stateCounts(state) });
        deps.sleep(Math.min(waitMs / 1000, 1));
        continue;
      }
      if (outcome === "paused" || outcome === "pausing") {
        // 保留监听进程并公开停车状态，resume_pending 由下一轮 tick 续试。
        persistDriverOutcome(resolvedRoot, runId, outcome);
        writeDriverStatus(resolvedRoot, runId, {
          status: outcome, resume_pending: Boolean(state.resume_pending),
          pause: tickData.pause ?? null, ticks,
        });
        idleReadyTicks = 0;
        deps.sleep(Math.min(waitMs / 1000, 1));
        continue;
      }
      if (outcome === "ready") {
        // 同步节点（command/gate）当轮终态后，下游要到下一次队列重建才就绪：
        // ready 意味着“立刻再 tick”，只有连续空转才判卡死。
        // 暂停节点挡住依赖时不计入空转，避免把持有态误判成死锁。
        const pausedHold = (state.nodes || []).some((node) => isRecord(node) && node.state === "paused");
        if (truthyList(tickData.submitted) || pausedHold) {
          idleReadyTicks = 0;
          if (!truthyList(tickData.submitted)) deps.sleep(0.5);
        } else {
          idleReadyTicks += 1;
          if (idleReadyTicks >= 3) throw new ToolError("fleet driver stalled with ready nodes making no progress");
          // 给并发的 review/tick 一个非零时间窗，避免毫秒级三振误杀。
          deps.sleep(0.5);
        }
        continue;
      }
      throw new ToolError("fleet driver stalled with pending nodes but no active or review-gated node");
    }
  } catch (error) {
    persistDriverOutcome(resolvedRoot, runId, "failed", String(error?.message ?? error));
    writeDriverStatus(resolvedRoot, runId, {
      status: "failed",
      error: String(error?.message ?? error),
      finished_at: utcNow(),
    });
    throw error;
  }
}

export async function launchDriverImpl(runId, root, waitMs) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  // 启动观察窗口要让事件循环跑起来才拿得到退出码，锁必须持到 await 回来之后再放。
  const lock = await acquireRunLockAsync(resolvedRoot, runId);
  try {
    return await launchDriverLocked(runId, resolvedRoot, waitMs);
  } finally {
    releaseRunLock(lock);
  }
}

export function launchDriver(runId, root, waitMs) {
  return deps.launchDriver(runId, root, waitMs);
}

export async function launchDriverLocked(runId, root, waitMs) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const target = statePath(resolvedRoot, runId);
  const state = readJson(target);
  if (existsSync(api.cancellationPath(resolvedRoot, runId)) && state.run_state === "cancelled") return { status: "cancelled", run_id: runId, started: false };
  const statusFile = driverStatusPath(resolvedRoot, runId);
  const existing = existsSync(statusFile) ? readJson(statusFile) : {};
  if (["running", "cancelling", "paused", "pausing"].includes(existing.status) && deps.processAlive(existing.pid)) {
    return {
      status: "ok",
      run_id: runId,
      pid: existing.pid ?? null,
      reused: true,
      state_path: rel(target),
      driver_status_path: rel(statusFile),
      log_path: rel(driverLogPath(resolvedRoot, runId)),
    };
  }

  const logPath = driverLogPath(resolvedRoot, runId);
  mkdirSync(path.dirname(logPath), { recursive: true });
  const command = [
    process.execPath,
    hostPaths.SCHEDULER_CLI_PATH,
    "drive",
    "--run-id",
    runId,
    "--state-root",
    resolvedRoot,
    "--wait-ms",
    pyStr(waitMs),
    "--format",
    "json",
  ];
  const log = openSync(logPath, "a");
  let child;
  try {
    child = deps.spawnDriver(command[0], command.slice(1), {
      cwd: ROOT,
      stdio: ["ignore", log, log],
      detached: true,
      windowsHide: true,
    });
  } finally {
    closeSync(log);
  }
  let spawnError = null;
  // Install error handling before yielding: spawn errors otherwise become uncaught events.
  child.once("error", (error) => { spawnError = error; });
  child.unref();
  // 等 driver 自己写下 running 状态（driveRun 的第一步）或进程先退出；负载高时固定窗口会漏判启动即崩。
  // A quick exit(0) remains successful; preserve a child's terminal status below.
  const failedToStart = () => spawnError || child.signalCode !== null || (child.exitCode !== null && child.exitCode !== 0);
  const startDeadline = Date.now() + 10000;
  while (!failedToStart() && child.exitCode === null && Date.now() < startDeadline) {
    await delay(50);
    if (existsSync(statusFile) && readJson(statusFile).pid === child.pid) break;
  }
  if (failedToStart()) {
    const tail = readFileSync(logPath, "utf8").slice(-1200);
    throw new ToolError(`fleet driver failed to start: ${spawnError?.message || child.signalCode || ""}${tail}`);
  }
  const latest = existsSync(statusFile) ? readJson(statusFile) : {};
  if (latest.pid !== child.pid) {
    writeJson(statusFile, {
      run_id: runId,
      pid: child.pid,
      status: "running",
      started_at: utcNow(),
      updated_at: utcNow(),
      error: null,
    });
  }
  return {
    status: "ok",
    run_id: runId,
    pid: child.pid,
    reused: false,
    state_path: rel(target),
    driver_status_path: rel(statusFile),
    log_path: rel(logPath),
  };
}

Object.assign(api, {
  tickRun,
  tickRunLocked,
  waitRun,
  resumeRun,
  driverOutcome,
  writeDriverStatus,
  persistDriverOutcome,
  driveRun,
  launchDriverImpl,
  launchDriver,
  launchDriverLocked,
});
