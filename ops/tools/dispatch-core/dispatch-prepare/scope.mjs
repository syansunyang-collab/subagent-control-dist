import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  ROOT,
  isAbsoluteLikePython,
  isRecord,
  pathlibJoin,
  resolveLikePython,
} from "../_tool_common.mjs";
import { pyGetItem, pyIsRelativeTo, pyStr, pyStrip, pyTruthy } from "../_py.mjs";
import {
  PREFLIGHT_BINARY_LIKE_EXTENSIONS,
  PREFLIGHT_BYTES_THRESHOLD,
  PREFLIGHT_FILE_THRESHOLD,
  PREFLIGHT_GIT_TIMEOUT_SECONDS,
  PREFLIGHT_LARGE_FILE_BYTES,
  PREFLIGHT_STAT_FILE_CAP,
  PREFLIGHT_WALK_SKIP_DIRS,
  PREFLIGHT_WALK_SKIP_PATHS,
} from "./constants.mjs";
import { deps } from "./deps.mjs";
import { isDirectory, isFile, pathParts, pyList } from "./py-utils.mjs";

// ---- scope 预检 ----

function preflightPathIsSkipped(relative, { directory }) {
  const all = pathParts(relative);
  const parts = directory ? all : all.slice(0, -1);
  if (parts.some((part) => PREFLIGHT_WALK_SKIP_DIRS.has(part))) return true;
  return PREFLIGHT_WALK_SKIP_PATHS.some(
    (prefix) => prefix.length <= all.length && prefix.every((part, index) => all[index] === part),
  );
}

function preflightGitRoot(baseRoot) {
  let completed;
  try {
    completed = spawnSync("git", ["-C", String(baseRoot), "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: PREFLIGHT_GIT_TIMEOUT_SECONDS * 1000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (completed.error) return null;
  const stdout = String(completed.stdout ?? "");
  if (completed.status !== 0 || !pyStrip(stdout)) return null;
  const root = resolveLikePython(pyStrip(stdout));
  return isDirectory(root) ? root : null;
}

function preflightGitFiles(directory, gitRoot) {
  let relative;
  try {
    relative = relativePartsOrThrow(resolveLikePython(directory), resolveLikePython(gitRoot));
  } catch {
    return null;
  }
  const argv = ["-C", String(gitRoot), "ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  if (relative.length) argv.push("--", relative.join("/"));
  let completed;
  try {
    completed = spawnSync("git", argv, {
      timeout: PREFLIGHT_GIT_TIMEOUT_SECONDS * 1000,
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (completed.error) return null;
  if (completed.status !== 0) return null;
  const files = [];
  const raw = Buffer.isBuffer(completed.stdout) ? completed.stdout : Buffer.from(String(completed.stdout ?? ""));
  for (const chunk of raw.toString("utf8").split("\0")) {
    if (!chunk) continue;
    if (preflightPathIsSkipped(chunk, { directory: false })) continue;
    const candidate = path.join(String(gitRoot), chunk);
    try {
      relativePartsOrThrow(resolveLikePython(candidate), resolveLikePython(directory));
    } catch {
      continue;
    }
    if (isFile(candidate)) files.push(candidate);
  }
  return files;
}

/** Path.relative_to()：不在子路径时抛错，用于复刻 Python 的 try/except ValueError 分支。 */
function relativePartsOrThrow(child, parent) {
  if (!pyIsRelativeTo(child, parent)) throw new Error("not relative");
  return pathParts(child).slice(pathParts(parent).length);
}

/** os.walk(top, onerror=...) 的生成器复刻：调用方可就地修改 frame.dirnames 剪枝。 */
function* walkDir(top, onError) {
  const stack = [String(top)];
  while (stack.length) {
    const dirpath = stack.pop();
    let entries;
    try {
      entries = readdirSync(dirpath, { withFileTypes: true });
    } catch (error) {
      if (onError) onError(error, dirpath);
      continue;
    }
    const dirnames = [];
    const filenames = [];
    for (const entry of entries) {
      if (entry.isDirectory()) dirnames.push(entry.name);
      else filenames.push(entry.name);
    }
    const frame = { dirpath, dirnames, filenames };
    yield frame;
    for (let index = frame.dirnames.length - 1; index >= 0; index -= 1) {
      stack.push(path.join(dirpath, frame.dirnames[index]));
    }
  }
}

export function computeScopePreflight(readPaths, { baseRoot = ROOT } = {}) {
  let fileCount = 0;
  let totalBytes = 0;
  let largeFileCount = 0;
  let binaryLikeCount = 0;
  let truncated = false;
  let urlCount = 0;
  const missingPaths = [];
  const unreadablePaths = [];
  const resolvedBaseRoot = resolveLikePython(baseRoot);
  const gitRoot = preflightGitRoot(resolvedBaseRoot);

  const accountFile = (target) => {
    if (fileCount >= PREFLIGHT_STAT_FILE_CAP) {
      truncated = true;
      return false;
    }
    let size;
    try {
      size = statSync(target).size;
    } catch (error) {
      unreadablePaths.push(`${target}: ${error.message}`);
      return true;
    }
    fileCount += 1;
    totalBytes += size;
    if (size > PREFLIGHT_LARGE_FILE_BYTES) largeFileCount += 1;
    if (PREFLIGHT_BINARY_LIKE_EXTENSIONS.has(path.extname(String(target)).toLowerCase())) binaryLikeCount += 1;
    return true;
  };

  const recordWalkError = (error, filename) => {
    unreadablePaths.push(`${filename || baseRoot}: ${error.message}`);
  };

  for (const raw of readPaths) {
    if (truncated) break;
    const lowered = pyStrip(raw).toLowerCase();
    if (lowered.startsWith("http://") || lowered.startsWith("https://")) {
      urlCount += 1;
      continue;
    }
    const candidate = String(raw);
    const resolved = isAbsoluteLikePython(candidate) ? candidate : pathlibJoin(resolvedBaseRoot, candidate);
    let info;
    try {
      info = existsSync(resolved) ? statSync(resolved) : null;
    } catch (error) {
      unreadablePaths.push(`${raw}: ${error.message}`);
      continue;
    }
    if (!info) {
      missingPaths.push(raw);
      continue;
    }
    if (info.isFile()) {
      if (!accountFile(resolved)) break;
      continue;
    }
    if (!info.isDirectory()) {
      unreadablePaths.push(`${raw}: path is neither a regular file nor a directory`);
      continue;
    }
    const gitFiles = gitRoot !== null ? preflightGitFiles(resolved, gitRoot) : null;
    if (gitFiles !== null) {
      for (const item of gitFiles) {
        if (!accountFile(item)) break;
      }
      continue;
    }
    for (const frame of deps.walk(resolved, recordWalkError)) {
      let currentRelative;
      try {
        currentRelative = relativePartsOrThrow(resolveLikePython(frame.dirpath), resolvedBaseRoot).join("/");
      } catch {
        currentRelative = "";
      }
      frame.dirnames = frame.dirnames.filter(
        (name) => !preflightPathIsSkipped(currentRelative ? `${currentRelative}/${name}` : name, { directory: true }),
      );
      let stop = false;
      for (const name of frame.filenames) {
        if (!accountFile(path.join(frame.dirpath, name))) {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }
  }

  const result = {
    scope_file_count: fileCount,
    scope_total_bytes: totalBytes,
    scope_large_file_count: largeFileCount,
    scope_binary_like_count: binaryLikeCount,
    scope_stat_truncated: truncated,
    scope_url_count: urlCount,
    scope_missing_paths: missingPaths,
    scope_unreadable_paths: unreadablePaths,
    scope_preflight_warning: null,
  };
  if (fileCount > PREFLIGHT_FILE_THRESHOLD || totalBytes > PREFLIGHT_BYTES_THRESHOLD) {
    result.scope_preflight_warning = `scope.read 预估 ${fileCount} 个文件、${totalBytes} 字节，超出预警阈值`
      + `（文件 ${PREFLIGHT_FILE_THRESHOLD} / 字节 ${PREFLIGHT_BYTES_THRESHOLD}）；`
      + "建议按 ops/skills/subagent-fleet-discipline/references/parallel-slicing.md 的产能规格拆分";
  }
  return result;
}

export function enforceScopePreflight(scopePreflight) {
  const missing = pyList(pyTruthy(scopePreflight?.scope_missing_paths) ? scopePreflight.scope_missing_paths : []).map(pyStr);
  const unreadable = pyList(pyTruthy(scopePreflight?.scope_unreadable_paths) ? scopePreflight.scope_unreadable_paths : []).map(pyStr);
  return [
    ...(missing.length ? [`scope.read path does not exist: ${missing.join(", ")}`] : []),
    ...(unreadable.length ? [`scope.read path is not readable: ${unreadable.join("; ")}`] : []),
  ];
}

// A7：读作用域分层。read_scope_layers 为可选 seed 字段。entry 必读全文；index 只列目录/清单；
// deep 仅命中 when 才深入（项形如 {"path","when"}）；deferred 默认禁读。scope_preflight 只统计 entry+index。
export function readScopeLayersFromSeed(seed) {
  const layers = seed?.read_scope_layers;
  if (!isRecord(layers)) return null;

  const strings = (key) => pyList(pyTruthy(layers[key]) ? layers[key] : [])
    .filter((item) => typeof item === "string" && pyStrip(item));

  const deep = [];
  for (const item of pyList(pyTruthy(layers.deep) ? layers.deep : [])) {
    if (isRecord(item) && typeof item.path === "string" && pyStrip(item.path)) {
      deep.push({ path: item.path, when: pyStr(pyTruthy(item.when) ? item.when : "") });
    } else if (typeof item === "string" && pyStrip(item)) {
      deep.push({ path: item, when: "" });
    }
  }
  return { entry: strings("entry"), index: strings("index"), deep, deferred: strings("deferred") };
}

export function preflightReadPaths(layers, fallbackRead) {
  if (layers === null || layers === undefined) return [...pyList(fallbackRead)];
  return [...pyGetItem(layers, "entry"), ...pyGetItem(layers, "index")];
}

export function renderReadScopeLayers(layers) {
  const lines = ["分层读取指令（read_scope_layers）："];
  lines.push("- entry：必读全文。");
  for (const item of pyGetItem(layers, "entry")) lines.push(`  - ${item}`);
  lines.push("- index：只列目录/清单，不读文件内容。");
  for (const item of pyGetItem(layers, "index")) lines.push(`  - ${item}`);
  lines.push("- deep：仅命中 when 条件才深入。");
  for (const item of pyGetItem(layers, "deep")) lines.push(`  - ${item.path}（when: ${item.when}）`);
  lines.push("- deferred：默认禁读；读前必须在报告说明理由。");
  for (const item of pyGetItem(layers, "deferred")) lines.push(`  - ${item}`);
  return lines.join("\n");
}

export { walkDir };
