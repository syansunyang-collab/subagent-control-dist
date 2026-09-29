// ops/tools/task_package_build.py 的 JS 复刻：把 package_seed 校验并组装成 task_package_envelope。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」；导出名为 Python 名的 camelCase，
// Python 关键字参数作为末尾 options 对象。
//
// 异常映射表（Python 分支 → JS 抛出物）：
//   parse_seed JSON 非法 / 根非对象                                 ToolError → ToolError（JSON 文案经 pyJsonLoads 逐字复刻）
//   load_seed_from_args 输入源不唯一                                 ToolError → ToolError
//   norm_repo_path 仓外路径                                         ToolError → ToolError
//   repo_output_path 不在允许根下                                   ToolError → ToolError
//   repo_abs_path 空串 / 仓外                                       ToolError → ToolError
//   target_repo_root 非空串 / 非绝对路径                             ToolError → ToolError
//   repo_or_target_abs_path 空串 / 既不在仓内也不在 target_repo 内     ToolError → ToolError
//   require_dict / require_list / require_string 类型不符             ToolError → ToolError
//   string_list 非列表 / 元素非字符串                                ToolError → ToolError
//   route_id_from_seed 缺 route_id / 只写在 inputs 里                ToolError → ToolError
//   validate_body 缺必填体字段、契约检查首条 issue                     ToolError → ToolError
//   build_and_write_output 输出路径越界                              ToolError → ToolError
//   sample_seed route_id 不含 "__"（元组解包失败）                    ValueError → pyError("ValueError", "not enough values to unpack (expected 2, got 1)")
//   load_seed 文件不存在                                            FileNotFoundError → pyError("FileNotFoundError", "[Errno 2] No such file or directory: '<path>'")
//   run_git 找不到 git                                              ToolError → ToolError（_tool_common.mjs 抛出）
//
// 有意的实现差异（不改变可观察行为）：
//   Path.write_text(newline=None) 在 Windows 上把 "\n" 写成 os.linesep，这里用 os.EOL 复刻同一字节形态。
//   Path.read_text(newline=None) 读入时把 "\r\n" 归一为 "\n"，这里用 _py.mjs 的 pyReadText 复刻。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ROOT, RUNTIME_ROOT, ToolError, clock, ids, isRecord, isSameOrInside, lexicalAbsolute, pathlibJoin, pyError, readStdinText, resolveLikePython, runGit, utcDateStamp,
} from "./_tool_common.mjs";
import {
  pyGet, pyGetItem, pyIsAbsolute, pyJsonLoads, pyReadText, pyReadTextReplace, pyRelativeTo, pyResolveUnder,
  pySplitLines, pyStr, pyStrip, pyStripChars, pyTruthy,
} from "./_py.mjs";
import { SEED_BODY_REQUIRED, profileFor, routeProfiles } from "./task_package_profiles.mjs";

export { ROOT, RUNTIME_ROOT, ToolError, readStdinText, SEED_BODY_REQUIRED, profileFor, routeProfiles };

export const PLAN_EXECUTION_ADJUSTMENT_KINDS = [
  "equivalent_command",
  "unique_path_resolution",
  "semantics_preserving_step_reorder",
];

export const FINAL_HANDOFF_VERDICTS = new Set(["done", "partial", "needs_owner", "needs_split", "failed", "pass", "fail"]);

function deepCopy(value) {
  return structuredClone(value);
}

// ---- 模块函数 ----

export function readProjectName() {
  const projectFile = path.join(ROOT, "PROJECT.md");
  if (!existsSync(projectFile)) return "<项目名>";
  const lines = pySplitLines(pyReadTextReplace(projectFile));
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (lines[idx].trim() !== "## 项目名称") continue;
    for (const candidate of lines.slice(idx + 1)) {
      const value = candidate.trim();
      if (value && !value.startsWith("#")) return value;
    }
    break;
  }
  return "<项目名>";
}

export function loadSeed(file) {
  let raw;
  if (file === "-") {
    raw = readStdinText("--seed -");
  } else {
    try {
      raw = pyReadText(file);
    } catch (error) {
      if (error?.code === "ENOENT") throw pyError("FileNotFoundError", `[Errno 2] No such file or directory: '${file}'`);
      throw error;
    }
  }
  return parseSeed(raw);
}

export function parseSeed(raw) {
  let data;
  try {
    data = pyJsonLoads(raw);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    throw new ToolError(`package_seed is not valid JSON: ${error.message}`);
  }
  if (!isRecord(data)) throw new ToolError("package_seed root must be a JSON object");
  return cleanJsonStrings(data);
}

export function cleanJsonStrings(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8").toString("utf8");
  if (Array.isArray(value)) return value.map(cleanJsonStrings);
  if (isRecord(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[pyStr(cleanJsonStrings(key))] = cleanJsonStrings(item);
    return out;
  }
  return value;
}

export function normRepoPath(value) {
  const projectReal = resolveLikePython(ROOT);
  const lexical = lexicalAbsolute(pathlibJoin(ROOT, value));
  const lexicalRelative = pyRelativeTo(lexical, projectReal);
  if (lexicalRelative === null) throw new ToolError(`path is outside repository scope: ${value}`);
  const resolved = resolveLikePython(lexical);
  // 项目内声明挂载（CR-RESOURCES 只读链接）的 realpath 落在运行包内：读面放行，写面仍由写域守卫拒绝。
  if (pyRelativeTo(resolved, projectReal) === null && !isSameOrInside(resolved, RUNTIME_ROOT)) {
    throw new ToolError(`path is outside repository scope: ${value}`);
  }
  return lexicalRelative;
}

export function repoOutputPath(value, allowedRoots, label) {
  const relPath = normRepoPath(value);
  const allowed = allowedRoots.map((root) => pyStripChars(String(root), "/").replace(/\\/g, "/"));
  if (!allowed.some((root) => relPath === root || relPath.startsWith(`${root}/`))) {
    throw new ToolError(`${label} must be under one of: ${allowedRoots.join(", ")}`);
  }
  return relPath;
}

export function repoAbsPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${label} must be a non-empty string`);
  const projectReal = resolveLikePython(ROOT);
  const lexical = lexicalAbsolute(pathlibJoin(ROOT, value));
  if (pyRelativeTo(lexical, projectReal) === null) {
    throw new ToolError(`${label} must resolve under repository root: ${value}`);
  }
  const resolved = resolveLikePython(lexical);
  if (pyRelativeTo(resolved, projectReal) === null && !isSameOrInside(resolved, RUNTIME_ROOT)) {
    throw new ToolError(`${label} must resolve under repository root: ${value}`);
  }
  return resolved;
}

export function targetRepoRoot(runtime) {
  const target = pyGet(runtime, "target_repo", null);
  if (target === null || target === undefined || target === "") return null;
  if (typeof target !== "string" || !target.trim()) {
    throw new ToolError("runtime_context.target_repo must be a non-empty string when set");
  }
  if (!pyIsAbsolute(target)) throw new ToolError("runtime_context.target_repo must be an absolute path");
  return resolveLikePython(target);
}

export function repoOrTargetAbsPath(value, runtime, label) {
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${label} must be a non-empty string`);
  const projectReal = resolveLikePython(ROOT);
  const lexical = lexicalAbsolute(pathlibJoin(ROOT, value));
  const resolved = resolveLikePython(lexical);
  const inProjectLexically = pyRelativeTo(lexical, projectReal) !== null;
  if (inProjectLexically && (pyRelativeTo(resolved, projectReal) !== null || isSameOrInside(resolved, RUNTIME_ROOT))) {
    return resolved;
  }
  const target = targetRepoRoot(runtime);
  if (target !== null && pyRelativeTo(resolved, target) !== null) return resolved;
  throw new ToolError(`${label} must resolve under repository root or runtime_context.target_repo: ${value}`);
}

export function requireDict(data, key) {
  const value = pyGet(data, key);
  if (!isRecord(value)) throw new ToolError(`${key} must be a JSON object`);
  return deepCopy(value);
}

export function requireList(data, key) {
  const value = pyGet(data, key);
  if (!Array.isArray(value)) throw new ToolError(`${key} must be a JSON list`);
  return deepCopy(value);
}

export function requireString(data, key) {
  const value = pyGet(data, key);
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${key} must be a non-empty string`);
  return value;
}

export function stringList(value, label) {
  if (!Array.isArray(value)) throw new ToolError(`${label} must be a list`);
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") throw new ToolError(`${label} entries must be strings`);
    result.push(item);
  }
  return result;
}

export function scopeFromSeed(seed) {
  const scope = requireDict(seed, "scope");
  return {
    read: stringList(pyGet(scope, "read"), "scope.read"),
    write: stringList(pyGet(scope, "write"), "scope.write"),
    delete: stringList(pyGet(scope, "delete"), "scope.delete"),
    out_of_scope: stringList(pyGet(scope, "out_of_scope"), "scope.out_of_scope"),
  };
}

export function gitValue(args, fallback = "") {
  const result = runGit(args);
  if (result.exit_code !== 0) return fallback;
  return result.stdout.trim() || fallback;
}

export function packageId(routeId, seed) {
  if (pyTruthy(pyGet(seed, "package_id"))) return pyStr(pyGetItem(seed, "package_id"));
  const now = clock.now();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${utcDateStamp()}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `pkg-${String(routeId).replaceAll("__", "-")}-${stamp}-${ids.uuidHex().slice(0, 12)}`;
}

export function routeIdFromSeed(seed) {
  const value = pyGet(seed, "route_id");
  if (typeof value === "string" && value.trim()) return value.trim();
  const inputs = pyGet(seed, "inputs");
  if (isRecord(inputs) && typeof pyGet(inputs, "route_id") === "string" && pyGetItem(inputs, "route_id").trim()) {
    throw new ToolError(
      "package_seed.route_id is required at the JSON root; " +
        "inputs.route_id is task input metadata and is not used to select a route",
    );
  }
  throw new ToolError("package_seed.route_id is required at the JSON root");
}

const TRUTHY_TEXT = new Set(["1", "true", "yes", "y", "on"]);
export function truthyText(value) {
  const base = pyTruthy(value) ? value : "";
  return TRUTHY_TEXT.has(pyStrip(pyStr(base)).toLowerCase());
}

function projectDeclarations(input) {
  const seed = deepCopy(input);
  for (const [object, canonical, legacy] of [
    [seed.expected_output, "file_path", "path"],
    [seed.handoff_contract, "require_final_handoff", "final_response_required"],
  ]) {
    if (!Object.hasOwn(object, canonical) && Object.hasOwn(object, legacy)) object[canonical] = object[legacy];
    delete object[legacy];
  }
  const destinations = [seed.expected_output.file_path, seed.handoff_contract.handoff_file].filter(value => typeof value === "string" && value);
  for (const destination of destinations) {
    if (!seed.scope.write.includes(destination)) seed.scope.write.push(destination);
    const conflictWrite = seed.concurrency_contract?.conflict_keys?.write;
    if (Array.isArray(conflictWrite) && !conflictWrite.includes(destination)) conflictWrite.push(destination);
  }
  if (truthyText(seed.runtime_context.network_needed) || seed.tool_contract.network_allowed === true) {
    seed.runtime_context.network_needed = "yes";
    seed.tool_contract.network_allowed = true;
  }
  delete seed.runtime_context.agent_runtime_consent;
  delete seed.handoff_contract.parent_consume_action;
  delete seed.ownership.unlock_conditions;
  if (Array.isArray(seed.tool_contract.allowed)) {
    seed.tool_contract.allowed = [...new Set(seed.tool_contract.allowed.map(item => typeof item === "string" ? item.trim() : item))];
  } else if (seed.tool_contract.allowed == null) {
    seed.tool_contract.allowed = null;
  }
  const executor = seed.extensions?.capability_contract?.executor;
  if (seed.route_id === "executor-agent__plan-execution" && isRecord(executor)) {
    if (!Object.hasOwn(executor, "execution_adjustment_policy")) executor.execution_adjustment_policy = {};
    const policy = executor.execution_adjustment_policy;
    if (isRecord(policy) && !Object.hasOwn(policy, "allowed_kinds")) policy.allowed_kinds = [...PLAN_EXECUTION_ADJUSTMENT_KINDS];
  }
  const scoped = executor?.scoped;
  if (isRecord(scoped?.ref_resolution) && !(scoped.operation_type === "source_clone_only" && scoped.ref_resolution.if_missing === "fallback_default_branch")) {
    delete scoped.ref_resolution.fallback_ref;
  }
  // 回执检查由运行协议固定启用，不由调用者重复声明或关闭。
  seed.handoff_contract.require_final_handoff = true;
  return seed;
}

// 别名与规范字段同时提供时只拒绝冲突值；输出统一使用规范字段。
function aliasValue(object, canonical, legacy, label, issues) {
  if (Object.hasOwn(object, canonical)) {
    if (Object.hasOwn(object, legacy) && object[canonical] !== object[legacy]) {
      issues.push(`${label}.${legacy} conflicts with ${label}.${canonical}; provide one value`);
    }
    return object[canonical];
  }
  return object[legacy];
}

// expected_output 的别名归一与 file 模式值域规则。
export function checkExpectedOutputContract(expected) {
  const issues = [];
  const filePath = aliasValue(expected, "file_path", "path", "expected_output", issues);
  const mode = pyGet(expected, "mode");
  if (mode !== "file") {
    issues.push("expected_output.mode must be file");
    return issues;
  }
  if (typeof filePath !== "string" || !filePath) {
    issues.push("expected_output.mode=file requires expected_output.file_path");
  }
  return issues;
}

// handoff_contract 的遗留别名、字段类型和输出路径形状。
export function checkHandoffContract(handoff) {
  const issues = [];
  aliasValue(handoff, "require_final_handoff", "final_response_required", "handoff_contract", issues);
  const acceptVerdicts = pyGet(handoff, "accept_verdicts");
  if (!Array.isArray(acceptVerdicts) || !acceptVerdicts.length) {
    issues.push("handoff_contract.accept_verdicts must be a non-empty list");
  } else {
    const invalid = acceptVerdicts.filter((item) => !FINAL_HANDOFF_VERDICTS.has(item)).map(pyStr);
    if (invalid.length) {
      issues.push(`handoff_contract.accept_verdicts contains invalid verdicts: ${invalid.join(", ")}`);
    }
  }
  if (typeof pyGet(handoff, "handoff_file_required") !== "boolean") {
    issues.push("handoff_contract.handoff_file_required must be boolean");
  }
  if (pyTruthy(pyGet(handoff, "handoff_file_required")) && !pyTruthy(pyGet(handoff, "handoff_file"))) {
    issues.push("handoff_contract.handoff_file is required when handoff_file_required=true");
  }
  return issues;
}

export function validateBody(seed, routeId) {
  const missing = SEED_BODY_REQUIRED.filter((key) => !Object.hasOwn(seed, key));
  if (missing.length) {
    throw new ToolError(`package_seed missing required body fields for ${routeId}: ${missing.join(", ")}`);
  }
  requireDict(seed, "project_positioning");
  requireString(seed, "goal");
  const scope = scopeFromSeed(seed);
  requireDict(seed, "ownership");
  requireDict(seed, "concurrency_contract");
  requireDict(seed, "inputs");
  requireList(seed, "known_facts");
  const expected = requireDict(seed, "expected_output");
  const runtime = requireDict(seed, "runtime_context");
  requireDict(seed, "alignment");
  requireDict(seed, "planning_policy");
  requireDict(seed, "tool_contract");
  requireList(seed, "stop_conditions");
  requireDict(seed, "extensions");
  const handoff = requireDict(seed, "handoff_contract");

  const issues = [
    ...checkExpectedOutputContract(expected),
    ...checkHandoffContract(handoff),
  ];
  if (issues.length) throw new ToolError(issues[0]);

  const filePath = Object.hasOwn(expected, "file_path") ? expected.file_path : expected.path;
  repoOrTargetAbsPath(filePath, runtime, "expected_output.file_path");
  for (const item of scope.write) repoOrTargetAbsPath(item, runtime, "scope.write");
  for (const item of scope.delete) repoAbsPath(item, "scope.delete");
  const handoffFile = pyGet(handoff, "handoff_file", null);
  if (handoffFile !== null && handoffFile !== undefined) repoAbsPath(handoffFile, "handoff_contract.handoff_file");
  return null; // Python 的隐式 None。
}

export function enrichRuntimeContext(runtimeContext) {
  const runtime = deepCopy(runtimeContext);
  // Python 的 setdefault 会先求值实参，git 探测无条件发生；此处保持同一副作用顺序。
  const cwdDefault = ROOT;
  if (!Object.hasOwn(runtime, "cwd")) runtime.cwd = cwdDefault;
  runtime.output_root = ROOT;
  const gitDefault = {
    branch: gitValue(["branch", "--show-current"], "(unknown)"),
    head: gitValue(["rev-parse", "--short=12", "HEAD"], "(unknown)"),
  };
  if (!Object.hasOwn(runtime, "git")) runtime.git = gitDefault;
  return runtime;
}

export function enrichExpectedOutput(expectedOutput, runtimeContext) {
  const expected = deepCopy(expectedOutput);
  if (pyGet(expected, "mode") === "file" && typeof pyGet(expected, "file_path") === "string") {
    expected.resolved_file_path = repoOrTargetAbsPath(
      pyGetItem(expected, "file_path"),
      runtimeContext,
      "expected_output.file_path",
    );
  }
  return expected;
}

export function enrichHandoffContract(handoffContract) {
  const handoff = deepCopy(handoffContract);
  const handoffFile = pyGet(handoff, "handoff_file");
  if (typeof handoffFile === "string" && handoffFile.trim()) {
    handoff.resolved_handoff_file = repoAbsPath(handoffFile, "handoff_contract.handoff_file");
  } else {
    handoff.resolved_handoff_file = null;
  }
  return handoff;
}

export function buildPackage(seed) {
  const routeId = routeIdFromSeed(seed);
  const profile = profileFor(routeId);
  validateBody(seed, routeId);
  seed = projectDeclarations(seed);
  const pkgId = packageId(routeId, seed);
  const pkg = {
    version: pyStr(pyGet(seed, "version", "1")),
    package_id: pkgId,
    agent: deepCopy(pyGetItem(profile, "agent")),
    project_positioning: seed.project_positioning,
    goal: seed.goal,
    scope: {
      read: seed.scope.read,
      write: seed.scope.write,
      delete: seed.scope.delete,
      out_of_scope: seed.scope.out_of_scope,
    },
    ownership: seed.ownership,
    concurrency_contract: seed.concurrency_contract,
    inputs: seed.inputs,
    known_facts: seed.known_facts,
    expected_output: enrichExpectedOutput(seed.expected_output, seed.runtime_context),
    runtime_context: enrichRuntimeContext(seed.runtime_context),
    alignment: seed.alignment,
    planning_policy: seed.planning_policy,
    tool_contract: seed.tool_contract,
    stop_conditions: seed.stop_conditions,
    extensions: seed.extensions,
    handoff_contract: enrichHandoffContract(seed.handoff_contract),
  };
  return { task_package: pkg };
}

export function buildAndWriteOutput(seed, output) {
  const localSeed = { ...seed };
  if (!pyTruthy(pyGet(localSeed, "package_id"))) {
    const routeId = routeIdFromSeed(localSeed);
    localSeed.package_id = packageId(routeId, localSeed);
  }
  const pkg = buildPackage(localSeed);
  const out = path.join(ROOT, repoOutputPath(output, ["tmp", "notes/manifests"], "--output"));
  mkdirSync(path.dirname(out), { recursive: true });
  // Path.write_text(newline=None) 在 Windows 上把 "\n" 写成 CRLF，这里复刻同一字节形态。
  writeFileSync(out, `${JSON.stringify(pkg, null, 2)}\n`.replaceAll("\n", os.EOL), "utf8");
  return pkg;
}

export function renderMessage(pkg) {
  const payload = JSON.stringify(pkg, null, 2);
  return (
    "请严格执行以下完整 task_package。不得用自然语言任务说明替代任务包；" +
    "先按公共提示词做任务材料预检，发现材料缺失、互相冲突或无法判断时立即返回 needs_owner。\n\n" +
    "```json\n" +
    `${payload}\n` +
    "```\n"
  );
}

export function sampleSeed(routeId) {
  const parts = String(routeId).split("__");
  if (parts.length < 2) throw pyError("ValueError", "not enough values to unpack (expected 2, got 1)");
  const role = parts[0];
  const capability = parts.slice(1).join("__");
  const promptKey = capability.replaceAll("-", "_");
  return {
    route_id: routeId,
    goal: `构造 ${routeId} 的统一完整 seed 自测包。`,
    project_positioning: {
      project: readProjectName(),
      status: "tool self-test",
      roadmap: "tool self-test",
    },
    scope: {
      read: ["AGENTS.md"],
      write: [`notes/manifests/${routeId}-self-test.md`],
      delete: [],
      out_of_scope: ["禁止修改文件", "禁止提交", "禁止联网"],
    },
    ownership: {
      owner: "child_agent",
      parent_forbidden_same_scope_probe: true,
    },
    concurrency_contract: {
      group_id: `self-test-${routeId}`,
      lane_id: "single",
      depends_on: [],
      conflict_keys: {
        read: ["AGENTS.md"],
        write: [`notes/manifests/${routeId}-self-test.md`],
        delete: [],
        output: `notes/manifests/${routeId}-self-test.md`,
      },
      parallel_policy: "single_lane",
    },
    inputs: {
      route_id: routeId,
      route_file: `ops/protocols/task-package-routes/${routeId}.md`,
      question: "确认统一完整 seed 可以构包。",
    },
    known_facts: [],
    expected_output: {
      mode: "file",
      file_path: `notes/manifests/${routeId}-self-test.md`,
      required_sections: ["scope", "summary", "findings"],
      business_gate: `${promptKey}_gate`,
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
      reason: "tool self-test",
    },
    tool_contract: {
      allowed: null,
      forbidden: ["write_outside_scope", "git_commit", "network", "install_dependencies"],
      network_allowed: false,
      install_allowed: false,
    },
    stop_conditions: [
      "required input file missing",
      "scope authorization conflict",
      "output contract cannot be satisfied",
    ],
    extensions: {
      capability_contract: {
        [promptKey]: {
          self_test: true,
          role,
          capability,
        },
      },
    },
    handoff_contract: {
      handoff_file_required: false,
      handoff_file: null,
      accept_verdicts: ["done", "partial", "needs_owner", "failed", "pass", "fail"],
    },
  };
}
