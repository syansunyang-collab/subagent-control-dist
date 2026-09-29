// Fleet scheduler 的工具面共享逻辑：MCP 与 Pi 扩展各自注册工具，调度语义全部留在
// ops/tools/fleet_scheduler.mjs，本文件只负责进程封装、参数整形与结构化错误。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const FLEET_TOOL_NAMES = Object.freeze(["fleet_start", "fleet_status", "fleet_wait", "fleet_review", "fleet_cancel"]);
export const FLEET_DECISIONS = Object.freeze(["accept", "block", "requeue"]);
export const FLEET_WAIT_MS_MIN = 1_000;
export const FLEET_WAIT_MS_MAX = 600_000;
export const FLEET_WAIT_MS_DEFAULT = 60_000;
export const FLEET_COMMAND_TIMEOUT_MS = 120_000;

export const FLEET_SCHEDULER_NAME = "fleet_scheduler";
export const FLEET_MANIFEST_CHECK_NAME = "fleet_manifest_check";
export const SUBAGENT_PROJECT_ROOT_ENV = "SUBAGENT_PROJECT_ROOT";
export const SUBAGENT_RUNTIME_ROOT_ENV = "SUBAGENT_RUNTIME_ROOT";
const SUBAGENT_REGISTRY_ROOT_ENV = "SUBAGENT_REGISTRY_ROOT";

const DECISION_FLAG = Object.freeze({ accept: "--accept", block: "--block", requeue: "--requeue" });
const SETTLED_DRIVER_STATES = new Set(["completed", "blocked", "needs_parent_review", "failed", "cancelled"]);
const DRIVER_POLL_MS = 500;
const NO_ACTIVE_REPROBE_MS = 5_000;
const SCHEDULER_RELATIVE_PATH = path.join("ops", "tools", "fleet_scheduler.mjs");
// ops/tools 与 ops/dist 同深度，源码入口和打包入口都能用同一步回到仓根。
const MODULE_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function failure(kind, message, detail = {}) {
  return { ok: false, error: { kind, message, ...detail } };
}

// 部署槽只装 bundle，不带调度器脚本；fleet 状态又必须落在持有脚本的那个仓里。
export function resolveFleetRepoRoot({ cwd = process.cwd(), env = process.env } = {}) {
  for (const candidate of [env.SUBAGENT_CONTROL_REPO_ROOT, cwd, MODULE_REPO_ROOT]) {
    if (!candidate) continue;
    const root = path.resolve(String(candidate));
    if (existsSync(path.join(root, SCHEDULER_RELATIVE_PATH))) return root;
  }
  return path.resolve(cwd);
}

// spawn 之前先证明调度器脚本存在;部署槽 cwd 下缺脚本时给出唯一出路,不让模型面对裸 node 报错。
function requireScheduler(scheduler) {
  if (!scheduler || !existsSync(scheduler)) {
    return failure(
      "scheduler_not_found",
      `fleet_scheduler was not found: ${scheduler ?? "(unresolved)"}; install the shared runtime package or set SUBAGENT_CONTROL_REPO_ROOT to the control repo root`,
      { expected_path: scheduler ?? null },
    );
  }
  return { ok: true, scheduler };
}

// 生产包只带已声明入口；开发模式才按运行包的源码脚本与 dist 制品顺序查找。
function resolveRuntimeScript({ runtimeRoot, name, defaults }) {
  for (const relative of defaults) {
    const candidate = path.join(runtimeRoot, ...relative.split("/"));
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
      if (declared) return path.join(runtimeRoot, ...declared.split("/"));
      // 消费模式只认已声明入口：依次确认默认相对路径确实在 files 清单内。
      const files = Array.isArray(manifest.files) ? manifest.files : [];
      for (const relative of defaults) {
        if (!files.includes(relative)) continue;
        const candidate = path.join(runtimeRoot, ...relative.split("/"));
        if (existsSync(candidate)) return candidate;
      }
      return null;
    }
    return resolveRuntimeScript({ runtimeRoot, name, defaults });
  };
  return {
    scheduler: resolveOne(FLEET_SCHEDULER_NAME, [
      "ops/dist/fleet_scheduler.bundle.mjs",
      "ops/tools/fleet_scheduler.mjs",
    ]),
    manifestChecker: resolveOne(FLEET_MANIFEST_CHECK_NAME, [
      "ops/dist/fleet_manifest_check.bundle.mjs",
      "ops/tools/fleet_manifest_check.mjs",
    ]),
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
    const child = spawn(interpreter, args, {
      cwd,
      env,
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve(failure(
      "spawn_failed",
      `could not run ${interpreter}: ${error?.message ?? String(error)}`,
      { command: [interpreter, ...args] },
    )));
    child.on("close", (code, signal) => {
      const command = [interpreter, ...args];
      if (signal) {
        resolve(failure("timeout", `${args[1] || args[0]} exceeded ${timeoutMs} ms and was killed`, {
          command,
          signal,
          stderr: stderr.trim(),
        }));
        return;
      }
      if (code !== 0 && !stdout.trim()) {
        resolve(failure("scheduler_failed", stderr.trim().split("\n").pop() || `exit code ${code}`, {
          command,
          exit_code: code,
          stderr: stderr.trim().slice(0, 2000),
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
          stdout: stdout.trim().slice(0, 2000),
          stderr: stderr.trim().slice(0, 2000),
        }));
        return;
      }
      if (code !== 0 || payload?.status === "failed" || payload?.status === "error") {
        // 错误面只回有界摘要:manifest 校验失败时全量 payload 可达数十 KB,与工具面省上下文的
        // 立项目的相反;具体错误在 error 或 errors 数组里,白名单透传。
        const errorText = payload?.error
          ?? (Array.isArray(payload?.errors) && payload.errors.length > 0 ? payload.errors.join("; ").slice(0, 2000) : null);
        resolve(failure("scheduler_failed", String(errorText ?? `exit code ${code}`), {
          command,
          exit_code: code,
          payload: payload
            ? {
                status: payload.status ?? null,
                error: payload.error ?? null,
                errors: Array.isArray(payload.errors) ? payload.errors.slice(0, 20) : null,
                warnings: Array.isArray(payload.warnings) ? payload.warnings.slice(0, 20) : null,
              }
            : null,
          stderr: stderr.trim().slice(0, 2000),
        }));
        return;
      }
      resolve({ ok: true, payload });
    });
  });
}

function readDriverRecord(runDir) {
  try {
    return JSON.parse(readFileSync(path.join(runDir, "driver.json"), "utf8"));
  } catch {
    return null;
  }
}

function readDriverStatus(projectRoot, statePath) {
  const stateDir = path.isAbsolute(String(statePath ?? ""))
    ? path.dirname(String(statePath))
    : path.join(projectRoot, path.dirname(String(statePath ?? "")));
  return readDriverRecord(stateDir);
}

// Keep model-facing receipts small; the scheduler's complete state remains at state_path.
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
    ...(summary.cancellation ? { cancellation: { reason: summary.cancellation.reason ?? null, errors: summary.cancellation.errors ?? [] } } : {}),
  };
}

function compactStatus(payload) {
  return {
    run_id: payload.run_id,
    counts: payload.counts ?? null,
    summary: compactSummary(payload.summary),
    state_path: payload.state_path ?? null,
  };
}

function driverFields(driver) {
  return {
    driver_status: typeof driver?.status === "string" ? driver.status : null,
    driver_error: driver?.error ?? null,
  };
}

// driver 状态文件归调度器所有；面板等外部消费方经此投影取 driver 字段，不自行定位该文件。
// 文件缺失或损坏时两个字段均为 null；fleet_status 返回同一组字段。
export function projectFleetDriver({ stateRoot, runId } = {}) {
  if (!stateRoot || !runId) return driverFields(null);
  return driverFields(readDriverRecord(path.join(path.resolve(String(stateRoot)), String(runId))));
}

export function createFleetCore({
  repoRoot = null,
  runtimeRoot = null,
  projectRoot = null,
  mode = null,
  manifest = null,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = FLEET_COMMAND_TIMEOUT_MS,
} = {}) {
  const root = runtimeRoot
    ? path.resolve(runtimeRoot)
    : repoRoot
      ? path.resolve(repoRoot)
      : resolveFleetRepoRoot({ cwd: projectRoot ?? cwd, env });
  const spawnCwd = path.resolve(projectRoot ?? cwd);
  const scripts = manifest
    ? resolveFleetScripts({ runtimeRoot: root, manifest })
    : { scheduler: null, manifestChecker: null };
  // 消费模式只认已声明入口；开发模式才回落到运行包里的源码脚本与 dist 制品。
  const scheduler = scripts.scheduler
    ?? (manifest ? null : resolveRuntimeScript({
      runtimeRoot: root,
      name: FLEET_SCHEDULER_NAME,
      defaults: ["ops/dist/fleet_scheduler.bundle.mjs", "ops/tools/fleet_scheduler.mjs"],
    }));
  const manifestChecker = scripts.manifestChecker
    ?? (manifest ? null : resolveRuntimeScript({
      runtimeRoot: root,
      name: FLEET_MANIFEST_CHECK_NAME,
      defaults: ["ops/dist/fleet_manifest_check.bundle.mjs", "ops/tools/fleet_manifest_check.mjs"],
    }));
  const spawnEnv = {
    ...env,
    [SUBAGENT_PROJECT_ROOT_ENV]: spawnCwd,
    [SUBAGENT_RUNTIME_ROOT_ENV]: root,
    // The scheduler's dispatch_prepare subprocess must share Pi's project registry.
    [SUBAGENT_REGISTRY_ROOT_ENV]: path.join(spawnCwd, ".runtime", "cockpit", "async-registry"),
  };
  const interpreter = process.execPath;
  const runTool = (script, args, overrides = {}) => {
    const present = requireScheduler(script);
    if (!present.ok) return Promise.resolve(present);
    return spawnJson(interpreter, [script, ...args], {
      cwd: spawnCwd,
      env: spawnEnv,
      timeoutMs,
      ...overrides,
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
      ...(run_id ? ["--run-id", String(run_id)] : []),
      "--format",
      "json",
    ]);
    if (!launched.ok) return launched;
    const statePath = String(launched.payload.state_path ?? "");
    return {
      ok: true,
      run_id: String(launched.payload.run_id ?? run_id ?? ""),
      state_root: path.posix.dirname(path.posix.dirname(statePath)),
      node_count: Array.isArray(checked.payload.nodes) ? checked.payload.nodes.length : 0,
      state_path: statePath,
      driver_pid: launched.payload.pid ?? null,
      driver_log_path: launched.payload.log_path ?? null,
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
        { timeoutMs: remaining + FLEET_COMMAND_TIMEOUT_MS },
      );
      if (!waited.ok) return waited;
      event = String(waited.payload.event ?? "");
      driver = readDriverStatus(spawnCwd, statePath);
      // 没有在跑的异步任务(纯 command 段)时无通知可等:进入 driver.json 轮询窗,每 500ms 读一次
      // 文件,窗口期满(5s)才重新 spawn 一次 wait 探 active 任务是否恢复——调度器进程从每轮一个
      // 降为每 5s 一个,异步任务恢复后 notice 等待最多迟一个窗口。
      if (event === "no_active_tasks" && !SETTLED_DRIVER_STATES.has(String(driver?.status ?? ""))) {
        const reprobeAt = Date.now() + NO_ACTIVE_REPROBE_MS;
        while (
          Date.now() < reprobeAt &&
          Date.now() < deadline &&
          !SETTLED_DRIVER_STATES.has(String(driver?.status ?? ""))
        ) {
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
      state_path: statePath,
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
      "json",
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

  // 冻结接口：run级协作暂停/恢复，只走调度器控制面，不新增公开模型工具。
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
