// fleet_scheduler.mjs 按职责拆出的 locks。只搬移代码，不改行为。
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { ToolError } from "../_tool_common.mjs";
import { tryFileLock } from "../file_lock.mjs";
import { RUN_LOCK_TIMEOUT_SECONDS } from "./constants.mjs";
import { deps } from "./deps.mjs";
import { runLockPath } from "./paths.mjs";
import { pyInt } from "./py-utils.mjs";

/**
 * Serialize state mutation and dispatch for one Fleet run across processes.
 * Python 的 contextmanager 在 JS 里写成回调：runMutationLock(root, runId, fn, { timeoutSeconds })。
 */
export function runMutationLock(root, runId, fn, { timeoutSeconds = RUN_LOCK_TIMEOUT_SECONDS } = {}) {
  const lock = acquireRunLock(root, runId, timeoutSeconds);
  try {
    const result = fn();
    // Preserve synchronous callers, but hold through fulfillment/rejection of async callbacks.
    if (result != null && typeof result.then === "function") {
      return Promise.resolve(result).finally(() => releaseRunLock(lock));
    }
    releaseRunLock(lock);
    return result;
  } catch (error) {
    releaseRunLock(lock);
    throw error;
  }
}

/** Returns an opaque OS-handle token, never a pathname that another owner could replace. */
export function acquireRunLock(root, runId, timeoutSeconds = RUN_LOCK_TIMEOUT_SECONDS) {
  const target = runLockPath(root, runId);
  mkdirSync(path.dirname(target), { recursive: true });
  const deadline = deps.monotonic() + Math.max(0, timeoutSeconds);
  for (;;) {
    const lock = tryFileLock(target);
    if (lock) return lock;
    if (deps.monotonic() >= deadline) throw new ToolError(`fleet run mutation lock busy: ${runId}`);
    deps.sleep(0.05);
  }
}

/** Async acquisition must yield so another launch in this process can finish and release. */
export async function acquireRunLockAsync(root, runId, timeoutSeconds = RUN_LOCK_TIMEOUT_SECONDS) {
  const target = runLockPath(root, runId);
  mkdirSync(path.dirname(target), { recursive: true });
  const deadline = deps.monotonic() + Math.max(0, timeoutSeconds);
  for (;;) {
    const lock = tryFileLock(target);
    if (lock) return lock;
    if (deps.monotonic() >= deadline) throw new ToolError(`fleet run mutation lock busy: ${runId}`);
    await delay(50);
  }
}

export function releaseRunLock(lock) {
  lock.release();
  return null;
}

export function processAliveImpl(pid) {
  let value;
  try {
    value = pyInt(pid);
  } catch {
    return false;
  }
  if (value <= 0) return false;
  try {
    process.kill(value, 0);
  } catch {
    // Python 的 os.kill 在 PermissionError（OSError 子类）时同样落到 False 分支。
    return false;
  }
  return true;
}

export function processAlive(pid) {
  return deps.processAlive(pid);
}
