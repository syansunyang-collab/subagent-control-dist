const CONTROL_UI_VERSION = "0.1.0";

const ACTIONS = Object.freeze([
  { name: "status", label: "查看状态", readOnly: true },
  { name: "review", label: "查看待复核项", readOnly: true },
  { name: "cancel", label: "取消任务", readOnly: false },
]);

function text(value, fallback = "unknown") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTask(task, index) {
  const item = task && typeof task === "object" ? task : {};
  return {
    id: text(item.id, `task-${index + 1}`),
    state: text(item.transportState),
    contractState: text(item.contractState, "n/a"),
    requested: item.requested ?? null,
    actual: item.actual ?? null,
    reason: item.reason ?? null,
  };
}

function countStates(tasks) {
  return tasks.reduce((counts, task) => {
    counts[task.state] = (counts[task.state] ?? 0) + 1;
    return counts;
  }, {});
}

/**
 * Convert a controller snapshot into a dependency-free, JSON-serializable UI model.
 * The UI owns presentation only; task truth and lifecycle remain in the controller.
 */
export function buildControlUiModel(snapshot = {}) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const tasks = list(source.tasks ?? source.results).map(normalizeTask);
  return {
    version: CONTROL_UI_VERSION,
    title: "Subagent Control",
    batchState: text(source.batchState ?? source.state),
    counts: countStates(tasks),
    tasks,
    actions: ACTIONS.map((action) => ({ ...action })),
  };
}

/**
 * Render the model as stable plain text for Pi command output and smoke tests.
 */
export function renderControlUi(snapshot = {}) {
  const model = buildControlUiModel(snapshot);
  const lines = [
    `${model.title} v${model.version}`,
    `批次状态：${model.batchState}`,
    `任务数：${model.tasks.length}`,
  ];
  for (const task of model.tasks) {
    const contract = task.contractState === "n/a" ? "" : `，合同=${task.contractState}`;
    const reason = task.reason ? `，原因=${text(task.reason)}` : "";
    lines.push(`- ${task.id}：${task.state}${contract}${reason}`);
  }
  lines.push(`可用动作：${model.actions.map((action) => action.name).join("、")}`);
  return lines.join("\n");
}

export { ACTIONS as CONTROL_UI_ACTIONS, CONTROL_UI_VERSION };
