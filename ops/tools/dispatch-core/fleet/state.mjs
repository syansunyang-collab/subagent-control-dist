// fleet_scheduler.mjs 按职责拆出的 state。只搬移代码，不改行为。
import { api } from "./api.mjs";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pyStr } from "../_py.mjs";
import { isRecord, rel, resolveLikePython, ROOT, ToolError, utcNow } from "../_tool_common.mjs";
import {
  deepCopy,
  effectiveBudget,
  effectiveReviewPolicy,
  loadManifest,
  nodeCommand,
  nodeDependencyPolicy,
  nodeDependsOn,
  nodeFailurePolicy,
  nodeId,
  nodeIsolation,
  nodeIsReducer,
  nodeKind,
  nodeResourceLocks,
  nodeRole,
  nodeRoute,
  nodeRouteSource,
  nodeSeed,
  nodeWriteScope,
  topologicalLayers,
  validateManifest,
} from "../fleet_manifest_check.mjs";
import { DEFAULT_ASYNC_TASK_ROOT } from "./constants.mjs";
import { manifestSnapshotPath, requireRepoInternal, runDir, safeId, statePath, writeJson } from "./paths.mjs";
import { positiveInt } from "./py-utils.mjs";
import { newRouteRecord } from "./route.mjs";

export function createInitialState(manifest, manifestPath, runId, root, dispatchOverrides = null) {
  const nodes = [];
  for (const node of (Array.isArray(manifest.nodes) ? manifest.nodes : [])) {
    if (!isRecord(node)) continue;
    const nid = nodeId(node);
    const requestedRoute = nodeRoute(node);
    const routeSource = nodeRouteSource(node);
    const routeRecord = newRouteRecord(requestedRoute, routeSource);
    const seed = nodeSeed(node);
    nodes.push({
      id: nid,
      kind: nodeKind(node),
      command_spec: nodeKind(node) === "command" ? nodeCommand(node) : null,
      state: "pending",
      route_id: Object.hasOwn(seed, "route_id")
        ? seed.route_id
        : (Object.hasOwn(node, "route_id") ? node.route_id : ""),
      role: nodeRole(node),
      route: routeRecord,
      route_source: routeSource,
      requested_route: deepCopy(requestedRoute),
      actual_route: null,
      usage_provenance: null,
      depends_on: nodeDependsOn(node),
      dependency_policy: nodeDependencyPolicy(node),
      failure_policy: nodeFailurePolicy(node),
      resource_locks: nodeResourceLocks(node),
      is_reducer: nodeIsReducer(node),
      isolation: nodeIsolation(node, manifest),
      write_scope: nodeWriteScope(node),
      task_id: null,
      task_root: pyStr(DEFAULT_ASYNC_TASK_ROOT),
      worktree_path: null,
      dispatch: null,
      last_status: null,
      review_required: false,
      review_decision: null,
      review: null,
      review_round: 0,
      review_history: [],
      revision: 0,
      updated_at: utcNow(),
    });
  }
  return {
    run_state_schema_version: 1,
    run_id: runId,
    created_at: utcNow(),
    updated_at: utcNow(),
    repo_root: pyStr(ROOT),
    manifest_source: pyStr(manifestPath),
    manifest_snapshot: pyStr(manifestSnapshotPath(root, runId)),
    state_root: pyStr(root),
    budget: effectiveBudget(manifest),
    review_policy: effectiveReviewPolicy(manifest),
    dispatch_overrides: { ...(dispatchOverrides || {}) },
    run_state: "created",
    revision: 0,
    event_revision: 0,
    ready_queue: [],
    ready_queue_revision: 0,
    failure_fuse: { status: "open", blocked_nodes: [] },
    fleet_settled_emitted: false,
    nodes,
    events: [],
  };
}

export function indexNodes(state) {
  // 节点 id 是外部输入，__proto__ 这类合法 id 落在 {} 上会改原型而不是建自有键。
  const out = Object.create(null);
  for (const node of (Array.isArray(state.nodes) ? state.nodes : [])) {
    if (isRecord(node)) out[node.id] = node;
  }
  return out;
}

export const BUSINESS_STATE_BY_NODE_STATE = {
  done: "completed",
  failed: "failed",
  cancelled: "cancelled",
  blocked: "blocked",
  needs_parent_review: "needs_owner",
  running: "running",
  queued: "queued",
  submitted: "submitted",
  pending: "pending",
};

/** Append the durable Fleet event envelope used by scheduler and Cockpit. */
export function appendFleetEvent(state, eventType, node = null, options = {}) {
  const { businessState = null, incrementNodeRevision = true, ...details } = options;
  if (node !== null && incrementNodeRevision) {
    node.revision = positiveInt(node.revision) + 1;
  }
  state.revision = positiveInt(state.revision) + 1;
  const timestamp = utcNow();
  const nodeState = pyStr(node !== null ? node.state : (state.run_state || "unknown"));
  const business = businessState || (Object.hasOwn(BUSINESS_STATE_BY_NODE_STATE, nodeState)
    ? BUSINESS_STATE_BY_NODE_STATE[nodeState]
    : nodeState);
  const cursorRevision = positiveInt(state.event_revision) + 1;
  state.event_revision = cursorRevision;
  const event = {
    at: timestamp,
    timestamp,
    type: eventType,
    run_id: pyStr(state.run_id || ""),
    node_id: node !== null ? pyStr(node.id || "") : "",
    task_id: node !== null ? (node.task_id ?? null) : null,
    revision: node !== null ? positiveInt(node.revision) : positiveInt(state.revision),
    node_revision: node !== null ? positiveInt(node.revision) : null,
    fleet_revision: cursorRevision,
    cursor: `${state.run_id}+${cursorRevision}`,
    state: nodeState,
    business_state: business,
    ...details,
  };
  let events = state.events;
  if (!Array.isArray(events)) {
    events = [];
    state.events = events;
  }
  events.push(event);
  if (events.length > 200) events.splice(0, events.length - 200);
  return event;
}

export function setNodeState(state, node, nodeState, options = {}) {
  const { eventType = "agent_progress", businessState = null, ...details } = options;
  const before = pyStr(node.state || "");
  node.state = nodeState;
  node.updated_at = utcNow();
  if (before !== nodeState || ["agent_started", "agent_settled", "reducer_settled"].includes(eventType)) {
    appendFleetEvent(state, eventType, node, { businessState, ...details });
  }
  return before !== nodeState;
}

export function setFailureFuse(state, { nodeIdValue, reason, blocker = null } = {}) {
  let fuse = state.failure_fuse;
  if (!isRecord(fuse)) {
    fuse = {};
    state.failure_fuse = fuse;
  }
  fuse.status = "tripped";
  fuse.reason = reason;
  fuse.tripped_by = blocker || nodeIdValue;
  if (!Object.hasOwn(fuse, "blocked_nodes")) fuse.blocked_nodes = [];
  const blockedNodes = fuse.blocked_nodes;
  if (Array.isArray(blockedNodes) && !blockedNodes.includes(nodeIdValue)) blockedNodes.push(nodeIdValue);
  return null;
}

/** Reconcile the durable ready queue from authoritative node state. */
export function rebuildReadyQueue(state, manifestNodesList, { preserveExisting = true } = {}) {
  const byId = indexNodes(state);
  const [layers] = topologicalLayers(manifestNodesList);
  const criticality = api.downstreamCounts(manifestNodesList);
  const layerIndex = Object.create(null);
  layers.forEach((layer, index) => {
    for (const nid of layer) layerIndex[nid] = index;
  });
  const existing = preserveExisting ? state.ready_queue : [];
  const existingIds = Array.isArray(existing) ? existing.map((item) => pyStr(item)) : [];
  const candidates = new Set();
  for (const [nid, node] of Object.entries(byId)) {
    if (node.state === "pending" && api.dependenciesReady(node, byId)) candidates.add(pyStr(nid));
  }
  const ordered = existingIds.filter((nid) => candidates.has(nid));
  for (const nid of candidates) {
    if (!ordered.includes(nid)) ordered.push(nid);
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
  state.ready_queue = ordered;
  state.ready_queue_revision = positiveInt(state.revision);
  return ordered;
}

export function startRun(manifestFile, runIdArg, root, force, dispatchOverrides = null) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const manifest = loadManifest(manifestFile);
  const validation = validateManifest(manifest);
  if (validation.status !== "ok") {
    throw new ToolError(`fleet manifest failed validation: ${validation.errors.join("; ")}`);
  }
  const stem = path.basename(pyStr(manifestFile)).replace(/\.[^.\\/]*$/, "");
  const runId = safeId(runIdArg || pyStr(manifest.run_id || stem));
  const directory = runDir(resolvedRoot, runId);
  if (existsSync(directory) && !force) throw new ToolError(`fleet run already exists: ${rel(directory)}`);
  if (existsSync(api.cancellationPath(resolvedRoot, runId))) throw new ToolError("cancelled fleet records are retained; use a new run_id");
  if (existsSync(directory) && force) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  mkdirSync(directory, { recursive: true });
  writeJson(manifestSnapshotPath(resolvedRoot, runId), manifest);
  const state = createInitialState(
    manifest,
    resolveLikePython(manifestFile),
    runId,
    resolvedRoot,
    dispatchOverrides,
  );
  state.run_state = "running";
  appendFleetEvent(state, "fleet_started", null, {
    businessState: "running",
    incrementNodeRevision: false,
    manifest: pyStr(manifestFile),
  });
  rebuildReadyQueue(state, Array.isArray(manifest.nodes) ? [...manifest.nodes] : [], { preserveExisting: false });
  writeJson(statePath(resolvedRoot, runId), state);
  return {
    status: "ok",
    run_id: runId,
    state_path: rel(statePath(resolvedRoot, runId)),
    nodes: state.nodes.length,
  };
}

Object.assign(api, {
  createInitialState,
  indexNodes,
  appendFleetEvent,
  setNodeState,
  setFailureFuse,
  rebuildReadyQueue,
  startRun,
  BUSINESS_STATE_BY_NODE_STATE,
});
