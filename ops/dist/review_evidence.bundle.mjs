#!/usr/bin/env node

// ops/tools/review_evidence.mjs
import process5 from "node:process";

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
import path from "node:path";
import process from "node:process";
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
function isAbsoluteLikePython(value) {
  const text = String(value ?? "");
  if (process.platform !== "win32") return text.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(text) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(text);
}
function pathlibJoin(base, other) {
  const text = String(other ?? "");
  if (isAbsoluteLikePython(text)) return text;
  if (process.platform === "win32" && /^[\\/]/.test(text)) {
    const drive = path.parse(path.resolve(String(base))).root.replace(/[\\/]+$/, "");
    return `${drive}${text}`;
  }
  return path.join(String(base), text);
}
function resolveLikePython(value) {
  const absolute = path.resolve(String(value));
  let current = absolute;
  const tail2 = [];
  while (true) {
    try {
      const real = realpathSync.native(current);
      return tail2.length ? path.join(real, ...tail2.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail2.push(path.basename(current));
      current = parent;
    }
  }
}
function repoRoot() {
  const explicit = String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim();
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
  let cur = resolveLikePython(process.cwd());
  while (true) {
    if (existsSync(path.join(cur, ".git")) || existsSync(path.join(cur, "AGENTS.md")) && existsSync(path.join(cur, "ops"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new ToolError(`cannot locate cockpit repository root from ${resolveLikePython(process.cwd())}`);
}
function declaredDirectory(envKey) {
  const explicit = String(process.env[envKey] || "").trim();
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
  if (String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const cwd = resolveLikePython(process.cwd());
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
  if (String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (existsSync(path.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  return repoRoot();
}
var ROOT = projectRoot();
var RUNTIME_ROOT = runtimeRoot();
function lexicalAbsolute(value) {
  return path.resolve(String(value));
}
function absolutePath(value, label, { error = ToolError } = {}) {
  const candidate = String(value);
  if (!isAbsoluteLikePython(candidate)) throw new error(`${label} must be absolute: ${value}`);
  return path.resolve(candidate);
}
function isReparseStat(info) {
  return Boolean(info?.isSymbolicLink?.());
}
function componentsOf(candidate) {
  const parsed = path.parse(candidate);
  const rest = candidate.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  return { anchor: parsed.root, parts: rest };
}
function assertNoReparseComponents(value, { allowMissing = false, label = "path", error = ToolError } = {}) {
  const candidate = absolutePath(value, label, { error });
  const { anchor, parts } = componentsOf(candidate);
  let current = anchor;
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (caught) {
      if (caught?.code === "ENOENT") {
        if (allowMissing) return;
        throw new error(`${label} component does not exist: ${current}`);
      }
      throw new error(`cannot inspect ${label} component ${current}: ${caught.message}`);
    }
    if (info.isSymbolicLink() || isReparseStat(info)) throw new error(`symlink/reparse ${label} is not permitted: ${current}`);
  }
}
function ensureControlledDirectory(value, { mode = 448, label = "controlled directory", error = ToolError } = {}) {
  const candidate = absolutePath(value, label, { error });
  const { anchor, parts } = componentsOf(candidate);
  let current = anchor;
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (caught) {
      if (caught?.code !== "ENOENT") throw new error(`cannot inspect ${label} ${current}: ${caught.message}`);
      try {
        mkdirSync(current, { mode });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw new error(`cannot create ${label} ${current}: ${mkdirError.message}`);
      }
      try {
        info = lstatSync(current);
      } catch (recheck) {
        throw new error(`cannot recheck ${label} ${current}: ${recheck.message}`);
      }
    }
    if (!info.isDirectory() || info.isSymbolicLink() || isReparseStat(info)) throw new error(`${label} is not a real directory: ${current}`);
  }
  return candidate;
}
function assertRegularFile(value, label, { error = ToolError } = {}) {
  const checked = absolutePath(value, label, { error });
  assertNoReparseComponents(path.dirname(checked), { allowMissing: false, error });
  let info;
  try {
    info = lstatSync(checked);
  } catch {
    throw new error(`${label} is unavailable: ${checked}`);
  }
  if (!info.isFile() || info.isSymbolicLink() || isReparseStat(info)) throw new error(`${label} is not a regular file: ${checked}`);
}
function atomicWriteBytes(value, data, { ensureParent = false, label = "write destination", error = ToolError } = {}) {
  const target = absolutePath(value, label, { error });
  if (ensureParent) ensureControlledDirectory(path.dirname(target), { error });
  assertNoReparseComponents(path.dirname(target), { allowMissing: false, error });
  let existing = null;
  try {
    existing = lstatSync(target);
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw new error(`cannot inspect ${label} ${target}: ${caught.message}`);
  }
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || isReparseStat(existing))) {
    throw new error(`${label} is not a regular file: ${target}`);
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${ids.uuidHex()}`);
  let fd = null;
  try {
    fd = openSync(temp, "wx", 384);
    const info = fstatSync(fd);
    if (!info.isFile()) throw new error(`temporary write is not a regular file: ${temp}`);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    assertNoReparseComponents(path.dirname(target), { allowMissing: false, error });
    let current = null;
    try {
      current = lstatSync(target);
    } catch (caught) {
      if (caught?.code !== "ENOENT") throw new error(`cannot recheck ${label} ${target}: ${caught.message}`);
    }
    if (current && (!current.isFile() || current.isSymbolicLink() || isReparseStat(current))) {
      throw new error(`${label} changed to a non-regular file: ${target}`);
    }
    renameSync(temp, target);
    assertRegularFile(target, "written file", { error });
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
    }
  }
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ops/tools/review_evidence.selftest.mjs
import { mkdirSync as mkdirSync2, mkdtempSync, readFileSync as readFileSync3, rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path5 from "node:path";
import process4 from "node:process";

// ops/tools/dispatch-core/review_evidence.mjs
import { spawnSync } from "node:child_process";
import { opendirSync, readdirSync, statSync as statSync2 } from "node:fs";
import path4 from "node:path";
import process3 from "node:process";

// ops/tools/dispatch-core/_py.mjs
import { readFileSync as readFileSync2 } from "node:fs";
import path2 from "node:path";
import process2 from "node:process";
var PY_SPACE_CLASS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
var PY_SPACE_RE = new RegExp(`[${PY_SPACE_CLASS}]`);
var RE_LSTRIP = new RegExp(`^[${PY_SPACE_CLASS}]+`);
var RE_RSTRIP = new RegExp(`[${PY_SPACE_CLASS}]+$`);
var RE_LINE_BOUNDARY = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/;
var NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
function pyStrip(value) {
  return String(value ?? "").replace(RE_LSTRIP, "").replace(RE_RSTRIP, "");
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
function pyFloat(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const text = pyStrip(value).replace(/(?<=[0-9])_(?=[0-9])/g, "");
    if (/^[+-]?(?:inf|infinity)$/i.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(text)) return Number.NaN;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
      throw pyError("ValueError", `could not convert string to float: ${pyRepr(value)}`);
    }
    return Number(text);
  }
  throw pyError("TypeError", `float() argument must be a string or a real number, not '${pyTypeName(value)}'`);
}
function pyJsonDumps(value, { compact = false } = {}) {
  const itemSep = compact ? "," : ", ";
  const keySep = compact ? ":" : ": ";
  const walk = (item) => {
    if (item === null || item === void 0) return "null";
    if (Array.isArray(item)) return `[${item.map(walk).join(itemSep)}]`;
    if (typeof item === "object") {
      return `{${Object.entries(item).filter(([, entry]) => entry !== void 0).map(([key, entry]) => `${JSON.stringify(String(key))}${keySep}${walk(entry)}`).join(itemSep)}}`;
    }
    return JSON.stringify(item);
  };
  return walk(value);
}
function pyReadTextReplace(file) {
  return readFileSync2(file, "utf8").replace(/\r\n?/g, "\n");
}
function pyNormcase(value) {
  const text = String(value);
  return process2.platform === "win32" ? text.replace(/\//g, "\\").toLowerCase() : text;
}
function pathAnchor(root) {
  if (process2.platform !== "win32") return root;
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
  return anchor + parts.join(process2.platform === "win32" ? "\\" : "/");
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
  const tail2 = pathParts(child).parts.slice(pathParts(parent).parts.length);
  return tail2.length ? tail2.join("/") : ".";
}

// ops/tools/dispatch-core/task_package_profiles.mjs
import path3 from "node:path";
var ROUTE_DIR = path3.join(RUNTIME_ROOT, "ops", "protocols", "task-package-routes");

// ops/tools/dispatch-core/task_package_build.mjs
var TRUTHY_TEXT = /* @__PURE__ */ new Set(["1", "true", "yes", "y", "on"]);
function truthyText(value) {
  const base = pyTruthy(value) ? value : "";
  return TRUTHY_TEXT.has(pyStrip(pyStr(base)).toLowerCase());
}

// ops/tools/dispatch-core/review_evidence.mjs
var PROFILE = "evidence_only_v1";
var ASSISTED_PROFILE = "evidence_assisted_v1";
var SEMANTIC_PROFILE = "semantic_review_v2";
var SEMANTIC_INJECTION_TOKEN_LIMIT = 2e5;
var SEMANTIC_FULL_CONTENT_BYTE_CEILING = SEMANTIC_INJECTION_TOKEN_LIMIT * 3;
var SEMANTIC_COMPLETE_INDEX_FILE_CAP = 2048;
var SEMANTIC_TARGET_CONTENT_BYTE_BUDGET = 6e4;
var SEMANTIC_OMISSION_DIR_CAP = 32;
var REGENERATED_TREE_REASONS = /* @__PURE__ */ new Map([
  [".git", "vcs_metadata"],
  [".runtime", "regenerated_runtime"],
  ["node_modules", "dependency_tree"]
]);
var semanticScanSlot = null;
var REVIEW_ROUTES = {
  "verify-agent__code-verification": { kind: "evidence", contract_slot: "verify" },
  "verify-agent__anti-defensive-inspection": { kind: "evidence", contract_slot: "anti_defensive_inspection" },
  "verify-agent__prompt-bloat-inspection": { kind: "evidence", contract_slot: "prompt_bloat_inspection" },
  "semantic-review-agent__rule-quality-inspection": { kind: "semantic", contract_slot: "rule_quality_inspection" },
  "semantic-review-agent__contract-drift-inspection": { kind: "semantic", contract_slot: "contract_drift_inspection" }
};
var SEMANTIC_REVIEW_ROUTES = new Set(
  Object.entries(REVIEW_ROUTES).filter(([, spec]) => spec.kind === "semantic").map(([rid]) => rid)
);
var STATIC_REVIEW_ROUTES = new Set(Object.keys(REVIEW_ROUTES));
var CONTRACT_SLOTS = Object.fromEntries(
  Object.entries(REVIEW_ROUTES).map(([rid, spec]) => [rid, spec.contract_slot])
);
function statOrNull(value) {
  try {
    return statSync2(value);
  } catch {
    return null;
  }
}
function pathExists(value) {
  return statOrNull(value) !== null;
}
function pathIsDir(value) {
  return Boolean(statOrNull(value)?.isDirectory());
}
function decodeTruncated(buffer, limit) {
  const cap = Math.max(0, Math.min(limit, buffer.length));
  let end = cap;
  if (cap < buffer.length) {
    let index = cap - 1;
    let trailing = 0;
    while (index >= 0 && (buffer[index] & 192) === 128) {
      index -= 1;
      trailing += 1;
    }
    if (index >= 0) {
      const lead = buffer[index];
      const needed = lead >= 240 ? 3 : lead >= 224 ? 2 : lead >= 192 ? 1 : 0;
      if (trailing < needed) end = index;
    }
  }
  return buffer.subarray(0, end).toString("utf8");
}
function assertReviewRoutesConsistent(routes = null) {
  const checked = routes === null || routes === void 0 ? REVIEW_ROUTES : routes;
  for (const [rid, spec] of Object.entries(checked)) {
    const kind = isRecord(spec) ? spec.kind : void 0;
    if (!["evidence", "semantic"].includes(kind)) {
      throw new ToolError(`REVIEW_ROUTES[${rid}].kind \u4E0D\u5728\u95ED\u96C6 evidence|semantic: ${pyRepr(kind ?? null)}`);
    }
    const slot = isRecord(spec) ? spec.contract_slot : void 0;
    if (typeof slot !== "string" || !slot.trim()) {
      throw new ToolError(`REVIEW_ROUTES[${rid}].contract_slot \u7F3A\u5931\u6216\u4E3A\u7A7A`);
    }
  }
  return null;
}
assertReviewRoutesConsistent();
var TARGET_KEYS = ["target_files", "affected_files", "truth_sources", "downstream_truth_sources"];
var TOKEN_RE = /[A-Za-z_][A-Za-z0-9_.-]{2,}/g;
function assertNoReparse(value, { allowMissing = false } = {}) {
  assertNoReparseComponents(value, { allowMissing, label: "evidence path" });
}
function ensureDirectory(value) {
  return ensureControlledDirectory(value, { label: "evidence directory" });
}
function routeId(pkg) {
  const agent = isRecord(pkg?.agent) ? pkg.agent : {};
  const capability = isRecord(agent.capability) ? agent.capability : {};
  const role = String(agent.role || "");
  const name = String(capability.name || "");
  return `${role}__${name}`;
}
function capabilityContract(pkg, rid) {
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  const contracts = isRecord(extensions.capability_contract) ? extensions.capability_contract : {};
  if (!Object.hasOwn(CONTRACT_SLOTS, rid)) throw pyError("KeyError", pyRepr(rid));
  const value = contracts[CONTRACT_SLOTS[rid]];
  return isRecord(value) ? value : {};
}
function reviewRoot(pkg) {
  const runtime = isRecord(pkg?.runtime_context) ? pkg.runtime_context : {};
  const target = runtime.target_repo;
  if (typeof target === "string" && target.trim()) return resolveLikePython(target);
  const cwd = runtime.cwd;
  if (typeof cwd === "string" && cwd.trim()) return resolveLikePython(cwd);
  return resolveLikePython(ROOT);
}
function uniqueStrings(values) {
  const result = [];
  for (const value of values) {
    if (typeof value === "string" && value.trim() && !result.includes(value)) result.push(value);
  }
  return result;
}
function declaredTargets(contract) {
  const values = [];
  for (const key of TARGET_KEYS) {
    const item = contract?.[key];
    if (Array.isArray(item)) values.push(...item);
  }
  return uniqueStrings(values);
}
function resolveScopedPath(root, value) {
  const rootPath = lexicalAbsolute(root);
  const target = isAbsoluteLikePython(value) ? lexicalAbsolute(value) : lexicalAbsolute(pathlibJoin(rootPath, value));
  assertNoReparse(rootPath, { allowMissing: true });
  assertNoReparse(target, { allowMissing: true });
  const resolved = resolveLikePython(target);
  const resolvedRoot = resolveLikePython(rootPath);
  if (!pyIsRelativeTo(resolved, resolvedRoot)) {
    throw new ToolError(
      `review evidence path escapes review root: ${value} (review root: ${resolvedRoot}; \u76EE\u6807\u5728\u53E6\u4E00\u4ED3\u65F6\u7528 dispatch_prepare --async-target-cwd \u6307\u5411\u8BE5\u4ED3\uFF0Cscope \u5199\u8BE5\u4ED3\u5185\u8DEF\u5F84)`
    );
  }
  return target;
}
function relTo(root, target) {
  return pyRelativeToPosix(resolveLikePython(target), resolveLikePython(root));
}
function run(argv, cwd, timeout = 30) {
  const started = process3.hrtime.bigint();
  const elapsed = () => Math.round(Number(process3.hrtime.bigint() - started) / 1e6 * 1e3) / 1e3;
  const command = argv.map(String);
  const completed = spawnSync(command[0], command.slice(1), {
    cwd: String(cwd),
    encoding: "utf8",
    timeout: Math.round(pyFloat(timeout) * 1e3),
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (completed.error) {
    if (completed.error.code === "ETIMEDOUT" || completed.signal) {
      return {
        exit_code: null,
        stdout: String(completed.stdout ?? ""),
        stderr: String(completed.stderr ?? ""),
        timed_out: true,
        duration_ms: elapsed()
      };
    }
    return {
      exit_code: null,
      stdout: "",
      stderr: String(completed.error.message ?? completed.error),
      timed_out: false,
      duration_ms: elapsed()
    };
  }
  return {
    exit_code: completed.status,
    stdout: String(completed.stdout ?? ""),
    stderr: String(completed.stderr ?? ""),
    timed_out: false,
    duration_ms: elapsed()
  };
}
function git(root, args, timeout = 30) {
  return run(["git", "-C", String(root), ...args], root, timeout);
}
function tail(text, limit = 600) {
  const value = String(text || "");
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  return [...value].slice(-limit).join("");
}
function checkOutputSummary(stdout, stderr, limit = 2e3) {
  const combined = `${stdout || ""}${stderr || ""}`.trim();
  if (!combined) return "";
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ""));
  } catch {
    return tail(combined, limit);
  }
  if (!isRecord(parsed)) return tail(pyJsonDumps(parsed, { compact: true }), limit);
  const summary = {};
  for (const key of ["status", "ok", "applied", "build_id", "windows_path_replacement", "verification", "metrics"]) {
    if (Object.hasOwn(parsed, key)) summary[key] = parsed[key];
  }
  const checks = parsed.checks;
  if (isRecord(checks)) {
    const failed = Object.entries(checks).filter(([, value]) => value === false).map(([key]) => String(key));
    summary.checks = { total: Object.keys(checks).length, failed };
  }
  const compact = pyJsonDumps(Object.keys(summary).length ? summary : parsed, { compact: true });
  return tail(compact, limit);
}
function surfacePath(surface, candidates) {
  const normalized = String(surface).replace(/\\/g, "/");
  const matches = candidates.filter((item) => normalized.includes(String(item).replace(/\\/g, "/")));
  if (!matches.length) return null;
  let best = matches[0];
  for (const item of matches) if (item.length > best.length) best = item;
  return best;
}
var SURFACE_RANGE_RE = /(?<![\p{L}\p{N}_.])(\d{1,6})\s*[-–]\s*(\d{1,6})(?![\p{L}\p{N}_.])/u;
var SURFACE_RANGE_MAX_LINES = 240;
function surfaceExcerpt(target, surface, maxLines = 10) {
  const lines = pySplitLines(pyReadTextReplace(target));
  const text = String(surface);
  const descriptor = text.includes(":") ? text.slice(text.indexOf(":") + 1) : text;
  const rangeMatch = SURFACE_RANGE_RE.exec(descriptor);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    let end = Number(rangeMatch[2]);
    if (start >= 1 && start <= end) {
      end = Math.min(end, lines.length, start + SURFACE_RANGE_MAX_LINES - 1);
      if (start <= lines.length) {
        const picked = [];
        for (let index = start - 1; index < end; index += 1) picked.push(`${index + 1}: ${lines[index]}`);
        return { surface: text, lines: picked };
      }
    }
  }
  const tokens = uniqueStrings(
    (descriptor.match(TOKEN_RE) || []).filter((token) => !["path", "file", "line"].includes(token.toLowerCase())).map((token) => token.toLowerCase())
  );
  const scored = [];
  lines.forEach((line, index) => {
    const folded = line.toLowerCase();
    const matched = tokens.filter((token) => folded.includes(token));
    if (matched.length) scored.push([matched.length, matched.reduce((sum, token) => sum + token.length, 0), index]);
  });
  scored.sort((left, right) => right[0] - left[0] || right[1] - left[1] || left[2] - right[2]);
  let hits = scored.slice(0, 2).map((item) => item[2]);
  if (!hits.length) hits = lines.length ? [0] : [];
  const selected = [];
  for (const hit of hits.slice(0, 2)) {
    for (let index = Math.max(0, hit - 1); index < Math.min(lines.length, hit + 2); index += 1) {
      if (!selected.includes(index)) selected.push(index);
      if (selected.length >= maxLines) break;
    }
    if (selected.length >= maxLines) break;
  }
  return { surface: text, lines: selected.map((index) => `${index + 1}: ${lines[index]}`) };
}
function sourceEvidence(root, rid, contract, scopeRead, byteBudget) {
  const targets = declaredTargets(contract);
  const changed = Array.isArray(contract?.changed_surfaces) ? uniqueStrings(contract.changed_surfaces) : [];
  const items = [];
  const errors = [];
  let used = 0;
  let complete = true;
  for (const value of uniqueStrings([...targets, ...scopeRead])) {
    let target;
    try {
      target = resolveScopedPath(root, value);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      errors.push(error.message);
      complete = false;
      continue;
    }
    const entry = { path: value };
    if (!pathExists(target)) {
      entry.exists = false;
      errors.push(`missing review source: ${value}`);
      complete = false;
      items.push(entry);
      continue;
    }
    if (pathIsDir(target)) {
      entry.kind = "directory";
      entry.entries = readdirSync(target).length;
      complete = false;
      items.push(entry);
      continue;
    }
    const matchingSurfaces = changed.filter((surface) => surfacePath(surface, [value]));
    if (matchingSurfaces.length) {
      entry.excerpts = matchingSurfaces.map((surface) => surfaceExcerpt(target, surface));
      const encoded = Buffer.byteLength(pyJsonDumps(entry.excerpts), "utf8");
      if (used + encoded > byteBudget) {
        entry.excerpts = entry.excerpts.slice(0, 1);
        entry.truncated = true;
        complete = false;
      } else {
        used += encoded;
      }
    }
    if (targets.includes(value)) {
      const content = pyReadTextReplace(target);
      const encoded = Buffer.from(content, "utf8");
      const remaining = Math.max(0, byteBudget - used);
      if (encoded.length <= remaining) {
        entry.content = content;
        used += encoded.length;
      } else {
        entry.content = decodeTruncated(encoded, remaining);
        entry.truncated = true;
        complete = false;
        used = byteBudget;
      }
    }
    items.push(entry);
  }
  return [items, errors, complete];
}
function estimatedTokens(value) {
  const payload = pyJsonDumps(value, { compact: true });
  return Math.floor((Buffer.byteLength(payload, "utf8") + 2) / 3);
}
function compareNormPath(left, right) {
  const a = pyNormcase(left);
  const b = pyNormcase(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
function noteUnenumeratedDirectory(state, abs, reason) {
  state.skipped = true;
  if (state.unenumeratedDirectories.length >= SEMANTIC_OMISSION_DIR_CAP) {
    state.unenumeratedDirectoryOverflow += 1;
    return;
  }
  let relative = abs;
  try {
    relative = relTo(state.root, abs);
  } catch {
  }
  state.unenumeratedDirectories.push({ path: relative, reason });
}
function addSemanticFile(state, abs, role, options = {}) {
  const relative = relTo(state.root, abs);
  const seenKey = pyNormcase(abs);
  const declaredFile = options.declaredFile === true;
  if (state.seen.has(seenKey)) {
    const entry = state.items.get(relative);
    if (!entry && declaredFile) {
      let bytes2 = 0;
      try {
        bytes2 = statSync2(abs).size;
      } catch {
        bytes2 = 0;
      }
      state.meta.set(relative, { abs, bytes: bytes2 });
      state.items.set(relative, { path: relative, declared_as: [role] });
      return;
    }
    if (entry && !entry.declared_as.includes(role)) entry.declared_as.push(role);
    return;
  }
  state.seen.add(seenKey);
  let bytes = 0;
  try {
    bytes = statSync2(abs).size;
  } catch {
    bytes = 0;
  }
  state.enumeratedFiles += 1;
  state.enumeratedBytes += bytes;
  if (!declaredFile && state.storedExpanded >= SEMANTIC_COMPLETE_INDEX_FILE_CAP) {
    state.overCap = true;
    state.omittedFileCount += 1;
    return;
  }
  if (!declaredFile) state.storedExpanded += 1;
  state.meta.set(relative, { abs, bytes });
  state.items.set(relative, { path: relative, declared_as: [role] });
}
function walkSemanticDirectory(state, dir, role) {
  const found = [];
  let streaming = false;
  const visitFile = (full) => {
    if (streaming) {
      addSemanticFile(state, full, role);
      return;
    }
    found.push(full);
    if (found.length > SEMANTIC_COMPLETE_INDEX_FILE_CAP) {
      streaming = true;
      for (const item of found) addSemanticFile(state, item, role);
      found.length = 0;
    }
  };
  const walk = (current) => {
    let handle;
    try {
      handle = opendirSync(current);
    } catch {
      return;
    }
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        const full = path4.join(current, entry.name);
        if (entry.isDirectory()) {
          const reason = REGENERATED_TREE_REASONS.get(entry.name);
          if (reason) {
            noteUnenumeratedDirectory(state, full, reason);
            continue;
          }
          walk(full);
          continue;
        }
        visitFile(full);
      }
    } catch {
      noteUnenumeratedDirectory(state, current, "unreadable");
    } finally {
      handle.closeSync();
    }
  };
  walk(dir);
  if (!streaming) {
    found.sort(compareNormPath);
    for (const item of found) addSemanticFile(state, item, role);
  }
}
function finalizeSemanticSources(state) {
  const enumerationComplete = !state.skipped && !state.overCap && state.omittedFileCount === 0;
  const scopeDirectoryDeclared = state.scopeReadDirectories.length > 0;
  const fullCandidate = !scopeDirectoryDeclared && enumerationComplete && state.enumeratedBytes <= SEMANTIC_FULL_CONTENT_BYTE_CEILING && projectedSemanticTokens(state.enumeratedBytes, state.enumeratedFiles) <= SEMANTIC_INJECTION_TOKEN_LIMIT;
  const mode = fullCandidate ? "full_candidate" : enumerationComplete ? "complete_index" : "bounded_index";
  if (mode === "full_candidate") {
    for (const [relative, entry] of state.items) {
      const meta = state.meta.get(relative);
      entry.content = pyReadTextReplace(meta.abs);
      state.contentBytesRead += meta.bytes;
    }
  } else {
    let remaining = SEMANTIC_TARGET_CONTENT_BYTE_BUDGET;
    for (const [relative, entry] of state.items) {
      if (!entry.declared_as.includes("target")) continue;
      const meta = state.meta.get(relative);
      if (meta.bytes <= remaining) {
        entry.content = pyReadTextReplace(meta.abs);
        remaining -= meta.bytes;
        state.contentBytesRead += meta.bytes;
      } else {
        state.targetContentOmitted.push(relative);
      }
    }
  }
  return {
    mode,
    scopeDirectoryDeclared,
    scopeReadDirectories: state.scopeReadDirectories,
    enumerationComplete,
    enumeratedFiles: state.enumeratedFiles,
    enumeratedBytes: state.enumeratedBytes,
    omittedFileCount: state.omittedFileCount,
    unenumeratedDirectories: state.unenumeratedDirectories,
    unenumeratedDirectoryOverflow: state.unenumeratedDirectoryOverflow,
    contentBytesRead: state.contentBytesRead,
    targetContentOmitted: state.targetContentOmitted
  };
}
function semanticSourceEvidence(root, contract, scopeRead) {
  const state = {
    root,
    items: /* @__PURE__ */ new Map(),
    meta: /* @__PURE__ */ new Map(),
    seen: /* @__PURE__ */ new Set(),
    enumeratedFiles: 0,
    enumeratedBytes: 0,
    omittedFileCount: 0,
    storedExpanded: 0,
    overCap: false,
    skipped: false,
    unenumeratedDirectories: [],
    unenumeratedDirectoryOverflow: 0,
    contentBytesRead: 0,
    targetContentOmitted: [],
    scopeReadDirectories: []
  };
  const errors = [];
  const declarations = [
    ...declaredTargets(contract).map((value) => [value, "target"]),
    ...scopeRead.map((value) => [value, "scope_read"])
  ];
  for (const [value, role] of declarations) {
    let declaredPath;
    try {
      declaredPath = resolveScopedPath(root, value);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      errors.push(error.message);
      continue;
    }
    if (!pathExists(declaredPath)) {
      errors.push(`missing review source: ${value}`);
      continue;
    }
    if (pathIsDir(declaredPath)) {
      if (role === "scope_read") {
        try {
          state.scopeReadDirectories.push(relTo(root, declaredPath));
        } catch {
          state.scopeReadDirectories.push(String(value));
        }
      }
      walkSemanticDirectory(state, declaredPath, role);
    } else addSemanticFile(state, declaredPath, role, { declaredFile: true });
  }
  semanticScanSlot = finalizeSemanticSources(state);
  return [[...state.items.values()], errors, errors.length === 0];
}
function scopedGitEvidence(root, paths, patchBudget, changeBase = null) {
  let repoPaths = [];
  for (const value of paths) {
    let target;
    try {
      target = resolveScopedPath(root, value);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      continue;
    }
    if (pyIsRelativeTo(target, root)) repoPaths.push(relTo(root, target));
  }
  repoPaths = uniqueStrings(repoPaths);
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.exit_code !== 0) {
    return { mode: "not_a_repo", path_count: repoPaths.length, error: tail(inside.stderr) };
  }
  let base = null;
  if (changeBase !== null) {
    const resolved = git(root, ["rev-parse", "--verify", "--end-of-options", `${changeBase}^{commit}`]);
    if (resolved.exit_code !== 0) {
      return { mode: "invalid_base", change_base: changeBase, path_count: repoPaths.length, error: tail(resolved.stderr) };
    }
    base = String(resolved.stdout || "").trim();
  }
  const diffFrom = base ?? "HEAD";
  const suffix = repoPaths.length ? ["--", ...repoPaths] : [];
  const head = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--short", "--untracked-files=all", ...suffix]);
  const stat = git(root, ["diff", "--stat", diffFrom, ...suffix]);
  const result = {
    mode: "git",
    base,
    head: String(head.stdout || "").trim(),
    path_count: repoPaths.length,
    scoped_status: pySplitLines(String(status.stdout || "")),
    diff_stat: String(stat.stdout || "").trim()
  };
  if (patchBudget > 0) {
    const patch = git(root, ["diff", "--no-ext-diff", "--unified=2", diffFrom, ...suffix]);
    const patchText = String(patch.stdout || "");
    const patchBuffer = Buffer.from(patchText, "utf8");
    result.patch_excerpt = decodeTruncated(patchBuffer, patchBudget);
    result.patch_bytes = patchBuffer.length;
    result.patch_truncated = patchBuffer.length > patchBudget;
  }
  return result;
}
function validateCheck(raw, root) {
  if (!isRecord(raw)) throw new ToolError("mechanical_checks entries must be objects");
  const checkId = String(raw.id || "").trim();
  const argv = raw.argv;
  if (!checkId || !Array.isArray(argv) || !argv.length || !argv.every((item) => typeof item === "string" && item)) {
    throw new ToolError("mechanical check requires id and non-empty string argv");
  }
  const cwd = resolveScopedPath(root, String(raw.cwd || "."));
  if (!pathIsDir(cwd)) throw new ToolError(`mechanical check cwd is not a directory: ${cwd}`);
  const timeout = pyFloat(Object.hasOwn(raw, "timeout_seconds") ? raw.timeout_seconds : 120);
  if (timeout <= 0 || timeout > 600) throw new ToolError("mechanical check timeout_seconds must be in (0, 600]");
  const expected = Object.hasOwn(raw, "expected_exit_codes") ? raw.expected_exit_codes : [0];
  if (!Array.isArray(expected) || !expected.length || !expected.every((item) => typeof item === "boolean" || typeof item === "number" && Number.isInteger(item))) {
    throw new ToolError("mechanical check expected_exit_codes must be a non-empty integer list");
  }
  const codes = [...new Set(expected.map((item) => typeof item === "boolean" ? Number(item) : item))].sort(
    (left, right) => left - right
  );
  return [checkId, argv, cwd, timeout, codes];
}
function atomicWriteBytes2(target, payload) {
  const destination = lexicalAbsolute(target);
  try {
    atomicWriteBytes(destination, payload, { ensureParent: true, label: "evidence destination" });
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`cannot atomically write evidence file ${destination}: ${error?.message ?? error}`);
  }
  return null;
}
function atomicWriteText(target, text) {
  atomicWriteBytes2(target, Buffer.from(String(text), "utf8"));
  return null;
}
function executeChecks(root, checks, logRoot) {
  const results = [];
  ensureDirectory(logRoot);
  for (const raw of checks) {
    const [checkId, argv, cwd, timeout, expected] = validateCheck(raw, root);
    const result = run(argv, cwd, timeout);
    const safe = checkId.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80);
    const logPath = path4.join(String(logRoot), `${safe}.log`);
    atomicWriteText(
      logPath,
      `argv=${pyJsonDumps(argv)}
cwd=${cwd}
exit_code=${result.exit_code === null ? "None" : result.exit_code}
timed_out=${String(result.timed_out).toLowerCase()}

[stdout]
${result.stdout}
[stderr]
${result.stderr}`
    );
    const passed = expected.includes(result.exit_code) && !result.timed_out;
    const outputTail = checkOutputSummary(String(result.stdout || ""), String(result.stderr || ""));
    let visibleLog;
    try {
      visibleLog = pyRelativeToPosix(logPath, ROOT);
    } catch {
      visibleLog = String(logPath);
    }
    const checkResult = {
      id: checkId,
      argv,
      cwd: String(cwd),
      exit_code: result.exit_code,
      passed,
      timed_out: result.timed_out,
      duration_ms: result.duration_ms,
      output_tail: outputTail,
      log_path: visibleLog
    };
    if (!(expected.length === 1 && expected[0] === 0)) checkResult.expected_exit_codes = expected;
    results.push(checkResult);
  }
  return results;
}
function projectedSemanticTokens(enumeratedBytes, enumeratedFiles) {
  const overhead = enumeratedFiles * 96 + 1024;
  return Math.floor((enumeratedBytes + overhead + 2) / 3);
}
function semanticIndexComplete(scan) {
  return scan.mode !== "bounded_index" && scan.enumerationComplete && scan.omittedFileCount === 0;
}
function semanticMaterialOmissions(scan) {
  return {
    index_complete: semanticIndexComplete(scan),
    omitted_file_count: scan.omittedFileCount,
    unenumerated_directories: scan.unenumeratedDirectories,
    unenumerated_directory_overflow: scan.unenumeratedDirectoryOverflow,
    target_content_omitted: scan.targetContentOmitted,
    scope_read_directories: scan.scopeReadDirectories ?? [],
    read_authorization: "unchanged",
    note: "\u7701\u7565\u6216\u672A\u679A\u4E3E\u8DEF\u5F84\u672A\u88AB\u9884\u88C5\uFF0C\u4E0D\u8868\u793A scope.read \u88AB\u53D6\u6D88\uFF1B\u540E\u7EED\u4ECD\u53EF\u6309\u539F\u6388\u6743\u8BFB\u53D6\u3002\u4EC5\u7531 scope.read \u6388\u6743\u7684\u76EE\u5F55\u4E0D\u81EA\u52A8\u9884\u88C5\u6B63\u6587\uFF1B\u663E\u5F0F\u76EE\u6807\u4ECD\u6309\u9884\u7B97\u9001\u8FBE\u3002"
  };
}
function shrinkSemanticIndex(evidence, scan) {
  const targets = [];
  const rest = [];
  for (const item of evidence.sources) {
    if (item.declared_as?.includes("target")) targets.push(item);
    else rest.push(item);
  }
  evidence.sources = targets.concat(rest);
  while (rest.length && estimatedTokens(evidence) > SEMANTIC_INJECTION_TOKEN_LIMIT) {
    rest.pop();
    evidence.sources = targets.concat(rest);
    scan.omittedFileCount += 1;
  }
  if (estimatedTokens(evidence) > SEMANTIC_INJECTION_TOKEN_LIMIT) {
    for (const item of targets) {
      if (!Object.hasOwn(item, "content")) continue;
      delete item.content;
      if (!scan.targetContentOmitted.includes(item.path)) scan.targetContentOmitted.push(item.path);
    }
  }
}
function applySemanticMaterialMode(evidence, scan) {
  if (!scan) throw new ToolError("semantic evidence scan missing");
  evidence.material_mode = scan.mode === "full_candidate" ? "full" : "index";
  const estimatedFull = scan.mode === "full_candidate" ? estimatedTokens(evidence) : projectedSemanticTokens(scan.enumeratedBytes, scan.enumeratedFiles);
  if (scan.mode === "full_candidate" && estimatedFull > SEMANTIC_INJECTION_TOKEN_LIMIT) {
    evidence.material_mode = "index";
    let remaining = SEMANTIC_TARGET_CONTENT_BYTE_BUDGET;
    for (const item of evidence.sources) {
      const isTarget = Array.isArray(item.declared_as) && item.declared_as.includes("target");
      if (!isTarget || !Object.hasOwn(item, "content")) {
        delete item.content;
        continue;
      }
      const bytes = Buffer.byteLength(String(item.content), "utf8");
      if (bytes <= remaining) {
        remaining -= bytes;
        continue;
      }
      delete item.content;
      if (!scan.targetContentOmitted.includes(item.path)) scan.targetContentOmitted.push(item.path);
    }
  }
  if (evidence.material_mode === "index") {
    evidence.material_omissions = semanticMaterialOmissions(scan);
    if (estimatedTokens(evidence) > SEMANTIC_INJECTION_TOKEN_LIMIT) {
      shrinkSemanticIndex(evidence, scan);
      evidence.material_omissions = semanticMaterialOmissions(scan);
    }
  }
  evidence.material_stats = {
    token_limit: SEMANTIC_INJECTION_TOKEN_LIMIT,
    estimated_full_tokens: estimatedFull,
    injected_tokens: estimatedTokens(evidence),
    source_count: evidence.sources.length,
    full_content_source_count: evidence.sources.filter((item) => Object.hasOwn(item, "content")).length,
    index_complete: semanticIndexComplete(scan),
    omitted_file_count: scan.omittedFileCount,
    enumerated_file_count: scan.enumeratedFiles,
    enumerated_bytes: scan.enumeratedBytes,
    content_bytes_read: scan.contentBytesRead,
    unenumerated_directory_count: scan.unenumeratedDirectories.length + scan.unenumeratedDirectoryOverflow,
    scope_read_directory_count: (scan.scopeReadDirectories ?? []).length,
    budget_applied_before_read: true
  };
}
function buildEvidence(pkg, options = {}) {
  const { execute, root = null, logRoot = null, outputRoot = null, outputPath = null } = options;
  const rid = routeId(pkg);
  const contract = capabilityContract(pkg, rid);
  const scope = isRecord(pkg?.scope) ? pkg.scope : {};
  const scopeRead = Array.isArray(scope.read) ? uniqueStrings(scope.read) : [];
  const base = resolveLikePython(root || reviewRoot(pkg));
  const targets = declaredTargets(contract);
  const semanticReview = SEMANTIC_REVIEW_ROUTES.has(rid);
  let sources;
  let errors;
  let sourcesComplete;
  let semanticScan = null;
  if (semanticReview) {
    semanticScanSlot = null;
    [sources, errors, sourcesComplete] = semanticSourceEvidence(base, contract, scopeRead);
    semanticScan = semanticScanSlot;
    semanticScanSlot = null;
  } else {
    [sources, errors, sourcesComplete] = sourceEvidence(base, rid, contract, scopeRead, 6e4);
  }
  const rawChecks = Object.hasOwn(contract, "mechanical_checks") ? contract.mechanical_checks : [];
  if (!Array.isArray(rawChecks)) throw new ToolError("contract.mechanical_checks must be a list");
  let checks = [];
  if (execute) {
    let logs = logRoot;
    if (logs === null || logs === void 0) {
      logs = evidenceLogDirectory(evidenceOutputPath(pkg, { outputRoot, outputPath }));
    }
    checks = executeChecks(base, rawChecks, logs);
  }
  const codeReady = rid !== "verify-agent__code-verification" || rawChecks.length > 0;
  const changeBase = typeof contract.change_base === "string" && contract.change_base.trim() ? contract.change_base.trim() : null;
  const gitEvidence = scopedGitEvidence(
    base,
    uniqueStrings([...targets, ...scopeRead]),
    rid === "verify-agent__code-verification" ? 0 : 1e3,
    changeBase
  );
  if (gitEvidence.mode === "invalid_base") errors.push(`change_base does not resolve to a commit: ${changeBase}`);
  const complete = Boolean(execute && sourcesComplete && codeReady && !errors.length);
  const closedDossier = Array.isArray(pkg?.tool_contract?.allowed) && pkg.tool_contract.allowed.length === 0;
  const omittedContractKeys = /* @__PURE__ */ new Set(["mechanical_checks", "output_report"]);
  if (rid === "verify-agent__code-verification") omittedContractKeys.add("affected_files");
  const reviewContract = Object.fromEntries(
    Object.entries(contract).filter(([key]) => !omittedContractKeys.has(key))
  );
  const evidence = {
    schema_version: 1,
    route_id: rid,
    profile: semanticReview ? SEMANTIC_PROFILE : closedDossier && complete && !truthyText(pkg?.runtime_context?.network_needed) ? PROFILE : ASSISTED_PROFILE,
    complete,
    goal: pkg?.goal ?? null,
    contract: reviewContract,
    known_facts: Object.hasOwn(pkg, "known_facts") ? pkg.known_facts : [],
    git: gitEvidence,
    sources,
    mechanical_checks: checks,
    errors
  };
  if (semanticReview) {
    evidence.source_root = String(base);
    applySemanticMaterialMode(evidence, semanticScan);
  }
  return evidence;
}
function derivedEvidenceFilename(packageId) {
  const raw = String(packageId || "package");
  let safe = raw.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^\.+/, "").replace(/\.+$/, "").slice(0, 80);
  if (!safe) safe = "package";
  if (safe !== raw || [".", ".."].includes(raw)) safe = `${safe}-${ids.uuidHex().slice(0, 16)}`;
  return `${safe}.json`;
}
function assertDerivedOutputContained(output, root) {
  const rootPath = lexicalAbsolute(root);
  const outputPath = lexicalAbsolute(output);
  assertNoReparse(rootPath, { allowMissing: true });
  assertNoReparse(outputPath, { allowMissing: true });
  if (!pyIsRelativeTo(resolveLikePython(outputPath), resolveLikePython(rootPath))) {
    throw new ToolError(`derived evidence output escapes output root: ${outputPath}`);
  }
  return outputPath;
}
function evidenceLogDirectory(output) {
  const target = lexicalAbsolute(output);
  const parsed = path4.parse(target);
  const stripped = parsed.ext ? path4.join(parsed.dir, parsed.name) : target;
  return stripped !== target ? stripped : path4.join(parsed.dir, `${parsed.base}.logs`);
}
function evidenceOutputPath(pkg, options = {}) {
  const { outputRoot = null, outputPath = null } = options;
  const packageId = String(pkg?.package_id || "package");
  if (outputPath !== null && outputPath !== void 0) {
    return lexicalAbsolute(outputPath);
  }
  if (outputRoot !== null && outputRoot !== void 0) {
    const root2 = lexicalAbsolute(outputRoot);
    if (path4.extname(root2).toLowerCase() === ".json" || Boolean(statOrNull(root2)?.isFile())) return root2;
    return assertDerivedOutputContained(path4.join(root2, derivedEvidenceFilename(packageId)), root2);
  }
  const root = lexicalAbsolute(path4.join(ROOT, "tmp", "review_evidence"));
  return assertDerivedOutputContained(path4.join(root, derivedEvidenceFilename(packageId)), root);
}

// ops/tools/review_evidence.selftest.mjs
function selfTest() {
  const tmpParent = path5.join(ROOT, "tmp");
  mkdirSync2(tmpParent, { recursive: true });
  const repo = mkdtempSync(path5.join(tmpParent, "review-evidence-self-test-"));
  try {
    run(["git", "init"], repo);
    run(["git", "config", "user.email", "self-test@example.invalid"], repo);
    run(["git", "config", "user.name", "self-test"], repo);
    writeFileSync(
      path5.join(repo, "target.py"),
      "def target():\n    return 1\n\ndef recorder_lock():\n    return 'old'\n",
      "utf8"
    );
    run(["git", "add", "target.py"], repo);
    run(["git", "commit", "-m", "baseline"], repo);
    writeFileSync(
      path5.join(repo, "target.py"),
      "def target():\n    return 2\n\ndef recorder_lock():\n    return 'new'\n",
      "utf8"
    );
    writeFileSync(path5.join(repo, "unrelated.txt"), "must not leak", "utf8");
    const pkg = {
      package_id: "review-evidence-self-test",
      agent: { role: "verify-agent", capability: { name: "code-verification" } },
      goal: "verify target",
      scope: { read: ["target.py"], write: [], delete: [], out_of_scope: [] },
      runtime_context: { cwd: repo },
      tool_contract: { allowed: [] },
      extensions: {
        capability_contract: {
          verify: {
            verify_mode: "verification",
            review_goal: "target returns 2",
            affected_files: ["target.py"],
            changed_surfaces: ["target.py: target", "target.py: recorder_lock"],
            mechanical_checks: [
              { id: "prints-once", argv: [process4.execPath, "-e", "console.log('once')"], cwd: "." },
              {
                id: "multiline-json",
                argv: [
                  process4.execPath,
                  "-e",
                  "console.log(JSON.stringify({status:'ok',checks:{alpha:true,beta:true}}, null, 2))"
                ],
                cwd: "."
              }
            ]
          }
        }
      }
    };
    const evidence = buildEvidence(pkg, { execute: true, root: repo, logRoot: path5.join(repo, "logs") });
    const statusText = evidence.git.scoped_status.join("\n");
    if (!statusText.includes("target.py") || statusText.includes("unrelated.txt")) {
      throw new ToolError("self-test scoped git status leaked unrelated paths");
    }
    const jsonSummary = JSON.parse(evidence.mechanical_checks[1].output_tail);
    if (jsonSummary.status !== "ok" || !isDeepStrictEqual(jsonSummary.checks, { total: 2, failed: [] })) {
      throw new ToolError("self-test multiline JSON output summary lost structured observations");
    }
    if (evidence.profile !== PROFILE || !evidence.complete) {
      throw new ToolError("self-test expected evidence_only_v1 complete pack");
    }
    const excerpts = evidence.sources[0].excerpts ?? [];
    const excerptText = JSON.stringify(excerpts);
    if (!excerpts.length || !excerptText.includes("return 2") || !excerptText.includes("recorder_lock")) {
      throw new ToolError("self-test changed surface excerpt missing current implementation");
    }
    writeFileSync(path5.join(repo, "rule-a.md"), "alpha\n", "utf8");
    writeFileSync(path5.join(repo, "rule-b.md"), "beta\n", "utf8");
    const semanticPackage = {
      package_id: "semantic-review-self-test",
      agent: { role: "semantic-review-agent", capability: { name: "rule-quality-inspection" } },
      goal: "review rules",
      scope: { read: ["rule-a.md", "rule-b.md"], write: [], delete: [], out_of_scope: [] },
      runtime_context: { cwd: repo },
      extensions: { capability_contract: { rule_quality_inspection: { target_files: ["rule-a.md"] } } }
    };
    const semantic = buildEvidence(semanticPackage, { execute: true, root: repo, logRoot: path5.join(repo, "semantic-logs") });
    if (semantic.profile !== SEMANTIC_PROFILE || semantic.material_mode !== "full") {
      throw new ToolError("self-test expected semantic full material mode");
    }
    if (!isDeepStrictEqual(new Set(semantic.sources.map((item) => item.path)), /* @__PURE__ */ new Set(["rule-a.md", "rule-b.md"]))) {
      throw new ToolError("self-test semantic material omitted a scoped source");
    }
    if (!semantic.sources.every((item) => Object.hasOwn(item, "content"))) {
      throw new ToolError("self-test semantic full mode omitted source content");
    }
    writeFileSync(path5.join(repo, "large.md"), "x".repeat(SEMANTIC_INJECTION_TOKEN_LIMIT * 3 + 1), "utf8");
    semanticPackage.scope.read = ["rule-a.md", "rule-b.md", "large.md"];
    const indexed = buildEvidence(semanticPackage, { execute: true, root: repo, logRoot: path5.join(repo, "indexed-logs") });
    if (indexed.material_mode !== "index") {
      throw new ToolError("self-test semantic oversized material did not switch to complete index mode");
    }
    const indexedTarget = indexed.sources.find((item) => item.path === "rule-a.md");
    if (!indexedTarget || !Object.hasOwn(indexedTarget, "content")) {
      throw new ToolError("self-test semantic oversized index dropped the declared target body");
    }
    if (indexed.sources.some((item) => item.path !== "rule-a.md" && Object.hasOwn(item, "content"))) {
      throw new ToolError("self-test semantic oversized index preloaded non-target content");
    }
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// ops/tools/review_evidence.mjs
var PROGRAM = "review_evidence.mjs";
var USAGE = `usage: ${PROGRAM} [-h] [--self-test]`;
var DESCRIPTION = "\u4E3A\u9759\u6001\u7EC8\u9A8C\u751F\u6210\u6709\u754C\u673A\u68B0\u8BC1\u636E\u5305\u3002\u65E5\u5E38\u6D3E\u53D1\u7531 dispatch_prepare.mjs \u81EA\u52A8\u8C03\u7528\u3002";
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
`;
}
function parseArgs(argv) {
  const args = { selfTest: false };
  for (const token of argv) {
    if (token === "-h" || token === "--help") throw new HelpRequested();
    if (token === "--self-test") {
      args.selfTest = true;
      continue;
    }
    throw new ArgumentError(`unrecognized arguments: ${token}`);
  }
  return args;
}
function main(argv) {
  const args = parseArgs(argv);
  if (!args.selfTest) throw new ToolError("direct evidence preparation is internal; use dispatch_prepare.mjs");
  selfTest();
  process5.stdout.write("review_evidence self-test: pass\n");
  return 0;
}
try {
  process5.exitCode = main(process5.argv.slice(2));
} catch (error) {
  if (error instanceof HelpRequested) {
    process5.stdout.write(helpText());
    process5.exitCode = 0;
  } else if (error instanceof ArgumentError) {
    process5.stderr.write(`${USAGE}
${PROGRAM}: error: ${error.message}
`);
    process5.exitCode = 2;
  } else if (["ToolError", "ValueError"].includes(error?.name)) {
    process5.stderr.write(`error: ${error.message}
`);
    process5.exitCode = 1;
  } else {
    throw error;
  }
}
export {
  main,
  parseArgs
};
