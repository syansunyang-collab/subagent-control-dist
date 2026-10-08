// ops/tools/pi_write_domain_extension.mjs
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
var PI_CHILD_WRITE_DOMAIN_PROFILE = "pi-child-write-domain/v1";
var WRITE_DOMAIN_ENV = "PI_WRITE_DOMAIN";
var WRITE_DOMAIN_TOOL_NAMES = Object.freeze(["write", "edit"]);
var UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
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
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  normalized = normalizeWindowsShellPath(normalized, platform);
  if (normalized === "~") return homeDir;
  if (normalized.startsWith("~/") || platform === "win32" && normalized.startsWith("~\\")) {
    return path.join(homeDir, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}
function normalizeDomainPath(value, baseDir, caseInsensitive = false, options = {}) {
  if (value === null || value === void 0 || String(value) === "") return null;
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
    }
    normalized = path.normalize(path.resolve(normalized));
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  } catch {
    return null;
  }
}
function isInsidePath(base, candidate) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function parseWriteDomainSpec(raw, { baseDir = process.cwd() } = {}) {
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
  const transientRoots = list(parsed.transientRoots ?? [], "transientRoots");
  const gitRoot = parsed.gitRoot ? normalizeDomainPath(parsed.gitRoot, baseDir, caseInsensitive) : null;
  const runtimeRoot = parsed.runtimeRoot ? normalizeDomainPath(parsed.runtimeRoot, baseDir, caseInsensitive) : null;
  return {
    version,
    taskId: String(parsed.taskId || "") || null,
    allowed,
    roots,
    deleteAllowed,
    transientRoots,
    gitRoot,
    runtimeRoot,
    log,
    caseInsensitive
  };
}
function evaluatePathSet(resolvedPath, entries) {
  if (!resolvedPath) return { allowed: false, matched: null };
  for (const entry of entries) {
    if (resolvedPath === entry || isInsidePath(entry, resolvedPath)) return { allowed: true, matched: entry };
  }
  return { allowed: false, matched: null };
}
function evaluateWriteDomain(resolvedPath, spec) {
  if (resolvedPath && spec.runtimeRoot && isInsidePath(spec.runtimeRoot, resolvedPath)) {
    return { allowed: false, matched: null, reason: "runtime_package_read_only" };
  }
  return evaluatePathSet(resolvedPath, [...spec.allowed, ...spec.roots]);
}
function evaluateDeleteDomain(resolvedPath, spec) {
  return evaluatePathSet(resolvedPath, [...spec.deleteAllowed || [], ...spec.roots || []]);
}
function guardToolCall(event, cwd, spec) {
  const toolName = String(event?.toolName ?? "");
  if (!WRITE_DOMAIN_TOOL_NAMES.includes(toolName)) return null;
  const rawPath = event?.input && typeof event.input === "object" ? event.input.path : void 0;
  const resolved = normalizeDomainPath(rawPath, cwd, spec.caseInsensitive);
  const verdict = evaluateWriteDomain(resolved, spec);
  return {
    schema_version: 1,
    kind: "tool_call",
    profile: PI_CHILD_WRITE_DOMAIN_PROFILE,
    at: (/* @__PURE__ */ new Date()).toISOString(),
    task_id: spec.taskId,
    tool_call_id: event?.toolCallId == null ? null : String(event.toolCallId),
    tool: toolName,
    raw_path: rawPath == null ? null : String(rawPath),
    resolved_path: resolved,
    allowed: verdict.allowed,
    matched: verdict.matched,
    ...verdict.reason ? { reason: verdict.reason } : {}
  };
}
function appendAuditRecord(logPath, record) {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}
`, "utf8");
    return null;
  } catch (error) {
    return String(error?.message || error);
  }
}
function blockedReason(record, spec) {
  return [
    `write domain violation: ${record.tool} target ${record.raw_path ?? "(missing path)"} is outside this task's declared write scope.`,
    "Write business changes only to paths listed in task_package scope.write/write_extra;",
    `scripts, fixtures, logs and temporary files go under this task's own directories, where creating and deleting are free: ${(spec.roots || []).join(", ")}.`,
    "scope.delete does not authorize write/edit. Do not retry the same path through another tool; report the required scope change to the parent."
  ].join(" ");
}
function installPiWriteDomain(pi) {
  const spec = parseWriteDomainSpec(process.env[WRITE_DOMAIN_ENV]);
  if (!spec) return;
  const readyError = appendAuditRecord(spec.log, {
    schema_version: 1,
    kind: "guard_ready",
    profile: PI_CHILD_WRITE_DOMAIN_PROFILE,
    at: (/* @__PURE__ */ new Date()).toISOString(),
    task_id: spec.taskId
  });
  if (readyError) throw new Error(`write domain audit unavailable at startup: ${readyError}`);
  pi.on("tool_call", (event, ctx) => {
    const record = guardToolCall(event, ctx?.cwd || process.cwd(), spec);
    if (!record) return void 0;
    const logError = appendAuditRecord(spec.log, record);
    if (logError) {
      return {
        block: true,
        reason: `write domain audit unavailable; ${record.tool} was blocked before execution: ${logError}`
      };
    }
    return record.allowed ? void 0 : { block: true, reason: blockedReason(record, spec) };
  });
}
var pi_write_domain_extension_default = installPiWriteDomain;
function readWriteDomainAudit(logPath) {
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
      } else if (record?.kind === "tool_call" && WRITE_DOMAIN_TOOL_NAMES.includes(record.tool) && typeof record.allowed === "boolean" && typeof record.tool_call_id === "string" && record.tool_call_id.length > 0) {
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
function summarizeWriteDomainAudit({ logPath, observedToolCalls = null, requireReady = true } = {}) {
  const audit = readWriteDomainAudit(logPath);
  const observed = Array.isArray(observedToolCalls) ? observedToolCalls.filter((item) => WRITE_DOMAIN_TOOL_NAMES.includes(String(item?.name ?? item?.toolName ?? ""))) : null;
  const expectedIds = observed ? observed.map((item) => String(item?.id ?? item?.toolCallId ?? "")).filter(Boolean).sort() : [];
  const recordedIds = audit.records.map((item) => String(item.tool_call_id)).sort();
  const recordedIdSet = new Set(recordedIds);
  const structuralErrors = [...audit.errors];
  if (requireReady && audit.ready.length !== 1) structuralErrors.push(`guard_ready count: ${audit.ready.length}`);
  if (recordedIdSet.size !== recordedIds.length) structuralErrors.push("duplicate tool_call_id in audit");
  const missingObserved = expectedIds.filter((id) => !recordedIdSet.has(id));
  if (observed && expectedIds.length !== observed.length) structuralErrors.push("observed write/edit call missing tool_call_id");
  if (missingObserved.length) structuralErrors.push(`unrecorded observed tool calls: ${missingObserved.join(", ")}`);
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
    violations: violations.slice(0, 50)
  };
}
function mergeWriteDomainEvidence(audit, submission = {}) {
  const reportedViolationCount = submission?.submitted ? Math.max(0, Number(submission.write_domain_reported_violation_count) || 0) : 0;
  return {
    ...audit,
    scope_compliant: audit?.scope_compliant === true && submission?.scope_compliant !== false,
    reported_scope_checked: submission?.submitted === true,
    reported_violation_count: reportedViolationCount,
    violation_count: Math.max(0, Number(audit?.blocked_count) || 0) + reportedViolationCount,
    reported_violations: Array.isArray(submission?.write_domain_reported_violations) ? submission.write_domain_reported_violations.slice(0, 50) : []
  };
}
function gitIgnoredPaths(gitRoot, candidates) {
  const inside = [...new Set(candidates)].filter((candidate) => gitRoot && candidate !== gitRoot && isInsidePath(gitRoot, candidate));
  if (!inside.length) return /* @__PURE__ */ new Set();
  const relative = inside.map((candidate) => path.relative(gitRoot, candidate).split(path.sep).join("/"));
  const run = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    cwd: gitRoot,
    input: `${relative.join("\0")}\0`,
    encoding: "utf8",
    windowsHide: true
  });
  if (run.status !== 0) return /* @__PURE__ */ new Set();
  const hits = new Set(String(run.stdout || "").split("\0").filter(Boolean));
  return new Set(inside.filter((_, index) => hits.has(relative[index])));
}
function evaluateReportedWriteScope(scopeActual, spec, baseDirs = []) {
  const roots = [...new Set(baseDirs.map((item) => String(item || "")).filter(Boolean))];
  const pending = [];
  for (const field of ["written", "deleted"]) {
    const values = Array.isArray(scopeActual?.[field]) ? scopeActual[field] : [];
    const evaluate = field === "deleted" ? evaluateDeleteDomain : evaluateWriteDomain;
    for (const rawPath of values) {
      const candidates = roots.map((root) => normalizeDomainPath(rawPath, root, spec.caseInsensitive)).filter(Boolean);
      if (candidates.some((candidate) => evaluate(candidate, spec).allowed)) continue;
      if (candidates.some((candidate) => evaluatePathSet(candidate, spec.transientRoots || []).allowed)) continue;
      pending.push({ field, raw_path: String(rawPath), resolved_candidates: candidates });
    }
  }
  const ignored = gitIgnoredPaths(spec.gitRoot, pending.flatMap((item) => item.resolved_candidates));
  return pending.filter((item) => !item.resolved_candidates.some((candidate) => ignored.has(candidate)));
}
export {
  PI_CHILD_WRITE_DOMAIN_PROFILE,
  WRITE_DOMAIN_ENV,
  WRITE_DOMAIN_TOOL_NAMES,
  pi_write_domain_extension_default as default,
  evaluateDeleteDomain,
  evaluateReportedWriteScope,
  evaluateWriteDomain,
  guardToolCall,
  isInsidePath,
  mergeWriteDomainEvidence,
  normalizeDomainPath,
  parseWriteDomainSpec,
  readWriteDomainAudit,
  summarizeWriteDomainAudit
};
