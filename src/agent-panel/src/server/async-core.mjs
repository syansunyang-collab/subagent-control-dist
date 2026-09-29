import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXPECTED_CONTRACT_VERSION = "async-task-service/v1";
export const LOOPBACK_HOST = "127.0.0.1";
// 生产 bundle 落在 <runtimeRoot>/ops/dist/，模块根必须回到 <runtimeRoot>/src/agent-panel；
// source 运行仍按源码路径上跳两级（<仓根>/src/agent-panel）。默认控制仓为模块上两级。
const MODULE_FILE = fileURLToPath(import.meta.url);
export const BUNDLED_MODULE = MODULE_FILE.endsWith(".bundle.mjs");
export const PANEL_ROOT = BUNDLED_MODULE
  ? path.resolve(path.dirname(MODULE_FILE), "..", "..", "src", "agent-panel")
  : path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const MODULE_ROOT = PANEL_ROOT;
export const DEFAULT_CONTROL_REPO_PATH = path.resolve(MODULE_ROOT, "..", "..");

// 生产 bundle 的线程入口与主入口同目录；source 环境仍用源码文件名。
export const AGGREGATION_WORKER_ENTRY = BUNDLED_MODULE
  ? "./agent_panel_aggregation_worker.bundle.mjs"
  : "./aggregation-worker.mjs";
export const CONFIG_WORKER_ENTRY = BUNDLED_MODULE
  ? "./agent_panel_config_worker.bundle.mjs"
  : "./config-worker.mjs";

// 面板资产根：发布槽为 <runtimeRoot>/src/agent-panel，source 为模块目录。壳与 Node CLI
// 用它作为稳定实例身份（panel_root），不再用可变的监控仓路径。
export function resolvePanelRoot(explicit = "") {
  return path.resolve(String(explicit || process.env.AGENT_PANEL_PANEL_ROOT || PANEL_ROOT));
}

// 用户级面板状态目录（日志、WebView2 缓存）：不落在生产者仓，也不落在消费项目目录。
export function resolvePanelStateRoot(explicit = "") {
  return path.resolve(String(
    explicit
      || process.env.AGENT_PANEL_STATE_ROOT
      || path.join(os.homedir(), ".subagent-control", "agent-panel"),
  ));
}

// 全局运行资产根（发布槽）：async-core 实现与发布物料从这里读取，监控仓只提供项目 cockpit 数据。
export function resolveRuntimeAssetRoot(explicit = "") {
  return path.resolve(String(
    explicit
      || process.env.SUBAGENT_RUNTIME_ROOT
      || path.join(os.homedir(), ".pi", "agent", "extensions", "subagent-control"),
  ));
}

export function resolveAsyncCorePath({ asyncCorePath = "", runtimeAssetRoot = "" } = {}) {
  if (asyncCorePath) return path.resolve(String(asyncCorePath));
  const runtimeRoot = resolveRuntimeAssetRoot(runtimeAssetRoot);
  const published = path.join(runtimeRoot, "ops", "tools", "async-core", "index.mjs");
  if (existsSync(published)) return published;
  // MCP 槽的 bundle 同时导出 core API 并承载 worker CLI，不依赖 Pi 扩展目录。
  const released = path.join(runtimeRoot, "ops", "tools", "subagent_service.mjs");
  if (existsSync(released)) return released;
  // source 开发回退到模块自身所属仓的 ops/tools；生产 bundle 时该值等于发布槽，绝不指向监控仓。
  const local = path.join(path.resolve(MODULE_ROOT, "..", ".."), "ops", "tools", "async-core", "index.mjs");
  return existsSync(local) ? local : published;
}

export class PanelError extends Error {
  constructor(code, message, { status = 503, scope = "global", details = null } = {}) {
    super(message);
    this.name = "PanelError";
    this.code = code;
    this.status = status;
    this.scope = scope;
    this.details = details;
  }
}

function asDirectory(candidate, code, label) {
  const resolved = path.resolve(String(candidate));
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new PanelError(code, `${label}不可用：${resolved}`, { details: { path: resolved } });
  }
  if (!stats.isDirectory()) {
    throw new PanelError(code, `${label}不是目录：${resolved}`, { details: { path: resolved } });
  }
  return resolved;
}

export function resolveControlRepoPath(value = "") {
  const raw = String(
    value
      || process.env.AGENT_PANEL_CONTROL_REPO_PATH
      || process.env.CONTROL_REPO_PATH
      || DEFAULT_CONTROL_REPO_PATH,
  ).trim();
  if (!raw) {
    throw new PanelError("CONTROL_ROOT_INVALID", "控制仓路径为空");
  }
  return path.resolve(raw);
}

export function derivePort(repositoryPath) {
  const normalized = path.resolve(String(repositoryPath)).replaceAll("\\", "/").toLowerCase();
  const digest = createHash("sha256").update(normalized, "utf8").digest();
  return 43000 + (digest.readUInt16BE(0) % 1000);
}

export function resolvePanelPaths(controlRepoPath) {
  const controlRoot = resolveControlRepoPath(controlRepoPath);
  const runtimeRoot = path.join(controlRoot, ".runtime", "cockpit");
  return {
    controlRoot,
    runtimeRoot,
    taskRoot: path.join(runtimeRoot, "async_tasks"),
    inboxRoot: path.join(runtimeRoot, "async_inbox"),
    fleetRoot: path.join(runtimeRoot, "fleet_runs"),
    // 任务注册表跟随项目 cockpit，与 Pi 的消费路径一致（此前切仓写成 <project>/.registry）。
    registryRoot: path.join(runtimeRoot, "async-registry"),
  };
}

export function validateControlRepo(controlRepoPath) {
  const paths = resolvePanelPaths(controlRepoPath);
  asDirectory(paths.controlRoot, "CONTROL_ROOT_INVALID", "控制仓路径");
  asDirectory(paths.runtimeRoot, "CONTROL_RUNTIME_INVALID", "控制仓运行态目录");
  return paths;
}

export function assertContractVersion(coreModule, expected = EXPECTED_CONTRACT_VERSION) {
  const actual = coreModule?.CONTRACT_VERSION;
  if (actual !== expected) {
    throw new PanelError(
      "CONTRACT_VERSION_MISMATCH",
      `async-core CONTRACT_VERSION 不匹配：期望 ${expected}，实际 ${String(actual ?? "<missing>")}`,
      { details: { expected, actual: actual ?? null } },
    );
  }
  if (typeof coreModule.createAsyncTaskCore !== "function") {
    throw new PanelError("ASYNC_CORE_API_INVALID", "async-core 缺少公共入口 createAsyncTaskCore");
  }
  return coreModule;
}

export async function loadAsyncCore({ asyncCoreModule = null, asyncCorePath, expectedContractVersion } = {}) {
  const loaded = asyncCoreModule || await import(pathToFileURL(path.resolve(asyncCorePath)).href);
  return assertContractVersion(loaded, expectedContractVersion || EXPECTED_CONTRACT_VERSION);
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function terminateProcessTree(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(numericPid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return result.status === 0;
  }
  try {
    process.kill(-numericPid, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(numericPid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes = 4) {
  return randomBytes(bytes).toString("hex");
}

// 注册表默认落在被监控项目的 cockpit（任务数据留各自项目）；显式注入与部署级环境变量优先。
export function resolveRegistryRoot({ paths = null, registryRoot = "" } = {}) {
  const explicit = String(
    registryRoot
      || process.env.AGENT_PANEL_ASYNC_REGISTRY_ROOT
      || process.env.ASYNC_TASK_REGISTRY_ROOT
      || "",
  ).trim();
  if (explicit) return path.resolve(explicit);
  if (paths?.registryRoot) return path.resolve(paths.registryRoot);
  return path.join(os.homedir(), ".subagent-control", "async_task_registry");
}

export function buildAsyncCoreOptions({ paths, asyncCorePath, registryRoot, overrides = {} }) {
  const runnerPath = process.execPath;
  const workerEntrypoint = path.resolve(asyncCorePath);
  const defaults = {
    cwd: paths.controlRoot,
    registryRoot: resolveRegistryRoot({ paths, registryRoot }),
    defaultTaskRoot: paths.taskRoot,
    workerEntrypoint,
    workerSpawnCwd: paths.controlRoot,
    trustedRunnerRoot: paths.controlRoot,
    defaultRunnerPath: runnerPath,
    runnerCatalog: { node: { path: runnerPath } },
    defaultRunnerKey: "node",
    defaultRunnerEntry: { path: runnerPath },
    trustedRunnerBasenames: [path.basename(runnerPath)],
    taskIdPrefix: "agent-panel",
    defaultModel: "unknown",
    defaultEffort: "unknown",
    defaultTaskRootLayout: { kind: "directory" },
    writeClaimRootSegments: [".runtime", "cockpit", "write-claims"],
    selfTestEnvironment: "agent-panel",
    runnerTrustFailureMessage: "agent-panel async-core runner trust check failed",
    defaultContextMode: "isolated",
    allowCustomRunner: false,
    promptIdentity: { source: "agent-panel" },
    handoffCheckerPolicy: { command: runnerPath, args: [] },
    childEnv: {
      PATH: process.env.PATH || "",
      SystemRoot: process.env.SystemRoot || "",
      TEMP: process.env.TEMP || "",
      TMP: process.env.TMP || "",
    },
    host: {
      pid: process.pid,
      hostname: os.hostname(),
      nodeExecutable: runnerPath,
      caseInsensitivePaths: process.platform === "win32",
      spawn,
      spawnSync,
      isProcessAlive,
      terminateProcessTree,
      setExitCode: (code) => { process.exitCode = code; },
      nowMs: () => Date.now(),
      nowIso,
      randomHex,
      sleepSync: (milliseconds) => {
        const duration = Math.max(0, Number(milliseconds) || 0);
        if (duration) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
      },
      setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimer: (timer) => clearTimeout(timer),
    },
  };
  return { ...defaults, ...overrides, host: { ...defaults.host, ...(overrides.host || {}) } };
}

export async function createAsyncTaskService({ paths, asyncCorePath, asyncCoreModule, registryRoot, overrides = {} }) {
  const core = await loadAsyncCore({ asyncCoreModule, asyncCorePath });
  const options = buildAsyncCoreOptions({ paths, asyncCorePath, registryRoot, overrides });
  const service = core.createAsyncTaskCore(options);
  for (const method of ["get", "snapshot", "cancel"]) {
    if (typeof service?.[method] !== "function") {
      throw new PanelError("ASYNC_CORE_API_INVALID", `async-core 服务缺少公共入口 ${method}`);
    }
  }
  return { core, service, options };
}

export function controlPathExists(candidate) {
  return existsSync(candidate);
}
