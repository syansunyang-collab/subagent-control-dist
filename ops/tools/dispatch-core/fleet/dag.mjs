// fleet_scheduler.mjs 按职责拆出的 dag。只搬移代码，不改行为。
import { api } from "./api.mjs";
import path from "node:path";
import { pyJsonLoads, pyReadText, pyRepr, pyStr } from "../_py.mjs";
import { isRecord, rel, ROOT, utcNow } from "../_tool_common.mjs";
import { nodeDependsOn, nodeId, nodeIsReducer, nodeSeed, sortedStrings } from "../fleet_manifest_check.mjs";
import { ASYNC_TERMINAL_STATES, FAILED_DEPENDENCY_STATES, TERMINAL_STATES } from "./constants.mjs";
import { pyDictEqual } from "./py-utils.mjs";

export const ACCEPTANCE_RESULTS_BLOCK = /```json[ \t]+acceptance_results[^\n]*\n([\s\S]*?)\n```/i;

export function acceptanceLeafExpectedIds(manifestNode) {
  const seed = nodeSeed(manifestNode);
  const contract = isRecord(seed.contract) ? seed.contract : {};
  const context = isRecord(contract.acceptance_context) ? contract.acceptance_context : {};
  const items = Array.isArray(context.items) ? context.items : [];
  let ids = items.filter((item) => isRecord(item) && item.acceptance_id).map((item) => pyStr(item.acceptance_id));
  if (!ids.length && context.acceptance_id) ids = [pyStr(context.acceptance_id)];
  return ids;
}

/** 报告缺逐项 acceptance_results 块或 id 集不齐时返回原因;合格返回 None。 */
export function acceptanceResultsBlockIssue(reportPath, expectedIds) {
  let text;
  try {
    text = pyReadText(reportPath);
  } catch {
    return `report not readable: ${rel(reportPath)}`;
  }
  const match = ACCEPTANCE_RESULTS_BLOCK.exec(text);
  if (!match) return "missing ```json acceptance_results block";
  let payload;
  try {
    payload = pyJsonLoads(match[1]);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    return `acceptance_results block is invalid JSON: ${error.message}`;
  }
  const entries = isRecord(payload) ? payload.acceptance_results : null;
  if (!Array.isArray(entries)) return "acceptance_results block root must contain an acceptance_results list";
  const seen = [];
  for (const entry of entries) {
    if (!isRecord(entry)) return "acceptance_results entries must be objects";
    if (!["pass", "fail", "needs_owner"].includes(entry.gate)) {
      return `acceptance_results gate invalid: ${pyStr(entry.gate ?? null)}`;
    }
    seen.push(pyStr(entry.acceptance_id ?? null));
  }
  const seenSorted = sortedStrings(new Set(seen));
  const expectedSorted = sortedStrings(new Set(expectedIds));
  if (!pyDictEqual(seenSorted, expectedSorted) || seen.length !== new Set(seen).size) {
    return `acceptance_results ids mismatch: got ${pyRepr(sortedStrings(seen))}, expected ${pyRepr(sortedStrings(expectedIds))}`;
  }
  return null;
}

/** 多 item 合同的验收叶终态即机械校验逐项结构块:缺块只在节点上标注并随依赖索引交给 reducer 从报告正文推导;任何情况下不重派叶子、不改任务绑定。 */
export function enforceAcceptanceResultsGate(state, manifestById, { reportRoot = null } = {}) {
  if (!Object.values(manifestById).some((node) => nodeIsReducer(node))) return [];
  const actions = [];
  const byId = api.indexNodes(state);
  for (const [nid, manifestNode] of Object.entries(manifestById)) {
    if (nodeIsReducer(manifestNode)) continue;
    const expectedIds = acceptanceLeafExpectedIds(manifestNode);
    if (!expectedIds.length) continue;
    const node = byId[nid];
    if (!node || node.state !== "done") continue;
    const taskId = pyStr(node.task_id || "");
    if (!taskId || node.acceptance_results_checked === taskId) continue;
    const slug = pyStr(nodeSeed(manifestNode).slug || "");
    const reportPath = path.join(reportRoot || path.join(ROOT, "notes", "verify"), `${slug}.md`);
    const issue = acceptanceResultsBlockIssue(reportPath, expectedIds);
    node.acceptance_results_checked = taskId;
    if (issue === null) {
      delete node.acceptance_results_block;
      continue;
    }
    node.acceptance_results_block = issue;
    actions.push({ node: nid, action: "derive_from_prose", issue });
  }
  return actions;
}

// 已知差异：Python 的 visit() 只在返回前写 memo，环状输入会 RecursionError；这里先占位再递归，
// 环状输入给出有限计数。validate_manifest 已在上游拒环，该分支在真实调用路径上不可达。
export function downstreamCounts(manifestNodesList) {
  const ids = manifestNodesList.map((node) => nodeId(node));
  const reverse = new Map();
  for (const nid of ids) if (!reverse.has(nid)) reverse.set(nid, new Set());
  for (const node of manifestNodesList) {
    const nid = nodeId(node);
    for (const dep of nodeDependsOn(node)) {
      if (reverse.has(dep)) reverse.get(dep).add(nid);
    }
  }

  const memo = new Map();
  const visit = (nid) => {
    if (memo.has(nid)) return memo.get(nid);
    const children = new Set();
    memo.set(nid, children);
    for (const child of (reverse.get(nid) ?? new Set())) {
      children.add(child);
      for (const item of visit(child)) children.add(item);
    }
    memo.set(nid, children);
    return children;
  };

  const out = Object.create(null);
  for (const nid of ids) out[nid] = visit(nid).size;
  return out;
}

export function dependenciesReady(node, byId) {
  const policy = pyStr(node.dependency_policy || "all_succeeded");
  for (const dep of (node.depends_on || [])) {
    const depNode = byId[dep] ?? {};
    const depState = depNode.state;
    // gate 是硬裁决点：任何依赖策略下都只有 accept（done）才放行下游。
    if (depNode.kind === "gate") {
      if (depState !== "done") return false;
      continue;
    }
    if (depState === "needs_parent_review" && api.requiresSafetyReview(depNode.last_status || {})) return false;
    if (policy === "all_settled") {
      if (!TERMINAL_STATES.has(depState)) return false;
    } else if (depState !== "done") {
      return false;
    }
  }
  return true;
}

export function blockedByFailedDependency(node, byId) {
  const toleratesFailure = pyStr(node.dependency_policy || "all_succeeded") === "all_settled"
    || pyStr(node.failure_policy || "success_only") === "all_settled";
  for (const dep of (node.depends_on || [])) {
    const depNode = byId[dep] ?? {};
    const depState = depNode.state;
    if (!FAILED_DEPENDENCY_STATES.has(depState)) continue;
    // 被 block 的 gate 对下游是硬阻断，不受 all_settled 豁免。
    if (depNode.kind === "gate" || !toleratesFailure) return pyStr(dep);
  }
  return null;
}

export function registerAllSettledConsumers(state) {
  const byId = api.indexNodes(state);
  const consumersByDependency = new Map();
  for (const consumer of (Array.isArray(state.nodes) ? state.nodes : [])) {
    if (!isRecord(consumer) || consumer.dependency_policy !== "all_settled") continue;
    const consumerId = pyStr(consumer.id || "");
    for (const dependencyId of (consumer.depends_on || [])) {
      const key = pyStr(dependencyId);
      if (!consumersByDependency.has(key)) consumersByDependency.set(key, []);
      consumersByDependency.get(key).push(consumerId);
    }
  }

  const changed = [];
  for (const [dependencyId, consumerIds] of consumersByDependency) {
    const dependency = byId[dependencyId];
    if (!dependency || !TERMINAL_STATES.has(dependency.state)) continue;
    if (dependency.kind === "gate" || api.requiresSafetyReview(dependency.last_status || {})) {
      // gate 的裁决不可下放给 reducer，也不得因 all_settled 消费者被 driver 豁免停车。
      continue;
    }
    const normalizedConsumers = sortedStrings(new Set(consumerIds));
    if (!pyDictEqual(dependency.all_settled_consumers ?? null, normalizedConsumers)) {
      dependency.all_settled_consumers = normalizedConsumers;
      changed.push(dependencyId);
    }
    if (dependency.state === "needs_parent_review") {
      const lastStatus = isRecord(dependency.last_status) ? dependency.last_status : {};
      const executionState = lastStatus.state;
      if (!ASYNC_TERMINAL_STATES.has(executionState)) continue;
      api.setNodeState(state, dependency, executionState, {
        eventType: "agent_settled",
        businessState: pyStr(lastStatus.business_state || "") || null,
        review_deferred_to: normalizedConsumers,
      });
      dependency.review_required = false;
      dependency.review_decision = null;
      dependency.review_deferred_to = normalizedConsumers;
      changed.push(dependencyId);
    }
    dependency.updated_at = utcNow();
  }
  return sortedStrings(new Set(changed));
}

export function releaseResolvedDependencyBlocks(state, byId) {
  const released = [];
  for (const node of (Array.isArray(state.nodes) ? state.nodes : [])) {
    if (!isRecord(node) || node.state !== "blocked") continue;
    const blocker = pyStr(node.blocked_by || "");
    const dependencies = new Set((node.depends_on || []).map((dep) => pyStr(dep)));
    if (!dependencies.has(blocker)) continue;
    const blockerState = (byId[blocker] ?? {}).state;
    if (pyStr(node.dependency_policy || "all_succeeded") !== "all_settled"
      && FAILED_DEPENDENCY_STATES.has(blockerState)) {
      continue;
    }
    node.state = "pending";
    delete node.blocked_by;
    node.updated_at = utcNow();
    released.push(pyStr(node.id || ""));
  }
  return released;
}

Object.assign(api, {
  acceptanceLeafExpectedIds,
  acceptanceResultsBlockIssue,
  enforceAcceptanceResultsGate,
  downstreamCounts,
  dependenciesReady,
  blockedByFailedDependency,
  registerAllSettledConsumers,
  releaseResolvedDependencyBlocks,
  ACCEPTANCE_RESULTS_BLOCK,
});
