// dispatch-core/review_evidence.mjs：ops/tools/review_evidence.py 的 JS 复刻。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」：导出名为 Python 函数名的 camelCase，
// 位置参数同序，Python 关键字参数收敛为末尾 options 对象（键 camelCase）。常量保持 UPPER_SNAKE。
//
// 异常映射表（Python → JS）：
//   ToolError(msg)                       → ToolError(msg)，消息逐字相同。
//   KeyError(rid)                        → pyError("KeyError", repr(rid))；capabilityContract 读缺失的 CONTRACT_SLOTS 槽位。
//   ValueError(Path.relative_to)         → pyError("ValueError", "'<child>' is not in the subpath of '<parent>'")；
//                                          relTo 的目标不在 root 之下时 Python 不捕获、直接上抛。
//   TypeError / ValueError(float())      → pyError("TypeError"/"ValueError", ...)；validateCheck 的 timeout_seconds 非数值。
//   OSError(subprocess)                  → 不抛，run() 返回 {exit_code: null, stderr: <runtime 消息>, timed_out: false}；
//                                          消息文本由 runtime 决定（Python "[WinError 2] ..." vs Node "spawnSync ... ENOENT"），
//                                          不可能逐字相同。
//   OSError(原子写)                       → ToolError(`cannot atomically write evidence file ${destination}: ${exc}`)；
//                                          JS 侧 _tool_common 的写门本身抛 ToolError，原样透传，非 ToolError 才包装。
import { spawnSync } from "node:child_process";
import { opendirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  ROOT,
  ToolError,
  assertNoReparseComponents,
  ensureControlledDirectory,
  ids,
  isRecord,
  lexicalAbsolute,
  pyError,
  resolveLikePython,
  atomicWriteBytes as writeBytesAtomically,
} from "./_tool_common.mjs";
import {
  pyFloat, pyIsAbsolute, pyIsRelativeTo, pyJsonDumps, pyNormcase, pyPathJoin, pyReadTextReplace, pyRelativeToPosix,
  pyRepr, pySplitLines,
} from "./_py.mjs";

import { truthyText } from "./task_package_build.mjs";

export const PROFILE = "evidence_only_v1";
export const ASSISTED_PROFILE = "evidence_assisted_v1";
export const SEMANTIC_PROFILE = "semantic_review_v2";
export const SEMANTIC_INJECTION_TOKEN_LIMIT = 200_000;
// 全文预装上限：estimatedTokens ≈ (jsonBytes+2)/3，源文字节超过此值就不可能是 full。
// 在 stat 之后、读取之前用它拒绝无界读文，不先读再截。
export const SEMANTIC_FULL_CONTENT_BYTE_CEILING = SEMANTIC_INJECTION_TOKEN_LIMIT * 3;
// 完整路径索引的存储上限。超过后停止保留非目标路径，只计数，不先造无界索引再删。
export const SEMANTIC_COMPLETE_INDEX_FILE_CAP = 2048;
// 显式目标在有界索引里保留正文的共享字节预算，与非 semantic 的 60KB 同量级。
export const SEMANTIC_TARGET_CONTENT_BYTE_BUDGET = 60_000;
const SEMANTIC_OMISSION_DIR_CAP = 32;
// 只跳过已证实会把编译撑爆的再生树，不照搬整组忽略目录。tmp 不在此列：显式目标在 tmp 也必须保留。
const REGENERATED_TREE_REASONS = new Map([
  [".git", "vcs_metadata"],
  [".runtime", "regenerated_runtime"],
  ["node_modules", "dependency_tree"],
]);
let semanticScanSlot = null;
// 静态审查 route 的单一真源:kind 决定注入画像(semantic 走 SEMANTIC_PROFILE),
// contract_slot 决定读哪个能力合同槽位。下面三个旧名由它派生,新增 route 只改这里。
export const REVIEW_ROUTES = {
  "verify-agent__code-verification": { kind: "evidence", contract_slot: "verify" },
  "verify-agent__anti-defensive-inspection": { kind: "evidence", contract_slot: "anti_defensive_inspection" },
  "verify-agent__prompt-bloat-inspection": { kind: "evidence", contract_slot: "prompt_bloat_inspection" },
  "semantic-review-agent__rule-quality-inspection": { kind: "semantic", contract_slot: "rule_quality_inspection" },
  "semantic-review-agent__contract-drift-inspection": { kind: "semantic", contract_slot: "contract_drift_inspection" },
};
export const SEMANTIC_REVIEW_ROUTES = new Set(
  Object.entries(REVIEW_ROUTES).filter(([, spec]) => spec.kind === "semantic").map(([rid]) => rid),
);
export const STATIC_REVIEW_ROUTES = new Set(Object.keys(REVIEW_ROUTES));
export const CONTRACT_SLOTS = Object.fromEntries(
  Object.entries(REVIEW_ROUTES).map(([rid, spec]) => [rid, spec.contract_slot]),
);

function statOrNull(value) {
  try {
    return statSync(value);
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

// bytes[:limit].decode("utf-8", errors="ignore")：丢掉被截断的半个字符。
function decodeTruncated(buffer, limit) {
  const cap = Math.max(0, Math.min(limit, buffer.length));
  let end = cap;
  if (cap < buffer.length) {
    let index = cap - 1;
    let trailing = 0;
    while (index >= 0 && (buffer[index] & 0xc0) === 0x80) {
      index -= 1;
      trailing += 1;
    }
    if (index >= 0) {
      const lead = buffer[index];
      const needed = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
      if (trailing < needed) end = index;
    }
  }
  return buffer.subarray(0, end).toString("utf8");
}

// ---- 与 Python 同名的实现 ----

export function assertReviewRoutesConsistent(routes = null) {
  const checked = routes === null || routes === undefined ? REVIEW_ROUTES : routes;
  for (const [rid, spec] of Object.entries(checked)) {
    const kind = isRecord(spec) ? spec.kind : undefined;
    if (!["evidence", "semantic"].includes(kind)) {
      throw new ToolError(`REVIEW_ROUTES[${rid}].kind 不在闭集 evidence|semantic: ${pyRepr(kind ?? null)}`);
    }
    const slot = isRecord(spec) ? spec.contract_slot : undefined;
    if (typeof slot !== "string" || !slot.trim()) {
      throw new ToolError(`REVIEW_ROUTES[${rid}].contract_slot 缺失或为空`);
    }
  }
  return null;
}

assertReviewRoutesConsistent();

export const TARGET_KEYS = ["target_files", "affected_files", "truth_sources", "downstream_truth_sources"];
export const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_.-]{2,}/g;

function assertNoReparse(value, { allowMissing = false } = {}) {
  assertNoReparseComponents(value, { allowMissing, label: "evidence path" });
}

function ensureDirectory(value) {
  return ensureControlledDirectory(value, { label: "evidence directory" });
}

export function routeId(pkg) {
  const agent = isRecord(pkg?.agent) ? pkg.agent : {};
  const capability = isRecord(agent.capability) ? agent.capability : {};
  const role = String(agent.role || "");
  const name = String(capability.name || "");
  return `${role}__${name}`;
}

export function capabilityContract(pkg, rid) {
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  const contracts = isRecord(extensions.capability_contract) ? extensions.capability_contract : {};
  if (!Object.hasOwn(CONTRACT_SLOTS, rid)) throw pyError("KeyError", pyRepr(rid));
  const value = contracts[CONTRACT_SLOTS[rid]];
  return isRecord(value) ? value : {};
}

export function isStaticReview(pkg) {
  const rid = routeId(pkg);
  if (!STATIC_REVIEW_ROUTES.has(rid)) return false;
  if (rid === "verify-agent__code-verification") {
    const contract = capabilityContract(pkg, rid);
    if (contract.verify_mode !== "verification") return false;
    // 带 acceptance_context 的终验叶按 oracle/cases 自行只读取证,
    // 不锁进 evidence_only_v1 静态画像(否则案例级 oracle 无证可取,结构性空转)。
    const acceptance = contract.acceptance_context;
    return !(isRecord(acceptance) && Object.keys(acceptance).length > 0);
  }
  return true;
}

export function reviewRoot(pkg) {
  const runtime = isRecord(pkg?.runtime_context) ? pkg.runtime_context : {};
  const target = runtime.target_repo;
  if (typeof target === "string" && target.trim()) return resolveLikePython(target);
  const cwd = runtime.cwd;
  if (typeof cwd === "string" && cwd.trim()) return resolveLikePython(cwd);
  return resolveLikePython(ROOT);
}

export function uniqueStrings(values) {
  const result = [];
  for (const value of values) {
    if (typeof value === "string" && value.trim() && !result.includes(value)) result.push(value);
  }
  return result;
}

export function declaredTargets(contract) {
  const values = [];
  for (const key of TARGET_KEYS) {
    const item = contract?.[key];
    if (Array.isArray(item)) values.push(...item);
  }
  return uniqueStrings(values);
}

export function resolveScopedPath(root, value) {
  const rootPath = lexicalAbsolute(root);
  const target = pyIsAbsolute(value) ? lexicalAbsolute(value) : lexicalAbsolute(pyPathJoin(rootPath, value));
  assertNoReparse(rootPath, { allowMissing: true });
  assertNoReparse(target, { allowMissing: true });
  const resolved = resolveLikePython(target);
  const resolvedRoot = resolveLikePython(rootPath);
  if (!pyIsRelativeTo(resolved, resolvedRoot)) {
    throw new ToolError(
      `review evidence path escapes review root: ${value} (review root: ${resolvedRoot}; ` +
        "目标在另一仓时用 dispatch_prepare --async-target-cwd 指向该仓，scope 写该仓内路径)",
    );
  }
  return target;
}

export function relTo(root, target) {
  return pyRelativeToPosix(resolveLikePython(target), resolveLikePython(root));
}

export function run(argv, cwd, timeout = 30) {
  const started = process.hrtime.bigint();
  const elapsed = () => Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 1000) / 1000;
  const command = argv.map(String);
  const completed = spawnSync(command[0], command.slice(1), {
    cwd: String(cwd),
    encoding: "utf8",
    timeout: Math.round(pyFloat(timeout) * 1000),
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (completed.error) {
    if (completed.error.code === "ETIMEDOUT" || completed.signal) {
      return {
        exit_code: null,
        stdout: String(completed.stdout ?? ""),
        stderr: String(completed.stderr ?? ""),
        timed_out: true,
        duration_ms: elapsed(),
      };
    }
    return {
      exit_code: null,
      stdout: "",
      stderr: String(completed.error.message ?? completed.error),
      timed_out: false,
      duration_ms: elapsed(),
    };
  }
  return {
    exit_code: completed.status,
    stdout: String(completed.stdout ?? ""),
    stderr: String(completed.stderr ?? ""),
    timed_out: false,
    duration_ms: elapsed(),
  };
}

export function git(root, args, timeout = 30) {
  return run(["git", "-C", String(root), ...args], root, timeout);
}

export function tail(text, limit = 600) {
  const value = String(text || "");
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  return [...value].slice(-limit).join("");
}

export function checkOutputSummary(stdout, stderr, limit = 2_000) {
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

export function surfacePath(surface, candidates) {
  const normalized = String(surface).replace(/\\/g, "/");
  const matches = candidates.filter((item) => normalized.includes(String(item).replace(/\\/g, "/")));
  if (!matches.length) return null;
  let best = matches[0];
  for (const item of matches) if (item.length > best.length) best = item;
  return best;
}

export const SURFACE_RANGE_RE = /(?<![\p{L}\p{N}_.])(\d{1,6})\s*[-–]\s*(\d{1,6})(?![\p{L}\p{N}_.])/u;
export const SURFACE_RANGE_MAX_LINES = 240;

export function surfaceExcerpt(target, surface, maxLines = 10) {
  const lines = pySplitLines(pyReadTextReplace(target));
  const text = String(surface);
  const descriptor = text.includes(":") ? text.slice(text.indexOf(":") + 1) : text;
  // 显式行范围（如 "src/cli.py:42-88 parse_args"）按范围取行；关键词打分只作无范围时的回退,
  // 否则全新文件的 "1-N 全文新增" 描述只会命中注释行,证据包对审查者不可用。
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
    (descriptor.match(TOKEN_RE) || [])
      .filter((token) => !["path", "file", "line"].includes(token.toLowerCase()))
      .map((token) => token.toLowerCase()),
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

export function sourceEvidence(root, rid, contract, scopeRead, byteBudget) {
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
    // 摘录与全文按同一预算记账;target 文件对所有 route 供全文——按 route 排除全文
    // 会让代码验证审查者只拿到几行摘录,无法完成内容审查。
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

export function estimatedTokens(value) {
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
    // 目录不在 review root 下时保留原路径，仍标记未枚举。
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
      let bytes = 0;
      try {
        bytes = statSync(abs).size;
      } catch {
        bytes = 0;
      }
      state.meta.set(relative, { abs, bytes });
      state.items.set(relative, { path: relative, declared_as: [role] });
      return;
    }
    if (entry && !entry.declared_as.includes(role)) entry.declared_as.push(role);
    return;
  }
  state.seen.add(seenKey);
  let bytes = 0;
  try {
    bytes = statSync(abs).size;
  } catch {
    bytes = 0;
  }
  state.enumeratedFiles += 1;
  state.enumeratedBytes += bytes;
  // 直接点名的文件即使超出索引上限也保留；目录展开的文件到上限后只计数。
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
        const full = path.join(current, entry.name);
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
  // 读取授权不等于预装义务：scope.read 声明的是目录时只生成有界覆盖索引，
  // 不因为读取域看起来小就把整棵子树的正文装进启动材料。
  const scopeDirectoryDeclared = state.scopeReadDirectories.length > 0;
  // 全文候选同时受字节上限与读取前的 token 投影约束，避免先读全文再截。
  const fullCandidate = !scopeDirectoryDeclared &&
    enumerationComplete &&
    state.enumeratedBytes <= SEMANTIC_FULL_CONTENT_BYTE_CEILING &&
    projectedSemanticTokens(state.enumeratedBytes, state.enumeratedFiles) <= SEMANTIC_INJECTION_TOKEN_LIMIT;
  const mode = fullCandidate ? "full_candidate" : enumerationComplete ? "complete_index" : "bounded_index";
  if (mode === "full_candidate") {
    for (const [relative, entry] of state.items) {
      const meta = state.meta.get(relative);
      entry.content = pyReadTextReplace(meta.abs);
      state.contentBytesRead += meta.bytes;
    }
  } else {
    // 索引模式仍优先送达声明目标正文（预算内），其余只保留清单等待按需读取。
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
    targetContentOmitted: state.targetContentOmitted,
  };
}

export function semanticSourceEvidence(root, contract, scopeRead) {
  // 返回形状保持 [sources, errors, sourcesComplete]。
  // 扫描统计只经模块槽交给同步的 buildEvidence，不进入返回值。
  // scope.read 仍是读取授权；这里只决定预装，不改写授权，也不先读全文再截。
  const state = {
    root,
    items: new Map(),
    meta: new Map(),
    seen: new Set(),
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
    scopeReadDirectories: [],
  };
  const errors = [];
  const declarations = [
    ...declaredTargets(contract).map((value) => [value, "target"]),
    ...scopeRead.map((value) => [value, "scope_read"]),
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
      // 只登记读取域目录，供覆盖索引说明为什么没有预装整棵子树。
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

// changeBase 给出时差异取「基线提交 → 当前工作区」（含之后的提交与未提交修改），
// 未跟踪文件在 scoped_status 里以 ?? 列出；基线解析失败时报错，不退回 HEAD。
export function scopedGitEvidence(root, paths, patchBudget, changeBase = null) {
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
    diff_stat: String(stat.stdout || "").trim(),
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

export function validateCheck(raw, root) {
  if (!isRecord(raw)) throw new ToolError("mechanical_checks entries must be objects");
  const checkId = String(raw.id || "").trim();
  const argv = raw.argv;
  if (
    !checkId ||
    !Array.isArray(argv) ||
    !argv.length ||
    !argv.every((item) => typeof item === "string" && item)
  ) {
    throw new ToolError("mechanical check requires id and non-empty string argv");
  }
  const cwd = resolveScopedPath(root, String(raw.cwd || "."));
  if (!pathIsDir(cwd)) throw new ToolError(`mechanical check cwd is not a directory: ${cwd}`);
  const timeout = pyFloat(Object.hasOwn(raw, "timeout_seconds") ? raw.timeout_seconds : 120);
  if (timeout <= 0 || timeout > 600) throw new ToolError("mechanical check timeout_seconds must be in (0, 600]");
  const expected = Object.hasOwn(raw, "expected_exit_codes") ? raw.expected_exit_codes : [0];
  if (
    !Array.isArray(expected) ||
    !expected.length ||
    !expected.every((item) => typeof item === "boolean" || (typeof item === "number" && Number.isInteger(item)))
  ) {
    throw new ToolError("mechanical check expected_exit_codes must be a non-empty integer list");
  }
  // Python 的 set(expected) 只在 execute_checks 里参与 in / sorted()，用去重排序数组等价表达。
  const codes = [...new Set(expected.map((item) => (typeof item === "boolean" ? Number(item) : item)))].sort(
    (left, right) => left - right,
  );
  return [checkId, argv, cwd, timeout, codes];
}

export function atomicWriteBytes(target, payload) {
  // 通过受检父目录与同目录原子替换写入。
  // 这是应用层路径门，不是防敌意 OS 竞态的沙箱。OSError 包装保证每次写失败都是 ToolError，
  // 也就是 dispatch_prepare 调用方捕获的类型。
  const destination = lexicalAbsolute(target);
  try {
    writeBytesAtomically(destination, payload, { ensureParent: true, label: "evidence destination" });
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`cannot atomically write evidence file ${destination}: ${error?.message ?? error}`);
  }
  return null;
}

export function atomicWriteText(target, text) {
  atomicWriteBytes(target, Buffer.from(String(text), "utf8"));
  return null;
}

export function executeChecks(root, checks, logRoot) {
  const results = [];
  ensureDirectory(logRoot);
  for (const raw of checks) {
    const [checkId, argv, cwd, timeout, expected] = validateCheck(raw, root);
    const result = run(argv, cwd, timeout);
    const safe = checkId.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80);
    const logPath = path.join(String(logRoot), `${safe}.log`);
    atomicWriteText(
      logPath,
      `argv=${pyJsonDumps(argv)}\ncwd=${cwd}\nexit_code=${result.exit_code === null ? "None" : result.exit_code}\n` +
        `timed_out=${String(result.timed_out).toLowerCase()}\n\n[stdout]\n${result.stdout}\n[stderr]\n${result.stderr}`,
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
      log_path: visibleLog,
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
    note: "省略或未枚举路径未被预装，不表示 scope.read 被取消；后续仍可按原授权读取。" +
      "仅由 scope.read 授权的目录不自动预装正文；显式目标仍按预算送达。",
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
  const estimatedFull = scan.mode === "full_candidate"
    ? estimatedTokens(evidence)
    : projectedSemanticTokens(scan.enumeratedBytes, scan.enumeratedFiles);
  if (scan.mode === "full_candidate" && estimatedFull > SEMANTIC_INJECTION_TOKEN_LIMIT) {
    // 序列化估算超限时降级为索引：非目标正文丢弃，声明目标正文仍按目标预算保留。
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
    budget_applied_before_read: true,
  };
}

export function buildEvidence(pkg, options = {}) {
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
    // 60KB ≈ 20K token,worker 上下文吃得下;5KB 连一个中型脚本全文都装不下,
    // 审查者拿不到事实输入只能空转。非 semantic 仍走这条，不改预算语义。
    [sources, errors, sourcesComplete] = sourceEvidence(base, rid, contract, scopeRead, 60_000);
  }
  const rawChecks = Object.hasOwn(contract, "mechanical_checks") ? contract.mechanical_checks : [];
  if (!Array.isArray(rawChecks)) throw new ToolError("contract.mechanical_checks must be a list");
  let checks = [];
  if (execute) {
    let logs = logRoot;
    if (logs === null || logs === undefined) {
      // Derive logs from the final evidence file.  In particular, an
      // output_root ending in .json is a file, never a directory.
      logs = evidenceLogDirectory(evidenceOutputPath(pkg, { outputRoot, outputPath }));
    }
    checks = executeChecks(base, rawChecks, logs);
  }
  const codeReady = rid !== "verify-agent__code-verification" || rawChecks.length > 0;
  const changeBase = typeof contract.change_base === "string" && contract.change_base.trim() ? contract.change_base.trim() : null;
  const gitEvidence = scopedGitEvidence(
    base,
    uniqueStrings([...targets, ...scopeRead]),
    rid === "verify-agent__code-verification" ? 0 : 1_000,
    changeBase,
  );
  if (gitEvidence.mode === "invalid_base") errors.push(`change_base does not resolve to a commit: ${changeBase}`);
  const complete = Boolean(execute && sourcesComplete && codeReady && !errors.length);
  // 封闭卷宗只在任务包显式声明无工具（tool_contract.allowed=[]）时成立；
  // 缺省或受限工具集走 assisted，保留补读与复现能力。
  const closedDossier = Array.isArray(pkg?.tool_contract?.allowed) && pkg.tool_contract.allowed.length === 0;
  const omittedContractKeys = new Set(["mechanical_checks", "output_report"]);
  if (rid === "verify-agent__code-verification") omittedContractKeys.add("affected_files");
  const reviewContract = Object.fromEntries(
    Object.entries(contract).filter(([key]) => !omittedContractKeys.has(key)),
  );
  const evidence = {
    schema_version: 1,
    route_id: rid,
    profile: semanticReview ? SEMANTIC_PROFILE
      : (closedDossier && complete && !truthyText(pkg?.runtime_context?.network_needed)) ? PROFILE : ASSISTED_PROFILE,
    complete,
    goal: pkg?.goal ?? null,
    contract: reviewContract,
    known_facts: Object.hasOwn(pkg, "known_facts") ? pkg.known_facts : [],
    git: gitEvidence,
    sources,
    mechanical_checks: checks,
    errors,
  };
  if (semanticReview) {
    evidence.source_root = String(base);
    applySemanticMaterialMode(evidence, semanticScan);
  }
  return evidence;
}

export function writeEvidenceFile(output, evidence) {
  const payload = Buffer.from(`${pyJsonDumps(evidence, { compact: true })}\n`, "utf8");
  atomicWriteBytes(output, payload);
  return null;
}

// Return a collision-resistant filename without changing the logical ID.
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

// Derive a log directory that can never equal the evidence output file.
export function evidenceLogDirectory(output) {
  const target = lexicalAbsolute(output);
  const parsed = path.parse(target);
  const stripped = parsed.ext ? path.join(parsed.dir, parsed.name) : target;
  return stripped !== target ? stripped : path.join(parsed.dir, `${parsed.base}.logs`);
}

export function evidenceOutputPath(pkg, options = {}) {
  const { outputRoot = null, outputPath = null } = options;
  const packageId = String(pkg?.package_id || "package");
  if (outputPath !== null && outputPath !== undefined) {
    // Explicit file paths, including extensionless and dotfile names, remain exact.
    return lexicalAbsolute(outputPath);
  }
  if (outputRoot !== null && outputRoot !== undefined) {
    const root = lexicalAbsolute(outputRoot);
    // Accept either an explicit directory or a file-shaped output root/path.
    if (path.extname(root).toLowerCase() === ".json" || Boolean(statOrNull(root)?.isFile())) return root;
    return assertDerivedOutputContained(path.join(root, derivedEvidenceFilename(packageId)), root);
  }
  const root = lexicalAbsolute(path.join(ROOT, "tmp", "review_evidence"));
  return assertDerivedOutputContained(path.join(root, derivedEvidenceFilename(packageId)), root);
}

export function attachReviewEvidence(envelope, options = {}) {
  const { execute, root = null, outputRoot = null, outputPath = null } = options;
  const pkg = isRecord(envelope?.task_package) ? envelope.task_package : envelope;
  if (!isRecord(pkg) || !isStaticReview(pkg)) return null;
  const output = evidenceOutputPath(pkg, { outputRoot, outputPath });
  const evidence = buildEvidence(pkg, {
    execute,
    root,
    logRoot: evidenceLogDirectory(output),
    outputRoot,
    outputPath,
  });
  const sourceCount = evidence.sources.length;
  const checkCount = evidence.mechanical_checks.length;
  const checkFailures = evidence.mechanical_checks.filter((item) => !item.passed).length;
  if (!Object.hasOwn(pkg, "extensions")) pkg.extensions = {};
  const extensions = pkg.extensions;
  if (!isRecord(extensions)) throw new ToolError("task_package.extensions must be an object");
  let evidenceRef;
  if (execute) {
    writeEvidenceFile(output, evidence);
    evidenceRef = {
      schema_version: 1,
      profile: evidence.profile,
      complete: evidence.complete,
      path: pyIsRelativeTo(output, ROOT) ? pyRelativeToPosix(output, ROOT) : String(output),
      source_count: sourceCount,
      check_count: checkCount,
      check_failures: checkFailures,
    };
    if (evidence.profile === SEMANTIC_PROFILE) {
      evidenceRef.material_mode = evidence.material_mode;
      evidenceRef.material_stats = evidence.material_stats;
    }
  } else {
    evidenceRef = {
      schema_version: 1,
      profile: evidence.profile === SEMANTIC_PROFILE ? SEMANTIC_PROFILE : truthyText(pkg?.runtime_context?.network_needed) ? ASSISTED_PROFILE : "preview",
      complete: false,
      path: null,
      source_count: sourceCount,
      check_count: 0,
      check_failures: 0,
    };
    if (evidence.profile === SEMANTIC_PROFILE) {
      evidenceRef.material_mode = evidence.material_mode;
      evidenceRef.material_stats = evidence.material_stats;
    }
  }
  extensions.review_execution = {
    profile: evidenceRef.profile,
    result_schema: "review_result_v1",
    artifact_writer: "async child runner",
    contract_slot: CONTRACT_SLOTS[routeId(pkg)],
  };
  if (evidenceRef.profile === SEMANTIC_PROFILE) extensions.review_execution.material_mode = evidenceRef.material_mode;
  extensions.review_evidence = evidenceRef;
  return evidenceRef;
}
