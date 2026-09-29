// 控制仓真源与运行槽同步。
//
// 生产真源：<home>/.pi/agent/extensions/subagent-control/deployment.json 的 source.source_root。
// 浏览器开发模式（options.browser === true）：启动控制仓 options.controlRoot。监控工程不是入参，不能改真源。
// 受管文件以控制仓现有文件为准：ops/model-notes.toml、ops/templates/worker-resources.json、ops/agents/*.toml。
// 运行槽：releases/subagent 下含 ops/model-notes.toml 的正式目录（跳过点号开头）、Pi 扩展槽、
// consumer/current.json 的 runtime_root。同物理路径只保留第一次出现的槽。
// status() 每次按 SHA-256 重算，不记待同步队列，不重放旧文本。槽失败不改真源。
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PanelError } from "./async-core.mjs";

export const SYNC_STATUS_REASONS = Object.freeze(["differs", "missing", "unreadable"]);

const MODEL_NOTES_FILE = "ops/model-notes.toml";
const WORKER_RESOURCES_FILE = "ops/templates/worker-resources.json";
const AGENTS_PREFIX = "ops/agents/";
const PI_EXTENSION_SEGMENTS = Object.freeze([".pi", "agent", "extensions", "subagent-control"]);
const SUBAGENT_RELEASE_SEGMENTS = Object.freeze([".subagent-control", "releases", "subagent"]);
const CONSUMER_CURRENT_SEGMENTS = Object.freeze([".subagent-control", "releases", "consumer", "current.json"]);
const READ_FAILURE_CODES = new Set(["EACCES", "EPERM", "EISDIR", "ENOTDIR", "EIO", "EBUSY", "EINVAL", "ELOOP"]);
const WRITE_FAILURE_CODES = new Set([
  ...READ_FAILURE_CODES,
  "ENOENT",
  "ENOSPC",
  "EEXIST",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "EBADF",
  "ENOTEMPTY",
]);

export class ConfigSyncError extends PanelError {
  constructor(code, message, options = {}) {
    super(code, message, {
      status: options.status ?? 503,
      scope: "local",
      details: options.details ?? null,
    });
    this.name = "ConfigSyncError";
  }
}

function fail(code, message, status, details = null) {
  throw new ConfigSyncError(code, message, { status, details });
}

function samePath(left, right) {
  const a = path.resolve(String(left));
  const b = path.resolve(String(right));
  return process.platform === "win32"
    ? a.toLocaleLowerCase("en-US") === b.toLocaleLowerCase("en-US")
    : a === b;
}

function isInside(root, target) {
  const base = path.resolve(root);
  const abs = path.resolve(target);
  if (samePath(base, abs)) return true;
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return process.platform === "win32"
    ? abs.toLocaleLowerCase("en-US").startsWith(prefix.toLocaleLowerCase("en-US"))
    : abs.startsWith(prefix);
}

function toAbsolute(root, relative) {
  return path.join(path.resolve(root), ...relative.split("/"));
}

function inspectPath(target) {
  let stats;
  try {
    stats = statSync(target, { throwIfNoEntry: false });
  } catch (error) {
    if (READ_FAILURE_CODES.has(error?.code)) return { kind: "unreadable", code: error.code };
    throw error;
  }
  if (!stats) return { kind: "missing" };
  if (stats.isFile()) return { kind: "file" };
  if (stats.isDirectory()) return { kind: "directory" };
  return { kind: "other" };
}

function readBytes(target) {
  const inspected = inspectPath(target);
  if (inspected.kind === "missing") return { state: "missing" };
  if (inspected.kind !== "file") return { state: "unreadable" };
  try {
    return { state: "ok", bytes: readFileSync(target) };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing" };
    if (READ_FAILURE_CODES.has(error?.code)) return { state: "unreadable" };
    throw error;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileRank(file) {
  if (file === MODEL_NOTES_FILE) return 0;
  if (file === WORKER_RESOURCES_FILE) return 1;
  return 2;
}

function compareFiles(left, right) {
  const rank = fileRank(left) - fileRank(right);
  if (rank !== 0) return rank;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function slotKey(slot) {
  const resolved = path.resolve(slot);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function compareStatus(left, right) {
  const slotOrder = slotKey(left.slot) < slotKey(right.slot) ? -1 : slotKey(left.slot) > slotKey(right.slot) ? 1 : 0;
  if (slotOrder !== 0) return slotOrder;
  return compareFiles(left.file, right.file);
}

function normalizeRelative(input) {
  if (typeof input !== "string" || !input.trim()) {
    fail("SYNC_FILES_INVALID", "同步文件路径无效", 400);
  }
  const posix = input.replaceAll("\\", "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    fail("SYNC_FILES_INVALID", "同步文件必须是受管相对路径", 400, { file: input });
  }
  const parts = posix.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail("SYNC_FILES_INVALID", "同步文件路径越界", 400, { file: input });
  }
  return parts.join("/");
}

function identityOf(slotPath) {
  const resolved = path.resolve(slotPath);
  try {
    return path.resolve(realpathSync(resolved));
  } catch (error) {
    if (error?.code === "ENOENT") return resolved;
    if (READ_FAILURE_CODES.has(error?.code)) {
      fail("SYNC_SLOTS_UNREADABLE", "运行槽路径不可读", 503, { path: resolved });
    }
    throw error;
  }
}

function dedupeSlots(slots, controlRoot) {
  const seen = [];
  const unique = [];
  for (const slot of slots) {
    const resolved = path.resolve(slot);
    if (controlRoot && isInside(controlRoot, resolved)) continue;
    const key = identityOf(resolved);
    const folded = process.platform === "win32" ? key.toLocaleLowerCase("en-US") : key;
    if (seen.includes(folded)) continue;
    seen.push(folded);
    unique.push(resolved);
  }
  return unique;
}

function requireDirectory(target, code, message) {
  const inspected = inspectPath(target);
  if (inspected.kind === "directory") return path.resolve(target);
  if (inspected.kind === "unreadable") fail(code, message, 503, { path: path.resolve(target) });
  fail(code, message, 503, { path: path.resolve(target) });
}

export function createConfigSync(options = {}) {
  // 测试注入：返回 { fail: "write" | "unreadable" | "missing" } 模拟该操作失败。
  function inject(event) {
    return options.faultInjector?.(event) ?? null;
  }

  function homeDir() {
    return path.resolve(options.homeDir ?? os.homedir());
  }

  function readDeployment(file) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") fail("SYNC_DEPLOYMENT_MISSING", "Pi 扩展槽缺少 deployment.json", 503, { path: file });
      if (READ_FAILURE_CODES.has(error?.code)) {
        fail("SYNC_DEPLOYMENT_UNREADABLE", "Pi 扩展槽 deployment.json 不可读", 503, { path: file });
      }
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) fail("SYNC_DEPLOYMENT_INVALID", "deployment.json 不是合法 JSON", 503, { path: file });
      throw error;
    }
    const sourceRoot = payload?.source?.source_root;
    if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
      fail("SYNC_SOURCE_ROOT_INVALID", "deployment.json 缺少绝对路径 source.source_root", 503, { path: file });
    }
    return requireDirectory(sourceRoot, "SYNC_SOURCE_ROOT_INVALID", "真源目录不可用");
  }

  function resolveSources() {
    if (options.browser === true) {
      if (typeof options.controlRoot !== "string" || !options.controlRoot.trim()) {
        fail("SYNC_LAUNCH_ROOT_INVALID", "浏览器模式缺少启动控制仓", 503);
      }
      const controlRoot = requireDirectory(options.controlRoot, "SYNC_LAUNCH_ROOT_INVALID", "启动控制仓不可用");
      return sourcePaths(controlRoot);
    }
    const deployment = path.join(homeDir(), ...PI_EXTENSION_SEGMENTS, "deployment.json");
    return sourcePaths(readDeployment(deployment));
  }

  function sourcePaths(controlRoot) {
    return { control_root: controlRoot };
  }

  function pushBuildSlots(slots) {
    const releases = path.join(homeDir(), ...SUBAGENT_RELEASE_SEGMENTS);
    let entries;
    try {
      entries = readdirSync(releases, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (READ_FAILURE_CODES.has(error?.code)) fail("SYNC_SLOTS_UNREADABLE", "运行槽目录不可读", 503, { path: releases });
      throw error;
    }
    const names = entries.map((entry) => entry.name).filter((name) => !name.startsWith(".")).sort();
    for (const name of names) {
      const full = path.join(releases, name);
      const inspected = inspectPath(full);
      if (inspected.kind === "missing") continue;
      if (inspected.kind === "unreadable") fail("SYNC_SLOTS_UNREADABLE", "运行槽目录不可读", 503, { path: full });
      if (inspected.kind !== "directory") continue;
      const marker = inspectPath(toAbsolute(full, MODEL_NOTES_FILE));
      if (marker.kind === "unreadable") fail("SYNC_SLOTS_UNREADABLE", "运行槽标记文件不可读", 503, { path: full });
      if (marker.kind === "file") slots.push(full);
    }
  }

  function consumerSlot() {
    const pointer = path.join(homeDir(), ...CONSUMER_CURRENT_SEGMENTS);
    let text;
    try {
      text = readFileSync(pointer, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (READ_FAILURE_CODES.has(error?.code)) fail("SYNC_POINTER_UNREADABLE", "consumer/current.json 不可读", 503, { path: pointer });
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) fail("SYNC_POINTER_INVALID", "consumer/current.json 不是合法 JSON", 503, { path: pointer });
      throw error;
    }
    const runtimeRoot = payload?.runtime_root;
    if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) {
      fail("SYNC_POINTER_INVALID", "consumer/current.json 缺少绝对路径 runtime_root", 503, { path: pointer });
    }
    return path.resolve(runtimeRoot);
  }

  function enumerateSlots(controlRoot) {
    if (options.listSlots) return dedupeSlots(options.listSlots(), controlRoot);
    const slots = [];
    pushBuildSlots(slots);
    const extension = path.join(homeDir(), ...PI_EXTENSION_SEGMENTS);
    const extensionState = inspectPath(extension);
    if (extensionState.kind === "unreadable") fail("SYNC_SLOTS_UNREADABLE", "Pi 扩展槽不可读", 503, { path: extension });
    if (extensionState.kind === "directory") slots.push(extension);
    const consumer = consumerSlot();
    if (consumer) slots.push(consumer);
    return dedupeSlots(slots, controlRoot);
  }

  function listManaged(controlRoot) {
    const files = [];
    for (const relative of [MODEL_NOTES_FILE, WORKER_RESOURCES_FILE]) {
      const inspected = inspectPath(toAbsolute(controlRoot, relative));
      if (inspected.kind === "missing") continue;
      if (inspected.kind !== "file") {
        fail("SYNC_SOURCE_UNREADABLE", "真源受管文件不可读", 503, { file: relative });
      }
      files.push(relative);
    }
    const agentsDir = path.join(controlRoot, "ops", "agents");
    const agentsState = inspectPath(agentsDir);
    if (agentsState.kind === "unreadable" || agentsState.kind === "file" || agentsState.kind === "other") {
      fail("SYNC_SOURCE_UNREADABLE", "真源角色目录不可读", 503, { path: agentsDir });
    }
    if (agentsState.kind === "directory") {
      let names;
      try {
        names = readdirSync(agentsDir);
      } catch (error) {
        if (READ_FAILURE_CODES.has(error?.code)) fail("SYNC_SOURCE_UNREADABLE", "真源角色目录不可读", 503, { path: agentsDir });
        throw error;
      }
      for (const name of names.filter((item) => item.endsWith(".toml") && !item.startsWith(".")).sort()) {
        const relative = `${AGENTS_PREFIX}${name}`;
        const inspected = inspectPath(toAbsolute(controlRoot, relative));
        if (inspected.kind === "missing") continue;
        if (inspected.kind === "unreadable") fail("SYNC_SOURCE_UNREADABLE", "真源角色卡不可读", 503, { file: relative });
        if (inspected.kind === "file") files.push(relative);
      }
    }
    return files;
  }

  function readSource(controlRoot, file) {
    const sourcePath = toAbsolute(controlRoot, file);
    const injected = inject({ op: "read-source", slot: null, file, sourcePath, destPath: null });
    if (injected?.fail === "missing") return { state: "missing" };
    if (injected?.fail === "unreadable") fail("SYNC_SOURCE_UNREADABLE", "真源文件不可读", 503, { file });
    const read = readBytes(sourcePath);
    if (read.state === "unreadable") fail("SYNC_SOURCE_UNREADABLE", "真源文件不可读", 503, { file });
    return read;
  }

  function currentBytes(controlRoot, files) {
    const bytes = new Map();
    for (const file of files) {
      const read = readSource(controlRoot, file);
      if (read.state === "missing") continue;
      bytes.set(file, read.bytes);
    }
    return bytes;
  }

  function readSlot(slot, file) {
    const destPath = toAbsolute(slot, file);
    const injected = inject({
      op: "read-slot",
      slot,
      file,
      sourcePath: null,
      destPath,
    });
    if (injected?.fail === "missing") return { state: "missing" };
    if (injected?.fail === "unreadable") return { state: "unreadable" };
    return readBytes(destPath);
  }

  function measure(controlRoot, files, slots) {
    const bytes = currentBytes(controlRoot, files);
    const items = [];
    for (const slot of slots) {
      for (const file of bytes.keys()) {
        const read = readSlot(slot, file);
        if (read.state === "missing" || read.state === "unreadable") {
          items.push({ slot, file, reason: read.state });
          continue;
        }
        if (sha256(bytes.get(file)) !== sha256(read.bytes)) items.push({ slot, file, reason: "differs" });
      }
    }
    return items.sort(compareStatus);
  }

  function status() {
    const sources = resolveSources();
    return measure(sources.control_root, listManaged(sources.control_root), enumerateSlots(sources.control_root));
  }

  function cleanupTemp(tempPath) {
    try {
      rmSync(tempPath, { force: true });
    } catch (error) {
      if (error?.code === "ENOENT" || WRITE_FAILURE_CODES.has(error?.code)) return;
      throw error;
    }
  }

  function copyIntoSlot(controlRoot, slot, file, bytes) {
    const sourcePath = toAbsolute(controlRoot, file);
    const destPath = toAbsolute(slot, file);
    if (!isInside(slot, destPath) || isInside(controlRoot, destPath)) {
      fail("SYNC_PATH_ESCAPE", "同步目标越出运行槽", 500, { slot, file });
    }
    const injected = inject({ op: "write-slot", slot, file, sourcePath, destPath });
    if (injected?.fail === "write") return { slot, file, ok: false, reason: "write_failed" };
    if (inspectPath(slot).kind !== "directory") return { slot, file, ok: false, reason: "write_failed" };
    const destDir = path.dirname(destPath);
    try {
      mkdirSync(destDir, { recursive: true });
    } catch (error) {
      if (WRITE_FAILURE_CODES.has(error?.code)) return { slot, file, ok: false, reason: "write_failed" };
      throw error;
    }
    const tempPath = path.join(destDir, `.panel-sync-${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeFileSync(tempPath, bytes);
      renameSync(tempPath, destPath);
      return { slot, file, ok: true, reason: null };
    } catch (error) {
      cleanupTemp(tempPath);
      if (WRITE_FAILURE_CODES.has(error?.code)) return { slot, file, ok: false, reason: "write_failed" };
      throw error;
    }
  }

  function syncFiles(files) {
    const sources = resolveSources();
    const managed = new Set(listManaged(sources.control_root));
    const ordered = [];
    for (const file of files) {
      if (!managed.has(file)) fail("SYNC_FILES_INVALID", "同步文件不在真源受管集合内", 400, { file });
      if (!ordered.includes(file)) ordered.push(file);
    }
    ordered.sort(compareFiles);
    const bytes = currentBytes(sources.control_root, ordered);
    for (const file of ordered) {
      if (!bytes.has(file)) fail("SYNC_SOURCE_UNREADABLE", "真源文件在复制前消失", 503, { file });
    }
    const slots = enumerateSlots(sources.control_root);
    const syncResults = [];
    for (const slot of slots) {
      for (const file of ordered) {
        syncResults.push(copyIntoSlot(sources.control_root, slot, file, bytes.get(file)));
      }
    }
    return {
      sync_results: syncResults,
      sync_status: measure(sources.control_root, listManaged(sources.control_root), enumerateSlots(sources.control_root)),
    };
  }

  function syncWritten(relativeFiles) {
    if (!Array.isArray(relativeFiles)) fail("SYNC_FILES_INVALID", "同步文件列表必须是数组", 400);
    return syncFiles(relativeFiles.map((file) => normalizeRelative(file)));
  }

  function reconcile() {
    const sources = resolveSources();
    const pending = measure(sources.control_root, listManaged(sources.control_root), enumerateSlots(sources.control_root));
    const files = [...new Set(pending.map((item) => item.file))].sort(compareFiles);
    const bytes = currentBytes(sources.control_root, files);
    for (const file of files) {
      if (!bytes.has(file)) fail("SYNC_SOURCE_UNREADABLE", "真源文件在收敛前消失", 503, { file });
    }
    const slots = [];
    for (const item of pending) {
      if (!slots.includes(item.slot)) slots.push(item.slot);
    }
    const syncResults = [];
    for (const slot of slots) {
      for (const file of files) {
        if (!pending.some((item) => item.slot === slot && item.file === file)) continue;
        syncResults.push(copyIntoSlot(sources.control_root, slot, file, bytes.get(file)));
      }
    }
    return {
      sync_results: syncResults,
      sync_status: measure(sources.control_root, listManaged(sources.control_root), enumerateSlots(sources.control_root)),
    };
  }

  return { resolveSources, status, syncWritten, reconcile };
}
