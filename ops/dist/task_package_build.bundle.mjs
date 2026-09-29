#!/usr/bin/env node

// ops/tools/task_package_build.mjs
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
function runGit(args) {
  const cmd = ["git", ...args.map(String)];
  const proc = spawnSync("git", args.map(String), { cwd: ROOT, encoding: "utf8", windowsHide: true });
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
function lexicalAbsolute(value) {
  return path.resolve(String(value));
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ops/tools/dispatch-core/task_package_build.mjs
import { existsSync as existsSync3, mkdirSync as mkdirSync2, writeFileSync } from "node:fs";
import os from "node:os";
import path4 from "node:path";

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

// ops/tools/dispatch-core/task_package_profiles.mjs
import { existsSync as existsSync2, readdirSync, statSync as statSync2 } from "node:fs";
import path3 from "node:path";
var ROUTE_DIR = path3.join(RUNTIME_ROOT, "ops", "protocols", "task-package-routes");
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
function loadSeed(file) {
  let raw;
  if (file === "-") {
    raw = readStdinText("--seed -");
  } else {
    try {
      raw = pyReadText(file);
    } catch (error) {
      if (error?.code === "ENOENT") throw pyError("FileNotFoundError", `[Errno 2] No such file or directory: '${file}'`);
      throw error;
    }
  }
  return parseSeed(raw);
}
function parseSeed(raw) {
  let data;
  try {
    data = pyJsonLoads(raw);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    throw new ToolError(`package_seed is not valid JSON: ${error.message}`);
  }
  if (!isRecord(data)) throw new ToolError("package_seed root must be a JSON object");
  return cleanJsonStrings(data);
}
function cleanJsonStrings(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8").toString("utf8");
  if (Array.isArray(value)) return value.map(cleanJsonStrings);
  if (isRecord(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[pyStr(cleanJsonStrings(key))] = cleanJsonStrings(item);
    return out;
  }
  return value;
}
function normRepoPath(value) {
  const projectReal = resolveLikePython(ROOT);
  const lexical = lexicalAbsolute(pathlibJoin(ROOT, value));
  const lexicalRelative = pyRelativeTo(lexical, projectReal);
  if (lexicalRelative === null) throw new ToolError(`path is outside repository scope: ${value}`);
  const resolved = resolveLikePython(lexical);
  if (pyRelativeTo(resolved, projectReal) === null && !isSameOrInside(resolved, RUNTIME_ROOT)) {
    throw new ToolError(`path is outside repository scope: ${value}`);
  }
  return lexicalRelative;
}
function repoOutputPath(value, allowedRoots, label) {
  const relPath = normRepoPath(value);
  const allowed = allowedRoots.map((root) => pyStripChars(String(root), "/").replace(/\\/g, "/"));
  if (!allowed.some((root) => relPath === root || relPath.startsWith(`${root}/`))) {
    throw new ToolError(`${label} must be under one of: ${allowedRoots.join(", ")}`);
  }
  return relPath;
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
function gitValue(args, fallback = "") {
  const result = runGit(args);
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
function buildAndWriteOutput(seed, output) {
  const localSeed = { ...seed };
  if (!pyTruthy(pyGet(localSeed, "package_id"))) {
    const routeId = routeIdFromSeed(localSeed);
    localSeed.package_id = packageId(routeId, localSeed);
  }
  const pkg = buildPackage(localSeed);
  const out = path4.join(ROOT, repoOutputPath(output, ["tmp", "notes/manifests"], "--output"));
  mkdirSync2(path4.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(pkg, null, 2)}
`.replaceAll("\n", os.EOL), "utf8");
  return pkg;
}
function renderMessage(pkg) {
  const payload = JSON.stringify(pkg, null, 2);
  return `\u8BF7\u4E25\u683C\u6267\u884C\u4EE5\u4E0B\u5B8C\u6574 task_package\u3002\u4E0D\u5F97\u7528\u81EA\u7136\u8BED\u8A00\u4EFB\u52A1\u8BF4\u660E\u66FF\u4EE3\u4EFB\u52A1\u5305\uFF1B\u5148\u6309\u516C\u5171\u63D0\u793A\u8BCD\u505A\u4EFB\u52A1\u6750\u6599\u9884\u68C0\uFF0C\u53D1\u73B0\u6750\u6599\u7F3A\u5931\u3001\u4E92\u76F8\u51B2\u7A81\u6216\u65E0\u6CD5\u5224\u65AD\u65F6\u7ACB\u5373\u8FD4\u56DE needs_owner\u3002

\`\`\`json
${payload}
\`\`\`
`;
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

// ops/tools/task_package_build.selftest.mjs
import { existsSync as existsSync4, mkdtempSync, readFileSync as readFileSync3, rmSync, unlinkSync as unlinkSync2 } from "node:fs";
import os2 from "node:os";
import path5 from "node:path";
import { pathToFileURL } from "node:url";
function withTempDir(prefix, body) {
  const dir = mkdtempSync(path5.join(os2.tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
function expectToolError(fn, failMessage) {
  try {
    fn();
  } catch (error) {
    if (error?.name === "ToolError") return;
    throw error;
  }
  throw new ToolError(failMessage);
}
function expectToolErrorContains(fn, substring, failMessage) {
  try {
    fn();
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    if (!String(error.message).includes(substring)) throw error;
    return;
  }
  throw new ToolError(failMessage);
}
function expectPasses(body, prefix) {
  try {
    body();
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    throw new ToolError(`${prefix}: ${error.message}`);
  }
}
function selfTest() {
  const seeds = Object.keys(routeProfiles()).sort().map((routeId) => sampleSeed(routeId));
  for (const seed of seeds) {
    const pkg = buildPackage(seed);
    const taskPackage = pkg.task_package;
    if (!Object.hasOwn(pkg, "task_package")) throw new ToolError("self-test package missing root");
    if (!taskPackage.agent.required_files.includes("ops/agent-prompts/_common.md")) {
      throw new ToolError("self-test package missing common prompt");
    }
    const resolvedFilePath = String(taskPackage.expected_output?.resolved_file_path ?? "");
    if (!resolvedFilePath.startsWith(String(ROOT))) {
      throw new ToolError("self-test package missing repository-root resolved_file_path");
    }
    if (taskPackage.runtime_context?.output_root !== String(ROOT)) {
      throw new ToolError("self-test package missing runtime_context.output_root");
    }
  }
  const legacy = sampleSeed("verify-agent__code-verification");
  legacy.expected_output.path = legacy.expected_output.file_path;
  delete legacy.expected_output.file_path;
  legacy.handoff_contract.final_response_required = true;
  legacy.tool_contract.network_allowed = true;
  const normalized = buildPackage(legacy).task_package;
  if (normalized.expected_output.file_path !== legacy.expected_output.path || normalized.runtime_context.network_needed !== "yes" || normalized.handoff_contract.require_final_handoff !== true) {
    throw new ToolError("self-test alias/network normalization failed");
  }
  const outputRel = "notes/manifests/task-package-build-self-test-temp.json";
  const outputPath = path5.join(ROOT, outputRel);
  if (existsSync4(outputPath)) throw new ToolError(`self-test output path already exists: ${outputRel}`);
  try {
    const outputPackage = buildAndWriteOutput(sampleSeed("verify-agent__code-verification"), outputRel);
    const stored = JSON.parse(readFileSync3(outputPath, "utf8"));
    if (stored.task_package.package_id !== outputPackage.task_package.package_id) {
      throw new ToolError("--output self-test stored package id mismatch");
    }
  } finally {
    if (existsSync4(outputPath)) unlinkSync2(outputPath);
  }
  expectToolError(() => {
    const bad = sampleSeed("verify-agent__prompt-bloat-inspection");
    delete bad.scope;
    buildPackage(bad);
  }, "self-test expected missing scope to fail");
  expectPasses(() => {
    const seed = sampleSeed("verify-agent__code-verification");
    seed.runtime_context = { network_needed: "no" };
    buildPackage(seed);
  }, "self-test expected omitted fixed consent to pass");
  expectToolError(() => {
    const bad = sampleSeed("explorer-agent__codebase-scan");
    bad.expected_output = { ...bad.expected_output, mode: "message", file_path: null };
    buildPackage(bad);
  }, "self-test expected invalid output mode to fail");
  const parentFields = sampleSeed("verify-agent__code-verification");
  parentFields.handoff_contract.parent_consume_action = "accept";
  parentFields.ownership.unlock_conditions = ["accepted"];
  const projected = buildPackage(parentFields).task_package;
  if (Object.hasOwn(projected.handoff_contract, "parent_consume_action") || Object.hasOwn(projected.ownership, "unlock_conditions")) {
    throw new ToolError("self-test expected parent lifecycle fields to be stripped");
  }
  expectToolError(() => {
    const bad = sampleSeed("verify-agent__code-verification");
    bad.scope = { ...bad.scope, read: ["../outside-repository.txt"] };
    const built = buildPackage(bad);
    normRepoPath(built.task_package.scope.read[0]);
  }, "self-test expected outside-repository path normalization to fail");
  expectToolErrorContains(
    () => {
      const bad = sampleSeed("explorer-agent__codebase-scan");
      const outsideOutput = String(path5.join(path5.dirname(ROOT), "outside-output.md"));
      bad.scope = { ...bad.scope, write: [outsideOutput] };
      bad.expected_output = { ...bad.expected_output, file_path: outsideOutput };
      buildPackage(bad);
    },
    "must resolve under repository root or runtime_context.target_repo",
    "self-test expected outside repository write path to fail"
  );
  expectPasses(() => {
    withTempDir("task-package-build-target-output-", (dir) => {
      const target = path5.resolve(dir);
      const good = sampleSeed("docs-agent__documentation-authoring");
      good.runtime_context = { ...good.runtime_context, target_repo: target };
      const targetDoc = path5.join(target, "docs", "contract.md");
      good.scope = { ...good.scope, write: [...good.scope.write, targetDoc] };
      good.expected_output = { ...good.expected_output, file_path: targetDoc };
      const pkg = buildPackage(good).task_package;
      if (path5.resolve(pkg.expected_output.resolved_file_path) !== path5.resolve(targetDoc)) {
        throw new ToolError("self-test target_repo expected_output resolved path mismatch");
      }
    });
  }, "self-test expected target_repo expected_output to pass");
  expectPasses(() => {
    withTempDir("task-package-build-target-", (dir) => {
      const target = path5.resolve(dir);
      const good = sampleSeed("executor-agent__scoped-execution");
      good.runtime_context = { ...good.runtime_context, target_repo: target };
      good.scope = { ...good.scope, write: [...good.scope.write, path5.join(target, "PROJECT.md")] };
      buildPackage(good);
    });
  }, "self-test expected target_repo scope.write to pass");
  expectPasses(() => {
    const seed = sampleSeed("explorer-agent__codebase-scan");
    seed.runtime_context = { ...seed.runtime_context, output_root: String(path5.dirname(ROOT)) };
    const body = buildPackage(seed).task_package;
    if (body.runtime_context.output_root !== String(ROOT)) throw new ToolError("compiler output_root mismatch");
  }, "self-test expected output_root to be derived");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path5.resolve(process.argv[1])).href) {
  selfTest();
  process.stdout.write("task_package_build self-test: pass\n");
}

// ops/tools/task_package_build.mjs
var PROGRAM = "task_package_build.mjs";
var USAGE = `usage: ${PROGRAM} [-h] [--seed SEED] [--seed-stdin] [--sample-route SAMPLE_ROUTE] [--output OUTPUT] [--message] [--print-json] [--list-routes] [--self-test]`;
var DESCRIPTION = "\u5C06\u4E3B\u4EE3\u7406\u586B\u5199\u7684 package_seed JSON \u6821\u9A8C\u5E76\u7EC4\u88C5\u6210\u5B8C\u6574\u7684 task_package_envelope JSON\u3002\n\u65E5\u5E38\u6D3E\u53D1\u8BF7\u76F4\u63A5\u7528 dispatch_prepare.mjs\uFF08\u5DF2\u5C01\u88C5\u672C\u6B65\u9AA4\uFF09\uFF1B\u672C\u5DE5\u5177\u7528\u4E8E\u5355\u72EC\u6784\u5EFA\u5E76\u68C0\u89C6\u5B8C\u6574\u5305\uFF0C\u6216\u8C03\u8BD5\u6784\u5305\u95EE\u9898\u3002";
var EPILOG = "\u5178\u578B\u7528\u6CD5\uFF1A\n  node task_package_build.mjs --seed seed.json --output notes/manifests/pkg.json\n  node task_package_build.mjs --sample-route verify-agent__code-verification --message\n  node task_package_build.mjs --list-routes\n\n\u89C4\u5219\u771F\u6E90\uFF1Aops/policies/runtime-tools.md";
var OPTIONS = [
  { flag: "--seed", dest: "seed", kind: "value" },
  { flag: "--seed-stdin", dest: "seedStdin", kind: "flag" },
  { flag: "--sample-route", dest: "sampleRoute", kind: "value" },
  { flag: "--output", dest: "output", kind: "value" },
  { flag: "--message", dest: "message", kind: "flag" },
  { flag: "--print-json", dest: "printJson", kind: "flag" },
  { flag: "--list-routes", dest: "listRoutes", kind: "flag" },
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
  const args = {
    seed: null,
    seedStdin: false,
    sampleRoute: null,
    output: null,
    message: false,
    printJson: false,
    listRoutes: false,
    selfTest: false
  };
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
    args[option.dest] = value;
  }
  return args;
}
function loadSeedFromArgs(args) {
  const sources = [Boolean(args.seed), Boolean(args.seedStdin), Boolean(args.sampleRoute)];
  if (sources.filter(Boolean).length !== 1) {
    throw new ToolError("provide exactly one of --seed, --seed-stdin or --sample-route");
  }
  if (args.sampleRoute) return sampleSeed(args.sampleRoute);
  if (args.seedStdin) return parseSeed(readStdinText("--seed-stdin"));
  return loadSeed(args.seed);
}
function main(argv) {
  const args = parseArgs(argv);
  if (args.listRoutes) {
    process4.stdout.write(`${Object.keys(routeProfiles()).sort().join("\n")}
`);
    return 0;
  }
  if (args.selfTest) {
    selfTest();
    process4.stdout.write("task_package_build self-test: pass\n");
    return 0;
  }
  if (args.message && args.printJson) {
    throw new ToolError("--message and --print-json cannot be used together");
  }
  const seed = loadSeedFromArgs(args);
  const pkg = args.output ? buildAndWriteOutput(seed, args.output) : buildPackage(seed);
  if (args.message) {
    process4.stdout.write(`${renderMessage(pkg)}
`);
  } else if (args.output && !args.printJson) {
    const taskPackage = pkg.task_package;
    process4.stdout.write(
      `wrote output=${normRepoPath(args.output)} package_id=${taskPackage.package_id} route_id=${seed.route_id ?? ""}
`
    );
  } else {
    process4.stdout.write(`${JSON.stringify(pkg, null, 2)}
`);
  }
  return 0;
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
