// ops/tools/dispatch_prepare.py 的 JS 复刻：派发编译器的编排层。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」；导出函数名为 Python 名的 camelCase，
// Python 关键字参数作为末尾一个 options 对象（键名 camelCase）。
//
// 异常映射表（Python 分支 → JS）：
//   ToolError(msg)                      → ToolError(msg)，消息逐字
//   PreparedDispatchError               → PreparedDispatchError（prepared_dispatch.mjs 导出），
//                                         prepare_async_subagent 内按 Python 同样收束为 ToolError
//   json.JSONDecodeError                → pyJsonLoads 抛出的 name="JSONDecodeError" 错误，
//                                         load_seeds / call_async_internal_adapter 按 Python 收束为 ToolError
//   KeyError（package["task_package"] 等裸下标） → pyGetItem 抛出的 name="KeyError"，message 是键的 repr
//   OSError（读文件 / 子进程启动失败）   → Node 系统错误（error.code/errno），批量与 CLI 顶层按
//                                         Python 的 except 元组一并捕获（isPyCaughtError）
//   UnicodeDecodeError（--seed 文件解码） → 与 Python 同分支收束为 ToolError，文案逐字
//   subprocess.TimeoutExpired           → spawnSync 的 ETIMEDOUT，收束为 Python 对应的 ToolError 文案
//
// 注入面：pytest 里被 monkeypatch 的模块级名字集中在导出的可变对象 `deps`；
// lru_cache 用模块级 Map，统一由 clearCaches() 清空。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  ROOT,
  RUNTIME_ROOT,
  ToolError,
  clock,
  emit,
  homeDir,
  ids,
  isAbsoluteLikePython,
  isRecord,
  lexicalAbsolute,
  loadRoleConfig,
  modelConfigSources,
  normalizeConflictPath,
  pathConflict,
  pathlibJoin,
  readStdinText,
  rel,
  resolveLikePython,
} from "./_tool_common.mjs";
import {
  PY_SPACE_CLASS,
  pyGetItem,
  pyIsRelativeTo,
  pyJsonLoads,
  pyRepr,
  pySamePath,
  pySpawnSync,
  pySplitLines,
  pyStr,
  pyStrip,
  pyTruthy,
} from "./_py.mjs";
import { parse as parseToml } from "smol-toml";
import {
  CATALOG_CACHE_FILE_NAME,
  CATALOG_CACHE_SCHEMA,
  catalogCacheKey,
  fingerprintPaths,
  readCatalogCacheEntry,
  writeCatalogCacheEntry,
} from "./model_catalog_cache.mjs";

import { BUILD_LOG_PATH, ensureAgentPanel } from "./agent_panel_launcher.mjs";
import {
  DISPATCH_CONTRACT_VERSION as PREPARED_DISPATCH_CONTRACT_VERSION,
  PreparedDispatchError,
  compilePreparedDispatch,
  verifyPreparedDispatch,
} from "./prepared_dispatch.mjs";
import {
  PROFILE as EVIDENCE_ONLY_PROFILE,
  SEMANTIC_PROFILE as SEMANTIC_REVIEW_PROFILE,
  attachReviewEvidence,
  isStaticReview,
} from "./review_evidence.mjs";
import {
  cardFor,
  exampleSeed,
  expandSeed,
  listCards,
  profileFor,
  renderTemplate,
  routesWithCards,
} from "./seed_minimal.mjs";
import { readRequiredFiles, renderTaskMaterialFile, roleDeveloperInstructions } from "./subagent_preload.mjs";
import { buildPackage, gitValue, parseSeed, sampleSeed, truthyText } from "./task_package_build.mjs";
export { truthyText };
import { lintPackage } from "./task_package_lint.mjs";
import { conditionalRequiredFiles, routeIdFromAgent } from "./task_package_profiles.mjs";
import { PI_CHILD_MODEL_EXTENSION_PROFILE, resolvePiAgentDir, resolvePiChildModelExtensions } from "../pi_model_extension_profile.mjs";
import { loadSelectionConfig, resolveSelection, resolveWorkerResources } from "./model_selection.mjs";
import { defaultOnTools, loadWorkerResourcesConfig } from "../pi_worker_resources.mjs";

export {
  EVIDENCE_ONLY_PROFILE,
  PREPARED_DISPATCH_CONTRACT_VERSION,
  PreparedDispatchError,
  ROOT,
  RUNTIME_ROOT,
  SEMANTIC_REVIEW_PROFILE,
  ToolError,
  attachReviewEvidence,
  buildPackage,
  cardFor,
  compilePreparedDispatch,
  conditionalRequiredFiles,
  emit,
  exampleSeed,
  expandSeed,
  isStaticReview,
  listCards,
  lintPackage,
  parseSeed,
  profileFor,
  readStdinText,
  rel,
  renderTaskMaterialFile,
  renderTemplate,
  routeIdFromAgent,
  routesWithCards,
  sampleSeed,
  verifyPreparedDispatch,
};

export const PREFLIGHT_FILE_THRESHOLD = 400;
export const PREFLIGHT_BYTES_THRESHOLD = 10 * 1024 * 1024;
export const PREFLIGHT_LARGE_FILE_BYTES = 2 * 1024 * 1024;
export const PREFLIGHT_WALK_SKIP_DIRS = new Set([".git", ".runtime", "node_modules", "__pycache__", "tmp"]);
export const PREFLIGHT_WALK_SKIP_PATHS = [["ops", "dist"]];
export const PREFLIGHT_GIT_TIMEOUT_SECONDS = 15;
export const PREFLIGHT_STAT_FILE_CAP = 20000;
export const PREFLIGHT_BINARY_LIKE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".7z",
  ".dwg", ".dxf", ".step", ".stp", ".iges", ".igs",
  ".exe", ".dll", ".bin", ".dat", ".mp4", ".avi",
]);
export const ASYNC_MCP_SERVER_NAME = "asyncSubagent";
export const ASYNC_DISPATCH_CONTRACT_VERSION = PREPARED_DISPATCH_CONTRACT_VERSION;
export const CROSS_REPO_RESULT_MODES = new Set(["read_only_audit", "simulated_planning", "real_rerun"]);
export const ACCEPTANCE_SYNTHESIS_PROFILE = "acceptance_synthesis_v1";
// 裸 basename 哨兵：async 服务端把它解析为自身部署形态内的可信 runner
// （仓内=tools/ 源文件，部署槽=随 release 发布的 bundle）。
export const PI_ASYNC_RUNNER_SENTINEL = "run-pi-task.mjs";
// Resolve the user-level config only when a submit/preview readiness path asks for it;
// prepare-only must not touch the home directory or user MCP configuration.
export const GLOBAL_CONFIG_PATH = null;
export const PROJECT_ASYNC_TASK_ROOT = path.join(ROOT, ".runtime", "cockpit", "async_tasks");

// ---- 注入面与缓存 ----

/** pytest 里被 monkeypatch 的模块级名字集中于此；测试通过替换 deps.xxx 注入替身。 */
export const deps = {
  // Python GLOBAL_CONFIG_PATH（Path | None）
  globalConfigPath: null,
  ensureAgentPanel,
  walk: walkDir,
  agentConfigEntry: agentConfigEntryImpl,
  piChildCatalogCommand: piChildCatalogCommandImpl,
  piChildModelExtensionProfile: piChildModelExtensionProfileImpl,
  probePiChildModelCatalogUncached: probePiChildModelCatalogUncachedImpl,
  probePiChildModelCatalog: probePiChildModelCatalogImpl,
  callAsyncInternalAdapter: callAsyncInternalAdapterImpl,
  asyncSubagentServer: asyncSubagentServerImpl,
  asyncSubagentEndpoint: asyncSubagentEndpointImpl,
  asyncSubagentReadiness: asyncSubagentReadinessImpl,
  resolveDelivery: resolveDeliveryImpl,
  compilePreparedDispatch,
  verifyPreparedDispatch,
  attachReviewEvidence,
};

const caches = {
  asyncSubagentServer: new Map(),
  asyncSubagentEndpoint: new Map(),
  asyncSubagentReadiness: new Map(),
  piChildModelExtensionProfile: new Map(),
  childModelCatalog: new Map(),
};

/** 等价于 Python 各 lru_cache 的 cache_clear() 全量调用。 */
export function clearCaches() {
  for (const cache of Object.values(caches)) cache.clear();
}

/** 只清 probe_pi_child_model_catalog 的缓存（Python 的 cache_clear()）。 */
export function clearModelCatalogCache() {
  caches.childModelCatalog.clear();
}

// ---- Python 语义小工具（本模块私有；建议上提的已在回报里登记） ----

const PY_SPLIT_RE = new RegExp(`[${PY_SPACE_CLASS}]+`);

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedStrings(values) {
  return [...values].sort(compareCodePoints);
}

/** Python str[:n]：按码位切片，不是 UTF-16 单元。 */
function pySlice(value, limit) {
  return Array.from(String(value)).slice(0, limit).join("");
}

/** Python `list(x)`：序列取元素，字符串取字符，映射取键，其余空列表。 */
function pyList(value) {
  if (Array.isArray(value)) return [...value];
  if (typeof value === "string") return Array.from(value);
  if (isRecord(value)) return Object.keys(value);
  return [];
}

/** Node 的 fs 系统错误 / Python OSError 的判定。 */
function isSystemError(error) {
  return Boolean(error) && typeof error.code === "string" && (error.errno !== undefined || error.syscall !== undefined);
}

/** Python `except (ToolError, KeyError, ValueError, OSError)` 的 JS 对应判定。 */
function isPyCaughtError(error, names) {
  if (!error) return false;
  if (names.has(String(error.name))) return true;
  return names.has("OSError") && isSystemError(error);
}

function statOrNull(target) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

function isFile(target) {
  return Boolean(statOrNull(target)?.isFile());
}

function isDirectory(target) {
  return Boolean(statOrNull(target)?.isDirectory());
}

/** PurePath.parts 的相对形态；"" 与 "." 段丢弃。 */
function pathParts(value) {
  return String(value ?? "").split(/[\\/]+/).filter((part) => part && part !== ".");
}

/** json.dumps(value, ensure_ascii=False, indent=2)：不排序键。 */
function jsonDumpsIndent2(value) {
  return JSON.stringify(value, null, 2);
}

/** json.dumps(value, ensure_ascii=False, separators=(",", ":")) */
function jsonDumpsCompact(value) {
  return JSON.stringify(value);
}

/** shutil.which()：按 PATH（Windows 上叠加 PATHEXT）查可执行文件。 */
function shutilWhich(name) {
  const candidate = String(name ?? "");
  if (!candidate) return null;
  const isWindows = process.platform === "win32";
  const exts = isWindows
    ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExt = isWindows && exts.some((ext) => candidate.toLowerCase().endsWith(ext.toLowerCase()));
  const names = isWindows && !hasExt ? exts.map((ext) => candidate + ext) : [candidate];
  if (candidate.includes("/") || candidate.includes("\\")) {
    for (const item of names) if (isFile(item)) return item;
    return null;
  }
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (isWindows) dirs.unshift(process.cwd());
  for (const dir of dirs) {
    for (const item of names) {
      const full = path.join(dir, item);
      if (isFile(full)) return full;
    }
  }
  return null;
}

// ---- 用户级配置 ----

export function defaultRegistryRoot() {
  return path.join(homeDir(), ".subagent-control", "async_task_registry");
}

function configSource(_configPath) {
  return "global";
}

function configBase(configPath) {
  return path.dirname(String(configPath));
}

function resolveConfigPath(configPath, value) {
  const raw = String(value || ".");
  if (isAbsoluteLikePython(raw)) return resolveLikePython(raw);
  return resolveLikePython(pathlibJoin(configBase(configPath), raw));
}

export function _serverFromConfig(configPath) {
  const config = loadToml(configPath);
  const rawServers = isRecord(config.mcp_servers) ? config.mcp_servers : {};
  const serverName = ASYNC_MCP_SERVER_NAME;
  const server = rawServers[serverName];
  if (!isRecord(server)) return null;
  const args = Array.isArray(server.args) ? server.args : [];
  const env = isRecord(server.env) ? server.env : {};
  return {
    source: configSource(configPath),
    config_path: String(configPath),
    server_name: serverName,
    command: pyStr(pyTruthy(server.command) ? server.command : ""),
    args: args.map((item) => pyStr(item)),
    cwd: String(resolveConfigPath(configPath, pyStr(pyTruthy(server.cwd) ? server.cwd : "."))),
    env: Object.fromEntries(Object.entries(env).map(([key, value]) => [String(key), pyStr(value)])),
    approval_mode: pyStr(pyTruthy(server.default_tools_approval_mode) ? server.default_tools_approval_mode : ""),
  };
}

function asyncSubagentServerImpl() {
  // COCKPIT_GLOBAL_CONFIG:沙箱/测试用的用户级配置替身(绝对路径)。未设时行为与历来一致。
  const envConfig = pyStrip(String(process.env.COCKPIT_GLOBAL_CONFIG || ""));
  const globalConfig = deps.globalConfigPath || (envConfig || path.join(homeDir(), ".codex", "config.toml"));
  return _serverFromConfig(globalConfig);
}

export function asyncSubagentServer() {
  if (!caches.asyncSubagentServer.has("value")) {
    caches.asyncSubagentServer.set("value", deps.asyncSubagentServer());
  }
  return caches.asyncSubagentServer.get("value");
}

export function selectAsyncSubagentServer(projectServer, globalServer) {
  // Project registrations do not select the shared async service.
  return globalServer;
}

export function asyncServerScriptPath(server) {
  const cwd = resolveLikePython(pyStr(pyTruthy(server?.cwd) ? server.cwd : ROOT));
  for (const arg of (pyTruthy(server?.args) ? server.args : [])) {
    if (pyStr(arg).endsWith(".mjs")) {
      const candidate = pyStr(arg);
      return isAbsoluteLikePython(candidate) ? resolveLikePython(candidate) : resolveLikePython(pathlibJoin(cwd, candidate));
    }
  }
  return null;
}

function asyncSubagentEndpointImpl() {
  const server = asyncSubagentServer();
  return [server, server ? asyncServerScriptPath(server) : null];
}

export function asyncSubagentEndpoint() {
  if (!caches.asyncSubagentEndpoint.has("value")) {
    caches.asyncSubagentEndpoint.set("value", deps.asyncSubagentEndpoint());
  }
  return caches.asyncSubagentEndpoint.get("value");
}

export function asyncServerEnv(server) {
  return { ...process.env, ...(pyTruthy(server?.env) ? server.env : {}) };
}

// ---- scope 预检 ----

function preflightPathIsSkipped(relative, { directory }) {
  const all = pathParts(relative);
  const parts = directory ? all : all.slice(0, -1);
  if (parts.some((part) => PREFLIGHT_WALK_SKIP_DIRS.has(part))) return true;
  return PREFLIGHT_WALK_SKIP_PATHS.some(
    (prefix) => prefix.length <= all.length && prefix.every((part, index) => all[index] === part),
  );
}

function preflightGitRoot(baseRoot) {
  let completed;
  try {
    completed = spawnSync("git", ["-C", String(baseRoot), "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: PREFLIGHT_GIT_TIMEOUT_SECONDS * 1000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (completed.error) return null;
  const stdout = String(completed.stdout ?? "");
  if (completed.status !== 0 || !pyStrip(stdout)) return null;
  const root = resolveLikePython(pyStrip(stdout));
  return isDirectory(root) ? root : null;
}

function preflightGitFiles(directory, gitRoot) {
  let relative;
  try {
    relative = relativePartsOrThrow(resolveLikePython(directory), resolveLikePython(gitRoot));
  } catch {
    return null;
  }
  const argv = ["-C", String(gitRoot), "ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  if (relative.length) argv.push("--", relative.join("/"));
  let completed;
  try {
    completed = spawnSync("git", argv, {
      timeout: PREFLIGHT_GIT_TIMEOUT_SECONDS * 1000,
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (completed.error) return null;
  if (completed.status !== 0) return null;
  const files = [];
  const raw = Buffer.isBuffer(completed.stdout) ? completed.stdout : Buffer.from(String(completed.stdout ?? ""));
  for (const chunk of raw.toString("utf8").split("\0")) {
    if (!chunk) continue;
    if (preflightPathIsSkipped(chunk, { directory: false })) continue;
    const candidate = path.join(String(gitRoot), chunk);
    try {
      relativePartsOrThrow(resolveLikePython(candidate), resolveLikePython(directory));
    } catch {
      continue;
    }
    if (isFile(candidate)) files.push(candidate);
  }
  return files;
}

/** Path.relative_to()：不在子路径时抛错，用于复刻 Python 的 try/except ValueError 分支。 */
function relativePartsOrThrow(child, parent) {
  if (!pyIsRelativeTo(child, parent)) throw new Error("not relative");
  return pathParts(child).slice(pathParts(parent).length);
}

/** os.walk(top, onerror=...) 的生成器复刻：调用方可就地修改 frame.dirnames 剪枝。 */
function* walkDir(top, onError) {
  const stack = [String(top)];
  while (stack.length) {
    const dirpath = stack.pop();
    let entries;
    try {
      entries = readdirSync(dirpath, { withFileTypes: true });
    } catch (error) {
      if (onError) onError(error, dirpath);
      continue;
    }
    const dirnames = [];
    const filenames = [];
    for (const entry of entries) {
      if (entry.isDirectory()) dirnames.push(entry.name);
      else filenames.push(entry.name);
    }
    const frame = { dirpath, dirnames, filenames };
    yield frame;
    for (let index = frame.dirnames.length - 1; index >= 0; index -= 1) {
      stack.push(path.join(dirpath, frame.dirnames[index]));
    }
  }
}

export function computeScopePreflight(readPaths, { baseRoot = ROOT } = {}) {
  let fileCount = 0;
  let totalBytes = 0;
  let largeFileCount = 0;
  let binaryLikeCount = 0;
  let truncated = false;
  let urlCount = 0;
  const missingPaths = [];
  const unreadablePaths = [];
  const resolvedBaseRoot = resolveLikePython(baseRoot);
  const gitRoot = preflightGitRoot(resolvedBaseRoot);

  const accountFile = (target) => {
    if (fileCount >= PREFLIGHT_STAT_FILE_CAP) {
      truncated = true;
      return false;
    }
    let size;
    try {
      size = statSync(target).size;
    } catch (error) {
      unreadablePaths.push(`${target}: ${error.message}`);
      return true;
    }
    fileCount += 1;
    totalBytes += size;
    if (size > PREFLIGHT_LARGE_FILE_BYTES) largeFileCount += 1;
    if (PREFLIGHT_BINARY_LIKE_EXTENSIONS.has(path.extname(String(target)).toLowerCase())) binaryLikeCount += 1;
    return true;
  };

  const recordWalkError = (error, filename) => {
    unreadablePaths.push(`${filename || baseRoot}: ${error.message}`);
  };

  for (const raw of readPaths) {
    if (truncated) break;
    const lowered = pyStrip(raw).toLowerCase();
    if (lowered.startsWith("http://") || lowered.startsWith("https://")) {
      urlCount += 1;
      continue;
    }
    const candidate = String(raw);
    const resolved = isAbsoluteLikePython(candidate) ? candidate : pathlibJoin(resolvedBaseRoot, candidate);
    let info;
    try {
      info = existsSync(resolved) ? statSync(resolved) : null;
    } catch (error) {
      unreadablePaths.push(`${raw}: ${error.message}`);
      continue;
    }
    if (!info) {
      missingPaths.push(raw);
      continue;
    }
    if (info.isFile()) {
      if (!accountFile(resolved)) break;
      continue;
    }
    if (!info.isDirectory()) {
      unreadablePaths.push(`${raw}: path is neither a regular file nor a directory`);
      continue;
    }
    const gitFiles = gitRoot !== null ? preflightGitFiles(resolved, gitRoot) : null;
    if (gitFiles !== null) {
      for (const item of gitFiles) {
        if (!accountFile(item)) break;
      }
      continue;
    }
    for (const frame of deps.walk(resolved, recordWalkError)) {
      let currentRelative;
      try {
        currentRelative = relativePartsOrThrow(resolveLikePython(frame.dirpath), resolvedBaseRoot).join("/");
      } catch {
        currentRelative = "";
      }
      frame.dirnames = frame.dirnames.filter(
        (name) => !preflightPathIsSkipped(currentRelative ? `${currentRelative}/${name}` : name, { directory: true }),
      );
      let stop = false;
      for (const name of frame.filenames) {
        if (!accountFile(path.join(frame.dirpath, name))) {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }
  }

  const result = {
    scope_file_count: fileCount,
    scope_total_bytes: totalBytes,
    scope_large_file_count: largeFileCount,
    scope_binary_like_count: binaryLikeCount,
    scope_stat_truncated: truncated,
    scope_url_count: urlCount,
    scope_missing_paths: missingPaths,
    scope_unreadable_paths: unreadablePaths,
    scope_preflight_warning: null,
  };
  if (fileCount > PREFLIGHT_FILE_THRESHOLD || totalBytes > PREFLIGHT_BYTES_THRESHOLD) {
    result.scope_preflight_warning = `scope.read 预估 ${fileCount} 个文件、${totalBytes} 字节，超出预警阈值`
      + `（文件 ${PREFLIGHT_FILE_THRESHOLD} / 字节 ${PREFLIGHT_BYTES_THRESHOLD}）；`
      + "建议按 ops/skills/subagent-fleet-discipline/references/parallel-slicing.md 的产能规格拆分";
  }
  return result;
}

export function enforceScopePreflight(scopePreflight) {
  const missing = pyList(pyTruthy(scopePreflight?.scope_missing_paths) ? scopePreflight.scope_missing_paths : []).map(pyStr);
  const unreadable = pyList(pyTruthy(scopePreflight?.scope_unreadable_paths) ? scopePreflight.scope_unreadable_paths : []).map(pyStr);
  return [
    ...(missing.length ? [`scope.read path does not exist: ${missing.join(", ")}`] : []),
    ...(unreadable.length ? [`scope.read path is not readable: ${unreadable.join("; ")}`] : []),
  ];
}

// A7：读作用域分层。read_scope_layers 为可选 seed 字段。entry 必读全文；index 只列目录/清单；
// deep 仅命中 when 才深入（项形如 {"path","when"}）；deferred 默认禁读。scope_preflight 只统计 entry+index。
export function readScopeLayersFromSeed(seed) {
  const layers = seed?.read_scope_layers;
  if (!isRecord(layers)) return null;

  const strings = (key) => pyList(pyTruthy(layers[key]) ? layers[key] : [])
    .filter((item) => typeof item === "string" && pyStrip(item));

  const deep = [];
  for (const item of pyList(pyTruthy(layers.deep) ? layers.deep : [])) {
    if (isRecord(item) && typeof item.path === "string" && pyStrip(item.path)) {
      deep.push({ path: item.path, when: pyStr(pyTruthy(item.when) ? item.when : "") });
    } else if (typeof item === "string" && pyStrip(item)) {
      deep.push({ path: item, when: "" });
    }
  }
  return { entry: strings("entry"), index: strings("index"), deep, deferred: strings("deferred") };
}

export function preflightReadPaths(layers, fallbackRead) {
  if (layers === null || layers === undefined) return [...pyList(fallbackRead)];
  return [...pyGetItem(layers, "entry"), ...pyGetItem(layers, "index")];
}

export function renderReadScopeLayers(layers) {
  const lines = ["分层读取指令（read_scope_layers）："];
  lines.push("- entry：必读全文。");
  for (const item of pyGetItem(layers, "entry")) lines.push(`  - ${item}`);
  lines.push("- index：只列目录/清单，不读文件内容。");
  for (const item of pyGetItem(layers, "index")) lines.push(`  - ${item}`);
  lines.push("- deep：仅命中 when 条件才深入。");
  for (const item of pyGetItem(layers, "deep")) lines.push(`  - ${item.path}（when: ${item.when}）`);
  lines.push("- deferred：默认禁读；读前必须在报告说明理由。");
  for (const item of pyGetItem(layers, "deferred")) lines.push(`  - ${item}`);
  return lines.join("\n");
}

export function seedBudget(seed) {
  const raw = seed?.budget;
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) throw new ToolError("seed.budget must be an object with max_elapsed_minutes");
  const out = {};
  // 预算只有墙钟时限；旧种子里的 max_tool_calls 不再解析（空转熔断与时限覆盖失控场景）。
  for (const key of ["max_elapsed_minutes"]) {
    if (Object.hasOwn(raw, key) && raw[key] !== null && raw[key] !== undefined) {
      const value = raw[key];
      if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
        throw new ToolError(`seed.budget.${key} must be a positive number`);
      }
      out[key] = value;
    }
  }
  return out;
}

// ---- 写冲突 ----

export function conflictPaths(value) {
  if (typeof value === "string") return pyStrip(value) ? [value] : [];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && pyStrip(item)).map(String);
  return [];
}

export function seedWriteConflictPaths(seed) {
  const scope = isRecord(seed?.scope) ? seed.scope : {};
  const expected = isRecord(seed?.expected_output) ? seed.expected_output : {};
  const handoff = isRecord(seed?.handoff_contract) ? seed.handoff_contract : {};
  const concurrency = isRecord(seed?.concurrency_contract) ? seed.concurrency_contract : {};
  const conflictKeys = isRecord(concurrency.conflict_keys) ? concurrency.conflict_keys : {};
  const rawPaths = [];
  rawPaths.push(...conflictPaths(scope.write));
  rawPaths.push(...conflictPaths(scope.write_extra));
  rawPaths.push(...conflictPaths(scope.delete));
  rawPaths.push(...conflictPaths(conflictKeys.write));
  rawPaths.push(...conflictPaths(conflictKeys.delete));
  rawPaths.push(...conflictPaths(conflictKeys.output));
  for (const key of ["file_path", "path", "resolved_file_path"]) {
    rawPaths.push(...conflictPaths(expected[key]));
  }
  rawPaths.push(...conflictPaths(handoff.handoff_file));
  rawPaths.push(...conflictPaths(handoff.resolved_handoff_file));
  const normalized = new Set();
  for (const item of rawPaths) {
    const value = normalizeConflictPath(item);
    if (value) normalized.add(value);
  }
  return sortedStrings(normalized);
}

export function batchWriteConflicts(seeds) {
  const rows = seeds.map((seed, idx) => ({
    seed_index: idx + 1,
    route_id: pyStr(pyTruthy(seed?.route_id) ? seed.route_id : ""),
    write_paths: seedWriteConflictPaths(seed),
  }));
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    const left = rows[leftIndex];
    for (const right of rows.slice(leftIndex + 1)) {
      const hits = [];
      for (const leftPath of left.write_paths) {
        for (const rightPath of right.write_paths) {
          if (pathConflict(leftPath, rightPath)) hits.push({ left: leftPath, right: rightPath });
        }
      }
      if (hits.length) {
        conflicts.push({
          left_seed_index: left.seed_index,
          right_seed_index: right.seed_index,
          left_route_id: left.route_id,
          right_route_id: right.route_id,
          conflicts: hits,
        });
      }
    }
  }
  return conflicts;
}

// ---- seed 输入 ----

export function readSeedFileText(target) {
  let rawBytes;
  try {
    rawBytes = readFileSync(String(target));
  } catch (error) {
    const detail = systemErrorText(error);
    throw new ToolError(`cannot read --seed file: ${target}: ${detail}`);
  }
  const stripped = rawBytes.length >= 3 && rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf
    ? rawBytes.subarray(3)
    : rawBytes;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stripped);
  } catch {
    // utf-8-sig 失败，回退 utf-16（Python 的 utf-16 需要 BOM 判定字节序）。
  }
  if (rawBytes.length >= 2 && rawBytes[0] === 0xff && rawBytes[1] === 0xfe && rawBytes.length % 2 === 0) {
    return rawBytes.subarray(2).toString("utf16le");
  }
  if (rawBytes.length >= 2 && rawBytes[0] === 0xfe && rawBytes[1] === 0xff && rawBytes.length % 2 === 0) {
    const swapped = Buffer.from(rawBytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  throw new ToolError(`--seed file invalid encoding; expected UTF-8 (with or without BOM) or UTF-16: ${target}`);
}

/** Python OSError 的 strerror（拿不到时退回消息全文）。 */
function systemErrorText(error) {
  const map = {
    ENOENT: "No such file or directory",
    EACCES: "Permission denied",
    EISDIR: "Is a directory",
    ENOTDIR: "Not a directory",
    EPERM: "Operation not permitted",
    EMFILE: "Too many open files",
  };
  return map[error?.code] || String(error?.message ?? error);
}

export function expandDispatchSeed(seed) {
  const expanded = expandSeed(parseSeed(JSON.stringify(seed)));
  for (const key of ["slice_id", "slug", "title"]) {
    const value = seed?.[key];
    if (value !== null && value !== undefined && value !== "") expanded[key] = value;
  }
  return expanded;
}

export function loadSeeds(args) {
  const sources = [Boolean(pyTruthy(args?.seed)), Boolean(pyTruthy(args?.seed_stdin)), Boolean(pyTruthy(args?.sample_route))];
  if (sources.filter(Boolean).length !== 1) {
    throw new ToolError("provide exactly one of --seed, --seed-stdin or --sample-route");
  }
  if (pyTruthy(args.sample_route)) return [sampleSeed(args.sample_route)];
  const raw = pyTruthy(args.seed_stdin) ? readStdinText("--seed-stdin") : readSeedFileText(args.seed);
  let data;
  try {
    data = pyJsonLoads(raw);
  } catch (error) {
    if (error?.name === "JSONDecodeError") throw new ToolError(`seed JSON invalid: ${error.message}`);
    throw error;
  }
  if (Array.isArray(data)) {
    if (!data.length) throw new ToolError("seed array is empty");
    return data.map((item) => expandDispatchSeed(item));
  }
  return [expandDispatchSeed(data)];
}

export function lintOrFail(pkg) {
  // 此入口消费本编译链的buildPackage产物；独立lintPackage默认保留全检。
  const issues = lintPackage(pkg, { compiled: true });
  if (issues.length) throw new ToolError(`task package lint failed: ${issues.join("; ")}`);
}

export function packagePathForTemp(pkg) {
  const taskPackage = pyGetItem(pkg, "task_package");
  const packageId = pyStr(pyTruthy(taskPackage.package_id) ? taskPackage.package_id : "package");
  const safe = pySlice(
    Array.from(packageId).map((ch) => (/[\p{L}\p{N}]/u.test(ch) || "._-".includes(ch) ? ch : "-")).join(""),
    120,
  );
  const target = path.join(ROOT, "tmp", "dispatch_prepare", `${safe}-${ids.uuidHex()}.task-package.json`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${jsonDumpsCompact(pkg)}\n`, "utf8");
  return target;
}

export function loadToml(target) {
  let text;
  try {
    text = readFileSync(String(target), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new ToolError(`cannot parse toml: ${rel(target)}: ${error.message}`);
  }
  let data;
  try {
    data = parseToml(text);
  } catch (error) {
    throw new ToolError(`cannot parse toml: ${rel(target)}: ${error.message}`);
  }
  return isRecord(data) ? data : {};
}

// ---- 交付就绪 ----

export function resolveDeliveryWithReadiness(delivery, readiness) {
  if (delivery !== "auto" && delivery !== "async-subagent") return [delivery, { status: "not_checked", issues: [] }];
  if (pyGetItem(readiness, "status") === "available") return ["async-subagent", readiness];
  return ["unavailable", readiness];
}

function resolveDeliveryImpl(delivery) {
  if (delivery !== "auto" && delivery !== "async-subagent") return [delivery, { status: "not_checked", issues: [] }];
  return resolveDeliveryWithReadiness(delivery, asyncSubagentReadiness());
}

export function resolveDelivery(delivery) {
  return deps.resolveDelivery(delivery);
}

export function asyncDispatchContractStatus(buildInfo) {
  const current = pyStrip(pyStr(pyTruthy(buildInfo?.dispatch_contract_version) ? buildInfo.dispatch_contract_version : ""));
  const rawSupported = buildInfo?.supported_dispatch_contract_versions;
  let supported = Array.isArray(rawSupported)
    ? rawSupported.map((item) => pyStrip(pyStr(item))).filter((item) => item)
    : [];
  if (!supported.length && current) supported = [current];
  const compatible = supported.includes(ASYNC_DISPATCH_CONTRACT_VERSION);
  let issue = null;
  if (!current) {
    issue = "configured Async MCP build-info is missing dispatch_contract_version";
  } else if (!compatible) {
    issue = `configured Async MCP does not support ${ASYNC_DISPATCH_CONTRACT_VERSION} `
      + `(current=${current}, supported=${pyRepr(supported)}); run `
      + "npm --prefix ops run build:subagent and "
      + "python -B ops/tools/deploy_subagent_bundle.py --apply --format json";
  }
  return {
    current: current || null,
    supported,
    compatible: compatible && Boolean(current),
    issue,
  };
}

function asyncSubagentReadinessImpl() {
  const issues = [];
  const [server, toolPath] = asyncSubagentEndpoint();
  let buildInfo = {};
  let contractStatus = asyncDispatchContractStatus(buildInfo);
  if (!pyTruthy(server)) {
    issues.push(
      "mcp_servers.asyncSubagent is missing from the user-level config (~/.codex/config.toml); "
      + "project-level registration does not select the service; run "
      + "python -B ops/tools/deploy_subagent_bundle.py --apply to publish and register the server",
    );
  } else if (!pyTruthy(server.command)) {
    issues.push("mcp_servers.asyncSubagent.command is empty");
  } else if (server.approval_mode !== "approve") {
    issues.push("mcp_servers.asyncSubagent.default_tools_approval_mode must be approve");
  }
  if (pyTruthy(toolPath) && !isFile(toolPath)) {
    issues.push(`missing async tool: ${toolPath}`);
  } else if (!pyTruthy(toolPath)) {
    issues.push("mcp_servers.asyncSubagent args do not include an .mjs server script");
  }
  if (!issues.length) {
    try {
      buildInfo = deps.callAsyncInternalAdapter("build-info", {});
      contractStatus = asyncDispatchContractStatus(buildInfo);
      if (contractStatus.issue) issues.push(pyStr(contractStatus.issue));
    } catch (error) {
      if (error?.name !== "ToolError") throw error;
      issues.push(`cannot read configured Async MCP build-info: ${error.message}`);
    }
  }
  return {
    status: issues.length ? "unavailable" : "available",
    issues,
    server_source: pyTruthy(server) ? server.source : null,
    registration_policy: "MCP服务使用用户级注册；项目同名注册不参与选址。",
    config_path: pyTruthy(server) ? server.config_path : null,
    server_name: pyTruthy(server) ? server.server_name : null,
    tool_path: pyTruthy(toolPath) ? String(toolPath) : null,
    approval_mode: pyTruthy(server) ? server.approval_mode : null,
    build_id: pyStr(pyTruthy(buildInfo?.build_id) ? buildInfo.build_id : "") || null,
    dispatch_contract_version: contractStatus.current,
    supported_dispatch_contract_versions: contractStatus.supported,
  };
}

export function asyncSubagentReadiness() {
  if (!caches.asyncSubagentReadiness.has("value")) {
    caches.asyncSubagentReadiness.set("value", deps.asyncSubagentReadiness());
  }
  return caches.asyncSubagentReadiness.get("value");
}

// ---- 派发载荷 ----

export function renderDirectFileRefPayload(packagePath) {
  const packageRel = rel(packagePath);
  return [
    `DIRECT_TASK_PACKAGE_FILE: ${packageRel}`,
    "",
    "请先运行以下命令读取完整任务材料，然后只按任务材料执行：",
    `node ops/tools/subagent_preload.mjs render --package ${packageRel}`,
    "",
    "这一步只是读取 direct 启动材料；不要自行扫描 .runtime、notes 或仓库根目录寻找任务包。",
  ].join("\n");
}

export function _validTaskId(taskId) {
  return typeof taskId === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(taskId);
}

// 黄金跑测器把 Python 名转 camelCase 时 `_valid_task_id` → `ValidTaskId`；本别名只服务语料调用。
export { _validTaskId as ValidTaskId };

export function renderAsyncTaskPayload(packagePath, taskId) {
  const packageRel = rel(packagePath);
  return [
    `SUBAGENT_TASK_ID: ${taskId}`,
    `TASK_PACKAGE_FILE: ${packageRel}`,
    "",
    "异步子代理任务已提交；不要另走同步派发。",
    `无其他工作时等一次终态：subagent_wait({"task_id":"${taskId}","timeout_ms":60000})`,
    `终态收轻量回执：subagent_result({"task_id":"${taskId}"})`,
  ].join("\n");
}

function callAsyncInternalAdapterImpl(operation, args) {
  const [server, toolPath] = asyncSubagentEndpoint();
  if (!pyTruthy(server)) {
    throw new ToolError(
      "async subagent MCP server is missing from the user-level config (~/.codex/config.toml); "
      + "register it with python -B ops/tools/deploy_subagent_bundle.py --apply and re-check "
      + "build-info with --delivery auto, or dispatch through the Pi native dispatch_prepare tool, "
      + "which uses the session AsyncTaskService instead of this endpoint",
    );
  }
  if (!pyTruthy(toolPath) || !isFile(toolPath)) {
    throw new ToolError("configured async subagent MCP server script is unavailable");
  }
  const argv = [String(toolPath), "internal", operation];
  for (const [key, value] of Object.entries(args || {})) {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    const flag = `--${key.split("_").join("-")}`;
    if (Array.isArray(value)) argv.push(flag, value.map((item) => pyStr(item)).join(","));
    else if (typeof value === "boolean") {
      if (value) argv.push(flag);
    } else argv.push(flag, pyStr(value));
  }
  const completed = pySpawnSync(pyStr(pyGetItem(server, "command")), argv, {
    cwd: String(pyGetItem(server, "cwd")),
    env: asyncServerEnv(server),
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (completed.error) {
    if (completed.error.code === "ETIMEDOUT") {
      throw new ToolError("async subagent internal submit timed out before returning task_id");
    }
    throw new ToolError("node is not available for async subagent MCP dispatch");
  }
  if (completed.signal === "SIGTERM" && completed.status === null) {
    throw new ToolError("async subagent internal submit timed out before returning task_id");
  }
  const stdout = String(completed.stdout ?? "");
  const stderr = String(completed.stderr ?? "");
  if (completed.status !== 0) {
    throw new ToolError(`async subagent internal adapter failed: ${pySlice(pyStrip(stderr || stdout), 600)}`);
  }
  let response;
  try {
    response = pyJsonLoads(stdout);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    throw new ToolError(`async subagent internal adapter returned invalid JSON: ${pySlice(stdout, 600)}`);
  }
  if (!isRecord(response) || response.ok === false) {
    throw new ToolError(`async subagent internal adapter failed: ${pyStr(response)}`);
  }
  return response;
}

export function callAsyncInternalAdapter(operation, args) {
  return deps.callAsyncInternalAdapter(operation, args);
}

export function prepareDirect(pkg) {
  const taskPackage = pyGetItem(pkg, "task_package");
  const packageId = pyStr(pyTruthy(taskPackage.package_id) ? taskPackage.package_id : "");
  const agent = isRecord(taskPackage.agent) ? taskPackage.agent : {};
  const agentType = pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : (pyTruthy(agent.role) ? agent.role : ""));
  const packagePath = packagePathForTemp(pkg);
  return {
    status: "ok",
    delivery_mode: "direct_message",
    direct_payload_mode: "file_ref",
    package_id: packageId,
    agent_type: agentType,
    task_package_path: rel(packagePath),
    spawn_payload: renderDirectFileRefPayload(packagePath),
  };
}


export function taskToolAllowlist(taskPackage) {
  const contract = isRecord(taskPackage?.tool_contract) ? taskPackage.tool_contract : {};
  const allowed = contract.allowed;
  if (allowed === null || allowed === undefined) return null;
  if (!Array.isArray(allowed) || allowed.some((item) => typeof item !== "string" || !pyStrip(item))) {
    throw new ToolError("task_package.tool_contract.allowed must be null or an array of non-empty Pi tool names");
  }
  return [...new Set(allowed.map((item) => pyStrip(item)))];
}

/**
 * Compile the role × capability worker whitelist into the task package. The role selection is the role tools
 * plus the default_on tools of the import scope; tool_contract.allowed becomes that selection, or the seed list
 * narrowed to it. The result is the final tool surface: the runner only adds the delivery tool.
 * task_package.worker_resources records the extensions / skills / project_skills the runner loads.
 */
export function applyRoleWorkerResources(taskPackage, config, imports) {
  const agent = isRecord(taskPackage.agent) ? taskPackage.agent : {};
  const role = pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : (pyTruthy(agent.role) ? agent.role : ""));
  const capability = isRecord(agent.capability) ? pyStrip(pyStr(pyTruthy(agent.capability.name) ? agent.capability.name : "")) : "";
  const whitelist = resolveWorkerResources(config, role, capability);
  if (whitelist === null) return;
  const declared = taskToolAllowlist(taskPackage);
  const selection = [...new Set([...whitelist.tools, ...defaultOnTools(imports)])];
  taskPackage.tool_contract.allowed = declared === null ? selection : declared.filter((name) => selection.includes(name));
  taskPackage.worker_resources = {
    extensions: whitelist.extensions,
    skills: whitelist.skills,
    project_skills: whitelist.project_skills,
    declared_tools: declared,
    source: { role, capability },
  };
}

export function reviewExecutionProfile(taskPackage) {
  const extensions = isRecord(taskPackage?.extensions) ? taskPackage.extensions : {};
  const review = isRecord(extensions.review_execution) ? extensions.review_execution : {};
  return pyStr(pyTruthy(review.profile) ? review.profile : "");
}

/** Project capability-selected prompt layers from the route profile. */
export function projectConditionalRequiredFiles(taskPackage) {
  const agent = isRecord(taskPackage?.agent) ? taskPackage.agent : {};
  const capability = isRecord(agent.capability) ? agent.capability : {};
  const routeId = `${pyStr(Object.hasOwn(agent, "role") ? agent.role : "")}__${pyStr(Object.hasOwn(capability, "name") ? capability.name : "")}`;
  agent.required_files = conditionalRequiredFiles(taskPackage, profileFor(routeId));
  return null;
}

function agentConfigEntryImpl(agentType) {
  return loadRoleConfig(agentType);
}

export function agentConfigEntry(agentType) {
  return deps.agentConfigEntry(agentType);
}

function piChildCatalogCommandImpl() {
  const configured = pyStrip(String(process.env.PI_CONTROL_PI || ""));
  if (configured) {
    const suffix = path.extname(configured).toLowerCase();
    if ([".js", ".mjs", ".cjs"].includes(suffix)) {
      const node = shutilWhich("node");
      return node ? [node, configured] : [];
    }
    return [configured];
  }
  let executable = process.platform === "win32" ? shutilWhich("pi.cmd") : shutilWhich("pi");
  // Windows 上第二次查 pi+PATHEXT；非 Windows 的同名再查是确定性重复，不再做。
  if (!executable && process.platform === "win32") executable = shutilWhich("pi");
  return executable ? [executable] : [];
}

export function piChildCatalogCommand() {
  return deps.piChildCatalogCommand();
}

/** Resolve the controlled model-provider extensions shared with run-pi-task.mjs. */
function piChildModelExtensionProfileImpl() {
  if (pyStrip(String(process.env.PI_CONTROL_PI || ""))) {
    return { profile: PI_CHILD_MODEL_EXTENSION_PROFILE, extensions: [], error: null };
  }
  let extensions;
  try {
    extensions = resolvePiChildModelExtensions();
  } catch (error) {
    return { profile: PI_CHILD_MODEL_EXTENSION_PROFILE, extensions: [], error: pySlice(String(error?.message ?? error), 500) };
  }
  if (!extensions.every((item) => typeof item === "string" && isAbsoluteLikePython(item) && isFile(item))) {
    return { profile: PI_CHILD_MODEL_EXTENSION_PROFILE, extensions: [], error: "model extension profile returned invalid paths" };
  }
  return { profile: PI_CHILD_MODEL_EXTENSION_PROFILE, extensions, error: null };
}

export function piChildModelExtensionProfile() {
  if (!caches.piChildModelExtensionProfile.has("value")) {
    caches.piChildModelExtensionProfile.set("value", deps.piChildModelExtensionProfile());
  }
  return caches.piChildModelExtensionProfile.get("value");
}

/** Probe the exact controlled-extension Pi model surface used by child RPC sessions. */
function probePiChildModelCatalogUncachedImpl(targetCwd) {
  const command = piChildCatalogCommand();
  const extensionProfile = piChildModelExtensionProfile();
  if (!command.length || pyTruthy(extensionProfile.error)) {
    return {
      status: "unavailable",
      models: [],
      model_count: 0,
      source: "pi --list-models (child model profile)",
      error: pyTruthy(extensionProfile.error) ? extensionProfile.error : "Pi executable not found",
    };
  }
  const argv = [...command.slice(1), "-ne", "-ns", "-np", "--no-themes", "-nc", "--no-approve"];
  for (const extensionPath of extensionProfile.extensions) argv.push("-e", extensionPath);
  argv.push("--list-models");
  const completed = pySpawnSync(command[0], argv, {
    cwd: String(targetCwd),
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (completed.error) {
    return {
      status: "unavailable",
      models: [],
      model_count: 0,
      source: `pi --list-models (${extensionProfile.profile})`,
      error: pySlice(String(completed.error.message ?? completed.error), 500),
    };
  }
  const stdout = String(completed.stdout ?? "");
  const stderr = String(completed.stderr ?? "");
  if (completed.status !== 0) {
    return {
      status: "unavailable",
      models: [],
      model_count: 0,
      source: `pi --list-models (${extensionProfile.profile})`,
      error: pySlice(pyStrip(stderr || stdout), 500),
    };
  }
  const models = new Set();
  // 目录的 6 列是 provider / model / context / max-out / thinking / images；
  // context 与 images 是选型事实的真源，按模型键旁挂 model_details，缺列时留 null。
  const details = {};
  for (const line of pySplitLines(stdout)) {
    const columns = line.split(PY_SPLIT_RE).filter((item) => item !== "");
    if (columns.length < 2 || columns[0].toLowerCase() === "provider") continue;
    const provider = pyStrip(columns[0]);
    const modelId = pyStrip(columns[1]);
    if (!provider || !modelId) continue;
    const key = `${provider}/${modelId}`;
    models.add(key);
    const images = columns.length >= 6 ? pyStrip(columns[5]).toLowerCase() : "";
    details[key] = {
      context_window: columns.length >= 3 ? pyStrip(columns[2]) || null : null,
      supports_vision: images === "yes" ? true : images === "no" ? false : null,
    };
  }
  if (!models.size) {
    return {
      status: "unavailable",
      models: [],
      model_count: 0,
      source: `pi --list-models (${extensionProfile.profile})`,
      error: "Pi returned no parseable child models",
    };
  }
  const ordered = sortedStrings(models);
  return {
    status: "ok",
    models: ordered,
    model_details: Object.fromEntries(ordered.map((key) => [key, details[key]])),
    model_count: ordered.length,
    source: `pi --list-models (${extensionProfile.profile})`,
    error: null,
  };
}

export function _probePiChildModelCatalogUncached(targetCwd) {
  return deps.probePiChildModelCatalogUncached(targetCwd);
}

// ---- 子进程模型目录文件层 ----
// 进程内 LRU 之上再挂一层文件缓存，让同一调用项目的后续 compiler 进程复用探测结果。
// 只在 prepare/submit 落盘（options.cacheWrite）；list/template/preview 只读不写。

/** 相关配置面：Pi agent 目录里会改变子进程模型目录的模型/设置文件；只取指纹，不读内容。 */
const CHILD_CATALOG_CONFIG_SURFACE = Object.freeze([
  "models.json",
  "models-store.json",
  "settings.json",
  "npm/package.json",
]);

/**
 * 文件层身份：解析后的 Pi 命令、PI_CONTROL_PI、受控扩展 profile、相关配置指纹与 target cwd。
 * target_cwd 必须进身份：受支持的 PI_CONTROL_PI 目录命令可以随 cwd 返回不同模型。
 */
function piChildCatalogCacheIdentity(targetCwd) {
  const command = piChildCatalogCommand();
  const extensionProfile = piChildModelExtensionProfile();
  const extensions = Array.isArray(extensionProfile.extensions) ? extensionProfile.extensions : [];
  const agentDir = resolvePiAgentDir();
  const configPaths = [
    ...extensions,
    ...CHILD_CATALOG_CONFIG_SURFACE.map((name) => path.join(agentDir, ...String(name).split("/"))),
  ];
  return {
    schema: CATALOG_CACHE_SCHEMA,
    platform: process.platform,
    pi_control_pi: pyStrip(String(process.env.PI_CONTROL_PI || "")),
    command,
    extension_profile: {
      profile: extensionProfile.profile,
      extensions,
      error: extensionProfile.error ?? null,
    },
    config_fingerprints: fingerprintPaths(configPaths),
    target_cwd: String(targetCwd),
  };
}

/**
 * 缓存文件位置：调用项目的 runtime 目录，不跟随只读 RUNTIME_ROOT 或进程 cwd。
 * SUBAGENT_CATALOG_CACHE_DIR 只是内部测试接缝（隔离到临时目录），不是用户开关。
 */
function piChildCatalogCacheFile() {
  const override = pyStrip(String(process.env.SUBAGENT_CATALOG_CACHE_DIR || ""));
  const cacheDir = override ? resolveLikePython(override) : path.join(ROOT, ".runtime", "cockpit", "cache");
  return path.join(cacheDir, CATALOG_CACHE_FILE_NAME);
}

/** 文件层只在真实探测实现下生效：替身（测试/自测夹具）既不读也不落盘。 */
function childCatalogFileLayerEnabled() {
  return deps.probePiChildModelCatalogUncached === probePiChildModelCatalogUncachedImpl;
}

/** 由文件层服务过的条目：命中但缺所请求模型时据此强制复探一次。 */
const cacheServedCatalogs = new WeakSet();

function rememberChildCatalog(key, value) {
  caches.childModelCatalog.set(key, value);
  while (caches.childModelCatalog.size > 8) {
    caches.childModelCatalog.delete(caches.childModelCatalog.keys().next().value);
  }
  return value;
}

/** 真实探测（不读缓存）：按 options.cacheWrite 落盘，失败结果不写盘。 */
function probePiChildModelCatalogFresh(key, { cacheWrite = false } = {}) {
  let identityBefore = null;
  if (cacheWrite && childCatalogFileLayerEnabled()) {
    try { identityBefore = piChildCatalogCacheIdentity(key); } catch { /* 可选缓存不可用时仍真实探测。 */ }
  }
  const value = deps.probePiChildModelCatalogUncached(key);
  rememberChildCatalog(key, value);
  if (identityBefore && value?.status === "ok") {
    try {
      const identity = piChildCatalogCacheIdentity(key);
      if (catalogCacheKey(identityBefore) === catalogCacheKey(identity)) {
        writeCatalogCacheEntry(piChildCatalogCacheFile(), catalogCacheKey(identity), identity, value);
      }
    } catch {
      // 文件层是可选加速，任何身份/IO 失败都不改变探测结果。
    }
  }
  return value;
}

/** 按目标 cwd 缓存的探测壳；替身只需接管 deps.probePiChildModelCatalogUncached。 */
function probePiChildModelCatalogImpl(targetCwd, options = {}) {
  const key = String(targetCwd);
  if (caches.childModelCatalog.has(key)) {
    const value = caches.childModelCatalog.get(key);
    caches.childModelCatalog.delete(key);
    caches.childModelCatalog.set(key, value);
    // 进程内命中不重写文件层：避免用旧探测结果刷新 stored_at_ms 而拉长实际陈旧窗口。
    return value;
  }
  if (childCatalogFileLayerEnabled()) {
    let cached = null;
    try {
      const identity = piChildCatalogCacheIdentity(key);
      cached = readCatalogCacheEntry(piChildCatalogCacheFile(), catalogCacheKey(identity));
    } catch {
      cached = null;
    }
    if (cached) {
      cacheServedCatalogs.add(cached.catalog);
      return rememberChildCatalog(key, cached.catalog);
    }
  }
  return probePiChildModelCatalogFresh(key, options);
}

/** options.cacheWrite 只在 prepare/submit 打开；其余动作与直接调用都是只读。 */
export function probePiChildModelCatalog(targetCwd, options = {}) {
  return deps.probePiChildModelCatalog(targetCwd, options);
}

export function requirePiChildModel(model, targetCwd, options = {}) {
  const resolvedCwd = String(resolveLikePython(targetCwd));
  let catalog = probePiChildModelCatalog(resolvedCwd, options);
  // 文件层命中但缺所请求模型：只强制复探一次，再按原合同裁决（不新增失败门）。
  // 进程内 LRU 仍按原合同处理：它的值来自本进程的真实探测，且每次探测都重算身份。
  if (catalog?.status === "ok" && cacheServedCatalogs.has(catalog) && !new Set(pyTruthy(catalog.models) ? catalog.models : []).has(model)) {
    catalog = probePiChildModelCatalogFresh(resolvedCwd, options);
  }
  if (catalog?.status !== "ok") {
    return {
      status: "unknown",
      source: catalog?.source ?? "Pi child catalog probe",
      warning: `Pi child model catalog probe failed: ${pyStr(catalog?.error || "unknown error")}; continuing to runner model validation`,
    };
  }
  const available = new Set(pyTruthy(catalog.models) ? catalog.models : []);
  if (!available.has(model)) {
    throw new ToolError(
      `resolved model ${model} is not available in the Pi child model profile (${pyStr(catalog.source)}); `
      + `available models: ${[...available].sort().join(", ") || "(none)"}; `
      + "nothing was dispatched and no other model was substituted; choose a model from this list and retry",
    );
  }
  return { status: "available", source: pyStr(pyTruthy(catalog.source) ? catalog.source : "") };
}

function resolveFromPicks(agentType, capability, options = {}) {
  const selection = resolveSelection(loadSelectionConfig(modelConfigSources()), {
    role: agentType,
    capability,
    pick: options.pick || null,
    model: options.model || null,
    effort: options.effort || null,
    authorization: options.authorization || null,
  });
  return {
    agent_type: agentType,
    executor: "pi",
    primary_model: selection.resolved_model,
    primary_effort: selection.resolved_effort,
    model_source: selection.requested.model ? "cli" : (selection.requested.pick ? "pick" : "agent_config"),
    effort_source: selection.effort_source === "explicit" ? "cli" : selection.effort_source,
    selection,
  };
}

/** Resolve one role's requested model from the same role picks used by dispatch. */
export function resolveRoleModelSelection(agentTypeRaw, modelOverride, effortOverride, capability = "", options = {}) {
  const agentType = pyStrip(pyStr(pyTruthy(agentTypeRaw) ? agentTypeRaw : ""));
  if (!agentType) throw new ToolError("invalid runtime role: (empty)");
  const capabilityId = pyStrip(pyStr(pyTruthy(capability) ? capability : ""));
  if (!capabilityId) throw new ToolError(`selection requires capability for role ${agentType}`);
  return resolveFromPicks(agentType, capabilityId, {
    model: modelOverride,
    effort: effortOverride,
    pick: options.pick,
    authorization: options.authorization,
  });
}

export function resolveAsyncModelSelection(taskPackage, modelOverride, effortOverride, extra = {}) {
  const agent = isRecord(taskPackage?.agent) ? taskPackage.agent : {};
  const agentType = pyStrip(pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : (pyTruthy(agent.role) ? agent.role : "")));
  const capability = isRecord(agent.capability) ? pyStrip(pyStr(pyTruthy(agent.capability.name) ? agent.capability.name : "")) : "";
  return resolveRoleModelSelection(agentType, modelOverride, effortOverride, capability, extra);
}

export function resolveAsyncRuntimeOptions(taskPackage, options = {}) {
  const {
    model = "",
    effort = "",
    pick = "",
    authorization = null,
    contextMode = "",
    runnerPath = "",
    taskRoot = "",
    targetCwd = "",
    executionProfile = "",
    stallSilenceMs = null,
    catalogCacheWrite = false,
  } = options;
  const agent = isRecord(taskPackage?.agent) ? taskPackage.agent : {};
  const resolvedToolAllowlist = taskToolAllowlist(taskPackage);
  const warnings = [];
  const reviewNeedsNetwork = truthyText(taskPackage?.runtime_context?.network_needed);
  let reviewProfile = reviewExecutionProfile(taskPackage);
  if (reviewProfile === EVIDENCE_ONLY_PROFILE && reviewNeedsNetwork) {
    reviewProfile = "evidence_assisted_v1";
    taskPackage.extensions.review_execution.profile = reviewProfile;
  }
  const evidenceOnly = reviewProfile === EVIDENCE_ONLY_PROFILE;
  const semanticReview = reviewProfile === SEMANTIC_REVIEW_PROFILE;
  const acceptanceSynthesis = reviewProfile === ACCEPTANCE_SYNTHESIS_PROFILE;
  const networkReview = reviewNeedsNetwork && (reviewProfile === "evidence_assisted_v1" || isStaticReview(taskPackage));
  if (networkReview && !semanticReview && !acceptanceSynthesis) warnings.push("network_needed=yes：使用evidence_assisted_v1；工具按声明或Pi配置提供，不自动追加取证工具。");
  let effectiveExecutionProfile = evidenceOnly
    ? EVIDENCE_ONLY_PROFILE
    : (pyTruthy(executionProfile) ? executionProfile : "standard");
  if (!["standard", "simulation", EVIDENCE_ONLY_PROFILE].includes(effectiveExecutionProfile)) {
    throw new ToolError(`unsupported async execution_profile: ${effectiveExecutionProfile}`);
  }
  const effectiveTargetCwd = resolveLikePython(pyTruthy(targetCwd) ? targetCwd : ROOT);
  if (!isDirectory(effectiveTargetCwd)) throw new ToolError(`async target_cwd does not exist: ${effectiveTargetCwd}`);
  const controllerRuntime = resolveLikePython(path.join(ROOT, ".runtime"));
  const effectiveTaskRoot = resolveLikePython(
    pyTruthy(taskRoot) ? taskRoot : path.join(controllerRuntime, "cockpit", "async_tasks"),
  );
  if (!pyIsRelativeTo(effectiveTaskRoot, controllerRuntime)) {
    throw new ToolError("async task_root must stay inside the controller repository .runtime");
  }
  let effectiveRunnerPath = "";
  // 未显式覆盖 runner 时发裸 basename 哨兵，由服务端解析为其部署形态内的可信 runner
  // （身份门覆盖执行体，存在性由服务端在提交边界 fail-closed）；显式路径仍走本地存在性校验通路。
  const requestedRunnerPath = pyTruthy(runnerPath) ? runnerPath : PI_ASYNC_RUNNER_SENTINEL;
  if (requestedRunnerPath === PI_ASYNC_RUNNER_SENTINEL) {
    effectiveRunnerPath = requestedRunnerPath;
  } else if (pyTruthy(requestedRunnerPath)) {
    effectiveRunnerPath = String(resolveLikePython(requestedRunnerPath));
    if (!isFile(effectiveRunnerPath)) throw new ToolError(`async runner does not exist: ${effectiveRunnerPath}`);
  }
  const extensions = isRecord(taskPackage?.extensions) ? taskPackage.extensions : {};
  const crossRepo = isRecord(extensions.cross_repo_acceptance) ? extensions.cross_repo_acceptance : {};
  let resultMode = pyStr(pyTruthy(crossRepo.result_mode) ? crossRepo.result_mode : "");
  if (resultMode && !CROSS_REPO_RESULT_MODES.has(resultMode)) {
    throw new ToolError(
      "extensions.cross_repo_acceptance.result_mode must be one of "
      + sortedStrings(CROSS_REPO_RESULT_MODES).join(" | "),
    );
  }
  if (!pySamePath(effectiveTargetCwd, resolveLikePython(ROOT)) && !resultMode) {
    // 报告与 handoff 之外声明了写域即为跨仓实施；只写这两份产物才是只读审计。
    const outputs = new Set([taskPackage?.expected_output?.file_path, taskPackage?.handoff_contract?.handoff_file]
      .filter(Boolean).map((item) => String(resolveLikePython(item))));
    const businessWrites = (taskPackage?.scope?.write ?? []).filter((item) => !outputs.has(String(resolveLikePython(item))));
    resultMode = businessWrites.length ? "real_rerun" : "read_only_audit";
    crossRepo.result_mode = resultMode;
    extensions.cross_repo_acceptance = crossRepo;
    taskPackage.extensions = extensions;
    warnings.push(businessWrites.length
      ? "跨仓result_mode按业务写域缺省为real_rerun；只读审计时显式选择read_only_audit。"
      : "跨仓result_mode缺省为read_only_audit：写域只有报告与handoff；需要实施业务改动时在scope.write_extra声明写域。");
  }
  if (resultMode === "simulated_planning" && effectiveExecutionProfile !== "simulation") {
    warnings.push(`result_mode=simulated_planning：execution_profile由${effectiveExecutionProfile}推导为simulation。`);
    effectiveExecutionProfile = "simulation";
  }
  let simulationProfile = null;
  if (effectiveExecutionProfile === "simulation") {
    const simulation = isRecord(crossRepo.simulation) ? crossRepo.simulation : {};
    const role = pyStrip(pyStr(pyTruthy(simulation.role) ? simulation.role : ""));
    const persona = simulation.persona;
    if (resultMode !== "simulated_planning" || !role || !isRecord(persona) || !pyTruthy(persona)) {
      throw new ToolError(
        "simulation requires result_mode=simulated_planning and non-empty "
        + "extensions.cross_repo_acceptance.simulation.role/persona",
      );
    }
    simulationProfile = { role, persona: structuredClone(persona) };
  }
  const modelSelection = resolveAsyncModelSelection(taskPackage, model, effort, { pick, authorization });
  if (modelSelection.selection && extensions.resource_config_fingerprint) {
    modelSelection.selection.config_source = {
      ...modelSelection.selection.config_source,
      resource_config_fingerprint: extensions.resource_config_fingerprint,
    };
  }
  // 最终请求已在本次解析中校验；此后不得改 effort。
  // Production dispatch uses the bare sentinel and is always checked. Explicit runner paths are
  // custom/test seams; their model catalog belongs to that runner and is not inferred here.
  const usesDefaultPiRunner = requestedRunnerPath === PI_ASYNC_RUNNER_SENTINEL;
  // 文件层只由 prepare/submit 落盘；preview、list 与直接调用保持只读。
  const catalogProbeOptions = { cacheWrite: Boolean(catalogCacheWrite) };
  const webExtension = { status: "configured_resources", source: "Pi user configuration" };
  if (usesDefaultPiRunner) {
    modelSelection.child_model = requirePiChildModel(
      pyStr(pyTruthy(modelSelection.primary_model) ? modelSelection.primary_model : ""),
      effectiveTargetCwd,
      catalogProbeOptions,
    );
  } else {
    modelSelection.child_model = { status: "not_checked", source: "custom_runner" };
  }
  return {
    agent_type: pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : (pyTruthy(agent.role) ? agent.role : "")),
    executor: "pi",
    execution_profile: effectiveExecutionProfile,
    context_mode: evidenceOnly ? "isolated" : (pyTruthy(contextMode) ? contextMode : "project-aware"),
    runner_path: effectiveRunnerPath,
    target_cwd: effectiveTargetCwd,
    task_root: effectiveTaskRoot,
    result_mode: resultMode,
    simulation_profile: simulationProfile,
    ...(warnings.length ? { warnings } : {}),
    tool_allowlist: resolvedToolAllowlist,
    tool_allowlist_source: resolvedToolAllowlist === null ? "pi_configured_tools" : "task_package.tool_contract.allowed",
    web_extension: webExtension,
    model_selection: modelSelection,
    stall_silence_ms: stallSilenceMs,
  };
}

// ---- 派发阶段坐标 ----

const dispatchPhaseState = { phase: "seed", seedIndex: 0 };

export function currentDispatchPhase() {
  return dispatchPhaseState.phase;
}

/**
 * 记录单个 seed 走到了哪一段：seed | lint | compile | submit。
 * 批量派发的失败项按这个坐标标注停在哪一步；同时向 stderr 打一行心跳，
 * 宿主按 `[dispatch-phase] seed=<批内 1 起序号，单发为 0> phase=<name>` 解析编译进度。
 */
export function markDispatchPhase(phase) {
  dispatchPhaseState.phase = phase;
  process.stderr.write(`[dispatch-phase] seed=${dispatchPhaseState.seedIndex} phase=${phase}\n`);
  return null;
}

/** Compile once, verify once, and optionally submit the prepared dispatch. */
export function prepareAsyncSubagent(pkg, options = {}) {
  const {
    model = "",
    effort = "",
    pick = "",
    authorization = null,
    contextMode = "",
    runnerPath = "",
    taskRoot = "",
    targetCwd = "",
    executionProfile = "",
    stallSilenceMs = null,
    catalogCacheWrite = false,
    resolvedOptions = null,
    submitter = null,
    batchId = "",
    sliceId = "",
    displayTitle = "",
    action = "submit",
    originId = "",
    reviewEvidenceBuilder = null,
    budget = null,
  } = options;
  let deferFinalRuntimeResolution = Boolean(options.deferFinalRuntimeResolution);
  const normalizedAction = pyStrip(pyStr(pyTruthy(action) ? action : "submit")).toLowerCase();
  if (!["prepare", "submit"].includes(normalizedAction)) {
    throw new ToolError(`async preparation does not support action=${pyRepr(normalizedAction)}`);
  }
  const taskPackage = pyGetItem(pkg, "task_package");
  const packageId = pyStr(pyTruthy(taskPackage.package_id) ? taskPackage.package_id : "");
  const staticReview = isStaticReview(taskPackage);
  deferFinalRuntimeResolution = Boolean(
    deferFinalRuntimeResolution || (staticReview && ["prepare", "submit"].includes(normalizedAction)),
  );
  let opts;
  if (deferFinalRuntimeResolution) {
    // A static-review call may receive an options envelope resolved before
    // evidence existed.  Keep only stable routing inputs for allocation and
    // final model/path recomputation; profile fields are never trusted
    // across the evidence boundary.
    const supplied = { ...(resolvedOptions || {}) };
    const selection = isRecord(supplied.model_selection) ? supplied.model_selection : {};
    const agentObject = isRecord(taskPackage.agent) ? taskPackage.agent : {};
    opts = {
      agent_type: pyStr(pyTruthy(supplied.agent_type)
        ? supplied.agent_type
        : (pyTruthy(agentObject.runtime_role) ? agentObject.runtime_role : (pyTruthy(agentObject.role) ? agentObject.role : ""))),
      executor: "pi",
      target_cwd: lexicalAbsolute(pyTruthy(targetCwd) ? targetCwd : (pyTruthy(supplied.target_cwd) ? supplied.target_cwd : ROOT)),
      task_root: lexicalAbsolute(pyTruthy(taskRoot) ? taskRoot : (pyTruthy(supplied.task_root) ? supplied.task_root : PROJECT_ASYNC_TASK_ROOT)),
      runner_path: pyTruthy(runnerPath) ? runnerPath : pyStr(pyTruthy(supplied.runner_path) ? supplied.runner_path : ""),
      model_selection: {
        primary_model: pyTruthy(model) ? model : pyStr(pyTruthy(selection.primary_model) ? selection.primary_model : ""),
        primary_effort: pyTruthy(effort) ? effort : pyStr(pyTruthy(selection.primary_effort) ? selection.primary_effort : ""),
      },
    };
  } else if (resolvedOptions !== null && resolvedOptions !== undefined) {
    opts = { ...resolvedOptions };
  } else {
    opts = resolveAsyncRuntimeOptions(taskPackage, {
      model,
      effort,
      pick,
      authorization,
      contextMode,
      runnerPath,
      taskRoot,
      targetCwd,
      executionProfile,
      stallSilenceMs,
      catalogCacheWrite,
    });
  }

  const stableSelection = isRecord(opts.model_selection) ? opts.model_selection : {};
  const stableModel = pyTruthy(model) ? model : pyStr(pyTruthy(stableSelection.primary_model) ? stableSelection.primary_model : "");
  const stableEffort = pyTruthy(effort) ? effort : pyStr(pyTruthy(stableSelection.primary_effort) ? stableSelection.primary_effort : "");
  const stableRunnerPath = pyTruthy(runnerPath) ? runnerPath : pyStr(pyTruthy(opts.runner_path) ? opts.runner_path : "");
  const stableTaskRoot = pyTruthy(taskRoot) ? taskRoot : pyStr(pyTruthy(opts.task_root) ? opts.task_root : "");
  const stableTargetCwd = pyTruthy(targetCwd) ? targetCwd : pyStr(pyTruthy(opts.target_cwd) ? opts.target_cwd : "");

  const effectiveOriginId = pyStr(originId);

  const dispatchEnvelopeFor = (resolved) => {
    const selection = isRecord(resolved.model_selection) ? resolved.model_selection : {};
    return {
      contract_version: ASYNC_DISPATCH_CONTRACT_VERSION,
      // producer_root 是任务/临时状态归属根（项目本地），不是运行包根；运行资产由 entryDir/checker 策略解析。
      producer_root: String(ROOT),
      origin_thread_id: effectiveOriginId,
      target_cwd: String(pyTruthy(resolved.target_cwd) ? resolved.target_cwd : ROOT),
      task_file: "",
      task_root: String(pyTruthy(resolved.task_root) ? resolved.task_root : PROJECT_ASYNC_TASK_ROOT),
      runner_path: pyStr(pyTruthy(resolved.runner_path) ? resolved.runner_path : "") || null,
      runtime_role: pyStr(pyTruthy(resolved.agent_type) ? resolved.agent_type : ""),
      model: pyStr(pyTruthy(selection.primary_model) ? selection.primary_model : "") || null,
      effort: pyStr(pyTruthy(selection.primary_effort) ? selection.primary_effort : "") || null,
      ...(isRecord(selection.selection) ? { selection: selection.selection } : {}),
      context_mode: pyStr(pyTruthy(resolved.context_mode) ? resolved.context_mode : "project-aware"),
      execution_profile: pyStr(pyTruthy(resolved.execution_profile) ? resolved.execution_profile : "standard"),
      result_mode: pyStr(pyTruthy(resolved.result_mode) ? resolved.result_mode : "") || null,
      simulation: resolved.simulation_profile ?? null,
      stall_silence_ms: resolved.stall_silence_ms ?? null,
      // 种子 budget 经 prepareDispatch 传入；任务包本身不携带 budget。
      budget: isRecord(budget) && Object.keys(budget).length ? budget : (isRecord(taskPackage.budget) ? taskPackage.budget : {}),
      batch_id: pyTruthy(batchId) ? batchId : null,
      slice_id: pyTruthy(sliceId) ? sliceId : null,
      display_title: clampDisplayTitle(pyTruthy(displayTitle)
        ? displayTitle
        : pyStr(pyTruthy(taskPackage.goal) ? taskPackage.goal : packageId)),
    };
  };

  let dispatchEnvelope = deferFinalRuntimeResolution ? null : dispatchEnvelopeFor(opts);
  const reviewHolder = {};

  const buildTaskMaterial = (packagePath) => renderTaskMaterialFile(packagePath);

  const buildReviewEvidence = (materialRoot, _preparedPackage) => {
    if (reviewEvidenceBuilder !== null && reviewEvidenceBuilder !== undefined) {
      const value = reviewEvidenceBuilder(materialRoot, _preparedPackage);
      reviewHolder.value = value;
      return value;
    }
    const evidence = deps.attachReviewEvidence(pkg, {
      execute: true,
      outputPath: path.join(String(materialRoot), "review-evidence.json"),
    });
    reviewHolder.value = evidence;
    return { writes_performed: pyTruthy(evidence) ? ["review-evidence.json"] : [] };
  };

  // Only static-review packages need the owned evidence writer during compile.
  const shouldWriteEvidence = isStaticReview(taskPackage);

  const finalizeAfterEvidence = (_materialRoot, _preparedPackage) => {
    opts = resolveAsyncRuntimeOptions(taskPackage, {
      model: stableModel,
      effort: stableEffort,
      pick,
      authorization,
      contextMode,
      runnerPath: stableRunnerPath,
      taskRoot: stableTaskRoot,
      targetCwd: stableTargetCwd,
      executionProfile,
      stallSilenceMs,
      // 该回调只在 prepare/submit 路径执行：允许文件层落盘。
      catalogCacheWrite: true,
    });
    // The package has been changed by evidence; lint and envelope construction
    // are intentionally after that callback and before task rendering.
    lintOrFail(pkg);
    dispatchEnvelope = dispatchEnvelopeFor(opts);
    return { runtime_options: opts, dispatch_envelope: dispatchEnvelope };
  };

  let descriptor;
  try {
    const selection = isRecord(opts.model_selection) ? opts.model_selection : null;
    descriptor = deps.compilePreparedDispatch(pkg, {
      producerRoot: ROOT,
      resolvedRuntimeOptions: {
        ...opts,
        runtime_role: pyStr(pyTruthy(opts.agent_type) ? opts.agent_type : ""),
        model: selection ? pyStr(pyTruthy(selection.primary_model) ? selection.primary_model : "") : "",
        effort: selection ? pyStr(pyTruthy(selection.primary_effort) ? selection.primary_effort : "") : "",
        runner_path: pyStr(pyTruthy(opts.runner_path) ? opts.runner_path : ""),
        batch_id: pyTruthy(batchId) ? batchId : null,
        slice_id: pyTruthy(sliceId) ? sliceId : null,
        display_title: clampDisplayTitle(pyTruthy(displayTitle)
          ? displayTitle
          : pyStr(pyTruthy(taskPackage.goal) ? taskPackage.goal : packageId)),
      },
      dispatchEnvelope,
      taskMaterialBuilder: buildTaskMaterial,
      reviewEvidenceBuilder: shouldWriteEvidence ? buildReviewEvidence : null,
      postMaterialCallback: deferFinalRuntimeResolution ? finalizeAfterEvidence : null,
      originId: effectiveOriginId,
      batchId: pyTruthy(batchId) ? batchId : null,
      sliceId: pyTruthy(sliceId) ? sliceId : null,
      displayTitle: clampDisplayTitle(pyTruthy(displayTitle)
        ? displayTitle
        : pyStr(pyTruthy(taskPackage.goal) ? taskPackage.goal : packageId)),
    });
  } catch (error) {
    if (isPyCaughtError(error, new Set(["PreparedDispatchError", "OSError", "ValueError"]))) {
      throw new ToolError(`prepared dispatch compilation failed: ${error.message}`);
    }
    throw error;
  }
  let verifiedDescriptor;
  try {
    verifiedDescriptor = deps.verifyPreparedDispatch(pyGetItem(descriptor, "descriptor_file"));
  } catch (error) {
    if (isPyCaughtError(error, new Set(["PreparedDispatchError", "OSError", "ValueError"]))) {
      throw new ToolError(`prepared dispatch verification failed: ${error.message}`);
    }
    throw error;
  }
  const agentType = pyStr(pyTruthy(opts.agent_type) ? opts.agent_type : "");
  const effectiveExecutionProfile = pyStr(pyTruthy(opts.execution_profile) ? opts.execution_profile : "standard");
  const effectiveContextMode = pyStr(pyTruthy(opts.context_mode) ? opts.context_mode : "project-aware");
  const effectiveTaskRoot = String(pyGetItem(opts, "task_root"));
  const resultMode = pyStr(pyTruthy(opts.result_mode) ? opts.result_mode : "");
  const modelSelection = { ...(pyTruthy(opts.model_selection) ? opts.model_selection : {}) };
  const primaryModel = pyStr(pyTruthy(modelSelection.primary_model) ? modelSelection.primary_model : "");
  const primaryEffort = pyStr(pyTruthy(modelSelection.primary_effort) ? modelSelection.primary_effort : "");
  const packagePath = String(pyGetItem(verifiedDescriptor, "package_file"));
  const taskMaterialPath = String(pyGetItem(verifiedDescriptor, "task_file"));
  const dispatchEnvelopePath = String(pyGetItem(verifiedDescriptor, "dispatch_file"));
  const baseResult = {
    status: "ok",
    action: normalizedAction,
    delivery_mode: "async_subagent",
    batch_id: pyTruthy(batchId) ? batchId : null,
    slice_id: pyTruthy(sliceId) ? sliceId : null,
    display_title: clampDisplayTitle(pyTruthy(displayTitle)
      ? displayTitle
      : pyStr(pyTruthy(taskPackage.goal) ? taskPackage.goal : packageId)),
    origin_thread_id: pyTruthy(effectiveOriginId) ? effectiveOriginId : null,
    dispatch_contract_version: ASYNC_DISPATCH_CONTRACT_VERSION,
    package_id: packageId,
    agent_type: agentType,
    executor: "pi",
    task_package_path: rel(packagePath),
    task_material_path: rel(taskMaterialPath),
    dispatch_envelope_path: rel(dispatchEnvelopePath),
    package_file: verifiedDescriptor.package_file,
    task_file: verifiedDescriptor.task_file,
    dispatch_file: verifiedDescriptor.dispatch_file,
    descriptor_file: verifiedDescriptor.descriptor_file,
    preparation_id: verifiedDescriptor.preparation_id,
    material_root: verifiedDescriptor.material_root,
    descriptor: verifiedDescriptor,
    writes_performed: [...pyList(pyTruthy(verifiedDescriptor.writes_performed) ? verifiedDescriptor.writes_performed : [])],
    tool_allowlist: opts.tool_allowlist ?? null,
    tool_allowlist_source: pyStr(pyTruthy(opts.tool_allowlist_source) ? opts.tool_allowlist_source : ""),
    context_mode: effectiveContextMode,
    review_execution_profile: reviewExecutionProfile(taskPackage) || null,
    execution_profile: effectiveExecutionProfile,
    result_mode: resultMode || null,
    async_model_selection: modelSelection,
    ...(opts.warnings?.length ? { warnings: opts.warnings } : {}),
    model: primaryModel,
    effort: primaryEffort,
  };
  if (normalizedAction === "prepare") baseResult.state = "prepared";
  if (reviewHolder.value !== undefined && reviewHolder.value !== null) {
    baseResult.review_evidence = reviewHolder.value;
  }
  if (normalizedAction === "prepare") return baseResult;

  markDispatchPhase("submit");
  const submit = submitter || deps.callAsyncInternalAdapter;
  // Exactly one selected transport invocation; no retry path exists here.
  const receipt = submit("submit-prepared", { dispatch_file: verifiedDescriptor.dispatch_file });
  if (!isRecord(receipt)) throw new ToolError("async transport returned a malformed receipt; task_id is ambiguous");
  const rawTaskId = receipt.task_id;
  const taskId = typeof rawTaskId === "string" ? rawTaskId : "";
  if (!_validTaskId(taskId)) {
    throw new ToolError("async transport returned an empty or malformed task_id; task submission is ambiguous");
  }
  const taskDir = pathlibJoin(effectiveTaskRoot, taskId);
  Object.assign(baseResult, {
    task_id: taskId,
    task_dir: String(taskDir),
    status_path: String(path.join(taskDir, "status.json")),
    handoff_path: String(path.join(taskDir, "handoff.md")),
    report_path: String(path.join(taskDir, "report.md")),
    wait_tool_arguments: { task_id: taskId, timeout_ms: 60000 },
    get_tool_arguments: { task_ids: [taskId], detail: "compact" },
    result_tool_arguments: { task_id: taskId },
    spawn_payload: renderAsyncTaskPayload(packagePath, taskId),
  });
  return baseResult;
}

export function taskPackageOutputSummary(taskPackage) {
  const expected = isRecord(taskPackage?.expected_output) ? taskPackage.expected_output : {};
  const handoff = isRecord(taskPackage?.handoff_contract) ? taskPackage.handoff_contract : {};
  const scope = isRecord(taskPackage?.scope) ? taskPackage.scope : {};
  const scopeWrite = [];
  for (const item of pyList(Object.hasOwn(scope, "write") ? scope.write : [])) {
    if (typeof item === "string" && !scopeWrite.includes(item)) scopeWrite.push(item);
  }
  const expectedCandidates = ["resolved_file_path", "file_path", "path"]
    .filter((key) => pyTruthy(expected[key]))
    .map((key) => pyStr(pyTruthy(expected[key]) ? expected[key] : ""));
  const handoffCandidates = ["resolved_handoff_file", "handoff_file"]
    .filter((key) => pyTruthy(handoff[key]))
    .map((key) => pyStr(pyTruthy(handoff[key]) ? handoff[key] : ""));
  const declared = new Set([...expectedCandidates, ...handoffCandidates].map((item) => item.split("\\").join("/")));
  const extraWrites = scopeWrite.filter((item) => !declared.has(item.split("\\").join("/")));
  let note = null;
  if (extraWrites.length) {
    note = "scope.write_extra entries are additional allowed writes; they do not override "
      + "expected_output.file_path. Set expected_output.file_path/resolved_file_path "
      + "explicitly when a reducer or report must land at a specific path.";
  }
  return {
    expected_report_path: expectedCandidates.length ? expectedCandidates[0] : null,
    expected_handoff_path: handoffCandidates.length ? handoffCandidates[0] : null,
    expected_output: expected,
    handoff_contract: handoff,
    scope_write: scopeWrite,
    extra_write_paths: extraWrites,
    write_extra_note: note,
  };
}

export function prepareDryRun(pkg, delivery, resolvedDelivery, readiness, resolvedOptions = null) {
  const taskPackage = pyGetItem(pkg, "task_package");
  readRequiredFiles(taskPackage);
  roleDeveloperInstructions(taskPackage);
  const packageId = pyStr(pyTruthy(taskPackage.package_id) ? taskPackage.package_id : "");
  const agent = isRecord(taskPackage.agent) ? taskPackage.agent : {};
  const agentType = pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : (pyTruthy(agent.role) ? agent.role : ""));
  const wouldDeliveryMap = { "async-subagent": "async_subagent", direct: "direct_message" };
  const result = {
    status: "ok",
    dry_run: true,
    delivery_mode: `${delivery}_dry_run`,
    resolved_delivery: resolvedDelivery,
    would_delivery_mode: Object.hasOwn(wouldDeliveryMap, resolvedDelivery) ? wouldDeliveryMap[resolvedDelivery] : resolvedDelivery,
    delivery_readiness: readiness,
    package_id: packageId,
    agent_type: agentType,
    business_output: taskPackageOutputSummary(taskPackage),
    spawn_payload: "DRY_RUN_ONLY: no async task or dispatch payload registered; rerun with --action prepare/submit after dispatch is authorized",
    writes_performed: [],
  };
  if (resolvedOptions !== null && resolvedOptions !== undefined) {
    // 预览将写入 envelope 的双轨字段，键值口径与 prepare_async_subagent 的 dispatch_envelope 一致。
    const selection = isRecord(resolvedOptions.model_selection) ? resolvedOptions.model_selection : {};
    result.async_preview = {
      executor: resolvedOptions.executor ?? null,
      runner_path: pyStr(pyTruthy(resolvedOptions.runner_path) ? resolvedOptions.runner_path : "") || null,
      model: pyStr(pyTruthy(selection.primary_model) ? selection.primary_model : "") || null,
      effort: pyStr(pyTruthy(selection.primary_effort) ? selection.primary_effort : "") || null,
      model_source: selection.model_source ?? null,
      effort_source: selection.effort_source ?? null,
      child_model: selection.child_model ?? null,
      ...(isRecord(selection.selection) ? { selection: selection.selection } : {}),
    };
  }
  return result;
}

export function normalizeDispatchAction(action = "") {
  const requested = pyStrip(pyStr(pyTruthy(action) ? action : "")).toLowerCase();
  if (requested && !["preview", "prepare", "submit"].includes(requested)) {
    throw new ToolError("action must be one of preview, prepare, submit");
  }
  return requested || "submit";
}

/** The legacy Codex adapter is the only layer allowed to read this env value. */
export function legacyOriginId() {
  return String(process.env.CODEX_THREAD_ID || "");
}

export function prepareDispatch(seed, delivery, options = {}) {
  const {
    action = "",
    asyncModel = "",
    asyncEffort = "",
    asyncPick = "",
    asyncAuthorization = null,
    asyncContextMode = "",
    asyncRunnerPath = "",
    asyncTaskRoot = "",
    asyncTargetCwd = "",
    asyncExecutionProfile = "",
    asyncStallSilenceMs = null,
    asyncBatchId = "",
    asyncSliceId = "",
    asyncDisplayTitle = "",
    asyncSubmitter = null,
    originId = null,
  } = options;
  markDispatchPhase("seed");
  const normalizedAction = normalizeDispatchAction(action);
  const preview = normalizedAction === "preview";
  if (asyncTargetCwd) {
    const targetRepo = String(resolveLikePython(asyncTargetCwd));
    const runtimeContext = { ...(seed.runtime_context ?? {}), target_repo: targetRepo };
    // 子代理在目标树里运行：执行目录与 git 快照取目标树；报告与 handoff 仍按 output_root 落在发起方仓。
    if (!pySamePath(targetRepo, resolveLikePython(ROOT))) {
      runtimeContext.cwd ??= targetRepo;
      runtimeContext.git ??= {
        branch: gitValue(["branch", "--show-current"], "(unknown)", targetRepo),
        head: gitValue(["rev-parse", "--short=12", "HEAD"], "(unknown)", targetRepo),
      };
    }
    seed = { ...seed, runtime_context: runtimeContext };
  }
  const pkg = buildPackage(seed);
  markDispatchPhase("lint");
  projectConditionalRequiredFiles(pyGetItem(pkg, "task_package"));
  lintOrFail(pkg);
  const compiledTask = pyGetItem(pkg, "task_package");
  compiledTask.extensions.model_config = { global_root: modelConfigSources().global_root, project_root: ROOT };
  const importedResources = loadWorkerResourcesConfig(path.join(RUNTIME_ROOT, "ops", "templates", "worker-resources.json"));
  applyRoleWorkerResources(compiledTask, loadSelectionConfig(modelConfigSources()), importedResources);
  const resourceSnapshot = {
    tools: importedResources.tools, extensions: importedResources.extensions,
    skills: importedResources.skills, required_tools: importedResources.required_tools,
  };
  compiledTask.extensions.resource_config_fingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(resourceSnapshot)).digest("hex")}`;
  markDispatchPhase("compile");

  // Prepare and an explicitly async preview compile against the async contract without
  // consulting a transport. Default auto preview still reports live readiness for CLI users.
  let resolvedDelivery;
  let readiness;
  if (normalizedAction === "prepare" || (preview && delivery === "async-subagent")) {
    resolvedDelivery = "async-subagent";
    readiness = { status: "not_checked", issues: [] };
  } else {
    [resolvedDelivery, readiness] = deps.resolveDelivery(delivery);
  }

  const staticReview = isStaticReview(pyGetItem(pkg, "task_package"));
  const deferFinalRuntimeResolution = resolvedDelivery === "async-subagent"
    && ["prepare", "submit"].includes(normalizedAction)
    && staticReview;
  const reviewEvidence = preview ? deps.attachReviewEvidence(pkg, { execute: false }) : null;
  let resolvedAsyncOptions = null;
  if (["preview", "prepare", "submit"].includes(normalizedAction)
    && resolvedDelivery === "async-subagent"
    && !deferFinalRuntimeResolution) {
    resolvedAsyncOptions = resolveAsyncRuntimeOptions(pyGetItem(pkg, "task_package"), {
      model: asyncModel,
      effort: asyncEffort,
      pick: asyncPick,
      authorization: asyncAuthorization,
      contextMode: asyncContextMode,
      runnerPath: asyncRunnerPath,
      taskRoot: asyncTaskRoot,
      targetCwd: asyncTargetCwd,
      executionProfile: asyncExecutionProfile,
      stallSilenceMs: asyncStallSilenceMs,
      // preview 只读；prepare/submit 才允许文件层落盘。
      catalogCacheWrite: normalizedAction !== "preview",
    });
    const effectiveTarget = resolveLikePython(pyGetItem(resolvedAsyncOptions, "target_cwd"));
    if (!pySamePath(effectiveTarget, resolveLikePython(ROOT))) {
      const taskPackage = pyGetItem(pkg, "task_package");
      taskPackage.runtime_context.target_repo = String(effectiveTarget);
      lintOrFail(pkg);
    }
  }

  // A7：分层读作用域——把 read_scope_layers 落进任务包（渲染进任务书），preflight 只算 entry+index。
  const layers = readScopeLayersFromSeed(seed);
  if (layers !== null) pyGetItem(pkg, "task_package").read_scope_layers = layers;
  const scopePreflightBase = asyncTargetCwd
    ? resolveLikePython(asyncTargetCwd)
    : (resolvedAsyncOptions !== null ? resolveLikePython(String(pyGetItem(resolvedAsyncOptions, "target_cwd"))) : ROOT);
  const scopePreflight = computeScopePreflight(
    preflightReadPaths(layers, pyGetItem(pyGetItem(pyGetItem(pkg, "task_package"), "scope"), "read")),
    { baseRoot: scopePreflightBase },
  );
  const scopeDiagnostics = enforceScopePreflight(scopePreflight);
  pyGetItem(pkg, "task_package").scope_preflight = scopePreflight;
  if (scopeDiagnostics.length) {
    pyGetItem(pkg, "task_package").known_facts.push(...scopeDiagnostics);
  }
  const budget = seedBudget(seed);

  const annotate = (result) => {
    if (!Object.hasOwn(result, "action")) result.action = normalizedAction;
    result.scope_preflight = scopePreflight;
    result.business_output = taskPackageOutputSummary(pyGetItem(pkg, "task_package"));
    const warnings = [...new Set([
      ...scopeDiagnostics, ...(result.warnings || []), ...(resolvedAsyncOptions?.warnings || []),
      result.async_model_selection?.child_model?.warning,
      resolvedAsyncOptions?.model_selection?.child_model?.warning,
    ].filter(Boolean))];
    if (warnings.length) result.warnings = warnings;
    if (asyncBatchId) {
      result.batch_id = asyncBatchId;
      result.slice_id = asyncSliceId;
    }
    result.display_title = clampDisplayTitle(asyncDisplayTitle || sliceMetadata(seed, 0)[1]);
    if (layers !== null) {
      result.read_scope_layers = layers;
      result.read_scope_layers_directive = renderReadScopeLayers(layers);
    }
    if (pyTruthy(budget)) {
      result.budget = budget;
      // max_elapsed_minutes 由 runner 按 attempt 执行（未给时缺省 90 分钟）。
      result.budget_enforcement = { max_elapsed_minutes: "enforced_per_attempt" };
    }
    if (preview && reviewEvidence !== null && reviewEvidence !== undefined) {
      result.review_evidence = reviewEvidence;
    }
    return result;
  };

  if (preview) return annotate(prepareDryRun(pkg, delivery, resolvedDelivery, readiness, resolvedAsyncOptions));
  let result;
  if (resolvedDelivery === "async-subagent") {
    result = prepareAsyncSubagent(pkg, {
      model: asyncModel,
      effort: asyncEffort,
      pick: asyncPick,
      authorization: asyncAuthorization,
      contextMode: asyncContextMode,
      runnerPath: asyncRunnerPath,
      taskRoot: asyncTaskRoot,
      targetCwd: asyncTargetCwd,
      executionProfile: asyncExecutionProfile,
      stallSilenceMs: asyncStallSilenceMs,
      budget,
      catalogCacheWrite: normalizedAction !== "preview",
      resolvedOptions: resolvedAsyncOptions,
      submitter: asyncSubmitter,
      batchId: asyncBatchId,
      sliceId: asyncSliceId,
      displayTitle: asyncDisplayTitle,
      action: normalizedAction,
      deferFinalRuntimeResolution,
      originId: (normalizedAction === "prepare" && (originId === null || originId === undefined))
        ? ""
        : ((originId === null || originId === undefined) ? legacyOriginId() : pyStr(originId)),
    });
  } else if (resolvedDelivery === "direct") {
    throw new ToolError("direct subagent dispatch is disabled; use --delivery auto/async-subagent so dispatch goes through MCP async");
  } else if (resolvedDelivery === "unavailable") {
    const issues = pyList(pyTruthy(readiness?.issues) ? readiness.issues : []).join("; ");
    throw new ToolError(`async subagent MCP dispatch unavailable; subagent dispatch not submitted: ${issues || "unknown readiness issue"}`);
  } else {
    throw new ToolError(`unknown delivery: ${resolvedDelivery}`);
  }
  annotate(result);
  result.requested_delivery = delivery;
  result.resolved_delivery = resolvedDelivery;
  result.delivery_readiness = readiness;
  return result;
}

export function makeBatchId(_seeds) {
  const now = clock.now();
  const pad = (value, width) => String(value).padStart(width, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}T`
    + `${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}`
    + `${pad(now.getUTCMilliseconds(), 3)}Z`;
  return `batch-${stamp}-${ids.uuidHex().slice(0, 12)}`;
}

export function sliceMetadata(seed, index) {
  const sliceId = pyStrip(pyStr(
    pyTruthy(seed?.slice_id) ? seed.slice_id : (pyTruthy(seed?.slug) ? seed.slug : `slice-${String(index + 1).padStart(2, "0")}`),
  ));
  const displayTitle = pyStrip(pyStr(
    pyTruthy(seed?.title) ? seed.title : (pyTruthy(seed?.goal) ? seed.goal : sliceId),
  ));
  return [pySlice(sliceId, 120), pySlice(displayTitle, 240)];
}

/** display_title 会进 submit 回包；超长值（尤其长中文 goal）撑爆回包 token 预算，统一按字节截断。 */
export function clampDisplayTitle(text, limitBytes = 120) {
  const encoded = Buffer.from(pyStr(text), "utf8").subarray(0, limitBytes);
  return pyStrip(new TextDecoder("utf-8", { fatal: false }).decode(encoded).replace(/\uFFFD+$/, ""));
}

/**
 * 逐 seed try/except：一个 seed 失败不丢失其它已提交结果；整体 status=partial 时
 * dispatches 里同时含成功项（带 task_id）和失败项（带 seed_index/phase/error）。
 * 写冲突只阻断参与者，独立 seed 继续提交；冲突索引由 failed_seed_indexes 返回。
 * 失败项的 phase 与 error 前缀给出阶段坐标：seed | lint | compile | submit。
 */
export function prepareBatchDispatch(seeds, delivery, options = {}) {
  const { batchId = "", ...kwargs } = options;
  const batchAction = normalizeDispatchAction(pyStr(pyTruthy(kwargs.action) ? kwargs.action : ""));
  const resolvedBatchId = pySlice(pyStrip(String(batchId ?? "")) || makeBatchId(seeds), 120);
  const conflicts = batchWriteConflicts(seeds);
  const conflictIndexes = new Set(conflicts.flatMap((item) => [
    Number(item.left_seed_index), Number(item.right_seed_index),
  ]));
  const dispatches = [];
  const failedIndexes = [];
  seeds.forEach((seed, idx) => {
    const [currentSliceId, currentTitle] = sliceMetadata(seed, idx);
    if (conflictIndexes.has(idx + 1)) {
      failedIndexes.push(idx + 1);
      dispatches.push({
        status: "failed",
        seed_index: idx + 1,
        phase: "seed",
        batch_id: resolvedBatchId,
        slice_id: currentSliceId,
        display_title: currentTitle,
        error: "batch write conflict preflight failed",
      });
      return;
    }
    const previousSeedIndex = dispatchPhaseState.seedIndex;
    dispatchPhaseState.seedIndex = idx + 1;
    try {
      const outcome = prepareDispatch(seed, delivery, {
        ...kwargs,
        asyncBatchId: resolvedBatchId,
        asyncSliceId: currentSliceId,
        asyncDisplayTitle: currentTitle,
      });
      dispatches.push(outcome);
    } catch (error) {
      if (!isPyCaughtError(error, new Set(["ToolError", "KeyError", "ValueError", "OSError"]))) {
        dispatchPhaseState.seedIndex = previousSeedIndex;
        throw error;
      }
      failedIndexes.push(idx + 1);
      const phase = dispatchPhaseState.phase;
      dispatches.push({
        status: "failed",
        seed_index: idx + 1,
        phase,
        batch_id: resolvedBatchId,
        slice_id: currentSliceId,
        display_title: currentTitle,
        error: `[${phase}] ${error.message}`,
      });
    } finally {
      dispatchPhaseState.seedIndex = previousSeedIndex;
    }
  });
  const committedTaskIds = dispatches.filter((item) => item.status === "ok" && pyTruthy(item.task_id)).map((item) => item.task_id);
  return {
    status: conflicts.length && conflictIndexes.size === seeds.length ? "failed" : (failedIndexes.length ? "partial" : "ok"),
    action: batchAction,
    batch_id: resolvedBatchId,
    count: dispatches.length,
    dispatches,
    failed_seed_indexes: failedIndexes,
    not_submitted_seed_indexes: [],
    committed_task_ids: committedTaskIds,
    ...(conflicts.length ? { batch_write_conflicts: conflicts } : {}),
  };
}

/** Python 的 ensure 形参在 JS 侧是 async（agent_panel_launcher.ensureAgentPanel 为 async），故本函数返回 Promise。 */
export async function attachAgentPanelLaunch(result, { dryRun, ensure = null } = {}) {
  const ensureFn = ensure || deps.ensureAgentPanel;
  if (dryRun) return result;
  let taskIds = [...pyList(pyTruthy(result?.committed_task_ids) ? result.committed_task_ids : [])];
  if (result?.status === "ok"
    && result?.action !== "prepare"
    && result?.delivery_mode === "async_subagent"
    && pyTruthy(result?.task_id)) {
    taskIds = [pyStr(pyGetItem(result, "task_id"))];
  }
  if (!taskIds.length) return result;
  try {
    result.agent_panel_launch = await ensureFn();
  } catch (error) {
    // UI failure is diagnostic only; submitted tasks keep their successful receipt.
    result.agent_panel_launch = {
      status: "failed",
      error: String(error?.message ?? error),
      log_path: BUILD_LOG_PATH,
    };
  }
  return result;
}

export function agentPanelLaunchText(result) {
  const launch = isRecord(result?.agent_panel_launch) ? result.agent_panel_launch : null;
  if (!pyTruthy(launch)) return "";
  const status = pyStr(pyTruthy(launch.status) ? launch.status : "unknown");
  if (status === "failed") {
    return `\n\nAgent Panel 启动失败（不影响已提交任务）：${pyTruthy(launch.error) ? launch.error : "查看 launcher 日志"}`;
  }
  return `\n\nAgent Panel：${status}`;
}

export function checkRouteCard(routeId) {
  const pkg = buildPackage(expandSeed(exampleSeed(routeId)));
  projectConditionalRequiredFiles(pyGetItem(pkg, "task_package"));
  lintOrFail(pkg);
  return null;
}

export function prepareDirectPreview(seed, { asyncModel = "" } = {}) {
  const pkg = buildPackage(seed);
  projectConditionalRequiredFiles(pyGetItem(pkg, "task_package"));
  lintOrFail(pkg);
  return prepareDirect(pkg);
}

/** Python 的 `import dispatch_prepare_selftest` 延迟导入：JS 侧用动态 import 避免循环依赖。 */
export async function selfTest() {
  const selftest = await import("../dispatch_prepare.selftest.mjs");
  return selftest.selfTest();
}

// ---- CLI 支撑（ops/tools/dispatch_prepare.mjs 使用） ----

export { isPyCaughtError, jsonDumpsIndent2, pyList, pySlice, shutilWhich, walkDir };
