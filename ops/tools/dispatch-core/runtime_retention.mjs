// ops/tools/runtime_retention.py 的 JS 复刻：运行态旧文件的盘点、候选收集与守门删除。
// 异常映射表（Python → JS）：
//   ToolError                        → ToolError（消息逐字相同）
//   OSError（lstat / scandir / rmtree / unlink / rmdir）→ Node fs 错误对象，捕获点与 Python 的 except OSError 一一对应；
//                                      冒到调用方文案里时只带 error.message（Python 带 [WinError n]，属已知差异面）
//   ValueError（Path.relative_to）    → 用 pyIsRelativeTo 判定，不抛（Python 的 try/except ValueError 分支就地转成布尔）
//   PreparedDispatchError            → prepared_dispatch.mjs 的同名类
// 时间：file_age_seconds 复刻 time.time()，不走 clock.now()——Python 侧的冻结助手也不patch time.time。
// 可变模块状态：Python 用模块级全局 + monkeypatch 覆盖，这里用模块内 let + configureRetentionRoots()
// 取得同一能力（返回改前快照，调用方负责还原）。
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  ROOT,
  ToolError,
  assertNoReparseComponents,
  homeDir,
  isReparseStat,
  lexicalAbsolute,
  loadJson,
  pathlibJoin,
  rel,
  resolveLikePython,
} from "./_tool_common.mjs";
import { pyIsRelativeTo, pyJsonDumps, pyNormcase, pyPureStr } from "./_py.mjs";
import { DESCRIPTOR_FILENAME, PreparedDispatchError } from "./prepared_dispatch.mjs";

// ---- pathlib 语义的小工具 ----

// Path 之间的相等：Windows 上 pathlib 按 normcase 比较。
function samePath(left, right) {
  return pyNormcase(pyPureStr(left)) === pyNormcase(pyPureStr(right));
}

// sorted(Path, ...)：Windows 上按 normcase 后的完整字符串排序。
function sortPaths(items) {
  return [...items].sort((left, right) => {
    const a = pyNormcase(String(left));
    const b = pyNormcase(String(right));
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// dict.fromkeys(paths)：按 Path 的相等语义去重，保留插入序。
function uniquePaths(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = pyNormcase(pyPureStr(item));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// PurePath.parts 去掉锚点后的分段。
function relativeParts(child, parent) {
  const strip = (value) => {
    const raw = String(value);
    const root = path.parse(raw).root;
    return raw.slice(root.length).split(/[\\/]+/).filter((part) => part && part !== ".");
  };
  return strip(child).slice(strip(parent).length);
}

function pathExists(value) {
  try {
    statSync(String(value));
    return true;
  } catch {
    return false;
  }
}

function pathIsDir(value) {
  try {
    return statSync(String(value)).isDirectory();
  } catch {
    return false;
  }
}

function pathIsFile(value) {
  try {
    return statSync(String(value)).isFile();
  } catch {
    return false;
  }
}

function pathIsSymlink(value) {
  try {
    return lstatSync(String(value)).isSymbolicLink();
  } catch {
    return false;
  }
}

// Path.iterdir()：抛 OSError 时由调用方按 Python 的 except OSError 分支处理。
function iterdir(value) {
  return readdirSync(String(value)).map((name) => pathlibJoin(String(value), name));
}

// Path.rglob("*")：目录与文件都产出，顺序不定（调用方按需 sorted）。
function rglob(value) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      out.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(String(value));
  return out;
}

// ---- 模块状态 ----

export function resolveAsyncTasksDir(cliTaskRoot = null) {
  // 与 subagent_service.mjs DEFAULT_TASK_ROOT 同优先级：--task-root > SUBAGENT_TASK_ROOT > 仓内 async_tasks。
  if (cliTaskRoot) return resolveLikePython(String(cliTaskRoot));
  const envRoot = process.env.SUBAGENT_TASK_ROOT;
  if (envRoot) return resolveLikePython(envRoot);
  return resolveLikePython(pathlibJoin(pathlibJoin(pathlibJoin(ROOT, ".runtime"), "cockpit"), "async_tasks"));
}

export const STATE_DIR = pathlibJoin(pathlibJoin(pathlibJoin(ROOT, ".runtime"), "cockpit"), "state");
export let ASYNC_TASKS_DIR = resolveAsyncTasksDir();
export let DISPATCH_PREPARE_DIR = pathlibJoin(pathlibJoin(ROOT, "tmp"), "dispatch_prepare");
export let PREPARATIONS_DIR = pathlibJoin(DISPATCH_PREPARE_DIR, "preparations");
const _INITIAL_PREPARATIONS_DIR = PREPARATIONS_DIR;

export function preparationsRoot() {
  // Keep tests/isolated callers able to override either the legacy root or the
  // explicit preparations root without leaving a stale derived constant.
  if (!samePath(PREPARATIONS_DIR, _INITIAL_PREPARATIONS_DIR)) return PREPARATIONS_DIR;
  return pathlibJoin(DISPATCH_PREPARE_DIR, "preparations");
}

// 任务定位索引默认根，与 subagent_runtime.mjs 的 registryRoot 默认值同源。
export const DEFAULT_REGISTRY_ROOT = pathlibJoin(pathlibJoin(homeDir(), ".subagent-control"), "async_task_registry");
export let ASYNC_REGISTRY_DIR = process.env.SUBAGENT_REGISTRY_ROOT || DEFAULT_REGISTRY_ROOT;
export const KEEP_FILES = [pathlibJoin(STATE_DIR, ".gitkeep")];
// 安全护栏覆盖的清理根：任何删除目标必须落在这些根之一内部（不含根自身）。
export let CLEANUP_ROOTS = [STATE_DIR, ASYNC_TASKS_DIR, DISPATCH_PREPARE_DIR, ASYNC_REGISTRY_DIR];
// 旧状态目录清理逻辑（iterRuntimeFiles / removeEmptyDirs）只扫这个根；
// async_tasks 和 dispatch_prepare 走各自的候选收集函数，语义不同不能混用。
export const STATE_CLEANUP_ROOTS = [STATE_DIR];
// subagent_service.mjs 的终态判定（见其 `["done", "failed", "cancelled"].includes(state)` 分支）；
// 非终态（submitted / queued / running / cancel_requested）一律不清理。
export const ASYNC_TASK_TERMINAL_STATES = new Set(["done", "failed", "cancelled"]);
export const ASYNC_TASK_RETENTION_DAYS = 7;
export const DISPATCH_PACKAGE_RETENTION_DAYS = 7;
export const ASYNC_TASK_CONTRACT_VERSION = "async-task-service/v1";

export function setAsyncTasksDir(value) {
  ASYNC_TASKS_DIR = value;
  CLEANUP_ROOTS = [STATE_DIR, ASYNC_TASKS_DIR, DISPATCH_PREPARE_DIR, ASYNC_REGISTRY_DIR];
}

/**
 * Python 侧靠 monkeypatch 改模块全局；JS 的 export let 对外只读，故由本函数承担同一职责。
 * 返回改前快照，调用方（测试与自测）负责还原。
 */
export function configureRetentionRoots(overrides = {}) {
  const previous = {
    asyncTasksDir: ASYNC_TASKS_DIR,
    dispatchPrepareDir: DISPATCH_PREPARE_DIR,
    preparationsDir: PREPARATIONS_DIR,
    asyncRegistryDir: ASYNC_REGISTRY_DIR,
    cleanupRoots: CLEANUP_ROOTS,
  };
  if ("asyncTasksDir" in overrides) ASYNC_TASKS_DIR = overrides.asyncTasksDir;
  if ("dispatchPrepareDir" in overrides) DISPATCH_PREPARE_DIR = overrides.dispatchPrepareDir;
  if ("preparationsDir" in overrides) PREPARATIONS_DIR = overrides.preparationsDir;
  if ("asyncRegistryDir" in overrides) ASYNC_REGISTRY_DIR = overrides.asyncRegistryDir;
  if ("cleanupRoots" in overrides) CLEANUP_ROOTS = overrides.cleanupRoots;
  return previous;
}

function assertNoReparse(value, { allowMissing = false } = {}) {
  assertNoReparseComponents(value, { allowMissing, label: "retention path" });
}

export { assertNoReparse as _assertNoReparseComponents };

export function safeRuntimePath(value) {
  const candidate = lexicalAbsolute(value);
  // Check the complete lexical ancestry before resolving either the candidate
  // or any configured cleanup root.  This also covers legacy top-level files.
  assertNoReparse(candidate, { allowMissing: true });
  const roots = uniquePaths([...CLEANUP_ROOTS, DISPATCH_PREPARE_DIR, preparationsRoot()]);
  const checkedRoots = [];
  const candidateResolved = resolveLikePython(candidate);
  for (const root of roots) {
    const rootAbsolute = lexicalAbsolute(root);
    assertNoReparse(rootAbsolute, { allowMissing: true });
    checkedRoots.push([rootAbsolute, resolveLikePython(rootAbsolute)]);
  }
  if (checkedRoots.some(([, rootResolved]) => samePath(candidateResolved, rootResolved))) {
    throw new ToolError(`refusing to operate on cleanup root: ${rel(candidateResolved)}`);
  }
  for (const [rootAbsolute, rootResolved] of checkedRoots) {
    if (!pyIsRelativeTo(candidate, rootAbsolute)) continue;
    let current = rootAbsolute;
    for (const part of relativeParts(candidate, rootAbsolute)) {
      current = pathlibJoin(current, part);
      let info;
      try {
        info = lstatSync(current);
      } catch (error) {
        if (error?.code === "ENOENT") break;
        throw new ToolError(`cannot inspect cleanup target: ${current}: ${error.message}`);
      }
      if (info.isSymbolicLink() || isReparseStat(info)) {
        throw new ToolError(`symlink/reparse cleanup target is not eligible: ${current}`);
      }
    }
    if (!pyIsRelativeTo(candidateResolved, rootResolved)) {
      throw new ToolError(`cleanup target escapes runtime cleanup roots: ${value}`);
    }
    return candidateResolved;
  }
  throw new ToolError(`cleanup target escapes runtime cleanup roots: ${value}`);
}

function cleanupRootGateIssues() {
  const issues = [];
  const roots = uniquePaths([...CLEANUP_ROOTS, DISPATCH_PREPARE_DIR, preparationsRoot()]);
  for (const root of roots) {
    try {
      assertNoReparse(root, { allowMissing: true });
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      issues.push(error.message);
    }
  }
  return issues;
}

export { cleanupRootGateIssues as _cleanupRootGateIssues };

export function fileSize(value) {
  try {
    return statSync(String(value)).size;
  } catch {
    return 0;
  }
}

export function fileAgeSeconds(value) {
  try {
    return Math.max(0, Date.now() / 1000 - statSync(String(value)).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

export function dirSize(value) {
  let total = 0;
  for (const item of rglob(value)) {
    if (pathIsFile(item)) total += fileSize(item);
  }
  return total;
}

export function asyncTaskState(taskDir) {
  const statusPath = pathlibJoin(String(taskDir), "status.json");
  if (!pathExists(statusPath)) return null;
  let data;
  try {
    data = loadJson(statusPath);
  } catch (error) {
    if (error instanceof ToolError) return null;
    throw error;
  }
  const state = data.state;
  return typeof state === "string" ? state : null;
}

export function staleAsyncTaskDirs() {
  assertNoReparse(ASYNC_TASKS_DIR, { allowMissing: true });
  if (!pathExists(ASYNC_TASKS_DIR)) return [];
  const stale = [];
  for (const taskDir of sortPaths(iterdir(ASYNC_TASKS_DIR).filter(pathIsDir))) {
    const state = asyncTaskState(taskDir);
    if (!ASYNC_TASK_TERMINAL_STATES.has(state)) continue;
    if (fileAgeSeconds(taskDir) <= ASYNC_TASK_RETENTION_DAYS * 86400) continue;
    stale.push(taskDir);
  }
  return stale;
}

export function staleDispatchPackageFiles() {
  assertNoReparse(DISPATCH_PREPARE_DIR, { allowMissing: true });
  if (!pathExists(DISPATCH_PREPARE_DIR)) return [];
  const stale = [];
  for (const item of sortPaths(iterdir(DISPATCH_PREPARE_DIR))) {
    if (!pathIsFile(item)) continue;
    if (fileAgeSeconds(item) <= DISPATCH_PACKAGE_RETENTION_DAYS * 86400) continue;
    stale.push(item);
  }
  return stale;
}

/** Reject symlink/reparse components before inventory or deletion. */
function safePreparationPath(value) {
  const preparationRoot = lexicalAbsolute(preparationsRoot());
  const dispatchRoot = lexicalAbsolute(DISPATCH_PREPARE_DIR);
  const candidate = lexicalAbsolute(value);
  // All lexical ancestors are checked before either containment resolve.
  assertNoReparse(preparationRoot, { allowMissing: false });
  assertNoReparse(dispatchRoot, { allowMissing: false });
  assertNoReparse(candidate, { allowMissing: true });
  const root = resolveLikePython(preparationRoot);
  if (!pyIsRelativeTo(root, resolveLikePython(dispatchRoot))) {
    throw new ToolError(`preparations root escapes dispatch_prepare root: ${preparationRoot}`);
  }
  if (!pyIsRelativeTo(candidate, preparationRoot)) {
    throw new ToolError(`preparation path is outside preparations root: ${value}`);
  }
  const resolvedCandidate = resolveLikePython(candidate);
  if (!pyIsRelativeTo(resolvedCandidate, root)) {
    throw new ToolError(`preparation path escapes preparations root: ${value}`);
  }
  let current = preparationRoot;
  for (const part of relativeParts(candidate, preparationRoot)) {
    current = pathlibJoin(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw new ToolError(`cannot inspect preparation path: ${current}: ${error.message}`);
    }
    if (info.isSymbolicLink() || isReparseStat(info)) {
      throw new ToolError(`symlink/reparse preparation path is not eligible: ${current}`);
    }
  }
  return resolvedCandidate;
}

export { safePreparationPath as _safePreparationPath };

function containsPreparationPath(value, preparation) {
  if (typeof value !== "string" || !value.trim()) return false;
  if (!path.isAbsolute(value)) return false;
  assertNoReparse(value, { allowMissing: true });
  assertNoReparse(preparation, { allowMissing: true });
  return pyIsRelativeTo(resolveLikePython(value), resolveLikePython(preparation));
}

function valueReferencesPreparation(value, preparation) {
  if (containsPreparationPath(value, preparation)) return true;
  if (Array.isArray(value)) return value.some((item) => valueReferencesPreparation(item, preparation));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => valueReferencesPreparation(item, preparation));
  }
  return false;
}

/** Return whether a non-terminal task record/status names this preparation. */
export function liveTaskPreparationReference(preparation, { taskRoot } = {}) {
  assertNoReparse(taskRoot, { allowMissing: true });
  if (!pathExists(taskRoot)) return [false, []];
  const issues = [];
  const treeIssue = treeReparseIssue(taskRoot, "task reference tree");
  if (treeIssue) return [false, [treeIssue]];
  let referenced = false;
  let taskDirs;
  try {
    taskDirs = sortPaths(iterdir(taskRoot).filter(pathIsDir));
  } catch (error) {
    return [false, [`cannot inventory task root ${taskRoot}: ${error.message}`]];
  }
  for (const taskDir of taskDirs) {
    const statusPath = pathlibJoin(taskDir, "status.json");
    if (!pathIsFile(statusPath)) {
      issues.push(`task status is missing: ${statusPath}`);
      continue;
    }
    let status;
    try {
      status = loadJson(statusPath);
    } catch (error) {
      issues.push(`task status is malformed: ${statusPath}: ${error.message}`);
      continue;
    }
    const state = status.state;
    if (ASYNC_TASK_TERMINAL_STATES.has(state)) continue;
    if (typeof state !== "string") {
      issues.push(`task status has no state: ${statusPath}`);
      continue;
    }
    const records = sortPaths(rglob(taskDir).filter((item) => item.endsWith(".json") && pathIsFile(item)));
    for (const recordPath of records) {
      let record;
      try {
        record = loadJson(recordPath);
      } catch (error) {
        issues.push(`non-terminal task record is malformed: ${recordPath}: ${error.message}`);
        continue;
      }
      if (valueReferencesPreparation(record, preparation)) referenced = true;
    }
  }
  return [referenced, issues];
}

/** Inventory a tree without following symlink/reparse directories. */
function treeReparseIssue(root, label) {
  try {
    assertNoReparse(root, { allowMissing: false });
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return error.message;
  }
  let rootInfo;
  try {
    rootInfo = lstatSync(String(root));
  } catch (error) {
    return `cannot inspect ${label} ${root}: ${error.message}`;
  }
  if (rootInfo.isSymbolicLink() || isReparseStat(rootInfo)) {
    return `symlink/reparse ${label} is not eligible: ${root}`;
  }
  const pending = [String(root)];
  try {
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = path.join(directory, entry.name);
        let info;
        try {
          info = lstatSync(child);
        } catch (error) {
          return `cannot inspect ${label} child ${child}: ${error.message}`;
        }
        if (info.isSymbolicLink() || isReparseStat(info)) {
          return `symlink/reparse ${label} child is not eligible: ${child}`;
        }
        if (info.isDirectory()) pending.push(child);
      }
    }
  } catch (error) {
    return `cannot inventory ${label} ${root}: ${error.message}`;
  }
  return null;
}

function preparationTreeIssue(preparation) {
  return treeReparseIssue(preparation, "preparation tree");
}

/**
 * Read only the descriptor fields retention relies on: material_root binds the
 * descriptor to this directory, task_root is where live references are searched.
 */
function preparationTaskRoot(preparation) {
  const descriptor = pathlibJoin(preparation, DESCRIPTOR_FILENAME);
  let info;
  try {
    info = lstatSync(descriptor);
  } catch (error) {
    throw new ToolError(`committed preparation descriptor is missing or unreadable: ${descriptor}: ${error.code || error.message}`);
  }
  if (!info.isFile() || info.isSymbolicLink() || isReparseStat(info)) {
    throw new ToolError(`preparation descriptor is not a regular file: ${descriptor}`);
  }
  const data = loadJson(descriptor);
  const materialRoot = data.material_root;
  if (
    typeof materialRoot !== "string"
    || !path.isAbsolute(materialRoot)
    || !samePath(resolveLikePython(materialRoot), resolveLikePython(preparation))
  ) {
    throw new ToolError(`preparation descriptor material_root does not name this preparation: ${descriptor}`);
  }
  const taskRoot = data.task_root;
  if (typeof taskRoot !== "string" || !taskRoot.trim() || !path.isAbsolute(taskRoot)) {
    throw new ToolError(`preparation descriptor task_root is invalid: ${descriptor}`);
  }
  return taskRoot;
}

/**
 * Root, symlink/reparse and tree problems are global `issues`; an entry whose
 * descriptor cannot prove ownership/liveness scope is only `isolated`.
 */
export function preparationPrecheck() {
  const preparationRoot = preparationsRoot();
  try {
    assertNoReparse(preparationRoot, { allowMissing: true });
    assertNoReparse(DISPATCH_PREPARE_DIR, { allowMissing: true });
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { issues: [error.message], isolated: [] };
  }
  try {
    lstatSync(String(preparationRoot));
  } catch (error) {
    if (error?.code === "ENOENT") return { issues: [], isolated: [] };
    return { issues: [`cannot inspect preparations root: ${preparationRoot}: ${error.message}`], isolated: [] };
  }
  const issues = [];
  const isolated = [];
  let entries;
  try {
    safePreparationPath(preparationRoot);
    entries = sortPaths(iterdir(preparationRoot));
  } catch (error) {
    return { issues: [`cannot inventory preparations root: ${error.message}`], isolated: [] };
  }
  for (const entry of entries) {
    let safe;
    try {
      safe = safePreparationPath(entry);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      issues.push(error.message);
      continue;
    }
    if (!pathIsDir(entry)) {
      isolated.push({ path: rel(safe), reason: "preparation entry is not a directory" });
      continue;
    }
    const treeIssue = preparationTreeIssue(safe);
    if (treeIssue) {
      issues.push(treeIssue);
      continue;
    }
    try {
      preparationTaskRoot(safe);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      isolated.push({ path: rel(safe), reason: error.message });
    }
  }
  return { issues, isolated };
}

/** List old, committed and unreferenced preparation directories only. */
export function stalePreparedDirectories() {
  const preparationRoot = preparationsRoot();
  assertNoReparse(preparationRoot, { allowMissing: true });
  if (!pathExists(preparationRoot)) return [];
  try {
    safePreparationPath(preparationRoot);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return [];
  }
  const stale = [];
  for (const entry of sortPaths(iterdir(preparationRoot))) {
    let preparation;
    try {
      preparation = safePreparationPath(entry);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      continue;
    }
    if (!pathIsDir(entry)) continue;
    if (preparationTreeIssue(preparation)) continue;
    const descriptor = pathlibJoin(preparation, DESCRIPTOR_FILENAME);
    if (!pathIsFile(descriptor) || fileAgeSeconds(descriptor) <= DISPATCH_PACKAGE_RETENTION_DAYS * 86400) continue;
    let taskRoot;
    try {
      taskRoot = preparationTaskRoot(preparation);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      continue;
    }
    const [referenced, issues] = liveTaskPreparationReference(preparation, { taskRoot });
    if (issues.length || referenced) continue;
    stale.push(preparation);
  }
  return stale;
}

export function registryRecordsForTaskRoot(registryRoot, taskRoot) {
  assertNoReparse(registryRoot, { allowMissing: true });
  assertNoReparse(taskRoot, { allowMissing: true });
  if (!pathIsDir(registryRoot)) return [];
  const records = [];
  const expectedRoot = resolveLikePython(taskRoot);
  for (const item of sortPaths(iterdir(registryRoot).filter((entry) => entry.endsWith(".json")))) {
    assertNoReparse(item, { allowMissing: false });
    let record;
    let recordRoot;
    try {
      record = loadJson(item);
      recordRoot = resolveLikePython(String(record.task_root || ""));
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      continue;
    }
    if (samePath(recordRoot, expectedRoot) && record.contract_version === ASYNC_TASK_CONTRACT_VERSION) {
      records.push([item, record]);
    }
  }
  return records;
}

export function registryPrecheckIssues({ registryRoot = null, taskRoot = null } = {}) {
  registryRoot = registryRoot !== null ? registryRoot : ASYNC_REGISTRY_DIR;
  taskRoot = taskRoot !== null ? taskRoot : ASYNC_TASKS_DIR;
  assertNoReparse(registryRoot, { allowMissing: true });
  assertNoReparse(taskRoot, { allowMissing: true });
  if (!pathIsDir(registryRoot)) return [];
  const issues = [];
  const expectedRoot = resolveLikePython(taskRoot);
  const expectedRegistry = resolveLikePython(registryRoot);
  for (const item of sortPaths(iterdir(registryRoot).filter((entry) => entry.endsWith(".json")))) {
    assertNoReparse(item, { allowMissing: false });
    const stem = path.basename(item, ".json");
    const name = path.basename(item);
    const localTaskDir = pathlibJoin(taskRoot, stem);
    let record;
    try {
      record = loadJson(item);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      if (pathExists(localTaskDir)) issues.push(`registry record for local task is unreadable: ${name}: ${error.message}`);
      continue;
    }
    const rawRoot = String(record.task_root || "");
    const recordRoot = rawRoot ? resolveLikePython(rawRoot) : null;
    const belongsHere = recordRoot !== null && samePath(recordRoot, expectedRoot);
    if (pathExists(localTaskDir) && !belongsHere) {
      issues.push(`registry task_root binding mismatch: ${name}`);
      continue;
    }
    if (!belongsHere) continue;
    if (record.contract_version !== ASYNC_TASK_CONTRACT_VERSION || record.task_id !== stem) {
      issues.push(`registry contract or task_id mismatch: ${name}`);
      continue;
    }
    if (!pathExists(localTaskDir)) continue;
    const taskFile = pathlibJoin(localTaskDir, "task.json");
    let task;
    try {
      task = loadJson(taskFile);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      issues.push(`task record for registry entry is unreadable: ${name}: ${error.message}`);
      continue;
    }
    if (
      task.task_id !== stem
      || !samePath(resolveLikePython(String(task.task_root || "")), expectedRoot)
      || !samePath(resolveLikePython(String(task.task_dir || "")), resolveLikePython(localTaskDir))
      || !samePath(resolveLikePython(String(task.registry_root || "")), expectedRegistry)
    ) {
      issues.push(`registry and task record binding mismatch: ${name}`);
    }
  }
  return issues;
}

export function staleRegistryFiles(staleTaskDirs, { registryRoot = null, taskRoot = null } = {}) {
  registryRoot = registryRoot !== null ? registryRoot : ASYNC_REGISTRY_DIR;
  taskRoot = taskRoot !== null ? taskRoot : ASYNC_TASKS_DIR;
  const staleIds = new Set(staleTaskDirs.map((item) => path.basename(String(item))));
  const stale = [];
  for (const [item, record] of registryRecordsForTaskRoot(registryRoot, taskRoot)) {
    const taskId = String(record.task_id || "");
    const stem = path.basename(item, ".json");
    if (!taskId || stem !== taskId) continue;
    if (staleIds.has(taskId) || !pathExists(pathlibJoin(taskRoot, taskId))) stale.push(item);
  }
  return stale;
}

export function iterRuntimeFiles() {
  const files = [];
  for (const root of STATE_CLEANUP_ROOTS) {
    assertNoReparse(root, { allowMissing: true });
    if (pathExists(root)) files.push(...rglob(root).filter(pathIsFile));
  }
  return sortPaths(files);
}

export function runtimeInventory() {
  const files = iterRuntimeFiles();
  assertNoReparse(ASYNC_TASKS_DIR, { allowMissing: true });
  assertNoReparse(DISPATCH_PREPARE_DIR, { allowMissing: true });
  assertNoReparse(ASYNC_REGISTRY_DIR, { allowMissing: true });
  let totalFiles = files.length;
  let totalBytes = files.reduce((sum, item) => sum + fileSize(item), 0);
  if (pathExists(ASYNC_TASKS_DIR)) {
    for (const taskDir of iterdir(ASYNC_TASKS_DIR).filter(pathIsDir)) {
      const taskFiles = rglob(taskDir).filter(pathIsFile);
      totalFiles += taskFiles.length;
      totalBytes += taskFiles.reduce((sum, item) => sum + fileSize(item), 0);
    }
  }
  if (pathExists(DISPATCH_PREPARE_DIR)) {
    const packageFiles = iterdir(DISPATCH_PREPARE_DIR).filter(pathIsFile);
    totalFiles += packageFiles.length;
    totalBytes += packageFiles.reduce((sum, item) => sum + fileSize(item), 0);
  }
  const currentPreparationsRoot = preparationsRoot();
  assertNoReparse(currentPreparationsRoot, { allowMissing: true });
  let preparationRootInfo = null;
  try {
    preparationRootInfo = pathExists(currentPreparationsRoot) ? lstatSync(String(currentPreparationsRoot)) : null;
  } catch {
    preparationRootInfo = null;
  }
  if (
    preparationRootInfo !== null
    && preparationRootInfo.isDirectory()
    && !preparationRootInfo.isSymbolicLink()
    && !isReparseStat(preparationRootInfo)
    && preparationTreeIssue(currentPreparationsRoot) === null
  ) {
    const preparationFiles = rglob(currentPreparationsRoot).filter((item) => pathIsFile(item) && !pathIsSymlink(item));
    totalFiles += preparationFiles.length;
    totalBytes += preparationFiles.reduce((sum, item) => sum + fileSize(item), 0);
  }
  const registryFiles = registryRecordsForTaskRoot(ASYNC_REGISTRY_DIR, ASYNC_TASKS_DIR).map(([item]) => item);
  totalFiles += registryFiles.length;
  totalBytes += registryFiles.reduce((sum, item) => sum + fileSize(item), 0);
  return { files: totalFiles, bytes: totalBytes };
}

export function cleanupCandidates() {
  const rootIssues = cleanupRootGateIssues();
  if (rootIssues.length) throw new ToolError(rootIssues.join("; "));
  const candidates = [];
  const staleTaskDirs = staleAsyncTaskDirs();
  for (const item of KEEP_FILES) assertNoReparse(item, { allowMissing: true });
  const keep = new Set(KEEP_FILES.map((item) => pyNormcase(pyPureStr(resolveLikePython(item)))));
  for (const item of iterRuntimeFiles()) {
    const resolved = safeRuntimePath(item);
    if (keep.has(pyNormcase(pyPureStr(resolved)))) continue;
    candidates.push({ kind: "file", path: rel(resolved), bytes: fileSize(resolved), reason: "obsolete runtime state" });
  }
  for (const taskDir of staleTaskDirs) {
    const resolved = safeRuntimePath(taskDir);
    candidates.push({
      kind: "dir",
      path: rel(resolved),
      bytes: dirSize(resolved),
      reason: `terminal async task older than ${ASYNC_TASK_RETENTION_DAYS}d`,
    });
  }
  for (const packageFile of staleDispatchPackageFiles()) {
    const resolved = safeRuntimePath(packageFile);
    candidates.push({
      kind: "file",
      path: rel(resolved),
      bytes: fileSize(resolved),
      reason: `dispatch_prepare package older than ${DISPATCH_PACKAGE_RETENTION_DAYS}d`,
    });
  }
  for (const preparation of stalePreparedDirectories()) {
    const resolved = safeRuntimePath(preparation);
    candidates.push({
      kind: "dir",
      path: rel(resolved),
      bytes: dirSize(resolved),
      reason: `committed prepared dispatch older than ${DISPATCH_PACKAGE_RETENTION_DAYS}d and unreferenced`,
    });
  }
  for (const registryFile of staleRegistryFiles(staleTaskDirs)) {
    const resolved = safeRuntimePath(registryFile);
    candidates.push({
      kind: "file",
      path: rel(resolved),
      bytes: fileSize(resolved),
      reason: "async task registry entry has no retained task directory",
    });
  }
  return candidates;
}

export function selfTest() {
  const raw = mkdtempSync(path.join(os.tmpdir(), "runtime-retention-"));
  const savedEnv = process.env.SUBAGENT_TASK_ROOT;
  const savedTasksDir = ASYNC_TASKS_DIR;
  try {
    const root = raw;
    const taskRoot = pathlibJoin(root, "tasks");
    const registryRoot = pathlibJoin(root, "registry");
    mkdirSync(pathlibJoin(taskRoot, "live"), { recursive: true });
    mkdirSync(pathlibJoin(taskRoot, "stale"));
    mkdirSync(pathlibJoin(taskRoot, "corrupt"));
    mkdirSync(registryRoot);
    for (const [taskId, pointedRoot] of [
      ["live", taskRoot],
      ["stale", taskRoot],
      ["missing", taskRoot],
      ["other", pathlibJoin(root, "other-tasks")],
    ]) {
      writeFileSync(
        pathlibJoin(registryRoot, `${taskId}.json`),
        pyJsonDumps({
          contract_version: ASYNC_TASK_CONTRACT_VERSION,
          task_id: taskId,
          task_root: String(pointedRoot),
        }),
        "utf8",
      );
    }
    for (const taskId of ["live", "stale"]) {
      const taskDir = pathlibJoin(taskRoot, taskId);
      writeFileSync(
        pathlibJoin(taskDir, "task.json"),
        pyJsonDumps({
          task_id: taskId,
          task_root: String(taskRoot),
          task_dir: String(taskDir),
          registry_root: String(registryRoot),
        }),
        "utf8",
      );
    }
    writeFileSync(pathlibJoin(registryRoot, "corrupt.json"), "{broken", "utf8");
    const candidates = staleRegistryFiles([pathlibJoin(taskRoot, "stale")], { registryRoot, taskRoot });
    const names = new Set(candidates.map((item) => path.basename(item)));
    if (names.size !== 2 || !names.has("stale.json") || !names.has("missing.json")) {
      throw new ToolError(`registry retention self-test mismatch: ${JSON.stringify([...names].sort())}`);
    }
    const issues = registryPrecheckIssues({ registryRoot, taskRoot });
    if (issues.length !== 1 || !issues[0].includes("corrupt.json")) {
      throw new ToolError(`registry retention precheck self-test mismatch: ${JSON.stringify(issues)}`);
    }

    // env / CLI 优先级 + 清理目标切换：resolveAsyncTasksDir 与 setAsyncTasksDir 必须改写扫描根。
    delete process.env.SUBAGENT_TASK_ROOT;
    const repoDefault = resolveLikePython(pathlibJoin(pathlibJoin(pathlibJoin(ROOT, ".runtime"), "cockpit"), "async_tasks"));
    if (!samePath(resolveAsyncTasksDir(), repoDefault)) {
      throw new ToolError("task-root default did not fall back to repo async_tasks");
    }
    process.env.SUBAGENT_TASK_ROOT = String(taskRoot);
    if (!samePath(resolveAsyncTasksDir(), resolveLikePython(taskRoot))) {
      throw new ToolError("SUBAGENT_TASK_ROOT override was not honored");
    }
    const cliTarget = resolveLikePython(pathlibJoin(root, "cli-tasks"));
    if (!samePath(resolveAsyncTasksDir(String(cliTarget)), cliTarget)) {
      throw new ToolError("--task-root did not win over SUBAGENT_TASK_ROOT");
    }
    const switchedStale = pathlibJoin(taskRoot, "switched-stale");
    mkdirSync(switchedStale, { recursive: true });
    writeFileSync(pathlibJoin(switchedStale, "status.json"), pyJsonDumps({ state: "done" }), "utf8");
    const oldMtime = Date.now() / 1000 - (ASYNC_TASK_RETENTION_DAYS + 1) * 86400;
    utimesSync(switchedStale, oldMtime, oldMtime);
    setAsyncTasksDir(resolveAsyncTasksDir());
    const found = new Set(staleAsyncTaskDirs().map((item) => pyNormcase(pyPureStr(resolveLikePython(item)))));
    if (!found.has(pyNormcase(pyPureStr(resolveLikePython(switchedStale))))) {
      throw new ToolError("cleanup scan did not switch to SUBAGENT_TASK_ROOT target");
    }
  } finally {
    setAsyncTasksDir(savedTasksDir);
    if (savedEnv === undefined) delete process.env.SUBAGENT_TASK_ROOT;
    else process.env.SUBAGENT_TASK_ROOT = savedEnv;
    rmSync(raw, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  return { tool: "runtime_retention", status: "ok", self_test: true };
}

export function removeEmptyDirs() {
  const removed = [];
  for (const root of STATE_CLEANUP_ROOTS) {
    assertNoReparse(root, { allowMissing: true });
    if (!pathExists(root)) continue;
    const dirs = rglob(root).filter(pathIsDir);
    // Python: sorted(key=len(parts), reverse=True) —— 稳定排序，同深度保持 rglob 产出序。
    const ordered = dirs
      .map((item, index) => ({ item, index, depth: relativeParts(item, path.parse(String(item)).root).length }))
      .sort((a, b) => (b.depth - a.depth) || (a.index - b.index))
      .map((entry) => entry.item);
    for (const item of ordered) {
      if (samePath(item, root)) continue;
      assertNoReparse(item, { allowMissing: true });
      try {
        rmdirSync(item);
      } catch {
        continue;
      }
      removed.push(rel(item));
    }
  }
  return removed;
}

function preparationRelativePath(value) {
  const root = lexicalAbsolute(preparationsRoot());
  const candidate = lexicalAbsolute(value);
  assertNoReparse(root, { allowMissing: true });
  assertNoReparse(candidate, { allowMissing: true });
  if (!pyIsRelativeTo(candidate, root)) return null;
  return relativeParts(candidate, root);
}

/** Recheck the complete preparation immediately before an apply delete. */
function revalidatePreparationForDelete(preparation) {
  const safe = safePreparationPath(preparation);
  if (!pathIsDir(safe)) throw new ToolError(`preparation is not a directory: ${safe}`);
  let treeIssue = preparationTreeIssue(safe);
  if (treeIssue) throw new ToolError(treeIssue);
  const taskRoot = preparationTaskRoot(safe);
  if (fileAgeSeconds(pathlibJoin(safe, DESCRIPTOR_FILENAME)) <= DISPATCH_PACKAGE_RETENTION_DAYS * 86400) {
    throw new ToolError(`preparation became fresh before deletion: ${safe}`);
  }
  const [referenced, issues] = liveTaskPreparationReference(safe, { taskRoot });
  if (issues.length) throw new ToolError(`live task reference recheck failed: ${issues.join("; ")}`);
  if (referenced) throw new ToolError(`preparation gained a live non-terminal reference: ${safe}`);
  // Final application-level path/tree recheck.  There is intentionally no
  // lifecycle lock here; a hostile OS race is outside this tool's claim.
  safePreparationPath(safe);
  treeIssue = preparationTreeIssue(safe);
  if (treeIssue) throw new ToolError(treeIssue);
}

export function applyCandidates(candidates) {
  const deleted = [];
  const errors = [];
  const deletedSet = new Set();
  let precheckIssues;
  let isolated = [];
  try {
    const preparation = preparationPrecheck();
    isolated = preparation.isolated.map((entry) => pathlibJoin(ROOT, entry.path));
    precheckIssues = [...cleanupRootGateIssues(), ...registryPrecheckIssues(), ...preparation.issues];
  } catch (error) {
    precheckIssues = [`deletion precheck failed: ${error.message}`];
  }
  if (precheckIssues.length) {
    errors.push(...precheckIssues.map((issue) => `global deletion precheck: ${issue}`));
    return { deleted_count: 0, deleted_bytes: 0, deleted: [], removed_dirs: [], errors };
  }
  for (const item of candidates) {
    try {
      const target = safeRuntimePath(pathlibJoin(ROOT, String(item.path)));
      const swallowed = isolated.find((entry) => pyIsRelativeTo(entry, target));
      if (swallowed) throw new ToolError(`candidate contains isolated preparation: ${rel(swallowed)}`);
      const preparationRelative = preparationRelativePath(target);
      if (preparationRelative !== null) {
        if (!(item.kind === "dir" && preparationRelative.length === 1 && preparationRelative[0].startsWith("prep-"))) {
          throw new ToolError("prepared material may only be deleted as one fully revalidated preparation directory");
        }
        revalidatePreparationForDelete(target);
      }
      if (item.kind === "dir") rmSync(target, { recursive: true });
      else rmSync(target, { force: true });
      deleted.push(String(item.path));
      deletedSet.add(String(item.path));
    } catch (error) {
      errors.push(`${item.path}: ${error.message}`);
    }
  }
  return {
    deleted_count: deleted.length,
    deleted_bytes: candidates
      .filter((item) => deletedSet.has(String(item.path)))
      .reduce((sum, item) => sum + Number(item.bytes), 0),
    deleted: deleted.slice(0, 50),
    removed_dirs: removeEmptyDirs().slice(0, 50),
    errors,
  };
}

export function buildData(args) {
  const rootIssues = cleanupRootGateIssues();
  const before = rootIssues.length ? { files: 0, bytes: 0 } : runtimeInventory();
  let candidates = [];
  if (!rootIssues.length) {
    try {
      candidates = cleanupCandidates();
    } catch (error) {
      candidates = [];
      rootIssues.push(`cleanup candidate inventory failed: ${error.message}`);
    }
  }
  const registryIssues = rootIssues.length ? [] : registryPrecheckIssues();
  const preparation = rootIssues.length ? { issues: [], isolated: [] } : preparationPrecheck();
  const issues = [...rootIssues, ...registryIssues, ...preparation.issues];
  let applied = { deleted_count: 0, deleted_bytes: 0, deleted: [], removed_dirs: [], errors: [] };
  // Root, registry and symlink/reparse prechecks are fail-closed for the whole
  // apply; a preparation with an unusable descriptor is only isolated.  There
  // is no lifecycle lock; applyCandidates performs a fresh
  // descriptor/age/reference/tree check for each preparation.
  if (args.apply && !issues.length) applied = applyCandidates(candidates);
  // An attempted apply must report the actual post-attempt inventory, even
  // when a precheck or one candidate blocked the operation.
  const after = args.apply && !rootIssues.length ? runtimeInventory() : before;
  const failed = Boolean(issues.length || applied.errors.length);
  const status = failed ? "failed" : preparation.isolated.length ? "partial" : "ok";
  return {
    tool: "runtime_retention",
    status,
    exit_code: status === "ok" ? 0 : 1,
    mode: args.apply ? "apply" : "dry-run",
    cleanup_roots: CLEANUP_ROOTS.map((item) => rel(item)),
    before,
    after,
    precheck_issues: issues,
    isolated: { count: preparation.isolated.length, items: preparation.isolated },
    candidates: {
      count: candidates.length,
      bytes: candidates.reduce((sum, item) => sum + Number(item.bytes), 0),
      items: candidates.slice(0, 50),
    },
    applied,
  };
}

export function buildText(data) {
  const lines = [
    "# Runtime Retention",
    "",
    `status: ${data.status}`,
    `mode: ${data.mode}`,
    `cleanup_roots: ${data.cleanup_roots.join(", ")}`,
    `before.files: ${data.before.files}`,
    `before.bytes: ${data.before.bytes}`,
    `after.files: ${data.after.files}`,
    `after.bytes: ${data.after.bytes}`,
    `candidates.count: ${data.candidates.count}`,
    `candidates.bytes: ${data.candidates.bytes}`,
    `applied.deleted_count: ${data.applied.deleted_count}`,
    `applied.deleted_bytes: ${data.applied.deleted_bytes}`,
    "",
    "## Precheck Issues",
  ];
  if (data.precheck_issues.length) lines.push(...data.precheck_issues.map((item) => `- ${item}`));
  else lines.push("- none");
  lines.push("");
  lines.push("## Isolated Preparations");
  if (data.isolated.items.length) lines.push(...data.isolated.items.map((item) => `- ${item.path}: ${item.reason}`));
  else lines.push("- none");
  lines.push("");
  lines.push("## Candidate Sample");
  if (data.candidates.items.length) {
    lines.push(...data.candidates.items.slice(0, 20).map((item) => `- ${item.path} (${item.bytes} bytes): ${item.reason}`));
  } else {
    lines.push("- none");
  }
  lines.push("");
  lines.push("## Apply Errors");
  if (data.applied.errors.length) lines.push(...data.applied.errors.map((item) => `- ${item}`));
  else lines.push("- none");
  return `${lines.join("\n")}\n`;
}
