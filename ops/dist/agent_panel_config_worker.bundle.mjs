// src/agent-panel/src/server/config-worker.mjs
import { parentPort, workerData } from "node:worker_threads";

// src/agent-panel/src/server/config-store.mjs
import { spawn as spawn2, spawnSync } from "node:child_process";
import { createHash as createHash3, randomBytes as randomBytes2 } from "node:crypto";
import { copyFileSync, existsSync as existsSync5, readFileSync as readFileSync6, readdirSync as readdirSync3, realpathSync as realpathSync3, renameSync as renameSync3, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "node:fs";
import path7 from "node:path";
import { pathToFileURL as pathToFileURL3 } from "node:url";

// src/agent-panel/src/server/async-core.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var MODULE_FILE = fileURLToPath(import.meta.url);
var BUNDLED_MODULE = MODULE_FILE.endsWith(".bundle.mjs");
var PANEL_ROOT = BUNDLED_MODULE ? path.resolve(path.dirname(MODULE_FILE), "..", "..", "src", "agent-panel") : path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
var MODULE_ROOT = PANEL_ROOT;
var DEFAULT_CONTROL_REPO_PATH = path.resolve(MODULE_ROOT, "..", "..");
var PanelError = class extends Error {
  constructor(code, message, { status = 503, scope = "global", details = null } = {}) {
    super(message);
    this.name = "PanelError";
    this.code = code;
    this.status = status;
    this.scope = scope;
    this.details = details;
  }
};

// ops/tools/model_config.mjs
import { existsSync, readFileSync, statSync } from "node:fs";
import path2 from "node:path";
import process2 from "node:process";
var MODEL_CONFIG_DECLARATION_SEGMENTS = Object.freeze([".pi", "control-plane-model-config.json"]);
var MODEL_CONFIG_SCHEMA_VERSION = 1;
var MODEL_CONFIG_ASSETS = Object.freeze({
  agents_dir: Object.freeze({ kind: "dir", relative: Object.freeze(["ops", "agents"]) }),
  model_notes: Object.freeze({ kind: "file", relative: Object.freeze(["ops", "model-notes.toml"]) })
});
var MODEL_CONFIG_ASSET_KEYS = Object.freeze(Object.keys(MODEL_CONFIG_ASSETS));
var MODEL_CONFIG_REQUIRED_KEYS = Object.freeze(["agents_dir", "model_notes"]);
var ModelConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelConfigError";
    this.code = "MODEL_CONFIG_INVALID";
  }
};
function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function samePath(left, right) {
  const normalizedLeft = path2.resolve(String(left));
  const normalizedRight = path2.resolve(String(right));
  return process2.platform === "win32" ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US") : normalizedLeft === normalizedRight;
}
function isInsideProject(target, projectRoot2) {
  const normalizedTarget = process2.platform === "win32" ? path2.resolve(target).toLocaleLowerCase("en-US") : path2.resolve(target);
  const normalizedRoot = process2.platform === "win32" ? path2.resolve(projectRoot2).toLocaleLowerCase("en-US") : path2.resolve(projectRoot2);
  if (normalizedTarget === normalizedRoot) return true;
  return normalizedTarget.startsWith(`${normalizedRoot}${path2.sep}`);
}
function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}
function assetExists(target, key) {
  return MODEL_CONFIG_ASSETS[key].kind === "dir" ? isDirectory(target) : isFile(target);
}
function globalModelConfigAssetPath(root, key) {
  if (!MODEL_CONFIG_ASSETS[key]) throw new ModelConfigError(`\u672A\u77E5\u7684\u6A21\u578B\u914D\u7F6E\u8D44\u4EA7\uFF1A${key}`);
  return path2.join(path2.resolve(String(root)), ...MODEL_CONFIG_ASSETS[key].relative);
}
function inspectGlobalModelConfig(root) {
  const resolved = path2.resolve(String(root));
  const missing = MODEL_CONFIG_REQUIRED_KEYS.filter((key) => !assetExists(globalModelConfigAssetPath(resolved, key), key));
  return { root: resolved, complete: missing.length === 0, missing };
}
function resolveGlobalModelConfigRoot({ roots = [] } = {}) {
  const inspected = [];
  for (const entry of roots) {
    const raw = typeof entry === "string" ? entry : entry?.root;
    if (!text(raw)) continue;
    const source = typeof entry === "string" ? "runtime_root" : String(entry?.source || "runtime_root");
    const inspection = inspectGlobalModelConfig(raw);
    if (inspection.complete) return { root: inspection.root, source };
    if (inspected.some((item) => samePath(item.root, inspection.root))) continue;
    inspected.push({ root: inspection.root, source, missing: inspection.missing });
  }
  const detail = inspected.length ? inspected.map((item) => `${item.root}\uFF08${item.source}\uFF09\u7F3A\u5C11 ${item.missing.join(", ")}`).join("\uFF1B") : "\u6CA1\u6709\u53EF\u7528\u7684\u5019\u9009\u8FD0\u884C\u6839";
  throw new ModelConfigError(
    `\u5168\u5C40\u89D2\u8272/\u6A21\u578B\u914D\u7F6E\u4E0D\u5B8C\u6574\uFF1A${detail}\u3002\u8BF7\u90E8\u7F72\u5E26 ops/agents \u4E0E ops/model-notes.toml \u7684\u8FD0\u884C\u5305\u3002`
  );
}
function modelConfigDeclarationPath(projectRoot2) {
  return path2.join(path2.resolve(String(projectRoot2)), ...MODEL_CONFIG_DECLARATION_SEGMENTS);
}
function declarationPathValue(declaration, key, declarationPath) {
  const value = declaration[key];
  if (!text(value)) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32\uFF1A${declarationPath}`);
  }
  const raw = value.trim();
  if (path2.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith("\\\\")) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u5FC5\u987B\u662F\u9879\u76EE\u5185\u76F8\u5BF9\u8DEF\u5F84\uFF1A${declarationPath}\uFF1A${raw}`);
  }
  const segments = raw.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u4E0D\u5F97\u8D8A\u51FA\u9879\u76EE\u6839\uFF1A${declarationPath}\uFF1A${raw}`);
  }
  return segments.join("/");
}
function readModelConfigDeclaration(projectRoot2) {
  const declarationPath = modelConfigDeclarationPath(projectRoot2);
  if (!existsSync(declarationPath)) {
    return { path: declarationPath, exists: false, overrides: {}, declared_keys: [] };
  }
  if (!isFile(declarationPath)) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u5FC5\u987B\u662F\u666E\u901A\u6587\u4EF6\uFF1A${declarationPath}`);
  }
  let raw;
  try {
    raw = readFileSync(declarationPath, "utf8");
  } catch (error) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u4E0D\u53EF\u8BFB\uFF1A${declarationPath}\uFF1A${error?.message ?? error}`);
  }
  let declaration;
  try {
    declaration = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u4E0D\u662F\u6709\u6548 JSON\uFF1A${declarationPath}\uFF1A${error?.message ?? error}`);
  }
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u5FC5\u987B\u662F JSON \u5BF9\u8C61\uFF1A${declarationPath}`);
  }
  if (declaration.schema_version !== MODEL_CONFIG_SCHEMA_VERSION) {
    throw new ModelConfigError(
      `\u6A21\u578B\u914D\u7F6E\u58F0\u660E schema_version \u5FC5\u987B\u4E3A ${MODEL_CONFIG_SCHEMA_VERSION}\uFF1A${declarationPath}`
    );
  }
  const unknown = Object.keys(declaration).filter((key) => key !== "schema_version" && !MODEL_CONFIG_ASSETS[key]);
  if (unknown.length > 0) {
    throw new ModelConfigError(
      `\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u542B\u672A\u77E5\u5B57\u6BB5 ${unknown.join(", ")}\uFF1A${declarationPath}\uFF1B\u53EF\u7528\u5B57\u6BB5\uFF1A${MODEL_CONFIG_ASSET_KEYS.join(", ")}`
    );
  }
  const declaredKeys = MODEL_CONFIG_ASSET_KEYS.filter((key) => declaration[key] !== void 0);
  if (declaredKeys.length === 0) {
    throw new ModelConfigError(
      `\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u672A\u9009\u62E9\u4EFB\u4F55\u8D44\u4EA7\uFF1A${declarationPath}\uFF1B\u81F3\u5C11\u58F0\u660E ${MODEL_CONFIG_ASSET_KEYS.join(" / ")} \u4E4B\u4E00`
    );
  }
  const project = path2.resolve(String(projectRoot2));
  const overrides = {};
  for (const key of declaredKeys) {
    const relative = declarationPathValue(declaration, key, declarationPath);
    const resolved = path2.resolve(project, ...relative.split("/"));
    if (!isInsideProject(resolved, project)) {
      throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u8D8A\u51FA\u9879\u76EE\u6839\uFF1A${declarationPath}\uFF1A${relative}`);
    }
    if (!assetExists(resolved, key)) {
      throw new ModelConfigError(
        `\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u6307\u5411\u7684${MODEL_CONFIG_ASSETS[key].kind === "dir" ? "\u76EE\u5F55" : "\u6587\u4EF6"}\u4E0D\u5B58\u5728\uFF1A${declarationPath}\uFF1A${relative}`
      );
    }
    overrides[key] = resolved;
  }
  return { path: declarationPath, exists: true, overrides, declared_keys: declaredKeys };
}
function resolveModelConfigSources({ roots = [], projectRoot: projectRoot2 } = {}) {
  if (!text(projectRoot2)) {
    throw new ModelConfigError("\u89E3\u6790\u6A21\u578B\u914D\u7F6E\u6765\u6E90\u9700\u8981\u9879\u76EE\u6839");
  }
  const global = resolveGlobalModelConfigRoot({ roots });
  const declaration = readModelConfigDeclaration(projectRoot2);
  const assets = {};
  const sources = {};
  for (const key of MODEL_CONFIG_ASSET_KEYS) {
    const declared = declaration.overrides[key];
    assets[key] = declared ?? globalModelConfigAssetPath(global.root, key);
    sources[key] = declared ? "project_declaration" : "global_default";
  }
  return {
    global_root: global.root,
    global_source: global.source,
    declaration_path: declaration.path,
    project_override: Object.keys(declaration.overrides).length > 0,
    declared_keys: declaration.declared_keys,
    agents_dir: assets.agents_dir,
    model_notes: assets.model_notes,
    sources,
    /** 角色 TOML 路径；角色名只做路径拼接，合法性由调用方既有的角色名校验负责。 */
    roleConfigPath(role) {
      const name = `${String(role ?? "").trim()}.toml`;
      const selected = path2.join(assets.agents_dir, name);
      return declaration.overrides.agents_dir && !existsSync(selected) ? path2.join(global.root, "ops", "agents", name) : selected;
    },
    /** 来源诊断：父进程选型与 runner 验收共用同一份字段。 */
    describe() {
      return {
        global_root: global.root,
        global_source: global.source,
        declaration_path: declaration.path,
        project_override: Object.keys(declaration.overrides).length > 0,
        declared_keys: [...declaration.declared_keys],
        agents_dir: assets.agents_dir,
        model_notes: assets.model_notes,
        sources: { ...sources }
      };
    }
  };
}

// src/agent-panel/src/server/config-sync.mjs
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync as readFileSync2, readdirSync, realpathSync, renameSync, rmSync, statSync as statSync2, writeFileSync } from "node:fs";
import os from "node:os";
import path3 from "node:path";
var SYNC_STATUS_REASONS = Object.freeze(["differs", "missing", "unreadable"]);
var MODEL_NOTES_FILE = "ops/model-notes.toml";
var WORKER_RESOURCES_FILE = "ops/templates/worker-resources.json";
var AGENTS_PREFIX = "ops/agents/";
var PI_EXTENSION_SEGMENTS = Object.freeze([".pi", "agent", "extensions", "subagent-control"]);
var SUBAGENT_RELEASE_SEGMENTS = Object.freeze([".subagent-control", "releases", "subagent"]);
var CONSUMER_CURRENT_SEGMENTS = Object.freeze([".subagent-control", "releases", "consumer", "current.json"]);
var READ_FAILURE_CODES = /* @__PURE__ */ new Set(["EACCES", "EPERM", "EISDIR", "ENOTDIR", "EIO", "EBUSY", "EINVAL", "ELOOP"]);
var WRITE_FAILURE_CODES = /* @__PURE__ */ new Set([
  ...READ_FAILURE_CODES,
  "ENOENT",
  "ENOSPC",
  "EEXIST",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "EBADF",
  "ENOTEMPTY"
]);
var ConfigSyncError = class extends PanelError {
  constructor(code, message, options = {}) {
    super(code, message, {
      status: options.status ?? 503,
      scope: "local",
      details: options.details ?? null
    });
    this.name = "ConfigSyncError";
  }
};
function fail(code, message, status, details = null) {
  throw new ConfigSyncError(code, message, { status, details });
}
function samePath2(left, right) {
  const a2 = path3.resolve(String(left));
  const b2 = path3.resolve(String(right));
  return process.platform === "win32" ? a2.toLocaleLowerCase("en-US") === b2.toLocaleLowerCase("en-US") : a2 === b2;
}
function isInside(root, target) {
  const base = path3.resolve(root);
  const abs = path3.resolve(target);
  if (samePath2(base, abs)) return true;
  const prefix = base.endsWith(path3.sep) ? base : base + path3.sep;
  return process.platform === "win32" ? abs.toLocaleLowerCase("en-US").startsWith(prefix.toLocaleLowerCase("en-US")) : abs.startsWith(prefix);
}
function toAbsolute(root, relative) {
  return path3.join(path3.resolve(root), ...relative.split("/"));
}
function inspectPath(target) {
  let stats;
  try {
    stats = statSync2(target, { throwIfNoEntry: false });
  } catch (error) {
    if (READ_FAILURE_CODES.has(error?.code)) return { kind: "unreadable", code: error.code };
    throw error;
  }
  if (!stats) return { kind: "missing" };
  if (stats.isFile()) return { kind: "file" };
  if (stats.isDirectory()) return { kind: "directory" };
  return { kind: "other" };
}
function readBytes(target) {
  const inspected = inspectPath(target);
  if (inspected.kind === "missing") return { state: "missing" };
  if (inspected.kind !== "file") return { state: "unreadable" };
  try {
    return { state: "ok", bytes: readFileSync2(target) };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing" };
    if (READ_FAILURE_CODES.has(error?.code)) return { state: "unreadable" };
    throw error;
  }
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function fileRank(file) {
  if (file === MODEL_NOTES_FILE) return 0;
  if (file === WORKER_RESOURCES_FILE) return 1;
  return 2;
}
function compareFiles(left, right) {
  const rank2 = fileRank(left) - fileRank(right);
  if (rank2 !== 0) return rank2;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
function slotKey(slot) {
  const resolved = path3.resolve(slot);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}
function compareStatus(left, right) {
  const slotOrder = slotKey(left.slot) < slotKey(right.slot) ? -1 : slotKey(left.slot) > slotKey(right.slot) ? 1 : 0;
  if (slotOrder !== 0) return slotOrder;
  return compareFiles(left.file, right.file);
}
function normalizeRelative(input) {
  if (typeof input !== "string" || !input.trim()) {
    fail("SYNC_FILES_INVALID", "\u540C\u6B65\u6587\u4EF6\u8DEF\u5F84\u65E0\u6548", 400);
  }
  const posix = input.replaceAll("\\", "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    fail("SYNC_FILES_INVALID", "\u540C\u6B65\u6587\u4EF6\u5FC5\u987B\u662F\u53D7\u7BA1\u76F8\u5BF9\u8DEF\u5F84", 400, { file: input });
  }
  const parts = posix.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail("SYNC_FILES_INVALID", "\u540C\u6B65\u6587\u4EF6\u8DEF\u5F84\u8D8A\u754C", 400, { file: input });
  }
  return parts.join("/");
}
function identityOf(slotPath) {
  const resolved = path3.resolve(slotPath);
  try {
    return path3.resolve(realpathSync(resolved));
  } catch (error) {
    if (error?.code === "ENOENT") return resolved;
    if (READ_FAILURE_CODES.has(error?.code)) {
      fail("SYNC_SLOTS_UNREADABLE", "\u8FD0\u884C\u69FD\u8DEF\u5F84\u4E0D\u53EF\u8BFB", 503, { path: resolved });
    }
    throw error;
  }
}
function dedupeSlots(slots, controlRoot) {
  const seen = [];
  const unique = [];
  for (const slot of slots) {
    const resolved = path3.resolve(slot);
    if (controlRoot && isInside(controlRoot, resolved)) continue;
    const key = identityOf(resolved);
    const folded = process.platform === "win32" ? key.toLocaleLowerCase("en-US") : key;
    if (seen.includes(folded)) continue;
    seen.push(folded);
    unique.push(resolved);
  }
  return unique;
}
function requireDirectory(target, code, message) {
  const inspected = inspectPath(target);
  if (inspected.kind === "directory") return path3.resolve(target);
  if (inspected.kind === "unreadable") fail(code, message, 503, { path: path3.resolve(target) });
  fail(code, message, 503, { path: path3.resolve(target) });
}
function createConfigSync(options = {}) {
  function inject(event) {
    return options.faultInjector?.(event) ?? null;
  }
  function homeDir() {
    return path3.resolve(options.homeDir ?? os.homedir());
  }
  function readDeployment(file) {
    let text3;
    try {
      text3 = readFileSync2(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") fail("SYNC_DEPLOYMENT_MISSING", "Pi \u6269\u5C55\u69FD\u7F3A\u5C11 deployment.json", 503, { path: file });
      if (READ_FAILURE_CODES.has(error?.code)) {
        fail("SYNC_DEPLOYMENT_UNREADABLE", "Pi \u6269\u5C55\u69FD deployment.json \u4E0D\u53EF\u8BFB", 503, { path: file });
      }
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(text3);
    } catch (error) {
      if (error instanceof SyntaxError) fail("SYNC_DEPLOYMENT_INVALID", "deployment.json \u4E0D\u662F\u5408\u6CD5 JSON", 503, { path: file });
      throw error;
    }
    const sourceRoot = payload?.source?.source_root;
    if (typeof sourceRoot !== "string" || !path3.isAbsolute(sourceRoot)) {
      fail("SYNC_SOURCE_ROOT_INVALID", "deployment.json \u7F3A\u5C11\u7EDD\u5BF9\u8DEF\u5F84 source.source_root", 503, { path: file });
    }
    return requireDirectory(sourceRoot, "SYNC_SOURCE_ROOT_INVALID", "\u771F\u6E90\u76EE\u5F55\u4E0D\u53EF\u7528");
  }
  function resolveSources() {
    if (options.browser === true) {
      if (typeof options.controlRoot !== "string" || !options.controlRoot.trim()) {
        fail("SYNC_LAUNCH_ROOT_INVALID", "\u6D4F\u89C8\u5668\u6A21\u5F0F\u7F3A\u5C11\u542F\u52A8\u63A7\u5236\u4ED3", 503);
      }
      const controlRoot = requireDirectory(options.controlRoot, "SYNC_LAUNCH_ROOT_INVALID", "\u542F\u52A8\u63A7\u5236\u4ED3\u4E0D\u53EF\u7528");
      return sourcePaths(controlRoot);
    }
    const deployment = path3.join(homeDir(), ...PI_EXTENSION_SEGMENTS, "deployment.json");
    return sourcePaths(readDeployment(deployment));
  }
  function sourcePaths(controlRoot) {
    return { control_root: controlRoot };
  }
  function pushBuildSlots(slots) {
    const releases = path3.join(homeDir(), ...SUBAGENT_RELEASE_SEGMENTS);
    let entries;
    try {
      entries = readdirSync(releases, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (READ_FAILURE_CODES.has(error?.code)) fail("SYNC_SLOTS_UNREADABLE", "\u8FD0\u884C\u69FD\u76EE\u5F55\u4E0D\u53EF\u8BFB", 503, { path: releases });
      throw error;
    }
    const names = entries.map((entry) => entry.name).filter((name) => !name.startsWith(".")).sort();
    for (const name of names) {
      const full = path3.join(releases, name);
      const inspected = inspectPath(full);
      if (inspected.kind === "missing") continue;
      if (inspected.kind === "unreadable") fail("SYNC_SLOTS_UNREADABLE", "\u8FD0\u884C\u69FD\u76EE\u5F55\u4E0D\u53EF\u8BFB", 503, { path: full });
      if (inspected.kind !== "directory") continue;
      const marker = inspectPath(toAbsolute(full, MODEL_NOTES_FILE));
      if (marker.kind === "unreadable") fail("SYNC_SLOTS_UNREADABLE", "\u8FD0\u884C\u69FD\u6807\u8BB0\u6587\u4EF6\u4E0D\u53EF\u8BFB", 503, { path: full });
      if (marker.kind === "file") slots.push(full);
    }
  }
  function consumerSlot() {
    const pointer = path3.join(homeDir(), ...CONSUMER_CURRENT_SEGMENTS);
    let text3;
    try {
      text3 = readFileSync2(pointer, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (READ_FAILURE_CODES.has(error?.code)) fail("SYNC_POINTER_UNREADABLE", "consumer/current.json \u4E0D\u53EF\u8BFB", 503, { path: pointer });
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(text3);
    } catch (error) {
      if (error instanceof SyntaxError) fail("SYNC_POINTER_INVALID", "consumer/current.json \u4E0D\u662F\u5408\u6CD5 JSON", 503, { path: pointer });
      throw error;
    }
    const runtimeRoot2 = payload?.runtime_root;
    if (typeof runtimeRoot2 !== "string" || !path3.isAbsolute(runtimeRoot2)) {
      fail("SYNC_POINTER_INVALID", "consumer/current.json \u7F3A\u5C11\u7EDD\u5BF9\u8DEF\u5F84 runtime_root", 503, { path: pointer });
    }
    return path3.resolve(runtimeRoot2);
  }
  function enumerateSlots(controlRoot) {
    if (options.listSlots) return dedupeSlots(options.listSlots(), controlRoot);
    const slots = [];
    pushBuildSlots(slots);
    const extension = path3.join(homeDir(), ...PI_EXTENSION_SEGMENTS);
    const extensionState = inspectPath(extension);
    if (extensionState.kind === "unreadable") fail("SYNC_SLOTS_UNREADABLE", "Pi \u6269\u5C55\u69FD\u4E0D\u53EF\u8BFB", 503, { path: extension });
    if (extensionState.kind === "directory") slots.push(extension);
    const consumer = consumerSlot();
    if (consumer) slots.push(consumer);
    return dedupeSlots(slots, controlRoot);
  }
  function listManaged(controlRoot) {
    const files = [];
    for (const relative of [MODEL_NOTES_FILE, WORKER_RESOURCES_FILE]) {
      const inspected = inspectPath(toAbsolute(controlRoot, relative));
      if (inspected.kind === "missing") continue;
      if (inspected.kind !== "file") {
        fail("SYNC_SOURCE_UNREADABLE", "\u771F\u6E90\u53D7\u7BA1\u6587\u4EF6\u4E0D\u53EF\u8BFB", 503, { file: relative });
      }
      files.push(relative);
    }
    const agentsDir = path3.join(controlRoot, "ops", "agents");
    const agentsState = inspectPath(agentsDir);
    if (agentsState.kind === "unreadable" || agentsState.kind === "file" || agentsState.kind === "other") {
      fail("SYNC_SOURCE_UNREADABLE", "\u771F\u6E90\u89D2\u8272\u76EE\u5F55\u4E0D\u53EF\u8BFB", 503, { path: agentsDir });
    }
    if (agentsState.kind === "directory") {
      let names;
      try {
        names = readdirSync(agentsDir);
      } catch (error) {
        if (READ_FAILURE_CODES.has(error?.code)) fail("SYNC_SOURCE_UNREADABLE", "\u771F\u6E90\u89D2\u8272\u76EE\u5F55\u4E0D\u53EF\u8BFB", 503, { path: agentsDir });
        throw error;
      }
      for (const name of names.filter((item) => item.endsWith(".toml") && !item.startsWith(".")).sort()) {
        const relative = `${AGENTS_PREFIX}${name}`;
        const inspected = inspectPath(toAbsolute(controlRoot, relative));
        if (inspected.kind === "missing") continue;
        if (inspected.kind === "unreadable") fail("SYNC_SOURCE_UNREADABLE", "\u771F\u6E90\u89D2\u8272\u5361\u4E0D\u53EF\u8BFB", 503, { file: relative });
        if (inspected.kind === "file") files.push(relative);
      }
    }
    return files;
  }
  function readSource(controlRoot, file) {
    const sourcePath = toAbsolute(controlRoot, file);
    const injected = inject({ op: "read-source", slot: null, file, sourcePath, destPath: null });
    if (injected?.fail === "missing") return { state: "missing" };
    if (injected?.fail === "unreadable") fail("SYNC_SOURCE_UNREADABLE", "\u771F\u6E90\u6587\u4EF6\u4E0D\u53EF\u8BFB", 503, { file });
    const read = readBytes(sourcePath);
    if (read.state === "unreadable") fail("SYNC_SOURCE_UNREADABLE", "\u771F\u6E90\u6587\u4EF6\u4E0D\u53EF\u8BFB", 503, { file });
    return read;
  }
  function currentBytes(controlRoot, files) {
    const bytes = /* @__PURE__ */ new Map();
    for (const file of files) {
      const read = readSource(controlRoot, file);
      if (read.state === "missing") continue;
      bytes.set(file, read.bytes);
    }
    return bytes;
  }
  function readSlot(slot, file) {
    const destPath = toAbsolute(slot, file);
    const injected = inject({
      op: "read-slot",
      slot,
      file,
      sourcePath: null,
      destPath
    });
    if (injected?.fail === "missing") return { state: "missing" };
    if (injected?.fail === "unreadable") return { state: "unreadable" };
    return readBytes(destPath);
  }
  function measure(controlRoot, files, slots) {
    const bytes = currentBytes(controlRoot, files);
    const items = [];
    for (const slot of slots) {
      for (const file of bytes.keys()) {
        const read = readSlot(slot, file);
        if (read.state === "missing" || read.state === "unreadable") {
          items.push({ slot, file, reason: read.state });
          continue;
        }
        if (sha256(bytes.get(file)) !== sha256(read.bytes)) items.push({ slot, file, reason: "differs" });
      }
    }
    return items.sort(compareStatus);
  }
  function status() {
    const sources = resolveSources();
    return measure(sources.control_root, listManaged(sources.control_root), enumerateSlots(sources.control_root));
  }
  function cleanupTemp(tempPath) {
    try {
      rmSync(tempPath, { force: true });
    } catch (error) {
      if (error?.code === "ENOENT" || WRITE_FAILURE_CODES.has(error?.code)) return;
      throw error;
    }
  }
  function copyIntoSlot(controlRoot, slot, file, bytes) {
    const sourcePath = toAbsolute(controlRoot, file);
    const destPath = toAbsolute(slot, file);
    if (!isInside(slot, destPath) || isInside(controlRoot, destPath)) {
      fail("SYNC_PATH_ESCAPE", "\u540C\u6B65\u76EE\u6807\u8D8A\u51FA\u8FD0\u884C\u69FD", 500, { slot, file });
    }
    const injected = inject({ op: "write-slot", slot, file, sourcePath, destPath });
    if (injected?.fail === "write") return { slot, file, ok: false, reason: "write_failed" };
    if (inspectPath(slot).kind !== "directory") return { slot, file, ok: false, reason: "write_failed" };
    const destDir = path3.dirname(destPath);
    try {
      mkdirSync(destDir, { recursive: true });
    } catch (error) {
      if (WRITE_FAILURE_CODES.has(error?.code)) return { slot, file, ok: false, reason: "write_failed" };
      throw error;
    }
    const tempPath = path3.join(destDir, `.panel-sync-${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeFileSync(tempPath, bytes);
      renameSync(tempPath, destPath);
      return { slot, file, ok: true, reason: null };
    } catch (error) {
      cleanupTemp(tempPath);
      if (WRITE_FAILURE_CODES.has(error?.code)) return { slot, file, ok: false, reason: "write_failed" };
      throw error;
    }
  }
  function syncFiles(files) {
    const sources = resolveSources();
    const managed = new Set(listManaged(sources.control_root));
    const ordered = [];
    for (const file of files) {
      if (!managed.has(file)) fail("SYNC_FILES_INVALID", "\u540C\u6B65\u6587\u4EF6\u4E0D\u5728\u771F\u6E90\u53D7\u7BA1\u96C6\u5408\u5185", 400, { file });
      if (!ordered.includes(file)) ordered.push(file);
    }
    ordered.sort(compareFiles);
    const bytes = currentBytes(sources.control_root, ordered);
    for (const file of ordered) {
      if (!bytes.has(file)) fail("SYNC_SOURCE_UNREADABLE", "\u771F\u6E90\u6587\u4EF6\u5728\u590D\u5236\u524D\u6D88\u5931", 503, { file });
    }
    const slots = enumerateSlots(sources.control_root);
    const syncResults = [];
    for (const slot of slots) {
      for (const file of ordered) {
        syncResults.push(copyIntoSlot(sources.control_root, slot, file, bytes.get(file)));
      }
    }
    return {
      sync_results: syncResults,
      sync_status: measure(sources.control_root, listManaged(sources.control_root), enumerateSlots(sources.control_root))
    };
  }
  function syncWritten(relativeFiles) {
    if (!Array.isArray(relativeFiles)) fail("SYNC_FILES_INVALID", "\u540C\u6B65\u6587\u4EF6\u5217\u8868\u5FC5\u987B\u662F\u6570\u7EC4", 400);
    return syncFiles(relativeFiles.map((file) => normalizeRelative(file)));
  }
  function reconcile() {
    const sources = resolveSources();
    const pending = measure(sources.control_root, listManaged(sources.control_root), enumerateSlots(sources.control_root));
    const files = [...new Set(pending.map((item) => item.file))].sort(compareFiles);
    const bytes = currentBytes(sources.control_root, files);
    for (const file of files) {
      if (!bytes.has(file)) fail("SYNC_SOURCE_UNREADABLE", "\u771F\u6E90\u6587\u4EF6\u5728\u6536\u655B\u524D\u6D88\u5931", 503, { file });
    }
    const slots = [];
    for (const item of pending) {
      if (!slots.includes(item.slot)) slots.push(item.slot);
    }
    const syncResults = [];
    for (const slot of slots) {
      for (const file of files) {
        if (!pending.some((item) => item.slot === slot && item.file === file)) continue;
        syncResults.push(copyIntoSlot(sources.control_root, slot, file, bytes.get(file)));
      }
    }
    return {
      sync_results: syncResults,
      sync_status: measure(sources.control_root, listManaged(sources.control_root), enumerateSlots(sources.control_root))
    };
  }
  return { resolveSources, status, syncWritten, reconcile };
}

// src/agent-panel/node_modules/@decimalturn/toml-patch/dist/toml-patch.js
function e(e4) {
  return e4.type === `Document`;
}
function t(e4) {
  return e4.type === `Table`;
}
function n(e4) {
  return e4.type === `TableKey`;
}
function r(e4) {
  return e4.type === `TableArray`;
}
function i(e4) {
  return e4.type === `TableArrayKey`;
}
function a(e4) {
  return e4.type === `KeyValue`;
}
function o(e4) {
  return e4.type === `String`;
}
function s(e4) {
  return e4.type === `Integer`;
}
function c(e4) {
  return e4.type === `Float`;
}
function l(e4) {
  return e4.type === `DateTime`;
}
function u(e4) {
  return e4.type === `InlineArray`;
}
function d(e4) {
  return e4.type === `InlineItem`;
}
function f(e4) {
  return e4.type === `InlineTable`;
}
function p(e4) {
  return e4.type === `Comment`;
}
function m(n2) {
  return e(n2) || t(n2) || r(n2) || f(n2) || u(n2);
}
function h(e4) {
  return n(e4) || i(e4) || d(e4);
}
function g(e4) {
  return a(e4) || t(e4) || r(e4) || p(e4);
}
var _;
var v;
function y(e4) {
  if (_ === e4 && v !== void 0) return v;
  let t2 = w(e4);
  return _ = e4, v = t2, t2;
}
function b() {
  _ = void 0, v = void 0;
}
function x(e4) {
  return { lines: e4.end.line - e4.start.line + 1, columns: e4.end.column - e4.start.column };
}
function S(e4, t2) {
  let n2 = Array.isArray(e4) ? e4 : w(e4);
  if (n2.length === 0) return { line: 1, column: t2 };
  let r2 = 0, i2 = n2.length - 1;
  for (; r2 < i2; ) {
    let e5 = r2 + i2 >>> 1;
    n2[e5] < t2 ? r2 = e5 + 1 : i2 = e5;
  }
  n2[r2] < t2 && r2++;
  let a2 = r2 + 1;
  return { line: a2, column: t2 - (n2[a2 - 2] + 1 || 0) };
}
function C(e4, t2) {
  let n2 = y(e4), r2 = n2[t2.line - 2] === void 0 ? 0 : n2[t2.line - 2] + 1, i2 = n2[t2.line - 1] || e4.length;
  return e4.substring(r2, i2);
}
function w(e4) {
  let t2 = [];
  for (let n2 = 0; n2 < e4.length; n2++) {
    let r2 = e4.charCodeAt(n2);
    r2 === 10 ? t2.push(n2) : r2 === 13 && (e4.charCodeAt(n2 + 1) === 10 ? (t2.push(n2 + 1), n2++) : t2.push(n2));
  }
  return t2.push(e4.length), t2;
}
function T(e4) {
  return { line: e4.line, column: e4.column };
}
function E(e4) {
  return { start: T(e4.start), end: T(e4.end) };
}
function D() {
  return { line: 1, column: 0 };
}
var O = class extends Error {
  line;
  column;
  constructor(e4, t2, n2) {
    let r2 = `Error parsing TOML (${t2.line}, ${t2.column + 1}):
`;
    if (e4) {
      let n3 = C(e4, t2), i2 = `${k(t2.column)}^`;
      n3 && (r2 += `${n3}
${i2}
`);
    }
    r2 += n2, super(r2), this.line = t2.line, this.column = t2.column;
  }
};
function k(e4, t2 = ` `) {
  return t2.repeat(e4);
}
var A = /^[\w-]+$/;
var j = /[\w,\d,",',+,\-,_]/;
function ee() {
  return { reference: null, mixed: false };
}
function* te(e4, t2) {
  let n2 = e4.length, r2 = 0, i2 = t2 ?? ee(), a2 = [], o2 = (e5, t3) => ({ start: S(a2, e5), end: S(a2, t3) });
  for (; r2 < n2; ) {
    let t3 = e4.charCodeAt(r2);
    if ((t3 <= 31 || t3 === 127) && t3 !== 9 && t3 !== 13 && t3 !== 10) throw new O(e4, S(a2, r2), `Control char 0x${t3.toString(16).toUpperCase().padStart(2, `0`)} not allowed`);
    if (t3 === 13 && (r2 + 1 >= n2 || e4.charCodeAt(r2 + 1) !== 10)) throw new O(e4, S(a2, r2), `Standalone CR; must be CRLF or LF`);
    if (t3 !== 32 && t3 !== 9 && t3 !== 13) {
      if (t3 === 10) s2(r2);
      else if (t3 === 91 || t3 === 93) yield { type: `Bracket`, raw: e4[r2], loc: o2(r2, r2 + 1) };
      else if (t3 === 123 || t3 === 125) yield { type: `Curly`, raw: e4[r2], loc: o2(r2, r2 + 1) };
      else if (t3 === 61) yield { type: `Equal`, raw: `=`, loc: o2(r2, r2 + 1) };
      else if (t3 === 44) yield { type: `Comma`, raw: `,`, loc: o2(r2, r2 + 1) };
      else if (t3 === 46) yield { type: `Dot`, raw: `.`, loc: o2(r2, r2 + 1) };
      else if (t3 === 35) yield c2();
      else {
        let t4 = ne(e4, r2, `'`) || ne(e4, r2, `"`);
        t4 ? yield l2(t4) : yield u2();
      }
    }
    r2++;
  }
  function s2(t3) {
    a2.push(t3);
    let n3 = t3 > 0 && e4.charCodeAt(t3 - 1) === 13 ? `\r
` : `
`;
    i2.reference === null ? i2.reference = n3 : i2.reference !== n3 && (i2.mixed = true);
  }
  function c2() {
    let t3 = r2;
    for (; r2 + 1 < n2; ) {
      let t4 = e4.charCodeAt(r2 + 1);
      if (t4 === 10 || t4 === 13) break;
      r2++;
      let n3 = e4.charCodeAt(r2);
      if ((n3 <= 31 || n3 === 127) && n3 !== 9) throw new O(e4, S(a2, r2), `Control char 0x${n3.toString(16).toUpperCase().padStart(2, `0`)} not allowed`);
    }
    return { type: `Comment`, raw: e4.slice(t3, r2 + 1), loc: o2(t3, r2 + 1) };
  }
  function l2(t3) {
    let i3 = r2, c3 = t3 + t3 + t3;
    for (r2 += 3; r2 < n2; ) {
      if (ne(e4, r2, t3)) {
        let n3 = 3;
        for (; e4[r2 + n3] === t3; ) n3++;
        if (n3 >= 6) throw new O(e4, S(a2, r2), `Invalid multiline string: ${n3} consecutive ${t3} characters`);
        if (n3 === 3) {
          r2 += 2;
          break;
        }
        r2 += n3 - 3, r2 += 2;
        break;
      }
      let i4 = e4.charCodeAt(r2);
      if (i4 === 13 && (r2 + 1 >= n2 || e4.charCodeAt(r2 + 1) !== 10)) throw new O(e4, S(a2, r2), `Standalone CR in multiline string; must be CRLF or LF`);
      if ((i4 <= 31 || i4 === 127) && i4 !== 9 && i4 !== 10 && i4 !== 13) {
        let n3 = t3 === `"` ? `multiline basic strings` : `multiline literal strings`, o3 = `0x${i4.toString(16).toUpperCase().padStart(2, `0`)}`, s3 = ``;
        i4 === 0 ? s3 = `Null` : i4 === 127 && (s3 = `DEL`);
        let c4 = s3 ? `${s3} (${o3}) not allowed in ${n3}` : `Control char ${o3} not allowed in ${n3}`;
        throw new O(e4, S(a2, r2), c4);
      }
      i4 === 10 && s2(r2), r2++;
    }
    if (r2 >= n2) {
      if (t3 === `"`) {
        let t4 = 0, i4 = n2 - 1;
        for (; i4 >= 0 && e4[i4] === `\\`; ) t4++, i4--;
        if (t4 > 0 && t4 % 2 != 0) throw new O(e4, S(a2, r2), `Unterminated multiline ${c3} (possible escape issue)`);
      }
      throw new O(e4, S(a2, r2), `Unterminated multiline ${c3}`);
    }
    return { type: `Literal`, raw: e4.slice(i3, r2 + 1), loc: o2(i3, r2 + 1) };
  }
  function u2() {
    let t3 = e4[r2];
    if (!j.test(t3)) throw new O(e4, S(a2, r2), `Unexpected char "${t3}"`);
    let i3 = r2, s3 = t3 === `"`, c3 = t3 === `'`;
    for (; r2 < n2 && !(r2 + 1 >= n2); ) {
      let t4 = e4.charCodeAt(r2 + 1);
      if (!(s3 || c3) && (t4 === 32 || t4 === 9 || t4 === 10 || t4 === 13 || t4 === 44 || t4 === 46 || t4 === 93 || t4 === 125 || t4 === 61 || t4 === 35)) break;
      if (r2++, !(s3 || c3)) {
        let t5 = e4.charCodeAt(r2);
        if (t5 <= 31 || t5 === 127) throw new O(e4, S(a2, r2), `Control char 0x${t5.toString(16).toUpperCase().padStart(2, `0`)} not allowed in unquoted value`);
      }
      if (s3 || c3) {
        let t5 = e4.charCodeAt(r2);
        if ((t5 <= 31 || t5 === 127) && t5 !== 9) {
          let n3 = s3 ? `basic strings` : `literal strings`, i5 = `0x${t5.toString(16).toUpperCase().padStart(2, `0`)}`, o3 = ``;
          t5 === 10 ? o3 = `Newline` : t5 === 13 ? o3 = `Carriage return` : t5 === 0 ? o3 = `Null` : t5 === 127 && (o3 = `DEL`);
          let c4 = o3 ? `${o3} (${i5}) not allowed in ${n3}` : `Control char ${i5} not allowed in ${n3}`;
          throw new O(e4, S(a2, r2), c4);
        }
      }
      let i4 = e4[r2];
      if (i4 === `"` && !c3 && (s3 = !s3), i4 === `'` && !s3 && (c3 = !c3), r2 + 1 >= n2) break;
      if (s3 && i4 === `\\`) {
        let t5 = e4[r2 + 1];
        (t5 === `"` || t5 === `\\`) && r2++;
      }
    }
    if (s3 || c3) throw new O(e4, S(a2, i3), `Expected close of string with ${s3 ? `"` : `'`}`);
    return { type: `Literal`, raw: e4.slice(i3, r2 + 1), loc: o2(i3, r2 + 1) };
  }
}
function ne(e4, t2, n2) {
  if (!n2 || e4[t2] !== n2 || e4[t2 + 1] !== n2 || e4[t2 + 2] !== n2) return false;
  if (n2 === `'`) return n2;
  let r2 = 0, i2 = t2 - 1;
  for (; i2 >= 0 && e4[i2] === `\\`; ) r2++, i2--;
  return (r2 === 0 || r2 % 2 == 0) && n2;
}
var M = new Int8Array(128);
M.fill(-1);
for (let e4 = 0; e4 < 10; e4++) M[48 + e4] = e4;
for (let e4 = 0; e4 < 6; e4++) M[65 + e4] = 10 + e4, M[97 + e4] = 10 + e4;
function re(e4) {
  let t2 = e4.charCodeAt(0);
  return t2 < 128 && M[t2] !== -1;
}
function ie(e4, t2) {
  return M[e4.charCodeAt(t2)] << 12 | M[e4.charCodeAt(t2 + 1)] << 8 | M[e4.charCodeAt(t2 + 2)] << 4 | M[e4.charCodeAt(t2 + 3)];
}
function ae(e4) {
  return e4.startsWith(`'''`) ? se(e4.slice(3, e4.length - 3)) : e4.startsWith(`'`) ? e4.slice(1, e4.length - 1) : e4.startsWith(`"""`) ? oe(se(e4.slice(3, e4.length - 3)), true) : e4.startsWith(`"`) ? oe(e4.slice(1, e4.length - 1), false) : e4;
}
function oe(e4, t2) {
  let n2 = e4.length;
  if (!t2 && e4.indexOf(`\\`) === -1) return e4;
  let r2 = [], i2 = 0;
  for (let a2 = 0; a2 < n2; a2++) {
    if (e4[a2] !== `\\`) continue;
    if (a2 > i2 && r2.push(e4.slice(i2, a2)), a2++, a2 >= n2) throw Error(`Trailing backslash`);
    let o2 = e4[a2];
    switch (o2) {
      case `b`:
        r2.push(`\b`);
        break;
      case `t`:
        r2.push(`	`);
        break;
      case `n`:
        r2.push(`
`);
        break;
      case `f`:
        r2.push(`\f`);
        break;
      case `r`:
        r2.push(`\r`);
        break;
      case `"`:
        r2.push(`"`);
        break;
      case `\\`:
        r2.push(`\\`);
        break;
      case `e`:
        r2.push(`\x1B`);
        break;
      case `u`: {
        if (a2 + 4 > n2 || !re(e4[a2 + 1]) || !re(e4[a2 + 2]) || !re(e4[a2 + 3]) || !re(e4[a2 + 4])) throw Error(`Invalid Unicode escape: \\u${e4.slice(a2 + 1, a2 + 5)}`);
        let t3 = ie(e4, a2 + 1);
        if (t3 >= 55296 && t3 <= 57343) throw Error(`Invalid \\u${e4.slice(a2 + 1, a2 + 5)}: surrogates not allowed`);
        r2.push(String.fromCharCode(t3)), a2 += 4;
        break;
      }
      case `U`: {
        if (a2 + 8 > n2) throw Error(`Invalid Unicode escape: \\U${e4.slice(a2 + 1, a2 + 9)}`);
        for (let t4 = 1; t4 <= 8; t4++) if (!re(e4[a2 + t4])) throw Error(`Invalid Unicode escape: \\U${e4.slice(a2 + 1, a2 + 9)}`);
        let t3 = parseInt(e4.slice(a2 + 1, a2 + 9), 16);
        if (t3 >= 55296 && t3 <= 57343) throw Error(`Invalid \\U${e4.slice(a2 + 1, a2 + 9)}: surrogates not allowed`);
        r2.push(String.fromCodePoint(t3)), a2 += 8;
        break;
      }
      case `x`: {
        if (a2 + 2 > n2 || !re(e4[a2 + 1]) || !re(e4[a2 + 2])) throw Error(`Invalid hex escape: \\x${e4.slice(a2 + 1, a2 + 3)}`);
        let t3 = M[e4.charCodeAt(a2 + 1)] << 4 | M[e4.charCodeAt(a2 + 2)];
        r2.push(String.fromCharCode(t3)), a2 += 2;
        break;
      }
      default:
        if (t2 && (o2 === `
` || o2 === `\r` || o2 === ` ` || o2 === `	`)) {
          let t3 = o2 === `
` || o2 === `\r`, r3 = a2;
          for (; r3 < n2 && (e4[r3] === ` ` || e4[r3] === `	` || e4[r3] === `
` || e4[r3] === `\r`); ) (e4[r3] === `
` || e4[r3] === `\r`) && (t3 = true), r3++;
          if (!t3) throw Error(`Invalid escape sequence: \\${o2}`);
          a2 = r3 - 1;
          break;
        }
        throw Error(`Invalid escape sequence: \\${o2}`);
    }
    i2 = a2 + 1;
  }
  return i2 === 0 ? e4 : (i2 < n2 && r2.push(e4.slice(i2)), r2.join(``));
}
function se(e4) {
  return e4.charCodeAt(0) === 10 ? e4.slice(1) : e4.charCodeAt(0) === 13 && e4.charCodeAt(1) === 10 ? e4.slice(2) : e4;
}
var ce = class {
  iterator;
  index;
  value;
  done;
  peeked;
  constructor(e4) {
    this.iterator = e4, this.index = -1, this.value = void 0, this.done = false, this.peeked = null;
  }
  next() {
    if (this.done) return ue();
    let e4 = this.peeked || this.iterator.next();
    return this.index += 1, this.value = e4.value, this.done = e4.done ?? false, this.peeked = null, e4;
  }
  peek() {
    return this.done ? ue() : (this.peeked ||= this.iterator.next(), this.peeked);
  }
  [Symbol.iterator]() {
    return this;
  }
};
var le = Object.freeze({ value: void 0, done: true });
function ue() {
  return le;
}
var de = /* @__PURE__ */ new WeakMap();
function fe(e4, t2) {
  de.set(e4, t2);
}
function pe(e4) {
  return de.get(e4);
}
function me(e4) {
  return { year: String(e4.getUTCFullYear()).padStart(4, `0`), month: String(e4.getUTCMonth() + 1).padStart(2, `0`), day: String(e4.getUTCDate()).padStart(2, `0`), hours: String(e4.getUTCHours()).padStart(2, `0`), minutes: String(e4.getUTCMinutes()).padStart(2, `0`), seconds: String(e4.getUTCSeconds()).padStart(2, `0`), ms: e4.getUTCMilliseconds() };
}
function he(e4) {
  return e4 === 0 ? `` : String(e4).padStart(3, `0`).replace(/0+$/, ``);
}
var ge = /\.(\d+)\s*$/;
var _e = /\.(\d+)(?:[Zz]|[+-]\d{2}:\d{2})\s*$/;
function ve(e4, t2) {
  var n2;
  return ((n2 = e4.match(t2)) == null ? void 0 : n2[1]) ?? ``;
}
function ye(e4, t2, n2) {
  let r2 = ve(t2, n2), i2 = r2.length > r2.replace(/0+$/, ``).length ? Math.max(r2.length, e4.length) : e4.length;
  return i2 === 0 ? `` : `.` + e4.padEnd(i2, `0`);
}
function be(e4) {
  let t2 = e4.toISOString().match(/\.(\d+)/);
  return t2 ? t2[1] : ``;
}
function xe(e4, t2, n2, r2 = ge) {
  let i2 = be(e4).replace(/0+$/, ``);
  return i2.length > he(t2).length ? ye(i2, n2, r2) : Se(t2, n2, r2);
}
function Se(e4, t2, n2 = ge) {
  let r2 = he(e4);
  if (t2 && t2.includes(`.`)) {
    let i2 = t2.match(n2);
    return i2 && i2[1].startsWith(String(e4).padStart(3, `0`)) ? `.` + i2[1] : ye(r2, t2, n2);
  }
  return r2 ? `.` + r2 : ``;
}
function Ce(e4) {
  if (e4 === `Z`) return 0;
  let t2 = e4[0] === `+` ? 1 : -1, [n2, r2] = e4.slice(1).split(`:`);
  return t2 * (parseInt(n2) * 60 + parseInt(r2));
}
function we(e4, t2) {
  return t2 <= 0 ? e4 : e4.replace(/(\d{2}:\d{2})(?::(\d{2}))?(?:\.(\d+))?/, (e5, n2, r2, i2) => {
    let a2 = i2 ?? ``;
    return a2.length >= t2 ? e5 : `${n2}:${r2 ?? `00`}.${a2.padEnd(t2, `0`)}`;
  });
}
var Te = class e2 {
  static IS_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  static IS_TIME_ONLY = /^\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/;
  static IS_LOCAL_DATETIME_T = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/;
  static IS_LOCAL_DATETIME_SPACE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/;
  static IS_OFFSET_DATETIME_T = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
  static IS_OFFSET_DATETIME_SPACE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
  static IS_FULL_DATE = /(\d{4})-(\d+)-(\d+)/;
  static IS_FULL_TIME = /(\d+):(\d+)(?::(\d+))?/;
  static createDateWithOriginalFormat(t2, n2) {
    if (e2.IS_DATE_ONLY.test(n2)) {
      if (t2.getUTCHours() !== 0 || t2.getUTCMinutes() !== 0 || t2.getUTCSeconds() !== 0 || t2.getUTCMilliseconds() !== 0) {
        if (t2 instanceof ke) return t2;
        let e5 = t2.toISOString().replace(`Z`, ``);
        return e5 = e5.replace(/\.000$/, ``), new Oe(e5, false);
      }
      let e4 = t2.toISOString().split(`T`)[0];
      return new Ee(e4);
    }
    if (e2.IS_TIME_ONLY.test(n2)) {
      let e4 = me(t2), r2 = xe(t2, e4.ms, n2);
      return new De(`${e4.hours}:${e4.minutes}:${e4.seconds}${r2}`);
    }
    if (e2.IS_LOCAL_DATETIME_T.test(n2)) {
      let e4 = me(t2), r2 = xe(t2, e4.ms, n2), i2 = `${e4.year}-${e4.month}-${e4.day}T${e4.hours}:${e4.minutes}:${e4.seconds}${r2}`;
      return new Oe(i2, false, i2);
    }
    if (e2.IS_LOCAL_DATETIME_SPACE.test(n2)) {
      let e4 = me(t2), r2 = xe(t2, e4.ms, n2), i2 = `${e4.year}-${e4.month}-${e4.day} ${e4.hours}:${e4.minutes}:${e4.seconds}${r2}`;
      return new Oe(i2, true, i2);
    }
    if (e2.IS_OFFSET_DATETIME_T.test(n2) || e2.IS_OFFSET_DATETIME_SPACE.test(n2)) {
      let r2 = n2.match(/([+-]\d{2}:\d{2}|[Zz])$/), i2 = r2 ? r2[1] === `z` ? `Z` : r2[1] : `Z`, a2 = e2.IS_OFFSET_DATETIME_SPACE.test(n2), o2 = me(new Date(t2.getTime() + Ce(i2) * 6e4)), s2 = a2 ? ` ` : `T`, c2 = xe(t2, o2.ms, n2, _e);
      return new ke(`${o2.year}-${o2.month}-${o2.day}${s2}${o2.hours}:${o2.minutes}:${o2.seconds}${c2}${i2}`, a2);
    }
    return t2;
  }
};
var Ee = class extends Date {
  constructor(e4) {
    super(e4);
  }
  toISOString() {
    let e4 = me(this);
    return `${e4.year}-${e4.month}-${e4.day}`;
  }
};
var De = class extends Date {
  originalFormat;
  constructor(e4, t2 = e4) {
    let n2 = e4;
    /:\d{2}:\d{2}/.test(e4) || (n2 = e4 + `:00`), super(`0000-01-01T${n2}Z`), this.originalFormat = t2;
  }
  toISOString() {
    let e4 = me(this);
    return `${e4.hours}:${e4.minutes}:${e4.seconds}${Se(e4.ms, this.originalFormat)}`;
  }
};
var Oe = class extends Date {
  useSpaceSeparator = false;
  originalFormat;
  constructor(e4, t2 = false, n2) {
    let r2 = e4;
    /\d{2}:\d{2}:\d{2}/.test(e4) || (r2 = e4.replace(/(\d{2}:\d{2})([\s\-+TZ]|$)/, `$1:00$2`)), super(r2.replace(` `, `T`) + `Z`), this.useSpaceSeparator = t2, this.originalFormat = n2 || e4;
  }
  toISOString() {
    let e4 = me(this), t2 = this.useSpaceSeparator ? ` ` : `T`;
    return `${e4.year}-${e4.month}-${e4.day}${t2}${e4.hours}:${e4.minutes}:${e4.seconds}${Se(e4.ms, this.originalFormat)}`;
  }
};
var ke = class extends Date {
  useSpaceSeparator = false;
  originalOffset;
  originalFormat;
  constructor(e4, t2 = false) {
    let n2 = e4;
    /\d{2}:\d{2}:\d{2}/.test(e4) || (n2 = e4.replace(/(\d{2}:\d{2})([\s\-+TZ]|$)/, `$1:00$2`)), super(n2.replace(` `, `T`)), this.useSpaceSeparator = t2, this.originalFormat = e4;
    let r2 = e4.match(/([+-]\d{2}:\d{2}|[Zz])$/);
    r2 && (this.originalOffset = r2[1] === `z` ? `Z` : r2[1]);
  }
  toISOString() {
    if (this.originalOffset) {
      let e5 = me(new Date(this.getTime() + Ce(this.originalOffset) * 6e4)), t2 = this.useSpaceSeparator ? ` ` : `T`, n2 = Se(e5.ms, this.originalFormat, _e);
      return `${e5.year}-${e5.month}-${e5.day}${t2}${e5.hours}:${e5.minutes}:${e5.seconds}${n2}${this.originalOffset}`;
    }
    let e4 = super.toISOString();
    return this.useSpaceSeparator ? e4.replace(`T`, ` `) : e4;
  }
};
var Ae = Te;
var je = `true`;
var Me = /e/i;
var Ne = /_/g;
var Pe = /^[+-]?inf$/;
var Fe = /^[+-]?nan$/;
var Ie = /^[+-]?0x/i;
function Le(e4) {
  return e4 >= 65 && e4 <= 90 || e4 >= 97 && e4 <= 122 || e4 >= 48 && e4 <= 57 || e4 === 95 || e4 === 45;
}
var Re = /^[+-]?0o/i;
var ze = /^[+-]?0b/i;
function Be(e4, t2, n2) {
  for (let r2 = 0; r2 < e4.length; r2++) if (!Le(e4.charCodeAt(r2))) throw new O(t2, { line: n2.line, column: n2.column + r2 }, `Invalid bare key char '${e4[r2]}'`);
}
function Ve(e4, t2, n2) {
  if (e4.startsWith(`"""`) || e4.startsWith(`'''`)) throw new O(t2, n2, `Multiline strings cannot be keys`);
}
function He(e4, t2, n2) {
  try {
    return ae(e4);
  } catch (e5) {
    throw new O(t2, n2, e5.message);
  }
}
function Ue(e4, t2, n2, r2 = true) {
  if (e4.endsWith(`_`) || (r2 ? /^[+-]?_/.test(e4) : e4.startsWith(`_`))) throw new O(t2, n2, `Underscore must be between digits`);
  if (/__/.test(e4)) throw new O(t2, n2, `Consecutive underscores not allowed`);
}
function We(e4, t2, n2, r2) {
  let i2 = e4.replace(Ne, ``);
  if (/^[+-]?0\d/.test(i2) && !Ie.test(e4) && !Re.test(e4) && !ze.test(e4)) throw new O(t2, n2, `Leading zeros are not allowed in ${r2}`);
}
function Ge(e4, t2, n2, r2) {
  if (/_[eE]/.test(e4)) throw new O(n2, r2, `Underscore before exponent is not allowed`);
  if (/[eE][+-]?_/.test(e4)) throw new O(n2, r2, `Underscore at start of exponent is not allowed`);
  if (/[eE][+-]?$/.test(e4)) throw new O(n2, r2, `Invalid float "${t2}": incomplete exponent`);
  if (/[eE][+-]?.*\./.test(e4)) throw new O(n2, r2, `Invalid float "${t2}": decimal point not allowed in exponent`);
}
function Ke(e4, t2, n2, r2, i2, a2) {
  if (e4.length !== 2) throw new O(i2, a2, `"${r2}": hour must be 2 digits`);
  if (t2.length !== 2) throw new O(i2, a2, `"${r2}": minute must be 2 digits`);
  if (n2 && n2.length !== 2) throw new O(i2, a2, `"${r2}": second must be 2 digits`);
}
function qe(e4, t2, n2, r2, i2, a2) {
  if (e4 !== void 0) {
    let t3 = parseInt(e4, 10);
    if (t3 < 0 || t3 > 23) throw new O(i2, a2, `"${r2}": hour must be 00-23`);
  }
  if (t2 !== void 0) {
    let e5 = parseInt(t2, 10);
    if (e5 < 0 || e5 > 59) throw new O(i2, a2, `"${r2}": minute must be 00-59`);
  }
  if (n2 !== void 0) {
    let e5 = parseInt(n2, 10);
    if (e5 < 0 || e5 > 60) throw new O(i2, a2, `"${r2}": second must be 00-60`);
  }
}
function Je(e4, t2, n2) {
  if (Ie.test(e4) || Re.test(e4) || ze.test(e4)) return;
  let r2 = e4.replace(/^[+-]/, ``).replace(/_/g, ``);
  if (!/^[0-9]+$/.test(r2)) throw new O(t2, n2, `Invalid integer "${e4}"`);
}
function Ye(e4, t2, n2, r2, i2, a2, o2) {
  let s2 = r2[0] + r2[1].toUpperCase();
  if (RegExp(`^[+\\-]?` + s2.replace(/([[\]])/g, `\\$1`)).test(e4)) throw new O(t2, n2, `${a2} prefix must be lowercase "${r2}"`);
  if (RegExp(`^[+\\-]?` + r2 + `_`, `i`).test(e4)) throw new O(t2, n2, `Underscore must be between digits`);
  let c2 = RegExp(`^[+\\-]?` + r2, `i`), l2 = e4.replace(c2, ``);
  if (!l2 || l2 === `_` || l2.startsWith(`_`)) throw new O(t2, n2, `Incomplete ${a2.toLowerCase()} number`);
  let u2 = l2.replace(/_/g, ``);
  if (!i2.test(u2)) throw new O(t2, n2, o2 ?? `Invalid ${a2.toLowerCase()} digits`);
  if (/^[+-]/.test(e4)) throw new O(t2, n2, `${a2} numbers cannot have a sign prefix`);
}
function* Xe(e4, t2) {
  let n2 = new ce(te(e4, t2));
  try {
    for (; !n2.next().done; ) {
      let t3 = lt(n2, e4);
      for (let e5 of t3) yield e5;
    }
  } finally {
    b();
  }
}
function et(e4) {
  return { type: `Comment`, loc: e4.value.loc, raw: e4.value.raw };
}
function tt(e4, t2) {
  let n2 = !e4.peek().done && e4.peek().value.type === `Bracket` ? `TableArray` : `Table`, r2 = n2 === `Table`;
  if (r2 && e4.value.raw !== `[`) throw new O(t2, e4.value.loc.start, `Expected table opening "[", found ${e4.value.raw}`);
  if (!r2) {
    let n3 = e4.peek();
    if (n3.done) throw new O(t2, e4.value.loc.start, `Expected "[[" for Array of Tables, found end of input`);
    if (e4.value.raw !== `[` || n3.value.raw !== `[`) throw new O(t2, e4.value.loc.start, `Expected "[[", found ${e4.value.raw + n3.value.raw}`);
    let r3 = e4.value, i3 = n3.value;
    if (r3.loc.end.line !== i3.loc.start.line || r3.loc.end.column !== i3.loc.start.column) throw new O(t2, r3.loc.start, `"[[" brackets must be adjacent (no whitespace)`);
  }
  let i2 = r2 ? { type: `TableKey`, loc: e4.value.loc } : { type: `TableArrayKey`, loc: e4.value.loc };
  if (e4.next(), n2 === `TableArray` && e4.next(), e4.done) throw new O(t2, i2.loc.start, `Expected table key, reached end of file`);
  if (e4.value.type === `Bracket` && e4.value.raw === `]`) throw new O(t2, e4.value.loc.start, n2 === `TableArray` ? `Array of Tables header [[]] requires a table name` : `Table header [] requires a table name`);
  let a2 = e4.value.raw;
  Ve(a2, t2, e4.value.loc.start), a2.startsWith(`"`) || a2.startsWith(`'`) || Be(a2, t2, e4.value.loc.start);
  let o2;
  for (o2 = [He(e4.value.raw, t2, e4.value.loc.start)], i2.item = { type: `Key`, loc: e4.value.loc, raw: e4.value.raw, value: o2 }; !e4.peek().done && e4.peek().value.type === `Dot`; ) {
    e4.next();
    let n3 = e4.value;
    e4.next();
    let r3 = e4.value.raw;
    r3.startsWith(`"`) || r3.startsWith(`'`) || Be(r3, t2, e4.value.loc.start);
    let a3 = ` `.repeat(n3.loc.start.column - i2.item.loc.end.column), o3 = ` `.repeat(e4.value.loc.start.column - n3.loc.end.column);
    i2.item.loc.end = e4.value.loc.end, i2.item.raw += `${a3}.${o3}${e4.value.raw}`;
    try {
      i2.item.value.push(ae(e4.value.raw));
    } catch (n4) {
      let r4 = n4;
      throw new O(t2, e4.value.loc.start, r4.message);
    }
  }
  if (e4.next(), !e4.done) {
    let n3 = i2.loc.start.line;
    if (e4.value.loc.start.line !== n3) throw new O(t2, e4.value.loc.start, r2 ? `Table header must be single-line` : `Array of Tables header must be single-line`);
  }
  if (r2 && (e4.done || e4.value.raw !== `]`)) throw new O(t2, e4.done ? i2.item.loc.end : e4.value.loc.start, `Expected table closing "]", found ${e4.done ? `end of file` : e4.value.raw}`);
  if (!r2 && (e4.done || e4.peek().done || e4.value.raw !== `]` || e4.peek().value.raw !== `]`)) throw new O(t2, e4.done || e4.peek().done ? i2.item.loc.end : e4.value.loc.start, `Expected "]]" closing, found ${e4.done || e4.peek().done ? `end of file` : e4.value.raw + e4.peek().value.raw}`);
  if (!r2) {
    let n3 = e4.value, r3 = e4.peek().value;
    if (n3.loc.end.line !== r3.loc.start.line || n3.loc.end.column !== r3.loc.start.column) throw new O(t2, n3.loc.start, `"]]" brackets must be adjacent (no whitespace)`);
  }
  if (r2 || e4.next(), i2.loc.end = e4.value.loc.end, !e4.peek().done) {
    let n3 = e4.peek().value;
    if (n3.loc.start.line === i2.loc.end.line && n3.type !== `Comment`) throw new O(t2, n3.loc.start, `Extra content after ${r2 ? `table` : `Array of Tables`} header`);
  }
  let s2 = [];
  for (; !e4.peek().done && e4.peek().value.type !== `Bracket`; ) {
    e4.next();
    let n3 = lt(e4, t2);
    for (let e5 = 0; e5 < n3.length; e5++) s2.push(n3[e5]);
  }
  return { type: r2 ? `Table` : `TableArray`, loc: { start: T(i2.loc.start), end: s2.length ? T(s2[s2.length - 1].loc.end) : T(i2.loc.end) }, key: i2, items: s2 };
}
function nt(e4, t2) {
  let n2 = He(e4.value.raw, t2, e4.value.loc.start);
  return { type: `String`, loc: e4.value.loc, raw: e4.value.raw, value: n2 };
}
function rt(e4) {
  return { type: `Boolean`, loc: e4.value.loc, value: e4.value.raw === je };
}
function it(e4, t2) {
  let n2 = e4.value.loc, r2 = e4.value.raw, i2;
  if (!e4.peek().done && e4.peek().value.type === `Literal` && Ae.IS_FULL_DATE.test(r2) && /^\d/.test(e4.peek().value.raw) && Ae.IS_FULL_TIME.test(e4.peek().value.raw)) {
    let t3 = n2.start;
    e4.next(), n2 = { start: t3, end: e4.value.loc.end }, r2 += ` ${e4.value.raw}`;
  }
  if (!e4.peek().done && e4.peek().value.type === `Dot`) {
    let i3 = n2.start;
    if (e4.next(), e4.peek().done || e4.peek().value.type !== `Literal`) throw new O(t2, e4.value.loc.end, `Expected fractional value for DateTime`);
    e4.next(), n2 = { start: i3, end: e4.value.loc.end }, r2 += `.${e4.value.raw}`;
  }
  if (ot(r2, t2, n2.start), Ae.IS_FULL_DATE.test(r2)) i2 = Ae.IS_DATE_ONLY.test(r2) ? new Ee(r2) : Ae.IS_LOCAL_DATETIME_T.test(r2) ? new Oe(r2, false) : Ae.IS_LOCAL_DATETIME_SPACE.test(r2) ? new Oe(r2, true) : Ae.IS_OFFSET_DATETIME_T.test(r2) ? new ke(r2, false) : Ae.IS_OFFSET_DATETIME_SPACE.test(r2) ? new ke(r2, true) : new Date(r2.replace(` `, `T`));
  else if (Ae.IS_TIME_ONLY.test(r2)) i2 = new De(r2, r2);
  else {
    let [e5] = (/* @__PURE__ */ new Date()).toISOString().split(`T`);
    i2 = /* @__PURE__ */ new Date(`${e5}T${r2}`);
  }
  return { type: `DateTime`, loc: n2, raw: r2, value: i2 };
}
function at(e4, t2) {
  return t2 === 2 ? e4 % 4 == 0 && e4 % 100 != 0 || e4 % 400 == 0 ? 29 : 28 : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][t2 - 1];
}
function ot(e4, t2, n2) {
  if (/\.([Zz]|[+-])/.test(e4)) throw new O(t2, n2, `"${e4}": fractional seconds needs digit after dot`);
  if (/[+-]$/.test(e4)) throw new O(t2, n2, `"${e4}": offset needs HH:MM`);
  let r2 = /\d{2}:\d{2}/.test(e4) ? e4.match(/([+-])(\d+)(:?)(\d*)$/) : null;
  if (r2) {
    let e5 = r2[0], i3 = r2[2], a3 = r2[3], o3 = r2[4];
    if (a3 !== `:`) throw new O(t2, n2, `Offset "${e5}": missing colon separator`);
    if (i3.length !== 2) throw new O(t2, n2, `Offset "${e5}": hour must be 2 digits`);
    if (!o3 || o3.length === 0) throw new O(t2, n2, `Offset "${e5}": minute required`);
    if (o3.length !== 2) throw new O(t2, n2, `Offset "${e5}": minute must be 2 digits`);
    let s3 = parseInt(i3, 10);
    if (s3 < 0 || s3 > 23) throw new O(t2, n2, `Offset "${e5}": hour must be 00-23`);
    let c3 = parseInt(o3, 10);
    if (c3 < 0 || c3 > 59) throw new O(t2, n2, `Offset "${e5}": minute must be 00-59`);
  }
  if (!/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/.test(e4) && !/^\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(e4)) throw /^\d{4}-\d{2}-\d{2}T$/.test(e4) ? new O(t2, n2, `"${e4}": 'T' requires time component`) : /^\d{4}-\d{2}-\d{2}[a-su-zA-SU-Z]/.test(e4) ? new O(t2, n2, `Invalid date "${e4}": unexpected character after date`) : /^\d{4}-\d{2}-\d{2}\d{2}:\d{2}/.test(e4) ? new O(t2, n2, `"${e4}": missing 'T' or space separator`) : new O(t2, n2, `Invalid datetime "${e4}"`);
  let i2 = e4.match(/^(\d+)-/);
  if (i2 && i2[1].length !== 4) throw new O(t2, n2, `"${e4}": year must be 4 digits`);
  let a2 = e4.match(/^(\d+)-(\d+)-(\d+)/);
  if (a2) {
    let [, , r3, i3] = a2;
    if (r3.length !== 2) throw new O(t2, n2, `"${e4}": month must be 2 digits`);
    if (i3.length !== 2) throw new O(t2, n2, `"${e4}": day must be 2 digits`);
  }
  let o2 = e4.match(/[T ](\d+):(\d+)(?::(\d+))?/);
  if (o2) {
    let [, r3, i3, a3] = o2;
    Ke(r3, i3, a3, e4, t2, n2);
  }
  let s2 = e4.match(/^(\d+):(\d+)(?::(\d+))?/);
  if (s2 && !a2) {
    let [, r3, i3, a3] = s2;
    Ke(r3, i3, a3, e4, t2, n2);
  }
  let c2 = e4.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/), l2 = e4.match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (c2) {
    let [, r3, i3, a3, o3, s3, l3] = c2, u2 = parseInt(i3, 10);
    if (u2 < 1 || u2 > 12) throw new O(t2, n2, `"${e4}": month must be 01-12`);
    let d2 = parseInt(a3, 10);
    if (d2 < 1 || d2 > 31) throw new O(t2, n2, `"${e4}": day must be 01-31`);
    if (d2 > at(parseInt(r3, 10), u2)) throw new O(t2, n2, `"${e4}": day ${a3} invalid for ${r3}-${i3}`);
    qe(o3, s3, l3, e4, t2, n2);
  } else if (l2) {
    let [, r3, i3, a3] = l2;
    qe(r3, i3, a3, e4, t2, n2);
  }
}
function st(e4, t2) {
  let n2 = e4.value.loc, r2 = e4.value.raw, i2;
  if (Pe.test(r2)) i2 = r2.startsWith(`-`) ? -1 / 0 : 1 / 0;
  else if (Fe.test(r2)) {
    let e5 = new Float64Array(1), t3 = new DataView(e5.buffer);
    r2.startsWith(`-`) ? (t3.setUint32(0, 0, true), t3.setUint32(4, 4294443008, true)) : (t3.setUint32(0, 0, true), t3.setUint32(4, 2146959360, true)), i2 = e5[0];
    let a2 = r2.startsWith(`+`) ? `+` : r2.startsWith(`-`) ? `-` : void 0;
    return { type: `Float`, loc: n2, raw: r2, value: i2, nanSign: a2 };
  } else if (!e4.peek().done && e4.peek().value.type === `Dot`) {
    let a2 = n2.start;
    {
      if (Me.test(r2) && !Ie.test(r2)) throw new O(t2, n2.start, `Float "${r2}": dot after exponent`);
      let e5 = r2;
      We(e5, t2, n2.start, `the integer part of a float`);
      let i3 = e5.replace(/^[+-]/, ``);
      if (i3 === `` || i3 === `_`) throw new O(t2, n2.start, `Float: digit required before dot`);
      Ue(e5, t2, n2.start);
    }
    if (e4.next(), e4.peek().done || e4.peek().value.type !== `Literal`) throw new O(t2, e4.value.loc.end, `Expected fraction value for Float`);
    e4.next(), r2 += `.${e4.value.raw}`, n2 = { start: a2, end: e4.value.loc.end };
    {
      let n3 = e4.value.raw;
      if (!/^\d/.test(n3)) throw new O(t2, e4.value.loc.start, `Float: fraction must start with digit, found "${n3}"`);
      Ue(n3, t2, e4.value.loc.start, false), Ge(n3, r2, t2, e4.value.loc.start);
    }
    i2 = Number(r2.replace(Ne, ``));
  } else {
    if (Ue(r2, t2, n2.start), Ge(r2, r2, t2, n2.start), !e4.peek().done && e4.peek().value.type === `Dot`) throw new O(t2, e4.peek().value.loc.start, `Float "${r2}.": dot after exponent`);
    We(r2, t2, n2.start, `the integer part of a float`), i2 = Number(r2.replace(Ne, ``));
  }
  if (Number.isNaN(i2) && !Fe.test(r2)) throw new O(t2, n2.start, `Invalid float "${r2}"`);
  return { type: `Float`, loc: n2, raw: r2, value: i2 };
}
function ct(e4, t2) {
  let n2 = e4.value.raw, r2 = e4.value.loc;
  if (/^\d{1,}-\d{1,}/.test(n2) || /^\d{1,}:\d{1,}/.test(n2) || /^\d{6}-\d{2}$/.test(n2)) throw new O(t2, r2.start, `Invalid integer "${n2}"`);
  if (n2 === `-0` || n2 === `+0`) return { type: `Integer`, loc: r2, raw: n2, value: 0 };
  if (/^[+-]{2,}/.test(n2)) throw new O(t2, r2.start, `Double sign is not allowed in integers`);
  We(n2, t2, r2.start, `decimal integers`), Ue(n2, t2, r2.start), Je(n2, t2, r2.start);
  let i2 = 10;
  Ie.test(n2) ? (i2 = 16, Ye(n2, t2, r2.start, `0x`, /^[0-9a-fA-F]+$/, `Hexadecimal`)) : Re.test(n2) ? (i2 = 8, Ye(n2, t2, r2.start, `0o`, /^[0-7]+$/, `Octal`, `Invalid octal digits (must be 0-7)`)) : ze.test(n2) && (i2 = 2, Ye(n2, t2, r2.start, `0b`, /^[01]+$/, `Binary`, `Invalid binary digits (must be 0 or 1)`));
  let a2 = parseInt(n2.replace(Ne, ``).replace(Re, ``).replace(ze, ``), i2);
  if (Number.isNaN(a2)) throw new O(t2, r2.start, `Invalid integer "${n2}"`);
  return { type: `Integer`, loc: r2, raw: n2, value: a2 };
}
function lt(e4, t2) {
  if (e4.value.type === `Comment`) return [et(e4)];
  if (e4.value.type === `Bracket`) return [tt(e4, t2)];
  if (e4.value.type === `Literal`) return ut(e4, t2);
  throw e4.value.type === `Equal` ? new O(t2, e4.value.loc.start, `Missing key before '='`) : new O(t2, e4.value.loc.start, `Unexpected token "${e4.value.type}"`);
}
function ut(e4, t2) {
  let n2 = e4.value.raw;
  if (n2.endsWith(`:`)) throw new O(t2, { line: e4.value.loc.start.line, column: e4.value.loc.start.column + [...n2].length - 1 }, `Use '=' to separate keys and values, not ':'`);
  Ve(n2, t2, e4.value.loc.start), n2.startsWith(`"`) || n2.startsWith(`'`) || Be(n2, t2, e4.value.loc.start);
  let r2;
  r2 = [He(e4.value.raw, t2, e4.value.loc.start)];
  let i2 = { type: `Key`, loc: e4.value.loc, raw: e4.value.raw, value: r2 };
  for (; !e4.peek().done && e4.peek().value.type === `Dot`; ) {
    e4.next();
    let n3 = e4.value;
    e4.next();
    let r3 = e4.value.raw;
    Ve(r3, t2, e4.value.loc.start), r3.startsWith(`"`) || r3.startsWith(`'`) || Be(r3, t2, e4.value.loc.start);
    let a3 = C(t2, i2.loc.end), o3 = C(t2, n3.loc.end), s3 = a3.slice(i2.loc.end.column, n3.loc.start.column), c3 = o3.slice(n3.loc.end.column, e4.value.loc.start.column);
    i2.loc.end = e4.value.loc.end, i2.raw += `${s3}.${c3}${e4.value.raw}`, i2.value.push(He(e4.value.raw, t2, e4.value.loc.start));
  }
  if (e4.next(), !e4.done && e4.value.loc.start.line !== i2.loc.end.line) throw new O(t2, e4.value.loc.start, `"=" must be on same line as key`);
  if (e4.done || e4.value.type !== `Equal`) throw !e4.done && e4.value.raw === `:` ? new O(t2, e4.value.loc.start, `Use '=' to separate keys and values, not ':'`) : new O(t2, e4.done ? i2.loc.end : e4.value.loc.start, `Expected "=" for key-value`);
  let a2 = e4.value.loc.start.column, o2 = e4.value.loc.start.line;
  if (e4.next(), e4.done) throw new O(t2, i2.loc.start, `Expected value, reached EOF`);
  if (e4.value.loc.start.line !== o2) throw new O(t2, e4.value.loc.start, `Value must be on same line as '='`);
  if (e4.done) throw new O(t2, i2.loc.start, `Expected value for key-value`);
  let s2 = dt(e4, t2), c2 = s2[0];
  if (!e4.peek().done) {
    let n3 = e4.peek().value;
    if (n3.type === `Dot` && n3.loc.start.line === c2.loc.end.line && (c2.type === `Float` || c2.type === `Integer`)) throw new O(t2, n3.loc.start, `Invalid number: multiple decimal points not allowed`);
    if ((n3.type === `Literal` || n3.type === `Bracket`) && n3.loc.start.line === c2.loc.end.line) throw new O(t2, n3.loc.start, `Key/value pairs must be separated by a newline`);
  }
  return s2[0] = { type: `KeyValue`, key: i2, value: c2, loc: { start: T(i2.loc.start), end: T(c2.loc.end) }, equals: a2 }, s2;
}
function dt(e4, t2) {
  if (e4.value.type === `Literal`) {
    let n2 = e4.value.raw;
    return n2[0] === `"` || n2[0] === `'` ? [nt(e4, t2)] : n2 === je || n2 === `false` ? [rt(e4)] : /^\d/.test(n2) && (/^\d{1,}-\d{1,}/.test(n2) || /^\d{1,}:\d{1,}/.test(n2)) ? [it(e4, t2)] : !e4.peek().done && e4.peek().value.type === `Dot` || Pe.test(n2) || Fe.test(n2) || Me.test(n2) && !Ie.test(n2) ? [st(e4, t2)] : [ct(e4, t2)];
  }
  if (e4.value.type === `Curly`) {
    let [n2, r2] = pt(e4, t2);
    return [n2, ...r2];
  }
  if (e4.value.type === `Bracket`) {
    let [n2, r2] = mt(e4, t2);
    return [n2, ...r2];
  }
  throw e4.value.type === `Dot` ? new O(t2, e4.value.loc.start, `Number cannot start with a dot`) : new O(t2, e4.value.loc.start, `Unrecognized token type`);
}
function ft(e4) {
  for (let t2 = 1; t2 < e4.length; t2++) {
    let n2 = e4[t2 - 1], r2 = e4[t2];
    if (n2.loc.end.line === r2.loc.start.line) {
      let e5 = r2.loc.start.column - n2.loc.end.column;
      if (e5 >= 1) return e5;
    }
  }
}
function pt(e4, t2) {
  if (e4.value.raw !== `{`) throw new O(t2, e4.value.loc.start, `Expected "{" for inline table`);
  let n2 = { type: `InlineTable`, loc: e4.value.loc, items: [] }, r2 = [];
  for (e4.next(); !e4.done && (e4.value.type !== `Curly` || e4.value.raw !== `}`); ) {
    if (e4.value.type === `Comment`) {
      r2.push(et(e4)), e4.next();
      continue;
    }
    if (e4.value.type === `Comma`) {
      let r3 = n2.items[n2.items.length - 1];
      if (!r3) throw new O(t2, e4.value.loc.start, `Leading comma in inline table`);
      if (r3.comma) throw new O(t2, e4.value.loc.start, `Consecutive commas in inline table`);
      r3.comma = true, r3.loc.end = e4.value.loc.start, e4.next();
      continue;
    }
    let i2 = n2.items[n2.items.length - 1];
    if (i2 && !i2.comma) throw new O(t2, e4.value.loc.start, `Missing comma between inline table items`);
    let a2 = lt(e4, t2), o2 = a2[0];
    if (o2.type === `KeyValue`) {
      n2.items.push({ type: `InlineItem`, loc: E(o2.loc), item: o2, comma: false });
      for (let e5 = 1; e5 < a2.length; e5++) r2.push(a2[e5]);
    }
    e4.next();
  }
  if (e4.done || e4.value.type !== `Curly` || e4.value.raw !== `}`) throw new O(t2, e4.done ? n2.loc.start : e4.value.loc.start, `Expected "}"`);
  n2.loc.end = e4.value.loc.end;
  {
    let e5 = ft(n2.items);
    e5 !== void 0 && fe(n2, e5);
  }
  return [n2, r2];
}
function mt(e4, t2) {
  if (e4.value.raw !== `[`) throw new O(t2, e4.value.loc.start, `Expected "[" for inline array`);
  let n2 = { type: `InlineArray`, loc: e4.value.loc, items: [] }, r2 = [];
  for (e4.next(); !e4.done && (e4.value.type !== `Bracket` || e4.value.raw !== `]`); ) {
    if (e4.value.type === `Comma`) {
      let r3 = n2.items[n2.items.length - 1];
      if (!r3) throw new O(t2, e4.value.loc.start, `Leading comma in array`);
      if (r3.comma) throw new O(t2, e4.value.loc.start, `Consecutive commas in array`);
      r3.comma = true, r3.loc.end = e4.value.loc.start;
    } else if (e4.value.type === `Comment`) r2.push(et(e4));
    else {
      let i2 = n2.items[n2.items.length - 1];
      if (i2 && !i2.comma) throw new O(t2, e4.value.loc.start, `Missing comma between array elements`);
      let a2 = dt(e4, t2), o2 = a2[0];
      n2.items.push({ type: `InlineItem`, loc: E(o2.loc), item: o2, comma: false });
      for (let e5 = 1; e5 < a2.length; e5++) r2.push(a2[e5]);
    }
    e4.next();
  }
  if (e4.done || e4.value.type !== `Bracket` || e4.value.raw !== `]`) throw new O(t2, e4.done ? n2.loc.start : e4.value.loc.start, `Expected "]"`);
  n2.loc.end = e4.value.loc.end;
  {
    let e5 = ft(n2.items);
    e5 !== void 0 && fe(n2, e5);
  }
  return [n2, r2];
}
function N(e4) {
  return e4[e4.length - 1];
}
function ht() {
  return /* @__PURE__ */ Object.create(null);
}
function gt(e4, t2) {
  return e4 === t2 && (typeof e4 != `number` || Object.is(e4, t2));
}
var _t = new DataView(new ArrayBuffer(8));
function vt(e4) {
  return Number.isNaN(e4) ? (_t.setFloat64(0, e4, true), !!(_t.getUint32(4, true) & 2147483648)) : false;
}
function yt(e4) {
  return typeof e4 == `string`;
}
function bt(e4) {
  return typeof e4 == `number` && e4 % 1 == 0 && isFinite(e4) && !Object.is(e4, -0) && e4 >= -(2 ** 53 - 1) && e4 <= 2 ** 53 - 1;
}
function xt(e4) {
  return typeof e4 == `bigint`;
}
function St(e4) {
  return typeof e4 == `number` && (!bt(e4) || !isFinite(e4) || Object.is(e4, -0));
}
function Ct(e4) {
  return typeof e4 == `boolean`;
}
function wt(e4) {
  return Object.prototype.toString.call(e4) === `[object Date]`;
}
var Tt = /* @__PURE__ */ new Set([`Temporal.PlainDate`, `Temporal.PlainTime`, `Temporal.PlainDateTime`, `Temporal.ZonedDateTime`, `PlainDate`, `PlainTime`, `PlainDateTime`, `ZonedDateTime`]);
function Et(e4) {
  var t2;
  return typeof e4 == `object` && !!e4 && Tt.has((t2 = e4.constructor) == null ? void 0 : t2.name) && typeof e4.equals == `function`;
}
function Dt(e4) {
  var t2;
  let n2 = ((t2 = e4.constructor) == null ? void 0 : t2.name) ?? ``;
  if (n2 === `Temporal.ZonedDateTime` || n2 === `ZonedDateTime`) {
    let t3 = e4.toString(), n3 = t3.match(/\[(.+)\]$/);
    if (n3 && !/^[+-]\d{2}:\d{2}$/.test(n3[1])) throw Error(`ZonedDateTime with IANA timezone "${t3}" cannot be represented in TOML. TOML only supports offset-based timezones (+05:30, Z).`);
    return t3.replace(/\[.*\]$/, ``).replace(/(\+00:00)$/, `Z`);
  }
  let r2 = e4.toString();
  if (/\[.*\]/.test(r2)) throw Error(`Temporal value contains unsupported annotation: "${r2}". TOML only supports ISO 8601 calendar.`);
  return r2;
}
function Ot(e4, t2 = /* @__PURE__ */ new WeakSet()) {
  return typeof e4 != `object` || !e4 ? false : Et(e4) ? true : !t2.has(e4) && (t2.add(e4), Object.values(e4).some((e5) => Ot(e5, t2)));
}
function P(e4) {
  return e4 && typeof e4 == `object` && !wt(e4) && !Et(e4) && !Array.isArray(e4);
}
function kt(e4) {
  return e4 != null && typeof e4[Symbol.iterator] == `function`;
}
function At(e4) {
  return e4.startsWith(`"`) && !e4.startsWith(`"""`);
}
function jt(e4) {
  return e4.startsWith(`"""`);
}
function Mt(e4) {
  return e4.startsWith(`'`) && !e4.startsWith(`'''`);
}
function Nt(e4) {
  return e4.startsWith(`'''`);
}
function Pt(e4, t2) {
  return t2 in e4;
}
function F(e4, t2) {
  if (e4.length !== t2.length) return false;
  for (let n2 = 0; n2 < e4.length; n2++) if (e4[n2] !== t2[n2]) return false;
  return true;
}
function Ft(e4) {
  return /^\d{4}-\d{2}-\d{2}$/.test(e4) ? `date` : /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(e4) ? `time` : /(?:[Zz]|[+-]\d{2}:\d{2})$/.test(e4) ? `offset` : `datetime`;
}
function It(e4) {
  let t2 = e4.match(/\.(\d+)/);
  return t2 ? t2[1].replace(/0+$/, ``) : ``;
}
function Lt(e4) {
  return e4 === 0 ? 0 : String(e4).padStart(3, `0`).replace(/0+$/, ``).length;
}
function Rt(e4, t2) {
  let n2 = It(t2);
  return n2.length > Lt(e4.getUTCMilliseconds()) ? n2 : void 0;
}
function zt(e4, t2) {
  if (Et(e4) && Et(t2)) return e4.toString() === t2.toString();
  if (wt(e4) && wt(t2)) {
    if (e4.getTime() !== t2.getTime()) return false;
    let n2 = e4.toISOString(), r2 = t2.toISOString();
    if (Ft(n2) !== Ft(r2)) return false;
    let i2 = Rt(e4, n2), a2 = Rt(t2, r2);
    return i2 === void 0 || a2 === void 0 || i2 === a2;
  }
  return false;
}
function Bt(e4) {
  let t2 = [], n2 = /* @__PURE__ */ new WeakSet(), r2 = [{ value: e4 }];
  for (; r2.length > 0; ) {
    let e5 = r2.pop();
    if (`text` in e5) {
      t2.push(e5.text), `leave` in e5 && n2.delete(e5.leave);
      continue;
    }
    let i2 = e5.value;
    if (P(i2)) {
      if (n2.has(i2)) throw TypeError(`Cannot stableStringify a circular structure`);
      n2.add(i2);
      let e6 = Object.keys(i2).sort();
      t2.push(`{`), r2.push({ leave: i2, text: `}` });
      for (let t3 = e6.length - 1; t3 >= 0; t3--) {
        let n3 = e6[t3];
        t3 < e6.length - 1 && r2.push({ text: `,` }), r2.push({ value: i2[n3] }), r2.push({ text: `:` }), r2.push({ text: JSON.stringify(n3) });
      }
    } else if (Array.isArray(i2)) {
      if (n2.has(i2)) throw TypeError(`Cannot stableStringify a circular structure`);
      n2.add(i2), t2.push(`[`), r2.push({ leave: i2, text: `]` });
      for (let e6 = i2.length - 1; e6 >= 0; e6--) e6 < i2.length - 1 && r2.push({ text: `,` }), r2.push({ value: i2[e6] });
    } else if (Et(i2)) t2.push(JSON.stringify(i2.toString()));
    else if (wt(i2)) t2.push(JSON.stringify(i2.toISOString()));
    else if (typeof i2 == `bigint`) t2.push(i2.toString() + `n`);
    else if (typeof i2 == `number` && !Number.isFinite(i2)) {
      let e6 = Number.isNaN(i2) ? vt(i2) ? `-` : `+` : i2 < 0 ? `-` : `+`;
      t2.push(`${e6}${String(i2)}`);
    } else typeof i2 == `number` && Object.is(i2, -0) ? t2.push(`-0`) : t2.push(JSON.stringify(i2));
  }
  return t2.join(``);
}
function Vt(e4, t2) {
  let n2 = e4.length, r2 = t2.length;
  e4.length = n2 + r2;
  for (let i2 = 0; i2 < r2; i2++) e4[n2 + i2] = t2[i2];
}
var Ht = typeof String.prototype.isWellFormed == `function` ? String.prototype.isWellFormed : void 0;
function Ut(e4) {
  for (let t2 = 0; t2 < e4.length; t2++) {
    let n2 = e4.charCodeAt(t2);
    if (!(n2 < 55296 || n2 > 57343)) {
      if (n2 <= 56319) {
        let n3 = e4.charCodeAt(t2 + 1);
        if (n3 >= 56320 && n3 <= 57343) {
          t2++;
          continue;
        }
      }
      return { index: t2, code: n2 };
    }
  }
}
function Wt(e4, t2) {
  if (Ht !== void 0 && Ht.call(e4)) return;
  let n2 = Ut(e4);
  if (!n2) return;
  let r2 = n2.code.toString(16).toUpperCase().padStart(4, `0`);
  throw Error(`${t2} contains a lone surrogate (U+${r2}) at index ${n2.index}. Unpaired surrogates are not Unicode scalar values and cannot be encoded as TOML.`);
}
function Gt(e4, t2) {
  kt(e4) ? n2(e4, null) : r2(e4, null);
  function n2(e5, t3) {
    for (let n3 of e5) r2(n3, t3);
  }
  function r2(e5, i2) {
    let a2 = t2[e5.type];
    switch (a2 && typeof a2 == `function` && a2(e5, i2), a2 && a2.enter && a2.enter(e5, i2), e5.type) {
      case `Document`:
        n2(e5.items, e5);
        break;
      case `Table`:
        r2(e5.key, e5), n2(e5.items, e5);
        break;
      case `TableKey`:
        r2(e5.item, e5);
        break;
      case `TableArray`:
        r2(e5.key, e5), n2(e5.items, e5);
        break;
      case `TableArrayKey`:
        r2(e5.item, e5);
        break;
      case `KeyValue`:
        r2(e5.key, e5), r2(e5.value, e5);
        break;
      case `InlineArray`:
        n2(e5.items, e5);
        break;
      case `InlineItem`:
        r2(e5.item, e5);
        break;
      case `InlineTable`:
        n2(e5.items, e5);
        break;
      case `Key`:
      case `String`:
      case `Integer`:
      case `Float`:
      case `Boolean`:
      case `DateTime`:
      case `Comment`:
        break;
      default:
        throw Error(`Unrecognized node type "${e5.type}"`);
    }
    a2 && a2.exit && a2.exit(e5, i2);
  }
}
function Kt(e4) {
  return new TextDecoder(`utf-8`, { fatal: true, ignoreBOM: true }).decode(e4);
}
function qt(e4) {
  return e4.charCodeAt(0) === 65279;
}
function Jt(e4) {
  return qt(e4) ? e4.slice(1) : e4;
}
var Yt = `auto`;
var Xt = `auto`;
function Zt(e4) {
  for (let t2 of e4) {
    let e5 = tn(t2);
    if (e5 !== null) return e5;
  }
  return false;
}
function Qt(e4, t2) {
  for (let n2 of t2) {
    let t3 = $t(n2, e4);
    if (t3 !== null) return t3;
  }
  return true;
}
function $t(e4, t2) {
  if (!e4 || typeof e4 != `object`) return null;
  if ((e4.type === `InlineArray` || e4.type === `InlineTable`) && e4.loc) {
    let n2 = en(e4.loc, t2);
    if (n2 !== null) return n2;
  }
  if (e4.items && Array.isArray(e4.items)) for (let n2 of e4.items) {
    let e5 = $t(n2, t2);
    if (e5 !== null) return e5;
    if (n2.item) {
      let e6 = $t(n2.item, t2);
      if (e6 !== null) return e6;
    }
  }
  for (let n2 of [`value`, `key`, `item`]) if (e4[n2]) {
    let r2 = $t(e4[n2], t2);
    if (r2 !== null) return r2;
  }
  return null;
}
function en(e4, t2) {
  if (!e4 || !e4.start || !e4.end) return null;
  let n2 = t2.split(/\r?\n/), r2 = e4.start.line - 1, i2 = e4.end.line - 1, a2 = e4.start.column, o2 = e4.end.column, s2 = ``;
  if (r2 === i2) {
    var c2;
    s2 = ((c2 = n2[r2]) == null ? void 0 : c2.substring(a2, o2 + 1)) || ``;
  } else {
    n2[r2] && (s2 += n2[r2].substring(a2));
    for (let e5 = r2 + 1; e5 < i2; e5++) s2 += `
` + (n2[e5] || ``);
    n2[i2] && (s2 += `
` + n2[i2].substring(0, o2 + 1));
  }
  let l2 = s2.match(/^\[(\s*)/), u2 = s2.match(/^\{(\s*)/);
  return l2 ? l2[1].length > 0 : u2 ? u2[1].length > 0 : null;
}
function tn(e4) {
  if (!e4 || typeof e4 != `object`) return null;
  if (e4.type === `InlineArray` && e4.items && Array.isArray(e4.items) || e4.type === `InlineTable` && e4.items && Array.isArray(e4.items)) return nn(e4.items);
  if (e4.type === `KeyValue` && e4.value) return tn(e4.value);
  if (e4.items && Array.isArray(e4.items)) for (let t2 of e4.items) {
    let e5 = tn(t2);
    if (e5 !== null) return e5;
  }
  return null;
}
function nn(e4) {
  if (e4.length === 0) return null;
  let t2 = e4[e4.length - 1];
  return t2 && typeof t2 == `object` && `comma` in t2 ? t2.comma === true : false;
}
function rn(e4) {
  let t2 = e4.indexOf(`
`);
  return t2 > 0 && e4[t2 - 1] === `\r` ? `\r
` : `
`;
}
function an(e4) {
  let t2 = 0, n2 = e4.length;
  for (; n2 > 0 && e4[n2 - 1] === `
`; ) t2++, n2--, n2 > 0 && e4[n2 - 1] === `\r` && n2--;
  return t2;
}
function on(e4) {
  for (let t2 = 0; t2 < e4.length; t2++) {
    if (e4[t2] !== `\\`) continue;
    let n2 = e4[t2 + 1];
    if (!n2) return null;
    if (n2 === `\\`) {
      t2++;
      continue;
    }
    if (n2 === `x` && /^[0-9A-Fa-f]{2}$/.test(e4.slice(t2 + 2, t2 + 4))) return /[A-F]/.test(e4.slice(t2 + 2, t2 + 4));
    if (n2 === `u` && /^[0-9A-Fa-f]{4}$/.test(e4.slice(t2 + 2, t2 + 6))) return /[A-F]/.test(e4.slice(t2 + 2, t2 + 6));
    if (n2 === `U` && /^[0-9A-Fa-f]{8}$/.test(e4.slice(t2 + 2, t2 + 10))) return /[A-F]/.test(e4.slice(t2 + 2, t2 + 10));
  }
  return null;
}
function sn(e4) {
  if (!e4 || typeof e4 != `object`) return null;
  if (e4.type === `String` && typeof e4.raw == `string`) {
    let t2 = on(e4.raw);
    if (t2 !== null) return t2;
  }
  for (let t2 of [`key`, `item`, `value`]) if (e4[t2] && typeof e4[t2] == `object`) {
    let n2 = sn(e4[t2]);
    if (n2 !== null) return n2;
  }
  if (Array.isArray(e4.items)) for (let t2 of e4.items) {
    let e5 = sn(t2);
    if (e5 !== null) return e5;
  }
  return null;
}
function cn(e4) {
  for (let t2 of e4) {
    let e5 = sn(t2);
    if (e5 !== null) return e5;
  }
  return true;
}
function ln(e4) {
  let t2 = e4.split(/\r?\n/), n2 = 0, r2 = 0;
  for (let e5 of t2) if (e5.length !== 0 && (e5[0] === `	` ? n2++ : e5[0] === ` ` && r2++, n2 + r2 >= 5)) break;
  return n2 > 0 && n2 >= r2;
}
function un(e4) {
  let t2 = 0;
  for (; t2 < e4.length && e4[t2] === ` `; ) t2++;
  return t2;
}
function dn(e4, t2) {
  let n2 = e4.split(/\r?\n/), r2 = [], i2 = /* @__PURE__ */ new Set([`Table`, `TableArray`, `InlineTable`, `InlineArray`]), a2 = /* @__PURE__ */ new Set([`Table`, `TableArray`, `InlineTable`, `InlineArray`, `KeyValue`, `InlineItem`, `Comment`]), o2 = (e5, t3) => {
    var s3, c3, l2;
    if (!e5 || typeof e5 != `object`) return;
    if (t3 !== void 0 && a2.has(e5.type) && ((s3 = e5.loc) == null || (s3 = s3.start) == null ? void 0 : s3.line) > t3) {
      let t4 = un(n2[e5.loc.start.line - 1] ?? ``);
      t4 > 0 && r2.push(t4);
    }
    let u2 = i2.has(e5.type) && ((c3 = e5.loc) == null || (c3 = c3.end) == null ? void 0 : c3.line) > ((l2 = e5.loc) == null || (l2 = l2.start) == null ? void 0 : l2.line) ? e5.loc.start.line : t3;
    if (Array.isArray(e5.items)) for (let t4 of e5.items) o2(t4, u2);
    e5.item && o2(e5.item, u2), e5.value && o2(e5.value, u2);
  }, s2 = Array.isArray(t2) ? t2 : Array.from(t2 ?? []);
  for (let e5 of s2) o2(e5);
  if (r2.length > 0) return Math.min(...r2);
  let c2 = n2.filter((e5) => e5.trim().length > 0 && !e5.trimStart().startsWith(`#`)).map(un).filter((e5) => e5 > 0);
  return c2.length > 0 ? Math.min(...c2) : 2;
}
var fn = /* @__PURE__ */ new Map([[`
`, `
`], [`\r
`, `\r
`], [`\\n`, `
`], [`\\r\\n`, `\r
`], [`LF`, `
`], [`CRLF`, `\r
`], [`UNIX`, `
`], [`DOS`, `\r
`]]);
function pn(e4) {
  let t2 = fn.get(e4) ?? fn.get(e4.toUpperCase());
  if (t2 === void 0) throw TypeError(`Invalid newLine value: expected LF or CRLF`);
  return t2;
}
function mn(e4) {
  if (!e4 || typeof e4 != `object`) return {};
  let t2 = (e5) => typeof e5 == `boolean` ? null : `expected boolean, got ${typeof e5}`, n2 = (e5) => e5 == null || typeof e5 == `boolean` || e5 === `auto` || e5 === `parent` || typeof e5 == `number` && Number.isInteger(e5) && e5 >= 0 ? null : `expected boolean, non-negative integer, "auto" or "parent", got ${typeof e5}`, r2 = { newLine: (e5) => typeof e5 == `string` ? null : `expected string, got ${typeof e5}`, trailingNewline: (e5) => typeof e5 == `boolean` || typeof e5 == `number` ? null : `expected boolean or number, got ${typeof e5}`, trailingComma: t2, bracketSpacing: t2, leadingBom: t2, inlineTableStart: (e5) => e5 == null || typeof e5 == `number` && Number.isInteger(e5) && e5 >= 0 ? null : `expected non-negative integer or undefined, got ${typeof e5}`, truncateZeroTimeInDates: t2, useTabsForIndentation: t2, indentWidth: (e5) => e5 == null || typeof e5 == `number` && Number.isInteger(e5) && e5 > 0 ? null : `expected positive integer or undefined, got ${typeof e5}`, minimumDecimals: (e5) => e5 == null || typeof e5 == `number` && Number.isInteger(e5) && e5 >= 0 ? null : `expected non-negative integer or undefined, got ${typeof e5}`, minimumTimeDecimals: (e5) => e5 == null || typeof e5 == `number` && Number.isInteger(e5) && e5 >= 0 ? null : `expected non-negative integer or undefined, got ${typeof e5}`, updateOrder: t2, multilineTable: n2, multilineArray: n2, escapeSequenceUpperCase: t2 }, i2 = {}, a2 = [], o2 = [];
  for (let t3 in e4) {
    let n3 = Object.prototype.hasOwnProperty.call(r2, t3) ? r2[t3] : void 0;
    if (n3) {
      let r3 = e4[t3], a3 = n3(r3);
      a3 ? o2.push(`${t3} (${a3})`) : i2[t3] = r3;
    } else Object.prototype.hasOwnProperty.call(e4, t3) && a2.push(t3);
  }
  if (a2.length > 0 && console.warn(`toml-patch: Ignoring unsupported format properties: ${a2.join(`, `)}. Supported properties are: ${Object.keys(r2).join(`, `)}`), o2.length > 0) throw TypeError(`Invalid types for format properties: ${o2.join(`, `)}`);
  return `newLine` in i2 && (i2.newLine = pn(i2.newLine)), i2;
}
function I(e4, t2) {
  if (e4) {
    if (e4 instanceof L) return e4;
    {
      let n2 = mn(e4);
      return new L(n2.newLine ?? t2.newLine, n2.trailingNewline ?? t2.trailingNewline, n2.trailingComma ?? t2.trailingComma, n2.bracketSpacing ?? t2.bracketSpacing, `inlineTableStart` in n2 ? n2.inlineTableStart : t2.inlineTableStart, n2.truncateZeroTimeInDates ?? t2.truncateZeroTimeInDates, n2.useTabsForIndentation ?? t2.useTabsForIndentation, n2.minimumDecimals ?? t2.minimumDecimals, n2.leadingBom ?? t2.leadingBom, n2.updateOrder ?? t2.updateOrder, n2.indentWidth ?? t2.indentWidth, n2.multilineTable ?? t2.multilineTable, n2.multilineArray ?? t2.multilineArray, n2.escapeSequenceUpperCase ?? t2.escapeSequenceUpperCase, n2.minimumTimeDecimals ?? t2.minimumTimeDecimals);
    }
  }
  return t2;
}
var L = class e3 {
  newLine;
  trailingNewline;
  trailingComma;
  bracketSpacing;
  leadingBom;
  inlineTableStart;
  truncateZeroTimeInDates;
  useTabsForIndentation;
  indentWidth;
  minimumDecimals;
  minimumTimeDecimals;
  updateOrder;
  multilineTable;
  multilineArray;
  escapeSequenceUpperCase;
  constructor(e4, t2, n2, r2, i2, a2, o2, s2, c2, l2, u2, d2, f2, p2, m2) {
    this.newLine = e4 == null ? `
` : pn(e4), this.trailingNewline = t2 ?? 1, this.trailingComma = n2 ?? false, this.bracketSpacing = r2 ?? true, this.inlineTableStart = i2 ?? 1, this.truncateZeroTimeInDates = a2 ?? false, this.useTabsForIndentation = o2 ?? false, this.indentWidth = this.useTabsForIndentation ? 1 : u2 ?? 2, this.minimumDecimals = s2 ?? 0, this.minimumTimeDecimals = m2 ?? 0, this.leadingBom = c2 ?? false, this.updateOrder = l2 ?? false, this.multilineTable = d2 ?? `auto`, this.multilineArray = f2 ?? `auto`, this.escapeSequenceUpperCase = p2 ?? true;
  }
  static default() {
    return new e3(`
`, 1, false, true, 1, false, false, 0, false, false, 2, Yt, Xt, true, 0);
  }
  static autoDetectFormat(t2) {
    return e3.autoDetectFormatWithCst(t2);
  }
  static autoDetectFormatWithCst(t2, n2) {
    let r2 = e3.default();
    r2.leadingBom = qt(t2);
    let i2 = Jt(t2), a2 = [];
    r2.newLine = rn(i2), r2.trailingNewline = an(i2);
    try {
      a2 = Array.isArray(n2) ? n2 : Array.from(n2 ?? Xe(i2)), r2.trailingComma = Zt(a2), r2.bracketSpacing = Qt(i2, a2);
    } catch {
      r2.trailingComma = false, r2.bracketSpacing = true;
    }
    return r2.useTabsForIndentation = ln(i2), r2.indentWidth = r2.useTabsForIndentation ? 1 : dn(i2, a2), r2.inlineTableStart = 1, r2.truncateZeroTimeInDates = false, r2.minimumDecimals = 0, r2.minimumTimeDecimals = 0, r2.updateOrder = false, r2.multilineTable = Yt, r2.multilineArray = Xt, r2.escapeSequenceUpperCase = cn(a2), r2;
  }
  static autoDetectFormatWithAst(t2, n2) {
    return e3.autoDetectFormatWithCst(t2, n2);
  }
};
var hn = /* @__PURE__ */ new WeakMap();
var gn = /* @__PURE__ */ new WeakMap();
var _n = /* @__PURE__ */ new WeakSet();
var vn = /* @__PURE__ */ new WeakMap();
function yn(e4, t2) {
  return (e4[t2.line - 1] ?? e4[e4.length - 1]) + t2.column;
}
function bn(e4, t2) {
  let n2 = xn(t2);
  for (let t3 of e4) n2(t3);
}
function xn(e4) {
  let n2 = [0];
  for (let t2 = 0; t2 < e4.length; t2++) e4.charCodeAt(t2) === 10 && n2.push(t2 + 1);
  return (i2) => {
    let o2 = [i2];
    for (; o2.length > 0; ) {
      let i3 = o2.pop(), s2 = [yn(n2, i3.loc.start), yn(n2, i3.loc.end)];
      if (Object.defineProperty(i3, "range", { configurable: true, enumerable: false, value: s2 }), hn.set(i3, e4), vn.set(i3, Cn(i3).slice()), a(i3)) o2.push(i3.value), o2.push(i3.key);
      else if (d(i3)) o2.push(i3.item);
      else if (t(i3) || r(i3)) {
        o2.push(i3.key);
        let e5 = i3.items;
        for (let t2 = e5.length - 1; t2 >= 0; t2--) o2.push(e5[t2]);
      } else if (m(i3)) {
        let e5 = i3.items;
        for (let t2 = e5.length - 1; t2 >= 0; t2--) o2.push(e5[t2]);
      }
    }
  };
}
function R(e4) {
  return hn.get(e4);
}
function Sn(e4) {
  let t2 = vn.get(e4);
  if (!t2) return false;
  let n2 = Cn(e4);
  return t2.length === n2.length && t2.every((e5, t3) => e5 === n2[t3]);
}
function Cn(e4) {
  return a(e4) ? [e4.key, e4.value] : d(e4) ? [e4.item] : t(e4) || r(e4) ? [e4.key, ...e4.items] : m(e4) ? e4.items : [];
}
function wn(e4) {
  if (_n.has(e4)) return;
  let t2 = [e4];
  for (; t2.length > 0; ) {
    let e5 = t2.pop();
    for (let n2 of Cn(e5)) gn.set(n2, e5), t2.push(n2);
  }
  _n.add(e4);
}
function Tn(e4) {
  let t2 = [e4];
  for (; t2.length > 0; ) {
    let e5 = t2.pop();
    Dn(e5);
    for (let n2 of Cn(e5)) t2.push(n2);
  }
}
function En(e4) {
  Tn(e4);
}
function Dn(e4) {
  Object.defineProperty(e4, "dirty", { configurable: true, enumerable: false, value: true, writable: true });
}
function On(e4, t2, n2) {
  wn(e4), n2 && (gn.set(n2, t2), Tn(n2));
  let r2 = t2;
  for (; r2; ) Dn(r2), r2 = gn.get(r2);
}
function kn(e4) {
  let t2 = vn.get(e4);
  return !!(t2 != null && t2[0]) && t2[0].loc.start.line > e4.loc.start.line;
}
var An = /* @__PURE__ */ new WeakMap();
var jn = /* @__PURE__ */ new WeakSet();
var Mn = /* @__PURE__ */ new WeakSet();
var Nn = /* @__PURE__ */ new WeakSet();
var Pn = /* @__PURE__ */ new WeakSet();
function Fn(e4, t2, n2, r2) {
  let i2 = e4 === `array` ? r2.multilineArray : r2.multilineTable;
  return typeof i2 == `boolean` ? i2 : typeof i2 == `number` ? t2 >= i2 : i2 === `parent` && n2;
}
function In(e4, t2) {
  An.set(e4, t2), t2 && e4.items.length === 0 && (e4.loc.end.line = e4.loc.start.line + 1, e4.loc.end.column = e4.loc.start.column + 1);
}
function Ln(e4) {
  return An.get(e4);
}
function Rn(e4) {
  jn.add(e4);
}
function zn(e4) {
  return jn.has(e4);
}
function Bn(e4) {
  Mn.add(e4);
}
function Vn(e4) {
  return Mn.has(e4);
}
function Hn(e4) {
  Nn.add(e4);
}
function Un(e4) {
  return Nn.has(e4);
}
function Wn(e4) {
  Pn.add(e4);
}
function Gn(e4) {
  return Pn.has(e4);
}
function Kn(e4) {
  return e4.items.length ? e4.items.some((t2, n2) => {
    let r2 = e4.items[n2 - 1];
    return t2.loc.start.line > ((r2 == null ? void 0 : r2.loc.end.line) ?? e4.loc.start.line);
  }) : e4.loc.end.line > e4.loc.start.line;
}
function qn(e4, t2) {
  let n2 = (e5, r2) => {
    if (e5 === t2) return r2;
    if (a(e5)) return n2(e5.value, r2);
    if (d(e5)) return n2(e5.item, r2);
    if (u(e5) || f(e5)) {
      for (let t3 of e5.items) {
        let e6 = n2(t3, r2 + 1);
        if (e6 !== void 0) return e6;
      }
      return;
    }
    if (m(e5)) for (let t3 of e5.items) {
      let e6 = n2(t3, r2);
      if (e6 !== void 0) return e6;
    }
  };
  return n2(e4, 0);
}
function Jn(e4, t2) {
  let n2 = (e5, r2) => {
    if (e5 === t2) return r2;
    if (a(e5)) return n2(e5.value, r2);
    if (d(e5)) return n2(e5.item, r2);
    if (u(e5) || f(e5)) {
      for (let t3 of e5.items) {
        let r3 = n2(t3, e5);
        if (r3) return r3;
      }
      return;
    }
    if (m(e5)) for (let t3 of e5.items) {
      let e6 = n2(t3, r2);
      if (e6) return e6;
    }
  };
  return n2(e4, void 0);
}
var Yn = /* @__PURE__ */ new WeakSet();
var Xn = /* @__PURE__ */ new WeakSet();
var Zn = /* @__PURE__ */ new WeakMap();
var Qn = /* @__PURE__ */ new WeakMap();
function $n(e4, t2) {
  Zn.set(e4, t2);
}
function er(e4, t2) {
  Qn.set(e4, t2);
}
function tr(e4) {
  Xn.add(e4);
}
var nr = /* @__PURE__ */ new WeakMap();
var rr = /* @__PURE__ */ new WeakSet();
var ir = /* @__PURE__ */ new WeakSet();
function ar(e4) {
  return ir.has(e4);
}
function or(e4) {
  ir.delete(e4);
}
function sr(e4, t2, n2) {
  wr(n2, z(e4), t2);
}
function cr(e4) {
  En(e4), Yn.add(e4);
}
var lr = /* @__PURE__ */ new WeakMap();
var ur = (e4) => (lr.has(e4) || lr.set(e4, /* @__PURE__ */ new WeakMap()), lr.get(e4));
function dr(e4) {
  return lr.has(e4) || lr.set(e4, /* @__PURE__ */ new WeakMap()), lr.get(e4);
}
var fr = /* @__PURE__ */ new WeakMap();
function z(e4) {
  return fr.has(e4) || fr.set(e4, /* @__PURE__ */ new WeakMap()), fr.get(e4);
}
function pr(e4, t2, n2, r2) {
  if (m(t2)) {
    let e5 = t2.items.indexOf(n2);
    if (e5 < 0) throw Error(`Item not found in parent for replace`);
    t2.items.splice(e5, 1, r2);
  } else if (a(t2) && f(t2.value) && !f(n2)) {
    let e5 = t2.value.items.indexOf(n2);
    if (e5 < 0) throw Error(`Item not found in parent for replace`);
    t2.value.items.splice(e5, 1, r2);
  } else if (h(t2)) t2.item = r2;
  else if (a(t2)) t2.key === n2 ? t2.key = r2 : t2.value = r2;
  else throw Error(`Unsupported parent type "${t2.type}" for replace`);
  U(r2, { lines: n2.loc.start.line - r2.loc.start.line, columns: n2.loc.start.column - r2.loc.start.column });
  let i2 = x(n2.loc), o2 = x(r2.loc);
  wr({ lines: o2.lines - i2.lines, columns: o2.columns - i2.columns }, z(e4), r2, n2), Xn.has(e4) || On(e4, t2, r2), Yn.add(e4);
}
function B(t2, n2, r2, i2, a2, o2, s2, c2 = false) {
  if (!m(n2)) throw Error(`Unsupported parent type "${n2.type}" for insert`);
  i2 = i2 != null && typeof i2 == `number` ? i2 : n2.items.length;
  let l2, d2;
  u(n2) || f(n2) ? { shift: l2, offset: d2 } = vr(n2, r2, i2, Zn.get(t2) ?? 2) : a2 && e(n2) ? { shift: l2, offset: d2 } = yr(n2, r2, i2) : { shift: l2, offset: d2 } = hr(t2, n2, r2, i2, s2), U(r2, l2, { first_line_only: c2 });
  let h2 = n2.items[i2 - 1], g2 = h2 && z(t2).get(h2);
  if (g2 && (d2.lines += g2.lines, d2.columns += g2.columns, z(t2).delete(h2)), (f(n2) || u(n2)) && d2.lines !== 0 && (o2 || m(t2)) && t2 !== n2) {
    let e4 = r2.loc.start.line, i3 = o2 ?? t2.items, a3 = mr(n2, i3);
    for (let t3 = 0; t3 < i3.length; t3++) {
      let n3 = i3[t3];
      if (!p(n3)) continue;
      let r3 = n3.loc.start.line;
      r3 < a3.loc.start.line || r3 > a3.loc.end.line || r3 < e4 && (n3.loc.start.line -= d2.lines, n3.loc.end.line -= d2.lines);
    }
  }
  z(t2).set(r2, d2), Xn.has(t2) || On(t2, n2, r2), Yn.add(t2);
}
function mr(e4, t2) {
  for (let n2 of t2) {
    if (!a(n2)) continue;
    let t3 = n2.value;
    if (!u(t3) && !f(t3)) continue;
    let r2 = false, i2 = (t4) => {
      t4 === e4 && (r2 = true);
    };
    if (Gt(t3, { InlineArray: i2, InlineTable: i2 }), r2) return t3;
  }
  return e4;
}
function hr(n2, i2, a2, o2, s2) {
  if (!g(a2)) throw Error(`Incompatible child type "${a2.type}"`);
  let c2 = i2.items[o2 - 1], l2 = e(i2) && !i2.items.length, u2 = e(i2) && !l2 && c2 === void 0;
  i2.items.splice(o2, 0, a2);
  let d2;
  if (c2 !== void 0) {
    if (Xn.has(n2)) d2 = c2;
    else {
      let e4 = false;
      for (let t2 = 0; t2 < o2; t2++) if (p(i2.items[t2])) {
        e4 = true;
        break;
      }
      if (!e4) d2 = c2;
      else {
        let e5 = -1, t2 = -1;
        for (let n3 = 0; n3 < o2; n3++) {
          let r2 = i2.items[n3], a3 = r2.loc.end;
          (a3.line > e5 || a3.line === e5 && a3.column > t2) && (e5 = a3.line, t2 = a3.column, d2 = r2);
        }
      }
    }
  }
  let f2 = d2 ? { line: d2.loc.end.line, column: p(d2) ? i2.loc.start.column : d2.loc.start.column } : T(i2.loc.start), m2 = t(a2) || r(a2), h2 = 0;
  s2 === void 0 ? l2 || u2 || (h2 = m2 ? 2 : 1) : h2 = s2, f2.line += h2;
  let _2 = { lines: f2.line - a2.loc.start.line, columns: f2.column - a2.loc.start.column }, v2 = x(a2.loc), y2 = !Xn.has(n2) && c2 === void 0 && (t(i2) || r(i2) || e(i2)) && nr.has(i2), b2 = y2 && !rr.has(i2);
  y2 && (nr.delete(i2), rr.delete(i2));
  let S2 = y2 && !b2, C2 = 0;
  if (S2) {
    let e4 = t(i2) || r(i2) ? z(n2).get(i2.key) : ur(n2).get(i2);
    C2 = e4 ? -e4.lines : 1;
  }
  let w2 = b2 || S2 ? h2 - 2 : h2 - 1, E2 = { lines: u2 ? v2.lines + 1 : v2.lines + w2, columns: v2.columns };
  return { shift: { lines: _2.lines + C2, columns: _2.columns }, offset: E2 };
}
function gr(e4, t2, n2, r2 = {}) {
  let { useNewLine: i2 = false, skipCommaSpace: a2 = 2, skipBracketSpace: o2 = 1, hasCommaHandling: s2 = false, isLastElement: c2 = false, hasSeparatingCommaBefore: l2 = false, hasSeparatingCommaAfter: d2 = false, hasTrailingComma: m2 = false, indentWidth: h2 = 2 } = r2, g2 = n2 > 0 ? e4.items[n2 - 1] : void 0, _2 = g2 ? { line: g2.loc.end.line, column: i2 ? p(g2) ? e4.loc.start.column : g2.loc.start.column : g2.loc.end.column } : T(e4.loc.start);
  if (!g2 && i2) {
    let t3 = e4.items.find((e5, t4) => t4 > n2 && !p(e5));
    t3 ? _2.column = t3.loc.start.column : e4.loc.end.line > e4.loc.start.line && (_2.column = (u(e4) || f(e4) ? Qn.get(e4) : void 0) ?? e4.loc.end.column - 1 + h2);
  }
  let v2 = 0;
  if (i2) v2 = 1;
  else {
    let e5 = l2 || !s2 && !!g2;
    e5 && s2 ? _2.column += a2 : (e5 || s2 && !g2) && (_2.column += o2);
  }
  _2.line += v2;
  let y2 = { lines: _2.line - t2.loc.start.line, columns: _2.column - t2.loc.start.column }, b2 = x(t2.loc);
  if (!s2) return { shift: y2, offset: { lines: b2.lines + (v2 - 1), columns: b2.columns } };
  let S2 = l2 && m2 && !d2 && c2, C2 = 0;
  S2 && (C2 = -1);
  let w2 = b2.columns + (l2 || d2 ? a2 : 0) + (m2 ? 1 + C2 : 0);
  return i2 && c2 && g2 && e4.loc.end.line === g2.loc.end.line && (w2 = b2.columns - (g2.loc.end.column - g2.loc.start.column)), { shift: y2, offset: { lines: b2.lines + (v2 - 1), columns: w2 } };
}
function _r(e4) {
  return pe(e4) ?? 2;
}
function vr(e4, t2, n2, r2) {
  if (!d(t2)) throw Error(`Incompatible child type "${t2.type}"`);
  let i2 = _r(e4), a2 = n2 == null ? N(e4.items) : e4.items[n2 - 1], o2 = n2 == null || n2 === e4.items.length, s2 = n2 == null ? void 0 : e4.items[n2];
  e4.items.splice(n2, 0, t2);
  let c2 = !!a2, l2 = !o2;
  return c2 && (a2.comma = true), l2 && (t2.comma = true), gr(e4, t2, n2, { useNewLine: Cr(e4, t2) && !(a2 && s2 && s2.loc.start.line === a2.loc.end.line && s2.loc.start.column >= a2.loc.end.column) && !(Ln(e4) !== true && f(e4) && !s2 && a2 && a2.loc.end.line === e4.loc.end.line), skipCommaSpace: i2, hasCommaHandling: true, isLastElement: o2, hasSeparatingCommaBefore: c2, hasSeparatingCommaAfter: l2, hasTrailingComma: o2 && t2.comma === true, indentWidth: r2 });
}
function yr(e4, t2, n2) {
  let r2 = gr(e4, t2, n2, { useNewLine: false, hasCommaHandling: false });
  return e4.items.splice(n2, 0, t2), r2;
}
function V(n2, i2, a2, o2) {
  if (!m(i2)) throw Error(`Unsupported parent type "${i2.type}" for remove`);
  Xn.has(n2) || On(n2, i2);
  let s2 = i2.items.indexOf(a2);
  if (s2 < 0) {
    if (s2 = i2.items.findIndex((e4) => h(e4) && e4.item === a2), s2 < 0) throw Error(`Node not found in parent for removal`);
    a2 = i2.items[s2];
  }
  let c2 = i2.items[s2 - 1], l2 = i2.items[s2 + 1];
  i2.items.splice(s2, 1);
  let g2 = x(a2.loc);
  l2 && p(l2) && l2.loc.start.line === a2.loc.end.line && (g2 = x({ start: a2.loc.start, end: l2.loc.end }), l2 = i2.items[s2 + 1], i2.items.splice(s2, 1));
  let _2 = c2 && d(c2) || l2 && d(l2), v2 = c2 ? z(n2).get(c2) : void 0, y2 = c2 && c2.loc.end.line === a2.loc.start.line + ((v2 == null ? void 0 : v2.lines) ?? 0), b2 = l2 && l2.loc.start.line === a2.loc.end.line, S2 = _2 && (y2 || b2), C2 = { lines: -(g2.lines - +!!S2), columns: S2 ? -g2.columns : 0 };
  if ((e(i2) || t(i2) || r(i2)) && l2 && !S2 && l2.loc.start.line > a2.loc.end.line) {
    let e4 = t(a2) || r(a2), o3 = t(l2) || r(l2), u2 = -1;
    for (let e5 = 0; e5 < s2; e5++) {
      let t2 = i2.items[e5].loc.end.line;
      t2 > u2 && (u2 = t2);
    }
    let d2 = c2 ? z(n2).get(c2) : void 0, f2 = z(n2).get(a2), p2 = c2 ? e4 ? a2.loc.start.line + ((d2 == null ? void 0 : d2.lines) ?? 0) - u2 - 1 : 0 : o3 ? l2.loc.start.line + ((f2 == null ? void 0 : f2.lines) ?? 0) - a2.loc.end.line - 1 : 0;
    p2 > 0 && (C2.lines -= p2);
  }
  let w2 = (f(i2) || u(i2)) && i2.loc.end.line > i2.loc.start.line, T2 = w2 && a2.loc.start.line === i2.loc.start.line;
  w2 && !T2 && c2 === void 0 && l2 === void 0 && a2.loc.start.line > i2.loc.start.line && i2.loc.end.line > a2.loc.end.line && Wn(i2), c2 === void 0 && l2 === void 0 && (!w2 || T2) && (C2.lines = 0, C2.columns = 0, (f(i2) || u(i2)) && ir.add(i2), (t(i2) || r(i2) || e(i2)) && nr.set(i2, true)), (c2 !== void 0 || l2 !== void 0) && (t(i2) || r(i2) || e(i2)) && rr.add(i2);
  let E2 = u(i2) || f(i2) ? _r(i2) : 2;
  if (_2 && y2 && (C2.columns -= E2), _2 && !c2 && l2 && (Cr(i2) || (C2.columns -= E2)), _2 && c2 && !l2 && (c2.comma = !!a2.comma, y2)) {
    var D2;
    let e4 = c2 ? ((D2 = z(n2).get(c2)) == null ? void 0 : D2.columns) ?? 0 : 0;
    C2.columns = c2.loc.end.column - a2.loc.end.column - e4;
  }
  let O2, k2;
  c2 ? (O2 = c2, k2 = z(n2)) : (t(i2) || r(i2)) && `key` in i2 ? (O2 = i2.key, k2 = z(n2)) : (O2 = i2, k2 = ur(n2));
  let A2 = z(n2), j2 = k2.get(O2);
  j2 && (C2.lines += j2.lines, C2.columns += j2.columns);
  let ee2 = A2.get(a2);
  if (ee2 && (C2.lines += ee2.lines, S2 && (C2.columns += ee2.columns)), k2.set(O2, C2), Yn.add(n2), w2 && (o2 || m(n2)) && n2 !== i2) {
    let e4 = a2.loc.start.line, t2 = o2 ?? n2.items, r2 = mr(i2, t2), s3 = [];
    for (let n3 = 0; n3 < t2.length; n3++) {
      let a3 = t2[n3];
      if (!p(a3)) continue;
      let o3 = a3.loc.start.line;
      o3 < r2.loc.start.line || o3 > r2.loc.end.line || (o3 === e4 && (o3 < i2.loc.end.line || a3.loc.start.column < i2.loc.end.column) ? s3.push(n3) : C2.lines !== 0 && o3 < e4 && (a3.loc.start.line -= C2.lines, a3.loc.end.line -= C2.lines));
    }
    for (let e5 = s3.length - 1; e5 >= 0; e5--) t2.splice(s3[e5], 1);
  }
}
function br(e4) {
  let t2 = e4.loc.start.line, n2 = e4.loc.start.column;
  if (`key` in e4) {
    let r2 = e4.key.loc.end;
    (r2.line > t2 || r2.line === t2 && r2.column > n2) && (t2 = r2.line, n2 = r2.column);
  }
  for (let r2 = 0; r2 < e4.items.length; r2++) {
    let i2 = e4.items[r2].loc.end;
    (i2.line > t2 || i2.line === t2 && i2.column > n2) && (t2 = i2.line, n2 = i2.column);
  }
  e4.loc.end = { line: t2, column: n2 };
}
function xr(e4, t2, n2 = true) {
  if (!n2 || !t2.items.length) return;
  wr({ lines: 0, columns: 1 }, ur(e4), t2);
  let r2 = N(t2.items);
  wr({ lines: 0, columns: 1 }, z(e4), r2), Yn.add(e4);
}
function Sr(e4, t2, n2 = false) {
  if (!n2 || !t2.items.length) return;
  let r2 = N(t2.items);
  r2.comma = true, wr({ lines: 0, columns: 1 }, z(e4), r2), Yn.add(e4);
}
function H(e4) {
  if (!Yn.has(e4)) return;
  let t2 = ur(e4), n2 = z(e4), r2 = 0, i2 = {};
  function a2(e5) {
    switch (e5.type) {
      case `Document`: {
        let t3 = e5;
        o2(t3);
        for (let e6 = 0; e6 < t3.items.length; e6++) a2(t3.items[e6]);
        s2(t3), br(t3);
        break;
      }
      case `Table`: {
        let t3 = e5;
        o2(t3), a2(t3.key);
        for (let e6 = 0; e6 < t3.items.length; e6++) a2(t3.items[e6]);
        s2(t3), br(t3);
        break;
      }
      case `TableArray`: {
        let t3 = e5;
        o2(t3), a2(t3.key);
        for (let e6 = 0; e6 < t3.items.length; e6++) a2(t3.items[e6]);
        s2(t3), br(t3);
        break;
      }
      case `TableKey`: {
        let t3 = e5;
        o2(t3), a2(t3.item), s2(t3);
        break;
      }
      case `TableArrayKey`: {
        let t3 = e5;
        o2(t3), a2(t3.item), s2(t3);
        break;
      }
      case `KeyValue`: {
        let t3 = e5, c3 = t3.loc.start.line + r2, l3 = n2.get(t3.key);
        t3.equals += (i2[c3] || 0) + (l3 ? l3.columns : 0), o2(t3), a2(t3.key), a2(t3.value), s2(t3);
        break;
      }
      case `InlineArray`: {
        let r3 = e5;
        if (!t2.get(r3) && !n2.get(r3)) {
          c2(r3);
          for (let e6 = 0; e6 < r3.items.length; e6++) a2(r3.items[e6]);
          l2(r3);
          break;
        }
        o2(r3);
        for (let e6 = 0; e6 < r3.items.length; e6++) a2(r3.items[e6]);
        s2(r3);
        break;
      }
      case `InlineTable`: {
        let r3 = e5;
        if (!t2.get(r3) && !n2.get(r3)) {
          c2(r3);
          for (let e6 = 0; e6 < r3.items.length; e6++) a2(r3.items[e6]);
          l2(r3);
          break;
        }
        o2(r3);
        for (let e6 = 0; e6 < r3.items.length; e6++) a2(r3.items[e6]);
        s2(r3);
        break;
      }
      case `InlineItem`: {
        let t3 = e5;
        o2(t3), a2(t3.item), s2(t3);
        break;
      }
      case `Key`:
      case `String`:
      case `Integer`:
      case `Float`:
      case `Boolean`:
      case `DateTime`:
      case `Comment`:
        o2(e5), s2(e5);
        break;
      default:
        throw Error(`Unrecognized node type "${e5.type}"`);
    }
  }
  function o2(e5) {
    e5.loc.start.line += r2;
    let n3 = i2[e5.loc.start.line] || 0;
    e5.loc.start.column += n3;
    let a3 = t2.get(e5);
    a3 && (r2 += a3.lines, i2[e5.loc.start.line] = (i2[e5.loc.start.line] || 0) + a3.columns);
  }
  function s2(e5) {
    e5.loc.end.line += r2;
    let t3 = i2[e5.loc.end.line] || 0;
    e5.loc.end.column += t3;
    let a3 = n2.get(e5);
    a3 && (r2 += a3.lines, i2[e5.loc.end.line] = (i2[e5.loc.end.line] || 0) + a3.columns);
  }
  function c2(e5) {
    e5.loc.start.line += r2, e5.loc.start.column += i2[e5.loc.start.line] || 0;
  }
  function l2(e5) {
    e5.loc.end.line += r2, e5.loc.end.column += i2[e5.loc.end.line] || 0;
  }
  a2(e4), Yn.delete(e4), lr.delete(e4), fr.delete(e4);
}
function U(e4, t2, n2 = {}) {
  let { lines: r2, columns: i2 } = t2;
  if (r2 === 0 && i2 === 0) return e4;
  let { first_line_only: o2 = false, shift_generated_multiline_end: s2 = false } = n2, c2 = e4.loc.start.line, l2 = e4.type;
  if (l2 === `Key` || l2 === `String` || l2 === `Integer` || l2 === `Float` || l2 === `Boolean` || l2 === `DateTime` || l2 === `Comment`) return (!o2 || e4.loc.start.line === c2) && (e4.loc.start.column += i2, e4.loc.end.line === e4.loc.start.line && (e4.loc.end.column += i2)), e4.loc.start.line += r2, e4.loc.end.line += r2, e4;
  if (l2 === `KeyValue`) {
    let t3 = e4, n3 = t3.value.type;
    if (n3 === `String` || n3 === `Integer` || n3 === `Float` || n3 === `Boolean` || n3 === `DateTime`) {
      let n4 = !o2 || t3.loc.start.line === c2;
      n4 && (t3.loc.start.column += i2, t3.loc.end.line === t3.loc.start.line && (t3.loc.end.column += i2)), t3.loc.start.line += r2, t3.loc.end.line += r2, n4 && (t3.equals += i2);
      let a2 = t3.key;
      (!o2 || a2.loc.start.line === c2) && (a2.loc.start.column += i2, a2.loc.end.column += i2), a2.loc.start.line += r2, a2.loc.end.line += r2;
      let s3 = t3.value;
      return (!o2 || s3.loc.start.line === c2) && (s3.loc.start.column += i2, s3.loc.end.line === s3.loc.start.line && (s3.loc.end.column += i2)), s3.loc.start.line += r2, s3.loc.end.line += r2, e4;
    }
  }
  let p2 = (e5) => {
    if (!o2 || e5.loc.start.line === c2) {
      e5.loc.start.column += i2;
      let t3 = (!o2 || s2) && e5.loc.end.line !== e5.loc.start.line && ((u(e5) || f(e5)) && Ln(e5) !== void 0 && !zn(e5) || d(e5) && ((u(e5.item) || f(e5.item)) && Ln(e5.item) !== void 0 && !zn(e5.item) || a(e5.item) && (u(e5.item.value) || f(e5.item.value)) && Ln(e5.item.value) !== void 0 && !zn(e5.item.value)) || a(e5) && (u(e5.value) || f(e5.value)) && Ln(e5.value) !== void 0);
      (e5.loc.end.line === e5.loc.start.line || t3) && (e5.loc.end.column += i2);
    }
    e5.loc.start.line += r2, e5.loc.end.line += r2;
  };
  return Gt(e4, { Table: p2, TableKey: p2, TableArray: p2, TableArrayKey: p2, KeyValue(e5) {
    let t3 = !o2 || e5.loc.start.line === c2;
    p2(e5), t3 && (e5.equals += i2);
  }, Key: p2, String: p2, Integer: p2, Float: p2, Boolean: p2, DateTime: p2, InlineArray: p2, InlineItem: p2, InlineTable: p2, Comment: p2 }), e4;
}
function Cr(e4, t2) {
  let n2 = Ln(e4);
  if (n2 === true) return true;
  if (n2 !== void 0 || !e4.items.length) return false;
  let r2 = t2 ? e4.items.filter((e5) => e5 !== t2) : e4.items;
  return r2.length ? e4.loc.end.line > e4.loc.start.line && r2.every((e5, t3) => t3 === 0 || e5.loc.start.line > r2[t3 - 1].loc.start.line) : e4.loc.end.line > e4.loc.start.line;
}
function wr(e4, t2, n2, r2) {
  let i2 = t2.get(r2 || n2);
  i2 && (e4.lines += i2.lines, e4.columns += i2.columns), t2.set(n2, e4);
}
function Tr(e4) {
  let t2 = e4.match(/\r\n|\n/);
  return (t2 == null ? void 0 : t2[0]) === `\r
` ? `\r
` : `
`;
}
function Er(e4, t2) {
  var n2;
  let r2 = Tr(e4);
  e4 = e4.replace(/\r\n/g, `
`).replace(/\n/g, r2);
  let i2, a2;
  e4.startsWith(`"""\\${r2}`) ? (i2 = 4 + r2.length, a2 = `"""\\${r2}`) : e4.startsWith(`"""${r2}`) ? (i2 = 3 + r2.length, a2 = `"""${r2}`) : (i2 = 3, a2 = `"""`);
  let o2 = e4.length - 3, s2 = e4.slice(i2, o2).split(r2), c2 = s2[s2.length - 1], l2 = s2.length > 1 && /^[\t ]*$/.test(c2), u2 = l2 ? c2 : ``, d2 = (l2 ? s2.slice(0, -1) : s2).map((e5) => {
    var t3;
    if (/^[\t ]*$/.test(e5)) return { indent: e5, content: ``, trailingWs: ``, hasBackslash: false, isBlank: true };
    let n3 = e5, r3 = 0;
    for (let e6 = n3.length - 1; e6 >= 0 && n3[e6] === `\\`; e6--) r3++;
    let i3 = r3 % 2 == 1;
    i3 && (n3 = n3.slice(0, -1));
    let a3 = ((t3 = n3.match(/^[\t ]*/)) == null ? void 0 : t3[0]) ?? ``, o3 = n3.slice(a3.length), s3 = o3.match(/([\t ]+)$/), c3 = s3 ? s3[1] : ``;
    return { indent: a3, content: o3.slice(0, o3.length - c3.length), trailingWs: c3, hasBackslash: i3, isBlank: false };
  }), f2 = d2.filter((e5) => !e5.isBlank), p2 = Math.max(...f2.map((e5) => e5.content.length + e5.trailingWs.length), 1), m2 = f2.filter((e5) => e5.hasBackslash), h2 = m2[m2.length - 1] ?? f2[f2.length - 1] ?? { indent: ``, trailingWs: ``, hasBackslash: false, content: ``, isBlank: false }, g2 = f2[f2.length - 1] ?? h2, _2 = [];
  {
    let e5 = [], t3 = 0;
    for (let n3 of d2) n3.isBlank ? e5.push(n3.indent) : (t3 > 0 && _2.push(e5), e5 = [], t3++);
  }
  let v2 = f2.some((e5, t3) => !e5.hasBackslash && t3 < f2.length - 1), y2 = a2 === `"""${r2}`, b2 = y2 && f2.length > 0 ? ((n2 = t2.match(/^[\t ]*/)) == null ? void 0 : n2[0]) ?? `` : ``, x2 = (e5) => {
    let t3 = e5.match(/\S+| +/g) ?? [], n3 = [], r3 = 0;
    for (; r3 < t3.length; ) {
      let e6 = t3[r3++];
      for (; r3 < t3.length && t3[r3][0] === ` `; ) {
        let n4 = t3[r3], i3 = t3[r3 + 1];
        if (!i3) {
          r3++;
          break;
        }
        if (e6.length + n4.length + i3.length <= p2) e6 += n4 + i3, r3 += 2;
        else {
          e6 += n4, r3++;
          break;
        }
      }
      n3.push(e6);
    }
    return n3.length === 0 && n3.push(``), n3;
  }, S2 = [], C2 = [], w2 = /* @__PURE__ */ new Set(), T2 = /* @__PURE__ */ new Set(), E2 = /* @__PURE__ */ new Map(), D2 = false;
  if (v2 && t2.includes(r2) && (r2 === `\r
` || !t2.includes(`\r
`))) {
    D2 = true;
    let e5 = t2.split(r2), n3 = e5[0].slice(b2.length);
    if (n3.length > 0 && n3[0] === ` `) return null;
    let i3 = e5[e5.length - 1];
    if (i3.length > 0 && i3.length - i3.trimEnd().length !== g2.trailingWs.length) return null;
    for (let t3 = 0; t3 < e5.length; t3++) {
      var O2;
      let n4 = e5[t3], r3 = t3 === 0 ? n4.slice(b2.length) : n4, i4 = ((O2 = r3.match(/^[\t ]*/)) == null ? void 0 : O2[0]) ?? ``, a3 = x2(r3.slice(i4.length)), o3 = S2.length;
      T2.add(o3), t3 > 0 && E2.set(o3, i4);
      for (let e6 of a3) S2.push(e6);
      t3 < e5.length - 1 && w2.add(o3 + a3.length - 1);
    }
  } else {
    let e5 = t2.replace(/\r\n/g, `\\r\\n`).replace(/\n/g, `\\n`).slice(b2.length);
    if (e5.length > 0 && (e5[0] === ` ` || e5.length - e5.trimEnd().length !== g2.trailingWs.length)) return null;
    if (!v2) {
      let t3 = 0, n4 = 0;
      for (let r3 = 0; r3 < f2.length - 1; r3++) {
        let i4 = f2[r3];
        if (!i4.hasBackslash) break;
        let a3 = i4.content + i4.trailingWs;
        if (e5.slice(n4, n4 + a3.length) === a3) t3++, n4 += a3.length;
        else break;
      }
      let i3 = 0, o3 = 0;
      for (let r3 = f2.length - 1; r3 >= t3; r3--) {
        let t4 = f2[r3], a3 = t4.content + t4.trailingWs;
        if (a3.length === 0) break;
        let s4 = e5.length - o3 - a3.length;
        if (s4 >= n4 && e5.slice(s4, s4 + a3.length) === a3) i3++, o3 += a3.length;
        else break;
      }
      if (i3 > 0) {
        let s4 = e5.slice(n4, e5.length - o3);
        if (s4.length === 0 || s4[0] !== ` `) {
          for (let e7 = 0; e7 < t3; e7++) {
            let n5 = f2[e7];
            if (C2.push(`${n5.indent}${n5.content}${n5.trailingWs}\\`), e7 < t3 - 1 && e7 < _2.length && _2[e7].length > 0) for (let t4 of _2[e7]) C2.push(t4);
          }
          if (s4.length > 0) {
            let e7 = x2(s4), n5 = e7.join(``), r3 = /(?<!\\)\\n/.test(n5);
            if (t3 > 0 && !r3) {
              let e8 = t3 - 1;
              if (e8 < _2.length && _2[e8].length > 0) for (let t4 of _2[e8]) C2.push(t4);
            }
            for (let n6 = 0; n6 < e7.length; n6++) {
              let i4 = e7[n6], a4 = t3 + n6, o4 = a4 < f2.length ? f2[a4] : null, c3 = o4 ? y2 && a4 === 0 ? b2 : o4.indent : h2.indent, l3 = i4.length > 0 && /\s$/.test(i4) ? `` : s4.endsWith(` `) ? ` ` : ``;
              if (C2.push(`${c3}${i4}${l3}\\`), n6 < e7.length - 1 && !r3) {
                let e8 = t3 + n6;
                if (e8 < _2.length && _2[e8].length > 0) for (let t4 of _2[e8]) C2.push(t4);
              }
            }
            let a3 = f2.length - i3 - 1;
            if (!r3 && a3 >= 0 && a3 < _2.length && _2[a3].length > 0) for (let e8 of _2[a3]) C2.push(e8);
          } else if (t3 > 0) {
            let e7 = t3 - 1;
            if (e7 < _2.length && _2[e7].length > 0) for (let t4 of _2[e7]) C2.push(t4);
          }
          let e6 = f2.length - i3;
          for (let t4 = e6; t4 < f2.length; t4++) {
            let n5 = f2[t4], r3 = t4 === f2.length - 1;
            if (t4 > e6) {
              let e7 = t4 - 1;
              if (e7 < _2.length && _2[e7].length > 0) for (let t5 of _2[e7]) C2.push(t5);
            }
            C2.push(r3 ? `${n5.indent}${n5.content}${n5.trailingWs}${n5.hasBackslash && n5.content !== `` ? `\\` : ``}` : `${n5.indent}${n5.content}${n5.trailingWs}\\`);
          }
          return l2 && !(g2.hasBackslash && g2.content === ``) ? `${a2}${C2.join(r2)}${r2}${u2}"""` : `${a2}${C2.join(r2)}"""`;
        }
      }
      let s3 = e5.slice(n4);
      if (t3 > 0 && (n4 === e5.length || s3.length > 0 && s3[0] !== ` `)) {
        for (let e6 = 0; e6 < t3; e6++) {
          let n5 = f2[e6];
          if (C2.push(`${n5.indent}${n5.content}${n5.trailingWs}\\`), e6 < t3 - 1 && e6 < _2.length && _2[e6].length > 0) for (let t4 of _2[e6]) C2.push(t4);
        }
        if (n4 === e5.length) {
          let e6 = f2[t3 - 1], n5 = g2.hasBackslash && e6.content !== `` ? `\\` : ``;
          C2[C2.length - 1] = `${e6.indent}${e6.content}${g2.trailingWs}${n5}`;
        } else {
          let e6 = x2(s3), n5 = e6.join(``), r3 = /(?<!\\)\\n/.test(n5), i4 = t3 - 1;
          if (!r3 && i4 < _2.length && _2[i4].length > 0) for (let e7 of _2[i4]) C2.push(e7);
          for (let n6 = 0; n6 < e6.length; n6++) {
            let i5 = n6 === e6.length - 1, a3 = e6[n6], o4 = t3 + n6, s4 = o4 < f2.length ? f2[o4] : null, c3 = s4 ? y2 && o4 === 0 ? b2 : s4.indent : i5 ? g2.indent : h2.indent, l3, u3;
            if (i5 ? (l3 = g2.trailingWs, u3 = g2.hasBackslash && g2.content !== `` ? `\\` : ``) : (l3 = a3.length > 0 && /\s$/.test(a3) ? `` : ` `, u3 = `\\`), C2.push(`${c3}${a3}${l3}${u3}`), !i5) {
              let e7 = t3 + n6;
              if (!r3 && e7 < _2.length && _2[e7].length > 0) for (let t4 of _2[e7]) C2.push(t4);
            }
          }
        }
        return l2 && !(g2.hasBackslash && g2.content === ``) ? `${a2}${C2.join(r2)}${r2}${u2}"""` : `${a2}${C2.join(r2)}"""`;
      }
    }
    let n3 = x2(e5);
    for (let e6 of n3) S2.push(e6);
  }
  for (let e5 = 0; e5 < S2.length; e5++) {
    let t3 = e5 === S2.length - 1, n3 = w2.has(e5), r3 = t3 || n3, i3 = e5 < f2.length ? f2[e5] : null, a3 = D2 && T2.has(e5) && e5 > 0 ? E2.get(e5) ?? `` : i3 ? y2 && e5 === 0 ? b2 : i3.indent : r3 ? g2.indent : h2.indent, o3 = S2[e5], s3, c3;
    if (r3 && t3 ? (s3 = g2.trailingWs, c3 = g2.hasBackslash && g2.content !== `` ? `\\` : ``) : r3 ? (s3 = g2.trailingWs, c3 = ``) : (s3 = o3.length > 0 && /\s$/.test(o3) ? `` : ` `, c3 = `\\`), C2.push(`${a3}${o3}${s3}${c3}`), !t3 && !n3 && !D2) {
      let t4 = S2.join(``);
      if (!/(?<!\\)\\n/.test(t4) && e5 < _2.length && _2[e5].length > 0) for (let t5 of _2[e5]) C2.push(t5);
    }
  }
  return l2 && !(g2.hasBackslash && g2.content === ``) ? `${a2}${C2.join(r2)}${r2}${u2}"""` : `${a2}${C2.join(r2)}"""`;
}
function Dr(e4) {
  if (e4.includes(`'`)) return false;
  for (let t2 = 0; t2 < e4.length; t2++) {
    let n2 = e4.charCodeAt(t2);
    if (n2 < 32 && n2 !== 9 || n2 === 127) return false;
  }
  return true;
}
function Or(e4) {
  if (e4.includes(`'''`)) return false;
  for (let t2 = 0; t2 < e4.length; t2++) {
    let n2 = e4.charCodeAt(t2);
    if (n2 === 13) {
      if (e4.charCodeAt(t2 + 1) !== 10) return false;
    } else if (n2 < 32 && n2 !== 9 && n2 !== 10 || n2 === 127) return false;
  }
  return true;
}
function kr(e4) {
  switch (e4) {
    case `b`:
      return `\b`;
    case `t`:
      return `	`;
    case `n`:
      return `
`;
    case `f`:
      return `\f`;
    case `r`:
      return `\r`;
    case `"`:
      return `"`;
    case `\\`:
      return `\\`;
    default:
      return null;
  }
}
function Ar(e4, t2) {
  return t2 === `singleline-basic` ? e4 <= 31 || e4 === 127 : e4 >= 0 && e4 <= 7 || e4 === 11 || e4 >= 14 && e4 <= 31 || e4 === 127;
}
function jr(e4, t2, n2) {
  switch (e4) {
    case `\\`:
      return `\\\\`;
    case `\b`:
      return `\\b`;
    case `	`:
      return `\\t`;
    case `\f`:
      return `\\f`;
    case `"`:
      return t2 === `singleline-basic` ? `\\"` : `"`;
    case `
`:
      return t2 === `singleline-basic` ? `\\n` : `
`;
    case `\r`:
      return t2 === `singleline-basic` ? `\\r` : `\r`;
    default: {
      let r2 = e4.charCodeAt(0);
      if (Ar(r2, t2)) {
        let e5 = r2.toString(16).padStart(4, `0`);
        return `\\u${n2 ? e5.toUpperCase() : e5}`;
      }
      return e4;
    }
  }
}
function Mr(e4) {
  return e4.replace(/(\\+)u([0-9a-f]{4})/g, (e5, t2, n2) => t2.length % 2 == 1 ? `${t2}u${n2.toUpperCase()}` : e5);
}
function Nr(e4) {
  let t2 = /* @__PURE__ */ new Map();
  for (let n2 = 0; n2 < e4.length; n2++) {
    if (e4[n2] !== `\\`) continue;
    let r2 = e4[n2 + 1];
    if (!r2) continue;
    let i2 = kr(r2);
    if (i2 !== null) {
      i2 !== `
` && i2 !== `\r` && !t2.has(i2) && t2.set(i2, `\\` + r2), n2 += 1;
      continue;
    }
    if (r2 === `x` && /^[0-9A-Fa-f]{2}$/.test(e4.slice(n2 + 2, n2 + 4))) {
      let r3 = e4.slice(n2, n2 + 4), i3 = Number.parseInt(e4.slice(n2 + 2, n2 + 4), 16), a2 = String.fromCharCode(i3);
      t2.has(a2) || t2.set(a2, r3), n2 += 3;
      continue;
    }
    if (r2 === `u` && /^[0-9A-Fa-f]{4}$/.test(e4.slice(n2 + 2, n2 + 6))) {
      let r3 = e4.slice(n2, n2 + 6), i3 = Number.parseInt(e4.slice(n2 + 2, n2 + 6), 16), a2 = String.fromCodePoint(i3);
      t2.has(a2) || t2.set(a2, r3), n2 += 5;
      continue;
    }
    if (r2 === `U` && /^[0-9A-Fa-f]{8}$/.test(e4.slice(n2 + 2, n2 + 10))) {
      let r3 = e4.slice(n2, n2 + 10), i3 = Number.parseInt(e4.slice(n2 + 2, n2 + 10), 16), a2 = String.fromCodePoint(i3);
      t2.has(a2) || t2.set(a2, r3), n2 += 9;
      continue;
    }
  }
  return t2;
}
function Pr(e4, t2, n2, r2) {
  let i2 = ``;
  for (let a2 of e4) {
    let e5 = t2.get(a2);
    if (e5) {
      i2 += e5;
      continue;
    }
    i2 += jr(a2, n2, r2);
  }
  return i2;
}
function Fr(e4, t2, n2, r2 = true) {
  let i2 = Nr(t2);
  if (i2.size === 0 && n2 === `singleline-basic`) {
    let t3 = JSON.stringify(e4).slice(1, -1).replace(/\x7f/g, `\\u007f`);
    return r2 ? Mr(t3) : t3;
  }
  let a2 = Pr(e4, i2, n2, r2);
  return n2 === `multiline-basic` ? a2.replace(/\r(?!\n)/g, `\\r`).replace(/"""/g, `""\\"`) : a2;
}
function Ir() {
  return { type: `Document`, loc: { start: D(), end: D() }, items: [] };
}
function W(e4, t2 = true) {
  let n2 = Lr(e4, t2);
  return { type: `Table`, loc: E(n2.loc), key: n2, items: [] };
}
function Lr(e4, t2 = true) {
  let n2 = Hr(e4, t2);
  return { type: `TableKey`, loc: { start: D(), end: { line: 1, column: n2.length + 2 } }, item: { type: `Key`, loc: { start: { line: 1, column: 1 }, end: { line: 1, column: n2.length + 1 } }, value: e4, raw: n2 } };
}
function Rr(e4, t2 = true) {
  let n2 = zr(e4, t2);
  return { type: `TableArray`, loc: E(n2.loc), key: n2, items: [] };
}
function zr(e4, t2 = true) {
  let n2 = Hr(e4, t2);
  return { type: `TableArrayKey`, loc: { start: D(), end: { line: 1, column: n2.length + 4 } }, item: { type: `Key`, loc: { start: { line: 1, column: 2 }, end: { line: 1, column: n2.length + 2 } }, value: e4, raw: n2 } };
}
function Br(e4, t2, n2 = false, r2 = true) {
  let i2 = Ur(e4, r2), { column: a2 } = i2.loc.end, o2 = a2 + 1;
  return U(t2, { lines: 1 - t2.loc.start.line, columns: a2 + 3 - t2.loc.start.column }, { first_line_only: true, shift_generated_multiline_end: n2 }), { type: `KeyValue`, loc: { start: T(i2.loc.start), end: T(t2.loc.end) }, key: i2, equals: o2, value: t2 };
}
function Vr(e4, t2 = true) {
  let n2 = JSON.stringify(e4).replace(/\x7f/g, `\\u007f`);
  return t2 ? Mr(n2) : n2;
}
function Hr(e4, t2 = true) {
  return e4.map((e5) => (Wt(e5, `Key ${JSON.stringify(e5)}`), A.test(e5) ? e5 : Vr(e5, t2))).join(`.`);
}
function Ur(e4, t2 = true) {
  let n2 = Hr(e4, t2);
  return { type: `Key`, loc: { start: D(), end: { line: 1, column: n2.length } }, raw: n2, value: e4 };
}
function Wr(e4, t2, n2 = true) {
  return Wt(e4, `String value`), t2 ? Gr(e4, t2, n2) : Kr(e4, void 0, n2);
}
function Gr(e4, t2, n2) {
  if (At(t2)) return Kr(e4, t2, n2);
  if (Mt(t2)) return Dr(e4) ? qr(e4) : Or(e4) ? Xr(e4, `'''${t2.slice(1, -1)}'''`) : Kr(e4, void 0, n2);
  if (Nt(t2)) return Or(e4) ? Xr(e4, t2) : Yr(e4, `"""${t2.slice(3, -3)}"""`, n2);
  if (jt(t2)) return Yr(e4, t2, n2);
  throw Error(`Existing raw string value is not valid: ${t2}`);
}
function Kr(e4, t2, n2 = true) {
  let r2 = ``;
  return r2 = t2 ? `"${Fr(e4, t2, `singleline-basic`, n2)}"` : Vr(e4, n2), { type: `String`, loc: { start: D(), end: { line: 1, column: r2.length } }, raw: r2, value: e4 };
}
function qr(e4) {
  let t2 = `'${e4}'`, n2;
  if (t2.includes(`
`)) {
    let e5 = t2.split(/\r\n|\n/), r2 = e5[e5.length - 1];
    n2 = { line: e5.length, column: r2.length };
  } else n2 = { line: 1, column: t2.length };
  return { type: `String`, loc: { start: D(), end: n2 }, raw: t2, value: e4 };
}
function Jr(e4, t2, n2) {
  return e4.startsWith(t2 + `\r
`) ? `\r
` : e4.startsWith(t2 + `
`) ? `
` : n2.startsWith(`\r
`) ? `\r
` : n2.startsWith(`
`) ? `
` : ``;
}
function Yr(e4, t2, n2 = true) {
  let r2 = Fr(e4, t2, `multiline-basic`, n2), i2 = `"""` + Jr(t2, `"""`, r2) + r2 + `"""`, a2 = t2.slice(3, -3);
  if (/(^|[^\\])(\\\\)*\\$/m.test(a2)) {
    let e5 = Er(t2, r2);
    e5 !== null && (i2 = e5);
  }
  let o2 = Zr(i2);
  return { type: `String`, loc: { start: D(), end: o2 }, raw: i2, value: e4 };
}
function Xr(e4, t2) {
  let n2 = `'''` + Jr(t2, `'''`, e4) + e4 + `'''`, r2 = Zr(n2);
  return { type: `String`, loc: { start: D(), end: r2 }, raw: n2, value: e4 };
}
function Zr(e4) {
  if (e4.includes(`
`)) {
    let t2 = e4.split(/\r\n|\n/), n2 = t2[t2.length - 1];
    return { line: t2.length, column: n2.length };
  }
  return { line: 1, column: e4.length };
}
function Qr(e4) {
  let t2 = e4.toString();
  return { type: `Integer`, loc: { start: D(), end: { line: 1, column: t2.length } }, raw: t2, value: e4 };
}
function $r(e4, t2 = 1) {
  let n2, r2;
  if (e4 === 1 / 0) n2 = `inf`;
  else if (e4 === -1 / 0) n2 = `-inf`;
  else if (Number.isNaN(e4)) {
    let t3 = vt(e4);
    r2 = t3 ? `-` : void 0, n2 = t3 ? `-nan` : `nan`;
  } else if (Object.is(e4, -0)) n2 = `-0.` + `0`.repeat(Math.max(t2, 1));
  else {
    n2 = e4.toString();
    let r3 = n2.search(/[eE]/);
    if (r3 !== -1) {
      let e5 = n2.slice(0, r3), i2 = n2.slice(r3), a2 = e5.indexOf(`.`);
      if (a2 === -1) n2 = `${e5}.${`0`.repeat(Math.max(t2, 1))}${i2}`;
      else {
        let r4 = e5.length - a2 - 1;
        n2 = r4 < t2 ? `${e5}${`0`.repeat(t2 - r4)}${i2}` : `${e5}${i2}`;
      }
    } else {
      let e5 = n2.indexOf(`.`);
      if (e5 === -1) n2 += `.` + `0`.repeat(Math.max(t2, 1));
      else {
        let r4 = n2.length - e5 - 1;
        r4 < t2 && (n2 += `0`.repeat(t2 - r4));
      }
    }
  }
  return { type: `Float`, loc: { start: D(), end: { line: 1, column: n2.length } }, raw: n2, value: e4, ...r2 === void 0 ? {} : { nanSign: r2 } };
}
function ei(e4) {
  return { type: `Boolean`, loc: { start: D(), end: { line: 1, column: e4 ? 4 : 5 } }, value: e4 };
}
function ti(e4, t2 = false, n2 = 0) {
  t2 && !(e4 instanceof De) && e4.getUTCHours() === 0 && e4.getUTCMinutes() === 0 && e4.getUTCSeconds() === 0 && e4.getUTCMilliseconds() === 0 && (e4 = new Ee(e4.toISOString().split(`T`)[0]));
  let r2 = we(e4.toISOString(), n2);
  return { type: `DateTime`, loc: { start: D(), end: { line: 1, column: r2.length } }, raw: r2, value: e4 };
}
function ni(e4, t2 = false, n2 = 0) {
  var r2;
  let i2 = ((r2 = e4.constructor) == null ? void 0 : r2.name) ?? ``, a2 = i2 === `Temporal.PlainDate` || i2 === `PlainDate`, o2 = i2 === `Temporal.PlainTime` || i2 === `PlainTime`, s2 = i2 === `Temporal.PlainDateTime` || i2 === `PlainDateTime`, c2;
  if (a2) c2 = Dt(e4);
  else if (o2) c2 = Dt(e4);
  else if (s2) {
    if (t2) {
      let t3 = globalThis.Temporal;
      if (!t3) throw Error(`Temporal API is not available in this runtime. Set temporal: false or use a runtime with Temporal support.`);
      let r3 = t3.PlainDate.from(e4.toString().split(`T`)[0]);
      if (r3.toString() + `T00:00:00` === e4.toString().slice(0, 19)) return c2 = we(Dt(r3), n2), { type: `DateTime`, loc: { start: D(), end: { line: 1, column: c2.length } }, raw: c2, value: r3 };
    }
    c2 = Dt(e4);
  } else c2 = Dt(e4);
  return c2 = we(c2, n2), { type: `DateTime`, loc: { start: D(), end: { line: 1, column: c2.length } }, raw: c2, value: e4 };
}
function ri() {
  return { type: `InlineArray`, loc: { start: D(), end: { line: 1, column: 2 } }, items: [] };
}
function G(e4) {
  return { type: `InlineItem`, loc: E(e4.loc), item: e4, comma: false };
}
function ii() {
  return { type: `InlineTable`, loc: { start: D(), end: { line: 1, column: 2 } }, items: [] };
}
function ai(e4) {
  return !u(e4) || e4.items.length === 0 ? false : e4.items[e4.items.length - 1].comma === true;
}
function oi(e4) {
  return !f(e4) || e4.items.length === 0 ? false : e4.items[e4.items.length - 1].comma === true;
}
function si(e4, t2) {
  return t2.inlineTableStart === 0 ? e4 : (e4.items.filter((e5) => {
    if (!a(e5)) return false;
    let n2 = f(e5.value), r2 = u(e5.value) && e5.value.items.length > 0 && e5.value.items.every((e6) => f(e6.item));
    if (n2 || r2) {
      let n3 = gi(e5.key.value);
      return t2.inlineTableStart === void 0 || n3 < t2.inlineTableStart;
    }
    return false;
  }).forEach((n2) => {
    V(e4, e4, n2), f(n2.value) ? n2.value.items.length === 0 ? B(e4, e4, W(n2.key.value)) : B(e4, e4, ci(n2, t2.bracketSpacing, t2.escapeSequenceUpperCase)) : li(n2, t2.bracketSpacing, t2.escapeSequenceUpperCase).forEach((t3) => {
      B(e4, e4, t3);
    });
  }), H(e4), e4);
}
function ci(e4, t2, n2) {
  let r2 = W(e4.key.value, n2);
  tr(r2);
  for (let t3 of e4.value.items) B(r2, r2, t3.item, void 0, void 0, void 0, void 0, true);
  return H(r2), pi(r2, 1, t2), r2;
}
function li(e4, n2, i2) {
  let a2 = Ir();
  tr(a2);
  for (let t2 of e4.value.items) {
    let n3 = Rr(e4.key.value, i2);
    B(a2, a2, n3);
    for (let e5 of t2.item.items) B(a2, n3, e5.item, void 0, void 0, void 0, void 0, true);
  }
  H(a2);
  for (let e5 of a2.items) (t(e5) || r(e5)) && pi(e5, 1, n2);
  return a2.items;
}
function ui(e4) {
  let t2 = Ln(e4);
  return t2 === void 0 ? Kn(e4) : t2;
}
function di(e4) {
  return Math.max(e4, 2);
}
function fi(e4, t2, n2, r2 = true) {
  let i2 = ui(e4), o2 = false;
  if (i2) {
    let i3 = t2 + n2;
    for (let t3 of e4.items) U(t3, { lines: 0, columns: i3 - t3.loc.start.column }), d(t3) && (u(t3.item) || f(t3.item) ? fi(t3.item, t3.item.loc.start.column, di(n2), r2) && (t3.loc.end = { ...t3.item.loc.end }, o2 = true) : a(t3.item) && (u(t3.item.value) || f(t3.item.value)) && fi(t3.item.value, t3.item.loc.start.column, n2, r2) && (t3.item.loc.end = { ...t3.item.value.loc.end }, t3.loc.end = { ...t3.item.loc.end }, o2 = true));
    e4.loc.end.column = t2 + 1, o2 = true;
  }
  for (let t3 of e4.items) if (d(t3)) {
    if (u(t3.item) || f(t3.item)) fi(t3.item, t3.item.loc.start.column, di(n2), r2) && (t3.loc.end = { ...t3.item.loc.end }, o2 = true);
    else if (a(t3.item) && (u(t3.item.value) || f(t3.item.value))) {
      let e5 = t3.item.value, i3 = t3.item.loc.start.column, a2 = ui(e5);
      fi(e5, i3, n2, r2) && (a2 && (e5.loc.end.column = i3 + 1), t3.item.loc.end = { ...e5.loc.end }, t3.loc.end = { ...t3.item.loc.end }, o2 = true);
    }
  }
  let s2 = pe(e4) ?? 2;
  for (let t3 = 1; t3 < e4.items.length; t3++) {
    let n3 = e4.items[t3 - 1], r3 = e4.items[t3];
    n3.loc.end.line === r3.loc.start.line && U(r3, { lines: 0, columns: n3.loc.end.column + (n3.comma ? s2 : 1) - r3.loc.start.column });
  }
  if (o2 && !i2 && e4.items.length > 0) {
    let t3 = e4.items[e4.items.length - 1];
    e4.loc.end = { line: t3.loc.end.line, column: t3.loc.end.column + +!!t3.comma + (r2 ? 2 : 1) };
  }
  return o2;
}
function pi(e4, t2, n2 = true) {
  let r2 = a(e4) ? [e4] : e4.items;
  for (let e5 of r2) a(e5) && (u(e5.value) || f(e5.value)) && fi(e5.value, e5.loc.start.column, t2, n2);
}
function mi(e4, t2) {
  let n2 = (e5, r2) => {
    if (r2 && (delete e5.range, Ln(e5) === true || Kn(e5))) {
      let n3 = e5.loc.start.column + t2;
      for (let t3 of e5.items) U(t3, { lines: 0, columns: n3 - t3.loc.start.column });
      e5.loc.end.column = e5.loc.start.column + 1;
    }
    for (let t3 of e5.items) d(t3) && (u(t3.item) || f(t3.item) ? n2(t3.item, u(e5) && f(t3.item)) : a(t3.item) && (u(t3.item.value) || f(t3.item.value)) && n2(t3.item.value, false));
  };
  n2(e4, false);
}
function hi(e4) {
  if (e4.items.length > 0) {
    let t2 = e4.items[e4.items.length - 1];
    e4.loc.end.line = t2.loc.end.line, e4.loc.end.column = t2.loc.end.column;
  } else e4.loc.end.line = e4.key.loc.end.line, e4.loc.end.column = e4.key.loc.end.column;
}
function gi(e4) {
  return Math.max(0, e4.length - 1);
}
function _i(e4, t2) {
  if (t2.inlineTableStart === void 0 || t2.inlineTableStart === 0) return e4;
  let n2 = [];
  for (let i3 of e4.items) if (a(i3) && f(i3.value)) {
    if (gi(i3.key.value) < t2.inlineTableStart) {
      let r2 = ci(i3, t2.bracketSpacing, t2.escapeSequenceUpperCase);
      V(e4, e4, i3), B(e4, e4, r2), vi(r2, n2, t2);
    }
  } else (i3.type === `Table` || r(i3)) && vi(i3, n2, t2);
  let i2 = /* @__PURE__ */ new Map();
  for (let { table: t3, parent: r2 } of n2) {
    let n3 = e4.items.indexOf(r2), a2 = (i2.get(r2) ?? 0) + 1;
    i2.set(r2, a2), B(e4, e4, t3, n3 + a2);
  }
  return H(e4), e4;
}
function vi(e4, t2, n2) {
  let r2 = [];
  for (let t3 = 0; t3 < e4.items.length; t3++) {
    let i2 = e4.items[t3];
    if (a(i2) && f(i2.value)) {
      let t4 = [...e4.key.item.value, ...i2.key.value];
      gi(t4) < (n2.inlineTableStart ?? 1) && r2.push({ item: i2, nestedTableKey: t4 });
    }
  }
  for (let { item: i2, nestedTableKey: a2 } of r2) {
    let r3 = W(a2, n2.escapeSequenceUpperCase);
    tr(r3);
    let o2 = i2.value;
    for (let e5 of o2.items) B(r3, r3, e5.item);
    H(r3), V(e4, e4, i2), hi(e4), t2.push({ table: r3, parent: e4 }), vi(r3, t2, n2);
  }
  r2.length > 0 && H(e4);
}
function yi(e4) {
  let t2 = 0, n2 = 0;
  for (let r2 of e4.items) n2 === 0 && r2.loc.start.line > 1 ? t2 = 1 - r2.loc.start.line : r2.loc.start.line + t2 > n2 + 2 && (t2 += n2 + 2 - (r2.loc.start.line + t2)), U(r2, { lines: t2, columns: 0 }), n2 = r2.loc.end.line;
  return e4;
}
function bi(e4) {
  return e4 instanceof Date && typeof e4.isDate == `function` && typeof e4.isTime == `function` && typeof e4.isDateTime == `function`;
}
function xi(e4) {
  let t2 = e4.toISOString().replace(/\.000(?=([Zz]|[+-]\d{2}:\d{2})$|$)/, ``);
  return e4.isDate() ? new Ee(t2) : e4.isTime() ? new De(t2, t2) : e4.isLocal() ? new Oe(t2, false) : new ke(t2, false);
}
function Si(e4) {
  return e4.items.length > 0 && e4.loc.end.line - e4.loc.start.line + 1 > e4.items.length;
}
function Ci(e4) {
  return u(e4) || f(e4);
}
function wi(e4, t2, n2) {
  if (!d(t2) || !Ci(t2.item) || !Si(e4)) return;
  let r2 = e4.items.find((e5) => Ci(e5.item) && e5.item.type === t2.item.type && Si(e5.item));
  if (!r2 || !Ci(r2.item)) return;
  let i2 = t2.item, a2 = r2.item, o2 = a2.items.length > 0 ? a2.items[0].loc.start.column - a2.loc.start.column : n2, s2 = a2.items.length > 0 ? a2.items[0].loc.start.line - a2.loc.start.line : 1, c2 = a2.items.length > 0 ? a2.loc.end.line - a2.items[a2.items.length - 1].loc.end.line : 1, l2 = i2.loc.start.line, u2 = i2.loc.start.column, f2 = l2 + s2;
  for (let e5 of i2.items) U(e5, { lines: f2 - e5.loc.start.line, columns: u2 + o2 - e5.loc.start.column }), f2 = e5.loc.end.line + 1;
  i2.loc.end = { line: f2 - 1 + c2, column: a2.loc.end.column }, Rn(i2), t2.loc = { start: T(i2.loc.start), end: T(i2.loc.end) };
}
function Ti(e4, t2) {
  let n2 = (e5) => {
    let r2 = false;
    for (let i2 of e5.items) {
      if (!d(i2) || !Ci(i2.item)) continue;
      let a2 = i2.item;
      if (f(a2) && Kn(a2)) {
        delete i2.range, delete a2.range;
        let n3 = a2.loc.start.column + Math.max(t2, 2);
        for (let e6 of a2.items) U(e6, { lines: 0, columns: n3 - e6.loc.start.column });
        a2.loc.end.column = a2.loc.start.column + 1, Bn(a2), Rn(a2), r2 = true, Hn(e5), i2.comma = true, i2.loc.end = { line: a2.loc.end.line, column: a2.loc.end.column }, e5.loc.end = { line: a2.loc.end.line, column: a2.loc.end.column + (i2.comma ? 2 : 1) };
      }
      u(a2) && n2(a2) && (delete a2.range, delete i2.range, i2.loc.end = { line: a2.loc.end.line, column: a2.loc.end.column }, r2 = true, Hn(e5));
    }
    if (r2) {
      for (let t4 = 1; t4 < e5.items.length; t4++) {
        let n3 = e5.items[t4 - 1], r3 = e5.items[t4];
        n3.loc.end.line === r3.loc.start.line && U(r3, { lines: 0, columns: n3.loc.end.column + (n3.comma ? 2 : 1) - r3.loc.start.column });
      }
      let t3 = e5.items[e5.items.length - 1];
      t3 && (e5.loc.end = { line: Math.max(e5.loc.end.line, t3.loc.end.line), column: t3.loc.end.column + (t3.comma ? 2 : 1) });
    }
    return r2;
  };
  n2(e4);
}
function K(e4, t2 = L.default(), n2 = 0, r2 = false) {
  e4 = ji(e4);
  let i2 = Ir();
  tr(i2), $n(i2, t2.indentWidth);
  for (let a2 of Ei(e4, t2, n2, r2)) B(i2, i2, a2);
  if (H(i2), si(i2, t2), (t2.inlineTableStart ?? 1) > 1 && _i(i2, t2), t2.multilineTable !== `auto` || t2.multilineArray !== `auto`) for (let e5 of i2.items) (e5.type === `Table` || e5.type === `TableArray` || a(e5) && (u(e5.value) || f(e5.value))) && pi(e5, t2.indentWidth, t2.bracketSpacing);
  return yi(i2);
}
function* Ei(e4, t2, n2 = 0, r2 = false) {
  for (let i2 of Object.keys(e4)) {
    let a2 = e4[i2];
    if (a2 === void 0) continue;
    let o2 = ji(a2);
    o2 !== void 0 && (yield Br([i2], Oi(o2, t2, n2, r2), n2 > 0 && !r2, t2.escapeSequenceUpperCase));
  }
}
function Di(e4, t2, n2) {
  let r2 = e4.items[e4.items.length - 1];
  r2 && (r2.comma = true);
  let i2 = r2 ? { line: r2.loc.end.line, column: r2.loc.end.column + 2 } : { line: e4.loc.start.line, column: e4.loc.start.column + (n2.bracketSpacing ? 2 : 1) };
  U(t2, { lines: i2.line - t2.loc.start.line, columns: i2.column - t2.loc.start.column }), e4.items.push(t2), t2.comma = false, e4.loc.end = { line: t2.loc.end.line, column: t2.loc.end.column + (n2.bracketSpacing ? 2 : 1) };
}
function Oi(e4, t2, n2, r2) {
  let i2 = t2.minimumDecimals ?? 0;
  if (e4 === null) throw Error(`"null" values are not supported`);
  if (e4 === void 0) throw Error(`"undefined" values are not supported inside arrays`);
  return yt(e4) ? Wr(e4, void 0, t2.escapeSequenceUpperCase) : xt(e4) ? Qr(e4) : bt(e4) ? i2 > 0 ? $r(e4, i2) : Qr(e4) : St(e4) ? $r(e4, Math.max(i2, 1)) : Ct(e4) ? ei(e4) : Et(e4) ? ni(e4, t2.truncateZeroTimeInDates, t2.minimumTimeDecimals ?? 0) : bi(e4) ? ti(xi(e4), t2.truncateZeroTimeInDates, t2.minimumTimeDecimals ?? 0) : wt(e4) ? ti(e4, t2.truncateZeroTimeInDates, t2.minimumTimeDecimals ?? 0) : Array.isArray(e4) ? ki(e4, t2, n2, r2) : Ai(e4, t2, n2, r2);
}
function ki(e4, t2, n2, r2) {
  let i2 = ri(), a2 = !(e4.length === 0 && n2 > 0) && Fn(`array`, n2, r2, t2);
  if (In(i2, a2), $n(i2, t2.indentWidth), tr(i2), !a2) {
    for (let r3 of e4) Di(i2, G(Oi(r3, t2, n2 + 1, a2)), t2);
    if (i2.items.length > 0 && t2.trailingComma) {
      let e5 = i2.items[i2.items.length - 1];
      e5.comma = true, i2.loc.end.column++;
    }
    return i2;
  }
  for (let r3 of e4) {
    let e5 = G(Oi(r3, t2, n2 + 1, a2));
    wi(i2, e5, t2.indentWidth), B(i2, i2, e5);
  }
  return xr(i2, i2, t2.bracketSpacing), Sr(i2, i2, t2.trailingComma), H(i2), i2;
}
function Ai(e4, t2, n2, r2) {
  if (e4 = ji(e4), !P(e4)) return Oi(e4, t2, n2, r2);
  let i2 = ii(), a2 = !(Object.keys(e4).length === 0 && n2 > 0) && Fn(`table`, n2, r2, t2);
  if (In(i2, a2), $n(i2, t2.indentWidth), tr(i2), !a2) {
    for (let r3 of Ei(e4, t2, n2 + 1, a2)) Di(i2, G(r3), t2);
    if (i2.items.length > 0 && t2.trailingComma) {
      let e5 = i2.items[i2.items.length - 1];
      e5.comma = true, i2.loc.end.column++;
    }
    return i2;
  }
  for (let r3 of Ei(e4, t2, n2 + 1, a2)) B(i2, i2, G(r3));
  return xr(i2, i2, t2.bracketSpacing), Sr(i2, i2, t2.trailingComma), H(i2), i2;
}
function ji(e4) {
  return !e4 || wt(e4) || Et(e4) ? e4 : typeof e4.toJSON == `function` ? e4.toJSON() : e4;
}
var Mi = /(\r\n|\n)/g;
function Ni(e4, t2) {
  let n2 = [], r2 = (e5) => {
    let t3 = { line: e5.loc.end.line, column: e5.loc.end.column - 1 }, n3 = e5.items[e5.items.length - 1];
    return n3 && (n3.loc.end.line > t3.line || n3.loc.end.line === t3.line && n3.loc.end.column > t3.column) && (t3.line = n3.loc.end.line, t3.column = n3.loc.end.column + +!!n3.comma), t3;
  };
  function i2(e5) {
    switch (e5.type) {
      case `Document`:
        for (let t3 = 0; t3 < e5.items.length; t3++) i2(e5.items[t3]);
        break;
      case `Table`: {
        let t3 = e5;
        i2(t3.key);
        for (let e6 = 0; e6 < t3.items.length; e6++) i2(t3.items[e6]);
        break;
      }
      case `TableKey`: {
        let t3 = e5;
        Ii(n2, t3.loc, `[` + t3.item.raw + `]`);
        break;
      }
      case `TableArray`: {
        let t3 = e5;
        i2(t3.key);
        for (let e6 = 0; e6 < t3.items.length; e6++) i2(t3.items[e6]);
        break;
      }
      case `TableArrayKey`: {
        let t3 = e5;
        Ii(n2, t3.loc, `[[` + t3.item.raw + `]]`);
        break;
      }
      case `KeyValue`: {
        let t3 = e5, r3 = t3.loc.start.line;
        Li(n2, r3, t3.equals, `=`), i2(t3.key), i2(t3.value);
        break;
      }
      case `Key`:
        Ii(n2, e5.loc, e5.raw);
        break;
      case `String`:
        Ii(n2, e5.loc, e5.raw);
        break;
      case `Integer`:
        Ii(n2, e5.loc, e5.raw);
        break;
      case `Float`:
        Ii(n2, e5.loc, e5.raw);
        break;
      case `Boolean`:
        Ii(n2, e5.loc, e5.value.toString());
        break;
      case `DateTime`:
        Ii(n2, e5.loc, e5.raw);
        break;
      case `InlineArray`: {
        let t3 = e5, { start: a2 } = t3.loc, o2 = r2(t3);
        Li(n2, a2.line, a2.column, `[`), Li(n2, o2.line, o2.column, `]`);
        for (let e6 = 0; e6 < t3.items.length; e6++) i2(t3.items[e6]);
        break;
      }
      case `InlineTable`: {
        let t3 = e5, { start: a2 } = t3.loc, o2 = r2(t3);
        Li(n2, a2.line, a2.column, `{`), Li(n2, o2.line, o2.column, `}`);
        for (let e6 = 0; e6 < t3.items.length; e6++) i2(t3.items[e6]);
        break;
      }
      case `InlineItem`: {
        let t3 = e5;
        if (i2(t3.item), t3.comma) {
          let e6 = t3.loc.end;
          Li(n2, e6.line, e6.column, `,`);
        }
        break;
      }
      case `Comment`:
        Ii(n2, e5.loc, e5.raw);
        break;
      default: {
        let t3 = e5.type;
        throw Error(`toTOML: Unrecognized node type: ${String(t3)}`);
      }
    }
  }
  if (kt(e4)) for (let t3 of e4) i2(t3);
  else i2(e4);
  if (t2.useTabsForIndentation) {
    let t3 = /* @__PURE__ */ new Set(), r3 = (e5) => {
      if (e5.type === `String` && e5.loc.end.line > e5.loc.start.line) for (let n3 = e5.loc.start.line + 1; n3 <= e5.loc.end.line; n3++) t3.add(n3);
      if (m(e5)) for (let t4 of e5.items) r3(t4);
      a(e5) && r3(e5.value), d(e5) && r3(e5.item);
    };
    if (kt(e4)) for (let t4 of e4) r3(t4);
    else r3(e4);
    for (let e5 = 0; e5 < n2.length; e5++) {
      if (t3.has(e5 + 1)) continue;
      let r4 = n2[e5], i3 = r4.match(/^( +)/);
      if (i3) {
        let t4 = i3[1], a2 = `	`.repeat(t4.length);
        n2[e5] = a2 + r4.substring(t4.length);
      }
    }
  }
  return n2.join(t2.newLine) + t2.newLine.repeat(t2.trailingNewline);
}
function Pi(e4, n2) {
  let i2 = kt(e4) ? Array.from(e4) : [e4], o2 = [], s2 = [], c2 = [], l2 = /* @__PURE__ */ new WeakSet(), p2 = 1, g2 = 0, _2 = (e5) => {
    if (e5.type === `Comment` && c2.push(e5), a(e5)) _2(e5.value);
    else if (d(e5)) _2(e5.item);
    else if (e5.type === `Table` || e5.type === `TableArray`) for (let t2 of e5.items) _2(t2);
    else if (m(e5)) for (let t2 of e5.items) _2(t2);
  };
  for (let e5 of i2) _2(e5);
  let v2 = /* @__PURE__ */ new WeakSet(), y2 = (e5) => {
    for (let n3 of e5) if (a(n3)) {
      let e6 = n3.value;
      (f(e6) || u(e6)) && v2.add(e6);
    } else (t(n3) || r(n3)) && y2(n3.items);
  };
  y2(i2);
  let b2 = (e5) => (n2.useTabsForIndentation ? `	` : ` `).repeat(e5), x2 = (e5) => {
    if (e5.length === 0) return;
    o2.push(e5);
    let t2 = e5.split(/\r\n|\n/);
    t2.length === 1 ? g2 += e5.length : (p2 += t2.length - 1, g2 = t2[t2.length - 1].length);
  }, S2 = (e5, t2) => {
    e5 > p2 ? (x2(n2.newLine.repeat(e5 - p2)), t2 > 0 && x2(b2(t2))) : e5 === p2 && t2 > g2 ? x2(g2 === 0 ? b2(t2) : ` `.repeat(t2 - g2)) : o2.length > 0 && (e5 < p2 || e5 === p2 && t2 < g2) && (x2(n2.newLine), t2 > 0 && x2(b2(t2)));
  }, C2 = (e5) => {
    switch (e5.type) {
      case `Key`:
        return e5.raw;
      case `String`:
        return e5.raw;
      case `Integer`:
        return e5.raw;
      case `Float`:
        return e5.raw;
      case `Boolean`:
        return e5.value.toString();
      case `DateTime`:
        return e5.raw;
      case `Comment`:
        return e5.raw;
      default:
        return;
    }
  }, w2 = (e5) => {
    if (a(e5)) return [e5.key, e5.value];
    if (d(e5) || h(e5)) return [e5.item];
    if (e5.type === `Table` || e5.type === `TableArray`) {
      let t2 = e5;
      return [t2.key, ...t2.items];
    }
    return m(e5) ? e5.items : [];
  }, T2 = (e5) => {
    let t2 = [e5];
    for (; t2.length > 0; ) {
      let e6 = t2.pop();
      if (e6.dirty) return false;
      let n3 = C2(e6);
      if (n3 !== void 0) {
        let t3 = R(e6);
        if (!t3 || !e6.range || t3.slice(e6.range[0], e6.range[1]) !== n3) return false;
      } else if (!Sn(e6)) return false;
      t2.push(...w2(e6));
    }
    return true;
  }, E2 = (e5) => e5.type !== `Document` && e5.type !== `InlineItem` && e5.type !== `TableKey` && e5.type !== `TableArrayKey` && (C2(e5) !== void 0 || Sn(e5)), D2 = (e5, t2, r2 = false) => {
    t2.line > e5.line ? (x2(n2.newLine.repeat(t2.line - e5.line)), t2.column > 0 && x2(r2 ? ` `.repeat(t2.column) : b2(t2.column))) : t2.line === e5.line && t2.column > e5.column && x2(` `.repeat(t2.column - e5.column));
  }, O2 = (e5, t2, n3) => {
    var r2, i3;
    let a2 = R(e5);
    if (!a2 || !e5.range || u(e5) && Un(e5) && (!n3 || t2 && !t2.range || n3 && !n3.range) || t2 && R(t2) !== a2 || n3 && R(n3) !== a2) return;
    let o3 = (t2 == null || (r2 = t2.range) == null ? void 0 : r2[1]) ?? e5.range[0] + 1, s3 = (n3 == null || (i3 = n3.range) == null ? void 0 : i3[0]) ?? e5.range[1] - 1;
    if (o3 === void 0 || s3 === void 0 || s3 < o3) return;
    let c3 = a2.slice(o3, s3);
    if (t2 != null && t2.comma && c3.startsWith(`,`) && (c3 = c3.slice(1)), /^[\t \r\n]*$/.test(c3)) return c3;
  }, k2 = (e5, t2) => {
    let n3 = R(t2);
    return n3 !== void 0 && R(e5) === n3 && t2.range !== void 0 && e5.range !== void 0 && e5.range[0] >= t2.range[0] && e5.range[1] <= t2.range[1];
  }, A2 = (e5) => {
    let t2 = f(e5) && Vn(e5), r2;
    for (let n3 of e5.items) {
      let i4 = r2 ? { line: r2.loc.end.line, column: r2.loc.end.column + +!!r2.comma } : { line: e5.loc.start.line, column: e5.loc.start.column + 1 }, a3 = c2.filter((t3) => !l2.has(t3) && k2(t3, e5) && t3.loc.start.line >= i4.line && t3.loc.end.line <= n3.loc.start.line && (t3.loc.start.line > i4.line || t3.loc.start.column >= i4.column) && (t3.loc.end.line < n3.loc.start.line || t3.loc.end.column <= n3.loc.start.column) && t3.loc.start.line >= e5.loc.start.line && t3.loc.end.line <= e5.loc.end.line).sort((e6, t3) => e6.loc.start.line - t3.loc.start.line || e6.loc.start.column - t3.loc.start.column);
      if (a3.length > 0) {
        for (let e6 of a3) D2(i4, e6.loc.start), x2(e6.raw), l2.add(e6), i4 = e6.loc.end;
        D2(i4, n3.loc.start);
      } else {
        let a4 = O2(e5, r2, n3);
        if (a4 !== void 0) x2(a4);
        else {
          let a5 = R(n3) !== R(e5);
          if (r2 && a5 && n3.loc.start.line === r2.loc.end.line) {
            let t3 = pe(e5) ?? 2, n4 = Math.max(0, t3 - 1);
            n4 > 0 && x2(` `.repeat(n4));
          } else D2(i4, n3.loc.start, t2);
        }
      }
      j2(n3, false);
      for (let t3 of c2) {
        if (l2.has(t3) || !k2(t3, e5) || t3.loc.start.line !== n3.loc.end.line || t3.loc.start.column < n3.loc.end.column || t3.loc.start.line < e5.loc.start.line || t3.loc.end.line > e5.loc.end.line) continue;
        let r3 = n3.loc.end.column + +!!n3.comma;
        t3.loc.start.column > r3 && x2(` `.repeat(t3.loc.start.column - r3)), x2(t3.raw), l2.add(t3);
      }
      r2 = n3;
    }
    let i3 = r2 ? { line: r2.loc.end.line, column: r2.loc.end.column + +!!r2.comma } : { line: e5.loc.start.line, column: e5.loc.start.column + 1 }, a2 = c2.filter((t3) => !l2.has(t3) && k2(t3, e5) && t3.loc.start.line >= i3.line && t3.loc.end.line <= e5.loc.end.line).sort((e6, t3) => e6.loc.start.line - t3.loc.start.line || e6.loc.start.column - t3.loc.start.column);
    if (a2.length > 0) {
      for (let e6 of a2) D2(i3, e6.loc.start), x2(e6.raw), l2.add(e6), i3 = e6.loc.end;
      D2(i3, { line: e5.loc.end.line, column: e5.loc.end.column - 1 });
    } else {
      let a3 = O2(e5, r2, void 0);
      if (a3 !== void 0) x2(a3);
      else if (r2) t2 && r2.comma && x2(` `), D2(i3, { line: e5.loc.end.line, column: e5.loc.end.column - 1 }, t2);
      else {
        let t3 = R(e5);
        if (t3 && e5.range) {
          let r3 = t3.slice(e5.range[0], e5.range[1]), i4 = Math.max(r3.lastIndexOf(`
`), r3.lastIndexOf(`\r`)), a4 = v2.has(e5) || Gn(e5);
          if (i4 !== -1 && a4 && kn(e5)) {
            var o3;
            let e6 = ((o3 = r3.slice(i4 + 1, -1).match(/^[\t ]*/)) == null ? void 0 : o3[0]) ?? ``;
            x2(n2.newLine + e6);
          }
        }
      }
    }
  }, j2 = (e5, t2 = true) => {
    if (e5.type === `Comment` && l2.has(e5)) return;
    let n3 = R(e5);
    if (!(n3 !== void 0 && e5.range && s2.some((t3) => t3.source === n3 && t3.start <= e5.range[0] && t3.end >= e5.range[1]))) {
      if (E2(e5) && T2(e5) && e5.range && n3 !== void 0) {
        let r2 = n3.slice(e5.range[0], e5.range[1]), i3 = C2(e5);
        if (i3 === void 0 || i3 === r2) {
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(r2), s2.push({ source: n3, start: e5.range[0], end: e5.range[1] });
          return;
        }
      }
      switch (e5.type) {
        case `Document`:
          for (let t3 of e5.items) j2(t3);
          break;
        case `Table`: {
          let n4 = e5;
          j2(n4.key, t2);
          for (let e6 of n4.items) j2(e6);
          break;
        }
        case `TableKey`: {
          let n4 = e5;
          t2 && S2(n4.loc.start.line, n4.loc.start.column), x2(`[${n4.item.raw}]`);
          break;
        }
        case `TableArray`: {
          let n4 = e5;
          j2(n4.key, t2);
          for (let e6 of n4.items) j2(e6);
          break;
        }
        case `TableArrayKey`: {
          let n4 = e5;
          t2 && S2(n4.loc.start.line, n4.loc.start.column), x2(`[[${n4.item.raw}]]`);
          break;
        }
        case `KeyValue`: {
          let n4 = e5;
          t2 && S2(n4.loc.start.line, n4.loc.start.column), j2(n4.key, false), D2(n4.key.loc.end, { line: n4.loc.start.line, column: n4.equals }), x2(`=`), D2({ line: n4.loc.start.line, column: n4.equals + 1 }, n4.value.loc.start), j2(n4.value, false);
          break;
        }
        case `Key`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.raw);
          break;
        case `String`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.raw);
          break;
        case `Integer`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.raw);
          break;
        case `Float`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.raw);
          break;
        case `Boolean`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.value.toString());
          break;
        case `DateTime`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.raw);
          break;
        case `InlineArray`: {
          let n4 = e5;
          t2 && S2(n4.loc.start.line, n4.loc.start.column), x2(`[`), A2(n4), x2(`]`);
          break;
        }
        case `InlineTable`: {
          let n4 = e5;
          t2 && S2(n4.loc.start.line, n4.loc.start.column), x2(`{`), A2(n4), x2(`}`);
          break;
        }
        case `InlineItem`: {
          let t3 = e5;
          if (j2(t3.item, false), t3.comma) {
            let e6 = R(t3);
            if (e6 && t3.range && t3.item.range && R(t3.item) === e6) {
              let n4 = e6.slice(t3.item.range[1], t3.range[1]);
              /^[\t ]*$/.test(n4) && x2(n4);
            }
            x2(`,`);
          }
          break;
        }
        case `Comment`:
          t2 && S2(e5.loc.start.line, e5.loc.start.column), x2(e5.raw);
          break;
        default:
          throw Error(`toTOMLCursor: Unrecognized node type: ${String(e5.type)}`);
      }
    }
  };
  for (let e5 of i2) j2(e5);
  return o2.join(``).replace(/\r\n|\n/g, n2.newLine) + n2.newLine.repeat(n2.trailingNewline);
}
function Fi(e4, t2) {
  let n2 = Array.isArray(e4) ? e4 : kt(e4) ? Array.from(e4) : [e4], r2 = [], i2 = 1, a2 = 0, o2 = (e5) => (t2.useTabsForIndentation ? `	` : ` `).repeat(e5), s2 = (e5) => {
    if (e5.length === 0) return;
    r2.push(e5);
    let t3 = 0, n3 = -1, o3 = e5.indexOf(`
`);
    for (; o3 !== -1; ) t3++, n3 = o3, o3 = e5.indexOf(`
`, o3 + 1);
    if (t3 === 0) {
      a2 += e5.length;
      return;
    }
    i2 += t3, a2 = e5.length - n3 - 1;
  }, c2 = (e5, n3) => {
    e5 > i2 ? (s2(t2.newLine.repeat(e5 - i2)), n3 > 0 && s2(o2(n3))) : e5 === i2 && n3 > a2 ? s2(a2 === 0 ? o2(n3) : ` `.repeat(n3 - a2)) : r2.length > 0 && (e5 < i2 || e5 === i2 && n3 < a2) && (s2(t2.newLine), n3 > 0 && s2(o2(n3)));
  }, l2 = (e5) => {
    switch (e5.type) {
      case `Key`:
        return e5.raw;
      case `String`:
        return e5.raw;
      case `Integer`:
        return e5.raw;
      case `Float`:
        return e5.raw;
      case `Boolean`:
        return e5.value.toString();
      case `DateTime`:
        return e5.raw;
      case `Comment`:
        return e5.raw;
      default:
        return ``;
    }
  }, u2 = [], d2 = (e5, t3) => {
    switch (e5.type) {
      case `Document`: {
        let t4 = e5.items;
        for (let e6 = t4.length - 1; e6 >= 0; e6--) u2.push([0, t4[e6], true]);
        break;
      }
      case `Table`: {
        let n3 = e5, r3 = n3.items;
        for (let e6 = r3.length - 1; e6 >= 0; e6--) u2.push([0, r3[e6], true]);
        u2.push([0, n3.key, t3]);
        break;
      }
      case `TableKey`: {
        let n3 = e5;
        u2.push([1, `[${n3.item.raw}]`]), t3 && u2.push([3, n3.loc.start.line, n3.loc.start.column]);
        break;
      }
      case `TableArray`: {
        let n3 = e5, r3 = n3.items;
        for (let e6 = r3.length - 1; e6 >= 0; e6--) u2.push([0, r3[e6], true]);
        u2.push([0, n3.key, t3]);
        break;
      }
      case `TableArrayKey`: {
        let n3 = e5;
        u2.push([1, `[[${n3.item.raw}]]`]), t3 && u2.push([3, n3.loc.start.line, n3.loc.start.column]);
        break;
      }
      case `KeyValue`: {
        let n3 = e5;
        u2.push([0, n3.value, false]), u2.push([2, n3.loc.start.line, n3.equals + 1, n3.value.loc.start.line, n3.value.loc.start.column, false]), u2.push([1, `=`]), u2.push([2, n3.key.loc.end.line, n3.key.loc.end.column, n3.loc.start.line, n3.equals, false]), u2.push([0, n3.key, false]), t3 && u2.push([3, n3.loc.start.line, n3.loc.start.column]);
        break;
      }
      case `Key`:
      case `String`:
      case `Integer`:
      case `Float`:
      case `Boolean`:
      case `DateTime`:
      case `Comment`:
        u2.push([1, l2(e5)]), t3 && u2.push([3, e5.loc.start.line, e5.loc.start.column]);
        break;
      case `InlineArray`: {
        let n3 = e5, r3 = n3.items;
        if (u2.push([1, `]`]), r3.length > 0) {
          let e6 = r3[r3.length - 1];
          u2.push([2, e6.loc.end.line, e6.loc.end.column + +!!e6.comma, n3.loc.end.line, n3.loc.end.column - 1, false]);
        }
        for (let e6 = r3.length - 1; e6 >= 0; e6--) {
          let t4 = r3[e6], i3 = e6 > 0 ? r3[e6 - 1] : void 0;
          u2.push([0, t4, false]), u2.push(i3 ? [2, i3.loc.end.line, i3.loc.end.column + +!!i3.comma, t4.loc.start.line, t4.loc.start.column, false] : [2, n3.loc.start.line, n3.loc.start.column + 1, t4.loc.start.line, t4.loc.start.column, false]);
        }
        u2.push([1, `[`]), t3 && u2.push([3, n3.loc.start.line, n3.loc.start.column]);
        break;
      }
      case `InlineTable`: {
        let n3 = e5, r3 = n3.items, i3 = Vn(n3);
        if (u2.push([1, `}`]), r3.length > 0) {
          let e6 = r3[r3.length - 1];
          i3 && e6.comma && u2.push([1, ` `]), u2.push([2, e6.loc.end.line, e6.loc.end.column + +!!e6.comma, n3.loc.end.line, n3.loc.end.column - 1, i3]);
        }
        for (let e6 = r3.length - 1; e6 >= 0; e6--) {
          let t4 = r3[e6], a3 = e6 > 0 ? r3[e6 - 1] : void 0;
          u2.push([0, t4, false]), u2.push(a3 ? [2, a3.loc.end.line, a3.loc.end.column + +!!a3.comma, t4.loc.start.line, t4.loc.start.column, i3] : [2, n3.loc.start.line, n3.loc.start.column + 1, t4.loc.start.line, t4.loc.start.column, i3]);
        }
        u2.push([1, `{`]), t3 && u2.push([3, n3.loc.start.line, n3.loc.start.column]);
        break;
      }
      case `InlineItem`: {
        let t4 = e5;
        t4.comma && u2.push([1, `,`]), u2.push([0, t4.item, false]);
        break;
      }
      default:
        throw Error(`toTOMLSequential: Unrecognized node type: ${String(e5.type)}`);
    }
  };
  for (let e5 = n2.length - 1; e5 >= 0; e5--) u2.push([0, n2[e5], true]);
  for (; u2.length > 0; ) {
    let e5 = u2.pop();
    switch (e5[0]) {
      case 0:
        d2(e5[1], e5[2]);
        break;
      case 1:
        s2(e5[1]);
        break;
      case 2: {
        let n3 = e5[1], r3 = e5[2], i3 = e5[3], a3 = e5[4], c3 = e5[5];
        i3 > n3 ? (s2(t2.newLine.repeat(i3 - n3)), a3 > 0 && s2(c3 ? ` `.repeat(a3) : o2(a3))) : i3 === n3 && a3 > r3 && s2(` `.repeat(a3 - r3));
        break;
      }
      case 3:
        c2(e5[1], e5[2]);
    }
  }
  return r2.join(``).replace(/\r\n|\n/g, t2.newLine) + t2.newLine.repeat(t2.trailingNewline);
}
function Ii(e4, t2, n2) {
  if (t2.start.line === t2.end.line) {
    let r3 = Ri(e4, t2.start.line), i3 = r3.substring(0, t2.start.column), a2 = i3.length < t2.start.column ? i3.padEnd(t2.start.column, ` `) : i3, o2 = r3.substring(t2.end.column);
    e4[t2.start.line - 1] = a2 + n2 + o2;
    return;
  }
  let r2 = n2.split(Mi).filter((e5) => e5 !== `
` && e5 !== `\r
`), i2 = t2.end.line - t2.start.line + 1;
  if (r2.length !== i2) throw Error(`Mismatch between location and raw string, expected ${i2} lines for "${n2}"`);
  for (let n3 = t2.start.line; n3 <= t2.end.line; n3++) {
    let i3 = Ri(e4, n3), a2 = n3 === t2.start.line, o2 = n3 === t2.end.line, s2 = ``;
    if (a2) {
      let e5 = i3.substring(0, t2.start.column);
      s2 = e5.length < t2.start.column ? e5.padEnd(t2.start.column, ` `) : e5;
    }
    let c2 = o2 ? i3.substring(t2.end.column) : ``;
    e4[n3 - 1] = s2 + r2[n3 - t2.start.line] + c2;
  }
}
function Li(e4, t2, n2, r2) {
  let i2 = Ri(e4, t2), a2 = i2.length < n2 ? i2.padEnd(n2, ` `) : i2.substring(0, n2), o2 = i2.substring(n2 + 1);
  e4[t2 - 1] = a2 + r2 + o2;
}
function Ri(e4, t2) {
  if (!e4[t2 - 1]) for (let n2 = 0; n2 < t2; n2++) e4[n2] || (e4[n2] = ``);
  return e4[t2 - 1];
}
function zi(e4, t2 = `asNeeded`) {
  let n2 = e4.replace(/_/g, ``), r2 = n2;
  if (/^[+-]?0x/i.test(n2) || /^[+-]?0o/i.test(n2) || /^[+-]?0b/i.test(n2)) {
    let e5 = n2[0] === `+` || n2[0] === `-` ? n2[0] : ``;
    r2 = e5 + n2.slice(+!!e5).toLowerCase();
  }
  let i2;
  try {
    i2 = BigInt(r2);
  } catch {
    return Number(n2);
  }
  return t2 === true ? i2 : t2 === false || i2 >= BigInt(-(2 ** 53 - 1)) && i2 <= BigInt(2 ** 53 - 1) ? Number(i2) : i2;
}
function Bi(e4, t2, n2) {
  for (let r2 of e4.items) {
    let e5 = r2.item;
    if (e5.value.type === `InlineTable`) {
      let r3 = t2.concat(e5.key.value);
      n2.add(Yi(r3)), Bi(e5.value, r3, n2);
    }
  }
}
function Vi(e4) {
  var t2, n2, r2, i2, a2, o2;
  if ((t2 = e4.constructor) != null && (t2 = t2.name) != null && (n2 = t2.startsWith) != null && n2.call(t2, `Temporal.`) || ((r2 = e4.constructor) == null ? void 0 : r2.name) === `PlainDate` || ((i2 = e4.constructor) == null ? void 0 : i2.name) === `PlainTime` || ((a2 = e4.constructor) == null ? void 0 : a2.name) === `PlainDateTime` || ((o2 = e4.constructor) == null ? void 0 : o2.name) === `ZonedDateTime`) return e4;
  let s2 = globalThis.Temporal;
  if (e4 instanceof Ee) return s2.PlainDate.from(e4.toISOString());
  if (e4 instanceof De) return s2.PlainTime.from(e4.toISOString());
  if (e4 instanceof Oe) return s2.PlainDateTime.from(e4.toISOString().replace(` `, `T`));
  if (e4 instanceof ke) {
    let t3 = e4.toISOString().replace(` `, `T`), n3 = t3.match(/([+-]\d{2}:\d{2}|Z)$/), r3 = n3 ? n3[1] : `Z`, i3 = t3.replace(/([+-]\d{2}:\d{2}|Z)$/, ``), a3 = r3 === `Z` ? `+00:00` : r3;
    return s2.ZonedDateTime.from(`${i3}${r3}[${a3}]`);
  }
  return s2.PlainDateTime.from(e4.toISOString().replace(`Z`, ``));
}
function q(e4, t2 = ``, n2 = {}) {
  let { integersAsBigInt: r2 = `asNeeded`, temporal: i2 = false } = n2, a2 = ht(), o2 = /* @__PURE__ */ new Set(), s2 = /* @__PURE__ */ new Set(), c2 = /* @__PURE__ */ new Set(), l2 = /* @__PURE__ */ new Set(), u2 = /* @__PURE__ */ new Set(), d2 = a2, f2 = [], p2 = { tables: o2, table_arrays: s2, defined: c2, implicit_tables: l2, inline_tables: u2 };
  for (let t3 of e4) switch (t3.type) {
    case `Table`:
      m2(t3);
      for (let e5 of t3.items) e5.type === `KeyValue` && g2(e5);
      break;
    case `TableArray`:
      h2(t3);
      for (let e5 of t3.items) e5.type === `KeyValue` && g2(e5);
      break;
    case `KeyValue`:
      g2(t3);
  }
  return a2;
  function m2(e5) {
    let n3 = e5.key.item.value;
    try {
      Ui(a2, [], n3, e5.type, p2);
    } catch (n4) {
      let r4 = n4;
      throw new O(t2, e5.key.loc.start, r4.message);
    }
    let r3 = Yi(n3);
    o2.add(r3), c2.add(r3), d2 = Wi(a2, n3), f2 = n3;
  }
  function h2(e5) {
    let n3 = e5.key.item.value;
    try {
      Ui(a2, [], n3, e5.type, p2);
    } catch (n4) {
      let r4 = n4;
      throw new O(t2, e5.key.loc.start, r4.message);
    }
    let r3 = Yi(n3);
    s2.add(r3), c2.add(r3), d2 = Gi(a2, n3), f2 = n3;
  }
  function g2(e5) {
    let n3 = e5.key.value;
    try {
      Ui(d2, f2, n3, e5.type, p2);
    } catch (n4) {
      let r3 = n4;
      throw new O(t2, e5.key.loc.start, r3.message);
    }
    if (n3.length > 1) for (let e6 = 1; e6 < n3.length; e6++) {
      let t3 = Yi(f2.concat(n3.slice(0, e6)));
      l2.add(t3), c2.add(t3);
    }
    let a3;
    try {
      a3 = Hi(e5.value, { integersAsBigInt: r2, temporal: i2 });
    } catch (n4) {
      let r3 = n4;
      throw new O(t2, e5.value.loc.start, r3.message);
    }
    if (e5.value.type === `InlineTable`) {
      let t3 = f2.concat(n3);
      u2.add(Yi(t3)), Bi(e5.value, t3, u2);
    }
    let o3 = n3.length > 1 ? Wi(d2, n3.slice(0, -1)) : d2;
    o3[N(n3)] = a3, c2.add(Yi(f2.concat(n3)));
  }
}
function Hi(e4, t2 = {}) {
  let { integersAsBigInt: n2 = `asNeeded`, temporal: r2 = false } = t2;
  switch (e4.type) {
    case `InlineTable`:
      let t3 = ht(), i2 = /* @__PURE__ */ new Set(), a2 = /* @__PURE__ */ new Map();
      return e4.items.forEach(({ item: e5 }) => {
        let o2 = e5.key.value, s2 = Hi(e5.value, { integersAsBigInt: n2, temporal: r2 }), c2 = Ji(o2), l2 = Yi(o2);
        if (i2.has(l2)) throw Error(`Duplicate key "${c2}" in inline table`);
        for (let e6 = 1; e6 < o2.length; e6++) {
          let t4 = Ji(o2.slice(0, e6));
          if (i2.has(Yi(o2.slice(0, e6)))) throw Error(`Key "${c2}" conflicts with key: "${t4}"`);
        }
        if (a2.has(l2)) {
          let e6 = a2.get(l2);
          throw Error(`Key "${c2}" conflicts with key: "${e6}"`);
        }
        i2.add(l2);
        for (let e6 = 1; e6 < o2.length; e6++) {
          let t4 = Yi(o2.slice(0, e6));
          a2.has(t4) || a2.set(t4, c2);
        }
        let u2 = o2.length > 1 ? Wi(t3, o2.slice(0, -1)) : t3;
        u2[N(o2)] = s2;
      }), t3;
    case `InlineArray`:
      return e4.items.map((e5) => Hi(e5.item, { integersAsBigInt: n2, temporal: r2 }));
    case `DateTime`:
      if (r2) {
        if (globalThis.Temporal === void 0) throw Error(`Temporal API is not available in this runtime. Set temporal: false or use a runtime with Temporal support.`);
        return Vi(e4.value);
      }
      return e4.value;
    case `String`:
      return e4.value;
    case `Integer`:
      return zi(e4.raw, n2);
    case `Float`:
    case `Boolean`:
      return e4.value;
    default:
      throw Error(`Unrecognized value type "${e4.type}"`);
  }
}
function Ui(e4, t2, n2, r2, i2) {
  let a2 = t2.length > 0 ? [...t2] : [], o2 = Array(n2.length), s2 = Array(n2.length);
  for (let e5 = 0; e5 < n2.length; e5++) a2.push(n2[e5]), o2[e5] = Ji(a2), s2[e5] = Yi(a2);
  let c2 = o2[n2.length - 1], l2 = s2[n2.length - 1];
  if (r2 === `KeyValue` && n2.length > 1) for (let e5 = 1; e5 < n2.length; e5++) {
    let t3 = o2[e5 - 1];
    if (i2.inline_tables.has(s2[e5 - 1])) throw Error(`Cannot extend inline table at ${t3}`);
  }
  if ((r2 === `Table` || r2 === `TableArray`) && i2.inline_tables.has(l2)) throw Error(`Cannot extend inline table at ${c2}`);
  if (r2 === `Table` || r2 === `TableArray`) for (let e5 = 1; e5 < n2.length; e5++) {
    let t3 = o2[e5 - 1];
    if (i2.inline_tables.has(s2[e5 - 1])) throw Error(`Cannot extend inline table at ${t3}`);
  }
  if (r2 === `KeyValue` && n2.length > 1) for (let e5 = 1; e5 < n2.length; e5++) {
    let t3 = o2[e5 - 1];
    if (i2.table_arrays.has(s2[e5 - 1])) throw Error(`Cannot traverse Array of Tables at ${t3}`);
  }
  if ((r2 === `Table` || r2 === `TableArray`) && i2.implicit_tables.has(l2)) throw Error(`Implicit table already defined: ${c2}`);
  if (r2 === `KeyValue` && i2.implicit_tables.has(l2)) throw Error(`Table already defined: ${c2}`);
  if (r2 === `KeyValue` && n2.length > 1) for (let e5 = 1; e5 <= n2.length; e5++) {
    let t3 = o2[e5 - 1];
    if (i2.tables.has(s2[e5 - 1])) throw Error(`Cannot extend explicit table ${t3} with dotted keys`);
  }
  let u2 = 0;
  for (let t3 of n2) {
    if (!Pt(e4, t3)) return;
    if (qi(e4[t3])) throw Error(`Value already defined for ${o2[u2]}`);
    let r3 = o2[u2];
    if (Array.isArray(e4[t3]) && !i2.table_arrays.has(s2[u2])) throw Error(`Cannot add to static array at ${r3}`);
    let a3 = u2++ < n2.length - 1;
    e4 = Array.isArray(e4[t3]) && a3 ? N(e4[t3]) : e4[t3];
  }
  let d2 = c2;
  if (e4 && r2 === `Table` && i2.defined.has(l2) || e4 && r2 === `KeyValue` && n2.length === 1 && i2.defined.has(l2) && !qi(e4)) throw Error(`Table already defined: ${d2}`);
  if (e4 && r2 === `TableArray` && !i2.table_arrays.has(l2)) throw Error(`Cannot add Array of Tables to table at ${d2}`);
}
function Wi(e4, t2) {
  let n2 = Ki(e4, t2.slice(0, -1)), r2 = N(t2);
  return n2[r2] || (n2[r2] = ht()), n2[r2];
}
function Gi(e4, t2) {
  let n2 = Ki(e4, t2.slice(0, -1)), r2 = N(t2);
  n2[r2] || (n2[r2] = []);
  let i2 = ht();
  return n2[N(t2)].push(i2), i2;
}
function Ki(e4, t2) {
  return t2.reduce((e5, t3) => (e5[t3] || (e5[t3] = ht()), Array.isArray(e5[t3]) ? N(e5[t3]) : e5[t3]), e4);
}
function qi(e4) {
  return typeof e4 != `object` && !wt(e4);
}
function Ji(e4) {
  return e4.join(`.`);
}
function Yi(e4) {
  return JSON.stringify(e4);
}
function J(e4) {
  return e4.type === `Add`;
}
function Xi(e4) {
  return e4.type === `Edit`;
}
function Y(e4) {
  return e4.type === `Remove`;
}
function Zi(e4) {
  return e4.type === `Move`;
}
function Qi(e4) {
  return e4.type === `Rename`;
}
function $i(e4, t2, n2 = [], r2 = {}) {
  return gt(e4, t2) || zt(e4, t2) || typeof e4 == `number` && typeof t2 == `number` && Number.isNaN(e4) && Number.isNaN(t2) && vt(e4) === vt(t2) ? [] : Array.isArray(e4) && Array.isArray(t2) ? ia(e4, t2, n2, r2) : P(e4) && P(t2) ? ea(e4, t2, n2, r2) : [{ type: `Edit`, path: n2 }];
}
function ea(e4, t2, n2 = [], r2 = {}) {
  let i2 = [], a2 = Object.keys(e4), o2 = a2.map((t3) => Bt(e4[t3])), s2 = Object.keys(t2), c2 = s2.map((e5) => Bt(t2[e5])), l2 = new Map(s2.map((e5, t3) => [e5, c2[t3]])), u2 = new Set(a2), d2 = new Set(s2), f2 = (e5, t3, n3) => {
    let r3 = /* @__PURE__ */ new Map();
    return e5.forEach((e6, i3) => {
      if (n3.has(e6)) return;
      let a3 = r3.get(t3[i3]);
      a3 ? a3.push(e6) : r3.set(t3[i3], [e6]);
    }), r3;
  }, p2 = f2(a2, o2, d2), m2 = f2(s2, c2, u2), h2 = /* @__PURE__ */ new Map(), g2 = /* @__PURE__ */ new Set(), _2 = /* @__PURE__ */ new Map();
  for (let [e5, t3] of p2) {
    let n3 = m2.get(e5);
    if (!n3) continue;
    let r3 = Math.min(t3.length, n3.length);
    for (let e6 = 0; e6 < r3; e6++) h2.set(t3[e6], n3[e6]), g2.add(n3[e6]), _2.set(n3[e6], t3[e6]);
  }
  a2.forEach((a3, s3) => {
    let c3 = n2.concat(a3);
    if (d2.has(a3)) {
      let n3 = e4[a3], u3 = t2[a3], d3 = typeof n3 == `number` && !Number.isFinite(n3) || typeof u3 == `number` && !Number.isFinite(u3);
      (r2.updateOrder || d3 || o2[s3] !== l2.get(a3)) && Vt(i2, $i(e4[a3], t2[a3], c3, r2));
    } else h2.has(a3) ? i2.push({ type: `Rename`, path: n2, from: a3, to: h2.get(a3) }) : i2.push({ type: `Remove`, path: c3 });
  }), s2.forEach((e5) => {
    if (!u2.has(e5) && !g2.has(e5)) {
      let t3 = { type: `Add`, path: n2.concat(e5) };
      if (r2.orderSource !== void 0) {
        let i3 = r2.orderSource;
        for (let e6 of n2) i3 = i3 == null ? void 0 : i3[e6];
        if (P(i3)) {
          let n3 = Object.keys(i3), r3 = n3.indexOf(e5);
          for (let e6 = r3 + 1; e6 < n3.length; e6++) {
            let r4 = n3[e6], i4 = _2.get(r4) ?? (u2.has(r4) ? r4 : void 0);
            if (i4 !== void 0) {
              t3.before = i4;
              break;
            }
          }
        }
      }
      i2.push(t3);
    }
  });
  let v2 = s2;
  if (r2.orderSource !== void 0) {
    let e5 = r2.orderSource;
    for (let t3 of n2) e5 = e5 == null ? void 0 : e5[t3];
    if (P(e5)) {
      let t3 = new Set(s2);
      v2 = Object.keys(e5).filter((e6) => t3.has(e6));
    }
  }
  let y2 = i2.filter((e5) => J(e5) && e5.path.length === n2.length + 1 || Qi(e5) && e5.path.length === n2.length);
  if (r2.orderSource !== void 0 && y2.length > 1) {
    let e5 = [...y2].sort((e6, t4) => {
      let n3 = J(e6) ? e6.path[e6.path.length - 1] : Qi(e6) ? e6.to : ``, r3 = J(t4) ? t4.path[t4.path.length - 1] : Qi(t4) ? t4.to : ``;
      return v2.indexOf(n3) - v2.indexOf(r3);
    }), t3 = 0;
    i2 = i2.map((n3) => y2.includes(n3) ? e5[t3++] : n3);
  }
  if (r2.updateOrder) {
    let e5 = [];
    for (let t3 of a2) if (d2.has(t3)) e5.includes(t3) || e5.push(t3);
    else if (h2.has(t3)) {
      let n3 = h2.get(t3);
      e5.includes(n3) || e5.push(n3);
    }
    for (let t3 of s2) e5.includes(t3) || e5.push(t3);
    s2.forEach((t3, r3) => {
      if (e5[r3] === t3) return;
      let a3 = e5.indexOf(t3);
      i2.push({ type: `Move`, path: n2, from: a3, to: r3, key: t3 }), e5.splice(a3, 1), e5.splice(r3, 0, t3);
    });
  }
  return i2;
}
function ta(e4) {
  if (typeof e4 == `string`) return e4.includes(`
`);
  if (Array.isArray(e4)) return e4.length > 0;
  if (typeof e4 == `object` && e4 && !(e4 instanceof Date)) {
    let t2 = Object.values(e4);
    return t2.some((e5) => typeof e5 == `object` && !!e5) || t2.some(ta);
  }
  return false;
}
function na(e4) {
  return typeof e4 == `object` && !!e4 && !Array.isArray(e4) && !(e4 instanceof Date);
}
function ra(e4) {
  return e4.length > 4 && e4.some((e5) => typeof e5 == `string`) && e4.some(na);
}
function ia(e4, t2, n2 = [], r2 = {}) {
  let i2 = [], a2 = e4.map(Bt), o2 = t2.map(Bt), s2 = e4.some(ta) || t2.some(ta) || ra(e4) || ra(t2), c2 = e4.slice(), l2 = 0, u2 = false, d2 = (e5) => {
    let t3 = { type: `Remove`, path: n2.concat(e5) };
    return (!u2 || l2 > 0) && Object.defineProperty(t3, "coordinate", { value: `source` }), t3;
  };
  for (let e5 = 0; e5 < o2.length; e5++) {
    let f2 = o2[e5], p2 = e5 >= a2.length;
    if (!p2 && a2[e5] === f2) continue;
    let m2 = p2 ? -1 : a2.indexOf(f2, e5 + 1);
    if (m2 > -1) {
      let r3 = a2[e5], p3 = 0;
      for (let t3 = e5; t3 < a2.length; t3++) a2[t3] === r3 && p3++;
      let h3 = 0;
      for (let t3 = e5; t3 < o2.length; t3++) o2[t3] === r3 && h3++;
      let g2 = p3 > h3;
      if (s2 && (o2.indexOf(a2[e5]) === -1 || g2)) {
        i2.push(d2(e5 + l2)), a2.splice(e5, 1), c2.splice(e5, 1), l2++, e5--;
        continue;
      }
      if (l2 > 0 && g2) {
        i2.push(d2(e5 + l2)), a2.splice(e5, 1), c2.splice(e5, 1), l2++, e5--;
        continue;
      }
      if (s2 && l2 > 0) {
        i2.push({ type: `Add`, path: n2.concat(e5) }), u2 = true, a2.splice(e5, 0, f2), c2.splice(e5, 0, t2[e5]), l2--;
        continue;
      }
      i2.push({ type: `Move`, path: n2, from: m2, to: e5 });
      let _2 = a2.splice(m2, 1);
      a2.splice(e5, 0, ..._2);
      let v2 = c2.splice(m2, 1);
      c2.splice(e5, 0, ...v2);
      continue;
    }
    let h2 = false;
    if (!p2) {
      let t3 = a2[e5], n3 = 0;
      for (let r4 = e5; r4 < a2.length; r4++) a2[r4] === t3 && n3++;
      let r3 = 0;
      for (let n4 = e5; n4 < o2.length; n4++) o2[n4] === t3 && r3++;
      h2 = n3 > r3;
    }
    if (!p2 && h2) {
      Vt(i2, $i(c2[e5], t2[e5], n2.concat(e5), r2)), a2[e5] = f2, c2[e5] = t2[e5];
      continue;
    }
    i2.push({ type: `Add`, path: n2.concat(e5) }), u2 = true, a2.splice(e5, 0, f2), c2.splice(e5, 0, t2[e5]), l2 > 0 && l2--;
  }
  for (let e5 = o2.length; e5 < a2.length; e5++) i2.push(d2(e5 + l2));
  return i2;
}
function X(n2, i2) {
  if (!i2.length) return d(n2) && a(n2.item) ? n2.item : n2;
  if (a(n2)) return X(n2.value, i2);
  let o2 = {}, s2, c2;
  if (m(n2) && n2.items.some((l2, u2) => {
    try {
      let f2 = [];
      if (a(l2)) f2 = l2.key.value;
      else if (t(l2)) f2 = l2.key.item.value;
      else if (r(l2)) {
        f2 = l2.key.item.value;
        let e4 = Bt(f2);
        o2[e4] || (o2[e4] = 0);
        let t2 = o2[e4]++;
        f2 = f2.concat(t2);
      } else d(l2) && a(l2.item) ? f2 = l2.item.key.value : d(l2) && (f2 = [u2]);
      if (f2.length && F(f2, i2.slice(0, f2.length))) {
        let t2 = i2.slice(f2.length);
        if (e(n2) && r(l2) && t2.length > 0) {
          let e4 = l2.key.item.value, i3 = n2, a2 = i3.items.findIndex((t3, n3) => n3 > u2 && r(t3) && F(t3.key.item.value, e4)), o3 = a2 === -1 ? i3.items.length : a2;
          s2 = aa(l2, t2, e4, i3.items.slice(u2 + 1, o3));
        } else s2 = d(l2) && a(l2.item) ? i2.length === f2.length ? l2 : X(l2.item.value, t2) : d(l2) && i2.length > f2.length ? X(l2.item, t2) : X(l2, t2);
        return true;
      }
      return (a(l2) || d(l2) && a(l2.item)) && f2.length > i2.length && F(f2.slice(0, i2.length), i2) && (c2 ||= l2), false;
    } catch {
      return false;
    }
  }), !s2 && c2 && (s2 = c2), !s2) throw Error(`Node not found at ${i2.join(`.`)}`);
  return s2;
}
function aa(e4, n2, i2, a2) {
  try {
    return X(e4, n2);
  } catch {
  }
  let o2 = {};
  for (let e5 of a2) {
    let a3 = [];
    if (t(e5)) {
      let t2 = e5.key.item.value;
      t2.length > i2.length && F(t2.slice(0, i2.length), i2) && (a3 = t2.slice(i2.length));
    } else if (r(e5)) {
      let t2 = e5.key.item.value;
      if (t2.length > i2.length && F(t2.slice(0, i2.length), i2)) {
        let e6 = t2.slice(i2.length), n3 = Bt(e6);
        o2[n3] || (o2[n3] = 0);
        let r2 = o2[n3]++;
        a3 = e6.concat(r2);
      }
    }
    if (a3.length && F(a3, n2.slice(0, a3.length))) try {
      return X(e5, n2.slice(a3.length));
    } catch {
    }
  }
  throw Error(`Node not found at (aot scope) ${n2.join(`.`)}`);
}
function Z(e4, t2) {
  try {
    return X(e4, t2);
  } catch {
  }
}
function oa(e4, t2) {
  let n2 = t2, r2;
  for (; n2.length && !r2; ) n2 = n2.slice(0, -1), r2 = Z(e4, n2);
  if (!r2) throw Error(`Parent not found for ${t2.join(`.`)}`);
  return r2;
}
var sa = String.raw`(?:[\w-]+|"[^"]*"|'[^']*')`;
var ca = new RegExp(String.raw`^#\s*${sa}(?:\s*\.\s*${sa})*\s*=`);
var la = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|"""[\s\S]*?"""|'''[\s\S]*?'''|[^\s#]+)`;
var ua = new RegExp(String.raw`^#\s*${sa}(?:\s*\.\s*${sa})*\s*=\s*${la}\s*$`);
var da = new RegExp(String.raw`^#\s*\[\[?\s*${sa}(?:\s*\.\s*${sa})*\s*\]\]?\s*$`);
function fa(e4) {
  return ua.test(e4.raw) || da.test(e4.raw);
}
function pa(e4) {
  let t2 = e4.raw.indexOf(`=`);
  if (t2 < 0) return false;
  let n2 = false, r2 = false;
  for (let i2 = t2 + 1; i2 < e4.raw.length; i2++) {
    let t3 = e4.raw[i2];
    if (t3 === `\\`) {
      i2++;
      continue;
    }
    if (!r2 && t3 === `"`) {
      n2 = !n2;
      continue;
    }
    if (!n2 && t3 === `'`) {
      r2 = !r2;
      continue;
    }
    if (!n2 && !r2 && t3 === `#`) return true;
  }
  return false;
}
function ma(e4) {
  return fa(e4) ? true : ca.test(e4.raw) ? pa(e4) ? true : e4.raw.replace(/^[^=]*=\s*/, ``).split(/\s+/).filter(Boolean).length <= 3 : false;
}
function ha(e4) {
  let t2 = e4.raw.match(ca);
  if (!t2) return;
  let n2 = t2[0].replace(/^#\s*/, ``).replace(/\s*=.*$/, ``).trim(), r2 = n2.indexOf(`.`);
  return r2 >= 0 && (n2 = n2.substring(0, r2)), (n2.startsWith(`"`) && n2.endsWith(`"`) || n2.startsWith(`'`) && n2.endsWith(`'`)) && (n2 = n2.slice(1, -1)), n2 || void 0;
}
function ga(e4) {
  return (f(e4) || u(e4)) && e4.loc.end.line > e4.loc.start.line;
}
function _a(e4) {
  if (a(e4)) return e4.key.value[0];
  if (t(e4) || r(e4)) return e4.key.item.value[0];
  if (d(e4) && a(e4.item)) return e4.item.key.value[0];
}
function va(e4, t2, n2, r2 = _a) {
  let i2 = [], a2 = t2, o2, s2 = [], c2 = () => {
    s2.length && (i2.push({ kind: `pinned`, items: s2, startLine: s2[0].loc.start.line, endLine: N(s2).loc.end.line }), s2 = []);
  };
  for (let t3 of e4) {
    if (p(t3)) {
      if (t3.loc.start.line <= a2) {
        o2 ? (o2.items.push(t3), o2.endLine = Math.max(o2.endLine, t3.loc.end.line)) : i2.push({ kind: `pinned`, items: [t3], startLine: t3.loc.start.line, endLine: t3.loc.end.line });
        continue;
      }
      let e6 = s2.length ? N(s2).loc.end.line : void 0;
      s2.length && t3.loc.start.line === e6 + 1 || c2(), s2.push(t3);
      continue;
    }
    let e5 = [];
    if (s2.length) {
      if (N(s2).loc.end.line + 1 === t3.loc.start.line && n2(t3)) {
        let n3 = r2(t3);
        if (n3 !== void 0) {
          let e6 = -1;
          for (let t4 = s2.length - 1; t4 >= 0; t4--) {
            let r3 = ma(s2[t4]) ? ha(s2[t4]) : void 0;
            if (r3 !== void 0 && r3 !== n3) {
              e6 = t4;
              break;
            }
          }
          if (e6 >= 0) {
            let t4 = s2.splice(0, e6 + 1);
            i2.push({ kind: `pinned`, items: t4, startLine: t4[0].loc.start.line, endLine: N(t4).loc.end.line });
          }
        }
        e5 = s2, s2 = [];
      } else c2();
    }
    let l2 = [...e5, t3], u2 = { kind: `member`, member: t3, key: r2(t3), items: l2, startLine: l2[0].loc.start.line, endLine: t3.loc.end.line };
    i2.push(u2), o2 = u2, a2 = t3.loc.end.line;
  }
  return c2(), i2;
}
function ya(t2, n2 = () => true, r2 = _a) {
  let i2 = e(t2) ? 0 : t2.key.loc.end.line;
  return va(t2.items, i2, n2, r2);
}
function ba(e4, t2) {
  let n2 = t2.filter((t3) => p(t3) && (t3.loc.start.line > e4.loc.start.line || t3.loc.start.line === e4.loc.start.line && t3.loc.start.column >= e4.loc.start.column) && (t3.loc.end.line < e4.loc.end.line || t3.loc.end.line === e4.loc.end.line && t3.loc.end.column <= e4.loc.end.column));
  return va([...e4.items, ...n2].sort((e5, t3) => e5.loc.start.line - t3.loc.start.line || e5.loc.start.column - t3.loc.start.column), e4.loc.start.line, () => true);
}
function xa(e4, t2) {
  function n2(e5) {
    if (a(e5)) return n2(e5.value);
    if (m(e5)) {
      for (let n3 of e5.items) if (d(n3) && n3.item === t2) return n3;
      for (let t3 of e5.items) {
        let e6 = n2(d(t3) ? t3.item : t3);
        if (e6) return e6;
      }
    }
  }
  return n2(e4);
}
function Sa(e4, n2) {
  function i2(e5, t2) {
    if (e5 === n2) return t2;
    if (a(e5)) return i2(e5.value, t2);
    if (f(e5) || u(e5)) for (let r2 of e5.items) {
      if (r2 === n2) return t2;
      let e6 = i2(r2.item, t2);
      if (e6) return e6;
    }
  }
  function o2(e5) {
    for (let s2 of e5.items) {
      if (s2 === n2) return e5;
      if (a(s2)) {
        let t2 = i2(s2.value, e5);
        if (t2) return t2;
      } else if (t(s2) || r(s2)) {
        let e6 = o2(s2);
        if (e6) return e6;
      }
    }
  }
  return o2(e4);
}
function Ca(e4) {
  for (let n2 = 0; n2 < e4.items.length; n2++) {
    let i2 = e4.items[n2];
    if (!t(i2) && !r(i2)) continue;
    let a2 = e4.items[n2 + 1];
    if (!a2) continue;
    let o2 = wa(i2, a2);
    if (!o2) continue;
    let s2 = i2.items;
    s2.splice(s2.length - o2.length, o2.length), e4.items.splice(n2 + 1, 0, ...o2), br(i2), n2 += o2.length;
  }
}
function wa(e4, t2) {
  let n2 = N(ya(e4));
  if (!n2 || n2.kind !== `pinned`) return;
  let r2 = n2.items, i2 = n2.endLine + 1 === t2.loc.start.line, a2 = r2.every(fa);
  if (i2 && !a2) return r2;
}
function Q(n2, i2, a2) {
  if (e(i2) && (t(a2) || r(a2))) {
    let e4 = i2.items.indexOf(a2), o2 = e4 > 0 ? i2.items[e4 - 1] : void 0;
    if (o2 && (t(o2) || r(o2))) {
      let e5 = wa(o2, a2);
      if (e5) for (let t2 of e5) V(n2, o2, t2);
    }
  }
  if (e(i2) || t(i2) || r(i2)) {
    let e4 = ya(i2).find((e5) => e5.member === a2);
    if (e4) {
      let t2 = e4.items.indexOf(a2);
      for (let r2 = 0; r2 <= t2; r2++) {
        let t3 = e4.items[r2];
        i2.items.includes(t3) && V(n2, i2, t3);
      }
      for (let n3 = t2 + 1; n3 < e4.items.length; n3++) {
        let t3 = e4.items[n3], r2 = i2.items.indexOf(t3);
        r2 < 0 || i2.items.splice(r2, 1);
      }
      return;
    }
  }
  if (ga(i2) && e(n2)) {
    let e4 = Sa(n2, i2);
    if (e4) {
      let t2 = ba(i2, e4.items).find((e5) => e5.member === a2);
      if (t2) {
        let r2 = t2.items.filter((e5) => e5 !== a2);
        for (let t3 of r2) {
          let n3 = e4.items.indexOf(t3);
          n3 < 0 || e4.items.splice(n3, 1);
        }
        r2.length && (a2.loc.start = t2.items[0].loc.start, a2.loc.end = N(t2.items).loc.end), V(n2, i2, a2, e4.items), H(n2);
        return;
      }
    }
  }
  V(n2, i2, a2);
}
function Ta(t2, n2, r2, i2) {
  let s2 = false;
  if (ga(n2) && e(t2)) {
    let e4 = Sa(t2, n2);
    if (e4) {
      let c3 = ba(n2, e4.items);
      {
        let e5 = n2.items, r3 = 1;
        for (let n3 = 1; n3 < e5.length; n3++) if (e5[n3].loc.start.line === e5[n3 - 1].loc.start.line) {
          let i3 = z(t2).get(e5[n3 - 1]), a2 = z(t2).get(e5[n3]);
          if (i3 || a2) continue;
          if (r3++, r3 >= 3) {
            s2 = true;
            break;
          }
        } else r3 = 1;
      }
      let l3 = [], p3, h3, g3, _3 = [], v3 = (e5, t3) => {
        if (!m(e5)) return;
        let n3 = e5.items;
        for (let e6 = 0; e6 < n3.length; e6++) {
          let r3 = n3[e6], i3 = r3.loc.start.line > t3;
          if (i3 && _3.push({ node: r3, start: T(r3.loc.start), end: T(r3.loc.end) }), r3.loc.end.line > t3 && r3.loc.end.line > r3.loc.start.line && _3.push({ node: r3, start: T(r3.loc.start), end: T(r3.loc.end), endOnly: true }), d(r3)) {
            let e7 = r3.item;
            if (i3) {
              let t4 = a(e7) ? e7 : void 0;
              _3.push({ node: e7, start: T(e7.loc.start), end: T(e7.loc.end), equals: t4 ? t4.equals : void 0 }), t4 && (_3.push({ node: t4.key, start: T(t4.key.loc.start), end: T(t4.key.loc.end) }), _3.push({ node: t4.value, start: T(t4.value.loc.start), end: T(t4.value.loc.end) }));
            }
            e7.loc.end.line > t3 && e7.loc.end.line > e7.loc.start.line && _3.push({ node: e7, start: T(e7.loc.start), end: T(e7.loc.end), endOnly: true }), v3(e7, t3);
          } else m(r3) && v3(r3, t3);
        }
      };
      for (let t3 of c3) {
        if (t3.kind !== `member` || !t3.member) continue;
        let n3 = t3.items.filter((e5) => e5 !== t3.member);
        if (t3.member === r2 && (p3 = T(r2.loc.start), h3 = T(r2.loc.end), d(r2) && (g3 = T(r2.item.loc.end)), v3(d(r2) ? r2.item : r2, p3.line), n3.length && (r2.loc.start = T(t3.items[0].loc.start), r2.loc.end = T(N(t3.items).loc.end))), n3.length) {
          l3.push({ owner: t3.member, ownerOriginalStart: T(t3.member.loc.start), comments: n3 });
          for (let t4 of n3) {
            let n4 = e4.items.indexOf(t4);
            n4 >= 0 && e4.items.splice(n4, 1);
          }
        }
      }
      let y3 = n2.items.indexOf(r2), b3 = y3 === n2.items.length - 1, x3 = y3 > 0 ? n2.items[y3 - 1] : void 0, S2 = i2 === 0 && y3 > 0 && r2.loc.end.line > r2.loc.start.line && x3 !== void 0 && x3.loc.start.line === r2.loc.start.line;
      V(t2, n2, r2, e4.items);
      let C2 = false;
      if (b3 && x3 !== void 0 && r2.loc.end.line > r2.loc.start.line && !Cr(n2) && z(t2).get(x3) && (z(t2).delete(x3), C2 = true), H(t2), B(t2, n2, r2, i2, void 0, e4.items), C2) {
        let e5 = z(t2).get(r2);
        e5 && (e5.lines = 0, e5.columns = 0);
      }
      H(t2), p3 && h3 && r2.loc.end.line > r2.loc.start.line && (r2.loc.end.column = h3.column, d(r2) && g3 && r2.item.loc.end.line > r2.item.loc.start.line && (r2.item.loc.end.column = g3.column));
      for (let { node: e5, start: t3, end: n3, endOnly: r3, equals: i3 } of _3) {
        if (r3) {
          e5.loc.end.column = n3.column;
          continue;
        }
        e5.loc.start.column = t3.column, e5.loc.end.line === e5.loc.start.line && (e5.loc.end.column = n3.column), i3 !== void 0 && a(e5) && (e5.equals = i3);
      }
      for (let { owner: t3, ownerOriginalStart: n3, comments: i3 } of l3) {
        let a2;
        t3 === r2 ? (a2 = { lines: r2.loc.start.line - n3.line, columns: r2.loc.start.column - n3.column }, r2.loc.start = { line: p3.line + a2.lines, column: p3.column + a2.columns }, r2.loc.end = { line: h3.line + a2.lines, column: h3.column + a2.columns }) : a2 = { lines: t3.loc.start.line - n3.line, columns: t3.loc.start.column - n3.column };
        for (let t4 of i3) {
          U(t4, a2);
          let n4 = e4.items.findIndex((e5) => e5.loc.start.line > t4.loc.start.line);
          n4 === -1 ? e4.items.push(t4) : e4.items.splice(n4, 0, t4);
        }
      }
      let w2 = n2;
      if (s2 || S2) {
        let e5 = (t3, n4) => {
          let r3;
          for (let n5 of t3.items) {
            if (!r3) {
              r3 = { line: n5.loc.end.line, column: n5.loc.end.column + 2 };
              continue;
            }
            let t4 = { lines: r3.line - n5.loc.start.line, columns: r3.column - n5.loc.start.column };
            if (t4.lines !== 0 || t4.columns !== 0) {
              U(n5, t4), n5.loc.end.line > n5.loc.start.line && (n5.loc.end.column -= t4.columns, d(n5) && n5.item.loc.end.line > n5.item.loc.start.line && (n5.item.loc.end.column -= t4.columns));
              let r4 = d(n5) ? a(n5.item) ? n5.item.value : n5.item : n5;
              (f(r4) || u(r4)) && r4.loc.end.line > r4.loc.start.line && e5(r4, n5);
            }
            r3 = { line: n5.loc.end.line, column: n5.loc.end.column + 2 };
          }
          r3 && (t3.loc.end = { line: r3.line, column: r3.column - 1 }, n4 && n4.loc.end.line === t3.loc.end.line && (n4.loc.end.column = t3.loc.end.column));
        }, n3;
        for (let t3 of w2.items) {
          if (t3 === r2) {
            n3 = { line: r2.loc.end.line, column: r2.loc.end.column + 2 };
            continue;
          }
          if (!n3) continue;
          let i3 = { lines: n3.line - t3.loc.start.line, columns: n3.column - t3.loc.start.column };
          if (i3.lines !== 0 || i3.columns !== 0) {
            U(t3, i3);
            let n4 = d(t3) ? a(t3.item) ? t3.item.value : t3.item : t3;
            (f(n4) || u(n4)) && n4.loc.end.line > n4.loc.start.line && e5(n4, d(t3) ? t3 : void 0);
          }
          let s3 = t3.loc.end.line, c4 = d(t3) ? t3.item : t3;
          o(c4) && c4.loc.end.line > c4.loc.start.line && (s3 = c4.loc.start.line + c4.raw.split(`
`).length - 1, c4.loc.end.line = s3, t3.loc.end.line = s3), n3 = { line: s3, column: t3.loc.end.column + 2 };
        }
        if (n3) {
          let e6 = T(w2.loc.end);
          w2.loc.end = { line: n3.line, column: n3.column - 1 };
          let r3 = xa(t2, w2);
          r3 && (r3.loc.end = { line: w2.loc.end.line, column: w2.loc.end.column });
          let i3 = { lines: w2.loc.end.line - e6.line, columns: w2.loc.end.column - e6.column };
          (i3.lines !== 0 || i3.columns !== 0) && sr(t2, r3 ?? w2, i3);
        }
      }
      return;
    }
  }
  let c2 = n2, l2 = c2.items, p2 = l2[0], h2 = l2[l2.length - 1], g2 = p2.loc.start.column - c2.loc.start.column - 1, _2 = c2.loc.end.column - 1 - h2.loc.end.column;
  V(t2, n2, r2), B(t2, n2, r2, i2), H(t2);
  let v2 = c2.items, y2 = v2[0], b2 = y2.loc.start.column - c2.loc.start.column - 1;
  b2 !== g2 && U(y2, { lines: 0, columns: g2 - b2 });
  let x2 = v2[v2.length - 1];
  c2.loc.end.column - 1 - x2.loc.end.column !== _2 && (c2.loc.end.column = x2.loc.end.column + 1 + _2);
}
function Ea(e4) {
  let n2 = [];
  for (let i3 of e4) {
    if (i3.kind === `pinned`) {
      n2.push({ kind: `pinned`, isSection: false, movable: false, groups: [i3], startLine: i3.startLine, endLine: i3.endLine, items: i3.items });
      continue;
    }
    let e5 = t(i3.member) || r(i3.member), a2 = n2[n2.length - 1];
    if (a2 && a2.kind === `member` && i3.key !== void 0 && a2.key === i3.key) {
      a2.groups.push(i3), a2.endLine = i3.endLine, a2.items = a2.items.concat(i3.items);
      continue;
    }
    n2.push({ kind: `member`, key: i3.key, isSection: e5, movable: i3.key !== void 0, groups: [i3], startLine: i3.startLine, endLine: i3.endLine, items: [...i3.items] });
  }
  let i2 = /* @__PURE__ */ new Map();
  for (let e5 of n2) e5.kind === `member` && e5.key !== void 0 && i2.set(e5.key, (i2.get(e5.key) ?? 0) + 1);
  for (let e5 of n2) e5.kind === `member` && e5.key !== void 0 && i2.get(e5.key) > 1 && (e5.movable = false);
  return n2;
}
function Da(e4, t2) {
  let n2 = [...e4];
  for (let e5 of t2) {
    if (e5.key === void 0) continue;
    let t3 = n2.indexOf(e5.key);
    if (t3 === -1) continue;
    let r2 = Math.max(0, Math.min(e5.to, n2.length - 1));
    t3 !== r2 && (n2.splice(t3, 1), n2.splice(r2, 0, e5.key));
  }
  return n2;
}
function Oa(e4) {
  return [...e4.path, e4.key].join(`.`);
}
function ka(e4, n2, i2, o2) {
  if (n2.some((e5) => typeof e5 != `string`)) return;
  let s2 = [...n2, i2], c2 = [{ container: e4, prefix: [] }];
  for (let n3 of e4.items) (t(n3) || r(n3)) && c2.push({ container: n3, prefix: n3.key.item.value });
  for (let e5 of c2) for (let t2 of e5.container.items) {
    if (!a(t2) || t2.key.value.length < 2 || o2.has(t2)) continue;
    let n3 = [...e5.prefix, ...t2.key.value];
    if (n3.length === s2.length && n3.every((e6, t3) => e6 === s2[t3])) return { container: e5.container, dottedPrefix: t2.key.value.slice(0, -1) };
  }
}
function Aa(n2, i2, o2, s2) {
  if (i2.length === 0) return { container: n2 };
  let c2;
  try {
    c2 = Z(n2, i2);
  } catch {
    return;
  }
  if (!c2) return;
  if (a(c2) && (c2 = c2.value), c2 && h(c2) && (c2 = c2.item), c2 && (e(c2) || t(c2) || r(c2))) return { container: c2 };
  if (o2 === void 0) return;
  let l2 = ka(n2, i2, o2, s2);
  if (l2) return l2;
  let u2 = -1;
  for (let e4 = i2.length - 1; e4 >= 0; e4--) if (typeof i2[e4] == `number`) {
    u2 = e4;
    break;
  }
  if (u2 < 0) return;
  let d2 = i2.slice(u2 + 1);
  if (d2.length === 0 || d2.some((e4) => typeof e4 != `string`)) return;
  let f2 = Z(n2, i2.slice(0, u2 + 1));
  if (!f2 || !r(f2)) return;
  let p2 = [...d2, o2];
  return f2.items.some((e4) => a(e4) && e4.key.value.length === p2.length && e4.key.value.every((e5, t2) => e5 === p2[t2])) ? { container: f2, dottedPrefix: d2 } : void 0;
}
function ja(e4, t2, n2) {
  if (t2.key === void 0) return false;
  let r2;
  try {
    r2 = Z(e4, t2.path.concat(t2.key));
  } catch {
    return false;
  }
  return r2 !== void 0 && d(r2) && !n2.has(r2);
}
function Ma(t2, n2, r2, i2, o2) {
  let s2 = Ea(ya(t2, (e4) => r2.has(e4), o2 ? (e4) => {
    if (!a(e4)) return;
    let t3 = e4.key.value;
    if (t3.length === o2.length + 1) {
      for (let e5 = 0; e5 < o2.length; e5++) if (t3[e5] !== o2[e5]) return;
      return t3[o2.length];
    }
  } : void 0)), c2 = /* @__PURE__ */ new Map();
  for (let e4 of s2) e4.kind === `member` && e4.movable && e4.key !== void 0 && c2.set(e4.key, e4);
  let l2 = new Set(s2.filter((e4) => e4.kind === `member` && e4.key !== void 0).map((e4) => e4.key));
  for (let e4 of n2) e4.key !== void 0 && l2.has(e4.key) && !c2.has(e4.key) && i2.push(`"${Oa(e4)}" -- its entries are not contiguous in the document (e.g. the TOML spec's own "valid but discouraged" out-of-order table pattern), so reordering was skipped for it`);
  if (c2.size === 0) return;
  let u2 = o2 ? s2.filter((e4) => e4.kind === `member` && e4.movable).map((e4) => e4.key) : s2.filter((e4) => e4.kind === `member`).map((e4, t3) => e4.movable ? e4.key : `\0anchor:${t3}`), d2 = n2.filter((e4) => e4.key !== void 0 && c2.has(e4.key));
  if (d2.length === 0) return;
  let f2 = Da(u2, d2).filter((e4) => c2.has(e4)), p2 = f2.filter((e4) => !c2.get(e4).isSection), m2 = f2.filter((e4) => c2.get(e4).isSection), h2 = false;
  for (let e4 of f2) if (c2.get(e4).isSection) h2 = true;
  else if (h2) {
    i2.push(`the requested order asked for a root key-value to be positioned after a section header, which TOML cannot represent -- each group (root key-values, section blocks) was reordered to match its own requested relative order instead`);
    break;
  }
  let g2 = 0, _2 = 0, v2 = s2.map((e4) => {
    if (e4.kind !== `member` || !e4.movable) return e4;
    let t3 = e4.isSection ? m2[_2++] : p2[g2++];
    return c2.get(t3);
  });
  if (v2.every((e4, t3) => e4 === s2[t3])) return;
  let y2 = e(t2) ? 1 : t2.key.loc.end.line, b2 = s2.map((e4, t3) => t3 === 0 ? e4.startLine - y2 : e4.startLine - s2[t3 - 1].endLine - 1), x2 = y2;
  for (let e4 = 0; e4 < v2.length; e4++) {
    let t3 = v2[e4], n3 = b2[e4], r3 = (e4 === 0 ? x2 : x2 + 1) + n3 - t3.startLine;
    if (r3 !== 0) for (let e5 of t3.items) U(e5, { lines: r3, columns: 0 });
    x2 = t3.endLine + r3;
  }
  let S2 = v2.flatMap((e4) => e4.items), C2 = t2.items;
  C2.splice(0, C2.length, ...S2), br(t2);
}
function Na(e4, t2, n2) {
  if (t2.length === 0) return;
  Ca(e4);
  let r2 = [], i2 = /* @__PURE__ */ new Map();
  for (let o2 of t2) {
    var a2;
    if (o2.key === void 0) continue;
    let t3 = Aa(e4, o2.path, o2.key, n2);
    if (!t3) {
      if (ja(e4, o2, n2)) continue;
      r2.push(`"${Oa(o2)}" -- unsupported location for reordering (e.g. a dotted-key implicit table, or an interior of an inline table/array-of-tables entry)`);
      continue;
    }
    let s2 = ((a2 = t3.dottedPrefix) == null ? void 0 : a2.join(`\0`)) ?? ``, c2 = i2.get(t3.container);
    c2 || (c2 = /* @__PURE__ */ new Map(), i2.set(t3.container, c2));
    let l2 = c2.get(s2);
    l2 ? l2.moves.push(o2) : c2.set(s2, { ...t3, moves: [o2] });
  }
  for (let e5 of i2.values()) for (let t3 of e5.values()) Ma(t3.container, t3.moves, n2, r2, t3.dottedPrefix);
  if (r2.length > 0) {
    let e5 = [...new Set(r2)];
    console.warn(`toml-patch: updateOrder could not honor the requested position for ${e5.length === 1 ? `1 entry` : `${e5.length} entries`}, left unchanged:
` + e5.map((e6) => `  - ${e6}`).join(`
`));
  }
  br(e4);
}
var Pa = /* @__PURE__ */ new WeakMap();
var Fa = /* @__PURE__ */ new WeakMap();
function Ia(e4, t2) {
  let n2 = e4[t2].loc.end.line;
  for (let r2 = t2 + 1; r2 < e4.length; r2++) {
    let t3 = e4[r2];
    if (p(t3) && t3.loc.start.line === n2) return t3;
    if (!p(t3) && t3.loc.start.line > n2) return;
  }
}
function La(e4, t2, n2) {
  for (let r2 = t2 + n2; r2 >= 0 && r2 < e4.length; r2 += n2) if (!p(e4[r2])) return r2;
}
function Ra(e4, t2, n2) {
  Fa.has(e4) || Fa.set(e4, e4.loc.start.column);
  let r2 = e4.loc.start.column + n2, i2 = Math.max(t2, r2) - r2;
  i2 !== 0 && (e4.loc.start.column += i2, e4.loc.end.column += i2);
}
function za(e4, t2) {
  Fa.set(t2, t2.loc.start.column), Pa.set(t2, t2.loc.start.column - e4.loc.end.column);
}
function Ba(e4, t2, n2, r2) {
  if (!m(e4)) return;
  let i2 = e4.items, a2 = i2.indexOf(t2);
  if (a2 < 0) return;
  let o2 = Ia(i2, a2);
  if (!o2 || n2.loc.start.line !== n2.loc.end.line || r2.loc.start.line !== r2.loc.end.line) return;
  let s2 = o2.loc.start.column, c2 = o2.loc.start.line, l2 = [La(i2, a2, -1), La(i2, a2, 1)], u2;
  for (let e5 of l2) {
    if (e5 == null) continue;
    let t3 = Ia(i2, e5);
    if (t3 && Math.abs(t3.loc.start.line - c2) === 1 && t3.loc.start.column === s2) {
      u2 = t3.loc.start.column;
      break;
    }
  }
  if (u2 == null) return;
  let d2 = x(n2.loc), f2 = x(r2.loc).columns - d2.columns;
  Ra(o2, u2, f2);
}
function Va(e4, t2, n2) {
  if (!m(e4)) return;
  let r2 = e4.items, i2 = r2.indexOf(t2);
  if (i2 < 0) return;
  let a2 = Ia(r2, i2);
  if (!a2) return;
  let o2 = a2.loc.start.column, s2 = a2.loc.start.line, c2 = [La(r2, i2, -1), La(r2, i2, 1)];
  for (let e5 of c2) {
    if (e5 == null) continue;
    let t3 = Ia(r2, e5);
    if (t3 && Math.abs(t3.loc.start.line - s2) === 1 && t3.loc.start.column === o2) {
      Ra(a2, t3.loc.start.column, n2);
      return;
    }
  }
}
function Ha(e4, t2, n2) {
  if (!m(e4) || n2 === 0) return;
  let r2 = e4.items, i2 = r2.indexOf(t2);
  if (i2 < 0) return;
  let a2 = Ia(r2, i2);
  a2 && za(t2, a2);
}
function Ua(e4, t2, n2) {
  if (!u(e4) && !f(e4)) return 0;
  let r2 = x(t2.loc), i2 = n2 > 0, a2 = n2 < e4.items.length, o2 = n2 === e4.items.length, s2 = d(t2) ? t2.comma : false, c2 = i2 && s2 && !a2 && o2;
  return r2.columns + (i2 || a2 ? 2 : 0) + (s2 ? 1 + (c2 ? -1 : 0) : 0);
}
function Wa(e4, n2 = []) {
  for (let i2 of e4.items) {
    if (p(i2)) {
      n2.push(i2);
      continue;
    }
    (t(i2) || r(i2)) && Wa(i2, n2);
  }
  return n2;
}
function Ga(e4, n2 = /* @__PURE__ */ new Set()) {
  for (let i2 of e4.items) {
    if (a(i2) && f(i2.value) && i2.loc.start.line === i2.loc.end.line) {
      n2.add(i2.loc.end.line);
      continue;
    }
    (t(i2) || r(i2)) && Ga(i2, n2);
  }
  return n2;
}
function Ka(e4) {
  for (let n3 of e4.items) (t(n3) || r(n3)) && Ka(n3);
  let n2 = e4.loc.end.line, i2 = e4.loc.end.column, a2 = (e5, t2) => {
    (e5 > n2 || e5 === n2 && t2 > i2) && (n2 = e5, i2 = t2);
  };
  (t(e4) || r(e4)) && a2(e4.key.loc.end.line, e4.key.loc.end.column);
  for (let t2 of e4.items) a2(t2.loc.end.line, t2.loc.end.column);
  e4.loc.end.line = n2, e4.loc.end.column = i2;
}
function qa(e4, t2, n2) {
  let r2 = n2.newLine, i2 = t2.match(/(?:\r\n|\n)+$/u), a2 = i2 ? i2[0] : ``, o2 = a2 ? t2.slice(0, -a2.length) : t2, s2 = o2.length ? o2.split(r2) : [], c2 = Ga(e4), l2 = (e5, t3) => {
    let n3 = e5.lastIndexOf(t3.raw);
    return n3 >= 0 ? n3 : t3.loc.start.column;
  }, u2 = Wa(e4).filter((e5) => {
    let t3 = s2[e5.loc.start.line - 1] || ``, n3 = l2(t3, e5), r3 = t3.slice(0, n3);
    return r3.trim().length > 0 && /\s{2,}$/u.test(r3);
  }).sort((e5, t3) => e5.loc.start.line - t3.loc.start.line), d2 = [], f2 = [];
  for (let e5 of u2) {
    let t3 = f2[f2.length - 1];
    !t3 || e5.loc.start.line === t3.loc.start.line + 1 ? f2.push(e5) : (f2.length > 0 && d2.push(f2), f2 = [e5]);
  }
  f2.length > 0 && d2.push(f2);
  for (let e5 of d2) {
    if (e5.length < 2) continue;
    let t3 = Fa.get(e5[0]) ?? e5[0].loc.start.column, n3 = /* @__PURE__ */ new Map();
    for (let t4 of e5) {
      let e6 = Fa.get(t4) ?? t4.loc.start.column;
      n3.set(e6, (n3.get(e6) || 0) + 1);
    }
    let r3 = 1;
    for (let [e6, i4] of n3) i4 > r3 && (r3 = i4, t3 = e6);
    let i3 = Math.max(...e5.map((e6) => {
      let t4 = s2[e6.loc.start.line - 1] || ``, n4 = l2(t4, e6);
      return t4.slice(0, n4).trimEnd().length;
    })), a3 = Math.min(...e5.map((e6) => {
      let t4 = s2[e6.loc.start.line - 1] || ``, n4 = l2(t4, e6), r4 = t4.slice(0, n4).trimEnd();
      return Math.max(1, n4 - r4.length);
    })), o3 = e5.filter((e6) => Pa.has(e6)), u3 = e5.some((e6) => !c2.has(e6.loc.start.line));
    if (o3.length > 0 && u3) {
      let t4 = Math.min(...e5.map((e6) => {
        if (Pa.has(e6)) return Pa.get(e6) || 1;
        let t5 = s2[e6.loc.start.line - 1] || ``, n4 = l2(t5, e6), r4 = t5.slice(0, n4).trimEnd();
        return Math.max(1, n4 - r4.length);
      }));
      a3 = Math.min(a3, t4);
    }
    if (t3 < i3 + 1) {
      let e6 = i3 + a3;
      t3 = Math.max(t3, e6);
    }
    for (let n4 of e5) {
      let e6 = n4.loc.start.line - 1, r4 = s2[e6] || ``, i4 = l2(r4, n4), a4 = r4.slice(0, i4).trimEnd(), o4 = Math.max(t3, a4.length + 1);
      i4 !== o4 && (s2[e6] = a4 + ` `.repeat(o4 - a4.length) + n4.raw), n4.loc.start.column !== o4 && (n4.loc.start.column = o4, n4.loc.end.column = o4 + n4.raw.length);
    }
  }
  return Ka(e4), s2.join(r2) + a2;
}
function Ja(e4, t2, n2) {
  let r2 = ee(), i2 = Jt(e4), a2 = Array.from(Xe(i2, r2));
  bn(a2, i2);
  let o2 = I(n2, L.autoDetectFormatWithCst(e4, a2));
  if (r2.mixed) {
    let e5 = o2.newLine === `\r
` ? `CRLF` : `LF`;
    console.warn(`toml-patch: Mixed line endings detected. Line endings in the output will be normalized to ${e5}`);
  }
  return ((e5) => o2.leadingBom ? `\uFEFF${e5}` : e5)(eo(a2, t2, o2, n2 instanceof L || n2 != null && Object.prototype.hasOwnProperty.call(n2, `indentWidth`), n2 instanceof L || n2 != null && Object.prototype.hasOwnProperty.call(n2, `trailingComma`)).tomlString);
}
function Ya(e4, t2, n2) {
  let r2 = e4.slice(n2), i2 = 0, a2 = Math.min(r2.length, t2.length);
  for (let e5 = 1; e5 <= a2; e5++) F(r2.slice(r2.length - e5), t2.slice(0, e5)) && (i2 = e5);
  return i2;
}
function Xa(e4, t2, n2) {
  if (n2 === void 0) return;
  let r2 = t2.key.value;
  if (r2.length < 2) return;
  let i2 = r2.slice(0, -1);
  for (let t3 = 0; t3 < e4.items.length; t3++) {
    let o2 = e4.items[t3];
    if (!d(o2) || !a(o2.item)) continue;
    let s2 = o2.item.key.value;
    if (s2.length === r2.length && F(s2.slice(0, -1), i2) && s2[s2.length - 1] === n2) return t3;
  }
}
function Za(e4) {
  let t2 = /* @__PURE__ */ new WeakSet(), n2 = (e5) => {
    t2.add(e5);
  };
  return Gt(e4, { Document: n2, Table: n2, TableKey: n2, TableArray: n2, TableArrayKey: n2, KeyValue: n2, Key: n2, String: n2, Integer: n2, Float: n2, Boolean: n2, DateTime: n2, InlineArray: n2, InlineItem: n2, InlineTable: n2, Comment: n2 }), t2;
}
function Qa(e4, t2, n2, r2) {
  if (!P(t2)) return t2;
  let i2 = q(K(e4, I({ ...n2, inlineTableStart: 0 }, n2)).items, ``, { temporal: r2 });
  if (!P(i2)) return t2;
  let a2 = {};
  for (let e5 of Object.keys(i2)) Object.prototype.hasOwnProperty.call(t2, e5) && (a2[e5] = t2[e5]);
  for (let e5 of Object.keys(t2)) Object.prototype.hasOwnProperty.call(a2, e5) || (a2[e5] = t2[e5]);
  return a2;
}
function $a(e4) {
  let n2 = e4.items;
  for (let e5 = 0; e5 < n2.length; e5++) {
    let i2 = n2[e5];
    if (!((t(i2) || r(i2)) && m(i2))) continue;
    let a2 = i2.items, o2 = a2.length;
    for (; o2 > 0 && p(a2[o2 - 1]); ) o2--;
    if (o2 < a2.length) {
      let t2 = n2[e5 + 1];
      if (t2 && r(t2)) {
        let e6 = i2.key.item.value, r2 = t2.key.item.value;
        if (F(e6, r2.slice(0, e6.length))) {
          let e7 = a2.splice(o2), r3 = n2.indexOf(t2);
          for (let t3 of [...e7].reverse()) n2.splice(r3, 0, t3);
          br(i2);
        }
      }
    }
  }
}
function eo(e4, t2, n2, r2 = false, i2 = true) {
  let a2 = [...e4];
  t2 = no(t2);
  let o2 = Ot(t2), s2 = 1, c2 = 0;
  for (let e5 of a2) {
    let t3 = e5.loc.end;
    (t3.line > s2 || t3.line === s2 && t3.column > c2) && (s2 = t3.line, c2 = t3.column);
  }
  let l2 = q(a2, ``, { temporal: o2 }), u2 = { type: `Document`, loc: { start: { line: 1, column: 0 }, end: { line: s2, column: c2 } }, items: a2 };
  $n(u2, n2.indentWidth);
  let d2 = n2.inlineTableStart != null && n2.inlineTableStart > 1 ? 1 : n2.inlineTableStart, f2 = I({ ...n2, inlineTableStart: d2 }, n2), p2 = K(t2, f2), m2 = q(p2.items, ``, { temporal: o2 }), h2 = n2.updateOrder ? Qa(t2, m2, f2, o2) : m2;
  if (!n2.updateOrder && to(l2, h2)) return { tomlString: Ni(a2, n2), document: u2 };
  let g2 = ro(io(u2, h2, $i(l2, h2, [], { updateOrder: n2.updateOrder, orderSource: t2 })));
  if (g2.length === 0) return { tomlString: Ni(a2, n2), document: u2 };
  let _2 = yo(u2, p2, g2, n2, o2, Za(u2), t2, r2, i2);
  return { tomlString: qa(_2, Pi(_2.items, n2), n2), document: _2 };
}
function to(e4, t2) {
  let n2 = [[e4, t2]];
  for (; n2.length > 0; ) {
    let [e5, t3] = n2.pop();
    if (typeof e5 == `number` && typeof t3 == `number` && (!Number.isFinite(e5) || !Number.isFinite(t3)) || typeof e5 == `number` && typeof t3 == `number` && Number.isNaN(e5) && Number.isNaN(t3)) return false;
    if (Object.is(e5, t3)) continue;
    if (wt(e5) && wt(t3)) {
      if (!zt(e5, t3)) return false;
      continue;
    }
    if (!e5 || !t3 || typeof e5 != `object` || typeof t3 != `object` || Array.isArray(e5) !== Array.isArray(t3)) return false;
    if (!Array.isArray(e5)) {
      let n3 = Object.getPrototypeOf(e5), r3 = Object.getPrototypeOf(t3);
      if (n3 !== Object.prototype && n3 !== null || r3 !== Object.prototype && r3 !== null) return false;
    }
    let r2 = Object.keys(e5), i2 = Object.keys(t3);
    if (r2.length !== i2.length) return false;
    for (let i3 of r2) {
      if (!Object.prototype.hasOwnProperty.call(t3, i3)) return false;
      n2.push([e5[i3], t3[i3]]);
    }
  }
  return true;
}
function no(e4) {
  if (Array.isArray(e4)) {
    let t3 = false, n2 = [];
    for (let r2 = 0; r2 < e4.length; r2++) {
      if (!Object.prototype.hasOwnProperty.call(e4, r2)) {
        t3 = true;
        continue;
      }
      let i2 = no(e4[r2]);
      t3 ||= i2 !== e4[r2], n2.push(i2);
    }
    return t3 ? n2 : e4;
  }
  if (!P(e4)) return e4;
  let t2 = e4;
  for (let n2 of Object.keys(e4)) {
    let r2 = no(e4[n2]);
    r2 !== e4[n2] && (t2 === e4 && (t2 = { ...e4 }), t2[n2] = r2);
  }
  return t2;
}
function ro(e4) {
  for (let t2 = 0; t2 < e4.length; t2++) {
    let n2 = e4[t2];
    if (Y(n2)) {
      let r2 = N(n2.path), i2 = n2.path.slice(0, -1), a2 = t2 + 1;
      for (; a2 < e4.length; ) {
        let o2 = e4[a2];
        if (J(o2)) {
          if (typeof N(o2.path) == `number` && F(i2, o2.path.slice(0, -1))) {
            if (n2.coordinate === `source`) {
              let n3 = -1;
              for (let t3 = a2 + 1; t3 < e4.length; t3++) {
                let r3 = e4[t3];
                if (Y(r3) && r3.coordinate === `source` && F(i2, r3.path.slice(0, -1))) {
                  n3 = t3;
                  break;
                }
              }
              if (n3 !== -1) {
                let r3 = e4.splice(n3, 1)[0];
                e4.splice(t2, 0, r3), t2 = -1;
                break;
              }
            }
            break;
          }
          a2++;
          continue;
        }
        if (Zi(o2) && o2.key === void 0) {
          if (F(i2, o2.path)) break;
          a2++;
          continue;
        }
        if (!Y(o2)) {
          a2++;
          continue;
        }
        let s2 = N(o2.path), c2 = o2.path.slice(0, -1);
        if (typeof r2 == `number` && typeof s2 == `number` && F(i2, c2) && s2 > r2) {
          e4.splice(a2, 1), e4.splice(t2, 0, o2), t2 = -1;
          break;
        }
        a2++;
      }
    }
  }
  return e4;
}
function io(e4, t2, n2) {
  let i2 = /* @__PURE__ */ new Set(), o2 = [], s2 = /* @__PURE__ */ new Map();
  for (let e5 of n2) {
    if (!Y(e5) && !J(e5)) continue;
    let t3 = e5.path.slice(0, -1);
    if (t3.length === 0) continue;
    let n3 = JSON.stringify(t3), r2 = s2.get(n3);
    r2 || (r2 = { path: t3, removes: [], adds: [] }, s2.set(n3, r2)), (Y(e5) ? r2.removes : r2.adds).push(e5);
  }
  for (let t3 of s2.values()) t3.removes.length !== 0 && t3.adds.length !== 0 && (Z(e4, t3.path) || (t3.removes.forEach((e5) => i2.add(e5)), t3.adds.forEach((e5) => i2.add(e5)), o2.push({ type: `Edit`, path: t3.path })));
  for (let t3 of n2) {
    if (i2.has(t3) || !Y(t3) && !J(t3)) continue;
    let r2 = t3.path.slice(0, -1);
    if (r2.length === 0 || typeof N(r2) != `number`) continue;
    let s3 = Z(e4, r2);
    if (!s3 || !d(s3) || !f(s3.item)) continue;
    let c3 = n2.filter((e5) => !i2.has(e5) && (Y(e5) || J(e5)) && F(e5.path.slice(0, -1), r2));
    if (c3.length === 0 || c3.some((e5) => e5.path.length !== r2.length + 1)) continue;
    let l3 = new Set(s3.item.items.filter(d).map((e5) => {
      let t4 = a(e5.item) ? e5.item : void 0;
      return (t4 == null ? void 0 : t4.key.value.length) === 1 ? t4.key.value[0] : void 0;
    }).filter((e5) => e5 !== void 0)), u2 = new Set(c3.filter(Y).map((e5) => N(e5.path)));
    if (c3.some(Y) && c3.some(J) && l3.size === u2.size && ![...l3].some((e5) => !u2.has(e5))) {
      for (let e5 of c3) i2.add(e5);
      o2.push({ type: `Edit`, path: r2 });
    }
  }
  let c2 = /* @__PURE__ */ new Map();
  for (let t3 of n2) {
    if (i2.has(t3) || !Xi(t3) && !J(t3) && !Y(t3) || typeof N(t3.path) != `number`) continue;
    let n3 = t3.path.slice(0, -1);
    if (n3.length === 0) continue;
    let a2 = Z(e4, n3.concat(0));
    a2 && r(a2) && c2.set(JSON.stringify(n3), n3);
  }
  for (let e5 of c2.values()) {
    let r2 = t2;
    for (let t3 of e5) r2 = r2 == null ? void 0 : r2[t3];
    if (!Array.isArray(r2) || r2.every((e6) => P(e6))) continue;
    let a2 = n2.filter((t3) => !i2.has(t3) && (Xi(t3) || J(t3) || Y(t3)) && t3.path.length > e5.length && F(t3.path.slice(0, e5.length), e5));
    if (!(a2.length < 2)) {
      for (let e6 of a2) i2.add(e6);
      o2.push({ type: `Edit`, path: e5 });
    }
  }
  if (i2.size === 0) return n2;
  let l2 = n2.filter((e5) => !i2.has(e5));
  return l2.push(...o2), l2;
}
function ao(e4, t2, n2 = true) {
  return t2.map((t3) => A.test(t3) ? t3 : `"${Fr(t3, e4, `singleline-basic`, n2)}"`).join(`.`);
}
function oo(e4) {
  let t2 = [], n2, r2 = false;
  for (let i2 = 0; i2 < e4.length; i2++) {
    let a2 = e4[i2];
    if (n2) {
      n2 === `"` && r2 ? r2 = false : n2 === `"` && a2 === `\\` ? r2 = true : a2 === n2 && (n2 = void 0);
      continue;
    }
    if (a2 === `"` || a2 === `'`) {
      n2 = a2;
      continue;
    }
    if (a2 !== `.`) continue;
    let o2 = i2;
    for (; o2 > 0 && (e4[o2 - 1] === ` ` || e4[o2 - 1] === `	`); ) o2--;
    let s2 = i2 + 1;
    for (; s2 < e4.length && (e4[s2] === ` ` || e4[s2] === `	`); ) s2++;
    t2.push(e4.slice(o2, s2));
  }
  return t2;
}
function so(e4) {
  let t2 = [], n2 = 0, r2, i2 = false;
  for (let a2 = 0; a2 < e4.length; a2++) {
    let o2 = e4[a2];
    if (r2) {
      r2 === `"` && i2 ? i2 = false : r2 === `"` && o2 === `\\` ? i2 = true : o2 === r2 && (r2 = void 0);
      continue;
    }
    o2 === `"` || o2 === `'` ? r2 = o2 : o2 === `.` && (t2.push(e4.slice(n2, a2)), n2 = a2 + 1);
  }
  return t2.push(e4.slice(n2)), t2;
}
function co(e4, t2) {
  let n2 = oo(t2);
  n2.length !== 0 && (e4.raw = so(e4.raw).reduce((e5, t3, r2) => r2 === 0 ? t3 : `${e5}${n2[Math.min(r2 - 1, n2.length - 1)]}${t3}`, ``), e4.loc.end.column = e4.loc.start.column + e4.raw.length);
}
function lo(e4, t2) {
  let n2;
  return Gt(e4, { KeyValue: (e5) => {
    !n2 && e5.key.value.length > t2.length && F(e5.key.value.slice(0, t2.length), t2) && oo(e5.key.raw).length > 0 && (n2 = e5);
  } }), n2;
}
function uo(e4) {
  let t2 = e4.search(/[eE]/), n2 = t2 === -1 ? e4 : e4.slice(0, t2), r2 = n2.indexOf(`.`), i2 = r2 === -1 ? `` : n2.slice(r2 + 1);
  return { hasExponent: t2 !== -1, fractionLength: i2.length, isRound: !/[1-9]/.test(i2) };
}
function fo(e4) {
  let t2 = e4.search(/[eE]/), n2 = t2 === -1 ? e4 : e4.slice(0, t2), r2 = n2.indexOf(`.`);
  return r2 === -1 ? 0 : n2.length - r2 - 1;
}
function po(e4, t2, n2 = false) {
  let [r2, i2] = e4.toExponential().split(/[eE]/), a2 = Math.max(t2, fo(r2));
  return `${a2 > 0 ? Number(r2).toFixed(a2) : String(Number(r2))}${n2 ? `E` : `e`}${i2.replace(/^\+/, ``)}`;
}
function mo(e4) {
  if (e4.startsWith(`0x`)) return { radix: 16, prefix: `0x` };
  if (e4.startsWith(`0o`)) return { radix: 8, prefix: `0o` };
  if (e4.startsWith(`0b`)) return { radix: 2, prefix: `0b` };
}
function ho(e4) {
  let t2 = e4;
  (t2.startsWith(`+`) || t2.startsWith(`-`)) && (t2 = t2.slice(1)), (t2.startsWith(`0x`) || t2.startsWith(`0o`) || t2.startsWith(`0b`)) && (t2 = t2.slice(2));
  let n2 = t2.lastIndexOf(`_`);
  return n2 === -1 ? void 0 : t2.length - n2 - 1;
}
function go(e4, t2) {
  if (e4.length <= t2) return e4;
  let n2 = ``, r2 = 0;
  for (let i2 = e4.length - 1; i2 >= 0; i2--) n2 = e4[i2] + n2, r2++, r2 === t2 && i2 > 0 && (n2 = `_` + n2, r2 = 0);
  return n2;
}
function _o(e4, t2) {
  let n2 = mo(t2), r2 = ho(t2);
  if (n2) {
    if (typeof e4 == `bigint` ? e4 < 0n : e4 < 0) return;
    let i2 = n2.radix === 16 && /[A-F]/.test(t2), a2 = e4.toString(n2.radix);
    return i2 && (a2 = a2.toUpperCase()), n2.prefix + (r2 ? go(a2, r2) : a2);
  }
  if (r2) {
    let t3 = typeof e4 == `bigint` ? e4 < 0n : e4 < 0, n3 = t3 ? e4.toString().slice(1) : e4.toString();
    return (t3 ? `-` : ``) + go(n3, r2);
  }
}
function vo(e4, t2, n2 = true, r2 = 0) {
  if (o(e4) && o(t2)) {
    let r3 = Wr(t2.value, e4.raw, n2);
    t2.raw = r3.raw, t2.loc = r3.loc;
  }
  if (l(e4) && l(t2)) {
    let n3 = e4.raw, i2 = t2.value;
    if (Et(i2)) {
      let e5 = Dt(i2);
      if (n3.includes(` `) && e5.includes(`T`) && (e5 = e5.replace(`T`, ` `)), /(?:\+00:00|-00:00)/.test(n3) && e5.endsWith(`Z`)) {
        let t3 = n3.match(/([+-]00:00)/)[1];
        e5 = e5.replace(/Z$/, t3);
      }
      e5 = we(e5, r2), t2.raw = e5, t2.loc.end.column = t2.loc.start.column + t2.raw.length;
    } else if (!(Te.IS_TIME_ONLY.test(n3) && i2 instanceof Date && i2.getUTCFullYear() > 1)) {
      let e5 = Te.createDateWithOriginalFormat(i2, n3);
      t2.value = e5, t2.raw = we(e5.toISOString(), r2), t2.loc.end.column = t2.loc.start.column + t2.raw.length;
    }
  }
  if (c(e4) && c(t2) && Number.isNaN(e4.value) && Number.isNaN(t2.value)) {
    let n3 = e4, r3 = t2;
    n3.nanSign && (r3.nanSign = `+`, r3.raw = `+nan`);
  }
  if (s(e4) && t2.type === `Integer`) {
    let n3 = e4, r3 = _o(t2.value, n3.raw);
    if (r3 !== void 0) {
      let e5 = t2;
      e5.raw = r3, e5.loc.end.column = e5.loc.start.column + r3.length;
    }
  }
  if (c(e4) && (t2.type === `Integer` || t2.type === `Float`)) {
    let n3 = e4, r3 = t2.value;
    if (typeof r3 == `number`) {
      let { hasExponent: e5, fractionLength: i2, isRound: a2 } = uo(n3.raw), o2 = Number.isInteger(r3) && !Object.is(r3, -0), s2 = fo(t2.raw), c2;
      if (e5 && Number.isFinite(r3) && !Object.is(r3, -0)) {
        let e6 = n3.raw.includes(`E`);
        c2 = po(r3, o2 ? Math.max(a2 ? i2 : 0, s2) : s2, e6);
      } else o2 && a2 && (c2 = r3.toFixed(Math.max(i2, s2)));
      if (c2 !== void 0) {
        let e6 = t2;
        e6.type = `Float`, e6.raw = c2, e6.loc.end.column = e6.loc.start.column + c2.length;
      }
    }
  }
  if (u(e4) && u(t2)) {
    let n3 = ai(e4);
    if (t2.items.length > 0) {
      let e5 = t2.items[t2.items.length - 1];
      e5.comma !== n3 && (e5.comma = n3, n3 && (t2.loc.end.column += 1));
    }
  }
  if (f(e4) && f(t2)) {
    let n3 = oi(e4);
    if (t2.items.length > 0) {
      let e5 = t2.items[t2.items.length - 1];
      e5.comma !== n3 && (e5.comma = n3, n3 && (t2.loc.end.column += 1));
    }
  }
}
function yo(n2, i2, s2, c2, l2 = false, g2 = /* @__PURE__ */ new WeakSet(), _2 = void 0, v2 = false, y2 = true) {
  let b2 = /* @__PURE__ */ new Map(), S2 = /* @__PURE__ */ new Set();
  function C2(e4) {
    let t2 = n2.items, r2 = t2.indexOf(e4);
    if (r2 > 0) {
      let n3 = t2[r2 - 1];
      p(n3) && n3.loc.end.line + 1 === e4.loc.start.line && S2.add(e4);
    }
  }
  let w2 = /* @__PURE__ */ new WeakMap();
  function T2(e4) {
    let i3 = w2.get(e4);
    if (i3 !== void 0) return i3;
    let o2 = {};
    function s3(n3, i4) {
      if (n3 === e4) return i4;
      if (a(n3)) return s3(n3.value, i4);
      if (d(n3)) return s3(n3.item, i4);
      if (m(n3)) for (let e5 = 0; e5 < n3.items.length; e5++) {
        let c4 = n3.items[e5], l3 = [];
        if (a(c4)) l3 = c4.key.value;
        else if (t(c4) || r(c4)) {
          if (l3 = c4.key.item.value, r(c4)) {
            let e6 = Bt(l3);
            o2[e6] = (o2[e6] ?? -1) + 1, l3 = l3.concat(o2[e6]);
          }
        } else d(c4) && (l3 = a(c4.item) ? c4.item.key.value : [e5]);
        let u2 = s3(c4, l3.length ? i4.concat(l3) : i4);
        if (u2) return u2;
      }
    }
    let c3 = s3(n2, []);
    return c3 !== void 0 && w2.set(e4, c3), c3;
  }
  function E2(e4, t2) {
    let n3 = a(e4) ? e4 : d(e4) && a(e4.item) ? e4.item : void 0;
    if (!n3) return false;
    let r2 = n3.key.value.length;
    return r2 > t2.length || !F(n3.key.value, t2.slice(t2.length - r2));
  }
  function D2(e4, i3) {
    let o2 = e4.key.item.value.concat(i3);
    return e4.items.some((e5) => a(e5) && e5.key.value.length > i3.length && F(e5.key.value.slice(0, i3.length), i3)) ? true : n2.items.some((e5) => {
      if (!t(e5) && !r(e5)) return false;
      let n3 = e5.key.item.value;
      return n3.length > o2.length && F(n3.slice(0, o2.length), o2);
    });
  }
  function O2(e4, t2) {
    let n3 = [], r2 = false;
    for (let i4 of e4.items) {
      if (!a(i4) || !f(i4.value) || !D2(t2, i4.key.value)) {
        n3.push(i4);
        continue;
      }
      let e5 = [];
      for (let t3 of i4.value.items) {
        if (!d(t3) || !a(t3.item)) continue;
        let n4 = q([t3.item], ``, { temporal: l2 });
        for (let e6 of t3.item.key.value) n4 = n4 == null ? void 0 : n4[e6];
        let r3 = Po(n4, c2);
        r3 !== void 0 && e5.push(Br(i4.key.value.concat(t3.item.key.value), r3));
      }
      e5.length > 0 ? (n3.push(...e5), r2 = true) : n3.push(i4);
    }
    if (!r2) return e4;
    let i3 = Rr(e4.key.item.value, c2.escapeSequenceUpperCase);
    for (let e5 of n3) B(i3, i3, e5);
    return H(i3), i3;
  }
  function k2(e4, t2) {
    function n3(e5) {
      if (a(e5)) return n3(e5.value);
      if (d(e5)) return n3(e5.item);
      if (!m(e5)) return;
      let r2 = e5.items;
      for (let n4 of r2) if (n4 === t2 || d(n4) && n4.item === t2) return e5;
      for (let e6 of r2) {
        let t3 = n3(d(e6) ? e6.item : e6);
        if (t3) return t3;
      }
    }
    return n3(e4);
  }
  function j2(e4, t2, r2, i3) {
    let a2 = t2.concat(e4.key.value), o2 = e4.key.raw;
    e4.key.value = a2, e4.key.raw = a2.map((e5) => A.test(e5) ? e5 : JSON.stringify(e5).replace(/\x7f/g, `\\u007f`)).join(`.`);
    let s3 = e4.key.raw.length - o2.length;
    e4.key.loc.end.column = e4.key.loc.start.column + e4.key.raw.length, e4.equals += s3, U(e4.value, { lines: 0, columns: s3 }, { first_line_only: true }), e4.loc.end.line === e4.loc.start.line && (e4.loc.end.column += s3), pr(n2, i3, r2, e4), Co(n2, e4);
  }
  function ee2(e4, t2) {
    let n3 = e4.key.item, r2 = n3.raw, i3 = t2.concat(n3.value), a2 = i3.map((e5) => A.test(e5) ? e5 : JSON.stringify(e5).replace(/\x7f/g, `\\u007f`)).join(`.`), o2 = a2.length - r2.length;
    n3.value = i3, n3.raw = a2, n3.loc.end.column = n3.loc.start.column + a2.length, e4.key.loc.end.line === e4.key.loc.start.line && (e4.key.loc.end.column += o2);
  }
  function te2(e4, t2, r2, i3) {
    ee2(e4, t2), pr(n2, i3, r2, e4);
  }
  function ne2(e4, t2, r2) {
    let i3 = Z(n2, e4);
    if (i3 && !E2(i3, e4)) return null;
    let a2 = e4.length;
    for (; a2 > 0; ) {
      let t3 = Z(n2, e4.slice(0, a2));
      if (t3 && !E2(t3, e4.slice(0, a2))) break;
      a2--;
    }
    let o2 = e4.slice(a2);
    if (o2.length === 0 || !o2.every((e5) => typeof e5 == `string`)) return null;
    if (_2 !== void 0) {
      let e5 = _2;
      for (let t3 of r2) e5 = e5 == null ? void 0 : e5[t3];
      if (e5 !== void 0) {
        let n3 = Po(e5, c2);
        if (n3 !== void 0) return Br([...o2, ...t2.key.value], n3, false, c2.escapeSequenceUpperCase);
      }
    }
    let s3 = t2.key, l3 = [...o2, ...s3.value].map((e5) => A.test(e5) ? e5 : JSON.stringify(e5).replace(/\x7f/g, `\\u007f`)).join(`.`), u2 = l3.length - s3.raw.length;
    return s3.raw = l3, s3.value = [...o2, ...s3.value], s3.loc.end.column = s3.loc.start.column + l3.length, t2.equals += u2, U(t2.value, { lines: 0, columns: u2 }, { first_line_only: true }), t2.loc.end.line === t2.loc.start.line && (t2.loc.end.column += u2), t2;
  }
  let M2 = /* @__PURE__ */ new Set(), re2 = /* @__PURE__ */ new Set(), ie2 = /* @__PURE__ */ new WeakMap();
  function ae2(e4, t2) {
    return ie2.get(e4) ?? t2;
  }
  let oe2 = [], se2 = /* @__PURE__ */ new Set(), ce2 = [];
  function le2(e4, t2, r2) {
    if (!u(e4) && !f(e4) || !d(r2) || f(e4) && !a(r2.item)) return r2;
    let i3 = _2;
    for (let e5 of t2) i3 = i3 == null ? void 0 : i3[e5];
    if (!Array.isArray(i3) && !P(i3)) return r2;
    let o2 = qn(n2, e4) ?? 0, s3 = Cr(e4) || e4.items.length === 0 && e4.loc.end.line > e4.loc.start.line, l3 = v2 ? c2.indentWidth : u(e4) && e4.items.length === 0 ? Math.max(c2.indentWidth, 4) : c2.indentWidth;
    u(e4) && e4.items.length === 0 && !c2.useTabsForIndentation && er(e4, Math.max(l3, 4));
    let p2 = Array.isArray(i3) ? `array` : `table`, m2 = e4.items.map((t3) => f(e4) && a(t3.item) ? t3.item.value : t3.item).find((e5) => p2 === `array` ? u(e5) : f(e5)), h2 = m2 && p2 === `array` ? ai(m2) : m2 && p2 === `table` ? oi(m2) : false, g3 = m2, b3 = g3 && g3.items.length > 0 ? g3.items[0].loc.start.column - g3.loc.start.column > 1 : void 0, x2 = Fn(p2, o2 + 1, s3, c2), S3 = p2 === `array` ? `multilineArray` : `multilineTable`, C3 = I({ ...c2, inlineTableStart: 0, [S3]: x2, trailingComma: y2 ? c2.trailingComma : h2, bracketSpacing: b3 ?? c2.bracketSpacing, indentWidth: l3 }, c2), w3 = K({ tmp: i3 }, C3, o2 + 1, s3).items[0];
    if (!w3 || !a(w3)) return r2;
    let T3 = w3.value;
    if (x2 && (u(T3) || f(T3))) {
      let e5 = T3.loc.start.column;
      T3.loc.start.column = 0, T3.loc.end.line === T3.loc.start.line ? T3.loc.end.column -= e5 : Fn(u(T3) ? `array` : `table`, o2 + 1, s3, C3) && (T3.loc.end.column = 1);
    }
    if (f(e4)) {
      let e5 = G(Br(r2.item.key.value, T3, false, c2.escapeSequenceUpperCase));
      return e5.comma = r2.comma, e5;
    }
    let E3 = G(T3);
    return e4.items.length === 0 && u(e4) && f(T3) && (E3.comma = true), E3;
  }
  function ue2(e4, t2, r2) {
    let i3 = d(t2) ? t2.item : t2;
    if (!u(i3) && !f(i3)) return t2;
    let o2 = _2;
    for (let e5 of r2) o2 = o2 == null ? void 0 : o2[e5];
    if (!Array.isArray(o2) && !P(o2)) return t2;
    let s3 = Jn(n2, e4), l3 = s3 ? qn(n2, s3) ?? 0 : -1, p2 = s3 ? Cr(s3) || s3.items.length === 0 && s3.loc.end.line > s3.loc.start.line : false, m2 = Array.isArray(o2) ? `array` : `table`, h2 = m2 === `array` ? c2.multilineArray : c2.multilineTable, g3 = Fn(m2, l3 + 1, p2, c2), v3 = d(e4) ? e4.item : e4, b3 = u(v3) || f(v3) ? v3 : void 0, x2 = u(v3) ? `array` : f(v3) ? `table` : void 0, S3 = b3 !== void 0 && x2 !== m2 && Kn(b3) && h2 === `auto`;
    if (!(g3 || S3)) return t2;
    let C3 = m2 === `array` ? `multilineArray` : `multilineTable`, w3 = I({ ...c2, inlineTableStart: 0, [C3]: true, trailingComma: y2 ? c2.trailingComma : false }, c2), T3 = K({ tmp: o2 }, w3, l3 + 1, p2).items[0];
    if (!T3 || !a(T3)) return t2;
    let E3 = T3.value;
    if (u(E3) || f(E3)) {
      let t3 = d(e4) ? e4.item.loc.start.column : e4.loc.start.column;
      E3.loc.end.line === E3.loc.start.line ? E3.loc.end.column += t3 - E3.loc.start.column : E3.loc.end.column = 1, E3.loc.start.column = t3;
    }
    if (d(t2)) {
      let e5 = G(E3);
      return e5.comma = t2.comma, e5;
    }
    return E3;
  }
  s2.forEach((s3) => {
    if (J(s3)) {
      var v3;
      let o2 = X(i2, s3.path), h2 = s3.path.slice(0, -1), g3 = N(s3.path), _3 = r(o2);
      if (bt(g3) && !_3 && !bt(N(h2))) {
        let e4 = Z(n2, h2.concat(0));
        e4 && r(e4) && (_3 = true);
      }
      if (_3 && bt(g3) && !bt(N(h2))) {
        let e4 = Z(n2, h2), t2 = e4 && a(e4) ? e4.value : e4;
        if (t2 && u(t2)) {
          let e5 = q(i2.items, ``, { temporal: l2 });
          for (let t3 of s3.path) e5 = e5 == null ? void 0 : e5[t3];
          let r2 = I({ ...c2, inlineTableStart: 0 }, c2), u2 = e5 === void 0 ? void 0 : K({ tmp: e5 }, r2), p2 = u2 == null ? void 0 : u2.items[0];
          if (p2 && a(p2) && (o2 = G(p2.value), _3 = false, d(o2) && f(o2.item) && o2.item.items.length > 0)) {
            let e6 = o2.item;
            if (!(e6.items[0].loc.start.column - e6.loc.start.column > 1)) {
              let r3 = t2.items.map((e7) => e7.item).find((e7) => f(e7) && e7.items.length > 0);
              r3 && r3.items[0].loc.start.column - r3.loc.start.column > 1 && xr(n2, e6, true);
            }
          }
        }
      }
      if (_3 && !r(o2)) {
        let e4 = h2.filter((e5) => typeof e5 == `string`), n3 = q(i2.items, ``, { temporal: l2 });
        for (let e5 of s3.path) n3 = n3 == null ? void 0 : n3[e5];
        if (n3 !== void 0) {
          let i3 = Rr(e4, c2.escapeSequenceUpperCase), a2 = K(n3, c2);
          for (let e5 of a2.items) B(i3, i3, e5, void 0);
          let s4 = (n4) => {
            if (m(n4)) for (let i4 of n4.items) {
              if (!t(i4) && !r(i4)) continue;
              let n5 = i4.key, a3 = n5.item, o3 = e4.concat(a3.value);
              a3.value = o3, a3.raw = Ur(o3, c2.escapeSequenceUpperCase).raw, a3.loc.start.column = n5.loc.start.column + 1, a3.loc.end.column = a3.loc.start.column + a3.raw.length, n5.loc.end.column = a3.loc.start.column + a3.raw.length + 1, s4(i4);
            }
          };
          s4(i3), H(i3), o2 = i3;
        }
      }
      let y3;
      if (t(o2)) y3 = n2;
      else if (_3) {
        y3 = n2;
        let e4 = n2, i3 = Z(e4, h2.concat(g3 - 1)), a2 = Z(e4, h2.concat(g3));
        if (a2) g3 = e4.items.indexOf(a2);
        else if (i3) {
          if (g3 = e4.items.indexOf(i3) + 1, r(i3)) {
            let n3 = i3.key.item.value, a3 = g3 - 1;
            for (let i4 = g3; i4 < e4.items.length; i4++) {
              let o3 = e4.items[i4], s4 = t(o3) || r(o3) ? o3.key.item.value : void 0;
              s4 && s4.length > n3.length && F(s4.slice(0, n3.length), n3) && (a3 = i4);
            }
            g3 = a3 + 1, r(o2) && (o2 = O2(o2, i3));
          }
        } else g3 = e4.items.length;
      } else {
        y3 = n2;
        for (let e4 = s3.path.length - 1; e4 >= 0; e4--) {
          let t2 = Z(n2, s3.path.slice(0, e4));
          if (t2 && !E2(t2, s3.path.slice(0, e4))) {
            y3 = t2;
            break;
          }
        }
        a(y3) ? y3 = y3.value : d(y3) && a(y3.item) ? y3 = y3.item.value : (d(y3) && f(y3.item) || d(y3) && u(y3.item)) && (y3 = y3.item);
      }
      if ((u(y3) || f(y3)) && (o2 = le2(y3, s3.path, o2), wi(y3, o2, c2.indentWidth)), u(y3)) {
        let e4 = Z(n2, h2), t2 = Z(n2, h2.slice(0, -1));
        if (e4 && a(e4) && t2) {
          let n3 = Ua(y3, o2, g3);
          n3 !== 0 && Va(t2, e4, n3);
        }
      }
      let b3 = (u(y3) || f(y3)) && y3.loc.end.line > y3.loc.start.line;
      b3 && re2.has(y3) && H(n2);
      let x2 = u(y3) || f(y3) ? (v3 = Sa(n2, y3)) == null ? void 0 : v3.items : void 0;
      if (r(y3) || u(y3) || e(y3)) {
        if (u(y3)) {
          let e4 = ae2(y3, ai(y3));
          if (d(o2)) {
            let t2 = y3.items.length === 0 && f(o2.item) && Cr(o2.item);
            o2.comma = t2 || e4;
            let n3 = o2, r2 = f(n3.item) ? n3.item : void 0, u2 = r2 && r2.items.length > 0 ? y3.items.map((e5) => e5.item).find((e5) => e5 !== n3.item && f(e5)) : void 0;
            if (r2 && u2) {
              let e5 = oi(u2);
              if (e5 !== oi(r2)) {
                let t3 = q(i2.items, ``, { temporal: l2 });
                for (let e6 of s3.path) t3 = t3 == null ? void 0 : t3[e6];
                let r3 = I({ ...c2, inlineTableStart: 0, trailingComma: e5 }, c2), u3 = t3 === void 0 ? void 0 : K({ tmp: t3 }, r3).items[0];
                if (u3 && a(u3)) {
                  let e6 = G(u3.value);
                  e6.comma = n3.comma, o2 = e6;
                }
              }
            }
          }
        }
        if (c2.inlineTableStart !== void 0 && c2.inlineTableStart > 0 && e(y3) && t(o2)) {
          let e4 = Mo(o2, n2, c2);
          B(n2, y3, o2, g3);
          for (let t2 of e4) B(n2, n2, t2, void 0);
        } else {
          let i3 = o2;
          d(o2) && (r(y3) || e(y3)) && (i3 = o2.item);
          let c3 = g3;
          if (e(y3) && a(i3)) {
            let e4 = y3.items.findIndex((e5) => t(e5) || r(e5));
            e4 !== -1 && (c3 = e4);
          }
          let l3 = false;
          if ((r(y3) || e(y3)) && a(i3)) {
            let e4 = ne2(h2, i3, s3.path);
            e4 && (M2.has(y3) && H(n2), i3 = e4, l3 = true);
          }
          if (u(y3) && y3.items.length === 0 && H(n2), c3 === 0 && u(y3) && dr(n2).has(y3) && H(n2), c3 === 0 && (e(y3) || t(y3) || r(y3)) && dr(n2).has(y3) && H(n2), a(i3) && i3.key.value.length > 1) {
            let e4 = lo(n2, i3.key.value.slice(0, -1));
            if (e4) {
              let t2 = i3.equals;
              co(i3.key, e4.key.raw), i3.equals = i3.key.loc.end.column + e4.equals - e4.key.loc.end.column;
              let n3 = i3.equals - t2;
              U(i3.value, { lines: 0, columns: n3 }, { first_line_only: true }), i3.loc.end.line === i3.loc.start.line && (i3.loc.end.column += n3);
            }
          }
          B(n2, y3, i3, c3, void 0, x2), l3 && M2.add(y3);
        }
      } else if (f(y3)) {
        y3.items.length === 0 && (H(n2), ar(y3) && y3.loc.end.line > y3.loc.start.line && (y3.loc.end.line = y3.loc.start.line));
        let e4 = ae2(y3, oi(y3));
        if (a(o2)) {
          let t2 = G(o2);
          t2.comma = e4;
          let r2 = Xa(y3, o2, s3.before);
          B(n2, y3, t2, r2, void 0, x2);
        } else if (d(o2) && a(o2.item)) {
          let t2 = o2.item, r2 = ne2(h2, t2, s3.path);
          r2 && (M2.has(y3) && H(n2), t2 = r2);
          let i3 = G(t2);
          i3.comma = e4;
          let a2 = Xa(y3, t2, s3.before);
          B(n2, y3, i3, a2, void 0, x2), r2 && M2.add(y3);
        } else B(n2, y3, o2, void 0, void 0, x2);
      } else if (c2.inlineTableStart !== void 0 && c2.inlineTableStart > 0 && a(o2) && f(o2.value) && t(y3)) gi([...y3.key.item.value, ...o2.key.value]) < c2.inlineTableStart ? No(o2, y3, n2, c2) : B(n2, y3, o2);
      else if (c2.inlineTableStart === 0 && a(o2) && f(o2.value) && e(y3)) B(n2, y3, o2, void 0, true);
      else {
        let i3 = o2;
        d(o2) && (t(y3) || r(y3) || e(y3)) && (i3 = o2.item);
        let c3 = false;
        if (t(y3) && a(i3)) {
          let e4 = ne2(h2, i3, s3.path);
          e4 && (M2.has(y3) && H(n2), i3 = e4, c3 = true);
        }
        let l3 = (t(y3) || r(y3)) && y3.items.length > 0 && y3.items.every(p) ? 2 : void 0;
        B(n2, y3, i3, void 0, void 0, void 0, l3), c3 && M2.add(y3);
      }
      b3 && re2.add(y3);
    } else if (Xi(s3)) {
      let p2 = Z(n2, s3.path), h2;
      try {
        h2 = X(i2, s3.path);
      } catch {
        h2 = void 0;
      }
      if (!p2 || !h2) {
        To(n2, i2, s3, c2, l2, g2, S2);
        return;
      }
      if (a(p2) && t(h2)) {
        let e4 = h2.key.item.value;
        if ($(n2, e4).some((e5) => e5 !== p2)) {
          To(n2, i2, s3, c2, l2, g2, S2);
          return;
        }
      }
      if (d(p2) && (t(h2) || r(h2))) {
        let e4 = Z(n2, s3.path.slice(0, -1)), t2 = e4 && a(e4) ? e4.value : e4;
        if (t2 && u(t2)) {
          let e5 = _2;
          for (let t3 of s3.path) e5 = e5 == null ? void 0 : e5[t3];
          if (e5 !== void 0) {
            let t3 = I({ ...c2, inlineTableStart: 0 }, c2), n3 = K({ tmp: e5 }, t3), r2 = n3 == null ? void 0 : n3.items[0];
            r2 && a(r2) && (h2 = G(r2.value));
          }
        }
      }
      let v4, y3 = Z(n2, s3.path.slice(0, -1));
      y3 && a(y3) && E2(y3, s3.path.slice(0, -1)) && (y3 = k2(n2, y3));
      let b3 = Fo(n2, s3.path);
      if (a(p2) && a(h2)) {
        let i3 = false;
        if (p2.key.value.length > 1) {
          let o2 = T2(p2), c3 = Ya(s3.path, p2.key.value, o2 ? o2.length - p2.key.value.length : 0);
          if (c3 > 0 && c3 < p2.key.value.length) {
            p2.key.value = p2.key.value.slice(0, c3), p2.key.raw = Ur(p2.key.value).raw;
            let o3 = p2.key.loc.end.column, s4 = p2.key.loc.start.column + p2.key.raw.length, l3 = s4 - o3;
            p2.key.loc.end.column = s4, p2.equals += l3, p2.value.loc.start.column += l3, p2.value.loc.end.line === p2.value.loc.start.line && (p2.value.loc.end.column += l3), p2.loc.end.line === p2.loc.start.line && (p2.loc.end.column += l3), i3 = true;
            let u2 = p2.key.value;
            if (y3 && (t(y3) || e(y3) || r(y3))) {
              let e4 = [...y3.items];
              for (let i4 = e4.length - 1; i4 >= 0; i4--) {
                let o4 = e4[i4];
                if (o4 === p2) continue;
                let s5 = a(o4) ? o4.key.value : t(o4) || r(o4) ? o4.key.item.value : void 0;
                s5 && s5.length >= u2.length && F(s5.slice(0, u2.length), u2) && Q(n2, y3, o4);
              }
            }
          }
        }
        if (!i3 && a(h2) && y3 && (t(y3) || e(y3) || r(y3)) && Lo(n2, y3, p2.key.value, p2), vo(p2.value, h2.value, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0), y3 && Ba(y3, p2, p2.value, h2.value), v4 = p2, p2 = p2.value, h2 = h2.value, i3 && _2 !== void 0) {
          let e4 = _2;
          for (let t2 of s3.path) e4 = e4 == null ? void 0 : e4[t2];
          if (e4 !== void 0) {
            let t2 = Po(e4, c2);
            t2 !== void 0 && (h2 = t2, vo(p2, h2, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0));
          }
        }
      } else if (a(p2) && d(h2) && a(h2.item)) {
        let i3 = false;
        if (p2.key.value.length > 1) {
          let o2 = T2(p2), c3 = Ya(s3.path, p2.key.value, o2 ? o2.length - p2.key.value.length : 0);
          if (c3 > 0 && c3 < p2.key.value.length) {
            p2.key.value = p2.key.value.slice(0, c3), p2.key.raw = Ur(p2.key.value).raw;
            let o3 = p2.key.loc.end.column, s4 = p2.key.loc.start.column + p2.key.raw.length, l3 = s4 - o3;
            p2.key.loc.end.column = s4, p2.equals += l3, p2.value.loc.start.column += l3, p2.value.loc.end.line === p2.value.loc.start.line && (p2.value.loc.end.column += l3), p2.loc.end.line === p2.loc.start.line && (p2.loc.end.column += l3), i3 = true;
            let u2 = p2.key.value;
            if (y3 && (t(y3) || e(y3) || r(y3))) {
              let e4 = [...y3.items];
              for (let i4 = e4.length - 1; i4 >= 0; i4--) {
                let o4 = e4[i4];
                if (o4 === p2) continue;
                let s5 = a(o4) ? o4.key.value : t(o4) || r(o4) ? o4.key.item.value : void 0;
                s5 && s5.length >= u2.length && F(s5.slice(0, u2.length), u2) && Q(n2, y3, o4);
              }
            }
          }
        }
        if (!i3 && a(h2.item) && y3 && (t(y3) || e(y3) || r(y3)) && Lo(n2, y3, p2.key.value, p2), v4 = p2, p2 = p2.value, h2 = h2.item.value, i3 && _2 !== void 0) {
          let e4 = _2;
          for (let t2 of s3.path) e4 = e4 == null ? void 0 : e4[t2];
          if (e4 !== void 0) {
            let t2 = Po(e4, c2);
            t2 !== void 0 && (h2 = t2);
          }
        }
      } else if (d(p2) && a(p2.item) && a(h2)) {
        let e4 = p2.item, i3 = false;
        if (e4.key.value.length > 1) {
          let o2 = T2(e4), l3 = Ya(s3.path, e4.key.value, o2 ? o2.length - e4.key.value.length : 0);
          if (l3 > 0 && l3 < e4.key.value.length) {
            e4.key.value = e4.key.value.slice(0, l3), e4.key.raw = Ur(e4.key.value, c2.escapeSequenceUpperCase).raw;
            let o3 = e4.key.loc.end.column, s4 = e4.key.loc.start.column + e4.key.raw.length, u2 = s4 - o3;
            e4.key.loc.end.column = s4, e4.equals += u2, e4.value.loc.start.column += u2, e4.value.loc.end.line === e4.value.loc.start.line && (e4.value.loc.end.column += u2), e4.loc.end.line === e4.loc.start.line && (e4.loc.end.column += u2), e4.loc.end.line === e4.loc.start.line && sr(n2, e4, { lines: 0, columns: u2 }), i3 = true;
            let f2 = e4.key.value, h3 = y3;
            if (h3 && d(h3) && (h3 = h3.item), h3 && a(h3) && (h3 = h3.value), h3 && m(h3)) {
              let e5 = [...h3.items];
              for (let i4 = e5.length - 1; i4 >= 0; i4--) {
                let o4 = e5[i4];
                if (o4 === p2) continue;
                let s5 = a(o4) ? o4.key.value : d(o4) && a(o4.item) ? o4.item.key.value : t(o4) || r(o4) ? o4.key.item.value : void 0;
                s5 && s5.length >= f2.length && F(s5.slice(0, f2.length), f2) && Q(n2, h3, o4);
              }
            }
          }
        }
        if (vo(e4.value, h2.value, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0), v4 = e4, p2 = e4.value, h2 = h2.value, i3 && _2 !== void 0) {
          let e5 = _2;
          for (let t2 of s3.path) e5 = e5 == null ? void 0 : e5[t2];
          if (e5 !== void 0) {
            let t2 = Po(e5, c2);
            t2 !== void 0 && (h2 = t2, vo(p2, h2, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0));
          }
        }
      } else if (d(p2) && d(h2) && a(p2.item) && a(h2.item)) {
        let e4 = false, i3 = p2.item;
        if (i3.key.value.length > 1) {
          let o2 = T2(i3), l3 = Ya(s3.path, i3.key.value, o2 ? o2.length - i3.key.value.length : 0);
          if (l3 > 0 && l3 < i3.key.value.length) {
            i3.key.value = i3.key.value.slice(0, l3), i3.key.raw = Ur(i3.key.value, c2.escapeSequenceUpperCase).raw;
            let o3 = i3.key.loc.end.column, s4 = i3.key.loc.start.column + i3.key.raw.length, u2 = s4 - o3;
            i3.key.loc.end.column = s4, i3.equals += u2, i3.value.loc.start.column += u2, i3.value.loc.end.line === i3.value.loc.start.line && (i3.value.loc.end.column += u2), i3.loc.end.line === i3.loc.start.line && (i3.loc.end.column += u2), i3.loc.end.line === i3.loc.start.line && sr(n2, i3, { lines: 0, columns: u2 }), e4 = true;
            let f2 = i3.key.value, h3 = y3;
            if (h3 && d(h3) && (h3 = h3.item), h3 && a(h3) && (h3 = h3.value), h3 && m(h3)) {
              let e5 = [...h3.items];
              for (let i4 = e5.length - 1; i4 >= 0; i4--) {
                let o4 = e5[i4];
                if (o4 === p2) continue;
                let s5 = a(o4) ? o4.key.value : d(o4) && a(o4.item) ? o4.item.key.value : t(o4) || r(o4) ? o4.key.item.value : void 0;
                s5 && s5.length >= f2.length && F(s5.slice(0, f2.length), f2) && Q(n2, h3, o4);
              }
            }
          }
        }
        if (vo(i3.value, h2.item.value, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0), v4 = i3, p2 = i3.value, h2 = h2.item.value, e4 && _2 !== void 0) {
          let e5 = _2;
          for (let t2 of s3.path) e5 = e5 == null ? void 0 : e5[t2];
          if (e5 !== void 0) {
            let t2 = Po(e5, c2);
            t2 !== void 0 && (h2 = t2, vo(p2, h2, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0));
          }
        }
      } else if (t(p2)) {
        let o2 = q(i2.items, ``, { temporal: l2 });
        for (let e4 of s3.path) o2 = o2 == null ? void 0 : o2[e4];
        if (o2 !== void 0) {
          let i3 = p2.key.item.value, l3 = i3.slice(-1), u2 = i3.slice(0, -1), d2 = k2(n2, p2) ?? oa(n2, s3.path);
          if (e(d2)) {
            let e4 = $(n2, i3).filter((e5) => e5 !== p2 && (t(e5) || r(e5)));
            for (let t2 of e4) Q(n2, d2, t2);
          }
          let f2 = K({ [l3[0]]: o2 }, c2), m2 = f2.items[0];
          if (u2.length > 0) {
            if (t(m2) || r(m2)) te2(m2, u2, p2, d2), g2.add(m2);
            else if ($(n2, u2).some(a)) j2(m2, u2, p2, d2), g2.add(m2);
            else {
              let e4 = n2.items.find((e5) => e5 !== p2 && (t(e5) || r(e5)) && F(e5.key.item.value, u2));
              if (e4) B(n2, e4, m2, void 0), Q(n2, d2, p2), g2.add(m2);
              else {
                let e5 = W(u2, c2.escapeSequenceUpperCase);
                S2.add(e5), B(n2, e5, m2, 0), pr(n2, d2, p2, e5), g2.add(e5);
              }
            }
          } else pr(n2, d2, p2, m2), g2.add(m2), Co(n2, m2);
          if (f2.items.length > 1) for (let e4 = 1; e4 < f2.items.length; e4++) {
            let t2 = f2.items[e4];
            u2.length > 0 && ee2(t2, u2);
            let r2 = e4 === 1 ? m2 : f2.items[e4 - 1];
            B(n2, d2, t2, d2.items.indexOf(r2) + 1), g2.add(t2);
          }
          return;
        }
        v4 = oa(n2, s3.path);
      } else if (r(p2)) {
        let o2 = q(i2.items, ``, { temporal: l2 }), u2 = p2.key.item.value, d2 = o2, f2 = typeof s3.path[s3.path.length - 1] == `number` ? s3.path.slice(0, -1) : s3.path;
        for (let e4 of f2) d2 = d2 == null ? void 0 : d2[e4];
        if (d2 !== void 0) {
          let i3 = u2.slice(-1), o3 = u2.slice(0, -1), l3 = k2(n2, p2) ?? oa(n2, s3.path), f3 = K({ [i3[0]]: d2 }, c2).items[0];
          if (Array.isArray(d2) && !d2.every((e4) => P(e4))) {
            let e4 = $(n2, u2).filter((e5) => e5 !== p2 && (t(e5) || r(e5)));
            for (let t2 of e4) Q(n2, n2, t2);
          }
          if (o3.length > 0) {
            if (t(f3) || r(f3)) te2(f3, o3, p2, l3), g2.add(f3);
            else {
              let r2 = e(l3) ? l3.items.find((e4) => t(e4) && F(e4.key.item.value, o3)) : void 0;
              if (r2) {
                let e4 = r2.items.find((e5) => a(e5) && F(e5.key.value, f3.key.value));
                e4 ? pr(n2, r2, e4, f3) : B(n2, r2, f3, void 0), Q(n2, l3, p2), g2.add(r2);
                return;
              }
              if ($(n2, o3).some(a)) j2(f3, o3, p2, l3), g2.add(f3);
              else {
                let e4 = W(o3, c2.escapeSequenceUpperCase);
                S2.add(e4), B(n2, e4, f3, 0), pr(n2, l3, p2, e4), g2.add(e4);
              }
            }
          } else pr(n2, l3, p2, f3), g2.add(f3), Co(n2, f3);
          return;
        }
        v4 = oa(n2, s3.path);
      } else if (v4 = oa(n2, s3.path), a(v4)) {
        let e4 = X(n2, s3.path.slice(0, -1));
        a(e4) && u(e4.value) && (v4 = e4.value);
      } else d(v4) && a(v4.item) ? v4 = v4.item.value : (d(v4) && f(v4.item) || d(v4) && u(v4.item)) && (v4 = v4.item);
      if (d(p2) && d(h2) && (o(p2.item) && o(h2.item) && (vo(p2.item, h2.item, c2.escapeSequenceUpperCase, c2.minimumTimeDecimals ?? 0), h2.loc = { start: { ...h2.item.loc.start }, end: { ...h2.item.loc.end } }), h2.comma = p2.comma), b3) {
        let e4 = x(p2.loc), t2 = x(h2.loc).columns - e4.columns;
        t2 !== 0 && Ha(b3.container, b3.row, t2);
      }
      h2 = ue2(p2, h2, s3.path), pr(n2, v4, p2, h2), u(h2) && se2.add(h2), (u(h2) || f(h2)) && (H(n2), mi(h2, c2.indentWidth), ce2.push({ owner: v4, container: h2 })), e(v4) && a(p2) && (t(h2) || r(h2)) && wo(n2, h2);
    } else if (Y(s3)) {
      let o2 = Z(n2, s3.path);
      if (o2) {
        let l3 = oa(n2, s3.path);
        if (l3 === o2 && (l3 = oa(n2, s3.path.slice(0, -1))), l3 === o2) {
          let e4 = Sa(n2, o2);
          e4 && (l3 = e4);
        }
        a(l3) && (l3 = l3.value), d(l3) && a(l3.item) && (l3 = l3.item.value), d(l3) && f(l3.item) && (l3 = l3.item), d(l3) && u(l3.item) && (l3 = l3.item), (!m(l3) || !l3.items.includes(o2)) && (l3 = k2(n2, o2) ?? (m(l3) ? n2 : Sa(n2, o2) ?? n2));
        let p2 = false;
        if (s3.path.length > 1 && t(o2) && _2 !== void 0) {
          let e4 = s3.path.slice(0, -1), t2 = o2.key.item.value.slice(0, -1);
          if ($(n2, t2).filter((e5) => e5 !== o2).length === 0) {
            let r2 = _2;
            for (let t3 of e4) r2 = r2 == null ? void 0 : r2[t3];
            if (P(r2) && Object.keys(r2).length === 0) {
              let e5 = o2;
              for (; e5.items.length > 0; ) V(n2, e5, N(e5.items));
              H(n2);
              let r3 = e5.key, i3 = h(r3) ? r3.item : r3;
              i3.value = t2, i3.raw = ao(i3.raw, i3.value, c2.escapeSequenceUpperCase), i3.loc.end.column = i3.loc.start.column + i3.raw.length, r3.loc.end.column = r3.loc.start.column + i3.raw.length + 2, e5.loc.end.line = r3.loc.end.line, e5.loc.end.column = r3.loc.end.column, C2(e5), p2 = true;
            }
          }
        }
        let g3 = e(l3) && m(l3) ? l3.items.indexOf(o2) : -1, v4 = m(l3) && !e(l3) ? l3.items.indexOf(o2) : -1, y3 = d(o2) ? o2.comma : void 0;
        d(o2) && (u(l3) || f(l3)) && er(l3, o2.loc.start.column), d(o2) && (u(l3) || f(l3)) && v4 === l3.items.length - 1 && y3 !== void 0 && ie2.set(l3, y3);
        let x2 = d(o2) && (u(l3) || f(l3)) && o2.loc.end.line === l3.loc.end.line ? l3.loc.end.column - o2.loc.end.column : void 0, w3 = T2(d(o2) && a(o2.item) ? o2.item : o2), E3 = a(o2) ? o2 : d(o2) && a(o2.item) ? o2.item : void 0;
        if (E3 && w3 && m(l3)) {
          let e4 = w3.length - E3.key.value.length, i3 = s3.path.slice(e4);
          if (i3.length > 0 && i3.length < E3.key.value.length) {
            let e5 = l3.items, s4 = [];
            for (let n3 of e5) {
              if (n3 === o2) continue;
              let e6 = a(n3) ? n3.key.value : d(n3) && a(n3.item) ? n3.item.key.value : t(n3) || r(n3) ? n3.key.item.value : void 0;
              e6 && e6.length > i3.length && F(e6.slice(0, i3.length), i3) && s4.push(n3);
            }
            for (let e6 of s4) Q(n2, l3, e6);
          }
        }
        if (E3 && w3 && m(l3)) {
          let e4 = E3.key.value, i3 = l3.items, s4 = [];
          for (let n3 of i3) {
            if (n3 === o2) continue;
            let i4 = a(n3) ? n3.key.value : d(n3) && a(n3.item) ? n3.item.key.value : t(n3) || r(n3) ? n3.key.item.value : void 0;
            i4 && i4.length > e4.length && F(i4.slice(0, e4.length), e4) && s4.push(n3);
          }
          for (let e5 of s4) Q(n2, l3, e5);
        }
        if ((t(o2) || r(o2)) && m(l3)) {
          let e4 = o2.key.item.value, i3 = l3.items, s4 = [];
          for (let n3 of i3) {
            if (n3 === o2) continue;
            let i4 = a(n3) ? n3.key.value : t(n3) || r(n3) ? n3.key.item.value : void 0;
            i4 && i4.length > e4.length && F(i4.slice(0, e4.length), e4) && s4.push(n3);
          }
          for (let e5 of s4) Q(n2, l3, e5);
        }
        if (p2 || Q(n2, l3, o2), d(o2) && (u(l3) || f(l3)) && o2.loc.end.line === l3.loc.end.line) {
          let e4 = l3.items, t2 = l3.loc.end.line === l3.loc.start.line ? e4.every((e5) => e5.loc.end.line === l3.loc.start.line) : e4.length > 0 && N(e4).loc.end.line === l3.loc.end.line;
          if (e4.length > 0 && v4 === e4.length && t2) {
            let t3 = x2 ?? l3.loc.end.column - o2.loc.end.column;
            H(n2);
            let r2 = N(e4).loc.end.column + t3;
            l3.loc.end.column !== r2 && (l3.loc.end.column = r2);
            let i3, s4 = (e5) => {
              if (a(e5)) return e5.value === l3 ? e5 : s4(e5.value);
              if (d(e5)) return s4(e5.item);
              if (m(e5)) for (let t4 of e5.items) {
                let e6 = s4(d(t4) ? t4.item : t4);
                if (e6) return e6;
              }
            };
            if (i3 = s4(n2), i3 && i3.loc.end.line === l3.loc.end.line) {
              i3.loc.end.column = l3.loc.end.column;
              let e5 = (t5) => {
                if (a(t5)) return e5(t5.value);
                if (d(t5)) return t5.item === i3 ? t5 : e5(t5.item);
                if (m(t5)) for (let n3 of t5.items) {
                  let t6 = e5(n3);
                  if (t6) return t6;
                }
              }, t4 = e5(n2);
              if (t4) {
                let e6 = l3.loc.end.column - t4.loc.end.column;
                t4.loc.end.column = l3.loc.end.column, e6 !== 0 && (sr(n2, t4, { lines: 0, columns: e6 }), cr(n2), H(n2));
              }
            }
          }
        }
        if (!p2 && s3.path.length > 1 && (t(o2) || r(o2)) && _2 !== void 0) {
          let e4 = s3.path.slice(0, -1), t2 = o2.key.item.value.slice(0, -1);
          if ($(n2, t2).length === 0) {
            let r2 = _2;
            for (let t3 of e4) r2 = r2 == null ? void 0 : r2[t3];
            if (P(r2) && Object.keys(r2).length === 0) {
              let e5 = W(t2, c2.escapeSequenceUpperCase);
              S2.add(e5);
              let r3 = g3 >= 0 ? Math.min(g3, n2.items.length) : n2.items.length;
              H(n2), B(n2, n2, e5, r3);
            }
          }
        }
        if (!p2 && s3.path.length > 1 && _2 !== void 0) {
          let i3 = a(o2) ? o2 : d(o2) && a(o2.item) ? o2.item : void 0;
          if (i3 && i3.key.value.length > 1) {
            let o3 = s3.path.slice(0, -1), u2 = e(l3) || t(l3) || r(l3) || f(l3) ? l3 : n2;
            if (m(u2)) {
              let s4;
              if (t(u2) || r(u2)) {
                let e4 = u2.key.item.value, t2 = 0, n3 = 0;
                for (let r2 = 0; r2 < e4.length && t2 < o3.length; r2++) {
                  for (; t2 < o3.length && typeof o3[t2] == `number`; ) t2++;
                  if (t2 >= o3.length || o3[t2] !== e4[r2]) break;
                  n3++, t2++;
                }
                for (; t2 < o3.length && typeof o3[t2] == `number`; ) t2++;
                s4 = n3 === e4.length ? o3.slice(t2) : o3.slice(e4.length + +!!r(u2));
              } else if (f(u2)) {
                if (w3) {
                  let e4 = w3.slice(0, w3.length - i3.key.value.length), t2 = 0, n3 = 0;
                  for (; n3 < e4.length && t2 < o3.length; ) {
                    for (; t2 < o3.length && typeof o3[t2] == `number`; ) t2++;
                    if (t2 >= o3.length || o3[t2] !== e4[n3]) break;
                    n3++, t2++;
                  }
                  for (; t2 < o3.length && typeof o3[t2] == `number`; ) t2++;
                  s4 = n3 === e4.length ? o3.slice(t2) : o3.slice(e4.length);
                } else s4 = o3.slice(o3.length - (i3.key.value.length - 1));
              } else s4 = o3;
              s4 = s4.filter((e4) => typeof e4 == `string`);
              let l4 = u2.items.filter((e4) => {
                let t2 = a(e4) ? e4.key.value : d(e4) && a(e4.item) ? e4.item.key.value : void 0;
                return t2 ? F(t2.slice(0, s4.length), s4) : false;
              }), p3 = r(u2), m2 = [];
              p3 && l4.length === 0 && (m2 = $(n2, u2.key.item.value.concat(s4)));
              let h2 = s4.length === 0 && (t(u2) || r(u2) || f(u2));
              if (l4.length === 0 && m2.length === 0 && !h2) {
                let r2 = _2;
                for (let e4 of o3) r2 = r2 == null ? void 0 : r2[e4];
                if (P(r2) && Object.keys(r2).length === 0) {
                  if (f(u2)) {
                    let e4 = s4.map((e5) => A.test(e5) ? e5 : JSON.stringify(e5).replace(/\x7f/g, `\\u007f`)).join(`.`), t2 = Array.from(Xe(`${e4} = {}`))[0];
                    if (a(t2)) {
                      let e5 = G(t2);
                      e5.comma = y3 ?? false, H(n2), ar(u2) && u2.loc.end.line > u2.loc.start.line && (u2.loc.end.line = u2.loc.start.line), B(n2, u2, e5, v4 >= 0 ? v4 : void 0), c2.bracketSpacing && U(e5, { lines: 0, columns: 1 });
                      let r4 = u2.items[v4 + 1], i5 = z(n2).get(e5);
                      r4 && i5 && r4.loc.start.line === e5.loc.end.line && (i5.columns = e5.loc.end.column + 2 - r4.loc.start.column);
                    }
                    return;
                  }
                  let r3 = W(p3 || t(u2) ? u2.key.item.value.concat(s4) : s4, c2.escapeSequenceUpperCase);
                  S2.add(r3);
                  let i4 = g3 >= 0 ? g3 : n2.items.length;
                  if (p3) {
                    let e4 = n2.items.indexOf(u2);
                    i4 = e4 >= 0 ? e4 + 1 : n2.items.length;
                  } else if (t(u2)) {
                    let e4 = n2.items.indexOf(u2);
                    i4 = e4 >= 0 ? e4 + 1 : n2.items.length;
                  } else if (e(u2)) {
                    let e4 = xo(n2);
                    i4 = e4 >= 0 ? e4 : n2.items.length;
                  }
                  H(n2), B(n2, n2, r3, i4);
                }
              }
            }
          }
        }
        if (r(o2)) {
          let e4 = o2.key.item.value, t2 = s3.path.slice(0, -1);
          !Z(n2, t2.concat(0)) && Z(i2, t2) && b2.set(e4.join(`.`), e4);
        }
      } else {
        let e4 = () => Z(n2, s3.path.concat(0)) || $(n2, s3.path).filter(r)[0], a2 = e4();
        if (a2) {
          let o3 = n2.items.indexOf(a2), l3 = false;
          if (s3.path.length > 1 && _2 !== void 0) {
            let e5 = s3.path.slice(0, -1);
            if ($(n2, e5).filter((e6) => !(r(e6) && F(e6.key.item.value, s3.path))).length === 0) {
              let t2 = _2;
              for (let n3 of e5) t2 = t2 == null ? void 0 : t2[n3];
              if (P(t2) && Object.keys(t2).length === 0) {
                let t3 = a2, r2 = t3.key;
                for (; t3.items.length > 0; ) Q(n2, t3, N(t3.items));
                H(n2), t3.type = `Table`, r2.type = `TableKey`;
                let i3 = h(r2) ? r2.item : r2;
                i3.value = e5, i3.raw = ao(i3.raw, i3.value, c2.escapeSequenceUpperCase), i3.loc.end.column = i3.loc.start.column + i3.raw.length, r2.loc.end.column = r2.loc.start.column + i3.raw.length + 2, t3.loc.end.line = r2.loc.end.line, t3.loc.end.column = r2.loc.end.column, C2(t3), l3 = true;
              }
            }
          }
          let u2;
          for (; u2 = e4(); ) Q(n2, n2, u2);
          for (let e5 of $(n2, s3.path).filter(t)) Q(n2, n2, e5);
          if (Z(i2, s3.path)) {
            let e5 = s3.path;
            b2.set(e5.join(`.`), e5);
          }
          if (!l3 && s3.path.length > 1 && _2 !== void 0) {
            let e5 = s3.path.slice(0, -1);
            if ($(n2, e5).length === 0) {
              let t2 = _2;
              for (let n3 of e5) t2 = t2 == null ? void 0 : t2[n3];
              if (P(t2) && Object.keys(t2).length === 0) {
                let t3 = W(e5, c2.escapeSequenceUpperCase);
                S2.add(t3);
                let r2 = o3 >= 0 ? Math.min(o3, n2.items.length) : n2.items.length;
                H(n2), B(n2, n2, t3, r2);
              }
            }
          }
        } else {
          let e5 = Io(n2, s3.path), t2 = $(n2, e5);
          if (t2.length > 0) {
            let r2 = n2.items.indexOf(t2[0]);
            for (let e6 of t2) Q(n2, n2, e6);
            if (e5.length > 1 && _2 !== void 0) {
              let t3 = e5.slice(0, -1);
              if ($(n2, t3).length === 0) {
                let e6 = _2;
                for (let t4 of s3.path.slice(0, -1)) e6 = e6 == null ? void 0 : e6[t4];
                if (P(e6) && Object.keys(e6).length === 0) {
                  let e7 = W(t3, c2.escapeSequenceUpperCase);
                  S2.add(e7);
                  let i3 = r2 >= 0 ? Math.min(r2, n2.items.length) : n2.items.length;
                  H(n2), B(n2, n2, e7, i3);
                }
              }
            }
          } else X(n2, s3.path);
        }
      }
    } else if (Zi(s3)) {
      if (s3.key !== void 0) {
        oe2.push(s3);
        return;
      }
      let e4 = Z(n2, s3.path);
      if (e4) {
        if (h(e4) && (e4 = e4.item), a(e4) && (e4 = e4.value), s3.from >= e4.items.length) return;
        let t2 = e4.items[s3.from];
        Ta(n2, e4, t2, s3.to);
      } else {
        $a(n2);
        let e5 = X(n2, s3.path.concat(s3.from)), i3 = ya(n2).find((t2) => t2.member === e5), a2 = i3 ? [...i3.items] : [e5], o2 = a2.map((e6) => ({ startLine: e6.loc.start.line, endLine: e6.loc.end.line })), c3 = n2.items.indexOf(i3 ? i3.items[0] : e5), l3 = o2[o2.length - 1].endLine, u2;
        for (let e6 = 0; e6 < n2.items.length; e6++) {
          let t2 = n2.items[e6];
          if (t2.loc.start.line > l3) {
            u2 = t2.loc.start.line - l3;
            break;
          }
        }
        if (u2 === void 0 && c3 > 0) {
          let e6 = n2.items[c3 - 1];
          u2 = o2[0].startLine - e6.loc.end.line;
        }
        let d2 = i3 ? i3.items.indexOf(e5) : 0;
        for (let e6 = 0; e6 <= d2; e6++) n2.items.includes(a2[e6]) && V(n2, n2, a2[e6]);
        for (let e6 = d2 + 1; e6 < a2.length; e6++) {
          let t2 = n2.items.indexOf(a2[e6]);
          t2 >= 0 && n2.items.splice(t2, 1);
        }
        let f2 = Z(n2, s3.path.concat(s3.to)), m2, h2 = false, g3 = i3 && i3.items[0] !== e5 && p(i3.items[0]);
        if (f2) {
          let e6 = ya(n2).find((e7) => e7.member === f2);
          h2 = !!(e6 && e6.items[0] !== f2 && p(e6.items[0])), m2 = h2 && g3 ? n2.items.indexOf(e6.items[0]) : n2.items.indexOf(f2);
        } else m2 = n2.items.length;
        let _3 = m2 > 0 ? n2.items[m2 - 1].loc.end.line : 0, v4 = m2 < n2.items.length ? n2.items[m2].loc.start.line : void 0, y3 = h2 && g3, b3 = m2;
        for (let e6 = 0; e6 < a2.length; e6++) {
          let i4 = a2[e6], s4;
          if ((y3 || g3 && m2 > 0 && m2 < n2.items.length) && b3 > 0) {
            let n3 = e6 === 0 ? _3 : o2[e6 - 1].endLine, a3 = e6 === 0 && v4 !== void 0 ? v4 - _3 : o2[e6].startLine - n3;
            a3 !== (t(i4) || r(i4) ? 2 : 1) && (s4 = a3);
          }
          B(n2, n2, i4, b3, void 0, void 0, s4), b3++;
        }
        if (u2 !== void 0) {
          H(n2);
          let e6 = a2[a2.length - 1], t2 = n2.items.indexOf(e6) + 1;
          if (t2 < n2.items.length) {
            let r2 = n2.items[t2].loc.start.line - e6.loc.end.line, i4 = u2 - r2;
            if (i4 !== 0) for (let e7 = t2; e7 < n2.items.length; e7++) U(n2.items[e7], { lines: i4, columns: 0 });
          }
        }
      }
    } else if (Qi(s3)) {
      let e4 = s3.path.concat(s3.from), o2 = Z(n2, e4);
      if (!o2) {
        let i3 = $(n2, e4);
        if (i3.length === 1 && (t(i3[0]) || r(i3[0]))) {
          let t2 = i3[0].key, n3 = h(t2) ? t2.item : t2, r2 = e4.length - 1, a2 = n3.raw;
          n3.value[r2] = s3.to, n3.raw = ao(n3.raw, n3.value, c2.escapeSequenceUpperCase), co(n3, a2), n3.loc.end.column = n3.loc.start.column + n3.raw.length;
          return;
        }
      }
      o2 ||= X(n2, e4);
      let l3 = X(i2, s3.path.concat(s3.to));
      h(o2) && (o2 = o2.item), h(l3) && (l3 = l3.item);
      let u2 = o2.key, d2 = l3.key, f2 = h(u2) ? u2.item : u2, p2 = h(d2) ? d2.item : d2;
      if (f2.value.length !== p2.value.length) {
        let e5 = s3.path.concat(s3.from);
        if ((t(o2) || r(o2)) && a(l3) && F(f2.value.slice(0, e5.length), e5)) {
          let t2 = e5.length - 1, n3 = f2.raw;
          f2.value[t2] = s3.to, f2.raw = ao(f2.raw, f2.value, c2.escapeSequenceUpperCase), co(f2, n3), f2.loc.end.column = f2.loc.start.column + f2.raw.length;
          return;
        }
        if (a(o2) && a(l3) && f2.value.length <= e5.length && F(f2.value, e5.slice(e5.length - f2.value.length))) {
          let e6 = f2.raw;
          f2.value[f2.value.length - 1] = s3.to, f2.raw = ao(f2.raw, f2.value, c2.escapeSequenceUpperCase), f2.loc.end.column = f2.loc.start.column + f2.raw.length;
          let t2 = f2.raw.length - e6.length;
          t2 > 0 && (o2.equals += t2, U(o2.value, { lines: 0, columns: t2 }, { first_line_only: true }), sr(n2, o2.value, { lines: 0, columns: t2 }));
          return;
        }
        throw Error(`Cannot rename "${f2.raw}" to "${p2.raw}": the replacement key has ${p2.value.length} segment(s) where the existing key has ${f2.value.length}, so one cannot be substituted for the other.`);
      }
      p2.raw = ao(f2.raw, p2.value, c2.escapeSequenceUpperCase), co(p2, f2.raw), p2.loc.end.column = p2.loc.start.column + p2.raw.length, pr(n2, h(u2) ? u2 : o2, f2, p2);
    }
  }), H(n2);
  for (let e4 = 1; e4 < n2.items.length; e4++) {
    let r2 = n2.items[e4 - 1], i3 = n2.items[e4];
    if (p(r2) && t(i3) && S2.has(i3)) {
      let e5 = i3.loc.start.line - r2.loc.end.line - 1;
      e5 > 0 && U(i3, { lines: -e5, columns: 0 });
    }
  }
  let de2 = n2.items;
  for (let e4 = 0; e4 < de2.length - 1; e4++) {
    let n3 = de2[e4], i3 = de2[e4 + 1];
    if ((t(n3) || r(n3)) && n3.items.length === 0 && (t(i3) || r(i3))) {
      let t2 = i3.loc.start.line - n3.loc.end.line - 1;
      if (t2 > 1) {
        let n4 = 1 - t2;
        for (let t3 = e4 + 1; t3 < de2.length; t3++) U(de2[t3], { lines: n4, columns: 0 });
      }
    }
  }
  let fe2 = false;
  Gt(n2, { InlineTable: (e4) => {
    ar(e4) && (fe2 = true);
  }, InlineArray: (e4) => {
    ar(e4) && (fe2 = true);
  } }), fe2 && H(n2);
  let pe2 = false, me2 = [];
  if (Gt(n2, { InlineTable: (e4) => {
    ar(e4) && (me2.push(e4), Eo(e4), or(e4), xr(n2, e4, c2.bracketSpacing), pe2 = true);
  }, InlineArray: (e4) => {
    ar(e4) && (Eo(e4), or(e4), xr(n2, e4, c2.bracketSpacing), pe2 = true);
  } }), pe2) {
    H(n2);
    for (let e4 of me2) Do(n2, e4);
    Oo(n2);
  }
  if (Ao(n2), jo(n2, b2, c2), Na(n2, oe2, g2), oe2.length > 0 && cr(n2), se2.size > 0) {
    H(n2);
    for (let e4 of se2) Ti(e4, c2.indentWidth);
  }
  if (ce2.length > 0) {
    H(n2);
    for (let { owner: e4, container: t2 } of ce2) bo(t2), fi(t2, e4.loc.start.column, c2.indentWidth, c2.bracketSpacing);
  }
  return n2;
}
function bo(e4) {
  if (delete e4.range, m(e4)) for (let t2 of e4.items) bo(t2);
  h(e4) && bo(e4.item), a(e4) && (bo(e4.key), bo(e4.value));
}
function xo(e4) {
  return e4.items.findIndex((e5) => t(e5) || r(e5));
}
function So(e4) {
  let t2 = xo(e4);
  return t2 === -1 ? void 0 : t2;
}
function Co(e4, t2) {
  let n2 = e4.items.indexOf(t2);
  if (n2 < 0) return;
  let r2 = xo(e4);
  r2 === -1 || r2 > n2 || (V(e4, e4, t2), H(e4), B(e4, e4, t2, r2));
}
function wo(e4, n2) {
  let i2 = e4.items.indexOf(n2);
  if (i2 < 0) return;
  let o2 = e4.items.findIndex((e5, n3) => n3 > i2 && (t(e5) || r(e5)));
  if (!e4.items.some((e5, t2) => t2 > i2 && a(e5) && (o2 === -1 || t2 < o2))) return;
  let s2 = o2 === -1 ? e4.items.length : o2;
  H(e4), V(e4, e4, n2), B(e4, e4, n2, s2 - 1);
}
function To(e4, n2, i2, o2, s2, c2, l2) {
  let u2 = q(n2.items, ``, { temporal: s2 });
  for (let e5 of i2.path) u2 = u2 == null ? void 0 : u2[e5];
  if (u2 === void 0) return;
  {
    let n3 = i2.path.findIndex((e5) => typeof e5 == `number`);
    if (n3 > 0 && i2.path.slice(n3 + 1).every((e5) => typeof e5 == `string`)) {
      let s3 = Z(e4, i2.path.slice(0, n3 + 1));
      if (s3 && r(s3)) {
        let r2 = s3.key.item.value, c3 = i2.path.slice(n3 + 1), l3 = $(e4, r2.concat(c3));
        for (let t2 of l3) Q(e4, e4, t2);
        let d2 = s3.items.filter((e5) => {
          let t2 = a(e5) ? e5.key.value : void 0;
          return t2 && t2.length > c3.length && F(t2.slice(0, c3.length), c3);
        });
        for (let t2 of d2) Q(e4, s3, t2);
        let f2 = u2;
        for (let e5 = i2.path.length - 1; e5 > n3; e5--) f2 = { [i2.path[e5]]: f2 };
        let p3 = Ni(K(f2, o2).items, o2), m3 = Array.from(Xe(p3)), h3 = (t2) => {
          let n4 = s3.items.find((e5) => a(e5) && F(e5.key.value, t2.key.value));
          n4 ? pr(e4, s3, n4, t2) : B(e4, s3, t2, void 0);
        };
        for (let e5 of m3) {
          if (a(e5)) {
            h3(e5);
            continue;
          }
          if (t(e5)) {
            let t2 = e5.key.item.value;
            for (let n4 of e5.items) {
              if (!a(n4)) continue;
              let e6 = n4.key.raw, r3 = t2.concat(n4.key.value);
              n4.key.value = r3, n4.key.raw = Ur(r3, o2.escapeSequenceUpperCase).raw;
              let i3 = n4.key.raw.length - e6.length;
              n4.key.loc.end.column = n4.key.loc.start.column + n4.key.raw.length, n4.equals += i3, U(n4.value, { lines: 0, columns: i3 }, { first_line_only: true }), n4.loc.end.line === n4.loc.start.line && (n4.loc.end.column += i3), h3(n4);
            }
          }
        }
        return;
      }
    }
  }
  let p2 = u2;
  for (let e5 = i2.path.length - 1; e5 >= 0; e5--) p2 = { [i2.path[e5]]: p2 };
  let m2 = $(e4, i2.path);
  for (let t2 of m2) V(e4, e4, t2);
  let h2 = Ni(K(p2, o2).items, o2), g2 = Array.from(Xe(h2)), _2 = So(e4);
  _2 !== void 0 && H(e4);
  let v2;
  for (let n3 = 0; n3 < g2.length; n3++) {
    let i3 = g2[n3], o3 = t(i3) ? e4.items.find((e5) => t(e5) && F(e5.key.item.value, i3.key.item.value)) : void 0;
    if (o3) {
      for (let t2 of i3.items) B(e4, o3, t2, void 0);
      v2 ||= o3;
      continue;
    }
    if (a(i3) && f(i3.value)) {
      let o4 = i3.key.value, s3 = e4.items.find((e5) => t(e5) && F(e5.key.item.value, o4));
      if (s3) {
        for (let t2 of i3.value.items) B(e4, s3, d(t2) ? t2.item : t2, void 0);
        v2 ||= s3;
        continue;
      }
      if ($(e4, o4).filter((e5) => a(e5) || t(e5) || r(e5)).length > 0) {
        for (let t2 of i3.value.items) {
          let r2 = d(t2) ? t2.item : t2;
          if (a(r2)) {
            let e5 = r2.key.raw, t3 = o4.concat(r2.key.value);
            r2.key.value = t3, r2.key.raw = t3.map((e6) => A.test(e6) ? e6 : JSON.stringify(e6).replace(/\x7f/g, `\\u007f`)).join(`.`);
            let n4 = r2.key.raw.length - e5.length;
            r2.key.loc.end.column = r2.key.loc.start.column + r2.key.raw.length, r2.equals += n4, U(r2.value, { lines: 0, columns: n4 }, { first_line_only: true }), r2.loc.end.line === r2.loc.start.line && (r2.loc.end.column += n4);
          }
          B(e4, e4, r2, n3 === 0 ? _2 : void 0), v2 ||= r2;
        }
        continue;
      }
    }
    if (t(i3)) {
      let t2 = i3.key.item.value;
      if ($(e4, t2).filter((e5) => a(e5)).length > 0) {
        for (let r2 of i3.items) {
          if (a(r2)) {
            let e5 = r2.key.raw, n4 = t2.concat(r2.key.value);
            r2.key.value = n4, r2.key.raw = n4.map((e6) => A.test(e6) ? e6 : JSON.stringify(e6).replace(/\x7f/g, `\\u007f`)).join(`.`);
            let i4 = r2.key.raw.length - e5.length;
            r2.key.loc.end.column = r2.key.loc.start.column + r2.key.raw.length, r2.equals += i4, U(r2.value, { lines: 0, columns: i4 }, { first_line_only: true }), r2.loc.end.line === r2.loc.start.line && (r2.loc.end.column += i4);
          }
          B(e4, e4, r2, n3 === 0 ? _2 : void 0), v2 ||= r2;
        }
        continue;
      }
    }
    n3 > 0 && v2 && t(v2) && a(i3) ? B(e4, v2, i3, void 0) : B(e4, e4, i3, n3 === 0 ? _2 : void 0), v2 ||= i3;
  }
  let y2 = v2;
  t(y2) && l2.add(y2), c2.add(y2);
}
function Eo(e4) {
  if (e4.items.length > 0) {
    let t2 = e4.items[e4.items.length - 1];
    e4.loc.end.column = t2.loc.end.column + 1;
  } else e4.loc.end.line = e4.loc.start.line, e4.loc.end.column = e4.loc.start.column + 2;
}
function Do(e4, t2) {
  let n2 = [], r2 = (e5) => {
    if (n2.push(e5), e5 === t2) return true;
    if (a(e5)) {
      if (r2(e5.value)) return true;
    } else if (d(e5)) {
      if (r2(e5.item)) return true;
    } else if (m(e5)) {
      for (let t3 of e5.items) if (r2(t3)) return true;
    }
    return n2.pop(), false;
  };
  if (!r2(e4)) return;
  let i2 = n2.findLast(d);
  if (!i2) return;
  let o2 = t2.loc.end.line - i2.loc.end.line;
  if (o2 === 0) return;
  let s2 = n2.findLastIndex((e5, t3) => t3 < n2.length - 1 && (f(e5) || u(e5)));
  if (s2 < 0) return;
  let c2 = n2[s2], l2 = n2[s2 + 1], p2 = c2.items.indexOf(l2), h2 = p2 >= 0 ? c2.items[p2 + 1] : void 0;
  if (p2 < 0 || !h2) return;
  let g2 = h2.loc.start.column - l2.loc.end.column, _2 = ko(l2) + g2 - h2.loc.start.column;
  for (let e5 = p2 + 1; e5 < c2.items.length; e5++) U(c2.items[e5], { lines: o2, columns: _2 });
  c2.loc.end.column += _2;
  for (let e5 of n2) e5 !== t2 && e5.loc.end.line > t2.loc.end.line && (e5.loc.end.line += o2);
  for (let e5 = n2.length - 1; e5 >= 0; e5--) {
    let r3 = n2[e5];
    a(r3) ? (r3.loc.end = { ...r3.value.loc.end }, r3.value !== t2 && f(r3.value) && (r3.loc.end.column += _2)) : d(r3) && (r3.loc.end = { ...r3.item.loc.end });
  }
}
function Oo(e4) {
  Gt(e4, { InlineTable: { exit: (e5) => {
    if (e5.items.length === 0 || e5.loc.end.line !== e5.loc.start.line) return;
    let t2 = e5.items[e5.items.length - 1], n2 = ko(t2), r2 = e5.loc.end.column, i2 = n2 + (r2 - t2.loc.end.column);
    i2 !== r2 && (e5.loc.end.column = i2);
  } }, InlineArray: { exit: (e5) => {
    if (e5.items.length === 0 || e5.loc.end.line !== e5.loc.start.line) return;
    let t2 = e5.items[e5.items.length - 1], n2 = ko(t2), r2 = e5.loc.end.column, i2 = n2 + (r2 - t2.loc.end.column);
    i2 !== r2 && (e5.loc.end.column = i2);
  } } });
}
function ko(e4) {
  if (!d(e4)) return e4.loc.end.column;
  if (a(e4.item)) {
    let t2 = e4.item.value;
    if (f(t2) || u(t2)) return t2.loc.end.column;
  }
  return f(e4.item) || u(e4.item) ? e4.item.loc.end.column : e4.loc.end.column;
}
function Ao(e4) {
  Gt(e4, { KeyValue: (t2) => {
    let n2 = t2.value;
    if (!u(n2) || n2.items.length > 0) return;
    let r2 = oa(e4, [t2.key.value[0]]);
    if (!r2 || !m(r2)) return;
    let i2 = t2.loc.start.line, a2 = t2.loc.end.line, o2 = r2.items;
    for (let e5 = o2.length - 1; e5 >= 0; e5--) {
      let t3 = o2[e5];
      if (!p(t3)) continue;
      let n3 = t3.loc.start.line;
      n3 >= i2 && n3 <= a2 && o2.splice(e5, 1);
    }
  } });
}
function jo(e4, n2, i2) {
  if (n2.size !== 0) {
    for (let a2 of n2.values()) {
      if (a2.length > 1) {
        let n4 = Z(e4, a2.slice(0, -1).concat([0]));
        if (n4 && r(n4)) {
          let t2 = a2[a2.length - 1], r2 = K({ [t2]: [] }, i2), o3 = Br([t2], r2.items[0].value);
          H(e4), B(e4, n4, o3);
          continue;
        }
        let o2;
        for (let n5 = a2.length - 1; n5 >= 1; n5--) {
          let r2 = Z(e4, a2.slice(0, n5));
          if (r2 && t(r2)) {
            o2 = r2;
            break;
          }
        }
        if (o2) {
          let t2 = a2.slice(o2.key.item.value.length), n5 = Br(t2, K({ [t2[t2.length - 1]]: [] }, i2).items[0].value);
          H(e4), B(e4, o2, n5);
          continue;
        }
      }
      let n3 = Br(a2, K({ [a2[a2.length - 1]]: [] }, i2).items[0].value);
      H(e4), B(e4, e4, n3, So(e4));
    }
    H(e4);
  }
}
function Mo(e4, t2, n2) {
  let r2 = [], i2 = (e5, r3) => {
    for (let o2 = e5.items.length - 1; o2 >= 0; o2--) {
      let s2 = e5.items[o2];
      if (a(s2) && f(s2.value)) {
        let c2 = [...e5.key.item.value, ...s2.key.value];
        if (gi(c2) < (n2.inlineTableStart ?? 1) && n2.inlineTableStart !== 0) {
          let l2 = W(c2, n2.escapeSequenceUpperCase);
          for (let e6 of s2.value.items) d(e6) && a(e6.item) && B(t2, l2, e6.item, void 0);
          e5.items.splice(o2, 1), hi(e5), r3.push(l2), i2(l2, r3);
        }
      }
    }
  };
  return i2(e4, r2), r2;
}
function No(e4, t2, n2, r2) {
  let i2 = W([...t2.key.item.value, ...e4.key.value], r2.escapeSequenceUpperCase);
  if (f(e4.value)) for (let t3 of e4.value.items) d(t3) && a(t3.item) && B(n2, i2, t3.item, void 0);
  B(n2, n2, i2, void 0), hi(t2);
  let o2 = Mo(i2, n2, r2);
  for (let e5 of o2) B(n2, n2, e5, void 0);
}
function Po(e4, n2) {
  let r2 = I({ ...n2, inlineTableStart: 0 }, n2), i2 = Ni(K({ __tmp__: e4 }, r2).items, r2), o2 = Array.from(Xe(i2))[0];
  if (a(o2)) return o2.value;
  if (t(o2) && o2.items.length > 0 && a(o2.items[0])) return o2.items[0].value;
}
function Fo(e4, t2) {
  for (let n2 = t2.length - 1; n2 > 0; n2--) {
    let r2 = Z(e4, t2.slice(0, n2));
    if (!r2 || !a(r2) || !f(r2.value)) continue;
    let i2 = Z(e4, t2.slice(0, n2 - 1));
    if (i2 && m(i2)) return { container: i2, row: r2 };
  }
}
function $(e4, n2) {
  let i2 = [];
  for (let o2 of e4.items) {
    let e5;
    a(o2) ? e5 = o2.key.value : (t(o2) || r(o2)) && (e5 = o2.key.item.value), e5 && F(e5.slice(0, n2.length), n2) && i2.push(o2);
  }
  return i2;
}
function Io(e4, t2) {
  let n2 = [];
  for (let i2 of t2) typeof i2 == `number` && $(e4, n2).some(r) || n2.push(i2);
  return n2;
}
function Lo(e4, n2, i2, o2) {
  let s2 = [...n2.items];
  for (let c2 = s2.length - 1; c2 >= 0; c2--) {
    let l2 = s2[c2];
    if (l2 === o2) continue;
    let u2 = a(l2) ? l2.key.value : t(l2) || r(l2) ? l2.key.item.value : void 0;
    u2 && u2.length > i2.length && F(u2.slice(0, i2.length), i2) && Q(e4, n2, l2);
  }
}
var Wo = Object.freeze(L.default());
function Go(e4) {
  let t2 = Wo;
  return e4.newLine === t2.newLine && e4.trailingNewline === t2.trailingNewline && e4.trailingComma === t2.trailingComma && e4.bracketSpacing === t2.bracketSpacing && e4.inlineTableStart === t2.inlineTableStart && e4.truncateZeroTimeInDates === t2.truncateZeroTimeInDates && e4.useTabsForIndentation === t2.useTabsForIndentation && e4.indentWidth === t2.indentWidth && e4.minimumDecimals === t2.minimumDecimals && e4.minimumTimeDecimals === t2.minimumTimeDecimals && e4.leadingBom === t2.leadingBom && e4.updateOrder === t2.updateOrder && e4.multilineTable === t2.multilineTable && e4.multilineArray === t2.multilineArray;
}
function Ko(e4, t2) {
  let n2 = Jt(typeof e4 == `string` ? e4 : Kt(e4));
  return q(Xe(n2), n2, { integersAsBigInt: (t2 == null ? void 0 : t2.integersAsBigInt) ?? `asNeeded`, temporal: (t2 == null ? void 0 : t2.temporal) ?? false });
}
function qo(e4, t2) {
  let n2 = t2 == null ? Wo : I(t2, L.default()), r2 = K(e4, n2), i2 = Go(n2) ? Fi(r2.items, n2) : Ni(r2.items, n2);
  return n2.leadingBom ? `\uFEFF${i2}` : i2;
}

// src/agent-panel/src/server/toml-blocks.mjs
var TomlWritebackError = class extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "TomlWritebackError";
    this.code = code;
    this.file = options.file ?? null;
  }
};
function parse(text3, file = "TOML") {
  try {
    return Ko(text3);
  } catch (error) {
    throw new TomlWritebackError("TOML_INVALID", `${file}: ${error.message}`, { file });
  }
}
function same(a2, b2) {
  return JSON.stringify(a2) === JSON.stringify(b2);
}
function table(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function merge(base, draft, location = []) {
  if (Array.isArray(draft)) {
    if (location.at(-1) === "picks" && Array.isArray(base)) {
      const byId = new Map(base.map((pick) => [pick.id, pick]));
      return draft.map((pick) => merge(byId.get(pick.id), pick, [...location, pick.id]));
    }
    return draft;
  }
  if (!table(draft)) return draft;
  const result = table(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(draft)) {
    result[key] = merge(result[key], value, [...location, key]);
  }
  return result;
}
function tableLike(value) {
  return table(value) || Array.isArray(value) && value.length > 0 && value.every(table);
}
function hoistNewRootValues(original, target, anchor) {
  const added = Object.keys(target).filter((key) => !Object.hasOwn(original, key) && !tableLike(target[key]));
  if (!added.length) return target;
  const rest = Object.keys(target).filter((key) => !added.includes(key));
  let at2 = anchor && rest.includes(anchor) ? rest.indexOf(anchor) + 1 : rest.findIndex((key) => tableLike(target[key]));
  if (at2 < 0) at2 = rest.length;
  const order = [...rest.slice(0, at2), ...added, ...rest.slice(at2)];
  return Object.fromEntries(order.map((key) => [key, target[key]]));
}
function deletePath(object, path9) {
  let parent = object;
  for (const part of path9.slice(0, -1)) {
    if (!table(parent?.[part])) throw new TomlWritebackError("TOML_DELETE_MISSING", `Missing table: ${path9.join(".")}`);
    parent[part] = { ...parent[part] };
    parent = parent[part];
  }
  if (!table(parent)) throw new TomlWritebackError("TOML_DELETE_MISSING", `Missing table: ${path9.join(".")}`);
  delete parent[path9.at(-1)];
}
function parseHeader(header2) {
  const parts = [];
  const body = header2.replace(/^\[\[?/, "").replace(/\]\]?$/, "");
  const re2 = /(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\.|$)/g;
  let match;
  let end = 0;
  while (match = re2.exec(body)) {
    if (match.index !== end) return null;
    const value = match[0].replace(/\.$/, "");
    parts.push(value[0] === '"' ? JSON.parse(value) : value[0] === "'" ? value.slice(1, -1) : value);
    end = re2.lastIndex;
  }
  return end === body.length ? parts : null;
}
function blocks(text3) {
  const lines = text3.split("\n");
  const headers = [];
  let triple = null;
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!triple && depth === 0) {
      const match = /^\s*(\[\[?[^\]\r\n]+\]\]?)\s*(?:#.*)?$/.exec(line);
      if (match) {
        const path9 = parseHeader(match[1]);
        if (path9) headers.push({ index, path: path9, array: match[1].startsWith("[[") });
      }
    }
    let quote = null;
    for (let at2 = 0; at2 < line.length; at2 += 1) {
      if (triple) {
        if (line.startsWith(triple, at2)) {
          at2 += 2;
          triple = null;
        }
        continue;
      }
      if (quote) {
        if (quote === '"' && line[at2] === "\\") {
          at2++;
          continue;
        }
        if (line[at2] === quote) quote = null;
        continue;
      }
      if (line[at2] === "#") break;
      if (line.startsWith('"""', at2) || line.startsWith("'''", at2)) {
        triple = line.slice(at2, at2 + 3);
        at2 += 2;
      } else if (line[at2] === '"' || line[at2] === "'") quote = line[at2];
      else if (line[at2] === "[") depth++;
      else if (line[at2] === "]") depth = Math.max(0, depth - 1);
    }
  }
  return headers.map((item, index) => {
    let start = item.index;
    while (start > 0 && /^\s*#/.test(lines[start - 1])) start--;
    const next = headers[index + 1];
    let end = next?.index ?? lines.length;
    if (next) while (end > 0 && /^\s*#/.test(lines[end - 1])) end--;
    return { ...item, start, end };
  });
}
function atPath(object, path9) {
  return path9.reduce((value, key) => value?.[key], object);
}
function pathsOfTables(data, prefix = []) {
  const paths = [];
  if (!table(data)) return paths;
  for (const [key, value] of Object.entries(data)) {
    const path9 = [...prefix, key];
    if (table(value)) {
      paths.push(path9);
      paths.push(...pathsOfTables(value, path9));
    }
  }
  return paths;
}
function header(path9) {
  return `[${path9.map((key) => /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)).join(".")}]`;
}
function renderNewTable(path9, value) {
  let result = `${header(path9)}
`;
  for (const [key, entry] of Object.entries(value)) {
    if (table(entry)) continue;
    if (Array.isArray(entry) && entry.every((item) => typeof item === "string") && /^[A-Za-z0-9_-]+$/.test(key)) {
      result += `${key} = [${entry.map((item) => JSON.stringify(item)).join(", ")}]
`;
      continue;
    }
    result += `${qo({ [key]: entry }).trimEnd()}
`;
  }
  return result;
}
function patchSafe(text3, data, file) {
  const warnings = [];
  const previous = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };
  let output;
  try {
    output = Ja(text3, data, { updateOrder: true });
  } finally {
    console.warn = previous;
  }
  if (warnings.length) throw new TomlWritebackError("TOML_PATCH_WARNING", `${file}: ${warnings.join("; ")}`, { file });
  return output;
}
function patchDocument(originalText, targetData, editIdentity = {}) {
  const file = editIdentity.file ?? "TOML";
  const original = parse(originalText, file);
  let target = merge(original, targetData);
  for (const path9 of editIdentity.deletedPaths ?? []) deletePath(target, path9);
  target = hoistNewRootValues(original, target, editIdentity.rootAnchor);
  let text3 = originalText.replace(/\r\n?/g, "\n");
  const physical = blocks(text3);
  const originalPickIds = new Set((original.picks ?? []).map((item) => item.id));
  const targetPickIds = new Set((target.picks ?? []).map((item) => item.id));
  const pickBlocks = physical.filter((block) => block.array && same(block.path, ["picks"]));
  const removedPickIds = new Set([...originalPickIds].filter((id) => !targetPickIds.has(id)));
  const removed = physical.filter((block) => !block.array && atPath(original, block.path) !== void 0 && atPath(target, block.path) === void 0);
  for (const block of pickBlocks) {
    const rows = text3.split("\n");
    const snippet = `${rows.slice(block.index, block.end).join("\n")}
`;
    const id = parse(snippet, file).picks?.[0]?.id;
    if (removedPickIds.has(id)) removed.push(block);
  }
  for (const block of removed.sort((a2, b2) => b2.start - a2.start)) {
    const rows = text3.split("\n");
    rows.splice(block.start, block.end - block.start);
    text3 = rows.join("\n");
  }
  const additions = pathsOfTables(target).filter((path9) => atPath(original, path9) === void 0 && Object.values(atPath(target, path9)).some((entry) => !table(entry)));
  for (const path9 of additions) {
    const entries = blocks(text3);
    let anchor;
    for (let depth = path9.length - 1; depth > 0 && !anchor; depth -= 1) {
      const prefix = path9.slice(0, depth);
      anchor = entries.filter((entry) => !entry.array && prefix.every((part, index) => entry.path[index] === part)).at(-1);
    }
    const rows = text3.split("\n");
    const place = anchor ? anchor.end : rows.at(-1) === "" ? rows.length - 1 : rows.length;
    const insertion = renderNewTable(path9, atPath(target, path9)).trimEnd().split("\n");
    rows.splice(place, 0, ...place && rows[place - 1]?.trim() ? [""] : [], ...insertion, "");
    text3 = rows.join("\n");
  }
  const newPicks = (target.picks ?? []).filter((pick) => !originalPickIds.has(pick.id));
  for (const pick of newPicks) {
    const rows = text3.split("\n");
    const entries = blocks(text3).filter((block) => block.array && same(block.path, ["picks"]));
    const place = entries.at(-1)?.end ?? rows.length;
    const serialized = Object.entries(pick).map(([key, value]) => qo({ [key]: value }).trimEnd());
    rows.splice(place, 0, ...place && rows[place - 1]?.trim() ? [""] : [], "[[picks]]", ...serialized, "");
    text3 = rows.join("\n");
  }
  return patchSafe(text3, target, file).replace(/\r\n?/g, "\n");
}

// ops/tools/dispatch-core/model_selection.mjs
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync3, readdirSync as readdirSync2, readFileSync as readFileSync4 } from "node:fs";
import path5 from "node:path";

// ops/node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r\n|\n|\r/g);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i2 = line - 1; i2 <= line + 1; i2++) {
    let l2 = lines[i2 - 1];
    if (!l2)
      continue;
    codeblock += i2.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l2;
    codeblock += "\n";
    if (i2 === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class extends Error {
  line;
  column;
  codeblock;
  constructor(message, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
};

// ops/node_modules/smol-toml/dist/util.js
function isEscaped(str, ptr) {
  let i2 = 0;
  while (str[ptr - ++i2] === "\\")
    ;
  return --i2 && i2 % 2;
}
function indexOfNewline(str, start = 0, end = str.length) {
  let idx = str.indexOf("\n", start);
  if (str[idx - 1] === "\r")
    idx--;
  return idx <= end ? idx : -1;
}
function skipComment(str, ptr) {
  for (let i2 = ptr; i2 < str.length; i2++) {
    let c2 = str[i2];
    if (c2 === "\n")
      return i2;
    if (c2 === "\r" && str[i2 + 1] === "\n")
      return i2 + 1;
    if (c2 < " " && c2 !== "	" || c2 === "\x7F") {
      throw new TomlError("control characters are not allowed in comments", {
        toml: str,
        ptr
      });
    }
  }
  return str.length;
}
function skipVoid(str, ptr, banNewLines, banComments) {
  let c2;
  while ((c2 = str[ptr]) === " " || c2 === "	" || !banNewLines && (c2 === "\n" || c2 === "\r" && str[ptr + 1] === "\n"))
    ptr++;
  return banComments || c2 !== "#" ? ptr : skipVoid(str, skipComment(str, ptr), banNewLines);
}
function skipUntil(str, ptr, sep, end, banNewLines = false) {
  if (!end) {
    ptr = indexOfNewline(str, ptr);
    return ptr < 0 ? str.length : ptr;
  }
  for (let i2 = ptr; i2 < str.length; i2++) {
    let c2 = str[i2];
    if (c2 === "#") {
      i2 = indexOfNewline(str, i2);
    } else if (c2 === sep) {
      return i2 + 1;
    } else if (c2 === end || banNewLines && (c2 === "\n" || c2 === "\r" && str[i2 + 1] === "\n")) {
      return i2;
    }
  }
  throw new TomlError("cannot find end of structure", {
    toml: str,
    ptr
  });
}
function getStringEnd(str, seek) {
  let first = str[seek];
  let target = first === str[seek + 1] && str[seek + 1] === str[seek + 2] ? str.slice(seek, seek + 3) : first;
  seek += target.length - 1;
  do
    seek = str.indexOf(target, ++seek);
  while (seek > -1 && first !== "'" && isEscaped(str, seek));
  if (seek > -1) {
    seek += target.length;
    if (target.length > 1) {
      if (str[seek] === first)
        seek++;
      if (str[seek] === first)
        seek++;
    }
  }
  return seek;
}

// ops/node_modules/smol-toml/dist/date.js
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}:\d{2}(?:\.\d+)?)?(Z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    if (typeof date === "string") {
      let match = date.match(DATE_TIME_RE);
      if (match) {
        if (!match[1]) {
          hasDate = false;
          date = `0000-01-01T${date}`;
        }
        hasTime = !!match[2];
        hasTime && date[10] === " " && (date = date.replace(" ", "T"));
        if (match[2] && +match[2] > 23) {
          date = "";
        } else {
          offset = match[3] || null;
          date = date.toUpperCase();
          if (!offset && hasTime)
            date += "Z";
        }
      } else {
        date = "";
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// ops/node_modules/smol-toml/dist/primitive.js
var INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/;
var FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
var LEADING_ZERO = /^[+-]?0[0-9_]/;
var ESCAPE_REGEX = /^[0-9a-f]{4,8}$/i;
var ESC_MAP = {
  b: "\b",
  t: "	",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\"
};
function parseString(str, ptr = 0, endPtr = str.length) {
  let isLiteral = str[ptr] === "'";
  let isMultiline = str[ptr++] === str[ptr] && str[ptr] === str[ptr + 1];
  if (isMultiline) {
    endPtr -= 2;
    if (str[ptr += 2] === "\r")
      ptr++;
    if (str[ptr] === "\n")
      ptr++;
  }
  let tmp = 0;
  let isEscape;
  let parsed = "";
  let sliceStart = ptr;
  while (ptr < endPtr - 1) {
    let c2 = str[ptr++];
    if (c2 === "\n" || c2 === "\r" && str[ptr] === "\n") {
      if (!isMultiline) {
        throw new TomlError("newlines are not allowed in strings", {
          toml: str,
          ptr: ptr - 1
        });
      }
    } else if (c2 < " " && c2 !== "	" || c2 === "\x7F") {
      throw new TomlError("control characters are not allowed in strings", {
        toml: str,
        ptr: ptr - 1
      });
    }
    if (isEscape) {
      isEscape = false;
      if (c2 === "u" || c2 === "U") {
        let code = str.slice(ptr, ptr += c2 === "u" ? 4 : 8);
        if (!ESCAPE_REGEX.test(code)) {
          throw new TomlError("invalid unicode escape", {
            toml: str,
            ptr: tmp
          });
        }
        try {
          parsed += String.fromCodePoint(parseInt(code, 16));
        } catch {
          throw new TomlError("invalid unicode escape", {
            toml: str,
            ptr: tmp
          });
        }
      } else if (isMultiline && (c2 === "\n" || c2 === " " || c2 === "	" || c2 === "\r")) {
        ptr = skipVoid(str, ptr - 1, true);
        if (str[ptr] !== "\n" && str[ptr] !== "\r") {
          throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
            toml: str,
            ptr: tmp
          });
        }
        ptr = skipVoid(str, ptr);
      } else if (c2 in ESC_MAP) {
        parsed += ESC_MAP[c2];
      } else {
        throw new TomlError("unrecognized escape sequence", {
          toml: str,
          ptr: tmp
        });
      }
      sliceStart = ptr;
    } else if (!isLiteral && c2 === "\\") {
      tmp = ptr - 1;
      isEscape = true;
      parsed += str.slice(sliceStart, tmp);
    }
  }
  return parsed + str.slice(sliceStart, endPtr - 1);
}
function parseValue(value, toml, ptr, integersAsBigInt) {
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  if (value === "-inf")
    return -Infinity;
  if (value === "inf" || value === "+inf")
    return Infinity;
  if (value === "nan" || value === "+nan" || value === "-nan")
    return NaN;
  if (value === "-0")
    return integersAsBigInt ? 0n : 0;
  let isInt = INT_REGEX.test(value);
  if (isInt || FLOAT_REGEX.test(value)) {
    if (LEADING_ZERO.test(value)) {
      throw new TomlError("leading zeroes are not allowed", {
        toml,
        ptr
      });
    }
    value = value.replace(/_/g, "");
    let numeric = +value;
    if (isNaN(numeric)) {
      throw new TomlError("invalid number", {
        toml,
        ptr
      });
    }
    if (isInt) {
      if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt) {
        throw new TomlError("integer value cannot be represented losslessly", {
          toml,
          ptr
        });
      }
      if (isInt || integersAsBigInt === true)
        numeric = BigInt(value);
    }
    return numeric;
  }
  const date = new TomlDate(value);
  if (!date.isValid()) {
    throw new TomlError("invalid value", {
      toml,
      ptr
    });
  }
  return date;
}

// ops/node_modules/smol-toml/dist/extract.js
function sliceAndTrimEndOf(str, startPtr, endPtr, allowNewLines) {
  let value = str.slice(startPtr, endPtr);
  let commentIdx = value.indexOf("#");
  if (commentIdx > -1) {
    skipComment(str, commentIdx);
    value = value.slice(0, commentIdx);
  }
  let trimmed = value.trimEnd();
  if (!allowNewLines) {
    let newlineIdx = value.indexOf("\n", trimmed.length);
    if (newlineIdx > -1) {
      throw new TomlError("newlines are not allowed in inline tables", {
        toml: str,
        ptr: startPtr + newlineIdx
      });
    }
  }
  return [trimmed, commentIdx];
}
function extractValue(str, ptr, end, depth, integersAsBigInt) {
  if (depth === 0) {
    throw new TomlError("document contains excessively nested structures. aborting.", {
      toml: str,
      ptr
    });
  }
  let c2 = str[ptr];
  if (c2 === "[" || c2 === "{") {
    let [value, endPtr2] = c2 === "[" ? parseArray(str, ptr, depth, integersAsBigInt) : parseInlineTable(str, ptr, depth, integersAsBigInt);
    let newPtr = end ? skipUntil(str, endPtr2, ",", end) : endPtr2;
    if (endPtr2 - newPtr && end === "}") {
      let nextNewLine = indexOfNewline(str, endPtr2, newPtr);
      if (nextNewLine > -1) {
        throw new TomlError("newlines are not allowed in inline tables", {
          toml: str,
          ptr: nextNewLine
        });
      }
    }
    return [value, newPtr];
  }
  let endPtr;
  if (c2 === '"' || c2 === "'") {
    endPtr = getStringEnd(str, ptr);
    let parsed = parseString(str, ptr, endPtr);
    if (end) {
      endPtr = skipVoid(str, endPtr, end !== "]");
      if (str[endPtr] && str[endPtr] !== "," && str[endPtr] !== end && str[endPtr] !== "\n" && str[endPtr] !== "\r") {
        throw new TomlError("unexpected character encountered", {
          toml: str,
          ptr: endPtr
        });
      }
      endPtr += +(str[endPtr] === ",");
    }
    return [parsed, endPtr];
  }
  endPtr = skipUntil(str, ptr, ",", end);
  let slice = sliceAndTrimEndOf(str, ptr, endPtr - +(str[endPtr - 1] === ","), end === "]");
  if (!slice[0]) {
    throw new TomlError("incomplete key-value declaration: no value specified", {
      toml: str,
      ptr
    });
  }
  if (end && slice[1] > -1) {
    endPtr = skipVoid(str, ptr + slice[1]);
    endPtr += +(str[endPtr] === ",");
  }
  return [
    parseValue(slice[0], str, ptr, integersAsBigInt),
    endPtr
  ];
}

// ops/node_modules/smol-toml/dist/struct.js
var KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
function parseKey(str, ptr, end = "=") {
  let dot = ptr - 1;
  let parsed = [];
  let endPtr = str.indexOf(end, ptr);
  if (endPtr < 0) {
    throw new TomlError("incomplete key-value: cannot find end of key", {
      toml: str,
      ptr
    });
  }
  do {
    let c2 = str[ptr = ++dot];
    if (c2 !== " " && c2 !== "	") {
      if (c2 === '"' || c2 === "'") {
        if (c2 === str[ptr + 1] && c2 === str[ptr + 2]) {
          throw new TomlError("multiline strings are not allowed in keys", {
            toml: str,
            ptr
          });
        }
        let eos = getStringEnd(str, ptr);
        if (eos < 0) {
          throw new TomlError("unfinished string encountered", {
            toml: str,
            ptr
          });
        }
        dot = str.indexOf(".", eos);
        let strEnd = str.slice(eos, dot < 0 || dot > endPtr ? endPtr : dot);
        let newLine = indexOfNewline(strEnd);
        if (newLine > -1) {
          throw new TomlError("newlines are not allowed in keys", {
            toml: str,
            ptr: ptr + dot + newLine
          });
        }
        if (strEnd.trimStart()) {
          throw new TomlError("found extra tokens after the string part", {
            toml: str,
            ptr: eos
          });
        }
        if (endPtr < eos) {
          endPtr = str.indexOf(end, eos);
          if (endPtr < 0) {
            throw new TomlError("incomplete key-value: cannot find end of key", {
              toml: str,
              ptr
            });
          }
        }
        parsed.push(parseString(str, ptr, eos));
      } else {
        dot = str.indexOf(".", ptr);
        let part = str.slice(ptr, dot < 0 || dot > endPtr ? endPtr : dot);
        if (!KEY_PART_RE.test(part)) {
          throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
            toml: str,
            ptr
          });
        }
        parsed.push(part.trimEnd());
      }
    }
  } while (dot + 1 && dot < endPtr);
  return [parsed, skipVoid(str, endPtr + 1, true, true)];
}
function parseInlineTable(str, ptr, depth, integersAsBigInt) {
  let res = {};
  let seen = /* @__PURE__ */ new Set();
  let c2;
  let comma = 0;
  ptr++;
  while ((c2 = str[ptr++]) !== "}" && c2) {
    let err = { toml: str, ptr: ptr - 1 };
    if (c2 === "\n") {
      throw new TomlError("newlines are not allowed in inline tables", err);
    } else if (c2 === "#") {
      throw new TomlError("inline tables cannot contain comments", err);
    } else if (c2 === ",") {
      throw new TomlError("expected key-value, found comma", err);
    } else if (c2 !== " " && c2 !== "	") {
      let k2;
      let t2 = res;
      let hasOwn = false;
      let [key, keyEndPtr] = parseKey(str, ptr - 1);
      for (let i2 = 0; i2 < key.length; i2++) {
        if (i2)
          t2 = hasOwn ? t2[k2] : t2[k2] = {};
        k2 = key[i2];
        if ((hasOwn = Object.hasOwn(t2, k2)) && (typeof t2[k2] !== "object" || seen.has(t2[k2]))) {
          throw new TomlError("trying to redefine an already defined value", {
            toml: str,
            ptr
          });
        }
        if (!hasOwn && k2 === "__proto__") {
          Object.defineProperty(t2, k2, { enumerable: true, configurable: true, writable: true });
        }
      }
      if (hasOwn) {
        throw new TomlError("trying to redefine an already defined value", {
          toml: str,
          ptr
        });
      }
      let [value, valueEndPtr] = extractValue(str, keyEndPtr, "}", depth - 1, integersAsBigInt);
      seen.add(value);
      t2[k2] = value;
      ptr = valueEndPtr;
      comma = str[ptr - 1] === "," ? ptr - 1 : 0;
    }
  }
  if (comma) {
    throw new TomlError("trailing commas are not allowed in inline tables", {
      toml: str,
      ptr: comma
    });
  }
  if (!c2) {
    throw new TomlError("unfinished table encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}
function parseArray(str, ptr, depth, integersAsBigInt) {
  let res = [];
  let c2;
  ptr++;
  while ((c2 = str[ptr++]) !== "]" && c2) {
    if (c2 === ",") {
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    } else if (c2 === "#")
      ptr = skipComment(str, ptr);
    else if (c2 !== " " && c2 !== "	" && c2 !== "\n" && c2 !== "\r") {
      let e4 = extractValue(str, ptr - 1, "]", depth - 1, integersAsBigInt);
      res.push(e4[0]);
      ptr = e4[1];
    }
  }
  if (!c2) {
    throw new TomlError("unfinished array encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}

// ops/node_modules/smol-toml/dist/parse.js
function peekTable(key, table2, meta, type) {
  let t2 = table2;
  let m2 = meta;
  let k2;
  let hasOwn = false;
  let state;
  for (let i2 = 0; i2 < key.length; i2++) {
    if (i2) {
      t2 = hasOwn ? t2[k2] : t2[k2] = {};
      m2 = (state = m2[k2]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l2 = t2.length - 1;
        t2 = t2[l2];
        m2 = m2[l2].c;
      }
    }
    k2 = key[i2];
    if ((hasOwn = Object.hasOwn(t2, k2)) && m2[k2]?.t === 0 && m2[k2]?.d) {
      return null;
    }
    if (!hasOwn) {
      if (k2 === "__proto__") {
        Object.defineProperty(t2, k2, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m2, k2, { enumerable: true, configurable: true, writable: true });
      }
      m2[k2] = {
        t: i2 < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: {}
      };
    }
  }
  state = m2[k2];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t2[k2] = [];
    }
    t2[k2].push(t2 = {});
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: {} };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t2 = hasOwn ? t2[k2] : t2[k2] = {};
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k2, t2, state.c];
}
function parse2(toml, { maxDepth = 1e3, integersAsBigInt } = {}) {
  let res = {};
  let meta = {};
  let tbl = res;
  let m2 = meta;
  for (let ptr = skipVoid(toml, 0); ptr < toml.length; ) {
    if (toml[ptr] === "[") {
      let isTableArray = toml[++ptr] === "[";
      let k2 = parseKey(toml, ptr += +isTableArray, "]");
      if (isTableArray) {
        if (toml[k2[1] - 1] !== "]") {
          throw new TomlError("expected end of table declaration", {
            toml,
            ptr: k2[1] - 1
          });
        }
        k2[1]++;
      }
      let p2 = peekTable(
        k2[0],
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p2) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      m2 = p2[2];
      tbl = p2[1];
      ptr = k2[1];
    } else {
      let k2 = parseKey(toml, ptr);
      let p2 = peekTable(
        k2[0],
        tbl,
        m2,
        0
        /* Type.DOTTED */
      );
      if (!p2) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      let v2 = extractValue(toml, k2[1], void 0, maxDepth, integersAsBigInt);
      p2[1][p2[0]] = v2[0];
      ptr = v2[1];
    }
    ptr = skipVoid(toml, ptr, true);
    if (toml[ptr] && toml[ptr] !== "\n" && toml[ptr] !== "\r") {
      throw new TomlError("each key-value declaration must be followed by an end-of-line", {
        toml,
        ptr
      });
    }
    ptr = skipVoid(toml, ptr);
  }
  return res;
}

// ops/tools/_dispatch-prepare-argv.mjs
var DISPATCH_PREPARE_SEED_FIELD_TYPES = Object.freeze({
  route_id: "string",
  goal: "string",
  scope: "object",
  contract: "object",
  slug: "string",
  known_facts: "array",
  delegation_intent: "string",
  extensions: "object",
  read_scope_layers: "object",
  budget: "object",
  slice_id: "string",
  title: "string",
  version: "string",
  package_id: "string",
  agent: "object",
  project_positioning: "object",
  ownership: "object",
  concurrency_contract: "object",
  inputs: "object",
  expected_output: "object",
  runtime_context: "object",
  alignment: "object",
  planning_policy: "object",
  tool_contract: "object",
  stop_conditions: "array",
  handoff_contract: "object"
});
var DISPATCH_PREPARE_SEED_FIELDS = Object.freeze(Object.keys(DISPATCH_PREPARE_SEED_FIELD_TYPES));
var AUTHORIZATION_OVERRIDES = Object.freeze(["effort_range", "outside_pool"]);
var DISPATCH_PREPARE_OVERRIDE_FLAGS = Object.freeze({
  pick: "--async-pick",
  model: "--async-model",
  authorization: "--async-authorization",
  effort: "--async-effort",
  target_cwd: "--async-target-cwd",
  execution_profile: "--async-execution-profile",
  origin_id: "--origin-id"
});

// ops/tools/dispatch-core/_tool_common.mjs
import {
  closeSync,
  existsSync as existsSync2,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync as mkdirSync2,
  openSync,
  readFileSync as readFileSync3,
  readSync,
  realpathSync as realpathSync2,
  renameSync as renameSync2,
  statSync as statSync3,
  unlinkSync,
  writeSync
} from "node:fs";
import path4 from "node:path";
import process3 from "node:process";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var ToolError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
};
function isAbsoluteLikePython(value) {
  const text3 = String(value ?? "");
  if (process3.platform !== "win32") return text3.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(text3) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(text3);
}
function resolveLikePython(value) {
  const absolute2 = path4.resolve(String(value));
  let current = absolute2;
  const tail = [];
  while (true) {
    try {
      const real = realpathSync2.native(current);
      return tail.length ? path4.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path4.dirname(current);
      if (parent === current) return absolute2;
      tail.push(path4.basename(current));
      current = parent;
    }
  }
}
function repoRoot() {
  const explicit = String(process3.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim();
  if (explicit) {
    if (!isAbsoluteLikePython(explicit)) throw new ToolError("SUBAGENT_CONTROL_REPO_ROOT must be an absolute path");
    const resolved = resolveLikePython(explicit);
    let info = null;
    try {
      info = statSync3(resolved);
    } catch {
      info = null;
    }
    if (!info || !info.isDirectory()) throw new ToolError(`SUBAGENT_CONTROL_REPO_ROOT is not a directory: ${explicit}`);
    return resolved;
  }
  const scriptRoot = path4.resolve(path4.dirname(fileURLToPath2(import.meta.url)), "..", "..", "..");
  if (existsSync2(path4.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  let cur = resolveLikePython(process3.cwd());
  while (true) {
    if (existsSync2(path4.join(cur, ".git")) || existsSync2(path4.join(cur, "AGENTS.md")) && existsSync2(path4.join(cur, "ops"))) {
      return cur;
    }
    const parent = path4.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new ToolError(`cannot locate cockpit repository root from ${resolveLikePython(process3.cwd())}`);
}
function declaredDirectory(envKey) {
  const explicit = String(process3.env[envKey] || "").trim();
  if (!explicit) return null;
  if (!isAbsoluteLikePython(explicit)) throw new ToolError(`${envKey} must be an absolute path`);
  const resolved = resolveLikePython(explicit);
  let info = null;
  try {
    info = statSync3(resolved);
  } catch {
    info = null;
  }
  if (!info || !info.isDirectory()) throw new ToolError(`${envKey} is not a directory: ${explicit}`);
  return resolved;
}
function projectRoot() {
  const explicit = declaredDirectory("SUBAGENT_PROJECT_ROOT");
  if (explicit) return explicit;
  if (String(process3.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const cwd = resolveLikePython(process3.cwd());
  let cur = cwd;
  while (true) {
    if (existsSync2(path4.join(cur, ".git")) || existsSync2(path4.join(cur, "AGENTS.md")) && existsSync2(path4.join(cur, "ops"))) {
      return cur;
    }
    const parent = path4.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return repoRoot();
}
function runtimeRoot() {
  const explicit = declaredDirectory("SUBAGENT_RUNTIME_ROOT");
  if (explicit) return explicit;
  if (String(process3.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const scriptRoot = path4.resolve(path4.dirname(fileURLToPath2(import.meta.url)), "..", "..", "..");
  if (existsSync2(path4.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  return repoRoot();
}
var ROOT = projectRoot();
var RUNTIME_ROOT = runtimeRoot();

// ops/tools/dispatch-core/model_selection.mjs
var EFFORT_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
var ID_RE = /^[a-z0-9_]+$/;
var ROLE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/;
var PICK_KEYS = Object.freeze(["id", "when", "capability", "model", "effort", "effort_min", "effort_max", "default"]);
var NOTE_KEYS = Object.freeze(["tag", "supports_vision", "description", "efforts", "effort_note"]);
var REMOVED_ROLE_KEYS = Object.freeze({
  pi_model: "\u6539\u5199 [[picks]]",
  pi_model_reasoning_effort: "\u6539\u5199 [[picks]]",
  pi_candidates: "\u6539\u5199 [[picks]]",
  owner_note: "\u6539\u5199 [[picks]]",
  pi_effort_limits: "\u6863\u4F4D\u8303\u56F4\u6539\u5199\u5728\u5404\u63A8\u8350\u884C\u7684 effort_min / effort_max"
});
var REMOVED_NOTE_KEYS = Object.freeze({
  max_effort: "\u53EF\u9009\u6863\u4F4D\u6539\u5199 efforts",
  effort_levels: "\u53EF\u9009\u6863\u4F4D\u6539\u5199 efforts\uFF0C\u5B9E\u6D4B\u8BF4\u660E\u5199 effort_note",
  status: "\u6A21\u578B\u662F\u5426\u53EF\u7528\u4EE5 Pi \u6A21\u578B\u6E05\u5355\u4E3A\u51C6"
});
var WORKER_RESOURCE_LISTS = Object.freeze(["tools", "extensions", "skills"]);
var PROJECT_SKILL_MODES = Object.freeze(["none", "all"]);
var AGENT_BLOCK_RE = /```yaml\s+task_package_agent\s*\n([\s\S]*?)\n```/;
var CARD_RE = /```json\s+route_card\s*\n([\s\S]*?)\n```/;
function fail2(code, file, field, message, where = {}) {
  const error = new ToolError(`${field ? `${file} ${field}` : file}\uFF1A${message}`);
  Object.assign(error, { code, file: String(file), field: field || null, ...where });
  throw error;
}
function text2(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function asText(value) {
  return text2(value) ? value.trim() : "";
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
var rank = (level) => EFFORT_LEVELS.indexOf(level);
function readToml(file) {
  if (!text2(file) || !existsSync3(file)) fail2("file_invalid", file || "(missing)", "", "\u6587\u4EF6\u4E0D\u5B58\u5728");
  try {
    return parse2(readFileSync4(file, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    fail2("file_invalid", file, "", `\u4E0D\u662F\u6709\u6548 TOML\uFF1A${error?.message ?? error}`);
  }
}
function optionalText(value, file, field, where) {
  if (value === void 0) return "";
  if (typeof value !== "string") fail2("value_invalid", file, field, "\u5FC5\u987B\u662F\u5B57\u7B26\u4E32", where);
  return value.trim();
}
function loadNotes(file) {
  const data = readToml(file);
  const notes = /* @__PURE__ */ new Map();
  if (data.notes !== void 0 && !record(data.notes)) fail2("value_invalid", file, "notes", '\u5FC5\u987B\u662F\u8868\uFF0C\u6BCF\u4E2A\u6A21\u578B\u5199\u4E00\u5F20 [notes."<\u6A21\u578B>"]');
  for (const [model, value] of Object.entries(data.notes ?? {})) {
    const at2 = `notes."${model}"`;
    if (!record(value)) fail2("value_invalid", file, at2, "\u5FC5\u987B\u662F\u8868");
    for (const key of Object.keys(value)) {
      if (REMOVED_NOTE_KEYS[key]) fail2("field_removed", file, `${at2}.${key}`, `\u5DF2\u5220\u9664\uFF0C${REMOVED_NOTE_KEYS[key]}`);
      if (!NOTE_KEYS.includes(key)) fail2("field_unknown", file, `${at2}.${key}`, `\u672A\u77E5\u5B57\u6BB5\uFF1B\u53EF\u7528\u5B57\u6BB5\uFF1A${NOTE_KEYS.join("\u3001")}`);
    }
    if (value.supports_vision !== void 0 && typeof value.supports_vision !== "boolean") {
      fail2("value_invalid", file, `${at2}.supports_vision`, "\u5FC5\u987B\u662F true \u6216 false");
    }
    const efforts = value.efforts ?? EFFORT_LEVELS;
    const ordered = Array.isArray(efforts) && efforts.length > 0 && efforts.every((item, index) => rank(item) >= 0 && (index === 0 || rank(item) > rank(efforts[index - 1])));
    if (!ordered) fail2("value_invalid", file, `${at2}.efforts`, `\u5FC5\u987B\u662F ${EFFORT_LEVELS.join(" < ")} \u7684\u975E\u7A7A\u5B50\u96C6\uFF0C\u6309\u6863\u4F4D\u987A\u5E8F\u6392\u5217\u4E14\u4E0D\u91CD\u590D`);
    notes.set(model, {
      tag: optionalText(value.tag, file, `${at2}.tag`),
      supports_vision: value.supports_vision ?? null,
      description: optionalText(value.description, file, `${at2}.description`),
      efforts: [...efforts],
      effort_note: optionalText(value.effort_note, file, `${at2}.effort_note`)
    });
  }
  return notes;
}
function loadRoutes(root) {
  const dir = root ? path5.join(root, "ops", "protocols", "task-package-routes") : "";
  if (!dir || !existsSync3(dir)) return [];
  const routes = [];
  for (const name of readdirSync2(dir).filter((item) => item.endsWith(".md")).sort()) {
    const file = path5.join(dir, name);
    const body = readFileSync4(file, "utf8");
    const agent = AGENT_BLOCK_RE.exec(body);
    if (!agent) continue;
    const role = /(?:^|\n)\s*role:\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(agent[1])?.[1] || "";
    const capability = /capability:\s*\n(?:[^\n]*\n){0,4}?\s*name:\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(agent[1])?.[1] || "";
    if (!role || !capability) continue;
    let card = {};
    let phaseError = null;
    try {
      card = JSON.parse(CARD_RE.exec(body)?.[1] ?? "{}");
    } catch (error) {
      phaseError = `route_card \u4E0D\u662F\u6709\u6548 JSON\uFF1A${error?.message ?? error}`;
    }
    const phase = card.dispatch_phase;
    phaseError ??= phase === void 0 ? "\u5C1A\u672A\u5199\u5165 dispatch_phase" : !record(phase) || !["direct", "workflow"].includes(phase.kind) ? "dispatch_phase.kind \u5FC5\u987B\u662F direct \u6216 workflow" : phase.kind === "workflow" && !text2(phase.step) ? "dispatch_phase.step \u7F3A\u5C11\u771F\u5B9E\u6B65\u9AA4" : null;
    routes.push({
      role,
      capability,
      route_id: `${role}__${capability}`,
      description: asText(card.applies_to),
      dispatch_phase: phaseError ? null : { kind: phase.kind, step: text2(phase.step) ? phase.step.trim() : null },
      phase_error: phaseError,
      file
    });
  }
  return routes;
}
function nameList(value, file, field) {
  if (!Array.isArray(value) || value.some((item) => !text2(item))) fail2("value_invalid", file, field, "\u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32\u6570\u7EC4");
  return [...new Set(value.map((item) => item.trim()))];
}
function projectSkillsValue(value, file, field) {
  if (PROJECT_SKILL_MODES.includes(value)) return value;
  if (Array.isArray(value)) return nameList(value, file, field);
  fail2("value_invalid", file, field, '\u5FC5\u987B\u662F "none"\u3001"all" \u6216 skill \u540D\u5355');
}
function roleWorkerResources(data, file) {
  if (![...WORKER_RESOURCE_LISTS, "project_skills"].some((key) => data[key] !== void 0)) return null;
  return {
    ...Object.fromEntries(WORKER_RESOURCE_LISTS.map((key) => [key, data[key] === void 0 ? [] : nameList(data[key], file, key)])),
    project_skills: data.project_skills === void 0 ? "none" : projectSkillsValue(data.project_skills, file, "project_skills")
  };
}
function capabilityWorkerResources(role, value, file, field) {
  const base = role ?? { tools: [], extensions: [], skills: [], project_skills: "none" };
  const out = { ...base };
  for (const key of WORKER_RESOURCE_LISTS) {
    if (value[key] === void 0) continue;
    const list = nameList(value[key], file, `${field}.${key}`);
    const extra = list.filter((name) => !base[key].includes(name));
    if (extra.length) fail2("value_invalid", file, `${field}.${key}`, `\u53EA\u80FD\u6536\u7A84\u89D2\u8272\u6E05\u5355\uFF0C\u591A\u51FA ${extra.join(", ")}`);
    out[key] = list;
  }
  if (value.project_skills !== void 0) {
    const narrowed = projectSkillsValue(value.project_skills, file, `${field}.project_skills`);
    const allowed = base.project_skills === "all" || narrowed === "none" || Array.isArray(base.project_skills) && Array.isArray(narrowed) && narrowed.every((name) => base.project_skills.includes(name));
    if (!allowed) fail2("value_invalid", file, `${field}.project_skills`, `\u53EA\u80FD\u6536\u7A84\u89D2\u8272\u7684 project_skills\uFF08\u89D2\u8272\u503C ${JSON.stringify(base.project_skills)}\uFF09`);
    out.project_skills = narrowed;
  }
  return role || [...WORKER_RESOURCE_LISTS, "project_skills"].some((key) => value[key] !== void 0) ? out : null;
}
function effortsOf(notes, model) {
  return notes.get(model)?.efforts ?? EFFORT_LEVELS;
}
function loadPick(item, index, file, role, notes, known, ids) {
  const field = `picks[${index}]`;
  const where = { role, pick_id: record(item) && text2(item.id) ? item.id.trim() : null };
  const bad = (code, key, message) => fail2(code, file, key ? `${field}.${key}` : field, message, where);
  if (!record(item)) bad("value_invalid", "", "\u5FC5\u987B\u662F\u8868");
  if (item.slot !== void 0) bad("field_removed", "slot", "\u5DF2\u5220\u9664\uFF0C\u6539\u5199 model\uFF08Pi \u6A21\u578B\u5168\u540D\uFF09\u4E0E effort / effort_min / effort_max");
  const unknown = Object.keys(item).find((key) => !PICK_KEYS.includes(key));
  if (unknown) bad("field_unknown", unknown, `\u672A\u77E5\u5B57\u6BB5\uFF1B\u53EF\u7528\u5B57\u6BB5\uFF1A${PICK_KEYS.join("\u3001")}\u3002\u89D2\u8272\u9876\u5C42\u952E\u987B\u5199\u5728\u7B2C\u4E00\u4E2A [[picks]] \u4E4B\u524D`);
  const id = asText(item.id);
  if (!ID_RE.test(id)) bad("value_invalid", "id", `\u5FC5\u987B\u662F ASCII \u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u4E0E\u4E0B\u5212\u7EBF\uFF0C\u5B9E\u5F97 ${JSON.stringify(item.id)}`);
  if (ids.has(id)) bad("pick_duplicate", "id", `${id} \u5728\u89D2\u8272\u5185\u91CD\u590D`);
  ids.add(id);
  if (item.capability !== void 0 && !text2(item.capability)) bad("value_invalid", "capability", "\u4E0D\u80FD\u4E3A\u7A7A\uFF1B\u9002\u7528\u5168\u90E8\u4EFB\u52A1\u65F6\u5220\u9664\u8BE5\u5B57\u6BB5");
  const capability = item.capability === void 0 ? null : item.capability.trim();
  if (capability && !known.has(capability)) bad("capability_unknown", "capability", `${capability} \u4E0D\u662F\u8BE5\u89D2\u8272\u5DF2\u6709\u4EFB\u52A1\u7C7B\u578B`);
  if (!text2(item.model) || !item.model.includes("/")) bad("value_invalid", "model", "\u5FC5\u987B\u662F Pi \u6A21\u578B\u5168\u540D\uFF0C\u4F8B\u5982 openai-codex/gpt-6.1-sol");
  const model = item.model.trim();
  const levels = {};
  for (const key of ["effort", "effort_min", "effort_max"]) {
    if (rank(item[key]) < 0) bad("value_invalid", key, `\u5FC5\u987B\u662F ${EFFORT_LEVELS.join("/")} \u4E4B\u4E00\uFF0C\u5B9E\u5F97 ${JSON.stringify(item[key])}`);
    levels[key] = item[key];
  }
  if (rank(levels.effort_min) > rank(levels.effort_max)) bad("effort_order", "effort_min", `${levels.effort_min} \u9AD8\u4E8E effort_max ${levels.effort_max}`);
  if (rank(levels.effort) < rank(levels.effort_min) || rank(levels.effort) > rank(levels.effort_max)) {
    bad("effort_order", "effort", `${levels.effort} \u4E0D\u5728 effort_min\u2013effort_max\uFF08${levels.effort_min}\u2013${levels.effort_max}\uFF09\u5185`);
  }
  const allowed = effortsOf(notes, model);
  for (const key of ["effort", "effort_min", "effort_max"]) {
    if (!allowed.includes(levels[key])) {
      bad("effort_not_supported", key, `${levels[key]} \u4E0D\u5728 ${model} \u7684\u53EF\u9009\u6863\u4F4D\uFF08${allowed.join("/")}\uFF09\u5185\uFF1B\u6539\u9009\u6863\u4F4D\u6216\u5230\u6A21\u578B\u6863\u4F4D\u9875\u8C03\u6574`);
    }
  }
  if (item.default !== void 0 && typeof item.default !== "boolean") bad("value_invalid", "default", "\u5FC5\u987B\u662F true \u6216 false");
  return { id, when: optionalText(item.when, file, `${field}.when`, where), capability, model, ...levels, default: item.default === true };
}
function checkDefaults(picks, known, capabilities, file, role) {
  const seen = /* @__PURE__ */ new Map();
  picks.forEach((pick, index) => {
    if (!pick.default) return;
    const key = pick.capability ?? "";
    if (seen.has(key)) {
      fail2("default_duplicate", file, `picks[${index}].default`, pick.capability ? `\u4EFB\u52A1\u7C7B\u578B ${pick.capability} \u7684\u9ED8\u8BA4\u884C\u53EA\u80FD\u6709\u4E00\u884C\uFF08\u5DF2\u6709 ${seen.get(key)}\uFF09` : `\u4E0D\u5E26 capability \u7684\u9ED8\u8BA4\u884C\u53EA\u80FD\u6709\u4E00\u884C\uFF08\u5DF2\u6709 ${seen.get(key)}\uFF09`, { role, pick_id: pick.id });
    }
    seen.set(key, pick.id);
  });
  const lacking = [...known].filter((capability) => !seen.has(capability));
  const sealed = lacking.find((capability) => capabilities.get(capability)?.inherit_role_picks === false);
  if (sealed) {
    fail2("default_missing", file, `capabilities.${sealed}`, "\u4E0D\u7EE7\u627F\u89D2\u8272\u63A8\u8350\uFF0C\u5FC5\u987B\u6709\u4E00\u884C capability \u6307\u5411\u5B83\u7684 default \u63A8\u8350\u884C", { role });
  }
  if ((known.size === 0 || lacking.length) && !seen.has("")) {
    fail2("default_missing", file, "picks", known.size === 0 ? "\u89D2\u8272\u6CA1\u6709\u4EFB\u52A1\u7C7B\u578B\uFF0C\u5FC5\u987B\u628A\u4E00\u884C\u4E0D\u5E26 capability \u7684\u63A8\u8350\u8BBE\u4E3A default" : `\u4EFB\u52A1\u7C7B\u578B ${lacking.join("\u3001")} \u6CA1\u6709\u4E13\u5C5E\u9ED8\u8BA4\uFF0C\u5FC5\u987B\u628A\u4E00\u884C\u4E0D\u5E26 capability \u7684\u63A8\u8350\u8BBE\u4E3A default`, { role });
  }
}
function loadRoleFile(file, routes, notes) {
  const data = readToml(file);
  const role = asText(data.name);
  if (!role) fail2("value_invalid", file, "name", "\u89D2\u8272\u540D\u4E0D\u80FD\u4E3A\u7A7A");
  if (`${role}.toml` !== path5.basename(file)) fail2("value_invalid", file, "name", `\u4E0E\u6587\u4EF6\u540D\u4E0D\u4E00\u81F4\uFF1A${role}`);
  for (const [key, hint] of Object.entries(REMOVED_ROLE_KEYS)) {
    if (data[key] !== void 0) fail2("field_removed", file, key, `\u5DF2\u5220\u9664\uFF0C${hint}`, { role });
  }
  const workerResources = roleWorkerResources(data, file);
  const roleRoutes = routes.filter((item) => item.role === role);
  const known = new Set(roleRoutes.map((item) => item.capability));
  const capabilities = /* @__PURE__ */ new Map();
  if (data.capabilities !== void 0 && !record(data.capabilities)) {
    fail2("value_invalid", file, "capabilities", "\u5FC5\u987B\u662F\u8868\uFF0C\u6BCF\u4E2A\u4EFB\u52A1\u7C7B\u578B\u5199\u4E00\u5F20 [capabilities.<id>]", { role });
  }
  for (const [capability, value] of Object.entries(data.capabilities ?? {})) {
    const field = `capabilities.${capability}`;
    if (roleRoutes.length && !known.has(capability)) fail2("capability_unknown", file, field, "\u4E0D\u662F\u8BE5\u89D2\u8272\u5DF2\u6709\u4EFB\u52A1\u7C7B\u578B", { role });
    if (!record(value)) fail2("value_invalid", file, field, "\u5FC5\u987B\u662F\u8868", { role });
    if (value.inherit_role_picks !== void 0 && typeof value.inherit_role_picks !== "boolean") {
      fail2("value_invalid", file, `${field}.inherit_role_picks`, "\u5FC5\u987B\u662F true \u6216 false", { role });
    }
    capabilities.set(capability, {
      inherit_role_picks: value.inherit_role_picks !== false,
      worker_resources: capabilityWorkerResources(workerResources, value, file, field)
    });
    known.add(capability);
  }
  if (!roleRoutes.length && Array.isArray(data.picks)) {
    for (const item of data.picks) if (record(item) && text2(item.capability)) known.add(item.capability.trim());
  }
  if (!Array.isArray(data.picks) || !data.picks.length) fail2("value_invalid", file, "picks", "\u81F3\u5C11\u8981\u6709\u4E00\u884C\u63A8\u8350", { role });
  const ids = /* @__PURE__ */ new Set();
  const picks = data.picks.map((item, index) => loadPick(item, index, file, role, notes, known, ids));
  checkDefaults(picks, known, capabilities, file, role);
  return {
    role,
    description: asText(data.description),
    file,
    picks,
    capabilities,
    routes: roleRoutes,
    known_capabilities: known,
    worker_resources: workerResources
  };
}
function roleNames(sources) {
  const names = /* @__PURE__ */ new Set();
  for (const dir of [sources.agents_dir, text2(sources.global_root) ? path5.join(sources.global_root, "ops", "agents") : ""]) {
    if (!text2(dir) || !existsSync3(dir)) continue;
    for (const name of readdirSync2(dir)) if (ROLE_FILE_RE.test(name)) names.add(name.slice(0, -".toml".length));
  }
  return [...names].sort();
}
function loadSelectionConfig(sources) {
  if (!record(sources) || typeof sources.roleConfigPath !== "function") {
    throw new ToolError("loadSelectionConfig \u9700\u8981 resolveModelConfigSources \u7684\u8FD4\u56DE\u5BF9\u8C61");
  }
  const notes = loadNotes(sources.model_notes);
  const routes = loadRoutes(sources.global_root);
  const roles = /* @__PURE__ */ new Map();
  for (const name of roleNames(sources)) {
    const file = sources.roleConfigPath(name);
    if (existsSync3(file)) roles.set(name, loadRoleFile(file, routes, notes));
  }
  return {
    sources,
    config_source: sources.describe(),
    notes,
    routes,
    roles,
    warnings: routes.filter((route) => route.phase_error).map((route) => ({ code: "dispatch_phase_invalid", file: route.file, field: "dispatch_phase", role: route.role, message: route.phase_error }))
  };
}
function modelEfforts(config, model) {
  return [...effortsOf(config.notes, model)];
}
function roleRecord(config, role) {
  const found = config.roles.get(role);
  if (!found) throw new ToolError(`\u672A\u77E5\u89D2\u8272\uFF1A${role || "(\u7A7A)"}`);
  return found;
}
function requireCapability(role, capability) {
  if (!text2(capability)) throw new ToolError(`\u89E3\u6790 ${role.role} \u5FC5\u987B\u7ED9\u51FA\u4EFB\u52A1\u7C7B\u578B`);
  if (role.known_capabilities.size && !role.known_capabilities.has(capability)) {
    throw new ToolError(`${role.file}\uFF1A${capability} \u4E0D\u662F\u8BE5\u89D2\u8272\u5DF2\u6709\u4EFB\u52A1\u7C7B\u578B`);
  }
}
function inherits(role, capability) {
  return role.capabilities.get(capability)?.inherit_role_picks !== false;
}
function applicable(role, capability) {
  return role.picks.filter((item) => item.capability === capability || !item.capability && inherits(role, capability));
}
function effectiveDefault(role, capability) {
  return role.picks.find((item) => item.capability === capability && item.default) || (inherits(role, capability) ? role.picks.find((item) => !item.capability && item.default) : null) || null;
}
function selectionConfigFingerprint(config, { role = "" } = {}) {
  const roles = role ? [roleRecord(config, role)] : [...config.roles.values()];
  const snapshot = {
    notes: [...config.notes],
    roles: roles.map((item) => ({
      role: item.role,
      picks: item.picks,
      capabilities: [...item.capabilities],
      worker_resources: item.worker_resources
    }))
  };
  return `sha256:${createHash2("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}
function capabilityRow(role, id) {
  const route = role.routes.find((item) => item.capability === id);
  return {
    id,
    route_id: route?.route_id ?? `${role.role}__${id}`,
    description: route?.description ?? "",
    dispatch_phase: route?.dispatch_phase ?? null,
    default_pick: effectiveDefault(role, id)?.id ?? null,
    inherit_role_picks: inherits(role, id)
  };
}
function projectCatalog(config, { piModels = null, role: roleFilter = "", capability = "" } = {}) {
  const pi2 = piModels ? new Set(piModels) : null;
  const picked = [...config.roles.values()].flatMap((role) => role.picks.map((pick) => pick.model));
  const models = [.../* @__PURE__ */ new Set([...piModels ?? [], ...config.notes.keys(), ...picked])].map((model) => {
    const note = config.notes.get(model);
    return {
      model,
      tag: note?.tag ?? "",
      supports_vision: note?.supports_vision ?? null,
      efforts: modelEfforts(config, model),
      effort_note: note?.effort_note ?? "",
      in_pi: pi2 ? pi2.has(model) : null
    };
  });
  const warnings = [...config.warnings];
  const roles = [];
  for (const role of config.roles.values()) {
    if (roleFilter && role.role !== roleFilter) continue;
    if (capability) requireCapability(role, capability);
    const shown = capability ? applicable(role, capability) : role.picks;
    if (pi2) {
      role.picks.forEach((pick, index) => {
        if (shown.includes(pick) && !pi2.has(pick.model)) {
          warnings.push({
            code: "model_not_in_pi",
            file: role.file,
            field: `picks[${index}].model`,
            role: role.role,
            pick_id: pick.id,
            message: `${pick.model} \u4E0D\u5728\u5F53\u524D Pi \u6A21\u578B\u6E05\u5355\u4E2D`
          });
        }
      });
    }
    roles.push({
      role: role.role,
      description: role.description,
      capabilities: (capability ? [capability] : [...role.known_capabilities]).map((id) => capabilityRow(role, id)),
      picks: shown.map((pick) => ({ ...pick }))
    });
  }
  if (roleFilter && !roles.length) throw new ToolError(`\u672A\u77E5\u89D2\u8272\uFF1A${roleFilter}`);
  return { config_source: config.config_source, config_fingerprint: selectionConfigFingerprint(config, { role: roleFilter }), models, roles, warnings };
}

// ops/tools/pi_worker_resources.mjs
import { spawn } from "node:child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync5, statSync as statSync4, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir } from "node:os";
import path6 from "node:path";
import { fileURLToPath as fileURLToPath3, pathToFileURL as pathToFileURL2 } from "node:url";
var WORKER_RESOURCES_CONFIG = path6.resolve(path6.dirname(fileURLToPath3(import.meta.url)), "../templates/worker-resources.json");
var IMPORT_ACCESS = Object.freeze(["off", "optional", "default_on"]);
var BUILTIN_TOOLS = Object.freeze(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
var RUNNER_TOOLS = Object.freeze(["research_search", "research_fetch", "command_job"]);
var PI_CLI = path6.join(process.env.APPDATA || path6.join(homedir(), "AppData", "Roaming"), "npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
var PROBE_TIMEOUT_MS = 6e4;
var PROBE_SCRIPT = `import { pathToFileURL } from "node:url";
const { loadExtensions } = await import(pathToFileURL(process.env.PI_TOOL_PROBE_LOADER).href);
const { extensions, errors } = await loadExtensions(JSON.parse(process.env.PI_TOOL_PROBE_EXTENSIONS), process.cwd());
if (errors.length) throw new Error(errors.map(({ path, error }) => path + ": " + error).join("; "));
console.log(JSON.stringify([...new Set(extensions.flatMap((extension) => [...extension.tools.keys()]))]));
`;
var probes = /* @__PURE__ */ new Map();
var SECTIONS = Object.freeze(["tools", "extensions", "skills"]);
var ENTRY_KEYS = Object.freeze({ tools: ["access", "label", "group"], extensions: ["access", "label"], skills: ["access", "label"] });
var REMOVED_KEYS = Object.freeze({
  base_extensions: '\u6539\u5199\u4E3A extensions \u4E2D access = "default_on" \u7684\u6761\u76EE',
  main_only_extensions: '\u6539\u5199\u4E3A extensions \u4E2D access = "off" \u7684\u6761\u76EE',
  main_only_skills: '\u6539\u5199\u4E3A skills \u4E2D access = "off" \u7684\u6761\u76EE',
  force_excluded_tools: '\u6539\u5199\u4E3A tools \u4E2D access = "off" \u7684\u6761\u76EE'
});
function configError(code, file, field, message) {
  return Object.assign(new Error(`${file} ${field}\uFF1A${message}`), { code, file, field });
}
function literalLength(key) {
  return key.replaceAll("*", "").length;
}
function matches(value, pattern) {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}
function packageJsonName(dir) {
  const file = path6.join(dir, "package.json");
  if (!existsSync4(file)) return null;
  const name = JSON.parse(readFileSync5(file, "utf8")).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
function resourceName(file) {
  const parts = String(file).replaceAll("\\", "/").split("/").filter(Boolean);
  const last = parts.length - 1;
  if (parts[last] === "SKILL.md") return parts[last - 1];
  const modules = parts.lastIndexOf("node_modules");
  if (modules >= 0 && modules < last) {
    return parts[modules + 1].startsWith("@") ? `${parts[modules + 1]}/${parts[modules + 2]}` : parts[modules + 1];
  }
  const local = parts.lastIndexOf("local-packages");
  if (local >= 0 && local < last) {
    const dir = parts.slice(0, local + 2).join("/");
    return packageJsonName(/^[A-Za-z]:$/.test(parts[0]) ? dir : `/${dir}`) ?? parts[local + 1];
  }
  const extensions = parts.lastIndexOf("extensions");
  if (extensions >= 0 && extensions === last - 1) return parts[last].replace(/\.[^.]+$/, "");
  if (extensions >= 0 && extensions < last) return parts[extensions + 1];
  return parts[last].replace(/\.[^.]+$/, "");
}
function loadWorkerResourcesConfig(configPath = WORKER_RESOURCES_CONFIG) {
  const raw = JSON.parse(readFileSync5(configPath, "utf8"));
  for (const [key, hint] of Object.entries(REMOVED_KEYS)) {
    if (raw[key] !== void 0) throw configError("field_removed", configPath, key, `\u5DF2\u5220\u9664\uFF0C${hint}`);
  }
  if (raw.version !== 2) throw configError("value_invalid", configPath, "version", "\u5FC5\u987B\u4E3A 2");
  const config = { configPath };
  for (const section of SECTIONS) {
    const entries = raw[section];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw configError("value_invalid", configPath, section, "\u5FC5\u987B\u5B58\u5728\u4E14\u662F\u5BF9\u8C61\uFF1B\u6CA1\u6709\u6761\u76EE\u65F6\u5199 {}");
    }
    for (const [key, entry] of Object.entries(entries)) {
      const field = `${section}.${key}`;
      if (section === "tools" && key.includes("*")) throw configError("value_invalid", configPath, field, "\u5DE5\u5177\u53EA\u5199\u5177\u4F53\u540D\u5B57\uFF0C\u4E0D\u652F\u6301 *");
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw configError("value_invalid", configPath, field, "\u5FC5\u987B\u662F\u5BF9\u8C61");
      const unknown = Object.keys(entry).find((item) => !ENTRY_KEYS[section].includes(item));
      if (unknown) throw configError("field_unknown", configPath, `${field}.${unknown}`, `\u672A\u77E5\u5B57\u6BB5\uFF1B\u53EF\u7528\u5B57\u6BB5\uFF1A${ENTRY_KEYS[section].join("\u3001")}`);
      if (!IMPORT_ACCESS.includes(entry.access)) throw configError("value_invalid", configPath, `${field}.access`, `\u5FC5\u987B\u662F ${IMPORT_ACCESS.join(" / ")} \u4E4B\u4E00`);
      for (const text3 of ["label", "group"]) {
        if (entry[text3] !== void 0 && typeof entry[text3] !== "string") throw configError("value_invalid", configPath, `${field}.${text3}`, "\u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
      }
    }
    config[section] = entries;
  }
  const required = raw.required_tools;
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !name.trim())) {
    throw configError("value_invalid", configPath, "required_tools", "\u5FC5\u987B\u662F\u5DE5\u5177\u540D\u6570\u7EC4");
  }
  for (const name of required) {
    if (config.tools[name]?.access === "off") throw configError("value_invalid", configPath, `tools.${name}.access`, "\u8FD0\u884C\u5FC5\u9700\u5DE5\u5177\u4E0D\u80FD\u8BBE\u4E3A off");
  }
  config.required_tools = [...required];
  return config;
}
function importEntry(config, section, name) {
  const hits = Object.keys(config[section]).filter((key) => matches(name, key));
  if (!hits.length) return null;
  const rank2 = (key) => key.includes("*") ? literalLength(key) : Number.POSITIVE_INFINITY;
  const best = Math.max(...hits.map(rank2));
  const top = hits.filter((key) => rank2(key) === best);
  if (top.length > 1) {
    throw configError("value_invalid", config.configPath, section, `${name} \u540C\u65F6\u5339\u914D ${top.join("\u3001")}\uFF1B\u5220\u53BB\u91CD\u590D\u6216\u5199\u51FA\u66F4\u5177\u4F53\u7684\u952E`);
  }
  return { key: top[0], ...config[section][top[0]] };
}
function accessOf(config, section, name) {
  if (section === "tools" && config.required_tools.includes(name)) return "default_on";
  return importEntry(config, section, name)?.access ?? "off";
}
async function discoverWorkerResources({
  cwd = process.cwd(),
  agentDir = process.env.PI_CODING_AGENT_DIR || path6.join(homedir(), ".pi", "agent"),
  piCli = PI_CLI
} = {}) {
  const { DefaultPackageManager, SettingsManager } = await import(pathToFileURL2(path6.join(path6.dirname(piCli), "index.js")).href);
  const settingsPath = path6.join(agentDir, "settings.json");
  const settings = existsSync4(settingsPath) ? JSON.parse(readFileSync5(settingsPath, "utf8")) : {};
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.inMemory(settings) });
  const missing = [];
  const resolved = await manager.resolve(async (source) => {
    missing.push(source);
    return "skip";
  });
  const enabled = (type) => (resolved[type] || []).filter((item) => item.enabled && ["user", "project"].includes(item.metadata?.scope)).map((item) => ({ name: resourceName(item.path), path: item.path, scope: item.metadata.scope }));
  return { settingsPath, extensions: enabled("extensions"), skills: enabled("skills"), missing };
}
function probeRegisteredTools({ extensions, piCli = PI_CLI, cacheFile, cwd = process.cwd() }) {
  const key = JSON.stringify(["registration-only/v1", path6.resolve(cwd), ...[piCli, ...extensions.map((item) => item.path)].map((file) => [file, existsSync4(file) ? statSync4(file).mtimeMs : 0])]);
  const cached = existsSync4(cacheFile) ? JSON.parse(readFileSync5(cacheFile, "utf8")) : null;
  if (cached?.key === key) return Promise.resolve(cached.tools);
  const id = `${cacheFile}
${key}`;
  if (!probes.has(id)) {
    probes.set(id, runToolProbe(extensions, piCli, cwd).then((tools) => {
      mkdirSync3(path6.dirname(cacheFile), { recursive: true });
      writeFileSync2(cacheFile, JSON.stringify({ key, tools }));
      return tools;
    }).finally(() => probes.delete(id)));
  }
  return probes.get(id);
}
function runToolProbe(extensions, piCli, cwd) {
  const loader = path6.join(path6.dirname(piCli), "core", "extensions", "loader.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", PROBE_SCRIPT], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PI_TOOL_PROBE_LOADER: loader, PI_TOOL_PROBE_EXTENSIONS: JSON.stringify(extensions.map((item) => item.path)) }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Pi \u6269\u5C55\u6CE8\u518C\u63A2\u6D4B\u5931\u8D25\uFF08exit ${code}\uFF09${stderr.trim() ? `\uFF1A${stderr.trim().slice(-400)}` : ""}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`Pi \u5DE5\u5177\u6CE8\u518C\u8868\u65E0\u6CD5\u89E3\u6790\uFF1A${error.message}`));
      }
    });
  });
}
function catalogEntries(config, section, installed) {
  const rows = installed.map(({ name, scope }) => {
    const entry = importEntry(config, section, name);
    return { key: entry?.key ?? null, name, access: entry?.access ?? "off", label: entry?.label ?? "", installed: true, scope };
  });
  for (const [key, entry] of Object.entries(config[section])) {
    if (!installed.some(({ name }) => matches(name, key))) {
      rows.push({ key, name: key, access: entry.access, label: entry.label ?? "", installed: false, scope: null });
    }
  }
  return rows;
}
async function resolveWorkerResourceCatalog({
  cwd = process.cwd(),
  agentDir,
  configPath = WORKER_RESOURCES_CONFIG,
  piCli = PI_CLI,
  toolCache = path6.join(cwd, ".runtime", "cockpit", "worker-tool-probe.json"),
  probeTools = probeRegisteredTools
} = {}) {
  const config = loadWorkerResourcesConfig(configPath);
  const found = await discoverWorkerResources({ cwd, agentDir, piCli });
  const diagnostics = found.missing.map((source) => ({ code: "not_installed", file: found.settingsPath, field: "packages", message: `\u5DF2\u914D\u7F6E\u7684 Pi \u8D44\u6E90\u672A\u5B89\u88C5\uFF1A${source}` }));
  const known = /* @__PURE__ */ new Set([...BUILTIN_TOOLS, ...RUNNER_TOOLS]);
  try {
    for (const name of await probeTools({ extensions: found.extensions, piCli, cacheFile: toolCache, cwd })) known.add(name);
  } catch (error) {
    diagnostics.push({ code: "tool_probe_failed", file: found.settingsPath, field: "extensions", message: `\u8BFB\u53D6\u5DF2\u88C5\u63D2\u4EF6\u6CE8\u518C\u7684\u5DE5\u5177\u5931\u8D25\uFF0C\u5DE5\u5177\u8868\u53EA\u542B\u5185\u7F6E\u5DE5\u5177\uFF1A${error.message}` });
  }
  const toolNames = [.../* @__PURE__ */ new Set([...known, ...Object.keys(config.tools), ...config.required_tools])].sort();
  return {
    configPath,
    settingsPath: found.settingsPath,
    tools: toolNames.map((name) => {
      const entry = config.tools[name];
      return {
        key: entry ? name : null,
        name,
        access: accessOf(config, "tools", name),
        label: entry?.label ?? "",
        group: entry?.group ?? "",
        installed: known.has(name) || config.required_tools.includes(name)
      };
    }),
    extensions: catalogEntries(config, "extensions", found.extensions),
    skills: catalogEntries(config, "skills", found.skills.filter((item) => item.scope === "user")),
    project_skills: found.skills.filter((item) => item.scope === "project").map(({ name, scope }) => ({ name, scope })),
    required_tools: config.required_tools,
    diagnostics
  };
}
if (path6.basename(process.argv[1] || "") === "pi_worker_resources.mjs") {
  if (process.argv.slice(2).some((arg) => arg !== "--json")) {
    console.error("Usage: node ops/tools/pi_worker_resources.mjs --json");
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await resolveWorkerResourceCatalog(), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

// src/agent-panel/src/server/config-store.mjs
var CONFIG_CONTRACT_VERSION = "panel-config/v1";
var RESOURCE_FIELDS = Object.freeze(["tools", "extensions", "skills", "project_skills"]);
var PROJECT_SKILL_MODES2 = Object.freeze(["none", "all"]);
var RESOURCE_EXEMPT_ROLES = /* @__PURE__ */ new Set(["delegate-work"]);
var IMPORTS_FILE = "ops/templates/worker-resources.json";
var IMPORT_SECTIONS = Object.freeze(["tools", "extensions", "skills"]);
var ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
var TOML_READ_SCRIPT = 'import tomllib,json,sys;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))';
var TOML_CHECK_SCRIPT = "import tomllib,sys;tomllib.loads(sys.stdin.read())";
var TOML_BATCH_SCRIPT = 'import tomllib,json,sys\nout={}\nfor p in sys.argv[1:]:\n    try:\n        out[p]={"ok":True,"value":tomllib.load(open(p,"rb"))}\n    except Exception:\n        out[p]={"ok":False}\nprint(json.dumps(out))';
var ConfigError = class extends PanelError {
  constructor(code, message, options = {}) {
    super(code, message, { status: options.status ?? 400, scope: "local", details: options.details ?? null });
  }
};
function resolveConfigSources(sourceRoot) {
  try {
    return resolveModelConfigSources({
      roots: [{ root: sourceRoot, source: "control_repo" }],
      projectRoot: sourceRoot
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
    return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => valuesEqual(item, actual[index]));
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    return expectedKeys.length === actualKeys.length && expectedKeys.every((key) => Object.hasOwn(actual, key) && valuesEqual(expected[key], actual[key]));
  }
  return false;
}
function revisionOf(text3) {
  return createHash3("sha256").update(text3, "utf8").digest("hex").slice(0, 12);
}
function resolvePythonCommand(controlRoot, override) {
  if (override) return override;
  if (process.env.AGENT_PANEL_PYTHON) return process.env.AGENT_PANEL_PYTHON;
  const venv = path7.join(controlRoot, ".venv", "Scripts", "python.exe");
  if (existsSync5(venv)) return venv;
  return "python";
}
function runPython(pythonCommand, args, input) {
  const outcome = spawnSync(pythonCommand, args, {
    input,
    encoding: "utf8",
    timeout: 15e3,
    windowsHide: true
  });
  if (outcome.error) {
    throw new ConfigError("CONFIG_PYTHON_UNAVAILABLE", "TOML \u89E3\u6790\u5668\u8FDB\u7A0B\u4E0D\u53EF\u7528", { status: 503 });
  }
  return outcome;
}
function parseTomlFile(pythonCommand, filePath) {
  const outcome = runPython(pythonCommand, ["-c", TOML_READ_SCRIPT, filePath]);
  if (outcome.status !== 0) {
    throw new ConfigError("CONFIG_SOURCE_INVALID", "\u914D\u7F6E\u6E90\u4E0D\u53EF\u8BFB\u6216 TOML \u65E0\u6548", { status: 503 });
  }
  try {
    return JSON.parse(outcome.stdout);
  } catch {
    throw new ConfigError("CONFIG_SOURCE_INVALID", "\u914D\u7F6E\u6E90\u89E3\u6790\u7ED3\u679C\u65E0\u6548", { status: 503 });
  }
}
function validateTomlText(pythonCommand, text3) {
  const outcome = runPython(pythonCommand, ["-c", TOML_CHECK_SCRIPT], text3);
  return outcome.status === 0;
}
function saveTextTransactional(filePath, candidate, pythonCommand, faultInjector = null, verifyParsed = null, expectedRevision = null) {
  if (!validateTomlText(pythonCommand, candidate)) {
    return { state: "validation_error" };
  }
  if (faultInjector === "external-edit-before-recheck") {
    writeFileSync3(filePath, `${readFileSync6(filePath, "utf8")}# external-edit
`, "utf8");
  }
  if (expectedRevision !== null) {
    const fresh = readFileSync6(filePath, "utf8");
    if (revisionOf(fresh) !== expectedRevision) {
      return { state: "revision_conflict", current_revision: revisionOf(fresh) };
    }
  }
  const suffix = randomBytes2(4).toString("hex");
  const backupPath = `${filePath}.panel-bak-${suffix}`;
  const tempPath = `${filePath}.panel-tmp-${suffix}`;
  copyFileSync(filePath, backupPath);
  let failureReason = "write_failed";
  try {
    if (faultInjector === "after-backup") throw new Error("fault: after-backup");
    writeFileSync3(tempPath, candidate, "utf8");
    renameSync3(tempPath, filePath);
    if (faultInjector === "after-replace") throw new Error("fault: after-replace");
    const reread = readFileSync6(filePath, "utf8");
    if (reread !== candidate || !validateTomlText(pythonCommand, reread)) {
      throw new Error("post-write verification failed");
    }
    let parsed = null;
    if (verifyParsed) {
      parsed = parseTomlFile(pythonCommand, filePath);
      if (!verifyParsed(parsed)) {
        failureReason = "semantic_verify_failed";
        throw new Error("semantic verification failed");
      }
    }
    rmSync2(backupPath, { force: true });
    return { state: "saved", text: candidate, parsed };
  } catch {
    try {
      rmSync2(tempPath, { force: true });
    } catch {
    }
    try {
      copyFileSync(backupPath, filePath);
      rmSync2(backupPath, { force: true });
      return { state: "save_error_restored", reason: failureReason };
    } catch {
      return { state: "save_error_restore_failed", reason: failureReason, backup_path: path7.basename(backupPath) };
    }
  }
}
function resolveDefaultPiCommand(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const exists = options.exists || existsSync5;
  const node = options.node || process.execPath;
  if (platform === "win32") {
    const cli = path7.join(
      env.APPDATA || path7.join(env.USERPROFILE || "", "AppData", "Roaming"),
      "npm",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js"
    );
    if (exists(cli)) return [node, cli];
    return ["pi.cmd"];
  }
  return ["pi"];
}
function defaultPiModelProbe({ cwd, piCommand = resolveDefaultPiCommand(), timeoutMs = 3e4, signal } = {}) {
  const invocation = Array.isArray(piCommand) ? piCommand.map(String) : [String(piCommand)];
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-tools"
  ];
  const requestId = "agent-panel-model-catalog";
  return new Promise((resolve, reject) => {
    const child = spawn2(invocation[0], [...invocation.slice(1), ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1", PI_SKIP_VERSION_CHECK: "1" }
    });
    const closed = new Promise((resolveClose) => child.once("close", resolveClose));
    let buffer = "";
    let bytes = 0;
    let settled = false;
    const finish = (error, models) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.kill();
      closed.then(() => {
        if (error) reject(error);
        else resolve(models);
      });
    };
    const abort = () => finish(new ConfigError("PI_RPC_CANCELLED", "\u6A21\u578B\u76EE\u5F55\u67E5\u8BE2\u5DF2\u53D6\u6D88", { status: 503 }));
    const timer = setTimeout(() => finish(new ConfigError("PI_RPC_TIMEOUT", `Pi \u6A21\u578B\u76EE\u5F55\u67E5\u8BE2\u8D85\u8FC7 ${timeoutMs} ms\uFF0C\u70B9\u51FB\u91CD\u8BD5\u76EE\u5F55`, { status: 503 })), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => finish(new ConfigError("PI_RPC_START_FAILED", `Pi \u542F\u52A8\u5931\u8D25\uFF08${error.code || "unknown"}\uFF09\uFF0C\u68C0\u67E5 Pi \u5B89\u88C5\u8DEF\u5F84`, { status: 503 })));
    child.stdin.on("error", () => finish(new ConfigError("PI_RPC_INPUT_FAILED", "Pi RPC \u8F93\u5165\u7BA1\u9053\u5DF2\u5173\u95ED", { status: 503 })));
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024 * 1024) {
        finish(new ConfigError("PI_RPC_OUTPUT_LIMIT", "Pi RPC \u8F93\u51FA\u8D85\u8FC7 16 MiB", { status: 503 }));
        return;
      }
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        let record2;
        try {
          record2 = JSON.parse(line);
        } catch {
          continue;
        }
        if (record2?.type !== "response" || record2.id !== requestId || record2.command !== "get_available_models") continue;
        if (!record2.success || !Array.isArray(record2.data?.models)) {
          finish(new ConfigError("PI_RPC_RESPONSE_INVALID", "Pi RPC \u62D2\u7EDD\u76EE\u5F55\u67E5\u8BE2\u6216\u8FD4\u56DE\u683C\u5F0F\u4E0D\u6B63\u786E", { status: 503 }));
        } else finish(null, record2.data.models);
        return;
      }
    });
    child.once("close", (code) => finish(new ConfigError("PI_RPC_RESPONSE_MISSING", `Pi \u9000\u51FA\u4F46\u672A\u8FD4\u56DE\u6A21\u578B\u76EE\u5F55\uFF08exit=${code}\uFF09`, { status: 503 })));
    if (signal?.aborted) abort();
    else child.stdin.end(`${JSON.stringify({ id: requestId, type: "get_available_models" })}
`);
  });
}
async function loadPiScopeSdk(piCommand) {
  const invocation = Array.isArray(piCommand) ? piCommand : [piCommand];
  const cli = invocation.find((part) => typeof part === "string" && /\.[cm]?js$/i.test(part));
  if (cli) return import(pathToFileURL3(path7.join(path7.dirname(path7.resolve(cli)), "index.js")).href);
  const executable = invocation[0];
  if (typeof executable === "string") {
    const paths = path7.isAbsolute(executable) ? [executable] : (process.env.PATH || "").split(path7.delimiter).map((dir) => path7.join(dir, executable));
    const found = paths.find((candidate) => existsSync5(candidate));
    if (found) {
      const index = path7.join(path7.dirname(realpathSync3(found)), "index.js");
      if (existsSync5(index)) return import(pathToFileURL3(index).href);
    }
  }
  return import("@earendil-works/pi-coding-agent");
}
async function scopePiModels(models, { cwd, piCommand = resolveDefaultPiCommand(), agentDir, loadSdk = loadPiScopeSdk } = {}) {
  const { SettingsManager, resolveModelScopeWithDiagnostics } = await loadSdk(piCommand);
  const settings = SettingsManager.create(cwd, agentDir);
  if (settings.drainErrors().length) {
    throw new ConfigError("PI_MODEL_SCOPE_INVALID", "Pi \u767D\u540D\u5355\u914D\u7F6E\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 settings.json", { status: 503 });
  }
  const patterns = (settings.getEnabledModels() || []).map((pattern) => pattern.trim()).filter(Boolean);
  if (!patterns.length) return [];
  const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, { getAvailable: async () => models });
  return scopedModels.map((entry) => entry.model);
}
async function loadPiCatalog(probe, scopeModels, controlRoot, piCommand, signal, timeoutMs) {
  let mainModels;
  try {
    mainModels = await probe({ cwd: controlRoot, profile: "main", piCommand, signal, timeoutMs });
    if (!Array.isArray(mainModels)) throw new ConfigError("PI_RPC_RESPONSE_INVALID", "Pi RPC \u8FD4\u56DE\u7684\u6A21\u578B\u76EE\u5F55\u4E0D\u662F\u6570\u7EC4");
    mainModels = await scopeModels(mainModels, { cwd: controlRoot, piCommand });
    if (!Array.isArray(mainModels)) throw new ConfigError("PI_MODEL_SCOPE_INVALID", "Pi \u767D\u540D\u5355\u89E3\u6790\u7ED3\u679C\u4E0D\u662F\u6570\u7EC4");
  } catch (error) {
    return { available: false, error: error instanceof ConfigError ? error.message : "Pi \u6A21\u578B\u76EE\u5F55\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u76EE\u5F55", error_code: error instanceof ConfigError ? error.code : "PI_RPC_FAILED", source: "pi-rpc/get_available_models", models: [] };
  }
  const models = mainModels.filter((model) => model && typeof model.provider === "string" && model.provider && typeof model.id === "string" && model.id).map((model) => ({
    ...model,
    value: `${model.provider}/${model.id}`,
    name: typeof model.name === "string" && model.name ? model.name : model.id,
    context_window: Number.isFinite(model.contextWindow) ? model.contextWindow : null
  }));
  return { available: true, error: "", source: "pi-rpc/get_available_models", models };
}
var EMPTY_RESOURCE_CATALOG = Object.freeze({ available: false, error: "", tools: [], extensions: [], skills: [], project_skills: [], required_tools: [], diagnostics: [] });
var CATALOG_UNAVAILABLE = "\u65E0\u6CD5\u8BFB\u53D6\u672C\u673A Pi \u7684\u63D2\u4EF6\u4E0E\u6280\u80FD\u76EE\u5F55\uFF0C\u8BF7\u786E\u8BA4 Pi \u5DF2\u5B89\u88C5\u540E\u91CD\u8BD5";
var IMPORTS_UNREADABLE = "\u5BFC\u5165\u8303\u56F4\u6587\u4EF6\u5185\u5BB9\u65E0\u6548\uFF0C\u8BF7\u6309\u670D\u52A1\u65E5\u5FD7\u4E2D\u7684\u63D0\u793A\u4FEE\u6B63\u540E\u91CD\u8BD5";
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
function resourceValues(source) {
  const projectSkills = source?.project_skills;
  return {
    tools: stringList(source?.tools),
    extensions: stringList(source?.extensions),
    skills: stringList(source?.skills),
    project_skills: PROJECT_SKILL_MODES2.includes(projectSkills) ? projectSkills : stringList(projectSkills)
  };
}
function assertResourceValue(field, value, location) {
  if (field === "project_skills" && PROJECT_SKILL_MODES2.includes(value)) return;
  const valid = Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() === item && item) && new Set(value).size === value.length;
  if (!valid) {
    const shape = field === "project_skills" ? '"none"\u3001"all" \u6216\u4E0D\u91CD\u590D\u7684\u540D\u79F0\u6570\u7EC4' : "\u4E0D\u91CD\u590D\u7684\u540D\u79F0\u6570\u7EC4";
    throw new ConfigError("CONFIG_VALUE_INVALID", `${location} \u9700\u8981${shape}`, { details: { location } });
  }
}
function unavailableNames(field, value, catalog, location) {
  if (!Array.isArray(value) || field === "project_skills") return [];
  const usable = catalog[field].filter((item) => item.installed && item.access !== "off").map((item) => item.name);
  const unknown = value.filter((name) => !usable.includes(name));
  return unknown.length ? [{ code: "RESOURCE_UNAVAILABLE", field: location, message: `\u542B\u672A\u5F00\u653E\u6216\u672A\u5B89\u88C5\u7684\u8D44\u6E90\uFF0C\u8FD0\u884C\u65F6\u4E0D\u4F1A\u52A0\u8F7D\uFF1A${unknown.join(", ")}` }] : [];
}
function widening(roleValue, capabilityValue) {
  if (capabilityValue === null || capabilityValue === void 0 || capabilityValue === "none") return null;
  if (roleValue === "all") return null;
  if (capabilityValue === "all") return ["all"];
  const allowed = Array.isArray(roleValue) ? roleValue : [];
  const extra = capabilityValue.filter((name) => !allowed.includes(name));
  return extra.length ? extra : null;
}
function createConfigStore(options = {}) {
  const launchRoot = path7.resolve(String(options.controlRoot));
  const sync = createConfigSync({
    controlRoot: launchRoot,
    browser: options.browser,
    homeDir: options.homeDir,
    listSlots: options.listSlots,
    faultInjector: options.syncFaultInjector
  });
  let controlRoot = launchRoot;
  let configSources = null;
  let agentsRoot = path7.join(controlRoot, "ops", "agents");
  const pythonCommand = resolvePythonCommand(controlRoot, options.pythonCommand);
  const piModelProbe = options.piModelProbe || defaultPiModelProbe;
  const piModelScope = options.piModelScope || scopePiModels;
  const piCommand = options.piCommand || resolveDefaultPiCommand();
  const faultInjector = options.faultInjector ?? null;
  const workerResourceCatalog = options.workerResourceCatalog || resolveWorkerResourceCatalog;
  const agentDir = options.homeDir ? path7.join(options.homeDir, ".pi", "agent") : void 0;
  const parseCache = /* @__PURE__ */ new Map();
  let piCatalogCache = null;
  let piCatalogCachedAt = 0;
  let piCatalogInFlight = null;
  const probeController = new AbortController();
  const piCatalogCacheMs = Number.isFinite(options.piCatalogCacheMs) ? Number(options.piCatalogCacheMs) : 6e4;
  function readSource(filePath) {
    try {
      return readFileSync6(filePath, "utf8");
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
    const misses = paths.filter((filePath) => existsSync5(filePath) && !cacheGet(filePath).hit);
    if (!misses.length) return;
    if (misses.length === 1) {
      try {
        getParsedToml(misses[0]);
      } catch {
      }
      return;
    }
    const outcome = runPython(pythonCommand, ["-c", TOML_BATCH_SCRIPT, ...misses]);
    if (outcome.status !== 0) return;
    let batch;
    try {
      batch = JSON.parse(outcome.stdout);
    } catch {
      return;
    }
    for (const filePath of misses) {
      const entry = batch[filePath];
      if (entry?.ok) cachePut(filePath, entry.value);
    }
  }
  function loadRoster() {
    let files;
    try {
      files = readdirSync3(agentsRoot, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".toml")).map((entry) => path7.join(agentsRoot, entry.name)).sort((left, right) => left.localeCompare(right));
    } catch {
      throw new ConfigError("CONFIG_SOURCE_MISSING", "\u63A7\u5236\u4ED3\u7F3A\u5C11\u53EF\u8BFB\u7684 ops/agents/ \u89D2\u8272\u76EE\u5F55", { status: 503 });
    }
    warmTomlCache(files);
    return files.map((file) => {
      const fileRole = path7.basename(file, ".toml");
      if (!ROLE_RE.test(fileRole)) {
        throw new ConfigError("CONFIG_ROLE_INVALID", `\u89D2\u8272\u6587\u4EF6\u540D\u683C\u5F0F\u65E0\u6548\uFF1A${path7.basename(file)}`, { status: 500 });
      }
      const parsed = getParsedToml(file);
      if (parsed?.name !== fileRole) {
        throw new ConfigError("CONFIG_ROLE_NAME_MISMATCH", `\u89D2\u8272\u6587\u4EF6 ${path7.basename(file)} \u7684 name \u5FC5\u987B\u7B49\u4E8E ${fileRole}`, { status: 500 });
      }
      return { role: fileRole, file };
    });
  }
  function roleEntry(roleName) {
    const roster = loadRoster();
    const entry = roster.find((item) => item.role === roleName);
    if (!entry) {
      throw new ConfigError("CONFIG_ROLE_UNKNOWN", "\u89D2\u8272\u4E0D\u5728 ops/agents/*.toml \u4E2D", { status: 404 });
    }
    return entry;
  }
  function routeCapabilities() {
    const { roles } = projectCatalog(loadSelectionConfig(configSources), {});
    return new Map(roles.map((role) => [role.role, role.capabilities.map((item) => item.id)]));
  }
  function capabilityIds(roleName, parsed, routes) {
    const ids = [...routes.get(roleName) || []];
    for (const id of Object.keys(capabilityTables(parsed))) if (!ids.includes(id)) ids.push(id);
    return ids;
  }
  function readRole(entry, routes = /* @__PURE__ */ new Map()) {
    if (!existsSync5(entry.file)) return { role: entry.role, missing: true, revision: null, capabilities: [] };
    const text3 = readFileSync6(entry.file, "utf8");
    const parsed = getParsedToml(entry.file);
    const tables = capabilityTables(parsed);
    return {
      role: entry.role,
      missing: false,
      revision: revisionOf(text3),
      ...resourceValues(parsed),
      capabilities: capabilityIds(entry.role, parsed, routes).map((id) => ({ id, ...resourceValues(tables[id]) }))
    };
  }
  async function resourceCatalog(monitorRoot) {
    try {
      return normalizeResourceCatalog(await workerResourceCatalog({ cwd: path7.resolve(monitorRoot || controlRoot), agentDir, configPath: importsPath() }));
    } catch (error) {
      console.error(`agent-panel resource catalog unavailable: ${error?.stack || error}`);
      return { ...EMPTY_RESOURCE_CATALOG, available: false, error: error?.field ? IMPORTS_UNREADABLE : CATALOG_UNAVAILABLE };
    }
  }
  function catalogs() {
    const cached = piCatalogCache || { available: false, error: "", models: [], source: "pi-rpc/get_available_models" };
    return {
      pi: { ...cached, loading: piCatalogInFlight !== null, stale: cached.available && (Boolean(cached.error) || Date.now() - piCatalogCachedAt >= piCatalogCacheMs), checked_at: piCatalogCachedAt ? new Date(piCatalogCachedAt).toISOString() : null }
    };
  }
  async function refreshCatalogs({ force = false } = {}) {
    if (!piCatalogInFlight && (force || !piCatalogCache?.available || piCatalogCache.error || Date.now() - piCatalogCachedAt >= piCatalogCacheMs)) {
      piCatalogInFlight = loadPiCatalog(piModelProbe, piModelScope, controlRoot, piCommand, probeController.signal, options.piProbeTimeoutMs).then((result) => {
        if (result.available) {
          piCatalogCache = result;
          piCatalogCachedAt = Date.now();
        } else {
          piCatalogCache = piCatalogCache?.available ? { ...piCatalogCache, error: result.error, error_code: result.error_code } : result;
        }
      }).finally(() => {
        piCatalogInFlight = null;
      });
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
    return path7.join(controlRoot, ...IMPORTS_FILE.split("/"));
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
      imports_revision: revisionOf(readFileSync6(importsPath(), "utf8")),
      catalogs: catalogs()
    };
  }
  function configState() {
    return state();
  }
  function validateRoleUpdates(updates, knownCapabilities) {
    if (!updates || typeof updates !== "object" || Array.isArray(updates) || !Object.keys(updates).length) {
      throw new ConfigError("CONFIG_UPDATE_EMPTY", "\u6CA1\u6709\u53EF\u4FDD\u5B58\u7684\u5B57\u6BB5");
    }
    for (const [key, value] of Object.entries(updates)) {
      if (RESOURCE_FIELDS.includes(key)) {
        assertResourceValue(key, value, key);
        continue;
      }
      if (key !== "capabilities") throw new ConfigError("CONFIG_FIELD_REJECTED", `\u89D2\u8272\u5B57\u6BB5\u4E0D\u7ECF\u914D\u7F6E\u9875\u5199\u5165\uFF1A${key}`);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ConfigError("CONFIG_VALUE_INVALID", "capabilities \u9700\u8981\u4EE5\u80FD\u529B id \u4E3A\u952E\u7684\u5BF9\u8C61");
      }
      for (const [id, fields] of Object.entries(value)) {
        const at2 = `capabilities.${id}`;
        if (!knownCapabilities.includes(id)) {
          throw new ConfigError("CONFIG_CAPABILITY_UNKNOWN", `${at2} \u4E0D\u662F\u8BE5\u89D2\u8272\u7684\u80FD\u529B`, { details: { location: at2 } });
        }
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
          throw new ConfigError("CONFIG_VALUE_INVALID", `${at2} \u9700\u8981\u5BF9\u8C61`, { details: { location: at2 } });
        }
        for (const [field, item] of Object.entries(fields)) {
          const location = `${at2}.${field}`;
          if (!RESOURCE_FIELDS.includes(field)) throw new ConfigError("CONFIG_FIELD_REJECTED", `\u80FD\u529B\u5B57\u6BB5\u4E0D\u7ECF\u914D\u7F6E\u9875\u5199\u5165\uFF1A${location}`, { details: { location } });
          if (item !== null) assertResourceValue(field, item, location);
        }
      }
    }
  }
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
        throw new ConfigError("CONFIG_CAPABILITY_WIDENS", `\u8D85\u51FA\u89D2\u8272\u5DF2\u52FE\u9009\u7684\u8303\u56F4\uFF1A${extra.join(", ")}`, { details: { location, names: extra } });
      }
    }
  }
  function withoutResources(parsed) {
    const rest = Object.fromEntries(Object.entries(parsed).filter(([key]) => !RESOURCE_FIELDS.includes(key) && key !== "capabilities"));
    const tables = Object.fromEntries(Object.entries(capabilityTables(parsed)).map(([id, table2]) => [
      id,
      Object.fromEntries(Object.entries(table2).filter(([key]) => !RESOURCE_FIELDS.includes(key)))
    ]));
    return { rest, tables };
  }
  function roleWriteTarget(parsed, updates) {
    const target = Object.fromEntries(RESOURCE_FIELDS.filter((field) => Object.hasOwn(updates, field)).map((field) => [field, updates[field]]));
    const tables = capabilityTables(parsed);
    const writes2 = {};
    const cleared = [];
    const dropped = [];
    for (const [id, fields] of Object.entries(updates.capabilities || {})) {
      const existing = tables[id] || {};
      const set = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
      const removed = Object.keys(fields).filter((field) => fields[field] === null && Object.hasOwn(existing, field));
      const remaining = Object.keys(existing).filter((key) => !removed.includes(key) && !Object.hasOwn(set, key));
      if (Object.keys(set).length) writes2[id] = set;
      else if (!remaining.length && Object.hasOwn(tables, id)) {
        dropped.push(id);
        continue;
      }
      cleared.push(...removed.map((field) => ["capabilities", id, field]));
    }
    if (Object.keys(writes2).length) target.capabilities = writes2;
    const survivors = Object.keys(tables).filter((id) => !dropped.includes(id));
    const deletedPaths = Object.keys(tables).length && !survivors.length && !Object.keys(writes2).length ? [["capabilities"]] : [...dropped.map((id) => ["capabilities", id]), ...cleared];
    return { target, deletedPaths };
  }
  async function saveRole(roleName, { updates, expected_revision: expectedRevision } = {}, monitorRoot = null) {
    requireSources();
    if (!ROLE_RE.test(String(roleName))) throw new ConfigError("CONFIG_ROLE_INVALID", "\u89D2\u8272\u540D\u683C\u5F0F\u65E0\u6548");
    const entry = roleEntry(roleName);
    if (RESOURCE_EXEMPT_ROLES.has(entry.role)) throw new ConfigError("CONFIG_ROLE_INVALID", `${entry.role} \u4E0D\u914D\u7F6E\u8D44\u6E90\u767D\u540D\u5355`);
    if (!existsSync5(entry.file)) throw new ConfigError("CONFIG_SOURCE_MISSING", "\u89D2\u8272 TOML \u6587\u4EF6\u4E0D\u5B58\u5728", { status: 404 });
    const parsed = getParsedToml(entry.file);
    const ids = capabilityIds(entry.role, parsed, routeCapabilities());
    validateRoleUpdates(updates, ids);
    if (typeof expectedRevision !== "string" || !expectedRevision) throw new ConfigError("CONFIG_REVISION_REQUIRED", "\u7F3A\u5C11 expected_revision");
    const catalog = await resourceCatalog(monitorRoot);
    const warnings = [];
    if (!catalog.available) warnings.push({ code: "RESOURCE_CATALOG_UNAVAILABLE", field: null, message: `\u8D44\u6E90\u76EE\u5F55\u4E0D\u53EF\u7528\uFF0C\u8D44\u6E90\u540D\u672A\u6838\u5BF9\uFF1A${catalog.error}` });
    else {
      for (const field of RESOURCE_FIELDS) if (Object.hasOwn(updates, field)) warnings.push(...unavailableNames(field, updates[field], catalog, field));
      for (const [id, fields] of Object.entries(updates.capabilities || {})) {
        for (const [field, value] of Object.entries(fields)) warnings.push(...unavailableNames(field, value, catalog, `capabilities.${id}.${field}`));
      }
    }
    const merged = mergedResources(parsed, updates, ids);
    assertNarrowing(merged);
    const text3 = readFileSync6(entry.file, "utf8");
    if (revisionOf(text3) !== expectedRevision) return { state: "revision_conflict", current_revision: revisionOf(text3) };
    const { target, deletedPaths } = roleWriteTarget(parsed, updates);
    let candidate;
    try {
      candidate = patchDocument(text3, target, { file: path7.basename(entry.file), deletedPaths, rootAnchor: "tools" });
    } catch (error) {
      if (!(error instanceof TomlWritebackError)) throw error;
      return { state: "validation_error", errors: [{ code: error.code, file: path7.basename(entry.file), field: null, message: error.message }] };
    }
    const untouched = withoutResources(parsed);
    const outcome = saveTextTransactional(entry.file, candidate, pythonCommand, faultInjector, (written) => {
      const after = withoutResources(written);
      const values = resourceValues(written);
      const writtenTables = capabilityTables(written);
      return valuesEqual(after.rest, untouched.rest) && Object.entries(untouched.tables).every(([id, table2]) => !Object.keys(table2).length || valuesEqual(after.tables[id], table2)) && RESOURCE_FIELDS.every((field) => valuesEqual(values[field], merged.role[field])) && Object.entries(merged.capabilities).every(([id, fields]) => RESOURCE_FIELDS.every((field) => Object.hasOwn(fields, field) ? valuesEqual(resourceValues(writtenTables[id])[field], fields[field]) : !Object.hasOwn(writtenTables[id] || {}, field)));
    }, expectedRevision);
    if (outcome.state !== "saved") return outcome;
    if (outcome.parsed) cachePut(entry.file, outcome.parsed);
    const file = path7.relative(controlRoot, entry.file).split(path7.sep).join("/");
    return {
      state: "saved",
      revision: revisionOf(outcome.text),
      role: readRole(entry, routeCapabilities()),
      write_results: [{ file, ok: true }],
      warnings,
      ...sync.syncWritten([file])
    };
  }
  function saveImports({ updates, expected_revision: expectedRevision } = {}) {
    requireSources();
    const file = importsPath();
    const text3 = readFileSync6(file, "utf8");
    if (revisionOf(text3) !== expectedRevision) return { state: "revision_conflict", current_revision: revisionOf(text3) };
    const data = JSON.parse(text3);
    const invalid = (code, field, message) => ({ state: "validation_error", errors: [{ code, file: IMPORTS_FILE, field, message }] });
    for (const [section, entries] of Object.entries(updates || {})) {
      if (!IMPORT_SECTIONS.includes(section)) return invalid("CONFIG_VALUE_INVALID", section, "\u4E0D\u662F\u53EF\u7F16\u8F91\u7684\u8D44\u6E90\u7C7B\u522B");
      for (const [name, fields] of Object.entries(entries)) {
        const entry = data[section][name] ??= {};
        for (const [field, value] of Object.entries(fields)) {
          const at2 = `${section}.${name}.${field}`;
          if (section === "tools" && data.required_tools.includes(name) && field !== "label") return invalid("CONFIG_VALUE_INVALID", at2, "\u8FD0\u884C\u5FC5\u9700\u7684\u5DE5\u5177\u53EA\u80FD\u4FEE\u6539\u663E\u793A\u540D");
          if (typeof value !== "string") return invalid("CONFIG_VALUE_INVALID", at2, "\u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
          if (value.trim()) entry[field] = value.trim();
          else delete entry[field];
        }
      }
    }
    const candidate = `${JSON.stringify(data, null, 2)}
`;
    const temporary = `${file}.panel-tmp-${randomBytes2(4).toString("hex")}`;
    writeFileSync3(temporary, candidate, "utf8");
    try {
      loadWorkerResourcesConfig(temporary);
    } catch (error) {
      rmSync2(temporary, { force: true });
      if (!error.field) throw error;
      return invalid(error.code, error.field, error.message.slice(error.message.indexOf("\uFF1A") + 1));
    }
    const fresh = readFileSync6(file, "utf8");
    if (revisionOf(fresh) !== expectedRevision) {
      rmSync2(temporary, { force: true });
      return { state: "revision_conflict", current_revision: revisionOf(fresh) };
    }
    renameSync3(temporary, file);
    return { state: "saved", revision: revisionOf(candidate), write_results: [{ file: IMPORTS_FILE, ok: true }], ...sync.syncWritten([IMPORTS_FILE]) };
  }
  return { state, configState, resourceCatalog, catalogs, refreshCatalogs, saveRole, saveImports, close };
}

// src/agent-panel/src/server/selection-store.mjs
import { spawnSync as spawnSync2 } from "node:child_process";
import { createHash as createHash4, randomBytes as randomBytes3 } from "node:crypto";
import { copyFileSync as copyFileSync2, existsSync as existsSync6, mkdirSync as mkdirSync4, mkdtempSync, readFileSync as readFileSync7, readdirSync as readdirSync4, renameSync as renameSync4, rmSync as rmSync3, writeFileSync as writeFileSync4 } from "node:fs";
import os2 from "node:os";
import path8 from "node:path";
var NOTES = "ops/model-notes.toml";
var LABELS = "ops/panel-labels.toml";
var ROUTES = "ops/protocols/task-package-routes";
var PYTHON_PARSE = "import json,sys,tomllib; print(json.dumps({k:tomllib.loads(v) for k,v in json.load(sys.stdin).items()}))";
var PICK_FIELDS = ["id", "when", "capability", "model", "effort", "effort_min", "effort_max", "default"];
var OPTIONAL_PICK_FIELDS = ["when", "capability", "default"];
var FIXED_PICKS = Object.freeze({ "delegate-work": ["luna_xhigh", "luna_max", "sol_high"] });
var EFFORT_FIELDS = { effort_min: "\u6700\u4F4E\u6863\u4F4D", effort: "\u9ED8\u8BA4\u6863\u4F4D", effort_max: "\u6700\u9AD8\u6863\u4F4D" };
var SelectionError = class extends PanelError {
  constructor(code, message, details = null, status = 422) {
    super(code, message, { status, scope: "local", details });
  }
};
function revision(text3) {
  return createHash4("sha256").update(text3, "utf8").digest("hex").slice(0, 12);
}
function absolute(root, relative) {
  return path8.join(root, ...relative.split("/"));
}
function relativeFile(root, file) {
  return path8.relative(root, file).split(path8.sep).join("/");
}
function roleFile(role) {
  return `ops/agents/${role}.toml`;
}
function editablePicks(picks) {
  if (!Array.isArray(picks)) throw new SelectionError("SELECTION_DRAFT_INVALID", "\u63A8\u8350\u884C\u5FC5\u987B\u662F\u6570\u7EC4");
  return picks.map((pick) => {
    if (!pick || typeof pick !== "object" || Array.isArray(pick)) throw new SelectionError("SELECTION_DRAFT_INVALID", "\u63A8\u8350\u884C\u5FC5\u987B\u662F\u5BF9\u8C61");
    const entry = Object.fromEntries(PICK_FIELDS.filter((key) => Object.hasOwn(pick, key)).map((key) => [key, pick[key]]));
    for (const key of OPTIONAL_PICK_FIELDS) if (entry[key] === "" || entry[key] === null || entry[key] === false) delete entry[key];
    return entry;
  });
}
function clearOptionalPickFields(text3, picks) {
  const wanted = new Map(picks.map((pick) => [pick.id, pick]));
  const lines = text3.split("\n");
  const headers = [];
  let triple = null;
  let depth = 0;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    if (!triple && depth === 0 && /^\s*\[\[?[^\]\r\n]+\]\]?\s*(?:#.*)?$/.test(line)) {
      headers.push({ row, pick: /^\s*\[\[picks\]\]\s*(?:#.*)?$/.test(line) });
    }
    let quote = null;
    for (let index = 0; index < line.length; index += 1) {
      if (triple) {
        if (line.startsWith(triple, index)) {
          triple = null;
          index += 2;
        }
        continue;
      }
      if (quote) {
        if (quote === '"' && line[index] === "\\") {
          index++;
          continue;
        }
        if (line[index] === quote) quote = null;
        continue;
      }
      if (line[index] === "#") break;
      if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
        triple = line.slice(index, index + 3);
        index += 2;
      } else if (line[index] === '"' || line[index] === "'") quote = line[index];
      else if (line[index] === "[") depth++;
      else if (line[index] === "]") depth = Math.max(0, depth - 1);
    }
  }
  const removed = /* @__PURE__ */ new Set();
  const optional = new RegExp(`^\\s*(${OPTIONAL_PICK_FIELDS.join("|")})\\s*=`);
  for (let index = 0; index < headers.length; index += 1) {
    const block = headers[index];
    if (!block.pick) continue;
    const end = headers[index + 1]?.row ?? lines.length;
    const idLine = lines.slice(block.row + 1, end).find((line) => /^\s*id\s*=/.test(line));
    const target = idLine && wanted.get(parse2(idLine).id);
    if (!target) continue;
    for (let row = block.row + 1; row < end; row += 1) {
      const field = optional.exec(lines[row])?.[1];
      if (field && !Object.hasOwn(target, field)) removed.add(row);
    }
  }
  return lines.filter((_2, row) => !removed.has(row)).join("\n");
}
function equalData(left, right) {
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, i2) => equalData(item, right[i2]));
  if (left && typeof left === "object") return right && typeof right === "object" && !Array.isArray(right) && Object.keys(left).length === Object.keys(right).length && Object.keys(left).every((key) => Object.hasOwn(right, key) && equalData(left[key], right[key]));
  return left === right;
}
function located({ code, file, field = null, role, pick_id: pickId, message }, root, picksOf) {
  const relative = file ? relativeFile(root, file) : null;
  const owner = role ?? /^ops\/agents\/([^/]+)\.toml$/.exec(relative ?? "")?.[1];
  const index = /^picks\[(\d+)\]/.exec(field ?? "")?.[1];
  const pick = pickId ?? (owner && index !== void 0 ? picksOf(owner)?.[Number(index)]?.id : void 0);
  return { code, file: relative, field, ...owner && { role: owner }, ...pick && { pick_id: pick }, message };
}
function candidateError(error, root, picksOf) {
  if (error instanceof TomlWritebackError) {
    return located({ code: error.code, file: error.file, message: error.message }, root, picksOf);
  }
  if (!(error instanceof ToolError)) throw error;
  return located({
    code: error.code ?? "SELECTION_CONFIG_INVALID",
    file: error.file,
    field: error.field,
    role: error.role,
    pick_id: error.pick_id,
    message: error.message.slice(error.message.indexOf("\uFF1A") + 1)
  }, root, picksOf);
}
function effortsInUse(targets, roles) {
  const notes = targets[NOTES]?.notes;
  if (!notes) return [];
  return Object.entries(roles).flatMap(([role, saved]) => (targets[roleFile(role)]?.picks ?? saved).flatMap((pick) => {
    const levels = notes[pick.model]?.efforts;
    return levels ? Object.keys(EFFORT_FIELDS).filter((field) => !levels.includes(pick[field])).map((field) => ({
      code: "EFFORT_IN_USE",
      file: NOTES,
      field: `notes."${pick.model}".efforts`,
      role,
      pick_id: pick.id,
      message: `${pick[field]} \u4ECD\u662F\u63A8\u8350\u884C ${pick.id} \u7684${EFFORT_FIELDS[field]}`
    })) : [];
  }));
}
function fileOrder(a2, b2) {
  return (a2 === NOTES ? 0 : 1) - (b2 === NOTES ? 0 : 1) || a2.localeCompare(b2);
}
function modelSources(root) {
  return resolveModelConfigSources({ roots: [{ root, source: "control_repo" }], projectRoot: root });
}
function createSelectionStore(options = {}) {
  const sync = options.sync || createConfigSync({ ...options, faultInjector: options.syncFaultInjector });
  const pythonCommand = options.pythonCommand || process.env.AGENT_PANEL_PYTHON || "python";
  const faultInjector = options.faultInjector;
  let cached = null;
  function readSnapshot() {
    const root = sync.resolveSources().control_root;
    const roleFiles = readdirSync4(path8.join(root, "ops", "agents")).filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/.test(name)).sort().map((name) => `ops/agents/${name}`);
    const files = [NOTES, ...roleFiles];
    const texts = Object.fromEntries(files.map((file) => [file, readFileSync7(absolute(root, file), "utf8")]));
    const revisions = Object.fromEntries(files.map((file) => [file, revision(texts[file])]));
    const key = JSON.stringify(revisions);
    if (!cached || cached.root !== root || cached.key !== key) {
      const sources = modelSources(root);
      const parsed = Object.fromEntries(files.map((file) => [file, parse2(texts[file])]));
      const editable = {
        roles: Object.fromEntries(roleFiles.map((file) => [path8.basename(file, ".toml"), editablePicks(parsed[file].picks || [])])),
        efforts: Object.fromEntries(Object.entries(parsed[NOTES].notes || {}).filter(([, note]) => note.efforts).map(([model, note]) => [model, note.efforts]))
      };
      let config;
      try {
        config = loadSelectionConfig(sources);
      } catch (error) {
        const failure = candidateError(error, root, (role) => editable.roles[role]);
        throw new SelectionError(failure.code, failure.message, failure);
      }
      cached = { root, key, files, texts, revisions, parsed, config, editable, sources };
    }
    return cached;
  }
  function readLabels(root) {
    const file = absolute(root, LABELS);
    return existsSync6(file) ? parse2(readFileSync7(file, "utf8")) : {};
  }
  function selectionState(configState = {}, monitorRoot = null) {
    const snapshot = readSnapshot();
    const pi2 = configState.catalogs?.pi ?? { available: false, error: "", models: [] };
    const piModels = pi2.available ? pi2.models.map((entry) => entry.value) : null;
    let projectOverride = null;
    if (monitorRoot && path8.resolve(monitorRoot) !== snapshot.root) {
      const monitoredSources = resolveModelConfigSources({ roots: [{ root: snapshot.root }], projectRoot: monitorRoot }).describe();
      if (monitoredSources.project_override) projectOverride = monitoredSources;
    }
    const catalog = projectCatalog(snapshot.config, { piModels });
    catalog.warnings = catalog.warnings.map((warning) => located({ code: "SELECTION_WARNING", ...warning }, snapshot.root, (role) => snapshot.editable.roles[role]));
    return {
      catalog,
      effort_levels: [...EFFORT_LEVELS],
      fixed_picks: FIXED_PICKS,
      labels: readLabels(snapshot.root),
      editable: snapshot.editable,
      revisions: snapshot.revisions,
      pi_catalog: pi2,
      project_override: projectOverride,
      sync_status: configState.sync_status ?? sync.status()
    };
  }
  function draftTargets(draft, snapshot) {
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new SelectionError("SELECTION_DRAFT_INVALID", "\u8349\u7A3F\u5FC5\u987B\u662F\u5BF9\u8C61");
    const targets = {};
    for (const [role, picks] of Object.entries(draft.roles || {})) {
      if (!Object.hasOwn(snapshot.editable.roles, role)) throw new SelectionError("SELECTION_ROLE_INVALID", `\u89D2\u8272\u4E0D\u5B58\u5728\uFF1A${role}`);
      const target = editablePicks(picks);
      if (!equalData(target, snapshot.editable.roles[role])) targets[roleFile(role)] = { picks: target };
    }
    const efforts = Object.entries(draft.efforts || {}).filter(([model, levels]) => {
      if (!Array.isArray(levels)) throw new SelectionError("SELECTION_DRAFT_INVALID", `\u53EF\u9009\u6863\u4F4D\u5FC5\u987B\u662F\u6570\u7EC4\uFF1A${model}`);
      return !equalData(levels, snapshot.editable.efforts[model] ?? EFFORT_LEVELS);
    });
    if (efforts.length) targets[NOTES] = { notes: Object.fromEntries(efforts.map(([model, levels]) => [model, { efforts: levels }])) };
    return targets;
  }
  function written(file, data, target) {
    if (file !== NOTES) return equalData(editablePicks(data.picks || []), target.picks);
    return Object.entries(target.notes).every(([model, note]) => equalData(data.notes?.[model]?.efforts, note.efforts));
  }
  function validateCandidates(snapshot, candidates, picksOf) {
    const root = mkdtempSync(path8.join(os2.tmpdir(), "panel-selection-"));
    try {
      for (const file of snapshot.files) {
        mkdirSync4(path8.dirname(absolute(root, file)), { recursive: true });
        writeFileSync4(absolute(root, file), candidates[file] ?? snapshot.texts[file]);
      }
      const routes = absolute(snapshot.root, ROUTES);
      if (existsSync6(routes)) {
        mkdirSync4(absolute(root, ROUTES), { recursive: true });
        for (const name of readdirSync4(routes).filter((item) => item.endsWith(".md"))) copyFileSync2(path8.join(routes, name), path8.join(absolute(root, ROUTES), name));
      }
      try {
        loadSelectionConfig(modelSources(root));
      } catch (error) {
        return candidateError(error, root, picksOf);
      }
      const parsed = spawnSync2(pythonCommand, ["-c", PYTHON_PARSE], {
        input: JSON.stringify(candidates),
        encoding: "utf8",
        timeout: 15e3,
        windowsHide: true
      });
      if (parsed.error || parsed.status !== 0) throw new SelectionError("SELECTION_PYTHON_FAILED", "Python tomllib \u6821\u9A8C\u5931\u8D25", { reason: parsed.error?.message || parsed.stderr }, 503);
      const python = JSON.parse(parsed.stdout);
      const mismatch = Object.keys(candidates).find((file) => !equalData(parse2(candidates[file]), python[file]));
      return mismatch ? { code: "SELECTION_SEMANTIC_MISMATCH", file: mismatch, field: null, message: "\u5019\u9009\u6587\u4EF6\u53CC\u89E3\u6790\u7ED3\u679C\u4E0D\u4E00\u81F4" } : null;
    } finally {
      rmSync3(root, { recursive: true, force: true });
    }
  }
  function saveSelection({ draft, expected_revision: expectedRevision } = {}, configState = {}, monitorRoot = null) {
    const snapshot = readSnapshot();
    const unknown = Object.entries(draft?.roles || {}).flatMap(([role, picks]) => (Array.isArray(picks) ? picks : []).flatMap((pick, index) => Object.keys(pick || {}).filter((key) => !PICK_FIELDS.includes(key)).map((key) => ({ code: "PICK_FIELD_UNKNOWN", file: roleFile(role), field: `picks[${index}].${key}`, role, pick_id: pick.id, message: `\u542B\u9762\u677F\u4E0D\u652F\u6301\u7684\u914D\u7F6E\u9879\u300C${key}\u300D\uFF0C\u4FDD\u5B58\u5DF2\u62D2\u7EDD` }))));
    if (unknown.length) return { state: "validation_error", errors: unknown };
    const targets = draftTargets(draft, snapshot);
    const changed = Object.keys(targets).sort(fileOrder);
    const stale = changed.find((file) => expectedRevision?.[file] !== snapshot.revisions[file]);
    if (stale) return { state: "revision_conflict", file: stale, current_revision: snapshot.revisions[stale] };
    const inUse = effortsInUse(targets, snapshot.editable.roles);
    if (inUse.length) return { state: "validation_error", errors: inUse };
    const picksOf = (role) => targets[roleFile(role)]?.picks ?? snapshot.editable.roles[role];
    const candidates = {};
    for (const file of changed) {
      try {
        candidates[file] = patchDocument(snapshot.texts[file], targets[file], { file: absolute(snapshot.root, file) });
      } catch (error) {
        if (!(error instanceof TomlWritebackError)) throw error;
        return { state: "validation_error", errors: [candidateError(error, snapshot.root, picksOf)] };
      }
      if (file !== NOTES) candidates[file] = clearOptionalPickFields(candidates[file], targets[file].picks);
      if (!written(file, parse2(candidates[file]), targets[file])) {
        return { state: "validation_error", errors: [{ code: "SELECTION_SEMANTIC_MISMATCH", file, field: null, message: "\u5199\u56DE\u7ED3\u679C\u4E0E\u8349\u7A3F\u4E0D\u4E00\u81F4" }] };
      }
    }
    if (changed.length) {
      const error = validateCandidates(snapshot, candidates, picksOf);
      if (error) return { state: "validation_error", errors: [error] };
    }
    faultInjector?.({ op: "before-cas", files: changed });
    for (const file of changed) {
      const fresh = readFileSync7(absolute(snapshot.root, file), "utf8");
      if (revision(fresh) !== expectedRevision[file]) {
        cached = null;
        return { state: "revision_conflict", file, current_revision: revision(fresh) };
      }
    }
    const staged = [];
    const swapped = [];
    const restoreErrors = [];
    try {
      for (const file of changed) {
        const destination = absolute(snapshot.root, file);
        const suffix = randomBytes3(8).toString("hex");
        const temporary = `${destination}.panel-tmp-${suffix}`;
        const backup = `${destination}.panel-bak-${suffix}`;
        copyFileSync2(destination, backup);
        staged.push({ file, destination, temporary, backup });
        writeFileSync4(temporary, candidates[file], "utf8");
      }
      for (const item of staged) {
        faultInjector?.({ op: "before-rename", file: item.file });
        renameSync4(item.temporary, item.destination);
        swapped.push(item);
        if (readFileSync7(item.destination, "utf8") !== candidates[item.file]) throw new Error(`post-write verification failed: ${item.file}`);
      }
    } catch (error) {
      for (const item of [...swapped].reverse()) {
        try {
          copyFileSync2(item.backup, item.destination);
        } catch (restoreError) {
          restoreErrors.push({ file: item.file, reason: restoreError.message, backup: item.backup });
        }
      }
      throw new SelectionError(
        restoreErrors.length ? "SELECTION_RESTORE_FAILED" : "SELECTION_WRITE_FAILED",
        "\u591A\u6587\u4EF6\u5199\u5165\u5931\u8D25",
        { cause: error.message, restore_errors: restoreErrors },
        503
      );
    } finally {
      for (const item of staged) {
        rmSync3(item.temporary, { force: true });
        if (existsSync6(item.backup) && !restoreErrors.some((failure) => failure.file === item.file)) rmSync3(item.backup, { force: true });
      }
      cached = null;
    }
    const results = sync.syncWritten(changed);
    return {
      state: "saved",
      selection: selectionState(configState, monitorRoot),
      write_results: changed.map((file) => ({ file, ok: true })),
      ...results
    };
  }
  return { selectionState, saveSelection, sync: () => sync.reconcile() };
}

// src/agent-panel/src/server/config-worker.mjs
var store = createConfigStore(workerData);
var selection = createSelectionStore({ ...workerData, faultInjector: workerData.selectionFaultInjector });
var methods = /* @__PURE__ */ new Set(["state", "configState", "resourceCatalog", "refreshCatalogs", "saveRole", "saveImports", "selectionState", "saveSelection", "sync", "close"]);
var writes = /* @__PURE__ */ new Set(["saveRole", "saveImports", "saveSelection", "sync"]);
var writeTail = Promise.resolve();
parentPort.on("message", async ({ id, method, args }) => {
  try {
    if (!methods.has(method)) throw new Error("unsupported config method");
    const invoke = () => method === "selectionState" ? selection.selectionState({ catalogs: store.catalogs() }, ...args) : method === "saveSelection" ? selection.saveSelection(args[0], { catalogs: store.catalogs() }, args[1]) : method === "sync" ? selection.sync() : store[method](...args);
    let result;
    if (method === "close") {
      await writeTail;
      result = await invoke();
    } else if (writes.has(method)) {
      const queued = writeTail.then(invoke);
      writeTail = queued.catch(() => {
      });
      result = await queued;
    } else result = await invoke();
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: {
      code: error.code || "CONFIG_SERVICE_FAILED",
      message: error.code ? error.message : "\u914D\u7F6E\u5904\u7406\u5931\u8D25",
      status: error.status || 503,
      scope: "local",
      details: error.details || null
    } });
  }
});
