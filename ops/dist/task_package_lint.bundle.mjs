#!/usr/bin/env node

// ops/tools/task_package_lint.mjs
import process4 from "node:process";

// ops/tools/dispatch-core/_tool_common.mjs
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process2 from "node:process";
import { fileURLToPath } from "node:url";

// ops/tools/model_config.mjs
var MODEL_CONFIG_DECLARATION_SEGMENTS = Object.freeze([".pi", "control-plane-model-config.json"]);
var MODEL_CONFIG_ASSETS = Object.freeze({
  agents_dir: Object.freeze({ kind: "dir", relative: Object.freeze(["ops", "agents"]) }),
  model_notes: Object.freeze({ kind: "file", relative: Object.freeze(["ops", "model-notes.toml"]) })
});
var MODEL_CONFIG_ASSET_KEYS = Object.freeze(Object.keys(MODEL_CONFIG_ASSETS));
var MODEL_CONFIG_REQUIRED_KEYS = Object.freeze(["agents_dir", "model_notes"]);

// ops/tools/dispatch-core/_tool_common.mjs
var ToolError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
};
function pyError(type, message) {
  const error = new Error(message);
  error.name = String(type);
  return error;
}
var frozen = null;
function withUuid4Bits(hex32) {
  let raw = BigInt(`0x${hex32}`);
  raw = raw & ~(0xFn << 76n) | 0x4n << 76n;
  raw = raw & ~(0x3n << 62n) | 0x2n << 62n;
  return raw.toString(16).padStart(32, "0");
}
function uuidFromSeed(seed, index) {
  return withUuid4Bits(createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 32));
}
var clock = {
  now() {
    return frozen ? new Date(frozen.nowMs) : /* @__PURE__ */ new Date();
  }
};
var ids = {
  uuidHex() {
    if (frozen) {
      const value = uuidFromSeed(frozen.uuidSeed, frozen.uuidIndex);
      frozen.uuidIndex += 1;
      return value;
    }
    return randomUUID().replace(/-/g, "");
  }
};
function utcDateStamp() {
  const now = clock.now();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
}
function isAbsoluteLikePython(value) {
  const text = String(value ?? "");
  if (process2.platform !== "win32") return text.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(text) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(text);
}
function pathlibJoin(base, other) {
  const text = String(other ?? "");
  if (isAbsoluteLikePython(text)) return text;
  if (process2.platform === "win32" && /^[\\/]/.test(text)) {
    const drive = path.parse(path.resolve(String(base))).root.replace(/[\\/]+$/, "");
    return `${drive}${text}`;
  }
  return path.join(String(base), text);
}
function resolveLikePython(value) {
  const absolute = path.resolve(String(value));
  let current = absolute;
  const tail = [];
  while (true) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}
function repoRoot() {
  const explicit = String(process2.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim();
  if (explicit) {
    if (!isAbsoluteLikePython(explicit)) throw new ToolError("SUBAGENT_CONTROL_REPO_ROOT must be an absolute path");
    const resolved = resolveLikePython(explicit);
    let info = null;
    try {
      info = statSync(resolved);
    } catch {
      info = null;
    }
    if (!info || !info.isDirectory()) throw new ToolError(`SUBAGENT_CONTROL_REPO_ROOT is not a directory: ${explicit}`);
    return resolved;
  }
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (existsSync(path.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  let cur = resolveLikePython(process2.cwd());
  while (true) {
    if (existsSync(path.join(cur, ".git")) || existsSync(path.join(cur, "AGENTS.md")) && existsSync(path.join(cur, "ops"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new ToolError(`cannot locate cockpit repository root from ${resolveLikePython(process2.cwd())}`);
}
function declaredDirectory(envKey) {
  const explicit = String(process2.env[envKey] || "").trim();
  if (!explicit) return null;
  if (!isAbsoluteLikePython(explicit)) throw new ToolError(`${envKey} must be an absolute path`);
  const resolved = resolveLikePython(explicit);
  let info = null;
  try {
    info = statSync(resolved);
  } catch {
    info = null;
  }
  if (!info || !info.isDirectory()) throw new ToolError(`${envKey} is not a directory: ${explicit}`);
  return resolved;
}
function projectRoot() {
  const explicit = declaredDirectory("SUBAGENT_PROJECT_ROOT");
  if (explicit) return explicit;
  if (String(process2.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const cwd = resolveLikePython(process2.cwd());
  let cur = cwd;
  while (true) {
    if (existsSync(path.join(cur, ".git")) || existsSync(path.join(cur, "AGENTS.md")) && existsSync(path.join(cur, "ops"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return repoRoot();
}
function runtimeRoot() {
  const explicit = declaredDirectory("SUBAGENT_RUNTIME_ROOT");
  if (explicit) return explicit;
  if (String(process2.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (existsSync(path.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  return repoRoot();
}
var ROOT = projectRoot();
var RUNTIME_ROOT = runtimeRoot();
function runGit(args, cwd = ROOT) {
  const cmd = ["git", ...args.map(String)];
  const proc = spawnSync("git", args.map(String), { cwd, encoding: "utf8", windowsHide: true });
  if (proc.error) {
    if (proc.error.code === "ENOENT") throw new ToolError("git executable not found");
    throw new ToolError(`git failed to start: ${proc.error.message}`);
  }
  return {
    command: cmd,
    exit_code: proc.status ?? 1,
    stdout: String(proc.stdout ?? "").replace(/\n+$/, ""),
    stderr: String(proc.stderr ?? "").replace(/\n+$/, "")
  };
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareCodePoints).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}
function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value), null, 2);
}
function emit(data, fmt, text) {
  if (fmt === "json") {
    process2.stdout.write(`${canonicalJson(data)}
`);
  } else {
    const trimmed = String(text ?? "").replace(/\s+$/, "");
    process2.stdout.write(`${trimmed || "(empty)"}
`);
  }
  if (Object.hasOwn(data, "exit_code")) return Number(data.exit_code);
  return ["failed", "error"].includes(data.status) ? 1 : 0;
}
function isSameOrInside(candidate, root) {
  if (!candidate || !root) return false;
  const target = resolveLikePython(candidate);
  const base = resolveLikePython(root);
  const relative = path.relative(base, target);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function readStdinText(sourceLabel) {
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  while (true) {
    let read = 0;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === "EAGAIN") continue;
      if (error?.code === "EOF") break;
      throw error;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return decodeStdinBytes(Buffer.concat(chunks), sourceLabel);
}
function decodeStdinBytes(raw, sourceLabel) {
  if (raw.length >= 3 && raw[0] === 239 && raw[1] === 187 && raw[2] === 191) return raw.subarray(3).toString("utf8");
  if (raw.length >= 2 && raw[0] === 255 && raw[1] === 254) return raw.subarray(2).toString("utf16le");
  if (raw.length >= 2 && raw[0] === 254 && raw[1] === 255) return swapUtf16(raw.subarray(2)).toString("utf16le");
  const utf8 = raw.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  if (raw.length % 2 === 0) return raw.toString("utf16le");
  throw new ToolError(`invalid ${sourceLabel} input encoding; expected UTF-8, UTF-16 or locale text`);
}
function swapUtf16(buffer) {
  const swapped = Buffer.from(buffer);
  swapped.swap16();
  return swapped;
}
function asList(value) {
  return Array.isArray(value) ? value : [];
}
function lexicalAbsolute(value) {
  return path.resolve(String(value));
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ops/tools/dispatch-core/task_package_lint.mjs
import { existsSync as existsSync4, statSync as statSync3 } from "node:fs";

// ops/tools/dispatch-core/_py.mjs
import { readFileSync as readFileSync2 } from "node:fs";
import path2 from "node:path";
import process3 from "node:process";
var PY_SPACE_CLASS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
var PY_SPACE_RE = new RegExp(`[${PY_SPACE_CLASS}]`);
var RE_LSTRIP = new RegExp(`^[${PY_SPACE_CLASS}]+`);
var RE_RSTRIP = new RegExp(`[${PY_SPACE_CLASS}]+$`);
var RE_LINE_BOUNDARY = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/;
var NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
function pyStrip(value) {
  return String(value ?? "").replace(RE_LSTRIP, "").replace(RE_RSTRIP, "");
}
function pyStripChars(value, chars) {
  const text = String(value ?? "");
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}
function pySplitLines(value) {
  const text = String(value ?? "");
  if (!text) return [];
  const parts = text.split(RE_LINE_BOUNDARY);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
function pyRepr(value) {
  if (value === null || value === void 0) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isRecord(value)) return `{${Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`).join(", ")}}`;
  const text = String(value);
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "	") out += "\\t";
    else if (ch === " " || !NON_PRINTABLE_RE.test(ch)) out += ch;
    else if (code <= 255) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 65535) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}
function pyStr(value) {
  if (typeof value === "string") return value;
  if (value === null || value === void 0) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  return pyRepr(value);
}
function pyTypeName(value) {
  if (value === null || value === void 0) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return "dict";
}
function pyTruthy(value) {
  if (value === null || value === void 0 || value === false || value === "") return false;
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}
function pyOr(...values) {
  for (const value of values.slice(0, -1)) {
    if (pyTruthy(value)) return value;
  }
  return values[values.length - 1];
}
function pyKeyError(message) {
  return pyError("KeyError", pyRepr(message));
}
function pyGetItem(container, key) {
  if (isRecord(container)) {
    if (!Object.hasOwn(container, key)) throw pyKeyError(key);
    return container[key];
  }
  if (Array.isArray(container)) {
    throw pyError("TypeError", `list indices must be integers or slices, not ${pyTypeName(key)}`);
  }
  if (typeof container === "string") {
    throw pyError("TypeError", `string indices must be integers, not '${pyTypeName(key)}'`);
  }
  throw pyError("TypeError", `'${pyTypeName(container)}' object is not subscriptable`);
}
function pyGet(container, key, fallback = void 0) {
  return isRecord(container) && Object.hasOwn(container, key) ? container[key] : fallback;
}
var JSON_WS = " 	\n\r";
var JSON_BACKSLASH = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "	" };
var JSON_NUMBER_RE = /(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/y;
var ScanStop = class {
  constructor(idx) {
    this.idx = idx;
  }
};
function jsonDecodeError(msg, doc, pos) {
  let lineno = 1;
  for (let i = 0; i < pos && i < doc.length; i += 1) if (doc[i] === "\n") lineno += 1;
  const lastNewline = pos === 0 ? -1 : doc.lastIndexOf("\n", pos - 1);
  return pyError("JSONDecodeError", `${msg}: line ${lineno} column ${pos - lastNewline} (char ${pos})`);
}
function jsonSkipWs(s, idx) {
  let cur = idx;
  while (cur < s.length && JSON_WS.includes(s[cur])) cur += 1;
  return cur;
}
function decodeUXXXX(s, pos) {
  const esc = s.slice(pos + 1, pos + 5);
  if (esc.length === 4 && esc[1] !== "x" && esc[1] !== "X" && /^[0-9a-fA-F]{4}$/.test(esc)) {
    return Number.parseInt(esc, 16);
  }
  throw jsonDecodeError("Invalid \\uXXXX escape", s, pos);
}
function jsonScanString(s, start) {
  const begin = start - 1;
  let end = start;
  let out = "";
  for (; ; ) {
    let idx = end;
    while (idx < s.length) {
      const code = s.charCodeAt(idx);
      if (code === 34 || code === 92 || code <= 31) break;
      idx += 1;
    }
    if (idx >= s.length) throw jsonDecodeError("Unterminated string starting at", s, begin);
    out += s.slice(end, idx);
    const terminator = s[idx];
    end = idx + 1;
    if (terminator === '"') break;
    if (terminator !== "\\") throw jsonDecodeError("Invalid control character at", s, end - 1);
    if (end >= s.length) throw jsonDecodeError("Unterminated string starting at", s, begin);
    const esc = s[end];
    if (esc !== "u") {
      if (!Object.hasOwn(JSON_BACKSLASH, esc)) throw jsonDecodeError("Invalid \\escape", s, end - 1);
      out += JSON_BACKSLASH[esc];
      end += 1;
    } else {
      let uni = decodeUXXXX(s, end);
      end += 5;
      if (uni >= 55296 && uni <= 56319 && s.slice(end, end + 2) === "\\u") {
        const uni2 = decodeUXXXX(s, end + 1);
        if (uni2 >= 56320 && uni2 <= 57343) {
          uni = 65536 + (uni - 55296 << 10 | uni2 - 56320);
          end += 6;
        }
      }
      out += String.fromCodePoint(uni);
    }
  }
  return [out, end];
}
function jsonSetKey(target, key, value) {
  if (key === "__proto__") Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  else target[key] = value;
}
function jsonObject(s, start) {
  const pairs = {};
  let end = start;
  let nextchar = s.slice(end, end + 1);
  if (nextchar !== '"') {
    if (nextchar && JSON_WS.includes(nextchar)) {
      end = jsonSkipWs(s, end);
      nextchar = s.slice(end, end + 1);
    }
    if (nextchar === "}") return [pairs, end + 1];
    if (nextchar !== '"') throw jsonDecodeError("Expecting property name enclosed in double quotes", s, end);
  }
  end += 1;
  for (; ; ) {
    let key;
    [key, end] = jsonScanString(s, end);
    if (s.slice(end, end + 1) !== ":") {
      end = jsonSkipWs(s, end);
      if (s.slice(end, end + 1) !== ":") throw jsonDecodeError("Expecting ':' delimiter", s, end);
    }
    end += 1;
    if (end < s.length && JSON_WS.includes(s[end])) {
      end += 1;
      if (end < s.length && JSON_WS.includes(s[end])) end = jsonSkipWs(s, end + 1);
    }
    let value;
    try {
      [value, end] = jsonScanOnce(s, end);
    } catch (error) {
      if (error instanceof ScanStop) throw jsonDecodeError("Expecting value", s, error.idx);
      throw error;
    }
    jsonSetKey(pairs, key, value);
    if (end < s.length) {
      nextchar = s[end];
      if (JSON_WS.includes(nextchar)) {
        end = jsonSkipWs(s, end + 1);
        nextchar = end < s.length ? s[end] : "";
      }
    } else {
      nextchar = "";
    }
    end += 1;
    if (nextchar === "}") break;
    if (nextchar !== ",") throw jsonDecodeError("Expecting ',' delimiter", s, end - 1);
    end = jsonSkipWs(s, end);
    nextchar = s.slice(end, end + 1);
    end += 1;
    if (nextchar !== '"') throw jsonDecodeError("Expecting property name enclosed in double quotes", s, end - 1);
  }
  return [pairs, end];
}
function jsonArray(s, start) {
  const values = [];
  let end = start;
  let nextchar = s.slice(end, end + 1);
  if (nextchar && JSON_WS.includes(nextchar)) {
    end = jsonSkipWs(s, end + 1);
    nextchar = s.slice(end, end + 1);
  }
  if (nextchar === "]") return [values, end + 1];
  for (; ; ) {
    let value;
    try {
      [value, end] = jsonScanOnce(s, end);
    } catch (error) {
      if (error instanceof ScanStop) throw jsonDecodeError("Expecting value", s, error.idx);
      throw error;
    }
    values.push(value);
    nextchar = s.slice(end, end + 1);
    if (nextchar && JSON_WS.includes(nextchar)) {
      end = jsonSkipWs(s, end + 1);
      nextchar = s.slice(end, end + 1);
    }
    end += 1;
    if (nextchar === "]") break;
    if (nextchar !== ",") throw jsonDecodeError("Expecting ',' delimiter", s, end - 1);
    if (end < s.length && JSON_WS.includes(s[end])) {
      end += 1;
      if (end < s.length && JSON_WS.includes(s[end])) end = jsonSkipWs(s, end + 1);
    }
  }
  return [values, end];
}
function jsonScanOnce(s, idx) {
  if (idx >= s.length) throw new ScanStop(idx);
  const nextchar = s[idx];
  if (nextchar === '"') return jsonScanString(s, idx + 1);
  if (nextchar === "{") return jsonObject(s, idx + 1);
  if (nextchar === "[") return jsonArray(s, idx + 1);
  if (nextchar === "n" && s.slice(idx, idx + 4) === "null") return [null, idx + 4];
  if (nextchar === "t" && s.slice(idx, idx + 4) === "true") return [true, idx + 4];
  if (nextchar === "f" && s.slice(idx, idx + 5) === "false") return [false, idx + 5];
  JSON_NUMBER_RE.lastIndex = idx;
  const match = JSON_NUMBER_RE.exec(s);
  if (match) {
    const [whole, integer, frac, exp] = match;
    const value = frac || exp ? Number.parseFloat(integer + (frac || "") + (exp || "")) : Number(integer) || 0;
    return [value, idx + whole.length];
  }
  if (nextchar === "N" && s.slice(idx, idx + 3) === "NaN") return [Number.NaN, idx + 3];
  if (nextchar === "I" && s.slice(idx, idx + 8) === "Infinity") return [Number.POSITIVE_INFINITY, idx + 8];
  if (nextchar === "-" && s.slice(idx, idx + 9) === "-Infinity") return [Number.NEGATIVE_INFINITY, idx + 9];
  throw new ScanStop(idx);
}
function pyJsonLoads(text) {
  const s = String(text);
  let obj;
  let end;
  try {
    [obj, end] = jsonScanOnce(s, jsonSkipWs(s, 0));
  } catch (error) {
    if (error instanceof ScanStop) throw jsonDecodeError("Expecting value", s, error.idx);
    throw error;
  }
  end = jsonSkipWs(s, end);
  if (end !== s.length) throw jsonDecodeError("Extra data", s, end);
  return obj;
}
function pyReadText(file) {
  const raw = readFileSync2(file);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw pyError("UnicodeDecodeError", `'utf-8' codec can't decode file: ${String(file)}`);
  }
  return text.replace(/\r\n?/g, "\n");
}
function pyReadTextReplace(file) {
  return readFileSync2(file, "utf8").replace(/\r\n?/g, "\n");
}
function pyNormcase(value) {
  const text = String(value);
  return process3.platform === "win32" ? text.replace(/\//g, "\\").toLowerCase() : text;
}
function pySamePath(left, right) {
  return pyNormcase(left) === pyNormcase(right);
}
function pathAnchor(root) {
  if (process3.platform !== "win32") return root;
  const anchor = root.replace(/\//g, "\\");
  return /^\\\\[^\\]+\\[^\\]+$/.test(anchor) ? `${anchor}\\` : anchor;
}
function pathParts(value) {
  const raw = String(value);
  const root = path2.parse(raw).root;
  const rest = raw.slice(root.length).split(/[\\/]+/).filter((part) => part && part !== ".");
  return { anchor: pathAnchor(root), parts: rest };
}
function pyPureStr(value) {
  const { anchor, parts } = pathParts(value);
  if (!parts.length) return anchor || ".";
  return anchor + parts.join(process3.platform === "win32" ? "\\" : "/");
}
function pyIsRelativeTo(child, parent) {
  const left = pathParts(child);
  const right = pathParts(parent);
  if (pyNormcase(left.anchor) !== pyNormcase(right.anchor)) return false;
  if (right.parts.length > left.parts.length) return false;
  return right.parts.every((part, index) => pyNormcase(part) === pyNormcase(left.parts[index]));
}
function pyRelativeToPosix(child, parent) {
  if (!pyIsRelativeTo(child, parent)) {
    throw pyError("ValueError", `${pyRepr(pyPureStr(child))} is not in the subpath of ${pyRepr(pyPureStr(parent))}`);
  }
  const tail = pathParts(child).parts.slice(pathParts(parent).parts.length);
  return tail.length ? tail.join("/") : ".";
}
function pyRelativeTo(child, parent) {
  return pyIsRelativeTo(child, parent) ? pyRelativeToPosix(child, parent) : null;
}
function pyResolveUnder(value, base) {
  return resolveLikePython(pathlibJoin(base, value));
}

// ops/tools/dispatch-core/task_package_build.mjs
import { existsSync as existsSync3, mkdirSync as mkdirSync2, writeFileSync } from "node:fs";
import path4 from "node:path";

// ops/tools/dispatch-core/task_package_profiles.mjs
import { existsSync as existsSync2, readdirSync, statSync as statSync2 } from "node:fs";
import path3 from "node:path";
var ROUTE_DIR = path3.join(RUNTIME_ROOT, "ops", "protocols", "task-package-routes");
var ACCEPTANCE_LEAF_COMMON_FILE = "ops/agent-prompts/_acceptance-leaf-common.md";
var REQUIRED_TOP_LEVEL = [
  "version",
  "package_id",
  "agent",
  "project_positioning",
  "goal",
  "scope",
  "ownership",
  "concurrency_contract",
  "inputs",
  "known_facts",
  "expected_output",
  "runtime_context",
  "alignment",
  "planning_policy",
  "tool_contract",
  "stop_conditions",
  "extensions",
  "handoff_contract"
];
var SEED_BODY_REQUIRED = [
  "project_positioning",
  "goal",
  "scope",
  "ownership",
  "concurrency_contract",
  "inputs",
  "known_facts",
  "expected_output",
  "runtime_context",
  "alignment",
  "planning_policy",
  "tool_contract",
  "stop_conditions",
  "extensions",
  "handoff_contract"
];
function valueError(message) {
  return pyError("ValueError", message);
}
function relRoute(routeFile) {
  return path3.relative(ROOT, routeFile).replace(/\\/g, "/");
}
function routeIdFromAgent(role, capability) {
  return `${role}__${capability}`;
}
var AGENT_BLOCK_RE = /```yaml\s+task_package_agent\s*\n([\s\S]*?)\n```/;
var CARD_RE = /```json\s+route_card\s*\n([\s\S]*?)\n```/;
function blockScalar(text, routeFile) {
  const match = AGENT_BLOCK_RE.exec(text);
  if (!match) throw valueError(`${relRoute(routeFile)} missing yaml task_package_agent block`);
  return match[1];
}
function parseCard(text, routeFile) {
  const match = CARD_RE.exec(text);
  if (!match) return null;
  const rel = relRoute(routeFile);
  let card;
  try {
    card = pyJsonLoads(match[1]);
  } catch (error) {
    throw valueError(`${rel} route_card block is not valid JSON: ${error.message}`);
  }
  if (!isRecord(card)) throw valueError(`${rel} route_card must be a JSON object`);
  const required = pyGet(card, "required", []);
  const slot = pyStr(pyOr(pyGet(card, "slot"), "")).trim();
  const needsSlot = pyTruthy(pyGet(card, "contract_defaults")) || pyTruthy(pyGet(card, "required_files_by_contract")) || required.some((req) => isRecord(req) && pyStr(pyGet(req, "path", "")).startsWith("contract."));
  if (needsSlot && !slot) throw valueError(`${rel} route_card uses contract fields but has no slot`);
  for (const req of required) {
    if (!isRecord(req) || !pyStr(pyGet(req, "path", "")).trim()) {
      throw valueError(`${rel} route_card required entries need a path`);
    }
  }
  const seedDefaults = isRecord(pyGet(card, "seed_defaults")) ? pyGet(card, "seed_defaults") : {};
  const expectedDefaults = isRecord(pyGet(seedDefaults, "expected_output")) ? pyGet(seedDefaults, "expected_output") : {};
  const businessGate = pyStr(pyOr(pyGet(expectedDefaults, "business_gate"), "")).trim();
  if (businessGate && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(businessGate)) {
    throw valueError(`${rel} expected_output.business_gate must be a bare field name`);
  }
  const requiredByContract = pyGet(card, "required_files_by_contract", null);
  if (requiredByContract !== null && requiredByContract !== void 0) {
    const keys = isRecord(requiredByContract) ? Object.keys(requiredByContract).sort() : null;
    if (!keys || keys.length !== 2 || keys[0] !== "map" || keys[1] !== "path") {
      throw valueError(`${rel} required_files_by_contract must contain path and map`);
    }
    const contractPath = pyStr(pyOr(pyGet(requiredByContract, "path"), "")).trim();
    const mapping = pyGet(requiredByContract, "map");
    if (!contractPath || !isRecord(mapping) || !pyTruthy(mapping)) {
      throw valueError(`${rel} required_files_by_contract needs a contract path and non-empty map`);
    }
    for (const [value, promptPath] of Object.entries(mapping)) {
      if (!pyStr(value).trim() || typeof promptPath !== "string" || !promptPath.startsWith("ops/agent-prompts/")) {
        throw valueError(`${rel} required_files_by_contract has an invalid mapping`);
      }
      const target = path3.join(RUNTIME_ROOT, promptPath);
      if (!(existsSync2(target) && statSync2(target).isFile())) {
        throw valueError(`${rel} conditional required file missing: ${promptPath}`);
      }
    }
  }
  return card;
}
function parseAgentBlock(block, routeFile) {
  let role = "";
  let runtimeRole = "";
  let capabilityName = "";
  let capabilityFile = "";
  const requiredFiles = [];
  let section = "";
  for (const rawLine of pySplitLines(block)) {
    const stripped = rawLine.trim();
    if (!stripped || stripped.startsWith("#") || stripped === "agent:") continue;
    if (stripped === "capability:") {
      section = "capability";
      continue;
    }
    if (stripped === "required_files:") {
      section = "required_files";
      continue;
    }
    if (section === "required_files" && stripped.startsWith("- ")) {
      requiredFiles.push(stripped.slice(2).trim());
      continue;
    }
    const colon = stripped.indexOf(":");
    if (colon === -1) continue;
    const key = stripped.slice(0, colon);
    const value = pyStripChars(stripped.slice(colon + 1).trim(), `"'`);
    if (section === "capability" && key === "name") capabilityName = value;
    else if (section === "capability" && key === "file") capabilityFile = value;
    else if (key === "role") {
      section = "agent";
      role = value;
    } else if (key === "runtime_role") {
      section = "agent";
      runtimeRole = value;
    }
  }
  const rel = relRoute(routeFile);
  const missing = [];
  if (!role) missing.push("agent.role");
  if (!runtimeRole) missing.push("agent.runtime_role");
  if (!capabilityName) missing.push("agent.capability.name");
  if (!capabilityFile) missing.push("agent.capability.file");
  if (!requiredFiles.length) missing.push("agent.required_files");
  if (missing.length) throw valueError(`${rel} task_package_agent missing: ${missing.join(", ")}`);
  return {
    role,
    runtime_role: runtimeRole,
    capability: { name: capabilityName, file: capabilityFile },
    required_files: requiredFiles
  };
}
function routeProfile(routeFile) {
  const routeId = path3.basename(routeFile, ".md");
  const text = pyReadText(routeFile);
  const agent = parseAgentBlock(blockScalar(text, routeFile), routeFile);
  const expectedRoute = routeIdFromAgent(agent.role, agent.capability.name);
  const relRouteFile = relRoute(routeFile);
  if (expectedRoute !== routeId) {
    throw valueError(`${relRouteFile} file name does not match task_package_agent: expected ${expectedRoute}`);
  }
  return {
    route_id: routeId,
    agent,
    role: agent.role,
    runtime_role: agent.runtime_role,
    capability: agent.capability.name,
    prompt_file: agent.capability.file,
    route_file: relRouteFile,
    required_files: agent.required_files,
    card: parseCard(text, routeFile)
  };
}
function loadRouteProfiles() {
  if (!(existsSync2(ROUTE_DIR) && statSync2(ROUTE_DIR).isDirectory())) {
    throw valueError(`route directory not found: ${path3.relative(RUNTIME_ROOT, ROUTE_DIR).replace(/\\/g, "/")}`);
  }
  const profiles = {};
  const names = readdirMd(ROUTE_DIR).sort();
  for (const name of names) {
    const profile = routeProfile(path3.join(ROUTE_DIR, name));
    profiles[profile.route_id] = profile;
  }
  if (!Object.keys(profiles).length) throw valueError("no task package routes found");
  return profiles;
}
function readdirMd(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name);
}
var PROFILE_CACHE = /* @__PURE__ */ new Map();
function profileCacheKey() {
  return `${ROOT}\0${RUNTIME_ROOT}`;
}
function routeProfiles() {
  const key = profileCacheKey();
  if (!PROFILE_CACHE.has(key)) PROFILE_CACHE.set(key, loadRouteProfiles());
  return PROFILE_CACHE.get(key);
}
function profileFor(routeId) {
  const profiles = routeProfiles();
  if (!Object.hasOwn(profiles, routeId)) {
    const supported = Object.keys(profiles).sort().join(", ");
    throw pyKeyError(`unsupported route_id ${pyRepr(routeId)}; supported: ${supported}`);
  }
  return profiles[routeId];
}
function conditionalRequiredFiles(pkg, profile) {
  const expected = [...pyGetItem(pyGetItem(profile, "agent"), "required_files")];
  const extensions = isRecord(pyGet(pkg, "extensions")) ? pyGet(pkg, "extensions") : {};
  const contracts = isRecord(pyGet(extensions, "capability_contract")) ? pyGet(extensions, "capability_contract") : {};
  const hasAcceptanceContext = Object.values(contracts).some(
    (contract2) => isRecord(contract2) && Object.hasOwn(contract2, "acceptance_context") && isRecord(pyGet(contract2, "acceptance_context"))
  );
  if (hasAcceptanceContext) expected.push(ACCEPTANCE_LEAF_COMMON_FILE);
  const card = isRecord(pyGet(profile, "card")) ? pyGet(profile, "card") : {};
  const selector = pyGet(card, "required_files_by_contract");
  const slot = pyStr(pyOr(pyGet(card, "slot"), "")).trim();
  const contract = slot && isRecord(pyGet(contracts, slot)) ? pyGet(contracts, slot) : {};
  if (isRecord(selector)) {
    const selected = pyStr(pyOr(pyGet(contract, pyStr(pyOr(pyGet(selector, "path"), ""))), ""));
    const mapping = isRecord(pyGet(selector, "map")) ? pyGet(selector, "map") : {};
    const promptPath = pyGet(mapping, selected);
    if (typeof promptPath === "string" && promptPath) expected.push(promptPath);
  }
  return [...new Set(expected)];
}

// ops/tools/dispatch-core/task_package_build.mjs
var PLAN_EXECUTION_ADJUSTMENT_KINDS = [
  "equivalent_command",
  "unique_path_resolution",
  "semantics_preserving_step_reorder"
];
var FINAL_HANDOFF_VERDICTS = /* @__PURE__ */ new Set(["done", "partial", "needs_owner", "needs_split", "failed", "pass", "fail"]);
function deepCopy(value) {
  return structuredClone(value);
}
function readProjectName() {
  const projectFile = path4.join(ROOT, "PROJECT.md");
  if (!existsSync3(projectFile)) return "<\u9879\u76EE\u540D>";
  const lines = pySplitLines(pyReadTextReplace(projectFile));
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (lines[idx].trim() !== "## \u9879\u76EE\u540D\u79F0") continue;
    for (const candidate of lines.slice(idx + 1)) {
      const value = candidate.trim();
      if (value && !value.startsWith("#")) return value;
    }
    break;
  }
  return "<\u9879\u76EE\u540D>";
}
function repoAbsPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${label} must be a non-empty string`);
  const projectReal = resolveLikePython(ROOT);
  const lexical = lexicalAbsolute(pathlibJoin(ROOT, value));
  if (pyRelativeTo(lexical, projectReal) === null) {
    throw new ToolError(`${label} must resolve under repository root: ${value}`);
  }
  const resolved = resolveLikePython(lexical);
  if (pyRelativeTo(resolved, projectReal) === null && !isSameOrInside(resolved, RUNTIME_ROOT)) {
    throw new ToolError(`${label} must resolve under repository root: ${value}`);
  }
  return resolved;
}
function targetRepoRoot(runtime) {
  const target = pyGet(runtime, "target_repo", null);
  if (target === null || target === void 0 || target === "") return null;
  if (typeof target !== "string" || !target.trim()) {
    throw new ToolError("runtime_context.target_repo must be a non-empty string when set");
  }
  if (!isAbsoluteLikePython(target)) throw new ToolError("runtime_context.target_repo must be an absolute path");
  return resolveLikePython(target);
}
function repoOrTargetAbsPath(value, runtime, label) {
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${label} must be a non-empty string`);
  const projectReal = resolveLikePython(ROOT);
  const lexical = lexicalAbsolute(pathlibJoin(ROOT, value));
  const resolved = resolveLikePython(lexical);
  const inProjectLexically = pyRelativeTo(lexical, projectReal) !== null;
  if (inProjectLexically && (pyRelativeTo(resolved, projectReal) !== null || isSameOrInside(resolved, RUNTIME_ROOT))) {
    return resolved;
  }
  const target = targetRepoRoot(runtime);
  if (target !== null && pyRelativeTo(resolved, target) !== null) return resolved;
  throw new ToolError(`${label} must resolve under repository root or runtime_context.target_repo: ${value}`);
}
function requireDict(data, key) {
  const value = pyGet(data, key);
  if (!isRecord(value)) throw new ToolError(`${key} must be a JSON object`);
  return deepCopy(value);
}
function requireList(data, key) {
  const value = pyGet(data, key);
  if (!Array.isArray(value)) throw new ToolError(`${key} must be a JSON list`);
  return deepCopy(value);
}
function requireString(data, key) {
  const value = pyGet(data, key);
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${key} must be a non-empty string`);
  return value;
}
function stringList(value, label) {
  if (!Array.isArray(value)) throw new ToolError(`${label} must be a list`);
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") throw new ToolError(`${label} entries must be strings`);
    result.push(item);
  }
  return result;
}
function scopeFromSeed(seed) {
  const scope = requireDict(seed, "scope");
  return {
    read: stringList(pyGet(scope, "read"), "scope.read"),
    write: stringList(pyGet(scope, "write"), "scope.write"),
    delete: stringList(pyGet(scope, "delete"), "scope.delete"),
    out_of_scope: stringList(pyGet(scope, "out_of_scope"), "scope.out_of_scope")
  };
}
function gitValue(args, fallback = "", cwd = void 0) {
  const result = runGit(args, cwd);
  if (result.exit_code !== 0) return fallback;
  return result.stdout.trim() || fallback;
}
function packageId(routeId, seed) {
  if (pyTruthy(pyGet(seed, "package_id"))) return pyStr(pyGetItem(seed, "package_id"));
  const now = clock.now();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${utcDateStamp()}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `pkg-${String(routeId).replaceAll("__", "-")}-${stamp}-${ids.uuidHex().slice(0, 12)}`;
}
function routeIdFromSeed(seed) {
  const value = pyGet(seed, "route_id");
  if (typeof value === "string" && value.trim()) return value.trim();
  const inputs = pyGet(seed, "inputs");
  if (isRecord(inputs) && typeof pyGet(inputs, "route_id") === "string" && pyGetItem(inputs, "route_id").trim()) {
    throw new ToolError(
      "package_seed.route_id is required at the JSON root; inputs.route_id is task input metadata and is not used to select a route"
    );
  }
  throw new ToolError("package_seed.route_id is required at the JSON root");
}
var TRUTHY_TEXT = /* @__PURE__ */ new Set(["1", "true", "yes", "y", "on"]);
function truthyText(value) {
  const base = pyTruthy(value) ? value : "";
  return TRUTHY_TEXT.has(pyStrip(pyStr(base)).toLowerCase());
}
function projectDeclarations(input) {
  const seed = deepCopy(input);
  for (const [object, canonical, legacy] of [
    [seed.expected_output, "file_path", "path"],
    [seed.handoff_contract, "require_final_handoff", "final_response_required"]
  ]) {
    if (!Object.hasOwn(object, canonical) && Object.hasOwn(object, legacy)) object[canonical] = object[legacy];
    delete object[legacy];
  }
  const destinations = [seed.expected_output.file_path, seed.handoff_contract.handoff_file].filter((value) => typeof value === "string" && value);
  for (const destination of destinations) {
    if (!seed.scope.write.includes(destination)) seed.scope.write.push(destination);
    const conflictWrite = seed.concurrency_contract?.conflict_keys?.write;
    if (Array.isArray(conflictWrite) && !conflictWrite.includes(destination)) conflictWrite.push(destination);
  }
  if (truthyText(seed.runtime_context.network_needed) || seed.tool_contract.network_allowed === true) {
    seed.runtime_context.network_needed = "yes";
    seed.tool_contract.network_allowed = true;
  }
  delete seed.runtime_context.agent_runtime_consent;
  delete seed.handoff_contract.parent_consume_action;
  delete seed.ownership.unlock_conditions;
  if (Array.isArray(seed.tool_contract.allowed)) {
    seed.tool_contract.allowed = [...new Set(seed.tool_contract.allowed.map((item) => typeof item === "string" ? item.trim() : item))];
  } else if (seed.tool_contract.allowed == null) {
    seed.tool_contract.allowed = null;
  }
  const executor = seed.extensions?.capability_contract?.executor;
  if (seed.route_id === "executor-agent__plan-execution" && isRecord(executor)) {
    if (!Object.hasOwn(executor, "execution_adjustment_policy")) executor.execution_adjustment_policy = {};
    const policy = executor.execution_adjustment_policy;
    if (isRecord(policy) && !Object.hasOwn(policy, "allowed_kinds")) policy.allowed_kinds = [...PLAN_EXECUTION_ADJUSTMENT_KINDS];
  }
  const scoped = executor?.scoped;
  if (isRecord(scoped?.ref_resolution) && !(scoped.operation_type === "source_clone_only" && scoped.ref_resolution.if_missing === "fallback_default_branch")) {
    delete scoped.ref_resolution.fallback_ref;
  }
  seed.handoff_contract.require_final_handoff = true;
  return seed;
}
function aliasValue(object, canonical, legacy, label, issues) {
  if (Object.hasOwn(object, canonical)) {
    if (Object.hasOwn(object, legacy) && object[canonical] !== object[legacy]) {
      issues.push(`${label}.${legacy} conflicts with ${label}.${canonical}; provide one value`);
    }
    return object[canonical];
  }
  return object[legacy];
}
function checkExpectedOutputContract(expected) {
  const issues = [];
  const filePath = aliasValue(expected, "file_path", "path", "expected_output", issues);
  const mode = pyGet(expected, "mode");
  if (mode !== "file") {
    issues.push("expected_output.mode must be file");
    return issues;
  }
  if (typeof filePath !== "string" || !filePath) {
    issues.push("expected_output.mode=file requires expected_output.file_path");
  }
  return issues;
}
function checkHandoffContract(handoff) {
  const issues = [];
  aliasValue(handoff, "require_final_handoff", "final_response_required", "handoff_contract", issues);
  const acceptVerdicts = pyGet(handoff, "accept_verdicts");
  if (!Array.isArray(acceptVerdicts) || !acceptVerdicts.length) {
    issues.push("handoff_contract.accept_verdicts must be a non-empty list");
  } else {
    const invalid = acceptVerdicts.filter((item) => !FINAL_HANDOFF_VERDICTS.has(item)).map(pyStr);
    if (invalid.length) {
      issues.push(`handoff_contract.accept_verdicts contains invalid verdicts: ${invalid.join(", ")}`);
    }
  }
  if (typeof pyGet(handoff, "handoff_file_required") !== "boolean") {
    issues.push("handoff_contract.handoff_file_required must be boolean");
  }
  if (pyTruthy(pyGet(handoff, "handoff_file_required")) && !pyTruthy(pyGet(handoff, "handoff_file"))) {
    issues.push("handoff_contract.handoff_file is required when handoff_file_required=true");
  }
  return issues;
}
function validateBody(seed, routeId) {
  const missing = SEED_BODY_REQUIRED.filter((key) => !Object.hasOwn(seed, key));
  if (missing.length) {
    throw new ToolError(`package_seed missing required body fields for ${routeId}: ${missing.join(", ")}`);
  }
  requireDict(seed, "project_positioning");
  requireString(seed, "goal");
  const scope = scopeFromSeed(seed);
  requireDict(seed, "ownership");
  requireDict(seed, "concurrency_contract");
  requireDict(seed, "inputs");
  requireList(seed, "known_facts");
  const expected = requireDict(seed, "expected_output");
  const runtime = requireDict(seed, "runtime_context");
  requireDict(seed, "alignment");
  requireDict(seed, "planning_policy");
  requireDict(seed, "tool_contract");
  requireList(seed, "stop_conditions");
  requireDict(seed, "extensions");
  const handoff = requireDict(seed, "handoff_contract");
  const issues = [
    ...checkExpectedOutputContract(expected),
    ...checkHandoffContract(handoff)
  ];
  if (issues.length) throw new ToolError(issues[0]);
  const filePath = Object.hasOwn(expected, "file_path") ? expected.file_path : expected.path;
  repoOrTargetAbsPath(filePath, runtime, "expected_output.file_path");
  for (const item of scope.write) repoOrTargetAbsPath(item, runtime, "scope.write");
  for (const item of scope.delete) repoAbsPath(item, "scope.delete");
  const handoffFile = pyGet(handoff, "handoff_file", null);
  if (handoffFile !== null && handoffFile !== void 0) repoAbsPath(handoffFile, "handoff_contract.handoff_file");
  return null;
}
function enrichRuntimeContext(runtimeContext) {
  const runtime = deepCopy(runtimeContext);
  const cwdDefault = ROOT;
  if (!Object.hasOwn(runtime, "cwd")) runtime.cwd = cwdDefault;
  runtime.output_root = ROOT;
  const gitDefault = {
    branch: gitValue(["branch", "--show-current"], "(unknown)"),
    head: gitValue(["rev-parse", "--short=12", "HEAD"], "(unknown)")
  };
  if (!Object.hasOwn(runtime, "git")) runtime.git = gitDefault;
  return runtime;
}
function enrichExpectedOutput(expectedOutput, runtimeContext) {
  const expected = deepCopy(expectedOutput);
  if (pyGet(expected, "mode") === "file" && typeof pyGet(expected, "file_path") === "string") {
    expected.resolved_file_path = repoOrTargetAbsPath(
      pyGetItem(expected, "file_path"),
      runtimeContext,
      "expected_output.file_path"
    );
  }
  return expected;
}
function enrichHandoffContract(handoffContract) {
  const handoff = deepCopy(handoffContract);
  const handoffFile = pyGet(handoff, "handoff_file");
  if (typeof handoffFile === "string" && handoffFile.trim()) {
    handoff.resolved_handoff_file = repoAbsPath(handoffFile, "handoff_contract.handoff_file");
  } else {
    handoff.resolved_handoff_file = null;
  }
  return handoff;
}
function buildPackage(seed) {
  const routeId = routeIdFromSeed(seed);
  const profile = profileFor(routeId);
  validateBody(seed, routeId);
  seed = projectDeclarations(seed);
  const pkgId = packageId(routeId, seed);
  const pkg = {
    version: pyStr(pyGet(seed, "version", "1")),
    package_id: pkgId,
    agent: deepCopy(pyGetItem(profile, "agent")),
    project_positioning: seed.project_positioning,
    goal: seed.goal,
    scope: {
      read: seed.scope.read,
      write: seed.scope.write,
      delete: seed.scope.delete,
      out_of_scope: seed.scope.out_of_scope
    },
    ownership: seed.ownership,
    concurrency_contract: seed.concurrency_contract,
    inputs: seed.inputs,
    known_facts: seed.known_facts,
    expected_output: enrichExpectedOutput(seed.expected_output, seed.runtime_context),
    runtime_context: enrichRuntimeContext(seed.runtime_context),
    alignment: seed.alignment,
    planning_policy: seed.planning_policy,
    tool_contract: seed.tool_contract,
    stop_conditions: seed.stop_conditions,
    extensions: seed.extensions,
    handoff_contract: enrichHandoffContract(seed.handoff_contract)
  };
  return { task_package: pkg };
}
function sampleSeed(routeId) {
  const parts = String(routeId).split("__");
  if (parts.length < 2) throw pyError("ValueError", "not enough values to unpack (expected 2, got 1)");
  const role = parts[0];
  const capability = parts.slice(1).join("__");
  const promptKey = capability.replaceAll("-", "_");
  return {
    route_id: routeId,
    goal: `\u6784\u9020 ${routeId} \u7684\u7EDF\u4E00\u5B8C\u6574 seed \u81EA\u6D4B\u5305\u3002`,
    project_positioning: {
      project: readProjectName(),
      status: "tool self-test",
      roadmap: "tool self-test"
    },
    scope: {
      read: ["AGENTS.md"],
      write: [`notes/manifests/${routeId}-self-test.md`],
      delete: [],
      out_of_scope: ["\u7981\u6B62\u4FEE\u6539\u6587\u4EF6", "\u7981\u6B62\u63D0\u4EA4", "\u7981\u6B62\u8054\u7F51"]
    },
    ownership: {
      owner: "child_agent",
      parent_forbidden_same_scope_probe: true
    },
    concurrency_contract: {
      group_id: `self-test-${routeId}`,
      lane_id: "single",
      depends_on: [],
      conflict_keys: {
        read: ["AGENTS.md"],
        write: [`notes/manifests/${routeId}-self-test.md`],
        delete: [],
        output: `notes/manifests/${routeId}-self-test.md`
      },
      parallel_policy: "single_lane"
    },
    inputs: {
      route_id: routeId,
      route_file: `ops/protocols/task-package-routes/${routeId}.md`,
      question: "\u786E\u8BA4\u7EDF\u4E00\u5B8C\u6574 seed \u53EF\u4EE5\u6784\u5305\u3002"
    },
    known_facts: [],
    expected_output: {
      mode: "file",
      file_path: `notes/manifests/${routeId}-self-test.md`,
      required_sections: ["scope", "summary", "findings"],
      business_gate: `${promptKey}_gate`
    },
    runtime_context: {
      network_needed: "no"
    },
    alignment: {
      alignment_state_ref: null,
      planner_allowed: false,
      guard_status: "not_applicable"
    },
    planning_policy: {
      plan_required: false,
      reason: "tool self-test"
    },
    tool_contract: {
      allowed: null,
      forbidden: ["write_outside_scope", "git_commit", "network", "install_dependencies"],
      network_allowed: false,
      install_allowed: false
    },
    stop_conditions: [
      "required input file missing",
      "scope authorization conflict",
      "output contract cannot be satisfied"
    ],
    extensions: {
      capability_contract: {
        [promptKey]: {
          self_test: true,
          role,
          capability
        }
      }
    },
    handoff_contract: {
      handoff_file_required: false,
      handoff_file: null,
      accept_verdicts: ["done", "partial", "needs_owner", "failed", "pass", "fail"]
    }
  };
}

// ops/tools/dispatch-core/task_package_lint.mjs
var EXTERNAL_REF_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
var RESOURCE_RELEASE_EVENTS = /* @__PURE__ */ new Set(["contract_locked", "execution_done", "validation_passed"]);
function dictGet(container, key, fallback = void 0) {
  if (!isRecord(container)) throw pyError("AttributeError", `'${pyTypeName(container)}' object has no attribute 'get'`);
  return Object.hasOwn(container, key) ? container[key] : fallback;
}
function sameStringList(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}
function loadPackage(file) {
  let raw;
  if (file === "-") {
    raw = readStdinText("--file -");
  } else {
    try {
      raw = pyReadText(file);
    } catch (error) {
      if (error?.code === "ENOENT") throw pyError("FileNotFoundError", `[Errno 2] No such file or directory: '${file}'`);
      throw error;
    }
  }
  return parsePackage(raw);
}
function parsePackage(raw) {
  let data;
  try {
    data = pyJsonLoads(raw);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    throw new ToolError(`package is not valid JSON: ${error.message}`);
  }
  if (!isRecord(data) || !isRecord(pyGet(data, "task_package"))) {
    throw new ToolError(
      'expected task_package_envelope root with task_package object; wrap the task_package_body as {"task_package": {...}} or use task_package_build.mjs'
    );
  }
  return data;
}
function existsUnderRoot(value, root) {
  return existsSync4(pathlibJoin(root, value));
}
function isExternalRef(value) {
  return EXTERNAL_REF_RE.test(value) || value.startsWith("http://") || value.startsWith("https://");
}
function targetRoot(pkg) {
  const issues = [];
  const runtime = dictGet(pkg, "runtime_context", {});
  const target = isRecord(runtime) ? pyGet(runtime, "target_repo") : null;
  const createAllowed = isRecord(runtime) ? pyGet(runtime, "target_repo_create_allowed") === true : false;
  if (target === null || target === void 0 || target === "") return [resolveLikePython(ROOT), issues];
  if (typeof target !== "string" || !target.trim()) {
    return [resolveLikePython(ROOT), ["runtime_context.target_repo must be a non-empty string when set"]];
  }
  if (!isAbsoluteLikePython(target)) issues.push("runtime_context.target_repo must be an absolute path");
  const resolved = pyResolveUnder(target, ROOT);
  if (!existsSync4(resolved) && !createAllowed) {
    issues.push(`runtime_context.target_repo not found: ${target}`);
  } else if (existsSync4(resolved) && !statSync3(resolved).isDirectory()) {
    issues.push(`runtime_context.target_repo is not a directory: ${target}`);
  }
  return [resolved, issues];
}
function pathScopeIssue(value, { base, rootLabel, allowAbsoluteOutside = false, allowRuntime = false } = {}) {
  if (isExternalRef(value)) return null;
  const resolved = pyResolveUnder(value, base);
  if (isAbsoluteLikePython(value) && allowAbsoluteOutside) return null;
  if (allowRuntime && pyRelativeTo(lexicalAbsolute(pathlibJoin(base, value)), resolveLikePython(base)) !== null && isSameOrInside(resolved, RUNTIME_ROOT)) return null;
  if (pyRelativeTo(resolved, resolveLikePython(base)) === null) {
    const issue = `path is outside ${rootLabel} scope: ${value}`;
    if (allowAbsoluteOutside) {
      const retry = existsSync4(resolved) ? `replace this scope.read entry with ${JSON.stringify(resolved)} and retry preview` : "set scope.read to an existing real absolute path for external read and retry preview";
      return `${issue}; resolved path: ${resolved}; ${retry} (read only; write/delete boundaries unchanged)`;
    }
    return issue;
  }
  return null;
}
function routeProfile2(pkg) {
  const agent = dictGet(pkg, "agent", {});
  const capability = dictGet(agent, "capability", {});
  const routeId = routeIdFromAgent(pyStr(dictGet(agent, "role", "")), pyStr(dictGet(capability, "name", "")));
  return [routeId, profileFor(routeId)];
}
function lintAgent(pkg, profile, routeId, { compiled = false } = {}) {
  const issues = [];
  const agent = dictGet(pkg, "agent", {});
  const capability = dictGet(agent, "capability", {});
  const expectedAgent = pyGetItem(profile, "agent");
  if (!compiled) {
    if (dictGet(agent, "role") !== pyGetItem(expectedAgent, "role")) issues.push(`agent.role mismatch for ${routeId}`);
    if (dictGet(agent, "runtime_role") !== pyGetItem(expectedAgent, "runtime_role")) {
      issues.push(`agent.runtime_role mismatch for ${routeId}`);
    }
    if (dictGet(capability, "name") !== pyGetItem(pyGetItem(expectedAgent, "capability"), "name")) {
      issues.push(`capability.name mismatch for ${routeId}`);
    }
    if (dictGet(capability, "file") !== pyGetItem(pyGetItem(expectedAgent, "capability"), "file")) {
      issues.push(`capability.file mismatch for ${routeId}`);
    }
  }
  const requiredFiles = asList(dictGet(agent, "required_files"));
  const expectedRequiredFiles = conditionalRequiredFiles(pkg, profile);
  if (!compiled && !sameStringList(requiredFiles, expectedRequiredFiles)) issues.push(`agent.required_files mismatch for ${routeId}`);
  for (const item of expectedRequiredFiles) {
    if (!existsUnderRoot(item, RUNTIME_ROOT)) issues.push(`agent.required_files path missing from runtime: ${item}`);
  }
  if (!requiredFiles.includes("ops/agent-prompts/_common.md")) {
    issues.push("agent.required_files missing ops/agent-prompts/_common.md");
  }
  const capabilityFile = pyGetItem(pyGetItem(expectedAgent, "capability"), "file");
  if (!requiredFiles.includes(capabilityFile)) {
    issues.push(`agent.required_files missing capability prompt ${capabilityFile}`);
  }
  if (!existsUnderRoot(pyGetItem(profile, "route_file"), RUNTIME_ROOT)) {
    issues.push(`route file missing: ${pyGetItem(profile, "route_file")}`);
  }
  return issues;
}
function lintScope(pkg) {
  const issues = [];
  const scope = dictGet(pkg, "scope", {});
  if (!isRecord(scope)) return ["scope must be an object"];
  const [root, rootIssues] = targetRoot(pkg);
  issues.push(...rootIssues);
  const rootLabel = !pySamePath(root, resolveLikePython(ROOT)) ? "target_repo" : "repository";
  for (const key of ["read", "write", "delete", "out_of_scope"]) {
    if (!Array.isArray(dictGet(scope, key))) issues.push(`scope.${key} must be a list`);
  }
  for (const item of asList(dictGet(scope, "read"))) {
    if (typeof item !== "string") {
      issues.push("scope.read entries must be strings");
      continue;
    }
    const issue = pathScopeIssue(item, { base: root, rootLabel, allowAbsoluteOutside: true, allowRuntime: true });
    if (issue) issues.push(issue);
  }
  for (const key of ["write", "delete"]) {
    for (const item of asList(dictGet(scope, key))) {
      if (typeof item !== "string") {
        issues.push(`scope.${key} entries must be strings`);
        continue;
      }
      if (isExternalRef(item)) {
        issues.push(`scope.${key} cannot be external ref: ${item}`);
        continue;
      }
      let issue = pathScopeIssue(item, { base: ROOT, rootLabel: "repository", allowAbsoluteOutside: false });
      if (issue && key === "write" && !pySamePath(root, resolveLikePython(ROOT))) {
        const targetIssue = pathScopeIssue(item, { base: root, rootLabel, allowAbsoluteOutside: false });
        if (targetIssue === null) issue = null;
      }
      if (issue) issues.push(issue);
    }
  }
  for (const item of asList(dictGet(scope, "out_of_scope"))) {
    if (typeof item !== "string") issues.push("scope.out_of_scope entries must be strings");
  }
  return issues;
}
function lintExpectedOutput(pkg) {
  const issues = [];
  const expected = dictGet(pkg, "expected_output", {});
  if (!isRecord(expected)) return ["expected_output must be an object"];
  const mode = dictGet(expected, "mode");
  const [root, rootIssues] = targetRoot(pkg);
  issues.push(...rootIssues);
  issues.push(...checkExpectedOutputContract(expected));
  const resolved = dictGet(expected, "resolved_file_path", null);
  if (mode === "file" && resolved !== null && resolved !== void 0 && pyTruthy(dictGet(expected, "file_path"))) {
    const repoIssue = pathScopeIssue(pyStr(resolved), { base: ROOT, rootLabel: "repository" });
    const targetIssue = pathScopeIssue(pyStr(resolved), { base: root, rootLabel: "target_repo" });
    if (repoIssue && targetIssue) {
      issues.push("expected_output.resolved_file_path must be under repository root or runtime_context.target_repo");
    }
  }
  return issues;
}
function lintCommonObjects(pkg) {
  const issues = [];
  for (const key of [
    "project_positioning",
    "ownership",
    "concurrency_contract",
    "inputs",
    "runtime_context",
    "alignment",
    "planning_policy",
    "tool_contract",
    "extensions",
    "handoff_contract"
  ]) {
    if (!isRecord(dictGet(pkg, key))) issues.push(`${key} must be an object`);
  }
  for (const key of ["known_facts", "stop_conditions"]) {
    if (!Array.isArray(dictGet(pkg, key))) issues.push(`${key} must be a list`);
  }
  const toolContract = dictGet(pkg, "tool_contract", {});
  const allowed = isRecord(toolContract) ? pyGet(toolContract, "allowed", null) : null;
  if (allowed !== null && allowed !== void 0) {
    if (!Array.isArray(allowed) || allowed.some((item) => typeof item !== "string" || !item.trim())) {
      issues.push("tool_contract.allowed must be null or an array of non-empty Pi tool names");
    }
  }
  for (const field of ["network_allowed", "install_allowed"]) {
    if (isRecord(toolContract) && Object.hasOwn(toolContract, field) && typeof toolContract[field] !== "boolean") {
      issues.push(`tool_contract.${field} must be boolean`);
    }
  }
  const handoff = dictGet(pkg, "handoff_contract", {});
  issues.push(...checkHandoffContract(handoff));
  const handoffFile = dictGet(handoff, "handoff_file");
  const resolvedHandoff = dictGet(handoff, "resolved_handoff_file", null);
  if (resolvedHandoff !== null && resolvedHandoff !== void 0 && pyTruthy(handoffFile)) {
    if (pathScopeIssue(pyStr(resolvedHandoff), { base: ROOT, rootLabel: "repository" })) {
      issues.push("handoff_contract.resolved_handoff_file must be under repository root");
    }
  }
  return issues;
}
function lintCapabilityContract(pkg, routeId) {
  const issues = [];
  const contracts = dictGet(dictGet(pkg, "extensions", {}), "capability_contract", {});
  if (!isRecord(contracts)) return issues;
  if (routeId === "executor-agent__scoped-execution") {
    const scoped = dictGet(dictGet(contracts, "executor", {}), "scoped", {});
    if (isRecord(scoped)) {
      const operationType = pyStr(pyOr(pyGet(scoped, "operation_type"), "")).trim();
      const refResolution = pyGet(scoped, "ref_resolution");
      const resolution = isRecord(refResolution) ? refResolution : {};
      const ifMissing = pyStr(pyOr(pyGet(resolution, "if_missing"), "")).trim();
      const fallbackRef = pyGet(resolution, "fallback_ref", null);
      const fallbackPresent = typeof fallbackRef === "string" && Boolean(fallbackRef.trim());
      if (operationType === "source_clone_only" && ifMissing === "fallback_default_branch") {
        if (!fallbackPresent) {
          issues.push(
            "executor.scoped.ref_resolution.fallback_ref must be a non-empty string when if_missing=fallback_default_branch"
          );
        }
      }
    }
  }
  if (routeId === "executor-agent__plan-execution") {
    const executor = dictGet(contracts, "executor", {});
    if (isRecord(executor)) {
      const policy = pyGet(executor, "execution_adjustment_policy", {});
      if (isRecord(policy) && Object.hasOwn(policy, "allowed_kinds") && (!Array.isArray(policy.allowed_kinds) || policy.allowed_kinds.some((kind) => !PLAN_EXECUTION_ADJUSTMENT_KINDS.includes(kind)))) {
        issues.push("executor.execution_adjustment_policy.allowed_kinds must be a subset of the supported adjustment kinds");
      }
      const locks = pyGet(executor, "resource_locks");
      if (Array.isArray(locks)) {
        locks.forEach((lock, index) => {
          const prefix = `executor.resource_locks[${index}]`;
          if (!isRecord(lock)) {
            issues.push(`${prefix} must be an object`);
            return;
          }
          for (const field of ["lock_id", "holder_lane"]) {
            const value = pyGet(lock, field);
            if (typeof value !== "string" || !value.trim()) {
              issues.push(`${prefix}.${field} must be a non-empty string`);
            }
          }
          const releaseEvents = pyGet(lock, "release_events");
          if (!Array.isArray(releaseEvents) || pyGet(lock, "exclusive") === true && !releaseEvents.length || asList(releaseEvents).some((event) => !RESOURCE_RELEASE_EVENTS.has(event))) {
            issues.push(`${prefix}.release_events must use observable release events`);
          }
        });
      }
    }
  }
  if (routeId === "batch-agent__mechanical-batch") {
    const batch = dictGet(contracts, "batch", {});
    if (isRecord(batch) && Object.hasOwn(batch, "chunk_budget")) {
      const budget = pyGet(batch, "chunk_budget");
      for (const field of ["max_files", "max_bytes", "max_lines"]) {
        const value = isRecord(budget) ? pyGet(budget, field, null) : null;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
          issues.push(`batch.chunk_budget.${field} must be a positive integer`);
        }
      }
    }
  }
  return issues;
}
function lintPackage(root, { compiled = false } = {}) {
  const pkg = pyGetItem(root, "task_package");
  const issues = [];
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(isRecord(pkg) ? Object.hasOwn(pkg, key) : false)) issues.push(`missing top-level field: ${key}`);
  }
  let routeId;
  let profile;
  try {
    [routeId, profile] = routeProfile2(pkg);
  } catch (error) {
    if (error?.name === "KeyError") return [error.message];
    throw error;
  }
  issues.push(...lintAgent(pkg, profile, routeId, { compiled }));
  issues.push(...lintScope(pkg));
  issues.push(...lintExpectedOutput(pkg));
  issues.push(...lintCommonObjects(pkg));
  issues.push(...lintCapabilityContract(pkg, routeId));
  return issues;
}

// ops/tools/task_package_lint.selftest.mjs
import { mkdirSync as mkdirSync3, mkdtempSync, realpathSync as realpathSync2, rmSync, symlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
import os from "node:os";
import path5 from "node:path";
import { pathToFileURL } from "node:url";
function withTempDir(prefix, body) {
  const dir = mkdtempSync(path5.join(os.tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
function selfTest() {
  const seeds = Object.keys(routeProfiles()).sort().map((routeId) => sampleSeed(routeId));
  for (const seed of seeds) {
    const issues = lintPackage(buildPackage(seed));
    if (issues.length) throw new ToolError(`self-test lint unexpectedly failed: ${issues.join("; ")}`);
  }
  const rounds = sampleSeed("plan-checker__requirement-granularity-review");
  rounds.extensions.capability_contract.requirement_granularity_review = {
    review_mode: "all_surfaces",
    review_round: 9,
    surface_rounds: {}
  };
  if (lintPackage(buildPackage(rounds)).length) {
    throw new ToolError("self-test expected business rounds to reach the reviewer");
  }
  const badAgent = buildPackage(seeds[3]);
  badAgent.task_package.agent.required_files = [];
  if (!lintPackage(badAgent).length) throw new ToolError("self-test expected missing route required_files to fail");
  const badScope = buildPackage(seeds[2]);
  badScope.task_package.scope.read = ["../outside-repository.txt"];
  if (!lintPackage(badScope).length) throw new ToolError("self-test expected outside repository read path to fail");
  const fallbackPackage = buildPackage(sampleSeed("executor-agent__scoped-execution"));
  fallbackPackage.task_package.extensions.capability_contract = {
    executor: {
      scoped: {
        operation_type: "source_clone_only",
        no_install: true,
        network_allowed: false,
        no_runtime_execution: true,
        ref_resolution: { if_missing: "fallback_default_branch", fallback_ref: null }
      }
    }
  };
  let fallbackIssues = lintPackage(fallbackPackage);
  if (!fallbackIssues.some((issue) => issue.includes("fallback_ref must be a non-empty string"))) {
    throw new ToolError("self-test expected missing fallback_ref to fail");
  }
  fallbackPackage.task_package.extensions.capability_contract.executor.scoped.ref_resolution.fallback_ref = "main";
  if (lintPackage(fallbackPackage).some((issue) => issue.includes("fallback_ref"))) {
    throw new ToolError("self-test expected explicit fallback_ref to pass");
  }
  fallbackPackage.task_package.extensions.capability_contract.executor.scoped.ref_resolution.if_missing = "needs_owner";
  if (lintPackage(fallbackPackage).some((issue) => issue.includes("fallback_ref"))) {
    throw new ToolError("self-test expected inactive fallback_ref to be ignored");
  }
  withTempDir("task-package-target-repo-", (target) => {
    mkdirSync3(path5.join(target, "src"), { recursive: true });
    writeFileSync2(path5.join(target, "src", "app.py"), "print('ok')\n", "utf8");
    const externalScope = buildPackage(sampleSeed("explorer-agent__codebase-scan"));
    const externalPkg = externalScope.task_package;
    externalPkg.runtime_context.target_repo = target;
    externalPkg.scope.read = ["src/", target];
    externalPkg.scope.write = ["notes/explorer/external.md", "notes/handoffs/external.yaml"];
    externalPkg.scope.delete = ["tmp/delete-me.txt"];
    externalPkg.expected_output.file_path = "notes/explorer/external.md";
    externalPkg.expected_output.resolved_file_path = String(path5.resolve(path5.join(ROOT, "notes/explorer/external.md")));
    externalPkg.handoff_contract.handoff_file_required = true;
    externalPkg.handoff_contract.handoff_file = "notes/handoffs/external.yaml";
    externalPkg.handoff_contract.resolved_handoff_file = String(path5.resolve(path5.join(ROOT, "notes/handoffs/external.yaml")));
    let issues = lintPackage(externalScope);
    if (issues.length) throw new ToolError(`self-test expected target_repo scope to pass: ${issues.join("; ")}`);
    withTempDir("task-package-external-sdk-", (sdk) => {
      const file = path5.join(sdk, "model-runtime.d.ts");
      writeFileSync2(file, "export interface ModelRuntime {}\n", "utf8");
      const realFile = realpathSync2.native(file);
      symlinkSync(sdk, path5.join(target, "sdk"), process.platform === "win32" ? "junction" : "dir");
      const junctionScope = structuredClone(externalScope);
      junctionScope.task_package.scope.read = ["sdk/model-runtime.d.ts"];
      const rejected = lintPackage(junctionScope);
      if (!rejected.some((issue) => issue.includes("outside target_repo scope") && issue.includes(JSON.stringify(realFile)) && issue.includes("scope.read") && issue.includes("retry preview"))) {
        throw new ToolError(`self-test expected relative junction read rejection with real path retry: ${rejected.join("; ")}`);
      }
      junctionScope.task_package.scope.read = [realFile];
      const accepted = lintPackage(junctionScope);
      if (accepted.length) throw new ToolError(`self-test expected real absolute external read to pass: ${accepted.join("; ")}`);
      for (const key of ["write", "delete"]) {
        const outside = structuredClone(junctionScope);
        outside.task_package.scope[key].push(realFile);
        const denied = lintPackage(outside);
        if (!denied.some((issue) => issue.includes("outside repository scope")) || denied.some((issue) => issue.includes("retry preview"))) {
          throw new ToolError(`self-test expected external ${key} rejection without read retry: ${denied.join("; ")}`);
        }
      }
    });
    const externalWriteScope = buildPackage(sampleSeed("executor-agent__scoped-execution"));
    const externalWritePkg = externalWriteScope.task_package;
    externalWritePkg.runtime_context.target_repo = path5.join(target, "new-target");
    externalWritePkg.runtime_context.target_repo_create_allowed = true;
    externalWritePkg.scope.write.push(path5.join(target, "new-target", "PROJECT.md"));
    issues = lintPackage(externalWriteScope);
    if (issues.length) throw new ToolError(`self-test expected creatable target_repo write scope to pass: ${issues.join("; ")}`);
    const externalOutside = buildPackage(sampleSeed("explorer-agent__codebase-scan"));
    externalOutside.task_package.runtime_context.target_repo = target;
    externalOutside.task_package.scope.read = ["../outside-target-repo.txt"];
    if (!lintPackage(externalOutside).some((issue) => issue.includes("outside target_repo scope"))) {
      throw new ToolError("self-test expected outside target_repo read path to fail");
    }
    const externalDeleteOutside = buildPackage(sampleSeed("explorer-agent__codebase-scan"));
    externalDeleteOutside.task_package.runtime_context.target_repo = target;
    externalDeleteOutside.task_package.scope.delete = ["../outside-target-repo.txt"];
    if (!lintPackage(externalDeleteOutside).some((issue) => issue.includes("outside repository scope"))) {
      throw new ToolError("self-test expected outside repository delete path to fail");
    }
    const missingTarget = buildPackage(sampleSeed("explorer-agent__codebase-scan"));
    missingTarget.task_package.runtime_context.target_repo = path5.join(target, "missing");
    if (!lintPackage(missingTarget).some((issue) => issue.includes("runtime_context.target_repo not found"))) {
      throw new ToolError("self-test expected missing target_repo to fail");
    }
    const externalExpected = buildPackage(sampleSeed("docs-agent__documentation-authoring"));
    externalExpected.task_package.runtime_context.target_repo = target;
    const targetDoc = path5.join(target, "docs", "contract.md");
    externalExpected.task_package.scope.write.push(targetDoc);
    externalExpected.task_package.expected_output.file_path = targetDoc;
    externalExpected.task_package.expected_output.resolved_file_path = targetDoc;
    issues = lintPackage(externalExpected);
    if (issues.length) throw new ToolError(`self-test expected target_repo expected_output lint to pass: ${issues.join("; ")}`);
  });
  const badSections = buildPackage(seeds[2]);
  badSections.task_package.expected_output.mode = "message";
  if (!lintPackage(badSections).length) throw new ToolError("self-test expected invalid expected_output.mode to fail");
  const badVerdicts = buildPackage(seeds[2]);
  badVerdicts.task_package.handoff_contract.accept_verdicts = ["accept"];
  if (!lintPackage(badVerdicts).length) throw new ToolError("self-test expected invalid accept_verdicts to fail");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path5.resolve(process.argv[1])).href) {
  selfTest();
  process.stdout.write("task_package_lint self-test: pass\n");
}

// ops/tools/task_package_lint.mjs
var PROGRAM = "task_package_lint.mjs";
var USAGE = `usage: ${PROGRAM} [-h] [--file FILE] [--package PACKAGE] [--stdin] [--format {text,json}] [--self-test]`;
var DESCRIPTION = "\u5BF9\u5DF2\u6784\u5EFA\u7684 task_package_envelope JSON \u505A\u9759\u6001\u6821\u9A8C\uFF1A\u8DEF\u7531\u56FA\u5B9A\u5934\u5339\u914D\u3001scope \u8DEF\u5F84\u5408\u6CD5\u3001handoff \u5951\u7EA6\u5B8C\u6574\u7B49\u3002\n\u4E3B\u4EE3\u7406\u5728\u6D3E\u53D1\u524D\u6216 CI \u6D41\u6C34\u7EBF\u4E2D\u8C03\u7528\uFF0C\u786E\u8BA4\u4EFB\u52A1\u5305\u683C\u5F0F\u6B63\u786E\u3001\u4E0D\u542B\u5DF2\u77E5\u7684\u9057\u7559\u5B57\u6BB5\u548C\u7ED3\u6784\u9519\u8BEF\u3002";
var EPILOG = "\u5178\u578B\u7528\u6CD5\uFF1A\n  node task_package_lint.mjs --file notes/manifests/pkg.json\n  node task_package_build.mjs --seed seed.json | node task_package_lint.mjs --stdin\n\n\u89C4\u5219\u771F\u6E90\uFF1Aops/policies/runtime-tools.md";
var OPTIONS = [
  { flag: "--file", dest: "file", kind: "value" },
  { flag: "--package", dest: "package", kind: "value" },
  { flag: "--stdin", dest: "stdin", kind: "flag" },
  { flag: "--format", dest: "format", kind: "value", choices: ["text", "json"] },
  { flag: "--self-test", dest: "selfTest", kind: "flag" }
];
var ArgumentError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgumentError";
  }
};
var HelpRequested = class extends Error {
};
function helpText() {
  return `${USAGE}

${DESCRIPTION}

${EPILOG}
`;
}
function matchOption(token) {
  const exact = OPTIONS.find((option) => option.flag === token);
  if (exact) return exact;
  const prefixed = OPTIONS.filter((option) => option.flag.startsWith(token));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new ArgumentError(`ambiguous option: ${token} could match ${prefixed.map((option) => option.flag).join(", ")}`);
  }
  return null;
}
function parseArgs(argv) {
  const args = { file: null, package: null, stdin: false, format: "text", selfTest: false };
  const tokens = [...argv];
  while (tokens.length) {
    const token = tokens.shift();
    if (token === "-h" || token === "--help") throw new HelpRequested();
    if (!token.startsWith("--")) throw new ArgumentError(`unrecognized arguments: ${token}`);
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    const inline = equals >= 0 ? token.slice(equals + 1) : null;
    const option = matchOption(name);
    if (!option) throw new ArgumentError(`unrecognized arguments: ${token}`);
    if (option.kind === "flag") {
      if (inline !== null) throw new ArgumentError(`argument ${option.flag}: ignored explicit argument '${inline}'`);
      args[option.dest] = true;
      continue;
    }
    let value = inline;
    if (value === null) {
      if (!tokens.length) throw new ArgumentError(`argument ${option.flag}: expected one argument`);
      value = tokens.shift();
    }
    if (option.choices && !option.choices.includes(value)) {
      throw new ArgumentError(
        `argument ${option.flag}: invalid choice: '${value}' (choose from ${option.choices.map((item) => `'${item}'`).join(", ")})`
      );
    }
    args[option.dest] = value;
  }
  return args;
}
function loadPackageFromArgs(args) {
  const sources = [Boolean(args.file), Boolean(args.package), Boolean(args.stdin)];
  if (sources.filter(Boolean).length !== 1) {
    throw new ToolError("provide exactly one of --file, --package or --stdin");
  }
  if (args.stdin) return parsePackage(readStdinText("--stdin"));
  if (args.package) return loadPackage(args.package);
  return loadPackage(args.file);
}
function main(argv) {
  const args = parseArgs(argv);
  if (args.selfTest) {
    selfTest();
    process4.stdout.write("task_package_lint self-test: pass\n");
    return 0;
  }
  const pkg = loadPackageFromArgs(args);
  const issues = lintPackage(pkg);
  const data = { status: issues.length ? "fail" : "pass", issue_count: issues.length, issues };
  const text = [`status: ${data.status}`, `issue_count: ${data.issue_count}`, ...issues.map((issue) => `- ${issue}`)].join("\n");
  emit(data, args.format, text);
  return issues.length ? 1 : 0;
}
try {
  process4.exitCode = main(process4.argv.slice(2));
} catch (error) {
  if (error instanceof HelpRequested) {
    process4.stdout.write(helpText());
    process4.exitCode = 0;
  } else if (error instanceof ArgumentError) {
    process4.stderr.write(`${USAGE}
${PROGRAM}: error: ${error.message}
`);
    process4.exitCode = 2;
  } else if (["ToolError", "KeyError", "ValueError"].includes(error?.name)) {
    process4.stderr.write(`error: ${error.message}
`);
    process4.exitCode = 1;
  } else {
    throw error;
  }
}
export {
  main,
  parseArgs
};
