// 角色推荐行与模型档位的真实契约自测。夹具只覆盖解析与校验规则，不读取、不断言生产配置取值。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveModelConfigSources } from "../model_config.mjs";
import { ToolError } from "./_tool_common.mjs";
import { EFFORT_LEVELS, loadSelectionConfig, modelEfforts, projectCatalog, resolveSelection, resolveWorkerResources } from "./model_selection.mjs";

const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.stack || error?.message || String(error) });
    console.error(`fail ${name}: ${error?.message ?? error}`);
  }
}

const NOTES = [
  "version = 1",
  '[notes."p/wide"]',
  'tag = "宽"',
  "supports_vision = true",
  '[notes."p/narrow"]',
  'tag = "窄"',
  'efforts = ["low", "medium", "high", "xhigh"]',
  'effort_note = "给人看的备注"',
  '[notes."p/tiny"]',
  'efforts = ["off", "minimal", "low", "medium"]',
  "",
].join("\n");

// executor：两个任务类型，plan-execution 有专属默认；角色默认给 scoped-execution。
const EXECUTOR = [
  'name = "executor-agent"',
  'description = "执行"',
  "[[picks]]",
  'id = "regular"',
  'when = "常规实现"',
  'model = "p/wide"',
  'effort = "high"',
  'effort_min = "low"',
  'effort_max = "xhigh"',
  "default = true",
  "[[picks]]",
  'id = "backend"',
  'when = "复杂后端"',
  'model = "p/narrow"',
  'effort = "high"',
  'effort_min = "medium"',
  'effort_max = "xhigh"',
  "[[picks]]",
  'id = "plan"',
  'capability = "plan-execution"',
  'model = "p/narrow"',
  'effort = "medium"',
  'effort_min = "low"',
  'effort_max = "high"',
  "default = true",
  "[[picks]]",
  'id = "wide_low"',
  'when = "同模型第二行"',
  'model = "p/wide"',
  'effort = "low"',
  'effort_min = "off"',
  'effort_max = "medium"',
  "",
].join("\n");

function writeRoute(root, role, capability) {
  const dir = path.join(root, "ops", "protocols", "task-package-routes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${role}__${capability}.md`), [
    "```yaml task_package_agent",
    "agent:",
    `  role: ${role}`,
    "  capability:",
    `    name: ${capability}`,
    "```",
    "```json route_card",
    `{ "applies_to": "${capability} fixture", "dispatch_phase": { "kind": "direct" } }`,
    "```",
    "",
  ].join("\n"), "utf8");
}

function fixture({ executor = EXECUTOR, notes = NOTES, extraRoles = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "model-selection-"));
  mkdirSync(path.join(root, "ops", "agents"), { recursive: true });
  writeFileSync(path.join(root, "ops", "model-notes.toml"), notes, "utf8");
  writeRoute(root, "executor-agent", "scoped-execution");
  writeRoute(root, "executor-agent", "plan-execution");
  writeFileSync(path.join(root, "ops", "agents", "executor-agent.toml"), executor, "utf8");
  for (const [name, text] of Object.entries(extraRoles)) writeFileSync(path.join(root, "ops", "agents", `${name}.toml`), text, "utf8");
  return root;
}

function withFixture(options, fn) {
  const root = fixture(options);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function load(root) {
  return loadSelectionConfig(resolveModelConfigSources({ roots: [{ root, source: "fixture" }], projectRoot: root }));
}

function resolve(config, input) {
  return resolveSelection(config, { role: "executor-agent", capability: "scoped-execution", ...input });
}

function rejects(root, expected) {
  assert.throws(() => load(root), (error) => {
    assert.ok(error instanceof ToolError, String(error));
    for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value, `${key}: ${error.message}`);
    return true;
  });
}

const replacePick = (id, from, to) => EXECUTOR.replace(new RegExp(`(id = "${id}"[\\s\\S]*?)${from}`), `$1${to}`);

check("picks keep file order and project the §7 shape", () => withFixture({}, (root) => {
  const catalog = projectCatalog(load(root), { piModels: null });
  const role = catalog.roles.find((item) => item.role === "executor-agent");
  assert.deepEqual(role.picks.map((pick) => pick.id), ["regular", "backend", "plan", "wide_low"]);
  assert.deepEqual(Object.keys(role.picks[0]).sort(), ["capability", "default", "effort", "effort_max", "effort_min", "id", "model", "when"]);
  assert.deepEqual(role.picks[2], { id: "plan", when: "", capability: "plan-execution", model: "p/narrow", effort: "medium", effort_min: "low", effort_max: "high", default: true });
  assert.deepEqual(role.capabilities.map(({ id, default_pick, inherit_role_picks }) => [id, default_pick, inherit_role_picks]),
    [["plan-execution", "plan", true], ["scoped-execution", "regular", true]]);
  const narrow = catalog.models.find((item) => item.model === "p/narrow");
  assert.deepEqual(narrow, { model: "p/narrow", tag: "窄", supports_vision: null, efforts: ["low", "medium", "high", "xhigh"], effort_note: "给人看的备注", in_pi: null });
  assert.deepEqual(catalog.warnings, []);
}));

check("configuration fingerprints describe selection content, not deployment paths", () => withFixture({}, (root) => {
  const before = resolve(load(root), {}).config_source.config_fingerprint;
  assert.match(before, /^sha256:[a-f0-9]{64}$/u);
  withFixture({}, (otherRoot) => {
    assert.equal(resolve(load(otherRoot), {}).config_source.config_fingerprint, before);
  });
  writeFileSync(path.join(root, "ops", "model-notes.toml"), NOTES.replace('tag = "宽"', 'tag = "宽模型"'), "utf8");
  assert.notEqual(resolve(load(root), {}).config_source.config_fingerprint, before);
}));

check("models are the union of Pi list, notes and picks; picks outside Pi only warn", () => withFixture({}, (root) => {
  const catalog = projectCatalog(load(root), { piModels: ["p/wide", "q/other"] });
  assert.deepEqual(catalog.models.map((item) => [item.model, item.in_pi]),
    [["p/wide", true], ["q/other", true], ["p/narrow", false], ["p/tiny", false]]);
  assert.deepEqual(catalog.models.find((item) => item.model === "q/other").efforts, [...EFFORT_LEVELS]);
  assert.deepEqual(catalog.warnings.map(({ code, field, pick_id }) => [code, field, pick_id]),
    [["model_not_in_pi", "picks[1].model", "backend"], ["model_not_in_pi", "picks[2].model", "plan"]]);
}));

check("capability filter keeps own rows plus inherited role rows", () => withFixture({}, (root) => {
  const config = load(root);
  const [role] = projectCatalog(config, { role: "executor-agent", capability: "scoped-execution" }).roles;
  assert.deepEqual(role.picks.map((pick) => pick.id), ["regular", "backend", "wide_low"]);
  assert.deepEqual(role.capabilities.map((item) => item.id), ["scoped-execution"]);
  assert.deepEqual(projectCatalog(config, { role: "executor-agent", capability: "plan-execution" }).roles[0].picks.map((pick) => pick.id),
    ["regular", "backend", "plan", "wide_low"]);
}));

check("default row, pick and explicit effort inside the row range", () => withFixture({}, (root) => {
  const config = load(root);
  const omitted = resolve(config, {});
  assert.deepEqual([omitted.pick, omitted.resolved_model, omitted.resolved_effort, omitted.effort_source], ["regular", "p/wide", "high", "pick"]);
  assert.deepEqual(omitted.efforts, [...EFFORT_LEVELS]);
  assert.deepEqual(omitted.effort_range, ["low", "xhigh"]);
  assert.equal(omitted.authorization, null);
  assert.equal(resolveSelection(config, { role: "executor-agent", capability: "plan-execution" }).pick, "plan");
  const picked = resolve(config, { pick: "backend", effort: "medium" });
  assert.deepEqual([picked.resolved_model, picked.resolved_effort, picked.effort_source], ["p/narrow", "medium", "explicit"]);
  assert.throws(() => resolve(config, { pick: "plan" }), /只用于任务类型 plan-execution/);
  assert.throws(() => resolve(config, { pick: "backend", model: "p/wide" }), /只能填一个/);
  assert.throws(() => resolve(config, { pick: "missing" }), /推荐行不存在：missing/);
}));

check("model without effort: effective default first, then applicable rows in order", () => withFixture({}, (root) => {
  const config = load(root);
  assert.deepEqual([resolve(config, { model: "p/wide" }).pick, resolve(config, { model: "p/wide" }).resolved_effort], ["regular", "high"]);
  assert.equal(resolve(config, { model: "p/narrow" }).pick, "backend");
  const plan = resolveSelection(config, { role: "executor-agent", capability: "plan-execution", model: "p/narrow" });
  assert.deepEqual([plan.pick, plan.resolved_effort], ["plan", "medium"]);
}));

check("rows of another capability do not match; model outside the pool needs outside_pool", () => withFixture({
  executor: EXECUTOR.replace('model = "p/narrow"\neffort = "medium"\neffort_min = "low"\neffort_max = "high"',
    'model = "p/tiny"\neffort = "medium"\neffort_min = "low"\neffort_max = "medium"'),
}, (root) => {
  const config = load(root);
  assert.throws(() => resolve(config, { model: "p/tiny" }), /必须显式给出 effort/);
  const pooled = resolve(config, { model: "p/tiny", effort: "low" });
  assert.deepEqual([pooled.pick, pooled.effort_range, pooled.authorization], [null, null, null]);
  assert.throws(() => resolve(config, { model: "q/other", effort: "low" }), /outside_pool/);
  const outside = resolve(config, { model: "q/other", effort: "low", authorization: { quote: "用这个", overrides: ["outside_pool"] } });
  assert.deepEqual(outside.authorization.applied_overrides.map((item) => item.kind), ["outside_pool"]);
  assert.deepEqual(outside.authorization.applied_overrides[0].previous_value, ["p/wide", "p/narrow", "p/tiny"]);
}));

check("effort outside the row range needs effort_range; outside model efforts is refused even with authorization", () => withFixture({}, (root) => {
  const config = load(root);
  assert.throws(() => resolve(config, { pick: "backend", effort: "low" }), /effort_range/);
  const granted = resolve(config, { pick: "backend", effort: "low", authorization: JSON.stringify({ quote: "就用低档", overrides: ["effort_range"] }) });
  assert.deepEqual(granted.authorization.applied_overrides, [{ kind: "effort_range", previous_value: ["medium", "xhigh"] }]);
  assert.deepEqual(granted.authorization.requested_overrides, ["effort_range"]);
  const unneeded = resolve(config, { pick: "backend", effort: "high", authorization: { quote: "随意", overrides: ["effort_range"] } });
  assert.deepEqual(unneeded.authorization.applied_overrides, []);
  assert.throws(() => resolve(config, { pick: "backend", effort: "max", authorization: { quote: "要最高", overrides: ["effort_range", "outside_pool"] } }),
    /不在 p\/narrow 的可选档位.*授权不能解除/);
  assert.throws(() => resolve(config, { effort: "bogus" }), /effort 必须是/);
  for (const bad of [{ quote: "x", overrides: ["model_max_effort"] }, { quote: "", overrides: [] }, "not json"]) {
    assert.throws(() => resolve(config, { pick: "backend", effort: "low", authorization: bad }), /authorization/);
  }
  assert.deepEqual(modelEfforts(config, "p/narrow"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(modelEfforts(config, "unknown/model"), [...EFFORT_LEVELS]);
}));

check("invalid pick rows fail with code, file, field, role and pick_id", () => {
  const cases = [
    [replacePick("backend", 'effort_min = "medium"\neffort_max = "xhigh"', 'effort_min = "xhigh"\neffort_max = "medium"'),
      { code: "effort_order", field: "picks[1].effort_min", pick_id: "backend" }],
    [replacePick("backend", 'effort = "high"', 'effort = "low"'), { code: "effort_order", field: "picks[1].effort", pick_id: "backend" }],
    [replacePick("backend", 'effort_min = "medium"', 'effort_min = "off"'), { code: "effort_not_supported", field: "picks[1].effort_min", pick_id: "backend" }],
    [replacePick("backend", 'effort_max = "xhigh"', 'effort_max = "max"'), { code: "effort_not_supported", field: "picks[1].effort_max" }],
    [replacePick("regular", 'effort = "high"', 'effort = "extreme"'), { code: "value_invalid", field: "picks[0].effort", role: "executor-agent" }],
    [replacePick("backend", 'model = "p/narrow"', 'slot = "backend"\nmodel = "p/narrow"'), { code: "field_removed", field: "picks[1].slot" }],
    [replacePick("backend", 'model = "p/narrow"', 'model = "p/narrow"\ncolor = "red"'), { code: "field_unknown", field: "picks[1].color" }],
    [replacePick("backend", 'model = "p/narrow"', 'capability = ""\nmodel = "p/narrow"'), { code: "value_invalid", field: "picks[1].capability" }],
    [replacePick("backend", 'model = "p/narrow"', 'capability = "no-such"\nmodel = "p/narrow"'), { code: "capability_unknown", field: "picks[1].capability" }],
    [replacePick("backend", 'model = "p/narrow"', 'model = "narrow"'), { code: "value_invalid", field: "picks[1].model" }],
    [EXECUTOR.replace('id = "backend"', 'id = "regular"'), { code: "pick_duplicate", field: "picks[1].id" }],
    [replacePick("wide_low", 'effort_max = "medium"', 'effort_max = "medium"\ndefault = "yes"'), { code: "value_invalid", field: "picks[3].default" }],
    [EXECUTOR.replace('description = "执行"', 'description = "执行"\npi_effort_limits = []'), { code: "field_removed", field: "pi_effort_limits" }],
    // 形状错误报定位错误，不当作没写：capabilities 不是表、inherit_role_picks 不是布尔。
    [EXECUTOR.replace('description = "执行"', 'description = "执行"\ncapabilities = "damaged"'), { code: "value_invalid", field: "capabilities" }],
    [EXECUTOR.replace('description = "执行"', 'description = "执行"\n[capabilities.plan-execution]\ninherit_role_picks = "no"'),
      { code: "value_invalid", field: "capabilities.plan-execution.inherit_role_picks" }],
  ];
  for (const [executor, expected] of cases) {
    withFixture({ executor }, (root) => rejects(root, { file: path.join(root, "ops", "agents", "executor-agent.toml"), ...expected }));
  }
});

check("default rows: one per capability, at most one role default, required only where it is used", () => {
  const second = replacePick("wide_low", 'effort_max = "medium"', 'effort_max = "medium"\ndefault = true');
  withFixture({ executor: second }, (root) => rejects(root, { code: "default_duplicate", field: "picks[3].default" }));
  const twoPlan = `${EXECUTOR}[[picks]]\nid = "plan2"\ncapability = "plan-execution"\nmodel = "p/wide"\neffort = "low"\neffort_min = "low"\neffort_max = "low"\ndefault = true\n`;
  withFixture({ executor: twoPlan }, (root) => rejects(root, { code: "default_duplicate", field: "picks[4].default", pick_id: "plan2" }));
  // scoped-execution 没有专属默认，依赖角色默认。
  const noRoleDefault = EXECUTOR.replace('effort_max = "xhigh"\ndefault = true', 'effort_max = "xhigh"');
  withFixture({ executor: noRoleDefault }, (root) => rejects(root, { code: "default_missing", field: "picks" }));
  // 两个任务类型都有专属默认时，角色默认可以没有。
  const allOwn = `${noRoleDefault}[[picks]]\nid = "scoped"\ncapability = "scoped-execution"\nmodel = "p/wide"\neffort = "high"\neffort_min = "high"\neffort_max = "high"\ndefault = true\n`;
  withFixture({ executor: allOwn }, (root) => {
    const config = load(root);
    assert.equal(resolve(config, {}).pick, "scoped");
  });
  // 角色没有任务类型（分身）时必须有角色默认。
  const delegate = 'name = "delegate-work"\n[[picks]]\nid = "only"\nmodel = "p/wide"\neffort = "high"\neffort_min = "off"\neffort_max = "max"\n';
  withFixture({ extraRoles: { "delegate-work": delegate } }, (root) => rejects(root, { code: "default_missing", field: "picks", role: "delegate-work" }));
  withFixture({ extraRoles: { "delegate-work": `${delegate}default = true\n` } }, (root) => {
    assert.equal(resolveSelection(load(root), { role: "delegate-work", capability: "delegate_work" }).pick, "only");
  });
});

check("a capability that does not inherit role picks needs exactly its own default", () => {
  const sealed = EXECUTOR.replace('description = "执行"', 'description = "执行"\n[capabilities.plan-execution]\ninherit_role_picks = false');
  withFixture({ executor: sealed }, (root) => {
    const config = load(root);
    const [role] = projectCatalog(config, { role: "executor-agent", capability: "plan-execution" }).roles;
    assert.deepEqual(role.picks.map((pick) => pick.id), ["plan"]);
    assert.equal(role.capabilities[0].inherit_role_picks, false);
    // 显式点名通用行仍按旧规则放行；只有缺省选择不回落角色默认。
    assert.equal(resolveSelection(config, { role: "executor-agent", capability: "plan-execution", pick: "regular" }).pick, "regular");
  });
  const withoutOwn = sealed.replace('effort_max = "high"\ndefault = true', 'effort_max = "high"');
  withFixture({ executor: withoutOwn }, (root) => rejects(root, { code: "default_missing", field: "capabilities.plan-execution" }));
});

check("model notes: efforts must be a non-empty ordered subset; removed keys name their replacement", () => {
  const cases = [
    ['efforts = ["low", "medium", "high", "xhigh"]', "efforts = []", "value_invalid", 'notes."p/narrow".efforts'],
    ['efforts = ["low", "medium", "high", "xhigh"]', 'efforts = ["high", "low"]', "value_invalid", 'notes."p/narrow".efforts'],
    ['efforts = ["low", "medium", "high", "xhigh"]', 'efforts = ["low", "low", "high", "xhigh"]', "value_invalid", 'notes."p/narrow".efforts'],
    ['efforts = ["low", "medium", "high", "xhigh"]', 'efforts = ["low", "turbo"]', "value_invalid", 'notes."p/narrow".efforts'],
    ['tag = "宽"', 'tag = "宽"\nmax_effort = "high"', "field_removed", 'notes."p/wide".max_effort'],
    ['tag = "宽"', 'tag = "宽"\nstatus = "retired"', "field_removed", 'notes."p/wide".status'],
    ['tag = "宽"', 'tag = "宽"\neffort_levels = []', "field_removed", 'notes."p/wide".effort_levels'],
    ["supports_vision = true", 'supports_vision = "yes"', "value_invalid", 'notes."p/wide".supports_vision'],
  ];
  for (const [from, to, code, field] of cases) {
    withFixture({ notes: NOTES.replace(from, to) }, (root) => rejects(root, { code, field, file: path.join(root, "ops", "model-notes.toml") }));
  }
  // notes 存在但不是表：报错，不当作「没有笔记、七档全开」。
  withFixture({ notes: 'version = 1\nnotes = "damaged"\n' }, (root) => rejects(root, { code: "value_invalid", field: "notes", file: path.join(root, "ops", "model-notes.toml") }));
});

const ROLE_RESOURCES = [
  'tools = ["read", "bash", "web_search"]',
  'extensions = ["pi-web-access", "@narumitw/pi-lsp"]',
  'skills = ["git-recovery", "rule-authoring"]',
  'project_skills = "all"',
].join("\n");

function withWorkerResources(topLevel, capabilityTable, fn) {
  const executor = EXECUTOR.replace('description = "执行"\n', `description = "执行"\n${topLevel}\n${capabilityTable}\n`);
  return withFixture({ executor }, fn);
}

check("worker whitelist: capability narrows or inherits, role without keys is unmanaged", () => {
  withWorkerResources(ROLE_RESOURCES, ["[capabilities.plan-execution]", 'tools = ["read"]', "skills = []", 'project_skills = ["proj-a"]'].join("\n"), (root) => {
    const config = load(root);
    assert.deepEqual(resolveWorkerResources(config, "executor-agent", "scoped-execution"), {
      tools: ["read", "bash", "web_search"],
      extensions: ["pi-web-access", "@narumitw/pi-lsp"],
      skills: ["git-recovery", "rule-authoring"],
      project_skills: "all",
    });
    assert.deepEqual(resolveWorkerResources(config, "executor-agent", "plan-execution"), {
      tools: ["read"],
      extensions: ["pi-web-access", "@narumitw/pi-lsp"],
      skills: [],
      project_skills: ["proj-a"],
    });
  });
  withFixture({}, (root) => assert.equal(resolveWorkerResources(load(root), "executor-agent", "scoped-execution"), null));
});

check("worker whitelist: widening a capability fails with file and field", () => {
  const cases = [
    [ROLE_RESOURCES, ['[capabilities.plan-execution]', 'tools = ["read", "powershell"]'], "capabilities.plan-execution.tools"],
    [ROLE_RESOURCES, ['[capabilities.plan-execution]', 'extensions = ["pi-mcp-adapter"]'], "capabilities.plan-execution.extensions"],
    [ROLE_RESOURCES, ['[capabilities.plan-execution]', 'skills = ["writing-governance"]'], "capabilities.plan-execution.skills"],
    [ROLE_RESOURCES.replace('project_skills = "all"', 'project_skills = "none"'),
      ['[capabilities.plan-execution]', 'project_skills = "all"'], "capabilities.plan-execution.project_skills"],
    [ROLE_RESOURCES.replace('project_skills = "all"', 'project_skills = ["proj-a"]'),
      ['[capabilities.plan-execution]', 'project_skills = ["proj-a", "proj-b"]'], "capabilities.plan-execution.project_skills"],
    [ROLE_RESOURCES.replace('project_skills = "all"', 'project_skills = "some"'), [], "project_skills"],
    [ROLE_RESOURCES.replace('tools = ["read", "bash", "web_search"]', 'tools = "read"'), [], "tools"],
  ];
  for (const [topLevel, table, field] of cases) {
    withWorkerResources(topLevel, table.join("\n"), (root) => {
      assert.throws(() => load(root), (error) => error instanceof ToolError && error.field === field && error.file.endsWith("executor-agent.toml"), field);
    });
  }
});

check("loadSelectionConfig needs the full sources object", () => withFixture({}, (root) => {
  assert.throws(() => loadSelectionConfig({ agents_dir: path.join(root, "ops", "agents"), model_notes: path.join(root, "ops", "model-notes.toml") }),
    /resolveModelConfigSources/);
  assert.equal(readFileSync(path.join(root, "ops", "model-notes.toml"), "utf8"), NOTES);
}));

if (failures.length) {
  console.error(`MODEL_SELECTION_SELF_TEST_FAIL ${failures.length}`);
  process.exit(1);
}
console.log("MODEL_SELECTION_SELF_TEST_OK");
