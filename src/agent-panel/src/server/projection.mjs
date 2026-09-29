import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { createFleetCore, projectFleetDriver } from "../../../../ops/tools/fleet-tools-core.mjs";
import { readTaskOutcome } from "../../../../ops/tools/task-outcome.mjs";
import { classifyFleetActivity } from "../web/core.mjs";

import { EXPECTED_CONTRACT_VERSION, PanelError, resolvePanelStateRoot } from "./async-core.mjs";

const TASK_ID_PATTERN = /^[A-Za-z0-9_.-]{1,120}$/;
const MAX_TASKS = 2000;
const MAX_FLEET_RUNS = 200;
const MAX_NOTIFICATIONS = 200;
const MAX_EVENTS = 200;
const CANCELLABLE_STATES = new Set(["submitted", "queued", "running", "cancel_requested", "paused"]);
// 与 core.mjs TERMINAL_TRANSPORT_STATES 及 server 终态口径同表（三堂会审 sol#5 的口径纪律）
const TERMINAL_TASK_STATES = new Set(["done", "failed", "cancelled", "completed"]);
// 与 async-core cancelTask 的合法集一致；HTTP 边界先拒，避免下游普通异常被抹成全局 503
const CANCEL_REASONS = new Set(["user_requested", "external_safety_boundary"]);

function safeJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, error: error?.code === "ENOENT" ? "missing" : "invalid_json" };
  }
}

function safeJsonLines(filePath) {
  try {
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    const values = [];
    for (const line of lines.slice(-MAX_EVENTS)) {
      try {
        values.push({ ok: true, value: JSON.parse(line) });
      } catch {
        values.push({ ok: false, error: "invalid_json" });
      }
    }
    return { ok: true, values };
  } catch (error) {
    return { ok: false, error: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
}

function listDirectories(root, limit) {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, limit)
      .map((entry) => entry.name);
  } catch {
    throw new PanelError("RUNTIME_READ_FAILED", `运行态目录不可读：${root}`);
  }
}

function listFiles(root, extension, limit) {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
      .slice(0, limit)
      .map((entry) => entry.name);
  } catch {
    throw new PanelError("RUNTIME_READ_FAILED", `运行态目录不可读：${root}`);
  }
}

function isoTimestamp(value) {
  if (!value) return 0;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : 0;
}

// 等待时长不在服务端现算：payload 每秒漂移会击穿 ETag 缓存，前端拿稳定的起点自己算。
function waitingSince(value) {
  return isoTimestamp(value) ? value : null;
}

function hasValue(value) {
  return value !== undefined
    && value !== null
    && (typeof value !== "string" || value.trim() !== "");
}

function compactError(kind) {
  return { state: "error", error_kind: kind };
}

function projectTokenUsage(raw) {
  const value = raw?.token_usage;
  if (!hasValue(value) || (typeof value === "object" && Object.keys(value).length === 0)) {
    return { state: "missing" };
  }
  return value;
}

function tokenCount(tokenUsage) {
  const value = typeof tokenUsage === "object" && tokenUsage !== null
    ? (tokenUsage.totalTokens ?? tokenUsage.total_tokens)
    : tokenUsage;
  if (!hasValue(value)) return null;
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

// 真实运行时长：终态 = finished-started（缺 finished 用 updated 兜底），运行中 = now-started。
// 不再把 now-created 的墙钟当耗时——完成多日的任务显示"22h"就是这个病（复核实测）。
function taskDurationMs(raw, transportState) {
  // 起点锚：started_at 优先；service 快照记录不带 started_at 时退 created_at（含排队，仍远优于墙钟）
  const startTs = isoTimestamp(raw?.started_at) || isoTimestamp(raw?.created_at);
  if (!startTs) return null;
  // "completed" 不在 async-core 运输态词表里，但 server.mjs 终态集合认它；两套集合必须一致（三堂会审 sol#5）
  const terminal = ["done", "failed", "cancelled", "completed"].includes(String(transportState));
  const endTs = transportState === "paused"
    ? (isoTimestamp(raw?.paused_at) || isoTimestamp(raw?.updated_at) || null)
    : terminal
      ? (isoTimestamp(raw?.finished_at) || isoTimestamp(raw?.updated_at) || null)
      : Date.now();
  if (!endTs) return null;
  return Math.max(0, endTs - startTs);
}

function projectResultRead(raw) {
  const taskDir = raw?.task_dir;
  const taskId = raw?.task_id;
  const fallbackRevision = raw?.revision ?? raw?.rev ?? null;
  if (!taskDir || !taskId) {
    return {
      result_read_state: "unknown",
      result_revision: fallbackRevision != null ? String(fallbackRevision) : null,
    };
  }
  const receipt = safeJson(path.join(taskDir, "result.json"));
  const sidecar = safeJson(path.join(taskDir, "result-read.json"));
  const value = receipt.ok && receipt.value && typeof receipt.value === "object" && !Array.isArray(receipt.value)
    ? receipt.value
    : null;
  const trackingVersion = value?.result_tracking_version != null && String(value.result_tracking_version).trim() !== ""
    ? String(value.result_tracking_version)
    : null;
  const currentVersion = trackingVersion
    ?? (value?.revision != null && String(value.revision).trim() !== "" ? String(value.revision) : null)
    ?? (fallbackRevision != null ? String(fallbackRevision) : null);
  const recorded = sidecar.ok
    && sidecar.value
    && sidecar.value.task_id === taskId
    && currentVersion != null
    && String(sidecar.value.result_revision) === String(currentVersion);
  if (recorded) {
    return { result_read_state: "read", result_revision: currentVersion };
  }
  if (trackingVersion) {
    return { result_read_state: "unread", result_revision: trackingVersion };
  }
  return {
    result_read_state: "unknown",
    result_revision: currentVersion,
  };
}

function projectTask(raw, metadata = {}) {
  const transportState = raw?.state ?? "unknown";
  const businessState = raw?.business_state ?? null;
  const tokenUsage = projectTokenUsage(raw);
  const tokens = tokenCount(tokenUsage);
  const resultRead = projectResultRead({ ...raw, task_dir: raw?.task_dir ?? metadata.task_dir });
  return {
    duration_ms: taskDurationMs(raw, transportState),
    task_id: raw?.task_id ?? null,
    revision: String(raw?.revision ?? raw?.rev ?? 0),
    batch_id: hasValue(raw?.batch_id) ? raw.batch_id : metadata.batch_id ?? null,
    slice_id: hasValue(raw?.slice_id) ? raw.slice_id : metadata.slice_id ?? null,
    run_id: hasValue(raw?.run_id) ? raw.run_id : metadata.run_id ?? null,
    display_title: raw?.display_title ?? null,
    runtime_role: raw?.runtime_role ?? null,
    model: raw?.model ?? null,
    effort: raw?.effort ?? null,
    transport_state: transportState,
    business_state: businessState,
    task_outcome: readTaskOutcome(raw, raw?.task_dir ?? metadata.task_dir),
    review_gate: raw?.requires_parent_review ? "needs_parent_review" : raw?.review_gate ?? null,
    created_at: raw?.created_at ?? null,
    started_at: raw?.started_at ?? null,
    updated_at: raw?.updated_at ?? null,
    finished_at: raw?.finished_at ?? null,
    elapsed_seconds: raw?.elapsed_seconds ?? null,
    token_usage: tokenUsage,
    token_count: tokens,
    token_state: tokenUsage.state === "missing" ? "missing" : tokens === null ? "unavailable" : "available",
    tool_call_count: raw?.tool_call_count ?? 0,
    last_tool_kind: raw?.last_tool_kind ?? null,
    progress_state: raw?.progress_state ?? null,
    requires_parent_review: Boolean(raw?.requires_parent_review),
    review_acked_at: raw?.review_acked_at ?? null,
    result_read_state: resultRead.result_read_state,
    result_revision: resultRead.result_revision,
    failure_type: raw?.failure_type === "none" ? null : raw?.failure_type ?? null,
    cancel_reason: raw?.cancel_reason ?? null,
    report_path: raw?.report_path ?? raw?.report ?? null,
    handoff_path: raw?.handoff_path ?? raw?.handoff ?? null,
    completion_notice_path: raw?.completion_notice_path ?? null,
    task_dir: raw?.task_dir ?? null,
    target_cwd: raw?.target_cwd ?? metadata.target_cwd ?? null,
    origin_thread_id: raw?.origin_thread_id ?? metadata.origin_thread_id ?? null,
    project_path: raw?.project_path ?? metadata.project_path ?? null,
    failure_summary: raw?.failure_summary ?? null,
    error: raw?.error ?? null,
    can_cancel: CANCELLABLE_STATES.has(String(transportState)),
  };
}

function projectDiagnostic(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    revision: String(raw.revision ?? raw.rev ?? 0),
    transport_state: raw.state ?? null,
    business_state: raw.business_state ?? null,
    contract_state: raw.contract_state ?? null,
    review_gate: raw.review_gate ?? null,
    failure_summary: raw.failure_summary ?? null,
    process_alive: raw.process_alive ?? null,
    progress: raw.progress ?? null,
    failure_type: raw.failure_type ?? null,
    turn_status: raw.turn_status ?? null,
  };
}

function projectEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { event_state: "invalid" };
  }
  const result = {};
  for (const key of [
    "at", "timestamp", "type", "kind", "event", "status", "state", "task_id",
    "run_id", "batch_id", "slice_id", "node_id", "tool_kind", "revision", "fleet_revision",
    "business_state", "cursor", "path",
  ]) {
    if (value[key] !== undefined && value[key] !== null) result[key] = value[key];
  }
  return result;
}

function projectNode(value, runId, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { node_id: null, run_id: runId, state: "error", error_kind: "invalid_node" };
  }
  const nodeId = value.id ?? value.node_id ?? value.task_id ?? null;
  const nodeState = value.state ?? value.status ?? null;
  if (!hasValue(nodeId) || !hasValue(nodeState)) {
    return {
      node_id: hasValue(nodeId) ? nodeId : null,
      run_id: runId,
      task_id: value.task_id ?? null,
      state: "error",
      error_kind: "node_fields_missing",
      depends_on: Array.isArray(value.depends_on) ? value.depends_on : [],
    };
  }
  const review = value.review && typeof value.review === "object" ? value.review : null;
  return {
    node_id: nodeId,
    run_id: runId,
    task_id: value.task_id ?? null,
    batch_id: value.batch_id ?? value.dispatch?.batch_id ?? null,
    slice_id: value.slice_id ?? value.dispatch?.slice_id ?? null,
    // 节点的人话标题：派发时 seed.title/goal 派生，旧 cockpit 有此投影，迁移时丢失后
    // 节点卡只能显示 node id 代号（DAG 可读性审查确认的缺口）
    display_title: value.display_title ?? value.dispatch?.display_title ?? null,
    role: value.role ?? null,
    state: nodeState,
    business_state: value.business_state ?? value.last_status?.business_state ?? null,
    model: value.model ?? value.dispatch?.model ?? null,
    effort: value.effort ?? value.dispatch?.effort ?? null,
    revision: Number.isInteger(Number(value.revision)) ? Number(value.revision) : 0,
    resource_locks: Array.isArray(value.resource_locks) ? value.resource_locks.map(String) : [],
    is_reducer: value.is_reducer === true,
    depends_on: Array.isArray(value.depends_on) ? value.depends_on : [],
    review_required: Boolean(value.review_required || review),
    review: review
      ? {
          reason: review.reason ?? review.error ?? null,
          decision: value.review_decision ?? review.decision ?? null,
          // 等待起点锚在复核事件自己的时间戳上；缺了才退节点 updated_at，
          // 否则节点后续刷新会冲掉「等了多久」的起点
          updated_at: review.updated_at ?? value.updated_at ?? null,
          waiting_since: waitingSince(review.updated_at ?? value.updated_at),
        }
      : null,
    updated_at: value.updated_at ?? null,
  };
}

function sameFleetRoot(left, right) {
  const norm = (value) => {
    const resolved = path.resolve(String(value)).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return norm(left) === norm(right);
}

function annotateFleetActivity(run, tasks = []) {
  if (!run || run.error_kind) return run;
  const activity = classifyFleetActivity(run, tasks);
  return {
    ...run,
    activity: activity.kind,
    activity_visible: activity.visible,
    can_end: activity.canEnd,
    dependency_blocked: activity.dependencyBlocked,
    activity_problems: activity.problems,
  };
}

function projectFleetRun(runId, state, driverStatus = null) {
  const rawNodes = Array.isArray(state?.nodes)
    ? state.nodes
    : [];
  const events = Array.isArray(state?.events) ? state.events.slice(-MAX_EVENTS).map(projectEvent) : [];
  const nodes = rawNodes.map((node, index) => projectNode(node, runId, index));
  const nodeError = nodes.some((node) => node.state === "error");
  return annotateFleetActivity({
    run_id: runId,
    driver_status: driverStatus,
    state: state?.state ?? state?.status ?? state?.run_state ?? "unknown",
    created_at: state?.created_at ?? null,
    updated_at: state?.updated_at ?? null,
    finished_at: state?.finished_at ?? null,
    revision: Number.isInteger(Number(state?.revision)) ? Number(state.revision) : 0,
    event_revision: Number.isInteger(Number(state?.event_revision)) ? Number(state.event_revision) : 0,
    cursor: `${runId}+${Number.isInteger(Number(state?.event_revision)) ? Number(state.event_revision) : 0}`,
    ready_queue: Array.isArray(state?.ready_queue) ? state.ready_queue.map(String) : [],
    failure_fuse: state?.failure_fuse && typeof state.failure_fuse === "object"
      ? state.failure_fuse
      : { status: "open", blocked_nodes: [] },
    node_count: rawNodes.length,
    section_state: nodeError ? "error" : undefined,
    nodes,
    edges: nodes.flatMap((node) => (node.depends_on || []).map((source) => ({
      run_id: runId,
      from: source,
      to: node.node_id,
    }))),
    events,
  });
}

function sectionState(items, hasError = false) {
  if (hasError) return "error";
  return items.length ? "success" : "empty";
}

function attachFleetRunIds(tasks, fleetRuns) {
  const taskRuns = new Map();
  for (const run of fleetRuns || []) {
    if (!hasValue(run?.run_id)) continue;
    for (const node of run.nodes || []) {
      if (!hasValue(node?.task_id)) continue;
      if (!taskRuns.has(node.task_id)) taskRuns.set(node.task_id, new Set());
      taskRuns.get(node.task_id).add(run.run_id);
    }
  }
  return tasks.map((task) => {
    if (hasValue(task.run_id)) return task;
    const runIds = taskRuns.get(task.task_id);
    if (!runIds || runIds.size !== 1) return task;
    return { ...task, run_id: [...runIds][0] };
  });
}

function matchesTask(task, query) {
  const state = String(query.state || "").trim();
  if (state) {
    const accepted = new Set(state.split(",").map((item) => item.trim()).filter(Boolean));
    if (!accepted.has(String(task.transport_state))) return false;
  }
  const role = String(query.role || "").trim().toLowerCase();
  if (role && String(task.runtime_role || "").toLowerCase() !== role) return false;
  const model = String(query.model || "").trim().toLowerCase();
  if (model && String(task.model || "").toLowerCase() !== model) return false;
  const keyword = String(query.keyword || query.q || "").trim().toLowerCase();
  if (keyword) {
    const haystack = [
      task.task_id, task.display_title, task.batch_id, task.slice_id,
      task.run_id, task.runtime_role, task.model,
    ].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(keyword)) return false;
  }
  const scope = String(query.scope || query.range || "all").trim().toLowerCase();
  if (["thread", "this-thread", "current-thread"].includes(scope)) {
    const threadId = String(query.thread_id || query.thread || "").trim();
    if (!threadId || task.origin_thread_id !== threadId) return false;
  }
  if (["project", "this-project", "current-project"].includes(scope)) {
    const projectPath = String(query.project_path || query.project || "").trim();
    if (!projectPath || path.resolve(task.project_path || task.target_cwd || "") !== path.resolve(projectPath)) return false;
  }
  return true;
}

export class PanelProjection {
  constructor({ paths, service, contractVersion = EXPECTED_CONTRACT_VERSION }) {
    this.paths = paths;
    this.service = service;
    this.contractVersion = contractVersion;

  }

  #withKnownStart(raw) {
    if (!raw || raw.started_at || !raw.task_id) return raw;
    const disk = raw.task_dir ? safeJson(path.join(raw.task_dir, 'status.json')) : null;
    const startedAt = disk?.ok ? disk.value?.started_at : null;
    return startedAt ? { ...raw, started_at: startedAt } : raw;
  }

  #assertAvailable() {
    if (!isDirectory(this.paths.controlRoot)) {
      throw new PanelError(
        "CONTROL_ROOT_INVALID",
        `控制仓路径不可用：${this.paths.controlRoot}`,
        { details: { path: this.paths.controlRoot } },
      );
    }
    if (!isDirectory(this.paths.runtimeRoot)) {
      throw new PanelError(
        "CONTROL_RUNTIME_UNAVAILABLE",
        `控制仓运行态不可用：${this.paths.runtimeRoot}`,
        { details: { path: this.paths.runtimeRoot } },
      );
    }
    if (!this.service) {
      throw new PanelError("PANEL_SERVICE_UNAVAILABLE", "面板服务不可用");
    }
  }

  availabilityError() {
    try {
      this.#assertAvailable();
      return null;
    } catch (error) {
      return error;
    }
  }

  #taskDirectories() {
    return listDirectories(this.paths.taskRoot, MAX_TASKS);
  }

  #fallbackTasks() {
    const tasks = [];
    let hasError = false;
    for (const taskId of this.#taskDirectories()) {
      const taskDir = path.join(this.paths.taskRoot, taskId);
      try {
        if (!TASK_ID_PATTERN.test(taskId)) throw new Error("invalid_task_id");
        const response = this.service.get({ task_ids: [taskId], task_root: this.paths.taskRoot, detail: "diagnostic" });
        const raw = response.tasks?.[0];
        tasks.push(projectTask(this.#withKnownStart({ ...raw, task_dir: taskDir })));
      } catch {
        hasError = true;
        tasks.push({ task_id: taskId, task_dir: taskDir, ...compactError("task_data_invalid") });
      }
    }
    return { tasks, hasError };
  }

  #snapshotTasks() {
    // 进度会单独写入child live；每次请求读取当前快照并重算运行耗时。
    try {
      const response = this.service.snapshot({ task_root: this.paths.taskRoot, limit: MAX_TASKS });
      const tasks = (response.tasks || []).map((task) => {
        const taskDir = task.task_dir || path.join(this.paths.taskRoot, task.task_id);
        return projectTask(this.#withKnownStart({ ...task, task_dir: taskDir }));
      });
      return { tasks, hasError: false };
    } catch (error) {
      // async-core uses JSON.parse for a single malformed task record. That is
      // a local data fault; other service failures must reach the global error
      // boundary instead of being disguised as a partial task list.
      if (!(error instanceof SyntaxError)) throw error;
      if (!this.#taskDirectories().length) throw error;
      return this.#fallbackTasks();
    }
  }

  tasks(query = {}, fleetRuns = null) {
    this.#assertAvailable();
    const { tasks, hasError } = this.#snapshotTasks();
    const runs = fleetRuns || this.fleet().runs;
    const projected = attachFleetRunIds(tasks, runs);
    const filtered = projected.filter((task) => matchesTask(task, query));
    return {
      ok: true,
      contract_version: this.contractVersion,
      section: "tasks",
      section_state: sectionState(filtered, hasError),
      partial_errors: hasError,
      tasks: filtered,
    };
  }

  snapshot(query = {}) {
    const fleet = this.fleet();
    const tasks = this.tasks(query, fleet.runs);
    fleet.runs = (fleet.runs || []).map((run) => annotateFleetActivity(run, tasks.tasks));
    const reviews = this.reviews(tasks.tasks, fleet.runs);
    // snapshot 合同不收 limit（查询闭集），通知区固定全量窗口——不留读不到值的半截透传
    const notifications = this.notifications({});
    return {
      ok: true,
      contract_version: this.contractVersion,
      connection_state: "connected",
      context: {
        project_path: this.paths.controlRoot,
        thread_id: null,
      },
      tasks,
      fleet,
      reviews,
      notifications,
    };
  }

  taskDetail(taskId) {
    this.#assertAvailable();
    if (!TASK_ID_PATTERN.test(String(taskId))) {
      throw new PanelError("TASK_ID_INVALID", "task_id 格式无效", { status: 400, scope: "local" });
    }
    let response;
    try {
      response = this.service.get({ task_ids: [taskId], task_root: this.paths.taskRoot, detail: "diagnostic" });
    } catch (error) {
      // 单条记录 JSON 损坏（SyntaxError）是局部数据故障，标错即可；其他 service
      // 故障必须冒泡到全局错误边界，不伪装成单个任务的数据问题（与 #snapshotTasks 同一原则）
      if (!(error instanceof SyntaxError)) throw error;
      return {
        ok: false,
        contract_version: this.contractVersion,
        section: "task_detail",
        section_state: "error",
        error_kind: "task_data_invalid",
        task_id: taskId,
      };
    }
    const taskDir = path.join(this.paths.taskRoot, taskId);
    // service.get 记录可能缺 enrich 字段；status.json（合法读）兜底补齐，缺了就是缺了（null），不编。
    // safeJson 返回 {ok, value} 包装，必须解包——直接摊开包装壳等于兜底从未生效（复核 F1）。
    const disk = safeJson(path.join(taskDir, "status.json"));
    const diskStatus = disk.ok ? disk.value : {};
    const serviceRaw = response.tasks?.[0] || {};
    const raw = { ...diskStatus, ...serviceRaw, task_id: taskId, task_dir: taskDir };
    const task = attachFleetRunIds(
      [projectTask(raw)],
      this.fleet().runs,
    )[0];
    const events = this.taskEvents(taskId, taskDir);
    task.events = events.events;
    return {
      ok: true,
      contract_version: this.contractVersion,
      section: "task_detail",
      section_state: "success",
      task,
      diagnostic: projectDiagnostic(raw),
      events: events.events,
      events_state: events.state,
    };
  }

  taskEvents(taskId, taskDir = path.join(this.paths.taskRoot, taskId)) {
    this.#assertAvailable();
    if (!TASK_ID_PATTERN.test(String(taskId))) {
      throw new PanelError("TASK_ID_INVALID", "task_id 格式无效", { status: 400, scope: "local" });
    }
    const result = safeJsonLines(path.join(taskDir, "child-task-events.jsonl"));
    if (!result.ok) {
      // fail-closed：文件未产生（missing）才是 empty；权限/目录占位等读取失败显式标错，
      // 不把「读不到」谎报成「没有事件」
      if (result.error === "missing") return { state: "empty", events: [] };
      return { state: "error", error_kind: "events_unreadable", events: [] };
    }
    const events = [];
    let hasError = false;
    for (const item of result.values) {
      if (!item.ok) {
        hasError = true;
        events.push({ event_state: "error", error_kind: "event_data_invalid" });
      } else {
        events.push(projectEvent(item.value));
      }
    }
    return { state: hasError ? "error" : sectionState(events), events };
  }

  fleet() {
    this.#assertAvailable();
    const runs = [];
    let hasError = false;
    for (const runId of listDirectories(this.paths.fleetRoot, MAX_FLEET_RUNS)) {
      const runDir = path.join(this.paths.fleetRoot, runId);
      const state = safeJson(path.join(runDir, "state.json"));
      if (!state.ok && state.error !== "missing") {
        hasError = true;
        runs.push({ run_id: runId, ...compactError("fleet_data_invalid") });
        continue;
      }
      runs.push(projectFleetRun(runId, state.value, projectFleetDriver({ stateRoot: this.paths.fleetRoot, runId }).driver_status));
    }
    const value = {
      ok: true,
      contract_version: this.contractVersion,
      section: "fleet",
      section_state: sectionState(runs, hasError),
      partial_errors: hasError,
      runs,
    };
    return value;
  }

  fleetDetail(runId) {
    this.#assertAvailable();
    if (!TASK_ID_PATTERN.test(String(runId))) {
      throw new PanelError("RUN_ID_INVALID", "run_id 格式无效", { status: 400, scope: "local" });
    }
    const runDir = path.join(this.paths.fleetRoot, runId);
    if (!existsSync(runDir)) {
      return { ok: false, contract_version: this.contractVersion, section_state: "empty", run_id: runId };
    }
    const state = safeJson(path.join(runDir, "state.json"));
    if (!state.ok && state.error !== "missing") {
      return { ok: false, contract_version: this.contractVersion, section_state: "error", error_kind: "fleet_data_invalid", run_id: runId };
    }
    return {
      ok: true,
      contract_version: this.contractVersion,
      section: "fleet_detail",
      section_state: "success",
      run: projectFleetRun(runId, state.value, projectFleetDriver({ stateRoot: this.paths.fleetRoot, runId }).driver_status),
    };
  }

  reviews(tasks, fleetRuns = this.fleet().runs) {
    // 未读结果与待主处置独立入队；读过结果不清除仍存在的主处置标记。
    const taskItems = tasks
      .filter((task) => task.result_read_state === "unread" || task.requires_parent_review === true)
      .map((task) => ({
        kind: "task",
        id: task.task_id,
        task_id: task.task_id,
        run_id: task.run_id,
        reason: task.requires_parent_review === true ? "needs_parent_review" : "unread_result",
        updated_at: task.updated_at,
        waiting_since: waitingSince(task.updated_at),
      }));
    // Fleet 按正式决策独立裁决；不能因普通任务 review_acked_at 或结果已读被隐藏。
    const nodeItems = fleetRuns.flatMap((run) => (run.nodes || [])
      .filter((node) => node.review_required || ["needs_parent_review", "blocked"].includes(node.state))
      // 只有终局裁决（accepted/blocked）出队；requeued 会重跑、needs_owner 是熔断态
      // 恰恰最需要 owner 处置、pending 还在等——都必须留在队列（opus 复核 F1/F2：
      // 旧判据按 state 判导致熔断节点消失、accepted 完成节点滞留）
      .filter((node) => !["accepted", "blocked"].includes(node.review?.decision))
      .map((node) => ({
        kind: "fleet_node",
        id: `${run.run_id}:${node.node_id}`,
        task_id: node.task_id,
        run_id: run.run_id,
        node_id: node.node_id,
        reason: node.review?.reason || node.state,
        updated_at: node.updated_at,
        waiting_since: node.review?.waiting_since ?? waitingSince(node.updated_at),
      })));
    const items = [...taskItems, ...nodeItems];
    return {
      ok: true,
      contract_version: this.contractVersion,
      section: "reviews",
      section_state: sectionState(items),
      read_only: true,
      items,
    };
  }

  notifications(query = {}) {
    this.#assertAvailable();
    const items = [];
    let hasError = false;
    for (const name of listFiles(this.paths.inboxRoot, ".json", MAX_NOTIFICATIONS)) {
      const result = safeJson(path.join(this.paths.inboxRoot, name));
      if (!result.ok) {
        hasError = true;
        items.push({ notification_state: "error", error_kind: "notification_data_invalid", source: name });
        continue;
      }
      const value = result.value;
      if (!value || typeof value !== "object" || !value.task_id) {
        hasError = true;
        items.push({ notification_state: "error", error_kind: "notification_data_invalid", source: name });
        continue;
      }
      items.push({
        task_id: value.task_id,
        transport_state: value.state ?? null,
        business_state: value.business_state ?? null,
        terminal: ["done", "failed", "cancelled"].includes(String(value.state)),
        revision: value.revision ?? value.status_rev ?? null,
        finished_at: value.finished_at ?? null,
        source: name,
      });
    }
    items.sort((left, right) => isoTimestamp(right.finished_at) - isoTimestamp(left.finished_at));
    return this.#notificationsEnvelope({ items, hasError }, query);
  }

  // 按本次query裁切有界通知清单。
  #notificationsEnvelope({ items, hasError }, query) {
    return {
      ok: true,
      contract_version: this.contractVersion,
      section: "notifications",
      section_state: sectionState(items, hasError),
      partial_errors: hasError,
      items: items.slice(0, Number(query.limit) > 0 ? Number(query.limit) : MAX_NOTIFICATIONS),
    };
  }

  // 历史专用投影：只回终态任务，不捎带 fleet/reviews/notifications——
  // /api/history 曾复用整份 snapshot 再附一份终态数组，响应近双倍膨胀（sol 体检实测）
  history(query = {}) {
    this.#assertAvailable();
    const { tasks, hasError } = this.#snapshotTasks();
    const projected = attachFleetRunIds(tasks, this.fleet().runs);
    const filtered = projected
      .filter((task) => matchesTask(task, query))
      .filter((task) => TERMINAL_TASK_STATES.has(String(task.transport_state))
        || TERMINAL_TASK_STATES.has(String(task.business_state)));
    return {
      ok: true,
      contract_version: this.contractVersion,
      section: "history",
      section_state: sectionState(filtered, hasError),
      partial_errors: hasError,
      history: filtered,
      history_count: filtered.length,
    };
  }

  cancel(taskId, expectedRevision, reason = "user_requested") {
    this.#assertAvailable();
    if (!TASK_ID_PATTERN.test(String(taskId))) {
      throw new PanelError("TASK_ID_INVALID", "task_id 格式无效", { status: 400, scope: "local" });
    }
    if (expectedRevision === undefined || expectedRevision === null || String(expectedRevision).trim() === "") {
      throw new PanelError("EXPECTED_REVISION_REQUIRED", "取消必须提供 expected_revision", { status: 400, scope: "local" });
    }
    if (typeof expectedRevision !== "string" && typeof expectedRevision !== "number") {
      throw new PanelError("EXPECTED_REVISION_INVALID", "expected_revision 必须是字符串或数字", { status: 400, scope: "local" });
    }
    if (typeof reason !== "string" || !CANCEL_REASONS.has(reason)) {
      throw new PanelError("CANCEL_REASON_INVALID", `取消原因不在允许集内（${[...CANCEL_REASONS].join(" / ")}）`, { status: 400, scope: "local" });
    }
    return this.service.cancel({
      task_root: this.paths.taskRoot,
      task_id: taskId,
      expected_revision: String(expectedRevision),
      reason,
    });
  }

  ackReview(taskId, expectedRevision, note) {
    this.#assertAvailable();
    if (!TASK_ID_PATTERN.test(String(taskId))) {
      throw new PanelError("TASK_ID_INVALID", "task_id 格式无效", { status: 400, scope: "local" });
    }
    if (expectedRevision !== undefined && expectedRevision !== null
      && typeof expectedRevision !== "string" && typeof expectedRevision !== "number") {
      throw new PanelError("EXPECTED_REVISION_INVALID", "expected_revision 必须是字符串或数字", { status: 400, scope: "local" });
    }
    if (note !== undefined && note !== null && typeof note !== "string") {
      throw new PanelError("NOTE_INVALID", "note 必须是字符串", { status: 400, scope: "local" });
    }
    // expected_revision 可选：销账幂等且只作用于终态任务，竞态最坏结果是 already_acked
    return this.service.ackReview({
      task_id: taskId,
      ...(expectedRevision ? { expected_revision: String(expectedRevision) } : {}),
      ...(note ? { note: String(note) } : {}),
      task_root: this.paths.taskRoot,
    });
  }

  // 结束指定 Fleet：只调用既有 fleet_cancel，不另写状态机，不删 state、失败记录或任务报告。
  // run_id 只作为当前监控项目 fleet 目录下的名字；不接受调用方传入的路径或命令。
  async endFleet(runId, reason = "user_requested") {
    this.#assertAvailable();
    if (!TASK_ID_PATTERN.test(String(runId))) {
      throw new PanelError("RUN_ID_INVALID", "run_id 格式无效", { status: 400, scope: "local" });
    }
    if (typeof reason !== "string" || !CANCEL_REASONS.has(reason)) {
      throw new PanelError("CANCEL_REASON_INVALID", `结束原因不在允许集内（${[...CANCEL_REASONS].join(" / ")}）`, { status: 400, scope: "local" });
    }
    const runDir = path.join(this.paths.fleetRoot, String(runId));
    assertRuntimePathInside(this.paths.fleetRoot, runDir);
    const stateFile = path.join(runDir, "state.json");
    if (!existsSync(stateFile)) {
      throw new PanelError("FLEET_RUN_NOT_FOUND", "指定运行不在当前监控项目中", { status: 404, scope: "local" });
    }
    const parsed = safeJson(stateFile);
    if (!parsed.ok) {
      throw new PanelError("FLEET_DATA_INVALID", "运行状态不可读，未执行结束", { status: 422, scope: "local" });
    }
    const declaredRoot = parsed.value?.state_root;
    if (typeof declaredRoot !== "string" || !declaredRoot.trim() || !sameFleetRoot(declaredRoot, this.paths.fleetRoot)) {
      throw new PanelError("FLEET_RUN_ROOT_MISMATCH", "运行状态根必须是当前监控项目的 fleet 目录", { status: 422, scope: "local" });
    }
    const env = { ...(this.fleetCancelEnv || process.env) };
    const fleet = createFleetCore({
      projectRoot: this.paths.controlRoot,
      env,
      ...(this.fleetCancelTimeoutMs ? { timeoutMs: this.fleetCancelTimeoutMs } : {}),
    });
    const result = await fleet.fleet_cancel({ run_id: String(runId), reason });
    if (!result?.ok) {
      const message = String(result?.error?.message || "fleet_cancel 失败").slice(0, 500);
      throw new PanelError("FLEET_END_FAILED", message, {
        status: result?.error?.kind === "invalid_input" ? 400 : 422,
        scope: "local",
        details: {
          kind: result?.error?.kind || "scheduler_failed",
          exit_code: result?.error?.exit_code ?? null,
        },
      });
    }
    const status = String(result.status || "");
    const confirmed = status === "cancelled";
    // fleet_cancel 回执是紧凑 status：活跃节点在 summary.active，取消错误在 summary.cancellation。
    const summary = result.summary || {};
    return {
      accepted: true,
      status: confirmed ? "cancelled" : (status || "cancelling"),
      confirmed,
      reason: summary.cancellation?.reason ?? null,
      active: Array.isArray(summary.active) ? summary.active.map((node) => String(node.node_id)) : [],
      errors: Array.isArray(summary.cancellation?.errors) ? summary.cancellation.errors.slice(0, 20).map(String) : [],
    };
  }
}

// 面板运行产物落在用户级面板状态目录（AGENT_PANEL_STATE_ROOT，默认 ~/.subagent-control/agent-panel），
// 不依赖生产者仓或消费项目目录；控制仓不可用时也要能留下诊断。日志写入失败由 writeSafeLog 静默降级。
export function ensurePanelLogDirectory(stateRoot = "") {
  const logRoot = path.join(resolvePanelStateRoot(stateRoot), "logs");
  mkdirSync(logRoot, { recursive: true });
  return logRoot;
}

export function assertRuntimePathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PanelError("RUNTIME_PATH_ESCAPE", "运行态路径越界");
  }
  return candidate;
}

export function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
