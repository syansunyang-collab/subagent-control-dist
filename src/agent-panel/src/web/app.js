import {
  FILTER_DEFAULTS,
  STATE_LABELS,
  buildCancelRequest,
  collectFilterOptions,
  deriveRegionState,
  filterTasks,
  formatDuration,
  formatTokens,
  fleetEndControl,
  normalizeFleet,
  normalizeReviewQueue,
  normalizeSnapshot,
  normalizeTask,
  stateLabel
} from './core.mjs';
import { createConfigPages } from './config-pages.js';

const API = Object.freeze({
  snapshot: '/api/snapshot',
  history: '/api/history',
  task: (taskId) => `/api/tasks/${encodeURIComponent(taskId)}`,
  review: '/api/review-queue',
  cancel: (taskId) => `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
  endFleet: (runId) => `/api/fleet/${encodeURIComponent(runId)}/end`,
  projects: '/api/projects',
  monitorRoot: '/api/monitor-root',
  session: '/api/session'
});

// 每进程令牌：server 在 index.html 注入，变更请求必须回带（loopback CSRF 防线）
let panelToken = document.querySelector('meta[name="panel-token"]')?.content || '';

const stored = (() => {
  try {
    return {
      theme: localStorage.getItem('agent-panel.theme'),
      skyMotion: localStorage.getItem('agent-panel.sky-motion'),

    };
  } catch { return {}; }
})();


const state = {
  theme: stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : (document.documentElement.dataset.theme || 'dark'),
  // 天象氛围动画默认静止：五层无限动画常驻合成实测吃掉集显 60%+，动效改为自选。
  skyMotion: stored.skyMotion === 'on' ? 'on' : 'off',
  activeView: 'activity',
  filters: { ...FILTER_DEFAULTS },
  tasks: [],
  history: [],
  historyPage: 0,
  review: [],
  summary: { running: 0, review: 0, tokens: 0, total: 0 },
  inlineFleet: null,
  // 历史页 DAG 档案：当前展开的 run
  historyDagRun: '',
  selectedTask: null,
  cancelPending: null,
  endRunPending: null,
  context: {},
  connection: { state: 'loading', message: '连接检查中', detail: '' },
  lastSuccessAt: null,
  regions: {
    tasks: { loading: true, error: '', disabled: false },
    review: { loading: true, error: '', disabled: false },
    history: { loading: true, error: '', disabled: false }
  },
  polling: null,
  fixtureMode: false,
  projects: [],
  monitorRoot: '',
  // 配置页与运行槽的差异：打开配置页时沿任务轮询刷新，同步与保存后立即更新
  sync: { status: [], open: false },
  // 渲染签名缓存：数据没变就不重绘，轮询不闪动
  renderSig: Object.create(null)
};

const ui = {};

function byId(id) {
  return document.getElementById(id);
}

function cacheUi() {
  [
    'connection-state', 'summary-strip', 'last-refresh', 'scope-summary', 'activity-count', 'history-count',
    'task-region-state', 'task-count', 'filter-status', 'filter-role', 'filter-model', 'filter-scope',
    'task-list', 'review-count', 'review-queue',
    'history-list', 'history-range', 'history-dags', 'history-dag-select', 'activity-view', 'inline-dag',
    'history-view', 'task-detail', 'detail-title', 'detail-content', 'cancel-modal', 'cancel-title', 'cancel-copy', 'toast-stack', 'pending-fleet',
    'global-blocker', 'global-blocker-copy', 'global-blocker-detail',
    'picks-view', 'res-view', 'import-view', 'models-view', 'sync-status',
    'monitor-project'
  ].forEach((id) => { ui[id] = byId(id); });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function safeId(value) {
  return encodeURIComponent(String(value ?? ''));
}

function stateClass(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

function label(value, kind) {
  return stateLabel(value, kind);
}

function scopeLabel(value) {
  return ({ all: '全部', thread: '本线程', project: '本项目' })[value] || label(value);
}

/* ── 天象徽章引擎：夜=星象（亮星/暗星/流星/空环），昼=天气（太阳/云遮日/雨云/雾）。
     同时渲染两套图形，CSS 按 data-theme 显隐；尺寸恒 22px，图形只换语义不破网格。 ── */
const STATE_GROUP = {
  done: 'ok', completed: 'ok', success: 'ok',
  running: 'run',
  waiting: 'warn', needs_parent_review: 'warn', partial: 'warn', completed_with_uncertainty: 'warn', blocked: 'warn',
  failed: 'err', error: 'err',
  queued: 'mute', submitted: 'mute', cancelled: 'mute', unknown: 'mute',
  paused: 'warn',
};
const GLYPH_NIGHT = {
  ok: '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 0 7.3 4.7 12 6 7.3 7.3 6 12 4.7 7.3 0 6 4.7 4.7Z"/></svg>',
  warn: '<svg viewBox="0 0 12 12" fill="currentColor" opacity="0.85"><path d="M6 0 7.3 4.7 12 6 7.3 7.3 6 12 4.7 7.3 0 6 4.7 4.7Z"/></svg>',
  run: '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 0 7.3 4.7 12 6 7.3 7.3 6 12 4.7 7.3 0 6 4.7 4.7Z"/></svg>',
  err: '<svg viewBox="0 0 12 12" fill="none"><path d="M10.5 1.5 4 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="3.2" cy="8.8" r="2" fill="currentColor"/></svg>',
  mute: '<svg viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.2" stroke="currentColor" stroke-width="1.4" opacity="0.7"/></svg>'
};
// 状态语义色走 CSS 变量（内联 SVG 吃得到），改主题色板时图形跟随；云体/雾体的插画灰白无令牌，保持字面值
const GLYPH_DAY = {
  ok: '<svg viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="3" fill="var(--gold, #F2A93D)"/><g stroke="var(--gold, #F2A93D)" stroke-width="1.3" stroke-linecap="round"><path d="M7 1v1.4M7 11.6V13M1 7h1.4M11.6 7H13M2.9 2.9l1 1M10.1 10.1l1 1M11.1 2.9l-1 1M3.9 10.1l-1 1"/></g></svg>',
  warn: '<svg viewBox="0 0 14 14" fill="none"><circle cx="5.2" cy="5.4" r="2.6" fill="var(--gold, #F2A93D)"/><path d="M4.4 11.4h5.8a2.3 2.3 0 0 0 .4-4.57 3.2 3.2 0 0 0-6.2-.63 2.6 2.6 0 0 0 0 5.2Z" fill="#FFFDF8" stroke="#B99B55" stroke-width="0.9"/></svg>',
  run: '<svg viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.8"><path d="M7 1v1.4M7 11.6V13M1 7h1.4M11.6 7H13"/></g></svg>',
  err: '<svg viewBox="0 0 14 14" fill="none"><path d="M3.4 8.4h6.8a2.2 2.2 0 0 0 .4-4.36 3.4 3.4 0 0 0-6.6-.67 2.5 2.5 0 0 0-.6 5.03Z" fill="#D9CDBA" stroke="#A98F78" stroke-width="0.9"/><path d="M4.6 10.2 3.9 12M7.2 10.2l-.7 1.8M9.8 10.2l-.7 1.8" stroke="var(--err, #C25F52)" stroke-width="1.3" stroke-linecap="round"/></svg>',
  mute: '<svg viewBox="0 0 14 14" fill="none"><path d="M2 6h10M3.4 9h7.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.7"/></svg>'
};

function badgeGlyphs(group) {
  return `<span class="badge-glyph g-night" aria-hidden="true">${GLYPH_NIGHT[group]}</span><span class="badge-glyph g-day" aria-hidden="true">${GLYPH_DAY[group]}</span>`;
}

function stateGroup(value) {
  return STATE_GROUP[stateClass(value)] || 'mute';
}

function badge(kind, value) {
  const normalized = stateClass(value);
  const group = stateGroup(value);
  const baseClass = kind === 'tag' ? 'tag' : `${kind}-badge`;
  const dimension = kind === 'transport' ? '运行状态' : kind === 'business' ? '业务结果' : '';
  const title = dimension ? `${dimension}：${value}` : value;
  return `<span class="${baseClass} ${kind}-${normalized} b-state-${group}" title="${escapeHtml(title)}">${badgeGlyphs(group)}${escapeHtml(label(value, kind))}</span>`;
}

function formatTime(value) {
  if (!value || value === '—') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value); // 调用侧统一 escapeHtml，这里不再预转义（防双重转义）
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC+8';
}

function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatWait(waitMs) {
  if (!Number.isFinite(Number(waitMs)) || Number(waitMs) <= 0) return '刚刚进入';
  return `等待 ${formatDuration(waitMs)}`;
}

function shortId(value) {
  const raw = String(value ?? '');
  if (!raw) return '—';
  if (raw.length <= 22) return raw;
  const tail = raw.split('-').pop();
  return `…${tail || raw.slice(-10)}`;
}

/** 渲染签名：相同则跳过 innerHTML 重绘（消灭轮询闪动与动画重触发）。 */
function sigMatch(key, signature) {
  if (state.renderSig[key] === signature) return true;
  state.renderSig[key] = signature;
  return false;
}

function invalidateSig(...keys) {
  keys.forEach((key) => { delete state.renderSig[key]; });
}

function setConnection(nextState, message, detail = '') {
  state.connection = { state: nextState, message, detail };
  ui['connection-state'].dataset.state = nextState;
  ui['connection-state'].querySelector('.connection-label').textContent = message;
  ui['global-blocker-detail'].textContent = detail || '等待下一次轮询';
}

function regionState(region, items) {
  const regionInfo = state.regions[region] || {};
  return deriveRegionState({ ...regionInfo, items });
}

function stateMarkup(kind, message = '') {
  const copy = message || STATE_LABELS[kind] || '状态不可用';
  const className = `${kind}-state`;
  return `<div class="${className}" data-state="${kind}">${escapeHtml(copy)}</div>`;
}

function updateSelect(select, values, allLabel) {
  const current = select.value || 'all';
  const signature = `${allLabel}|${values.join('|')}`;
  if (select.dataset.sig !== signature) {
    select.dataset.sig = signature;
    select.innerHTML = [`<option value="all">${escapeHtml(allLabel)}</option>`]
      .concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`))
      .join('');
  }
  select.value = values.includes(current) ? current : 'all';
}

// 筛选条挂在历史页：状态是固定中文业务分组（index.html 静态选项），角色/模型选项池取自历史任务
function renderFilters() {
  const options = collectFilterOptions(state.history);
  updateSelect(ui['filter-role'], options.roles, '全部角色');
  updateSelect(ui['filter-model'], options.models, '全部模型');
  const threadOption = ui['filter-scope'].querySelector('option[value="thread"]');
  if (threadOption) {
    const available = Boolean(state.context.threadId);
    threadOption.disabled = !available;
    threadOption.textContent = available ? '本线程' : '本线程（无线程上下文）';
  }
  ui['filter-status'].value = state.filters.status;
  ui['filter-role'].value = state.filters.role;
  ui['filter-model'].value = state.filters.model;
  ui['filter-scope'].value = state.filters.scope;
}

// 运行页只收此时此刻在跑的任务（运输态非终态，对齐旧 async-cockpit 的 view=active 语义）。
// 不设时间窗：终结即入历史；待裁决终态走侧栏「待复核」专区。时间窗方案曾被销账操作
// 击穿——ack 重写 status.json 刷新 updated_at，75 条终态任务集体回流运行页。
const TERMINAL_TRANSPORT = new Set(['done', 'failed', 'cancelled', 'completed']);
function isActivityTask(task) {
  return !TERMINAL_TRANSPORT.has(task.transportState);
}

// 运行页不设筛选：在跑的东西量级小（个位到十几），全量平铺
function visibleTasks() {
  return state.tasks.filter(isActivityTask);
}

function renderSummary() {
  const summary = state.summary;
  const signature = `${summary.running}:${summary.review}:${summary.tokens}:${summary.total}:${state.tasks.length}:${state.history.length}:${state.review.length}`;
  if (sigMatch('summary', signature)) return;
  ui['summary-strip'].innerHTML = [
    ['running', summary.running, '运行中']
  ].map(([, value, itemLabel]) => `<div class="summary-item"><span class="summary-value">${escapeHtml(value)}</span><span class="summary-label">${escapeHtml(itemLabel)}</span></div>`).join('');
  ui['history-count'].textContent = String(state.history.length);
}

function renderTaskRow(task) {
  const invalid = task.localError ? ' is-invalid' : '';
  const cancel = task.canCancel
    ? `<button type="button" class="task-row-action" data-action="cancel" data-task-id="${safeId(task.taskId)}">取消</button>`
    : '';
  const errorNote = task.localError ? `<span class="meta-error" title="${escapeHtml(task.localError)}">${escapeHtml(task.localError)}</span>` : '';
  // 最近工具与累计调用次数分开：last_tool_kind 只能证明最近用过哪个工具，
  // 没有可靠进行中事件时不声称「正在使用」，次数也不挂在工具名后面。
  const toolChip = task.recentTool !== '—'
    ? `<span class="meta-tool" title="最近使用的工具">${escapeHtml(task.recentTool)}</span>`
    : '';
  const countChip = task.toolsCount > 0
    ? `<span class="meta-count" title="累计工具调用次数">调用 ×${task.toolsCount}</span>`
    : '';
  const tokenText = task.tokenCount === null ? '—' : `${formatTokens(task.tokenCount)} token`;
  const runChip = task.runId !== 'unassigned'
    ? `<span class="meta-tail" title="运行组 ${escapeHtml(task.runId)}">${escapeHtml(runChipLabel(task.runId).name)}</span>`
    : '';
  const meta = [
    escapeHtml(task.role),
    `${escapeHtml(task.model)} · ${escapeHtml(task.effort)}`,
    ...(toolChip ? [toolChip] : []),
    ...(countChip ? [countChip] : []),
    `<strong class="meta-hl">${escapeHtml(formatDuration(task.durationMs))}</strong>`,
    `<strong class="meta-hl">${escapeHtml(tokenText)}</strong>`,
    ...(runChip ? [runChip] : [])
  ].join('<span class="meta-sep">·</span>');
  return `<article class="task-row${invalid}" data-task-id="${safeId(task.taskId)}" data-transport-state="${escapeHtml(task.transportState)}" data-business-state="${escapeHtml(task.businessState)}">
    <div class="task-line1">
      <button type="button" class="task-title-button" data-action="task-detail" data-task-id="${safeId(task.taskId)}" title="查看任务详情">${escapeHtml(task.title)}</button>
      <span class="badge-slot">${badge('transport', task.transportState)}</span>
      <span class="badge-slot">${TERMINAL_TRANSPORT.has(task.transportState) ? badge('business', task.businessState) : ''}</span>
      <span class="action-slot">${cancel}</span>
    </div>
    <div class="task-line2">${meta}${errorNote}</div>
  </article>`;
}

function renderTasks() {
  const tasks = visibleTasks();
  const stateKind = regionState('tasks', state.tasks);
  ui['task-region-state'].className = `state-badge state-${stateKind}`;
  ui['task-region-state'].textContent = label(stateKind);
  ui['activity-count'].textContent = String(tasks.length);

  const signature = [
    'tasks', stateKind, state.regions.tasks.error || '',
    tasks.map((t) => `${t.taskId}:${t.transportState}:${t.businessState}:${t.updatedAt || ''}:${t.tokenCount || 0}:${t.durationMs || 0}:${t.recentTool || ''}:${t.toolsCount || 0}`).join('|')
  ].join('~');
  if (sigMatch('tasks', signature)) return;

  ui['task-count'].textContent = `${tasks.length} 条`;

  if (stateKind === 'loading' && state.tasks.length === 0) {
    ui['task-list'].innerHTML = stateMarkup('loading', '正在读取任务快照');
    return;
  }
  if (stateKind === 'disabled') {
    ui['task-list'].innerHTML = stateMarkup('disabled', '任务区域暂不可用');
    return;
  }
  const errorBanner = state.regions.tasks.error ? stateMarkup('error', state.regions.tasks.error) : '';
  if (stateKind === 'error' && tasks.length === 0) {
    ui['task-list'].innerHTML = stateMarkup('error', state.regions.tasks.error || '任务区域数据错误');
    return;
  }
  if (tasks.length === 0) {
    ui['task-list'].innerHTML = `<div class="empty-state empty-rich"><span class="empty-icon" aria-hidden="true">✦</span><p>暂无活动任务</p><button type="button" class="text-button" data-action="goto-history">去历史页看看</button></div>`;
    return;
  }
  // 运行页平铺：在跑的任务量级小，直接按行排；DAG 结构由上方内嵌拓扑图承担
  ui['task-list'].innerHTML = `${errorBanner}${tasks.map((task) => renderTaskRow(task)).join('')}`;
}

function fleetNodeDepths(fleet) {
  const depth = new Map();
  const visiting = new Set();
  const ids = new Set(fleet.nodes.map((node) => node.nodeId));
  const parents = new Map();
  fleet.edges.forEach((edge) => {
    if (!parents.has(edge.to)) parents.set(edge.to, []);
    parents.get(edge.to).push(edge.from);
  });
  const resolve = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ups = (parents.get(id) || []).filter((parent) => ids.has(parent));
    const value = ups.length ? Math.max(...ups.map((parent) => resolve(parent))) + 1 : 0;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  fleet.nodes.forEach((node) => resolve(node.nodeId));
  return depth;
}

// 运行事件流已移除：心跳噪声不进 UI，运行实况直接标注在 DAG 节点卡上（node-stats）。

// 活动区只画真实执行或结束未确认的 run。依赖受阻的 pending 进待处理区，不伪装运行中。
// 分类与结束文案在 core.mjs，避免这里再写一套口径。
function fleetRuns() {
  return state.inlineFleet && Array.isArray(state.inlineFleet.runs) ? state.inlineFleet.runs : [];
}

function activityFleetItems() {
  return fleetRuns()
    .map((run) => ({ run, control: fleetEndControl(run, state.tasks) }))
    .filter((item) => item.control.visible === 'activity' && item.control.runId);
}

function pendingFleetItems() {
  return fleetRuns()
    .map((run) => ({ run, control: fleetEndControl(run, state.tasks) }))
    .filter((item) => item.control.visible === 'pending' && item.control.runId);
}

function activeDagRunIds() {
  return activityFleetItems().map((item) => item.control.runId);
}

function fleetHeaderHtml(fleet, control, { closeAction = '' } = {}) {
  const doneCount = fleet.nodes.filter((node) => node.state === 'done').length;
  const end = control.canEnd
    ? `<button type="button" class="danger-button dag-end-run" data-action="end-fleet" data-run-id="${safeId(fleet.runId)}">结束运行</button>`
    : '';
  const close = closeAction
    ? `<button type="button" class="text-button" data-action="${closeAction}">收起</button>`
    : '';
  const problem = control.problemText ? `<p class="dag-problem">${escapeHtml(control.problemText)}</p>` : '';
  return `<div class="dag-header"><strong>${escapeHtml(fleet.runId)}</strong><span class="dag-status">${escapeHtml(control.statusLabel)}</span><span class="dag-run-progress"><b>${doneCount}</b> / ${fleet.nodes.length} 节点完成</span>${close}${end}</div>${problem}`;
}

// 活动 DAG 内嵌运行页：有活动 run 才出现，画的是与 Fleet 页同一套拓扑图。
function renderInlineDag() {
  const container = ui['inline-dag'];
  if (!container) return;
  const items = activityFleetItems();
  const taskById = new Map(state.tasks.map((task) => [task.taskId, task]));
  const signature = JSON.stringify(items.map((item) => [item.control.runId, item.control.kind, item.control.problemText,
    item.run.nodes?.map((node) => {
      const task = taskById.get(node.task_id);
      return [node.node_id, node.state, node.business_state ?? node.businessState, task?.transportState, task?.recentTool, task?.toolsCount, task?.durationMs, task?.tokenCount];
    })]));
  if (sigMatch('inlineDag', signature)) return;
  container.classList.toggle('is-hidden', !items.length);
  container.innerHTML = '';
  if (!items.length) return;
  items.forEach((item) => {
    const fleet = normalizeFleet(state.inlineFleet, item.control.runId);
    const block = document.createElement('div');
    block.className = 'inline-dag-run';
    block.dataset.runId = fleet.runId;
    block.dataset.activity = item.control.kind;
    const errorBanner = fleet.error ? stateMarkup('error', fleet.error) : '';
    block.innerHTML = `${fleetHeaderHtml(fleet, item.control)}${errorBanner}<div class="dag-stage"></div>`;
    container.append(block);
    drawFleetGraph(block.querySelector('.dag-stage'), fleet, taskById);
  });
}

function renderPendingFleets() {
  const container = ui['pending-fleet'];
  if (!container) return;
  const items = pendingFleetItems();
  const signature = `pending:${items.map((item) => `${item.control.runId}:${item.control.kind}:${item.control.dependencyBlocked}:${item.run.nodes?.map((node) => `${node.node_id}:${node.state}:${node.business_state ?? node.businessState ?? ''}`).join(',')}`).join('|')}`;
  if (sigMatch('pendingFleet', signature)) return;
  container.classList.toggle('is-hidden', !items.length);
  container.innerHTML = '';
  if (!items.length) return;
  const note = document.createElement('p');
  note.className = 'pending-fleet-note';
  note.textContent = '没有活动任务。依赖受阻或尚未派发的节点显示为待处理，不计入运行中，也不会按超时清理。';
  container.append(note);
  items.forEach((item) => {
    const fleet = normalizeFleet(state.inlineFleet, item.control.runId);
    const block = document.createElement('div');
    block.className = 'inline-dag-run';
    block.dataset.runId = fleet.runId;
    block.dataset.activity = 'pending';
    const errorBanner = fleet.error ? stateMarkup('error', fleet.error) : '';
    block.innerHTML = `${fleetHeaderHtml(fleet, item.control)}${errorBanner}<div class="dag-stage"></div>`;
    container.append(block);
    drawFleetGraph(block.querySelector('.dag-stage'), fleet);
  });
}

function drawFleetGraph(stage, fleet, taskById = new Map(state.tasks.map((task) => [task.taskId, task]))) {
  const depths = fleetNodeDepths(fleet);
  const maxDepth = Math.max(0, ...depths.values());
  const stageEl = typeof stage === 'string' ? byId(stage) : stage;
  const graph = document.createElement('div');
  graph.className = 'dag-graph';
  const mobileLayout = window.innerWidth <= 720;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'dag-edges-svg');
  // 手机端不挂连线 SVG：replaced element 吃不到 inset:0 拉伸，未设尺寸时以 300×150
  // 固有尺寸把单列布局撑出横向滚动（三堂会审收口实测）
  if (!mobileLayout) graph.append(svg);
  const byNodeId = new Map();
  // 分层带自动排布：每个依赖深度一个层带；≤6 节点单列，≤14 两列，更多三列；
  // 手机端恒单列流式（内联列模板压过媒体查询，必须在这里分支——三堂会审 k3 F2/sol#7）。
  let bandIndex = 0;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const columnNodes = fleet.nodes.filter((node) => depths.get(node.nodeId) === depth);
    if (!columnNodes.length) continue;
    bandIndex += 1;
    const band = document.createElement('div');
    band.className = 'dag-band';
    // 层带标签用渲染序号：成环等异常深度不产生 LAYER 空档（三堂会审 opus F-14）
    band.innerHTML = `<span class="dag-band-tag">LAYER ${bandIndex} · ${columnNodes.length} 节点</span>`;
    const grid = document.createElement('div');
    grid.className = 'dag-band-grid';
    const cols = columnNodes.length <= 6 ? 1 : columnNodes.length <= 14 ? 2 : 3;
    grid.style.gridTemplateColumns = mobileLayout ? 'minmax(0, 1fr)' : `repeat(${cols}, 232px)`;
    columnNodes.forEach((node) => {
      const el = document.createElement('div');
      el.className = 'dag-node';
      el.dataset.state = node.state;
      el.dataset.nodeId = node.nodeId;
      // 节点卡直写实况：最近工具 / 调用次数 / 真实耗时 / token（事件流退役后的唯一实况面）
      const task = node.taskId ? taskById.get(node.taskId) : null;
      const statParts = [];
      if (task) {
        if (task.recentTool && !['—', ''].includes(task.recentTool)) statParts.push(`<span class="stat-tool" title="最近工具调用">${escapeHtml(task.recentTool)}</span>`);
        if (task.toolsCount) statParts.push(`<span title="工具调用次数">×${escapeHtml(String(task.toolsCount))}</span>`);
        if (task.durationMs) statParts.push(`<span title="耗时">${escapeHtml(formatDuration(task.durationMs))}</span>`);
        if (task.tokenCount) statParts.push(`<span title="token 总量">${escapeHtml(formatTokens(task.tokenCount))}</span>`);
      }
      const stats = statParts.length ? `<span class="node-stats">${statParts.join('')}</span>` : '';
      // 人话标题优先（seed.title/goal 派生的 display_title），代号保留供定位
      const nodeTitle = node.title && node.title !== node.label
        ? `<span class="node-title" title="${escapeHtml(node.title)}">${escapeHtml(node.title)}</span>`
        : '';
      el.title = node.title || node.nodeId;
      const outcome = ['done', 'failed', 'cancelled'].includes(node.state)
        && node.businessState && node.businessState !== node.state
        && !['completed', 'done'].includes(node.businessState)
        ? `<span class="node-outcome">结果：${badge('tag', node.businessState)}</span>` : '';
      el.innerHTML = `<div class="node-line1"><span class="node-mark" aria-hidden="true"></span><span class="node-id">${escapeHtml(node.label).replaceAll('-', '-\u200b')}</span></div>${nodeTitle}<span class="node-meta">${badge('tag', node.state)}${outcome}${node.errorKind ? `<span class="mono node-err">${escapeHtml(node.errorKind)}</span>` : ''}</span>${stats}`;
      grid.append(el);
      byNodeId.set(node.nodeId, { el });
    });
    band.append(grid);
    graph.append(band);
  }
  stageEl.append(graph);
  // 等卡片落位后画连线；手机竖排布局下连线无意义，跳过
  requestAnimationFrame(() => {
    if (window.innerWidth <= 720) return;
    const stageRect = graph.getBoundingClientRect();
    if (!stageRect.width) return;
    svg.setAttribute('viewBox', `0 0 ${graph.scrollWidth} ${graph.scrollHeight}`);
    svg.setAttribute('width', String(graph.scrollWidth));
    svg.setAttribute('height', String(graph.scrollHeight));
    // 幽灵边（指向/来自不存在节点）先滤掉，不进计数（三堂会审 opus F-15）
    const byTarget = new Map();
    for (const edge of fleet.edges) {
      if (!byNodeId.has(edge.from) || !byNodeId.has(edge.to)) continue;
      if (!byTarget.has(edge.to)) byTarget.set(edge.to, []);
      byTarget.get(edge.to).push(edge);
    }
    // 逐条直画、允许穿卡：起点=源卡右缘、终点=目标卡左缘。层带边界/汇流线方案
    // 已被使用者否决（看不出依赖归属）；线画在卡面之上（z-index），半透明细线可读。
    const rectOf = (id) => {
      const entry = byNodeId.get(id);
      if (!entry) return null;
      const node = entry.el.getBoundingClientRect();
      return {
        state: entry.el.dataset.state,
        y: node.top + node.height / 2 - stageRect.top,
        right: node.right - stageRect.left,
        left: node.left - stageRect.left
      };
    };
    const fragments = [];
    for (const [target, edges] of byTarget) {
      const to = rectOf(target);
      if (!to) continue;
      for (const edge of edges) {
        const from = rectOf(edge.from);
        if (!from) continue;
        const x1 = from.right;
        const x2 = to.left;
        const bend = Math.max(36, Math.min(120, Math.abs(to.y - from.y) / 3, Math.max(36, (x2 - x1) / 2)));
        const cls = to.state === 'running' ? 'edge-running' : from.state === 'done' && to.state === 'done' ? 'edge-done' : 'edge-idle';
        fragments.push(`<path class="dag-edge-line ${cls}" d="M ${x1} ${from.y} C ${x1 + bend} ${from.y}, ${x2 - bend} ${to.y}, ${x2 - 1} ${to.y}" />`);
      }
    }
    svg.insertAdjacentHTML('beforeend', fragments.join(''));
  });
}

// run id 形如 <名字段…>-<YYYYMMDD>[-rN]：日期是公共噪声，轮次配上名字段才有意义。
// 与 shortId 分家：任务 id 的区分位在尾部 hash，run id 的区分位在前中段，两者不可共用截断口径
//（实测 13 个 run 里 6 个被 shortId 截成同一个「…20260829」）。
const RUN_ID_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const RUN_ID_ROUND = /^r\d+$/i;

function runChipLabel(runId) {
  const parts = String(runId ?? '').split('-').filter(Boolean);
  const meta = [];
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (RUN_ID_ROUND.test(last)) { meta.unshift(last.toLowerCase()); parts.pop(); continue; }
    const date = RUN_ID_DATE.exec(last);
    if (date) { meta.unshift(`${date[2]}/${date[3]}`); parts.pop(); continue; }
    break;
  }
  return { name: parts.join('-') || String(runId ?? '—'), meta: meta.join(' · ') };
}

// 历史页拓扑抽屉：run 收在下拉选择器里（不占页面第一级），选中才展开完整拓扑图。
// 展开区纵向不限高——一次完整看完一个 run，整页保持单一滚动条；宽图只在图区内横滚。
function renderHistoryDags() {
  const container = ui['history-dags'];
  const select = ui['history-dag-select'];
  if (!container || !select) return;
  const runs = state.inlineFleet && Array.isArray(state.inlineFleet.runs) ? state.inlineFleet.runs : [];
  const runById = new Map(runs.map((run) => [String(run?.run_id || ''), run]));
  runById.delete('');
  const runIds = [...runById.keys()]
    .sort((a, b) => String(runById.get(b)?.updated_at || '').localeCompare(String(runById.get(a)?.updated_at || '')) || a.localeCompare(b));
  // 选中的 run 已从磁盘消失时先清空：normalizeFleet 找不到会回退 runs[0]，静默画出没人选的 run
  if (state.historyDagRun && !runById.has(state.historyDagRun)) state.historyDagRun = '';
  const optionSig = `hdagopts:${runIds.join('|')}`;
  if (!sigMatch('historyDagOptions', optionSig)) {
    select.innerHTML = ['<option value="">运行组拓扑…</option>']
      .concat(runIds.map((runId) => {
        const run = runById.get(runId) || {};
        const { name, meta } = runChipLabel(runId);
        const nodes = Array.isArray(run.nodes) ? run.nodes.length : 0;
        const label = [name, meta, nodes ? `${nodes}节点` : ''].filter(Boolean).join(' · ');
        return `<option value="${escapeHtml(runId)}">${escapeHtml(label)}</option>`;
      }))
      .join('');
  }
  select.value = state.historyDagRun;
  // 签名带展开 run 的节点状态：点开仍在跑的 run 时进度随轮询更新而不是停在打开那刻
  const expandedRun = runById.get(state.historyDagRun);
  const expandedControl = state.historyDagRun ? fleetEndControl(expandedRun || { run_id: state.historyDagRun }, state.tasks) : null;
  const expanded = (expandedRun?.nodes || [])
    .map((node) => `${node?.node_id}:${node?.state}:${node?.business_state ?? node?.businessState ?? ''}`).join(',');
  const signature = `hdag:${state.historyDagRun}:${expandedControl?.kind || ''}:${expanded}`;

  if (sigMatch('historyDags', signature)) return;
  container.classList.toggle('is-hidden', !state.historyDagRun);
  // 拓扑查看独占：检索条与列表退场（CSS .is-dag-mode），收起即回归
  container.closest('.history-surface')?.classList.toggle('is-dag-mode', Boolean(state.historyDagRun));
  container.innerHTML = '';
  if (!state.historyDagRun) return;
  const fleet = normalizeFleet(state.inlineFleet, state.historyDagRun);
  const raw = fleetRuns().find((run) => String(run?.run_id || '') === state.historyDagRun);
  const control = fleetEndControl(raw || { run_id: state.historyDagRun }, state.tasks);
  if (fleet.nodes.length) {
    container.innerHTML = `${fleetHeaderHtml(fleet, control, { closeAction: 'history-dag-close' })}<div class="dag-stage"></div>`;
    drawFleetGraph(container.querySelector('.dag-stage'), fleet);
  } else if (fleet.error) {
    // 数据损坏与数据缺失是两回事，不合并成「没有数据」
    container.innerHTML = stateMarkup('error', fleet.error);
  } else {
    container.innerHTML = stateMarkup('empty', '这个 run 没有拓扑数据');
  }
}

function renderHistory() {
  renderHistoryDags();
  const visible = filterTasks(state.history, state.filters, state.context);
  const kind = regionState('history', visible);
  const pageCount = Math.max(1, Math.ceil(visible.length / 20));
  state.historyPage = Math.min(state.historyPage, pageCount - 1);
  const pagination = document.querySelector('#history-pagination');
  const signature = `hist:${kind}:${state.historyPage}:${JSON.stringify(state.filters)}:${state.regions.history.error || ''}:${JSON.stringify(visible.map((i) => [i.taskId, i.businessState, i.title, i.model, i.effort, i.tokenCount, i.durationMs, i.finishedAt, i.updatedAt, i.runId, i.taskOutcome]))}`;
  if (sigMatch('history', signature)) return;
  if (pagination) pagination.innerHTML = '';
  ui['history-range'].textContent = `共 ${visible.length} 条`;
  if (kind === 'loading' && !state.history.length) {
    ui['history-list'].innerHTML = stateMarkup('loading', '正在读取历史');
    return;
  }
  if (kind === 'disabled') {
    ui['history-list'].innerHTML = stateMarkup('disabled', '历史区域暂不可用');
    return;
  }
  if (kind === 'error' && !state.history.length) {
    ui['history-list'].innerHTML = stateMarkup('error', state.regions.history.error || '历史数据错误');
    return;
  }
  if (kind === 'empty') {
    const filtering = state.filters.status !== 'all' || state.filters.role !== 'all' || state.filters.model !== 'all' || state.filters.scope !== 'all';
    if (filtering && state.history.length) {
      ui['history-list'].innerHTML = `<div class="empty-state empty-rich"><span class="empty-icon" aria-hidden="true">◇</span><p>当前筛选没有匹配的历史任务</p><button type="button" class="text-button" data-action="clear-filters">清除全部筛选</button></div>`;
      return;
    }
    ui['history-list'].innerHTML = stateMarkup('empty', '暂无历史任务');
    return;
  }
  const errorBanner = state.regions.history.error ? stateMarkup('error', state.regions.history.error) : '';
  const start = state.historyPage * 20;
  const shown = visible.slice(start, start + 20);
  if (pagination) pagination.innerHTML = `<span>共 ${visible.length} 条 · 每页 20 条</span><div><button type="button" class="secondary-button" data-action="history-prev" ${state.historyPage === 0 ? 'disabled' : ''}>上一页</button><span>${state.historyPage + 1} / ${pageCount}</span><button type="button" class="secondary-button" data-action="history-next" ${state.historyPage + 1 >= pageCount ? 'disabled' : ''}>下一页</button></div>`;
  ui['history-list'].innerHTML = errorBanner + shown.map((task) => {
    const runLabel = task.runId === 'unassigned' ? '' : `<p>${escapeHtml(runChipLabel(task.runId).name)}</p>`;
    return `<article class="history-item"><div class="history-copy"><button type="button" class="history-title-button" data-action="task-detail" data-task-id="${safeId(task.taskId)}" title="查看任务详情">${escapeHtml(task.title)}</button>${runLabel}${task.taskOutcome ? `<p>${escapeHtml(task.taskOutcome.summary)}</p>` : ''}<div class="history-metadata"><span title="模型与档位">${escapeHtml(task.model)} · ${escapeHtml(task.effort)}</span><span>${escapeHtml(formatTime(task.finishedAt || task.updatedAt || ''))}</span><span>耗时 ${escapeHtml(formatDuration(task.durationMs))}</span><span>Tokens ${task.tokenCount === null ? '未记录' : escapeHtml(formatTokens(task.tokenCount))}</span></div></div><span class="badge-slot">${badge('business', task.businessState)}</span></article>`;
  }).join('');

}

function renderDetail() {
  const task = state.selectedTask;
  const open = Boolean(task);
  ui['task-detail'].classList.toggle('is-hidden', !open);
  ui['task-detail'].setAttribute('aria-hidden', String(!open));
  if (!task) return;
  const signature = `detail:${task.taskId}:${task.transportState}:${task.businessState}:${task.updatedAt || ''}:${task.tokenCount || 0}:${task.localError || ''}:${JSON.stringify(task.taskOutcome)}`;
  if (sigMatch('detail', signature)) return;
  const report = task.artifacts.report || '未提供';
  const handoff = task.artifacts.handoff || '未提供';
  const errorBlock = task.localError ? `<div class="detail-error" data-testid="detail-error">${escapeHtml(task.localError)}</div>` : '';
  const eventCount = task.events.length;
  const lastEvent = eventCount ? task.events[eventCount - 1] : null;
  const eventLines = task.events.slice(-12).map((event) => `<span class="event-line"><strong>${escapeHtml(event.type)}</strong>${escapeHtml(event.at)}${event.message && event.message !== '未提供事件摘要' ? ` · ${escapeHtml(event.message)}` : ''}</span>`).join('');
  const events = eventCount
    ? `<details class="detail-events"><summary>共 ${eventCount} 条事件 · 最近 ${escapeHtml(formatClock(lastEvent.at))}<span class="muted">（点击展开最近 12 条）</span></summary>${eventLines}</details>`
    : '<div class="empty-state">暂无事件记录</div>';
  const cancel = task.canCancel ? `<button type="button" class="danger-button" data-action="cancel" data-task-id="${safeId(task.taskId)}">取消任务</button>` : '';
  const breakPath = (value) => escapeHtml(value).replaceAll('\\', '\\' + String.fromCharCode(0x200B)).replaceAll('/', '/' + String.fromCharCode(0x200B));
  const reserveNote = task.reviewReason && task.reviewReason !== 'none' && task.businessState.startsWith('completed_with')
    ? `<div class="detail-field"><dt>保留项说明</dt><dd>${escapeHtml(task.reviewReason)}</dd></div>`
    : '';
  ui['detail-content'].innerHTML = `<div class="detail-hero"><div class="detail-id-row"><span class="detail-id">${escapeHtml(task.taskId)} · 版本 ${escapeHtml(task.revision ?? '—')}</span><button type="button" class="text-button detail-copy" data-action="copy-task-id" data-task-id="${safeId(task.taskId)}" title="复制完整任务 ID">复制 ID</button></div><h3>${escapeHtml(task.title)}</h3><div class="detail-badges">${badge('transport', task.transportState)}${badge('business', task.businessState)}</div></div>${errorBlock}${task.taskOutcome ? `<p>${escapeHtml(task.taskOutcome.summary)}</p><p>对象门：${escapeHtml(task.taskOutcome.object_gate.name || '未知')}；来源：${escapeHtml(task.taskOutcome.object_gate.source || '未知')}</p>` : ''}<dl class="detail-grid"><div class="detail-field"><dt>角色</dt><dd title="${escapeHtml(task.role)}">${escapeHtml(task.role)}</dd></div><div class="detail-field"><dt>模型 / 档位</dt><dd title="${escapeHtml(task.model)} / ${escapeHtml(task.effort)}">${escapeHtml(task.model)} / ${escapeHtml(task.effort)}</dd></div><div class="detail-field"><dt>耗时</dt><dd>${escapeHtml(formatDuration(task.durationMs))}</dd></div><div class="detail-field"><dt>Tokens（已记录）</dt><dd>${task.tokenCount === null ? '未记录' : escapeHtml(formatTokens(task.tokenCount))}</dd></div><div class="detail-field"><dt>开始时间</dt><dd>${escapeHtml(formatTime(task.startedAt))}</dd></div><div class="detail-field"><dt>完成时间</dt><dd>${escapeHtml(formatTime(task.finishedAt))}</dd></div><div class="detail-field"><dt>运行组 / 批次</dt><dd title="${escapeHtml(task.runId)} / ${escapeHtml(task.batchId)}">${escapeHtml(task.runId)} / ${escapeHtml(task.batchId)}</dd></div><div class="detail-field"><dt>工具计数</dt><dd>${escapeHtml(task.toolsCount)}</dd></div>${reserveNote}</dl><section class="detail-section"><h4>产物路径</h4><span class="detail-path report" title="${escapeHtml(report)}">${breakPath(report)}</span><span class="detail-path handoff" title="${escapeHtml(handoff)}">${breakPath(handoff)}</span></section><section class="detail-section"><h4>最近工具调用</h4><span class="detail-path" title="${escapeHtml(task.recentTool)}">${escapeHtml(task.recentTool)}</span></section><section class="detail-section"><h4>事件入口</h4>${events}</section><div class="detail-actions">${cancel}</div>`;
}

function renderGlobalBlocker() {
  const stale = state.connection.state !== 'success' && Boolean(state.lastSuccessAt);
  const unavailable = state.connection.state === 'error';
  ui['global-blocker'].classList.toggle('is-hidden', !stale && !unavailable);
  ui['global-blocker-copy'].textContent = state.lastSuccessAt
    ? `上次成功同步：${formatTime(state.lastSuccessAt)}。保留当前数据和编辑，恢复后自动同步。`
    : '尚未读取任务数据，正在重试本地服务。';
  ui['global-blocker-detail'].textContent = state.connection.detail || '等待下一次轮询';
  // 连接状态不拥有页面可见性；陈旧数据仍可查看，变更请求在 fetchJson 入口阻止。
  renderViewState();
}

function renderViewState() {
  const views = { activity: ui['activity-view'], history: ui['history-view'], ...Object.fromEntries(CONFIG_VIEWS.map((view) => [view, ui[`${view}-view`]])) };
  Object.entries(views).forEach(([name, el]) => {
    if (!el) return;
    const hidden = state.activeView !== name;
    el.classList.toggle('is-hidden', hidden);
    el.setAttribute('aria-hidden', String(hidden));
  });
  document.querySelectorAll('[data-action="view-tab"]').forEach((button) => {
    const active = button.dataset.view === state.activeView;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const sync = ui['sync-status'];
  if (sync) {
    const items = state.sync.status;
    sync.classList.toggle('is-hidden', !CONFIG_VIEWS.includes(state.activeView) || !items.length);
    // 详情按「配置 · 状况」归并，多个运行环境只计数，不显示路径。
    const lines = new Map();
    for (const item of items) {
      const text = `${configPages.fileLabel(item.file)} · ${({ differs: '内容不同', missing: '缺失', unreadable: '不可读' })[item.reason]}`;
      lines.set(text, (lines.get(text) || 0) + 1);
    }
    const details = state.sync.open ? `<ul class="sync-details">${[...lines].map(([text, count]) => `<li>${escapeHtml(text)}${count > 1 ? ` · ${count} 个运行环境` : ''}</li>`).join('')}</ul>` : '';
    sync.innerHTML = items.length ? `<div class="sync-line"><span class="txt">有改动尚未同步到运行环境</span><button type="button" class="secondary-button" data-action="sync-details">${state.sync.open ? '收起详情' : '查看详情'}</button><button type="button" class="secondary-button" data-action="sync-now">同步</button></div>${details}` : '';
  }
}

function renderHeader() {
  const themeButton = document.querySelector('[data-action="theme"]');
  const motionButton = document.querySelector('[data-action="sky-motion"]');
  document.documentElement.dataset.theme = state.theme;
  try {
    localStorage.setItem('agent-panel.theme', state.theme);
    localStorage.setItem('agent-panel.sky-motion', state.skyMotion);
  } catch { /* file:// 或隐私模式下静默跳过 */ }
  themeButton.setAttribute('aria-pressed', String(state.theme === 'dark'));
  if (motionButton) motionButton.setAttribute('aria-pressed', String(state.skyMotion === 'on'));
  ui['scope-summary'].textContent = state.filters.scope === 'all' ? '本仓 · 活动运行' : `本仓 · ${scopeLabel(state.filters.scope)}`;
  ui['last-refresh'].textContent = state.connection.state === 'success' && state.lastSuccessAt ? `同步于 ${formatClock(state.lastSuccessAt)}` : state.connection.message;
}

function renderAll() {
  renderHeader();
  renderFilters();
  renderSummary();
  renderTasks();
  renderInlineDag();
  renderPendingFleets();
  renderHistory();
  renderDetail();
  renderGlobalBlocker();
  renderViewState();
}

const EMPTY_TEXTS = new Set(['', '—', '未标注', '未命名任务', 'unassigned', null, undefined]);

/** 稀疏合并：详情接口字段缺失时不覆盖快照里已有的好值。 */
function mergeSparseTask(existing, incoming) {
  const merged = { ...incoming };
  const keepIfEmpty = (key) => { if (EMPTY_TEXTS.has(incoming[key]) && !EMPTY_TEXTS.has(existing[key])) merged[key] = existing[key]; };
  ['title', 'role', 'model', 'effort', 'recentTool'].forEach(keepIfEmpty);
  ['tokenCount', 'durationMs', 'toolsCount'].forEach((key) => { if (!incoming[key] && existing[key]) merged[key] = existing[key]; });
  if (!incoming.events?.length && existing.events?.length) merged.events = existing.events;
  if (!incoming.artifacts?.report && existing.artifacts?.report) merged.artifacts = { ...merged.artifacts, report: existing.artifacts.report };
  if (!incoming.artifacts?.handoff && existing.artifacts?.handoff) merged.artifacts = { ...merged.artifacts, handoff: existing.artifacts.handoff };
  return merged;
}

function mergeTask(updated, { preserveSparse = false } = {}) {
  const index = state.tasks.findIndex((task) => task.taskId === updated.taskId);
  const value = preserveSparse && index >= 0 ? mergeSparseTask(state.tasks[index], updated) : updated;
  if (index >= 0) state.tasks.splice(index, 1, value);
  else state.tasks.unshift(value);
  if (state.selectedTask?.taskId === updated.taskId) state.selectedTask = value;
}

function sectionError(section) {
  const root = section && typeof section === 'object' ? section : {};
  if (root.section_state === 'error') return '该区域数据存在损坏项，已按错误显示，不猜补';
  if (root.partial_errors === true) return '该区域部分数据损坏，已跳过损坏项';
  return '';
}

function applyEnvelope(envelope, errors = {}) {
  const snapshot = normalizeSnapshot(envelope.snapshot || envelope);
  state.tasks = snapshot.tasks;
  state.summary = snapshot.summary;
  state.inlineFleet = snapshot.fleet;
  state.context = { ...state.context, ...(snapshot.context || {}), ...(envelope.context || {}) };
  state.regions.tasks = { loading: false, error: errors.tasks || '', disabled: false };

  if (envelope.review !== undefined) {
    state.review = normalizeReviewQueue(envelope.review);
    state.regions.review = { loading: false, error: errors.review || sectionError(envelope.review), disabled: false };
  } else {
    state.review = state.tasks.filter((task) => task.needsReview || task.businessState === 'needs_parent_review').map((task) => ({ taskId: task.taskId, ackTaskId: task.taskId, runId: task.runId, reason: task.reviewReason || 'needs_parent_review', waitMs: task.waitMs, task, readOnly: true }));
    state.regions.review = { loading: false, error: errors.review || '', disabled: false };
  }
  if (envelope.history !== undefined) {
    state.history = normalizeSnapshot(envelope.history).tasks;
    state.regions.history = { loading: false, error: errors.history || sectionError(envelope.history), disabled: false };
  }

  renderAll();
}

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// GET 轮询的 ETag 复用：304 时直接回放上次解析结果，省网络与 JSON.parse。
const etagCache = new Map();

async function fetchJson(path, options = {}) {
  const mutating = options.method && options.method !== 'GET';
  if (mutating) {
    if (state.connection.state !== 'success') throw new ApiError('尚未恢复同步，请连接恢复后再保存或取消');
    // 不重放写请求；在发出前更新身份，服务重启也不需要重载页面或丢弃草稿。
    const session = await fetchJson(API.session);
    if (!session.panel_token) throw new ApiError('未取得面板连接身份，请重试');
    panelToken = session.panel_token;
  }
  const { timeoutMs = mutating ? 40000 : 8000, ...requestOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const cached = mutating ? null : etagCache.get(path);
    const response = await fetch(path, {
      ...requestOptions,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(mutating ? { 'X-Panel-Token': panelToken } : {}),
        ...(cached ? { 'If-None-Match': cached.etag } : {}),
        ...(options.headers || {})
      }
    });
    if (response.status === 304 && cached) {
      // 304 无 body 也要消费响应流：不消费 Chrome 会取消流（network 面板记
      // ERR_ABORTED）并放弃该连接的复用，keep-alive 名存实亡。
      await response.arrayBuffer().catch(() => {});
      return cached.value;
    }
    const raw = await response.text();
    if (!response.ok) {
      const failure = new ApiError(`${response.status} ${response.statusText || '请求失败'}`, response.status);
      try { failure.body = raw ? JSON.parse(raw) : null; } catch { failure.body = null; }
      if (failure.body?.error?.message) failure.message = failure.body.error.message;
      throw failure;
    }
    try {
      const value = raw ? JSON.parse(raw) : {};
      const etag = response.headers.get('etag');
      if (!mutating && etag) etagCache.set(path, { etag, value });
      return value;
    } catch {
      throw new ApiError('服务返回的 JSON 无法解析', response.status);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      if (mutating && error.status >= 200 && error.status < 300) error.outcomeUnknown = true;
      throw error;
    }
    const failure = new ApiError(error.name === 'AbortError' ? '本地服务请求超时' : '本地服务不可达');
    failure.outcomeUnknown = Boolean(mutating);
    throw failure;
  } finally {
    clearTimeout(timeout);
  }
}

// 连续失败计数：单次瞬时失败（keep-alive 竞态、server 重启窗口）不值得全屏阻断，
// 保留现有数据等下一轮自证；连续两败才判定连接真断。
let refreshFailureStreak = 0;

// single-flight：任何时刻至多一轮刷新在途（轮询、手动重试、销账后刷新共用入口），
// 慢请求不重叠、完成乱序不互相覆盖连接判定。
// 在途时不共享旧轮结果：那一轮的请求发起于本次触发原因（销账/取消/重试）之前，
// 共享会让 UI 陈旧到下一个 5s 轮询（opus 复核 F3）——改为当前轮 settle 后补一轮
// 追刷，期间的并发触发共享同一轮追刷；非 silent 触发立即给连接加载反馈（F4）。
let refreshInFlight = null;
let refreshChase = null;

function refreshAll(options = {}) {
  if (!refreshInFlight) {
    refreshInFlight = doRefreshAll(options).finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }
  if (!options.silent) {
    // 保留原有阻断详情：setConnection 缺省第三参会把 error.message 抹成占位文案（opus 二轮 R2-06）
    setConnection('loading', '连接检查中', state.connection.detail);
    renderHeader();
  }
  if (!refreshChase) {
    // 前置 catch：doRefreshAll 的渲染段在 try 之外，一次渲染抛错若拒绝了在途轮，
    // 只挂 onFulfilled 会让 refreshChase 被已拒 promise 永久钉死、追刷失能（opus 二轮 R2-01）
    refreshChase = refreshInFlight.catch(() => {}).then(() => {
      refreshChase = null;
      // 追刷启动前重查可见性：排队期间页面可能已再次隐藏，隐藏态不发请求，
      // 置挂起标记让恢复可见时补拉（sol 二轮复审 F-01）
      if (document.hidden) { pollSuspended = true; return undefined; }
      return refreshAll(options);
    });
  }
  return refreshChase;
}

async function doRefreshAll({ silent = false } = {}) {
  if (!silent && !state.fixtureMode) {
    setConnection('loading', '连接检查中');
    state.regions.tasks.loading = true;
    renderAll();
  }

  try {
    const snapshot = await fetchJson(API.snapshot);
    const errors = {};
    let history;
    if (state.activeView === 'history') {
      try { history = await fetchJson(API.history); }
      catch (error) { errors.history = error.message; }
    }
    applyEnvelope({ snapshot, history }, errors);
    if (CONFIG_VIEWS.includes(state.activeView)) void configPages.refreshSync();
    refreshFailureStreak = 0;
    state.lastSuccessAt = new Date().toISOString();
    setConnection('success', '已连接', '任务数据已同步；模型目录状态独立显示。');
    renderAll();
  } catch (error) {
    // 页面隐藏期间 settle 的失败不计连接判定：无人在看，阻断/波动提示都没有意义，
    // 恢复可见后由补拉轮重新自证（sol 复核 F-03）
    if (document.hidden) return;
    refreshFailureStreak += 1;
    if (refreshFailureStreak < 2) {
      setConnection('loading', '暂未同步，重试中', error.message);
      renderHeader();
      renderGlobalBlocker();
      return;
    }
    setConnection('error', '连接中断，重试中', error.message);
    if (!state.lastSuccessAt) Object.keys(state.regions).forEach((region) => {
      state.regions[region] = { loading: false, error: error.message, disabled: true };
    });
    renderAll();
  }
}

function showToast(message, kind = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  ui['toast-stack'].append(toast);
  setTimeout(() => toast.remove(), 4600);
}

function findTask(taskId) {
  return state.tasks.find((item) => item.taskId === taskId)
    || state.history.find((item) => item.taskId === taskId)
    || state.review.find((item) => item.taskId === taskId)?.task;
}

function openDetail(taskId) {
  const task = findTask(taskId);
  if (!task) return;
  state.selectedTask = task;
  invalidateSig('detail');
  renderDetail();
  if (state.fixtureMode) return;
  fetchJson(API.task(taskId)).then((payload) => {
    const raw = payload.task || payload.data || payload;
    if (!raw.events?.length && payload.events?.length) raw.events = payload.events;
    const detail = normalizeTask(raw, 0);
    mergeTask(detail, { preserveSparse: true });
    invalidateSig('detail');
    renderDetail();
  }).catch((error) => showToast(`详情入口暂不可用：${error.message}`, 'error'));
}

function handleKeydown(event) {
  if (event.key !== 'Escape') return;
  if (!ui['cancel-modal'].classList.contains('is-hidden')) { closeCancel(); return; }
  if (!ui['task-detail'].classList.contains('is-hidden')) { state.selectedTask = null; renderDetail(); }
}

function showCancelModal() {
  ui['cancel-modal'].classList.remove('is-hidden');
  ui['cancel-modal'].setAttribute('aria-hidden', 'false');
  ui['cancel-modal'].querySelector('.modal-backdrop')?.addEventListener('click', closeCancel, { once: true });
  ui['cancel-modal'].querySelector('[data-action="confirm-cancel"]')?.focus();
}

function openCancel(taskId) {
  const task = findTask(taskId);
  if (!task || !task.canCancel) return;
  state.endRunPending = null;
  state.cancelPending = task;
  if (ui['cancel-title']) ui['cancel-title'].textContent = '确认取消这个任务？';
  ui['cancel-copy'].textContent = `任务 ${task.taskId} 将使用 revision ${task.revision ?? '—'} 发起一次 CAS 取消请求。版本冲突会原样返回，不会覆盖新状态。`;
  const confirm = ui['cancel-modal']?.querySelector('[data-action="confirm-cancel"]');
  if (confirm) confirm.textContent = '确认取消';
  showCancelModal();
}

function openEndRun(runId) {
  const raw = fleetRuns().find((run) => String(run?.run_id || '') === runId);
  const control = fleetEndControl(raw || { run_id: runId }, state.tasks);
  if (!control.canEnd) return;
  state.cancelPending = null;
  state.endRunPending = runId;
  if (ui['cancel-title']) ui['cancel-title'].textContent = control.confirmTitle;
  ui['cancel-copy'].textContent = control.confirmCopy;
  const confirm = ui['cancel-modal']?.querySelector('[data-action="confirm-cancel"]');
  if (confirm) confirm.textContent = '确认结束';
  showCancelModal();
}

function closeCancel() {
  state.cancelPending = null;
  state.endRunPending = null;
  if (ui['cancel-title']) ui['cancel-title'].textContent = '确认取消这个任务？';
  const confirm = ui['cancel-modal']?.querySelector('[data-action="confirm-cancel"]');
  if (confirm) confirm.textContent = '确认取消';
  ui['cancel-modal'].classList.add('is-hidden');
  ui['cancel-modal'].setAttribute('aria-hidden', 'true');
}

async function confirmEndRun() {
  const runId = state.endRunPending;
  if (!runId) return;
  if (state.fixtureMode) {
    showToast('夹具模式不发送结束请求。');
    closeCancel();
    return;
  }
  const button = document.querySelector('[data-action="confirm-cancel"]');
  button.disabled = true;
  try {
    const response = await fetchJson(API.endFleet(runId), {
      method: 'POST',
      body: JSON.stringify({ reason: 'user_requested' })
    });
    const end = response.end || {};
    if (end.accepted === false) {
      showToast(`结束未被接受：${end.reason || '运行当前状态不可结束'}`, 'error');
      closeCancel();
      await refreshAll({ silent: true });
      return;
    }
    if (end.confirmed === false || end.status === 'cancelling') {
      showToast(`已请求结束 ${runId}，等待活跃任务确认；运行保持可见。`);
    } else {
      showToast(`已结束运行：${runId}。历史已保留。`);
    }
    closeCancel();
    await refreshAll({ silent: true });
  } catch (error) {
    showToast(`结束失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function confirmCancel() {
  if (state.endRunPending) {
    await confirmEndRun();
    return;
  }
  const task = state.cancelPending;
  if (!task) return;
  if (state.fixtureMode) {
    showToast('夹具模式不发送取消请求。');
    closeCancel();
    return;
  }
  const button = document.querySelector('[data-action="confirm-cancel"]');
  button.disabled = true;
  try {
    const response = await fetchJson(API.cancel(task.taskId), {
      method: 'POST',
      body: JSON.stringify(buildCancelRequest(task))
    });
    if (response.cancel && response.cancel.accepted === false) {
      showToast(`取消未被接受：${response.cancel.reason || '任务当前状态不可取消'}`, 'error');
      closeCancel();
      await refreshAll({ silent: true });
      return;
    }
    const payload = response.task || response.data;
    if (payload && typeof payload === 'object') {
      mergeTask(normalizeTask(payload, 0));
    }
    showToast(`已提交取消：${task.taskId}`);
    closeCancel();
    renderAll();
    await refreshAll({ silent: true });
  } catch (error) {
    if (error.status === 409) showToast(`取消被拒绝：${task.taskId} 的 revision 已过期。`, 'error');
    else showToast(`取消失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function copyTaskId(taskId) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(taskId);
    else {
      const helper = document.createElement('textarea');
      helper.value = taskId;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.append(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
    }
    showToast('已复制完整任务 ID。');
  } catch {
    showToast('复制失败，请在详情里手动选择任务 ID。', 'error');
  }
}

function handleClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'theme') {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    renderHeader();
    return;
  }
  if (action === 'sky-motion') {
    state.skyMotion = state.skyMotion === 'on' ? 'off' : 'on';
    syncSkyMotion();
    renderHeader();
    return;
  }
  if (action === 'sync-details') {
    state.sync.open = !state.sync.open;
    renderViewState();
    return;
  }
  if (action === 'sync-now') {
    target.disabled = true;
    fetchJson('/api/sync', { method: 'POST' }).then((response) => updateSyncStatus(response.sync_status))
      .catch((error) => showToast(`同步失败：${error.message}`, 'error'))
      .finally(() => { target.disabled = false; });
    return;
  }
  if (action === 'view-tab') {
    state.activeView = target.dataset.view;
    renderViewState();
    // 隐藏容器 getBoundingClientRect 归零，drawFleetGraph 的 rAF 会静默放弃连线；
    // 切回来时无人补画（签名已写入），这里主动失效重绘（审查 S2-2 丢线链路）
    invalidateSig('inlineDag', 'pendingFleet', 'historyDags');
    renderInlineDag();
    renderPendingFleets();
    renderHistoryDags();
    // 历史数据按页懒拉，切页立即补一轮，不等下一个轮询周期
    if (state.activeView === 'history') refreshAll({ silent: true });
    // 四个配置页共用一次读取，首次进入任一页时加载
    if (CONFIG_VIEWS.includes(state.activeView)) configPages.load();
    return;
  }
  if (action === 'task-detail') {
    openDetail(decodeURIComponent(target.dataset.taskId));
    return;
  }
  if (action === 'close-detail') {
    state.selectedTask = null;
    renderDetail();
    return;
  }
  if (action === 'copy-task-id') {
    copyTaskId(decodeURIComponent(target.dataset.taskId));
    return;
  }
  if (action === 'cancel') {
    openCancel(decodeURIComponent(target.dataset.taskId));
    return;
  }
  if (action === 'end-fleet') {
    openEndRun(decodeURIComponent(target.dataset.runId));
    return;
  }
  if (action === 'close-cancel') {
    closeCancel();
    return;
  }
  if (action === 'confirm-cancel') {
    confirmCancel();
    return;
  }
  if (action === 'history-dag-close') {
    state.historyDagRun = '';
    invalidateSig('historyDags');
    renderHistoryDags();
    return;
  }
  if (action === 'history-prev' || action === 'history-next') {
    state.historyPage = Math.max(0, state.historyPage + (action === 'history-next' ? 1 : -1));
    ui['history-list'].scrollTop = 0;
    invalidateSig('history');
    renderHistory();
    return;
  }
  if (action === 'clear-filters') {
    state.filters = { ...FILTER_DEFAULTS };
    state.historyPage = 0;
    invalidateSig('history');
    renderFilters();
    renderHistory();
    return;
  }
  if (action === 'goto-history') {
    state.activeView = 'history';
    renderViewState();
    // 与 view-tab 切页同语义：历史按页懒拉，进场立即补一轮
    refreshAll({ silent: true });
    return;
  }
  if (action === 'retry-connection') {
    refreshAll();
    return;
  }
}

function handleChange(event) {
  const id = event.target.id;
  if (id === 'monitor-project') {
    switchMonitorProject(event.target.value);
    return;
  }
  if (id === 'history-dag-select') {
    state.historyDagRun = event.target.value || '';
    invalidateSig('historyDags');
    renderHistoryDags();
    return;
  }
  if (id === 'filter-status') state.filters.status = event.target.value;
  if (id === 'filter-role') state.filters.role = event.target.value;
  if (id === 'filter-model') state.filters.model = event.target.value;
  if (id === 'filter-scope') state.filters.scope = event.target.value;
  if (id.startsWith('filter-')) {
    state.historyPage = 0;
    ui['history-list'].scrollTop = 0;
    invalidateSig('history');
    renderHeader();
    renderHistory();
  }
}

/** 窗口尺寸变化时只重画 DAG（连线坐标依赖布局），不动其它区域。 */
function installResizeRedraw() {
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      invalidateSig('inlineDag', 'historyDags');
      renderInlineDag();
      renderHistoryDags();
    }, 160);
  });
}

function startPolling() {
  if (state.fixtureMode) return;
  // 隐藏态不重排 timer：在途轮的 finally 可能在挂起后才 settle（sol 二轮复审 F-01）
  if (document.hidden) { pollSuspended = true; return; }
  clearTimeout(state.polling);
  state.polling = setTimeout(pollTick, 5000);
}

// 本轮 settle 后才排下一轮：单轮慢过 5 秒也不会叠加请求。页面隐藏时挂起——
// 观察型 UI 后台无人看，不发请求也不积累失败计数，恢复可见立即补一轮。
let pollSuspended = false;

function pollTick() {
  if (document.hidden) { pollSuspended = true; return; }
  Promise.all([refreshAll({ silent: true }), loadProjects()]).finally(startPolling);
}

// 隐藏事件立即挂起，不等下一次 tick 才发现：否则「隐藏→5s 内恢复」的窗口里
// pollSuspended 仍为 false，resumePolling 会空转，streak 不清、补拉不发（sol 复核 F-03）
function suspendPolling() {
  if (state.fixtureMode) return;
  pollSuspended = true;
  clearTimeout(state.polling);
}

function resumePolling() {
  if (state.fixtureMode || !pollSuspended || document.hidden) return;
  pollSuspended = false;
  refreshFailureStreak = 0; // 后台/睡眠期间的旧失败不继承，恢复后第一轮重新自证
  clearTimeout(state.polling);
  pollTick();
}

function syncSkyMotion() {
  document.body.classList.toggle('sky-paused', document.hidden || state.skyMotion !== 'on');
}

async function loadProjects() {
  const previous = JSON.stringify([state.projects, state.monitorRoot]);
  try {
    const payload = await fetchJson(API.projects);
    state.projects = Array.isArray(payload.projects) ? payload.projects : [];
    state.monitorRoot = payload.monitor_root || '';
  } catch {
    state.projects = [];
  }
  if (previous !== JSON.stringify([state.projects, state.monitorRoot])) renderProjectSwitch();
}

function renderProjectSwitch() {
  const select = ui['monitor-project'];
  if (!select) return;
  const current = state.monitorRoot;
  select.innerHTML = state.projects.map((item) => {
    const selected = item.selected || item.path === current ? ' selected' : '';
    const disabled = item.available ? '' : ' disabled';
    return `<option value="${escapeHtml(item.path)}"${selected}${disabled}>${escapeHtml(item.label)}</option>`;
  }).join('');
}

async function switchMonitorProject(next) {
  if (!next || next === state.monitorRoot) return;
  try {
    const payload = await fetchJson(API.monitorRoot, { method: 'PUT', body: JSON.stringify({ path: next }) });
    state.monitorRoot = payload.monitor_root || next;
    await refreshAll({ silent: false });
  } catch (error) {
    renderProjectSwitch();
    setConnection('error', '切换监控仓失败', error.body?.error?.message || error.message);
  }
}

function bootstrap() {
  cacheUi();
  syncSkyMotion();
  document.addEventListener('visibilitychange', () => {
    syncSkyMotion();
    if (document.hidden) suspendPolling(); else resumePolling();
  });
  document.addEventListener('click', handleClick);
  document.addEventListener('keydown', handleKeydown);
  document.addEventListener('change', handleChange);
  installResizeRedraw();
  const fixture = window.__AGENT_PANEL_DATA__;
  state.fixtureMode = Boolean(fixture);
  if (fixture) {
    setConnection('success', '夹具已载入', '当前页面使用显式浏览器夹具，不会发送取消请求。');
    applyEnvelope(fixture, fixture.errors || {});
    return;
  }
  renderAll();
  loadProjects();
  refreshAll();
  startPolling();
}

function updateSyncStatus(items) {
  state.sync.status = items;
  renderViewState();
}

const CONFIG_VIEWS = ['picks', 'res', 'import', 'models'];
const configPages = createConfigPages({
  roots: Object.fromEntries(CONFIG_VIEWS.map((view) => [view, document.getElementById(`${view}-view`)])),
  request: fetchJson, notify: showToast, updateSync: updateSyncStatus
});

bootstrap();
