#!/usr/bin/env node
// dispatch_prepare 的机械自测实现（ops/tools/dispatch_prepare_selftest.py 的移植），
// 经 node ops/tools/dispatch_prepare.mjs --self-test 调用。checks 键名与 true/false 语义与 Python 逐条一致。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import * as dp from "./dispatch-core/dispatch_prepare.mjs";
import { validatePlannerMechanicalSchema } from "./dispatch-core/seed_minimal.mjs";
import { pyIsRelativeTo, pyJsonLoads } from "./dispatch-core/_py.mjs";
import { modelConfigSources } from "./dispatch-core/_tool_common.mjs";
import { loadSelectionConfig, projectCatalog, resolveSelection } from "./dispatch-core/model_selection.mjs";

const { ROOT, ToolError, deps } = dp;

// 自测目录覆盖全部推荐行当前引用的模型：角色卡可编辑，目录跟着走，不写死模型名。
const selectionConfig = loadSelectionConfig(modelConfigSources());
const configuredModels = [...new Set([...selectionConfig.roles.values()].flatMap((role) => role.picks.map((pick) => pick.model)))].sort();

export const SELF_TEST_CHILD_CATALOG = {
  status: "ok",
  models: configuredModels,
  model_count: configuredModels.length,
  source: "dispatch_prepare self-test child catalog",
  error: null,
};

function timeNs() {
  return `${BigInt(Date.now()) * 1000000n + (process.hrtime.bigint() % 1000000n)}`;
}

function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDir(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readText(target) {
  return readFileSync(target, "utf8");
}

function deepEqual(left, right) {
  return JSON.stringify(dpCanonical(left)) === JSON.stringify(dpCanonical(right));
}

function dpCanonical(value) {
  if (Array.isArray(value)) return value.map(dpCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, dpCanonical(value[key])]));
  }
  return value;
}


/** 替身只在本函数内接管探测实现；退出（含异常）自动还原并清空缓存。 */
export function selfTest() {
  const original = deps.probePiChildModelCatalogUncached;
  deps.probePiChildModelCatalogUncached = () => structuredClone(SELF_TEST_CHILD_CATALOG);
  dp.clearModelCatalogCache();
  try {
    return runSelfTestChecks();
  } finally {
    deps.probePiChildModelCatalogUncached = original;
    dp.clearModelCatalogCache();
  }
}

function runSelfTestChecks() {
  const seed = dp.sampleSeed("general-agent__general-default");
  const tempPaths = [];
  const isolatedSubmissions = [];
  const catalog = projectCatalog(selectionConfig, { piModels: configuredModels });
  const resolveFor = (role, capability, options = {}) => resolveSelection(selectionConfig, { role, capability, ...options });
  // 每个角色、每个任务类型的适用推荐行都按行解析：模型与档位取自行本身。
  const everyPickResolvesToItsRow = catalog.roles.every((role) => role.capabilities.every((capability) => projectCatalog(selectionConfig, {
    role: role.role, capability: capability.id,
  }).roles[0].picks.every((pick) => {
    const resolved = resolveFor(role.role, capability.id, { pick: pick.id });
    return resolved.resolved_model === pick.model && resolved.resolved_effort === pick.effort
      && resolved.effort_range.join() === [pick.effort_min, pick.effort_max].join();
  })));

  const isolatedSubmitter = (operation, args) => {
    if (operation !== "submit-prepared") throw new ToolError(`unsupported self-test adapter operation: ${operation}`);
    const dispatchFile = path.resolve(String(args?.dispatch_file || ""));
    const controlledRoot = path.resolve(path.join(ROOT, "tmp", "dispatch_prepare"));
    if (!pyIsRelativeTo(dispatchFile, controlledRoot)) {
      throw new ToolError("self-test dispatch envelope escaped tmp/dispatch_prepare");
    }
    const envelope = pyJsonLoads(readText(dispatchFile));
    if (envelope.contract_version !== dp.ASYNC_DISPATCH_CONTRACT_VERSION) {
      throw new ToolError("self-test dispatch envelope contract mismatch");
    }
    isolatedSubmissions.push(dispatchFile);
    return { ok: true, task_id: `async-self-test-${String(isolatedSubmissions.length).padStart(2, "0")}` };
  };

  const asyncRoot = path.join(ROOT, ".runtime", "self-tests", `dispatch-prepare-async-${timeNs()}`);
  const fakeRunner = path.join(asyncRoot, "run-pi-task.mjs");
  mkdirSync(path.dirname(fakeRunner), { recursive: true });
  writeFileSync(fakeRunner, [
    "import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "function value(name, fallback='') { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; }",
    "const outDir = value('--outDir');",
    "const taskFile = value('--taskFile');",
    "mkdirSync(outDir, { recursive: true });",
    "const taskText = readFileSync(taskFile, 'utf8');",
    "writeFileSync(path.join(outDir, 'report.md'), '# fake async dispatch report\\n\\n' + taskText.slice(0, 200) + '\\n', 'utf8');",
    "writeFileSync(path.join(outDir, 'handoff.md'), 'verdict: done\\nsummary: fake async dispatch completed.\\nfiles_read_or_changed:\\n  - report.md\\nevidence_paths:\\n  - report.md\\nblockers:\\n  - none\\n', 'utf8');",
    "writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\npass\\n', 'utf8');",
    "writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'done' }, null, 2), 'utf8');",
  ].join("\n"), "utf8");

  // Compile against the existing fixture, not a sample project's src/main.py.
  seed.scope.read = [String(fakeRunner)];
  const direct = dp.prepareDirectPreview(seed);
  if (direct.task_package_path) tempPaths.push(path.join(ROOT, String(direct.task_package_path)));
  const renderedDirect = dp.renderTaskMaterialFile(path.join(ROOT, String(direct.task_package_path)));
  const dryDirect = dp.prepareDispatch(seed, "direct", { action: "preview" });
  const explicitAsyncPreview = dp.prepareDispatch(seed, "async-subagent", { action: "preview" });
  const outputVisibilitySeed = dp.exampleSeed("general-agent__general-default");
  if (!outputVisibilitySeed.scope) outputVisibilitySeed.scope = {};
  outputVisibilitySeed.scope.read = [String(fakeRunner)];
  if (!outputVisibilitySeed.scope.write_extra) outputVisibilitySeed.scope.write_extra = [];
  outputVisibilitySeed.scope.write_extra.push("notes/reports/dispatch-output-visibility-self-test.md");
  const outputVisibilityDry = dp.prepareDispatch(dp.expandSeed(outputVisibilitySeed), "direct", { action: "preview" });
  const scopeWriteDedupeSeed = dp.exampleSeed("general-agent__general-default");
  scopeWriteDedupeSeed.slug = "dispatch-scope-write-dedupe-self-test";
  if (!scopeWriteDedupeSeed.scope) scopeWriteDedupeSeed.scope = {};
  scopeWriteDedupeSeed.scope.read = [String(fakeRunner)];
  if (!scopeWriteDedupeSeed.scope.write_extra) scopeWriteDedupeSeed.scope.write_extra = [];
  scopeWriteDedupeSeed.scope.write_extra.push("notes/general/dispatch-scope-write-dedupe-self-test.md");
  const scopeWriteDedupeDry = dp.prepareDispatch(dp.expandSeed(scopeWriteDedupeSeed), "direct", { action: "preview" });
  const scopeWriteDedupePaths = (scopeWriteDedupeDry.business_output || {}).scope_write || [];
  const explorerTemplate = dp.renderTemplate("explorer-agent__codebase-scan");
  let directRuntimeBlocked = false;
  try {
    dp.prepareDispatch(seed, "direct");
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    directRuntimeBlocked = String(error.message).includes("direct subagent dispatch is disabled");
  }
  const dispatchTmp = path.join(ROOT, "tmp", "dispatch_prepare");
  const evidenceTmp = path.join(ROOT, "tmp", "review_evidence");
  const fileNames = (dir) => (existsSync(dir)
    ? new Set(readdirSync(dir).filter((name) => isFile(path.join(dir, name))))
    : new Set());
  const sameNames = (left, right) => left.size === right.size && [...left].every((name) => right.has(name));
  const beforeInvalidRoot = fileNames(dispatchTmp);
  const beforeInvalidEvidence = fileNames(evidenceTmp);
  const invalidRootSeed = dp.expandSeed(dp.exampleSeed("verify-agent__code-verification"));
  invalidRootSeed.scope.read = ["ops/tools/dispatch_prepare.mjs"];
  let invalidRootRejectedBeforeWrite = false;
  try {
    dp.prepareDispatch(invalidRootSeed, "async-subagent", {
      asyncRunnerPath: fakeRunner,
      asyncTaskRoot: path.join(path.dirname(ROOT), "outside-runtime"),
    });
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    invalidRootRejectedBeforeWrite = String(error.message).includes("task_root must stay inside")
      && sameNames(beforeInvalidRoot, fileNames(dispatchTmp))
      && sameNames(beforeInvalidEvidence, fileNames(evidenceTmp));
  }
  // 覆盖探针使用 child 模型目录中的真模型。
  const asyncDispatch = dp.prepareDispatch(seed, "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: isolatedSubmitter,
  });
  const auto = dp.prepareDispatch(seed, "auto", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: isolatedSubmitter,
  });
  const readiness = dp.asyncSubagentReadiness();
  const [endpointServer, endpointTool] = dp.asyncSubagentEndpoint();
  const staleContractStatus = dp.asyncDispatchContractStatus({ dispatch_contract_version: "async-dispatch/v1" });
  const compatibleContractStatus = dp.asyncDispatchContractStatus({
    dispatch_contract_version: dp.ASYNC_DISPATCH_CONTRACT_VERSION,
    supported_dispatch_contract_versions: ["async-dispatch/v1", dp.ASYNC_DISPATCH_CONTRACT_VERSION],
  });
  const [staleDelivery] = dp.resolveDeliveryWithReadiness(
    "async-subagent",
    { status: "unavailable", issues: [String(staleContractStatus.issue)] },
  );
  const checks = {
    list_roles_unique: catalog.roles.length > 0 && new Set(catalog.roles.map((row) => row.role)).size === catalog.roles.length,
    list_picks_have_ranges: catalog.roles.every((row) => row.picks.every((pick) => pick.id && pick.model && pick.effort_min && pick.effort_max)),
    list_phase_metadata_present: catalog.roles.every((row) => row.capabilities.every((cap) => cap.dispatch_phase?.kind)),
    list_models_have_efforts: catalog.models.every((row) => row.model && row.efforts.length > 0),
    list_picks_are_in_pi_catalog: catalog.warnings.length === 0,
    every_pick_resolves_to_its_row: everyPickResolvesToItsRow,
    direct_ok: direct.status === "ok",
    direct_mode: direct.delivery_mode === "direct_message",
    direct_file_ref_mode: direct.direct_payload_mode === "file_ref",
    direct_package_persisted: Boolean(direct.task_package_path) && isFile(path.join(ROOT, String(direct.task_package_path))),
    direct_spawn_has_file_marker: direct.spawn_payload.includes("DIRECT_TASK_PACKAGE_FILE:"),
    direct_spawn_has_render_command: direct.spawn_payload.includes("subagent_preload.mjs render --package"),
    direct_spawn_omits_inline_material: !direct.spawn_payload.includes("## 任务包"),
    async_ok: asyncDispatch.status === "ok",
    async_mode: asyncDispatch.delivery_mode === "async_subagent",
    async_has_task_id: Boolean(asyncDispatch.task_id),
    async_has_wait_tool_arguments: (asyncDispatch.wait_tool_arguments || {}).task_id === asyncDispatch.task_id,
    async_wait_has_no_revision_dependency: !Object.hasOwn(asyncDispatch.wait_tool_arguments || {}, "after_revision"),
    async_has_result_tool_arguments: (asyncDispatch.result_tool_arguments || {}).task_id === asyncDispatch.task_id,
    auto_ok: auto.status === "ok",
    auto_resolves_async_when_available: auto.resolved_delivery === "async-subagent",
    auto_has_readiness: auto.delivery_readiness.status === "available",
    auto_has_task_id: Boolean(auto.task_id),
    self_test_uses_isolated_submitter: Boolean(isolatedSubmissions.length)
      && isolatedSubmissions.every((item) => path.resolve(path.dirname(path.dirname(item)))
          === path.resolve(path.join(ROOT, "tmp", "dispatch_prepare", "preparations"))
        && path.basename(path.dirname(item)).startsWith("prep-")),
    readiness_auto_approves_async_tools: readiness.approval_mode === "approve",
    readiness_matches_dispatch_contract: readiness.dispatch_contract_version === dp.ASYNC_DISPATCH_CONTRACT_VERSION
      && (readiness.supported_dispatch_contract_versions || []).includes(dp.ASYNC_DISPATCH_CONTRACT_VERSION),
    stale_dispatch_contract_is_rejected: staleContractStatus.compatible === false
      && String(staleContractStatus.issue).includes(dp.ASYNC_DISPATCH_CONTRACT_VERSION),
    compatible_dispatch_contract_is_accepted: compatibleContractStatus.compatible === true,
    explicit_async_delivery_uses_readiness: staleDelivery === "unavailable",
    readiness_and_submit_share_configured_endpoint: Boolean(endpointServer)
      && endpointTool !== null && endpointTool !== undefined
      && readiness.tool_path === String(endpointTool),
    dry_run_ok: dryDirect.status === "ok" && dryDirect.dry_run === true,
    explicit_async_preview_skips_transport_readiness: explicitAsyncPreview.resolved_delivery === "async-subagent"
      && (explicitAsyncPreview.delivery_readiness || {}).status === "not_checked"
      && (explicitAsyncPreview.async_preview || {}).model
        === resolveFor("general-agent", "general-default").resolved_model,
    dry_run_no_spawn_hint: !dryDirect.spawn_payload.includes("SUBAGENT_TASK_ID"),
    dry_run_no_writes: deepEqual(dryDirect.writes_performed, []),
    dry_run_business_output_visible: Boolean((dryDirect.business_output || {}).expected_report_path),
    dry_run_write_extra_kept_separate: (outputVisibilityDry.business_output || {}).expected_report_path
        !== "notes/reports/dispatch-output-visibility-self-test.md"
      && ((outputVisibilityDry.business_output || {}).extra_write_paths || [])
        .includes("notes/reports/dispatch-output-visibility-self-test.md"),
    business_output_scope_write_deduped: scopeWriteDedupePaths
      .filter((item) => item === "notes/general/dispatch-scope-write-dedupe-self-test.md").length === 1,
    direct_runtime_blocked: directRuntimeBlocked,
    invalid_task_root_rejected_before_write: invalidRootRejectedBeforeWrite,
  };
  for (const rid of dp.routesWithCards()) {
    try {
      const outcome = dp.prepareDirectPreview(dp.expandSeed(dp.exampleSeed(rid)));
      if (outcome.task_package_path) tempPaths.push(path.join(ROOT, String(outcome.task_package_path)));
      checks[`card::${rid}`] = outcome.status === "ok";
    } catch (error) {
      if (!dp.isPyCaughtError(error, new Set(["ToolError", "KeyError", "ValueError"]))) throw error;
      checks[`card::${rid}`] = false;
    }
  }
  const codeTestingSeed = dp.exampleSeed("verify-agent__code-verification");
  codeTestingSeed.contract.verify_mode = "testing";
  for (const key of ["changed_surfaces", "allowed_risk_triggers", "disallowed_topics", "issue_admission_required"]) {
    delete codeTestingSeed.contract[key];
  }
  try {
    dp.expandSeed(codeTestingSeed);
    checks.code_testing_omits_verification_only_fields = true;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    checks.code_testing_omits_verification_only_fields = false;
  }
  const codeVerificationSeed = dp.exampleSeed("verify-agent__code-verification");
  delete codeVerificationSeed.contract.changed_surfaces;
  try {
    dp.expandSeed(codeVerificationSeed);
    checks.code_verification_requires_changed_surfaces = false;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    checks.code_verification_requires_changed_surfaces = String(error.message).includes("contract.changed_surfaces");
  }
  const plannerSeed = dp.exampleSeed("planner-agent__plan-authoring");
  if (!plannerSeed.contract) plannerSeed.contract = {};
  delete plannerSeed.contract.locked_decisions;
  plannerSeed.contract.mechanical_schema = { interface_contract_kind_values: ["invented"] };
  plannerSeed.extensions = {
    capability_contract: {
      planner: { mechanical_schema: { source: "caller", interface_contract_kind_values: ["invented"] } },
    },
  };
  const plannerExpanded = dp.expandSeed(plannerSeed);
  const plannerContract = ((plannerExpanded.extensions || {}).capability_contract || {}).planner || {};
  checks.planner_empty_locked_decisions_allowed = deepEqual(plannerContract.locked_decisions, [])
    && deepEqual((plannerExpanded.alignment || {}).decision_refs, []);
  checks.planner_mechanical_schema_injected_from_checker = (plannerContract.mechanical_schema || {}).source
      === "ops/tools/planning_manifest_check.py"
    && !((plannerContract.mechanical_schema || {}).interface_contract_kind_values || []).includes("invented")
    && ((plannerContract.mechanical_schema || {}).interface_contract_kind_values || []).includes("data_shape");
  const executorRootSeed = dp.exampleSeed("executor-agent__plan-execution");
  executorRootSeed.contract.dependency_edges = [];
  executorRootSeed.contract.resource_locks = [];
  const executorRootExpanded = dp.expandSeed(executorRootSeed);
  const executorRootContract = ((executorRootExpanded.extensions || {}).capability_contract || {}).executor || {};
  checks.executor_root_lane_empty_dependency_edges_allowed = deepEqual(executorRootContract.dependency_edges, []);
  checks.executor_lane_empty_resource_locks_allowed = deepEqual(executorRootContract.resource_locks, []);
  try {
    validatePlannerMechanicalSchema({ source: "ops/tools/planning_manifest_check.py" });
    checks.planner_mechanical_schema_missing_fields_block = false;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    checks.planner_mechanical_schema_missing_fields_block = String(error.message).includes("stop before task material write")
      && String(error.message).includes("interface_contract_kind_values");
  }
  // planning_pass 不再在编译期拒发，原样进入任务材料由 planner 判断。
  const unknownPlanningPassSeed = dp.exampleSeed("planner-agent__plan-authoring");
  unknownPlanningPassSeed.contract.planning_pass = "revision";
  checks.planner_planning_pass_passes_through = JSON.stringify(dp.expandSeed(unknownPlanningPassSeed)).includes('"planning_pass":"revision"');
  const minimal = {
    route_id: "explorer-agent__codebase-scan",
    goal: "self-test: 摸清 ops/tools 的脚本结构和入口",
    scope: { read: ["ops/tools/"] },
    contract: { scan_mode: "terrain_map", focus: "structure", question: "工具目录有哪些入口脚本和职责" },
    slug: "dispatch-prepare-self-test",
  };
  const expanded = dp.expandSeed({ ...minimal });
  const contract = expanded.extensions.capability_contract.explorer || {};
  const minimalDirect = dp.prepareDirectPreview(expanded);
  if (minimalDirect.task_package_path) tempPaths.push(path.join(ROOT, String(minimalDirect.task_package_path)));
  const minimalAsync = dp.prepareDispatch(expanded, "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: isolatedSubmitter,
  });
  if (minimalAsync.task_package_path) tempPaths.push(path.join(ROOT, String(minimalAsync.task_package_path)));
  const modelSelection = minimalAsync.async_model_selection || {};
  // 期望值取配置真源，配置变更不打爆自测；自测只断言"选型来自配置"这一行为。
  const explorerDefault = resolveFor("explorer-agent", "codebase-scan");
  const expectedModel = explorerDefault.resolved_model;
  const expectedEffort = explorerDefault.resolved_effort;
  Object.assign(checks, {
    minimal_expanded_full: Object.hasOwn(expanded, "handoff_contract"),
    minimal_slot_explorer: contract.scan_mode === "terrain_map",
    minimal_scope_paths_mirrored: deepEqual(contract.scope_paths, ["ops/tools/"]),
    minimal_report_in_write: expanded.scope.write.includes("notes/explorer/dispatch-prepare-self-test.md"),
    minimal_dispatch_ok: minimalDirect.status === "ok",
    minimal_async_primary_model_from_agent_config: Boolean(expectedModel) && modelSelection.primary_model === expectedModel,
    minimal_async_primary_effort_from_agent_config: Boolean(expectedEffort) && modelSelection.primary_effort === expectedEffort,
    minimal_template_renders: dp.renderTemplate("explorer-agent__codebase-scan").includes("scan_mode"),
    minimal_list_has_card: dp.listCards().some((row) => row.minimal_seed),
  });
  // pi 轨：检查已冻结的推荐行选择。
  const piEnvelopes = [];
  const piCapturingSubmitter = (operation, args) => {
    const receipt = isolatedSubmitter(operation, args);
    piEnvelopes.push(pyJsonLoads(readText(String(args.dispatch_file))));
    return receipt;
  };
  const piMinimal = { ...minimal, slug: "dispatch-prepare-pi-self-test", budget: { max_elapsed_minutes: 45 } };
  const piAsync = dp.prepareDispatch(dp.expandSeed(piMinimal), "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: piCapturingSubmitter,
  });
  if (piAsync.task_package_path) tempPaths.push(path.join(ROOT, String(piAsync.task_package_path)));
  const piSelection = piAsync.async_model_selection || {};
  const piDescriptorSelection = (piAsync.descriptor || {}).model_selection || {};
  const piEnvelope = piEnvelopes.length ? piEnvelopes[piEnvelopes.length - 1] : {};
  const expectedPiModel = explorerDefault.resolved_model;
  const expectedPiEffort = explorerDefault.resolved_effort;
  Object.assign(checks, {
    pi_async_ok: piAsync.status === "ok" && piAsync.executor === "pi",
    pi_async_runner_basename: path.basename(String(piEnvelope.runner_path || "")) === "run-pi-task.mjs",
    pi_async_envelope_carries_seed_budget: piEnvelope.budget?.max_elapsed_minutes === 45,
    pi_async_primary_model_from_pi_config: Boolean(expectedPiModel) && piSelection.primary_model === expectedPiModel,
    pi_async_primary_effort_from_pi_config: Boolean(expectedPiEffort) && piSelection.primary_effort === expectedPiEffort,
    pi_envelope_model_matches_selection: piEnvelope.model === piSelection.primary_model,
    pi_envelope_effort_matches_selection: piEnvelope.effort === piSelection.primary_effort,
    pi_envelope_has_no_model_fallback: !Object.hasOwn(piEnvelope, "model_fallback"),
    pi_envelope_freezes_pick_efforts_and_range: piEnvelope.selection?.pick === explorerDefault.pick
      && deepEqual(piEnvelope.selection?.efforts, explorerDefault.efforts)
      && deepEqual(piEnvelope.selection?.effort_range, explorerDefault.effort_range),
    pi_descriptor_freezes_selection_sources: piDescriptorSelection.model === piEnvelope.model
      && piDescriptorSelection.effort === piEnvelope.effort
      && piDescriptorSelection.model_source === piSelection.model_source
      && piDescriptorSelection.effort_source === piSelection.effort_source
      && deepEqual(piDescriptorSelection.child_model, piSelection.child_model),
    pi_envelope_has_no_executor_field: !Object.hasOwn(piEnvelope, "executor"),
    pi_envelope_contract_unchanged: piEnvelope.contract_version === dp.ASYNC_DISPATCH_CONTRACT_VERSION,
  });
  const batchFile = path.join(ROOT, "tmp", "dispatch_prepare", `self-test-batch-${timeNs()}.json`);
  mkdirSync(path.dirname(batchFile), { recursive: true });
  writeFileSync(batchFile, JSON.stringify([
    dp.exampleSeed("explorer-agent__codebase-scan"),
    dp.exampleSeed("explorer-agent__runtime-env-scan"),
  ]), "utf8");
  try {
    const batchSeeds = dp.loadSeeds({ seed: batchFile, seed_stdin: false, sample_route: null });
    const batchOut = batchSeeds.map((item) => dp.prepareDirectPreview(item));
    for (const item of batchOut) {
      if (item.task_package_path) tempPaths.push(path.join(ROOT, String(item.task_package_path)));
    }
    checks.batch_seeds_two = batchOut.length === 2 && batchOut.every((item) => item.delivery_mode === "direct_message");
    checks.batch_policy_parallel = batchSeeds.every(
      (item) => item.concurrency_contract.parallel_policy === "allowed_if_no_conflict",
    );
    const metadataSeeds = [
      {
        route_id: "explorer-agent__codebase-scan",
        goal: "scan the first batch scope",
        scope: { read: ["PROJECT.md"] },
        contract: { scan_mode: "slice_scan", focus: "structure", question: "what is the first batch scope", depth_limit: 1000 },
        slug: "self-test-batch-a",
      },
      {
        route_id: "explorer-agent__codebase-scan",
        goal: "scan the second batch scope",
        scope: { read: ["AGENTS.md"] },
        contract: { scan_mode: "slice_scan", focus: "structure", question: "what is the second batch scope", depth_limit: 1000 },
        slug: "self-test-batch-b",
      },
    ];
    const metadataBatch = dp.prepareBatchDispatch(
      metadataSeeds.map((item) => dp.expandDispatchSeed(item)),
      "async-subagent",
      { batchId: "batch-self-test", action: "preview", asyncRunnerPath: fakeRunner, asyncTaskRoot: asyncRoot },
    );
    checks.batch_metadata_is_stable = metadataBatch.status === "ok"
      && metadataBatch.batch_id === "batch-self-test"
      && deepEqual((metadataBatch.dispatches || []).map((item) => item.slice_id), ["self-test-batch-a", "self-test-batch-b"])
      && (metadataBatch.dispatches || []).every((item) => item.batch_id === "batch-self-test");
  } finally {
    rmSync(batchFile, { force: true });
  }
  const bomSeedFile = path.join(ROOT, "tmp", "dispatch_prepare", `self-test-bom-seed-${timeNs()}.json`);
  mkdirSync(path.dirname(bomSeedFile), { recursive: true });
  writeFileSync(bomSeedFile, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(dp.exampleSeed("explorer-agent__codebase-scan")), "utf8"),
  ]));
  try {
    const bomSeeds = dp.loadSeeds({ seed: bomSeedFile, seed_stdin: false, sample_route: null });
    checks.seed_file_tolerates_bom = bomSeeds.length === 1 && bomSeeds[0].route_id === "explorer-agent__codebase-scan";
  } finally {
    rmSync(bomSeedFile, { force: true });
  }
  const nameRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-prepare-server-name-self-test-"));
  try {
    const newConfig = path.join(nameRoot, "new.toml");
    writeFileSync(newConfig, `[mcp_servers.${dp.ASYNC_MCP_SERVER_NAME}]\ncommand = "new"\n`, "utf8");
    const resolved = dp._serverFromConfig(newConfig);
    checks.server_name_resolves_new_registration = resolved !== null
      && resolved.server_name === dp.ASYNC_MCP_SERVER_NAME
      && resolved.command === "new";
  } finally {
    rmSync(nameRoot, { recursive: true, force: true });
  }
  const sampleGlobalServer = { source: "global", config_path: "global-config" };
  checks.project_async_mcp_registration_ignored = dp.selectAsyncSubagentServer({ source: "project", config_path: "project-config" }, sampleGlobalServer) === sampleGlobalServer;
  checks.global_async_mcp_registration_selected = dp.selectAsyncSubagentServer(null, sampleGlobalServer) === sampleGlobalServer;
  const resolvedServer = dp.asyncSubagentServer();
  const resolvedScript = resolvedServer ? dp.asyncServerScriptPath(resolvedServer) : null;
  checks.async_server_script_resolves = resolvedServer === null
    || (resolvedScript !== null && isFile(resolvedScript));
  try {
    dp.expandSeed({ ...minimal, goal: "<本次扫描要回答的一句话问题>" });
    checks.minimal_placeholder_rejected = false;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    checks.minimal_placeholder_rejected = true;
  }
  const documentScanSeed = dp.expandSeed(dp.exampleSeed("research-agent__document-scan"));
  const documentScanOk = dp.prepareDirectPreview(documentScanSeed);
  if (documentScanOk.task_package_path) tempPaths.push(path.join(ROOT, String(documentScanOk.task_package_path)));
  checks.vision_requirement_passes_with_configured_model = documentScanOk.status === "ok";
  const documentScanOverride = dp.prepareDirectPreview(documentScanSeed, { asyncModel: "no-vision-fixture-model" });
  checks.vision_requirement_is_task_guidance = documentScanOverride.status === "ok";
  const readOnlyPackage = {
    agent: { role: "general-agent", runtime_role: "general-agent", capability: { name: "general-default" } },
    scope: { read: ["a/"], write: [], delete: [] },
    runtime_context: { network_needed: "no" },
    tool_contract: { allowed: ["read", "grep", "find", "ls"], network_allowed: false, install_allowed: false },
    extensions: {},
  };
  const crossRepoTarget = path.join(asyncRoot, "target-repo");
  mkdirSync(crossRepoTarget, { recursive: true });
  writeFileSync(path.join(crossRepoTarget, "marker.txt"), "cross-repo self-test\n", "utf8");
  const crossRepoSeed = structuredClone(expanded);
  crossRepoSeed.scope.read = ["marker.txt"];
  if (crossRepoSeed.inputs && typeof crossRepoSeed.inputs === "object" && !Array.isArray(crossRepoSeed.inputs)) {
    crossRepoSeed.inputs.files = ["marker.txt"];
  }
  if (!crossRepoSeed.extensions) crossRepoSeed.extensions = {};
  crossRepoSeed.extensions.cross_repo_acceptance = { result_mode: "read_only_audit" };
  const crossRepoPrepared = dp.prepareDispatch(crossRepoSeed, "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncTargetCwd: crossRepoTarget,
    asyncSubmitter: isolatedSubmitter,
  });
  const crossRepoPackagePath = path.join(ROOT, String(crossRepoPrepared.task_package_path));
  const crossRepoPackage = pyJsonLoads(readText(crossRepoPackagePath)).task_package;
  checks.cross_repo_target_repo_bound_into_task_package = path.resolve(crossRepoPackage.runtime_context.target_repo)
    === path.resolve(crossRepoTarget);
  tempPaths.push(
    crossRepoPackagePath,
    withSuffix(crossRepoPackagePath, ".task.md"),
    withSuffix(crossRepoPackagePath, ".dispatch.json"),
  );
  readOnlyPackage.extensions = { cross_repo_acceptance: { result_mode: "read_only_audit" } };
  const crossRepoOptions = dp.resolveAsyncRuntimeOptions(readOnlyPackage, {
    runnerPath: fakeRunner, targetCwd: crossRepoTarget,
  });
  checks.cross_repo_task_root_stays_in_controller_runtime = pyIsRelativeTo(
    String(crossRepoOptions.task_root), path.resolve(path.join(ROOT, ".runtime")),
  ) && !pyIsRelativeTo(String(crossRepoOptions.task_root), path.resolve(path.join(crossRepoTarget, ".runtime")));
  const simulationPackage = structuredClone(readOnlyPackage);
  simulationPackage.extensions.cross_repo_acceptance = {
    result_mode: "simulated_planning",
    simulation: { role: "target-reviewer", persona: { instructions: "只读检查目标仓入口", boundaries: ["不写目标仓"] } },
  };
  const simulationOptions = dp.resolveAsyncRuntimeOptions(simulationPackage, {
    runnerPath: fakeRunner, targetCwd: crossRepoTarget,
  });
  checks.cross_repo_simulation_profile_comes_from_seed = simulationOptions.result_mode === "simulated_planning"
    && simulationOptions.simulation_profile.role === "target-reviewer"
    && simulationOptions.simulation_profile.persona.instructions === "只读检查目标仓入口";
  const missingModePackage = structuredClone(readOnlyPackage);
  missingModePackage.extensions = {};
  const defaultAudit = dp.resolveAsyncRuntimeOptions(missingModePackage, {
    runnerPath: fakeRunner, targetCwd: crossRepoTarget,
  });
  checks.cross_repo_result_mode_defaults_read_only = defaultAudit.result_mode === "read_only_audit"
    && defaultAudit.warnings.length > 0;
  const evidencePackage = structuredClone(readOnlyPackage);
  evidencePackage.scope.write = ["notes/x.md"];
  evidencePackage.extensions = { review_execution: { profile: dp.EVIDENCE_ONLY_PROFILE } };
  const evidenceOptions = dp.resolveAsyncRuntimeOptions(evidencePackage, {
    runnerPath: fakeRunner, taskRoot: asyncRoot, targetCwd: ROOT,
  });
  checks.evidence_only_resolves_isolated_execution_profile = evidenceOptions.execution_profile === dp.EVIDENCE_ONLY_PROFILE
    && evidenceOptions.context_mode === "isolated";
  const semanticPackage = structuredClone(readOnlyPackage);
  semanticPackage.scope.write = ["notes/verify/semantic-self-test.md"];
  semanticPackage.extensions = { review_execution: { profile: dp.SEMANTIC_REVIEW_PROFILE } };
  const semanticOptions = dp.resolveAsyncRuntimeOptions(semanticPackage, {
    runnerPath: fakeRunner, taskRoot: asyncRoot, targetCwd: ROOT,
  });
  checks.semantic_review_keeps_standard_project_aware = semanticOptions.execution_profile === "standard"
    && semanticOptions.context_mode === "project-aware";
  // 网络需求与显式工具面分别保留，不按工具名猜网络能力。
  const semanticNetworkLocalTools = structuredClone(semanticPackage);
  semanticNetworkLocalTools.runtime_context = { network_needed: "yes" };
  semanticNetworkLocalTools.tool_contract = { allowed: ["read", "grep", "write"] };
  const semanticLocalOptions = dp.resolveAsyncRuntimeOptions(semanticNetworkLocalTools, {
    runnerPath: fakeRunner, taskRoot: asyncRoot, targetCwd: ROOT,
  });
  checks.semantic_review_network_needed_preserves_explicit_tools = deepEqual(semanticLocalOptions.tool_allowlist, ["read", "grep", "write"]);
  // 工具面继承与联网动作授权分离，无需重复枚举网络工具名。
  const semanticNetworkNoTool = structuredClone(semanticPackage);
  semanticNetworkNoTool.runtime_context = { network_needed: "yes" };
  semanticNetworkNoTool.tool_contract = { network_allowed: true, allowed: null };
  const inheritedNetworkOptions = dp.resolveAsyncRuntimeOptions(semanticNetworkNoTool, {
    runnerPath: fakeRunner, taskRoot: asyncRoot, targetCwd: ROOT,
  });
  checks.semantic_review_network_needed_accepts_inherited_tools = inheritedNetworkOptions.tool_allowlist === null
    && inheritedNetworkOptions.tool_allowlist_source === "pi_configured_tools";
  const evidenceNetworkPackage = structuredClone(evidencePackage);
  evidenceNetworkPackage.runtime_context = { network_needed: "yes" };
  const assistedOptions = dp.resolveAsyncRuntimeOptions(evidenceNetworkPackage, {
    runnerPath: fakeRunner, taskRoot: asyncRoot, targetCwd: ROOT,
  });
  checks.evidence_network_uses_assisted_profile = assistedOptions.execution_profile === "standard"
    && assistedOptions.warnings.length > 0;
  const semanticPreview = dp.prepareDispatch(
    dp.expandDispatchSeed({
      route_id: "semantic-review-agent__rule-quality-inspection",
      goal: "semantic review material self-test",
      scope: { read: ["AGENTS.md", "ops/skills/rule-authoring/SKILL.md"] },
      contract: { target_files: ["AGENTS.md"], inspection_focus: ["single_direction"] },
    }),
    "async-subagent",
    { action: "preview", asyncRunnerPath: fakeRunner, asyncTaskRoot: asyncRoot },
  );
  checks.semantic_preview_uses_full_review_material = (semanticPreview.review_evidence || {}).profile === dp.SEMANTIC_REVIEW_PROFILE
    && (semanticPreview.review_evidence || {}).material_mode === "full";
  const brokenRouteSeed = dp.exampleSeed("explorer-agent__codebase-scan");
  brokenRouteSeed.route_id = "nonexistent-agent__no-such-capability";
  const batchPartial = dp.prepareBatchDispatch([seed, brokenRouteSeed], "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: isolatedSubmitter,
  });
  for (const item of batchPartial.dispatches) {
    if (item.task_package_path) tempPaths.push(path.join(ROOT, String(item.task_package_path)));
  }
  checks.batch_partial_status_on_mixed_seeds = batchPartial.status === "partial";
  checks.batch_partial_keeps_first_task_id = Boolean(batchPartial.committed_task_ids.length);
  checks.batch_partial_lists_failed_index = deepEqual(batchPartial.failed_seed_indexes, [2]);
  const batchPartialFailure = batchPartial.dispatches[1];
  checks.batch_partial_failure_carries_phase = batchPartialFailure.phase === "seed"
    && String(batchPartialFailure.error || "").startsWith("[seed] ");
  checks.batch_partial_dispatches_len_matches_seeds = batchPartial.dispatches.length === 2;
  const conflictSeedA = dp.exampleSeed("explorer-agent__codebase-scan");
  pushWriteExtra(conflictSeedA, "notes/conflict/self-test.md");
  const conflictSeedB = dp.exampleSeed("explorer-agent__runtime-env-scan");
  pushWriteExtra(conflictSeedB, "notes/conflict/self-test.md");
  const conflictSeedC = dp.exampleSeed("explorer-agent__codebase-scan");
  conflictSeedC.slug = "independent-conflict-self-test";
  pushWriteExtra(conflictSeedC, "notes/conflict/independent-self-test.md");
  const batchConflict = dp.prepareBatchDispatch([conflictSeedA, conflictSeedB, conflictSeedC].map((seed) => dp.expandDispatchSeed(seed)), "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: isolatedSubmitter,
  });
  checks.batch_write_conflict_isolates_participants = batchConflict.status === "partial"
    && batchConflict.committed_task_ids.length === 1
    && deepEqual(batchConflict.dispatches.map((item) => item.status), ["failed", "failed", "ok"])
    && deepEqual(batchConflict.failed_seed_indexes, [1, 2])
    && deepEqual(batchConflict.not_submitted_seed_indexes, [])
    && Boolean((batchConflict.batch_write_conflicts || []).length);
  const resolvedConflictSeedA = dp.exampleSeed("explorer-agent__codebase-scan");
  resolvedConflictSeedA.expected_output = {
    mode: "file",
    resolved_file_path: path.join(ROOT, "notes/conflict/resolved-self-test.md"),
  };
  const resolvedConflictSeedB = dp.exampleSeed("explorer-agent__runtime-env-scan");
  resolvedConflictSeedB.handoff_contract = {
    resolved_handoff_file: path.join(ROOT, "notes/conflict/resolved-self-test.md"),
  };
  const resolvedBatchConflict = dp.prepareBatchDispatch([resolvedConflictSeedA, resolvedConflictSeedB], "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: isolatedSubmitter,
  });
  checks.batch_resolved_write_conflict_blocks_all = resolvedBatchConflict.status === "failed"
    && deepEqual(resolvedBatchConflict.committed_task_ids, [])
    && deepEqual(resolvedBatchConflict.failed_seed_indexes, [1, 2])
    && deepEqual(resolvedBatchConflict.not_submitted_seed_indexes, [])
    && Boolean((resolvedBatchConflict.batch_write_conflicts || []).length);
  checks.scope_preflight_small_scope_no_warning = (dryDirect.scope_preflight || {}).scope_preflight_warning === null
    && (dryDirect.scope_preflight || {}).scope_file_count === 1;
  const heavyDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-prepare-preflight-self-test-"));
  try {
    // Isolate ignore rules when TEMP lives inside an ignored workspace directory.
    const initialized = spawnSync("git", ["init", "-q", heavyDir], { encoding: "utf8", windowsHide: true });
    if (initialized.status !== 0) throw new Error(`preflight fixture git init failed: ${initialized.stderr}`);
    for (let index = 0; index < dp.PREFLIGHT_FILE_THRESHOLD + 100; index += 1) {
      writeFileSync(path.join(heavyDir, `f${index}.txt`), "x", "utf8");
    }
    const heavyPreflight = dp.computeScopePreflight([heavyDir], { baseRoot: heavyDir });
    checks.scope_preflight_over_threshold_warns = Boolean(heavyPreflight.scope_preflight_warning);
    checks.scope_preflight_over_threshold_file_count = heavyPreflight.scope_file_count === dp.PREFLIGHT_FILE_THRESHOLD + 100;
  } finally {
    rmSync(heavyDir, { recursive: true, force: true });
  }
  const gitRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-prepare-git-ignore-self-test-"));
  try {
    const initialized = spawnSync("git", ["init", "-q", gitRoot], { encoding: "utf8", windowsHide: true });
    writeFileSync(path.join(gitRoot, ".gitignore"), ".runtime/\nnode_modules/\ntmp/\nops/dist/\n", "utf8");
    writeFileSync(path.join(gitRoot, "kept.txt"), "kept\n", "utf8");
    for (const relative of [".runtime/tasks", "node_modules/pkg", "tmp/cache", "ops/dist/assets"]) {
      const ignoredDir = path.join(gitRoot, relative);
      mkdirSync(ignoredDir, { recursive: true });
      writeFileSync(path.join(ignoredDir, "ignored.txt"), "ignored\n", "utf8");
    }
    const originalWalk = deps.walk;
    deps.walk = function* poisonWalk() {
      throw new Error("ignored tree walk");
    };
    let ignoredPreflight = null;
    try {
      ignoredPreflight = dp.computeScopePreflight(["."], { baseRoot: gitRoot });
    } catch {
      ignoredPreflight = null;
    } finally {
      deps.walk = originalWalk;
    }
    checks.scope_preflight_respects_git_ignore = ignoredPreflight !== null
      && initialized.status === 0
      && ignoredPreflight.scope_file_count === 2;
  } finally {
    rmSync(gitRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  const missingPreflight = dp.computeScopePreflight(["notes/does-not-exist-preflight-self-test/"]);
  checks.scope_preflight_missing_path_is_reported = missingPreflight.scope_file_count === 0
    && deepEqual(missingPreflight.scope_missing_paths, ["notes/does-not-exist-preflight-self-test/"])
    && deepEqual(missingPreflight.scope_unreadable_paths, []);
  const urlPreflight = dp.computeScopePreflight(["https://example.com/docs", "ops/tools/dispatch_prepare.mjs"]);
  checks.scope_preflight_url_entries_skip_stat = urlPreflight.scope_url_count === 1
    && deepEqual(urlPreflight.scope_missing_paths, [])
    && urlPreflight.scope_file_count === 1;
  try {
    dp.enforceScopePreflight(urlPreflight);
    checks.scope_preflight_url_entries_pass_enforcement = true;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    checks.scope_preflight_url_entries_pass_enforcement = false;
  }
  checks.scope_preflight_missing_path_is_diagnostic = dp.enforceScopePreflight(missingPreflight).length > 0;
  // read_scope_layers 分层 schema + 渲染 + preflight 只算 entry+index；旧 budget 字段只作成本提示。
  const layeredSeed = {
    route_id: "explorer-agent__codebase-scan",
    goal: "self-test layered read scope",
    scope: { read: ["ops/tools/", "runs/"] },
    contract: { scan_mode: "terrain_map", focus: "structure", question: "分层读取自测" },
    slug: "dispatch-prepare-layers-self-test",
    read_scope_layers: {
      entry: ["ops/tools/seed_minimal.mjs"],
      index: ["ops/tools/"],
      deep: [{ path: "notes/", when: "命中扫描接缝时" }],
      deferred: ["runs/"],
    },
    budget: { max_tool_calls: 40, max_elapsed_minutes: 10 },
  };
  const extractedLayers = dp.readScopeLayersFromSeed(layeredSeed);
  const layeredPreflightPaths = dp.preflightReadPaths(extractedLayers, layeredSeed.scope.read);
  const layeredDirective = dp.renderReadScopeLayers(extractedLayers);
  const extractedBudget = dp.seedBudget(layeredSeed);
  let nonpositiveBudgetRejected = false;
  try {
    dp.seedBudget({ budget: { max_elapsed_minutes: -1 } });
    nonpositiveBudgetRejected = false;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    nonpositiveBudgetRejected = true;
  }
  const layeredDry = dp.prepareDispatch(dp.expandSeed({ ...layeredSeed }), "direct", { action: "preview" });
  checks.read_scope_layers_extracted = extractedLayers !== null
    && deepEqual(extractedLayers.deferred, ["runs/"])
    && deepEqual(extractedLayers.deep, [{ path: "notes/", when: "命中扫描接缝时" }]);
  checks.read_scope_layers_preflight_entry_index_only = deepEqual(layeredPreflightPaths, ["ops/tools/seed_minimal.mjs", "ops/tools/"])
    && !layeredPreflightPaths.includes("runs/");
  checks.read_scope_layers_dry_run_carries_directive = Object.hasOwn(layeredDry, "read_scope_layers_directive")
    && layeredDry.budget_enforcement?.max_elapsed_minutes === "enforced_per_attempt";
  checks.seed_budget_rejects_nonpositive = nonpositiveBudgetRejected;
  // 旧种子的 max_tool_calls 被忽略，预算只保留墙钟时限。
  checks.seed_budget_ignores_legacy_tool_calls = deepEqual(extractedBudget, { max_elapsed_minutes: 10 })
    && deepEqual(layeredDry.budget_enforcement, { max_elapsed_minutes: "enforced_per_attempt" });
  const ownedPreparationRoots = new Set();
  for (const item of isolatedSubmissions) {
    if (path.basename(path.dirname(item)).startsWith("prep-")) ownedPreparationRoots.add(path.resolve(path.dirname(item)));
  }
  for (const item of tempPaths) {
    if (path.basename(path.dirname(item)).startsWith("prep-")) ownedPreparationRoots.add(path.resolve(path.dirname(item)));
  }
  for (const preparation of ownedPreparationRoots) {
    try {
      rmSync(preparation, { recursive: true, force: false, maxRetries: 10, retryDelay: 50 });
    } catch {
      checks[`cleanup::${dp.rel(preparation)}`] = false;
    }
  }
  for (const item of tempPaths) {
    if (path.basename(path.dirname(item)).startsWith("prep-")) continue;
    try {
      rmSync(item, { force: true });
    } catch {
      checks[`cleanup::${dp.rel(item)}`] = false;
    }
  }
  const registryRoot = process.env.SUBAGENT_REGISTRY_ROOT || dp.defaultRegistryRoot();
  if (isDir(registryRoot)) {
    for (const name of readdirSync(registryRoot)) {
      if (!name.endsWith(".json")) continue;
      const registryFile = path.join(registryRoot, name);
      try {
        const record = pyJsonLoads(readText(registryFile));
        if (path.resolve(String(record.task_root || "")) === path.resolve(asyncRoot)) rmSync(registryFile, { force: true });
      } catch {
        continue;
      }
    }
  }
  const selfTestRoot = path.join(ROOT, ".runtime", "self-tests");
  if (pyIsRelativeTo(path.resolve(asyncRoot), path.resolve(selfTestRoot))) {
    rmSync(asyncRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } else {
    checks["cleanup::async_root_boundary"] = false;
  }
  return {
    status: Object.values(checks).every(Boolean) ? "ok" : "failed",
    checks,
    verification: {
      readiness_and_submit_share_configured_endpoint: checks.readiness_and_submit_share_configured_endpoint,
      invalid_input_has_no_evidence_or_material_writes: checks.invalid_task_root_rejected_before_write,
      auto_submit_returns_task_id: checks.auto_has_task_id,
      prepared_submit_returns_task_id: checks.async_has_task_id,
      direct_runtime_is_blocked: checks.direct_runtime_blocked,
      async_failure_has_no_sync_fallback: checks.direct_runtime_blocked,
    },
  };
}

/** Path.with_suffix()：换掉最后一个扩展名。 */
function withSuffix(target, suffix) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const dot = base.lastIndexOf(".");
  return path.join(dir, (dot > 0 ? base.slice(0, dot) : base) + suffix);
}

function pushWriteExtra(seed, value) {
  if (!seed.scope) seed.scope = {};
  if (!seed.scope.write_extra) seed.scope.write_extra = [];
  seed.scope.write_extra.push(value);
}
