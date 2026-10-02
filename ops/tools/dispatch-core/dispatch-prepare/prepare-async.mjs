import path from "node:path";

import {
  ROOT,
  ToolError,
  isRecord,
  lexicalAbsolute,
  pathlibJoin,
  rel,
} from "../_tool_common.mjs";
import { pyGetItem, pyRepr, pyStr, pyStrip, pyTruthy } from "../_py.mjs";
import { isStaticReview } from "../review_evidence.mjs";
import { renderTaskMaterialFile } from "../subagent_preload.mjs";
import { clampDisplayTitle } from "./batch-meta.mjs";
import { ASYNC_DISPATCH_CONTRACT_VERSION, PROJECT_ASYNC_TASK_ROOT } from "./constants.mjs";
import { _validTaskId, renderAsyncTaskPayload } from "./delivery.mjs";
import { deps } from "./deps.mjs";
import { isPyCaughtError, pyList } from "./py-utils.mjs";
import { lintOrFail } from "./seed.mjs";
import { resolveAsyncRuntimeOptions } from "./runtime.mjs";
import { markDispatchPhase } from "./state.mjs";
import { reviewExecutionProfile } from "./worker.mjs";

/** Compile once, verify once, and optionally submit the prepared dispatch. */
export function prepareAsyncSubagent(pkg, options = {}) {
  const {
    model = "",
    effort = "",
    pick = "",
    authorization = null,
    contextMode = "",
    runnerPath = "",
    taskRoot = "",
    targetCwd = "",
    executionProfile = "",
    stallSilenceMs = null,
    catalogCacheWrite = false,
    resolvedOptions = null,
    submitter = null,
    batchId = "",
    sliceId = "",
    displayTitle = "",
    action = "submit",
    originId = "",
    fast = undefined,
    reviewEvidenceBuilder = null,
    budget = null,
  } = options;
  let deferFinalRuntimeResolution = Boolean(options.deferFinalRuntimeResolution);
  const normalizedAction = pyStrip(pyStr(pyTruthy(action) ? action : "submit")).toLowerCase();
  if (!["prepare", "submit"].includes(normalizedAction)) {
    throw new ToolError(`async preparation does not support action=${pyRepr(normalizedAction)}`);
  }
  const taskPackage = pyGetItem(pkg, "task_package");
  const packageId = pyStr(pyTruthy(taskPackage.package_id) ? taskPackage.package_id : "");
  const staticReview = isStaticReview(taskPackage);
  deferFinalRuntimeResolution = Boolean(
    deferFinalRuntimeResolution || (staticReview && ["prepare", "submit"].includes(normalizedAction)),
  );
  let opts;
  if (deferFinalRuntimeResolution) {
    // A static-review call may receive an options envelope resolved before
    // evidence existed.  Keep only stable routing inputs for allocation and
    // final model/path recomputation; profile fields are never trusted
    // across the evidence boundary.
    const supplied = { ...(resolvedOptions || {}) };
    const selection = isRecord(supplied.model_selection) ? supplied.model_selection : {};
    const agentObject = isRecord(taskPackage.agent) ? taskPackage.agent : {};
    opts = {
      agent_type: pyStr(pyTruthy(supplied.agent_type)
        ? supplied.agent_type
        : (pyTruthy(agentObject.runtime_role) ? agentObject.runtime_role : (pyTruthy(agentObject.role) ? agentObject.role : ""))),
      executor: "pi",
      target_cwd: lexicalAbsolute(pyTruthy(targetCwd) ? targetCwd : (pyTruthy(supplied.target_cwd) ? supplied.target_cwd : ROOT)),
      task_root: lexicalAbsolute(pyTruthy(taskRoot) ? taskRoot : (pyTruthy(supplied.task_root) ? supplied.task_root : PROJECT_ASYNC_TASK_ROOT)),
      runner_path: pyTruthy(runnerPath) ? runnerPath : pyStr(pyTruthy(supplied.runner_path) ? supplied.runner_path : ""),
      model_selection: {
        primary_model: pyTruthy(model) ? model : pyStr(pyTruthy(selection.primary_model) ? selection.primary_model : ""),
        primary_effort: pyTruthy(effort) ? effort : pyStr(pyTruthy(selection.primary_effort) ? selection.primary_effort : ""),
      },
    };
  } else if (resolvedOptions !== null && resolvedOptions !== undefined) {
    opts = { ...resolvedOptions };
  } else {
    opts = resolveAsyncRuntimeOptions(taskPackage, {
      model,
      effort,
      pick,
      authorization,
      contextMode,
      runnerPath,
      taskRoot,
      targetCwd,
      executionProfile,
      stallSilenceMs,
      catalogCacheWrite,
      fast,
    });
  }

  const stableSelection = isRecord(opts.model_selection) ? opts.model_selection : {};
  const stableModel = pyTruthy(model) ? model : pyStr(pyTruthy(stableSelection.primary_model) ? stableSelection.primary_model : "");
  const stableEffort = pyTruthy(effort) ? effort : pyStr(pyTruthy(stableSelection.primary_effort) ? stableSelection.primary_effort : "");
  const stableRunnerPath = pyTruthy(runnerPath) ? runnerPath : pyStr(pyTruthy(opts.runner_path) ? opts.runner_path : "");
  const stableTaskRoot = pyTruthy(taskRoot) ? taskRoot : pyStr(pyTruthy(opts.task_root) ? opts.task_root : "");
  const stableTargetCwd = pyTruthy(targetCwd) ? targetCwd : pyStr(pyTruthy(opts.target_cwd) ? opts.target_cwd : "");

  const effectiveOriginId = pyStr(originId);

  const dispatchEnvelopeFor = (resolved) => {
    const selection = isRecord(resolved.model_selection) ? resolved.model_selection : {};
    return {
      contract_version: ASYNC_DISPATCH_CONTRACT_VERSION,
      // producer_root 是任务/临时状态归属根（项目本地），不是运行包根；运行资产由 entryDir/checker 策略解析。
      producer_root: String(ROOT),
      origin_thread_id: effectiveOriginId,
      target_cwd: String(pyTruthy(resolved.target_cwd) ? resolved.target_cwd : ROOT),
      task_file: "",
      task_root: String(pyTruthy(resolved.task_root) ? resolved.task_root : PROJECT_ASYNC_TASK_ROOT),
      runner_path: pyStr(pyTruthy(resolved.runner_path) ? resolved.runner_path : "") || null,
      runtime_role: pyStr(pyTruthy(resolved.agent_type) ? resolved.agent_type : ""),
      model: pyStr(pyTruthy(selection.primary_model) ? selection.primary_model : "") || null,
      effort: pyStr(pyTruthy(selection.primary_effort) ? selection.primary_effort : "") || null,
      ...(isRecord(selection.selection) ? { selection: selection.selection } : {}),
      context_mode: pyStr(pyTruthy(resolved.context_mode) ? resolved.context_mode : "project-aware"),
      execution_profile: pyStr(pyTruthy(resolved.execution_profile) ? resolved.execution_profile : "standard"),
      result_mode: pyStr(pyTruthy(resolved.result_mode) ? resolved.result_mode : "") || null,
      simulation: resolved.simulation_profile ?? null,
      stall_silence_ms: resolved.stall_silence_ms ?? null,
      // 种子 budget 经 prepareDispatch 传入；任务包本身不携带 budget。
      budget: isRecord(budget) && Object.keys(budget).length ? budget : (isRecord(taskPackage.budget) ? taskPackage.budget : {}),
      batch_id: pyTruthy(batchId) ? batchId : null,
      slice_id: pyTruthy(sliceId) ? sliceId : null,
      display_title: clampDisplayTitle(pyTruthy(displayTitle)
        ? displayTitle
        : pyStr(pyTruthy(taskPackage.goal) ? taskPackage.goal : packageId)),
    };
  };

  let dispatchEnvelope = deferFinalRuntimeResolution ? null : dispatchEnvelopeFor(opts);
  const reviewHolder = {};

  const buildTaskMaterial = (packagePath) => renderTaskMaterialFile(packagePath);

  const buildReviewEvidence = (materialRoot, _preparedPackage) => {
    if (reviewEvidenceBuilder !== null && reviewEvidenceBuilder !== undefined) {
      const value = reviewEvidenceBuilder(materialRoot, _preparedPackage);
      reviewHolder.value = value;
      return value;
    }
    const evidence = deps.attachReviewEvidence(pkg, {
      execute: true,
      outputPath: path.join(String(materialRoot), "review-evidence.json"),
    });
    reviewHolder.value = evidence;
    return { writes_performed: pyTruthy(evidence) ? ["review-evidence.json"] : [] };
  };

  // Only static-review packages need the owned evidence writer during compile.
  const shouldWriteEvidence = isStaticReview(taskPackage);

  const finalizeAfterEvidence = (_materialRoot, _preparedPackage) => {
    opts = resolveAsyncRuntimeOptions(taskPackage, {
      model: stableModel,
      effort: stableEffort,
      pick,
      authorization,
      contextMode,
      runnerPath: stableRunnerPath,
      taskRoot: stableTaskRoot,
      targetCwd: stableTargetCwd,
      executionProfile,
      stallSilenceMs,
      // 该回调只在 prepare/submit 路径执行：允许文件层落盘。
      catalogCacheWrite: true,
      fast,
    });
    // The package has been changed by evidence; lint and envelope construction
    // are intentionally after that callback and before task rendering.
    lintOrFail(pkg);
    dispatchEnvelope = dispatchEnvelopeFor(opts);
    return { runtime_options: opts, dispatch_envelope: dispatchEnvelope };
  };

  let descriptor;
  try {
    const selection = isRecord(opts.model_selection) ? opts.model_selection : null;
    descriptor = deps.compilePreparedDispatch(pkg, {
      producerRoot: ROOT,
      resolvedRuntimeOptions: {
        ...opts,
        runtime_role: pyStr(pyTruthy(opts.agent_type) ? opts.agent_type : ""),
        model: selection ? pyStr(pyTruthy(selection.primary_model) ? selection.primary_model : "") : "",
        effort: selection ? pyStr(pyTruthy(selection.primary_effort) ? selection.primary_effort : "") : "",
        runner_path: pyStr(pyTruthy(opts.runner_path) ? opts.runner_path : ""),
        batch_id: pyTruthy(batchId) ? batchId : null,
        slice_id: pyTruthy(sliceId) ? sliceId : null,
        display_title: clampDisplayTitle(pyTruthy(displayTitle)
          ? displayTitle
          : pyStr(pyTruthy(taskPackage.goal) ? taskPackage.goal : packageId)),
      },
      dispatchEnvelope,
      taskMaterialBuilder: buildTaskMaterial,
      reviewEvidenceBuilder: shouldWriteEvidence ? buildReviewEvidence : null,
      postMaterialCallback: deferFinalRuntimeResolution ? finalizeAfterEvidence : null,
      originId: effectiveOriginId,
      batchId: pyTruthy(batchId) ? batchId : null,
      sliceId: pyTruthy(sliceId) ? sliceId : null,
      displayTitle: clampDisplayTitle(pyTruthy(displayTitle)
        ? displayTitle
        : pyStr(pyTruthy(taskPackage.goal) ? taskPackage.goal : packageId)),
    });
  } catch (error) {
    if (isPyCaughtError(error, new Set(["PreparedDispatchError", "OSError", "ValueError"]))) {
      throw new ToolError(`prepared dispatch compilation failed: ${error.message}`);
    }
    throw error;
  }
  let verifiedDescriptor;
  try {
    verifiedDescriptor = deps.verifyPreparedDispatch(pyGetItem(descriptor, "descriptor_file"));
  } catch (error) {
    if (isPyCaughtError(error, new Set(["PreparedDispatchError", "OSError", "ValueError"]))) {
      throw new ToolError(`prepared dispatch verification failed: ${error.message}`);
    }
    throw error;
  }
  const agentType = pyStr(pyTruthy(opts.agent_type) ? opts.agent_type : "");
  const effectiveExecutionProfile = pyStr(pyTruthy(opts.execution_profile) ? opts.execution_profile : "standard");
  const effectiveContextMode = pyStr(pyTruthy(opts.context_mode) ? opts.context_mode : "project-aware");
  const effectiveTaskRoot = String(pyGetItem(opts, "task_root"));
  const resultMode = pyStr(pyTruthy(opts.result_mode) ? opts.result_mode : "");
  const modelSelection = { ...(pyTruthy(opts.model_selection) ? opts.model_selection : {}) };
  const primaryModel = pyStr(pyTruthy(modelSelection.primary_model) ? modelSelection.primary_model : "");
  const primaryEffort = pyStr(pyTruthy(modelSelection.primary_effort) ? modelSelection.primary_effort : "");
  const packagePath = String(pyGetItem(verifiedDescriptor, "package_file"));
  const taskMaterialPath = String(pyGetItem(verifiedDescriptor, "task_file"));
  const dispatchEnvelopePath = String(pyGetItem(verifiedDescriptor, "dispatch_file"));
  const baseResult = {
    status: "ok",
    action: normalizedAction,
    delivery_mode: "async_subagent",
    batch_id: pyTruthy(batchId) ? batchId : null,
    slice_id: pyTruthy(sliceId) ? sliceId : null,
    display_title: clampDisplayTitle(pyTruthy(displayTitle)
      ? displayTitle
      : pyStr(pyTruthy(taskPackage.goal) ? taskPackage.goal : packageId)),
    origin_thread_id: pyTruthy(effectiveOriginId) ? effectiveOriginId : null,
    dispatch_contract_version: ASYNC_DISPATCH_CONTRACT_VERSION,
    package_id: packageId,
    agent_type: agentType,
    executor: "pi",
    task_package_path: rel(packagePath),
    task_material_path: rel(taskMaterialPath),
    dispatch_envelope_path: rel(dispatchEnvelopePath),
    package_file: verifiedDescriptor.package_file,
    task_file: verifiedDescriptor.task_file,
    dispatch_file: verifiedDescriptor.dispatch_file,
    descriptor_file: verifiedDescriptor.descriptor_file,
    preparation_id: verifiedDescriptor.preparation_id,
    material_root: verifiedDescriptor.material_root,
    descriptor: verifiedDescriptor,
    writes_performed: [...pyList(pyTruthy(verifiedDescriptor.writes_performed) ? verifiedDescriptor.writes_performed : [])],
    tool_allowlist: opts.tool_allowlist ?? null,
    tool_allowlist_source: pyStr(pyTruthy(opts.tool_allowlist_source) ? opts.tool_allowlist_source : ""),
    context_mode: effectiveContextMode,
    review_execution_profile: reviewExecutionProfile(taskPackage) || null,
    execution_profile: effectiveExecutionProfile,
    result_mode: resultMode || null,
    async_model_selection: modelSelection,
    ...(opts.warnings?.length ? { warnings: opts.warnings } : {}),
    model: primaryModel,
    effort: primaryEffort,
    fast: taskPackage.runtime_context?.fast === true,
  };
  if (normalizedAction === "prepare") baseResult.state = "prepared";
  if (reviewHolder.value !== undefined && reviewHolder.value !== null) {
    baseResult.review_evidence = reviewHolder.value;
  }
  if (normalizedAction === "prepare") return baseResult;

  markDispatchPhase("submit");
  const submit = submitter || deps.callAsyncInternalAdapter;
  // Exactly one selected transport invocation; no retry path exists here.
  const receipt = submit("submit-prepared", { dispatch_file: verifiedDescriptor.dispatch_file });
  if (!isRecord(receipt)) throw new ToolError("async transport returned a malformed receipt; task_id is ambiguous");
  const rawTaskId = receipt.task_id;
  const taskId = typeof rawTaskId === "string" ? rawTaskId : "";
  if (!_validTaskId(taskId)) {
    throw new ToolError("async transport returned an empty or malformed task_id; task submission is ambiguous");
  }
  const taskDir = pathlibJoin(effectiveTaskRoot, taskId);
  Object.assign(baseResult, {
    task_id: taskId,
    task_dir: String(taskDir),
    status_path: String(path.join(taskDir, "status.json")),
    handoff_path: String(path.join(taskDir, "handoff.md")),
    report_path: String(path.join(taskDir, "report.md")),
    wait_tool_arguments: { task_id: taskId, timeout_ms: 60000 },
    get_tool_arguments: { task_ids: [taskId], detail: "compact" },
    result_tool_arguments: { task_id: taskId },
    spawn_payload: renderAsyncTaskPayload(packagePath, taskId),
  });
  return baseResult;
}
