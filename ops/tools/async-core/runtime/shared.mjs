function cloneValue(value) {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const RETAINED_WORKER_ERROR_CODE = "ASYNC_TASK_WORKER_RETAINED";
const PROCESS_TREE_CONFIRMATION_MARKER_CODE = "ASYNC_TASK_PROCESS_TREE";
const PROCESS_TREE_TERMINATION_UNCONFIRMED_REASON = "process_tree_termination_unconfirmed";
// 主机启动时刻比任务创建晚出这么多，才把整棵进程树按随上一启动周期消失处理；吸收 uptime 的秒级取整。
const HOST_REBOOT_MARGIN_MS = 5000;
const REVISION_CONFLICT_NEXT_STEP = "read the current revision with get and retry cancel with that revision";
const RESUME_REVISION_CONFLICT_NEXT_STEP = "read the current revision with subagent_get and retry subagent_resume";
// 子代理静默检测：live 静默超过 task.stall_silence_ms 即写 status.stall 并投递 <task_id>.stall.json，
// 有新事件即清除。只叫醒主代理，不改运输态、不取消、不猜死因。0 表示关闭。
const STALL_SILENCE_DEFAULT_MS = 600000;
const STALL_CHECK_INTERVAL_MAX_MS = 15000;
// 每个 attempt 的 runner 全程时限（--timeoutMs）缺省值：任务未给 budget.max_elapsed_minutes 时使用。
// 只防失控；超过 90 分钟的合法长任务在种子里显式设置 budget.max_elapsed_minutes。
// 时钟随 runner 进程起算，续跑/回退/暂停后恢复都是新 attempt、重新计时。
const DEFAULT_ATTEMPT_ELAPSED_LIMIT_MINUTES = 90;
// worker 持有取消截止时间，短命 CLI 返回后仍会执行兜底。
// 30 秒覆盖 runner 的 abort/settled（12 秒）与 EOF/TERM（各 5 秒）收尾窗口。
const CANCEL_FORCE_CLEANUP_MS = 30000;
const WORKER_START_ROLLBACK_INCOMPLETE_ERROR_CODE = "ASYNC_TASK_WORKER_ROLLBACK_INCOMPLETE";
// salvage 报告已退役；字段在状态与回执契约面保位，取值恒为该常量。
const RETIRED_SALVAGE_REPORT_PATH = null;

// Preserve the runner's path for diagnostics; resume checks file availability.
function reportedSessionFile(childResult) {
  const file = childResult?.session?.file;
  return typeof file === "string" && file.trim() ? file.trim() : null;
}

// A terminal-looking record is not safe to release while the persisted process-tree
// marker has not been explicitly confirmed.  Top-PID death and a Boolean termination
// request are deliberately not confirmation.
function isUnconfirmedRetainedProcessTree(status) {
  const marker = status?.retained_marker;
  const markerPresent = Boolean(
    marker && typeof marker === "object" && !Array.isArray(marker) && (
      Object.hasOwn(marker, "termination_confirmed")
      || marker.scope === "process_tree"
      || marker.code === RETAINED_WORKER_ERROR_CODE
      || marker.code === PROCESS_TREE_CONFIRMATION_MARKER_CODE
    ),
  );
  return (status?.retained_worker === true || markerPresent)
    && marker?.termination_confirmed !== true;
}

function annotateInternalError(error, metadata) {
  Object.assign(error, metadata);
  return error;
}


export {
  cloneValue,
  deepFreeze,
  RETAINED_WORKER_ERROR_CODE,
  PROCESS_TREE_CONFIRMATION_MARKER_CODE,
  PROCESS_TREE_TERMINATION_UNCONFIRMED_REASON,
  HOST_REBOOT_MARGIN_MS,
  REVISION_CONFLICT_NEXT_STEP,
  RESUME_REVISION_CONFLICT_NEXT_STEP,
  STALL_SILENCE_DEFAULT_MS,
  STALL_CHECK_INTERVAL_MAX_MS,
  DEFAULT_ATTEMPT_ELAPSED_LIMIT_MINUTES,
  CANCEL_FORCE_CLEANUP_MS,
  WORKER_START_ROLLBACK_INCOMPLETE_ERROR_CODE,
  RETIRED_SALVAGE_REPORT_PATH,
  reportedSessionFile,
  isUnconfirmedRetainedProcessTree,
  annotateInternalError,
};
