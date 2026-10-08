"use strict";

/**
 * Shell resolution and execution for scheduled commands.
 *
 * Pi's own bash tool resolves the user-configured `shellPath` through
 * SettingsManager and then getShellConfig(); this module applies the same
 * resolution to scheduled commands so Windows (Git Bash) works as real source
 * instead of a patch. Both transport styles are supported:
 *
 * - `argv`  (default): `shell -c <command>` via the host-provided exec function
 * - `stdin` (legacy WSL bash): the command is written to the shell's stdin
 *
 * The Pi SDK is injected, so the module stays importable from plain Node.
 */

const { spawn } = require("node:child_process");

const MAX_CAPTURED_OUTPUT = 60_000;
const DEFAULT_TIMEOUT_MS = 300_000;

function cacheKey({ cwd, agentDir, projectTrusted, override }) {
  return [cwd ?? "", agentDir ?? "", projectTrusted ? "1" : "0", override ?? ""].join("|");
}

/**
 * Resolve the shell configuration for a scheduled command.
 * `override` (a task-level shellPath) wins over the user's settings value.
 */
function resolveShellConfig({
  cwd,
  agentDir,
  projectTrusted = false,
  settingsManagerClass,
  getShellConfig,
  override = null,
  cache = null,
} = {}) {
  if (typeof getShellConfig !== "function") {
    return { ok: false, error: "getShellConfig is not available in this host" };
  }
  const key = cacheKey({ cwd, agentDir, projectTrusted, override });
  if (cache && cache.has(key)) return cache.get(key);

  let shellPath = override ?? null;
  let source = override ? "task" : "auto";
  if (!shellPath && settingsManagerClass && typeof settingsManagerClass.create === "function") {
    try {
      const manager = settingsManagerClass.create(cwd, agentDir, { projectTrusted });
      const configured = manager && typeof manager.getShellPath === "function" ? manager.getShellPath() : null;
      if (configured) {
        shellPath = configured;
        source = "settings";
      }
    } catch (error) {
      const failed = { ok: false, error: `failed to read shellPath from settings: ${error && error.message ? error.message : String(error)}` };
      if (cache) cache.set(key, failed);
      return failed;
    }
  }

  let config;
  try {
    config = getShellConfig(shellPath ?? undefined);
  } catch (error) {
    const failed = { ok: false, error: `failed to resolve shell: ${error && error.message ? error.message : String(error)}` };
    if (cache) cache.set(key, failed);
    return failed;
  }
  const resolved = {
    ok: true,
    shell: config.shell,
    args: Array.isArray(config.args) ? config.args : [],
    commandTransport: config.commandTransport === "stdin" ? "stdin" : "argv",
    shellPath: shellPath ?? config.shell,
    source,
  };
  if (cache) cache.set(key, resolved);
  return resolved;
}

function appendOutput(chunks, chunk) {
  const total = chunks.reduce((sum, item) => sum + item.length, 0);
  if (total >= MAX_CAPTURED_OUTPUT) return;
  chunks.push(chunk.slice(0, MAX_CAPTURED_OUTPUT - total));
}

/**
 * Execute a command through the resolved shell using the host exec function.
 * `exec(command, args, options)` is Pi's `pi.exec`; tests pass a node:child_process
 * based equivalent.
 */
async function executeShellCommand({
  shellConfig,
  command,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  exec,
  env = null,
}) {
  if (!shellConfig || shellConfig.ok !== true) {
    return { ok: false, code: null, killed: false, timedOut: false, stdout: "", stderr: "", error: shellConfig ? shellConfig.error : "shell is not configured" };
  }
  const startedAt = Date.now();
  if (shellConfig.commandTransport === "stdin") {
    const result = await spawnWithStdin({ shellConfig, command, cwd, timeoutMs, env });
    return { ...result, durationMs: Date.now() - startedAt, cwd, shell: shellConfig.shell };
  }
  if (typeof exec !== "function") {
    return { ok: false, code: null, killed: false, timedOut: false, stdout: "", stderr: "", error: "host exec is not available", durationMs: Date.now() - startedAt, cwd, shell: shellConfig.shell };
  }
  try {
    const raw = await exec(shellConfig.shell, [...shellConfig.args, command], {
      cwd,
      timeout: timeoutMs,
      ...(env ? { env } : {}),
    });
    const code = raw && raw.code !== undefined ? raw.code : null;
    const killed = Boolean(raw && raw.killed);
    // Pi 0.99.1 exec reports a timeout kill as { code: 0, killed: true }. killed is the signal.
    return {
      ok: code === 0 && !killed,
      code,
      killed,
      timedOut: killed,
      stdout: String((raw && raw.stdout) ?? ""),
      stderr: String((raw && raw.stderr) ?? ""),
      error: killed ? "command timed out or was killed" : null,
      durationMs: Date.now() - startedAt,
      cwd,
      shell: shellConfig.shell,
    };
  } catch (error) {
    return {
      ok: false,
      code: null,
      killed: false,
      timedOut: false,
      stdout: "",
      stderr: "",
      error: error && error.message ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      cwd,
      shell: shellConfig.shell,
    };
  }
}

/**
 * stdin transport (legacy WSL bash: `bash -s` reads the script from stdin).
 */
function spawnWithStdin({ shellConfig, command, cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let child;
    try {
      child = spawn(shellConfig.shell, shellConfig.args, {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        ...(env ? { env } : {}),
      });
    } catch (error) {
      resolve({ ok: false, code: null, killed: false, timedOut: false, stdout: "", stderr: "", error: error && error.message ? error.message : String(error) });
      return;
    }
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* the process may already be gone */
      }
    }, Math.max(1_000, timeoutMs));
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.on("data", (chunk) => appendOutput(stdoutChunks, String(chunk)));
    child.stderr.on("data", (chunk) => appendOutput(stderrChunks, String(chunk)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, killed: false, timedOut, stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), error: error && error.message ? error.message : String(error) });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const killed = timedOut || Boolean(signal);
      resolve({
        ok: code === 0 && !killed,
        code: code ?? null,
        killed,
        timedOut,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        error: killed && timedOut ? `command timed out after ${timeoutMs}ms` : null,
      });
    });
    try {
      child.stdin.end(`${command}\n`);
    } catch {
      /* the error/close handlers report the failure */
    }
  });
}

module.exports = {
  MAX_CAPTURED_OUTPUT,
  DEFAULT_TIMEOUT_MS,
  resolveShellConfig,
  executeShellCommand,
  spawnWithStdin,
};
