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
import { existsSync } from "node:fs";
import path from "node:path";
import { uptime } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  RUNTIME_ROOT,
  ToolError,
  emit,
  loadJson as readJson,
  rel,
  resolveLikePython,
  utcNow,
} from "./_tool_common.mjs";
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
  nodeWriteScope,
  pathConflict,
  topologicalLayers,
  validateManifest,
} from "./fleet_manifest_check.mjs";
import { monotonicSeconds, sleepSeconds } from "./fleet/py-utils.mjs";
import { processAliveImpl } from "./fleet/locks.mjs";
import { asyncInternalBatchImpl, runCommandImpl } from "./fleet/async-runtime.mjs";
import { dispatchNodeImpl } from "./fleet/dispatch.mjs";
import { launchDriverImpl } from "./fleet/driver.mjs";
import { deps } from "./fleet/deps.mjs";
import { hostPaths } from "./fleet/host-paths.mjs";

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

export {
  DEFAULT_STATE_ROOT,
  DEFAULT_ASYNC_TASK_ROOT,
  TERMINAL_STATES,
  ASYNC_TERMINAL_STATES,
  ACTIVE_STATES,
  FAILED_DEPENDENCY_STATES,
  SUMMARY_NODE_LIMIT,
  SUMMARY_EVENT_LIMIT,
  SAFE_ID_RE,
  INITIAL_LIVENESS_GRACE_SECONDS,
  RUN_LOCK_TIMEOUT_SECONDS,
  LIVENESS_RECHECK_SECONDS,
  DISPATCH_PREPARE_TIMEOUT_SECONDS,
  MAX_RUNTIME_EVIDENCE_BYTES,
  MAX_RUNTIME_USAGE_VALUE,
  RUNTIME_USAGE_FIELDS,
  ROUTE_KEYS,
} from "./fleet/constants.mjs";

export {
  utcAfter,
  livenessCheckDue,
  deferLivenessCheck,
  safeId,
  writeJson,
  requireRepoInternal,
  stateRoot,
  runDir,
  statePath,
  manifestSnapshotPath,
  seedPath,
  dependencyResultIndexPath,
  driverStatusPath,
  driverLogPath,
  runLockPath,
} from "./fleet/paths.mjs";

export {
  runMutationLock,
  acquireRunLock,
  acquireRunLockAsync,
  releaseRunLock,
  processAlive,
} from "./fleet/locks.mjs";

export {
  newRouteRecord,
  ensureRouteRecord,
  routeSnapshot,
  frozenRequestedRoute,
  updateRouteFromPayload,
  routeMatchesManifest,
  normalizeDispatchOverrides,
} from "./fleet/route.mjs";

export {
  createInitialState,
  indexNodes,
  appendFleetEvent,
  setNodeState,
  setFailureFuse,
  rebuildReadyQueue,
  startRun,
} from "./fleet/state.mjs";

export {
  runCommand,
  parseJsonStdout,
  nodeTaskRoot,
  asyncCompletionInbox,
  enrichTerminalRouteFromRuntime,
  applyAsyncStatus,
  readCompletionNotices,
  compactCompletionNotice,
  waitForCompletionNotices,
  asyncInternalBatch,
  refreshActiveNodes,
} from "./fleet/async-runtime.mjs";

export {
  ACCEPTANCE_RESULTS_BLOCK,
  acceptanceLeafExpectedIds,
  acceptanceResultsBlockIssue,
  enforceAcceptanceResultsGate,
  downstreamCounts,
  dependenciesReady,
  blockedByFailedDependency,
  registerAllSettledConsumers,
  releaseResolvedDependencyBlocks,
} from "./fleet/dag.mjs";

export { reviewEvidencePath, appendReviewRecord, reviewRun, reviewRunLocked } from "./fleet/review.mjs";

export {
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
} from "./fleet/admission.mjs";

export {
  commandNodeCwd,
  commandNodeEnv,
  executeCommandNode,
  openGateNode,
  dispatchNode,
  compactDispatchOutcome,
} from "./fleet/dispatch.mjs";

export { settleFleetIfNeeded, cancellationPath, cancelRun, settleCancellation } from "./fleet/cancel.mjs";

export { pauseRequestPath, readPauseIntent, settlePause, pauseRun } from "./fleet/pause.mjs";

export {
  tickRun,
  tickRunLocked,
  waitRun,
  resumeRun,
  driverOutcome,
  writeDriverStatus,
  driveRun,
  launchDriver,
  launchDriverLocked,
} from "./fleet/driver.mjs";

export {
  stateCounts,
  shortText,
  compactNode,
  compactEvent,
  loadManifestSnapshotForStatus,
  orderedPendingIds,
  nextReadySummary,
  buildStatusSummary,
  formatStatusSummary,
  statusRun,
} from "./fleet/summary.mjs";

export { positiveInt as _positiveInt } from "./fleet/py-utils.mjs";

const SCHEDULER_CLI_PATH = process.argv[1] && /^fleet_scheduler(?:\.bundle)?\.mjs$/.test(path.basename(process.argv[1]))
  ? path.resolve(process.argv[1])
  : path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "fleet_scheduler.mjs");
const DISPATCH_PREPARE_PATH = existsSync(path.join(RUNTIME_ROOT, "ops/dist/dispatch_prepare.bundle.mjs"))
  ? path.join(RUNTIME_ROOT, "ops/dist/dispatch_prepare.bundle.mjs")
  : path.join(RUNTIME_ROOT, "ops/tools/dispatch_prepare.mjs");
const ASYNC_SERVICE_PATH = existsSync(path.join(RUNTIME_ROOT, "ops/tools/subagent_service.mjs"))
  ? path.join(RUNTIME_ROOT, "ops/tools/subagent_service.mjs")
  : path.join(RUNTIME_ROOT, "ops/dist/subagent_service.bundle.mjs");
hostPaths.SCHEDULER_CLI_PATH = SCHEDULER_CLI_PATH;
hostPaths.DISPATCH_PREPARE_PATH = DISPATCH_PREPARE_PATH;
hostPaths.ASYNC_SERVICE_PATH = ASYNC_SERVICE_PATH;

/** pytest / 行为测试里被替换的模块级名字集中于此。 */
Object.assign(deps, {
  runCommand: runCommandImpl,
  asyncInternalBatch: asyncInternalBatchImpl,
  processAlive: processAliveImpl,
  bootTimeMs: () => Date.now() - Math.round(uptime() * 1000),
  dispatchNode: dispatchNodeImpl,
  launchDriver: launchDriverImpl,
  spawnDriver: spawn,
  sleep: sleepSeconds,
  monotonic: monotonicSeconds,
});

export { deps };

export async function selfTest() {
  const { selfTest: run } = await import("../fleet_scheduler.selftest.mjs");
  return run();
}
