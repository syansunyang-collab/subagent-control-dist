// fleet_scheduler.mjs 按职责拆出的 summary。只搬移代码，不改行为。
import { api } from "./api.mjs";
import { existsSync } from "node:fs";
import { pyJsonDumps, pyRStrip, pyStr, pyStrip } from "../_py.mjs";
import { canonicalValue, isRecord, loadJson as readJson, rel, ROOT } from "../_tool_common.mjs";
import { topologicalLayers } from "../fleet_manifest_check.mjs";
import { ACTIVE_STATES, SUMMARY_EVENT_LIMIT, SUMMARY_NODE_LIMIT } from "./constants.mjs";
import { requireRepoInternal, statePath } from "./paths.mjs";
import { notEmptyPy, resolveUnder, truthyList } from "./py-utils.mjs";
import { routeSnapshot } from "./route.mjs";

export function stateCounts(state) {
  const counts = Object.create(null);
  for (const node of (Array.isArray(state.nodes) ? state.nodes : [])) {
    if (isRecord(node)) {
      const nodeState = pyStr(node.state || "unknown");
      counts[nodeState] = (counts[nodeState] ?? 0) + 1;
    }
  }
  return counts;
}

export function shortText(value, limit = 220) {
  const text = pyStrip(pyStr(value).split("\r").join(" ").split("\n").join(" "));
  if (text.length <= limit) return text;
  return `${pyRStrip(text.slice(0, limit - 3))}...`;
}

export function compactNode(node) {
  const data = {
    id: node.id ?? null,
    state: node.state ?? null,
    kind: node.kind ?? null,
    role: node.role ?? null,
    route_id: node.route_id ?? null,
    route: routeSnapshot(node),
    route_source: node.route_source ?? null,
    dependency_policy: node.dependency_policy ?? null,
    failure_policy: node.failure_policy ?? null,
    resource_locks: node.resource_locks ?? null,
    is_reducer: node.is_reducer ?? null,
    revision: Object.hasOwn(node, "revision") ? node.revision : 0,
    task_id: node.task_id ?? null,
    updated_at: node.updated_at ?? null,
  };
  for (const key of [
    "blocked_by",
    "review_required",
    "review_decision",
    "reviewed_at",
    "review_deferred_to",
    "all_settled_consumers",
    "next_liveness_check_at",
    "review_round",
    "superseded_task_ids",
    "warnings",
  ]) {
    if (notEmptyPy(node[key])) data[key] = node[key];
  }
  const lastStatus = node.last_status;
  if (isRecord(lastStatus)) {
    for (const key of [
      "source",
      "contract_state",
      "business_state",
      "business_state_raw",
      "artifact_state",
      "requires_parent_review",
      "cancel_reason",
      "failure_type",
      "turn_status",
      "exit_code",
      "signal",
      "error",
      "process_alive",
      "completion_notice_path",
      "report_path",
      "handoff_path",
      "declared_report_path",
      "business_report_path",
      "salvage_report_path",
      "salvage_evidence_paths",
      "live_path",
      "last_progress_line",
      // 运行项只展示遥测，不从时长、工具次数或静默推导异常。
      "elapsed_seconds",
      "live_age_seconds",
      "tool_call_count",
      "last_tool_kind",
      "progress_state",
    ]) {
      if (notEmptyPy(lastStatus[key])) {
        const value = lastStatus[key];
        data[key] = typeof value === "string" ? shortText(value) : value;
      }
    }
  }
  if (["accepted", "blocked"].includes(node.review_decision)) {
    data.review_gate = node.review_decision === "accepted" ? "pass" : "fail";
    data.requires_parent_review = false;
  } else if (isRecord(lastStatus) && lastStatus.review_gate) {
    data.review_gate = lastStatus.review_gate;
  }
  const review = node.review;
  if (isRecord(review)) {
    const projected = {};
    for (const [key, value] of Object.entries(review)) {
      if (!["decision", "evidence_path", "reason", "reviewed_at"].includes(key)) continue;
      if (value === null || value === undefined || value === "") continue;
      projected[key] = typeof value === "string" ? shortText(value) : value;
    }
    data.review = projected;
  }
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (notEmptyPy(value) || (key === "requires_parent_review" && ["accepted", "blocked"].includes(node.review_decision))) out[key] = value;
  }
  return out;
}

export function compactEvent(event) {
  const data = {};
  for (const key of [
    "at",
    "timestamp",
    "type",
    "run_id",
    "node_id",
    "task_id",
    "revision",
    "node_revision",
    "fleet_revision",
    "cursor",
    "state",
    "business_state",
    "decision",
    "evidence_path",
    "source",
    "reason",
    "review_round",
    "fuse_tripped",
    "route",
    "route_source",
    "requested_route",
    "actual_route",
    "usage_provenance",
    "error",
    "attention_required",
  ]) {
    if (notEmptyPy(event[key])) data[key] = event[key];
  }
  for (const key of ["submitted", "skipped"]) {
    const value = event[key];
    if (Array.isArray(value)) data[`${key}_count`] = value.length;
  }
  const refresh = event.refresh;
  if (isRecord(refresh)) {
    const projected = {};
    for (const key of [
      "active",
      "inbox",
      "queried",
      "reconciled",
      "inspection_deferred",
      "released_dependency_blocks",
      "all_settled_updates",
      "errors",
    ]) {
      if (notEmptyPy(refresh[key])) projected[key] = refresh[key];
    }
    data.refresh = projected;
  }
  return data;
}

export function loadManifestSnapshotForStatus(state) {
  const pathText = state.manifest_snapshot;
  if (!pathText) return null;
  const resolved = requireRepoInternal(resolveUnder(pyStr(pathText), ROOT), "manifest snapshot");
  if (!existsSync(resolved)) return null;
  return readJson(resolved);
}

export function orderedPendingIds(state, manifest) {
  const byId = api.indexNodes(state);
  const pendingIds = (Array.isArray(state.nodes) ? state.nodes : [])
    .filter((node) => isRecord(node) && node.state === "pending")
    .map((node) => pyStr(node.id ?? null));
  if (!manifest) return pendingIds;
  const manifestNodesList = (Array.isArray(manifest.nodes) ? manifest.nodes : []).filter((node) => isRecord(node));
  let layers;
  try {
    [layers] = topologicalLayers(manifestNodesList);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    return pendingIds;
  }
  const layerIndex = Object.create(null);
  layers.forEach((layer, index) => {
    for (const nid of layer) layerIndex[nid] = index;
  });
  const criticality = api.downstreamCounts(manifestNodesList);
  const ordered = layers.flat().filter((nid) => Object.hasOwn(byId, nid) && byId[nid].state === "pending");
  const seen = new Set(ordered);
  for (const nid of pendingIds) {
    if (!seen.has(nid)) ordered.push(nid);
  }
  ordered.sort((left, right) => {
    const leftKey = [-(criticality[left] ?? 0), layerIndex[left] ?? 0, left];
    const rightKey = [-(criticality[right] ?? 0), layerIndex[right] ?? 0, right];
    for (let i = 0; i < 3; i += 1) {
      if (leftKey[i] < rightKey[i]) return -1;
      if (leftKey[i] > rightKey[i]) return 1;
    }
    return 0;
  });
  return ordered;
}

export function nextReadySummary(state, manifest) {
  const byId = api.indexNodes(state);
  const activeScopes = api.activeWriteScopes(state);
  const ready = [];
  const blockedReady = [];
  let submittedThisTick = 0;
  for (const nid of orderedPendingIds(state, manifest)) {
    const node = byId[nid];
    if (!node) continue;
    const badDep = api.blockedByFailedDependency(node, byId);
    if (badDep) {
      blockedReady.push({ id: nid, reason: `blocked_dependency:${badDep}` });
      continue;
    }
    if (!api.dependenciesReady(node, byId)) continue;
    const lockedBy = api.writeLocked(node, activeScopes);
    if (lockedBy) {
      blockedReady.push({ id: nid, reason: `write_locked_by:${lockedBy}` });
      continue;
    }
    const [ok, reason] = api.budgetAllows(node, state, submittedThisTick);
    if (!ok) {
      blockedReady.push({ id: nid, reason });
      continue;
    }
    ready.push(compactNode(node));
    submittedThisTick += 1;
    activeScopes.push([nid, [...(node.write_scope || [])]]);
    if (ready.length >= SUMMARY_NODE_LIMIT) break;
  }
  return [ready, blockedReady.slice(0, SUMMARY_NODE_LIMIT)];
}

export function buildStatusSummary(state, manifest) {
  const nodes = (Array.isArray(state.nodes) ? state.nodes : []).filter((node) => isRecord(node));
  const counts = stateCounts(state);
  const active = nodes.filter((node) => ACTIVE_STATES.has(node.state)).map((node) => compactNode(node));
  const needsReview = nodes
    .filter((node) => node.state === "needs_parent_review" && !truthyList(node.all_settled_consumers))
    .map((node) => compactNode(node));
  const paused = nodes.filter((node) => node.state === "paused").map((node) => compactNode(node));
  const aggregatedInputs = nodes.filter((node) => truthyList(node.all_settled_consumers)).map((node) => compactNode(node));
  const failedOrBlocked = nodes
    .filter((node) => ["failed", "cancelled", "blocked"].includes(node.state) && !truthyList(node.all_settled_consumers))
    .map((node) => compactNode(node));
  const recentCompleted = stableSortDesc(
    nodes.filter((node) => node.state === "done").map((node) => compactNode(node)),
    (node) => pyStr(node.updated_at || ""),
  ).slice(0, SUMMARY_NODE_LIMIT);
  const [nextReady, blockedReady] = nextReadySummary(state, manifest);
  const events = Array.isArray(state.events) ? state.events : [];
  const recentEvents = events.slice(-SUMMARY_EVENT_LIMIT).filter((event) => isRecord(event)).map((event) => compactEvent(event));
  return {
    total: nodes.length,
    counts,
    run_state: state.state_root && state.run_id && existsSync(api.cancellationPath(state.state_root, state.run_id))
      ? (state.run_state === "cancelled" ? "cancelled" : "cancelling") : state.run_state ?? null,
    ...(state.cancellation ? { cancellation: { ...state.cancellation, errors: (state.cancellation.errors || []).slice(0, SUMMARY_NODE_LIMIT) } } : {}),
    revision: Object.hasOwn(state, "revision") ? state.revision : 0,
    event_revision: Object.hasOwn(state, "event_revision") ? state.event_revision : 0,
    ready_queue: [...(state.ready_queue || [])].slice(0, SUMMARY_NODE_LIMIT),
    failure_fuse: isRecord(state.failure_fuse) ? state.failure_fuse : {},
    review_policy: isRecord(state.review_policy) ? state.review_policy : {},
    active: active.slice(0, SUMMARY_NODE_LIMIT),
    needs_review: needsReview.slice(0, SUMMARY_NODE_LIMIT),
    paused: paused.slice(0, SUMMARY_NODE_LIMIT),
    aggregated_inputs: aggregatedInputs.slice(0, SUMMARY_NODE_LIMIT),
    recent_completed: recentCompleted,
    failed_or_blocked: failedOrBlocked.slice(0, SUMMARY_NODE_LIMIT),
    next_ready: nextReady,
    ready_blocked: blockedReady,
    recent_events: recentEvents,
    manifest_available: manifest !== null && manifest !== undefined,
    ...(nodes.some(node => node.warnings?.length) ? {
      warning_node_count: nodes.filter(node => node.warnings?.length).length,
      warnings: nodes.filter(node => node.warnings?.length).slice(0, SUMMARY_NODE_LIMIT).map(node => ({ node_id: node.id, warnings: node.warnings })),
    } : {}),
  };
}

/** sorted(..., reverse=True)：Python 的稳定排序在 reverse=True 下仍保留等值项原序。 */
export function stableSortDesc(items, keyOf) {
  return items
    .map((item, index) => [item, index])
    .sort((left, right) => {
      const lk = keyOf(left[0]);
      const rk = keyOf(right[0]);
      if (lk < rk) return 1;
      if (lk > rk) return -1;
      return left[1] - right[1];
    })
    .map(([item]) => item);
}

export function formatStatusSummary(data) {
  const summary = isRecord(data.summary) ? data.summary : {};
  const counts = isRecord(summary.counts) ? summary.counts : {};
  const parts = [
    `counts=${pyJsonDumps(canonicalValue(counts))}`,
    `active=${(summary.active || []).length}`,
    `paused=${(summary.paused || []).length}`,
    `needs_review=${(summary.needs_review || []).length}`,
    `next_ready=${(summary.next_ready || []).length}`,
    `failed_or_blocked=${(summary.failed_or_blocked || []).length}`,
  ];
  return `fleet status summary ok: ${parts.join(" ")}`;
}

export function statusRun(runId, root, summary = false) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const target = statePath(resolvedRoot, runId);
  const state = readJson(target);
  const data = { status: "ok", run_id: runId, counts: stateCounts(state), state_path: rel(target) };
  if (summary) {
    const manifest = loadManifestSnapshotForStatus(state);
    data.summary = buildStatusSummary(state, manifest);
    return data;
  }
  data.state = state;
  return data;
}

Object.assign(api, {
  stateCounts,
  shortText,
  compactNode,
  compactEvent,
  loadManifestSnapshotForStatus,
  orderedPendingIds,
  nextReadySummary,
  buildStatusSummary,
  stableSortDesc,
  formatStatusSummary,
  statusRun,
});
