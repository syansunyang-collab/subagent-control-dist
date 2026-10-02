// ops/tools/seed_minimal.py 的 JS 复刻：差异卡解析、最小 seed 展开与模板渲染。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」；导出名为 Python 名的 camelCase，
// 位置参数同序，Python 关键字参数作为末尾 options 对象（本模块无关键字参数）。
//
// 异常映射表（Python 分支 → JS 抛出物）：
//   validate_planner_mechanical_schema  planner 闭集缺失或不完整          ToolError → ToolError
//   inject_acceptance_mechanical_contract acceptance 闭集不完整           ToolError → ToolError
//   example_seed / expand_seed / render_template  route 无差异卡           ToolError → ToolError
//   expand_seed                          无 slot 的 route 收到 contract    ToolError → ToolError
//   expand_seed                          goal 缺失且无法从 goal_from 派生   ToolError → ToolError
//   check_required                       required_when 结构非法            ToolError → ToolError
//   check_required                       缺字段 / 取值非法                  ToolError → ToolError
//   check_scoped_targets_authorized      target_paths 越权                 ToolError → ToolError
//   resolve_vars                         引用未设置 / 未知变量              ToolError → ToolError
//   card_for / profile_for               未注册 route_id                   KeyError → pyError("KeyError", repr)（task_package_profiles.mjs 抛出）
//   auto_slug                            route_id 不含 "__"                IndexError → pyError("IndexError", "list index out of range")
//   set_path 中间层非 dict                                                TypeError → 原生 TypeError（与 Python 同为崩溃分支，未在语料中触发）
//
// 有意的实现差异（不改变可观察行为）：
//   PLACEHOLDER_RE 用 /^<[\s\S]*>\n?$/ 复刻 Python `re.compile(r"^<.*>$", re.DOTALL)` 的 `$`
//   （Python 的 `$` 也匹配结尾换行前；调用方总是先 strip，两者布尔结果相同）。
//   planning_schema_snapshot 的闭集来自 ops/templates/planning-schema.json，
//   acceptance_schema_snapshot 的闭集来自 ops/templates/acceptance-schema.json，两者都与 Python 侧同源；
//   "source" 仍是注入任务包的字面量 "ops/tools/planning_manifest_check.py" 与
//   "ops/tools/acceptance_contract_check.py"。
import path from "node:path";

import {
  ROOT,
  RUNTIME_ROOT,
  ToolError,
  ids,
  isRecord,
  modelConfigSources,
  pyError,
  utcDateStamp,
} from "./_tool_common.mjs";
import {
  pyGet, pyGetItem, pyJsonDumps, pyOr, pyReadText, pyStr, pyStripChars, pyTruthy,
} from "./_py.mjs";
import { SEED_BODY_REQUIRED, profileFor, routeProfiles } from "./task_package_profiles.mjs";
import { packageId as computePackageId, readProjectName, stringList } from "./task_package_build.mjs";
import { MODEL_SELECTION_GUIDANCE } from "./model_selection_guidance.mjs";
import { loadSelectionConfig, modelEfforts, projectCatalog } from "./model_selection.mjs";

export { ROOT, ToolError, profileFor, routeProfiles };

// Python `re.compile(r"^<.*>$", re.DOTALL)`。
export const PLACEHOLDER_RE = /^<[\s\S]*>\n?$/;

// 每个完整 package_seed 都有这套字段，最小 seed 不会产出它们；handoff_contract 之类的
// 单项覆盖仍走深合并。
export const FULL_SEED_FIELDS = new Set(SEED_BODY_REQUIRED);

// 最小种子专有键，不得漏进完整 seed。
export const MINIMAL_ONLY_KEYS = new Set(["contract", "slug", "delegation_intent"]);
export const LIST_SEED_FIELDS = new Set([
  "known_facts",
  "scope.write_extra",
  "scope.delete",
  "scope.out_of_scope_extra",
  "contract.mechanical_checks",
  "contract.required_sections",
]);
export const PLANNER_SCHEMA_LIST_KEYS = [
  "planning_pass_values",
  "interface_contract_kind_values",
  "interface_contract_stability_values",
  "serial_reason_values",
  "dispatch_mode_values",
  "release_gate_values",
  "dependency_type_values",
];

// ---- 本模块私有的小工具（Python 语义助手见 _py.mjs） ----

// copy.deepcopy()。
function deepCopy(value) {
  return structuredClone(value);
}

// Python dict.setdefault(key, {})。
function setDefaultDict(container, key) {
  if (!Object.hasOwn(container, key)) container[key] = {};
  return container[key];
}

// `data.get(a, {}).get(b, {})…` 的链式取值；中间层缺失时返回 undefined。
function chainGet(container, ...keys) {
  let cursor = container;
  for (const key of keys) {
    if (!isRecord(cursor)) return undefined;
    cursor = pyGet(cursor, key);
  }
  return cursor;
}

function isEmptyMapping(value) {
  return isRecord(value) && Object.keys(value).length === 0;
}

// ---- 闭集真源 ----

// planning_manifest_check.py / acceptance_contract_check.py 与本模块共读 ops/templates 下的同一份闭集 JSON。
const schemaCache = new Map();

function templateSchema(name) {
  const file = path.join(RUNTIME_ROOT, "ops", "templates", name);
  if (!schemaCache.has(file)) schemaCache.set(file, JSON.parse(pyReadText(file)));
  return schemaCache.get(file);
}

function sortedCopy(values) {
  return [...values].sort();
}

// planning_manifest_check.planning_schema_snapshot() 的复刻：注入 planner 任务包的校验器闭集。
// "source" 是注入进任务包的数据字面量，两侧同样输出 Python 文件路径。
export function planningSchemaSnapshot() {
  const schema = templateSchema("planning-schema.json");
  return {
    source: "ops/tools/planning_manifest_check.py",
    planning_pass_values: sortedCopy(schema.planning_passes),
    interface_contract_kind_values: sortedCopy(schema.contract_kinds),
    interface_contract_stability_values: sortedCopy(schema.contract_stability),
    serial_reason_values: sortedCopy(schema.serial_reasons),
    dispatch_mode_values: sortedCopy(schema.dispatch_modes),
    release_gate_values: sortedCopy(schema.release_gates),
    dependency_type_values: sortedCopy(schema.dependency_types),
  };
}

// acceptance_contract_check.route_contract_requirements() 的复刻：从 route 卡实时派生，不进闭集 JSON。
function routeContractRequirements() {
  const result = {};
  for (const routeId of templateSchema("acceptance-schema.json").validation_routes) {
    const card = pyGet(profileFor(routeId), "card");
    if (!isRecord(card)) throw new ToolError(`validation route has no route_card: ${routeId}`);
    const paths = [];
    for (const item of pyGet(card, "required", [])) {
      if (!isRecord(item)) continue;
      const itemPath = pyGet(item, "path");
      if (typeof itemPath !== "string" || !itemPath.startsWith("contract.")) continue;
      paths.push(itemPath.slice("contract.".length));
    }
    result[routeId] = paths.sort();
  }
  return result;
}

// acceptance_contract_check.acceptance_schema_snapshot() 的复刻：注入验收出卷任务包的校验器闭集。
// "source" 是注入进任务包的数据字面量，两侧同样输出 Python 文件路径。
function acceptanceSchemaSnapshot() {
  const schema = templateSchema("acceptance-schema.json");
  return {
    source: "ops/tools/acceptance_contract_check.py",
    schema_version: schema.schema_version,
    technique_values: sortedCopy(schema.techniques),
    case_kind_values: sortedCopy(schema.case_kinds),
    severity_values: sortedCopy(schema.severity_values),
    validation_route_values: [...schema.validation_routes],
    entry_route_values: [...schema.entry_routes],
    route_contract_requirements: routeContractRequirements(),
    route_contract_macros: sortedCopy(schema.macros),
    disposition_values: sortedCopy(schema.dispositions),
    max_review_rounds: schema.max_review_rounds,
  };
}

// ---- 模块函数 ----

export function validatePlannerMechanicalSchema(schema) {
  const problems = [];
  if (pyGet(schema, "source") !== "ops/tools/planning_manifest_check.py") problems.push("source");
  for (const key of PLANNER_SCHEMA_LIST_KEYS) {
    const value = pyGet(schema, key);
    if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item)) {
      problems.push(key);
    }
  }
  if (problems.length) {
    throw new ToolError(
      `planner mechanical_schema unavailable or incomplete: ${problems.join(", ")}` +
        "; stop before task material write and repair planning_manifest_check.py schema export",
    );
  }
  return null; // Python 的隐式 None。
}

export function injectPlannerMechanicalSchema(seed) {
  if (pyGet(seed, "route_id") !== "planner-agent__plan-authoring") return seed;
  const schema = planningSchemaSnapshot();
  validatePlannerMechanicalSchema(schema);
  const planner = setDefaultDict(setDefaultDict(setDefaultDict(seed, "extensions"), "capability_contract"), "planner");
  planner.mechanical_schema = schema;
  return seed;
}

export function injectAcceptanceMechanicalContract(seed) {
  const routeId = pyGet(seed, "route_id");
  if (routeId !== "planner-agent__acceptance-authoring" && routeId !== "verify-agent__acceptance-synthesis") {
    return seed;
  }
  const schema = acceptanceSchemaSnapshot();
  const required = [
    "technique_values",
    "case_kind_values",
    "severity_values",
    "validation_route_values",
    "route_contract_macros",
    "disposition_values",
  ];
  const problems = required.filter((key) => {
    const value = pyGet(schema, key);
    return !Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item);
  });
  if (pyGet(schema, "source") !== "ops/tools/acceptance_contract_check.py") problems.push("source");
  if (!isRecord(pyGet(schema, "route_contract_requirements"))) problems.push("route_contract_requirements");
  const maxReviewRounds = pyGet(schema, "max_review_rounds");
  if (typeof maxReviewRounds !== "number" || !Number.isInteger(maxReviewRounds) || maxReviewRounds < 1) {
    problems.push("max_review_rounds");
  }
  if (problems.length) {
    throw new ToolError(
      `acceptance mechanical schema unavailable or incomplete: ${sortedCopy(new Set(problems)).join(", ")}` +
        "; stop before task material write and repair acceptance_contract_check.py",
    );
  }
  const contracts = setDefaultDict(setDefaultDict(seed, "extensions"), "capability_contract");
  if (routeId === "planner-agent__acceptance-authoring") {
    setDefaultDict(contracts, "acceptance_authoring").mechanical_schema = schema;
  } else {
    const synthesis = setDefaultDict(contracts, "acceptance_synthesis");
    synthesis.max_review_rounds = schema.max_review_rounds;
    synthesis.mechanical_schema = {
      source: schema.source,
      disposition_values: schema.disposition_values,
      max_review_rounds: schema.max_review_rounds,
    };
  }
  return seed;
}

export function cardFor(routeId) {
  const card = pyGet(profileFor(routeId), "card");
  return card === undefined ? null : card;
}

export function routesWithCards() {
  const profiles = routeProfiles();
  return Object.entries(profiles)
    .filter(([, profile]) => pyTruthy(pyGet(profile, "card")))
    .map(([routeId]) => routeId)
    .sort();
}

export function listCards() {
  const rows = [];
  const profiles = routeProfiles();
  for (const routeId of Object.keys(profiles).sort()) {
    const card = pyGet(profiles[routeId], "card");
    const source = isRecord(card) ? card : {};
    rows.push({
      route_id: routeId,
      minimal_seed: pyTruthy(card),
      applies_to: pyGet(source, "applies_to", ""),
      model_tier: pyGet(source, "model_tier", ""),
      model_requirements: pyGet(source, "model_requirements", []),
    });
  }
  return rows;
}

export function setPath(data, dotted, value) {
  let cursor = data;
  const keys = String(dotted).split(".");
  for (const key of keys.slice(0, -1)) cursor = setDefaultDict(cursor, key);
  cursor[keys[keys.length - 1]] = deepCopy(value);
  return null; // Python 的隐式 None。
}

// 从差异卡的必填示例构造可派发 seed；卡自带的示例同时是它的测试夹具（--card-check / 自测）。
export function exampleSeed(routeId) {
  const card = cardFor(routeId);
  if (card === null) throw new ToolError(`route ${routeId} has no route_card`);
  const seed = { route_id: routeId };
  for (const req of pyGet(card, "required", [])) {
    let example = pyGet(req, "example");
    if (example === undefined || example === null) {
      const enumValues = pyOr(pyGet(req, "enum"), [null]);
      example = enumValues[0] ?? null;
    }
    setPath(seed, pyGetItem(req, "path"), example);
  }
  return applyInputDefaults(seed, card);
}

export function getPath(data, dotted) {
  let cursor = data;
  for (const part of String(dotted).split(".")) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, part)) return null;
    cursor = cursor[part];
  }
  return cursor;
}

// 让 scope.write 与任务包声明的输出文件保持一致。
export function alignExpectedOutputWrite(full, reportPath, writeExtra) {
  const expected = pyGet(full, "expected_output");
  const scope = pyGet(full, "scope");
  const concurrency = pyGet(full, "concurrency_contract");
  if (!isRecord(expected) || !isRecord(scope)) return null;
  const filePath = pyGet(expected, "file_path");
  let writes = pyGet(scope, "write");
  if (typeof filePath !== "string" || !filePath.trim() || !Array.isArray(writes)) return null;

  if (!writes.includes(filePath)) writes.unshift(filePath);

  const writeExtraSet = new Set(writeExtra);
  if (filePath !== reportPath && writes.includes(reportPath) && !writeExtraSet.has(reportPath)) {
    scope.write = writes.filter((item) => item !== reportPath);
    writes = scope.write;
  }

  if (isRecord(concurrency)) {
    const conflict = pyGet(concurrency, "conflict_keys");
    if (isRecord(conflict)) {
      conflict.write = [...writes];
      conflict.output = filePath;
    }
  }
  return null; // Python 的隐式 None。
}

// 让最小 seed 的 handoff 覆盖与 scope.write 指向同一目的地。
export function alignHandoffOutputWrite(full, defaultHandoffPath, writeExtra) {
  const handoff = pyGet(full, "handoff_contract");
  const scope = pyGet(full, "scope");
  const concurrency = pyGet(full, "concurrency_contract");
  if (!isRecord(handoff) || !isRecord(scope)) return null;
  const resolvedOverride = pyGet(handoff, "resolved_handoff_file");
  if (typeof resolvedOverride === "string" && resolvedOverride.trim()) handoff.handoff_file = resolvedOverride;
  const handoffFile = pyGet(handoff, "handoff_file");
  let writes = pyGet(scope, "write");
  if (typeof handoffFile !== "string" || !handoffFile.trim() || !Array.isArray(writes)) return null;
  if (!writes.includes(handoffFile)) writes.push(handoffFile);
  if (
    handoffFile !== defaultHandoffPath &&
    writes.includes(defaultHandoffPath) &&
    !new Set(writeExtra).has(defaultHandoffPath)
  ) {
    scope.write = writes.filter((item) => item !== defaultHandoffPath);
    writes = scope.write;
  }
  if (isRecord(concurrency)) {
    const conflict = pyGet(concurrency, "conflict_keys");
    if (isRecord(conflict)) conflict.write = [...writes];
  }
  return null; // Python 的隐式 None。
}

export function applyDelegationIntent(full, seed) {
  const intent = stripPlaceholders(pyGet(seed, "delegation_intent"));
  if (typeof intent !== "string" || !intent.trim()) return null;
  setDefaultDict(setDefaultDict(full, "extensions"), "orchestration").delegation_intent = intent.trim();
  return null; // Python 的隐式 None。
}

export function isPlaceholder(value) {
  return typeof value === "string" && PLACEHOLDER_RE.test(value.trim());
}

export function valueMissing(value) {
  if (value === null || value === undefined) return true;
  if (isPlaceholder(value)) return true;
  if (typeof value === "string" && !value.trim()) return true;
  if (Array.isArray(value)) return !value.length || value.some(isPlaceholder);
  return false;
}

// 丢掉调用方忘记填写或删除的模板占位符。
export function stripPlaceholders(value) {
  if (isRecord(value)) {
    const cleaned = {};
    for (const [key, item] of Object.entries(value)) {
      if (isPlaceholder(item)) continue;
      cleaned[key] = stripPlaceholders(item);
    }
    const out = {};
    for (const [key, item] of Object.entries(cleaned)) {
      if (item === null || item === undefined) continue;
      out[key] = item;
    }
    return out;
  }
  if (Array.isArray(value)) return value.filter((item) => !isPlaceholder(item)).map(stripPlaceholders);
  if (isPlaceholder(value)) return null;
  return value === undefined ? null : value;
}

export function listSeedValues(value) {
  if (valueMissing(value)) return [];
  if (Array.isArray(value)) return value.filter((item) => !isPlaceholder(item)).map(pyStr);
  return [pyStr(value)];
}

export function deepMerge(base, overlay) {
  for (const [key, value] of Object.entries(overlay)) {
    if (isRecord(value) && isRecord(pyGet(base, key))) deepMerge(base[key], value);
    else base[key] = deepCopy(value);
  }
  return base;
}

export function resolveVars(value, ctx) {
  if (typeof value === "string" && value.startsWith("$")) {
    const key = value.slice(1);
    if (key.startsWith("contract.")) {
      const contract = pyOr(pyGet(ctx, "contract"), {});
      const inner = pyGet(contract, key.slice(key.indexOf(".") + 1));
      if (inner === null || inner === undefined) throw new ToolError(`route_card default references unset ${value}`);
      return deepCopy(inner);
    }
    if (isRecord(ctx) && Object.hasOwn(ctx, key)) return deepCopy(ctx[key]);
    throw new ToolError(`route_card default references unknown variable ${value}`);
  }
  if (Array.isArray(value)) return value.map((item) => resolveVars(item, ctx));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveVars(item, ctx)]));
  }
  return value;
}

export function autoSlug(routeId, goal) {
  // Python `route_id.split("__", 1)[1]`：不含分隔符时 IndexError。
  const parts = String(routeId).split("__");
  if (parts.length < 2) throw pyError("IndexError", "list index out of range");
  const capability = parts.slice(1).join("__");
  const stamp = utcDateStamp();
  return `${capability}-${stamp}-${ids.uuidHex().slice(0, 12)}`;
}

function applyInputDefaults(seed, card) {
  const normalized = deepCopy(seed);
  for (const [key, value] of Object.entries(card.input_defaults ?? {})) {
    const parts = key.split(".");
    const parent = parts.slice(0, -1).reduce((node, part) => node?.[part], normalized);
    const current = parent?.[parts.at(-1)];
    const placeholder = isPlaceholder(current) ||
      (Array.isArray(current) && current.length > 0 && current.every(isPlaceholder));
    if (parent && Object.hasOwn(parent, parts.at(-1)) && !placeholder) continue;
    setPath(normalized, key, resolveVars(value, {
      goal: normalized.goal,
      scope_read: normalized.scope?.read ?? null,
    }));
  }
  return normalized;
}

export function checkRequired(seed, card, routeId) {
  const problems = [];
  const derived = pyGet(card, "optional", []).filter((item) => Object.hasOwn(card.input_defaults ?? {}, item.path));
  for (const req of [...pyGet(card, "required", []), ...derived]) {
    // 业务轮次由执行者消费，编译器不强制必填、闭集或逐面覆盖。
    if (["contract.planning_pass", "contract.review_round", "contract.surface_rounds"].includes(req.path)) continue;
    const condition = pyGet(req, "required_when");
    if (condition !== null && condition !== undefined) {
      const keys = isRecord(condition) ? Object.keys(condition).sort() : null;
      if (!keys || keys.length !== 2 || keys[0] !== "equals" || keys[1] !== "path") {
        throw new ToolError(`route ${routeId} required_when must contain only path and equals`);
      }
      const conditionPath = pyGet(condition, "path");
      if (typeof conditionPath !== "string" || !conditionPath.trim()) {
        throw new ToolError(`route ${routeId} required_when.path must be a non-empty string`);
      }
      if (getPath(seed, conditionPath) !== pyGet(condition, "equals", null)) continue;
    }
    const reqPath = pyGetItem(req, "path");
    const value = getPath(seed, reqPath);
    const hint = pyGet(req, "hint", "");
    const example = pyGet(req, "example", null);
    if (valueMissing(value) && !(pyGet(req, "allow_empty") === true && Array.isArray(value) && !value.length)) {
      let line = `缺 ${reqPath}`;
      if (pyTruthy(hint)) line += `：${hint}`;
      if (pyTruthy(pyGet(req, "enum"))) line += `；只能取 ${pyGetItem(req, "enum").join(" | ")}`;
      if (example !== null && example !== undefined && !(typeof example === "string" && example.startsWith("$"))) {
        line += `；示例: ${pyJsonDumps(example)}`;
      }
      problems.push(line);
      continue;
    }
    const enumValues = pyGet(req, "enum");
    if (pyTruthy(enumValues) && !enumValues.includes(value)) {
      problems.push(`${reqPath} 取值非法：只能取 ${enumValues.join(" | ")}，收到 ${pyJsonDumps(value)}`);
    }
  }
  if (problems.length) {
    throw new ToolError(
      `minimal seed 不完整，逐项补齐后重试：\n- ${problems.join("\n- ")}` +
        `\n骨架参考: node ops/tools/dispatch_prepare.mjs --seed-template ${routeId}`,
    );
  }
  return null; // Python 的隐式 None。
}

export function genericSeed(routeId, pkgId, goal, scope, reportPath, handoffPath) {
  return {
    route_id: routeId,
    package_id: pkgId,
    goal,
    project_positioning: {
      project: readProjectName(),
      status: "见 STATUS.md",
      roadmap: "见 ROADMAP.md",
    },
    scope,
    ownership: {
      owner: "child_agent",
      parent_forbidden_same_scope_probe: true,
    },
    concurrency_contract: {
      group_id: `dispatch-${routeId}`,
      lane_id: pkgId,
      depends_on: [],
      conflict_keys: {
        read: [...pyGetItem(scope, "read")],
        write: [...pyGetItem(scope, "write")],
        delete: [],
        output: reportPath,
      },
      parallel_policy: "allowed_if_no_conflict",
    },
    inputs: { question: goal },
    known_facts: [],
    expected_output: {
      mode: "file",
      file_path: reportPath,
    },
    runtime_context: {
      network_needed: "no",
    },
    alignment: {
      alignment_state_ref: null,
      planner_allowed: false,
      guard_status: "not_applicable",
    },
    planning_policy: {
      plan_required: false,
      reason: "outside PLAN single dispatch",
    },
    tool_contract: {
      allowed: null,
      forbidden: [],
      network_allowed: false,
      install_allowed: false,
    },
    stop_conditions: [
      "required input file missing",
      "scope authorization conflict",
      "output contract cannot be satisfied",
    ],
    extensions: {},
    handoff_contract: {
      handoff_file_required: true,
      handoff_file: handoffPath,
      accept_verdicts: ["done", "partial", "needs_owner", "failed"],
    },
  };
}

// 返回完整 package_seed；完整 seed 原样直通。
export function expandSeed(seed) {
  const routeId = pyGet(seed, "route_id");
  if (typeof routeId !== "string" || !routeId.trim()) {
    throw new ToolError("package_seed.route_id is required at the JSON root");
  }
  const profile = profileFor(routeId);
  if ([...FULL_SEED_FIELDS].every((key) => isRecord(seed) && Object.hasOwn(seed, key))) {
    const fullSeed = injectPlannerMechanicalSchema(deepCopy(seed));
    return injectAcceptanceMechanicalContract(fullSeed);
  }
  const card = pyGet(profile, "card");
  if (card === null || card === undefined) {
    throw new ToolError(
      `route ${routeId} 没有差异卡，最小种子不可用；按 ${pyGetItem(profile, "route_file")} 提供完整 package_seed，` +
        `已支持最小种子的 route: ${pyOr(routesWithCards().join(", "), "(none)")}`,
    );
  }
  seed = applyInputDefaults(seed, card);
  const scopeIn = pyOr(pyGet(seed, "scope"), {});
  if (Object.hasOwn(scopeIn, "write")) {
    scopeIn.write_extra = [...new Set([
      ...listSeedValues(pyGet(scopeIn, "write_extra")),
      ...stringList(scopeIn.write, "scope.write"),
    ])];
  }
  checkRequired(seed, card, routeId);

  let goalValue = pyGet(seed, "goal");
  if (valueMissing(goalValue)) {
    const goalFrom = pyGet(card, "goal_from");
    let source = typeof goalFrom === "string" && goalFrom ? getPath(seed, goalFrom) : null;
    if (Array.isArray(source)) {
      source = source.find((item) => typeof item === "string" && item.trim()) ?? null;
    }
    if (valueMissing(source)) {
      throw new ToolError(
        `minimal seed 缺 goal，且 route ${routeId} 无法从 ${pyOr(goalFrom, "route card")} 派生`,
      );
    }
    goalValue = source;
  }
  const goal = pyStr(goalValue).trim();
  const scopeRead = pyGet(scopeIn, "read", []).map(pyStr);
  const slugValue = pyGet(seed, "slug");
  const slug =
    typeof slugValue === "string" && pyStr(slugValue).trim() && !isPlaceholder(slugValue)
      ? pyStr(slugValue).trim()
      : autoSlug(routeId, goal);

  const pkgId = computePackageId(routeId, seed);
  const reportDir = pyStripChars(pyStr(pyGet(card, "report_dir", "notes/general")), "/");
  const reportPath = `${reportDir}/${slug}.md`;
  const handoffPath = `notes/handoffs/${pkgId}.md`;

  const writeExtra = listSeedValues(pyGet(scopeIn, "write_extra"));
  const scope = {
    read: scopeRead,
    write: [reportPath, handoffPath, ...writeExtra],
    delete: listSeedValues(pyGet(scopeIn, "delete")),
    out_of_scope: listSeedValues(pyGet(scopeIn, "out_of_scope_extra")),
  };

  const contractIn = stripPlaceholders(pyOr(pyGet(seed, "contract"), {}));
  const ctx = {
    route_id: routeId,
    goal,
    slug,
    scope_read: scopeRead,
    report_path: reportPath,
    handoff_path: handoffPath,
    contract: contractIn,
  };
  const contract = resolveVars(pyGet(card, "contract_defaults", {}), ctx);
  deepMerge(contract, contractIn);
  // 轮次值原样进入任务材料，包括空值和模板形态，由业务执行者解释。
  for (const field of ["planning_pass", "review_round", "surface_rounds"]) {
    if (Object.hasOwn(seed.contract ?? {}, field)) contract[field] = deepCopy(seed.contract[field]);
  }
  ctx.contract = contract;

  const full = genericSeed(routeId, pkgId, goal, scope, reportPath, handoffPath);
  deepMerge(full, resolveVars(pyGet(card, "seed_defaults", {}), ctx));
  // 卡提供的 out_of_scope 走 seed_defaults.scope.out_of_scope（deep_merge 直接替换列表）；
  // 这里把调用方的补充项重新追加，确保它们始终存活。
  for (const item of listSeedValues(pyGet(scopeIn, "out_of_scope_extra"))) {
    if (!full.scope.out_of_scope.includes(item)) full.scope.out_of_scope.push(item);
  }

  const slot = pyStr(pyOr(pyGet(card, "slot"), "")).trim();
  if (slot) {
    setDefaultDict(full.extensions, "capability_contract")[slot] = contract;
  } else if (pyTruthy(contract)) {
    throw new ToolError(
      `route ${routeId} 差异卡未声明 slot，最小种子不接受 contract 字段；` +
        `该 route 的合法字段骨架见 --seed-template ${routeId}，` +
        "任务细节改放 goal / inputs.constraints / known_facts",
    );
  }

  applyDelegationIntent(full, seed);

  // 与最小键并列直接给出的完整 seed 覆盖：model 优先。
  for (const [key, raw] of Object.entries(seed)) {
    if (MINIMAL_ONLY_KEYS.has(key) || ["route_id", "package_id", "goal", "scope"].includes(key)) continue;
    const value = stripPlaceholders(raw);
    if (value === null || isEmptyMapping(value) || (Array.isArray(value) && !value.length)) continue;
    if (isRecord(value) && isRecord(pyGet(full, key))) deepMerge(full[key], value);
    else full[key] = deepCopy(value);
  }
  injectPlannerMechanicalSchema(full);
  injectAcceptanceMechanicalContract(full);
  alignExpectedOutputWrite(full, reportPath, writeExtra);
  alignHandoffOutputWrite(full, handoffPath, writeExtra);
  return full;
}

export function renderTemplate(routeId) {
  const profile = profileFor(routeId);
  const card = pyGet(profile, "card");
  if (card === null || card === undefined) {
    throw new ToolError(
      `route ${routeId} 没有差异卡；已支持最小种子的 route: ${pyOr(routesWithCards().join(", "), "(none)")}`,
    );
  }
  const body = { route_id: routeId };
  for (const req of pyGet(card, "required", [])) {
    const reqPath = pyGetItem(req, "path");
    const hint = pyGet(req, "hint", "");
    const enumValues = pyGet(req, "enum");
    const example = pyGet(req, "example", null);
    let placeholder;
    if (pyTruthy(enumValues)) {
      placeholder = `<${enumValues.join("|")}${pyTruthy(hint) ? ` — ${hint}` : ""}>`;
    } else {
      const parts = pyTruthy(hint) ? [hint] : [];
      if (example !== null && example !== undefined && !(typeof example === "string" && example.startsWith("$"))) {
        parts.push(`例: ${pyJsonDumps(example)}`);
      }
      placeholder = `<${pyOr(parts.join(" | "), reqPath)}>`;
    }
    let cursor = body;
    const keys = String(reqPath).split(".");
    for (const key of keys.slice(0, -1)) {
      // 父级可能已被写成占位字符串；要挂子字段时替换为对象，子字段占位承载提示。
      let node = pyGet(cursor, key);
      if (!isRecord(node)) {
        node = {};
        cursor[key] = node;
      }
      cursor = node;
    }
    const leaf = keys[keys.length - 1];
    cursor[leaf] = Array.isArray(example) ? [placeholder] : placeholder;
  }
  for (const opt of pyGet(card, "optional", [])) {
    const optPath = pyGetItem(opt, "path");
    const hint = pyGet(opt, "hint", "");
    let cursor = body;
    const keys = String(optPath).split(".");
    for (const key of keys.slice(0, -1)) {
      let node = pyGet(cursor, key);
      if (!isRecord(node)) {
        node = {};
        cursor[key] = node;
      }
      cursor = node;
    }
    const enumValues = pyGet(opt, "enum");
    const valuesHint = pyTruthy(enumValues) ? `${enumValues.join("|")} — ` : "";
    const placeholder = `<可选 | ${valuesHint}${pyOr(hint, optPath)}>`;
    cursor[keys[keys.length - 1]] = LIST_SEED_FIELDS.has(optPath) ? [placeholder] : placeholder;
  }
  if (pyGet(card, "omit_delegation_intent") !== true) {
    body.delegation_intent =
      "<可选 | 1-3 句说明为什么派、要消哪个不确定、结果会影响主代理什么决定；" + "不写事实、结论或历史长摘录>";
  }
  // 与 list 同源；只展示本能力适用的推荐行。
  const [role, capability] = routeId.split("__");
  const sources = modelConfigSources();
  const modelTier = pyStr(pyOr(pyGet(card, "model_tier"), "")).trim();
  const config = loadSelectionConfig(sources);
  const projectedRole = projectCatalog(config, { role, capability }).roles[0];
  const defaultPick = projectedRole.capabilities[0].default_pick;
  const header = [
    `# minimal seed · ${routeId}`,
    `# 适用: ${pyGet(card, "applies_to", "")}`,
    `# 有效默认: ${defaultPick || "未配置"}`,
    ...projectedRole.picks.map((pick) => `# 推荐 ${pick.id}${pick.id === defaultPick ? "（默认）" : ""}: ${pick.when} → `
      + `${pick.model}@${pick.effort} [${pick.effort_min}–${pick.effort_max}]；选择 ${JSON.stringify({ pick: pick.id })}；`
      + `模型可选档位 ${modelEfforts(config, pick.model).join("/")}`),
    `# 配置来源: 角色=${sources.roleConfigPath(role)}；模型笔记=${sources.model_notes}`,
    ...(modelTier ? [`# 卡提示: ${modelTier}`] : []),
    ...(pyTruthy(pyGet(card, "model_requirements"))
      ? [`# 模型要求: ${pyGetItem(card, "model_requirements").map(pyStr).join(", ")}`]
      : []),
    ...MODEL_SELECTION_GUIDANCE.map((line) => `# 选型: ${line}`),
    ...Object.entries(card.input_defaults ?? {}).map(([key, value]) => `# 缺省: ${key} = ${pyJsonDumps(value)}`),
    "# 其余字段全部由工具按差异卡默认；scope.write 自动含预期输出和 handoff，业务写入用 scope.write_extra 添加。",
    "# <可选> 字段不需要时整行删除。CLI flag 与 Pi 扩展工具参数不可混用。",
    "# 配置归属发起项目；target_cwd 指定子代理执行目录和写域校验的目标仓，具体写入仍由 scope 授权。",
    "# scope.read 仓外只读用已存在的真实绝对路径；相对路径经 junction/symlink 指向仓外时，换成报错给出的真实绝对路径后重试 preview。",
    "# 该读取许可不扩展 scope.write/write_extra/delete；业务写入仍限仓根或已授权目标仓，delete 保持原边界。",
  ];
  return `${header.join("\n")}\n${JSON.stringify(body, null, 2)}`;
}
