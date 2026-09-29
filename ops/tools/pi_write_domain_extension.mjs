import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CHILD_WRITE_DOMAIN_PROFILE = "pi-child-write-domain/v1";
export const WRITE_DOMAIN_ENV = "PI_WRITE_DOMAIN";
export const WRITE_DOMAIN_TOOL_NAMES = Object.freeze(["write", "edit"]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeWindowsShellPath(value, platform = process.platform) {
  if (platform !== "win32" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return value;
  }
  const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return value;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

function normalizeToolPathInput(value, platform = process.platform, homeDir = homedir()) {
  let normalized = String(value ?? "").replace(UNICODE_SPACES, " ");
  // Pi 内建路径工具会去掉一个模型偶发添加的 @ 前缀；守门必须与实际执行路径同口径。
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  normalized = normalizeWindowsShellPath(normalized, platform);
  if (normalized === "~") return homeDir;
  if (normalized.startsWith("~/") || (platform === "win32" && normalized.startsWith("~\\"))) {
    return path.join(homeDir, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

// 与 Core 写域一致：已存在祖先 realpath，不存在尾段按字面追加；Windows 统一 case-fold。
export function normalizeDomainPath(value, baseDir, caseInsensitive = false, options = {}) {
  if (value === null || value === undefined || String(value) === "") return null;
  try {
    const platform = options.platform || process.platform;
    const input = normalizeToolPathInput(value, platform, options.homeDir || homedir());
    let normalized = path.normalize(path.isAbsolute(input) ? input : path.resolve(baseDir, input));
    try {
      const literalTail = [];
      let existingAncestor = normalized;
      while (!existsSync(existingAncestor)) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) {
          existingAncestor = null;
          break;
        }
        literalTail.unshift(path.basename(existingAncestor));
        existingAncestor = parent;
      }
      if (existingAncestor) {
        normalized = path.join(realpathSync.native(existingAncestor), ...literalTail);
      }
    } catch {
      // realpath 失败不放宽边界；保留已经解析出的绝对字面路径继续比较。
    }
    normalized = path.normalize(path.resolve(normalized));
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  } catch {
    // 非法 file URL 等输入不得让 extension handler 失效；null 会被判为越界。
    return null;
  }
}

export function isInsidePath(base, candidate) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function parseWriteDomainSpec(raw, { baseDir = process.cwd() } = {}) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${WRITE_DOMAIN_ENV} must encode one JSON object`);
  }
  const version = String(parsed.version || "");
  if (version !== PI_CHILD_WRITE_DOMAIN_PROFILE) {
    throw new Error(`${WRITE_DOMAIN_ENV}.version must be ${PI_CHILD_WRITE_DOMAIN_PROFILE}`);
  }
  const caseInsensitive = parsed.caseInsensitive === true;
  const list = (value, label) => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
      throw new Error(`${WRITE_DOMAIN_ENV}.${label} must be a list of non-empty strings`);
    }
    const normalized = value.map((item) => normalizeDomainPath(item, baseDir, caseInsensitive));
    if (normalized.some((item) => !item)) throw new Error(`${WRITE_DOMAIN_ENV}.${label} contains an invalid path`);
    return [...new Set(normalized)];
  };
  const logRaw = String(parsed.log ?? "");
  if (!logRaw) throw new Error(`${WRITE_DOMAIN_ENV}.log is required`);
  const log = normalizeDomainPath(logRaw, baseDir, false);
  if (!log) throw new Error(`${WRITE_DOMAIN_ENV}.log is invalid`);
  const allowed = list(parsed.allowed ?? [], "allowed");
  const roots = list(parsed.roots ?? [], "roots");
  const deleteAllowed = list(parsed.deleteAllowed ?? [], "deleteAllowed");
  // 只读运行包：即使落在某个已授权根内（例如项目链接指向共享包），常规 write/edit 也必须拒绝。
  const runtimeRoot = parsed.runtimeRoot
    ? normalizeDomainPath(parsed.runtimeRoot, baseDir, caseInsensitive)
    : null;
  return {
    version,
    taskId: String(parsed.taskId || "") || null,
    allowed,
    roots,
    deleteAllowed,
    runtimeRoot,
    log,
    caseInsensitive,
  };
}

// 每个写域条目都是前缀授权:目标等于条目或位于条目之下即允许。与 dispatch_prepare 的
// path_conflict 和 Core 的写域 claim 冲突判定同口径;条目在任务开始前是否已存在、是文件还是
// 目录不影响判定(工具病 20260904-write-extra-directory-denied:尚未创建的 write_extra 目录
// 曾被按精确文件匹配,目录内文件被拒)。
function evaluatePathSet(resolvedPath, entries) {
  if (!resolvedPath) return { allowed: false, matched: null };
  for (const entry of entries) {
    if (resolvedPath === entry || isInsidePath(entry, resolvedPath)) return { allowed: true, matched: entry };
  }
  return { allowed: false, matched: null };
}

export function evaluateWriteDomain(resolvedPath, spec) {
  if (resolvedPath && spec.runtimeRoot && isInsidePath(spec.runtimeRoot, resolvedPath)) {
    // 共享运行包内容不因任务 scope、marker 或目录链接而可写。
    return { allowed: false, matched: null, reason: "runtime_package_read_only" };
  }
  return evaluatePathSet(resolvedPath, [...spec.allowed, ...spec.roots]);
}

export function evaluateDeleteDomain(resolvedPath, spec) {
  return evaluatePathSet(resolvedPath, spec.deleteAllowed || []);
}

export function guardToolCall(event, cwd, spec) {
  const toolName = String(event?.toolName ?? "");
  if (!WRITE_DOMAIN_TOOL_NAMES.includes(toolName)) return null;
  const rawPath = event?.input && typeof event.input === "object" ? event.input.path : undefined;
  const resolved = normalizeDomainPath(rawPath, cwd, spec.caseInsensitive);
  const verdict = evaluateWriteDomain(resolved, spec);
  return {
    schema_version: 1,
    kind: "tool_call",
    profile: PI_CHILD_WRITE_DOMAIN_PROFILE,
    at: new Date().toISOString(),
    task_id: spec.taskId,
    tool_call_id: event?.toolCallId == null ? null : String(event.toolCallId),
    tool: toolName,
    raw_path: rawPath == null ? null : String(rawPath),
    resolved_path: resolved,
    allowed: verdict.allowed,
    matched: verdict.matched,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  };
}

function appendAuditRecord(logPath, record) {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
    return null;
  } catch (error) {
    return String(error?.message || error);
  }
}

function blockedReason(record) {
  return [
    `write domain violation: ${record.tool} target ${record.raw_path ?? "(missing path)"} is outside this task's declared write scope.`,
    "Use a path listed in task_package scope.write/write_extra, the task artifacts directory, or the evidence directory; scope.delete does not authorize write/edit.",
    "Do not retry the same path through another tool; report the required scope change to the parent.",
  ].join(" ");
}

function installPiWriteDomain(pi) {
  const spec = parseWriteDomainSpec(process.env[WRITE_DOMAIN_ENV]);
  if (!spec) return;
  const readyError = appendAuditRecord(spec.log, {
    schema_version: 1,
    kind: "guard_ready",
    profile: PI_CHILD_WRITE_DOMAIN_PROFILE,
    at: new Date().toISOString(),
    task_id: spec.taskId,
  });
  if (readyError) throw new Error(`write domain audit unavailable at startup: ${readyError}`);
  pi.on("tool_call", (event, ctx) => {
    const record = guardToolCall(event, ctx?.cwd || process.cwd(), spec);
    if (!record) return undefined;
    const logError = appendAuditRecord(spec.log, record);
    if (logError) {
      return {
        block: true,
        reason: `write domain audit unavailable; ${record.tool} was blocked before execution: ${logError}`,
      };
    }
    return record.allowed ? undefined : { block: true, reason: blockedReason(record) };
  });
}

export default installPiWriteDomain;

export function readWriteDomainAudit(logPath) {
  if (!logPath || !existsSync(logPath)) return { ready: [], records: [], errors: [] };
  const ready = [];
  const records = [];
  const errors = [];
  const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const record = JSON.parse(lines[index]);
      if (record?.kind === "guard_ready" && record.profile === PI_CHILD_WRITE_DOMAIN_PROFILE) {
        ready.push(record);
      } else if (
        record?.kind === "tool_call" &&
        WRITE_DOMAIN_TOOL_NAMES.includes(record.tool) &&
        typeof record.allowed === "boolean" &&
        typeof record.tool_call_id === "string" &&
        record.tool_call_id.length > 0
      ) {
        records.push(record);
      } else {
        throw new Error("invalid record shape");
      }
    } catch (error) {
      errors.push(`line ${index + 1}: ${error?.message || error}`);
    }
  }
  return { ready, records, errors };
}

export function summarizeWriteDomainAudit({ logPath, observedToolCalls = null, requireReady = true } = {}) {
  const audit = readWriteDomainAudit(logPath);
  const observed = Array.isArray(observedToolCalls)
    ? observedToolCalls.filter((item) => WRITE_DOMAIN_TOOL_NAMES.includes(String(item?.name ?? item?.toolName ?? "")))
    : null;
  const expectedIds = observed
    ? observed.map((item) => String(item?.id ?? item?.toolCallId ?? "")).filter(Boolean).sort()
    : [];
  const recordedIds = audit.records.map((item) => String(item.tool_call_id)).sort();
  const recordedIdSet = new Set(recordedIds);
  const structuralErrors = [...audit.errors];
  if (requireReady && audit.ready.length !== 1) structuralErrors.push(`guard_ready count: ${audit.ready.length}`);
  if (recordedIdSet.size !== recordedIds.length) structuralErrors.push("duplicate tool_call_id in audit");
  const missingObserved = expectedIds.filter((id) => !recordedIdSet.has(id));
  if (observed && expectedIds.length !== observed.length) structuralErrors.push("observed write/edit call missing tool_call_id");
  if (missingObserved.length) structuralErrors.push(`unrecorded observed tool calls: ${missingObserved.join(", ")}`);
  // 被 extension 拒绝的调用未必产生 tool_execution 事件，因此审计可比 runner 事件多；反向缺失才失败。
  const auditComplete = structuralErrors.length === 0;
  const violations = audit.records.filter((item) => item.allowed === false);
  return {
    ready_count: audit.ready.length,
    request_count: audit.records.length,
    allowed_count: audit.records.length - violations.length,
    blocked_count: violations.length,
    audit_complete: auditComplete,
    scope_compliant: auditComplete && violations.length === 0,
    audit_errors: structuralErrors,
    violations: violations.slice(0, 50),
  };
}

export function mergeWriteDomainEvidence(audit, submission = {}) {
  const reportedViolationCount = submission?.submitted
    ? Math.max(0, Number(submission.write_domain_reported_violation_count) || 0)
    : 0;
  return {
    ...audit,
    scope_compliant: audit?.scope_compliant === true && submission?.scope_compliant !== false,
    reported_scope_checked: submission?.submitted === true,
    reported_violation_count: reportedViolationCount,
    violation_count: Math.max(0, Number(audit?.blocked_count) || 0) + reportedViolationCount,
    reported_violations: Array.isArray(submission?.write_domain_reported_violations)
      ? submission.write_domain_reported_violations.slice(0, 50)
      : [],
  };
}

export function evaluateReportedWriteScope(scopeActual, spec, baseDirs = []) {
  const roots = [...new Set(baseDirs.map((item) => String(item || "")).filter(Boolean))];
  const violations = [];
  for (const field of ["written", "deleted"]) {
    const values = Array.isArray(scopeActual?.[field]) ? scopeActual[field] : [];
    const evaluate = field === "deleted" ? evaluateDeleteDomain : evaluateWriteDomain;
    for (const rawPath of values) {
      const candidates = roots.map((root) => normalizeDomainPath(rawPath, root, spec.caseInsensitive)).filter(Boolean);
      const matched = candidates.some((candidate) => evaluate(candidate, spec).allowed);
      if (!matched) violations.push({ field, raw_path: String(rawPath), resolved_candidates: candidates });
    }
  }
  return violations;
}
