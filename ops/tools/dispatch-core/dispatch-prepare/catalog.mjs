import path from "node:path";
import process from "node:process";

import { ToolError, isAbsoluteLikePython, resolveLikePython, ROOT } from "../_tool_common.mjs";
import { pySpawnSync, pyStr, pyStrip, pyTruthy } from "../_py.mjs";
import {
  CATALOG_CACHE_FILE_NAME,
  CATALOG_CACHE_SCHEMA,
  catalogCacheKey,
  fingerprintPaths,
  readCatalogCacheEntry,
  writeCatalogCacheEntry,
} from "../model_catalog_cache.mjs";
import {
  PI_CHILD_MODEL_EXTENSION_PROFILE,
  resolvePiChildModelExtensions,
} from "../../pi_model_extension_profile.mjs";
import { piModelDetails, probePiModelsSync } from "../../pi_model_catalog.mjs";
import { resolvePiAgentDir } from "../../pi_settings_packages.mjs";
import { deps } from "./deps.mjs";
import { isFile, pySlice, shutilWhich, sortedStrings } from "./py-utils.mjs";
import { caches } from "./state.mjs";

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

// The user's global rule forbids Fable as a subagent model. Model providers reach it on the
// Pi rail (pi-claude-code-provider, cursor-host), so the child catalog never lists it and an
// explicit request is refused even when the catalog probe is unavailable.
const DENIED_CHILD_MODEL = /fable/i;

export function requireAllowedChildModel(model) {
  if (DENIED_CHILD_MODEL.test(String(model))) {
    throw new ToolError(
      `model ${model} is a Fable model, which is not allowed for subagents; nothing was dispatched. `
      + "Choose a non-Fable model and retry.",
    );
  }
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
  const source = `pi rpc get_available_models (${extensionProfile.profile})`;
  const unavailable = (error) => ({ status: "unavailable", models: [], model_count: 0, source, error });
  if (!command.length || pyTruthy(extensionProfile.error)) {
    return unavailable(pyTruthy(extensionProfile.error) ? extensionProfile.error : "Pi executable not found");
  }
  let raw;
  try {
    raw = probePiModelsSync({
      cwd: String(targetCwd),
      command,
      args: ["--no-extensions", "--no-approve", ...extensionProfile.extensions.flatMap((extensionPath) => ["-e", extensionPath])],
      runSync: pySpawnSync,
    });
  } catch (error) {
    return unavailable(pySlice(String(error?.message ?? error), 500));
  }
  // model_details 是选型事实的真源：图像输入、Pi 支持档位与实际发送值、上下文窗口。
  const details = Object.fromEntries(Object.entries(piModelDetails(raw)).filter(([key]) => !DENIED_CHILD_MODEL.test(key)));
  const ordered = sortedStrings(Object.keys(details));
  if (!ordered.length) return unavailable("Pi returned no child models");
  return {
    status: "ok",
    models: ordered,
    model_details: Object.fromEntries(ordered.map((key) => [key, details[key]])),
    model_count: ordered.length,
    source,
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
  requireAllowedChildModel(model);
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

export {
  piChildCatalogCommandImpl,
  piChildModelExtensionProfileImpl,
  probePiChildModelCatalogImpl,
  probePiChildModelCatalogUncachedImpl,
};
