// ops/tools/task_package_lint.py 的 JS 复刻：对 task_package_envelope 做静态校验。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」；导出名为 Python 名的 camelCase。
// Python 模块通过 `from task_package_build import ...` / `from task_package_profiles import ...`
// 把这些名字绑进自身命名空间，消费面按 `task_package_lint.X` 取用，故此处一并再导出。
//
// 异常映射表（Python 分支 → JS 抛出物）：
//   parse_package JSON 非法                                 ToolError → ToolError（JSON 文案经 pyJsonLoads 逐字复刻）
//   parse_package 根不是含 task_package 对象的信封            ToolError → ToolError
//   load_package_from_args 输入源不唯一                       ToolError → ToolError
//   load_package 文件不存在                                  FileNotFoundError → pyError("FileNotFoundError", ...)
//   lint_package 缺 root["task_package"]                     KeyError  → pyError("KeyError", "'task_package'")
//   route_profile → profile_for 未注册 route_id              KeyError  → pyError("KeyError", pyRepr(消息))
//     —— lint_package 捕获后按 `[str(exc)]` 返回，issues 里带 repr 引号，逐字复刻。
//   非 dict 上调用 .get（scope / extensions / agent 等被写成列表时）  AttributeError → pyError("AttributeError", "'list' object has no attribute 'get'")
//     —— 这是 Python 侧的既有崩溃路径（见回报「Python 疑点」），此处按同一类型名与文案复刻，不修。
//   本模块自身不抛 ToolError 之外的自定义错误。
import { existsSync, statSync } from "node:fs";

import { ROOT, RUNTIME_ROOT, ToolError, asList, isRecord, isSameOrInside, lexicalAbsolute, pyError, readStdinText, resolveLikePython } from "./_tool_common.mjs";
import {
  pyGet, pyGetItem, pyIsAbsolute, pyJsonLoads, pyOr, pyPathJoin, pyReadText, pyRelativeTo,
  pyResolveUnder, pySamePath, pyStr, pyTruthy, pyTypeName,
} from "./_py.mjs";
import {
  buildPackage,
  PLAN_EXECUTION_ADJUSTMENT_KINDS,
  checkExpectedOutputContract,
  checkHandoffContract,
  sampleSeed,
} from "./task_package_build.mjs";
import {
  REQUIRED_TOP_LEVEL,
  conditionalRequiredFiles,
  profileFor,
  routeIdFromAgent,
  routeProfiles,
} from "./task_package_profiles.mjs";

export {
  ROOT,
  ToolError,
  asList,
  readStdinText,
  buildPackage,
  checkExpectedOutputContract,
  checkHandoffContract,
  sampleSeed,
  REQUIRED_TOP_LEVEL,
  conditionalRequiredFiles,
  profileFor,
  routeIdFromAgent,
  routeProfiles,
};

export const EXTERNAL_REF_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
export { PLAN_EXECUTION_ADJUSTMENT_KINDS };
export const RESOURCE_RELEASE_EVENTS = new Set(["contract_locked", "execution_done", "validation_passed"]);

// Python 在非 dict 上调用 .get 会抛 AttributeError；此处按同一类型名复刻。
function dictGet(container, key, fallback = undefined) {
  if (!isRecord(container)) throw pyError("AttributeError", `'${pyTypeName(container)}' object has no attribute 'get'`);
  return Object.hasOwn(container, key) ? container[key] : fallback;
}

function sameStringList(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

export function loadPackage(file) {
  let raw;
  if (file === "-") {
    raw = readStdinText("--file -");
  } else {
    try {
      raw = pyReadText(file);
    } catch (error) {
      if (error?.code === "ENOENT") throw pyError("FileNotFoundError", `[Errno 2] No such file or directory: '${file}'`);
      throw error;
    }
  }
  return parsePackage(raw);
}

export function parsePackage(raw) {
  let data;
  try {
    data = pyJsonLoads(raw);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    throw new ToolError(`package is not valid JSON: ${error.message}`);
  }
  if (!isRecord(data) || !isRecord(pyGet(data, "task_package"))) {
    throw new ToolError(
      "expected task_package_envelope root with task_package object; " +
        'wrap the task_package_body as {"task_package": {...}} or use task_package_build.mjs',
    );
  }
  return data;
}

export function existsRepoPath(value) {
  return existsSync(pyPathJoin(ROOT, value));
}

export function existsUnderRoot(value, root) {
  return existsSync(pyPathJoin(root, value));
}

export function isExternalRef(value) {
  return EXTERNAL_REF_RE.test(value) || value.startsWith("http://") || value.startsWith("https://");
}

export function targetRoot(pkg) {
  const issues = [];
  const runtime = dictGet(pkg, "runtime_context", {});
  const target = isRecord(runtime) ? pyGet(runtime, "target_repo") : null;
  const createAllowed = isRecord(runtime) ? pyGet(runtime, "target_repo_create_allowed") === true : false;
  if (target === null || target === undefined || target === "") return [resolveLikePython(ROOT), issues];
  if (typeof target !== "string" || !target.trim()) {
    return [resolveLikePython(ROOT), ["runtime_context.target_repo must be a non-empty string when set"]];
  }
  if (!pyIsAbsolute(target)) issues.push("runtime_context.target_repo must be an absolute path");
  const resolved = pyResolveUnder(target, ROOT);
  if (!existsSync(resolved) && !createAllowed) {
    issues.push(`runtime_context.target_repo not found: ${target}`);
  } else if (existsSync(resolved) && !statSync(resolved).isDirectory()) {
    issues.push(`runtime_context.target_repo is not a directory: ${target}`);
  }
  return [resolved, issues];
}

export function pathScopeIssue(value, { base, rootLabel, allowAbsoluteOutside = false, allowRuntime = false } = {}) {
  if (isExternalRef(value)) return null;
  const resolved = pyResolveUnder(value, base);
  if (pyIsAbsolute(value) && allowAbsoluteOutside) return null;
  if (allowRuntime && pyRelativeTo(lexicalAbsolute(pyPathJoin(base, value)), resolveLikePython(base)) !== null
      && isSameOrInside(resolved, RUNTIME_ROOT)) return null;
  if (pyRelativeTo(resolved, resolveLikePython(base)) === null) {
    const issue = `path is outside ${rootLabel} scope: ${value}`;
    if (allowAbsoluteOutside) {
      const retry = existsSync(resolved)
        ? `replace this scope.read entry with ${JSON.stringify(resolved)} and retry preview`
        : "set scope.read to an existing real absolute path for external read and retry preview";
      return `${issue}; resolved path: ${resolved}; ${retry} (read only; write/delete boundaries unchanged)`;
    }
    return issue;
  }
  return null;
}

export function routeProfile(pkg) {
  const agent = dictGet(pkg, "agent", {});
  const capability = dictGet(agent, "capability", {});
  const routeId = routeIdFromAgent(pyStr(dictGet(agent, "role", "")), pyStr(dictGet(capability, "name", "")));
  return [routeId, profileFor(routeId)];
}

export function lintAgent(pkg, profile, routeId, { compiled = false } = {}) {
  const issues = [];
  const agent = dictGet(pkg, "agent", {});
  const capability = dictGet(agent, "capability", {});
  const expectedAgent = pyGetItem(profile, "agent");
  if (!compiled) {
    if (dictGet(agent, "role") !== pyGetItem(expectedAgent, "role")) issues.push(`agent.role mismatch for ${routeId}`);
    if (dictGet(agent, "runtime_role") !== pyGetItem(expectedAgent, "runtime_role")) {
      issues.push(`agent.runtime_role mismatch for ${routeId}`);
    }
    if (dictGet(capability, "name") !== pyGetItem(pyGetItem(expectedAgent, "capability"), "name")) {
      issues.push(`capability.name mismatch for ${routeId}`);
    }
    if (dictGet(capability, "file") !== pyGetItem(pyGetItem(expectedAgent, "capability"), "file")) {
      issues.push(`capability.file mismatch for ${routeId}`);
    }
  }

  const requiredFiles = asList(dictGet(agent, "required_files"));
  const expectedRequiredFiles = conditionalRequiredFiles(pkg, profile);
  if (!compiled && !sameStringList(requiredFiles, expectedRequiredFiles)) issues.push(`agent.required_files mismatch for ${routeId}`);
  for (const item of expectedRequiredFiles) {
    if (!existsUnderRoot(item, RUNTIME_ROOT)) issues.push(`agent.required_files path missing from runtime: ${item}`);
  }
  if (!requiredFiles.includes("ops/agent-prompts/_common.md")) {
    issues.push("agent.required_files missing ops/agent-prompts/_common.md");
  }
  const capabilityFile = pyGetItem(pyGetItem(expectedAgent, "capability"), "file");
  if (!requiredFiles.includes(capabilityFile)) {
    issues.push(`agent.required_files missing capability prompt ${capabilityFile}`);
  }
  if (!existsUnderRoot(pyGetItem(profile, "route_file"), RUNTIME_ROOT)) {
    issues.push(`route file missing: ${pyGetItem(profile, "route_file")}`);
  }
  return issues;
}

export function lintScope(pkg) {
  const issues = [];
  const scope = dictGet(pkg, "scope", {});
  if (!isRecord(scope)) return ["scope must be an object"];
  const [root, rootIssues] = targetRoot(pkg);
  issues.push(...rootIssues);
  const rootLabel = !pySamePath(root, resolveLikePython(ROOT)) ? "target_repo" : "repository";
  for (const key of ["read", "write", "delete", "out_of_scope"]) {
    if (!Array.isArray(dictGet(scope, key))) issues.push(`scope.${key} must be a list`);
  }
  for (const item of asList(dictGet(scope, "read"))) {
    if (typeof item !== "string") {
      issues.push("scope.read entries must be strings");
      continue;
    }
    const issue = pathScopeIssue(item, { base: root, rootLabel, allowAbsoluteOutside: true, allowRuntime: true });
    if (issue) issues.push(issue);
  }
  for (const key of ["write", "delete"]) {
    for (const item of asList(dictGet(scope, key))) {
      if (typeof item !== "string") {
        issues.push(`scope.${key} entries must be strings`);
        continue;
      }
      if (isExternalRef(item)) {
        issues.push(`scope.${key} cannot be external ref: ${item}`);
        continue;
      }
      let issue = pathScopeIssue(item, { base: ROOT, rootLabel: "repository", allowAbsoluteOutside: false });
      if (issue && key === "write" && !pySamePath(root, resolveLikePython(ROOT))) {
        const targetIssue = pathScopeIssue(item, { base: root, rootLabel, allowAbsoluteOutside: false });
        if (targetIssue === null) issue = null;
      }
      if (issue) issues.push(issue);
    }
  }
  for (const item of asList(dictGet(scope, "out_of_scope"))) {
    if (typeof item !== "string") issues.push("scope.out_of_scope entries must be strings");
  }
  return issues;
}

export function lintExpectedOutput(pkg) {
  const issues = [];
  const expected = dictGet(pkg, "expected_output", {});
  if (!isRecord(expected)) return ["expected_output must be an object"];
  const mode = dictGet(expected, "mode");
  const [root, rootIssues] = targetRoot(pkg);
  issues.push(...rootIssues);
  issues.push(...checkExpectedOutputContract(expected));
  const resolved = dictGet(expected, "resolved_file_path", null);
  if (mode === "file" && resolved !== null && resolved !== undefined && pyTruthy(dictGet(expected, "file_path"))) {
    const repoIssue = pathScopeIssue(pyStr(resolved), { base: ROOT, rootLabel: "repository" });
    const targetIssue = pathScopeIssue(pyStr(resolved), { base: root, rootLabel: "target_repo" });
    if (repoIssue && targetIssue) {
      issues.push("expected_output.resolved_file_path must be under repository root or runtime_context.target_repo");
    }
  }
  return issues;
}

export function lintCommonObjects(pkg) {
  const issues = [];
  for (const key of [
    "project_positioning",
    "ownership",
    "concurrency_contract",
    "inputs",
    "runtime_context",
    "alignment",
    "planning_policy",
    "tool_contract",
    "extensions",
    "handoff_contract",
  ]) {
    if (!isRecord(dictGet(pkg, key))) issues.push(`${key} must be an object`);
  }
  for (const key of ["known_facts", "stop_conditions"]) {
    if (!Array.isArray(dictGet(pkg, key))) issues.push(`${key} must be a list`);
  }
  const toolContract = dictGet(pkg, "tool_contract", {});
  const allowed = isRecord(toolContract) ? pyGet(toolContract, "allowed", null) : null;
  if (allowed !== null && allowed !== undefined) {
    if (!Array.isArray(allowed) || allowed.some((item) => typeof item !== "string" || !item.trim())) {
      issues.push("tool_contract.allowed must be null or an array of non-empty Pi tool names");
    }
  }
  for (const field of ["network_allowed", "install_allowed"]) {
    if (isRecord(toolContract) && Object.hasOwn(toolContract, field) && typeof toolContract[field] !== "boolean") {
      issues.push(`tool_contract.${field} must be boolean`);
    }
  }
  const handoff = dictGet(pkg, "handoff_contract", {});
  issues.push(...checkHandoffContract(handoff));
  const handoffFile = dictGet(handoff, "handoff_file");
  const resolvedHandoff = dictGet(handoff, "resolved_handoff_file", null);
  if (resolvedHandoff !== null && resolvedHandoff !== undefined && pyTruthy(handoffFile)) {
    if (pathScopeIssue(pyStr(resolvedHandoff), { base: ROOT, rootLabel: "repository" })) {
      issues.push("handoff_contract.resolved_handoff_file must be under repository root");
    }
  }
  return issues;
}

export function lintCapabilityContract(pkg, routeId) {
  const issues = [];
  const contracts = dictGet(dictGet(pkg, "extensions", {}), "capability_contract", {});
  if (!isRecord(contracts)) return issues;

  if (routeId === "executor-agent__scoped-execution") {
    const scoped = dictGet(dictGet(contracts, "executor", {}), "scoped", {});
    if (isRecord(scoped)) {
      const operationType = pyStr(pyOr(pyGet(scoped, "operation_type"), "")).trim();
      const refResolution = pyGet(scoped, "ref_resolution");
      const resolution = isRecord(refResolution) ? refResolution : {};
      const ifMissing = pyStr(pyOr(pyGet(resolution, "if_missing"), "")).trim();
      const fallbackRef = pyGet(resolution, "fallback_ref", null);
      const fallbackPresent = typeof fallbackRef === "string" && Boolean(fallbackRef.trim());
      if (operationType === "source_clone_only" && ifMissing === "fallback_default_branch") {
        if (!fallbackPresent) {
          issues.push(
            "executor.scoped.ref_resolution.fallback_ref must be a non-empty string when if_missing=fallback_default_branch",
          );
        }
      }
    }
  }

  if (routeId === "executor-agent__plan-execution") {
    const executor = dictGet(contracts, "executor", {});
    if (isRecord(executor)) {
      const policy = pyGet(executor, "execution_adjustment_policy", {});
      if (
        isRecord(policy) &&
        Object.hasOwn(policy, "allowed_kinds") &&
        (!Array.isArray(policy.allowed_kinds) || policy.allowed_kinds.some(kind => !PLAN_EXECUTION_ADJUSTMENT_KINDS.includes(kind)))
      ) {
        issues.push("executor.execution_adjustment_policy.allowed_kinds must be a subset of the supported adjustment kinds");
      }
      const locks = pyGet(executor, "resource_locks");
      if (Array.isArray(locks)) {
        locks.forEach((lock, index) => {
          const prefix = `executor.resource_locks[${index}]`;
          if (!isRecord(lock)) {
            issues.push(`${prefix} must be an object`);
            return;
          }
          for (const field of ["lock_id", "holder_lane"]) {
            const value = pyGet(lock, field);
            if (typeof value !== "string" || !value.trim()) {
              issues.push(`${prefix}.${field} must be a non-empty string`);
            }
          }
          const releaseEvents = pyGet(lock, "release_events");
          if (
            !Array.isArray(releaseEvents) ||
            (pyGet(lock, "exclusive") === true && !releaseEvents.length) ||
            asList(releaseEvents).some((event) => !RESOURCE_RELEASE_EVENTS.has(event))
          ) {
            issues.push(`${prefix}.release_events must use observable release events`);
          }
        });
      }
    }
  }

  if (routeId === "batch-agent__mechanical-batch") {
    const batch = dictGet(contracts, "batch", {});
    if (isRecord(batch) && Object.hasOwn(batch, "chunk_budget")) {
      const budget = pyGet(batch, "chunk_budget");
      for (const field of ["max_files", "max_bytes", "max_lines"]) {
        const value = isRecord(budget) ? pyGet(budget, field, null) : null;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
          issues.push(`batch.chunk_budget.${field} must be a positive integer`);
        }
      }
    }
  }

  return issues;
}

export function lintPackage(root, { compiled = false } = {}) {
  const pkg = pyGetItem(root, "task_package");
  const issues = [];
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(isRecord(pkg) ? Object.hasOwn(pkg, key) : false)) issues.push(`missing top-level field: ${key}`);
  }
  let routeId;
  let profile;
  try {
    [routeId, profile] = routeProfile(pkg);
  } catch (error) {
    if (error?.name === "KeyError") return [error.message];
    throw error;
  }
  issues.push(...lintAgent(pkg, profile, routeId, { compiled }));
  issues.push(...lintScope(pkg));
  issues.push(...lintExpectedOutput(pkg));
  issues.push(...lintCommonObjects(pkg));
  issues.push(...lintCapabilityContract(pkg, routeId));
  return issues;
}
