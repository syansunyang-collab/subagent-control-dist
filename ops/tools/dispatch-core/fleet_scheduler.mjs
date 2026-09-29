// ops/tools/fleet_scheduler.py 的 JS 复刻：tick 驱动的 DAG 调度、写域与资源锁、预算、父级审阅门与脱管 driver。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」；导出函数名为 Python 名的 camelCase。
// 形参约定：Python `*` 之前的形参按原序保持位置参数；`*` 之后的 keyword-only 形参合并为末尾一个
// options 对象（键名 camelCase）。append_fleet_event / set_node_state 的 **details 在 options 里按
// 事件字段原名（snake_case）书写，不做 camelCase 转换。
//
// 异常映射表（Python 分支 → JS）：
//   ToolError(msg)                       → ToolError(msg)，消息逐字
//   FileNotFoundError（子进程可执行缺失）→ spawnSync 的 ENOENT，收束为 ToolError("command not found: …")
//   subprocess.TimeoutExpired            → spawnSync 的 ETIMEDOUT / SIGTERM，收束为对应 ToolError 文案
//   OSError（读写状态文件、日志落盘）    → Node 系统错误，按 Python 各自的 except 分支收束
//   json.JSONDecodeError                 → pyJsonLoads 抛出的 name="JSONDecodeError" 错误
//   ValueError（datetime.fromisoformat） → liveness_check_due 内按 Python 同样吞掉并判定为「到期」
//
// 进程边界：dispatch_prepare 与 subagent_service 仍是子进程（前者由 Python 的
// `sys.executable -B ops/tools/dispatch_prepare.py` 改为 `process.execPath ops/tools/dispatch_prepare.mjs`，
// argv 其余部分逐字不变）；driver 脱管拉起本仓 CLI `ops/tools/fleet_scheduler.mjs drive`。
// 文件锁：file_lock.mjs 通过 Koffi 使用 Windows [0,1) 字节锁 / POSIX flock，与 Python 互斥。
// 锁文件永久保留；空文件或历史 PID 文本不代表持锁，进程崩溃由 OS 释放，无陈旧回收竞态。
import { spawn } from "node:child_process";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { uptime } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { tryFileLock } from "./file_lock.mjs";
import { HOST_REBOOT_MARGIN_MS } from "../async-core/runtime/shared.mjs";

import {
  ROOT,
  RUNTIME_ROOT,
  ToolError,
  canonicalJson,
  canonicalValue,
  clock,
  emit,
  isRecord,
  loadJson as readJson,
  pathlibJoin,
  rel,
  resolveLikePython,
  utcNow,
} from "./_tool_common.mjs";
import {
  pyIsRelativeTo, pyJsonDumps, pyJsonLoads, pyReadText, pyRepr, pyResolveUnder,
  pyRStrip, pySamePath, pySpawnSync, pyStr, pyStrip,
} from "./_py.mjs";
import {
  deepCopy,
  effectiveBudget,
  effectiveReviewPolicy,
  loadManifest,
  nodeCommand,
  nodeDependsOn,
  nodeDependencyArtifacts,
  nodeDependencyPolicy,
  nodeFailurePolicy,
  nodeId,
  nodeIsReducer,
  nodeIsolation,
  nodeKind,
  nodeResourceLocks,
  nodeRole,
  nodeRoute,
  nodeRouteSource,
  nodeSeed,
  nodeTargetIsolation,
  nodeWriteScope,
  pathConflict,
  sortedStrings,
  stringList,
  topologicalLayers,
  validateManifest,
} from "./fleet_manifest_check.mjs";

export {
  ROOT,
  ToolError,
  deepCopy,
  effectiveBudget,
  effectiveReviewPolicy,
  emit,
  loadManifest,
  nodeCommand,
  nodeDependsOn,
  nodeDependencyArtifacts,
  nodeDependencyPolicy,
  nodeFailurePolicy,
  nodeId,
  nodeIsReducer,
  nodeIsolation,
  nodeKind,
  nodeResourceLocks,
  nodeRole,
  nodeRoute,
  nodeRouteSource,
  nodeSeed,
  nodeWriteScope,
  pathConflict,
  readJson,
  rel,
  resolveLikePython,
  topologicalLayers,
  utcNow,
  validateManifest,
};

export const DEFAULT_STATE_ROOT = path.join(ROOT, ".runtime", "cockpit", "fleet_runs");
export const DEFAULT_ASYNC_TASK_ROOT = path.join(ROOT, ".runtime", "cockpit", "async_tasks");
export const TERMINAL_STATES = new Set(["done", "failed", "cancelled", "blocked", "needs_parent_review"]);
export const ASYNC_TERMINAL_STATES = new Set(["done", "failed", "cancelled"]);
export const ACTIVE_STATES = new Set(["submitted", "queued", "running", "cancel_requested"]);
export const FAILED_DEPENDENCY_STATES = new Set(["failed", "cancelled", "blocked"]);
export const SUMMARY_NODE_LIMIT = 8;
export const SUMMARY_EVENT_LIMIT = 8;
export const SAFE_ID_RE = /[^A-Za-z0-9_.-]+/g;
export const INITIAL_LIVENESS_GRACE_SECONDS = 10 * 60;
export const RUN_LOCK_TIMEOUT_SECONDS = 30.0;
export const LIVENESS_RECHECK_SECONDS = 5 * 60;
export const DISPATCH_PREPARE_TIMEOUT_SECONDS = 5 * 60;
export const MAX_RUNTIME_EVIDENCE_BYTES = 128 * 1024;
export const MAX_RUNTIME_USAGE_VALUE = 2147483647;
export const RUNTIME_USAGE_FIELDS = [
  "total_tokens",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "model_context_window",
];
export const ROUTE_KEYS = ["executor", "model", "effort"];

const SCHEDULER_CLI_PATH = process.argv[1] && /^fleet_scheduler(?:\.bundle)?\.mjs$/.test(path.basename(process.argv[1]))
  ? path.resolve(process.argv[1])
  : path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "fleet_scheduler.mjs");
const DISPATCH_PREPARE_PATH = existsSync(path.join(RUNTIME_ROOT, "ops/dist/dispatch_prepare.bundle.mjs"))
  ? path.join(RUNTIME_ROOT, "ops/dist/dispatch_prepare.bundle.mjs")
  : path.join(RUNTIME_ROOT, "ops/tools/dispatch_prepare.mjs");
const ASYNC_SERVICE_PATH = existsSync(path.join(RUNTIME_ROOT, "ops/tools/subagent_service.mjs"))
  ? path.join(RUNTIME_ROOT, "ops/tools/subagent_service.mjs")
  : path.join(RUNTIME_ROOT, "ops/dist/subagent_service.bundle.mjs");

// ---- Python 语义小工具（本模块私有；建议上提的已在回报里登记） ----

/** time.sleep()：同步阻塞，供 deps 替身覆盖。 */
function sleepSeconds(seconds) {
  const ms = Math.max(0, Number(seconds) * 1000);
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** time.monotonic()：单位秒的单调时钟。 */
function monotonicSeconds() {
  return Number(process.hrtime.bigint()) / 1e9;
}

/** int()：bool→0/1，数值向零截断，十进制字符串解析，其余抛 Python 对应异常。 */
function pyInt(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot convert float infinity to integer");
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = pyStrip(value);
    if (!/^[+-]?\d+$/.test(text)) throw new TypeError(`invalid literal for int() with base 10: ${pyRepr(value)}`);
    return Number.parseInt(text, 10);
  }
  throw new TypeError(`int() argument must be a string or a number, not '${typeof value}'`);
}

/** `value not in (None, "", [])`：Python 的相等语义（0 与 False 都保留）。 */
function notEmptyPy(value) {
  if (value === null || value === undefined) return false;
  if (value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/** dict 相等：键序无关的深比较。 */
function pyDictEqual(left, right) {
  return JSON.stringify(canonicalValue(left ?? null)) === JSON.stringify(canonicalValue(right ?? null));
}

/** list(dict.fromkeys(items))：保序去重。 */
function dedupe(items) {
  return [...new Set(items)];
}

/** datetime.fromisoformat(...) 的毫秒时间戳；不可解析返回 null。 */
function parseIsoMs(raw) {
  const text = String(raw).replace("Z", "+00:00");
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) return null;
  const hasZone = /(?:[+-]\d{2}:?\d{2})$/.test(text);
  const value = Date.parse(hasZone ? text : `${text}Z`);
  return Number.isFinite(value) ? value : null;
}

function isDir(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** `Path(value).resolve() if is_absolute else (base / value).resolve()`。 */
function resolveUnder(value, base) {
  return pyResolveUnder(pyStr(value), base);
}

/** pytest / 行为测试里被替换的模块级名字集中于此。 */
export const deps = {
  runCommand: runCommandImpl,
  asyncInternalBatch: asyncInternalBatchImpl,
  processAlive: processAliveImpl,
  bootTimeMs: () => Date.now() - Math.round(uptime() * 1000),
  dispatchNode: dispatchNodeImpl,
  launchDriver: launchDriverImpl,
  spawnDriver: spawn,
  sleep: sleepSeconds,
  monotonic: monotonicSeconds,
};

// ---- 时间与标识 ----

export function utcAfter(seconds) {
  const now = utcNow();
  const match = /^(.*?)(?:\.(\d{1,6}))?\+00:00$/.exec(now);
  const base = Date.parse(`${match[1]}Z`) + Number(seconds) * 1000;
  const fraction = match[2] ? `.${match[2]}` : "";
  return `${new Date(base).toISOString().slice(0, 19)}${fraction}+00:00`;
}

export function livenessCheckDue(node) {
  const raw = pyStr(node.next_liveness_check_at || "");
  if (!raw) return true;
  const due = parseIsoMs(raw);
  if (due === null) return true;
  return due <= clock.now().getTime();
}

export function deferLivenessCheck(node, seconds = LIVENESS_RECHECK_SECONDS) {
  node.next_liveness_check_at = utcAfter(seconds);
  return null;
}

export function safeId(value) {
  const cleaned = pyStripChars(pyStrip(pyStr(value)).replace(SAFE_ID_RE, "-"), ".-");
  return cleaned || "fleet-run";
}

function pyStripChars(text, chars) {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

// ---- 路径与状态文件 ----

export function writeJson(target, data) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${canonicalJson(data)}\n`, "utf8");
  return null;
}

export function requireRepoInternal(target, label) {
  const resolved = resolveLikePython(target);
  const root = resolveLikePython(ROOT);
  if (!pyIsRelativeTo(resolved, root)) {
    throw new ToolError(`${label} must stay under repo root: ${resolved}`);
  }
  return resolved;
}

export function stateRoot(value) {
  const resolved = value
    ? pyResolveUnder(pyStr(value), ROOT)
    : resolveLikePython(DEFAULT_STATE_ROOT);
  return requireRepoInternal(resolved, "state root");
}

export function runDir(root, runId) {
  return path.join(pyStr(root), safeId(runId));
}

export function statePath(root, runId) {
  return path.join(runDir(root, runId), "state.json");
}

export function manifestSnapshotPath(root, runId) {
  return path.join(runDir(root, runId), "manifest.json");
}

export function seedPath(root, runId, nodeIdValue) {
  return path.join(runDir(root, runId), "seeds", `${safeId(nodeIdValue)}.json`);
}

export function dependencyResultIndexPath(root, runId, nodeIdValue) {
  return path.join(runDir(root, runId), "dependency-results", `${safeId(nodeIdValue)}.json`);
}

export function driverStatusPath(root, runId) {
  return path.join(runDir(root, runId), "driver.json");
}

export function driverLogPath(root, runId) {
  return path.join(runDir(root, runId), "driver.log");
}

export function runLockPath(root, runId) {
  return path.join(runDir(root, runId), "scheduler.lock");
}

/**
 * Serialize state mutation and dispatch for one Fleet run across processes.
 * Python 的 contextmanager 在 JS 里写成回调：runMutationLock(root, runId, fn, { timeoutSeconds })。
 */
export function runMutationLock(root, runId, fn, { timeoutSeconds = RUN_LOCK_TIMEOUT_SECONDS } = {}) {
  const lock = acquireRunLock(root, runId, timeoutSeconds);
  try {
    const result = fn();
    // Preserve synchronous callers, but hold through fulfillment/rejection of async callbacks.
    if (result != null && typeof result.then === "function") {
      return Promise.resolve(result).finally(() => releaseRunLock(lock));
    }
    releaseRunLock(lock);
    return result;
  } catch (error) {
    releaseRunLock(lock);
    throw error;
  }
}

/** Returns an opaque OS-handle token, never a pathname that another owner could replace. */
export function acquireRunLock(root, runId, timeoutSeconds = RUN_LOCK_TIMEOUT_SECONDS) {
  const target = runLockPath(root, runId);
  mkdirSync(path.dirname(target), { recursive: true });
  const deadline = deps.monotonic() + Math.max(0, timeoutSeconds);
  for (;;) {
    const lock = tryFileLock(target);
    if (lock) return lock;
    if (deps.monotonic() >= deadline) throw new ToolError(`fleet run mutation lock busy: ${runId}`);
    deps.sleep(0.05);
  }
}

/** Async acquisition must yield so another launch in this process can finish and release. */
export async function acquireRunLockAsync(root, runId, timeoutSeconds = RUN_LOCK_TIMEOUT_SECONDS) {
  const target = runLockPath(root, runId);
  mkdirSync(path.dirname(target), { recursive: true });
  const deadline = deps.monotonic() + Math.max(0, timeoutSeconds);
  for (;;) {
    const lock = tryFileLock(target);
    if (lock) return lock;
    if (deps.monotonic() >= deadline) throw new ToolError(`fleet run mutation lock busy: ${runId}`);
    await delay(50);
  }
}

export function releaseRunLock(lock) {
  lock.release();
  return null;
}

function processAliveImpl(pid) {
  let value;
  try {
    value = pyInt(pid);
  } catch {
    return false;
  }
  if (value <= 0) return false;
  try {
    process.kill(value, 0);
  } catch {
    // Python 的 os.kill 在 PermissionError（OSError 子类）时同样落到 False 分支。
    return false;
  }
  return true;
}

export function processAlive(pid) {
  return deps.processAlive(pid);
}

// ---- route 记录 ----

export function newRouteRecord(requested, source) {
  return {
    source,
    requested: requested ? deepCopy(requested) : null,
    frozen: null,
    actual: null,
    identity_evidence: null,
    usage: { provenance: null, token_usage: null },
  };
}

export function ensureRouteRecord(node) {
  let record = node.route;
  if (!isRecord(record) || !Object.hasOwn(record, "requested")) {
    record = newRouteRecord(
      isRecord(node.requested_route) ? node.requested_route : null,
      pyStr(node.route_source || "agent_config"),
    );
    node.route = record;
  }
  if (!Object.hasOwn(record, "source")) record.source = pyStr(node.route_source || "agent_config");
  if (!Object.hasOwn(record, "actual")) record.actual = null;
  if (!Object.hasOwn(record, "frozen")) record.frozen = null;
  let usage = record.usage;
  if (!isRecord(usage)) {
    usage = {};
    record.usage = usage;
  }
  if (!Object.hasOwn(usage, "provenance")) usage.provenance = null;
  if (!Object.hasOwn(usage, "token_usage")) usage.token_usage = null;
  if (record.identity_evidence !== null && record.identity_evidence !== undefined && !isRecord(record.identity_evidence)) {
    record.identity_evidence = null;
  }
  node.route_source = record.source;
  node.requested_route = deepCopy(record.requested ?? null);
  node.actual_route = deepCopy(record.actual ?? null);
  delete node.fallback;
  node.usage_provenance = usage.provenance ?? null;
  return record;
}

export function routeSnapshot(node) {
  return deepCopy(ensureRouteRecord(node));
}

export function frozenRequestedRoute(node) {
  const requested = ensureRouteRecord(node).requested;
  return isRecord(requested) ? deepCopy(requested) : null;
}

function routeFromPayload(payload) {
  let nested = {};
  for (const key of ["actual_route", "actual", "route"]) {
    const value = payload[key];
    if (isRecord(value)) {
      nested = value;
      break;
    }
  }
  const values = {};
  const aliases = {
    executor: ["actual_executor", "executor"],
    model: ["actual_model", "model"],
    effort: ["actual_effort", "effort"],
  };
  for (const [key, names] of Object.entries(aliases)) {
    let value = null;
    for (const name of [key, ...names]) {
      const candidate = nested[name];
      if (notEmptyValue(candidate)) {
        value = candidate;
        break;
      }
    }
    if (!notEmptyValue(value)) {
      value = null;
      for (const name of names) {
        const candidate = payload[name];
        if (notEmptyValue(candidate)) {
          value = candidate;
          break;
        }
      }
    }
    if (notEmptyValue(value)) values[key] = pyStr(value);
  }
  if (!Object.keys(values).length) return null;
  const result = {};
  for (const key of ROUTE_KEYS) result[key] = Object.hasOwn(values, key) ? values[key] : null;
  if (Object.hasOwn(nested, "provider") || Object.hasOwn(payload, "provider")) {
    result.provider = Object.hasOwn(nested, "provider") ? nested.provider : payload.provider;
  }
  return result;
}

/** `value not in (None, "")`。 */
function notEmptyValue(value) {
  return value !== null && value !== undefined && value !== "";
}

export function updateRouteFromPayload(node, payload, source) {
  const record = ensureRouteRecord(node);
  const actual = routeFromPayload(payload);
  if (actual) {
    const previous = isRecord(record.actual) ? record.actual : {};
    record.actual = { ...previous, ...actual, source };
  }

  const usage = isRecord(payload.usage) ? payload.usage : {};
  const usageProvenance = payload.usage_provenance || usage.provenance;
  if (notEmptyValue(usageProvenance)) record.usage.provenance = pyStr(usageProvenance);
  ensureRouteRecord(node);
  return null;
}

export function routeMatchesManifest(node, manifestNode) {
  const record = ensureRouteRecord(node);
  return record.source === nodeRouteSource(manifestNode)
    && pyDictEqual(record.requested ?? null, nodeRoute(manifestNode));
}

export function normalizeDispatchOverrides(contextMode = "") {
  const context = pyStrip(pyStr(contextMode || ""));
  if (context && !["isolated", "project-aware"].includes(context)) {
    throw new ToolError(`unsupported async context mode: ${context}`);
  }
  return context ? { context_mode: context } : {};
}

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

function positiveInt(value, fallback = 0) {
  let parsed;
  try {
    parsed = pyInt(value);
  } catch {
    return fallback;
  }
  return parsed >= 0 ? parsed : fallback;
}

export { positiveInt as _positiveInt };

const BUSINESS_STATE_BY_NODE_STATE = {
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
  const criticality = downstreamCounts(manifestNodesList);
  const layerIndex = Object.create(null);
  layers.forEach((layer, index) => {
    for (const nid of layer) layerIndex[nid] = index;
  });
  const existing = preserveExisting ? state.ready_queue : [];
  const existingIds = Array.isArray(existing) ? existing.map((item) => pyStr(item)) : [];
  const candidates = new Set();
  for (const [nid, node] of Object.entries(byId)) {
    if (node.state === "pending" && dependenciesReady(node, byId)) candidates.add(pyStr(nid));
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
  if (existsSync(cancellationPath(resolvedRoot, runId))) throw new ToolError("cancelled fleet records are retained; use a new run_id");
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

function runCommandImpl(cmd, cwd, { stdin = null, timeout = 60 } = {}) {
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

function runtimeTaskDir(node) {
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

function readBoundedRuntimeJson(target) {
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

function readTerminalRuntimeArtifacts(node) {
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

function runtimeIdentityEvidence(node, childResult) {
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

function runtimeTokenUsage(live) {
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

function requiresSafetyReview(status) {
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
    appendFleetEvent(fleetState, eventType, node, {
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
    if (state.state_root && state.run_id && existsSync(cancellationPath(state.state_root, state.run_id))) {
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

function asyncInternalBatchImpl(operation, taskRoot, taskIds, { detail = "compact" } = {}) {
  const statuses = Object.create(null);
  const errors = [];
  const batchSize = operation === "get" && detail === "diagnostic" ? 5 : 20;
  for (let start = 0; start < taskIds.length; start += batchSize) {
    const batch = taskIds.slice(start, start + batchSize);
    const argv = [
      "node",
      ASYNC_SERVICE_PATH,
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
  const byId = indexNodes(state);
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
    if (depState === "needs_parent_review" && requiresSafetyReview(depNode.last_status || {})) return false;
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
  const byId = indexNodes(state);
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
    if (dependency.kind === "gate" || requiresSafetyReview(dependency.last_status || {})) {
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
      setNodeState(state, dependency, executionState, {
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
  const byId = indexNodes(state);
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
      if (notEmptyPy(value)) entry[key] = typeof value === "string" ? shortText(value) : value;
    }
    const blockIssue = dependency.acceptance_results_block;
    if (blockIssue) {
      entry.acceptance_results_block = typeof blockIssue === "string" ? shortText(blockIssue) : blockIssue;
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
  if (fleetState) appendFleetEvent(fleetState, "agent_settled", node, {
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
    appendFleetEvent(fleetState, "agent_settled", node, {
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

export function commandNodeCwd(spec) {
  const declared = pyStrip(pyStr(spec.cwd || ""));
  if (!declared) return ROOT;
  const cwd = resolveLikePython(pathlibJoin(ROOT, declared));
  if (!pyIsRelativeTo(cwd, ROOT)) {
    throw new ToolError(`command cwd escapes repository root: ${declared}`);
  }
  return cwd;
}

/** Expose run identity and, when declared, the dependency artifact index to the command. */
export function commandNodeEnv(state, node, manifestNode) {
  const env = { ...process.env };
  const root = pyStr(state.state_root);
  const runId = pyStr(state.run_id);
  env.FLEET_RUN_ID = runId;
  env.FLEET_NODE_ID = pyStr(node.id || "");
  env.FLEET_RUN_DIR = runDir(root, runId);
  env.FLEET_STATE_PATH = statePath(root, runId);
  if (!nodeDependencyArtifacts(manifestNode).length) return env;
  const [artifacts, entries] = dependencyResultEntries(state, node, manifestNode);
  if (nodeDependencyPolicy(manifestNode) === "all_settled") {
    env.FLEET_DEPENDENCY_RESULT_INDEX = writeDependencyResultIndex(state, node, manifestNode, entries);
  }
  if (artifacts.length) env.FLEET_DEPENDENCY_ARTIFACTS = artifacts.join(path.delimiter);
  return env;
}

export function executeCommandNode(state, node, manifestNode, { dryRun = false } = {}) {
  // 至少一次语义：state 在 tick 结束才落盘，命令执行中途崩溃会在 resume 时重跑，命令必须可重入。
  const root = pyStr(state.state_root);
  const runId = pyStr(state.run_id);
  const spec = nodeCommand(manifestNode);
  const argv = [...(spec.argv || [])];
  let cwd;
  try {
    if (!argv.length) throw new ToolError(`command node ${pyStr(node.id ?? null)} has no argv`);
    cwd = commandNodeCwd(spec);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    // 无效命令直接结算负结果，不重复执行。
    markFailure(node, {
      contractState: "command_invalid",
      failureType: "command_invalid",
      error: String(error.message),
      fleetState: state,
    });
    return {
      status: "failed",
      node_id: node.id,
      error: String(error.message),
    };
  }
  const timeout = pyInt(spec.timeout_seconds || 600);
  if (dryRun) {
    return {
      status: "ok",
      node_id: node.id,
      dry_run: true,
      dispatch: { would_run: argv, cwd, timeout_seconds: timeout },
    };
  }
  let env;
  try {
    env = commandNodeEnv(state, node, manifestNode);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    markFailure(node, {
      contractState: "dependency_artifact_missing",
      failureType: "dependency_artifact_missing",
      error: String(error.message),
      fleetState: state,
    });
    return { status: "failed", node_id: node.id, error: String(error.message) };
  }
  const attempt = positiveInt(node.command_attempts) + 1;
  node.command_attempts = attempt;
  const logsDir = path.join(runDir(root, runId), "commands");
  mkdirSync(logsDir, { recursive: true });
  const stdoutPath = path.join(logsDir, `${safeId(pyStr(node.id))}.attempt-${attempt}.stdout.log`);
  const stderrPath = path.join(logsDir, `${safeId(pyStr(node.id))}.attempt-${attempt}.stderr.log`);
  const startedAt = deps.monotonic();
  let failure = null;
  let exitCode = null;
  let stdoutText = "";
  let stderrText = "";
  const workerResultPath = path.join(logsDir, `${safeId(pyStr(node.id))}.attempt-${attempt}.process.json`);
  const workerSpecPath = path.join(logsDir, `${safeId(pyStr(node.id))}.attempt-${attempt}.spec.json`);
  writeJson(workerSpecPath, { argv, cwd, timeout_ms: timeout * 1000, cancel_path: cancellationPath(root, runId), result_path: workerResultPath });
  const proc = pySpawnSync(process.execPath, [SCHEDULER_CLI_PATH, "command-worker", "--spec", workerSpecPath], {
    cwd,
    env,
    encoding: "utf8",
    timeout: (timeout + 40) * 1000,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  const workerResult = existsSync(workerResultPath) ? readJson(workerResultPath) : null;
  if (workerResult?.cancelled || (existsSync(cancellationPath(root, runId)) && !workerResult)) {
    writeFileSync(stdoutPath, pyStr(proc.stdout ?? ""));
    writeFileSync(stderrPath, pyStr(proc.stderr ?? ""));
    node.command_termination = workerResult || { confirmed: false, error: "command supervisor result missing" };
    setNodeState(state, node, workerResult?.confirmed ? "cancelled" : "running", { eventType: workerResult?.confirmed ? "agent_settled" : "agent_progress", businessState: workerResult?.confirmed ? "cancelled" : "running" });
    node.command_result = { argv, cwd, attempt, stdout_path: stdoutPath, stderr_path: stderrPath };
    node.not_executed = Boolean(workerResult?.not_executed);
    node.cancel_reason = "user_requested";
    return { status: "ok", node_id: node.id, terminal: Boolean(workerResult?.confirmed), cancelled: Boolean(workerResult?.confirmed) };
  }
  stdoutText = pyStr(proc.stdout ?? "");
  stderrText = pyStr(proc.stderr ?? "");
  if (workerResult?.timed_out) {
    failure = ["command_timeout", `command timed out after ${timeout}s`];
  } else if (workerResult?.error) {
    failure = [workerResult.error_code === "ENOENT" ? "command_not_found" : "command_spawn_failed", workerResult.error];
  } else if (proc.error && proc.error.code === "ENOENT") {
    failure = ["command_not_found", `command executable not found: ${argv[0]}`];
  } else if (proc.error && proc.error.code === "ETIMEDOUT") {
    stdoutText = pyStr(proc.stdout ?? "");
    stderrText = pyStr(proc.stderr ?? "");
    failure = ["command_timeout", `command timed out after ${timeout}s`];
  } else if (proc.error) {
    failure = ["command_spawn_failed", `command spawn failed: ${proc.error.message}`];
  } else if (proc.signal && proc.status === null) {
    stdoutText = pyStr(proc.stdout ?? "");
    stderrText = pyStr(proc.stderr ?? "");
    failure = ["command_timeout", `command timed out after ${timeout}s`];
  } else {
    exitCode = proc.status;
    stdoutText = pyStr(proc.stdout ?? "");
    stderrText = pyStr(proc.stderr ?? "");
    if (exitCode !== 0) {
      failure = ["command_failed", `command exited ${exitCode}: ${pyStrip(stderrText).slice(0, 800)}`];
    }
  }
  const durationSeconds = Math.round((deps.monotonic() - startedAt) * 1000) / 1000;
  try {
    writeFileSync(stdoutPath, stdoutText, "utf8");
    writeFileSync(stderrPath, stderrText, "utf8");
  } catch (error) {
    if (failure === null) failure = ["command_log_write_failed", `cannot persist command logs: ${error.message}`];
  }
  node.command_result = {
    argv,
    cwd,
    attempt,
    exit_code: exitCode,
    duration_seconds: durationSeconds,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
  };
  node.updated_at = utcNow();
  if (failure !== null) {
    const [contractState, error] = failure;
    const quarantined = !workerResult?.confirmed;
    node.resource_quarantined = quarantined;
    (quarantined ? markParentReview : markFailure)(node, {
      contractState,
      failureType: quarantined ? "retained_worker" : contractState,
      error,
      fleetState: state,
    });
    node.last_status.stdout_path = stdoutPath;
    node.last_status.stderr_path = stderrPath;
    return {
      status: node.state,
      node_id: node.id,
      error,
    };
  }
  node.last_status = {
    source: "fleet_command",
    state: "done",
    business_state: "completed",
    exit_code: 0,
    duration_seconds: durationSeconds,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    // 命令的 stdout 就是它对下游的正式产物，接进 dependency_artifacts 的 report 解析链。
    report_path: stdoutPath,
  };
  setNodeState(state, node, "done", {
    eventType: "agent_settled",
    businessState: "completed",
    command: argv[0],
    duration_seconds: durationSeconds,
  });
  return {
    status: "ok",
    node_id: node.id,
    terminal: true,
    exit_code: 0,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
  };
}

/** A gate is a pure decision point: it opens as needs_parent_review and waits for review. */
export function openGateNode(state, node, { dryRun = false } = {}) {
  if (dryRun) {
    return {
      status: "ok",
      node_id: node.id,
      dry_run: true,
      dispatch: { gate: "would_open" },
    };
  }
  node.review_required = true;
  node.review_decision = "pending";
  node.last_status = {
    source: "fleet_gate",
    state: "needs_parent_review",
    business_state: "gate_open",
    requires_parent_review: true,
  };
  setNodeState(state, node, "needs_parent_review", {
    eventType: "gate_opened",
    businessState: "gate_open",
  });
  return { status: "ok", node_id: node.id, terminal: true, gate: "opened" };
}

function dispatchNodeImpl(state, manifest, node, manifestNode, { dryRun = false } = {}) {
  const kind = pyStr(node.kind || nodeKind(manifestNode));
  if (kind === "command") return executeCommandNode(state, node, manifestNode, { dryRun });
  if (kind === "gate") return openGateNode(state, node, { dryRun });
  const root = pyStr(state.state_root);
  const runId = pyStr(state.run_id);
  let seed;
  try {
    seed = seedWithDependencyArtifacts(state, node, manifestNode, manifest);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    if (!nodeDependencyArtifacts(manifestNode).length) throw error;
    markFailure(node, {
      contractState: "dependency_artifact_missing",
      failureType: "dependency_artifact_missing",
      error: String(error.message),
      fleetState: state,
    });
    return { status: "failed", node_id: node.id, error: String(error.message) };
  }
  const seedFile = seedPath(root, runId, pyStr(node.id));
  writeJson(seedFile, seed);
  let dispatchCwd = ROOT;
  if (node.isolation === "worktree") {
    dispatchCwd = dryRun
      ? path.join(runDir(root, runId), "worktrees", safeId(pyStr(node.id)))
      : ensureWorktree(state, node);
  }
  const cmd = [
    process.execPath,
    DISPATCH_PREPARE_PATH,
    "--seed-stdin",
    "--format",
    "json",
    "--async-task-root",
    pyStr(nodeTaskRoot(state, node)),
    "--batch-id",
    runId,
  ];
  const dispatchOverrides = isRecord(state.dispatch_overrides) ? state.dispatch_overrides : {};
  const requestedRoute = frozenRequestedRoute(node);
  if (requestedRoute) {
    if (Object.hasOwn(requestedRoute, "pick")) cmd.push("--async-pick", requestedRoute.pick);
    if (Object.hasOwn(requestedRoute, "model")) cmd.push("--async-model", requestedRoute.model);
    if (Object.hasOwn(requestedRoute, "effort")) cmd.push("--async-effort", requestedRoute.effort);
    if (Object.hasOwn(requestedRoute, "authorization")) {
      cmd.push("--async-authorization", typeof requestedRoute.authorization === "string"
        ? requestedRoute.authorization
        : pyJsonDumps(requestedRoute.authorization));
    }
  }
  if (dispatchOverrides.context_mode) {
    cmd.push("--async-context-mode", pyStr(dispatchOverrides.context_mode));
  }
  if (dryRun) cmd.push("--action", "preview");
  let result;
  if (dryRun) {
    result = {
      status: "ok",
      dry_run: true,
      would_run: cmd,
      cwd: dispatchCwd,
      seed_path: rel(seedFile),
    };
  } else {
    const raw = deps.runCommand(cmd, dispatchCwd, {
      stdin: pyJsonDumps(seed),
      timeout: DISPATCH_PREPARE_TIMEOUT_SECONDS,
    });
    if (raw.exit_code !== 0) {
      const stderr = raw.stderr.slice(0, 1200);
      const stdout = raw.stdout.slice(0, 1200);
      const error = pyStrip(stderr) || pyStrip(stdout)
        || `dispatch_prepare exited ${raw.exit_code} without output`;
      node.dispatch = { exit_code: raw.exit_code, error: stderr, stdout };
      const safetyFailure = /write claim|identity|write.domain|write.scope|retained.worker/i.test(error);
      (safetyFailure ? markParentReview : markFailure)(node, {
        contractState: "dispatch_prepare_failed",
        failureType: error.toLowerCase().includes("write claim") ? "write_claim_conflict" : "dispatch_prepare_exit",
        error,
        fleetState: state,
      });
      return {
        status: node.state,
        node_id: node.id,
        error,
      };
    }
    result = parseJsonStdout(raw, "dispatch_prepare");
  }
  node.dispatch = result;
  const frozenSelection = isRecord(result.selection) ? result.selection
    : isRecord(result.async_preview?.selection) ? result.async_preview.selection
    : isRecord(result.async_model_selection?.selection) ? result.async_model_selection.selection
    : null;
  if (frozenSelection) ensureRouteRecord(node).frozen = deepCopy(frozenSelection);
  node.updated_at = utcNow();
  if (dryRun) return { status: "ok", node_id: node.id, dry_run: true, dispatch: result };
  const taskId = result.task_id;
  if (!taskId) {
    const error = "dispatch result missing task_id";
    markParentReview(node, {
      contractState: "dispatch_result_invalid",
      failureType: "dispatch_missing_task_id",
      error,
      fleetState: state,
    });
    return {
      status: "needs_parent_review",
      node_id: node.id,
      reason: "dispatch_result_requires_parent_review",
      error,
    };
  }
  node.task_id = taskId;
  node.receipt_task_id = taskId;
  if (result.warnings?.length) node.warnings = [...result.warnings];
  else delete node.warnings;
  updateRouteFromPayload(node, result, "dispatch_receipt");
  node.task_root = pyStr(nodeTaskRoot(state, node));
  setNodeState(state, node, pyStr(result.state || "submitted"), {
    eventType: "agent_started",
    businessState: pyStr(result.business_state || "") || null,
    dispatch_source: "dispatch_prepare",
    route: routeSnapshot(node),
  });
  node.next_liveness_check_at = utcAfter(INITIAL_LIVENESS_GRACE_SECONDS);
  return { status: "ok", node_id: node.id, task_id: taskId, dispatch: result };
}

export function dispatchNode(state, manifest, node, manifestNode, options = {}) {
  return deps.dispatchNode(state, manifest, node, manifestNode, options);
}

/** Keep the default tick surface useful without echoing the full task package. */
export function compactDispatchOutcome(outcome) {
  const data = {};
  for (const key of ["status", "node_id", "task_id", "dry_run", "error"]) {
    if (notEmptyPy(outcome[key])) data[key] = outcome[key];
  }

  const dispatch = outcome.dispatch;
  if (isRecord(dispatch)) {
    for (const key of [
      "delivery_mode",
      "resolved_delivery",
      "warnings",
      "model",
      "effort",
      "package_id",
      "task_package_path",
      "seed_path",
      "cwd",
    ]) {
      if (notEmptyPy(dispatch[key])) data[key] = dispatch[key];
    }
    const businessOutput = dispatch.business_output;
    if (isRecord(businessOutput)) {
      for (const key of ["expected_report_path", "expected_handoff_path"]) {
        if (notEmptyPy(businessOutput[key])) data[key] = businessOutput[key];
      }
    }
  }
  return data;
}

/** Emit one settlement for each changed terminal driver outcome. */
export function settleFleetIfNeeded(state) {
  const terminal = (Array.isArray(state.nodes) ? state.nodes : []).every(
    (node) => isRecord(node) && TERMINAL_STATES.has(node.state),
  );
  if (!terminal) return false;
  const outcomeState = driverOutcome(state);
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
  appendFleetEvent(state, "fleet_settled", null, {
    businessState: outcomeState,
    incrementNodeRevision: false,
    counts: stateCounts(state),
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
function missingTaskStoppedByReboot(state, node, taskRoot, failures) {
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
      const taskRoot = nodeTaskRoot(state, node);
      try {
        node.cancel_reason = "user_requested";
        const [statuses, failures] = asyncInternalBatch("get", taskRoot, [node.task_id]);
        let status = statuses[node.task_id];
        if (!status && missingTaskStoppedByReboot(state, node, taskRoot, failures)) {
          setNodeState(state, node, "cancelled", { eventType: "agent_settled", businessState: "unknown",
            source: "host_reboot_missing_task" });
          node.missing_task_evidence = { task_id: node.task_id, source: "host_reboot", outcome: "unknown" };
          node.resource_quarantined = false;
          continue;
        }
        errors.push(...failures);
        if (!status) continue;
        if (!ASYNC_TERMINAL_STATES.has(status.state) || node.resource_quarantined) {
          const result = deps.runCommand([
            process.execPath, ASYNC_SERVICE_PATH, "internal", "cancel",
            "--task-root", taskRoot, "--task-id", node.task_id,
            "--expected-revision", String(status.revision), "--reason", "user_requested",
          ], ROOT);
          if (result.exit_code !== 0) errors.push((result.stderr || result.stdout).slice(0, 600));
          const [latest, refreshErrors] = asyncInternalBatch("get", taskRoot, [node.task_id]);
          errors.push(...refreshErrors);
          status = latest[node.task_id];
        }
        if (status) applyAsyncStatus(node, status, "fleet_cancel", state);
      } catch (error) {
        errors.push(`${node.id}: ${error.message}`);
      }
    } else if (ACTIVE_STATES.has(node.state) || node.resource_quarantined) {
      errors.push(`${node.id}: active execution has no confirmed termination`);
    } else if (node.state === "paused") {
      errors.push(`${node.id}: paused execution has no task_id; not marked cancelled`);
    } else if (!TERMINAL_STATES.has(node.state)) {
      setNodeState(state, node, "cancelled", { eventType: "agent_settled", businessState: "cancelled" });
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
      counts: stateCounts(state), updated_at: utcNow() });
  }
  return { status: state.run_state, run_id: state.run_id, active: active.map((node) => node.id), errors, submitted: [] };
}

export function pauseRequestPath(root, runId) {
  return path.join(runDir(root, runId), "pause-request.json");
}

/** 停派意图的权威来源是独立控制文件，不是状态快照；读不到返回 null。 */
export function readPauseIntent(root, runId) {
  const target = pauseRequestPath(root, runId);
  return existsSync(target) ? readJson(target) : null;
}

const PAUSE_UNCONFIRMED_NEXT_STEP = "已登记的暂停请求尚未确认停止：用 status 观察收敛，或等任务会话保存完成；"
  + "Fleet 不自动强杀，也不释放未停止任务的写域；确实需要终止请显式 cancel。";
const RESUME_SEAM_NEXT_STEP = "恢复尚未完成，停派意图和未恢复任务已保留；根据 errors 排除原因后重试 resume。";

/** 解析 async service 控制子命令的 JSON 回执；非 0 退出或非对象一律返回 null。 */
function parseControlReply(result, label) {
  if (!result || result.exit_code !== 0) return null;
  try {
    const data = pyJsonLoads(String(result.stdout ?? ""));
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

function controlFailureDetail(result) {
  return String(result?.stderr || result?.stdout || "").trim().slice(0, 300);
}

/** 以当前 revision 调用 Core 的协作暂停/恢复；不强杀、不释放写域。 */
function runAsyncControl(operation, taskRoot, taskId, { expectedRevision = "", reason = "" } = {}) {
  const argv = [
    process.execPath,
    ASYNC_SERVICE_PATH,
    "internal",
    operation,
    "--task-root",
    pyStr(taskRoot),
    "--task-id",
    pyStr(taskId),
  ];
  if (expectedRevision) argv.push("--expected-revision", pyStr(expectedRevision));
  if (reason) argv.push("--reason", pyStr(reason));
  const result = deps.runCommand(argv, ROOT);
  return { reply: parseControlReply(result, `async internal ${operation}`), detail: controlFailureDetail(result) };
}

/**
 * 记录本次 run 的停派意图并逐任务发起 Core.pause，返回冻结回执。
 * 只记录本次 pause 实际发起的 task_ids；此前已独立暂停的任务进 independent_task_ids，不自动恢复。
 */
export function settlePause(state, { reason = null } = {}) {
  const errors = [];
  const root = pyStr(state.state_root);
  const runId = pyStr(state.run_id);
  const intent = readPauseIntent(root, runId);
  const intentReason = pyStr(reason || intent?.reason || state.pause_request?.reason || "pause_requested");
  const recorded = new Set(
    [...(intent?.task_ids ?? []), ...(state.pause_request?.task_ids ?? [])].map((item) => pyStr(item)).filter(Boolean),
  );
  const independent = new Set(
    [...(intent?.independent_task_ids ?? []), ...(state.pause_request?.independent_task_ids ?? [])]
      .map((item) => pyStr(item)).filter(Boolean),
  );
  const nodes = (Array.isArray(state.nodes) ? state.nodes : []).filter((node) => isRecord(node));

  // cancel 优先：已有取消请求时暂停不再动作，也不改写既有终态。
  if (existsSync(cancellationPath(root, runId))) {
    const cancellation = readJson(cancellationPath(root, runId));
    const cancellationState = ["cancelled", "cancelling"].includes(pyStr(state.run_state))
      ? pyStr(state.run_state)
      : "cancelling";
    return {
      run_id: runId,
      accepted: false,
      state: cancellationState,
      reason: "cancel_priority",
      paused_task_ids: [],
      pending_task_ids: [],
      next_step: `已存在取消请求（${pyStr(cancellation?.reason || "")}），暂停不再执行；用 status 观察取消收敛，`
        + "取消完成后需要继续时按新 run 处理。",
    };
  }

  if (nodes.length && nodes.every((node) => TERMINAL_STATES.has(node.state))) {
    // 已收口的 run 保持原终态，不改成 paused。
    const settled = driverOutcome({ ...state, run_state: "running" });
    state.run_state = settled;
    state.updated_at = utcNow();
    return {
      run_id: runId,
      accepted: true,
      state: settled,
      reason: "run_already_settled",
      paused_task_ids: [],
      pending_task_ids: [],
    };
  }

  for (const node of nodes) {
    const taskId = pyStr(node.task_id || "");
    if (!taskId) continue;
    if (!(ACTIVE_STATES.has(node.state) || node.state === "paused")) continue;
    const taskRoot = nodeTaskRoot(state, node);
    const [statuses, failures] = asyncInternalBatch("get", taskRoot, [taskId], { detail: "diagnostic" });
    errors.push(...failures);
    const status = statuses[taskId];
    if (!status) {
      errors.push(`${pyStr(node.id)}: async get missing task ${taskId}`);
      continue;
    }
    if (status.state === "paused") {
      // 本次 pause 之前就已暂停的任务保持独立，不列入自动恢复集合。
      if (!recorded.has(taskId)) independent.add(taskId);
      applyAsyncStatus(node, status, "fleet_pause", state);
      continue;
    }
    if (!ACTIVE_STATES.has(status.state)) {
      applyAsyncStatus(node, status, "fleet_pause", state);
      continue;
    }
    if (node.pause_requested) continue;
    const control = runAsyncControl("pause", taskRoot, taskId, {
      expectedRevision: pyStr(status.revision),
      reason: intentReason,
    });
    if (!control.reply) {
      errors.push(`${pyStr(node.id)}: internal pause 未取得回执${control.detail ? `：${control.detail}` : ""}`);
      continue;
    }
    node.pause_request_reason = pyStr(control.reply.reason || "");
    if (control.reply.reason === "already_paused") {
      independent.add(taskId);
      continue;
    }
    if (control.reply.accepted === false || control.reply.ok === false) {
      errors.push(`${pyStr(node.id)}: ${pyStr(control.reply.reason || "pause_rejected")}`
        + `${control.reply.next_step ? ` — ${pyStr(control.reply.next_step)}` : ""}`);
      continue;
    }
    node.pause_requested = true;
    recorded.add(taskId);
  }

  // 收敛观察：本次发起的任务只有确认停止后才算 paused。
  const pausedTaskIds = [];
  const pendingTaskIds = [];
  for (const taskId of [...recorded]) {
    const node = nodes.find((item) => pyStr(item.task_id || "") === taskId);
    if (!node) {
      pendingTaskIds.push(taskId);
      continue;
    }
    const [statuses, failures] = asyncInternalBatch("get", nodeTaskRoot(state, node), [taskId], { detail: "diagnostic" });
    errors.push(...failures);
    const status = statuses[taskId];
    if (status) applyAsyncStatus(node, status, "fleet_pause", state);
    if (status?.state === "paused") pausedTaskIds.push(taskId);
    else if (!status || !TERMINAL_STATES.has(status.state)) pendingTaskIds.push(taskId);
  }

  const unmanagedActive = nodes
    .filter((node) => ACTIVE_STATES.has(node.state) && !pyStr(node.task_id || ""))
    .map((node) => pyStr(node.id));
  const activeAny = nodes.some((node) => ACTIVE_STATES.has(node.state));
  const runState = pendingTaskIds.length || activeAny ? "pausing" : "paused";
  state.pause_request = {
    reason: intentReason,
    requested_at: pyStr(intent?.requested_at || state.pause_request?.requested_at || utcNow()),
    task_ids: [...recorded],
    independent_task_ids: [...independent],
    paused_task_ids: pausedTaskIds,
    pending_task_ids: pendingTaskIds,
    updated_at: utcNow(),
  };
  state.run_state = runState;
  state.updated_at = utcNow();
  if (intent) {
    // 锁内唯一写者：把已发起的 task_ids 回写控制文件，旧状态快照无法丢掉暂停意图。
    writeJson(pauseRequestPath(root, runId), {
      ...intent,
      reason: intentReason,
      task_ids: [...recorded],
      independent_task_ids: [...independent],
      updated_at: utcNow(),
    });
  }
  const receipt = {
    run_id: runId,
    accepted: true,
    state: runState,
    reason: pendingTaskIds.length ? "pause_requested" : (recorded.size ? "pause_confirmed" : "pause_idle"),
    paused_task_ids: pausedTaskIds,
    pending_task_ids: pendingTaskIds,
  };
  if (errors.length) {
    receipt.errors = errors.slice(0, 20);
    receipt.next_step = PAUSE_UNCONFIRMED_NEXT_STEP;
  } else if (unmanagedActive.length) {
    receipt.next_step = `节点 ${unmanagedActive.join(", ")} 为同步执行，不能协作暂停；`
      + "等其本轮结束且无其他活动执行后 run 才进入 paused。";
  }
  return receipt;
}

/** 先持久停派意图，再以各任务当前 revision 调用 Core.pause；不强杀、不释放写域。 */
export function pauseRun(runId, root, reason) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const text = String(reason || "").trim();
  if (!text) throw new ToolError("pause reason is required");
  readJson(statePath(resolvedRoot, runId));
  const intentPath = pauseRequestPath(resolvedRoot, runId);
  if (!existsSync(intentPath)) {
    // 独立于 tick 锁落盘：意图先于任务暂停持久，driver 的旧快照不能再派新节点。
    writeJson(intentPath, { reason: text, requested_at: utcNow(), task_ids: [], independent_task_ids: [] });
  }
  try {
    return runMutationLock(resolvedRoot, runId, () => {
      const state = readJson(statePath(resolvedRoot, runId));
      state.resume_pending = false;
      const receipt = settlePause(state, { reason: text });
      writeJson(statePath(resolvedRoot, runId), state);
      // cancel 优先：取消已在途时不留下悬挂的停派意图。
      if (receipt.reason === "cancel_priority") rmSync(intentPath, { force: true });
      return receipt;
    }, { timeoutSeconds: 15 });
  } catch (error) {
    if (!String(error.message).startsWith("fleet run mutation lock busy:")) throw error;
    return {
      run_id: runId,
      accepted: true,
      state: "pausing",
      reason: "waiting_for_inflight_operation",
      paused_task_ids: [],
      pending_task_ids: [],
      next_step: "调度器正在处理本轮派发，停派意图已落盘；driver 下一轮 tick 会继续协作暂停，用 status 观察收敛。",
    };
  }
}

/** 只恢复本次 pause 记录的任务；独立暂停的任务保持暂停，会话路径与 task_id 不变。 */
function resumePausedTasks(state, intent) {
  const errors = [];
  const pendingTaskIds = [];
  const nodes = (Array.isArray(state.nodes) ? state.nodes : []).filter((node) => isRecord(node));
  for (const rawTaskId of (intent?.task_ids ?? [])) {
    const taskId = pyStr(rawTaskId);
    if (!taskId) continue;
    const node = nodes.find((item) => pyStr(item.task_id || "") === taskId);
    if (!node) {
      pendingTaskIds.push(taskId);
      errors.push(`${taskId}: 已不再绑定到任何节点，未恢复`);
      continue;
    }
    const taskRoot = nodeTaskRoot(state, node);
    const [statuses, failures] = asyncInternalBatch("get", taskRoot, [taskId], { detail: "diagnostic" });
    errors.push(...failures);
    const status = statuses[taskId];
    if (!status) {
      pendingTaskIds.push(taskId);
      errors.push(`${taskId}: async get missing task`);
      continue;
    }
    if (status.state !== "paused") {
      applyAsyncStatus(node, status, "fleet_resume", state);
      if (ACTIVE_STATES.has(status.state) && node.pause_requested) pendingTaskIds.push(taskId);
      continue;
    }
    const control = runAsyncControl("resume", taskRoot, taskId, { expectedRevision: pyStr(status.revision) });
    if (!control.reply || control.reply.ok === false || control.reply.accepted === false) {
      pendingTaskIds.push(taskId);
      const reason = control.reply ? pyStr(control.reply.reason || "resume_rejected") : `internal resume 未取得回执${control.detail ? `：${control.detail}` : ""}`;
      errors.push(`${taskId}: ${reason}`);
      continue;
    }
    node.pause_requested = false;
    node.pause_request_reason = null;
  }
  return { pending_task_ids: pendingTaskIds, errors };
}

export function tickRun(runId, root, dryRun, verbose = false, { forceReconcile = false } = {}) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  return runMutationLock(resolvedRoot, runId, () =>
    tickRunLocked(runId, resolvedRoot, dryRun, verbose, { forceReconcile }));
}

export function tickRunLocked(runId, root, dryRun, verbose = false, { forceReconcile = false } = {}) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const target = statePath(resolvedRoot, runId);
  const state = readJson(target);
  if (existsSync(cancellationPath(resolvedRoot, runId))) {
    return dryRun ? { status: "cancelling", run_id: runId, submitted: [], dry_run: true } : settleCancellation(state);
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
  const byId = indexNodes(state);
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
  const refreshSummary = refreshActiveNodes(state, { forceReconcile });
  const acceptanceGateActions = enforceAcceptanceResultsGate(state, manifestById);
  if (acceptanceGateActions.length) refreshSummary.acceptance_results_gate = acceptanceGateActions;
  const allSettledUpdates = registerAllSettledConsumers(state);
  if (allSettledUpdates.length) refreshSummary.all_settled_updates = allSettledUpdates;
  const promotedDispatchFailures = promoteLegacyDispatchFailureBlocks(state);
  if (promotedDispatchFailures.length) refreshSummary.promoted_dispatch_failures = promotedDispatchFailures;
  const releasedDependencyBlocks = releaseResolvedDependencyBlocks(state, byId);
  if (releasedDependencyBlocks.length) refreshSummary.released_dependency_blocks = releasedDependencyBlocks;
  for (const node of (Array.isArray(state.nodes) ? state.nodes : [])) {
    if (!isRecord(node) || node.state !== "pending") continue;
    const badDep = blockedByFailedDependency(node, byId);
    if (badDep) {
      setNodeState(state, node, "blocked", {
        eventType: "agent_settled",
        businessState: "blocked",
        blocked_by: badDep,
        failure_fuse: true,
      });
      node.blocked_by = badDep;
      node.failure_fuse = { status: "tripped", blocked_by: badDep };
      setFailureFuse(state, {
        nodeIdValue: pyStr(node.id || ""),
        reason: "failed_dependency",
        blocker: badDep,
      });
    }
  }

  const submitted = [];
  const skipped = [];
  const activeScopes = activeWriteScopes(state);
  const activeResources = activeResourceLocks(state);
  let submittedThisTick = 0;
  const [layers] = topologicalLayers(Object.values(manifestById));
  const orderedIds = layers.flat();
  const readyIds = rebuildReadyQueue(state, Object.values(manifestById));
  const readySet = new Set(readyIds);
  for (const nid of orderedIds) {
    const node = byId[nid];
    if (!node || node.state !== "pending") continue;
    if (!readySet.has(nid)) skipped.push({ node_id: nid, reason: "waiting_for_dependencies" });
  }
  const queueWorking = [...readyIds];
  if (!dryRun && state.resume_pending && existsSync(pauseRequestPath(resolvedRoot, runId))) {
    const resumeInfo = resumePausedTasks(state, readPauseIntent(resolvedRoot, runId));
    state.resume_status = resumeInfo;
    if (!resumeInfo.pending_task_ids.length) {
      rmSync(pauseRequestPath(resolvedRoot, runId), { force: true });
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
  if (existsSync(pauseRequestPath(resolvedRoot, runId))) {
    // run级停派：意图文件在锁内重新读取，pending 节点保持原图与依赖，不标 cancelled/not_executed。
    const intent = readPauseIntent(resolvedRoot, runId);
    const receipt = dryRun
      ? { run_id: runId, accepted: true, state: "pausing", reason: "dry_run", paused_task_ids: [], pending_task_ids: [] }
      : state.resume_pending
        ? { run_id: runId, accepted: true, state: "pausing", reason: "resume_pending", ...state.resume_status, next_step: RESUME_SEAM_NEXT_STEP }
        : settlePause(state, { reason: intent?.reason ?? null });
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
    appendFleetEvent(state, "run_pause", null, {
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
    if (existsSync(cancellationPath(resolvedRoot, runId)) || existsSync(pauseRequestPath(resolvedRoot, runId))) break;
    const node = byId[nid];
    if (!node || node.state !== "pending") continue;
    const resourceOwner = resourceLocked(node, activeResources);
    if (resourceOwner) {
      skipped.push({ node_id: nid, reason: `resource_locked_by:${resourceOwner}` });
      continue;
    }
    const lockedBy = writeLocked(node, activeScopes);
    if (lockedBy) {
      skipped.push({ node_id: nid, reason: `write_locked_by:${lockedBy}` });
      continue;
    }
    const [ok, reason] = budgetAllows(node, state, submittedThisTick);
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
    if (enrichTerminalRouteFromRuntime(node)) {
      const nodeIdValue = pyStr(node.id || "");
      routeProvenanceUpdates.push(nodeIdValue);
      appendFleetEvent(state, "route_provenance", node, {
        incrementNodeRevision: false,
        source: "terminal_runtime_artifacts",
        route: routeSnapshot(node),
      });
    }
  }
  if (routeProvenanceUpdates.length) refreshSummary.route_provenance_updates = routeProvenanceUpdates;
  settleFleetIfNeeded(state);
  const compactSubmitted = submitted.map((item) => compactDispatchOutcome(item));
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
    appendFleetEvent(state, "tick", null, {
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
  const waited = waitForCompletionNotices(state, waitMs);
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
    const intent = readPauseIntent(resolvedRoot, runId);
    let resumeInfo = null;
    if (intent && dryRun) return {
      ...buildStatusSummary(before), accepted: false, state: before.run_state, reason: "dry_run", resumed: false,
    };
    if (intent && (existsSync(cancellationPath(resolvedRoot, runId)) || before.cancel_request)) return {
      ...tickRunLocked(runId, resolvedRoot, false, verbose),
      accepted: false, state: "cancelling", reason: "cancel_priority", resumed: false,
    };
    if (intent) {
      resumeInfo = resumePausedTasks(before, intent);
      if (resumeInfo.pending_task_ids.length) {
        before.run_state = "pausing";
        before.resume_pending = true;
        before.resume_status = resumeInfo;
        writeJson(statePath(resolvedRoot, runId), before);
        return {
          run_id: runId, accepted: true, resumed: false, state: "pausing", reason: "resume_pending",
          pending_task_ids: resumeInfo.pending_task_ids, errors: resumeInfo.errors,
          paused_task_ids: before.nodes.filter((node) => node.state === "paused").map((node) => node.task_id),
          next_step: RESUME_SEAM_NEXT_STEP,
        };
      }
      rmSync(pauseRequestPath(resolvedRoot, runId), { force: true });
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
      data.next_step = RESUME_SEAM_NEXT_STEP;
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

/** Python `not node.get("all_settled_consumers")`：None 与空列表都为假。 */
function truthyList(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
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

function persistDriverOutcome(root, runId, outcome, error = null) {
  runMutationLock(root, runId, () => {
    const target = statePath(root, runId);
    const state = readJson(target);
    const changed = state.run_state !== outcome || state.driver_error !== error;
    state.run_state = outcome;
    state.driver_error = error;
    if (changed) appendFleetEvent(state, "driver_status", null, {
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
          counts: stateCounts(state),
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
        writeDriverStatus(resolvedRoot, runId, { status: outcome, ticks, counts: stateCounts(state) });
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

async function launchDriverImpl(runId, root, waitMs) {
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
  if (existsSync(cancellationPath(resolvedRoot, runId)) && state.run_state === "cancelled") return { status: "cancelled", run_id: runId, started: false };
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
    SCHEDULER_CLI_PATH,
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
  const byId = indexNodes(state);
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
  const criticality = downstreamCounts(manifestNodesList);
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
  const byId = indexNodes(state);
  const activeScopes = activeWriteScopes(state);
  const ready = [];
  const blockedReady = [];
  let submittedThisTick = 0;
  for (const nid of orderedPendingIds(state, manifest)) {
    const node = byId[nid];
    if (!node) continue;
    const badDep = blockedByFailedDependency(node, byId);
    if (badDep) {
      blockedReady.push({ id: nid, reason: `blocked_dependency:${badDep}` });
      continue;
    }
    if (!dependenciesReady(node, byId)) continue;
    const lockedBy = writeLocked(node, activeScopes);
    if (lockedBy) {
      blockedReady.push({ id: nid, reason: `write_locked_by:${lockedBy}` });
      continue;
    }
    const [ok, reason] = budgetAllows(node, state, submittedThisTick);
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
    run_state: state.state_root && state.run_id && existsSync(cancellationPath(state.state_root, state.run_id))
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
function stableSortDesc(items, keyOf) {
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

export async function selfTest() {
  const { selfTest: run } = await import("../fleet_scheduler.selftest.mjs");
  return run();
}
