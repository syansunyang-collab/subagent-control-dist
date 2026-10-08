import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PanelError } from "./async-core.mjs";
import { ModelConfigError, resolveModelConfigSources } from "../../../../ops/tools/model_config.mjs";
import { createConfigSync } from "./config-sync.mjs";
import { patchDocument, TomlWritebackError } from "./toml-blocks.mjs";
import { loadSelectionConfig, projectCatalog } from "../../../../ops/tools/dispatch-core/model_selection.mjs";
import { loadWorkerResourcesConfig, resolveWorkerResourceCatalog } from "../../../../ops/tools/pi_worker_resources.mjs";
import { isPiModel, normalizePiModel, PiCatalogError, probePiModels } from "../../../../ops/tools/pi_model_catalog.mjs";

export const CONFIG_CONTRACT_VERSION = "panel-config/v1";

// 角色 TOML 允许面板写入的资源白名单字段闭集（角色顶层与 [capabilities.<id>] 同名）；其余字段不经面板。
export const RESOURCE_FIELDS = Object.freeze(["tools", "extensions", "skills", "project_skills"]);
const PROJECT_SKILL_MODES = Object.freeze(["none", "all"]);
// 同上下文分身只有推荐行，不按角色 × 能力发资源。
const RESOURCE_EXEMPT_ROLES = new Set(["delegate-work"]);
// 导入范围：worker-resources.json 中各资源的开放方式、显示名与工具分组；运行必需的工具只改显示名。
// 候选文件由运行器同一个解析器（loadWorkerResourcesConfig）整份校验后才换入。
const IMPORTS_FILE = "ops/templates/worker-resources.json";
const IMPORT_SECTIONS = Object.freeze(["tools", "extensions", "skills"]);
const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const TOML_READ_SCRIPT = 'import tomllib,json,sys;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))';
const TOML_CHECK_SCRIPT = "import tomllib,sys;tomllib.loads(sys.stdin.read())";
const TOML_BATCH_SCRIPT = 'import tomllib,json,sys\nout={}\nfor p in sys.argv[1:]:\n    try:\n        out[p]={"ok":True,"value":tomllib.load(open(p,"rb"))}\n    except Exception:\n        out[p]={"ok":False}\nprint(json.dumps(out))';

export class ConfigError extends PanelError {
  constructor(code, message, options = {}) {
    super(code, message, { status: options.status ?? 400, scope: "local", details: options.details ?? null });
  }
}

export function publishedRuntimeRoot() {
  return path.join(os.homedir(), ".pi", "agent", "extensions", "subagent-control");
}

export function resolveConfigSources(sourceRoot) {
  try {
    return resolveModelConfigSources({
      roots: [{ root: sourceRoot, source: "control_repo" }],
      projectRoot: sourceRoot,
    });
  } catch (error) {
    if (error instanceof ModelConfigError) {
      throw new ConfigError("CONFIG_SOURCE_INVALID", error.message, { status: 503 });
    }
    throw error;
  }
}

function valuesEqual(expected, actual) {
  if (expected === actual) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((item, index) => valuesEqual(item, actual[index]));
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    return expectedKeys.length === actualKeys.length
      && expectedKeys.every((key) => Object.hasOwn(actual, key) && valuesEqual(expected[key], actual[key]));
  }
  return false;
}

function revisionOf(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Python tomllib 一次性子进程：读取解析与候选校验都借道标准解析器，不手写 TOML 读取。
// ---------------------------------------------------------------------------

export function resolvePythonCommand(controlRoot, override) {
  if (override) return override;
  if (process.env.AGENT_PANEL_PYTHON) return process.env.AGENT_PANEL_PYTHON;
  const venv = path.join(controlRoot, ".venv", "Scripts", "python.exe");
  if (existsSync(venv)) return venv;
  return "python";
}

function runPython(pythonCommand, args, input) {
  const outcome = spawnSync(pythonCommand, args, {
    input,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  if (outcome.error) {
    throw new ConfigError("CONFIG_PYTHON_UNAVAILABLE", "TOML 解析器进程不可用", { status: 503 });
  }
  return outcome;
}

function parseTomlFile(pythonCommand, filePath) {
  const outcome = runPython(pythonCommand, ["-c", TOML_READ_SCRIPT, filePath]);
  if (outcome.status !== 0) {
    throw new ConfigError("CONFIG_SOURCE_INVALID", "配置源不可读或 TOML 无效", { status: 503 });
  }
  try {
    return JSON.parse(outcome.stdout);
  } catch {
    throw new ConfigError("CONFIG_SOURCE_INVALID", "配置源解析结果无效", { status: 503 });
  }
}

function validateTomlText(pythonCommand, text) {
  const outcome = runPython(pythonCommand, ["-c", TOML_CHECK_SCRIPT], text);
  return outcome.status === 0;
}

// ---------------------------------------------------------------------------
// 事务落盘：备份 → 临时文件原子换入 → 回读复验；任何失败尽力回滚并如实分级上报。
// ---------------------------------------------------------------------------

function saveTextTransactional(filePath, candidate, pythonCommand, faultInjector = null, verifyParsed = null, expectedRevision = null) {
  if (!validateTomlText(pythonCommand, candidate)) {
    return { state: "validation_error" };
  }
  if (faultInjector === "external-edit-before-recheck") {
    writeFileSync(filePath, `${readFileSync(filePath, "utf8")}# external-edit\n`, "utf8");
  }
  // CAS 晚重验：python 校验子进程耗时 ~300ms，早检窗口内的外部编辑会被覆盖；
  // 备份/换入前用新鲜内容再比一次 revision（三堂会审 sol#2/opus F-8）
  if (expectedRevision !== null) {
    const fresh = readFileSync(filePath, "utf8");
    if (revisionOf(fresh) !== expectedRevision) {
      return { state: "revision_conflict", current_revision: revisionOf(fresh) };
    }
  }
  const suffix = randomBytes(4).toString("hex");
  const backupPath = `${filePath}.panel-bak-${suffix}`;
  const tempPath = `${filePath}.panel-tmp-${suffix}`;
  copyFileSync(filePath, backupPath);
  let failureReason = "write_failed";
  try {
    if (faultInjector === "after-backup") throw new Error("fault: after-backup");
    writeFileSync(tempPath, candidate, "utf8");
    renameSync(tempPath, filePath);
    if (faultInjector === "after-replace") throw new Error("fault: after-replace");
    const reread = readFileSync(filePath, "utf8");
    if (reread !== candidate || !validateTomlText(pythonCommand, reread)) {
      throw new Error("post-write verification failed");
    }
    // 语义终局复验：解析落盘结果，逐键核对"实际写成的值 == 用户意图"。
    // 前面所有关卡挡的都是"非法 TOML"；这一道挡"合法但语义错位"（复核 F2/F6/F8/F11 类）。
    let parsed = null;
    if (verifyParsed) {
      parsed = parseTomlFile(pythonCommand, filePath);
      if (!verifyParsed(parsed)) {
        failureReason = "semantic_verify_failed";
        throw new Error("semantic verification failed");
      }
    }
    rmSync(backupPath, { force: true });
    return { state: "saved", text: candidate, parsed };
  } catch {
    try { rmSync(tempPath, { force: true }); } catch { /* 清理失败不掩盖主错误 */ }
    try {
      copyFileSync(backupPath, filePath);
      rmSync(backupPath, { force: true });
      return { state: "save_error_restored", reason: failureReason };
    } catch {
      return { state: "save_error_restore_failed", reason: failureReason, backup_path: path.basename(backupPath) };
    }
  }
}

// ---------------------------------------------------------------------------
// 模型目录通过异步 Pi RPC 独立读取；本地配置读取不启动 Pi。
// 保留最近成功目录供展示，刷新失败时标旧；依赖目录的新配置仍需成功校验。
// ---------------------------------------------------------------------------

export function resolveDefaultPiCommand(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const exists = options.exists || existsSync;
  const node = options.node || process.execPath;
  if (platform === "win32") {
    const cli = path.join(
      env.APPDATA || path.join(env.USERPROFILE || "", "AppData", "Roaming"),
      "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js",
    );
    if (exists(cli)) return [node, cli];
    return ["pi.cmd"];
  }
  return ["pi"];
}

async function loadPiScopeSdk(piCommand) {
  const invocation = Array.isArray(piCommand) ? piCommand : [piCommand];
  const cli = invocation.find((part) => typeof part === "string" && /\.[cm]?js$/i.test(part));
  if (cli) return import(pathToFileURL(path.join(path.dirname(path.resolve(cli)), "index.js")).href);
  // npm 的 POSIX pi 是指向 cli.js 的符号链接；Windows 默认命令已直接给出 cli.js。
  const executable = invocation[0];
  if (typeof executable === "string") {
    const paths = path.isAbsolute(executable) ? [executable] : (process.env.PATH || "").split(path.delimiter).map((dir) => path.join(dir, executable));
    const found = paths.find((candidate) => existsSync(candidate));
    if (found) {
      const index = path.join(path.dirname(realpathSync(found)), "index.js");
      if (existsSync(index)) return import(pathToFileURL(index).href);
    }
  }
  return import("@earendil-works/pi-coding-agent");
}

export async function scopePiModels(models, { cwd, piCommand = resolveDefaultPiCommand(), agentDir, loadSdk = loadPiScopeSdk } = {}) {
  const { SettingsManager, resolveModelScopeWithDiagnostics } = await loadSdk(piCommand);
  const settings = SettingsManager.create(cwd, agentDir);
  if (settings.drainErrors().length) {
    throw new ConfigError("PI_MODEL_SCOPE_INVALID", "Pi 白名单配置读取失败，请检查 settings.json", { status: 503 });
  }
  const patterns = (settings.getEnabledModels() || []).map((pattern) => pattern.trim()).filter(Boolean);
  if (!patterns.length) return [];
  const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, { getAvailable: async () => models });
  return scopedModels.map((entry) => entry.model);
}

async function loadPiCatalog(probe, scopeModels, controlRoot, piCommand, signal, timeoutMs) {
  let mainModels;
  try {
    mainModels = await probe({ cwd: controlRoot, command: piCommand, signal, timeoutMs });
    if (!Array.isArray(mainModels)) throw new ConfigError("PI_RPC_RESPONSE_INVALID", "Pi RPC 返回的模型目录不是数组");
    mainModels = await scopeModels(mainModels, { cwd: controlRoot, piCommand });
    if (!Array.isArray(mainModels)) throw new ConfigError("PI_MODEL_SCOPE_INVALID", "Pi 白名单解析结果不是数组");
  } catch (error) {
    const known = error instanceof ConfigError || error instanceof PiCatalogError;
    return { available: false, error: known ? error.message : "Pi 模型目录读取失败，请重试目录", error_code: known ? error.code : "PI_RPC_FAILED", source: "pi-rpc/get_available_models", models: [] };
  }
  const models = mainModels.filter(isPiModel).map((model) => ({ ...model, ...normalizePiModel(model) }));
  return { available: true, error: "", source: "pi-rpc/get_available_models", models };
}

// ---------------------------------------------------------------------------
// 子代理资源白名单：角色 × 能力的 tools / extensions / skills / project_skills
// ---------------------------------------------------------------------------

const EMPTY_RESOURCE_CATALOG = Object.freeze({ available: false, error: "", tools: [], extensions: [], skills: [], project_skills: [], required_tools: [], diagnostics: [] });

// 资源目录读不出时界面只显示稳定的提示，原始异常（含本机路径）写到服务 stderr。
const CATALOG_UNAVAILABLE = "无法读取本机 Pi 的插件与技能目录，请确认 Pi 已安装后重试";
const IMPORTS_UNREADABLE = "导入范围文件内容无效，请按服务日志中的提示修正后重试";

function normalizeResourceCatalog(raw) {
  const { tools, extensions, skills, project_skills: projectSkills, required_tools: requiredTools, diagnostics } = raw;
  return { available: true, error: "", tools, extensions, skills, project_skills: projectSkills, required_tools: requiredTools, diagnostics };
}

function capabilityTables(parsed) {
  const tables = parsed?.capabilities;
  return tables && typeof tables === "object" && !Array.isArray(tables) ? tables : {};
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : null;
}

/** 字段缺省投影为 null：角色级表示未配置，能力级表示继承角色。 */
function resourceValues(source) {
  const projectSkills = source?.project_skills;
  return {
    tools: stringList(source?.tools),
    extensions: stringList(source?.extensions),
    skills: stringList(source?.skills),
    project_skills: PROJECT_SKILL_MODES.includes(projectSkills) ? projectSkills : stringList(projectSkills),
  };
}

function assertResourceValue(field, value, location) {
  if (field === "project_skills" && PROJECT_SKILL_MODES.includes(value)) return;
  const valid = Array.isArray(value)
    && value.every((item) => typeof item === "string" && item.trim() === item && item)
    && new Set(value).size === value.length;
  if (!valid) {
    const shape = field === "project_skills" ? '"none"、"all" 或不重复的名称数组' : "不重复的名称数组";
    throw new ConfigError("CONFIG_VALUE_INVALID", `${location} 需要${shape}`, { details: { location } });
  }
}

// 未开放或未安装的名字照常保存：运行时跳过这些资源并记警告，面板只提示。警告为 { code, field, message }。
function unavailableNames(field, value, catalog, location) {
  if (!Array.isArray(value) || field === "project_skills") return [];
  const usable = catalog[field].filter((item) => item.installed && item.access !== "off").map((item) => item.name);
  const unknown = value.filter((name) => !usable.includes(name));
  return unknown.length ? [{ code: "RESOURCE_UNAVAILABLE", field: location, message: `含未开放或未安装的资源，运行时不会加载：${unknown.join(", ")}` }] : [];
}

/** 能力值只能收窄角色值；返回首个放宽处的位置与越界项。 */
function widening(roleValue, capabilityValue) {
  if (capabilityValue === null || capabilityValue === undefined || capabilityValue === "none") return null;
  if (roleValue === "all") return null;
  if (capabilityValue === "all") return ["all"];
  const allowed = Array.isArray(roleValue) ? roleValue : [];
  const extra = capabilityValue.filter((name) => !allowed.includes(name));
  return extra.length ? extra : null;
}

// ---------------------------------------------------------------------------
// ConfigStore 本体
// ---------------------------------------------------------------------------

export function createConfigStore(options = {}) {
  const launchRoot = path.resolve(String(options.controlRoot));
  const sync = createConfigSync({
    controlRoot: launchRoot,
    browser: options.browser,
    homeDir: options.homeDir,
    listSlots: options.listSlots,
    faultInjector: options.syncFaultInjector,
  });
  let controlRoot = launchRoot;
  let configSources = null;
  let agentsRoot = path.join(controlRoot, "ops", "agents");
  const pythonCommand = resolvePythonCommand(controlRoot, options.pythonCommand);
  const piModelProbe = options.piModelProbe || probePiModels;
  const piModelScope = options.piModelScope || scopePiModels;
  const piCommand = options.piCommand || resolveDefaultPiCommand();
  const faultInjector = options.faultInjector ?? null;
  const workerResourceCatalog = options.workerResourceCatalog || resolveWorkerResourceCatalog;
  const agentDir = options.homeDir ? path.join(options.homeDir, ".pi", "agent") : undefined;

  // 原文相同才复用解析结果；不以文件时间戳或大小代理实际输入。
  // 没有缓存时一次 state() 要 14 次 spawnSync，单线程服务被阻塞 ~1.7s（复核 F5）。
  const parseCache = new Map();
  let piCatalogCache = null;
  let piCatalogCachedAt = 0;
  let piCatalogInFlight = null;
  const probeController = new AbortController();
  const piCatalogCacheMs = Number.isFinite(options.piCatalogCacheMs) ? Number(options.piCatalogCacheMs) : 60000;

  function readSource(filePath) {
    try {
      return readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  }

  function cacheGet(filePath) {
    const source = readSource(filePath);
    if (source === null) return { hit: false, source };
    const entry = parseCache.get(filePath);
    if (entry && entry.source === source) return { hit: true, value: entry.value, source };
    return { hit: false, source };
  }

  function cachePut(filePath, value, source = readSource(filePath)) {
    if (source !== null) parseCache.set(filePath, { source, value });
  }

  function getParsedToml(filePath) {
    const cached = cacheGet(filePath);
    if (cached.hit) return cached.value;
    const parsed = parseTomlFile(pythonCommand, filePath);
    cachePut(filePath, parsed, cached.source);
    return parsed;
  }

  function warmTomlCache(paths) {
    const misses = paths.filter((filePath) => existsSync(filePath) && !cacheGet(filePath).hit);
    if (!misses.length) return;
    if (misses.length === 1) {
      try { getParsedToml(misses[0]); } catch { /* 单文件失败由后续调用点按各自语义处理 */ }
      return;
    }
    const outcome = runPython(pythonCommand, ["-c", TOML_BATCH_SCRIPT, ...misses]);
    if (outcome.status !== 0) return;
    let batch;
    try { batch = JSON.parse(outcome.stdout); } catch { return; }
    for (const filePath of misses) {
      const entry = batch[filePath];
      if (entry?.ok) cachePut(filePath, entry.value);
    }
  }

  function loadRoster() {
    let files;
    try {
      files = readdirSync(agentsRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
        .map((entry) => path.join(agentsRoot, entry.name))
        .sort((left, right) => left.localeCompare(right));
    } catch {
      throw new ConfigError("CONFIG_SOURCE_MISSING", "控制仓缺少可读的 ops/agents/ 角色目录", { status: 503 });
    }
    warmTomlCache(files);
    return files.map((file) => {
      const fileRole = path.basename(file, ".toml");
      if (!ROLE_RE.test(fileRole)) {
        throw new ConfigError("CONFIG_ROLE_INVALID", `角色文件名格式无效：${path.basename(file)}`, { status: 500 });
      }
      const parsed = getParsedToml(file);
      if (parsed?.name !== fileRole) {
        throw new ConfigError("CONFIG_ROLE_NAME_MISMATCH", `角色文件 ${path.basename(file)} 的 name 必须等于 ${fileRole}`, { status: 500 });
      }
      return { role: fileRole, file };
    });
  }

  function roleEntry(roleName) {
    const roster = loadRoster();
    const entry = roster.find((item) => item.role === roleName);
    if (!entry) {
      throw new ConfigError("CONFIG_ROLE_UNKNOWN", "角色不在 ops/agents/*.toml 中", { status: 404 });
    }
    return entry;
  }

  // 任务类型取自选型解析（路由卡），再并上角色卡已有的 [capabilities.<id>]。
  function routeCapabilities() {
    const { roles } = projectCatalog(loadSelectionConfig(configSources), {});
    return new Map(roles.map((role) => [role.role, role.capabilities.map((item) => item.id)]));
  }

  function capabilityIds(roleName, parsed, routes) {
    const ids = [...(routes.get(roleName) || [])];
    for (const id of Object.keys(capabilityTables(parsed))) if (!ids.includes(id)) ids.push(id);
    return ids;
  }

  function readRole(entry, routes = new Map()) {
    if (!existsSync(entry.file)) return { role: entry.role, missing: true, revision: null, capabilities: [] };
    const text = readFileSync(entry.file, "utf8");
    const parsed = getParsedToml(entry.file);
    const tables = capabilityTables(parsed);
    return { role: entry.role, missing: false, revision: revisionOf(text), ...resourceValues(parsed),
      capabilities: capabilityIds(entry.role, parsed, routes).map((id) => ({ id, ...resourceValues(tables[id]) })) };
  }

  async function resourceCatalog(monitorRoot) {
    try {
      return normalizeResourceCatalog(await workerResourceCatalog({ cwd: path.resolve(monitorRoot || controlRoot), agentDir, configPath: importsPath() }));
    } catch (error) {
      console.error(`agent-panel resource catalog unavailable: ${error?.stack || error}`);
      return { ...EMPTY_RESOURCE_CATALOG, available: false, error: error?.field ? IMPORTS_UNREADABLE : CATALOG_UNAVAILABLE };
    }
  }

  function catalogs() {
    const cached = piCatalogCache || { available: false, error: "", models: [], source: "pi-rpc/get_available_models" };
    return {
      pi: { ...cached, loading: piCatalogInFlight !== null, stale: cached.available && (Boolean(cached.error) || Date.now() - piCatalogCachedAt >= piCatalogCacheMs), checked_at: piCatalogCachedAt ? new Date(piCatalogCachedAt).toISOString() : null },
    };
  }

  async function refreshCatalogs({ force = false } = {}) {
    if (!piCatalogInFlight && (force || !piCatalogCache?.available || piCatalogCache.error || Date.now() - piCatalogCachedAt >= piCatalogCacheMs)) {
      piCatalogInFlight = loadPiCatalog(piModelProbe, piModelScope, controlRoot, piCommand, probeController.signal, options.piProbeTimeoutMs)
        .then((result) => {
          if (result.available) {
            piCatalogCache = result;
            piCatalogCachedAt = Date.now();
          } else {
            // 失败不覆盖成功目录，不缓存失败等待期；下一次显式重试可立即发起。
            piCatalogCache = piCatalogCache?.available
              ? { ...piCatalogCache, error: result.error, error_code: result.error_code }
              : result;
          }
        }).finally(() => { piCatalogInFlight = null; });
    }
    await piCatalogInFlight;
    return catalogs();
  }

  async function close() {
    probeController.abort();
    await piCatalogInFlight;
  }

  function requireSources() {
    if (configSources) return;
    controlRoot = sync.resolveSources().control_root;
    configSources = resolveConfigSources(controlRoot);
    agentsRoot = configSources.agents_dir;
  }

  function importsPath() {
    return path.join(controlRoot, ...IMPORTS_FILE.split("/"));
  }

  function state() {
    requireSources();
    const roster = loadRoster();
    const routes = routeCapabilities();
    return {
      contract_version: CONFIG_CONTRACT_VERSION,
      control_repo_path: controlRoot,
      config_source: configSources.describe(),
      sync_status: sync.status(),
      roles: roster.filter((entry) => !RESOURCE_EXEMPT_ROLES.has(entry.role)).map((entry) => readRole(entry, routes)),
      imports_revision: revisionOf(readFileSync(importsPath(), "utf8")),
      catalogs: catalogs(),
    };
  }

  // 基础投影只读真源和同步状态；资源注册探测由独立接口按需发起。
  function configState() {
    return state();
  }

  function validateRoleUpdates(updates, knownCapabilities) {
    if (!updates || typeof updates !== "object" || Array.isArray(updates) || !Object.keys(updates).length) {
      throw new ConfigError("CONFIG_UPDATE_EMPTY", "没有可保存的字段");
    }
    for (const [key, value] of Object.entries(updates)) {
      if (RESOURCE_FIELDS.includes(key)) {
        assertResourceValue(key, value, key);
        continue;
      }
      if (key !== "capabilities") throw new ConfigError("CONFIG_FIELD_REJECTED", `角色字段不经配置页写入：${key}`);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ConfigError("CONFIG_VALUE_INVALID", "capabilities 需要以能力 id 为键的对象");
      }
      for (const [id, fields] of Object.entries(value)) {
        const at = `capabilities.${id}`;
        if (!knownCapabilities.includes(id)) {
          throw new ConfigError("CONFIG_CAPABILITY_UNKNOWN", `${at} 不是该角色的能力`, { details: { location: at } });
        }
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
          throw new ConfigError("CONFIG_VALUE_INVALID", `${at} 需要对象`, { details: { location: at } });
        }
        for (const [field, item] of Object.entries(fields)) {
          const location = `${at}.${field}`;
          if (!RESOURCE_FIELDS.includes(field)) throw new ConfigError("CONFIG_FIELD_REJECTED", `能力字段不经配置页写入：${location}`, { details: { location } });
          if (item !== null) assertResourceValue(field, item, location);
        }
      }
    }
  }

  // 保存后的整卡资源值：角色级取更新值或原值；能力级只含显式收窄的键，null 删键回到继承。
  function mergedResources(parsed, updates, ids) {
    const role = resourceValues(parsed);
    for (const field of RESOURCE_FIELDS) if (Object.hasOwn(updates, field)) role[field] = updates[field];
    const tables = capabilityTables(parsed);
    const capabilities = {};
    for (const id of ids) {
      const values = resourceValues(tables[id]);
      const current = Object.fromEntries(RESOURCE_FIELDS.filter((field) => Object.hasOwn(tables[id] || {}, field)).map((field) => [field, values[field]]));
      for (const [field, value] of Object.entries(updates.capabilities?.[id] || {})) {
        if (value === null) delete current[field];
        else current[field] = value;
      }
      capabilities[id] = current;
    }
    return { role, capabilities };
  }

  function assertNarrowing({ role, capabilities }) {
    for (const [id, fields] of Object.entries(capabilities)) {
      for (const [field, value] of Object.entries(fields)) {
        const extra = widening(role[field], value);
        if (!extra) continue;
        const location = `capabilities.${id}.${field}`;
        throw new ConfigError("CONFIG_CAPABILITY_WIDENS", `超出角色已勾选的范围：${extra.join(", ")}`, { details: { location, names: extra } });
      }
    }
  }

  // 资源键以外的内容（推荐行、提示词、inherit_role_picks 等）必须原样保留。
  function withoutResources(parsed) {
    const rest = Object.fromEntries(Object.entries(parsed).filter(([key]) => !RESOURCE_FIELDS.includes(key) && key !== "capabilities"));
    const tables = Object.fromEntries(Object.entries(capabilityTables(parsed)).map(([id, table]) => [id,
      Object.fromEntries(Object.entries(table).filter(([key]) => !RESOURCE_FIELDS.includes(key)))]));
    return { rest, tables };
  }

  // 目标数据与删键路径：能力表删到不剩键时整段移除；最后一张也删掉时连同父表移除。
  function roleWriteTarget(parsed, updates) {
    const target = Object.fromEntries(RESOURCE_FIELDS.filter((field) => Object.hasOwn(updates, field)).map((field) => [field, updates[field]]));
    const tables = capabilityTables(parsed);
    const writes = {};
    const cleared = [];
    const dropped = [];
    for (const [id, fields] of Object.entries(updates.capabilities || {})) {
      const existing = tables[id] || {};
      const set = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
      const removed = Object.keys(fields).filter((field) => fields[field] === null && Object.hasOwn(existing, field));
      const remaining = Object.keys(existing).filter((key) => !removed.includes(key) && !Object.hasOwn(set, key));
      if (Object.keys(set).length) writes[id] = set;
      else if (!remaining.length && Object.hasOwn(tables, id)) { dropped.push(id); continue; }
      cleared.push(...removed.map((field) => ["capabilities", id, field]));
    }
    if (Object.keys(writes).length) target.capabilities = writes;
    const survivors = Object.keys(tables).filter((id) => !dropped.includes(id));
    const deletedPaths = Object.keys(tables).length && !survivors.length && !Object.keys(writes).length
      ? [["capabilities"]]
      : [...dropped.map((id) => ["capabilities", id]), ...cleared];
    return { target, deletedPaths };
  }

  async function saveRole(roleName, { updates, expected_revision: expectedRevision } = {}, monitorRoot = null) {
    requireSources();
    if (!ROLE_RE.test(String(roleName))) throw new ConfigError("CONFIG_ROLE_INVALID", "角色名格式无效");
    const entry = roleEntry(roleName);
    if (RESOURCE_EXEMPT_ROLES.has(entry.role)) throw new ConfigError("CONFIG_ROLE_INVALID", `${entry.role} 不配置资源白名单`);
    if (!existsSync(entry.file)) throw new ConfigError("CONFIG_SOURCE_MISSING", "角色 TOML 文件不存在", { status: 404 });
    const parsed = getParsedToml(entry.file);
    const ids = capabilityIds(entry.role, parsed, routeCapabilities());
    validateRoleUpdates(updates, ids);
    if (typeof expectedRevision !== "string" || !expectedRevision) throw new ConfigError("CONFIG_REVISION_REQUIRED", "缺少 expected_revision");
    const catalog = await resourceCatalog(monitorRoot);
    const warnings = [];
    if (!catalog.available) warnings.push({ code: "RESOURCE_CATALOG_UNAVAILABLE", field: null, message: `资源目录不可用，资源名未核对：${catalog.error}` });
    else {
      for (const field of RESOURCE_FIELDS) if (Object.hasOwn(updates, field)) warnings.push(...unavailableNames(field, updates[field], catalog, field));
      for (const [id, fields] of Object.entries(updates.capabilities || {})) {
        for (const [field, value] of Object.entries(fields)) warnings.push(...unavailableNames(field, value, catalog, `capabilities.${id}.${field}`));
      }
    }
    const merged = mergedResources(parsed, updates, ids);
    assertNarrowing(merged);
    const text = readFileSync(entry.file, "utf8");
    if (revisionOf(text) !== expectedRevision) return { state: "revision_conflict", current_revision: revisionOf(text) };
    const { target, deletedPaths } = roleWriteTarget(parsed, updates);
    let candidate;
    try {
      candidate = patchDocument(text, target, { file: path.basename(entry.file), deletedPaths, rootAnchor: "tools" });
    } catch (error) {
      if (!(error instanceof TomlWritebackError)) throw error;
      return { state: "validation_error", errors: [{ code: error.code, file: path.basename(entry.file), field: null, message: error.message }] };
    }
    const untouched = withoutResources(parsed);
    const outcome = saveTextTransactional(entry.file, candidate, pythonCommand, faultInjector, (written) => {
      const after = withoutResources(written);
      const values = resourceValues(written);
      const writtenTables = capabilityTables(written);
      return valuesEqual(after.rest, untouched.rest)
        && Object.entries(untouched.tables).every(([id, table]) => !Object.keys(table).length || valuesEqual(after.tables[id], table))
        && RESOURCE_FIELDS.every((field) => valuesEqual(values[field], merged.role[field]))
        && Object.entries(merged.capabilities).every(([id, fields]) => RESOURCE_FIELDS.every((field) => (Object.hasOwn(fields, field)
          ? valuesEqual(resourceValues(writtenTables[id])[field], fields[field])
          : !Object.hasOwn(writtenTables[id] || {}, field))));
    }, expectedRevision);
    if (outcome.state !== "saved") return outcome;
    if (outcome.parsed) cachePut(entry.file, outcome.parsed);
    const file = path.relative(controlRoot, entry.file).split(path.sep).join("/");
    return { state: "saved", revision: revisionOf(outcome.text), role: readRole(entry, routeCapabilities()),
      write_results: [{ file, ok: true }], warnings, ...sync.syncWritten([file]) };
  }

  // 导入范围整文件 CAS：按条目改开放方式、显示名与分组；本机已装但未记录的资源保存时补建条目。
  function saveImports({ updates, expected_revision: expectedRevision } = {}) {
    requireSources();
    const file = importsPath();
    const text = readFileSync(file, "utf8");
    if (revisionOf(text) !== expectedRevision) return { state: "revision_conflict", current_revision: revisionOf(text) };
    const data = JSON.parse(text);
    const invalid = (code, field, message) => ({ state: "validation_error", errors: [{ code, file: IMPORTS_FILE, field, message }] });
    for (const [section, entries] of Object.entries(updates || {})) {
      if (!IMPORT_SECTIONS.includes(section)) return invalid("CONFIG_VALUE_INVALID", section, "不是可编辑的资源类别");
      for (const [name, fields] of Object.entries(entries)) {
        // 新条目由本次提交的字段建出，缺 access 等问题交给下面的整份校验。
        const entry = (data[section][name] ??= {});
        for (const [field, value] of Object.entries(fields)) {
          const at = `${section}.${name}.${field}`;
          if (section === "tools" && data.required_tools.includes(name) && field !== "label") return invalid("CONFIG_VALUE_INVALID", at, "运行必需的工具只能修改显示名");
          if (typeof value !== "string") return invalid("CONFIG_VALUE_INVALID", at, "必须是字符串");
          if (value.trim()) entry[field] = value.trim();
          else delete entry[field];
        }
      }
    }
    const candidate = `${JSON.stringify(data, null, 2)}\n`;
    const temporary = `${file}.panel-tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(temporary, candidate, "utf8");
    try { loadWorkerResourcesConfig(temporary); }
    catch (error) {
      rmSync(temporary, { force: true });
      if (!error.field) throw error;
      return invalid(error.code, error.field, error.message.slice(error.message.indexOf("：") + 1));
    }
    // 换入前再核对一次，写临时文件期间的外部编辑不被覆盖。
    const fresh = readFileSync(file, "utf8");
    if (revisionOf(fresh) !== expectedRevision) {
      rmSync(temporary, { force: true });
      return { state: "revision_conflict", current_revision: revisionOf(fresh) };
    }
    renameSync(temporary, file);
    return { state: "saved", revision: revisionOf(candidate), write_results: [{ file: IMPORTS_FILE, ok: true }], ...sync.syncWritten([IMPORTS_FILE]) };
  }

  return { state, configState, resourceCatalog, catalogs, refreshCatalogs, saveRole, saveImports, close };
}
