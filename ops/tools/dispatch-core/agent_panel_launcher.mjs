// dispatch-core：ops/tools/agent_panel_launcher.py 的 JS 复刻。保证 Agent Panel 进程存在并返回端点信息。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」；导出名为 Python 函数名的 camelCase，位置参数同序。
//
// 副作用（进程探测、端口占用、子进程、文件读写）全部经末尾 options 的 deps 注入，默认实现见 resolveDeps。
//
// 异常映射表（Python → JS）：
//   RuntimeError（端口被占、shell 项目缺失、build_root 越界）→ pyError("RuntimeError", ...)，消息逐字相同。
//   KeyError（endpoint["control_root"] / manifest["executable"] 缺键）→ pyError("KeyError", "'<key>'")。
//   FileNotFoundError / OSError / JSONDecodeError（readJson 内部）→ 与 Python 一致吞掉并返回 {}。
//   FileExistsError（acquireBuildLock 抢锁）→ Node EEXIST，同样退化为返回 null。
//   ensureAgentPanel / backgroundBuild 顶层 `except Exception` → catch 全部错误并落 status:"failed" 状态字典。
//
// 与 Python 的已知形态差异（不是行为差异）：
//   - probeHealth / portIsFree / allocateEndpoint / ensureAgentPanel / backgroundBuild 返回 Promise（Node 无同步网络原语）。
//   - creationFlags 保留原值语义，实际 spawn 用 Node 的 detached + windowsHide 表达同一意图。
//   - background_python()（pythonw.exe 择优）无 JS 对应物，后台构建改用 process.execPath 跑 CLI。
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { spawn as spawnChild, spawnSync } from "node:child_process";

import {
  ids,
  isRecord,
  pyError,
  resolveLikePython,
  utcNow as isoUtcNow,
} from "./_tool_common.mjs";
import { pyGetItem } from "./_py.mjs";

// 面板资产与缓存独立于监控仓；任务状态仍由项目承载。
export const MONITOR_ROOT = path.resolve(process.env.SUBAGENT_PROJECT_ROOT || process.cwd());
const PANEL_STATE_ROOT = path.resolve(process.env.AGENT_PANEL_STATE_ROOT || path.join(homedir(), ".subagent-control", "agent-panel"));

// 面板从部署写入的当前发布槽运行，不占用 pi 扩展目录；首次部署前没有指针时沿用扩展目录。
function releasedPanelAssetRoot() {
  try {
    return JSON.parse(readFileSync(path.join(PANEL_STATE_ROOT, "runtime-root.json"), "utf8")).root;
  } catch {
    return undefined;
  }
}

export const PANEL_ASSET_ROOT = path.resolve(
  process.env.AGENT_PANEL_RUNTIME_ROOT || releasedPanelAssetRoot() || path.join(homedir(), ".pi", "agent", "extensions", "subagent-control"),
);
export const PANEL_ROOT = path.join(PANEL_ASSET_ROOT, "src", "agent-panel");
export const SHELL_ROOT = path.join(PANEL_ROOT, "shell");
export const PROJECT_FILE = path.join(SHELL_ROOT, "AgentPanel.Shell.csproj");
export const RUNTIME_ROOT = PANEL_STATE_ROOT;
export const ENDPOINT_PATH = path.join(RUNTIME_ROOT, "endpoint.json");
export const MANIFEST_PATH = path.join(RUNTIME_ROOT, "build-manifest.json");
export const BUILD_STATE_PATH = path.join(RUNTIME_ROOT, "build-state.json");
export const BUILD_LOG_PATH = path.join(RUNTIME_ROOT, "last-build.log");
export const BUILD_LOCK_PATH = path.join(RUNTIME_ROOT, "build.lock");
export const SHELL_STATE_PATH = path.join(RUNTIME_ROOT, "shell-state.json");
export const PORT_BASE = 43000;
export const PORT_SPAN = 1000;

// Python 侧靠 patch 模块常量替换路径；JS 走 deps.paths，键名为常量的 camelCase。
export const DEFAULT_PATHS = Object.freeze({
  panelRoot: PANEL_ROOT,
  controlRoot: MONITOR_ROOT,
  assetRoot: PANEL_ASSET_ROOT,
  projectFile: PROJECT_FILE,
  runtimeRoot: RUNTIME_ROOT,
  endpointPath: ENDPOINT_PATH,
  manifestPath: MANIFEST_PATH,
  buildStatePath: BUILD_STATE_PATH,
  buildLogPath: BUILD_LOG_PATH,
  buildLockPath: BUILD_LOCK_PATH,
  shellStatePath: SHELL_STATE_PATH,
  buildScript: path.join(PANEL_ASSET_ROOT, "ops", "dist", "agent_panel_launcher.bundle.mjs"),
});

// Windows 进程创建标志，值与 Python subprocess 常量相同。
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const CREATE_NO_WINDOW = 0x08000000;
const DETACHED_PROCESS = 0x00000008;
const STILL_ACTIVE_LOCK_STALE_SECONDS = 600;

// ---- 本模块窄口径的小工具（通用 Python 语义在 _py.mjs） ----

// Python str(x or "")：本模块字段合同均为标量，容器一律退化为空串（Python 会给 repr）。
function textOrEmpty(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined || value === false) return "";
  if (value === true) return "True";
  if (typeof value === "number") return value === 0 ? "" : String(value);
  return "";
}

// Python 真值：空 dict 为假。
function filled(value) {
  return isRecord(value) ? Object.keys(value).length > 0 : Boolean(value);
}

function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function errorText(error) {
  if (error === null || error === undefined) return "None";
  return typeof error?.message === "string" ? error.message : String(error);
}

function rstripSlash(value) {
  return String(value).replace(/\/+$/, "");
}

// ---- deps ----

// 默认副作用实现；测试注入假 deps。composite 项默认回落到本模块同名函数，保证 patch 一处即生效。
export function resolveDeps(overrides = {}) {
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
    now: utcNow,
    currentPid: () => process.pid,
    uuidHex: () => ids.uuidHex(),
    ...overrides,
    paths: { ...DEFAULT_PATHS, ...(overrides.paths || {}) },
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

// argv[0] 为可执行文件，与 Python subprocess.Popen 的列表形态一致。
function spawnDetached(argv, { cwd, env } = {}) {
  const child = spawnChild(argv[0], argv.slice(1), {
    cwd,
    env,
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid };
}

function runCapture(argv, { cwd } = {}) {
  const proc = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  return { returncode: proc.error ? 1 : (proc.status ?? 1), stdout: proc.error ? `${stdout}${proc.error.message}` : stdout };
}

// ---- 移植主体 ----

export function utcNow() {
  return isoUtcNow().replace("+00:00", "Z");
}

export function readJson(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, file);
  return null;
}

export function normalizeIdentityPath(value) {
  const text = resolveLikePython(String(value)).replaceAll("\\", "/");
  return process.platform === "win32" ? text.toLowerCase() : text;
}

export function deriveEndpoint(panelRoot = PANEL_ROOT, controlRoot = MONITOR_ROOT) {
  const panelDigest = createHash("sha256").update(normalizeIdentityPath(panelRoot), "utf8").digest();
  const port = PORT_BASE + (panelDigest.readUInt16BE(0) % PORT_SPAN);
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    panel_root: normalizeIdentityPath(panelRoot),
    control_root: normalizeIdentityPath(controlRoot),
  };
}

export function rememberProject({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const root = resolveLikePython(resolved.paths.controlRoot);
  const key = createHash("sha256").update(normalizeIdentityPath(root)).digest("hex");
  resolved.writeJson(path.join(resolved.paths.runtimeRoot, "projects", `${key}.json`), { project_root: root });
}

export function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: "127.0.0.1", port: Number(port), exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

export async function probeHealth(port, { timeout = 0.75 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${Number(port)}/api/health`, {
      signal: AbortSignal.timeout(Math.round(timeout * 1000)),
    });
    if (!response.ok) return {};
    const payload = JSON.parse(await response.text());
    return isRecord(payload) ? payload : {};
  } catch {
    return {};
  }
}

export function isOurPanel(payload, endpoint) {
  return (
    payload?.ok === true && payload.contract_version === "async-task-service/v1" &&
    normalizeIdentityPath(textOrEmpty(payload.panel_root)) === pyGetItem(endpoint, "panel_root") &&
    rstripSlash(textOrEmpty(payload.resolved_loopback_url)) === rstripSlash(pyGetItem(endpoint, "url"))
  );
}

export async function allocateEndpoint({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const endpoint = deriveEndpoint(resolved.paths.panelRoot, resolved.paths.controlRoot);
  const health = await resolved.probeHealth(Number(endpoint.port));
  if (!(await resolved.portIsFree(Number(endpoint.port))) && !resolved.isOurPanel(health, endpoint)) {
    throw pyError("RuntimeError", `Agent Panel 固定端口 ${endpoint.port} 已被其他服务占用；停止占用者后重试`);
  }
  endpoint.updated_at = resolved.now();
  resolved.writeJson(resolved.paths.endpointPath, endpoint);
  return endpoint;
}

export function isProcessAlive(pid) {
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
    process.kill(value, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但当前令牌无权访问，Python 的 OpenProcess/GetExitCodeProcess 同样判活。
    return error?.code === "EPERM";
  }
}

export function runningShell({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const state = resolved.readJson(resolved.paths.shellStatePath);
  return state?.running === true && resolved.isProcessAlive(state.pid) ? state : {};
}

export function buildRunning({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const state = resolved.readJson(resolved.paths.buildStatePath);
  return state?.status === "running" && resolved.isProcessAlive(state.pid);
}

export function runtimeBuildId({ deps } = {}) {
  const resolved = resolveDeps(deps);
  return resolved.readJson(path.join(resolved.paths.assetRoot, "ops", "dist", "subagent_service.manifest.json")).build_id ?? null;
}

export function validManifest({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const manifest = resolved.readJson(resolved.paths.manifestPath);
  const executable = textOrEmpty(manifest?.executable);
  return executable && isFile(executable) && manifest.runtime_build_id === runtimeBuildId({ deps: resolved }) ? manifest : {};
}

function launchOptions(resolved) {
  return {
    cwd: String(resolved.paths.panelRoot),
    env: {
      ...process.env,
      SUBAGENT_PROJECT_ROOT: resolved.paths.controlRoot,
      SUBAGENT_CONTROL_REPO_ROOT: resolved.paths.controlRoot,
      SUBAGENT_RUNTIME_ROOT: resolved.paths.assetRoot,
      AGENT_PANEL_RUNTIME_ROOT: resolved.paths.assetRoot,
      AGENT_PANEL_STATE_ROOT: resolved.paths.runtimeRoot,
    },
  };
}

export function creationFlags({ detached = false } = {}) {
  if (process.platform !== "win32") return 0;
  let flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
  if (detached) flags |= DETACHED_PROCESS;
  return flags;
}

export function startShell(executable, endpoint, { deps } = {}) {
  const resolved = resolveDeps(deps);
  const child = resolved.spawnDetached(
    [
      String(executable),
      "--repository-root", String(resolved.paths.panelRoot),
      "--control-repo", String(resolved.paths.controlRoot),
      "--service-entry", "../../ops/dist/agent_panel_server.bundle.mjs",
      "--port", String(pyGetItem(endpoint, "port")),
      "--loopback-url", String(pyGetItem(endpoint, "url")),
    ],
    launchOptions(resolved),
  );
  const state = {
    running: true,
    pid: child.pid,
    executable: String(executable),
    url: endpoint.url,
    started_at: resolved.now(),
  };
  resolved.writeJson(resolved.paths.shellStatePath, state);
  return { status: "started", ...state };
}

export function startBackgroundBuild({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const child = resolved.spawnDetached(
    [process.execPath, String(resolved.paths.buildScript), "--background-build"],
    launchOptions(resolved),
  );
  resolved.writeJson(resolved.paths.buildStatePath, {
    status: "running",
    pid: child.pid,
    started_at: resolved.now(),
  });
  return child.pid;
}

export async function ensureAgentPanel({ deps } = {}) {
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
    // UI 失败只是诊断信息，不能改变派发成败。
    return { status: "failed", error: errorText(error), log_path: String(resolved.paths.buildLogPath) };
  }
}

export function acquireBuildLock({ deps } = {}) {
  const resolved = resolveDeps(deps);
  mkdirSync(resolved.paths.runtimeRoot, { recursive: true });
  try {
    return openSync(resolved.paths.buildLockPath, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  try {
    const stale = Date.now() / 1000 - statSync(resolved.paths.buildLockPath).mtimeMs / 1000;
    if (stale > STILL_ACTIVE_LOCK_STALE_SECONDS && !resolved.buildRunning()) {
      rmSync(resolved.paths.buildLockPath, { force: true });
      return openSync(resolved.paths.buildLockPath, "wx");
    }
  } catch {
    // Python 同样把这一段的 OSError 吞掉并返回 None。
  }
  return null;
}

function directoryBytes(root) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  walk(root);
  return total;
}

export async function backgroundBuild({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const lock = resolved.acquireBuildLock();
  if (lock === null) return 0;
  writeSync(lock, String(resolved.currentPid()), null, "ascii");
  closeSync(lock);
  const started = performance.now();
  const buildInstance = resolved.uuidHex();
  try {
    const buildRoot = resolveLikePython(path.join(resolved.paths.runtimeRoot, "builds", buildInstance));
    const inside = path.relative(resolveLikePython(resolved.paths.runtimeRoot), buildRoot);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      throw pyError("ValueError", `'${buildRoot}' is not in the subpath of '${resolved.paths.runtimeRoot}'`);
    }
    const appDir = path.join(buildRoot, "app");
    const objDir = path.join(buildRoot, "obj");
    const binDir = path.join(buildRoot, "bin");
    mkdirSync(appDir, { recursive: true });
    const completed = resolved.runCapture(
      [
        "dotnet", "publish", String(resolved.paths.projectFile),
        "--configuration", "Release",
        "--output", appDir,
        "--nologo",
        `-p:BaseIntermediateOutputPath=${objDir}${path.sep}`,
        `-p:BaseOutputPath=${binDir}${path.sep}`,
      ],
      { cwd: String(resolved.paths.panelRoot) },
    );
    writeFileSync(resolved.paths.buildLogPath, String(completed.stdout ?? ""), "utf8");
    const executable = path.join(appDir, "AgentPanel.Shell.exe");
    if (completed.returncode !== 0 || !isFile(executable)) {
      resolved.writeJson(resolved.paths.buildStatePath, {
        status: "failed",
        pid: resolved.currentPid(),
        build_instance: buildInstance,
        exit_code: completed.returncode,
        log_path: String(resolved.paths.buildLogPath),
        finished_at: resolved.now(),
      });
      return 1;
    }
    const outputBytes = directoryBytes(appDir);
    const manifest = {
      build_instance: buildInstance,
      runtime_build_id: runtimeBuildId({ deps: resolved }),
      executable,
      built_at: resolved.now(),
      build_elapsed_ms: Math.round((performance.now() - started) * 1000) / 1000,
      output_bytes: outputBytes,
      log_path: String(resolved.paths.buildLogPath),
    };
    resolved.writeJson(resolved.paths.manifestPath, manifest);
    resolved.writeJson(resolved.paths.buildStatePath, { status: "completed", pid: resolved.currentPid(), ...manifest });
    const endpoint = await resolved.allocateEndpoint();
    const healthy = resolved.isOurPanel(await resolved.probeHealth(Number(pyGetItem(endpoint, "port"))), endpoint);
    if (!healthy && !filled(resolved.runningShell())) resolved.startShell(executable, endpoint);
    return 0;
  } catch (error) {
    // 后台证据必须落盘。
    resolved.writeJson(resolved.paths.buildStatePath, {
      status: "failed",
      pid: resolved.currentPid(),
      build_instance: buildInstance,
      error: errorText(error),
      log_path: String(resolved.paths.buildLogPath),
      finished_at: resolved.now(),
    });
    return 1;
  } finally {
    try {
      rmSync(resolved.paths.buildLockPath, { force: true });
    } catch {
      // Python 的 unlink(missing_ok=True) 同样不因缺文件失败。
    }
  }
}

export function selfTest({ deps } = {}) {
  const resolved = resolveDeps(deps);
  const endpointA = deriveEndpoint("e:/fake/panel-a", "e:/fake/project-a");
  const endpointB = deriveEndpoint("e:/fake/panel-b", "e:/fake/project-b");
  const checks = {
    current_process_is_alive: resolved.isProcessAlive(resolved.currentPid()),
    invalid_process_is_not_alive: !resolved.isProcessAlive(-1),
    runtime_is_global: path.resolve(RUNTIME_ROOT) !== path.join(MONITOR_ROOT, ".runtime", "agent-panel"),
    endpoint_derivation_is_deterministic:
      JSON.stringify(endpointA) === JSON.stringify(deriveEndpoint("e:/fake/panel-a", "e:/fake/project-a")),
    endpoint_port_in_range: PORT_BASE <= Number(endpointA.port) && Number(endpointA.port) < PORT_BASE + PORT_SPAN,
    different_panel_roots_get_different_ports: endpointA.port !== endpointB.port,
  };
  return { status: Object.values(checks).every(Boolean) ? "pass" : "fail", checks };
}
