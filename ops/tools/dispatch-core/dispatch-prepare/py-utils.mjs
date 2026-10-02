import { statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { isRecord } from "../_tool_common.mjs";
import { PY_SPACE_CLASS } from "../_py.mjs";

// ---- Python 语义小工具（本模块私有；建议上提的已在回报里登记） ----

const PY_SPLIT_RE = new RegExp(`[${PY_SPACE_CLASS}]+`);

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedStrings(values) {
  return [...values].sort(compareCodePoints);
}

/** Python str[:n]：按码位切片，不是 UTF-16 单元。 */
function pySlice(value, limit) {
  return Array.from(String(value)).slice(0, limit).join("");
}

/** Python `list(x)`：序列取元素，字符串取字符，映射取键，其余空列表。 */
function pyList(value) {
  if (Array.isArray(value)) return [...value];
  if (typeof value === "string") return Array.from(value);
  if (isRecord(value)) return Object.keys(value);
  return [];
}

/** Node 的 fs 系统错误 / Python OSError 的判定。 */
function isSystemError(error) {
  return Boolean(error) && typeof error.code === "string" && (error.errno !== undefined || error.syscall !== undefined);
}

/** Python `except (ToolError, KeyError, ValueError, OSError)` 的 JS 对应判定。 */
function isPyCaughtError(error, names) {
  if (!error) return false;
  if (names.has(String(error.name))) return true;
  return names.has("OSError") && isSystemError(error);
}

function statOrNull(target) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

function isFile(target) {
  return Boolean(statOrNull(target)?.isFile());
}

function isDirectory(target) {
  return Boolean(statOrNull(target)?.isDirectory());
}

/** PurePath.parts 的相对形态；"" 与 "." 段丢弃。 */
function pathParts(value) {
  return String(value ?? "").split(/[\\/]+/).filter((part) => part && part !== ".");
}

/** json.dumps(value, ensure_ascii=False, indent=2)：不排序键。 */
function jsonDumpsIndent2(value) {
  return JSON.stringify(value, null, 2);
}

/** json.dumps(value, ensure_ascii=False, separators=(",", ":")) */
function jsonDumpsCompact(value) {
  return JSON.stringify(value);
}

/** shutil.which()：按 PATH（Windows 上叠加 PATHEXT）查可执行文件。 */
function shutilWhich(name) {
  const candidate = String(name ?? "");
  if (!candidate) return null;
  const isWindows = process.platform === "win32";
  const exts = isWindows
    ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExt = isWindows && exts.some((ext) => candidate.toLowerCase().endsWith(ext.toLowerCase()));
  const names = isWindows && !hasExt ? exts.map((ext) => candidate + ext) : [candidate];
  if (candidate.includes("/") || candidate.includes("\\")) {
    for (const item of names) if (isFile(item)) return item;
    return null;
  }
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (isWindows) dirs.unshift(process.cwd());
  for (const dir of dirs) {
    for (const item of names) {
      const full = path.join(dir, item);
      if (isFile(full)) return full;
    }
  }
  return null;
}

export {
  PY_SPLIT_RE,
  isDirectory,
  isFile,
  isPyCaughtError,
  jsonDumpsCompact,
  jsonDumpsIndent2,
  pathParts,
  pyList,
  pySlice,
  shutilWhich,
  sortedStrings,
};
