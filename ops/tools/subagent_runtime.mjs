import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { hostname, uptime } from "node:os";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { terminateChildProcessTree } from "./pi_child_bash_process_tree.mjs";

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function requiredPath(value, label, base) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new TypeError(`async Core resolver requires ${label}`);
  }
  return path.resolve(base, String(value));
}

function isBundledEntry(entryPath) {
  return path.basename(entryPath).includes(".bundle.");
}

const RUNNER_STEM_BY_KIND = {
  pi: "run-pi-task",
};

function runnerFileForEntry(entryPath, kind) {
  const bundled = isBundledEntry(entryPath);
  return `${RUNNER_STEM_BY_KIND[kind]}.${bundled ? "bundle." : ""}mjs`;
}

function defaultHost(env, overrides = {}) {
  const host = {
    pid: process.pid,
    hostname: hostname(),
    nodeExecutable: process.execPath,
    caseInsensitivePaths: process.platform === "win32",
    spawn,
    spawnSync,
    isProcessAlive(pid) {
      try {
        process.kill(Number(pid), 0);
        return true;
      } catch {
        return false;
      }
    },
    terminateProcessTree(pid) {
      if (process.platform === "win32") {
        const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          encoding: "utf8",
          windowsHide: true,
          env,
        });
        return result.status === 0;
      }
      try {
        process.kill(-Number(pid), "SIGTERM");
        return true;
      } catch {
        try {
          process.kill(Number(pid), "SIGTERM");
          return true;
        } catch {
          return false;
        }
      }
    },
    terminateProcessTreeConfirmed(pid) {
      return terminateChildProcessTree(pid);
    },
    setExitCode(value) {
      process.exitCode = value;
    },
    // 本次主机启动时刻；早于它创建的任务进程树不可能存活。Windows 快速启动的休眠式关机不重置
    // uptime，此时判定为未重启，恢复仍 fail-closed。
    bootTimeMs() {
      return Date.now() - Math.round(uptime() * 1000);
    },
    nowMs() {
      return Date.now();
    },
    nowIso() {
      return new Date().toISOString();
    },
    randomHex(bytes = 8) {
      return randomBytes(bytes).toString("hex");
    },
    sleepSync(ms) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
    setTimer: globalThis.setTimeout,
    clearTimer: globalThis.clearTimeout,
  };
  return { ...host, ...cloneValue(overrides) };
}

const DEFAULT_PROMPT_IDENTITY = Object.freeze({
  failureSummaryPrefix: "Background subagent task failed.",
});

const CHECKER_RELATIVE_PATH = "ops/dist/subagent_handoff_check.bundle.mjs";

function normalizeRunnerCatalog(catalog, cwd) {
  return Object.fromEntries(Object.entries(catalog).map(([key, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`runner catalog entry ${key} must be an object`);
    }
    const entry = cloneValue(value);
    entry.path = requiredPath(entry.path, `runnerCatalog.${key}.path`, cwd);
    entry.basename = String(entry.basename || path.basename(entry.path));
    entry.aliases = Array.isArray(entry.aliases) ? entry.aliases.map(String) : [];
    entry.defaultModel = String(entry.defaultModel || "");
    entry.defaultEffort = String(entry.defaultEffort || "");
    return [String(key), entry];
  }));
}

function defaultCheckerPolicy({ entryDir, cwd, explicitPolicy, explicitCommand, explicitCheckerPath }) {
  const supplied = explicitPolicy && typeof explicitPolicy === "object" ? cloneValue(explicitPolicy) : {};
  const command = String(supplied.command || explicitCommand || process.execPath);
  const configuredPath = path.resolve(
    cwd,
    String(
      supplied.configuredPath
        || supplied.checkerPath
        || explicitCheckerPath
        // ops/tools 与 ops/dist 同深度：源码入口与打包入口都先回到仓根，再取 dist 里的 checker bundle。
        || path.resolve(entryDir, "..", "..", CHECKER_RELATIVE_PATH),
    ),
  );
  const candidates = Array.isArray(supplied.candidates)
    ? supplied.candidates
    : [
        // 优先使用与服务一起发布的 checker，避免工作仓迁移影响已启动任务的尾验。
        { absolutePath: path.join(entryDir, "subagent_handoff_check.bundle.mjs") },
        { base: "producer_root", relativePath: CHECKER_RELATIVE_PATH },
        { base: "target_cwd", relativePath: CHECKER_RELATIVE_PATH },
        { absolutePath: configuredPath },
        { base: "cwd", relativePath: CHECKER_RELATIVE_PATH },
      ];
  return {
    ...supplied,
    command,
    commandArgsPrefix: Array.isArray(supplied.commandArgsPrefix)
      ? [...supplied.commandArgsPrefix]
      : [],
    rootEnvironmentKey: String(supplied.rootEnvironmentKey || "SUBAGENT_CONTROL_REPO_ROOT"),
    candidates: candidates.map((candidate) => cloneValue(candidate)),
  };
}

export function resolveSubagentCoreOptions({
  entryPath,
  cwd,
  home,
  env,
  registryRoot,
  defaultTaskRoot,
  defaultRunnerPath,
  workerSpawnCwd,
  trustedRunnerRoot,
  defaultContextMode,
  allowCustomRunner,
  taskIdPrefix = "subagent",
  defaultRunnerKey = "pi",
  defaultModel,
  defaultEffort,
  promptIdentity,
  handoffCheckerPolicy,
  handoffCheckerCommand,
  checkerPath,
  runnerCatalog,
  trustedRunnerBasenames,
  childEnv,
  host,
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("async Core resolver requires an explicit env snapshot");
  }
  if (cwd === undefined || cwd === null || String(cwd).trim() === "") {
    // 库层不回落常驻宿主 process.cwd；缺项目根一律具名失败。
    const error = new TypeError("async Core resolver requires an explicit project root");
    error.name = "missing_project_root";
    error.code = "missing_project_root";
    throw error;
  }
  const environment = { ...env };
  const resolvedCwd = requiredPath(cwd, "cwd");
  const resolvedHome = requiredPath(home, "home");
  const resolvedEntry = requiredPath(entryPath, "entryPath", resolvedCwd);
  const entryDir = path.dirname(resolvedEntry);
  const resolvedRegistryRoot = path.resolve(
    registryRoot
      || environment.SUBAGENT_REGISTRY_ROOT
      || path.join(resolvedHome, ".subagent-control", "async_task_registry"),
  );
  const resolvedTaskRoot = path.resolve(
    defaultTaskRoot
      || environment.SUBAGENT_TASK_ROOT
      || path.join(resolvedCwd, ".runtime", "cockpit", "async_tasks"),
  );
  const bundled = isBundledEntry(resolvedEntry);
  const piSibling = path.join(entryDir, runnerFileForEntry(resolvedEntry, "pi"));
  const resolvedDefaultRunner = path.resolve(
    resolvedCwd,
    defaultRunnerPath
      || environment.SUBAGENT_CHILD_RUNNER
      || piSibling,
  );
  const defaultCatalog = {
    pi: {
      executor: "pi",
      basename: "run-pi-task.mjs",
      aliases: ["run-pi-task.bundle.mjs"],
      path: piSibling,
      defaultModel: environment.PI_ASYNC_MODEL || "openai-codex/gpt-6-sol",
      defaultEffort: environment.PI_ASYNC_EFFORT || "max",
    },
  };
  const catalog = normalizeRunnerCatalog(runnerCatalog || defaultCatalog, resolvedCwd);
  const catalogEntries = Object.entries(catalog);
  const exactDefault = catalogEntries.find(([, entry]) => path.resolve(entry.path) === resolvedDefaultRunner);
  const defaultBasename = path.basename(resolvedDefaultRunner).toLowerCase();
  const basenameDefault = catalogEntries.find(([, entry]) => (
    [entry.basename, ...(entry.aliases || [])]
      .map((value) => String(value || "").toLowerCase())
      .includes(defaultBasename)
  ));
  const piDefault = catalog.pi
    ? ["pi", catalog.pi]
    : catalogEntries[0];
  const [inferredDefaultKey, defaultEntry] = exactDefault || basenameDefault || piDefault || [];
  if (!defaultEntry) throw new TypeError("async Core resolver requires a non-empty runner catalog");
  const piEntry = catalog.pi || defaultEntry;
  const resolvedDefaultModel = piEntry.defaultModel || "openai-codex/gpt-6-sol";
  const resolvedDefaultEffort = piEntry.defaultEffort || "max";
  const resolvedChildEnv = { ...environment, ...(childEnv && typeof childEnv === "object" ? cloneValue(childEnv) : {}) };
  // 子进程（runner/worker/工具）显式带双根：项目面与服务侧一致，运行面指向发布包自身。
  if (!String(resolvedChildEnv.SUBAGENT_PROJECT_ROOT || "").trim()) {
    resolvedChildEnv.SUBAGENT_PROJECT_ROOT = resolvedCwd;
  }
  if (!String(resolvedChildEnv.SUBAGENT_RUNTIME_ROOT || "").trim()) {
    resolvedChildEnv.SUBAGENT_RUNTIME_ROOT = path.resolve(entryDir, "..", "..");
  }
  const checkerPolicy = defaultCheckerPolicy({
    entryDir,
    cwd: resolvedCwd,
    explicitPolicy: handoffCheckerPolicy,
    explicitCommand: handoffCheckerCommand?.command,
    explicitCheckerPath: checkerPath || handoffCheckerCommand?.checkerPath,
  });
  const checkerRootEnvironmentKey = String(checkerPolicy.rootEnvironmentKey || "").trim();
  if (checkerRootEnvironmentKey) delete resolvedChildEnv[checkerRootEnvironmentKey];
  const resolvedHost = defaultHost(resolvedChildEnv, host || {});
  const trustedNames = trustedRunnerBasenames || [
    "run-pi-task.mjs",
    "run-pi-task.bundle.mjs",
  ];
  const options = {
    cwd: resolvedCwd,
    registryRoot: resolvedRegistryRoot,
    defaultTaskRoot: resolvedTaskRoot,
    workerEntrypoint: resolvedEntry,
    workerSpawnCwd: path.resolve(workerSpawnCwd || resolvedCwd),
    trustedRunnerRoot: path.resolve(trustedRunnerRoot || entryDir),
    defaultRunnerPath: resolvedDefaultRunner,
    runnerCatalog: catalog,
    defaultRunnerKey: inferredDefaultKey || "default",
    defaultRunnerEntry: cloneValue(defaultEntry),
    trustedRunnerBasenames: [...trustedNames].map(String),
    taskIdPrefix: String(taskIdPrefix),
    defaultTaskRootLayout: {
      runtimeBasename: ".runtime",
      cockpitBasename: "cockpit",
      taskRootBasename: "async_tasks",
    },
    writeClaimRootSegments: [".runtime", "cockpit", "write-claims"],
    selfTestEnvironment: {
      registryRoot: "SUBAGENT_REGISTRY_ROOT",
      allowCustomRunner: "SUBAGENT_ALLOW_CUSTOM_RUNNER",
    },
    runnerTrustFailureMessage: "runner outside the server deployment is rejected; set SUBAGENT_ALLOW_CUSTOM_RUNNER=1 only for isolated test/dev services",
    defaultModel: String(defaultModel || resolvedDefaultModel),
    defaultEffort: String(defaultEffort || resolvedDefaultEffort),
    defaultContextMode: String(defaultContextMode || "isolated"),
    allowCustomRunner: allowCustomRunner
      ?? environment.SUBAGENT_ALLOW_CUSTOM_RUNNER === "1",
    promptIdentity: cloneValue(promptIdentity || DEFAULT_PROMPT_IDENTITY),
    handoffCheckerPolicy: checkerPolicy,
    childEnv: resolvedChildEnv,
    host: resolvedHost,
  };
  return deepFreeze(options);
}

function asResolvedOptions(options) {
  return options?.host && options?.runnerCatalog && options?.trustedRunnerRoot
    ? options
    : resolveSubagentCoreOptions(options);
}

export function resolveTrustedRunnerPath(options, candidate = "") {
  const resolved = asResolvedOptions(options);
  const text = String(candidate || "").trim();
  if (!text) return resolved.defaultRunnerPath;
  if (!/[\\/]/.test(text)) {
    const wanted = text.toLowerCase();
    const entry = Object.values(resolved.runnerCatalog).find((item) => [item.basename, ...(item.aliases || [])]
      .map((value) => String(value || "").toLowerCase())
      .includes(wanted));
    if (entry?.path) return path.resolve(resolved.cwd, entry.path);
  }
  return path.resolve(resolved.cwd, text);
}

export function isTrustedRunnerPath(options, runnerPath) {
  const resolved = asResolvedOptions(options);
  let canonical;
  let trustedRootCanonical;
  try {
    canonical = realpathSync.native(path.resolve(resolved.cwd, String(runnerPath)));
    trustedRootCanonical = realpathSync.native(path.resolve(resolved.trustedRunnerRoot));
  } catch {
    return false;
  }
  const names = new Set((resolved.trustedRunnerBasenames || []).map((value) => String(value).toLowerCase()));
  return path.dirname(canonical) === trustedRootCanonical
    && names.has(path.basename(canonical).toLowerCase());
}
