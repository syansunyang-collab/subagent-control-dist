// fleet_scheduler.mjs 按职责拆出的 async-runtime。只搬移代码，不改行为。
import { api } from "./api.mjs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pyJsonLoads, pyReadText, pyResolveUnder, pySamePath, pySpawnSync, pyStr, pyStrip } from "../_py.mjs";
import { isRecord, pathlibJoin, rel, resolveLikePython, ROOT, ToolError, utcNow } from "../_tool_common.mjs";
import { deepCopy, sortedStrings } from "../fleet_manifest_check.mjs";
import {
  ACTIVE_STATES,
  ASYNC_TERMINAL_STATES,
  MAX_RUNTIME_EVIDENCE_BYTES,
  MAX_RUNTIME_USAGE_VALUE,
  RUNTIME_USAGE_FIELDS,
  TERMINAL_STATES,
} from "./constants.mjs";
import { deps } from "./deps.mjs";
import { hostPaths } from "./host-paths.mjs";
import { deferLivenessCheck, livenessCheckDue, runDir } from "./paths.mjs";
import { isDir, isFile, notEmptyPy, pyDictEqual } from "./py-utils.mjs";
import { ensureRouteRecord, frozenRequestedRoute, routeSnapshot, updateRouteFromPayload } from "./route.mjs";

export function runCommandImpl(cmd, cwd, { stdin = null, timeout = 60 } = {}) {
  const argv = cmd.map((item) => pyStr(item));
  const proc = pySpawnSync(argv[0], argv.slice(1), {
    cwd: pyStr(cwd),
    input: stdin === null || stdin === undefined ? undefined : String(stdin),
    encoding: "utf8",
    timeout: timeout * 1000,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (proc.error) {
    if (proc.error.code === "ENOENT") throw new ToolError(`command not found: ${argv[0]}`);
    if (proc.error.code === "ETIMEDOUT") throw new ToolError(`command timed out: ${argv.join(" ")}`);
    throw new ToolError(`command failed to start: ${proc.error.message}`);
  }
  if (proc.signal && proc.status === null) throw new ToolError(`command timed out: ${argv.join(" ")}`);
  return {
    cmd: argv,
    exit_code: proc.status ?? 1,
    stdout: pyStr(proc.stdout ?? ""),
    stderr: pyStr(proc.stderr ?? ""),
  };
}

export function runCommand(cmd, cwd, options = {}) {
  return deps.runCommand(cmd, cwd, options);
}

export function parseJsonStdout(result, label) {
  const text = pyStrip(pyStr(result.stdout || ""));
  if (!text) throw new ToolError(`${label} returned empty stdout: ${pyStr(result.stderr ?? "").slice(0, 400)}`);
  let data;
  try {
    data = pyJsonLoads(text);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    throw new ToolError(`${label} returned invalid JSON: ${text.slice(0, 600)}`);
  }
  if (!isRecord(data)) throw new ToolError(`${label} JSON root is not object`);
  return data;
}

export function nodeTaskRoot(state, node) {
  const defaultRoot = path.join(runDir(pyStr(state.state_root), pyStr(state.run_id)), "async_tasks");
  return pyStr(node.task_root || defaultRoot);
}

export function asyncCompletionInbox(taskRoot) {
  return path.join(path.dirname(resolveLikePython(taskRoot)), "async_inbox");
}

export function runtimeTaskDir(node) {
  const lastStatus = isRecord(node.last_status) ? node.last_status : {};
  const dispatch = isRecord(node.dispatch) ? node.dispatch : {};
  const candidates = [lastStatus.task_dir, dispatch.task_dir];
  const taskRoot = node.task_root;
  const taskId = node.task_id;
  if (taskRoot && taskId) candidates.push(pathlibJoin(pyStr(taskRoot), pyStr(taskId)));
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !pyStrip(candidate)) continue;
    const resolved = pyResolveUnder(candidate, ROOT);
    if (isDir(resolved)) return resolved;
  }
  return null;
}

export function readBoundedRuntimeJson(target) {
  try {
    if (!isFile(target) || statSync(target).size > MAX_RUNTIME_EVIDENCE_BYTES) return null;
    const raw = readFileSync(target);
    if (raw.length > MAX_RUNTIME_EVIDENCE_BYTES) return null;
    const data = pyJsonLoads(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

export function readTerminalRuntimeArtifacts(node) {
  const taskDir = runtimeTaskDir(node);
  if (taskDir === null) return {};
  const artifacts = {};
  for (const name of ["status.json", "child-task-live.json", "child-task-result.json"]) {
    const target = resolveLikePython(path.join(taskDir, name));
    // Only canonical direct children of the task directory are admissible;
    // symlinked or traversal paths fail closed.
    if (!pySamePath(path.dirname(target), taskDir)) continue;
    const data = readBoundedRuntimeJson(target);
    if (data !== null) artifacts[name] = data;
  }
  return artifacts;
}

export function runtimeIdentityEvidence(node, childResult) {
  const selection = isRecord(childResult.selection) ? childResult.selection : {};
  const turnRequested = isRecord(selection.turnRequested) ? selection.turnRequested : {};
  const turn = isRecord(childResult.turn) ? childResult.turn : {};
  const requestedModel = turn.requestedModel || turnRequested.model;
  const requestedEffort = turn.requestedEffort || turnRequested.effort;
  if (typeof requestedModel !== "string" || !pyStrip(requestedModel)) return null;
  if (typeof requestedEffort !== "string" || !pyStrip(requestedEffort)) return null;
  const frozen = frozenRequestedRoute(node);
  if (!frozen) return null;
  if (requestedModel !== (frozen.model ?? undefined) || requestedEffort !== (frozen.effort ?? undefined)) return null;
  const thread = isRecord(childResult.thread) ? childResult.thread : {};
  const response = isRecord(thread.response) ? thread.response : {};
  const provider = response.modelProvider;
  if (typeof provider !== "string" || !pyStrip(provider)) return null;
  return {
    source: "child-task-result.json",
    request_observed: true,
    requested_model: requestedModel,
    requested_effort: requestedEffort,
    provider,
    provider_backend_attestation: "unavailable",
  };
}

export function runtimeTokenUsage(live) {
  const usage = live.token_usage;
  if (!isRecord(usage) || !Object.hasOwn(usage, "total_tokens")) return null;
  const projected = {};
  for (const key of RUNTIME_USAGE_FIELDS) {
    const value = usage[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value)) return null;
    if (value < 0 || value > MAX_RUNTIME_USAGE_VALUE) return null;
    projected[key] = value;
  }
  if (!Object.hasOwn(projected, "total_tokens")) return null;
  return projected;
}

/** Project bounded terminal runtime evidence without replacing route truth. */
export function enrichTerminalRouteFromRuntime(node) {
  const record = ensureRouteRecord(node);
  const before = deepCopy(record);
  const artifacts = readTerminalRuntimeArtifacts(node);
  const childResult = artifacts["child-task-result.json"];
  if (childResult) {
    const identity = runtimeIdentityEvidence(node, childResult);
    if (identity && (record.identity_evidence === null || record.identity_evidence === undefined)) {
      record.identity_evidence = identity;
    }
  }

  const live = artifacts["child-task-live.json"];
  const tokenUsage = live ? runtimeTokenUsage(live) : null;
  if (tokenUsage !== null && (record.usage.token_usage === null || record.usage.token_usage === undefined)) {
    record.usage.token_usage = tokenUsage;
    record.usage.provenance = "child-task-live.json";
  }
  ensureRouteRecord(node);
  return !pyDictEqual(before, record);
}

export function requiresSafetyReview(status) {
  const mechanical = status.mechanical_summary || {};
  return status.safety_review === true || status.retained_worker === true || status.cleanup?.tree_confirmed === false
    || status.write_domain_scope_compliant === false || mechanical.write_domain_scope_compliant === false
    || status.write_domain_violation_count > 0
    || /identity|write_domain|write_scope|write_claim|cleanup_failed|retained_worker/.test(
      `${status.failure_type || ""} ${status.contract_state || ""}`,
    );
}

export function applyAsyncStatus(node, status, source, fleetState = null) {
  const currentTaskId = pyStr(node.task_id || "");
  const receiptTaskId = pyStr(status.task_id || "");
  if (receiptTaskId && receiptTaskId !== currentTaskId) return false;
  if (currentTaskId && !receiptTaskId) return false;
  if (currentTaskId) {
    const boundTaskId = pyStr(node.receipt_task_id || "");
    if (boundTaskId && boundTaskId !== currentTaskId) return false;
    // 旧 state 没有 receipt_task_id；仅在回执身份与当前任务一致时补建绑定。
    node.receipt_task_id = currentTaskId;
  }
  const before = node.state;
  // Core 的通知/精简投影可能省略 retained_worker；从绑定任务的当前状态补资源事实。
  if (ASYNC_TERMINAL_STATES.has(status.state)) {
    const runtimeStatus = readTerminalRuntimeArtifacts({ ...node, last_status: status })["status.json"];
    if (runtimeStatus?.task_id === currentTaskId && runtimeStatus.retained_worker === true) {
      status = { ...status, retained_worker: true };
    }
  }
  node.resource_quarantined = status.retained_worker === true || status.cleanup?.tree_confirmed === false;
  updateRouteFromPayload(node, status, source);
  node.last_status = { ...status, source };
  const rawState = status.state;
  const requiresParentReview = Boolean(status.requires_parent_review || status.review_gate === "needs_parent_review");
  const cancelReason = pyStr(status.cancel_reason || "");
  const userCancel = cancelReason === "user_requested" || node.cancel_reason === "user_requested"
    || status.review_gate === "cancelled";
  if (rawState === "paused") {
    // 暂停是执行停止，不是 done/failed，也不放行依赖。
    node.state = "paused";
  } else if (ACTIVE_STATES.has(rawState)) {
    node.state = rawState;
  } else if (["done", "failed", "cancelled"].includes(rawState)
    && (node.kind === "gate" || requiresSafetyReview(status))) {
    node.state = "needs_parent_review";
    node.review_required = true;
    if (!["accepted", "blocked", "requeued"].includes(node.review_decision)) node.review_decision = "pending";
  } else if (["done", "failed", "cancelled"].includes(rawState)) {
    node.state = rawState === "cancelled" && userCancel ? "cancelled"
      : requiresParentReview || rawState === "failed" || (rawState === "cancelled" && !userCancel)
        || ["partial", "unknown", "blocked", "failed"].includes(status.business_state) ? "failed" : rawState;
    node.review_required = false;
    node.review_decision = null;
  }
  node.updated_at = utcNow();
  if (TERMINAL_STATES.has(node.state)) enrichTerminalRouteFromRuntime(node);
  const changed = before !== node.state;
  if (fleetState !== null && fleetState !== undefined) {
    const terminal = TERMINAL_STATES.has(node.state);
    const eventType = terminal && node.is_reducer
      ? "reducer_settled"
      : terminal ? "agent_settled" : "agent_progress";
    api.appendFleetEvent(fleetState, eventType, node, {
      businessState: pyStr(status.business_state || "") || null,
      source,
      changed,
      route: routeSnapshot(node),
      error: status.error || status.failure_type || null,
      attention_required: node.state === "failed" || node.state === "cancel_requested",
    });
  }
  return changed;
}

export function readCompletionNotices(taskRoot, taskIds) {
  const wanted = taskIds instanceof Set ? taskIds : new Set(taskIds);
  const inbox = asyncCompletionInbox(taskRoot);
  if (!existsSync(inbox)) return [Object.create(null), []];
  const notices = Object.create(null);
  const errors = [];
  const names = sortedStrings(readdirSync(inbox).filter((name) => name.endsWith(".json")));
  for (const name of names) {
    // <task_id>.stall.json / .attention.json 是非终态叫醒通知；Fleet 叶子由 scheduler 消费终态与 status 停车态。
    if (name.endsWith(".stall.json") || name.endsWith(".attention.json")) continue;
    const noticePath = path.join(inbox, name);
    let notice;
    try {
      notice = pyJsonLoads(pyReadText(noticePath));
    } catch (error) {
      if (error?.name !== "JSONDecodeError") throw error;
      const lineno = Number(/line (\d+) column/.exec(String(error.message))?.[1] ?? 1);
      errors.push(`invalid completion notice ${rel(noticePath)}:${lineno}`);
      continue;
    }
    if (!isRecord(notice)) {
      errors.push(`completion notice root must be object: ${rel(noticePath)}`);
      continue;
    }
    const stem = name.replace(/\.[^.]*$/, "");
    const taskId = pyStr(notice.task_id || stem);
    if (wanted.has(taskId)) notices[taskId] = { completion_notice_path: noticePath, ...notice };
  }
  return [notices, errors];
}

export function compactCompletionNotice(notice) {
  const data = {};
  for (const key of [
    "task_id",
    "state",
    "requires_parent_review",
    "contract_state",
    "business_state",
    "failure_type",
    "turn_status",
    "exit_code",
    "signal",
    "error",
    "report_path",
    "handoff_path",
    "completion_notice_path",
  ]) {
    const value = notice[key];
    if (!notEmptyPy(value)) continue;
    data[key] = key === "error" && typeof value === "string" ? value.slice(0, 300) : value;
  }
  return data;
}

export function waitForCompletionNotices(state, waitMs, { pollIntervalMs = 250 } = {}) {
  if (waitMs < 0 || waitMs > 600000) throw new ToolError("wait_ms must be between 0 and 600000");
  const activeNodes = (Array.isArray(state.nodes) ? state.nodes : []).filter(
    (node) => isRecord(node) && node.task_id && ACTIVE_STATES.has(node.state),
  );
  if (!activeNodes.length) {
    return {
      status: "ok",
      event: "no_active_tasks",
      active: 0,
      status_checked: false,
      notices: [],
    };
  }

  const grouped = new Map();
  for (const node of activeNodes) {
    const key = pyStr(nodeTaskRoot(state, node));
    if (!grouped.has(key)) grouped.set(key, new Set());
    grouped.get(key).add(pyStr(node.task_id));
  }

  const deadline = deps.monotonic() + waitMs / 1000;
  const errors = new Set();
  for (;;) {
    if (state.state_root && state.run_id && existsSync(api.cancellationPath(state.state_root, state.run_id))) {
      return { status: "cancelling", event: "cancellation_requested", active: activeNodes.length, notices: [] };
    }
    const found = Object.create(null);
    for (const [taskRootText, taskIds] of grouped) {
      const [notices, noticeErrors] = readCompletionNotices(taskRootText, taskIds);
      Object.assign(found, notices);
      for (const item of noticeErrors) errors.add(item);
    }
    if (Object.keys(found).length) {
      return {
        status: "ok",
        event: "completion_notice",
        active: activeNodes.length,
        status_checked: false,
        notice_count: Object.keys(found).length,
        notices: sortedStrings(Object.keys(found)).map((taskId) => compactCompletionNotice(found[taskId])),
        errors: sortedStrings(errors),
      };
    }
    const remaining = deadline - deps.monotonic();
    if (remaining <= 0) {
      return {
        status: "waiting",
        event: "timeout",
        active: activeNodes.length,
        status_checked: false,
        notice_count: 0,
        notices: [],
        errors: sortedStrings(errors),
      };
    }
    deps.sleep(Math.min(Math.max(pollIntervalMs, 10) / 1000, remaining));
  }
}

export function asyncInternalBatchImpl(operation, taskRoot, taskIds, { detail = "compact" } = {}) {
  const statuses = Object.create(null);
  const errors = [];
  const batchSize = operation === "get" && detail === "diagnostic" ? 5 : 20;
  for (let start = 0; start < taskIds.length; start += batchSize) {
    const batch = taskIds.slice(start, start + batchSize);
    const argv = [
      "node",
      hostPaths.ASYNC_SERVICE_PATH,
      "internal",
      operation,
      "--task-root",
      pyStr(taskRoot),
      "--task-ids",
      batch.join(","),
    ];
    if (operation === "get") argv.push("--detail", detail);
    const result = deps.runCommand(argv, ROOT);
    if (result.exit_code !== 0) {
      errors.push((result.stderr || result.stdout).slice(0, 600));
      continue;
    }
    let data;
    try {
      data = parseJsonStdout(result, `async internal ${operation}`);
    } catch (error) {
      if (error?.name !== "ToolError") throw error;
      errors.push(String(error.message));
      continue;
    }
    const tasks = data.tasks;
    if (!Array.isArray(tasks)) {
      errors.push(`async internal ${operation} returned non-list tasks`);
      continue;
    }
    for (const task of tasks) {
      if (!isRecord(task) || !task.task_id) continue;
      const normalized = { ...task };
      const progress = isRecord(task.progress) ? task.progress : {};
      for (const key of [
        "elapsed_seconds",
        "live_age_seconds",
        "tool_call_count",
        "last_tool_kind",
        "live_health",
        "progress_state",
      ]) {
        if (Object.hasOwn(progress, key)) normalized[key] = progress[key];
      }
      // Core 的 get 投影仅在写域审计不合规时携带此计数字段（即使计数为零）。
      if (Object.hasOwn(task, "write_domain_violation_count")) {
        normalized.write_domain_scope_compliant = task.write_domain_scope_compliant ?? false;
      }
      normalized.requires_parent_review = task.review_gate === "needs_parent_review";
      statuses[pyStr(task.task_id)] = normalized;
    }
  }
  return [statuses, errors];
}

export function asyncInternalBatch(operation, taskRoot, taskIds, options = {}) {
  return deps.asyncInternalBatch(operation, taskRoot, taskIds, options);
}

export function refreshActiveNodes(state, { forceReconcile = false } = {}) {
  const watchedNodes = (Array.isArray(state.nodes) ? state.nodes : []).filter(
    (node) => isRecord(node) && node.task_id
      && (ACTIVE_STATES.has(node.state) || node.state === "paused" || node.resource_quarantined),
  );
  const summary = {
    active: watchedNodes.filter((node) => ACTIVE_STATES.has(node.state)).length,
    paused: watchedNodes.filter((node) => node.state === "paused").length,
    inbox: 0,
    queried: 0,
    reconciled: 0,
    inspection_deferred: 0,
    errors: [],
  };
  const grouped = new Map();
  for (const node of watchedNodes) {
    const key = pyStr(nodeTaskRoot(state, node));
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(node);
  }

  for (const [taskRootText, nodes] of grouped) {
    const taskRoot = taskRootText;
    const taskIds = new Set(nodes.filter((node) => node.task_id).map((node) => pyStr(node.task_id)));
    const [notices, noticeErrors] = readCompletionNotices(taskRoot, taskIds);
    summary.errors.push(...noticeErrors);
    for (const node of nodes) {
      const taskId = pyStr(node.task_id || "");
      const notice = notices[taskId];
      if (notice) {
        applyAsyncStatus(node, notice, "completion_notice", state);
        summary.inbox += 1;
      }
    }

    const remaining = nodes.filter(
      (node) => (ACTIVE_STATES.has(node.state) || node.state === "paused" || node.resource_quarantined)
        && !Object.hasOwn(notices, pyStr(node.task_id || "")),
    );
    const dueRemaining = remaining.filter((node) => node.state === "paused" || forceReconcile || livenessCheckDue(node));
    summary.inspection_deferred += remaining.length - dueRemaining.length;
    if (!dueRemaining.length) continue;

    const dueIds = dueRemaining.map((node) => pyStr(node.task_id || ""));
    const [queried, queryErrors] = deps.asyncInternalBatch("get", taskRoot, dueIds, { detail: "diagnostic" });
    summary.errors.push(...queryErrors);
    const deadIds = [];
    for (const node of dueRemaining) {
      const taskId = pyStr(node.task_id || "");
      const status = queried[taskId];
      if (status && status.state === "paused") {
        applyAsyncStatus(node, status, "async_get", state);
        summary.queried += 1;
        continue;
      }
      if (status && ACTIVE_STATES.has(status.state) && status.process_alive === false) {
        deadIds.push(taskId);
      } else if (status) {
        applyAsyncStatus(node, status, "async_get", state);
        if (ACTIVE_STATES.has(node.state)) deferLivenessCheck(node);
        summary.queried += 1;
      } else {
        summary.errors.push(`async get missing task ${taskId}`);
      }
    }

    if (deadIds.length) {
      const [reconciled, reconcileErrors] = deps.asyncInternalBatch("reconcile", taskRoot, deadIds);
      summary.errors.push(...reconcileErrors);
      for (const node of dueRemaining) {
        const taskId = pyStr(node.task_id || "");
        const status = reconciled[taskId];
        if (status) {
          applyAsyncStatus(node, status, "async_reconcile", state);
          summary.reconciled += 1;
        }
      }
    }
  }
  return summary;
}

Object.assign(api, {
  runCommandImpl,
  runCommand,
  parseJsonStdout,
  nodeTaskRoot,
  asyncCompletionInbox,
  runtimeTaskDir,
  readBoundedRuntimeJson,
  readTerminalRuntimeArtifacts,
  runtimeIdentityEvidence,
  runtimeTokenUsage,
  enrichTerminalRouteFromRuntime,
  requiresSafetyReview,
  applyAsyncStatus,
  readCompletionNotices,
  compactCompletionNotice,
  waitForCompletionNotices,
  asyncInternalBatchImpl,
  asyncInternalBatch,
  refreshActiveNodes,
});
