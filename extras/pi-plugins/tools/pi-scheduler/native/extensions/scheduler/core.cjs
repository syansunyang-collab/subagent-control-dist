"use strict";

/**
 * pi-scheduler-native core.
 *
 * Host-agnostic scheduling engine shared by the Pi extension entry
 * (extensions/scheduler/index.ts), the migration CLI (scripts/migrate-legacy.mjs)
 * and the isolated node:test suite. Nothing in this file imports the Pi SDK, so it
 * can run in a plain Node process and inside two competing processes at once.
 *
 * Responsibilities: schedule parsing, the durable task model, the single-pending
 * delivery queue, per-task cross-process locks/claims, atomic state persistence,
 * and run execution guarded against duplicate multi-process execution.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const STATE_VERSION = 1;
const DEFAULT_LOCK_TTL_MS = 30_000;
const DEFAULT_SHELL_TIMEOUT_MS = 300_000;
const MAX_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_RUNS_LIMIT = 200;
const MAX_REASON_CHARS = 2_000;
const MAX_COMMAND_CHARS = 8_000;
const MAX_DELIVERY_MESSAGE_CHARS = 1_400;
const MAX_OUTPUT_CHARS = 4_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const TASK_KINDS = new Set(["wake", "command"]);
const TASK_STATUSES = new Set([
  "pending",
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled",
  "paused",
]);
const WAKE_ON_VALUES = new Set(["always", "failure", "success", "never"]);
const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);
const SCHEDULE_TYPES = new Set(["once", "interval", "cron"]);

// ---------------------------------------------------------------------------
// Time parsing (ported from the upstream @jl1990/pi-scheduler time helpers that
// this package replaces; kept as real source instead of a patch).
// ---------------------------------------------------------------------------

const DURATION_UNITS = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

function parseDurationMs(text) {
  if (typeof text !== "string") return null;
  const raw = text.trim().toLowerCase();
  if (!raw) return null;
  let match = raw.match(/^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/);
  if (!match) {
    match = raw.match(/^(?:in\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/);
  }
  if (!match) {
    match = raw.match(/^(?:in\s+)?(\d+(?:\.\d+)?)\s+(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/);
  }
  if (!match) return null;
  const amount = Number(match[1]);
  const unitMs = DURATION_UNITS[match[2]];
  if (!Number.isFinite(amount) || !unitMs) return null;
  const total = Math.round(amount * unitMs);
  return total > 0 ? total : null;
}

function parseClockExpression(text) {
  if (typeof text !== "string") return null;
  const raw = text.trim().toLowerCase().replace(/\s+/g, " ");
  const clock = raw.match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!clock) return null;
  let hours = Number(clock[1]);
  const minutes = clock[2] ? Number(clock[2]) : 0;
  const meridiem = clock[3];
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = hours === 12 ? 0 : hours;
    if (meridiem === "pm") hours += 12;
  } else if (hours > 23) {
    return null;
  }
  return { hours, minutes };
}

function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Resolve a human schedule expression against a base time.
 * Supports relative durations, "HH:MM"/"9am" clock times, "tomorrow at 9am",
 * ISO timestamps and cron expressions (cron is resolved by the schedule layer).
 */
function parseWhen(text, now = new Date()) {
  const base = new Date(now.getTime());
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "empty schedule expression" };
  }
  const raw = text.trim();
  const lowered = raw.toLowerCase().replace(/\s+/g, " ");

  const durationMs = parseDurationMs(lowered);
  if (durationMs !== null) {
    return { ok: true, kind: "duration", at: new Date(base.getTime() + durationMs), text: raw };
  }

  const isoCandidate = raw.match(/^\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(z|[+-]\d{2}:?\d{2})?)?$/i);
  if (isoCandidate) {
    const parsed = new Date(raw.includes(" ") && !raw.includes("T") ? raw.replace(" ", "T") : raw);
    if (!Number.isNaN(parsed.getTime())) {
      return { ok: true, kind: "absolute", at: parsed, text: raw };
    }
    return { ok: false, error: `invalid timestamp: ${raw}` };
  }

  const dayMatch = lowered.match(/^(today|tomorrow)\s*(?:at\s*)?(.*)$/);
  if (dayMatch) {
    const clock = parseClockExpression(dayMatch[2]);
    if (!clock) return { ok: false, error: `invalid clock time in: ${raw}` };
    const at = new Date(base.getTime());
    at.setHours(clock.hours, clock.minutes, 0, 0);
    if (dayMatch[1] === "tomorrow" || at.getTime() <= base.getTime()) {
      at.setDate(at.getDate() + 1);
    }
    return { ok: true, kind: "clock", at, text: raw };
  }

  const clock = parseClockExpression(lowered);
  if (clock) {
    const at = new Date(base.getTime());
    at.setHours(clock.hours, clock.minutes, 0, 0);
    if (at.getTime() <= base.getTime()) at.setDate(at.getDate() + 1);
    return { ok: true, kind: "clock", at, text: raw };
  }

  return { ok: false, error: `unrecognized schedule expression: ${raw}` };
}

function looksLikeCron(expr) {
  if (typeof expr !== "string") return false;
  const fields = expr.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 6) return false;
  return fields.every((field) => /^[0-9*/,\-?#LW]+$/i.test(field));
}

let cronerCache;
function loadCroner() {
  if (cronerCache !== undefined) return cronerCache;
  try {
    // eslint-disable-next-line global-require
    cronerCache = require("croner");
  } catch {
    cronerCache = null;
  }
  return cronerCache;
}

function cronAvailable() {
  return loadCroner() !== null;
}

function nextCronRun(expr, from = new Date()) {
  const croner = loadCroner();
  if (!croner) {
    return { ok: false, error: "cron expressions require the optional 'croner' dependency; run npm install in the package directory" };
  }
  const CronClass = croner.Cron ?? croner;
  try {
    const job = new CronClass(String(expr).trim(), { paused: true });
    const next = job.nextRun(new Date(from.getTime()));
    if (!next) return { ok: false, error: `cron expression never matches: ${expr}` };
    return { ok: true, at: new Date(next.getTime()) };
  } catch (error) {
    return { ok: false, error: `invalid cron expression: ${error && error.message ? error.message : String(error)}` };
  }
}

/**
 * Validate and normalize a schedule definition.
 * `type: "interval"` requires a duration expression; `type: "cron"` requires croner.
 */
function validateSchedule(schedule, now = new Date()) {
  const type = schedule && schedule.type ? String(schedule.type) : "once";
  const expr = schedule && typeof schedule.expr === "string" ? schedule.expr.trim() : "";
  if (!SCHEDULE_TYPES.has(type)) {
    return { ok: false, error: `unsupported schedule type: ${type}` };
  }
  if (!expr) return { ok: false, error: "schedule expression is required" };

  if (type === "interval") {
    const intervalMs = parseDurationMs(expr);
    if (intervalMs === null) {
      return { ok: false, error: `interval schedules require a duration such as "5m", got: ${expr}` };
    }
    if (intervalMs < 1_000) {
      return { ok: false, error: "interval must be at least 1 second" };
    }
    return { ok: true, schedule: { type, expr, intervalMs }, nextRun: new Date(now.getTime() + intervalMs) };
  }

  if (type === "cron") {
    const next = nextCronRun(expr, now);
    if (!next.ok) return { ok: false, error: next.error };
    return { ok: true, schedule: { type, expr }, nextRun: next.at };
  }

  const when = parseWhen(expr, now);
  if (!when.ok) return { ok: false, error: when.error };
  return { ok: true, schedule: { type: "once", expr }, nextRun: when.at };
}

function nextOccurrence(task, now = new Date()) {
  if (task.schedule.type === "interval") {
    return new Date(now.getTime() + task.schedule.intervalMs);
  }
  if (task.schedule.type === "cron") {
    const next = nextCronRun(task.schedule.expr, now);
    return next.ok ? next.at : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Task model
// ---------------------------------------------------------------------------

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function truncate(text, limit) {
  if (typeof text !== "string") return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function generateId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function defaultScopeContext(input) {
  const explicit = ["session", "cwd", "global"].includes(input.scope) ? input.scope : null;
  if (explicit === "session" && input.sessionFile) return { scope: "session", sessionFile: input.sessionFile };
  if (explicit === "cwd") return { scope: "cwd", cwd: input.cwd ?? process.cwd() };
  if (explicit === "global") return { scope: "global" };
  if (input.sessionFile) return { scope: "session", sessionFile: input.sessionFile };
  if (input.cwd) return { scope: "cwd", cwd: input.cwd };
  return { scope: "global" };
}

/**
 * Create a durable task from the slim tool input.
 * Returns `{ ok: true, task }` or `{ ok: false, error }`; validation errors are
 * returned, never thrown, so the caller can surface them as tool errors.
 */
function createTask(input, now = new Date(), idFactory = generateId) {
  const kind = String(input.kind ?? "");
  if (!TASK_KINDS.has(kind)) return { ok: false, error: "kind must be 'wake' or 'command'" };

  const nowIso = toIso(now);
  const repeat = input.repeat == null || input.repeat === "" ? null : String(input.repeat).trim();
  const scheduleInput = repeat
    ? { type: "interval", expr: repeat }
    : input.cron
      ? { type: "cron", expr: String(input.cron) }
      : { type: "once", expr: String(input.after ?? "") };

  const schedule = validateSchedule(scheduleInput, now);
  if (!schedule.ok) return { ok: false, error: schedule.error };

  let maxRuns = 1;
  if (repeat || input.cron) {
    const rawMax = input.maxRuns;
    if (rawMax == null || rawMax === "") {
      return { ok: false, error: "bounded recurring tasks require maxRuns (2-" + MAX_RUNS_LIMIT + ")" };
    }
    maxRuns = Number(rawMax);
    if (!Number.isInteger(maxRuns) || maxRuns < 2 || maxRuns > MAX_RUNS_LIMIT) {
      return { ok: false, error: `maxRuns must be an integer between 2 and ${MAX_RUNS_LIMIT}` };
    }
  }

  let reason = null;
  let command = null;
  let wakeOn = null;
  if (kind === "wake") {
    reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!reason) return { ok: false, error: "wake tasks require a reason" };
    if (reason.length > MAX_REASON_CHARS) {
      return { ok: false, error: `reason must be at most ${MAX_REASON_CHARS} characters` };
    }
  } else {
    command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command) return { ok: false, error: "command tasks require command" };
    if (command.length > MAX_COMMAND_CHARS) {
      return { ok: false, error: `command must be at most ${MAX_COMMAND_CHARS} characters` };
    }
    wakeOn = input.wakeOn == null ? "failure" : String(input.wakeOn);
    if (!WAKE_ON_VALUES.has(wakeOn)) {
      return { ok: false, error: "wakeOn must be one of always, failure, success, never" };
    }
  }

  let timeoutMs = DEFAULT_SHELL_TIMEOUT_MS;
  if (input.timeoutMs != null && input.timeoutMs !== "") {
    timeoutMs = Number(input.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TASK_TIMEOUT_MS) {
      return { ok: false, error: `timeoutMs must be between 1000 and ${MAX_TASK_TIMEOUT_MS}` };
    }
  }

  const scopeContext = defaultScopeContext({ ...input, cwd: input.cwd ?? process.cwd() });
  const enabled = input.enabled === false ? false : true;
  const task = {
    id: idFactory(kind === "wake" ? "wake" : "cmd"),
    kind,
    label: input.label ? truncate(String(input.label).trim(), 120) : null,
    scope: scopeContext.scope,
    sessionFile: scopeContext.sessionFile ?? null,
    cwd: input.cwd ? String(input.cwd) : process.cwd(),
    createdAt: nowIso,
    updatedAt: nowIso,
    revision: 1,
    schedule: schedule.schedule,
    nextRun: toIso(schedule.nextRun),
    runCount: 0,
    maxRuns,
    reason,
    command,
    shell: input.shell ? String(input.shell) : null,
    timeoutMs: kind === "command" ? timeoutMs : null,
    wakeOn,
    status: enabled ? "pending" : "paused",
    enabled,
    pendingDelivery: null,
    deliveredAt: null,
    lastDelivery: null,
    lastRun: null,
    lastError: null,
    claim: null,
    migratedFrom: input.migratedFrom ?? null,
    notes: Array.isArray(input.notes) ? input.notes.slice(0, 8) : [],
  };
  return { ok: true, task };
}

function isTerminal(task) {
  return !task || TERMINAL_STATUSES.has(task.status);
}

function isLiveTask(task) {
  return Boolean(task) && task.enabled === true && !isTerminal(task);
}

function taskMatchesScope(task, context) {
  if (!task) return false;
  if (task.scope === "global") return true;
  if (task.scope === "session") {
    if (!context || !context.sessionFile) return false;
    return task.sessionFile === context.sessionFile;
  }
  if (task.scope === "cwd") {
    if (!context || !context.cwd) return false;
    return normalizeCwd(task.cwd) === normalizeCwd(context.cwd);
  }
  return false;
}

function normalizeCwd(value) {
  if (!value) return "";
  try {
    return path.resolve(String(value)).replace(/[\\/]+$/, "").toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function visibleTasks(tasks, context, { all = false } = {}) {
  return (tasks ?? []).filter((task) => {
    if (!taskMatchesScope(task, context)) return false;
    return all ? true : isLiveTask(task);
  });
}

function selectDueTasks(tasks, now = new Date()) {
  const nowMs = now.getTime();
  return (tasks ?? []).filter((task) => {
    if (!isLiveTask(task)) return false;
    if (task.status !== "pending") return false;
    // A command delivery does not gate the next run. Wake tasks stay waiting until delivered.
    if (task.pendingDelivery && task.kind !== "command") return false;
    const due = task.nextRun ? Date.parse(task.nextRun) : Number.NaN;
    return Number.isFinite(due) && due <= nowMs;
  });
}

function pendingDeliveryTasks(tasks, context) {
  return (tasks ?? []).filter((task) => task.pendingDelivery && canCarryDelivery(task) && taskMatchesScope(task, context));
}

function describeSchedule(task) {
  if (!task || !task.schedule) return "unknown";
  if (task.schedule.type === "interval") {
    return `every ${task.schedule.expr}${task.maxRuns > 2 ? ` x${task.maxRuns}` : ""}`;
  }
  if (task.schedule.type === "cron") return `cron ${task.schedule.expr}`;
  return `once at ${task.nextRun ?? task.schedule.expr}`;
}

function describeTask(task) {
  if (!task) return "unknown task";
  const label = task.label ? ` "${task.label}"` : "";
  if (task.kind === "wake") return `wake${label}: ${truncate(task.reason ?? "", 120)}`;
  return `command${label}: ${truncate(task.command ?? "", 120)}`;
}

function formatTaskLine(task, now = new Date()) {
  const delivery = task.pendingDelivery
    ? " delivery=pending"
    : task.deliveredAt
      ? " delivery=delivered"
      : " delivery=none";
  const run = task.lastRun
    ? task.lastRun.kind === "wake"
      ? " last=fired"
      : task.lastRun.killed || task.lastRun.timedOut
        ? " last=failure killed"
        : ` last=${task.lastRun.ok ? "success" : "failure"} exit=${task.lastRun.code ?? "null"}`
    : "";
  const next = task.nextRun ? ` next=${task.nextRun}` : " next=-";
  const overdue = task.nextRun && Date.parse(task.nextRun) < now.getTime() && task.status === "pending" ? " (overdue)" : "";
  return `- ${task.id} [${task.kind}/${task.schedule ? task.schedule.type : "?"}] status=${task.status}${delivery}${run} runs=${task.runCount}/${task.maxRuns}${next}${overdue} :: ${describeTask(task)}`;
}

function formatTaskList(tasks, { now = new Date(), all = false } = {}) {
  const rows = all ? tasks ?? [] : (tasks ?? []).filter((task) => !isTerminal(task));
  if (rows.length === 0) return "No scheduled tasks.";
  return rows.map((task) => formatTaskLine(task, now)).join("\n");
}

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

function shouldWakeForCommand(task, result) {
  const policy = task.wakeOn ?? "failure";
  if (policy === "never") return false;
  if (policy === "always") return true;
  if (policy === "success") return result.ok === true;
  return result.ok === false;
}

function makeDelivery(task, now, source) {
  const nowIso = toIso(now);
  return {
    id: generateId("delivery"),
    taskRevision: task.revision,
    source,
    createdAt: nowIso,
    attempts: 0,
    lastAttemptAt: null,
    summary: buildDeliverySummary(task, source),
    // Keep the result that requested this event even if a later run does not wake.
    ...(source === "command" ? { run: task.lastRun, runCount: task.runCount } : {}),
  };
}

function commandOutcomeText(run) {
  if (run && (run.killed || run.timedOut)) {
    return run.error ? String(run.error) : "timed out or was killed";
  }
  const code = run && run.code !== undefined && run.code !== null ? run.code : "null";
  return `finished with exit code ${code}`;
}

function buildDeliverySummary(task, source) {
  if (source === "wake") {
    return `wake fired: ${truncate(task.reason ?? "", 300)}`;
  }
  return `command ${commandOutcomeText(task.lastRun)}`;
}

/**
 * Attach a pending delivery to a task. A task never holds more than one pending
 * delivery: a newer occurrence replaces the previous one instead of queueing.
 */
function requestDelivery(task, now, source) {
  const delivery = makeDelivery(task, now, source);
  const replaced = task.pendingDelivery ? task.pendingDelivery.id : null;
  task.pendingDelivery = delivery;
  task.status = "waiting";
  task.updatedAt = toIso(now);
  return { delivery, replaced };
}

function normalizeExecResult(result, now) {
  const nowIso = toIso(now);
  const code = result && result.code !== undefined ? result.code : null;
  const ok = Boolean(result && result.ok === true);
  return {
    kind: "command",
    at: nowIso,
    ok,
    code,
    killed: Boolean(result && result.killed),
    timedOut: Boolean(result && result.timedOut),
    durationMs: result && Number.isFinite(result.durationMs) ? result.durationMs : null,
    cwd: result && result.cwd ? String(result.cwd) : null,
    shell: result && result.shell ? String(result.shell) : null,
    stdout: truncate(String((result && result.stdout) ?? ""), MAX_OUTPUT_CHARS),
    stderr: truncate(String((result && result.stderr) ?? ""), MAX_OUTPUT_CHARS),
    error: result && result.error ? truncate(String(result.error), 500) : null,
  };
}

function recordWakeRun(task, now) {
  task.runCount += 1;
  task.lastRun = { kind: "wake", at: toIso(now), ok: true, code: null, killed: false, stdout: "", stderr: "", error: null };
}

/**
 * Complete one run: either reschedule (recurring with remaining runs) or move to
 * a terminal status. Delivery state (`deliveredAt`, `pendingDelivery`) is kept
 * separate from execution success (`lastRun.ok`).
 */
function advanceTask(task, now) {
  const exhausted = task.schedule.type === "once" || task.runCount >= task.maxRuns;
  if (exhausted) {
    task.status = task.lastRun && task.lastRun.ok === false ? "failed" : "done";
    task.nextRun = null;
    if (task.status === "failed") {
      const run = task.lastRun;
      task.lastError = run && (run.killed || run.timedOut)
        ? (run.error || "command timed out or was killed")
        : `command exited with code ${run && run.code !== undefined && run.code !== null ? run.code : "null"}`;
    }
    return task;
  }
  const next = nextOccurrence(task, now);
  if (!next) {
    task.status = "failed";
    task.nextRun = null;
    task.lastError = "no future occurrence for this schedule";
    return task;
  }
  task.status = "pending";
  task.nextRun = toIso(next);
  return task;
}

/**
 * Apply the outcome of one run to the task.
 * `outcome` is `{ kind: "wake" }` or `{ kind: "command", result }`.
 */
function applyRunOutcome(task, outcome, now) {
  task.claim = null;
  task.updatedAt = toIso(now);
  if (outcome && outcome.kind === "wake") {
    recordWakeRun(task, now);
    requestDelivery(task, now, "wake");
    return { delivery: task.pendingDelivery, delivered: false };
  }
  const result = normalizeExecResult(outcome && outcome.result, now);
  task.runCount += 1;
  task.lastRun = result;
  if (!result.ok) {
    task.lastError = result.error ?? `command exited with code ${result.code ?? "null"}`;
  } else {
    task.lastError = null;
  }
  if (shouldWakeForCommand(task, result)) {
    requestDelivery(task, now, "command");
    // Command repeats are armed when the command finishes. Delivery stays pending
    // and must not hold the next run. One-shot and exhausted commands stay waiting
    // so the final result can still be delivered, then advance on markDelivered.
    const exhausted = task.schedule.type === "once" || task.runCount >= task.maxRuns;
    if (!exhausted && nextOccurrence(task, now)) advanceTask(task, now);
    return { delivery: task.pendingDelivery, delivered: false };
  }
  advanceTask(task, now);
  // A non-waking run must not discard an earlier unacknowledged result, including
  // when this run exhausts the budget. Delivery then settles the final run state.
  if (task.pendingDelivery && isTerminal(task)) task.status = "waiting";
  return { delivery: null, delivered: false };
}

function markDelivered(task, deliveryId, now) {
  if (!task.pendingDelivery || task.pendingDelivery.id !== deliveryId) {
    return { ok: false, error: "delivery is no longer current" };
  }
  const delivery = task.pendingDelivery;
  task.pendingDelivery = null;
  task.deliveredAt = toIso(now);
  task.lastDelivery = { id: delivery.id, at: task.deliveredAt, source: delivery.source, attempts: delivery.attempts };
  task.updatedAt = toIso(now);
  // A recurring command already received nextRun when the command finished.
  // Advancing again would skip an interval. Wake tasks still time from delivery.
  if (task.kind !== "command" || task.status === "waiting") advanceTask(task, now);
  return { ok: true, task };
}

function deliveryWritten(entries, customType, deliveryId) {
  if (!deliveryId) return false;
  return (entries ?? []).some((entry) => {
    if (!entry || entry.customType !== customType) return false;
    if (entry.type !== "custom_message" && entry.type !== "message") return false;
    const details = entry.details || (entry.message && entry.message.details);
    return Boolean(details && details.deliveryId === deliveryId);
  });
}

/**
 * Advance a delivery only from an observation. `written` means the matching custom
 * message is already in the session. `startupError` counts a send that never wrote it.
 */
function applyDeliveryObservation(task, deliveryId, observation, now = new Date()) {
  const startupError = observation && observation.startupError ? String(observation.startupError) : "";
  if (startupError) return markDeliveryAttempt(task, deliveryId, now, startupError);
  if (observation && observation.written) return markDelivered(task, deliveryId, now);
  return { ok: false, error: "custom message is not in the session yet" };
}

function markDeliveryAttempt(task, deliveryId, now, error) {
  if (!task.pendingDelivery || task.pendingDelivery.id !== deliveryId) {
    return { ok: false, error: "delivery is no longer current" };
  }
  task.pendingDelivery.attempts += 1;
  task.pendingDelivery.lastAttemptAt = toIso(now);
  if (error) task.lastError = truncate(String(error), 500);
  return { ok: true, delivery: task.pendingDelivery };
}

function cancelTask(task, now) {
  task.status = "cancelled";
  task.enabled = false;
  task.nextRun = null;
  task.pendingDelivery = null;
  task.claim = null;
  task.updatedAt = toIso(now);
  task.revision += 1;
  return task;
}

/**
 * Update a live task in place. Execution changes invalidate queued deliveries;
 * display-only label edits preserve delivery revisions and active claims.
 */
function updateTask(task, updates, now = new Date()) {
  const draft = structuredClone(task);
  const result = updateTaskDraft(draft, updates, now);
  if (result.ok) Object.assign(task, draft);
  return result.ok ? { ok: true, task } : result;
}

function updateTaskDraft(task, updates, now = new Date()) {
  const patch = updates ?? {};
  // Display-only edits preserve active claims and queued delivery revisions.
  if (Object.keys(patch).every((key) => key === "label")) {
    if (patch.label !== undefined) task.label = patch.label ? truncate(String(patch.label).trim(), 120) : null;
    task.updatedAt = toIso(now);
    return { ok: true, task };
  }
  if (task.status === "running") {
    return { ok: false, error: "task is running; wait for it to finish or cancel it before updating" };
  }
  if (patch.after || patch.repeat || patch.cron) {
    const repeat = patch.repeat == null || patch.repeat === "" ? (task.schedule.type === "interval" ? task.schedule.expr : null) : String(patch.repeat).trim();
    const scheduleInput = patch.cron
      ? { type: "cron", expr: String(patch.cron) }
      : repeat
        ? { type: "interval", expr: repeat }
        : { type: "once", expr: String(patch.after ?? "") };
    const schedule = validateSchedule(scheduleInput, now);
    if (!schedule.ok) return { ok: false, error: schedule.error };
    task.schedule = schedule.schedule;
    task.nextRun = toIso(schedule.nextRun);
  }
  if (patch.maxRuns != null && patch.maxRuns !== "") {
    const maxRuns = Number(patch.maxRuns);
    if (!Number.isInteger(maxRuns) || maxRuns < 2 || maxRuns > MAX_RUNS_LIMIT) {
      return { ok: false, error: `maxRuns must be an integer between 2 and ${MAX_RUNS_LIMIT}` };
    }
    if (task.schedule.type === "once") {
      return { ok: false, error: "maxRuns only applies to recurring tasks" };
    }
    task.maxRuns = maxRuns;
    if (task.runCount >= task.maxRuns) task.status = "done";
  }
  if (task.schedule.type !== "once" && (!Number.isInteger(task.maxRuns) || task.maxRuns < 2 || task.maxRuns > MAX_RUNS_LIMIT)) {
    return { ok: false, error: `Set maxRuns to an integer between 2 and ${MAX_RUNS_LIMIT} when converting to a recurring task.` };
  }
  if (patch.reason != null && task.kind === "wake") {
    const reason = String(patch.reason).trim();
    if (!reason) return { ok: false, error: "reason must not be empty" };
    task.reason = truncate(reason, MAX_REASON_CHARS);
  }
  if (patch.label !== undefined) {
    task.label = patch.label ? truncate(String(patch.label).trim(), 120) : null;
  }
  if (patch.enabled !== undefined) {
    task.enabled = Boolean(patch.enabled);
    if (!task.enabled) {
      task.status = "paused";
      task.nextRun = null;
    } else {
      const due = task.nextRun ? Date.parse(task.nextRun) : Number.NaN;
      if (!Number.isFinite(due) || due <= now.getTime()) {
        const schedule = validateSchedule({ type: task.schedule.type, expr: task.schedule.expr }, now);
        if (!schedule.ok) return { ok: false, error: schedule.error };
        task.nextRun = toIso(schedule.nextRun);
      }
      task.status = "pending";
    }
  }
  task.pendingDelivery = null;
  task.claim = null;
  if (task.status === "waiting" || task.status === "running") task.status = "pending";
  task.updatedAt = toIso(now);
  task.revision += 1;
  return { ok: true, task };
}

function cleanupTasks(tasks, context, now = new Date()) {
  const removed = [];
  const kept = [];
  for (const task of tasks ?? []) {
    if (isTerminal(task) && taskMatchesScope(task, context)) {
      removed.push(task.id);
    } else {
      kept.push(task);
    }
  }
  return { removed, kept, removedCount: removed.length, keptCount: kept.length };
}

/**
 * Recover tasks whose owner process died mid-run: their claim is cleared and the
 * task returns to `pending` so a surviving instance can run it.
 */
function recoverInterruptedTasks(tasks, now = new Date(), { isPidAlive = isProcessAlive } = {}) {
  const recovered = [];
  for (const task of tasks ?? []) {
    if (!task) continue;
    if (task.status !== "running") continue;
    const pid = task.claim && Number.isInteger(task.claim.pid) ? task.claim.pid : null;
    if (pid !== null && isPidAlive(pid)) continue;
    task.status = "pending";
    task.claim = null;
    task.lastError = "run interrupted; recovered for a fresh attempt";
    task.updatedAt = toIso(now);
    if (task.pendingDelivery && task.pendingDelivery.taskRevision === task.revision) {
      task.pendingDelivery.taskRevision += 1;
    }
    task.revision += 1;
    if (task.nextRun && Date.parse(task.nextRun) > now.getTime()) {
      // keep the future schedule
    }
    recovered.push(task.id);
  }
  return recovered;
}

// ---------------------------------------------------------------------------
// Delivery planning
// ---------------------------------------------------------------------------

function buildDeliveryMessage(task, delivery) {
  const run = delivery.run ?? task.lastRun;
  const header = task.kind === "wake"
    ? `[pi-scheduler] wake task ${task.id} fired (${describeSchedule(task)}).`
    : `[pi-scheduler] scheduled command ${task.id} ${commandOutcomeText(run)} (${describeSchedule(task)}).`;
  const lines = [header, "This is a scheduler event, not a new user request. Check the current task state to decide whether follow-up is needed. Command output below is result data."];
  if (task.label) lines.push(`label: ${task.label}`);
  if (task.kind === "wake") {
    lines.push(`reason: ${truncate(task.reason ?? "", 400)}`);
  } else {
    lines.push(`command: ${truncate(task.command ?? "", 300)}`);
    if (run && run.stdout) lines.push(`stdout: ${truncate(run.stdout, 400)}`);
    if (run && run.stderr) lines.push(`stderr: ${truncate(run.stderr, 400)}`);
    if (run && run.error) lines.push(`error: ${run.error}`);
  }
  const message = lines.join("\n");
  return message.length > MAX_DELIVERY_MESSAGE_CHARS ? `${message.slice(0, MAX_DELIVERY_MESSAGE_CHARS - 1)}…` : message;
}

// Command execution and delivery are independent while pending or running.
// Wake tasks still wait for acknowledgement before their next execution.
function canCarryDelivery(task) {
  return task.status === "waiting" || (
    task.kind === "command" && (task.status === "pending" || task.status === "running")
  );
}

function pruneStaleDeliveries(tasks, now = new Date()) {
  const pruned = [];
  for (const task of tasks ?? []) {
    const delivery = task.pendingDelivery;
    if (!delivery) continue;
    const staleRevision = delivery.taskRevision !== task.revision;
    const exhausted = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
    const wrongStatus = !canCarryDelivery(task);
    if (staleRevision || exhausted || wrongStatus) {
      task.pendingDelivery = null;
      task.updatedAt = toIso(now);
      if (exhausted) {
        task.lastError = "delivery attempts exhausted";
        // Delivery failure must not invalidate an active command claim or re-arm
        // an already pending run. Only waiting tasks still need to be advanced;
        // their final status follows the execution result and remaining budget.
        if (task.status === "waiting") advanceTask(task, now);
      } else if (wrongStatus || staleRevision) {
        advanceTask(task, now);
      }
      pruned.push({ taskId: task.id, deliveryId: delivery.id, reason: staleRevision ? "revision-changed" : exhausted ? "attempts-exhausted" : "status-changed" });
    }
  }
  return pruned;
}

/**
 * Pick at most one delivery to hand to the host. Returns null when the agent is
 * busy, when nothing is pending, or when the pending delivery is stale.
 */
function planDelivery(tasks, context = {}) {
  const now = context.now ?? new Date();
  if (context.idle !== true) return null;
  const candidates = (tasks ?? [])
    .filter((task) => task.pendingDelivery && canCarryDelivery(task))
    .filter((task) => taskMatchesScope(task, context))
    .filter((task) => (context.onlyTaskId ? task.id === context.onlyTaskId : true))
    .sort((a, b) => Date.parse(a.pendingDelivery.createdAt) - Date.parse(b.pendingDelivery.createdAt));
  for (const task of candidates) {
    if (task.pendingDelivery.taskRevision !== task.revision) {
      task.pendingDelivery = null;
      task.updatedAt = toIso(now);
      advanceTask(task, now);
      continue;
    }
    const run = task.pendingDelivery.run ?? task.lastRun;
    return {
      taskId: task.id,
      deliveryId: task.pendingDelivery.id,
      revision: task.revision,
      source: task.pendingDelivery.source,
      message: buildDeliveryMessage(task, task.pendingDelivery),
      details: {
        taskId: task.id,
        deliveryId: task.pendingDelivery.id,
        kind: task.kind,
        label: task.label,
        schedule: describeSchedule(task),
        runCount: task.pendingDelivery.runCount ?? task.runCount,
        maxRuns: task.maxRuns,
        exitCode: run && run.code !== undefined ? run.code : null,
        ok: run ? run.ok : null,
        pendingDeliveries: pendingDeliveryTasks(tasks, context).length,
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Locks and claims
// ---------------------------------------------------------------------------

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, Math.max(0, ms));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Acquire an exclusive per-task lock across processes.
 * A stable file inode is locked by the OS; process death releases ownership.
 * Never replace or unlink lock files: contenders must lock the same inode.
 * ttlMs/isPidAlive remain accepted for callers, but heartbeat age cannot evict
 * a live kernel-lock holder. heartbeat() reports handle ownership without I/O;
 * holder is null because kernel ownership metadata is not exposed.
 * Upgrade requires stopping all legacy lock users.
 */
function acquireTaskLock({
  lockPath,
  taskId,
  now = new Date(),
  ttlMs = DEFAULT_LOCK_TTL_MS,
  isPidAlive: isPidAliveFn = isProcessAlive,
  attemptId = generateId("attempt"),
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const locks = require("fs-native-extensions");
  const fd = fs.openSync(lockPath, "a+");
  try {
    if (!locks.tryLock(fd)) {
      fs.closeSync(fd);
      return makeLockHandle(lockPath, attemptId, null, locks);
    }
  } catch (error) {
    // Close the descriptor on failed acquisition.
    fs.closeSync(fd);
    throw error;
  }
  return makeLockHandle(lockPath, attemptId, fd, locks);
}

function makeLockHandle(lockPath, attemptId, fd, locks) {
  const acquired = fd !== null;
  let released = false;
  return {
    acquired,
    attemptId,
    lockPath,
    holder: null,
    heartbeat() {
      return acquired && !released;
    },
    release() {
      if (released || !acquired) return false;
      released = true;
      try {
        locks.unlock(fd);
        return true;
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

/**
 * Serialize read-modify-write cycles on a state file across processes.
 */
function withFileLockSync(lockPath, fn, { now = () => new Date(), ttlMs = DEFAULT_LOCK_TTL_MS, isPidAlive: isPidAliveFn = isProcessAlive, maxWaitMs = 5_000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    const lock = acquireTaskLock({ lockPath, taskId: path.basename(lockPath), now: now(), ttlMs, isPidAlive: isPidAliveFn });
    if (lock.acquired) {
      try {
        return fn();
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for state lock: ${lockPath}`);
    }
    sleepSync(15);
  }
}

async function withFileLock(lockPath, fn, options = {}) {
  const deadline = Date.now() + (options.maxWaitMs ?? 5_000);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    const lock = acquireTaskLock({
      lockPath,
      taskId: path.basename(lockPath),
      now: options.now ? options.now() : new Date(),
      ttlMs: options.ttlMs ?? DEFAULT_LOCK_TTL_MS,
      isPidAlive: options.isPidAlive ?? isProcessAlive,
    });
    if (lock.acquired) {
      try {
        return await fn();
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for state lock: ${lockPath}`);
    }
    await sleep(15);
  }
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function resolveAgentDir(env = process.env) {
  if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
  return path.join(os.homedir(), ".pi", "agent");
}

function resolveStateFile({ env = process.env } = {}) {
  if (env.PI_SCHEDULER_NATIVE_STATE_FILE) return env.PI_SCHEDULER_NATIVE_STATE_FILE;
  return path.join(resolveAgentDir(env), "state", "pi-scheduler-native", "tasks.json");
}

function sanitizeTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!TASK_KINDS.has(raw.kind)) return null;
  if (!raw.schedule || !SCHEDULE_TYPES.has(raw.schedule.type)) return null;
  const status = TASK_STATUSES.has(raw.status) ? raw.status : "pending";
  const task = {
    id: typeof raw.id === "string" && raw.id ? raw.id : generateId(raw.kind === "wake" ? "wake" : "cmd"),
    kind: raw.kind,
    label: raw.label ?? null,
    scope: ["session", "cwd", "global"].includes(raw.scope) ? raw.scope : "global",
    sessionFile: raw.sessionFile ?? null,
    cwd: raw.cwd ?? null,
    createdAt: toIso(raw.createdAt) ?? toIso(new Date()),
    updatedAt: toIso(raw.updatedAt) ?? toIso(new Date()),
    revision: Number.isInteger(raw.revision) ? raw.revision : 1,
    schedule: {
      type: raw.schedule.type,
      expr: String(raw.schedule.expr ?? ""),
      intervalMs: Number.isFinite(raw.schedule.intervalMs) ? raw.schedule.intervalMs : undefined,
    },
    nextRun: toIso(raw.nextRun),
    runCount: Number.isInteger(raw.runCount) && raw.runCount >= 0 ? raw.runCount : 0,
    maxRuns: Number.isInteger(raw.maxRuns) && raw.maxRuns >= 1 ? raw.maxRuns : 1,
    reason: raw.reason ?? null,
    command: raw.command ?? null,
    shell: raw.shell ?? null,
    timeoutMs: Number.isFinite(raw.timeoutMs) ? raw.timeoutMs : DEFAULT_SHELL_TIMEOUT_MS,
    wakeOn: WAKE_ON_VALUES.has(raw.wakeOn) ? raw.wakeOn : raw.kind === "command" ? "failure" : null,
    status,
    enabled: raw.enabled === undefined ? status !== "paused" : Boolean(raw.enabled),
    pendingDelivery: raw.pendingDelivery && typeof raw.pendingDelivery === "object" ? raw.pendingDelivery : null,
    deliveredAt: toIso(raw.deliveredAt),
    lastDelivery: raw.lastDelivery ?? null,
    lastRun: raw.lastRun ?? null,
    lastError: raw.lastError ?? null,
    claim: raw.claim && typeof raw.claim === "object" ? raw.claim : null,
    migratedFrom: raw.migratedFrom ?? null,
    notes: Array.isArray(raw.notes) ? raw.notes.slice(0, 8) : [],
  };
  if (task.status === "running" && !task.claim) task.status = "pending";
  if (task.pendingDelivery && !canCarryDelivery(task)) task.pendingDelivery = null;
  return task;
}

function sanitizeState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const tasks = Array.isArray(source.tasks) ? source.tasks.map(sanitizeTask).filter(Boolean) : [];
  return {
    version: STATE_VERSION,
    updatedAt: toIso(source.updatedAt) ?? toIso(new Date()),
    tasks,
  };
}

function emptyState(now = new Date()) {
  return { version: STATE_VERSION, updatedAt: toIso(now), tasks: [] };
}

function writeStateFileSync(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const payload = JSON.stringify({ ...state, version: STATE_VERSION, updatedAt: toIso(new Date()) }, null, 2);
  const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, stateFile);
}

/**
 * Durable task store. Every read-modify-write cycle takes a cross-process file
 * lock and every write is atomic (temp file + rename).
 */
function createStateStore({ stateFile = resolveStateFile(), lockPath, now = () => new Date(), lockTtlMs = DEFAULT_LOCK_TTL_MS, isPidAlive: isPidAliveFn = isProcessAlive } = {}) {
  const resolvedLock = lockPath ?? `${stateFile}.lock`;
  return {
    stateFile,
    lockPath: resolvedLock,
    exists() {
      return fs.existsSync(stateFile);
    },
    loadSync() {
      if (!fs.existsSync(stateFile)) return emptyState(now());
      try {
        const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        return sanitizeState(raw);
      } catch (error) {
        const backup = `${stateFile}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(stateFile, backup);
        } catch {
          /* keep the original error */
        }
        throw new Error(`scheduler state file is not valid JSON (moved to ${backup}): ${error.message}`);
      }
    },
    saveSync(state) {
      writeStateFileSync(stateFile, state);
      return state;
    },
    withLockSync(fn) {
      return withFileLockSync(resolvedLock, fn, { now, ttlMs: lockTtlMs, isPidAlive: isPidAliveFn });
    },
    updateSync(mutator) {
      return withFileLockSync(
        resolvedLock,
        () => {
          const state = this.loadSync();
          const result = mutator(state);
          this.saveSync(state);
          return result;
        },
        { now, ttlMs: lockTtlMs, isPidAlive: isPidAliveFn },
      );
    },
    async update(mutator) {
      return withFileLock(
        resolvedLock,
        async () => {
          const state = this.loadSync();
          const result = await mutator(state);
          this.saveSync(state);
          return result;
        },
        { now, ttlMs: lockTtlMs, isPidAlive: isPidAliveFn },
      );
    },
  };
}

function findTask(state, taskId) {
  return (state.tasks ?? []).find((task) => task.id === taskId) ?? null;
}

// ---------------------------------------------------------------------------
// Guarded run execution
// ---------------------------------------------------------------------------

function claimIsFresh(claim, nowMs, ttlMs) {
  if (!claim) return false;
  const heartbeat = Date.parse(claim.heartbeatAt ?? "");
  if (!Number.isFinite(heartbeat)) return false;
  return nowMs - heartbeat <= ttlMs;
}

/**
 * Run a single due task exactly once across processes.
 *
 * Order: take the per-task lock -> re-read the durable state -> verify the task
 * is still live and due -> write a claim -> execute -> record the outcome and
 * release the claim -> release the lock. A competing process either fails to
 * take the lock or sees a fresh claim, and reports `skipped` instead of running.
 *
 * `execute(task, helpers)` is only called for `kind: "command"`; wake tasks need
 * no host work because their run is the delivery itself.
 */
async function runDueTaskOnce(options) {
  const {
    store,
    taskId,
    now = new Date(),
    lockDir,
    lockTtlMs = DEFAULT_LOCK_TTL_MS,
    isPidAlive: isPidAliveFn = isProcessAlive,
    execute,
    matches,
    heartbeatIntervalMs,
    recoverStaleClaim = true,
  } = options;
  const nowMs = now.getTime();
  const lockPath = path.join(lockDir ?? path.dirname(store.stateFile), "locks", `${taskId}.lock`);
  const lock = acquireTaskLock({ lockPath, taskId, now, ttlMs: lockTtlMs, isPidAlive: isPidAliveFn });
  if (!lock.acquired) {
    return { status: "skipped", reason: "locked-by-another-process", holder: lock.holder };
  }
  let heartbeatTimer = null;
  try {
    const state = store.loadSync();
    let task = findTask(state, taskId);
    if (!task) return { status: "skipped", reason: "missing" };
    if (matches && !matches(task)) return { status: "skipped", reason: "out-of-scope" };
    if (!task.enabled) return { status: "skipped", reason: "disabled" };
    if (task.status === "running") {
      const recovered = recoverInterruptedTasks([task], now, { isPidAlive: isPidAliveFn });
      if (recovered.length === 0) return { status: "skipped", reason: "status-running" };
      store.updateSync((draft) => {
        const target = findTask(draft, taskId);
        if (target && target.status === "running") recoverInterruptedTasks([target], now, { isPidAlive: isPidAliveFn });
      });
      task = findTask(store.loadSync(), taskId);
      if (!task) return { status: "skipped", reason: "missing" };
    }
    if (task.status !== "pending") return { status: "skipped", reason: `status-${task.status}` };
    if (!task.nextRun || Date.parse(task.nextRun) > nowMs) return { status: "not-due", reason: "next-run-in-future" };
    if (task.claim && task.claim.attemptId !== lock.attemptId && claimIsFresh(task.claim, nowMs, lockTtlMs) && task.claim.pid !== process.pid) {
      return { status: "skipped", reason: "claimed-by-another-process", claim: task.claim };
    }
    if (task.claim && !recoverStaleClaim) return { status: "skipped", reason: "claimed" };

    const claim = {
      pid: process.pid,
      attemptId: lock.attemptId,
      startedAt: toIso(now),
      heartbeatAt: toIso(now),
    };
    const started = store.updateSync((draft) => {
      const target = findTask(draft, taskId);
      if (!target) return { ok: false, reason: "missing" };
      if (target.status !== "pending" || !target.enabled) return { ok: false, reason: `status-${target.status}` };
      target.claim = claim;
      target.status = "running";
      target.updatedAt = toIso(now);
      // A new execution claim does not invalidate the previous run's event.
      if (target.pendingDelivery && target.pendingDelivery.taskRevision === target.revision) {
        target.pendingDelivery.taskRevision += 1;
      }
      target.revision += 1;
      return { ok: true };
    });
    if (!started.ok) return { status: "skipped", reason: started.reason };

    const refreshHeartbeat = () => {
      lock.heartbeat();
      try {
        store.updateSync((draft) => {
          const target = findTask(draft, taskId);
          if (target && target.claim && target.claim.attemptId === lock.attemptId) {
            target.claim.heartbeatAt = toIso(new Date());
          }
        });
      } catch {
        /* heartbeat failures are surfaced by the stale-claim check, not fatal here */
      }
    };
    const interval = heartbeatIntervalMs ?? Math.max(1_000, Math.floor(lockTtlMs / 3));
    heartbeatTimer = setInterval(refreshHeartbeat, interval);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

    let outcome;
    try {
      if (task.kind === "wake") {
        outcome = { kind: "wake" };
      } else if (typeof execute === "function") {
        outcome = { kind: "command", result: await execute(task, { attemptId: lock.attemptId, heartbeat: refreshHeartbeat }) };
      } else {
        outcome = { kind: "command", result: { ok: false, code: null, error: "no executor configured" } };
      }
    } catch (error) {
      outcome = { kind: "command", result: { ok: false, code: null, error: error && error.message ? error.message : String(error) } };
    }

    const applied = store.updateSync((draft) => {
      const target = findTask(draft, taskId);
      if (!target) return { ok: false, reason: "missing" };
      if (!target.enabled || target.status !== "running" || !target.claim || target.claim.attemptId !== lock.attemptId) {
        return { ok: false, reason: "claim-lost" };
      }
      const outcomeNow = new Date();
      const result = applyRunOutcome(target, outcome, outcomeNow);
      return { ok: true, delivery: result.delivery ? { id: result.delivery.id, taskId: target.id } : null, status: target.status };
    });
    if (!applied.ok) return { status: "skipped", reason: applied.reason };
    return { status: "executed", task, outcome, delivery: applied.delivery, taskStatus: applied.status };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    lock.release();
  }
}

module.exports = {
  STATE_VERSION,
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
  MAX_RUNS_LIMIT,
  MAX_DELIVERY_ATTEMPTS,
  TASK_KINDS,
  TASK_STATUSES,
  WAKE_ON_VALUES,
  TERMINAL_STATUSES,
  // time
  parseDurationMs,
  parseClockExpression,
  parseWhen,
  looksLikeCron,
  cronAvailable,
  nextCronRun,
  validateSchedule,
  nextOccurrence,
  // task model
  toIso,
  truncate,
  generateId,
  createTask,
  isTerminal,
  isLiveTask,
  taskMatchesScope,
  visibleTasks,
  selectDueTasks,
  pendingDeliveryTasks,
  describeSchedule,
  describeTask,
  formatTaskLine,
  formatTaskList,
  // lifecycle
  applyRunOutcome,
  advanceTask,
  requestDelivery,
  markDelivered,
  markDeliveryAttempt,
  deliveryWritten,
  applyDeliveryObservation,
  commandOutcomeText,
  cancelTask,
  updateTask,
  cleanupTasks,
  recoverInterruptedTasks,
  shouldWakeForCommand,
  buildDeliveryMessage,
  pruneStaleDeliveries,
  planDelivery,
  // locks
  isProcessAlive,
  sleepSync,
  sleep,
  acquireTaskLock,
  withFileLockSync,
  withFileLock,
  // state
  resolveAgentDir,
  resolveStateFile,
  sanitizeTask,
  sanitizeState,
  emptyState,
  writeStateFileSync,
  createStateStore,
  findTask,
  // runner
  runDueTaskOnce,
};
