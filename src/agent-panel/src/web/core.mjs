const UNKNOWN = 'unknown';

export const FILTER_DEFAULTS = Object.freeze({
  status: 'all',
  role: 'all',
  model: 'all',
  scope: 'all'
});

export const STATE_LABELS = Object.freeze({
  loading: '加载中',
  empty: '暂无数据',
  error: '局部错误',
  success: '已同步',
  disabled: '不可用',
  running: '运行中',
  paused: '已暂停',
  queued: '排队中',
  waiting: '等待中',
  blocked: '已阻断',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  needs_parent_review: '待复核',
  done: '完成',
  submitted: '已提交',
  completed_with_uncertainty: '有保留项',
  partial: '部分完成',
  unknown: '未知'
});

/* 运行生命周期与任务执行结果分别显示，结果不表示主代理已验收。 */
export const TRANSPORT_LABELS = Object.freeze({
  done: '已结束',
  completed: '已结束',
  failed: '异常终止'
});
export const BUSINESS_LABELS = Object.freeze({
  done: '完成',
  completed: '完成',
  // completed_with_uncertainty 是子任务结果归一态：只表示有保留项，不代表已验收或未读取
  completed_with_uncertainty: '有保留项',
  partial: '部分完成',
  failed: '失败'
});

/* 历史页结果筛选：固定中文业务分组，done/completed 合并为一组不重复展示；
   运输态（done/failed 等传输层语义）不进筛选，留在详情。completed_with_* 前缀
   一律归「有保留项」（对齐 runtime classifyBusinessState 归一口径）。 */
export const HISTORY_STATUS_GROUPS = Object.freeze([
  { key: 'done', label: '完成' },
  { key: 'uncertain', label: '有保留项' },
  { key: 'partial', label: '部分完成' },
  { key: 'failed', label: '失败' },
  { key: 'blocked', label: '受阻' },
  { key: 'cancelled', label: '已取消' },
  { key: 'unknown', label: '未知' }
]);

export function historyStatusGroup(task) {
  const business = text(task?.businessState, UNKNOWN).toLowerCase();
  if (business === 'done' || business === 'completed') return 'done';
  if (business.startsWith('completed_with')) return 'uncertain';
  if (business === 'partial') return 'partial';
  if (business === 'failed') return 'failed';
  if (business === 'blocked' || business === 'needs_parent_review') return 'blocked';
  if (business === 'cancelled') return 'cancelled';
  return 'unknown';
}

const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/* 活动性是运输层概念：排除已停止的 paused 与终态。业务态是裁决结果，只在终态有意义，
   拿它数活动会让「运行中（业务未裁决=in_progress/unknown）」的任务被数成 0 活动；
   normalizeSnapshot / normalizeRun / groupTasksByRun 共用同一终态表，口径不漂。 */
const TERMINAL_TRANSPORT_STATES = Object.freeze(['done', 'failed', 'cancelled', 'completed']);
const isActiveTransport = (state) => state !== 'paused' && !TERMINAL_TRANSPORT_STATES.includes(state);
const asArray = (value) => Array.isArray(value) ? value : [];
const arrayValue = (...values) => values.find((value) => Array.isArray(value)) || [];
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');
const text = (value, fallback = '') => value === undefined || value === null ? fallback : String(value);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function readState(raw, names, fallback = UNKNOWN) {
  return text(first(...names.map((name) => raw[name])), fallback).toLowerCase();
}

function readTaskId(raw, index) {
  const value = first(raw.task_id, raw.taskId, raw.id);
  return value === undefined ? `malformed-${index + 1}` : text(value);
}

// 服务端只发等待起点（waiting_since）；毫秒差在客户端渲染时点算，服务端 payload 保持稳定可缓存。
function waitMsSince(value) {
  const at = Date.parse(value || '');
  return Number.isFinite(at) ? Math.max(0, Date.now() - at) : undefined;
}

export function normalizeTask(input, index = 0) {
  const raw = asObject(input);
  const taskId = readTaskId(raw, index);
  const malformed = !input || typeof input !== 'object' || Array.isArray(input) || taskId.startsWith('malformed-');
  const artifacts = asObject(first(raw.artifacts, raw.outputs));
  const latestTool = first(raw.last_tool_kind, raw.recent_tool, raw.recentTool, raw.last_tool, raw.lastTool);
  const revision = first(raw.revision, raw.expected_revision, raw.expectedRevision);
  const waitingSeconds = first(raw.waiting_seconds, raw.waitingSeconds);
  const waitingSinceMs = waitMsSince(first(raw.waiting_since, raw.waitingSince));
  const tokenUsage = asObject(raw.token_usage);
  const elapsedSeconds = first(raw.elapsed_seconds, raw.elapsedSeconds);

  return {
    taskId,
    title: text(first(raw.display_title, raw.displayTitle, raw.title, raw.name, raw.task_name, raw.taskName), malformed ? '任务数据异常' : '未命名任务'),
    role: text(first(raw.runtime_role, raw.runtimeRole, raw.role, raw.agent_role, raw.agentRole), '未标注'),
    model: text(first(raw.model, raw.model_name, raw.modelName), '未标注'),
    effort: text(first(raw.effort, raw.reasoning_effort), '—'),
    transportState: readState(raw, ['transport_state', 'transportState', 'transport'], malformed ? 'error' : UNKNOWN),
    businessState: readState(raw, ['business_state', 'businessState', 'status', 'state'], malformed ? 'error' : UNKNOWN),
    taskOutcome: raw.task_outcome ?? raw.taskOutcome ?? null,
    startedAt: text(first(raw.started_at, raw.startedAt), ''),
    finishedAt: text(first(raw.finished_at, raw.finishedAt), ''),
    durationMs: number(first(raw.duration_ms, raw.durationMs, raw.elapsed_ms, raw.elapsedMs, elapsedSeconds === undefined ? undefined : Number(elapsedSeconds) * 1000), null),
    tokenCount: number(first(raw.token_count, raw.tokenCount, raw.tokens, raw.total_tokens, tokenUsage.totalTokens, tokenUsage.total_tokens), null),
    runId: text(first(raw.run_id, raw.runId), 'unassigned'),
    batchId: text(first(raw.batch_id, raw.batchId), 'scatter'),
    sliceId: text(first(raw.slice_id, raw.sliceId), '—'),
    scope: text(first(raw.scope, raw.scope_name), 'all').toLowerCase(),
    threadId: text(first(raw.origin_thread_id, raw.originThreadId, raw.thread_id, raw.threadId), ''),
    projectPath: text(first(raw.project_path, raw.projectPath, raw.target_cwd, raw.targetCwd), ''),
    revision: revision === undefined ? null : number(revision, null),
    reviewReason: text(first(raw.review_reason, raw.reviewReason, raw.reason, raw.failure_summary, raw.failureSummary, raw.failure_type === 'none' ? null : raw.failure_type, raw.failureType === 'none' ? null : raw.failureType), ''),
    waitMs: number(first(raw.wait_ms, raw.waitMs, raw.waiting_ms, raw.waitingMs, waitingSinceMs, waitingSeconds === undefined ? undefined : Number(waitingSeconds) * 1000), 0),
    canCancel: Boolean(first(raw.can_cancel, raw.canCancel, raw.cancellable, false)),
    needsReview: Boolean(first(raw.requires_parent_review, raw.requiresParentReview, false)) || text(first(raw.review_gate, raw.reviewGate), '') === 'needs_parent_review',
    artifacts: {
      report: text(first(artifacts.report, artifacts.report_path, raw.report_path, raw.reportPath), ''),
      handoff: text(first(artifacts.handoff, artifacts.handoff_path, raw.handoff_path, raw.handoffPath), '')
    },
    toolsCount: number(first(raw.tool_call_count, raw.toolCallCount, raw.tools_count, raw.toolsCount, raw.tool_count), 0),
    recentTool: latestTool ? text(latestTool) : '—',
    updatedAt: text(first(raw.updated_at, raw.updatedAt, raw.finished_at, raw.finishedAt, raw.timestamp), '—'),
    events: asArray(first(raw.events, raw.event_log)).map((event) => normalizeEvent(event)),
    localError: malformed ? '单任务数据结构无法解析，其他区域继续展示。' : text(first(raw.local_error, raw.localError), '')
  };
}

export function normalizeEvent(input) {
  const raw = asObject(input);
  return {
    type: text(first(raw.type, raw.event_type, raw.eventType), 'event'),
    at: text(first(raw.at, raw.timestamp, raw.time), '—'),
    message: text(first(raw.message, raw.summary, raw.label), '未提供事件摘要')
  };
}

export function normalizeSnapshot(input) {
  const root = asObject(input);
  const nested = asObject(first(root.snapshot, root.data));
  const taskSection = asObject(root.tasks);
  const nestedTaskSection = asObject(nested.tasks);
  const historySection = asObject(root.history);
  const nestedHistorySection = asObject(nested.history);
  const fleetSection = asObject(first(root.fleet, nested.fleet));
  const rawTasks = Array.isArray(input)
    ? input
    : arrayValue(
      root.tasks,
      taskSection.tasks,
      taskSection.items,
      root.items,
      nested.tasks,
      nestedTaskSection.tasks,
      nestedTaskSection.items,
      nested.items,
      root.history,
      historySection.tasks,
      historySection.items,
      nested.history,
      nestedHistorySection.tasks,
      nestedHistorySection.items
    );
  const tasks = rawTasks.map((task, index) => normalizeTask(task, index));
  const rawSummary = asObject(first(root.summary, taskSection.summary, nested.summary, nestedTaskSection.summary));
  const taskTokens = tasks.every((task) => task.tokenCount !== null)
    ? tasks.reduce((sum, task) => sum + task.tokenCount, 0)
    : null;
  const rawRuns = arrayValue(root.runs, taskSection.runs, fleetSection.runs, root.fleet, nested.runs, nestedTaskSection.runs, nestedFleetRuns(nested));

  return {
    tasks,
    runs: asArray(rawRuns).map((run) => normalizeRun(run)),
    fleet: first(root.fleet, nested.fleet, null),
    context: asObject(first(root.context, nested.context)),
    summary: {
      running: number(first(rawSummary.running, rawSummary.active, tasks.filter((task) => isActiveTransport(task.transportState)).length), 0),
      review: number(first(rawSummary.review, rawSummary.needs_parent_review, tasks.filter((task) => task.businessState === 'needs_parent_review').length), 0),
      tokens: number(first(rawSummary.tokens, rawSummary.token_count, taskTokens), null),
      total: number(first(rawSummary.total, rawSummary.task_count, tasks.length), tasks.length)
    }
  };
}

function nestedFleetRuns(root) {
  return asObject(root.fleet).runs;
}

export function normalizeRun(input) {
  const raw = asObject(input);
  const rawTasks = asArray(raw.tasks);
  const taskCount = first(raw.task_count, raw.taskCount, rawTasks.length ? rawTasks.length : undefined);
  const activeCount = first(raw.active_count, raw.activeCount, raw.active, rawTasks.filter((task) => isActiveTransport(readState(asObject(task), ['transport_state', 'transportState', 'transport', 'status', 'state']))).length || undefined);
  return {
    runId: text(first(raw.run_id, raw.runId, raw.id), 'unassigned'),
    label: text(first(raw.label, raw.name, raw.title), text(first(raw.run_id, raw.runId, raw.id), '未命名 run')),
    state: readState(raw, ['business_state', 'businessState', 'status', 'state'], UNKNOWN),
    taskCount: number(taskCount, 0),
    activeCount: number(activeCount, 0),
    updatedAt: text(first(raw.updated_at, raw.updatedAt, raw.finished_at, raw.finishedAt, raw.timestamp), '—')
  };
}

export function normalizeReviewQueue(input) {
  const root = asObject(input);
  const values = first(root.items, root.tasks, root.review_queue, root.reviewQueue, input);
  return asArray(values).map((item, index) => {
    const raw = asObject(item);
    const task = normalizeTask(first(raw.task, raw), index);
    const waitingSeconds = first(raw.waiting_seconds, raw.waitingSeconds);
    return {
      taskId: text(first(raw.task_id, raw.taskId, task.taskId)),
      kind: text(raw.kind, 'task'),
      linkedTaskId: text(first(raw.task_id, raw.taskId), ''),
      runId: text(first(raw.run_id, raw.runId, task.runId), 'unassigned'),
      reason: text(first(raw.reason, raw.review_reason, raw.reviewReason, task.reviewReason), '未提供原因'),
      waitMs: number(first(raw.wait_ms, raw.waitMs, raw.waiting_ms, raw.waitingMs, waitMsSince(first(raw.waiting_since, raw.waitingSince)), waitingSeconds === undefined ? undefined : Number(waitingSeconds) * 1000, task.waitMs), 0),
      task,
      readOnly: true
    };
  });
}

export function normalizeNotifications(input) {
  const root = asObject(input);
  const values = first(root.items, root.notifications, root.events, input);
  return asArray(values).map((item) => {
    const raw = asObject(item);
    const notificationState = text(first(raw.notification_state, raw.notificationState), '');
    const invalid = notificationState === 'error' || text(first(raw.error_kind, raw.errorKind), '') !== '';
    return {
      taskId: text(first(raw.task_id, raw.taskId), '—'),
      terminalState: readState(raw, ['transport_state', 'terminal_state', 'terminalState', 'status', 'state'], UNKNOWN),
      businessState: readState(raw, ['business_state', 'businessState'], UNKNOWN),
      at: text(first(raw.at, raw.timestamp, raw.time, raw.finished_at, raw.finishedAt, raw.updated_at, raw.updatedAt), '—'),
      summary: invalid
        ? `通知数据损坏（${text(first(raw.error_kind, raw.errorKind), 'notification_data_invalid')}），不猜补内容`
        : text(first(raw.summary, raw.message, raw.title), `任务 …${text(first(raw.task_id, raw.taskId), '').slice(-8) || '未知'} ${stateLabel(readState(raw, ['transport_state', 'terminal_state', 'terminalState', 'status', 'state'], UNKNOWN), 'transport')}`),
      invalid
    };
  });
}

export function normalizeFleet(input, runId = '') {
  const root = asObject(input);
  const run = asObject(first(root.run, null));
  const nested = asObject(first(root.fleet, root.data));
  const runValues = arrayValue(root.runs, nested.runs);
  const selectedRun = Object.keys(run).length ? run : asObject(runValues.find((item) => text(first(item?.run_id, item?.runId, item?.id)) === runId) || runValues[0]);
  const rawNodes = arrayValue(selectedRun.nodes, root.nodes, nested.nodes, root.tasks, nested.tasks, selectedRun.tasks);
  let nodeError = '';
  const nodes = rawNodes.map((node, index) => {
    const raw = asObject(node);
    const nodeId = first(raw.node_id, raw.nodeId, raw.id);
    const nodeState = first(raw.state, raw.status, raw.business_state, raw.businessState);
    if (nodeId === undefined || nodeState === undefined || text(nodeState) === '') {
      nodeError = `Fleet 节点缺少身份或状态字段（第 ${index + 1} 个），本区域按错误处理，不猜补。`;
    }
    return {
      nodeId: text(nodeId, `缺失-${index + 1}`),
      label: text(first(raw.label, raw.name, raw.title, raw.node_id, raw.nodeId, raw.id), `节点 ${index + 1}`),
      // 人话标题与代号分离：title 供阅读，nodeId/label 供定位；无 title 的节点回退代号
      title: text(first(raw.display_title, raw.displayTitle), ''),
      // Fleet progress follows the scheduler's node state; business outcome is separate.
      state: readState(raw, ['state', 'status', 'business_state', 'businessState'], 'error').replace(/^completed$/, 'done'),
      businessState: text(first(raw.business_state, raw.businessState), ''),
      kind: text(first(raw.kind, raw.type), 'task'),
      taskId: text(first(raw.task_id, raw.taskId), ''),
      errorKind: text(first(raw.error_kind, raw.errorKind), '')
    };
  });
  return {
    runId: text(first(selectedRun.run_id, selectedRun.runId, root.run_id, root.runId, nested.run_id, nested.runId, runId), runId || 'unassigned'),
    nodes,
    edges: arrayValue(selectedRun.edges, root.edges, nested.edges)
      .map((edge) => {
        const rawEdge = asObject(edge);
        return {
          from: text(first(rawEdge.from, rawEdge.source, rawEdge.source_id, rawEdge.sourceId)),
          to: text(first(rawEdge.to, rawEdge.target, rawEdge.target_id, rawEdge.targetId))
        };
      })
      .filter((edge) => edge.from !== '' && edge.to !== ''),
    events: arrayValue(selectedRun.events, root.events, root.event_log, nested.events, nested.event_log, selectedRun.event_log).map((event) => normalizeEvent(event)),
    error: nodeError || text(first(root.error_kind, root.errorKind), '')
  };
}

const FLEET_TERMINAL_NODE_STATES = new Set(['done', 'failed', 'cancelled', 'blocked', 'needs_parent_review']);
const FLEET_INFLIGHT_NODE_STATES = new Set(['submitted', 'queued', 'running', 'dispatched', 'cancel_requested']);
const FLEET_STATUS_LABELS = Object.freeze({
  running: '运行中',
  cancelling: '结束中',
  pending: '待处理',
  terminal: '已结束'
});

function fleetNodeId(node) {
  return String(node?.node_id || node?.nodeId || node?.id || '');
}

function fleetTaskTransport(task) {
  return String(task?.transportState || task?.transport_state || '');
}

// 活动区只收真实执行或尚未确认的结束。依赖受阻的 pending、无活动任务的待派节点
// 不算运行中；也不把这些 pending 改判成失败或按超时清掉。任务运输态优先于节点自报。
export function classifyFleetActivity(run, tasks = []) {
  if (!run || typeof run !== 'object' || run.error_kind || run.errorKind) {
    return {
      kind: 'terminal', visible: 'history', problems: [], canEnd: false, dependencyBlocked: false
    };
  }
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const taskById = new Map();
  for (const task of tasks || []) {
    const id = task?.taskId || task?.task_id;
    if (id) taskById.set(String(id), task);
  }
  const driver = String(run.driver_status || run.driverStatus || '');
  const runState = String(run.state || run.run_state || run.runState || '');
  const ready = new Set((Array.isArray(run.ready_queue) ? run.ready_queue : []).map((item) => String(item)));
  const problems = [];
  let executing = false;
  let cancelling = runState === 'cancelling' || driver === 'cancelling';
  let unresolved = false;
  const byId = new Map(nodes.map((node) => [fleetNodeId(node), node]));

  for (const node of nodes) {
    const state = String(node?.state || '');
    const nodeId = fleetNodeId(node);
    const task = node?.task_id || node?.taskId ? taskById.get(String(node.task_id || node.taskId)) : null;
    const transport = fleetTaskTransport(task);
    const taskTerminal = Boolean(task) && TERMINAL_TRANSPORT_STATES.includes(transport);
    const taskLive = Boolean(task) && transport !== '' && transport !== 'paused' && !taskTerminal;
    if (['needs_parent_review', 'failed', 'blocked'].includes(state) || node?.error_kind || node?.errorKind) {
      problems.push({ node_id: nodeId, state: state || String(node.error_kind || node.errorKind || '') });
    }
    if (state === 'cancel_requested' || transport === 'cancel_requested') cancelling = true;
    if (taskLive) {
      executing = true;
      continue;
    }
    if (taskTerminal) continue;
    if (FLEET_INFLIGHT_NODE_STATES.has(state)) {
      executing = true;
      continue;
    }
    if (state === 'ready' && (driver === 'running' || driver === 'ready') && ready.has(nodeId)) {
      executing = true;
      continue;
    }
    if (state && !FLEET_TERMINAL_NODE_STATES.has(state)) unresolved = true;
  }

  if (!executing && ready.size > 0 && (driver === 'running' || driver === 'ready')) executing = true;

  const dependencyBlocked = nodes.some((node) => {
    if (String(node?.state || '') !== 'pending') return false;
    const deps = Array.isArray(node.depends_on) ? node.depends_on : (Array.isArray(node?.dependsOn) ? node.dependsOn : []);
    if (!deps.length) return false;
    return deps.some((depId) => {
      const dep = byId.get(String(depId));
      if (!dep) return true;
      return ['failed', 'cancelled', 'blocked', 'needs_parent_review'].includes(String(dep.state || ''));
    });
  });

  if (cancelling && (executing || unresolved || runState === 'cancelling' || driver === 'cancelling')) {
    return { kind: 'cancelling', visible: 'activity', problems, canEnd: true, dependencyBlocked };
  }
  if (executing) {
    return { kind: 'running', visible: 'activity', problems, canEnd: true, dependencyBlocked };
  }
  if (unresolved || (runState !== 'cancelled' && nodes.some((node) => node.state === 'needs_parent_review'))) {
    return { kind: 'pending', visible: 'pending', problems, canEnd: true, dependencyBlocked };
  }
  return { kind: 'terminal', visible: 'history', problems, canEnd: false, dependencyBlocked: false };
}

export function fleetEndControl(run, tasks = []) {
  const activity = classifyFleetActivity(run, tasks);
  const runId = String(run?.run_id || run?.runId || '');
  return {
    ...activity,
    runId,
    statusLabel: FLEET_STATUS_LABELS[activity.kind] || FLEET_STATUS_LABELS.terminal,
    buttonLabel: activity.canEnd ? '结束运行' : '',
    confirmTitle: '确认结束这个运行？',
    confirmCopy: `运行 ${runId} 将停止后续派发并取消活跃任务。历史事件、失败记录和任务报告会保留。取消未确认前，运行仍保持可见。`,
    problemText: activity.problems.length ? '含待审或失败节点，问题保持可见，不会因结束请求被隐藏。' : ''
  };
}

export function deriveRegionState({ loading = false, error = '', disabled = false, items = [] } = {}) {
  if (disabled) return 'disabled';
  if (loading) return 'loading';
  if (error) return 'error';
  if (!items || items.length === 0) return 'empty';
  return 'success';
}

export function scopeMatches(task, scope, context = {}) {
  if (scope === 'all' || !scope) return true;
  if (task.scope === scope) return true;
  if (scope === 'thread' && context.threadId && task.threadId === context.threadId) return true;
  if (scope === 'project' && context.projectPath && task.projectPath === context.projectPath) return true;
  return false;
}

export function taskMatchesFilters(task, filters = FILTER_DEFAULTS, context = {}) {
  const active = { ...FILTER_DEFAULTS, ...filters };
  const stateMatch = active.status === 'all' || historyStatusGroup(task) === active.status;
  const roleMatch = active.role === 'all' || task.role === active.role;
  const modelMatch = active.model === 'all' || task.model === active.model;
  return stateMatch && roleMatch && modelMatch && scopeMatches(task, active.scope, context);
}

export function filterTasks(tasks, filters = FILTER_DEFAULTS, context = {}) {
  return asArray(tasks).filter((task) => taskMatchesFilters(task, filters, context));
}

export function collectFilterOptions(tasks) {
  const values = (field) => [...new Set(asArray(tasks).map((task) => text(task[field])).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { roles: values('role'), models: values('model') };
}

export function groupTasksByRun(tasks) {
  const groups = new Map();
  for (const task of asArray(tasks)) {
    const runId = task.runId || 'unassigned';
    if (!groups.has(runId)) {
      groups.set(runId, { runId, tasks: [], batches: new Map(), scatter: [], state: UNKNOWN });
    }
    const group = groups.get(runId);
    group.tasks.push(task);
    group.state = group.state === UNKNOWN ? task.businessState : group.state;
    const batchId = task.batchId || 'scatter';
    if (batchId === 'scatter' || batchId === 'unassigned') {
      group.scatter.push(task);
      continue;
    }
    if (!group.batches.has(batchId)) group.batches.set(batchId, []);
    group.batches.get(batchId).push(task);
  }
  return [...groups.values()].map((group) => {
    const activeCount = group.tasks.filter((task) => isActiveTransport(task.transportState)).length;
    const hasPaused = group.tasks.some((task) => task.transportState === 'paused');
    return {
      ...group,
      state: activeCount > 0 ? 'running' : hasPaused ? 'paused' : group.state,
      batches: [...group.batches.entries()].map(([batchId, batchTasks]) => ({ batchId, tasks: batchTasks })),
      scatter: group.scatter,
      taskCount: group.tasks.length,
      activeCount
    };
  }).sort((a, b) => b.activeCount - a.activeCount || a.runId.localeCompare(b.runId, undefined, { numeric: true }));
}

export function paginate(items, page = 1, pageSize = 6) {
  const safePageSize = Math.max(1, number(pageSize, 6));
  const totalPages = Math.max(1, Math.ceil(asArray(items).length / safePageSize));
  const safePage = Math.min(Math.max(1, number(page, 1)), totalPages);
  const start = (safePage - 1) * safePageSize;
  return { items: asArray(items).slice(start, start + safePageSize), page: safePage, pageSize: safePageSize, totalPages };
}

export function buildCancelRequest(task) {
  return {
    task_id: task.taskId,
    expected_revision: task.revision
  };
}

export function formatDuration(durationMs) {
  if (durationMs === null || durationMs === undefined) return '未记录';
  const seconds = Math.max(0, Math.floor(number(durationMs, 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remaining).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatTokens(tokenCount) {
  if (tokenCount === null || tokenCount === undefined) return '—';
  const count = Math.max(0, number(tokenCount, 0));
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}m`;
}

export function stateLabel(state, kind) {
  const normalized = text(state, UNKNOWN).toLowerCase();
  if (kind === 'transport' && TRANSPORT_LABELS[normalized]) return TRANSPORT_LABELS[normalized];
  if (kind === 'business' && BUSINESS_LABELS[normalized]) return BUSINESS_LABELS[normalized];
  return STATE_LABELS[normalized] || normalized.replaceAll('_', ' ');
}

export function runSummary(group) {
  return {
    runId: group.runId,
    taskCount: group.taskCount,
    activeCount: group.activeCount,
    state: group.state,
    batchCount: group.batches.length,
    scatterCount: group.scatter.length
  };
}
