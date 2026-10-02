import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { BUILD_LOG_PATH } from "../agent_panel_launcher.mjs";
import { loadSelectionConfig } from "../model_selection.mjs";
import { pyGetItem, pySamePath, pyStr, pyStrip, pyTruthy } from "../_py.mjs";
import { isStaticReview } from "../review_evidence.mjs";
import { exampleSeed, expandSeed } from "../seed_minimal.mjs";
import { readRequiredFiles, roleDeveloperInstructions } from "../subagent_preload.mjs";
import { buildPackage, gitValue } from "../task_package_build.mjs";
import {
  ROOT,
  RUNTIME_ROOT,
  ToolError,
  isRecord,
  modelConfigSources,
  resolveLikePython,
} from "../_tool_common.mjs";
import { loadWorkerResourcesConfig } from "../../pi_worker_resources.mjs";
import { clampDisplayTitle, makeBatchId, sliceMetadata } from "./batch-meta.mjs";
import { deps } from "./deps.mjs";
import { prepareDirect } from "./delivery.mjs";
import { prepareAsyncSubagent } from "./prepare-async.mjs";
import { isPyCaughtError, pyList, pySlice } from "./py-utils.mjs";
import { resolveAsyncRuntimeOptions } from "./runtime.mjs";
import { batchWriteConflicts, lintOrFail, seedBudget } from "./seed.mjs";
import {
  computeScopePreflight,
  enforceScopePreflight,
  preflightReadPaths,
  readScopeLayersFromSeed,
  renderReadScopeLayers,
} from "./scope.mjs";
import { dispatchPhaseState, markDispatchPhase } from "./state.mjs";
import { applyRoleWorkerResources, projectConditionalRequiredFiles } from "./worker.mjs";

export function taskPackageOutputSummary(taskPackage) {
  const expected = isRecord(taskPackage?.expected_output) ? taskPackage.expected_output : {};
  const handoff = isRecord(taskPackage?.handoff_contract) ? taskPackage.handoff_contract : {};
  const scope = isRecord(taskPackage?.scope) ? taskPackage.scope : {};
  const scopeWrite = [];
  for (const item of pyList(Object.hasOwn(scope, "write") ? scope.write : [])) {
    if (typeof item === "string" && !scopeWrite.includes(item)) scopeWrite.push(item);
  }
  const expectedCandidates = ["resolved_file_path", "file_path", "path"]
    .filter((key) => pyTruthy(expected[key]))
    .map((key) => pyStr(pyTruthy(expected[key]) ? expected[key] : ""));
  const handoffCandidates = ["resolved_handoff_file", "handoff_file"]
    .filter((key) => pyTruthy(handoff[key]))
    .map((key) => pyStr(pyTruthy(handoff[key]) ? handoff[key] : ""));
  const declared = new Set([...expectedCandidates, ...handoffCandidates].map((item) => item.split("\\").join("/")));
  const extraWrites = scopeWrite.filter((item) => !declared.has(item.split("\\").join("/")));
  let note = null;
  if (extraWrites.length) {
    note = "scope.write_extra entries are additional allowed writes; they do not override "
      + "expected_output.file_path. Set expected_output.file_path/resolved_file_path "
      + "explicitly when a reducer or report must land at a specific path.";
  }
  return {
    expected_report_path: expectedCandidates.length ? expectedCandidates[0] : null,
    expected_handoff_path: handoffCandidates.length ? handoffCandidates[0] : null,
    expected_output: expected,
    handoff_contract: handoff,
    scope_write: scopeWrite,
    extra_write_paths: extraWrites,
    write_extra_note: note,
  };
}

export function prepareDryRun(pkg, delivery, resolvedDelivery, readiness, resolvedOptions = null) {
  const taskPackage = pyGetItem(pkg, "task_package");
  readRequiredFiles(taskPackage);
  roleDeveloperInstructions(taskPackage);
  const packageId = pyStr(pyTruthy(taskPackage.package_id) ? taskPackage.package_id : "");
  const agent = isRecord(taskPackage.agent) ? taskPackage.agent : {};
  const agentType = pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : (pyTruthy(agent.role) ? agent.role : ""));
  const wouldDeliveryMap = { "async-subagent": "async_subagent", direct: "direct_message" };
  const result = {
    status: "ok",
    dry_run: true,
    delivery_mode: `${delivery}_dry_run`,
    resolved_delivery: resolvedDelivery,
    would_delivery_mode: Object.hasOwn(wouldDeliveryMap, resolvedDelivery) ? wouldDeliveryMap[resolvedDelivery] : resolvedDelivery,
    delivery_readiness: readiness,
    package_id: packageId,
    agent_type: agentType,
    business_output: taskPackageOutputSummary(taskPackage),
    spawn_payload: "DRY_RUN_ONLY: no async task or dispatch payload registered; rerun with --action prepare/submit after dispatch is authorized",
    writes_performed: [],
  };
  if (resolvedOptions !== null && resolvedOptions !== undefined) {
    // 预览将写入 envelope 的双轨字段，键值口径与 prepare_async_subagent 的 dispatch_envelope 一致。
    const selection = isRecord(resolvedOptions.model_selection) ? resolvedOptions.model_selection : {};
    result.async_preview = {
      executor: resolvedOptions.executor ?? null,
      fast: resolvedOptions.fast === true,
      runner_path: pyStr(pyTruthy(resolvedOptions.runner_path) ? resolvedOptions.runner_path : "") || null,
      model: pyStr(pyTruthy(selection.primary_model) ? selection.primary_model : "") || null,
      effort: pyStr(pyTruthy(selection.primary_effort) ? selection.primary_effort : "") || null,
      model_source: selection.model_source ?? null,
      effort_source: selection.effort_source ?? null,
      child_model: selection.child_model ?? null,
      ...(isRecord(selection.selection) ? { selection: selection.selection } : {}),
    };
  }
  return result;
}

export function normalizeDispatchAction(action = "") {
  const requested = pyStrip(pyStr(pyTruthy(action) ? action : "")).toLowerCase();
  if (requested && !["preview", "prepare", "submit"].includes(requested)) {
    throw new ToolError("action must be one of preview, prepare, submit");
  }
  return requested || "submit";
}

/** The legacy Codex adapter is the only layer allowed to read this env value. */
export function legacyOriginId() {
  return String(process.env.CODEX_THREAD_ID || "");
}

export function prepareDispatch(seed, delivery, options = {}) {
  const {
    action = "",
    asyncModel = "",
    asyncEffort = "",
    fast = undefined,
    asyncPick = "",
    asyncAuthorization = null,
    asyncContextMode = "",
    asyncRunnerPath = "",
    asyncTaskRoot = "",
    asyncTargetCwd = "",
    asyncExecutionProfile = "",
    asyncStallSilenceMs = null,
    asyncBatchId = "",
    asyncSliceId = "",
    asyncDisplayTitle = "",
    asyncSubmitter = null,
    originId = null,
  } = options;
  markDispatchPhase("seed");
  const normalizedAction = normalizeDispatchAction(action);
  const preview = normalizedAction === "preview";
  if (asyncTargetCwd) {
    const targetRepo = String(resolveLikePython(asyncTargetCwd));
    const runtimeContext = { ...(seed.runtime_context ?? {}), target_repo: targetRepo };
    // 子代理在目标树里运行：执行目录与 git 快照取目标树；报告与 handoff 仍按 output_root 落在发起方仓。
    if (!pySamePath(targetRepo, resolveLikePython(ROOT))) {
      runtimeContext.cwd ??= targetRepo;
      runtimeContext.git ??= {
        branch: gitValue(["branch", "--show-current"], "(unknown)", targetRepo),
        head: gitValue(["rev-parse", "--short=12", "HEAD"], "(unknown)", targetRepo),
      };
    }
    seed = { ...seed, runtime_context: runtimeContext };
  }
  const pkg = buildPackage(seed);
  markDispatchPhase("lint");
  projectConditionalRequiredFiles(pyGetItem(pkg, "task_package"));
  lintOrFail(pkg);
  const compiledTask = pyGetItem(pkg, "task_package");
  compiledTask.extensions.model_config = { global_root: modelConfigSources().global_root, project_root: ROOT };
  const importedResources = loadWorkerResourcesConfig(path.join(RUNTIME_ROOT, "ops", "templates", "worker-resources.json"));
  applyRoleWorkerResources(compiledTask, loadSelectionConfig(modelConfigSources()), importedResources);
  const resourceSnapshot = {
    tools: importedResources.tools, extensions: importedResources.extensions,
    skills: importedResources.skills, required_tools: importedResources.required_tools,
  };
  compiledTask.extensions.resource_config_fingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(resourceSnapshot)).digest("hex")}`;
  markDispatchPhase("compile");

  // Prepare and an explicitly async preview compile against the async contract without
  // consulting a transport. Default auto preview still reports live readiness for CLI users.
  let resolvedDelivery;
  let readiness;
  if (normalizedAction === "prepare" || (preview && delivery === "async-subagent")) {
    resolvedDelivery = "async-subagent";
    readiness = { status: "not_checked", issues: [] };
  } else {
    [resolvedDelivery, readiness] = deps.resolveDelivery(delivery);
  }

  const staticReview = isStaticReview(pyGetItem(pkg, "task_package"));
  const deferFinalRuntimeResolution = resolvedDelivery === "async-subagent"
    && ["prepare", "submit"].includes(normalizedAction)
    && staticReview;
  const reviewEvidence = preview ? deps.attachReviewEvidence(pkg, { execute: false }) : null;
  let resolvedAsyncOptions = null;
  if (["preview", "prepare", "submit"].includes(normalizedAction)
    && resolvedDelivery === "async-subagent"
    && !deferFinalRuntimeResolution) {
    resolvedAsyncOptions = resolveAsyncRuntimeOptions(pyGetItem(pkg, "task_package"), {
      model: asyncModel,
      effort: asyncEffort,
      fast,
      pick: asyncPick,
      authorization: asyncAuthorization,
      contextMode: asyncContextMode,
      runnerPath: asyncRunnerPath,
      taskRoot: asyncTaskRoot,
      targetCwd: asyncTargetCwd,
      executionProfile: asyncExecutionProfile,
      stallSilenceMs: asyncStallSilenceMs,
      // preview 只读；prepare/submit 才允许文件层落盘。
      catalogCacheWrite: normalizedAction !== "preview",
    });
    const effectiveTarget = resolveLikePython(pyGetItem(resolvedAsyncOptions, "target_cwd"));
    if (!pySamePath(effectiveTarget, resolveLikePython(ROOT))) {
      const taskPackage = pyGetItem(pkg, "task_package");
      taskPackage.runtime_context.target_repo = String(effectiveTarget);
      lintOrFail(pkg);
    }
  }

  // A7：分层读作用域——把 read_scope_layers 落进任务包（渲染进任务书），preflight 只算 entry+index。
  const layers = readScopeLayersFromSeed(seed);
  if (layers !== null) pyGetItem(pkg, "task_package").read_scope_layers = layers;
  const scopePreflightBase = asyncTargetCwd
    ? resolveLikePython(asyncTargetCwd)
    : (resolvedAsyncOptions !== null ? resolveLikePython(String(pyGetItem(resolvedAsyncOptions, "target_cwd"))) : ROOT);
  const scopePreflight = computeScopePreflight(
    preflightReadPaths(layers, pyGetItem(pyGetItem(pyGetItem(pkg, "task_package"), "scope"), "read")),
    { baseRoot: scopePreflightBase },
  );
  const scopeDiagnostics = enforceScopePreflight(scopePreflight);
  pyGetItem(pkg, "task_package").scope_preflight = scopePreflight;
  if (scopeDiagnostics.length) {
    pyGetItem(pkg, "task_package").known_facts.push(...scopeDiagnostics);
  }
  const budget = seedBudget(seed);

  const annotate = (result) => {
    if (!Object.hasOwn(result, "action")) result.action = normalizedAction;
    result.scope_preflight = scopePreflight;
    result.business_output = taskPackageOutputSummary(pyGetItem(pkg, "task_package"));
    result.fast = pyGetItem(pkg, "task_package").runtime_context?.fast === true;
    const warnings = [...new Set([
      ...scopeDiagnostics, ...(result.warnings || []), ...(resolvedAsyncOptions?.warnings || []),
      result.async_model_selection?.child_model?.warning,
      resolvedAsyncOptions?.model_selection?.child_model?.warning,
    ].filter(Boolean))];
    if (warnings.length) result.warnings = warnings;
    if (asyncBatchId) {
      result.batch_id = asyncBatchId;
      result.slice_id = asyncSliceId;
    }
    result.display_title = clampDisplayTitle(asyncDisplayTitle || sliceMetadata(seed, 0)[1]);
    if (layers !== null) {
      result.read_scope_layers = layers;
      result.read_scope_layers_directive = renderReadScopeLayers(layers);
    }
    if (pyTruthy(budget)) {
      result.budget = budget;
      // max_elapsed_minutes 由 runner 按 attempt 执行（未给时缺省 90 分钟）。
      result.budget_enforcement = { max_elapsed_minutes: "enforced_per_attempt" };
    }
    if (preview && reviewEvidence !== null && reviewEvidence !== undefined) {
      result.review_evidence = reviewEvidence;
    }
    return result;
  };

  if (preview) return annotate(prepareDryRun(pkg, delivery, resolvedDelivery, readiness, resolvedAsyncOptions));
  let result;
  if (resolvedDelivery === "async-subagent") {
    result = prepareAsyncSubagent(pkg, {
      model: asyncModel,
      effort: asyncEffort,
      fast,
      pick: asyncPick,
      authorization: asyncAuthorization,
      contextMode: asyncContextMode,
      runnerPath: asyncRunnerPath,
      taskRoot: asyncTaskRoot,
      targetCwd: asyncTargetCwd,
      executionProfile: asyncExecutionProfile,
      stallSilenceMs: asyncStallSilenceMs,
      budget,
      catalogCacheWrite: normalizedAction !== "preview",
      resolvedOptions: resolvedAsyncOptions,
      submitter: asyncSubmitter,
      batchId: asyncBatchId,
      sliceId: asyncSliceId,
      displayTitle: asyncDisplayTitle,
      action: normalizedAction,
      deferFinalRuntimeResolution,
      originId: (normalizedAction === "prepare" && (originId === null || originId === undefined))
        ? ""
        : ((originId === null || originId === undefined) ? legacyOriginId() : pyStr(originId)),
    });
  } else if (resolvedDelivery === "direct") {
    throw new ToolError("direct subagent dispatch is disabled; use --delivery auto/async-subagent so dispatch goes through MCP async");
  } else if (resolvedDelivery === "unavailable") {
    const issues = pyList(pyTruthy(readiness?.issues) ? readiness.issues : []).join("; ");
    throw new ToolError(`async subagent MCP dispatch unavailable; subagent dispatch not submitted: ${issues || "unknown readiness issue"}`);
  } else {
    throw new ToolError(`unknown delivery: ${resolvedDelivery}`);
  }
  annotate(result);
  result.requested_delivery = delivery;
  result.resolved_delivery = resolvedDelivery;
  result.delivery_readiness = readiness;
  return result;
}

/**
 * 逐 seed try/except：一个 seed 失败不丢失其它已提交结果；整体 status=partial 时
 * dispatches 里同时含成功项（带 task_id）和失败项（带 seed_index/phase/error）。
 * 写冲突只阻断参与者，独立 seed 继续提交；冲突索引由 failed_seed_indexes 返回。
 * 失败项的 phase 与 error 前缀给出阶段坐标：seed | lint | compile | submit。
 */
export function prepareBatchDispatch(seeds, delivery, options = {}) {
  const { batchId = "", ...kwargs } = options;
  const batchAction = normalizeDispatchAction(pyStr(pyTruthy(kwargs.action) ? kwargs.action : ""));
  const resolvedBatchId = pySlice(pyStrip(String(batchId ?? "")) || makeBatchId(seeds), 120);
  const conflicts = batchWriteConflicts(seeds);
  const conflictIndexes = new Set(conflicts.flatMap((item) => [
    Number(item.left_seed_index), Number(item.right_seed_index),
  ]));
  const dispatches = [];
  const failedIndexes = [];
  seeds.forEach((seed, idx) => {
    const [currentSliceId, currentTitle] = sliceMetadata(seed, idx);
    if (conflictIndexes.has(idx + 1)) {
      failedIndexes.push(idx + 1);
      dispatches.push({
        status: "failed",
        seed_index: idx + 1,
        phase: "seed",
        batch_id: resolvedBatchId,
        slice_id: currentSliceId,
        display_title: currentTitle,
        error: "batch write conflict preflight failed",
      });
      return;
    }
    const previousSeedIndex = dispatchPhaseState.seedIndex;
    dispatchPhaseState.seedIndex = idx + 1;
    try {
      const outcome = prepareDispatch(seed, delivery, {
        ...kwargs,
        asyncBatchId: resolvedBatchId,
        asyncSliceId: currentSliceId,
        asyncDisplayTitle: currentTitle,
      });
      dispatches.push(outcome);
    } catch (error) {
      if (!isPyCaughtError(error, new Set(["ToolError", "KeyError", "ValueError", "OSError"]))) {
        dispatchPhaseState.seedIndex = previousSeedIndex;
        throw error;
      }
      failedIndexes.push(idx + 1);
      const phase = dispatchPhaseState.phase;
      dispatches.push({
        status: "failed",
        seed_index: idx + 1,
        phase,
        batch_id: resolvedBatchId,
        slice_id: currentSliceId,
        display_title: currentTitle,
        error: `[${phase}] ${error.message}`,
      });
    } finally {
      dispatchPhaseState.seedIndex = previousSeedIndex;
    }
  });
  const committedTaskIds = dispatches.filter((item) => item.status === "ok" && pyTruthy(item.task_id)).map((item) => item.task_id);
  return {
    status: conflicts.length && conflictIndexes.size === seeds.length ? "failed" : (failedIndexes.length ? "partial" : "ok"),
    action: batchAction,
    batch_id: resolvedBatchId,
    count: dispatches.length,
    dispatches,
    failed_seed_indexes: failedIndexes,
    not_submitted_seed_indexes: [],
    committed_task_ids: committedTaskIds,
    ...(conflicts.length ? { batch_write_conflicts: conflicts } : {}),
  };
}

/** Python 的 ensure 形参在 JS 侧是 async（agent_panel_launcher.ensureAgentPanel 为 async），故本函数返回 Promise。 */
export async function attachAgentPanelLaunch(result, { dryRun, ensure = null } = {}) {
  const ensureFn = ensure || deps.ensureAgentPanel;
  if (dryRun) return result;
  let taskIds = [...pyList(pyTruthy(result?.committed_task_ids) ? result.committed_task_ids : [])];
  if (result?.status === "ok"
    && result?.action !== "prepare"
    && result?.delivery_mode === "async_subagent"
    && pyTruthy(result?.task_id)) {
    taskIds = [pyStr(pyGetItem(result, "task_id"))];
  }
  if (!taskIds.length) return result;
  try {
    result.agent_panel_launch = await ensureFn();
  } catch (error) {
    // UI failure is diagnostic only; submitted tasks keep their successful receipt.
    result.agent_panel_launch = {
      status: "failed",
      error: String(error?.message ?? error),
      log_path: BUILD_LOG_PATH,
    };
  }
  return result;
}

export function agentPanelLaunchText(result) {
  const launch = isRecord(result?.agent_panel_launch) ? result.agent_panel_launch : null;
  if (!pyTruthy(launch)) return "";
  const status = pyStr(pyTruthy(launch.status) ? launch.status : "unknown");
  if (status === "failed") {
    return `\n\nAgent Panel 启动失败（不影响已提交任务）：${pyTruthy(launch.error) ? launch.error : "查看 launcher 日志"}`;
  }
  return `\n\nAgent Panel：${status}`;
}

export function checkRouteCard(routeId) {
  const pkg = buildPackage(expandSeed(exampleSeed(routeId)));
  projectConditionalRequiredFiles(pyGetItem(pkg, "task_package"));
  lintOrFail(pkg);
  return null;
}

export function prepareDirectPreview(seed, { asyncModel = "" } = {}) {
  const pkg = buildPackage(seed);
  projectConditionalRequiredFiles(pyGetItem(pkg, "task_package"));
  lintOrFail(pkg);
  return prepareDirect(pkg);
}
