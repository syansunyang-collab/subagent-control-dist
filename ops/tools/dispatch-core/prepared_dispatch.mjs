// ops/tools/prepared_dispatch.py 的 JS 复刻：派发材料的编译、原子落盘与验证。
// 本模块不含投递策略：调用方给出已解析的信封选项，必要时再给材料/证据构建回调。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」；导出名是 Python 函数名的 camelCase，
// 位置参数同序，Python 关键字参数收成末尾一个 options 对象（键 camelCase）。
//
// 异常映射表（Python → JS）：
//   PreparedDispatchError(ValueError)         → PreparedDispatchError，name 与消息逐字一致
//   ValueError（Path.relative_to 不在根下）     → 就地转 PreparedDispatchError，文案取所在分支原文
//   TypeError / ValueError（json.dumps 失败）   → PreparedDispatchError("value is not canonical JSON: …")
//   json.JSONDecodeError / UnicodeDecodeError → PreparedDispatchError，文案取所在分支原文
//   FileNotFoundError / OSError（有分支的）      → PreparedDispatchError，文案取所在分支原文
//   OSError（无分支的，如落盘 rename 失败）        → 原样上抛 Node 的 fs 错误，仅触发已分配根的清理
//   回调自身抛出的异常                           → 原样上抛，类型不变
// PreparedDispatchError 在 Python 里是 ValueError 的子类，因此 compile 里 `except ValueError`
// 会一并吞掉守门错误并改写为 task_root 文案；JS 侧用 instanceof 显式复刻这一层。
import {
  closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync,
  statSync, unlinkSync,
} from "node:fs";
import path from "node:path";

import {
  absolutePath, assertNoReparseComponents, assertRegularFile, atomicWriteBytes, ensureControlledDirectory,
  ids, isRecord, isReparseStat, resolveLikePython,
} from "./_tool_common.mjs";
import { pyNormcase } from "./_py.mjs";

export const DESCRIPTOR_CONTRACT_VERSION = "prepared-dispatch-descriptor/v1";
export const DISPATCH_CONTRACT_VERSION = "async-dispatch/v2";
export const PREPARATION_DIRECTORY_NAME = "preparations";
export const PREPARATION_PREFIX = "prep-";
export const PREPARATION_ALLOCATION_RETRIES = 8;
export const PACKAGE_FILENAME = "package.json";
export const TASK_FILENAME = "package.task.md";
export const DISPATCH_FILENAME = "package.dispatch.json";
export const DESCRIPTOR_FILENAME = "prepared-dispatch.json";
const RESERVED_FILENAMES = Object.freeze([PACKAGE_FILENAME, TASK_FILENAME, DISPATCH_FILENAME, DESCRIPTOR_FILENAME]);
const OWNED_UNCOMMITTED_ROOTS = new Set();

export class PreparedDispatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreparedDispatchError";
  }
}

export const ASYNC_DISPATCH_V2_FIELDS = Object.freeze([
  "contract_version",
  "producer_root",
  "origin_thread_id",
  "target_cwd",
  "task_file",
  "task_root",
  "runner_path",
  "runtime_role",
  "model",
  "effort",
  "context_mode",
  "execution_profile",
  "result_mode",
  "simulation",
  "budget",
  "batch_id",
  "slice_id",
  "display_title",
  "save_raw_evidence",
  "turn_timeout_ms",
  "stall_silence_ms",
  "selection",
]);
const SELECTION_FIELDS = Object.freeze([
  "requested", "role", "capability", "pick", "config_source",
  "resolved_model", "resolved_effort", "effort_source", "efforts", "effort_range", "authorization",
]);
const ASYNC_DISPATCH_REQUIRED_FIELDS = Object.freeze([
  "contract_version", "producer_root", "origin_thread_id", "target_cwd", "task_file", "task_root",
]);
const ASYNC_CONTEXT_MODES = Object.freeze(["isolated", "project-aware"]);
const ASYNC_EXECUTION_PROFILES = Object.freeze(["standard", "simulation", "evidence_only_v1"]);
const ASYNC_RESULT_MODES = Object.freeze(["", "read_only_audit", "simulated_planning", "real_rerun"]);
const SIMULATION_FIELDS = Object.freeze(["role", "persona"]);
const DESCRIPTOR_MODEL_SELECTION_FIELDS = Object.freeze([
  "model", "effort", "model_source", "effort_source", "child_model",
]);
const DESCRIPTOR_CHILD_MODEL_FIELDS = Object.freeze(["status", "source"]);

// Path.relative_to：在根下返回相对分段数组，不在根下返回 null。
function _relativeUnder(root, target) {
  const relative = path.relative(root, target);
  if (!relative) return [];
  if (path.isAbsolute(relative) || relative.split(/[\\/]/)[0] === "..") return null;
  return relative.split(/[\\/]+/).filter(Boolean);
}

function _parentsOf(target) {
  const parents = [];
  let current = path.dirname(target);
  while (true) {
    parents.push(current);
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return parents;
}

// PurePath 排序：Windows 上按 normcase 后的整串比较。
function _comparePaths(left, right) {
  const a = pyNormcase(left);
  const b = pyNormcase(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function _isNone(value) {
  return value === null || value === undefined;
}

function _isPlainObject(value) {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function _typeName(value) {
  if (value === undefined) return "undefined";
  const type = typeof value;
  if (type !== "object") return type;
  return value?.constructor?.name || "object";
}

function _validateOptionalString(value, label) {
  if (!_isNone(value) && typeof value !== "string") {
    throw new PreparedDispatchError(`${label} must be a string or null`);
  }
}

function _validateAsyncNestedObject(value, label, fields) {
  if (_isNone(value)) return null;
  if (!isRecord(value)) throw new PreparedDispatchError(`dispatch envelope.${label} must be an object or null`);
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length) {
    throw new PreparedDispatchError(
      `dispatch envelope.${label} has unknown fields: ${unknown.map(String).sort().join(", ")}`,
    );
  }
  return value;
}

/** 材料可提交前校验包级复核元数据。 */
function _reviewEvidenceContract(pkg) {
  if (!isRecord(pkg)) return [false, null];
  let value = pkg;
  const nested = value.task_package;
  if (isRecord(nested)) value = nested;
  const extensions = value.extensions;
  if (_isNone(extensions)) return [false, null];
  if (!isRecord(extensions)) throw new PreparedDispatchError("task package extensions must be an object");

  const executionPresent = Object.hasOwn(extensions, "review_execution");
  const evidencePresent = Object.hasOwn(extensions, "review_evidence");
  const reviewExecution = extensions.review_execution;
  const reviewEvidence = extensions.review_evidence;
  if (executionPresent && !isRecord(reviewExecution)) {
    throw new PreparedDispatchError("package review_execution must be an object");
  }
  if (evidencePresent && !isRecord(reviewEvidence)) {
    throw new PreparedDispatchError("package review_evidence must be an object");
  }

  const executionProfile = isRecord(reviewExecution) ? reviewExecution.profile : null;
  const evidenceProfile = isRecord(reviewEvidence) ? reviewEvidence.profile : null;
  for (const [present, profile, label] of [
    [executionPresent, executionProfile, "review_execution.profile"],
    [evidencePresent, evidenceProfile, "review_evidence.profile"],
  ]) {
    if (present && (typeof profile !== "string" || !profile.trim())) {
      throw new PreparedDispatchError(`package ${label} must be a non-empty string`);
    }
  }
  if (executionProfile && evidenceProfile && executionProfile !== evidenceProfile) {
    throw new PreparedDispatchError("package review execution/evidence profiles do not match");
  }

  const evidenceOnly = executionProfile === "evidence_only_v1" || evidenceProfile === "evidence_only_v1";
  if (evidenceOnly) {
    if (!isRecord(reviewExecution) || !isRecord(reviewEvidence)) {
      throw new PreparedDispatchError("evidence-only package requires execution and evidence metadata");
    }
    if (executionProfile !== "evidence_only_v1" || evidenceProfile !== "evidence_only_v1") {
      throw new PreparedDispatchError("evidence-only package profiles must both be evidence_only_v1");
    }
    if (reviewEvidence.complete !== true) {
      throw new PreparedDispatchError("evidence-only package requires complete review evidence");
    }
  }

  if (isRecord(reviewEvidence)) {
    const target = reviewEvidence.path;
    const complete = reviewEvidence.complete;
    if (typeof target !== "string" || !target.trim()) {
      throw new PreparedDispatchError("package review_evidence.path must be a non-empty string");
    }
    if (typeof complete !== "boolean") {
      throw new PreparedDispatchError("package review_evidence.complete must be a boolean");
    }
  }
  return [evidenceOnly, isRecord(reviewEvidence) ? reviewEvidence : null];
}

/** 校验 compile 与磁盘接收共用的 v2 合同；返回浅拷贝，无效回退停用并输出诊断。 */
export function validateAsyncDispatchV2(envelope, { package: pkg = null } = {}) {
  if (!isRecord(envelope)) throw new PreparedDispatchError("dispatch envelope must be an object");
  const unknown = Object.keys(envelope).filter((key) => !ASYNC_DISPATCH_V2_FIELDS.includes(key));
  if (unknown.length) {
    throw new PreparedDispatchError(
      `dispatch envelope has unknown fields: ${unknown.map(String).sort().join(", ")}`,
    );
  }
  const missing = ASYNC_DISPATCH_REQUIRED_FIELDS.filter((key) => !Object.hasOwn(envelope, key));
  if (missing.length) {
    throw new PreparedDispatchError(
      `dispatch envelope is missing required fields: ${[...missing].sort().join(", ")}`,
    );
  }

  for (const key of ["contract_version", "producer_root", "target_cwd", "task_file", "task_root"]) {
    const value = envelope[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new PreparedDispatchError(`dispatch envelope.${key} must be a non-empty string`);
    }
  }
  if (envelope.contract_version !== DISPATCH_CONTRACT_VERSION) {
    throw new PreparedDispatchError("dispatch envelope contract must be async-dispatch/v2");
  }
  if (typeof envelope.origin_thread_id !== "string") {
    throw new PreparedDispatchError("dispatch envelope.origin_thread_id must be a string");
  }

  for (const key of ["runner_path", "model", "effort", "result_mode", "display_title"]) {
    if (Object.hasOwn(envelope, key)) _validateOptionalString(envelope[key], `dispatch envelope.${key}`);
  }
  if (Object.hasOwn(envelope, "selection") && !_isNone(envelope.selection)) {
    if (!isRecord(envelope.selection)) throw new PreparedDispatchError("dispatch envelope.selection must be an object or null");
    const unknownSelection = Object.keys(envelope.selection).filter((key) => !SELECTION_FIELDS.includes(key));
    if (unknownSelection.length) {
      throw new PreparedDispatchError(`dispatch envelope.selection has unknown fields: ${unknownSelection.sort().join(", ")}`);
    }
    const missingSelection = SELECTION_FIELDS.filter((key) => !Object.hasOwn(envelope.selection, key));
    if (missingSelection.length) {
      throw new PreparedDispatchError(`dispatch envelope.selection is missing fields: ${missingSelection.sort().join(", ")}`);
    }
  }
  envelope = { ...envelope };
  if (Object.hasOwn(envelope, "runtime_role") && typeof envelope.runtime_role !== "string") {
    throw new PreparedDispatchError("dispatch envelope.runtime_role must be a string");
  }
  for (const key of ["batch_id", "slice_id"]) {
    if (Object.hasOwn(envelope, key)) _validateOptionalString(envelope[key], `dispatch envelope.${key}`);
  }
  if (!Object.hasOwn(envelope, "context_mode") || typeof envelope.context_mode !== "string"
    || !envelope.context_mode.trim()) {
    throw new PreparedDispatchError("dispatch envelope.context_mode must be a non-empty string");
  }
  if (!ASYNC_CONTEXT_MODES.includes(envelope.context_mode)) {
    throw new PreparedDispatchError("dispatch envelope.context_mode is not supported");
  }
  if (!Object.hasOwn(envelope, "execution_profile") || typeof envelope.execution_profile !== "string"
    || !envelope.execution_profile.trim()) {
    throw new PreparedDispatchError("dispatch envelope.execution_profile must be a non-empty string");
  }
  if (!ASYNC_EXECUTION_PROFILES.includes(envelope.execution_profile)) {
    throw new PreparedDispatchError("dispatch envelope.execution_profile is not supported");
  }
  if (Object.hasOwn(envelope, "result_mode")
    && !(_isNone(envelope.result_mode) || ASYNC_RESULT_MODES.includes(envelope.result_mode))) {
    throw new PreparedDispatchError("dispatch envelope.result_mode is not supported");
  }
  const simulation = _validateAsyncNestedObject(envelope.simulation, "simulation", SIMULATION_FIELDS);
  if (simulation !== null) {
    if (Object.hasOwn(simulation, "role") && typeof simulation.role !== "string") {
      throw new PreparedDispatchError("dispatch envelope.simulation.role must be a string");
    }
    if (Object.hasOwn(simulation, "persona") && !isRecord(simulation.persona)) {
      throw new PreparedDispatchError("dispatch envelope.simulation.persona must be an object");
    }
  }
  if (!Object.hasOwn(envelope, "budget") || !isRecord(envelope.budget)) {
    throw new PreparedDispatchError("dispatch envelope.budget must be an object");
  }
  if (Object.hasOwn(envelope, "save_raw_evidence") && typeof envelope.save_raw_evidence !== "boolean") {
    throw new PreparedDispatchError("dispatch envelope.save_raw_evidence must be a boolean");
  }
  if (Object.hasOwn(envelope, "turn_timeout_ms")) {
    const timeout = envelope.turn_timeout_ms;
    if (typeof timeout === "boolean" || !Number.isInteger(timeout) || timeout < 0) {
      throw new PreparedDispatchError("dispatch envelope.turn_timeout_ms must be a non-negative integer");
    }
  }
  if (Object.hasOwn(envelope, "stall_silence_ms") && !_isNone(envelope.stall_silence_ms)) {
    const silence = envelope.stall_silence_ms;
    if (typeof silence === "boolean" || !Number.isInteger(silence) || silence < 0) {
      throw new PreparedDispatchError(
        "dispatch envelope.stall_silence_ms must be a non-negative integer (0 disables stall detection)",
      );
    }
  }

  const producerRoot = absolutePath(envelope.producer_root, "dispatch producer_root", { error: PreparedDispatchError });
  const targetCwd = absolutePath(envelope.target_cwd, "dispatch target_cwd", { error: PreparedDispatchError });
  const taskRoot = absolutePath(envelope.task_root, "dispatch task_root", { error: PreparedDispatchError });
  if (!_isDirectory(targetCwd)) throw new PreparedDispatchError(`dispatch target_cwd does not exist: ${targetCwd}`);
  const runtimeRoot = path.resolve(path.join(producerRoot, ".runtime"));
  if (_relativeUnder(runtimeRoot, taskRoot) === null) {
    throw new PreparedDispatchError("dispatch task_root must stay inside producer_root/.runtime");
  }

  const targetDomain = pyNormcase(resolveLikePython(targetCwd));
  const producerDomain = pyNormcase(resolveLikePython(producerRoot));
  const resultMode = envelope.result_mode || "";
  if (targetDomain !== producerDomain && !resultMode) {
    throw new PreparedDispatchError("cross-repo dispatch requires result_mode");
  }
  if (envelope.execution_profile === "simulation") {
    if (resultMode !== "simulated_planning" || !isRecord(simulation)) {
      throw new PreparedDispatchError(
        "simulation dispatch requires result_mode=simulated_planning and structured role/persona",
      );
    }
    const role = simulation.role;
    const persona = simulation.persona;
    if (typeof role !== "string" || !role.trim() || !isRecord(persona) || !Object.keys(persona).length) {
      throw new PreparedDispatchError(
        "simulation dispatch requires result_mode=simulated_planning and structured role/persona",
      );
    }
  }
  if (envelope.execution_profile !== "simulation" && resultMode === "simulated_planning") {
    throw new PreparedDispatchError("result_mode=simulated_planning requires execution_profile=simulation");
  }

  const [packageEvidenceOnly] = _reviewEvidenceContract(pkg);
  const envelopeEvidenceOnly = envelope.execution_profile === "evidence_only_v1";
  if (packageEvidenceOnly && (!envelopeEvidenceOnly || envelope.context_mode !== "isolated")) {
    throw new PreparedDispatchError("evidence-only package requires evidence_only_v1/isolated dispatch");
  }
  if (envelopeEvidenceOnly && !packageEvidenceOnly) {
    throw new PreparedDispatchError("evidence_only_v1 dispatch requires an evidence-only package");
  }
  return { ...envelope };
}

function _isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// json.dumps(ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) 的复刻。
// 已知差异：Python 的 float 1.0 序列化为 "1.0"，JS 只有一种数字类型，写出 "1"；
// 非可序列化对象的类型名按 JS 构造器名给出，不还原 Python 类型名。
function _canonicalJsonText(value, seen) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PreparedDispatchError(
        "value is not canonical JSON: Out of range float values are not JSON compliant",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new PreparedDispatchError("value is not canonical JSON: Circular reference detected");
    seen.add(value);
    const text = `[${value.map((item) => _canonicalJsonText(item, seen)).join(",")}]`;
    seen.delete(value);
    return text;
  }
  if (_isPlainObject(value)) {
    if (seen.has(value)) throw new PreparedDispatchError("value is not canonical JSON: Circular reference detected");
    seen.add(value);
    const keys = Object.keys(value).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const text = `{${keys.map((key) => `${JSON.stringify(key)}:${_canonicalJsonText(value[key], seen)}`).join(",")}}`;
    seen.delete(value);
    return text;
  }
  throw new PreparedDispatchError(
    `value is not canonical JSON: Object of type ${_typeName(value)} is not JSON serializable`,
  );
}

/** 所有材料文件唯一的规范 JSON 表示。 */
export function canonicalJsonBytes(value) {
  return Buffer.from(`${_canonicalJsonText(value, new Set())}\n`, "utf8");
}

/** 检查规范包含关系并拒绝 symlink/reparse 分量。 */
function _assertNoEscape(target, root, { allowMissingLeaf = false } = {}) {
  const controlledRoot = absolutePath(root, "controlled root", { error: PreparedDispatchError });
  const candidate = absolutePath(target, "path", { error: PreparedDispatchError });
  const rootReal = resolveLikePython(controlledRoot);
  const pathReal = resolveLikePython(candidate);
  assertNoReparseComponents(controlledRoot, { allowMissing: allowMissingLeaf, error: PreparedDispatchError });
  assertNoReparseComponents(candidate, { allowMissing: allowMissingLeaf, error: PreparedDispatchError });
  if (_relativeUnder(rootReal, pathReal) === null) {
    throw new PreparedDispatchError(`path escapes controlled root: ${candidate}`);
  }

  // 从根往候选路径逐层走已存在的分量：既拦截指回根内的符号链接，也拦截指向根外的逃逸。
  let rootInfo = null;
  try {
    rootInfo = lstatSync(controlledRoot);
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw new PreparedDispatchError(`cannot inspect controlled root: ${controlledRoot}`);
  }
  if (rootInfo && (rootInfo.isSymbolicLink() || isReparseStat(rootInfo))) {
    throw new PreparedDispatchError(`symlink/reparse controlled root: ${controlledRoot}`);
  }
  const parts = _relativeUnder(controlledRoot, candidate);
  if (parts === null) throw new PreparedDispatchError(`path is not under controlled root: ${candidate}`);
  let current = controlledRoot;
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (caught) {
      if (caught?.code === "ENOENT") {
        // 缺失的祖先只对分配/创建路径的调用方合法。
        if (allowMissingLeaf) break;
        throw new PreparedDispatchError(`path component does not exist: ${current}`);
      }
      throw new PreparedDispatchError(`cannot inspect path component ${current}: ${caught.message}`);
    }
    if (info.isSymbolicLink() || isReparseStat(info)) {
      throw new PreparedDispatchError(`symlink/reparse path is not permitted: ${current}`);
    }
  }
  return pathReal;
}

function _controlledParent(producerRoot) {
  const producer = absolutePath(producerRoot, "producer_root", { error: PreparedDispatchError });
  ensureControlledDirectory(producer, { error: PreparedDispatchError });
  _assertNoEscape(producer, producer, { allowMissingLeaf: false });
  const parent = path.join(producer, "tmp", "dispatch_prepare", PREPARATION_DIRECTORY_NAME);
  ensureControlledDirectory(parent, { error: PreparedDispatchError });
  _assertNoEscape(parent, producer, { allowMissingLeaf: false });
  return parent;
}

// Python 用 uuid.uuid4().hex，位布局天然带 RFC 4122 版本与变体位；_tool_common 的 ids.uuidHex()
// 给的是 sha256 截断值，不带这两处位，直接用会让本模块自己的 prep-<uuid4hex> 校验永远不通过。
// 这里只在同一个取值入口之上补齐版本半字节与变体位，冻结后依旧确定。
function _preparationHex() {
  const raw = ids.uuidHex().split("");
  raw[12] = "4";
  raw[16] = "89ab"[Number.parseInt(raw[16], 16) & 0x3];
  return raw.join("");
}

/** 在 producer 根下独占分配 ``prep-<uuid4hex>``。 */
export function allocatePreparationRoot(producerRoot, { retries = PREPARATION_ALLOCATION_RETRIES } = {}) {
  if (retries <= 0) throw new PreparedDispatchError("preparation allocation retries must be positive");
  const producer = absolutePath(producerRoot, "producer_root", { error: PreparedDispatchError });
  const parent = _controlledParent(producer);
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const preparation = path.join(parent, `${PREPARATION_PREFIX}${_preparationHex()}`);
    try {
      mkdirSync(preparation, { mode: 0o700 });
    } catch (caught) {
      if (caught?.code === "EEXIST") continue;
      throw caught;
    }
    _assertNoEscape(preparation, producer, { allowMissingLeaf: false });
    OWNED_UNCOMMITTED_ROOTS.add(pyNormcase(preparation));
    return preparation;
  }
  throw new PreparedDispatchError(`could not allocate an exclusive preparation root after ${retries} attempts`);
}

// 落盘注入点：Python 侧测试用 monkeypatch 换掉 os.replace 注入分阶段写失败；ESM 具名导入不可替换，
// 因此把唯一的落盘动作收进这个可替换对象，语义与 atomic_write_bytes 相同。
export const _writeAdapter = {
  write(target, data) {
    atomicWriteBytes(target, data, { error: PreparedDispatchError });
  },
};

export function _atomicWrite(target, data) {
  _writeAdapter.write(target, data);
}

function _packageId(pkg) {
  const value = Object.hasOwn(pkg, "task_package") ? pkg.task_package : pkg;
  if (!isRecord(value)) throw new PreparedDispatchError("task_package must be an object");
  const packageId = value.package_id;
  if (typeof packageId !== "string" || !packageId || packageId !== packageId.trim()) {
    throw new PreparedDispatchError(
      "task_package.package_id must be a non-empty string without leading/trailing whitespace",
    );
  }
  return packageId;
}

const RUNTIME_VALUE_ALIASES = Object.freeze({
  target_cwd: "targetCwd",
  task_root: "taskRoot",
  runner_path: "runnerPath",
  runtime_role: "runtimeRole",
  context_mode: "contextMode",
  execution_profile: "executionProfile",
  result_mode: "resultMode",
});

function _runtimeValue(options, key, defaultValue = null) {
  if (Object.hasOwn(options, key)) return options[key];
  const alias = Object.hasOwn(RUNTIME_VALUE_ALIASES, key) ? RUNTIME_VALUE_ALIASES[key] : "";
  return Object.hasOwn(options, alias) ? options[alias] : defaultValue;
}

function _makeEnvelope({ producerRoot, targetCwd, taskRoot, originId, options }) {
  const rawSelection = _runtimeValue(options, "model_selection", {});
  const modelSelection = isRecord(rawSelection) ? rawSelection : {};
  const text = (value) => (value ? String(value) : "");
  return {
    contract_version: DISPATCH_CONTRACT_VERSION,
    producer_root: String(producerRoot),
    origin_thread_id: String(originId),
    target_cwd: String(targetCwd),
    task_file: "",
    task_root: String(taskRoot),
    runner_path: _runtimeValue(options, "runner_path") || null,
    runtime_role: text(_runtimeValue(options, "runtime_role", "")),
    model: text(_runtimeValue(options, "model", modelSelection.primary_model ?? "")) || null,
    effort: text(_runtimeValue(options, "effort", modelSelection.primary_effort ?? "")) || null,
    ...(isRecord(modelSelection.selection) ? { selection: modelSelection.selection } : {}),
    context_mode: text(_runtimeValue(options, "context_mode", "project-aware")) || "project-aware",
    execution_profile: text(_runtimeValue(options, "execution_profile", "standard")) || "standard",
    result_mode: text(_runtimeValue(options, "result_mode", "")) || null,
    simulation: (_runtimeValue(options, "simulation_profile") || _runtimeValue(options, "simulation")) ?? null,
    budget: _runtimeValue(options, "budget", {}),
    batch_id: _runtimeValue(options, "batch_id") || null,
    slice_id: _runtimeValue(options, "slice_id") || null,
    display_title: text(_runtimeValue(options, "display_title", "")),
  };
}

// Python 用 inspect.signature 判断回调是否接受第二个位置参数；JS 用 Function.length 表达同一意图。
// 已知差异：带默认值或 rest 参数的 JS 回调 length 偏小，会按单参调用；回调需要包时请显式声明两个形参。
function _invokeBuilder(builder, materialRoot, pkg) {
  if (typeof builder !== "function") return builder(materialRoot, pkg);
  return builder.length >= 2 ? builder(materialRoot, pkg) : builder(materialRoot);
}

function _pathsWrittenByCallback(materialRoot, callbackResult) {
  const paths = [];
  if (isRecord(callbackResult)) {
    const raw = callbackResult.writes_performed;
    if (Array.isArray(raw)) {
      for (const value of raw) if (typeof value === "string") paths.push(value);
    }
  } else if (Array.isArray(callbackResult) || callbackResult instanceof Set) {
    for (const value of callbackResult) if (typeof value === "string") paths.push(value);
  }
  const normalized = [];
  for (const value of paths) {
    const candidate = absolutePath(
      path.isAbsolute(value) ? value : path.join(materialRoot, value),
      "callback output",
      { error: PreparedDispatchError },
    );
    _assertNoEscape(candidate, materialRoot, { allowMissingLeaf: false });
    const relative = path.relative(materialRoot, candidate).replace(/\\/g, "/") || ".";
    if (RESERVED_FILENAMES.includes(relative)) {
      throw new PreparedDispatchError(`callback cannot claim reserved material file: ${relative}`);
    }
    if (!normalized.includes(relative)) normalized.push(relative);
  }
  return normalized;
}

/** 遍历暂存树，不跟随 symlink/reparse 目录。 */
function _iterWorkspaceFiles(materialRoot) {
  const files = [];

  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch (caught) {
      throw new PreparedDispatchError(`cannot inspect preparation output ${directory}: ${caught.message}`);
    }
    for (const name of entries) {
      const target = path.join(directory, name);
      let info;
      try {
        info = lstatSync(target);
      } catch (caught) {
        throw new PreparedDispatchError(`cannot inspect preparation output ${target}: ${caught.message}`);
      }
      if (info.isSymbolicLink() || isReparseStat(info)) {
        throw new PreparedDispatchError(`symlink/reparse preparation output: ${target}`);
      }
      if (info.isDirectory()) visit(target);
      else if (info.isFile()) files.push(target);
      else throw new PreparedDispatchError(`unsupported preparation output type: ${target}`);
    }
  };

  assertNoReparseComponents(materialRoot, { allowMissing: false, error: PreparedDispatchError });
  visit(materialRoot);
  return files;
}

function _assertReservedFilesAbsent(materialRoot, { allowed = [] } = {}) {
  for (const filename of RESERVED_FILENAMES) {
    if (allowed.includes(filename)) continue;
    const target = path.join(materialRoot, filename);
    try {
      lstatSync(target);
    } catch (caught) {
      if (caught?.code === "ENOENT") continue;
      throw new PreparedDispatchError(`cannot inspect reserved material path ${target}: ${caught.message}`);
    }
    throw new PreparedDispatchError(`callback created reserved material path: ${filename}`);
  }
}

function _collectWorkspaceOutputs(materialRoot) {
  const outputs = [];
  for (const target of _iterWorkspaceFiles(materialRoot).sort(_comparePaths)) {
    if (RESERVED_FILENAMES.includes(path.basename(target))
      && pyNormcase(path.dirname(target)) === pyNormcase(materialRoot)) {
      continue;
    }
    outputs.push(path.relative(materialRoot, target).replace(/\\/g, "/"));
  }
  return outputs;
}

// Python 的 `a or b`：空字典是假值。
function _truthyMapping(candidate) {
  return isRecord(candidate) && Object.keys(candidate).length ? candidate : null;
}

function _firstMapping(...candidates) {
  for (const candidate of candidates) {
    const mapping = _truthyMapping(candidate);
    if (mapping !== null) return mapping;
  }
  return {};
}

// PurePath 语义的相对路径：只归一分隔符与 "." 分段，保留 ".."；不在根下返回 null（Python 抛 ValueError）。
function _pureRelative(root, value) {
  const parts = (text) => String(text).replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  const text = String(value);
  if (!path.isAbsolute(text)) return parts(text).join("/") || ".";
  const target = parts(text);
  const base = parts(root);
  if (!base.every((part, index) => pyNormcase(part) === pyNormcase(target[index] ?? ""))) return null;
  return target.slice(base.length).join("/") || ".";
}

/**
 * 把一个 package 编译成独占且已提交的暂存工作区。
 * 描述符是最后一次写入，因此它就是提交标记；在它之前的任何异常只移除本次调用分配的根。
 */
export function compilePreparedDispatch(pkg, options = {}) {
  const {
    producerRoot,
    resolvedRuntimeOptions = null,
    runtimeOptions = null,
    runtime = null,
    dispatchEnvelope = null,
    envelope: envelopeOption = null,
    taskMaterial: taskMaterialOption = null,
    taskMaterialBuilder = null,
    reviewEvidenceBuilder = null,
    postMaterialCallback = null,
    originId = null,
    batchId = null,
    sliceId = null,
    displayTitle = "",
  } = options;
  let taskMaterial = taskMaterialOption;
  if (!isRecord(pkg)) throw new PreparedDispatchError("package must be a dictionary");
  if (_isNone(originId) || typeof originId !== "string") {
    throw new PreparedDispatchError("origin_id must be explicitly supplied as a string");
  }
  const logicalPackageId = _packageId(pkg);
  const producer = absolutePath(producerRoot, "producer_root", { error: PreparedDispatchError });
  let runtimeOpts = { ..._firstMapping(resolvedRuntimeOptions, runtimeOptions, runtime) };
  if (!_isNone(options.targetCwd)) runtimeOpts.target_cwd = options.targetCwd;
  if (!_isNone(options.taskRoot)) runtimeOpts.task_root = options.taskRoot;
  let effectiveEnvelope = _truthyMapping(dispatchEnvelope) ?? _truthyMapping(envelopeOption) ?? null;
  let targetValue = _runtimeValue(runtimeOpts, "target_cwd");
  let taskRootValue = _runtimeValue(runtimeOpts, "task_root");
  if (_isNone(targetValue) && effectiveEnvelope !== null) targetValue = effectiveEnvelope.target_cwd ?? null;
  if (_isNone(taskRootValue) && effectiveEnvelope !== null) taskRootValue = effectiveEnvelope.task_root ?? null;
  if (!targetValue || !taskRootValue) {
    throw new PreparedDispatchError("target_cwd and task_root are required explicit runtime options");
  }
  let targetCwd = absolutePath(targetValue, "target_cwd", { error: PreparedDispatchError });
  let taskRoot = absolutePath(taskRootValue, "task_root", { error: PreparedDispatchError });
  if (!_isDirectory(targetCwd)) throw new PreparedDispatchError(`target_cwd does not exist: ${targetCwd}`);
  _assertTaskRootInsideRuntime(taskRoot, producer);

  const effectiveOriginId = originId;
  let effectiveBatchId = !_isNone(batchId)
    ? batchId
    : (effectiveEnvelope !== null ? effectiveEnvelope.batch_id ?? null : null);
  let effectiveSliceId = !_isNone(sliceId)
    ? sliceId
    : (effectiveEnvelope !== null ? effectiveEnvelope.slice_id ?? null : null);
  let effectiveDisplayTitle = displayTitle
    ? displayTitle
    : String((effectiveEnvelope !== null ? effectiveEnvelope.display_title : null) || "");
  if (!_isNone(effectiveBatchId) && typeof effectiveBatchId !== "string") {
    throw new PreparedDispatchError("batch_id must be a string or null");
  }
  if (!_isNone(effectiveSliceId) && typeof effectiveSliceId !== "string") {
    throw new PreparedDispatchError("slice_id must be a string or null");
  }

  const materialRoot = allocatePreparationRoot(producer);
  let committed = false;
  let descriptorWriteStarted = false;
  try {
    _assertReservedFilesAbsent(materialRoot);
    let callbackResult = null;
    if (!_isNone(reviewEvidenceBuilder)) {
      callbackResult = _invokeBuilder(reviewEvidenceBuilder, materialRoot, pkg);
    }
    _assertReservedFilesAbsent(materialRoot);

    // 调用方可能要等证据改动过 package 之后才敲定运行时/权限/执行选项。这个回调刻意保持通用：
    // 它返回可选的 runtime_options 与/或 envelope，纯编译器不引入任何投递策略。
    if (!_isNone(postMaterialCallback)) {
      const postResult = _invokeBuilder(postMaterialCallback, materialRoot, pkg);
      if (isRecord(postResult)) {
        let finalOptions = postResult.runtime_options;
        if (_isNone(finalOptions)) finalOptions = postResult.resolved_runtime_options;
        if (isRecord(finalOptions)) runtimeOpts = { ...finalOptions };
        let finalEnvelope = postResult.envelope;
        if (_isNone(finalEnvelope)) finalEnvelope = postResult.dispatch_envelope;
        if (isRecord(finalEnvelope)) effectiveEnvelope = structuredClone({ ...finalEnvelope });
      }
    }
    _assertReservedFilesAbsent(materialRoot);
    if (_isNone(batchId) && effectiveEnvelope !== null) effectiveBatchId = effectiveEnvelope.batch_id ?? null;
    if (_isNone(sliceId) && effectiveEnvelope !== null) effectiveSliceId = effectiveEnvelope.slice_id ?? null;
    if (!displayTitle && effectiveEnvelope !== null) {
      effectiveDisplayTitle = String(effectiveEnvelope.display_title || "");
    }

    // 回调之后重新读取目标与任务路径：这是信封与描述符使用的最终路径绑定，早于 package/task 字节渲染。
    let finalTargetValue = _runtimeValue(runtimeOpts, "target_cwd");
    let finalTaskRootValue = _runtimeValue(runtimeOpts, "task_root");
    if (_isNone(finalTargetValue) && effectiveEnvelope !== null) {
      finalTargetValue = effectiveEnvelope.target_cwd ?? null;
    }
    if (_isNone(finalTaskRootValue) && effectiveEnvelope !== null) {
      finalTaskRootValue = effectiveEnvelope.task_root ?? null;
    }
    if (!finalTargetValue || !finalTaskRootValue) {
      throw new PreparedDispatchError("post-material callback did not provide target_cwd and task_root");
    }
    targetCwd = absolutePath(finalTargetValue, "target_cwd", { error: PreparedDispatchError });
    taskRoot = absolutePath(finalTaskRootValue, "task_root", { error: PreparedDispatchError });
    if (!_isDirectory(targetCwd)) throw new PreparedDispatchError(`target_cwd does not exist: ${targetCwd}`);
    _assertTaskRootInsideRuntime(taskRoot, producer);

    const finalPackageId = _packageId(pkg);
    if (finalPackageId !== logicalPackageId) {
      throw new PreparedDispatchError("task_package.package_id changed during preparation");
    }

    const packageFile = path.join(materialRoot, PACKAGE_FILENAME);
    const taskFile = path.join(materialRoot, TASK_FILENAME);
    const dispatchFile = path.join(materialRoot, DISPATCH_FILENAME);
    const descriptorFile = path.join(materialRoot, DESCRIPTOR_FILENAME);

    const packageBytes = canonicalJsonBytes(pkg);
    const frozenPackage = JSON.parse(packageBytes.toString("utf8"));
    _reviewEvidenceContract(frozenPackage);
    _atomicWrite(packageFile, packageBytes);

    if (!_isNone(taskMaterialBuilder)) {
      const builtTask = _invokeBuilder(taskMaterialBuilder, packageFile, structuredClone(frozenPackage));
      if (typeof builtTask !== "string" && !Buffer.isBuffer(builtTask)) {
        throw new PreparedDispatchError("task material builder must return str or bytes");
      }
      taskMaterial = builtTask;
    }
    if (!canonicalJsonBytes(pkg).equals(packageBytes)) {
      throw new PreparedDispatchError("task material builder mutated the prepared package");
    }
    if (!_readFile(packageFile, "package").equals(packageBytes)) {
      throw new PreparedDispatchError("task material builder changed the persisted package");
    }
    _assertReservedFilesAbsent(materialRoot, { allowed: [PACKAGE_FILENAME] });
    if (_isNone(taskMaterial)) {
      const packageText = packageBytes.toString("utf8");
      taskMaterial = `# Prepared task material\n\n\`\`\`json\n${packageText}\`\`\`\n`;
    }
    if (typeof taskMaterial !== "string" && !Buffer.isBuffer(taskMaterial)) {
      throw new PreparedDispatchError("task material builder must return str or bytes");
    }
    const taskBytes = Buffer.isBuffer(taskMaterial) ? taskMaterial : Buffer.from(taskMaterial, "utf8");
    _atomicWrite(taskFile, taskBytes);

    let envelope;
    if (effectiveEnvelope === null) {
      envelope = _makeEnvelope({
        producerRoot: producer,
        targetCwd,
        taskRoot,
        originId: effectiveOriginId,
        options: runtimeOpts,
      });
    } else {
      envelope = structuredClone({ ...effectiveEnvelope });
      envelope.contract_version = String(envelope.contract_version || DISPATCH_CONTRACT_VERSION);
      envelope.producer_root = String(producer);
      envelope.target_cwd = String(targetCwd);
      envelope.task_root = String(taskRoot);
      envelope.origin_thread_id = effectiveOriginId;
    }
    for (const [key, value] of [
      ["runner_path", null], ["runtime_role", ""], ["model", null], ["effort", null],
      ["context_mode", "project-aware"],
      ["execution_profile", "standard"], ["result_mode", null], ["simulation", null], ["budget", {}],
      ["batch_id", null], ["slice_id", null], ["display_title", ""],
    ]) {
      if (!Object.hasOwn(envelope, key)) envelope[key] = value;
    }
    envelope.task_file = String(taskFile);
    if (!_isNone(effectiveBatchId)) envelope.batch_id = effectiveBatchId || null;
    if (!_isNone(effectiveSliceId)) envelope.slice_id = effectiveSliceId || null;
    if (effectiveDisplayTitle) envelope.display_title = effectiveDisplayTitle;
    if (envelope.contract_version !== DISPATCH_CONTRACT_VERSION) {
      throw new PreparedDispatchError("prepared dispatch must use async-dispatch/v2");
    }
    envelope = validateAsyncDispatchV2(envelope, { package: frozenPackage });
    const dispatchBytes = canonicalJsonBytes(envelope);
    _atomicWrite(dispatchFile, dispatchBytes);

    const descriptor = {
      contract_version: DESCRIPTOR_CONTRACT_VERSION,
      state: "prepared",
      preparation_id: path.basename(materialRoot),
      dispatch_contract_version: DISPATCH_CONTRACT_VERSION,
      producer_root: String(producer),
      material_root: String(materialRoot),
      package_id: logicalPackageId,
      package_file: String(packageFile),
      task_file: String(taskFile),
      dispatch_file: String(dispatchFile),
      descriptor_file: String(descriptorFile),
      target_cwd: String(targetCwd),
      task_root: String(taskRoot),
      origin_id: effectiveOriginId,
      batch_id: effectiveBatchId || null,
      slice_id: effectiveSliceId || null,
      writes_performed: [],
    };
    const selection = isRecord(runtimeOpts.model_selection) ? runtimeOpts.model_selection : null;
    if (selection !== null) {
      descriptor.model_selection = {
        model: envelope.model ?? null,
        effort: envelope.effort ?? null,
        model_source: String(selection.model_source || ""),
        effort_source: String(selection.effort_source || ""),
        child_model: structuredClone(selection.child_model || {}),
      };
    }
    const callbackPaths = _pathsWrittenByCallback(materialRoot, callbackResult);
    for (const target of _collectWorkspaceOutputs(materialRoot)) {
      if (!callbackPaths.includes(target)) callbackPaths.push(target);
    }
    descriptor.writes_performed = callbackPaths;
    _validatePackageEvidencePath(frozenPackage, {
      producerRoot: producer,
      materialRoot,
      preparedOutputs: callbackPaths,
    });
    descriptorWriteStarted = true;
    _atomicWrite(descriptorFile, canonicalJsonBytes(descriptor));
    committed = true;
    OWNED_UNCOMMITTED_ROOTS.delete(pyNormcase(materialRoot));
    return descriptor;
  } catch (caught) {
    if (!committed) {
      try {
        if (!descriptorWriteStarted) _discardUntrustedDescriptorMarker(materialRoot);
        cleanupUncommittedPreparation(materialRoot, { producerRoot: producer });
      } catch {
        // 清理失败绝不能替换掉编译器本身的错误；所有权闸门失败时把根留下来供人工检查。
      }
    }
    throw caught;
  }
}

// compile 里的 `except ValueError` 同时吞掉 relative_to 与守门错误（PreparedDispatchError 是 ValueError 子类）。
function _assertTaskRootInsideRuntime(taskRoot, producer) {
  const runtimeRoot = path.join(producer, ".runtime");
  try {
    if (_relativeUnder(resolveLikePython(runtimeRoot), taskRoot) === null) {
      throw new PreparedDispatchError("task_root is not relative to producer_root/.runtime");
    }
    _assertNoEscape(taskRoot, runtimeRoot, { allowMissingLeaf: true });
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) {
      throw new PreparedDispatchError("task_root must stay inside producer_root/.runtime");
    }
    throw caught;
  }
}

function _readFile(target, label) {
  const file = absolutePath(target, label, { error: PreparedDispatchError });
  assertRegularFile(file, label, { error: PreparedDispatchError });
  let fd = null;
  try {
    fd = openSync(file, "r");
    const info = fstatSync(fd);
    if (!info.isFile()) throw new PreparedDispatchError(`${label} is not a regular file: ${file}`);
    return readFileSync(fd);
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) throw caught;
    throw new PreparedDispatchError(`cannot read ${label}: ${file}`);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不改变读结果。
      }
    }
  }
}

function _descriptorPath(value, label) {
  let target;
  if (typeof value === "string" && value.trim()) target = value;
  else throw new PreparedDispatchError(`descriptor.${label} must be a non-empty absolute path`);
  if (!path.isAbsolute(target)) {
    throw new PreparedDispatchError(`descriptor.${label} must be a non-empty absolute path`);
  }
  // 保留词法上的 symlink 分量以便 lstat 拒绝；规范包含关系由 _assertNoEscape 单独检查。
  return absolutePath(target, `descriptor.${label}`, { error: PreparedDispatchError });
}

function _pathEqual(left, right) {
  return pyNormcase(absolutePath(left, "path", { error: PreparedDispatchError }))
    === pyNormcase(absolutePath(right, "path", { error: PreparedDispatchError }));
}

/** 要求持久化的复核证据是已声明、归本次暂存所有的 JSON 文件。 */
function _validatePackageEvidencePath(pkg, { producerRoot, materialRoot, preparedOutputs }) {
  const [, evidenceRef] = _reviewEvidenceContract(pkg);
  if (evidenceRef === null) return;
  let evidencePath = String(evidenceRef.path);
  if (!path.isAbsolute(evidencePath)) evidencePath = path.join(producerRoot, evidencePath);
  evidencePath = absolutePath(evidencePath, "review evidence", { error: PreparedDispatchError });
  _assertNoEscape(evidencePath, materialRoot, { allowMissingLeaf: false });
  const evidenceRelative = path.relative(materialRoot, evidencePath).replace(/\\/g, "/");
  if (!preparedOutputs.includes(evidenceRelative)) {
    throw new PreparedDispatchError("package review_evidence is absent from prepared outputs");
  }
  const evidenceBytes = _readFile(evidencePath, "review evidence");
  let evidence;
  try {
    evidence = JSON.parse(evidenceBytes.toString("utf8"));
  } catch {
    throw new PreparedDispatchError(`review evidence is not valid UTF-8 JSON: ${evidencePath}`);
  }
  if (!isRecord(evidence)) throw new PreparedDispatchError("review evidence root must be a JSON object");
}

function _uuid4Hex(hexPart) {
  const cleaned = String(hexPart).replace(/urn:/g, "").replace(/uuid:/g, "").replace(/^[{]+|[}]+$/g, "")
    .replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(cleaned)) return false;
  const value = BigInt(`0x${cleaned}`);
  // uuid.UUID.variant / version：先看 RFC 4122 变体位，再取版本半字节。
  if (!(value & (0x8000n << 48n))) return false;
  if (value & (0x4000n << 48n)) return false;
  return Number((value >> 76n) & 0xfn) === 4;
}

function _validateDescriptorShape(descriptor) {
  if (!isRecord(descriptor)) throw new PreparedDispatchError("descriptor root must be an object");
  const requiredStrings = [
    "contract_version", "state", "preparation_id",
    "dispatch_contract_version", "producer_root", "material_root", "package_id",
    "package_file", "task_file", "dispatch_file", "descriptor_file", "target_cwd",
    "task_root", "origin_id",
  ];
  const missing = requiredStrings.filter((key) => !Object.hasOwn(descriptor, key));
  if (missing.length) {
    throw new PreparedDispatchError(`descriptor is missing required fields: ${missing.join(", ")}`);
  }
  for (const key of requiredStrings) {
    if (typeof descriptor[key] !== "string") throw new PreparedDispatchError(`descriptor.${key} must be a string`);
  }
  if (!descriptor.contract_version.trim() || !descriptor.state.trim()) {
    throw new PreparedDispatchError("descriptor contract_version and state must be non-empty");
  }
  if (!descriptor.package_id || descriptor.package_id !== descriptor.package_id.trim()) {
    throw new PreparedDispatchError(
      "descriptor.package_id must be a non-empty string without leading/trailing whitespace",
    );
  }
  const preparationId = descriptor.preparation_id;
  if (!preparationId.startsWith(PREPARATION_PREFIX)) {
    throw new PreparedDispatchError("descriptor.preparation_id has invalid prefix");
  }
  const hexPart = preparationId.slice(PREPARATION_PREFIX.length);
  if (hexPart.length !== 32 || !_uuid4Hex(hexPart)) {
    throw new PreparedDispatchError("descriptor.preparation_id must be prep-<uuid4hex>");
  }
  for (const key of ["batch_id", "slice_id"]) {
    if (!Object.hasOwn(descriptor, key)) throw new PreparedDispatchError(`descriptor.${key} is required`);
    if (!_isNone(descriptor[key]) && typeof descriptor[key] !== "string") {
      throw new PreparedDispatchError(`descriptor.${key} must be a string or null`);
    }
  }
  const selection = descriptor.model_selection;
  if (!_isNone(selection)) {
    if (!isRecord(selection)
      || Object.keys(selection).sort().join(" ") !== [...DESCRIPTOR_MODEL_SELECTION_FIELDS].sort().join(" ")) {
      throw new PreparedDispatchError("descriptor.model_selection has an invalid schema");
    }
    for (const key of ["model", "effort"]) {
      if (!_isNone(selection[key]) && typeof selection[key] !== "string") {
        throw new PreparedDispatchError(`descriptor.model_selection.${key} must be a string or null`);
      }
    }
    for (const key of ["model_source", "effort_source"]) {
      if (typeof selection[key] !== "string" || !selection[key].trim()) {
        throw new PreparedDispatchError(`descriptor.model_selection.${key} must be a non-empty string`);
      }
    }
    const childModel = selection.child_model;
    if (!isRecord(childModel)
      || !DESCRIPTOR_CHILD_MODEL_FIELDS.every((key) => Object.hasOwn(childModel, key))
      || Object.keys(childModel).some((key) => !DESCRIPTOR_CHILD_MODEL_FIELDS.includes(key) && key !== "warning")) {
      throw new PreparedDispatchError("descriptor.model_selection.child_model has an invalid schema");
    }
    if (!Object.values(childModel).every((value) => typeof value === "string" && value.trim())) {
      throw new PreparedDispatchError("descriptor.model_selection.child_model fields must be non-empty strings");
    }
  }
  return descriptor;
}

/** 严格验证实现；公共边界负责把畸形输入归一。 */
function _verifyPreparedDispatch(descriptorFile) {
  let target = descriptorFile;
  if (isRecord(target)) target = target.descriptor_file;
  const descriptorPath = _descriptorPath(target, "descriptor_file");
  assertRegularFile(descriptorPath, "descriptor_file", { error: PreparedDispatchError });
  const rawDescriptor = _readFile(descriptorPath, "descriptor_file");
  let descriptor;
  try {
    descriptor = JSON.parse(rawDescriptor.toString("utf8"));
  } catch {
    throw new PreparedDispatchError(`descriptor is not valid UTF-8 JSON: ${descriptorPath}`);
  }
  _validateDescriptorShape(descriptor);
  if (descriptor.contract_version !== DESCRIPTOR_CONTRACT_VERSION) {
    throw new PreparedDispatchError("unsupported prepared descriptor contract");
  }
  if (descriptor.state !== "prepared") throw new PreparedDispatchError("prepared descriptor state is not prepared");

  const materialRoot = _descriptorPath(descriptor.material_root, "material_root");
  const producerRoot = _descriptorPath(descriptor.producer_root, "producer_root");
  const expectedRoot = path.join(
    producerRoot, "tmp", "dispatch_prepare", PREPARATION_DIRECTORY_NAME, descriptor.preparation_id,
  );
  if (!_pathEqual(materialRoot, expectedRoot)) {
    throw new PreparedDispatchError("material_root does not use the exact preparation layout");
  }
  if (!_isDirectory(materialRoot)) {
    throw new PreparedDispatchError(`material_root is not a directory: ${materialRoot}`);
  }
  _assertNoEscape(materialRoot, producerRoot, { allowMissingLeaf: false });
  if (!_pathEqual(descriptorPath, path.join(materialRoot, DESCRIPTOR_FILENAME))) {
    throw new PreparedDispatchError("descriptor_file does not match material_root commit marker");
  }

  const paths = {};
  const expectedNames = {
    package_file: PACKAGE_FILENAME,
    task_file: TASK_FILENAME,
    dispatch_file: DISPATCH_FILENAME,
    descriptor_file: DESCRIPTOR_FILENAME,
  };
  for (const [key, filename] of Object.entries(expectedNames)) {
    const target2 = _descriptorPath(descriptor[key], key);
    _assertNoEscape(target2, materialRoot, { allowMissingLeaf: false });
    if (pyNormcase(path.dirname(target2)) !== pyNormcase(materialRoot) || path.basename(target2) !== filename) {
      throw new PreparedDispatchError(`descriptor.${key} must use the exact v1 filename and containment`);
    }
    paths[key] = target2;
  }
  if (!_pathEqual(paths.descriptor_file, descriptorPath)) {
    throw new PreparedDispatchError("descriptor_file argument does not match descriptor");
  }

  const material = {};
  for (const key of ["package", "task", "dispatch"]) {
    material[key] = _readFile(paths[`${key}_file`], key);
  }

  let pkg;
  let envelope;
  try {
    pkg = JSON.parse(material.package.toString("utf8"));
    envelope = JSON.parse(material.dispatch.toString("utf8"));
  } catch {
    throw new PreparedDispatchError("package or dispatch material is not valid UTF-8 JSON");
  }
  if (!isRecord(pkg) || !isRecord(envelope)) {
    throw new PreparedDispatchError("package and dispatch material must be JSON objects");
  }
  envelope = validateAsyncDispatchV2(envelope, { package: pkg });
  const packageValue = Object.hasOwn(pkg, "task_package") ? pkg.task_package : pkg;
  if (!isRecord(packageValue)) throw new PreparedDispatchError("task_package material must be an object");
  if (packageValue.package_id !== descriptor.package_id) {
    throw new PreparedDispatchError("package_id identity mismatch");
  }

  if (!_pathEqual(envelope.producer_root, producerRoot)) {
    throw new PreparedDispatchError("dispatch producer_root mismatch");
  }
  if (!_pathEqual(envelope.task_file, paths.task_file)) {
    throw new PreparedDispatchError("dispatch task_file mismatch");
  }
  try {
    const taskRootPath = absolutePath(envelope.task_root, "dispatch task_root", { error: PreparedDispatchError });
    const runtimeRoot = path.join(producerRoot, ".runtime");
    if (_relativeUnder(resolveLikePython(runtimeRoot), taskRootPath) === null) {
      throw new PreparedDispatchError("dispatch task_root is not relative to producer_root/.runtime");
    }
    _assertNoEscape(taskRootPath, runtimeRoot, { allowMissingLeaf: true });
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) {
      throw new PreparedDispatchError("dispatch task_root must stay inside producer_root/.runtime");
    }
    throw caught;
  }
  if (!_pathEqual(envelope.target_cwd, descriptor.target_cwd)) {
    throw new PreparedDispatchError("target_cwd identity mismatch");
  }
  if (!_pathEqual(envelope.task_root, descriptor.task_root)) {
    throw new PreparedDispatchError("task_root identity mismatch");
  }
  if (descriptor.dispatch_contract_version !== envelope.contract_version) {
    throw new PreparedDispatchError("descriptor dispatch contract mismatch");
  }
  if (descriptor.origin_id !== envelope.origin_thread_id) {
    throw new PreparedDispatchError("origin identity mismatch");
  }
  if (descriptor.batch_id !== envelope.batch_id || descriptor.slice_id !== envelope.slice_id) {
    throw new PreparedDispatchError("batch/slice identity mismatch");
  }
  const selection = descriptor.model_selection;
  if (!_isNone(selection)
    && ((selection.model ?? null) !== (envelope.model ?? null)
      || (selection.effort ?? null) !== (envelope.effort ?? null))) {
    throw new PreparedDispatchError("descriptor model selection does not match dispatch envelope");
  }

  const writes = descriptor.writes_performed;
  if (!Array.isArray(writes) || writes.some((value) => typeof value !== "string" || !value.trim())) {
    throw new PreparedDispatchError("descriptor.writes_performed must be a list of non-empty strings");
  }
  const normalizedWrites = [];
  for (const value of writes) {
    const output = path.isAbsolute(value) ? value : path.join(materialRoot, value);
    _assertNoEscape(output, materialRoot, { allowMissingLeaf: false });
    const relative = _pureRelative(materialRoot, value);
    if (relative === null) throw new Error(`'${value}' is not in the subpath of '${materialRoot}'`);
    if (normalizedWrites.includes(relative)) {
      throw new PreparedDispatchError("descriptor.writes_performed contains duplicate paths");
    }
    normalizedWrites.push(relative);
  }
  const actualOutputs = _collectWorkspaceOutputs(materialRoot);
  const left = new Set(normalizedWrites);
  const right = new Set(actualOutputs);
  if (left.size !== right.size || [...left].some((value) => !right.has(value))) {
    throw new PreparedDispatchError("descriptor writes_performed does not match the preparation tree");
  }

  _validatePackageEvidencePath(pkg, {
    producerRoot,
    materialRoot,
    preparedOutputs: normalizedWrites,
  });
  return descriptor;
}

/** 验证已提交的描述符，并把畸形输入归一为本模块的错误。 */
export function verifyPreparedDispatch(descriptorFile) {
  try {
    return _verifyPreparedDispatch(descriptorFile);
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) throw caught;
    throw new PreparedDispatchError(`malformed prepared dispatch descriptor: ${caught?.message ?? caught}`);
  }
}

/** 在常规的所有权清理之前，移除回调伪造的保留标记。 */
function _discardUntrustedDescriptorMarker(materialRoot) {
  const root = absolutePath(materialRoot, "material_root", { error: PreparedDispatchError });
  if (!OWNED_UNCOMMITTED_ROOTS.has(pyNormcase(root))) return;
  const marker = path.join(root, DESCRIPTOR_FILENAME);
  let info;
  try {
    info = lstatSync(marker);
  } catch (caught) {
    if (caught?.code === "ENOENT") return;
    throw new PreparedDispatchError(`cannot inspect untrusted descriptor marker: ${marker}: ${caught.message}`);
  }
  try {
    if (info.isDirectory() && !info.isSymbolicLink() && !isReparseStat(info)) {
      _iterWorkspaceFiles(marker);
      rmSync(marker, { recursive: true });
    } else {
      unlinkSync(marker);
    }
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) throw caught;
    // Windows 的目录 junction 由 rmdir 当链接删除，绝不遍历它。
    if (caught?.code === "EISDIR") {
      rmdirSync(marker);
      return;
    }
    throw new PreparedDispatchError(`cannot discard untrusted descriptor marker: ${marker}: ${caught.message}`);
  }
}

/** 只移除本进程独占分配、且尚未提交的暂存根。 */
export function cleanupUncommittedPreparation(materialRoot, { producerRoot = null } = {}) {
  const root = absolutePath(materialRoot, "material_root", { error: PreparedDispatchError });
  let producer;
  if (_isNone(producerRoot)) {
    const parents = _parentsOf(root);
    producer = parents.length > 3 ? parents[3] : parents[0];
  } else {
    producer = absolutePath(producerRoot, "producer_root", { error: PreparedDispatchError });
  }
  _assertNoEscape(root, producer, { allowMissingLeaf: false });
  const ownedRoot = pyNormcase(root);
  if (!OWNED_UNCOMMITTED_ROOTS.has(ownedRoot)) return false;
  const descriptor = path.join(root, DESCRIPTOR_FILENAME);
  let descriptorInfo = null;
  try {
    descriptorInfo = lstatSync(descriptor);
  } catch (caught) {
    if (caught?.code !== "ENOENT") {
      OWNED_UNCOMMITTED_ROOTS.delete(ownedRoot);
      return false;
    }
  }
  if (descriptorInfo !== null) {
    // 可读的常规提交标记，或任何被污染的标记，都终结清理所有权；绝不让删除跟随 reparse 项。
    OWNED_UNCOMMITTED_ROOTS.delete(ownedRoot);
    return false;
  }
  try {
    _iterWorkspaceFiles(root); // 完整的稳定树 / reparse 前置检查
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) {
      OWNED_UNCOMMITTED_ROOTS.delete(ownedRoot);
      return false;
    }
    throw caught;
  }
  try {
    rmSync(root, { recursive: true });
  } catch (caught) {
    if (caught?.code === "ENOENT") {
      OWNED_UNCOMMITTED_ROOTS.delete(ownedRoot);
      return true;
    }
    throw caught;
  }
  OWNED_UNCOMMITTED_ROOTS.delete(ownedRoot);
  try {
    lstatSync(root);
  } catch (caught) {
    if (caught?.code === "ENOENT") return true;
    return false;
  }
  return false;
}
