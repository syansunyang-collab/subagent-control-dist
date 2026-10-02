// fleet_scheduler.mjs 按职责拆出的 paths。只搬移代码，不改行为。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pyIsRelativeTo, pyResolveUnder, pyStr, pyStrip } from "../_py.mjs";
import { canonicalJson, clock, resolveLikePython, ROOT, ToolError, utcNow } from "../_tool_common.mjs";
import { DEFAULT_STATE_ROOT, LIVENESS_RECHECK_SECONDS, SAFE_ID_RE } from "./constants.mjs";
import { parseIsoMs, pyStripChars } from "./py-utils.mjs";

// ---- 时间与标识 ----
export function utcAfter(seconds) {
  const now = utcNow();
  const match = /^(.*?)(?:\.(\d{1,6}))?\+00:00$/.exec(now);
  const base = Date.parse(`${match[1]}Z`) + Number(seconds) * 1000;
  const fraction = match[2] ? `.${match[2]}` : "";
  return `${new Date(base).toISOString().slice(0, 19)}${fraction}+00:00`;
}

export function livenessCheckDue(node) {
  const raw = pyStr(node.next_liveness_check_at || "");
  if (!raw) return true;
  const due = parseIsoMs(raw);
  if (due === null) return true;
  return due <= clock.now().getTime();
}

export function deferLivenessCheck(node, seconds = LIVENESS_RECHECK_SECONDS) {
  node.next_liveness_check_at = utcAfter(seconds);
  return null;
}

export function safeId(value) {
  const cleaned = pyStripChars(pyStrip(pyStr(value)).replace(SAFE_ID_RE, "-"), ".-");
  return cleaned || "fleet-run";
}

// ---- 路径与状态文件 ----
export function writeJson(target, data) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${canonicalJson(data)}\n`, "utf8");
  return null;
}

export function requireRepoInternal(target, label) {
  const resolved = resolveLikePython(target);
  const root = resolveLikePython(ROOT);
  if (!pyIsRelativeTo(resolved, root)) {
    throw new ToolError(`${label} must stay under repo root: ${resolved}`);
  }
  return resolved;
}

export function stateRoot(value) {
  const resolved = value
    ? pyResolveUnder(pyStr(value), ROOT)
    : resolveLikePython(DEFAULT_STATE_ROOT);
  return requireRepoInternal(resolved, "state root");
}

export function runDir(root, runId) {
  return path.join(pyStr(root), safeId(runId));
}

export function statePath(root, runId) {
  return path.join(runDir(root, runId), "state.json");
}

export function manifestSnapshotPath(root, runId) {
  return path.join(runDir(root, runId), "manifest.json");
}

export function seedPath(root, runId, nodeIdValue) {
  return path.join(runDir(root, runId), "seeds", `${safeId(nodeIdValue)}.json`);
}

export function dependencyResultIndexPath(root, runId, nodeIdValue) {
  return path.join(runDir(root, runId), "dependency-results", `${safeId(nodeIdValue)}.json`);
}

export function driverStatusPath(root, runId) {
  return path.join(runDir(root, runId), "driver.json");
}

export function driverLogPath(root, runId) {
  return path.join(runDir(root, runId), "driver.log");
}

export function runLockPath(root, runId) {
  return path.join(runDir(root, runId), "scheduler.lock");
}
