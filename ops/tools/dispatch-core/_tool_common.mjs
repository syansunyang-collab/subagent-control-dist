// dispatch-core 公共层：ops/tools/_tool_common.py 的 JS 复刻。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」；函数名为 Python 名的 camelCase。
// 异常映射：Python ToolError → ToolError；FileNotFoundError/OSError 分支按原文映射为 ToolError 消息。
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  realpathSync, renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { resolveModelConfigSources } from "../model_config.mjs";

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
}

// Python 侧非 ToolError 异常（KeyError / ValueError / TypeError / OSError…）的 JS 对应物：
// name 取 Python 类型名。KeyError 的 message 是键的 repr，如 'goal'。
export function pyError(type, message) {
  const error = new Error(message);
  error.name = String(type);
  return error;
}

// ---- 时间与 ID：唯一取值入口，测试可冻结 ----

let frozen = null;

// 置 RFC 4122 版本 4 与变体位，使冻结值也能通过 uuid.UUID(hex).version == 4 之类的校验。
function withUuid4Bits(hex32) {
  let raw = BigInt(`0x${hex32}`);
  raw = (raw & ~(0xFn << 76n)) | (0x4n << 76n);
  raw = (raw & ~(0x3n << 62n)) | (0x2n << 62n);
  return raw.toString(16).padStart(32, "0");
}

function uuidFromSeed(seed, index) {
  return withUuid4Bits(createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 32));
}

export const clock = {
  now() {
    return frozen ? new Date(frozen.nowMs) : new Date();
  },
};

export const ids = {
  uuidHex() {
    if (frozen) {
      const value = uuidFromSeed(frozen.uuidSeed, frozen.uuidIndex);
      frozen.uuidIndex += 1;
      return value;
    }
    return randomUUID().replace(/-/g, "");
  },
};

export function freezeDeterminism({ nowIso, uuidSeed }) {
  const text = String(nowIso);
  const nowMs = Date.parse(text);
  if (!Number.isFinite(nowMs)) throw new TypeError(`freezeDeterminism requires a parseable nowIso: ${nowIso}`);
  // Python 语料可带微秒；Date 只有毫秒，冻结时保留六位小数原文供 utcNow 复现。
  const fraction = /\.(\d{1,6})(?=[+Z-]|$)/.exec(text)?.[1] ?? null;
  frozen = {
    nowMs,
    micros: fraction === null ? null : fraction.padEnd(6, "0"),
    uuidSeed: String(uuidSeed ?? "golden"),
    uuidIndex: 0,
  };
}

export function resetDeterminism() {
  frozen = null;
}

// Python datetime.isoformat()：微秒六位，全零时省略小数；UTC 偏移写作 +00:00。
export function utcNow() {
  const now = clock.now();
  const base = now.toISOString().slice(0, 19);
  const micros = frozen?.micros ?? `${String(now.getUTCMilliseconds()).padStart(3, "0")}000`;
  const fraction = micros === "000000" ? "" : `.${micros}`;
  return `${base}${fraction}+00:00`;
}

export function utcDateStamp() {
  const now = clock.now();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
}

// ---- 路径语义（pathlib 口径） ----

// PurePath.is_absolute()：Windows 上要求盘符加根或 UNC，`/foo`、`\foo` 只是「有根无盘」，不算绝对。
export function isAbsoluteLikePython(value) {
  const text = String(value ?? "");
  if (process.platform !== "win32") return text.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(text) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(text);
}

// `base / other`：other 绝对时取 other；Windows 上「有根无盘」的 other 继承 base 的盘符；否则拼接。
export function pathlibJoin(base, other) {
  const text = String(other ?? "");
  if (isAbsoluteLikePython(text)) return text;
  if (process.platform === "win32" && /^[\\/]/.test(text)) {
    const drive = path.parse(path.resolve(String(base))).root.replace(/[\\/]+$/, "");
    return `${drive}${text}`;
  }
  return path.join(String(base), text);
}

// ---- 仓根 ----

export function resolveLikePython(value) {
  // Path.resolve(strict=False)：尽量 realpath，已存在的最长前缀走 realpath，其余词法拼接。
  const absolute = path.resolve(String(value));
  let current = absolute;
  const tail = [];
  while (true) {
    try {
      // realpathSync.native 在 Windows 上返回真实大小写的驱动器路径，与 Python 一致。
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

export function repoRoot() {
  const explicit = String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim();
  if (explicit) {
    if (!isAbsoluteLikePython(explicit)) throw new ToolError("SUBAGENT_CONTROL_REPO_ROOT must be an absolute path");
    const resolved = resolveLikePython(explicit);
    let info = null;
    try { info = statSync(resolved); } catch { info = null; }
    if (!info || !info.isDirectory()) throw new ToolError(`SUBAGENT_CONTROL_REPO_ROOT is not a directory: ${explicit}`);
    return resolved;
  }
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (existsSync(path.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  let cur = resolveLikePython(process.cwd());
  while (true) {
    if (existsSync(path.join(cur, ".git")) || (existsSync(path.join(cur, "AGENTS.md")) && existsSync(path.join(cur, "ops")))) {
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
  try { info = statSync(resolved); } catch { info = null; }
  if (!info || !info.isDirectory()) throw new ToolError(`${envKey} is not a directory: ${explicit}`);
  return resolved;
}

// 项目根：会话项目的一切项目面路径（PROJECT/STATUS/ROADMAP、scope、output、task_root、
// 临时材料、panel/Fleet 状态、map、notes、台账、.runtime）都以此为本。
// 显式 SUBAGENT_PROJECT_ROOT 优先；无值时沿用旧开发口径（显式 SUBAGENT_CONTROL_REPO_ROOT 或自 cwd 上溯）。
export function projectRoot() {
  const explicit = declaredDirectory("SUBAGENT_PROJECT_ROOT");
  if (explicit) return explicit;
  if (String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const cwd = resolveLikePython(process.cwd());
  let cur = cwd;
  while (true) {
    if (existsSync(path.join(cur, ".git")) || (existsSync(path.join(cur, "AGENTS.md")) && existsSync(path.join(cur, "ops")))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return repoRoot();
}

// 运行根：角色 TOML、routes、模板、checker 等只读生产资产以此为本；与项目根严格分离。
// 消费模式显式 SUBAGENT_RUNTIME_ROOT；开发模式沿用旧 SUBAGENT_CONTROL_REPO_ROOT 或脚本所在开发仓。
export function runtimeRoot() {
  const explicit = declaredDirectory("SUBAGENT_RUNTIME_ROOT");
  if (explicit) return explicit;
  if (String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (existsSync(path.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  return repoRoot();
}

// ROOT 是 projectRoot 兼容别名：绝不保持 producer 根语义。
// RUNTIME_ROOT 才是只读生产资产根；共享包写入由写域守卫与 scope 校验拒绝。
export const ROOT = projectRoot();
export const PROJECT_ROOT = ROOT;
export const RUNTIME_ROOT = runtimeRoot();
export const ROLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// 模型配置来源：全局默认运行根 + 项目显式覆盖声明；首次使用时解析，缺失配置只在真正读配置时报错。
// 父进程选型与子进程档位校验共用 ops/tools/model_config.mjs 的同一解析，不各自拼接路径。
let modelConfigCache = null;

export function modelConfigSources() {
  if (!modelConfigCache) {
    try {
      modelConfigCache = resolveModelConfigSources({
        roots: [{ root: RUNTIME_ROOT, source: "runtime_root" }],
        projectRoot: ROOT,
      });
    } catch (error) {
      if (error?.name === "ModelConfigError") throw new ToolError(error.message);
      throw error;
    }
  }
  return modelConfigCache;
}

export function roleConfigPath(role) {
  const normalized = String(role ?? "").trim();
  if (!ROLE_NAME_RE.test(normalized)) throw new ToolError(`invalid runtime role: ${normalized || "(empty)"}`);
  return modelConfigSources().roleConfigPath(normalized);
}

// 运行包只读资产：给出绝对路径，供调用方读取角色、模板、routes 等生产材料。
export function runtimeAssetPath(...segments) {
  return path.join(RUNTIME_ROOT, ...segments.map(String));
}

export function loadRoleConfig(role, { globalDefault = false } = {}) {
  const selectedFile = roleConfigPath(role);
  const file = globalDefault ? path.join(modelConfigSources().global_root, "ops", "agents", path.basename(selectedFile)) : selectedFile;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new ToolError(`runtime role config not found: ${rel(file)}`);
    throw new ToolError(`runtime role config is unreadable: ${rel(file)}`);
  }
  let data;
  try {
    data = parseToml(text);
  } catch {
    throw new ToolError(`runtime role config is unreadable: ${rel(file)}`);
  }
  const declaredName = String(data.name ?? "").trim();
  const stem = path.basename(file, ".toml");
  if (declaredName !== stem) {
    throw new ToolError(`runtime role name mismatch: ${rel(file)} declares ${declaredName || "(empty)"}`);
  }
  return data;
}

// Python Path.relative_to(ROOT).as_posix()；失败时返回原路径的 posix 形态。
export function rel(value) {
  const target = resolveLikePython(value);
  const relative = path.relative(ROOT, target);
  if (relative === "" ) return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return String(value).replace(/\\/g, "/");
  return relative.replace(/\\/g, "/");
}

// ---- 子进程与文件 ----

export function runGit(args) {
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
    stderr: String(proc.stderr ?? "").replace(/\n+$/, ""),
  };
}

export function loadJson(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new ToolError(`json file not found: ${rel(file)}`);
    throw new ToolError(`cannot read json file: ${rel(file)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ToolError(`invalid json file: ${rel(file)}:${jsonErrorLine(text, error)}`);
  }
  if (!isRecord(data)) throw new ToolError(`json root is not object: ${rel(file)}`);
  return data;
}

function jsonErrorLine(text, error) {
  const match = /position (\d+)/.exec(String(error?.message ?? ""));
  if (!match) return 1;
  return text.slice(0, Number(match[1])).split("\n").length;
}

export function fileFingerprint(file) {
  let info;
  try {
    info = statSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: rel(file), exists: false };
    throw new ToolError(`cannot stat path: ${rel(file)}`);
  }
  const mtime = Math.floor(info.mtimeMs / 1000);
  return {
    path: rel(file),
    exists: true,
    size: info.size,
    mtime,
    mtime_iso: localTimeString(mtime),
  };
}

function localTimeString(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---- JSON 文本：等价 json.dumps(sort_keys=True, indent=2, ensure_ascii=False) ----

export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareCodePoints).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value), null, 2);
}

export function emit(data, fmt, text) {
  if (fmt === "json") {
    process.stdout.write(`${canonicalJson(data)}\n`);
  } else {
    const trimmed = String(text ?? "").replace(/\s+$/, "");
    process.stdout.write(`${trimmed || "(empty)"}\n`);
  }
  if (Object.hasOwn(data, "exit_code")) return Number(data.exit_code);
  return ["failed", "error"].includes(data.status) ? 1 : 0;
}

export function statusLines() {
  const status = runGit(["status", "--short", "--untracked-files=all"]);
  if (status.exit_code !== 0) throw new ToolError(`git status failed: ${status.stderr}`);
  if (!status.stdout) return [];
  return status.stdout.split(/\r?\n/).filter((line) => line.trim());
}

export function repoPath(value, label, { mustExist = true } = {}) {
  const raw = String(value);
  const lexical = isAbsoluteLikePython(raw) ? path.resolve(raw) : path.resolve(ROOT, raw);
  const projectReal = resolveLikePython(ROOT);
  const lexicalRelative = path.relative(projectReal, lexical);
  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    throw new ToolError(`${label} escapes repository: ${value}`);
  }
  const resolved = resolveLikePython(lexical);
  const relative = path.relative(projectReal, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    // 项目内声明挂载（CR-RESOURCES 只读链接）指向共享包：读面放行，写面仍由 realpath 写域守卫拒绝。
    if (!isSameOrInside(resolved, RUNTIME_ROOT)) throw new ToolError(`${label} escapes repository: ${value}`);
  }
  if (mustExist) {
    let info = null;
    try { info = statSync(resolved); } catch { info = null; }
    if (!info || !info.isFile()) throw new ToolError(`${label} is not a readable file: ${value}`);
  }
  return resolved;
}

// 目标等于根或位于根之下（两侧均已 realpath 归一）。
export function isSameOrInside(candidate, root) {
  if (!candidate || !root) return false;
  const target = resolveLikePython(candidate);
  const base = resolveLikePython(root);
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

// 与 Python read_stdin_text 同序：utf-8-sig → 本地编码 → utf-16 → utf-16-le。
export function readStdinText(sourceLabel) {
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

export function decodeStdinBytes(raw, sourceLabel) {
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return raw.subarray(3).toString("utf8");
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString("utf16le");
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) return swapUtf16(raw.subarray(2)).toString("utf16le");
  const utf8 = raw.toString("utf8");
  if (!utf8.includes("�")) return utf8;
  if (raw.length % 2 === 0) return raw.toString("utf16le");
  throw new ToolError(`invalid ${sourceLabel} input encoding; expected UTF-8, UTF-16 or locale text`);
}

function swapUtf16(buffer) {
  const swapped = Buffer.from(buffer);
  swapped.swap16();
  return swapped;
}

// ---- 路径比较 ----

// 把写作用域路径归一为 ROOT 相对 posix 路径，供 pathConflict 比较；仓外路径记 external: 前缀。
export function normalizeConflictPath(value) {
  const raw = String(value ?? "").replace(/\\/g, "/").trim().replace(/\/+$/, "");
  if (!raw) return "";
  const resolved = isAbsoluteLikePython(raw) ? resolveLikePython(raw) : resolveLikePython(pathlibJoin(ROOT, raw));
  const relative = path.relative(resolveLikePython(ROOT), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return `external:${raw.toLowerCase()}`;
  return relative === "" ? "." : relative.replace(/\\/g, "/");
}

export function pathConflict(left, right) {
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function asList(value) {
  return Array.isArray(value) ? value : [];
}

export function add(issues, code, location) {
  issues.push({ code, message: location });
}

export function issueText(issue) {
  return `${issue?.code ?? ""}: ${issue?.message ?? ""}`;
}

export function lexicalAbsolute(value) {
  return path.resolve(String(value));
}

export function absolutePath(value, label, { error = ToolError } = {}) {
  const candidate = String(value);
  if (!isAbsoluteLikePython(candidate)) throw new error(`${label} must be absolute: ${value}`);
  return path.resolve(candidate);
}

// Windows junction / reparse 与符号链接在 Node lstat 下都表现为 isSymbolicLink。
export function isReparseStat(info) {
  return Boolean(info?.isSymbolicLink?.());
}

function componentsOf(candidate) {
  const parsed = path.parse(candidate);
  const rest = candidate.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  return { anchor: parsed.root, parts: rest };
}

export function assertNoReparseComponents(value, { allowMissing = false, label = "path", error = ToolError } = {}) {
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

export function ensureControlledDirectory(value, { mode = 0o700, label = "controlled directory", error = ToolError } = {}) {
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

export function assertRegularFile(value, label, { error = ToolError } = {}) {
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

export function atomicWriteBytes(value, data, { ensureParent = false, label = "write destination", error = ToolError } = {}) {
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
    fd = openSync(temp, "wx", 0o600);
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
    try { unlinkSync(temp); } catch {}
  }
}

// ---- 小工具 ----

export function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function homeDir() {
  return os.homedir();
}
