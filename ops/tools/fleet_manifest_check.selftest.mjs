#!/usr/bin/env node
// fleet_manifest_check --self-test 的机械用例集（ops/tools/fleet_manifest_check_selftest.py 的移植），
// 经 node ops/tools/fleet_manifest_check.mjs --self-test 调用。checks 键名与 true/false 语义与 Python 逐条一致。
import * as fmc from "./dispatch-core/fleet_manifest_check.mjs";
import { ToolError } from "./dispatch-core/_tool_common.mjs";
import { exampleSeed } from "./dispatch-core/seed_minimal.mjs";

const { deepCopy } = fmc;

const SELF_TEST_ROUTE = "explorer-agent__codebase-scan";

function selfTestSeed(route, slug, goal, reads, { question = true } = {}) {
  const value = exampleSeed(route);
  value.goal = goal;
  value.slug = slug;
  if (question) {
    if (!Object.hasOwn(value, "contract")) value.contract = {};
    value.contract.question = goal;
  }
  if (!Object.hasOwn(value, "scope")) value.scope = {};
  value.scope.read = [...reads];
  return value;
}

function selfTestManifest(nodes, topLevel = {}) {
  return { schema_version: fmc.MANIFEST_SCHEMA_VERSION, nodes, ...topLevel };
}

function selfTestValidManifest() {
  const seedA = selfTestSeed(SELF_TEST_ROUTE, "fleet-self-test-a", "self-test scan A", ["ops/tools"]);
  const seedB = selfTestSeed(SELF_TEST_ROUTE, "fleet-self-test-b", "self-test scan B", ["ops/policies"]);
  const seedC = selfTestSeed(SELF_TEST_ROUTE, "fleet-self-test-c", "self-test scan C", ["ops/protocols"]);
  return selfTestManifest(
    [
      { id: "scan-a", seed: seedA },
      { id: "scan-b", seed: seedB },
      {
        id: "scan-c",
        depends_on: ["scan-a", "scan-b"],
        dependency_artifacts: ["report"],
        dependency_policy: "all_settled",
        seed: seedC,
      },
    ],
    {
      run_id: "fleet-self-test",
      budget: { max_nodes_total: 4, max_running_total: 2, max_submitted_per_tick: 2 },
    },
  );
}

function deepEqual(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function caseValidAndExample() {
  const result = fmc.validateManifest(selfTestValidManifest());
  const scanC = result.nodes.find((row) => row.id === "scan-c") ?? {};
  const example = fmc.exampleManifest();
  const exampleResult = fmc.validateManifest(example);
  const reduceNode = example.nodes.find((node) => node.id === "reduce") ?? {};
  return {
    valid_manifest_ok: result.status === "ok",
    generated_example_manifest_ok: exampleResult.status === "ok",
    valid_layers: deepEqual(result.layers, [["scan-a", "scan-b"], ["scan-c"]]),
    all_settled_policy_is_reported: scanC.dependency_policy === "all_settled",
  };
}

function caseRouteModelBinding() {
  const researchSeed = selfTestSeed(
    "research-agent__external-research",
    "fleet-research-model-binding",
    "self-test research model binding",
    ["README.md"],
    { question: false },
  );
  const generalSeed = selfTestSeed(
    "general-agent__general-default",
    "fleet-general-model-binding",
    "self-test general model binding",
    ["README.md"],
    { question: false },
  );
  // 路由绑定来自有效推荐行；池外型号没有单次授权时拒绝。
  const accepts = (id, model, effort, seed) => fmc.validateManifest(selfTestManifest([{
    id,
    route: { executor: "pi", model, effort },
    seed: deepCopy(seed),
  }])).status === "ok";
  const schema = fmc.manifestSchema();
  const bindings = schema.authoring_guidance.route_model_bindings;
  const research = bindings["research-agent__external-research"];
  const general = bindings["general-agent__general-default"];
  return {
    role_default_model_accepted: accepts("research-default", research.default_model, research.default_effort, researchSeed),
    reference_model_accepted: accepts("general-reference", general.default_model, general.default_effort, generalSeed),
    outside_reference_model_rejected: !accepts("general-outside", "example/outside-pool", "high", generalSeed),
  };
}

function caseConflictAndCycle() {
  const seedConflictA = selfTestSeed(SELF_TEST_ROUTE, "fleet-conflict-a", "self-test conflict A", ["ops/tools"]);
  seedConflictA.scope.write_extra = ["notes/a.md"];
  const seedConflictB = selfTestSeed(SELF_TEST_ROUTE, "fleet-conflict-b", "self-test conflict B", ["ops/tools"]);
  seedConflictB.scope.write_extra = ["notes/a.md"];
  const conflict = selfTestManifest([{ id: "a", seed: seedConflictA }, { id: "b", seed: seedConflictB }]);
  const seedCycleA = selfTestSeed(SELF_TEST_ROUTE, "fleet-cycle-a", "self-test cycle A", ["ops/tools"]);
  const seedCycleB = selfTestSeed(SELF_TEST_ROUTE, "fleet-cycle-b", "self-test cycle B", ["ops/tools"]);
  const cycle = selfTestManifest([
    { id: "a", seed: seedCycleA, depends_on: ["b"] },
    { id: "b", seed: seedCycleB, depends_on: ["a"] },
  ]);
  return {
    write_conflict_warns: fmc.validateManifest(conflict).status === "ok"
      && fmc.validateManifest(conflict).warnings.length > 0,
    cycle_fails: fmc.validateManifest(cycle).status === "failed",
  };
}

function caseDeferredDependencyInput() {
  const sourceSeed = selfTestSeed(SELF_TEST_ROUTE, "fleet-deferred-source", "self-test deferred source", ["ops/tools"]);
  const deferredSeed = selfTestSeed(
    "general-agent__general-default",
    "fleet-deferred-input",
    "self-test deferred dependency input",
    [],
    { question: false },
  );
  const manifest = selfTestManifest([
    { id: "source", seed: sourceSeed },
    {
      id: "reduce",
      depends_on: ["source"],
      dependency_artifacts: ["report"],
      dependency_policy: "all_settled",
      seed: deferredSeed,
    },
  ]);
  const result = fmc.validateManifest(manifest);
  const reduceRow = result.nodes.find((row) => row.id === "reduce") ?? {};
  return {
    deferred_dependency_input_is_dispatchable: result.status === "ok",
    deferred_dependency_input_is_reported: Boolean(reduceRow.deferred_read_scope),
  };
}

function caseTargetIsolation() {
  // 控制仓声明产物目录通过；仓外写与未覆盖的写域拒绝。
  const seedIso = selfTestSeed(SELF_TEST_ROUTE, "fleet-target-isolation", "self-test isolation", ["ops/tools"]);
  const targetIsolationOk = selfTestManifest([
    { id: "iso", target_isolation: "read_only", seed: deepCopy(seedIso) },
  ]);
  const targetIsolationEscape = selfTestManifest([
    {
      id: "iso",
      target_isolation: "read_only",
      write_scope: ["../outside-repo/report.md"],
      seed: deepCopy(seedIso),
    },
  ]);
  const seedIsoTestResults = deepCopy(seedIso);
  seedIsoTestResults.slug = "fleet-target-isolation-test-results";
  seedIsoTestResults.scope.write_extra = ["test-results/functional-inspection/fleet-self-test"];
  const targetIsolationTestResults = selfTestManifest([
    {
      id: "iso-test-results",
      target_isolation: "read_only",
      artifact_write_scope: ["notes", "test-results/functional-inspection/fleet-self-test"],
      seed: seedIsoTestResults,
    },
  ]);
  const seedIsoSource = deepCopy(seedIso);
  seedIsoSource.slug = "fleet-target-isolation-source";
  seedIsoSource.scope.write_extra = ["src/forbidden-report.md"];
  const targetIsolationSourceWrite = selfTestManifest([
    {
      id: "iso-source",
      target_isolation: "read_only",
      artifact_write_scope: ["notes", "src/forbidden-report.md"],
      seed: seedIsoSource,
    },
  ]);
  const isoOkResult = fmc.validateManifest(targetIsolationOk);
  const isoEscapeResult = fmc.validateManifest(targetIsolationEscape);
  const isoTestResultsResult = fmc.validateManifest(targetIsolationTestResults);
  const isoSourceWriteResult = fmc.validateManifest(targetIsolationSourceWrite);
  return {
    target_isolation_notes_only_ok: isoOkResult.status === "ok",
    target_isolation_external_write_fails: isoEscapeResult.status === "failed"
      && isoEscapeResult.errors.some((item) => item.includes("escapes control repo")),
    target_isolation_test_results_ok: isoTestResultsResult.status === "ok",
    target_isolation_declared_directory_ok: isoSourceWriteResult.status === "ok",
    target_isolation_uncovered_write_fails: fmc.validateManifest({
      ...targetIsolationSourceWrite,
      nodes: [{ ...targetIsolationSourceWrite.nodes[0], artifact_write_scope: ["notes"] }],
    }).status === "failed",
  };
}

function caseReadScopeLayers() {
  // 目录名只提示成本；分层读取仍可使用。
  const seedBareBig = selfTestSeed(SELF_TEST_ROUTE, "fleet-bare-big", "self-test bare big", ["ops/tools", "runs/"]);
  const bareBigDir = selfTestManifest([{ id: "scan", seed: deepCopy(seedBareBig) }]);
  const seedLayered = selfTestSeed(SELF_TEST_ROUTE, "fleet-layered", "self-test layered", ["ops/tools", "runs/"]);
  seedLayered.read_scope_layers = {
    entry: ["ops/tools"],
    index: [],
    deep: [],
    deferred: ["runs/"],
  };
  const layeredDeferred = selfTestManifest([{ id: "scan", seed: deepCopy(seedLayered) }]);
  const bareBigResult = fmc.validateManifest(bareBigDir);
  return {
    bare_big_dir_read_scope_warns: bareBigResult.status === "ok"
      && bareBigResult.warnings.length > 0,
    layered_deferred_big_dir_ok: fmc.validateManifest(layeredDeferred).status === "ok",
  };
}

function caseNodeKinds() {
  const taskSeed = selfTestSeed(SELF_TEST_ROUTE, "fleet-kind-task", "self-test kind task", ["ops/tools"]);

  const commandNode = (overrides = {}) => ({
    id: "consume",
    kind: "command",
    command: { argv: ["python", "-c", "print('ok')"] },
    ...overrides,
  });

  const commandOk = fmc.validateManifest(selfTestManifest([commandNode()]));
  const commandRow = commandOk.nodes.length ? commandOk.nodes[0] : {};
  const commandMissingBlock = fmc.validateManifest(selfTestManifest([{ id: "consume", kind: "command" }]));
  const commandWithSeed = fmc.validateManifest(selfTestManifest([commandNode({ seed: deepCopy(taskSeed) })]));
  const commandBadArgv = fmc.validateManifest(selfTestManifest([commandNode({ command: { argv: [] } })]));
  const commandWorktree = fmc.validateManifest(selfTestManifest([commandNode({ isolation: "worktree" })]));
  const commandEscapeCwd = fmc.validateManifest(
    selfTestManifest([commandNode({ command: { argv: ["python"], cwd: "../outside" } })]),
  );
  const gateOk = fmc.validateManifest(selfTestManifest([
    { id: "up", seed: deepCopy(taskSeed) },
    { id: "confirm", kind: "gate", depends_on: ["up"] },
  ]));
  const gateRow = gateOk.nodes.find((row) => row.id === "confirm") ?? {};
  const gatePayload = fmc.validateManifest(
    selfTestManifest([{ id: "confirm", kind: "gate", write_scope: ["notes/x.md"] }]),
  );
  const gateWriteDomains = fmc.validateManifest(
    selfTestManifest([{ id: "confirm", kind: "gate", write_domains: ["notes"] }]),
  );
  const commandBoolTimeout = fmc.validateManifest(
    selfTestManifest([commandNode({ command: { argv: ["python"], timeout_seconds: true } })]),
  );
  const gateWorktree = fmc.validateManifest(
    selfTestManifest([{ id: "confirm", kind: "gate", isolation: "worktree" }]),
  );
  const budgetBool = fmc.validateManifest(
    selfTestManifest([commandNode()], { budget: { max_nodes_total: true } }),
  );
  const unknownKind = fmc.validateManifest(
    selfTestManifest([{ id: "x", kind: "wormhole", seed: deepCopy(taskSeed) }]),
  );
  const taskWithCommand = fmc.validateManifest(
    selfTestManifest([{ id: "t", seed: deepCopy(taskSeed), command: { argv: ["python"] } }]),
  );
  return {
    command_node_ok: commandOk.status === "ok"
      && commandRow.kind === "command"
      && commandRow.role === "command"
      && (commandRow.command ?? {}).timeout_seconds === fmc.COMMAND_DEFAULT_TIMEOUT_SECONDS,
    command_requires_command_block: commandMissingBlock.status === "failed"
      && commandMissingBlock.errors.some((item) => item.includes("requires command object")),
    command_argv_fails_closed: commandBadArgv.status === "failed"
      && commandBadArgv.errors.some((item) => item.includes("command.argv")),
    command_rejects_worktree_isolation: commandWorktree.status === "failed"
      && commandWorktree.errors.some((item) => item.includes("does not support worktree isolation")),
    command_cwd_stays_in_repo: commandEscapeCwd.status === "failed"
      && commandEscapeCwd.errors.some((item) => item.includes("repo-relative path")),
    gate_node_ok: gateOk.status === "ok" && gateRow.kind === "gate" && gateRow.role === "gate",
  };
}

export function selfTest() {
  const checks = {};
  for (const runCase of [
    caseValidAndExample,
    caseRouteModelBinding,
    caseConflictAndCycle,
    caseDeferredDependencyInput,
    caseTargetIsolation,
    caseReadScopeLayers,
    caseNodeKinds,
  ]) {
    for (const [name, passed] of Object.entries(runCase())) {
      if (Object.hasOwn(checks, name)) throw new ToolError(`duplicate self-test check name: ${name}`);
      checks[name] = Boolean(passed);
    }
  }
  return { status: Object.values(checks).every(Boolean) ? "ok" : "failed", checks };
}
