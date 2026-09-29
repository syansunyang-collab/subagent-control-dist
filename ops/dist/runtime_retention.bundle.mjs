#!/usr/bin/env node

// ops/tools/runtime_retention.mjs
import process4 from "node:process";

// ops/tools/dispatch-core/_tool_common.mjs
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ops/tools/model_config.mjs
var MODEL_CONFIG_DECLARATION_SEGMENTS = Object.freeze([".pi", "control-plane-model-config.json"]);
var MODEL_CONFIG_ASSETS = Object.freeze({
  agents_dir: Object.freeze({ kind: "dir", relative: Object.freeze(["ops", "agents"]) }),
  model_notes: Object.freeze({ kind: "file", relative: Object.freeze(["ops", "model-notes.toml"]) })
});
var MODEL_CONFIG_ASSET_KEYS = Object.freeze(Object.keys(MODEL_CONFIG_ASSETS));
var MODEL_CONFIG_REQUIRED_KEYS = Object.freeze(["agents_dir", "model_notes"]);

// ops/tools/dispatch-core/_tool_common.mjs
var ToolError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
};
function isAbsoluteLikePython(value) {
  const text = String(value ?? "");
  if (process.platform !== "win32") return text.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(text) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(text);
}
function pathlibJoin(base, other) {
  const text = String(other ?? "");
  if (isAbsoluteLikePython(text)) return text;
  if (process.platform === "win32" && /^[\\/]/.test(text)) {
    const drive = path.parse(path.resolve(String(base))).root.replace(/[\\/]+$/, "");
    return `${drive}${text}`;
  }
  return path.join(String(base), text);
}
function resolveLikePython(value) {
  const absolute = path.resolve(String(value));
  let current = absolute;
  const tail = [];
  while (true) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}
function repoRoot() {
  const explicit = String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim();
  if (explicit) {
    if (!isAbsoluteLikePython(explicit)) throw new ToolError("SUBAGENT_CONTROL_REPO_ROOT must be an absolute path");
    const resolved = resolveLikePython(explicit);
    let info = null;
    try {
      info = statSync(resolved);
    } catch {
      info = null;
    }
    if (!info || !info.isDirectory()) throw new ToolError(`SUBAGENT_CONTROL_REPO_ROOT is not a directory: ${explicit}`);
    return resolved;
  }
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (existsSync(path.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  let cur = resolveLikePython(process.cwd());
  while (true) {
    if (existsSync(path.join(cur, ".git")) || existsSync(path.join(cur, "AGENTS.md")) && existsSync(path.join(cur, "ops"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new ToolError(`cannot locate cockpit repository root from ${resolveLikePython(process.cwd())}`);
}
function declaredDirectory(envKey) {
  const explicit = String(process.env[envKey] || "").trim();
  if (!explicit) return null;
  if (!isAbsoluteLikePython(explicit)) throw new ToolError(`${envKey} must be an absolute path`);
  const resolved = resolveLikePython(explicit);
  let info = null;
  try {
    info = statSync(resolved);
  } catch {
    info = null;
  }
  if (!info || !info.isDirectory()) throw new ToolError(`${envKey} is not a directory: ${explicit}`);
  return resolved;
}
function projectRoot() {
  const explicit = declaredDirectory("SUBAGENT_PROJECT_ROOT");
  if (explicit) return explicit;
  if (String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const cwd = resolveLikePython(process.cwd());
  let cur = cwd;
  while (true) {
    if (existsSync(path.join(cur, ".git")) || existsSync(path.join(cur, "AGENTS.md")) && existsSync(path.join(cur, "ops"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return repoRoot();
}
function runtimeRoot() {
  const explicit = declaredDirectory("SUBAGENT_RUNTIME_ROOT");
  if (explicit) return explicit;
  if (String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (existsSync(path.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  return repoRoot();
}
var ROOT = projectRoot();
var RUNTIME_ROOT = runtimeRoot();
function rel(value) {
  const target = resolveLikePython(value);
  const relative = path.relative(ROOT, target);
  if (relative === "") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return String(value).replace(/\\/g, "/");
  return relative.replace(/\\/g, "/");
}
function loadJson(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new ToolError(`json file not found: ${rel(file)}`);
    throw new ToolError(`cannot read json file: ${rel(file)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ToolError(`invalid json file: ${rel(file)}:${jsonErrorLine(text, error)}`);
  }
  if (!isRecord(data)) throw new ToolError(`json root is not object: ${rel(file)}`);
  return data;
}
function jsonErrorLine(text, error) {
  const match = /position (\d+)/.exec(String(error?.message ?? ""));
  if (!match) return 1;
  return text.slice(0, Number(match[1])).split("\n").length;
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareCodePoints).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}
function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value), null, 2);
}
function emit(data, fmt, text) {
  if (fmt === "json") {
    process.stdout.write(`${canonicalJson(data)}
`);
  } else {
    const trimmed = String(text ?? "").replace(/\s+$/, "");
    process.stdout.write(`${trimmed || "(empty)"}
`);
  }
  if (Object.hasOwn(data, "exit_code")) return Number(data.exit_code);
  return ["failed", "error"].includes(data.status) ? 1 : 0;
}
function lexicalAbsolute(value) {
  return path.resolve(String(value));
}
function absolutePath(value, label, { error = ToolError } = {}) {
  const candidate = String(value);
  if (!isAbsoluteLikePython(candidate)) throw new error(`${label} must be absolute: ${value}`);
  return path.resolve(candidate);
}
function isReparseStat(info) {
  return Boolean(info?.isSymbolicLink?.());
}
function componentsOf(candidate) {
  const parsed = path.parse(candidate);
  const rest = candidate.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  return { anchor: parsed.root, parts: rest };
}
function assertNoReparseComponents(value, { allowMissing = false, label = "path", error = ToolError } = {}) {
  const candidate = absolutePath(value, label, { error });
  const { anchor, parts } = componentsOf(candidate);
  let current = anchor;
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (caught) {
      if (caught?.code === "ENOENT") {
        if (allowMissing) return;
        throw new error(`${label} component does not exist: ${current}`);
      }
      throw new error(`cannot inspect ${label} component ${current}: ${caught.message}`);
    }
    if (info.isSymbolicLink() || isReparseStat(info)) throw new error(`symlink/reparse ${label} is not permitted: ${current}`);
  }
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function homeDir() {
  return os.homedir();
}

// ops/tools/dispatch-core/runtime_retention.mjs
import { lstatSync as lstatSync2, mkdirSync as mkdirSync2, mkdtempSync, readdirSync, rmSync, rmdirSync, statSync as statSync2, utimesSync, writeFileSync } from "node:fs";
import os2 from "node:os";
import path3 from "node:path";
import process3 from "node:process";

// ops/tools/dispatch-core/_py.mjs
import path2 from "node:path";
import process2 from "node:process";
var PY_SPACE_CLASS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
var PY_SPACE_RE = new RegExp(`[${PY_SPACE_CLASS}]`);
var RE_LSTRIP = new RegExp(`^[${PY_SPACE_CLASS}]+`);
var RE_RSTRIP = new RegExp(`[${PY_SPACE_CLASS}]+$`);
function pyJsonDumps(value, { compact = false } = {}) {
  const itemSep = compact ? "," : ", ";
  const keySep = compact ? ":" : ": ";
  const walk = (item) => {
    if (item === null || item === void 0) return "null";
    if (Array.isArray(item)) return `[${item.map(walk).join(itemSep)}]`;
    if (typeof item === "object") {
      return `{${Object.entries(item).filter(([, entry]) => entry !== void 0).map(([key, entry]) => `${JSON.stringify(String(key))}${keySep}${walk(entry)}`).join(itemSep)}}`;
    }
    return JSON.stringify(item);
  };
  return walk(value);
}
function pyNormcase(value) {
  const text = String(value);
  return process2.platform === "win32" ? text.replace(/\//g, "\\").toLowerCase() : text;
}
function pathAnchor(root) {
  if (process2.platform !== "win32") return root;
  const anchor = root.replace(/\//g, "\\");
  return /^\\\\[^\\]+\\[^\\]+$/.test(anchor) ? `${anchor}\\` : anchor;
}
function pathParts(value) {
  const raw = String(value);
  const root = path2.parse(raw).root;
  const rest = raw.slice(root.length).split(/[\\/]+/).filter((part) => part && part !== ".");
  return { anchor: pathAnchor(root), parts: rest };
}
function pyPureStr(value) {
  const { anchor, parts } = pathParts(value);
  if (!parts.length) return anchor || ".";
  return anchor + parts.join(process2.platform === "win32" ? "\\" : "/");
}
function pyIsRelativeTo(child, parent) {
  const left = pathParts(child);
  const right = pathParts(parent);
  if (pyNormcase(left.anchor) !== pyNormcase(right.anchor)) return false;
  if (right.parts.length > left.parts.length) return false;
  return right.parts.every((part, index) => pyNormcase(part) === pyNormcase(left.parts[index]));
}

// ops/tools/dispatch-core/prepared_dispatch.mjs
var PACKAGE_FILENAME = "package.json";
var TASK_FILENAME = "package.task.md";
var DISPATCH_FILENAME = "package.dispatch.json";
var DESCRIPTOR_FILENAME = "prepared-dispatch.json";
var RESERVED_FILENAMES = Object.freeze([PACKAGE_FILENAME, TASK_FILENAME, DISPATCH_FILENAME, DESCRIPTOR_FILENAME]);
var ASYNC_DISPATCH_V2_FIELDS = Object.freeze([
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
  "selection"
]);
var SELECTION_FIELDS = Object.freeze([
  "requested",
  "role",
  "capability",
  "pick",
  "config_source",
  "resolved_model",
  "resolved_effort",
  "effort_source",
  "efforts",
  "effort_range",
  "authorization"
]);
var ASYNC_DISPATCH_REQUIRED_FIELDS = Object.freeze([
  "contract_version",
  "producer_root",
  "origin_thread_id",
  "target_cwd",
  "task_file",
  "task_root"
]);
var ASYNC_CONTEXT_MODES = Object.freeze(["isolated", "project-aware"]);
var ASYNC_EXECUTION_PROFILES = Object.freeze(["standard", "simulation", "evidence_only_v1"]);
var ASYNC_RESULT_MODES = Object.freeze(["", "read_only_audit", "simulated_planning", "real_rerun"]);
var SIMULATION_FIELDS = Object.freeze(["role", "persona"]);
var DESCRIPTOR_MODEL_SELECTION_FIELDS = Object.freeze([
  "model",
  "effort",
  "model_source",
  "effort_source",
  "child_model"
]);
var DESCRIPTOR_CHILD_MODEL_FIELDS = Object.freeze(["status", "source"]);
var RUNTIME_VALUE_ALIASES = Object.freeze({
  target_cwd: "targetCwd",
  task_root: "taskRoot",
  runner_path: "runnerPath",
  runtime_role: "runtimeRole",
  context_mode: "contextMode",
  execution_profile: "executionProfile",
  result_mode: "resultMode"
});

// ops/tools/dispatch-core/runtime_retention.mjs
function samePath(left, right) {
  return pyNormcase(pyPureStr(left)) === pyNormcase(pyPureStr(right));
}
function sortPaths(items) {
  return [...items].sort((left, right) => {
    const a = pyNormcase(String(left));
    const b = pyNormcase(String(right));
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
function uniquePaths(items) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const item of items) {
    const key = pyNormcase(pyPureStr(item));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
function relativeParts(child, parent) {
  const strip = (value) => {
    const raw = String(value);
    const root = path3.parse(raw).root;
    return raw.slice(root.length).split(/[\\/]+/).filter((part) => part && part !== ".");
  };
  return strip(child).slice(strip(parent).length);
}
function pathExists(value) {
  try {
    statSync2(String(value));
    return true;
  } catch {
    return false;
  }
}
function pathIsDir(value) {
  try {
    return statSync2(String(value)).isDirectory();
  } catch {
    return false;
  }
}
function pathIsFile(value) {
  try {
    return statSync2(String(value)).isFile();
  } catch {
    return false;
  }
}
function pathIsSymlink(value) {
  try {
    return lstatSync2(String(value)).isSymbolicLink();
  } catch {
    return false;
  }
}
function iterdir(value) {
  return readdirSync(String(value)).map((name) => pathlibJoin(String(value), name));
}
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
      const full = path3.join(dir, entry.name);
      out.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(String(value));
  return out;
}
function resolveAsyncTasksDir(cliTaskRoot = null) {
  if (cliTaskRoot) return resolveLikePython(String(cliTaskRoot));
  const envRoot = process3.env.SUBAGENT_TASK_ROOT;
  if (envRoot) return resolveLikePython(envRoot);
  return resolveLikePython(pathlibJoin(pathlibJoin(pathlibJoin(ROOT, ".runtime"), "cockpit"), "async_tasks"));
}
var STATE_DIR = pathlibJoin(pathlibJoin(pathlibJoin(ROOT, ".runtime"), "cockpit"), "state");
var ASYNC_TASKS_DIR = resolveAsyncTasksDir();
var DISPATCH_PREPARE_DIR = pathlibJoin(pathlibJoin(ROOT, "tmp"), "dispatch_prepare");
var PREPARATIONS_DIR = pathlibJoin(DISPATCH_PREPARE_DIR, "preparations");
var _INITIAL_PREPARATIONS_DIR = PREPARATIONS_DIR;
function preparationsRoot() {
  if (!samePath(PREPARATIONS_DIR, _INITIAL_PREPARATIONS_DIR)) return PREPARATIONS_DIR;
  return pathlibJoin(DISPATCH_PREPARE_DIR, "preparations");
}
var DEFAULT_REGISTRY_ROOT = pathlibJoin(pathlibJoin(homeDir(), ".subagent-control"), "async_task_registry");
var ASYNC_REGISTRY_DIR = process3.env.SUBAGENT_REGISTRY_ROOT || DEFAULT_REGISTRY_ROOT;
var KEEP_FILES = [pathlibJoin(STATE_DIR, ".gitkeep")];
var CLEANUP_ROOTS = [STATE_DIR, ASYNC_TASKS_DIR, DISPATCH_PREPARE_DIR, ASYNC_REGISTRY_DIR];
var STATE_CLEANUP_ROOTS = [STATE_DIR];
var ASYNC_TASK_TERMINAL_STATES = /* @__PURE__ */ new Set(["done", "failed", "cancelled"]);
var ASYNC_TASK_RETENTION_DAYS = 7;
var DISPATCH_PACKAGE_RETENTION_DAYS = 7;
var ASYNC_TASK_CONTRACT_VERSION = "async-task-service/v1";
function setAsyncTasksDir(value) {
  ASYNC_TASKS_DIR = value;
  CLEANUP_ROOTS = [STATE_DIR, ASYNC_TASKS_DIR, DISPATCH_PREPARE_DIR, ASYNC_REGISTRY_DIR];
}
function assertNoReparse(value, { allowMissing = false } = {}) {
  assertNoReparseComponents(value, { allowMissing, label: "retention path" });
}
function safeRuntimePath(value) {
  const candidate = lexicalAbsolute(value);
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
        info = lstatSync2(current);
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
function fileSize(value) {
  try {
    return statSync2(String(value)).size;
  } catch {
    return 0;
  }
}
function fileAgeSeconds(value) {
  try {
    return Math.max(0, Date.now() / 1e3 - statSync2(String(value)).mtimeMs / 1e3);
  } catch {
    return 0;
  }
}
function dirSize(value) {
  let total = 0;
  for (const item of rglob(value)) {
    if (pathIsFile(item)) total += fileSize(item);
  }
  return total;
}
function asyncTaskState(taskDir) {
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
function staleAsyncTaskDirs() {
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
function staleDispatchPackageFiles() {
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
function safePreparationPath(value) {
  const preparationRoot = lexicalAbsolute(preparationsRoot());
  const dispatchRoot = lexicalAbsolute(DISPATCH_PREPARE_DIR);
  const candidate = lexicalAbsolute(value);
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
      info = lstatSync2(current);
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
function containsPreparationPath(value, preparation) {
  if (typeof value !== "string" || !value.trim()) return false;
  if (!path3.isAbsolute(value)) return false;
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
function liveTaskPreparationReference(preparation, { taskRoot } = {}) {
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
function treeReparseIssue(root, label) {
  try {
    assertNoReparse(root, { allowMissing: false });
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return error.message;
  }
  let rootInfo;
  try {
    rootInfo = lstatSync2(String(root));
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
        const child = path3.join(directory, entry.name);
        let info;
        try {
          info = lstatSync2(child);
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
function preparationTaskRoot(preparation) {
  const descriptor = pathlibJoin(preparation, DESCRIPTOR_FILENAME);
  let info;
  try {
    info = lstatSync2(descriptor);
  } catch (error) {
    throw new ToolError(`committed preparation descriptor is missing or unreadable: ${descriptor}: ${error.code || error.message}`);
  }
  if (!info.isFile() || info.isSymbolicLink() || isReparseStat(info)) {
    throw new ToolError(`preparation descriptor is not a regular file: ${descriptor}`);
  }
  const data = loadJson(descriptor);
  const materialRoot = data.material_root;
  if (typeof materialRoot !== "string" || !path3.isAbsolute(materialRoot) || !samePath(resolveLikePython(materialRoot), resolveLikePython(preparation))) {
    throw new ToolError(`preparation descriptor material_root does not name this preparation: ${descriptor}`);
  }
  const taskRoot = data.task_root;
  if (typeof taskRoot !== "string" || !taskRoot.trim() || !path3.isAbsolute(taskRoot)) {
    throw new ToolError(`preparation descriptor task_root is invalid: ${descriptor}`);
  }
  return taskRoot;
}
function preparationPrecheck() {
  const preparationRoot = preparationsRoot();
  try {
    assertNoReparse(preparationRoot, { allowMissing: true });
    assertNoReparse(DISPATCH_PREPARE_DIR, { allowMissing: true });
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { issues: [error.message], isolated: [] };
  }
  try {
    lstatSync2(String(preparationRoot));
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
function stalePreparedDirectories() {
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
function registryRecordsForTaskRoot(registryRoot, taskRoot) {
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
function registryPrecheckIssues({ registryRoot = null, taskRoot = null } = {}) {
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
    const stem = path3.basename(item, ".json");
    const name = path3.basename(item);
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
    if (task.task_id !== stem || !samePath(resolveLikePython(String(task.task_root || "")), expectedRoot) || !samePath(resolveLikePython(String(task.task_dir || "")), resolveLikePython(localTaskDir)) || !samePath(resolveLikePython(String(task.registry_root || "")), expectedRegistry)) {
      issues.push(`registry and task record binding mismatch: ${name}`);
    }
  }
  return issues;
}
function staleRegistryFiles(staleTaskDirs, { registryRoot = null, taskRoot = null } = {}) {
  registryRoot = registryRoot !== null ? registryRoot : ASYNC_REGISTRY_DIR;
  taskRoot = taskRoot !== null ? taskRoot : ASYNC_TASKS_DIR;
  const staleIds = new Set(staleTaskDirs.map((item) => path3.basename(String(item))));
  const stale = [];
  for (const [item, record] of registryRecordsForTaskRoot(registryRoot, taskRoot)) {
    const taskId = String(record.task_id || "");
    const stem = path3.basename(item, ".json");
    if (!taskId || stem !== taskId) continue;
    if (staleIds.has(taskId) || !pathExists(pathlibJoin(taskRoot, taskId))) stale.push(item);
  }
  return stale;
}
function iterRuntimeFiles() {
  const files = [];
  for (const root of STATE_CLEANUP_ROOTS) {
    assertNoReparse(root, { allowMissing: true });
    if (pathExists(root)) files.push(...rglob(root).filter(pathIsFile));
  }
  return sortPaths(files);
}
function runtimeInventory() {
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
    preparationRootInfo = pathExists(currentPreparationsRoot) ? lstatSync2(String(currentPreparationsRoot)) : null;
  } catch {
    preparationRootInfo = null;
  }
  if (preparationRootInfo !== null && preparationRootInfo.isDirectory() && !preparationRootInfo.isSymbolicLink() && !isReparseStat(preparationRootInfo) && preparationTreeIssue(currentPreparationsRoot) === null) {
    const preparationFiles = rglob(currentPreparationsRoot).filter((item) => pathIsFile(item) && !pathIsSymlink(item));
    totalFiles += preparationFiles.length;
    totalBytes += preparationFiles.reduce((sum, item) => sum + fileSize(item), 0);
  }
  const registryFiles = registryRecordsForTaskRoot(ASYNC_REGISTRY_DIR, ASYNC_TASKS_DIR).map(([item]) => item);
  totalFiles += registryFiles.length;
  totalBytes += registryFiles.reduce((sum, item) => sum + fileSize(item), 0);
  return { files: totalFiles, bytes: totalBytes };
}
function cleanupCandidates() {
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
      reason: `terminal async task older than ${ASYNC_TASK_RETENTION_DAYS}d`
    });
  }
  for (const packageFile of staleDispatchPackageFiles()) {
    const resolved = safeRuntimePath(packageFile);
    candidates.push({
      kind: "file",
      path: rel(resolved),
      bytes: fileSize(resolved),
      reason: `dispatch_prepare package older than ${DISPATCH_PACKAGE_RETENTION_DAYS}d`
    });
  }
  for (const preparation of stalePreparedDirectories()) {
    const resolved = safeRuntimePath(preparation);
    candidates.push({
      kind: "dir",
      path: rel(resolved),
      bytes: dirSize(resolved),
      reason: `committed prepared dispatch older than ${DISPATCH_PACKAGE_RETENTION_DAYS}d and unreferenced`
    });
  }
  for (const registryFile of staleRegistryFiles(staleTaskDirs)) {
    const resolved = safeRuntimePath(registryFile);
    candidates.push({
      kind: "file",
      path: rel(resolved),
      bytes: fileSize(resolved),
      reason: "async task registry entry has no retained task directory"
    });
  }
  return candidates;
}
function selfTest() {
  const raw = mkdtempSync(path3.join(os2.tmpdir(), "runtime-retention-"));
  const savedEnv = process3.env.SUBAGENT_TASK_ROOT;
  const savedTasksDir = ASYNC_TASKS_DIR;
  try {
    const root = raw;
    const taskRoot = pathlibJoin(root, "tasks");
    const registryRoot = pathlibJoin(root, "registry");
    mkdirSync2(pathlibJoin(taskRoot, "live"), { recursive: true });
    mkdirSync2(pathlibJoin(taskRoot, "stale"));
    mkdirSync2(pathlibJoin(taskRoot, "corrupt"));
    mkdirSync2(registryRoot);
    for (const [taskId, pointedRoot] of [
      ["live", taskRoot],
      ["stale", taskRoot],
      ["missing", taskRoot],
      ["other", pathlibJoin(root, "other-tasks")]
    ]) {
      writeFileSync(
        pathlibJoin(registryRoot, `${taskId}.json`),
        pyJsonDumps({
          contract_version: ASYNC_TASK_CONTRACT_VERSION,
          task_id: taskId,
          task_root: String(pointedRoot)
        }),
        "utf8"
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
          registry_root: String(registryRoot)
        }),
        "utf8"
      );
    }
    writeFileSync(pathlibJoin(registryRoot, "corrupt.json"), "{broken", "utf8");
    const candidates = staleRegistryFiles([pathlibJoin(taskRoot, "stale")], { registryRoot, taskRoot });
    const names = new Set(candidates.map((item) => path3.basename(item)));
    if (names.size !== 2 || !names.has("stale.json") || !names.has("missing.json")) {
      throw new ToolError(`registry retention self-test mismatch: ${JSON.stringify([...names].sort())}`);
    }
    const issues = registryPrecheckIssues({ registryRoot, taskRoot });
    if (issues.length !== 1 || !issues[0].includes("corrupt.json")) {
      throw new ToolError(`registry retention precheck self-test mismatch: ${JSON.stringify(issues)}`);
    }
    delete process3.env.SUBAGENT_TASK_ROOT;
    const repoDefault = resolveLikePython(pathlibJoin(pathlibJoin(pathlibJoin(ROOT, ".runtime"), "cockpit"), "async_tasks"));
    if (!samePath(resolveAsyncTasksDir(), repoDefault)) {
      throw new ToolError("task-root default did not fall back to repo async_tasks");
    }
    process3.env.SUBAGENT_TASK_ROOT = String(taskRoot);
    if (!samePath(resolveAsyncTasksDir(), resolveLikePython(taskRoot))) {
      throw new ToolError("SUBAGENT_TASK_ROOT override was not honored");
    }
    const cliTarget = resolveLikePython(pathlibJoin(root, "cli-tasks"));
    if (!samePath(resolveAsyncTasksDir(String(cliTarget)), cliTarget)) {
      throw new ToolError("--task-root did not win over SUBAGENT_TASK_ROOT");
    }
    const switchedStale = pathlibJoin(taskRoot, "switched-stale");
    mkdirSync2(switchedStale, { recursive: true });
    writeFileSync(pathlibJoin(switchedStale, "status.json"), pyJsonDumps({ state: "done" }), "utf8");
    const oldMtime = Date.now() / 1e3 - (ASYNC_TASK_RETENTION_DAYS + 1) * 86400;
    utimesSync(switchedStale, oldMtime, oldMtime);
    setAsyncTasksDir(resolveAsyncTasksDir());
    const found = new Set(staleAsyncTaskDirs().map((item) => pyNormcase(pyPureStr(resolveLikePython(item)))));
    if (!found.has(pyNormcase(pyPureStr(resolveLikePython(switchedStale))))) {
      throw new ToolError("cleanup scan did not switch to SUBAGENT_TASK_ROOT target");
    }
  } finally {
    setAsyncTasksDir(savedTasksDir);
    if (savedEnv === void 0) delete process3.env.SUBAGENT_TASK_ROOT;
    else process3.env.SUBAGENT_TASK_ROOT = savedEnv;
    rmSync(raw, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  return { tool: "runtime_retention", status: "ok", self_test: true };
}
function removeEmptyDirs() {
  const removed = [];
  for (const root of STATE_CLEANUP_ROOTS) {
    assertNoReparse(root, { allowMissing: true });
    if (!pathExists(root)) continue;
    const dirs = rglob(root).filter(pathIsDir);
    const ordered = dirs.map((item, index) => ({ item, index, depth: relativeParts(item, path3.parse(String(item)).root).length })).sort((a, b) => b.depth - a.depth || a.index - b.index).map((entry) => entry.item);
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
  safePreparationPath(safe);
  treeIssue = preparationTreeIssue(safe);
  if (treeIssue) throw new ToolError(treeIssue);
}
function applyCandidates(candidates) {
  const deleted = [];
  const errors = [];
  const deletedSet = /* @__PURE__ */ new Set();
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
    deleted_bytes: candidates.filter((item) => deletedSet.has(String(item.path))).reduce((sum, item) => sum + Number(item.bytes), 0),
    deleted: deleted.slice(0, 50),
    removed_dirs: removeEmptyDirs().slice(0, 50),
    errors
  };
}
function buildData(args) {
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
  if (args.apply && !issues.length) applied = applyCandidates(candidates);
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
      items: candidates.slice(0, 50)
    },
    applied
  };
}
function buildText(data) {
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
    "## Precheck Issues"
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
  return `${lines.join("\n")}
`;
}

// ops/tools/runtime_retention.mjs
var PROGRAM = "runtime_retention.mjs";
var USAGE = `usage: ${PROGRAM} [-h] [--apply] [--task-root TASK_ROOT] [--self-test] [--format {text,json}]`;
var DESCRIPTION = "\u6E05\u7406\u8FD0\u884C\u6001\u65E7\u6587\u4EF6\uFF1A.runtime/cockpit/state/ \u4E0B\u7684\u65E7\u8FD0\u884C\u6001\u6587\u4EF6\u3001.runtime/cockpit/async_tasks/ \u4E0B\u7EC8\u6001\u8D85\u8FC7 7 \u5929\u7684\u4EFB\u52A1\u76EE\u5F55\u3001tmp/dispatch_prepare/ \u4E0B\u8D85\u8FC7 7 \u5929\u7684\u4EFB\u52A1\u5305\u6587\u4EF6\uFF0C\u4EE5\u53CA\u8FD9\u4E9B\u4EFB\u52A1\u5BF9\u5E94\u7684\u7528\u6237\u7EA7\u5B9A\u4F4D\u7D22\u5F15\u3002\u672C\u5DE5\u5177\u53EA\u8D1F\u8D23\u6E05\u573A\u3002";
var OPTIONS = [
  { flag: "--apply", dest: "apply", kind: "flag", help: "\u5B9E\u9645\u5220\u9664\u5019\u9009\u6587\u4EF6\uFF1B\u9ED8\u8BA4\u53EA\u9884\u89C8\u3002" },
  { flag: "--task-root", dest: "taskRoot", kind: "value", metavar: "TASK_ROOT", help: "\u8986\u76D6 async \u4EFB\u52A1\u6839\uFF1B\u4F18\u5148\u7EA7\u9AD8\u4E8E SUBAGENT_TASK_ROOT \u548C\u4ED3\u5185\u9ED8\u8BA4\u3002" },
  { flag: "--self-test", dest: "selfTest", kind: "flag", help: "\u8FD0\u884C\u9694\u79BB\u7684 registry \u751F\u547D\u5468\u671F\u56DE\u5F52\u540E\u9000\u51FA\u3002" },
  { flag: "--format", dest: "format", kind: "value", metavar: "{text,json}", choices: ["text", "json"], help: "\u8F93\u51FA\u683C\u5F0F\u3002\uFF08\u9ED8\u8BA4\uFF1Ajson\uFF09" }
];
var ArgumentError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgumentError";
  }
};
var HelpRequested = class extends Error {
};
function helpText() {
  const lines = [USAGE, "", DESCRIPTION, "", "options:", "  -h, --help            show this help message and exit"];
  for (const option of OPTIONS) {
    const invocation = option.kind === "value" ? `${option.flag} ${option.metavar}` : option.flag;
    lines.push(`  ${invocation}`);
    lines.push(`      ${option.help}`);
  }
  return `${lines.join("\n")}
`;
}
function matchOption(token) {
  const exact = OPTIONS.find((option) => option.flag === token);
  if (exact) return exact;
  const prefixed = OPTIONS.filter((option) => option.flag.startsWith(token));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new ArgumentError(`ambiguous option: ${token} could match ${prefixed.map((option) => option.flag).join(", ")}`);
  }
  return null;
}
function parseArgs(argv) {
  const args = { apply: false, taskRoot: "", selfTest: false, format: "json" };
  const tokens = [...argv];
  while (tokens.length) {
    const token = tokens.shift();
    if (token === "-h" || token === "--help") throw new HelpRequested();
    if (!token.startsWith("--")) throw new ArgumentError(`unrecognized arguments: ${token}`);
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    const inline = equals >= 0 ? token.slice(equals + 1) : null;
    const option = matchOption(name);
    if (!option) throw new ArgumentError(`unrecognized arguments: ${token}`);
    if (option.kind === "flag") {
      if (inline !== null) throw new ArgumentError(`argument ${option.flag}: ignored explicit argument '${inline}'`);
      args[option.dest] = true;
      continue;
    }
    let value = inline;
    if (value === null) {
      if (!tokens.length) throw new ArgumentError(`argument ${option.flag}: expected one argument`);
      value = tokens.shift();
    }
    if (option.choices && !option.choices.includes(value)) {
      throw new ArgumentError(
        `argument ${option.flag}: invalid choice: '${value}' (choose from ${option.choices.map((item) => `'${item}'`).join(", ")})`
      );
    }
    args[option.dest] = value;
  }
  return args;
}
function main(argv) {
  const args = parseArgs(argv);
  try {
    if (args.selfTest) return emit(selfTest(), args.format, "runtime_retention self-test: pass\n");
    if (args.taskRoot) setAsyncTasksDir(resolveAsyncTasksDir(args.taskRoot));
    const data = buildData(args);
    return emit(data, args.format, buildText(data));
  } catch (error) {
    if (!(error instanceof ToolError || error?.name === "ToolError")) throw error;
    return emit(
      { tool: "runtime_retention", status: "failed", exit_code: 1, error: error.message },
      "text",
      `failed: ${error.message}`
    );
  }
}
try {
  process4.exitCode = main(process4.argv.slice(2));
} catch (error) {
  if (error instanceof HelpRequested) {
    process4.stdout.write(helpText());
    process4.exitCode = 0;
  } else if (error instanceof ArgumentError) {
    process4.stderr.write(`${USAGE}
${PROGRAM}: error: ${error.message}
`);
    process4.exitCode = 2;
  } else {
    throw error;
  }
}
export {
  main,
  parseArgs
};
