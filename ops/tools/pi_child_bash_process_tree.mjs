// 下列函数经 toString() 拼进 child 扩展文件；node 内置模块统一用独特命名空间引用，
// 打包器只在重名时改名，独特名字保证生成文件头部的 import 与函数体一致。
import * as piChildBashFs from "node:fs";
import * as piChildBashProcess from "node:child_process";
import piChildBashPath from "node:path";
import { pathToFileURL } from "node:url";

export const PI_CHILD_BASH_PROCESS_TREE_PROFILE = "pi-child-bash-process-tree/v1";
export const PI_CHILD_BASH_DEFAULT_TIMEOUT_SECONDS = 120;
export const PI_CHILD_BASH_MAX_TIMEOUT_SECONDS = 600;
export const PI_CHILD_BASH_DEFAULT_SCRATCH = "C:\\tmp\\agent-scratch";

export function childBashSpawnEnv(baseEnv, platform = process.platform) {
  const env = { ...(baseEnv || {}) };
  if (platform !== "win32") return env;
  const scratch = String(env.PI_CONTROL_BASH_SCRATCH || "").trim() || PI_CHILD_BASH_DEFAULT_SCRATCH;
  env.TMP = scratch;
  env.TEMP = scratch;
  env.TMPDIR = scratch;
  return env;
}

export function resolveChildBashTimeout(value) {
  const seconds = value ?? PI_CHILD_BASH_DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > PI_CHILD_BASH_MAX_TIMEOUT_SECONDS) {
    throw new Error(`Invalid timeout: 子代理Bash前台timeout单位为秒，须大于0且不超过${PI_CHILD_BASH_MAX_TIMEOUT_SECONDS}；检查秒/毫秒，长任务改走后台。命令未启动。`);
  }
  return seconds;
}

export function resolveChildBash(options = {}) {
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
    const found = spawnSyncFn("which", ["bash"], { encoding: "utf8", timeout: 5000, env });
    const candidate = String(found.stdout || "").trim().split(/\r?\n/)[0];
    return candidate || "sh";
  }
  const pathApi = piChildBashPath.win32;
  const candidates = [
    env.ProgramFiles ? pathApi.join(env.ProgramFiles, "Git", "bin", "bash.exe") : "",
    env["ProgramFiles(x86)"] ? pathApi.join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe") : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  const found = spawnSyncFn("where.exe", ["bash.exe"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    env,
  });
  const candidate = String(found.stdout || "").trim().split(/\r?\n/)[0];
  if (candidate && exists(candidate)) return candidate;

  // Git itself is commonly on PATH through <root>\\cmd while Bash lives in
  // <root>\\bin or <root>\\usr\\bin. Derive only from discovered git.exe
  // ancestors, avoiding an unbounded drive scan.
  const gitFound = spawnSyncFn("where.exe", ["git.exe"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    env,
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

export function snapshotChildProcessTree(roots, options = {}) {
  const platform = options.platform || process.platform;
  const run = options.spawnSyncFn || piChildBashProcess.spawnSync;
  const result = platform === "win32"
    ? run("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 5000, windowsHide: true })
    : run("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0 || result.error) return null;
  let entries;
  try {
    if (platform === "win32") {
      const data = JSON.parse(String(result.stdout));
      entries = (Array.isArray(data) ? data : [data]).map((item) => [Number(item.ProcessId), Number(item.ParentProcessId)]);
    } else {
      entries = String(result.stdout).trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
    }
  } catch { return null; }
  const selected = new Set(roots.map(Number));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of entries) {
      if (selected.has(parent) && !selected.has(pid)) { selected.add(pid); changed = true; }
    }
  }
  return entries.filter(([pid]) => selected.has(pid)).map(([pid]) => pid);
}

export function terminateChildProcessTree(pid, options = {}) {
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
      timeout: 15000,
      windowsHide: true,
    });
    return {
      requested: true,
      exitCode: result.status ?? null,
      error: result.error?.message || null,
      ...proof(result.status),
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

/**
 * Wait for a child to terminate without hanging on inherited stdio handles.
 * After `exit`, keep reading while stdout/stderr still produce data (idle timer
 * re-arms on every chunk). A quiet inherited pipe is released after the idle
 * grace so we neither truncate an active tail nor wait forever.
 */
export function waitForChildProcess(child) {
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
        postExitTimer = undefined;
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

export function createTreeSafeBashOperations(options = {}) {
  const platform = options.platform || process.platform;
  const spawnFn = options.spawnFn || piChildBashProcess.spawn;
  const terminateTree = options.terminateTree || ((pid, onCaptured) => terminateChildProcessTree(pid, { platform, onCaptured }));
  const shell = options.shell || resolveChildBash({ ...options, platform });
  const normalizedShell = shell.replace(/\//g, "\\").toLowerCase();
  const commandFromStdin = platform === "win32" && /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalizedShell);

  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error("aborted");
      timeout = resolveChildBashTimeout(timeout);
      const spawnEnv = childBashSpawnEnv(env, platform);
      if (platform === "win32" && spawnEnv.TEMP) piChildBashFs.mkdirSync(spawnEnv.TEMP, { recursive: true });
      const child = spawnFn(shell, commandFromStdin ? ["-s"] : ["-c", command], {
        cwd,
        detached: platform !== "win32",
        env: spawnEnv,
        stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      if (commandFromStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(command);
      }
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      // Drain stdio after exit; do not resolve on the exit event alone.
      const exitPromise = waitForChildProcess(child).then((code) => ({ type: "exit", exitCode: code }));
      let timeoutHandle;
      let abortHandler;
      const timeoutPromise = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ type: "timeout" }), timeout * 1000);
      });
      const abortPromise = !signal
        ? new Promise(() => {})
        : new Promise((resolve) => {
            abortHandler = () => resolve({ type: "abort" });
            signal.addEventListener("abort", abortHandler, { once: true });
          });

      try {
        const outcome = await Promise.race([exitPromise, timeoutPromise, abortPromise]);
        if (outcome.type === "exit") return { exitCode: outcome.exitCode };
        const termination = terminateTree(child.pid, (record) => options.onCleanup?.(record));
        const stopped = await Promise.race([
          exitPromise.catch(() => ({ type: "exit", exitCode: null })),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
        const remaining = termination?.observed && !termination.confirmed && stopped?.type === "exit"
          ? snapshotChildProcessTree(termination.tracked_pids, { platform }) : termination?.remaining_pids;
        options.onCleanup?.({ ...termination, pid: child.pid, remaining_pids: remaining,
          confirmed: termination?.exitCode === 0 && termination?.observed === true && remaining?.length === 0 && stopped?.type === "exit" });
        const detail = termination?.error || (termination?.exitCode && `taskkill exit ${termination.exitCode}`) || "";
        throw new Error(`${outcome.type === "abort" ? "aborted" : `timeout:${timeout}`}${detail ? ` (${detail})` : ""}`);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      }
    },
  };
}

export function resolvePiChildBashToolModule(piCli, options = {}) {
  const exists = options.exists || piChildBashFs.existsSync;
  const modulePath = piChildBashPath.join(piChildBashPath.dirname(piChildBashPath.resolve(String(piCli || ""))), "core", "tools", "bash.js");
  if (!exists(modulePath)) {
    throw new Error(`Pi Bash tool module does not exist beside CLI: ${modulePath}`);
  }
  return pathToFileURL(modulePath).href;
}

async function installPiChildBashProcessTreeWithModule(pi, moduleSpecifier, shell, cleanupPath) {
  const { createBashTool } = await import(moduleSpecifier);
  pi.on("session_start", (_event, ctx) => {
    const original = createBashTool(ctx.cwd);
    pi.registerTool({
      ...original,
      parameters: {
        ...original.parameters,
        properties: {
          ...original.parameters.properties,
          timeout: { ...original.parameters.properties.timeout,
            description: `前台超时，单位秒（例如60为1分钟、120为2分钟）；省略为${PI_CHILD_BASH_DEFAULT_TIMEOUT_SECONDS}秒，最长${PI_CHILD_BASH_MAX_TIMEOUT_SECONDS}秒。长任务改走后台。`,
            exclusiveMinimum: 0, maximum: PI_CHILD_BASH_MAX_TIMEOUT_SECONDS,
          },
        },
      },
      execute(toolCallId, ...args) {
        const tool = createBashTool(ctx.cwd, { operations: createTreeSafeBashOperations({
          ...(shell ? { shell } : {}),
          onCleanup: cleanupPath ? (record) => piChildBashFs.appendFileSync(cleanupPath, JSON.stringify({ ...record, tool_call_id: toolCallId }) + "\n", "utf8") : undefined,
        }) });
        return tool.execute(toolCallId, ...args);
      },
    });
  });
}

export function renderPiChildBashProcessTreeSource({ bashToolModuleUrl, bashExecutable, cleanupPath = null } = {}) {
  const moduleSpecifier = String(bashToolModuleUrl || "").trim();
  const shell = String(bashExecutable || "").trim();
  if (!moduleSpecifier.startsWith("file:")) {
    throw new Error("Pi child Bash extension requires an absolute Bash tool module file URL");
  }
  if (!shell) {
    throw new Error("Pi child Bash extension requires a runner-resolved Bash executable");
  }
  return [
    'import * as piChildBashFs from "node:fs";',
    'import * as piChildBashProcess from "node:child_process";',
    'import piChildBashPath from "node:path";',
    `const PI_CHILD_BASH_DEFAULT_TIMEOUT_SECONDS = ${PI_CHILD_BASH_DEFAULT_TIMEOUT_SECONDS};`,
    `const PI_CHILD_BASH_MAX_TIMEOUT_SECONDS = ${PI_CHILD_BASH_MAX_TIMEOUT_SECONDS};`,
    `const PI_CHILD_BASH_DEFAULT_SCRATCH = ${JSON.stringify(PI_CHILD_BASH_DEFAULT_SCRATCH)};`,
    `const childBashSpawnEnv = ${childBashSpawnEnv.toString()};`,
    `const resolveChildBashTimeout = ${resolveChildBashTimeout.toString()};`,
    `const resolveChildBash = ${resolveChildBash.toString()};`,
    `const snapshotChildProcessTree = ${snapshotChildProcessTree.toString()};`,
    `const terminateChildProcessTree = ${terminateChildProcessTree.toString()};`,
    `const waitForChildProcess = ${waitForChildProcess.toString()};`,
    `const createTreeSafeBashOperations = ${createTreeSafeBashOperations.toString()};`,
    `const installPiChildBashProcessTreeWithModule = ${installPiChildBashProcessTreeWithModule.toString()};`,
    `const installPiChildBashProcessTree = (pi) => installPiChildBashProcessTreeWithModule(pi, ${JSON.stringify(moduleSpecifier)}, ${JSON.stringify(shell)}, ${JSON.stringify(cleanupPath)});`,
    "export default installPiChildBashProcessTree;",
  ].join("\n");
}
