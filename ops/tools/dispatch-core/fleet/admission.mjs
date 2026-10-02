// fleet_scheduler.mjs 按职责拆出的 admission。只搬移代码，不改行为。
import { api } from "./api.mjs";
import { existsSync } from "node:fs";
import path from "node:path";
import { pyStr, pyStrip } from "../_py.mjs";
import { isRecord, rel, resolveLikePython, ROOT, ToolError, utcNow } from "../_tool_common.mjs";
import {
  nodeDependencyArtifacts,
  nodeDependencyPolicy,
  nodeIsolation,
  nodeSeed,
  nodeTargetIsolation,
  pathConflict,
  sortedStrings,
  stringList,
} from "../fleet_manifest_check.mjs";
import { ACTIVE_STATES } from "./constants.mjs";
import { deps } from "./deps.mjs";
import { dependencyResultIndexPath, runDir, safeId, writeJson } from "./paths.mjs";
import { dedupe, notEmptyPy, pyInt, resolveUnder } from "./py-utils.mjs";
import { routeSnapshot } from "./route.mjs";

export function activeWriteScopes(state) {
  const scopes = [];
  for (const node of (Array.isArray(state.nodes) ? state.nodes : [])) {
    if (isRecord(node) && (ACTIVE_STATES.has(node.state) || node.resource_quarantined)) {
      scopes.push([pyStr(node.id ?? null), [...(node.write_scope || [])]]);
    }
  }
  return scopes;
}

export function activeResourceLocks(state) {
  const locks = [];
  for (const node of (Array.isArray(state.nodes) ? state.nodes : [])) {
    if (isRecord(node) && (ACTIVE_STATES.has(node.state) || node.resource_quarantined)) {
      const raw = node.resource_locks;
      const values = Array.isArray(raw)
        ? sortedStrings(new Set(raw.map((item) => pyStrip(pyStr(item))).filter((item) => item)))
        : [];
      if (values.length) locks.push([pyStr(node.id || ""), values]);
    }
  }
  return locks;
}

export function writeLocked(node, active) {
  const scope = [...(node.write_scope || [])];
  if (!scope.length) return null;
  for (const [owner, otherScope] of active) {
    for (const left of scope) {
      for (const right of otherScope) {
        if (pathConflict(left, right)) return owner;
      }
    }
  }
  return null;
}

export function resourceLocked(node, active) {
  const requested = new Set(
    (node.resource_locks || []).map((item) => pyStrip(pyStr(item))).filter((item) => item),
  );
  if (!requested.size) return null;
  for (const [owner, held] of active) {
    if (held.some((item) => requested.has(item))) return owner;
  }
  return null;
}

export function budgetAllows(node, state, submittedThisTick) {
  const budget = isRecord(state.budget) ? state.budget : {};
  const activeNodes = (Array.isArray(state.nodes) ? state.nodes : []).filter(
    (n) => isRecord(n) && ACTIVE_STATES.has(n.state),
  );
  const maxTotal = pyInt(budget.max_running_total || 8);
  const maxTick = pyInt(budget.max_submitted_per_tick || maxTotal);
  if (activeNodes.length >= maxTotal) return [false, `max_running_total ${maxTotal} reached`];
  if (submittedThisTick >= maxTick) return [false, `max_submitted_per_tick ${maxTick} reached`];
  const roleLimits = isRecord(budget.max_running_by_role) ? budget.max_running_by_role : {};
  const role = pyStr(node.role || "");
  const roleLimit = roleLimits[role];
  if (typeof roleLimit === "number" && Number.isInteger(roleLimit) && typeof roleLimit !== "boolean" && roleLimit > 0) {
    const roleActive = activeNodes.filter((n) => n.role === role).length;
    if (roleActive >= roleLimit) return [false, `max_running_by_role.${role} ${roleLimit} reached`];
  }
  return [true, ""];
}

export function ensureWorktree(state, node) {
  const worktreeRoot = path.join(runDir(pyStr(state.state_root), state.run_id), "worktrees");
  const worktree = path.join(worktreeRoot, safeId(pyStr(node.id)));
  if (node.worktree_path) return pyStr(node.worktree_path);
  if (existsSync(worktree)) throw new ToolError(`worktree path already exists before dispatch: ${rel(worktree)}`);
  const result = deps.runCommand(["git", "worktree", "add", "--detach", worktree, "HEAD"], ROOT, { timeout: 120 });
  if (result.exit_code !== 0) {
    throw new ToolError(`git worktree add failed for ${node.id}: ${result.stderr.slice(0, 600)}`);
  }
  node.worktree_path = worktree;
  return worktree;
}

export function dependencyResultEntries(state, node, manifestNode) {
  const requested = nodeDependencyArtifacts(manifestNode);
  const policy = nodeDependencyPolicy(manifestNode);
  const byId = api.indexNodes(state);
  const resolved = [];
  const entries = [];
  for (const dependencyId of (node.depends_on || [])) {
    const dependency = byId[pyStr(dependencyId)] ?? {};
    const lastStatus = isRecord(dependency.last_status) ? dependency.last_status : {};
    const dispatch = isRecord(dependency.dispatch) ? dependency.dispatch : {};
    const businessOutput = isRecord(dispatch.business_output) ? dispatch.business_output : {};
    const artifactPaths = {};
    const missingArtifacts = [];
    // gate 不产出产物，产物要求不作用于 gate 依赖。
    const requestedForDep = dependency.kind === "gate" ? [] : requested;
    for (const artifact of requestedForDep) {
      const candidates = artifact === "report"
        ? [
          lastStatus.business_report_path,
          lastStatus.report_path,
          lastStatus.declared_report_path,
          businessOutput.expected_report_path,
        ]
        : [
          lastStatus.business_handoff_path,
          lastStatus.handoff_path,
          lastStatus.declared_handoff_path,
          businessOutput.expected_handoff_path,
        ];
      let selected = "";
      for (const candidate of candidates) {
        if (typeof candidate !== "string" || !pyStrip(candidate)) continue;
        const target = resolveUnder(candidate, ROOT);
        if (existsSync(target)) {
          selected = target;
          break;
        }
      }
      if (!selected) {
        missingArtifacts.push(artifact);
        if (policy !== "all_settled") {
          throw new ToolError(
            `node ${pyStr(node.id ?? null)} dependency ${dependencyId} has no durable ${artifact} artifact`,
          );
        }
        continue;
      }
      artifactPaths[artifact] = selected;
      if (!resolved.includes(selected)) resolved.push(selected);
    }
    let artifactState;
    if (!requestedForDep.length) artifactState = "not_requested";
    else if (!missingArtifacts.length) artifactState = "available";
    else if (Object.keys(artifactPaths).length) artifactState = "partial";
    else artifactState = "missing";
    const entry = {
      node_id: pyStr(dependencyId),
      execution_state: lastStatus.state || dependency.state || "unknown",
      orchestration_state: dependency.state || "unknown",
      business_state: lastStatus.business_state || "unknown",
      artifact_state: artifactState,
      artifacts: artifactPaths,
      missing_artifacts: missingArtifacts,
    };
    for (const key of ["contract_state", "failure_type", "error"]) {
      const value = lastStatus[key];
      if (notEmptyPy(value)) entry[key] = typeof value === "string" ? api.shortText(value) : value;
    }
    const blockIssue = dependency.acceptance_results_block;
    if (blockIssue) {
      entry.acceptance_results_block = typeof blockIssue === "string" ? api.shortText(blockIssue) : blockIssue;
    }
    entries.push(entry);
  }
  return [resolved, entries];
}

export function writeDependencyResultIndex(state, node, manifestNode, entries) {
  const root = pyStr(state.state_root);
  const target = dependencyResultIndexPath(root, pyStr(state.run_id), pyStr(node.id));
  writeJson(target, {
    schema_version: 1,
    consumer_node_id: pyStr(node.id),
    dependency_policy: "all_settled",
    requested_artifacts: nodeDependencyArtifacts(manifestNode),
    dependencies: entries,
  });
  return resolveLikePython(target);
}

export function seedWithDependencyArtifacts(state, node, manifestNode, manifest = {}) {
  const seed = nodeSeed(manifestNode);
  // Grant only declared node writes, not lock scopes or artifact coverage.
  const writes = [...stringList(manifestNode.write_scope), ...stringList(manifestNode.write_domains)];
  if (writes.length && nodeIsolation(manifestNode, manifest) !== "read_only"
      && nodeTargetIsolation(manifestNode, manifest) !== "read_only") {
    seed.scope ??= {};
    seed.scope.write_extra = dedupe([...(seed.scope.write_extra || []), ...writes]);
  }
  let [artifacts, entries] = dependencyResultEntries(state, node, manifestNode);
  if (nodeDependencyPolicy(manifestNode) === "all_settled") {
    const indexPath = writeDependencyResultIndex(state, node, manifestNode, entries);
    artifacts = [indexPath, ...artifacts];
  }
  if (!artifacts.length) return seed;
  if (!Object.hasOwn(seed, "scope")) seed.scope = {};
  const scope = seed.scope;
  if (!isRecord(scope)) throw new ToolError(`node ${pyStr(node.id ?? null)} seed.scope must be an object`);
  const reads = Object.hasOwn(scope, "read") ? scope.read : [];
  if (!Array.isArray(reads)) throw new ToolError(`node ${pyStr(node.id ?? null)} seed.scope.read must be a list`);
  scope.read = dedupe([...artifacts, ...reads]);
  const layers = seed.read_scope_layers;
  if (isRecord(layers)) {
    const entry = Object.hasOwn(layers, "entry") ? layers.entry : [];
    if (!Array.isArray(entry)) {
      throw new ToolError(`node ${pyStr(node.id ?? null)} seed.read_scope_layers.entry must be a list`);
    }
    layers.entry = dedupe([...artifacts, ...entry]);
  }
  return seed;
}

export function markFailure(node, { contractState, failureType, error, fleetState = null } = {}) {
  node.state = "failed";
  node.review_required = false;
  node.review_decision = null;
  node.last_status = {
    source: "fleet_scheduler", state: "failed", business_state: "failed",
    contract_state: contractState, failure_type: failureType, error,
  };
  node.updated_at = utcNow();
  if (fleetState) api.appendFleetEvent(fleetState, "agent_settled", node, {
    businessState: "failed", contract_state: contractState, failure_type: failureType,
    error, attention_required: true, route: routeSnapshot(node),
  });
}

export function markParentReview(node, { contractState, failureType, error, fleetState = null } = {}) {
  node.state = "needs_parent_review";
  node.review_required = true;
  node.review_decision = "pending";
  node.last_status = {
    source: "fleet_scheduler",
    state: "failed",
    business_state: "failed",
    contract_state: contractState,
    failure_type: failureType,
    requires_parent_review: true,
    safety_review: true,
    error,
  };
  node.updated_at = utcNow();
  if (fleetState !== null && fleetState !== undefined) {
    api.appendFleetEvent(fleetState, "agent_settled", node, {
      businessState: "needs_owner",
      contract_state: contractState,
      failure_type: failureType,
      error,
      route: routeSnapshot(node),
    });
  }
  return null;
}

export function promoteLegacyDispatchFailureBlocks(state) {
  const promoted = [];
  for (const node of (Array.isArray(state.nodes) ? state.nodes : [])) {
    if (!isRecord(node) || node.state !== "blocked") continue;
    if (node.task_id || node.blocked_by || node.last_status) continue;
    const dispatch = node.dispatch;
    if (!isRecord(dispatch)) continue;
    let error = pyStrip(pyStr(dispatch.error || dispatch.stdout || ""));
    if (!error) error = "legacy dispatch failure recorded without output";
    markFailure(node, {
      contractState: "dispatch_prepare_failed",
      failureType: "legacy_dispatch_failure",
      error,
      fleetState: state,
    });
    promoted.push(pyStr(node.id || ""));
  }
  return promoted;
}

Object.assign(api, {
  activeWriteScopes,
  activeResourceLocks,
  writeLocked,
  resourceLocked,
  budgetAllows,
  ensureWorktree,
  dependencyResultEntries,
  writeDependencyResultIndex,
  seedWithDependencyArtifacts,
  markFailure,
  markParentReview,
  promoteLegacyDispatchFailureBlocks,
});
