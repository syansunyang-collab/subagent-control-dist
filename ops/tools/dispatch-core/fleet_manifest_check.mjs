// ops/tools/fleet_manifest_check.py 的 JS 复刻：fleet manifest 的静态校验与 DAG 分层。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」；导出函数名为 Python 名的 camelCase，
// Python 关键字参数作为末尾一个 options 对象（键名 camelCase）。
//
// 异常映射表（Python 分支 → JS）：
//   ToolError(msg)                       → ToolError(msg)，消息逐字
//   FileNotFoundError（manifest 缺失）   → 与 Python 同分支收束为 ToolError，文案逐字
//   json.JSONDecodeError                 → pyJsonLoads 抛出的 name="JSONDecodeError" 错误，
//                                          load_manifest 按 Python 收束为 ToolError（只取 lineno）
//   node_expanded_seed / _check_task_payload 里的裸 `except Exception`
//                                        → catch (error)，`str(exc)` 取 error.message
//
// 本模块无子进程与可变全局；`deps` 只用于测试替身注入编译器侧的三个入口。
import path from "node:path";

import {
  ToolError,
  emit,
  isRecord,
  modelConfigSources,
  normalizeConflictPath as normalizePath,
  pathConflict,
  rel,
} from "./_tool_common.mjs";
import { loadSelectionConfig, resolveSelection } from "./model_selection.mjs";
import { pyIsAbsolute, pyPureStr, pyReadText, pyJsonLoads, pyRepr, pyStr, pyStrip } from "./_py.mjs";
import {
  computeScopePreflight,
  resolveRoleModelSelection,
} from "./dispatch_prepare.mjs";
import { exampleSeed, expandSeed, routesWithCards } from "./seed_minimal.mjs";

export { ToolError, emit, normalizePath, pathConflict, rel, exampleSeed, expandSeed, routesWithCards };

/** pytest / 行为测试里被替换的模块级名字集中于此。 */
export const deps = {
  computeScopePreflight,
  resolveRoleModelSelection,
  expandSeed,
  routesWithCards,
};

export const ALLOWED_ISOLATION = new Set(["read_only", "same_tree_locked", "worktree"]);
export const ALLOWED_TARGET_ISOLATION = new Set(["read_only", "writable"]);
export const ALLOWED_DEPENDENCY_ARTIFACTS = new Set(["report", "handoff"]);
export const ALLOWED_DEPENDENCY_POLICIES = new Set(["all_succeeded", "all_settled"]);
export const ALLOWED_FAILURE_POLICIES = new Set(["success_only", "all_settled"]);
// Fleet task nodes use the same sole child executor as dispatch_prepare.
export const ALLOWED_EXECUTORS = new Set(["pi"]);
export const ALLOWED_ROUTE_FIELDS = new Set(["executor", "model", "effort", "pick", "authorization"]);
const ROUTE_STRING_FIELDS = new Set(["executor", "model", "effort", "pick"]);
const ROUTE_SELECTORS = ["pick", "model"];
export const ALLOWED_NODE_KINDS = new Set(["task", "command", "gate"]);
export const ALLOWED_COMMAND_FIELDS = new Set(["argv", "cwd", "timeout_seconds"]);
export const COMMAND_DEFAULT_TIMEOUT_SECONDS = 600;
export const COMMAND_MAX_TIMEOUT_SECONDS = 3600;
// gate 节点是纯裁决点：不携带任何执行或写入载荷。
export const GATE_FORBIDDEN_FIELDS = [
  "seed",
  "route",
  "command",
  "reducer",
  "write_scope",
  "write_domains",
  "artifact_write_scope",
  "resource_locks",
  "dependency_artifacts",
];
export const COMMAND_FORBIDDEN_FIELDS = ["seed", "route", "reducer"];
export const EXPLICIT_ROUTE_SOURCE = "manifest";
export const LEGACY_ROUTE_SOURCE = "agent_config";
export const MANIFEST_SCHEMA_VERSION = 2;
export const HIGH_TIER_ROLES = new Set(["executor-agent", "verify-agent", "plan-checker", "planner-agent"]);
// A6 lint：大目录模式（裸塞进 entry 未分层即预警），多问连接词，扫描类角色提示。
export const BIG_DIR_NAMES = new Set(["runs", "outputs", ".runtime", "node_modules", ".venv", "dist"]);
export const MULTI_QUESTION_CONNECTORS = ["和", "与", "以及", "同时", "plus", "and also"];
export const SCAN_ROLE_HINTS = ["explorer", "scan"];
// 仅供 lint 提示漏标 reducer 用；reducer 身份一律以显式 reducer 字段为准。
export const REDUCE_HINTS = ["reduce", "synth"];
export const DEFAULT_BUDGET = {
  max_nodes_total: 30,
  max_running_total: 8,
  max_submitted_per_tick: 8,
  max_high_tier_nodes: 4,
  max_scope_bytes_total: 50 * 1024 * 1024,
  max_running_by_role: {},
};
export const DEFAULT_REVIEW_POLICY = { max_rounds: 2 };
export const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  "schema_version",
  "run_id",
  "defaults",
  "budget",
  "review_policy",
  "nodes",
]);
export const ALLOWED_DEFAULT_FIELDS = new Set(["isolation", "target_isolation"]);
export const ALLOWED_NODE_FIELDS = new Set([
  "id",
  "kind",
  "depends_on",
  "dependency_artifacts",
  "dependency_policy",
  "seed",
  "command",
  "isolation",
  "target_isolation",
  "write_scope",
  "write_domains",
  "resource_locks",
  "failure_policy",
  "reducer",
  "artifact_write_scope",
  "route",
]);

// ---- Python 语义小工具（本模块私有；建议上提的已在回报里登记） ----

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** sorted()：字符串按码位序。 */
export function sortedStrings(values) {
  return [...values].sort(compareCodePoints);
}

/** sorted(set(a) - b)：Python 集合差集后排序。 */
function sortedKeysMinus(container, allowed) {
  return sortedStrings(Object.keys(container ?? {}).filter((key) => !allowed.has(key)));
}

/** copy.deepcopy()：JSON 值域内的深拷贝。 */
export function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (isRecord(value)) {
    // Create data properties (including __proto__) without invoking inherited setters.
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepCopy(item)]));
  }
  return value;
}

/** PurePath.parts：锚点算一段，"." 段丢弃。 */
function purePathParts(value) {
  const raw = String(value);
  const root = path.parse(raw).root;
  const rest = raw.slice(root.length).split(/[\\/]+/).filter((part) => part && part !== ".");
  return root ? [root, ...rest] : rest;
}

// ---- schema 与示例 ----

export function routeModelBindings() {
  const config = loadSelectionConfig(modelConfigSources());
  const bindings = Object.create(null);
  for (const role of config.roles.values()) {
    for (const route of role.routes) {
      const selected = resolveSelection(config, { role: role.role, capability: route.capability });
      const referenceModels = [...new Set([selected.resolved_model, ...role.picks.map((pick) => pick.model)])];
      bindings[route.route_id] = {
        mode: referenceModels.length > 1 ? "candidate_references" : "role_default",
        default_model: selected.resolved_model,
        default_effort: selected.resolved_effort,
        efforts: selected.efforts,
        effort_range: selected.effort_range,
        reference_models: referenceModels,
        candidate_order: "display_only",
        capability: route.capability,
        pick: selected.pick,
      };
    }
  }
  return bindings;
}

export function manifestSchema() {
  const budget = {};
  for (const [key, value] of Object.entries(DEFAULT_BUDGET)) {
    budget[key] = { default: deepCopy(value), type: isRecord(value) ? "object" : "positive_integer" };
  }
  return {
    additional_fields: "rejected",
    authoring_guidance: {
      sequence: [
        "先按任务职责选择 seed.route_id。",
        "再读取 route_model_bindings[seed.route_id]，参考角色默认与候选模型。",
        "不需要单次覆盖时省略 node.route，使用该 route 的角色默认模型和 effort。",
        "需要覆盖时按任务需求填写 route.model；reference_models 供参考，候选顺序不表示优先级或自动回退。",
      ],
      route_model_bindings: routeModelBindings(),
      runtime_availability_source: "dispatch_prepare(action=list)",
    },
    schema_version: { required: true, enum: [MANIFEST_SCHEMA_VERSION] },
    run_id: { type: "string", required: false },
    defaults: {
      isolation: { enum: sortedStrings(ALLOWED_ISOLATION), default: "same_tree_locked" },
      target_isolation: { enum: sortedStrings(ALLOWED_TARGET_ISOLATION), default: "writable" },
    },
    budget,
    review_policy: {
      max_rounds: { type: "positive_integer", default: 2 },
    },
    nodes: {
      required: true,
      type: "array",
      item: {
        id: { required: true, type: "non_empty_string" },
        kind: { enum: sortedStrings(ALLOWED_NODE_KINDS), default: "task" },
        command: {
          type: "object",
          required: "only when kind=command; forbidden otherwise",
          fields: {
            argv: { required: true, type: "non_empty_string_array" },
            cwd: { required: false, type: "repo_relative_path" },
            timeout_seconds: {
              required: false,
              type: "positive_integer",
              default: COMMAND_DEFAULT_TIMEOUT_SECONDS,
              maximum: COMMAND_MAX_TIMEOUT_SECONDS,
            },
          },
        },
        depends_on: { type: "string_array", default: [] },
        dependency_artifacts: {
          type: "string_array",
          enum: sortedStrings(ALLOWED_DEPENDENCY_ARTIFACTS),
          default: [],
          requires: "depends_on",
        },
        dependency_policy: {
          enum: sortedStrings(ALLOWED_DEPENDENCY_POLICIES),
          default: "all_succeeded",
          requires: "depends_on",
        },
        seed: {
          required: "only when kind=task; forbidden otherwise",
          type: "dispatch_prepare_seed",
        },
        isolation: { enum: sortedStrings(ALLOWED_ISOLATION), default: "same_tree_locked" },
        target_isolation: { enum: sortedStrings(ALLOWED_TARGET_ISOLATION), default: "writable" },
        write_scope: { type: "string_array", default: [] },
        write_domains: { type: "string_array", default: [] },
        resource_locks: { type: "string_array", default: [] },
        failure_policy: {
          enum: sortedStrings(ALLOWED_FAILURE_POLICIES),
          default: "success_only",
        },
        reducer: { type: "boolean", default: false },
        artifact_write_scope: { type: "string_array", default: [] },
        route: {
          type: "object",
          required: false,
          description: "运行时覆盖请求。省略时使用角色默认；按任务需求选择模型，参考 authoring_guidance.route_model_bindings[route_id]。",
          additional_fields: "rejected",
          fields: {
            executor: { required: false, default: "pi", enum: sortedStrings(ALLOWED_EXECUTORS) },
            model: {
              required: false,
              type: "non_empty_string",
              description: "请求的 Pi 模型。reference_models 提供选型参考；实际可用性由 child runtime 检查。",
            },
            effort: {
              required: false,
              type: "non_empty_string",
              description: "Requested reasoning effort passed to dispatch_prepare; the runner verifies model support.",
            },
            pick: {
              required: false,
              type: "non_empty_string",
              description: "推荐行 ID。与 model 至多填一个。",
            },
            authorization: {
              required: false,
              type: "object",
              description: "节点级授权 {quote, overrides: [effort_range | outside_pool]}，必须同时给出 effort；只对本节点的 model + effort 生效。",
            },
          },
        },
      },
    },
  };
}

export function exampleManifest() {
  const sourceSeed = exampleSeed("explorer-agent__codebase-scan");
  sourceSeed.goal = "核对一个有界源码切片。";
  sourceSeed.slug = "fleet-example-source";
  sourceSeed.scope.read = ["ops/tools"];
  if (!Object.hasOwn(sourceSeed, "contract")) sourceSeed.contract = {};
  sourceSeed.contract.question = "该切片的入口与风险是什么？";
  const reducerSeed = exampleSeed("general-agent__general-default");
  reducerSeed.goal = "归并依赖节点的正式报告。";
  reducerSeed.slug = "fleet-example-reducer";
  reducerSeed.scope.read = [];
  const generalBinding = routeModelBindings()["general-agent__general-default"];
  const generalOverride = generalBinding.reference_models.find((model) => model !== generalBinding.default_model)
    ?? generalBinding.default_model;
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: "review-and-reduce",
    budget: {
      max_nodes_total: 4,
      max_running_total: 1,
      max_submitted_per_tick: 1,
    },
    nodes: [
      {
        id: "review-a",
        depends_on: [],
        isolation: "same_tree_locked",
        target_isolation: "writable",
        seed: sourceSeed,
      },
      {
        id: "reduce",
        depends_on: ["review-a"],
        dependency_artifacts: ["report"],
        dependency_policy: "all_settled",
        isolation: "same_tree_locked",
        target_isolation: "writable",
        route: {
          executor: "pi",
          model: generalOverride,
          effort: "high",
        },
        seed: reducerSeed,
      },
      {
        id: "consume-decision",
        kind: "command",
        depends_on: ["reduce"],
        dependency_artifacts: ["report"],
        dependency_policy: "all_settled",
        command: {
          argv: ["python", "-c", "print('mechanical consumption step')"],
          timeout_seconds: 120,
        },
      },
      {
        id: "ship-gate",
        kind: "gate",
        depends_on: ["consume-decision"],
      },
    ],
  };
}

export function loadManifest(target) {
  const text = (() => {
    try {
      return pyReadText(target);
    } catch (error) {
      if (error?.code === "ENOENT") throw new ToolError(`fleet manifest not found: ${pyPureStr(target)}`);
      throw error;
    }
  })();
  let data;
  try {
    data = pyJsonLoads(text);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    const lineno = Number(/line (\d+) column/.exec(String(error.message))?.[1] ?? 1);
    throw new ToolError(`fleet manifest is invalid JSON: ${pyPureStr(target)}:${lineno}`);
  }
  if (!isRecord(data)) throw new ToolError("fleet manifest root must be a JSON object");
  return data;
}

export function effectiveBudget(manifest) {
  const raw = isRecord(manifest.budget) ? manifest.budget : {};
  return { ...deepCopy(DEFAULT_BUDGET), ...raw };
}

export function effectiveReviewPolicy(manifest) {
  const raw = isRecord(manifest.review_policy) ? manifest.review_policy : {};
  return { ...deepCopy(DEFAULT_REVIEW_POLICY), ...raw };
}

export function manifestNodes(manifest) {
  const nodes = manifest.nodes;
  if (!Array.isArray(nodes)) throw new ToolError("fleet manifest requires nodes: []");
  return nodes.map((node) => (isRecord(node) ? node : { _invalid_node: node }));
}

export function nodeId(node) {
  const value = node.id;
  return typeof value === "string" ? pyStrip(value) : "";
}

export function nodeSeed(node) {
  const seed = node.seed;
  return isRecord(seed) ? deepCopy(seed) : {};
}

export function nodeSeedForStaticValidation(node) {
  const seed = nodeSeed(node);
  const artifacts = node.dependency_artifacts;
  if (!Array.isArray(artifacts) || !artifacts.some((item) => typeof item === "string" && pyStrip(item))) {
    return seed;
  }
  let scope = seed.scope;
  if (!isRecord(scope)) {
    scope = {};
    seed.scope = scope;
  }
  const reads = scope.read;
  if (!Array.isArray(reads) || !reads.some((item) => typeof item === "string" && pyStrip(item))) {
    // 下游正式输入要等依赖终态后才存在。这里只补一个仓内探针通过 route
    // 的静态字段展开；真实提交仍由 scheduler 注入依赖产物路径。
    scope.read = ["ops/tools/fleet_manifest_check.mjs"];
  }
  return seed;
}

export function nodeExpandedSeed(node) {
  try {
    return deps.expandSeed(nodeSeedForStaticValidation(node));
  } catch {
    return nodeSeed(node);
  }
}

export function nodeRouteId(node) {
  const seed = nodeSeed(node);
  const value = seed.route_id;
  return typeof value === "string" ? pyStrip(value) : "";
}

export function nodeRoute(node) {
  const raw = node.route;
  if (!isRecord(raw)) return null;
  const out = {};
  for (const key of sortedStrings(ALLOWED_ROUTE_FIELDS)) {
    const value = raw[key];
    if (key === "authorization") {
      if (isRecord(value) || (typeof value === "string" && pyStrip(value))) out.authorization = isRecord(value) ? deepCopy(value) : pyStrip(value);
      continue;
    }
    if (typeof value === "string" && pyStrip(value)) out[key] = pyStrip(pyStr(value));
  }
  return out;
}

/** Return the durable source label without changing legacy manifests. */
export function nodeRouteSource(node) {
  return Object.hasOwn(node, "route") ? EXPLICIT_ROUTE_SOURCE : LEGACY_ROUTE_SOURCE;
}

export function nodeRouteErrors(node) {
  if (!Object.hasOwn(node, "route")) return [];
  const raw = node.route;
  if (!isRecord(raw)) return ["route must be an object"];
  const errors = [];
  for (const field of sortedKeysMinus(raw, ALLOWED_ROUTE_FIELDS)) {
    errors.push(`route has unsupported field: ${field}`);
  }
  for (const field of sortedStrings(ROUTE_STRING_FIELDS)) {
    if (!Object.hasOwn(raw, field)) continue;
    const value = raw[field];
    if (typeof value !== "string" || !pyStrip(value)) {
      errors.push(`route.${field} must be a non-empty string`);
    }
  }
  if (ROUTE_SELECTORS.filter((field) => Object.hasOwn(raw, field)).length > 1) {
    errors.push("route pick and model are mutually exclusive");
  }
  if (Object.hasOwn(raw, "authorization")) {
    let parsed = raw.authorization;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        errors.push("route.authorization must be a JSON object");
        parsed = null;
      }
    }
    if (parsed !== null && !isRecord(parsed)) errors.push("route.authorization must be an object");
    if (isRecord(parsed)) {
      if (typeof parsed.quote !== "string" || !pyStrip(parsed.quote)) errors.push("route.authorization.quote must be a non-empty string");
      if (!Array.isArray(parsed.overrides)) errors.push("route.authorization.overrides must be an array");
      if (!pyStrip(pyStr(raw.effort || ""))) errors.push("route.authorization requires route.effort");
    }
  }
  const executor = raw.executor;
  if (typeof executor === "string" && pyStrip(executor) && !ALLOWED_EXECUTORS.has(executor)) {
    errors.push(`route.executor must be one of ${pyRepr(sortedStrings(ALLOWED_EXECUTORS))}`);
  }
  return errors;
}

export function nodeKind(node) {
  const value = node.kind;
  if (typeof value === "string" && pyStrip(value)) return pyStrip(value);
  return "task";
}

export function nodeKindErrors(node) {
  const value = node.kind;
  if (value === null || value === undefined) return [];
  if (typeof value !== "string" || !ALLOWED_NODE_KINDS.has(pyStrip(value))) {
    return [`kind must be one of ${pyRepr(sortedStrings(ALLOWED_NODE_KINDS))}`];
  }
  return [];
}

export function nodeCommand(node) {
  const raw = node.command;
  if (!isRecord(raw)) return {};
  const argv = raw.argv;
  const timeout = Object.hasOwn(raw, "timeout_seconds") ? raw.timeout_seconds : COMMAND_DEFAULT_TIMEOUT_SECONDS;
  const cwd = raw.cwd;
  const timeoutValid = typeof timeout === "number" && Number.isInteger(timeout);
  return {
    argv: Array.isArray(argv) ? argv.map((item) => pyStr(item)) : [],
    cwd: typeof cwd === "string" && pyStrip(cwd) ? pyStrip(cwd) : "",
    timeout_seconds: timeoutValid ? timeout : COMMAND_DEFAULT_TIMEOUT_SECONDS,
  };
}

export function nodeCommandErrors(node) {
  const raw = Object.hasOwn(node, "command") ? node.command : null;
  if (raw === null || raw === undefined) return ["kind=command requires command object"];
  if (!isRecord(raw)) return ["command must be an object"];
  const errors = [];
  for (const field of sortedKeysMinus(raw, ALLOWED_COMMAND_FIELDS)) {
    errors.push(`command has unsupported field: ${field}`);
  }
  const argv = raw.argv;
  if (
    !Array.isArray(argv)
    || argv.length === 0
    || argv.some((item) => typeof item !== "string" || !pyStrip(item))
  ) {
    errors.push("command.argv must be a non-empty array of non-empty strings");
  }
  const cwd = Object.hasOwn(raw, "cwd") ? raw.cwd : null;
  if (cwd !== null && cwd !== undefined) {
    if (typeof cwd !== "string" || !pyStrip(cwd)) {
      errors.push("command.cwd must be a non-empty string when present");
    } else if (pyIsAbsolute(cwd) || purePathParts(cwd).includes("..")) {
      errors.push("command.cwd must be a repo-relative path without parent escapes");
    }
  }
  const timeout = Object.hasOwn(raw, "timeout_seconds") ? raw.timeout_seconds : null;
  if (
    timeout !== null && timeout !== undefined
    && (typeof timeout === "boolean"
      || typeof timeout !== "number"
      || !Number.isInteger(timeout)
      || timeout <= 0
      || timeout > COMMAND_MAX_TIMEOUT_SECONDS)
  ) {
    errors.push(`command.timeout_seconds must be a positive integer <= ${COMMAND_MAX_TIMEOUT_SECONDS}`);
  }
  return errors;
}

export function nodeRole(node) {
  const kind = nodeKind(node);
  if (kind !== "task") return kind;
  const routeId = nodeRouteId(node);
  return routeId.includes("__") ? routeId.split("__")[0] : routeId;
}

export function nodeDependsOn(node) {
  const raw = Object.hasOwn(node, "depends_on") ? node.depends_on : [];
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => typeof item === "string" && pyStrip(item)).map((item) => pyStrip(item));
}

export function nodeDependsOnErrors(node) {
  const raw = Object.hasOwn(node, "depends_on") ? node.depends_on : [];
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) return ["depends_on must be a list"];
  const errors = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string" || !pyStrip(item)) {
      errors.push(`depends_on[${index}] must be a non-empty string`);
    }
  });
  return errors;
}

export function nodeDependencyArtifacts(node) {
  return stringList(node.dependency_artifacts);
}

export function nodeDependencyArtifactErrors(node) {
  const raw = Object.hasOwn(node, "dependency_artifacts") ? node.dependency_artifacts : [];
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) return ["dependency_artifacts must be a list"];
  const errors = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string" || !ALLOWED_DEPENDENCY_ARTIFACTS.has(item)) {
      errors.push(
        `dependency_artifacts[${index}] must be one of ${pyRepr(sortedStrings(ALLOWED_DEPENDENCY_ARTIFACTS))}`,
      );
    }
  });
  if (raw.length && !nodeDependsOn(node).length) {
    errors.push("dependency_artifacts requires depends_on");
  }
  return errors;
}

export function nodeDependencyPolicy(node) {
  const value = Object.hasOwn(node, "dependency_policy") ? node.dependency_policy : "all_succeeded";
  return typeof value === "string" && pyStrip(value) ? pyStrip(value) : "all_succeeded";
}

export function nodeDependencyPolicyErrors(node) {
  const raw = Object.hasOwn(node, "dependency_policy") ? node.dependency_policy : "all_succeeded";
  if (typeof raw !== "string" || !ALLOWED_DEPENDENCY_POLICIES.has(raw)) {
    return [`dependency_policy must be one of ${pyRepr(sortedStrings(ALLOWED_DEPENDENCY_POLICIES))}`];
  }
  if (Object.hasOwn(node, "dependency_policy") && !nodeDependsOn(node).length) {
    return ["dependency_policy requires depends_on"];
  }
  return [];
}

export function nodeResourceLocks(node) {
  return sortedStrings(new Set(
    stringList(node.resource_locks).map((item) => pyStrip(item)).filter((item) => item),
  ));
}

export function nodeResourceLockErrors(node) {
  const raw = Object.hasOwn(node, "resource_locks") ? node.resource_locks : [];
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) return ["resource_locks must be a list"];
  const errors = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string" || !pyStrip(item)) {
      errors.push(`resource_locks[${index}] must be a non-empty string`);
      return;
    }
  });
  return errors;
}

export function nodeFailurePolicy(node) {
  const value = Object.hasOwn(node, "failure_policy") ? node.failure_policy : "success_only";
  return typeof value === "string" && pyStrip(value) ? pyStrip(value) : "success_only";
}

export function nodeFailurePolicyErrors(node) {
  const raw = Object.hasOwn(node, "failure_policy") ? node.failure_policy : "success_only";
  if (typeof raw !== "string" || !ALLOWED_FAILURE_POLICIES.has(raw)) {
    return [`failure_policy must be one of ${pyRepr(sortedStrings(ALLOWED_FAILURE_POLICIES))}`];
  }
  return [];
}

export function nodeIsReducer(node) {
  return node.reducer === true;
}

export function nodeReducerErrors(node) {
  const raw = Object.hasOwn(node, "reducer") ? node.reducer : false;
  if (typeof raw !== "boolean") return ["reducer must be a boolean"];
  if (raw && nodeDependencyPolicy(node) !== "all_settled") {
    return ["reducer=true requires dependency_policy=all_settled"];
  }
  return [];
}

export function nodeIsolation(node, manifest) {
  const defaults = isRecord(manifest.defaults) ? manifest.defaults : {};
  const fallback = Object.hasOwn(defaults, "isolation") ? defaults.isolation : "same_tree_locked";
  const value = Object.hasOwn(node, "isolation") ? node.isolation : fallback;
  return typeof value === "string" && pyStrip(value) ? value : "same_tree_locked";
}

export function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && pyStrip(item));
}

export function nodeScope(node) {
  const seed = nodeExpandedSeed(node);
  const scope = isRecord(seed.scope) ? seed.scope : {};
  return {
    read: stringList(scope.read),
    write: [...stringList(scope.write), ...stringList(scope.write_extra)],
    delete: stringList(scope.delete),
  };
}

export function nodeReadScope(node) {
  const seed = nodeSeed(node);
  const scope = isRecord(seed.scope) ? seed.scope : {};
  const rawReads = scope.read;
  if (
    nodeDependencyArtifacts(node).length
    && (!Array.isArray(rawReads) || !rawReads.some((item) => typeof item === "string" && pyStrip(item)))
  ) {
    return [];
  }
  return nodeScope(node).read;
}

export function nodeWriteScope(node) {
  const seed = nodeExpandedSeed(node);
  const scope = nodeScope(node);
  const writes = [...scope.write, ...scope.delete];
  const expected = isRecord(seed.expected_output) ? seed.expected_output : {};
  const handoff = isRecord(seed.handoff_contract) ? seed.handoff_contract : {};
  writes.push(...stringList(node.write_scope));
  writes.push(...stringList(node.write_domains));
  for (const key of ["file_path", "path"]) {
    const value = expected[key];
    if (typeof value === "string" && pyStrip(value)) writes.push(value);
  }
  const handoffFile = handoff.handoff_file;
  if (typeof handoffFile === "string" && pyStrip(handoffFile)) writes.push(handoffFile);
  return sortedStrings(new Set(writes.filter((item) => pyStrip(item)).map((item) => normalizePath(item))));
}

export function nodeTargetIsolation(node, manifest) {
  const defaults = isRecord(manifest.defaults) ? manifest.defaults : {};
  const fallback = Object.hasOwn(defaults, "target_isolation") ? defaults.target_isolation : "writable";
  const value = Object.hasOwn(node, "target_isolation") ? node.target_isolation : fallback;
  return typeof value === "string" && pyStrip(value) ? value : "writable";
}

export function nodeArtifactWriteScope(node) {
  const raw = stringList(node.artifact_write_scope);
  return sortedStrings(new Set(raw.filter((item) => pyStrip(item)).map((item) => normalizePath(item))));
}

// A7：读作用域分层。read_scope_layers 为可选 seed 字段（entry/index/deep/deferred）；缺失时按旧
// read_scope 全 entry 兼容。deep 项形如 {"path": "...", "when": "..."}，取 path 展平。
export function nodeReadScopeLayers(node) {
  const seed = nodeExpandedSeed(node);
  const layers = seed.read_scope_layers;
  if (!isRecord(layers)) return null;

  const flat = (key) => {
    const out = [];
    const items = Array.isArray(layers[key]) ? layers[key] : [];
    for (const item of items) {
      if (typeof item === "string" && pyStrip(item)) out.push(item);
      else if (isRecord(item) && typeof item.path === "string" && pyStrip(item.path)) out.push(item.path);
    }
    return out;
  };

  return { entry: flat("entry"), index: flat("index"), deep: flat("deep"), deferred: flat("deferred") };
}

export function pathHitsBigDir(raw) {
  const segments = pyStrip(String(raw).replace(/\\/g, "/")).toLowerCase().split("/").filter(Boolean);
  return segments.some((seg) => BIG_DIR_NAMES.has(seg));
}

export function nodeQuestionTexts(node) {
  const seed = nodeSeed(node);
  const texts = [];
  for (const value of [seed.goal]) {
    if (typeof value === "string" && pyStrip(value)) texts.push(value);
  }
  const contract = isRecord(seed.contract) ? seed.contract : {};
  const question = contract.question;
  if (typeof question === "string" && pyStrip(question)) texts.push(question);
  return texts;
}

export function writeScopesConflict(left, right) {
  const hits = [];
  for (const a of left) {
    for (const b of right) {
      if (pathConflict(a, b)) hits.push([a, b]);
    }
  }
  return hits;
}

export function topologicalLayers(nodes) {
  const ids = nodes.map((node) => nodeId(node));
  const idSet = new Set(ids);
  const indegree = new Map();
  const children = new Map();
  for (const item of ids) {
    if (!indegree.has(item)) indegree.set(item, 0);
    if (!children.has(item)) children.set(item, []);
  }
  const problems = [];
  for (const node of nodes) {
    const nid = nodeId(node);
    for (const dep of nodeDependsOn(node)) {
      if (!idSet.has(dep)) {
        problems.push(`node ${nid} depends on missing node ${dep}`);
        continue;
      }
      indegree.set(nid, indegree.get(nid) + 1);
      children.get(dep).push(nid);
    }
  }
  let ready = sortedStrings([...indegree.entries()].filter(([, count]) => count === 0).map(([item]) => item));
  const layers = [];
  const seen = [];
  while (ready.length) {
    const layer = ready;
    layers.push(layer);
    const nextReady = [];
    for (const item of layer) {
      seen.push(item);
      for (const child of children.get(item)) {
        indegree.set(child, indegree.get(child) - 1);
        if (indegree.get(child) === 0) nextReady.push(child);
      }
    }
    ready = sortedStrings(nextReady);
  }
  if (seen.length !== ids.length) {
    const cyclic = sortedStrings([...indegree.entries()].filter(([, count]) => count > 0).map(([item]) => item));
    problems.push(`dependency cycle detected: ${cyclic.join(", ")}`);
  }
  return [layers, problems];
}

export function dependencyClosure(nodes) {
  const byId = new Map();
  for (const node of nodes) byId.set(nodeId(node), node);
  const memo = new Map();

  const visit = (nid, stack) => {
    if (memo.has(nid)) return memo.get(nid);
    const active = new Set(stack ?? []);
    if (active.has(nid)) return new Set();
    active.add(nid);
    const deps = new Set();
    const node = byId.has(nid) ? byId.get(nid) : {};
    for (const dep of nodeDependsOn(node)) {
      if (byId.has(dep)) {
        deps.add(dep);
        for (const item of visit(dep, active)) deps.add(item);
      }
    }
    memo.set(nid, deps);
    return deps;
  };

  for (const nid of byId.keys()) visit(nid);
  // Python 返回 dict[str, set[str]]；这里以 id → 排序后的依赖数组呈现，成员判定用 includes。
  return Object.fromEntries([...memo.entries()].map(([key, value]) => [key, sortedStrings(value)]));
}

export function budgetInt(value, label, errors) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    errors.push(`budget.${label} must be a positive integer`);
    return null;
  }
  return value;
}

function forbiddenKindFields(nid, kind, node, fields, errors) {
  for (const field of fields) {
    if (Object.hasOwn(node, field)) errors.push(`node ${nid} kind=${kind} does not accept field: ${field}`);
  }
}

function checkTaskPayload(nid, node, validRoutes, errors) {
  if (Object.hasOwn(node, "command")) errors.push(`node ${nid} kind=task does not accept field: command`);
  if (!isRecord(node.seed)) errors.push(`node ${nid} requires seed object`);
  const routeId = nodeRouteId(node);
  let expandedSeed = null;
  if (!routeId) {
    errors.push(`node ${nid} requires route_id`);
  } else if (!validRoutes.has(routeId)) {
    errors.push(`node ${nid} references unknown route_id: ${routeId}`);
  } else {
    try {
      expandedSeed = deps.expandSeed(nodeSeedForStaticValidation(node));
    } catch (error) {
      errors.push(`node ${nid} seed is not dispatchable for ${routeId}: ${String(error?.message ?? error)}`);
    }
  }
  for (const reducerError of nodeReducerErrors(node)) errors.push(`node ${nid} ${reducerError}`);
  const routeErrors = nodeRouteErrors(node);
  for (const routeError of routeErrors) errors.push(`node ${nid} ${routeError}`);
  const requestedRoute = nodeRoute(node);
  if (expandedSeed !== null && requestedRoute !== null && !routeErrors.length) {
    try {
      deps.resolveRoleModelSelection(
        routeId.split("__")[0],
        requestedRoute.model,
        requestedRoute.effort,
        routeId.split("__").slice(1).join("__"),
        {
          pick: requestedRoute.pick,
          authorization: requestedRoute.authorization,
        },
      );
    } catch (error) {
      errors.push(
        `node ${nid} route configuration resolution failed for ${routeId}: ${String(error?.message ?? error)}; `
        + "请检查角色配置文件、解析结果及角色名；模型候选仅供选型参考",
      );
    }
  }
  return routeId;
}

function checkNode(index, node, manifest, ids, validRoutes, errors, warnings) {
  let nid = nodeId(node);
  if (!nid) {
    errors.push(`nodes[${index}].id is required`);
    nid = `<missing-${index}>`;
  }
  if (ids.has(nid)) errors.push(`duplicate node id: ${nid}`);
  ids.add(nid);
  for (const field of sortedKeysMinus(node, ALLOWED_NODE_FIELDS)) {
    errors.push(`node ${nid} has unsupported field: ${field}`);
  }
  const kind = nodeKind(node);
  for (const kindError of nodeKindErrors(node)) errors.push(`node ${nid} ${kindError}`);
  let routeId = "";
  if (kind === "task") {
    routeId = checkTaskPayload(nid, node, validRoutes, errors);
  } else if (kind === "command") {
    forbiddenKindFields(nid, kind, node, COMMAND_FORBIDDEN_FIELDS, errors);
    for (const commandError of nodeCommandErrors(node)) errors.push(`node ${nid} ${commandError}`);
    if (nodeIsolation(node, manifest) === "worktree") {
      errors.push(`node ${nid} kind=command does not support worktree isolation`);
    }
  } else if (kind === "gate") {
    forbiddenKindFields(nid, kind, node, GATE_FORBIDDEN_FIELDS, errors);
    if (nodeIsolation(node, manifest) === "worktree") {
      errors.push(`node ${nid} kind=gate does not support worktree isolation`);
    }
  }
  for (const depError of nodeDependsOnErrors(node)) errors.push(`node ${nid} ${depError}`);
  if (kind !== "gate") {
    for (const artifactError of nodeDependencyArtifactErrors(node)) errors.push(`node ${nid} ${artifactError}`);
    for (const resourceError of nodeResourceLockErrors(node)) errors.push(`node ${nid} ${resourceError}`);
  }
  for (const policyError of nodeDependencyPolicyErrors(node)) errors.push(`node ${nid} ${policyError}`);
  for (const failureError of nodeFailurePolicyErrors(node)) errors.push(`node ${nid} ${failureError}`);
  const isolation = nodeIsolation(node, manifest);
  if (!ALLOWED_ISOLATION.has(isolation)) {
    errors.push(`node ${nid} isolation must be one of ${pyRepr(sortedStrings(ALLOWED_ISOLATION))}`);
  }
  const writeScope = nodeWriteScope(node);
  if (writeScope.length && isolation === "read_only") {
    errors.push(`node ${nid} has write_scope but isolation=read_only`);
  }
  if (!writeScope.length && isolation === "worktree") {
    warnings.push(`node ${nid} uses worktree isolation without write_scope`);
  }
  // target_isolation=read_only：目标仓只读，产物写入控制仓声明范围。
  const targetIsolation = nodeTargetIsolation(node, manifest);
  if (!ALLOWED_TARGET_ISOLATION.has(targetIsolation)) {
    errors.push(`node ${nid} target_isolation must be one of ${pyRepr(sortedStrings(ALLOWED_TARGET_ISOLATION))}`);
  }
  const artifactWriteScopeRaw = nodeArtifactWriteScope(node);
  const artifactWriteScope = artifactWriteScopeRaw.length ? artifactWriteScopeRaw : writeScope;
  if (targetIsolation === "read_only") {
    for (const item of writeScope) {
      if (item.startsWith("external:")) {
        errors.push(`node ${nid} target_isolation=read_only but write_scope escapes control repo: ${item}`);
        continue;
      }
      if (!artifactWriteScope.some((prefix) => item === prefix || item.startsWith(`${prefix}/`))) {
        errors.push(`node ${nid} write_scope ${item} not under artifact_write_scope`);
      }
    }
  }
  // A7：分层读作用域。preflight 只算 entry+index；big-dir lint 只看 entry 且允许 index/deferred 降级。
  const readLayers = nodeReadScopeLayers(node);
  const readScope = nodeReadScope(node);
  let entryScope;
  let preflightScope;
  let demoted;
  if (readLayers !== null) {
    entryScope = readLayers.entry;
    preflightScope = [...readLayers.entry, ...readLayers.index];
    demoted = new Set([...readLayers.index, ...readLayers.deferred].map((item) => normalizePath(item)));
  } else {
    entryScope = readScope;
    preflightScope = readScope;
    demoted = new Set();
  }
  // entry 命中大目录模式时提示读面成本，不按目录名拒发。
  for (const raw of entryScope) {
    if (pathHitsBigDir(raw) && !demoted.has(normalizePath(raw))) {
      warnings.push(`node ${nid} read_scope entry hits large-dir pattern without index/deferred layer: ${raw}`);
    }
  }
  const preflight = deps.computeScopePreflight(preflightScope);
  if (preflight.scope_preflight_warning) {
    warnings.push(`node ${nid}: ${preflight.scope_preflight_warning}`);
  }
  const role = nodeRole(node);
  const isScan = SCAN_ROLE_HINTS.some((hint) => role.toLowerCase().includes(hint));
  // A6 lint 4：title/question 含多问连接词 → warning（一片应只答一个问题）。
  for (const text of nodeQuestionTexts(node)) {
    if (MULTI_QUESTION_CONNECTORS.some((conn) => text.toLowerCase().includes(conn))) {
      warnings.push(
        `node ${nid} title/question contains multi-question connector; split into one-question slices: ${text.slice(0, 60)}`,
      );
      break;
    }
  }
  const row = {
    id: nid,
    kind,
    route_id: routeId,
    role,
    depends_on: nodeDependsOn(node),
    dependency_artifacts: nodeDependencyArtifacts(node),
    dependency_policy: nodeDependencyPolicy(node),
    failure_policy: nodeFailurePolicy(node),
    resource_locks: nodeResourceLocks(node),
    is_reducer: nodeIsReducer(node),
    route: nodeRoute(node),
    route_source: nodeRouteSource(node),
    deferred_read_scope: Boolean(nodeDependencyArtifacts(node).length && !readScope.length),
    isolation,
    target_isolation: targetIsolation,
    read_scope: readScope,
    write_scope: writeScope,
    scope_preflight: preflight,
    is_scan: isScan,
  };
  if (kind === "command") row.command = nodeCommand(node);
  return row;
}

export function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  for (const field of sortedKeysMinus(manifest, ALLOWED_TOP_LEVEL_FIELDS)) {
    errors.push(`unsupported manifest field: ${field}`);
  }
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  const defaults = Object.hasOwn(manifest, "defaults") ? manifest.defaults : {};
  if (!isRecord(defaults)) {
    errors.push("defaults must be an object");
  } else {
    for (const field of sortedKeysMinus(defaults, ALLOWED_DEFAULT_FIELDS)) {
      errors.push(`unsupported defaults field: ${field}`);
    }
  }
  const rawBudget = Object.hasOwn(manifest, "budget") ? manifest.budget : {};
  if (!isRecord(rawBudget)) {
    errors.push("budget must be an object");
  } else {
    for (const field of sortedKeysMinus(rawBudget, new Set(Object.keys(DEFAULT_BUDGET)))) {
      errors.push(`unsupported budget field: ${field}`);
    }
  }
  let rawReviewPolicy = Object.hasOwn(manifest, "review_policy") ? manifest.review_policy : {};
  if (!isRecord(rawReviewPolicy)) {
    errors.push("review_policy must be an object");
    rawReviewPolicy = {};
  } else {
    for (const field of sortedKeysMinus(rawReviewPolicy, new Set(Object.keys(DEFAULT_REVIEW_POLICY)))) {
      errors.push(`unsupported review_policy field: ${field}`);
    }
    const maxRounds = Object.hasOwn(rawReviewPolicy, "max_rounds")
      ? rawReviewPolicy.max_rounds
      : DEFAULT_REVIEW_POLICY.max_rounds;
    if (typeof maxRounds === "boolean" || typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds <= 0) {
      errors.push("review_policy.max_rounds must be a positive integer");
    }
  }
  let nodes;
  try {
    nodes = manifestNodes(manifest);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    errors.push(String(error.message));
    return {
      status: "failed",
      errors,
      warnings: [],
      nodes: [],
      layers: [],
      budget: effectiveBudget(manifest),
    };
  }

  const validRoutes = new Set(deps.routesWithCards());
  const ids = new Set();
  const nodeRows = [];
  nodes.forEach((node, index) => {
    nodeRows.push(checkNode(index, node, manifest, ids, validRoutes, errors, warnings));
  });

  const [layers, dagProblems] = topologicalLayers(nodes);
  errors.push(...dagProblems);

  // A6 lint 3：explorer/scan 节点 ≥3 且无 reducer 节点 → warning（缺 reducer wave）。
  const scanCount = nodeRows.filter((row) => row.is_scan).length;
  const hasReduce = nodeRows.some((row) => row.is_reducer);
  if (scanCount >= 3 && !hasReduce) {
    warnings.push(
      `${scanCount} explorer/scan nodes without a reducer node; plan a reducer wave (mark that node reducer: true)`,
    );
  }
  // A6 lint 6：名字含 reduce/synth 但未标 reducer: true → warning（可能漏标；身份不由名字推断）。
  for (const row of nodeRows) {
    if (row.is_reducer) continue;
    if (REDUCE_HINTS.some((hint) => `${row.id} ${row.route_id}`.toLowerCase().includes(hint))) {
      warnings.push(
        `node ${row.id} reads as a reduce/synth step but is not marked reducer: true; mark it explicitly if it reduces`,
      );
    }
  }
  // 全部节点同一高档 route → warning；总量预算仅显式声明时拒发。
  const routeIds = new Set(nodeRows.filter((row) => row.route_id).map((row) => row.route_id));
  const roles = new Set(nodeRows.filter((row) => row.role).map((row) => row.role));
  if (nodeRows.length >= 2 && routeIds.size === 1 && roles.size && [...roles].every((role) => HIGH_TIER_ROLES.has(role))) {
    warnings.push(
      `all ${nodeRows.length} nodes share one high-tier route ${[...routeIds][0]}; diversify tiers or confirm max_high_tier_nodes`,
    );
  }

  const closure = dependencyClosure(nodes);
  const rowsById = Object.create(null);
  for (const row of nodeRows) rowsById[row.id] = row;
  for (let i = 0; i < nodeRows.length; i += 1) {
    const left = nodeRows[i];
    for (const right of nodeRows.slice(i + 1)) {
      const leftId = left.id;
      const rightId = right.id;
      const rightClosure = closure[rightId] ?? [];
      const leftClosure = closure[leftId] ?? [];
      if (rightClosure.includes(leftId) || leftClosure.includes(rightId)) continue;
      const hits = writeScopesConflict(left.write_scope, right.write_scope);
      if (hits.length) {
        const detail = hits.slice(0, 3).map(([a, b]) => `${a} <-> ${b}`).join(", ");
        warnings.push(`parallel write conflict between ${leftId} and ${rightId}; scheduler will serialize: ${detail}`);
      }
    }
  }

  const budget = effectiveBudget(manifest);
  const budgetFindings = (key) => isRecord(rawBudget) && Object.hasOwn(rawBudget, key) ? errors : warnings;
  const maxNodes = budgetInt(budget.max_nodes_total, "max_nodes_total", errors);
  if (maxNodes !== null && nodes.length > maxNodes) {
    budgetFindings("max_nodes_total").push(`node count ${nodes.length} exceeds budget.max_nodes_total ${maxNodes}`);
  }
  const maxHigh = budgetInt(budget.max_high_tier_nodes, "max_high_tier_nodes", errors);
  const highCount = nodeRows.filter((row) => HIGH_TIER_ROLES.has(row.role)).length;
  if (maxHigh !== null && highCount > maxHigh) {
    budgetFindings("max_high_tier_nodes").push(`high-tier node count ${highCount} exceeds budget.max_high_tier_nodes ${maxHigh}`);
  }
  budgetInt(budget.max_running_total, "max_running_total", errors);
  budgetInt(budget.max_submitted_per_tick, "max_submitted_per_tick", errors);
  let roleLimits = budget.max_running_by_role;
  if (!isRecord(roleLimits)) {
    errors.push("budget.max_running_by_role must be an object");
    roleLimits = {};
  }
  for (const [role, value] of Object.entries(roleLimits)) {
    budgetInt(value, `max_running_by_role.${role}`, errors);
  }
  const totalBytes = nodeRows.reduce((sum, row) => sum + Math.trunc(row.scope_preflight.scope_total_bytes || 0), 0);
  const totalFiles = nodeRows.reduce((sum, row) => sum + Math.trunc(row.scope_preflight.scope_file_count || 0), 0);
  const maxScopeBytes = budgetInt(budget.max_scope_bytes_total, "max_scope_bytes_total", errors);
  if (maxScopeBytes !== null && totalBytes > maxScopeBytes) {
    budgetFindings("max_scope_bytes_total").push(`scope bytes ${totalBytes} exceeds budget.max_scope_bytes_total ${maxScopeBytes}`);
  }

  return {
    status: errors.length ? "failed" : "ok",
    errors,
    warnings,
    nodes: nodeRows,
    layers,
    budget,
    review_policy: effectiveReviewPolicy(manifest),
    fleet_plan: {
      present: nodes.length >= 2,
      node_count: nodes.length,
      source: "manifest",
    },
    budget_usage: {
      nodes_total: nodes.length,
      high_tier_nodes: highCount,
      scope_file_count: totalFiles,
      scope_total_bytes: totalBytes,
    },
    routes_checked: sortedStrings(validRoutes),
    nodes_by_id: rowsById,
  };
}

export async function selfTest() {
  const { selfTest: run } = await import("../fleet_manifest_check.selftest.mjs");
  return run();
}
