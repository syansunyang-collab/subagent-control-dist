// fleet_scheduler.mjs 按职责拆出的 py-utils。只搬移代码，不改行为。
import { statSync } from "node:fs";
import process from "node:process";
import { pyRepr, pyResolveUnder, pyStr, pyStrip } from "../_py.mjs";
import { canonicalValue } from "../_tool_common.mjs";

// ---- Python 语义小工具（本模块私有；建议上提的已在回报里登记） ----

/** time.sleep()：同步阻塞，供 deps 替身覆盖。 */
export function sleepSeconds(seconds) {
  const ms = Math.max(0, Number(seconds) * 1000);
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** time.monotonic()：单位秒的单调时钟。 */
export function monotonicSeconds() {
  return Number(process.hrtime.bigint()) / 1e9;
}

/** int()：bool→0/1，数值向零截断，十进制字符串解析，其余抛 Python 对应异常。 */
export function pyInt(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot convert float infinity to integer");
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = pyStrip(value);
    if (!/^[+-]?\d+$/.test(text)) throw new TypeError(`invalid literal for int() with base 10: ${pyRepr(value)}`);
    return Number.parseInt(text, 10);
  }
  throw new TypeError(`int() argument must be a string or a number, not '${typeof value}'`);
}

/** `value not in (None, "", [])`：Python 的相等语义（0 与 False 都保留）。 */
export function notEmptyPy(value) {
  if (value === null || value === undefined) return false;
  if (value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/** dict 相等：键序无关的深比较。 */
export function pyDictEqual(left, right) {
  return JSON.stringify(canonicalValue(left ?? null)) === JSON.stringify(canonicalValue(right ?? null));
}

/** list(dict.fromkeys(items))：保序去重。 */
export function dedupe(items) {
  return [...new Set(items)];
}

/** datetime.fromisoformat(...) 的毫秒时间戳；不可解析返回 null。 */
export function parseIsoMs(raw) {
  const text = String(raw).replace("Z", "+00:00");
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) return null;
  const hasZone = /(?:[+-]\d{2}:?\d{2})$/.test(text);
  const value = Date.parse(hasZone ? text : `${text}Z`);
  return Number.isFinite(value) ? value : null;
}

export function isDir(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** `Path(value).resolve() if is_absolute else (base / value).resolve()`。 */
export function resolveUnder(value, base) {
  return pyResolveUnder(pyStr(value), base);
}

export function pyStripChars(text, chars) {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** `value not in (None, "")`。 */
export function notEmptyValue(value) {
  return value !== null && value !== undefined && value !== "";
}

export function positiveInt(value, fallback = 0) {
  let parsed;
  try {
    parsed = pyInt(value);
  } catch {
    return fallback;
  }
  return parsed >= 0 ? parsed : fallback;
}

/** Python `not node.get("all_settled_consumers")`：None 与空列表都为假。 */
export function truthyList(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}
