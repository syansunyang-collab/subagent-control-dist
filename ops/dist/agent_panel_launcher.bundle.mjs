#!/usr/bin/env node

// ops/tools/agent_panel_launcher.mjs
import process3 from "node:process";

// ops/tools/dispatch-core/agent_panel_launcher.mjs
import { createHash as createHash2 } from "node:crypto";
import { closeSync as closeSync2, mkdirSync as mkdirSync2, openSync as openSync2, readdirSync, readFileSync as readFileSync2, renameSync as renameSync2, rmSync, statSync as statSync2, writeFileSync, writeSync as writeSync2 } from "node:fs";
import net from "node:net";
import path2 from "node:path";
import { homedir } from "node:os";
import process2 from "node:process";
import { spawn as spawnChild, spawnSync } from "node:child_process";

// ops/tools/dispatch-core/_tool_common.mjs
import { createHash, randomUUID } from "node:crypto";
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
function pyError(type, message) {
  const error = new Error(message);
  error.name = String(type);
  return error;
}
var frozen = null;
function withUuid4Bits(hex32) {
  let raw = BigInt(`0x${hex32}`);
  raw = raw & ~(0xFn << 76n) | 0x4n << 76n;
  raw = raw & ~(0x3n << 62n) | 0x2n << 62n;
  return raw.toString(16).padStart(32, "0");
}
function uuidFromSeed(seed, index) {
  return withUuid4Bits(createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 32));
}
var clock = {
  now() {
    return frozen ? new Date(frozen.nowMs) : /* @__PURE__ */ new Date();
  }
};
var ids = {
  uuidHex() {
    if (frozen) {
      const value = uuidFromSeed(frozen.uuidSeed, frozen.uuidIndex);
      frozen.uuidIndex += 1;
      return value;
    }
    return randomUUID().replace(/-/g, "");
  }
};
function utcNow() {
  const now = clock.now();
  const base = now.toISOString().slice(0, 19);
  const micros = frozen?.micros ?? `${String(now.getUTCMilliseconds()).padStart(3, "0")}000`;
  const fraction = micros === "000000" ? "" : `.${micros}`;
  return `${base}${fraction}+00:00`;
}
function isAbsoluteLikePython(value) {
  const text = String(value ?? "");
  if (process.platform !== "win32") return text.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(text) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(text);
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
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ops/tools/dispatch-core/_py.mjs
var PY_SPACE_CLASS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
var PY_SPACE_RE = new RegExp(`[${PY_SPACE_CLASS}]`);
var RE_LSTRIP = new RegExp(`^[${PY_SPACE_CLASS}]+`);
var RE_RSTRIP = new RegExp(`[${PY_SPACE_CLASS}]+$`);
var NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
function pyRepr(value) {
  if (value === null || value === void 0) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isRecord(value)) return `{${Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`).join(", ")}}`;
  const text = String(value);
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "	") out += "\\t";
    else if (ch === " " || !NON_PRINTABLE_RE.test(ch)) out += ch;
    else if (code <= 255) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 65535) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}
function pyTypeName(value) {
  if (value === null || value === void 0) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return "dict";
}
function pyKeyError(message) {
  return pyError("KeyError", pyRepr(message));
}
function pyGetItem(container, key) {
  if (isRecord(container)) {
    if (!Object.hasOwn(container, key)) throw pyKeyError(key);
    return container[key];
  }
  if (Array.isArray(container)) {
    throw pyError("TypeError", `list indices must be integers or slices, not ${pyTypeName(key)}`);
  }
  if (typeof container === "string") {
    throw pyError("TypeError", `string indices must be integers, not '${pyTypeName(key)}'`);
  }
  throw pyError("TypeError", `'${pyTypeName(container)}' object is not subscriptable`);
}

// ops/tools/dispatch-core/agent_panel_launcher.mjs
var MONITOR_ROOT = path2.resolve(process2.env.SUBAGENT_PROJECT_ROOT || process2.cwd());
var PANEL_STATE_ROOT = path2.resolve(process2.env.AGENT_PANEL_STATE_ROOT || path2.join(homedir(), ".subagent-control", "agent-panel"));
function releasedPanelAssetRoot() {
  try {
    return JSON.parse(readFileSync2(path2.join(PANEL_STATE_ROOT, "runtime-root.json"), "utf8")).root;
  } catch {
    return void 0;
  }
}
var PANEL_ASSET_ROOT = path2.resolve(
  process2.env.AGENT_PANEL_RUNTIME_ROOT || releasedPanelAssetRoot() || path2.join(homedir(), ".pi", "agent", "extensions", "subagent-control")
);
var PANEL_ROOT = path2.join(PANEL_ASSET_ROOT, "src", "agent-panel");
var SHELL_ROOT = path2.join(PANEL_ROOT, "shell");
var PROJECT_FILE = path2.join(SHELL_ROOT, "AgentPanel.Shell.csproj");
var RUNTIME_ROOT2 = PANEL_STATE_ROOT;
var ENDPOINT_PATH = path2.join(RUNTIME_ROOT2, "endpoint.json");
var MANIFEST_PATH = path2.join(RUNTIME_ROOT2, "build-manifest.json");
var BUILD_STATE_PATH = path2.join(RUNTIME_ROOT2, "build-state.json");
var BUILD_LOG_PATH = path2.join(RUNTIME_ROOT2, "last-build.log");
var BUILD_LOCK_PATH = path2.join(RUNTIME_ROOT2, "build.lock");
var SHELL_STATE_PATH = path2.join(RUNTIME_ROOT2, "shell-state.json");
var PORT_BASE = 43e3;
var PORT_SPAN = 1e3;
var DEFAULT_PATHS = Object.freeze({
  panelRoot: PANEL_ROOT,
  controlRoot: MONITOR_ROOT,
  assetRoot: PANEL_ASSET_ROOT,
  projectFile: PROJECT_FILE,
  runtimeRoot: RUNTIME_ROOT2,
  endpointPath: ENDPOINT_PATH,
  manifestPath: MANIFEST_PATH,
  buildStatePath: BUILD_STATE_PATH,
  buildLogPath: BUILD_LOG_PATH,
  buildLockPath: BUILD_LOCK_PATH,
  shellStatePath: SHELL_STATE_PATH,
  buildScript: path2.join(PANEL_ASSET_ROOT, "ops", "dist", "agent_panel_launcher.bundle.mjs")
});
var STILL_ACTIVE_LOCK_STALE_SECONDS = 600;
function textOrEmpty(value) {
  if (typeof value === "string") return value;
  if (value === null || value === void 0 || value === false) return "";
  if (value === true) return "True";
  if (typeof value === "number") return value === 0 ? "" : String(value);
  return "";
}
function filled(value) {
  return isRecord(value) ? Object.keys(value).length > 0 : Boolean(value);
}
function isFile(target) {
  try {
    return statSync2(target).isFile();
  } catch {
    return false;
  }
}
function errorText(error) {
  if (error === null || error === void 0) return "None";
  return typeof error?.message === "string" ? error.message : String(error);
}
function rstripSlash(value) {
  return String(value).replace(/\/+$/, "");
}
function resolveDeps(overrides = {}) {
  if (overrides && overrides.__resolved === true) return overrides;
  const deps = {
    __resolved: true,
    isProcessAlive,
    portIsFree,
    probeHealth,
    readJson,
    writeJson,
    spawnDetached,
    runCapture,
    now: utcNow2,
    currentPid: () => process2.pid,
    uuidHex: () => ids.uuidHex(),
    ...overrides,
    paths: { ...DEFAULT_PATHS, ...overrides.paths || {} }
  };
  deps.isOurPanel ??= (payload, endpoint) => isOurPanel(payload, endpoint);
  deps.allocateEndpoint ??= () => allocateEndpoint({ deps });
  deps.rememberProject ??= () => rememberProject({ deps });
  deps.validManifest ??= () => validManifest({ deps });
  deps.runningShell ??= () => runningShell({ deps });
  deps.buildRunning ??= () => buildRunning({ deps });
  deps.acquireBuildLock ??= () => acquireBuildLock({ deps });
  deps.startShell ??= (executable, endpoint) => startShell(executable, endpoint, { deps });
  deps.startBackgroundBuild ??= () => startBackgroundBuild({ deps });
  return deps;
}
function spawnDetached(argv, { cwd, env } = {}) {
  const child = spawnChild(argv[0], argv.slice(1), {
    cwd,
    env,
    stdio: "ignore",
    detached: true,
    windowsHide: true
  });
  child.unref();
  return { pid: child.pid };
}
function runCapture(argv, { cwd } = {}) {
  const proc = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  const stdout = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  return { returncode: proc.error ? 1 : proc.status ?? 1, stdout: proc.error ? `${stdout}${proc.error.message}` : stdout };
}
function utcNow2() {
  return utcNow().replace("+00:00", "Z");
}
function readJson(file) {
  try {
    const value = JSON.parse(readFileSync2(file, "utf8"));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
function writeJson(file, value) {
  mkdirSync2(path2.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  renameSync2(temp, file);
  return null;
}
function normalizeIdentityPath(value) {
  const text = resolveLikePython(String(value)).replaceAll("\\", "/");
  return process2.platform === "win32" ? text.toLowerCase() : text;
}
function deriveEndpoint(panelRoot = PANEL_ROOT, controlRoot = MONITOR_ROOT) {
  const panelDigest = createHash2("sha256").update(normalizeIdentityPath(panelRoot), "utf8").digest();
  const port = PORT_BASE + panelDigest.readUInt16BE(0) % PORT_SPAN;
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    panel_root: normalizeIdentityPath(panelRoot),
    control_root: normalizeIdentityPath(controlRoot)
  };
}
function rememberProject({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const root = resolveLikePython(resolved.paths.controlRoot);
  const key = createHash2("sha256").update(normalizeIdentityPath(root)).digest("hex");
  resolved.writeJson(path2.join(resolved.paths.runtimeRoot, "projects", `${key}.json`), { project_root: root });
}
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: "127.0.0.1", port: Number(port), exclusive: true }, () => probe.close(() => resolve(true)));
  });
}
async function probeHealth(port, { timeout = 0.75 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${Number(port)}/api/health`, {
      signal: AbortSignal.timeout(Math.round(timeout * 1e3))
    });
    if (!response.ok) return {};
    const payload = JSON.parse(await response.text());
    return isRecord(payload) ? payload : {};
  } catch {
    return {};
  }
}
function isOurPanel(payload, endpoint) {
  return payload?.ok === true && payload.contract_version === "async-task-service/v1" && normalizeIdentityPath(textOrEmpty(payload.panel_root)) === pyGetItem(endpoint, "panel_root") && rstripSlash(textOrEmpty(payload.resolved_loopback_url)) === rstripSlash(pyGetItem(endpoint, "url"));
}
async function allocateEndpoint({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const endpoint = deriveEndpoint(resolved.paths.panelRoot, resolved.paths.controlRoot);
  const health = await resolved.probeHealth(Number(endpoint.port));
  if (!await resolved.portIsFree(Number(endpoint.port)) && !resolved.isOurPanel(health, endpoint)) {
    throw pyError("RuntimeError", `Agent Panel \u56FA\u5B9A\u7AEF\u53E3 ${endpoint.port} \u5DF2\u88AB\u5176\u4ED6\u670D\u52A1\u5360\u7528\uFF1B\u505C\u6B62\u5360\u7528\u8005\u540E\u91CD\u8BD5`);
  }
  endpoint.updated_at = resolved.now();
  resolved.writeJson(resolved.paths.endpointPath, endpoint);
  return endpoint;
}
function isProcessAlive(pid) {
  let value;
  if (typeof pid === "number") {
    if (!Number.isFinite(pid)) return false;
    value = Math.trunc(pid);
  } else if (typeof pid === "string") {
    const text = pid.trim();
    if (!/^[+-]?\d+$/.test(text)) return false;
    value = Number(text);
  } else if (typeof pid === "boolean") {
    value = pid ? 1 : 0;
  } else {
    return false;
  }
  if (value <= 0) return false;
  try {
    process2.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function runningShell({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const state = resolved.readJson(resolved.paths.shellStatePath);
  return state?.running === true && resolved.isProcessAlive(state.pid) ? state : {};
}
function buildRunning({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const state = resolved.readJson(resolved.paths.buildStatePath);
  return state?.status === "running" && resolved.isProcessAlive(state.pid);
}
function runtimeBuildId({ deps } = {}) {
  const resolved = resolveDeps(deps);
  return resolved.readJson(path2.join(resolved.paths.assetRoot, "ops", "dist", "subagent_service.manifest.json")).build_id ?? null;
}
function validManifest({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const manifest = resolved.readJson(resolved.paths.manifestPath);
  const executable = textOrEmpty(manifest?.executable);
  return executable && isFile(executable) && manifest.runtime_build_id === runtimeBuildId({ deps: resolved }) ? manifest : {};
}
function launchOptions(resolved) {
  return {
    cwd: String(resolved.paths.panelRoot),
    env: {
      ...process2.env,
      SUBAGENT_PROJECT_ROOT: resolved.paths.controlRoot,
      SUBAGENT_CONTROL_REPO_ROOT: resolved.paths.controlRoot,
      SUBAGENT_RUNTIME_ROOT: resolved.paths.assetRoot,
      AGENT_PANEL_RUNTIME_ROOT: resolved.paths.assetRoot,
      AGENT_PANEL_STATE_ROOT: resolved.paths.runtimeRoot
    }
  };
}
function startShell(executable, endpoint, { deps } = {}) {
  const resolved = resolveDeps(deps);
  const child = resolved.spawnDetached(
    [
      String(executable),
      "--repository-root",
      String(resolved.paths.panelRoot),
      "--control-repo",
      String(resolved.paths.controlRoot),
      "--service-entry",
      "../../ops/dist/agent_panel_server.bundle.mjs",
      "--port",
      String(pyGetItem(endpoint, "port")),
      "--loopback-url",
      String(pyGetItem(endpoint, "url"))
    ],
    launchOptions(resolved)
  );
  const state = {
    running: true,
    pid: child.pid,
    executable: String(executable),
    url: endpoint.url,
    started_at: resolved.now()
  };
  resolved.writeJson(resolved.paths.shellStatePath, state);
  return { status: "started", ...state };
}
function startBackgroundBuild({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const child = resolved.spawnDetached(
    [process2.execPath, String(resolved.paths.buildScript), "--background-build"],
    launchOptions(resolved)
  );
  resolved.writeJson(resolved.paths.buildStatePath, {
    status: "running",
    pid: child.pid,
    started_at: resolved.now()
  });
  return child.pid;
}
async function ensureAgentPanel({ deps } = {}) {
  const resolved = resolveDeps(deps);
  try {
    if (!isFile(resolved.paths.projectFile)) {
      throw pyError("RuntimeError", `Agent Panel shell project is missing: ${resolved.paths.projectFile}`);
    }
    resolved.rememberProject();
    const endpoint = await resolved.allocateEndpoint();
    const manifest = resolved.validManifest();
    const health = await resolved.probeHealth(Number(pyGetItem(endpoint, "port")));
    if (resolved.isOurPanel(health, endpoint)) return { status: "already_running", ...endpoint, monitor_root: health.control_repo_path };
    const shell = resolved.runningShell();
    if (filled(shell)) return { status: "starting", pid: shell.pid, ...endpoint };
    if (filled(manifest)) return resolved.startShell(String(pyGetItem(manifest, "executable")), endpoint);
    if (resolved.buildRunning()) return { status: "build_started", build_in_progress: true, ...endpoint };
    const pid = resolved.startBackgroundBuild();
    return { status: "build_started", pid, log_path: String(resolved.paths.buildLogPath), ...endpoint };
  } catch (error) {
    return { status: "failed", error: errorText(error), log_path: String(resolved.paths.buildLogPath) };
  }
}
function acquireBuildLock({ deps } = {}) {
  const resolved = resolveDeps(deps);
  mkdirSync2(resolved.paths.runtimeRoot, { recursive: true });
  try {
    return openSync2(resolved.paths.buildLockPath, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  try {
    const stale = Date.now() / 1e3 - statSync2(resolved.paths.buildLockPath).mtimeMs / 1e3;
    if (stale > STILL_ACTIVE_LOCK_STALE_SECONDS && !resolved.buildRunning()) {
      rmSync(resolved.paths.buildLockPath, { force: true });
      return openSync2(resolved.paths.buildLockPath, "wx");
    }
  } catch {
  }
  return null;
}
function directoryBytes(root) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path2.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync2(full).size;
    }
  };
  walk(root);
  return total;
}
async function backgroundBuild({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const lock = resolved.acquireBuildLock();
  if (lock === null) return 0;
  writeSync2(lock, String(resolved.currentPid()), null, "ascii");
  closeSync2(lock);
  const started = performance.now();
  const buildInstance = resolved.uuidHex();
  try {
    const buildRoot = resolveLikePython(path2.join(resolved.paths.runtimeRoot, "builds", buildInstance));
    const inside = path2.relative(resolveLikePython(resolved.paths.runtimeRoot), buildRoot);
    if (inside.startsWith("..") || path2.isAbsolute(inside)) {
      throw pyError("ValueError", `'${buildRoot}' is not in the subpath of '${resolved.paths.runtimeRoot}'`);
    }
    const appDir = path2.join(buildRoot, "app");
    const objDir = path2.join(buildRoot, "obj");
    const binDir = path2.join(buildRoot, "bin");
    mkdirSync2(appDir, { recursive: true });
    const completed = resolved.runCapture(
      [
        "dotnet",
        "publish",
        String(resolved.paths.projectFile),
        "--configuration",
        "Release",
        "--output",
        appDir,
        "--nologo",
        `-p:BaseIntermediateOutputPath=${objDir}${path2.sep}`,
        `-p:BaseOutputPath=${binDir}${path2.sep}`
      ],
      { cwd: String(resolved.paths.panelRoot) }
    );
    writeFileSync(resolved.paths.buildLogPath, String(completed.stdout ?? ""), "utf8");
    const executable = path2.join(appDir, "AgentPanel.Shell.exe");
    if (completed.returncode !== 0 || !isFile(executable)) {
      resolved.writeJson(resolved.paths.buildStatePath, {
        status: "failed",
        pid: resolved.currentPid(),
        build_instance: buildInstance,
        exit_code: completed.returncode,
        log_path: String(resolved.paths.buildLogPath),
        finished_at: resolved.now()
      });
      return 1;
    }
    const outputBytes = directoryBytes(appDir);
    const manifest = {
      build_instance: buildInstance,
      runtime_build_id: runtimeBuildId({ deps: resolved }),
      executable,
      built_at: resolved.now(),
      build_elapsed_ms: Math.round((performance.now() - started) * 1e3) / 1e3,
      output_bytes: outputBytes,
      log_path: String(resolved.paths.buildLogPath)
    };
    resolved.writeJson(resolved.paths.manifestPath, manifest);
    resolved.writeJson(resolved.paths.buildStatePath, { status: "completed", pid: resolved.currentPid(), ...manifest });
    const endpoint = await resolved.allocateEndpoint();
    const healthy = resolved.isOurPanel(await resolved.probeHealth(Number(pyGetItem(endpoint, "port"))), endpoint);
    if (!healthy && !filled(resolved.runningShell())) resolved.startShell(executable, endpoint);
    return 0;
  } catch (error) {
    resolved.writeJson(resolved.paths.buildStatePath, {
      status: "failed",
      pid: resolved.currentPid(),
      build_instance: buildInstance,
      error: errorText(error),
      log_path: String(resolved.paths.buildLogPath),
      finished_at: resolved.now()
    });
    return 1;
  } finally {
    try {
      rmSync(resolved.paths.buildLockPath, { force: true });
    } catch {
    }
  }
}
function selfTest({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const endpointA = deriveEndpoint("e:/fake/panel-a", "e:/fake/project-a");
  const endpointB = deriveEndpoint("e:/fake/panel-b", "e:/fake/project-b");
  const checks = {
    current_process_is_alive: resolved.isProcessAlive(resolved.currentPid()),
    invalid_process_is_not_alive: !resolved.isProcessAlive(-1),
    runtime_is_global: path2.resolve(RUNTIME_ROOT2) !== path2.join(MONITOR_ROOT, ".runtime", "agent-panel"),
    endpoint_derivation_is_deterministic: JSON.stringify(endpointA) === JSON.stringify(deriveEndpoint("e:/fake/panel-a", "e:/fake/project-a")),
    endpoint_port_in_range: PORT_BASE <= Number(endpointA.port) && Number(endpointA.port) < PORT_BASE + PORT_SPAN,
    different_panel_roots_get_different_ports: endpointA.port !== endpointB.port
  };
  return { status: Object.values(checks).every(Boolean) ? "pass" : "fail", checks };
}

// ops/tools/agent_panel_launcher.mjs
var USAGE = "usage: agent_panel_launcher.mjs [-h] [--build] [--status] [--self-test]";
var FLAGS = /* @__PURE__ */ new Map([
  ["--background-build", "backgroundBuild"],
  ["--build", "build"],
  ["--status", "status"],
  ["--self-test", "selfTest"]
]);
function parseArgs(argv) {
  const args = { backgroundBuild: false, build: false, status: false, selfTest: false, help: false };
  for (const token of argv) {
    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }
    const key = FLAGS.get(token);
    if (!key) {
      process3.stderr.write(`${USAGE}
agent_panel_launcher.mjs: error: unrecognized arguments: ${token}
`);
      process3.exit(2);
    }
    args[key] = true;
  }
  return args;
}
async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process3.stdout.write(
      `${USAGE}

\u6784\u5EFA\u5E76\u542F\u52A8\u5168\u5C40 Agent Panel\u3002

options:
  -h, --help   show this help message and exit
  --build      \u91CD\u65B0\u6784\u5EFA\u5168\u5C40\u684C\u9762\u58F3\uFF1B\u670D\u52A1\u8FD0\u884C\u4E2D\u65F6\u5148\u5173\u95ED\u9762\u677F\u3002
  --status     \u67E5\u770B launcher\u3001\u6784\u5EFA\u548C\u7A97\u53E3\u72B6\u6001\u3002
  --self-test  \u8FD0\u884C\u4E0D\u542F\u52A8\u7A97\u53E3\u7684\u673A\u68B0\u81EA\u6D4B\u3002
`
    );
    return 0;
  }
  if (args.backgroundBuild || args.build) return await backgroundBuild();
  let result;
  if (args.selfTest) {
    result = selfTest();
  } else if (args.status) {
    const endpoint = deriveEndpoint();
    const health = await probeHealth(Number(endpoint.port));
    result = {
      status: isOurPanel(health, endpoint) ? "running" : "stopped",
      monitor_root: health?.control_repo_path ?? null,
      endpoint: readJson(ENDPOINT_PATH),
      shell: readJson(SHELL_STATE_PATH),
      build: readJson(BUILD_STATE_PATH),
      manifest: readJson(MANIFEST_PATH)
    };
  } else {
    result = await ensureAgentPanel();
  }
  process3.stdout.write(`${JSON.stringify(result, null, 2)}
`);
  return ["failed", "fail"].includes(result.status) ? 1 : 0;
}
process3.exitCode = await main(process3.argv.slice(2));
