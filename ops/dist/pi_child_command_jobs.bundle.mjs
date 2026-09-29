// ops/tools/pi_child_command_jobs.mjs
import * as fs from "node:fs";
import path from "node:path";
import { spawn as spawn2 } from "node:child_process";
import { randomUUID } from "node:crypto";

// ops/tools/pi_child_bash_process_tree.mjs
import * as piChildBashFs from "node:fs";
import * as piChildBashProcess from "node:child_process";
import piChildBashPath from "node:path";
function resolveChildBash(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const exists = options.exists || piChildBashFs.existsSync;
  const spawnSyncFn = options.spawnSyncFn || piChildBashProcess.spawnSync;
  const configured = String(env.PI_CONTROL_BASH_PATH || "").trim();
  if (configured) {
    if (!exists(configured)) throw new Error(`PI_CONTROL_BASH_PATH does not exist: ${configured}`);
    return configured;
  }
  if (platform !== "win32") {
    if (exists("/bin/bash")) return "/bin/bash";
    const found2 = spawnSyncFn("which", ["bash"], { encoding: "utf8", timeout: 5e3, env });
    const candidate2 = String(found2.stdout || "").trim().split(/\r?\n/)[0];
    return candidate2 || "sh";
  }
  const pathApi = piChildBashPath.win32;
  const candidates = [
    env.ProgramFiles ? pathApi.join(env.ProgramFiles, "Git", "bin", "bash.exe") : "",
    env["ProgramFiles(x86)"] ? pathApi.join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe") : ""
  ].filter(Boolean);
  for (const candidate2 of candidates) {
    if (exists(candidate2)) return candidate2;
  }
  const found = spawnSyncFn("where.exe", ["bash.exe"], {
    encoding: "utf8",
    timeout: 5e3,
    windowsHide: true,
    env
  });
  const candidate = String(found.stdout || "").trim().split(/\r?\n/)[0];
  if (candidate && exists(candidate)) return candidate;
  const gitFound = spawnSyncFn("where.exe", ["git.exe"], {
    encoding: "utf8",
    timeout: 5e3,
    windowsHide: true,
    env
  });
  const gitExecutables = String(gitFound.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  for (const gitExecutable of gitExecutables) {
    let ancestor = pathApi.dirname(gitExecutable);
    for (let depth = 0; depth < 4; depth += 1) {
      for (const relative of [["bin", "bash.exe"], ["usr", "bin", "bash.exe"]]) {
        const bashCandidate = pathApi.join(ancestor, ...relative);
        if (exists(bashCandidate)) return bashCandidate;
      }
      const parent = pathApi.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  throw new Error("No Bash executable found for Pi child task");
}
function snapshotChildProcessTree(roots, options = {}) {
  const platform = options.platform || process.platform;
  const run = options.spawnSyncFn || piChildBashProcess.spawnSync;
  const result = platform === "win32" ? run("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 5e3, windowsHide: true }) : run("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 5e3 });
  if (result.status !== 0 || result.error) return null;
  let entries;
  try {
    if (platform === "win32") {
      const data = JSON.parse(String(result.stdout));
      entries = (Array.isArray(data) ? data : [data]).map((item) => [Number(item.ProcessId), Number(item.ParentProcessId)]);
    } else {
      entries = String(result.stdout).trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
    }
  } catch {
    return null;
  }
  const selected = new Set(roots.map(Number));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of entries) {
      if (selected.has(parent) && !selected.has(pid)) {
        selected.add(pid);
        changed = true;
      }
    }
  }
  return entries.filter(([pid]) => selected.has(pid)).map(([pid]) => pid);
}
function terminateChildProcessTree(pid, options = {}) {
  const platform = options.platform || process.platform;
  const spawnSyncFn = options.spawnSyncFn || piChildBashProcess.spawnSync;
  if (!pid) return { requested: false, reason: "missing_pid" };
  const tracked = snapshotChildProcessTree([pid], { platform, spawnSyncFn });
  const observed = Array.isArray(tracked) && tracked.includes(Number(pid));
  options.onCaptured?.({ pid, tracked_pids: tracked, observed, confirmed: false });
  const proof = (exitCode) => {
    const remaining = observed ? snapshotChildProcessTree(tracked, { platform, spawnSyncFn }) : null;
    return { tracked_pids: tracked, observed, remaining_pids: remaining, confirmed: exitCode === 0 && observed && remaining?.length === 0 };
  };
  if (platform === "win32") {
    const result = spawnSyncFn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      timeout: 15e3,
      windowsHide: true
    });
    return {
      requested: true,
      exitCode: result.status ?? null,
      error: result.error?.message || null,
      ...proof(result.status)
    };
  }
  try {
    process.kill(-Number(pid), "SIGKILL");
    return { requested: true, exitCode: 0, error: null, ...proof(0) };
  } catch {
    try {
      process.kill(Number(pid), "SIGKILL");
      return { requested: true, exitCode: 0, error: null, ...proof(0) };
    } catch (error) {
      return { requested: false, reason: "kill_failed", error: error?.message || String(error), ...proof(null) };
    }
  }
}
function waitForChildProcess(child) {
  const EXIT_STDIO_GRACE_MS = 100;
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode = null;
    let postExitTimer;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = void 0;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };
    const finalize = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onExit = (code) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code) => {
      finalize(code);
    };
    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

// ops/tools/pi_child_command_jobs.mjs
var COMMAND_JOBS_VERSION = "pi-command-jobs/v1";
var COMMAND_JOB_TOOL = "command_job";
var COMMAND_JOB_SCHEMA = {
  type: "object",
  required: ["action"],
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["start", "status", "stop"], description: "start\u542F\u52A8\uFF1Bstatus\u67E5\u770B\u4E00\u4E2A\u6216\u5168\u90E8\uFF1Bstop\u505C\u6B62\u6307\u5B9A\u4F5C\u4E1A\u5E76\u786E\u8BA4\u6E05\u7406\u3002" },
    command: { type: "string", description: "start\u5FC5\u586B\u3002\u586B\u5199\u4FDD\u6301\u524D\u53F0\u8FD0\u884C\u7684Bash\u547D\u4EE4\uFF0C\u7531\u672C\u5DE5\u5177\u8D1F\u8D23\u540E\u53F0\u5316\u548C\u4EFB\u52A1\u5185\u6536\u5C3E\u3002" },
    kind: { type: "string", enum: ["command", "service"], description: "\u7701\u7565\u4E3Acommand\uFF1A\u5B89\u88C5\u3001\u6784\u5EFA\u7B49\u7B49\u5F85\u9000\u51FA\u7684\u4F5C\u4E1A\u3002service\u7528\u4E8E\u672C\u4EFB\u52A1\u7684\u4E34\u65F6\u670D\u52A1\uFF1B\u5C31\u7EEA\u7531\u8C03\u7528\u65B9\u68C0\u67E5\uFF0C\u4EA4\u4ED8\u65F6\u6536\u5C3E\u3002" },
    timeout_seconds: { type: "number", exclusiveMinimum: 0, maximum: 2147483647e-3, description: "\u53EF\u9009\u6267\u884C\u671F\u9650\uFF0C\u5355\u4F4D\u79D2\uFF0C\u4F8B\u59821800\u4E3A30\u5206\u949F\uFF1B\u7701\u7565\u4E0D\u8BBE\u547D\u4EE4\u671F\u9650\uFF0C\u4ECD\u53D7\u6240\u5C5E\u4EFB\u52A1\u9884\u7B97\u548C\u53D6\u6D88\u7EA6\u675F\u3002\u4E0E\u524D\u53F0\u7B49\u5F85\u65F6\u95F4\u4E0D\u540C\u3002" },
    job_id: { type: "string", description: "start\u8FD4\u56DE\u7684\u672C\u4EFB\u52A1\u4F5C\u4E1A\u6807\u8BC6\uFF1Bstop\u5FC5\u586B\uFF0Cstatus\u7701\u7565\u65F6\u5206\u9875\u5217\u51FA\u4F5C\u4E1A\u3002" },
    offset: { type: "integer", minimum: 0, description: "status\u5217\u8868\u7684\u8D77\u59CB\u4F4D\u7F6E\uFF0C\u7701\u7565\u4E3A0\uFF0C\u6BCF\u987520\u9879\uFF1B\u67E5\u770B\u5355\u4E2Ajob_id\u65F6\u4E0D\u4F7F\u7528\u3002" }
  }
};
function readCommandJobsState(root) {
  if (!fs.existsSync(root)) return { version: COMMAND_JOBS_VERSION, jobs: [], active_commands: 0, active_services: 0, unsafe_jobs: 0 };
  const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  if (state.version !== COMMAND_JOBS_VERSION || !Array.isArray(state.jobs)) throw new Error("command jobs state unavailable");
  return state;
}
function createCommandJobs({
  root,
  cwd,
  owner,
  waitForExit = waitForChildProcess,
  shell = resolveChildBash(),
  env = process.env,
  spawnFn = spawn2,
  stopTree = terminateChildProcessTree,
  notify = () => {
  }
}) {
  if (typeof waitForExit !== "function") throw new Error("command jobs require the Pi process wait implementation");
  const items = /* @__PURE__ */ new Map();
  let closing = false;
  let shutdownPromise;
  let controlError = null;
  fs.mkdirSync(root, { recursive: true });
  const previous = fs.existsSync(path.join(root, "state.json")) ? readCommandJobsState(root).jobs : [];
  for (const old of previous) {
    const record = { ...old };
    if (["starting", "running", "stopping"].includes(record.status)) {
      record.status = "unknown";
      record.cleanup_confirmed = false;
    }
    items.set(record.job_id, { record, child: null });
  }
  function summary() {
    const jobs = [...items.values()].map(({ record }) => ({ ...record }));
    const active = jobs.filter((r) => ["starting", "running", "stopping"].includes(r.status));
    return {
      version: COMMAND_JOBS_VERSION,
      owner,
      jobs,
      active_commands: active.filter((r) => r.kind === "command").length,
      active_services: active.filter((r) => r.kind === "service").length,
      unsafe_jobs: jobs.filter((r) => r.cleanup_confirmed === false).length,
      ...controlError && { control_error: controlError }
    };
  }
  function persist() {
    const file = path.join(root, "state.json");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(summary()));
    try {
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  function tail(file) {
    if (!fs.existsSync(file)) return "";
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const bytes = Math.min(size, 8192);
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, size - bytes);
      return buf.subarray(0, n).toString("utf8").split("\n").slice(-120).join("\n");
    } finally {
      fs.closeSync(fd);
    }
  }
  function get(jobId) {
    const item = items.get(jobId);
    if (!item) throw new Error("job_id\u672A\u5728\u672C\u4EFB\u52A1\u767B\u8BB0\uFF1B\u4F7F\u7528command_job action=status\u67E5\u770B\u6807\u8BC6\u3002");
    return {
      ...item.record,
      command: item.record.command.slice(0, 1e3),
      command_truncated: item.record.command.length > 1e3,
      stdout_tail: tail(item.record.stdout_path),
      stderr_tail: tail(item.record.stderr_path)
    };
  }
  function finish(item, code, error) {
    const r = item.record;
    clearTimeout(item.timer);
    r.exit_code = code;
    r.signal = item.child?.signalCode ?? null;
    r.finished_at = (/* @__PURE__ */ new Date()).toISOString();
    if (error) r.error = error.message || String(error);
    r.status = r.cleanup_confirmed === false ? "unknown" : r.stop_reason === "deadline" ? "timed_out" : r.stop_reason ? "cancelled" : !error && code === 0 ? "completed" : "failed";
    if (!r.stop_reason) r.cleanup_confirmed = true;
    persist();
    if (!closing && !["requested", "task_complete", "start_failed"].includes(r.stop_reason)) {
      try {
        notify({
          job_id: r.job_id,
          status: r.status,
          exit_code: r.exit_code,
          stop_reason: r.stop_reason,
          stdout_path: r.stdout_path,
          stderr_path: r.stderr_path
        });
      } catch (e) {
        r.notification_error = String(e.message || e);
        persist();
      }
    }
  }
  async function start({ command, kind = "command", timeout_seconds } = {}) {
    if (closing) throw new Error("\u4EFB\u52A1\u6B63\u5728\u6536\u5C3E\uFF1B\u8BF7\u5C06\u672A\u5B8C\u6210\u547D\u4EE4\u4EA4\u56DE\u4E3B\u4EE3\u7406\u3002");
    if (typeof command !== "string" || !command.trim()) throw new Error("start\u9700\u8981\u975E\u7A7Acommand\u3002");
    if (!["command", "service"].includes(kind)) throw new Error("kind\u586B\u5199command\u6216service\u3002");
    if (timeout_seconds !== void 0 && (!Number.isFinite(timeout_seconds) || timeout_seconds <= 0 || timeout_seconds > 2147483647e-3)) {
      throw new Error("timeout_seconds\u987B\u4E3A\u5927\u4E8E0\u7684\u79D2\u6570\uFF0C\u4E14\u4E0D\u8D85\u8FC72147483.647\u3002");
    }
    const job_id = randomUUID();
    const dir = path.join(root, job_id);
    fs.mkdirSync(dir);
    const record = {
      job_id,
      owner,
      kind,
      command,
      cwd,
      status: "starting",
      pid: null,
      started_at: (/* @__PURE__ */ new Date()).toISOString(),
      timeout_seconds: timeout_seconds ?? null,
      stdout_path: path.join(dir, "stdout.log"),
      stderr_path: path.join(dir, "stderr.log"),
      exit_code: null,
      cleanup_confirmed: null
    };
    fs.writeFileSync(record.stdout_path, "");
    fs.writeFileSync(record.stderr_path, "");
    const item = { record, child: null };
    items.set(job_id, item);
    persist();
    try {
      const child = spawnFn(shell, ["-c", command], {
        cwd,
        env: { ...env, PI_COMMAND_JOB_ID: job_id },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      item.child = child;
      record.pid = child.pid ?? null;
      let lastPersist = 0;
      const append = (file, data) => {
        fs.appendFileSync(file, data);
        record.last_output_at = (/* @__PURE__ */ new Date()).toISOString();
        if (Date.now() - lastPersist >= 1e3) {
          persist();
          lastPersist = Date.now();
        }
      };
      child.stdout?.on("data", (d) => append(record.stdout_path, d));
      child.stderr?.on("data", (d) => append(record.stderr_path, d));
      item.done = Promise.resolve(waitForExit(child)).then((code) => finish(item, code), (error) => finish(item, null, error));
      item.done.catch((error) => {
        record.storage_error = String(error.message || error);
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      record.status = "running";
      persist();
      if (timeout_seconds !== void 0) item.timer = setTimeout(() => {
        void stop(job_id, "deadline").catch((error) => {
          record.error = String(error.message || error);
          record.cleanup_confirmed = false;
          persist();
        });
      }, timeout_seconds * 1e3);
      return get(job_id);
    } catch (error) {
      if (item.child?.pid && item.child.exitCode === null) await stop(job_id, "start_failed");
      record.status = "failed";
      record.error = String(error.message || error);
      persist();
      throw error;
    }
  }
  async function stop(jobId, reason = "requested") {
    const item = items.get(jobId);
    if (!item) return get(jobId);
    if (item.stopping) {
      await item.stopping;
      return get(jobId);
    }
    if (!["starting", "running", "stopping", "unknown"].includes(item.record.status)) return get(jobId);
    if (!item.child) throw new Error("\u539F\u6267\u884C\u5DF2\u4E0D\u53D7\u5F53\u524D\u7BA1\u7406\u5668\u6301\u6709\uFF1B\u4FDD\u7559\u8BC1\u636E\uFF0C\u7531\u4E3B\u4EE3\u7406\u6838\u5BF9\u8FDB\u7A0B\uFF0C\u4E0D\u91CD\u653E\u6216\u6309\u5386\u53F2PID\u5F3A\u6740\u3002");
    if (item.child.exitCode !== null || item.child.signalCode) {
      await Promise.race([item.done, new Promise((resolve) => setTimeout(resolve, 250))]);
      if (["starting", "running", "stopping"].includes(item.record.status)) {
        item.record.status = "unknown";
        item.record.cleanup_confirmed = false;
        item.record.error = "\u4E3B\u8FDB\u7A0B\u5DF2\u9000\u51FA\uFF0C\u8F93\u51FA\u6216\u540E\u4EE3\u6536\u5C3E\u672A\u786E\u8BA4\uFF1B\u4FDD\u7559\u73B0\u573A\u7531\u4E3B\u4EE3\u7406\u6838\u5BF9\u3002";
        persist();
      }
      return get(jobId);
    }
    item.stopping = (async () => {
      const r = item.record;
      r.status = "stopping";
      r.stop_reason = reason;
      persist();
      const proof = stopTree(item.child.pid);
      r.cleanup = proof;
      r.cleanup_confirmed = proof.confirmed === true;
      await Promise.race([item.done, new Promise((resolve) => {
        const timer = setTimeout(resolve, 2e3);
        timer.unref?.();
      })]);
      if (item.child.exitCode === null && !item.child.signalCode) {
        r.status = "unknown";
        r.cleanup_confirmed = false;
      }
      persist();
    })();
    await item.stopping;
    return get(jobId);
  }
  async function stopServices() {
    for (const item of items.values()) if (item.record.kind === "service" && ["running", "starting", "stopping"].includes(item.record.status)) {
      await stop(item.record.job_id, "task_complete");
    }
  }
  function shutdown() {
    closing = true;
    return shutdownPromise ??= (async () => {
      const errors = [];
      for (const item of items.values()) if (["running", "starting", "stopping", "unknown"].includes(item.record.status)) {
        try {
          await stop(item.record.job_id, "task_shutdown");
        } catch (e) {
          errors.push(String(e.message || e));
        }
      }
      persist();
      return { ...summary(), errors };
    })();
  }
  function recordControlError(error) {
    controlError = { message: String(error.message || error), code: error.code ?? null, at: (/* @__PURE__ */ new Date()).toISOString() };
    persist();
  }
  persist();
  return { start, get, stop, stopServices, shutdown, summary, recordControlError };
}
function installCommandJobs(pi, { jobs, controlFile, attemptId } = {}) {
  pi.registerTool({
    name: COMMAND_JOB_TOOL,
    label: "\u540E\u53F0\u547D\u4EE4",
    description: "\u5728\u672C\u4EFB\u52A1\u5185\u542F\u52A8\u3001\u67E5\u770B\u6216\u505C\u6B62\u53D7\u7BA1\u7406\u7684\u540E\u53F0Bash\u4F5C\u4E1A\u3002\u7528\u4E8E\u957F\u5B89\u88C5\u3001\u6784\u5EFA\u548C\u4E34\u65F6\u670D\u52A1\u3002start\u7ACB\u5373\u8FD4\u56DEjob_id\uFF0C\u547D\u4EE4\u7ED3\u675F\u81EA\u52A8\u901A\u77E5\uFF1B\u9759\u9ED8\u4E0D\u81EA\u52A8\u7EC8\u6B62\u3002status\u8FD4\u56DE\u6709\u754C\u65E5\u5FD7\u5C3E\u90E8\u53CA\u5B8C\u6574\u65E5\u5FD7\u8DEF\u5F84\u3002\u6CBF\u7528\u672C\u4EFB\u52A1\u547D\u4EE4/\u5199\u5165/\u7F51\u7EDC\u6388\u6743\uFF0C\u4E0D\u662F\u989D\u5916\u6C99\u7BB1\u3002",
    promptSnippet: "\u7BA1\u7406\u957F\u547D\u4EE4\u4E0E\u4EFB\u52A1\u5185\u4E34\u65F6\u670D\u52A1",
    parameters: COMMAND_JOB_SCHEMA,
    async execute(_id, args, signal) {
      if (signal?.aborted) throw new Error("\u8C03\u7528\u5DF2\u53D6\u6D88\uFF0C\u672A\u542F\u52A8\u65B0\u4F5C\u4E1A\u3002");
      const { action, job_id } = args;
      let value;
      if (action === "start") value = await jobs.start(args);
      else if (action === "status") {
        if (job_id) value = jobs.get(job_id);
        else {
          const state = jobs.summary();
          const offset = args.offset ?? 0;
          value = {
            ...state,
            total_jobs: state.jobs.length,
            offset,
            next_offset: offset + 20 < state.jobs.length ? offset + 20 : null,
            jobs: state.jobs.slice(offset, offset + 20).map(({ job_id: job_id2, kind, status, pid, exit_code, cleanup_confirmed }) => ({ job_id: job_id2, kind, status, pid, exit_code, cleanup_confirmed }))
          };
        }
      } else if (action === "stop") {
        if (!job_id) throw new Error("stop\u9700\u8981job_id\uFF1B\u5148\u7528status\u67E5\u770B\u3002");
        value = await jobs.stop(job_id);
      } else throw new Error("action\u586B\u5199start\u3001status\u6216stop\u3002");
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
    }
  });
  pi.on("tool_call", async (event) => {
    if (!["submit_task_result", "submit_review_result"].includes(event.toolName)) return;
    if (jobs.summary().active_commands > 0) return { block: true, reason: "\u540E\u53F0\u547D\u4EE4\u5C1A\u672A\u6536\u5C3E\u3002\u7528command_job status\u67E5\u770B\uFF0C\u5B8C\u6210\u6D88\u606F\u4F1A\u81EA\u52A8\u63A5\u7EED\uFF1B\u5148\u5B8C\u6210\u5176\u4ED6\u4E0D\u51B2\u7A81\u5DE5\u4F5C\uFF0C\u6216\u7ED3\u675F\u5F53\u524D\u56DE\u5408\u7B49\u5F85\u3002\u9700\u8981\u653E\u5F03\u8BE5\u547D\u4EE4\u65F6\u7528stop\u3002" };
    await jobs.stopServices();
  });
  pi.on("tool_result", (event) => {
    if (!["submit_task_result", "submit_review_result"].includes(event.toolName) || jobs.summary().unsafe_jobs === 0) return;
    return { content: [...event.content, { type: "text", text: "\u540E\u53F0\u4F5C\u4E1A\u6E05\u7406\u6709\u672A\u786E\u8BA4\u9879\uFF1B\u5DF2\u6709\u6210\u679C\u53EF\u4EE5\u4EA4\u4ED8\uFF0C\u8D44\u6E90\u5360\u6709\u4ECD\u4FDD\u7559\uFF0C\u7531\u4E3B\u4EE3\u7406\u7EE7\u7EED\u6838\u5BF9\u3002" }] };
  });
  let timer;
  if (controlFile) {
    timer = setInterval(() => {
      try {
        const request = JSON.parse(fs.readFileSync(controlFile, "utf8"));
        if (request.type === "abort" && request.attempt_id === attemptId) {
          clearInterval(timer);
          void jobs.shutdown();
        }
      } catch (e) {
        if (e.code === "ENOENT") return;
        try {
          jobs.recordControlError(e);
        } catch {
        }
      }
    }, 250);
    timer.unref?.();
  }
  pi.on("session_shutdown", async () => {
    clearInterval(timer);
    await jobs.shutdown();
  });
}
function commandJobsExtension(pi) {
  const config = JSON.parse(process.env.PI_COMMAND_JOBS_CONFIG || "null");
  if (!config) return;
  pi.on("session_start", () => {
    const jobs = createCommandJobs({
      ...config,
      waitForExit: waitForChildProcess,
      notify: (record) => pi.sendMessage(
        {
          customType: "command-job-result",
          content: "\u540E\u53F0\u4F5C\u4E1A\u7ED3\u675F\uFF1A" + JSON.stringify(record) + "\u3002\u672A\u67E5\u9A8C\u65F6\u67E5\u770B\u65E5\u5FD7\u5E76\u9A8C\u8BC1\u4EA7\u7269\uFF1B\u5DF2\u67E5\u9A8C\u5E76\u4EA4\u4ED8\u65F6\u590D\u7528\u5DF2\u6709\u7ED3\u8BBA\uFF0C\u65E0\u9700\u91CD\u590D\u63D0\u4EA4\u3002",
          display: true
        },
        { deliverAs: "followUp", triggerTurn: true }
      )
    });
    installCommandJobs(pi, { jobs, controlFile: config.controlFile, attemptId: config.attemptId });
  });
}
export {
  COMMAND_JOBS_VERSION,
  COMMAND_JOB_SCHEMA,
  COMMAND_JOB_TOOL,
  createCommandJobs,
  commandJobsExtension as default,
  installCommandJobs,
  readCommandJobsState
};
