import path from "node:path";

import {
  ROOT,
  ToolError,
  isRecord,
  modelConfigSources,
  resolveLikePython,
} from "../_tool_common.mjs";
import { pyIsRelativeTo, pySamePath, pyStr, pyStrip, pyTruthy } from "../_py.mjs";
import { loadSelectionConfig, resolveSelection } from "../model_selection.mjs";
import {
  PROFILE as EVIDENCE_ONLY_PROFILE,
  SEMANTIC_PROFILE as SEMANTIC_REVIEW_PROFILE,
  isStaticReview,
} from "../review_evidence.mjs";
import { truthyText } from "../task_package_build.mjs";
import { requirePiChildModel } from "./catalog.mjs";
import {
  ACCEPTANCE_SYNTHESIS_PROFILE,
  CROSS_REPO_RESULT_MODES,
  PI_ASYNC_RUNNER_SENTINEL,
} from "./constants.mjs";
import { isDirectory, isFile, sortedStrings } from "./py-utils.mjs";
import { reviewExecutionProfile, taskToolAllowlist } from "./worker.mjs";

function resolveFromPicks(agentType, capability, options = {}) {
  const selection = resolveSelection(loadSelectionConfig(modelConfigSources()), {
    role: agentType,
    capability,
    pick: options.pick || null,
    model: options.model || null,
    effort: options.effort || null,
    authorization: options.authorization || null,
  });
  return {
    agent_type: agentType,
    executor: "pi",
    primary_model: selection.resolved_model,
    primary_effort: selection.resolved_effort,
    model_source: selection.requested.model ? "cli" : (selection.requested.pick ? "pick" : "agent_config"),
    effort_source: selection.effort_source === "explicit" ? "cli" : selection.effort_source,
    selection,
  };
}

/** Resolve one role's requested model from the same role picks used by dispatch. */
export function resolveRoleModelSelection(agentTypeRaw, modelOverride, effortOverride, capability = "", options = {}) {
  const agentType = pyStrip(pyStr(pyTruthy(agentTypeRaw) ? agentTypeRaw : ""));
  if (!agentType) throw new ToolError("invalid runtime role: (empty)");
  const capabilityId = pyStrip(pyStr(pyTruthy(capability) ? capability : ""));
  if (!capabilityId) throw new ToolError(`selection requires capability for role ${agentType}`);
  return resolveFromPicks(agentType, capabilityId, {
    model: modelOverride,
    effort: effortOverride,
    pick: options.pick,
    authorization: options.authorization,
  });
}

export function resolveAsyncModelSelection(taskPackage, modelOverride, effortOverride, extra = {}) {
  const agent = isRecord(taskPackage?.agent) ? taskPackage.agent : {};
  const agentType = pyStrip(pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : (pyTruthy(agent.role) ? agent.role : "")));
  const capability = isRecord(agent.capability) ? pyStrip(pyStr(pyTruthy(agent.capability.name) ? agent.capability.name : "")) : "";
  return resolveRoleModelSelection(agentType, modelOverride, effortOverride, capability, extra);
}

export function resolveAsyncRuntimeOptions(taskPackage, options = {}) {
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
    fast = taskPackage?.runtime_context?.fast === true,
  } = options;
  if (fast === true) {
    taskPackage.runtime_context ??= {};
    taskPackage.runtime_context.fast = true;
  } else if (taskPackage.runtime_context) {
    delete taskPackage.runtime_context.fast;
  }
  const agent = isRecord(taskPackage?.agent) ? taskPackage.agent : {};
  const resolvedToolAllowlist = taskToolAllowlist(taskPackage);
  const warnings = [];
  const reviewNeedsNetwork = truthyText(taskPackage?.runtime_context?.network_needed);
  let reviewProfile = reviewExecutionProfile(taskPackage);
  if (reviewProfile === EVIDENCE_ONLY_PROFILE && reviewNeedsNetwork) {
    reviewProfile = "evidence_assisted_v1";
    taskPackage.extensions.review_execution.profile = reviewProfile;
  }
  const evidenceOnly = reviewProfile === EVIDENCE_ONLY_PROFILE;
  const semanticReview = reviewProfile === SEMANTIC_REVIEW_PROFILE;
  const acceptanceSynthesis = reviewProfile === ACCEPTANCE_SYNTHESIS_PROFILE;
  const networkReview = reviewNeedsNetwork && (reviewProfile === "evidence_assisted_v1" || isStaticReview(taskPackage));
  if (networkReview && !semanticReview && !acceptanceSynthesis) warnings.push("network_needed=yes：使用evidence_assisted_v1；工具按声明或Pi配置提供，不自动追加取证工具。");
  let effectiveExecutionProfile = evidenceOnly
    ? EVIDENCE_ONLY_PROFILE
    : (pyTruthy(executionProfile) ? executionProfile : "standard");
  if (!["standard", "simulation", EVIDENCE_ONLY_PROFILE].includes(effectiveExecutionProfile)) {
    throw new ToolError(`unsupported async execution_profile: ${effectiveExecutionProfile}`);
  }
  const effectiveTargetCwd = resolveLikePython(pyTruthy(targetCwd) ? targetCwd : ROOT);
  if (!isDirectory(effectiveTargetCwd)) throw new ToolError(`async target_cwd does not exist: ${effectiveTargetCwd}`);
  const controllerRuntime = resolveLikePython(path.join(ROOT, ".runtime"));
  const effectiveTaskRoot = resolveLikePython(
    pyTruthy(taskRoot) ? taskRoot : path.join(controllerRuntime, "cockpit", "async_tasks"),
  );
  if (!pyIsRelativeTo(effectiveTaskRoot, controllerRuntime)) {
    throw new ToolError("async task_root must stay inside the controller repository .runtime");
  }
  let effectiveRunnerPath = "";
  // 未显式覆盖 runner 时发裸 basename 哨兵，由服务端解析为其部署形态内的可信 runner
  // （身份门覆盖执行体，存在性由服务端在提交边界 fail-closed）；显式路径仍走本地存在性校验通路。
  const requestedRunnerPath = pyTruthy(runnerPath) ? runnerPath : PI_ASYNC_RUNNER_SENTINEL;
  if (requestedRunnerPath === PI_ASYNC_RUNNER_SENTINEL) {
    effectiveRunnerPath = requestedRunnerPath;
  } else if (pyTruthy(requestedRunnerPath)) {
    effectiveRunnerPath = String(resolveLikePython(requestedRunnerPath));
    if (!isFile(effectiveRunnerPath)) throw new ToolError(`async runner does not exist: ${effectiveRunnerPath}`);
  }
  const extensions = isRecord(taskPackage?.extensions) ? taskPackage.extensions : {};
  const crossRepo = isRecord(extensions.cross_repo_acceptance) ? extensions.cross_repo_acceptance : {};
  let resultMode = pyStr(pyTruthy(crossRepo.result_mode) ? crossRepo.result_mode : "");
  if (resultMode && !CROSS_REPO_RESULT_MODES.has(resultMode)) {
    throw new ToolError(
      "extensions.cross_repo_acceptance.result_mode must be one of "
      + sortedStrings(CROSS_REPO_RESULT_MODES).join(" | "),
    );
  }
  if (!pySamePath(effectiveTargetCwd, resolveLikePython(ROOT)) && !resultMode) {
    // 报告与 handoff 之外声明了写域即为跨仓实施；只写这两份产物才是只读审计。
    const outputs = new Set([taskPackage?.expected_output?.file_path, taskPackage?.handoff_contract?.handoff_file]
      .filter(Boolean).map((item) => String(resolveLikePython(item))));
    const businessWrites = (taskPackage?.scope?.write ?? []).filter((item) => !outputs.has(String(resolveLikePython(item))));
    resultMode = businessWrites.length ? "real_rerun" : "read_only_audit";
    crossRepo.result_mode = resultMode;
    extensions.cross_repo_acceptance = crossRepo;
    taskPackage.extensions = extensions;
    warnings.push(businessWrites.length
      ? "跨仓result_mode按业务写域缺省为real_rerun；只读审计时显式选择read_only_audit。"
      : "跨仓result_mode缺省为read_only_audit：写域只有报告与handoff；需要实施业务改动时在scope.write_extra声明写域。");
  }
  if (resultMode === "simulated_planning" && effectiveExecutionProfile !== "simulation") {
    warnings.push(`result_mode=simulated_planning：execution_profile由${effectiveExecutionProfile}推导为simulation。`);
    effectiveExecutionProfile = "simulation";
  }
  let simulationProfile = null;
  if (effectiveExecutionProfile === "simulation") {
    const simulation = isRecord(crossRepo.simulation) ? crossRepo.simulation : {};
    const role = pyStrip(pyStr(pyTruthy(simulation.role) ? simulation.role : ""));
    const persona = simulation.persona;
    if (resultMode !== "simulated_planning" || !role || !isRecord(persona) || !pyTruthy(persona)) {
      throw new ToolError(
        "simulation requires result_mode=simulated_planning and non-empty "
        + "extensions.cross_repo_acceptance.simulation.role/persona",
      );
    }
    simulationProfile = { role, persona: structuredClone(persona) };
  }
  const modelSelection = resolveAsyncModelSelection(taskPackage, model, effort, { pick, authorization });
  if (modelSelection.selection && extensions.resource_config_fingerprint) {
    modelSelection.selection.config_source = {
      ...modelSelection.selection.config_source,
      resource_config_fingerprint: extensions.resource_config_fingerprint,
    };
  }
  // 最终请求已在本次解析中校验；此后不得改 effort。
  // Production dispatch uses the bare sentinel and is always checked. Explicit runner paths are
  // custom/test seams; their model catalog belongs to that runner and is not inferred here.
  const usesDefaultPiRunner = requestedRunnerPath === PI_ASYNC_RUNNER_SENTINEL;
  // 文件层只由 prepare/submit 落盘；preview、list 与直接调用保持只读。
  const catalogProbeOptions = { cacheWrite: Boolean(catalogCacheWrite) };
  const webExtension = { status: "configured_resources", source: "Pi user configuration" };
  if (usesDefaultPiRunner) {
    modelSelection.child_model = requirePiChildModel(
      pyStr(pyTruthy(modelSelection.primary_model) ? modelSelection.primary_model : ""),
      effectiveTargetCwd,
      catalogProbeOptions,
    );
  } else {
    modelSelection.child_model = { status: "not_checked", source: "custom_runner" };
  }
  return {
    agent_type: pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : (pyTruthy(agent.role) ? agent.role : "")),
    executor: "pi",
    fast: fast === true,
    execution_profile: effectiveExecutionProfile,
    context_mode: evidenceOnly ? "isolated" : (pyTruthy(contextMode) ? contextMode : "project-aware"),
    runner_path: effectiveRunnerPath,
    target_cwd: effectiveTargetCwd,
    task_root: effectiveTaskRoot,
    result_mode: resultMode,
    simulation_profile: simulationProfile,
    ...(warnings.length ? { warnings } : {}),
    tool_allowlist: resolvedToolAllowlist,
    tool_allowlist_source: resolvedToolAllowlist === null ? "pi_configured_tools" : "task_package.tool_contract.allowed",
    web_extension: webExtension,
    model_selection: modelSelection,
    stall_silence_ms: stallSilenceMs,
  };
}
