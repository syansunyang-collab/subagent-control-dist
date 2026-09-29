// src/agent-panel/src/server/aggregation-worker.mjs
import { parentPort, workerData } from "node:worker_threads";

// src/agent-panel/src/server/async-core.mjs
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var EXPECTED_CONTRACT_VERSION = "async-task-service/v1";
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
function assertContractVersion(coreModule, expected = EXPECTED_CONTRACT_VERSION) {
  const actual = coreModule?.CONTRACT_VERSION;
  if (actual !== expected) {
    throw new PanelError(
      "CONTRACT_VERSION_MISMATCH",
      `async-core CONTRACT_VERSION \u4E0D\u5339\u914D\uFF1A\u671F\u671B ${expected}\uFF0C\u5B9E\u9645 ${String(actual ?? "<missing>")}`,
      { details: { expected, actual: actual ?? null } }
    );
  }
  if (typeof coreModule.createAsyncTaskCore !== "function") {
    throw new PanelError("ASYNC_CORE_API_INVALID", "async-core \u7F3A\u5C11\u516C\u5171\u5165\u53E3 createAsyncTaskCore");
  }
  return coreModule;
}
async function loadAsyncCore({ asyncCoreModule = null, asyncCorePath, expectedContractVersion } = {}) {
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
      windowsHide: true
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
  return (/* @__PURE__ */ new Date()).toISOString();
}
function randomHex(bytes = 4) {
  return randomBytes(bytes).toString("hex");
}
function resolveRegistryRoot({ paths = null, registryRoot = "" } = {}) {
  const explicit = String(
    registryRoot || process.env.AGENT_PANEL_ASYNC_REGISTRY_ROOT || process.env.ASYNC_TASK_REGISTRY_ROOT || ""
  ).trim();
  if (explicit) return path.resolve(explicit);
  if (paths?.registryRoot) return path.resolve(paths.registryRoot);
  return path.join(os.homedir(), ".subagent-control", "async_task_registry");
}
function buildAsyncCoreOptions({ paths, asyncCorePath, registryRoot, overrides = {} }) {
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
      TMP: process.env.TMP || ""
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
      setExitCode: (code) => {
        process.exitCode = code;
      },
      nowMs: () => Date.now(),
      nowIso,
      randomHex,
      sleepSync: (milliseconds) => {
        const duration = Math.max(0, Number(milliseconds) || 0);
        if (duration) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
      },
      setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimer: (timer) => clearTimeout(timer)
    }
  };
  return { ...defaults, ...overrides, host: { ...defaults.host, ...overrides.host || {} } };
}
async function createAsyncTaskService({ paths, asyncCorePath, asyncCoreModule, registryRoot, overrides = {} }) {
  const core = await loadAsyncCore({ asyncCoreModule, asyncCorePath });
  const options = buildAsyncCoreOptions({ paths, asyncCorePath, registryRoot, overrides });
  const service = core.createAsyncTaskCore(options);
  for (const method of ["get", "snapshot", "cancel"]) {
    if (typeof service?.[method] !== "function") {
      throw new PanelError("ASYNC_CORE_API_INVALID", `async-core \u670D\u52A1\u7F3A\u5C11\u516C\u5171\u5165\u53E3 ${method}`);
    }
  }
  return { core, service, options };
}

// src/agent-panel/src/server/projection.mjs
import {
  existsSync as existsSync2,
  mkdirSync,
  readdirSync,
  readFileSync as readFileSync3,
  statSync
} from "node:fs";
import path4 from "node:path";

// ops/tools/fleet-tools-core.mjs
import { spawn as spawn2 } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path2 from "node:path";
import process2 from "node:process";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var FLEET_TOOL_NAMES = Object.freeze(["fleet_start", "fleet_status", "fleet_wait", "fleet_review", "fleet_cancel"]);
var FLEET_DECISIONS = Object.freeze(["accept", "block", "requeue"]);
var FLEET_WAIT_MS_MIN = 1e3;
var FLEET_WAIT_MS_MAX = 6e5;
var FLEET_WAIT_MS_DEFAULT = 6e4;
var FLEET_COMMAND_TIMEOUT_MS = 12e4;
var FLEET_SCHEDULER_NAME = "fleet_scheduler";
var FLEET_MANIFEST_CHECK_NAME = "fleet_manifest_check";
var SUBAGENT_PROJECT_ROOT_ENV = "SUBAGENT_PROJECT_ROOT";
var SUBAGENT_RUNTIME_ROOT_ENV = "SUBAGENT_RUNTIME_ROOT";
var SUBAGENT_REGISTRY_ROOT_ENV = "SUBAGENT_REGISTRY_ROOT";
var DECISION_FLAG = Object.freeze({ accept: "--accept", block: "--block", requeue: "--requeue" });
var SETTLED_DRIVER_STATES = /* @__PURE__ */ new Set(["completed", "blocked", "needs_parent_review", "failed", "cancelled"]);
var DRIVER_POLL_MS = 500;
var NO_ACTIVE_REPROBE_MS = 5e3;
var SCHEDULER_RELATIVE_PATH = path2.join("ops", "tools", "fleet_scheduler.mjs");
var MODULE_REPO_ROOT = path2.resolve(path2.dirname(fileURLToPath2(import.meta.url)), "..", "..");
function failure(kind, message, detail = {}) {
  return { ok: false, error: { kind, message, ...detail } };
}
function resolveFleetRepoRoot({ cwd = process2.cwd(), env = process2.env } = {}) {
  for (const candidate of [env.SUBAGENT_CONTROL_REPO_ROOT, cwd, MODULE_REPO_ROOT]) {
    if (!candidate) continue;
    const root = path2.resolve(String(candidate));
    if (existsSync(path2.join(root, SCHEDULER_RELATIVE_PATH))) return root;
  }
  return path2.resolve(cwd);
}
function requireScheduler(scheduler) {
  if (!scheduler || !existsSync(scheduler)) {
    return failure(
      "scheduler_not_found",
      `fleet_scheduler was not found: ${scheduler ?? "(unresolved)"}; install the shared runtime package or set SUBAGENT_CONTROL_REPO_ROOT to the control repo root`,
      { expected_path: scheduler ?? null }
    );
  }
  return { ok: true, scheduler };
}
function resolveRuntimeScript({ runtimeRoot, name, defaults }) {
  for (const relative of defaults) {
    const candidate = path2.join(runtimeRoot, ...relative.split("/"));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
function resolvePackageManifestEntry(manifest, name) {
  const entrypoints = manifest?.entrypoints;
  if (entrypoints && entrypoints[name]) return String(entrypoints[name]).replace(/\\/g, "/");
  return null;
}
function resolveFleetScripts({ runtimeRoot, manifest }) {
  const resolveOne = (name, defaults) => {
    if (manifest) {
      const declared = resolvePackageManifestEntry(manifest, name);
      if (declared) return path2.join(runtimeRoot, ...declared.split("/"));
      const files = Array.isArray(manifest.files) ? manifest.files : [];
      for (const relative of defaults) {
        if (!files.includes(relative)) continue;
        const candidate = path2.join(runtimeRoot, ...relative.split("/"));
        if (existsSync(candidate)) return candidate;
      }
      return null;
    }
    return resolveRuntimeScript({ runtimeRoot, name, defaults });
  };
  return {
    scheduler: resolveOne(FLEET_SCHEDULER_NAME, [
      "ops/dist/fleet_scheduler.bundle.mjs",
      "ops/tools/fleet_scheduler.mjs"
    ]),
    manifestChecker: resolveOne(FLEET_MANIFEST_CHECK_NAME, [
      "ops/dist/fleet_manifest_check.bundle.mjs",
      "ops/tools/fleet_manifest_check.mjs"
    ])
  };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function clampWaitMs(value) {
  const requested = Number.isFinite(Number(value)) ? Number(value) : FLEET_WAIT_MS_DEFAULT;
  return Math.min(Math.max(Math.trunc(requested), FLEET_WAIT_MS_MIN), FLEET_WAIT_MS_MAX);
}
function spawnJson(interpreter, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn2(interpreter, args, {
      cwd,
      env,
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: "SIGKILL"
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve(failure(
      "spawn_failed",
      `could not run ${interpreter}: ${error?.message ?? String(error)}`,
      { command: [interpreter, ...args] }
    )));
    child.on("close", (code, signal) => {
      const command = [interpreter, ...args];
      if (signal) {
        resolve(failure("timeout", `${args[1] || args[0]} exceeded ${timeoutMs} ms and was killed`, {
          command,
          signal,
          stderr: stderr.trim()
        }));
        return;
      }
      if (code !== 0 && !stdout.trim()) {
        resolve(failure("scheduler_failed", stderr.trim().split("\n").pop() || `exit code ${code}`, {
          command,
          exit_code: code,
          stderr: stderr.trim().slice(0, 2e3)
        }));
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(stdout);
      } catch {
        resolve(failure("invalid_json", "scheduler did not return JSON on stdout", {
          command,
          exit_code: code,
          stdout: stdout.trim().slice(0, 2e3),
          stderr: stderr.trim().slice(0, 2e3)
        }));
        return;
      }
      if (code !== 0 || payload?.status === "failed" || payload?.status === "error") {
        const errorText = payload?.error ?? (Array.isArray(payload?.errors) && payload.errors.length > 0 ? payload.errors.join("; ").slice(0, 2e3) : null);
        resolve(failure("scheduler_failed", String(errorText ?? `exit code ${code}`), {
          command,
          exit_code: code,
          payload: payload ? {
            status: payload.status ?? null,
            error: payload.error ?? null,
            errors: Array.isArray(payload.errors) ? payload.errors.slice(0, 20) : null,
            warnings: Array.isArray(payload.warnings) ? payload.warnings.slice(0, 20) : null
          } : null,
          stderr: stderr.trim().slice(0, 2e3)
        }));
        return;
      }
      resolve({ ok: true, payload });
    });
  });
}
function readDriverRecord(runDir) {
  try {
    return JSON.parse(readFileSync(path2.join(runDir, "driver.json"), "utf8"));
  } catch {
    return null;
  }
}
function readDriverStatus(projectRoot, statePath) {
  const stateDir = path2.isAbsolute(String(statePath ?? "")) ? path2.dirname(String(statePath)) : path2.join(projectRoot, path2.dirname(String(statePath ?? "")));
  return readDriverRecord(stateDir);
}
function compactSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const node = (value) => ({ node_id: value.id ?? value.node_id ?? null, task_id: value.task_id ?? null, state: value.state ?? null });
  return {
    run_state: summary.run_state ?? null,
    revision: summary.revision ?? null,
    total: summary.total ?? null,
    active: (summary.active ?? []).map(node),
    completed: (summary.recent_completed ?? []).map(node),
    needs_review: (summary.needs_review ?? []).map(node),
    failed_or_blocked: (summary.failed_or_blocked ?? []).map(node),
    next_ready: (summary.next_ready ?? []).map(node),
    ...summary.cancellation ? { cancellation: { reason: summary.cancellation.reason ?? null, errors: summary.cancellation.errors ?? [] } } : {}
  };
}
function compactStatus(payload) {
  return {
    run_id: payload.run_id,
    counts: payload.counts ?? null,
    summary: compactSummary(payload.summary),
    state_path: payload.state_path ?? null
  };
}
function driverFields(driver) {
  return {
    driver_status: typeof driver?.status === "string" ? driver.status : null,
    driver_error: driver?.error ?? null
  };
}
function projectFleetDriver({ stateRoot, runId } = {}) {
  if (!stateRoot || !runId) return driverFields(null);
  return driverFields(readDriverRecord(path2.join(path2.resolve(String(stateRoot)), String(runId))));
}
function createFleetCore({
  repoRoot = null,
  runtimeRoot = null,
  projectRoot = null,
  mode = null,
  manifest = null,
  cwd = process2.cwd(),
  env = process2.env,
  timeoutMs = FLEET_COMMAND_TIMEOUT_MS
} = {}) {
  const root = runtimeRoot ? path2.resolve(runtimeRoot) : repoRoot ? path2.resolve(repoRoot) : resolveFleetRepoRoot({ cwd: projectRoot ?? cwd, env });
  const spawnCwd = path2.resolve(projectRoot ?? cwd);
  const scripts = manifest ? resolveFleetScripts({ runtimeRoot: root, manifest }) : { scheduler: null, manifestChecker: null };
  const scheduler = scripts.scheduler ?? (manifest ? null : resolveRuntimeScript({
    runtimeRoot: root,
    name: FLEET_SCHEDULER_NAME,
    defaults: ["ops/dist/fleet_scheduler.bundle.mjs", "ops/tools/fleet_scheduler.mjs"]
  }));
  const manifestChecker = scripts.manifestChecker ?? (manifest ? null : resolveRuntimeScript({
    runtimeRoot: root,
    name: FLEET_MANIFEST_CHECK_NAME,
    defaults: ["ops/dist/fleet_manifest_check.bundle.mjs", "ops/tools/fleet_manifest_check.mjs"]
  }));
  const spawnEnv = {
    ...env,
    [SUBAGENT_PROJECT_ROOT_ENV]: spawnCwd,
    [SUBAGENT_RUNTIME_ROOT_ENV]: root,
    // The scheduler's dispatch_prepare subprocess must share Pi's project registry.
    [SUBAGENT_REGISTRY_ROOT_ENV]: path2.join(spawnCwd, ".runtime", "cockpit", "async-registry")
  };
  const interpreter = process2.execPath;
  const runTool = (script, args, overrides = {}) => {
    const present = requireScheduler(script);
    if (!present.ok) return Promise.resolve(present);
    return spawnJson(interpreter, [script, ...args], {
      cwd: spawnCwd,
      env: spawnEnv,
      timeoutMs,
      ...overrides
    });
  };
  const runStatus = (runId) => runTool(scheduler, ["status", "--run-id", runId, "--summary", "--format", "json"]);
  async function fleet_start({ manifest_path, run_id } = {}) {
    const manifestPath = String(manifest_path ?? "").trim();
    if (!manifestPath) return failure("invalid_input", "manifest_path is required");
    const checked = await runTool(manifestChecker, ["--manifest", manifestPath, "--format", "json"]);
    if (!checked.ok) return checked;
    const launched = await runTool(scheduler, [
      "run",
      "--manifest",
      manifestPath,
      ...run_id ? ["--run-id", String(run_id)] : [],
      "--format",
      "json"
    ]);
    if (!launched.ok) return launched;
    const statePath = String(launched.payload.state_path ?? "");
    return {
      ok: true,
      run_id: String(launched.payload.run_id ?? run_id ?? ""),
      state_root: path2.posix.dirname(path2.posix.dirname(statePath)),
      node_count: Array.isArray(checked.payload.nodes) ? checked.payload.nodes.length : 0,
      state_path: statePath,
      driver_pid: launched.payload.pid ?? null,
      driver_log_path: launched.payload.log_path ?? null
    };
  }
  async function fleet_status({ run_id } = {}) {
    const runId = String(run_id ?? "").trim();
    if (!runId) return failure("invalid_input", "run_id is required");
    const status = await runStatus(runId);
    if (!status.ok) return status;
    return { ok: true, ...compactStatus(status.payload), ...driverFields(readDriverStatus(spawnCwd, status.payload.state_path)) };
  }
  async function fleet_wait({ run_id, wait_ms } = {}) {
    const runId = String(run_id ?? "").trim();
    if (!runId) return failure("invalid_input", "run_id is required");
    const waitMs = clampWaitMs(wait_ms);
    const opened = await runStatus(runId);
    if (!opened.ok) return opened;
    const statePath = String(opened.payload.state_path ?? "");
    const startedAt = Date.now();
    const deadline = startedAt + waitMs;
    let driver = readDriverStatus(spawnCwd, statePath);
    let event = "no_wait_performed";
    while (!SETTLED_DRIVER_STATES.has(String(driver?.status ?? ""))) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const waited = await runTool(
        scheduler,
        ["wait", "--run-id", runId, "--wait-ms", String(Math.min(remaining, FLEET_WAIT_MS_MAX)), "--format", "json"],
        { timeoutMs: remaining + FLEET_COMMAND_TIMEOUT_MS }
      );
      if (!waited.ok) return waited;
      event = String(waited.payload.event ?? "");
      driver = readDriverStatus(spawnCwd, statePath);
      if (event === "no_active_tasks" && !SETTLED_DRIVER_STATES.has(String(driver?.status ?? ""))) {
        const reprobeAt = Date.now() + NO_ACTIVE_REPROBE_MS;
        while (Date.now() < reprobeAt && Date.now() < deadline && !SETTLED_DRIVER_STATES.has(String(driver?.status ?? ""))) {
          await sleep(Math.min(DRIVER_POLL_MS, Math.max(deadline - Date.now(), 0)));
          driver = readDriverStatus(spawnCwd, statePath);
        }
      }
    }
    const settlement = await runStatus(runId);
    if (!settlement.ok) return settlement;
    return {
      ok: true,
      run_id: runId,
      settled: SETTLED_DRIVER_STATES.has(String(driver?.status ?? "")),
      driver_status: driver?.status ?? null,
      driver_error: driver?.error ?? null,
      event,
      waited_ms: Date.now() - startedAt,
      wait_ms: waitMs,
      counts: settlement.payload.counts,
      summary: compactSummary(settlement.payload.summary),
      state_path: statePath
    };
  }
  async function fleet_review({ run_id, node_id, decision, reason, evidence } = {}) {
    const runId = String(run_id ?? "").trim();
    const nodeId = String(node_id ?? "").trim();
    const flag = DECISION_FLAG[String(decision ?? "")];
    if (!runId) return failure("invalid_input", "run_id is required");
    if (!nodeId) return failure("invalid_input", "node_id is required");
    if (!flag) return failure("invalid_input", `decision must be one of ${FLEET_DECISIONS.join(", ")}`);
    const reviewed = await runTool(scheduler, [
      "review",
      "--run-id",
      runId,
      "--node-id",
      nodeId,
      flag,
      "--evidence",
      String(evidence ?? ""),
      "--reason",
      String(reason ?? ""),
      "--format",
      "json"
    ]);
    if (!reviewed.ok) return reviewed;
    const current = await runStatus(runId);
    if (!current.ok) return { ok: true, run_id: runId, node_id: nodeId, decision, status: reviewed.payload.status, status_error: current.error };
    return { ok: true, status: reviewed.payload.status, node_id: nodeId, decision, ...compactStatus(current.payload) };
  }
  async function fleet_cancel({ run_id, reason } = {}) {
    const runId = String(run_id ?? "").trim();
    if (!runId || !String(reason ?? "").trim()) return failure("invalid_input", "run_id and reason are required");
    const result = await runTool(scheduler, ["cancel", "--run-id", runId, "--reason", String(reason), "--format", "json"]);
    if (!result.ok) return result;
    const current = await runStatus(runId);
    if (!current.ok) return { ok: true, run_id: runId, status: result.payload.status, status_error: current.error };
    return { ok: true, status: current.payload.summary?.run_state ?? result.payload.status, ...compactStatus(current.payload), ...driverFields(readDriverStatus(spawnCwd, current.payload.state_path)) };
  }
  async function pause({ run_id, reason } = {}) {
    const runId = String(run_id ?? "").trim();
    if (!runId || !String(reason ?? "").trim()) return failure("invalid_input", "run_id and reason are required");
    const result = await runTool(scheduler, ["pause", "--run-id", runId, "--reason", String(reason), "--format", "json"]);
    return result.ok ? { ok: true, ...result.payload } : result;
  }
  async function resume({ run_id } = {}) {
    const runId = String(run_id ?? "").trim();
    if (!runId) return failure("invalid_input", "run_id is required");
    const result = await runTool(scheduler, ["resume", "--run-id", runId, "--format", "json"]);
    return result.ok ? { ok: true, ...result.payload } : result;
  }
  return { fleet_start, fleet_status, fleet_wait, fleet_review, fleet_cancel, pause, resume };
}

// ops/tools/task-outcome.mjs
import { readFileSync as readFileSync2 } from "node:fs";
import path3 from "node:path";
var GATES = /* @__PURE__ */ new Set(["pass", "fail", "needs_owner"]);
function projectTaskOutcome(status = {}, child = {}, taskPackage = {}) {
  const failure2 = status.failure_type && status.failure_type !== "none";
  const orchestration = child?.orchestration;
  const execution = status.state === "cancelled" || status.turn_status === "cancelled" ? "cancelled" : orchestration?.ok === true && orchestration.status === "completed" && orchestration.failure_type === "none" ? "completed" : orchestration?.ok === false || failure2 || status.exit_code != null && status.exit_code !== 0 || ["failed", "error"].includes(status.turn_status) ? "failed" : status.exit_code === 0 && ["completed", "done"].includes(status.turn_status) ? "completed" : "unknown";
  const business = child?.task?.agentDeclaredStatus ?? child?.task?.status ?? status.business_state ?? "unknown";
  const delivery = status.contract_state === "ok" ? "delivered" : status.contract_state ? "unconfirmed" : "unknown";
  const gate = GATES.has(child?.task?.reviewGate) ? child.task.reviewGate : child?.review_synthesis?.applied === true && GATES.has(child.review_synthesis.gate) ? child.review_synthesis.gate : "unknown";
  const name = typeof taskPackage?.expected_output?.business_gate === "string" ? taskPackage.expected_output.business_gate.replace(/^FINAL_HANDOFF\.output\./, "") : null;
  const parent = status.requires_parent_review === true ? "required" : status.requires_parent_review === false ? "not_required" : "unknown";
  const outcome = {
    execution,
    business,
    delivery,
    object_gate: { name, value: gate, source: gate === "unknown" ? null : GATES.has(child?.task?.reviewGate) ? "child-task-result.json:task.reviewGate" : "child-task-result.json:review_synthesis.gate" },
    parent_review: parent
  };
  return { ...outcome, summary: summarizeTaskOutcome(outcome) };
}
function summarizeTaskOutcome(outcome = {}) {
  const executionText = { completed: "\u8FD0\u884C\u7ED3\u675F", failed: "\u8FD0\u884C\u5931\u8D25", cancelled: "\u8FD0\u884C\u5DF2\u53D6\u6D88", unknown: "\u8FD0\u884C\u7ED3\u679C\u672A\u77E5" }[outcome.execution];
  const deliveryText = { delivered: "\u5408\u540C\u4EA7\u7269\u5DF2\u4EA4\u4ED8", unconfirmed: "\u5408\u540C\u4EA4\u4ED8\u672A\u786E\u8BA4", unknown: "\u5408\u540C\u4EA4\u4ED8\u672A\u77E5" }[outcome.delivery];
  const gateText = { pass: "\u901A\u8FC7", fail: "\u4E0D\u901A\u8FC7", needs_owner: "\u5F85\u8D1F\u8D23\u4EBA\u88C1\u51B3", unknown: "\u672A\u77E5" }[outcome.object_gate?.value];
  return [
    executionText,
    deliveryText,
    outcome.business === "partial" ? "\u4EFB\u52A1\u90E8\u5206\u5B8C\u6210" : outcome.business === "failed" && outcome.object_gate?.value !== "fail" ? "\u4EFB\u52A1\u5931\u8D25" : ["blocked", "needs_owner"].includes(outcome.business) ? "\u4EFB\u52A1\u53D7\u963B" : null,
    GATES.has(outcome.object_gate?.value) || outcome.object_gate?.name ? `\u5BF9\u8C61\u95E8${gateText}${outcome.object_gate?.name ? `\uFF08${outcome.object_gate.name}\uFF09` : ""}` : null,
    outcome.parent_review === "required" ? "\u5F85\u4E3B\u4EE3\u7406\u5904\u7F6E" : null
  ].filter(Boolean).join("\uFF1B");
}
function readObject(file) {
  try {
    return JSON.parse(readFileSync2(file, "utf8"));
  } catch {
    return {};
  }
}
function readTaskOutcome(status = {}, taskDir = status.task_dir) {
  if (!taskDir) return projectTaskOutcome(status);
  return projectTaskOutcome(
    status,
    readObject(path3.join(taskDir, "child-task-result.json")),
    readObject(path3.join(taskDir, "task-package.json"))
  );
}

// src/agent-panel/src/web/core.mjs
var FILTER_DEFAULTS = Object.freeze({
  status: "all",
  role: "all",
  model: "all",
  scope: "all"
});
var STATE_LABELS = Object.freeze({
  loading: "\u52A0\u8F7D\u4E2D",
  empty: "\u6682\u65E0\u6570\u636E",
  error: "\u5C40\u90E8\u9519\u8BEF",
  success: "\u5DF2\u540C\u6B65",
  disabled: "\u4E0D\u53EF\u7528",
  running: "\u8FD0\u884C\u4E2D",
  paused: "\u5DF2\u6682\u505C",
  queued: "\u6392\u961F\u4E2D",
  waiting: "\u7B49\u5F85\u4E2D",
  blocked: "\u5DF2\u963B\u65AD",
  completed: "\u5DF2\u5B8C\u6210",
  failed: "\u5931\u8D25",
  cancelled: "\u5DF2\u53D6\u6D88",
  needs_parent_review: "\u5F85\u590D\u6838",
  done: "\u5B8C\u6210",
  submitted: "\u5DF2\u63D0\u4EA4",
  completed_with_uncertainty: "\u6709\u4FDD\u7559\u9879",
  partial: "\u90E8\u5206\u5B8C\u6210",
  unknown: "\u672A\u77E5"
});
var TRANSPORT_LABELS = Object.freeze({
  done: "\u5DF2\u7ED3\u675F",
  completed: "\u5DF2\u7ED3\u675F",
  failed: "\u5F02\u5E38\u7EC8\u6B62"
});
var BUSINESS_LABELS = Object.freeze({
  done: "\u5B8C\u6210",
  completed: "\u5B8C\u6210",
  // completed_with_uncertainty 是子任务结果归一态：只表示有保留项，不代表已验收或未读取
  completed_with_uncertainty: "\u6709\u4FDD\u7559\u9879",
  partial: "\u90E8\u5206\u5B8C\u6210",
  failed: "\u5931\u8D25"
});
var HISTORY_STATUS_GROUPS = Object.freeze([
  { key: "done", label: "\u5B8C\u6210" },
  { key: "uncertain", label: "\u6709\u4FDD\u7559\u9879" },
  { key: "partial", label: "\u90E8\u5206\u5B8C\u6210" },
  { key: "failed", label: "\u5931\u8D25" },
  { key: "blocked", label: "\u53D7\u963B" },
  { key: "cancelled", label: "\u5DF2\u53D6\u6D88" },
  { key: "unknown", label: "\u672A\u77E5" }
]);
var TERMINAL_TRANSPORT_STATES = Object.freeze(["done", "failed", "cancelled", "completed"]);
var FLEET_TERMINAL_NODE_STATES = /* @__PURE__ */ new Set(["done", "failed", "cancelled", "blocked", "needs_parent_review"]);
var FLEET_INFLIGHT_NODE_STATES = /* @__PURE__ */ new Set(["submitted", "queued", "running", "dispatched", "cancel_requested"]);
var FLEET_STATUS_LABELS = Object.freeze({
  running: "\u8FD0\u884C\u4E2D",
  cancelling: "\u7ED3\u675F\u4E2D",
  pending: "\u5F85\u5904\u7406",
  terminal: "\u5DF2\u7ED3\u675F"
});
function fleetNodeId(node) {
  return String(node?.node_id || node?.nodeId || node?.id || "");
}
function fleetTaskTransport(task) {
  return String(task?.transportState || task?.transport_state || "");
}
function classifyFleetActivity(run, tasks = []) {
  if (!run || typeof run !== "object" || run.error_kind || run.errorKind) {
    return {
      kind: "terminal",
      visible: "history",
      problems: [],
      canEnd: false,
      dependencyBlocked: false
    };
  }
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const taskById = /* @__PURE__ */ new Map();
  for (const task of tasks || []) {
    const id = task?.taskId || task?.task_id;
    if (id) taskById.set(String(id), task);
  }
  const driver = String(run.driver_status || run.driverStatus || "");
  const runState = String(run.state || run.run_state || run.runState || "");
  const ready = new Set((Array.isArray(run.ready_queue) ? run.ready_queue : []).map((item) => String(item)));
  const problems = [];
  let executing = false;
  let cancelling = runState === "cancelling" || driver === "cancelling";
  let unresolved = false;
  const byId = new Map(nodes.map((node) => [fleetNodeId(node), node]));
  for (const node of nodes) {
    const state = String(node?.state || "");
    const nodeId = fleetNodeId(node);
    const task = node?.task_id || node?.taskId ? taskById.get(String(node.task_id || node.taskId)) : null;
    const transport = fleetTaskTransport(task);
    const taskTerminal = Boolean(task) && TERMINAL_TRANSPORT_STATES.includes(transport);
    const taskLive = Boolean(task) && transport !== "" && transport !== "paused" && !taskTerminal;
    if (["needs_parent_review", "failed", "blocked"].includes(state) || node?.error_kind || node?.errorKind) {
      problems.push({ node_id: nodeId, state: state || String(node.error_kind || node.errorKind || "") });
    }
    if (state === "cancel_requested" || transport === "cancel_requested") cancelling = true;
    if (taskLive) {
      executing = true;
      continue;
    }
    if (taskTerminal) continue;
    if (FLEET_INFLIGHT_NODE_STATES.has(state)) {
      executing = true;
      continue;
    }
    if (state === "ready" && (driver === "running" || driver === "ready") && ready.has(nodeId)) {
      executing = true;
      continue;
    }
    if (state && !FLEET_TERMINAL_NODE_STATES.has(state)) unresolved = true;
  }
  if (!executing && ready.size > 0 && (driver === "running" || driver === "ready")) executing = true;
  const dependencyBlocked = nodes.some((node) => {
    if (String(node?.state || "") !== "pending") return false;
    const deps = Array.isArray(node.depends_on) ? node.depends_on : Array.isArray(node?.dependsOn) ? node.dependsOn : [];
    if (!deps.length) return false;
    return deps.some((depId) => {
      const dep = byId.get(String(depId));
      if (!dep) return true;
      return ["failed", "cancelled", "blocked", "needs_parent_review"].includes(String(dep.state || ""));
    });
  });
  if (cancelling && (executing || unresolved || runState === "cancelling" || driver === "cancelling")) {
    return { kind: "cancelling", visible: "activity", problems, canEnd: true, dependencyBlocked };
  }
  if (executing) {
    return { kind: "running", visible: "activity", problems, canEnd: true, dependencyBlocked };
  }
  if (unresolved || runState !== "cancelled" && nodes.some((node) => node.state === "needs_parent_review")) {
    return { kind: "pending", visible: "pending", problems, canEnd: true, dependencyBlocked };
  }
  return { kind: "terminal", visible: "history", problems, canEnd: false, dependencyBlocked: false };
}

// src/agent-panel/src/server/projection.mjs
var TASK_ID_PATTERN = /^[A-Za-z0-9_.-]{1,120}$/;
var MAX_TASKS = 2e3;
var MAX_FLEET_RUNS = 200;
var MAX_NOTIFICATIONS = 200;
var MAX_EVENTS = 200;
var CANCELLABLE_STATES = /* @__PURE__ */ new Set(["submitted", "queued", "running", "cancel_requested", "paused"]);
var TERMINAL_TASK_STATES = /* @__PURE__ */ new Set(["done", "failed", "cancelled", "completed"]);
var CANCEL_REASONS = /* @__PURE__ */ new Set(["user_requested", "external_safety_boundary"]);
function safeJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(readFileSync3(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, error: error?.code === "ENOENT" ? "missing" : "invalid_json" };
  }
}
function safeJsonLines(filePath) {
  try {
    const lines = readFileSync3(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    const values = [];
    for (const line of lines.slice(-MAX_EVENTS)) {
      try {
        values.push({ ok: true, value: JSON.parse(line) });
      } catch {
        values.push({ ok: false, error: "invalid_json" });
      }
    }
    return { ok: true, values };
  } catch (error) {
    return { ok: false, error: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
}
function listDirectories(root, limit) {
  if (!existsSync2(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).slice(0, limit).map((entry) => entry.name);
  } catch {
    throw new PanelError("RUNTIME_READ_FAILED", `\u8FD0\u884C\u6001\u76EE\u5F55\u4E0D\u53EF\u8BFB\uFF1A${root}`);
  }
}
function listFiles(root, extension, limit) {
  if (!existsSync2(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension)).slice(0, limit).map((entry) => entry.name);
  } catch {
    throw new PanelError("RUNTIME_READ_FAILED", `\u8FD0\u884C\u6001\u76EE\u5F55\u4E0D\u53EF\u8BFB\uFF1A${root}`);
  }
}
function isoTimestamp(value) {
  if (!value) return 0;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : 0;
}
function waitingSince(value) {
  return isoTimestamp(value) ? value : null;
}
function hasValue(value) {
  return value !== void 0 && value !== null && (typeof value !== "string" || value.trim() !== "");
}
function compactError(kind) {
  return { state: "error", error_kind: kind };
}
function projectTokenUsage(raw) {
  const value = raw?.token_usage;
  if (!hasValue(value) || typeof value === "object" && Object.keys(value).length === 0) {
    return { state: "missing" };
  }
  return value;
}
function tokenCount(tokenUsage) {
  const value = typeof tokenUsage === "object" && tokenUsage !== null ? tokenUsage.totalTokens ?? tokenUsage.total_tokens : tokenUsage;
  if (!hasValue(value)) return null;
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}
function taskDurationMs(raw, transportState) {
  const startTs = isoTimestamp(raw?.started_at) || isoTimestamp(raw?.created_at);
  if (!startTs) return null;
  const terminal = ["done", "failed", "cancelled", "completed"].includes(String(transportState));
  const endTs = transportState === "paused" ? isoTimestamp(raw?.paused_at) || isoTimestamp(raw?.updated_at) || null : terminal ? isoTimestamp(raw?.finished_at) || isoTimestamp(raw?.updated_at) || null : Date.now();
  if (!endTs) return null;
  return Math.max(0, endTs - startTs);
}
function projectResultRead(raw) {
  const taskDir = raw?.task_dir;
  const taskId = raw?.task_id;
  const fallbackRevision = raw?.revision ?? raw?.rev ?? null;
  if (!taskDir || !taskId) {
    return {
      result_read_state: "unknown",
      result_revision: fallbackRevision != null ? String(fallbackRevision) : null
    };
  }
  const receipt = safeJson(path4.join(taskDir, "result.json"));
  const sidecar = safeJson(path4.join(taskDir, "result-read.json"));
  const value = receipt.ok && receipt.value && typeof receipt.value === "object" && !Array.isArray(receipt.value) ? receipt.value : null;
  const trackingVersion = value?.result_tracking_version != null && String(value.result_tracking_version).trim() !== "" ? String(value.result_tracking_version) : null;
  const currentVersion = trackingVersion ?? (value?.revision != null && String(value.revision).trim() !== "" ? String(value.revision) : null) ?? (fallbackRevision != null ? String(fallbackRevision) : null);
  const recorded = sidecar.ok && sidecar.value && sidecar.value.task_id === taskId && currentVersion != null && String(sidecar.value.result_revision) === String(currentVersion);
  if (recorded) {
    return { result_read_state: "read", result_revision: currentVersion };
  }
  if (trackingVersion) {
    return { result_read_state: "unread", result_revision: trackingVersion };
  }
  return {
    result_read_state: "unknown",
    result_revision: currentVersion
  };
}
function projectTask(raw, metadata = {}) {
  const transportState = raw?.state ?? "unknown";
  const businessState = raw?.business_state ?? null;
  const tokenUsage = projectTokenUsage(raw);
  const tokens = tokenCount(tokenUsage);
  const resultRead = projectResultRead({ ...raw, task_dir: raw?.task_dir ?? metadata.task_dir });
  return {
    duration_ms: taskDurationMs(raw, transportState),
    task_id: raw?.task_id ?? null,
    revision: String(raw?.revision ?? raw?.rev ?? 0),
    batch_id: hasValue(raw?.batch_id) ? raw.batch_id : metadata.batch_id ?? null,
    slice_id: hasValue(raw?.slice_id) ? raw.slice_id : metadata.slice_id ?? null,
    run_id: hasValue(raw?.run_id) ? raw.run_id : metadata.run_id ?? null,
    display_title: raw?.display_title ?? null,
    runtime_role: raw?.runtime_role ?? null,
    model: raw?.model ?? null,
    effort: raw?.effort ?? null,
    transport_state: transportState,
    business_state: businessState,
    task_outcome: readTaskOutcome(raw, raw?.task_dir ?? metadata.task_dir),
    review_gate: raw?.requires_parent_review ? "needs_parent_review" : raw?.review_gate ?? null,
    created_at: raw?.created_at ?? null,
    started_at: raw?.started_at ?? null,
    updated_at: raw?.updated_at ?? null,
    finished_at: raw?.finished_at ?? null,
    elapsed_seconds: raw?.elapsed_seconds ?? null,
    token_usage: tokenUsage,
    token_count: tokens,
    token_state: tokenUsage.state === "missing" ? "missing" : tokens === null ? "unavailable" : "available",
    tool_call_count: raw?.tool_call_count ?? 0,
    last_tool_kind: raw?.last_tool_kind ?? null,
    progress_state: raw?.progress_state ?? null,
    requires_parent_review: Boolean(raw?.requires_parent_review),
    review_acked_at: raw?.review_acked_at ?? null,
    result_read_state: resultRead.result_read_state,
    result_revision: resultRead.result_revision,
    failure_type: raw?.failure_type === "none" ? null : raw?.failure_type ?? null,
    cancel_reason: raw?.cancel_reason ?? null,
    report_path: raw?.report_path ?? raw?.report ?? null,
    handoff_path: raw?.handoff_path ?? raw?.handoff ?? null,
    completion_notice_path: raw?.completion_notice_path ?? null,
    task_dir: raw?.task_dir ?? null,
    target_cwd: raw?.target_cwd ?? metadata.target_cwd ?? null,
    origin_thread_id: raw?.origin_thread_id ?? metadata.origin_thread_id ?? null,
    project_path: raw?.project_path ?? metadata.project_path ?? null,
    failure_summary: raw?.failure_summary ?? null,
    error: raw?.error ?? null,
    can_cancel: CANCELLABLE_STATES.has(String(transportState))
  };
}
function projectDiagnostic(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    revision: String(raw.revision ?? raw.rev ?? 0),
    transport_state: raw.state ?? null,
    business_state: raw.business_state ?? null,
    contract_state: raw.contract_state ?? null,
    review_gate: raw.review_gate ?? null,
    failure_summary: raw.failure_summary ?? null,
    process_alive: raw.process_alive ?? null,
    progress: raw.progress ?? null,
    failure_type: raw.failure_type ?? null,
    turn_status: raw.turn_status ?? null
  };
}
function projectEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { event_state: "invalid" };
  }
  const result = {};
  for (const key of [
    "at",
    "timestamp",
    "type",
    "kind",
    "event",
    "status",
    "state",
    "task_id",
    "run_id",
    "batch_id",
    "slice_id",
    "node_id",
    "tool_kind",
    "revision",
    "fleet_revision",
    "business_state",
    "cursor",
    "path"
  ]) {
    if (value[key] !== void 0 && value[key] !== null) result[key] = value[key];
  }
  return result;
}
function projectNode(value, runId, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { node_id: null, run_id: runId, state: "error", error_kind: "invalid_node" };
  }
  const nodeId = value.id ?? value.node_id ?? value.task_id ?? null;
  const nodeState = value.state ?? value.status ?? null;
  if (!hasValue(nodeId) || !hasValue(nodeState)) {
    return {
      node_id: hasValue(nodeId) ? nodeId : null,
      run_id: runId,
      task_id: value.task_id ?? null,
      state: "error",
      error_kind: "node_fields_missing",
      depends_on: Array.isArray(value.depends_on) ? value.depends_on : []
    };
  }
  const review = value.review && typeof value.review === "object" ? value.review : null;
  return {
    node_id: nodeId,
    run_id: runId,
    task_id: value.task_id ?? null,
    batch_id: value.batch_id ?? value.dispatch?.batch_id ?? null,
    slice_id: value.slice_id ?? value.dispatch?.slice_id ?? null,
    // 节点的人话标题：派发时 seed.title/goal 派生，旧 cockpit 有此投影，迁移时丢失后
    // 节点卡只能显示 node id 代号（DAG 可读性审查确认的缺口）
    display_title: value.display_title ?? value.dispatch?.display_title ?? null,
    role: value.role ?? null,
    state: nodeState,
    business_state: value.business_state ?? value.last_status?.business_state ?? null,
    model: value.model ?? value.dispatch?.model ?? null,
    effort: value.effort ?? value.dispatch?.effort ?? null,
    revision: Number.isInteger(Number(value.revision)) ? Number(value.revision) : 0,
    resource_locks: Array.isArray(value.resource_locks) ? value.resource_locks.map(String) : [],
    is_reducer: value.is_reducer === true,
    depends_on: Array.isArray(value.depends_on) ? value.depends_on : [],
    review_required: Boolean(value.review_required || review),
    review: review ? {
      reason: review.reason ?? review.error ?? null,
      decision: value.review_decision ?? review.decision ?? null,
      // 等待起点锚在复核事件自己的时间戳上；缺了才退节点 updated_at，
      // 否则节点后续刷新会冲掉「等了多久」的起点
      updated_at: review.updated_at ?? value.updated_at ?? null,
      waiting_since: waitingSince(review.updated_at ?? value.updated_at)
    } : null,
    updated_at: value.updated_at ?? null
  };
}
function sameFleetRoot(left, right) {
  const norm = (value) => {
    const resolved = path4.resolve(String(value)).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return norm(left) === norm(right);
}
function annotateFleetActivity(run, tasks = []) {
  if (!run || run.error_kind) return run;
  const activity = classifyFleetActivity(run, tasks);
  return {
    ...run,
    activity: activity.kind,
    activity_visible: activity.visible,
    can_end: activity.canEnd,
    dependency_blocked: activity.dependencyBlocked,
    activity_problems: activity.problems
  };
}
function projectFleetRun(runId, state, driverStatus = null) {
  const rawNodes = Array.isArray(state?.nodes) ? state.nodes : [];
  const events = Array.isArray(state?.events) ? state.events.slice(-MAX_EVENTS).map(projectEvent) : [];
  const nodes = rawNodes.map((node, index) => projectNode(node, runId, index));
  const nodeError = nodes.some((node) => node.state === "error");
  return annotateFleetActivity({
    run_id: runId,
    driver_status: driverStatus,
    state: state?.state ?? state?.status ?? state?.run_state ?? "unknown",
    created_at: state?.created_at ?? null,
    updated_at: state?.updated_at ?? null,
    finished_at: state?.finished_at ?? null,
    revision: Number.isInteger(Number(state?.revision)) ? Number(state.revision) : 0,
    event_revision: Number.isInteger(Number(state?.event_revision)) ? Number(state.event_revision) : 0,
    cursor: `${runId}+${Number.isInteger(Number(state?.event_revision)) ? Number(state.event_revision) : 0}`,
    ready_queue: Array.isArray(state?.ready_queue) ? state.ready_queue.map(String) : [],
    failure_fuse: state?.failure_fuse && typeof state.failure_fuse === "object" ? state.failure_fuse : { status: "open", blocked_nodes: [] },
    node_count: rawNodes.length,
    section_state: nodeError ? "error" : void 0,
    nodes,
    edges: nodes.flatMap((node) => (node.depends_on || []).map((source) => ({
      run_id: runId,
      from: source,
      to: node.node_id
    }))),
    events
  });
}
function sectionState(items, hasError = false) {
  if (hasError) return "error";
  return items.length ? "success" : "empty";
}
function attachFleetRunIds(tasks, fleetRuns) {
  const taskRuns = /* @__PURE__ */ new Map();
  for (const run of fleetRuns || []) {
    if (!hasValue(run?.run_id)) continue;
    for (const node of run.nodes || []) {
      if (!hasValue(node?.task_id)) continue;
      if (!taskRuns.has(node.task_id)) taskRuns.set(node.task_id, /* @__PURE__ */ new Set());
      taskRuns.get(node.task_id).add(run.run_id);
    }
  }
  return tasks.map((task) => {
    if (hasValue(task.run_id)) return task;
    const runIds = taskRuns.get(task.task_id);
    if (!runIds || runIds.size !== 1) return task;
    return { ...task, run_id: [...runIds][0] };
  });
}
function matchesTask(task, query) {
  const state = String(query.state || "").trim();
  if (state) {
    const accepted = new Set(state.split(",").map((item) => item.trim()).filter(Boolean));
    if (!accepted.has(String(task.transport_state))) return false;
  }
  const role = String(query.role || "").trim().toLowerCase();
  if (role && String(task.runtime_role || "").toLowerCase() !== role) return false;
  const model = String(query.model || "").trim().toLowerCase();
  if (model && String(task.model || "").toLowerCase() !== model) return false;
  const keyword = String(query.keyword || query.q || "").trim().toLowerCase();
  if (keyword) {
    const haystack = [
      task.task_id,
      task.display_title,
      task.batch_id,
      task.slice_id,
      task.run_id,
      task.runtime_role,
      task.model
    ].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(keyword)) return false;
  }
  const scope = String(query.scope || query.range || "all").trim().toLowerCase();
  if (["thread", "this-thread", "current-thread"].includes(scope)) {
    const threadId = String(query.thread_id || query.thread || "").trim();
    if (!threadId || task.origin_thread_id !== threadId) return false;
  }
  if (["project", "this-project", "current-project"].includes(scope)) {
    const projectPath = String(query.project_path || query.project || "").trim();
    if (!projectPath || path4.resolve(task.project_path || task.target_cwd || "") !== path4.resolve(projectPath)) return false;
  }
  return true;
}
var PanelProjection = class {
  constructor({ paths, service, contractVersion = EXPECTED_CONTRACT_VERSION }) {
    this.paths = paths;
    this.service = service;
    this.contractVersion = contractVersion;
  }
  #withKnownStart(raw) {
    if (!raw || raw.started_at || !raw.task_id) return raw;
    const disk = raw.task_dir ? safeJson(path4.join(raw.task_dir, "status.json")) : null;
    const startedAt = disk?.ok ? disk.value?.started_at : null;
    return startedAt ? { ...raw, started_at: startedAt } : raw;
  }
  #assertAvailable() {
    if (!isDirectory(this.paths.controlRoot)) {
      throw new PanelError(
        "CONTROL_ROOT_INVALID",
        `\u63A7\u5236\u4ED3\u8DEF\u5F84\u4E0D\u53EF\u7528\uFF1A${this.paths.controlRoot}`,
        { details: { path: this.paths.controlRoot } }
      );
    }
    if (!isDirectory(this.paths.runtimeRoot)) {
      throw new PanelError(
        "CONTROL_RUNTIME_UNAVAILABLE",
        `\u63A7\u5236\u4ED3\u8FD0\u884C\u6001\u4E0D\u53EF\u7528\uFF1A${this.paths.runtimeRoot}`,
        { details: { path: this.paths.runtimeRoot } }
      );
    }
    if (!this.service) {
      throw new PanelError("PANEL_SERVICE_UNAVAILABLE", "\u9762\u677F\u670D\u52A1\u4E0D\u53EF\u7528");
    }
  }
  availabilityError() {
    try {
      this.#assertAvailable();
      return null;
    } catch (error) {
      return error;
    }
  }
  #taskDirectories() {
    return listDirectories(this.paths.taskRoot, MAX_TASKS);
  }
  #fallbackTasks() {
    const tasks = [];
    let hasError = false;
    for (const taskId of this.#taskDirectories()) {
      const taskDir = path4.join(this.paths.taskRoot, taskId);
      try {
        if (!TASK_ID_PATTERN.test(taskId)) throw new Error("invalid_task_id");
        const response = this.service.get({ task_ids: [taskId], task_root: this.paths.taskRoot, detail: "diagnostic" });
        const raw = response.tasks?.[0];
        tasks.push(projectTask(this.#withKnownStart({ ...raw, task_dir: taskDir })));
      } catch {
        hasError = true;
        tasks.push({ task_id: taskId, task_dir: taskDir, ...compactError("task_data_invalid") });
      }
    }
    return { tasks, hasError };
  }
  #snapshotTasks() {
    try {
      const response = this.service.snapshot({ task_root: this.paths.taskRoot, limit: MAX_TASKS });
      const tasks = (response.tasks || []).map((task) => {
        const taskDir = task.task_dir || path4.join(this.paths.taskRoot, task.task_id);
        return projectTask(this.#withKnownStart({ ...task, task_dir: taskDir }));
      });
      return { tasks, hasError: false };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (!this.#taskDirectories().length) throw error;
      return this.#fallbackTasks();
    }
  }
  tasks(query = {}, fleetRuns = null) {
    this.#assertAvailable();
    const { tasks, hasError } = this.#snapshotTasks();
    const runs = fleetRuns || this.fleet().runs;
    const projected = attachFleetRunIds(tasks, runs);
    const filtered = projected.filter((task) => matchesTask(task, query));
    return {
      ok: true,
      contract_version: this.contractVersion,
      section: "tasks",
      section_state: sectionState(filtered, hasError),
      partial_errors: hasError,
      tasks: filtered
    };
  }
  snapshot(query = {}) {
    const fleet = this.fleet();
    const tasks = this.tasks(query, fleet.runs);
    fleet.runs = (fleet.runs || []).map((run) => annotateFleetActivity(run, tasks.tasks));
    const reviews = this.reviews(tasks.tasks, fleet.runs);
    const notifications = this.notifications({});
    return {
      ok: true,
      contract_version: this.contractVersion,
      connection_state: "connected",
      context: {
        project_path: this.paths.controlRoot,
        thread_id: null
      },
      tasks,
      fleet,
      reviews,
      notifications
    };
  }
  taskDetail(taskId) {
    this.#assertAvailable();
    if (!TASK_ID_PATTERN.test(String(taskId))) {
      throw new PanelError("TASK_ID_INVALID", "task_id \u683C\u5F0F\u65E0\u6548", { status: 400, scope: "local" });
    }
    let response;
    try {
      response = this.service.get({ task_ids: [taskId], task_root: this.paths.taskRoot, detail: "diagnostic" });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return {
        ok: false,
        contract_version: this.contractVersion,
        section: "task_detail",
        section_state: "error",
        error_kind: "task_data_invalid",
        task_id: taskId
      };
    }
    const taskDir = path4.join(this.paths.taskRoot, taskId);
    const disk = safeJson(path4.join(taskDir, "status.json"));
    const diskStatus = disk.ok ? disk.value : {};
    const serviceRaw = response.tasks?.[0] || {};
    const raw = { ...diskStatus, ...serviceRaw, task_id: taskId, task_dir: taskDir };
    const task = attachFleetRunIds(
      [projectTask(raw)],
      this.fleet().runs
    )[0];
    const events = this.taskEvents(taskId, taskDir);
    task.events = events.events;
    return {
      ok: true,
      contract_version: this.contractVersion,
      section: "task_detail",
      section_state: "success",
      task,
      diagnostic: projectDiagnostic(raw),
      events: events.events,
      events_state: events.state
    };
  }
  taskEvents(taskId, taskDir = path4.join(this.paths.taskRoot, taskId)) {
    this.#assertAvailable();
    if (!TASK_ID_PATTERN.test(String(taskId))) {
      throw new PanelError("TASK_ID_INVALID", "task_id \u683C\u5F0F\u65E0\u6548", { status: 400, scope: "local" });
    }
    const result = safeJsonLines(path4.join(taskDir, "child-task-events.jsonl"));
    if (!result.ok) {
      if (result.error === "missing") return { state: "empty", events: [] };
      return { state: "error", error_kind: "events_unreadable", events: [] };
    }
    const events = [];
    let hasError = false;
    for (const item of result.values) {
      if (!item.ok) {
        hasError = true;
        events.push({ event_state: "error", error_kind: "event_data_invalid" });
      } else {
        events.push(projectEvent(item.value));
      }
    }
    return { state: hasError ? "error" : sectionState(events), events };
  }
  fleet() {
    this.#assertAvailable();
    const runs = [];
    let hasError = false;
    for (const runId of listDirectories(this.paths.fleetRoot, MAX_FLEET_RUNS)) {
      const runDir = path4.join(this.paths.fleetRoot, runId);
      const state = safeJson(path4.join(runDir, "state.json"));
      if (!state.ok && state.error !== "missing") {
        hasError = true;
        runs.push({ run_id: runId, ...compactError("fleet_data_invalid") });
        continue;
      }
      runs.push(projectFleetRun(runId, state.value, projectFleetDriver({ stateRoot: this.paths.fleetRoot, runId }).driver_status));
    }
    const value = {
      ok: true,
      contract_version: this.contractVersion,
      section: "fleet",
      section_state: sectionState(runs, hasError),
      partial_errors: hasError,
      runs
    };
    return value;
  }
  fleetDetail(runId) {
    this.#assertAvailable();
    if (!TASK_ID_PATTERN.test(String(runId))) {
      throw new PanelError("RUN_ID_INVALID", "run_id \u683C\u5F0F\u65E0\u6548", { status: 400, scope: "local" });
    }
    const runDir = path4.join(this.paths.fleetRoot, runId);
    if (!existsSync2(runDir)) {
      return { ok: false, contract_version: this.contractVersion, section_state: "empty", run_id: runId };
    }
    const state = safeJson(path4.join(runDir, "state.json"));
    if (!state.ok && state.error !== "missing") {
      return { ok: false, contract_version: this.contractVersion, section_state: "error", error_kind: "fleet_data_invalid", run_id: runId };
    }
    return {
      ok: true,
      contract_version: this.contractVersion,
      section: "fleet_detail",
      section_state: "success",
      run: projectFleetRun(runId, state.value, projectFleetDriver({ stateRoot: this.paths.fleetRoot, runId }).driver_status)
    };
  }
  reviews(tasks, fleetRuns = this.fleet().runs) {
    const taskItems = tasks.filter((task) => task.result_read_state === "unread" || task.requires_parent_review === true).map((task) => ({
      kind: "task",
      id: task.task_id,
      task_id: task.task_id,
      run_id: task.run_id,
      reason: task.requires_parent_review === true ? "needs_parent_review" : "unread_result",
      updated_at: task.updated_at,
      waiting_since: waitingSince(task.updated_at)
    }));
    const nodeItems = fleetRuns.flatMap((run) => (run.nodes || []).filter((node) => node.review_required || ["needs_parent_review", "blocked"].includes(node.state)).filter((node) => !["accepted", "blocked"].includes(node.review?.decision)).map((node) => ({
      kind: "fleet_node",
      id: `${run.run_id}:${node.node_id}`,
      task_id: node.task_id,
      run_id: run.run_id,
      node_id: node.node_id,
      reason: node.review?.reason || node.state,
      updated_at: node.updated_at,
      waiting_since: node.review?.waiting_since ?? waitingSince(node.updated_at)
    })));
    const items = [...taskItems, ...nodeItems];
    return {
      ok: true,
      contract_version: this.contractVersion,
      section: "reviews",
      section_state: sectionState(items),
      read_only: true,
      items
    };
  }
  notifications(query = {}) {
    this.#assertAvailable();
    const items = [];
    let hasError = false;
    for (const name of listFiles(this.paths.inboxRoot, ".json", MAX_NOTIFICATIONS)) {
      const result = safeJson(path4.join(this.paths.inboxRoot, name));
      if (!result.ok) {
        hasError = true;
        items.push({ notification_state: "error", error_kind: "notification_data_invalid", source: name });
        continue;
      }
      const value = result.value;
      if (!value || typeof value !== "object" || !value.task_id) {
        hasError = true;
        items.push({ notification_state: "error", error_kind: "notification_data_invalid", source: name });
        continue;
      }
      items.push({
        task_id: value.task_id,
        transport_state: value.state ?? null,
        business_state: value.business_state ?? null,
        terminal: ["done", "failed", "cancelled"].includes(String(value.state)),
        revision: value.revision ?? value.status_rev ?? null,
        finished_at: value.finished_at ?? null,
        source: name
      });
    }
    items.sort((left, right) => isoTimestamp(right.finished_at) - isoTimestamp(left.finished_at));
    return this.#notificationsEnvelope({ items, hasError }, query);
  }
  // 按本次query裁切有界通知清单。
  #notificationsEnvelope({ items, hasError }, query) {
    return {
      ok: true,
      contract_version: this.contractVersion,
      section: "notifications",
      section_state: sectionState(items, hasError),
      partial_errors: hasError,
      items: items.slice(0, Number(query.limit) > 0 ? Number(query.limit) : MAX_NOTIFICATIONS)
    };
  }
  // 历史专用投影：只回终态任务，不捎带 fleet/reviews/notifications——
  // /api/history 曾复用整份 snapshot 再附一份终态数组，响应近双倍膨胀（sol 体检实测）
  history(query = {}) {
    this.#assertAvailable();
    const { tasks, hasError } = this.#snapshotTasks();
    const projected = attachFleetRunIds(tasks, this.fleet().runs);
    const filtered = projected.filter((task) => matchesTask(task, query)).filter((task) => TERMINAL_TASK_STATES.has(String(task.transport_state)) || TERMINAL_TASK_STATES.has(String(task.business_state)));
    return {
      ok: true,
      contract_version: this.contractVersion,
      section: "history",
      section_state: sectionState(filtered, hasError),
      partial_errors: hasError,
      history: filtered,
      history_count: filtered.length
    };
  }
  cancel(taskId, expectedRevision, reason = "user_requested") {
    this.#assertAvailable();
    if (!TASK_ID_PATTERN.test(String(taskId))) {
      throw new PanelError("TASK_ID_INVALID", "task_id \u683C\u5F0F\u65E0\u6548", { status: 400, scope: "local" });
    }
    if (expectedRevision === void 0 || expectedRevision === null || String(expectedRevision).trim() === "") {
      throw new PanelError("EXPECTED_REVISION_REQUIRED", "\u53D6\u6D88\u5FC5\u987B\u63D0\u4F9B expected_revision", { status: 400, scope: "local" });
    }
    if (typeof expectedRevision !== "string" && typeof expectedRevision !== "number") {
      throw new PanelError("EXPECTED_REVISION_INVALID", "expected_revision \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6216\u6570\u5B57", { status: 400, scope: "local" });
    }
    if (typeof reason !== "string" || !CANCEL_REASONS.has(reason)) {
      throw new PanelError("CANCEL_REASON_INVALID", `\u53D6\u6D88\u539F\u56E0\u4E0D\u5728\u5141\u8BB8\u96C6\u5185\uFF08${[...CANCEL_REASONS].join(" / ")}\uFF09`, { status: 400, scope: "local" });
    }
    return this.service.cancel({
      task_root: this.paths.taskRoot,
      task_id: taskId,
      expected_revision: String(expectedRevision),
      reason
    });
  }
  ackReview(taskId, expectedRevision, note) {
    this.#assertAvailable();
    if (!TASK_ID_PATTERN.test(String(taskId))) {
      throw new PanelError("TASK_ID_INVALID", "task_id \u683C\u5F0F\u65E0\u6548", { status: 400, scope: "local" });
    }
    if (expectedRevision !== void 0 && expectedRevision !== null && typeof expectedRevision !== "string" && typeof expectedRevision !== "number") {
      throw new PanelError("EXPECTED_REVISION_INVALID", "expected_revision \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6216\u6570\u5B57", { status: 400, scope: "local" });
    }
    if (note !== void 0 && note !== null && typeof note !== "string") {
      throw new PanelError("NOTE_INVALID", "note \u5FC5\u987B\u662F\u5B57\u7B26\u4E32", { status: 400, scope: "local" });
    }
    return this.service.ackReview({
      task_id: taskId,
      ...expectedRevision ? { expected_revision: String(expectedRevision) } : {},
      ...note ? { note: String(note) } : {},
      task_root: this.paths.taskRoot
    });
  }
  // 结束指定 Fleet：只调用既有 fleet_cancel，不另写状态机，不删 state、失败记录或任务报告。
  // run_id 只作为当前监控项目 fleet 目录下的名字；不接受调用方传入的路径或命令。
  async endFleet(runId, reason = "user_requested") {
    this.#assertAvailable();
    if (!TASK_ID_PATTERN.test(String(runId))) {
      throw new PanelError("RUN_ID_INVALID", "run_id \u683C\u5F0F\u65E0\u6548", { status: 400, scope: "local" });
    }
    if (typeof reason !== "string" || !CANCEL_REASONS.has(reason)) {
      throw new PanelError("CANCEL_REASON_INVALID", `\u7ED3\u675F\u539F\u56E0\u4E0D\u5728\u5141\u8BB8\u96C6\u5185\uFF08${[...CANCEL_REASONS].join(" / ")}\uFF09`, { status: 400, scope: "local" });
    }
    const runDir = path4.join(this.paths.fleetRoot, String(runId));
    assertRuntimePathInside(this.paths.fleetRoot, runDir);
    const stateFile = path4.join(runDir, "state.json");
    if (!existsSync2(stateFile)) {
      throw new PanelError("FLEET_RUN_NOT_FOUND", "\u6307\u5B9A\u8FD0\u884C\u4E0D\u5728\u5F53\u524D\u76D1\u63A7\u9879\u76EE\u4E2D", { status: 404, scope: "local" });
    }
    const parsed = safeJson(stateFile);
    if (!parsed.ok) {
      throw new PanelError("FLEET_DATA_INVALID", "\u8FD0\u884C\u72B6\u6001\u4E0D\u53EF\u8BFB\uFF0C\u672A\u6267\u884C\u7ED3\u675F", { status: 422, scope: "local" });
    }
    const declaredRoot = parsed.value?.state_root;
    if (typeof declaredRoot !== "string" || !declaredRoot.trim() || !sameFleetRoot(declaredRoot, this.paths.fleetRoot)) {
      throw new PanelError("FLEET_RUN_ROOT_MISMATCH", "\u8FD0\u884C\u72B6\u6001\u6839\u5FC5\u987B\u662F\u5F53\u524D\u76D1\u63A7\u9879\u76EE\u7684 fleet \u76EE\u5F55", { status: 422, scope: "local" });
    }
    const env = { ...this.fleetCancelEnv || process.env };
    const fleet = createFleetCore({
      projectRoot: this.paths.controlRoot,
      env,
      ...this.fleetCancelTimeoutMs ? { timeoutMs: this.fleetCancelTimeoutMs } : {}
    });
    const result = await fleet.fleet_cancel({ run_id: String(runId), reason });
    if (!result?.ok) {
      const message = String(result?.error?.message || "fleet_cancel \u5931\u8D25").slice(0, 500);
      throw new PanelError("FLEET_END_FAILED", message, {
        status: result?.error?.kind === "invalid_input" ? 400 : 422,
        scope: "local",
        details: {
          kind: result?.error?.kind || "scheduler_failed",
          exit_code: result?.error?.exit_code ?? null
        }
      });
    }
    const status = String(result.status || "");
    const confirmed = status === "cancelled";
    return {
      accepted: true,
      status: confirmed ? "cancelled" : status || "cancelling",
      confirmed,
      reason: result.reason ?? null,
      active: Array.isArray(result.active) ? result.active.map(String) : [],
      errors: Array.isArray(result.errors) ? result.errors.slice(0, 20).map(String) : []
    };
  }
};
function assertRuntimePathInside(root, candidate) {
  const relative = path4.relative(path4.resolve(root), path4.resolve(candidate));
  if (relative === "" || relative.startsWith(`..${path4.sep}`) || path4.isAbsolute(relative)) {
    throw new PanelError("RUNTIME_PATH_ESCAPE", "\u8FD0\u884C\u6001\u8DEF\u5F84\u8D8A\u754C");
  }
  return candidate;
}
function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// src/agent-panel/src/server/aggregation-worker.mjs
var projectionPromise = null;
async function getProjection() {
  if (!projectionPromise) {
    projectionPromise = createAsyncTaskService({
      paths: workerData.paths,
      asyncCorePath: workerData.asyncCorePath,
      registryRoot: workerData.registryRoot
    }).then(({ core, service }) => new PanelProjection({
      paths: workerData.paths,
      service,
      contractVersion: core.CONTRACT_VERSION
    }));
  }
  return projectionPromise;
}
function serializeError(error) {
  return {
    code: error?.code || "SERVER_ERROR",
    message: error?.message || "\u670D\u52A1\u5904\u7406\u5931\u8D25",
    status: error?.status || 500,
    scope: error?.scope || "global",
    details: error?.details || null
  };
}
parentPort.on("message", async ({ id, method, args }) => {
  try {
    if (workerData.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, workerData.delayMs));
    }
    const projection = await getProjection();
    const result = projection[method](...args);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: serializeError(error) });
  }
});
