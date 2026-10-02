// ops/tools/dispatch_prepare.py 的 JS 复刻：派发编译器的编排层。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」；导出函数名为 Python 名的 camelCase，
// Python 关键字参数作为末尾一个 options 对象（键名 camelCase）。
//
// 异常映射表（Python 分支 → JS）：
//   ToolError(msg)                      → ToolError(msg)，消息逐字
//   PreparedDispatchError               → PreparedDispatchError（prepared_dispatch.mjs 导出），
//                                         prepare_async_subagent 内按 Python 同样收束为 ToolError
//   json.JSONDecodeError                → pyJsonLoads 抛出的 name="JSONDecodeError" 错误，
//                                         load_seeds / call_async_internal_adapter 按 Python 收束为 ToolError
//   KeyError（package["task_package"] 等裸下标） → pyGetItem 抛出的 name="KeyError"，message 是键的 repr
//   OSError（读文件 / 子进程启动失败）   → Node 系统错误（error.code/errno），批量与 CLI 顶层按
//                                         Python 的 except 元组一并捕获（isPyCaughtError）
//   UnicodeDecodeError（--seed 文件解码） → 与 Python 同分支收束为 ToolError，文案逐字
//   subprocess.TimeoutExpired           → spawnSync 的 ETIMEDOUT，收束为 Python 对应的 ToolError 文案
//
// 注入面：pytest 里被 monkeypatch 的模块级名字集中在导出的可变对象 `deps`；
// lru_cache 用模块级 Map，统一由 clearCaches() 清空。

import { ensureAgentPanel } from "./agent_panel_launcher.mjs";
import {
  compilePreparedDispatch,
  verifyPreparedDispatch,
} from "./prepared_dispatch.mjs";
import { attachReviewEvidence } from "./review_evidence.mjs";
import {
  piChildCatalogCommandImpl,
  piChildModelExtensionProfileImpl,
  probePiChildModelCatalogImpl,
  probePiChildModelCatalogUncachedImpl,
} from "./dispatch-prepare/catalog.mjs";
import {
  asyncSubagentReadinessImpl,
  callAsyncInternalAdapterImpl,
  resolveDeliveryImpl,
} from "./dispatch-prepare/delivery.mjs";
import { deps } from "./dispatch-prepare/deps.mjs";
import {
  asyncSubagentEndpointImpl,
  asyncSubagentServerImpl,
} from "./dispatch-prepare/server.mjs";
import { walkDir } from "./dispatch-prepare/scope.mjs";
import { agentConfigEntryImpl } from "./dispatch-prepare/worker.mjs";

// ---- 注入面与缓存 ----

Object.assign(deps, {
  globalConfigPath: null,
  ensureAgentPanel,
  walk: walkDir,
  agentConfigEntry: agentConfigEntryImpl,
  piChildCatalogCommand: piChildCatalogCommandImpl,
  piChildModelExtensionProfile: piChildModelExtensionProfileImpl,
  probePiChildModelCatalogUncached: probePiChildModelCatalogUncachedImpl,
  probePiChildModelCatalog: probePiChildModelCatalogImpl,
  callAsyncInternalAdapter: callAsyncInternalAdapterImpl,
  asyncSubagentServer: asyncSubagentServerImpl,
  asyncSubagentEndpoint: asyncSubagentEndpointImpl,
  asyncSubagentReadiness: asyncSubagentReadinessImpl,
  resolveDelivery: resolveDeliveryImpl,
  compilePreparedDispatch,
  verifyPreparedDispatch,
  attachReviewEvidence,
});

export { deps };

export { truthyText, buildPackage, parseSeed, sampleSeed } from "./task_package_build.mjs";
export {
  DISPATCH_CONTRACT_VERSION as PREPARED_DISPATCH_CONTRACT_VERSION,
  PreparedDispatchError,
  compilePreparedDispatch,
  verifyPreparedDispatch,
} from "./prepared_dispatch.mjs";
export {
  PROFILE as EVIDENCE_ONLY_PROFILE,
  SEMANTIC_PROFILE as SEMANTIC_REVIEW_PROFILE,
  attachReviewEvidence,
  isStaticReview,
} from "./review_evidence.mjs";
export {
  ROOT,
  RUNTIME_ROOT,
  ToolError,
  emit,
  readStdinText,
  rel,
} from "./_tool_common.mjs";
export {
  cardFor,
  exampleSeed,
  expandSeed,
  listCards,
  profileFor,
  renderTemplate,
  routesWithCards,
} from "./seed_minimal.mjs";
export { renderTaskMaterialFile } from "./subagent_preload.mjs";
export { lintPackage } from "./task_package_lint.mjs";
export { conditionalRequiredFiles, routeIdFromAgent } from "./task_package_profiles.mjs";

export {
  ACCEPTANCE_SYNTHESIS_PROFILE,
  ASYNC_DISPATCH_CONTRACT_VERSION,
  ASYNC_MCP_SERVER_NAME,
  CROSS_REPO_RESULT_MODES,
  GLOBAL_CONFIG_PATH,
  PI_ASYNC_RUNNER_SENTINEL,
  PREFLIGHT_BINARY_LIKE_EXTENSIONS,
  PREFLIGHT_BYTES_THRESHOLD,
  PREFLIGHT_FILE_THRESHOLD,
  PREFLIGHT_GIT_TIMEOUT_SECONDS,
  PREFLIGHT_LARGE_FILE_BYTES,
  PREFLIGHT_STAT_FILE_CAP,
  PREFLIGHT_WALK_SKIP_DIRS,
  PREFLIGHT_WALK_SKIP_PATHS,
  PROJECT_ASYNC_TASK_ROOT,
} from "./dispatch-prepare/constants.mjs";

export {
  clearCaches,
  clearModelCatalogCache,
  currentDispatchPhase,
  markDispatchPhase,
} from "./dispatch-prepare/state.mjs";

export {
  _serverFromConfig,
  asyncServerEnv,
  asyncServerScriptPath,
  asyncSubagentEndpoint,
  asyncSubagentServer,
  defaultRegistryRoot,
  loadToml,
  selectAsyncSubagentServer,
} from "./dispatch-prepare/server.mjs";

export {
  computeScopePreflight,
  enforceScopePreflight,
  preflightReadPaths,
  readScopeLayersFromSeed,
  renderReadScopeLayers,
  walkDir,
} from "./dispatch-prepare/scope.mjs";

export {
  batchWriteConflicts,
  conflictPaths,
  expandDispatchSeed,
  lintOrFail,
  loadSeeds,
  packagePathForTemp,
  readSeedFileText,
  seedBudget,
  seedWriteConflictPaths,
} from "./dispatch-prepare/seed.mjs";

export {
  _validTaskId,
  ValidTaskId,
  asyncDispatchContractStatus,
  asyncSubagentReadiness,
  callAsyncInternalAdapter,
  prepareDirect,
  renderAsyncTaskPayload,
  renderDirectFileRefPayload,
  resolveDelivery,
  resolveDeliveryWithReadiness,
} from "./dispatch-prepare/delivery.mjs";

export {
  agentConfigEntry,
  applyRoleWorkerResources,
  projectConditionalRequiredFiles,
  reviewExecutionProfile,
  taskToolAllowlist,
} from "./dispatch-prepare/worker.mjs";

export {
  _probePiChildModelCatalogUncached,
  piChildCatalogCommand,
  piChildModelExtensionProfile,
  probePiChildModelCatalog,
  requirePiChildModel,
} from "./dispatch-prepare/catalog.mjs";

export {
  resolveAsyncModelSelection,
  resolveAsyncRuntimeOptions,
  resolveRoleModelSelection,
} from "./dispatch-prepare/runtime.mjs";

export { prepareAsyncSubagent } from "./dispatch-prepare/prepare-async.mjs";
export { clampDisplayTitle, makeBatchId, sliceMetadata } from "./dispatch-prepare/batch-meta.mjs";

export {
  agentPanelLaunchText,
  attachAgentPanelLaunch,
  checkRouteCard,
  legacyOriginId,
  normalizeDispatchAction,
  prepareBatchDispatch,
  prepareDirectPreview,
  prepareDispatch,
  prepareDryRun,
  taskPackageOutputSummary,
} from "./dispatch-prepare/dispatch-run.mjs";

/** Python 的 `import dispatch_prepare_selftest` 延迟导入：JS 侧用动态 import 避免循环依赖。 */
export async function selfTest() {
  const selftest = await import("../dispatch_prepare.selftest.mjs");
  return selftest.selfTest();
}


// ---- CLI 支撑（ops/tools/dispatch_prepare.mjs 使用） ----

export { isPyCaughtError, jsonDumpsIndent2, pyList, pySlice, shutilWhich } from "./dispatch-prepare/py-utils.mjs";
