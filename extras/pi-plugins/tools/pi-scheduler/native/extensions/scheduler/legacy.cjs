"use strict";

/**
 * Legacy (@jl1990/pi-scheduler 0.x) task reader and migration planner.
 *
 * Migration is deliberately two-phase: `planMigration` only reads and produces a
 * reviewable plan; `applyMigration` writes the *new* state file and never touches
 * the legacy file. Migrated tasks arrive paused, and a legacy `prompt` is reduced
 * to a short reason instead of being replayed as a user instruction. Messages the
 * old host already queued in its own followUp queue cannot be recalled; that limit
 * is documented in README.md.
 */

const fs = require("node:fs");
const path = require("node:path");

const LEGACY_ACTIONS = new Set(["notify", "prompt", "shell", "message"]);
const LEGACY_TERMINAL_STATUSES = new Set(["fired", "cancelled", "failed"]);
const DEFAULT_MIGRATED_MAX_RUNS = 12;
const PROMPT_PREVIEW_CHARS = 200;
const REASON_CHARS = 300;

const core = require("./core.cjs");

function compact(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function readLegacyState(file) {
  if (!file) return { ok: false, error: "legacy state file path is required", tasks: [] };
  if (!fs.existsSync(file)) {
    return { ok: false, error: `legacy state file not found: ${file}`, tasks: [], missing: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, error: `legacy state file is not valid JSON: ${error.message}`, tasks: [] };
  }
  const tasks = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.tasks) ? parsed.tasks : [];
  return { ok: true, version: parsed && parsed.version ? parsed.version : null, tasks, error: null };
}

function legacyWakeOn(task) {
  const explicit = compact(task.wakeOn).toLowerCase();
  const hasSuccess = Boolean(compact(task.successPrompt));
  const hasFailure = Boolean(compact(task.failurePrompt));
  const hasFollowUp = Boolean(compact(task.followUpPrompt));
  if (hasFollowUp || (hasSuccess && hasFailure)) return "always";
  if (hasFailure) return "failure";
  if (hasSuccess) return "success";
  if (["always", "failure", "success", "never"].includes(explicit)) return explicit;
  return "never";
}

function legacySchedule(task) {
  const type = compact(task.type).toLowerCase() || "once";
  const expr = compact(task.schedule ?? task.whenText ?? task.when ?? "");
  if (type === "cron") return { kind: "cron", expr };
  if (type === "interval") return { kind: "interval", expr };
  const iso = core.toIso(task.nextRun ?? task.dueAt);
  if (iso) return { kind: "once", expr: iso };
  return { kind: "once", expr };
}

function buildMigratedTask(entry, task, now) {
  const schedule = legacySchedule(task);
  const overdue = Boolean(task.nextRun ?? task.dueAt) && Date.parse(task.nextRun ?? task.dueAt) < now.getTime();
  const notes = [...entry.notes];
  const input = {
    kind: entry.kind,
    label: task.name ?? task.title ?? null,
    cwd: task.cwd ?? null,
    sessionFile: task.sessionFile ?? null,
    scope: ["session", "cwd", "global"].includes(task.scope)
      ? task.scope
      : task.sessionFile
        ? "session"
        : task.cwd
          ? "cwd"
          : "global",
    timeoutMs: Number.isFinite(task.timeoutMs) ? task.timeoutMs : undefined,
    enabled: false,
    migratedFrom: { id: task.id, action: compact(task.action) || "notify", type: schedule.kind, promptChars: entry.promptChars },
    notes,
  };
  if (entry.kind === "wake") {
    input.reason = entry.reason;
  } else {
    input.command = compact(task.command ?? task.prompt ?? task.message);
    input.wakeOn = legacyWakeOn(task);
    if (entry.wakeOnNote) notes.push(entry.wakeOnNote);
  }
  if (schedule.kind === "interval") {
    input.repeat = schedule.expr;
    input.maxRuns = Number.isInteger(task.maxRuns) && task.maxRuns >= 2 ? Math.min(task.maxRuns, core.MAX_RUNS_LIMIT) : DEFAULT_MIGRATED_MAX_RUNS;
    if (!Number.isInteger(task.maxRuns)) notes.push(`legacy interval had no maxRuns; migrated as a bounded ${DEFAULT_MIGRATED_MAX_RUNS}-run task`);
  } else if (schedule.kind === "cron") {
    input.cron = schedule.expr;
    input.maxRuns = Number.isInteger(task.maxRuns) && task.maxRuns >= 2 ? Math.min(task.maxRuns, core.MAX_RUNS_LIMIT) : DEFAULT_MIGRATED_MAX_RUNS;
    if (!core.cronAvailable()) return { ok: false, error: "cron migration requires the 'croner' dependency; run npm install in the package directory" };
  } else {
    input.after = schedule.expr;
    if (overdue) {
      input.after = "1h";
      notes.push("legacy task was overdue; schedule reset to 1h after enabling");
    }
  }
  const created = core.createTask(input, now);
  if (!created.ok) return created;
  const migrated = created.task;
  migrated.status = "paused";
  migrated.enabled = false;
  migrated.nextRun = null;
  migrated.notes = notes.slice(0, 8);
  migrated.lastError = null;
  return { ok: true, task: migrated, notes };
}

/**
 * Build a reviewable migration plan. Pure read: no file is written.
 */
function planMigration({ legacyTasks = [], now = new Date(), legacyFile = null, stateFile = null } = {}) {
  const entries = [];
  for (const task of legacyTasks) {
    if (!task || typeof task !== "object") {
      entries.push({ legacyId: null, decision: "skip", reason: "entry is not an object", notes: [] });
      continue;
    }
    const action = compact(task.action).toLowerCase() || "notify";
    const status = compact(task.status).toLowerCase() || "pending";
    const base = { legacyId: task.id ?? null, action, kind: null, decision: "skip", reason: null, notes: [], task: null };
    if (!LEGACY_ACTIONS.has(action)) {
      entries.push({ ...base, reason: `unsupported legacy action: ${action}` });
      continue;
    }
    if (LEGACY_TERMINAL_STATUSES.has(status)) {
      entries.push({ ...base, reason: `legacy task already ${status}; nothing to migrate` });
      continue;
    }
    const schedule = legacySchedule(task);
    if (!schedule.expr) {
      entries.push({ ...base, reason: "legacy task has no usable schedule expression" });
      continue;
    }
    if (status === "running") {
      base.notes.push("legacy task was running when the old host stopped; it is migrated paused, not resumed");
    }
    if (task.enabled === false) {
      base.notes.push("legacy task was disabled; migrated paused");
    }
    const scopeGuess = ["session", "cwd", "global"].includes(task.scope)
      ? task.scope
      : task.sessionFile
        ? "session"
        : task.cwd
          ? "cwd"
          : "global";
    if (scopeGuess === "session") {
      base.notes.push("session-scoped: only runs while the original session file is open");
    }
    base.notes.push("migrated paused; enable it explicitly after review");

    if (action === "shell") {
      const command = compact(task.command ?? task.prompt ?? task.message);
      if (!command) {
        entries.push({ ...base, reason: "legacy shell task has no command" });
        continue;
      }
      base.kind = "command";
      base.wakeOnNote = "legacy success/failure/followUp prompts are not replayed; wakeOn was mapped from them";
    } else {
      const text = compact(task.prompt ?? task.message ?? task.payload ?? "");
      if (!text) {
        entries.push({ ...base, reason: `legacy ${action} task has no payload` });
        continue;
      }
      base.kind = "wake";
      base.reason = core.truncate(text, REASON_CHARS);
      base.promptChars = text.length;
      base.notes.push("legacy payload is not replayed verbatim; a short reason was derived for review");
      if (action === "notify") base.notes.push("legacy notify action mapped to a wake; review whether an agent turn is wanted");
      if (action === "message") base.notes.push("legacy message action mapped to a wake");
      base.preview = { text: core.truncate(text, PROMPT_PREVIEW_CHARS), chars: text.length };
    }

    const built = buildMigratedTask(base, task, now);
    if (!built.ok) {
      entries.push({ ...base, decision: "skip", reason: built.error });
      continue;
    }
    entries.push({ ...base, decision: "migrate", task: built.task, notes: built.notes });
  }

  const migrate = entries.filter((entry) => entry.decision === "migrate");
  const summary = {
    total: entries.length,
    migrate: migrate.length,
    skip: entries.length - migrate.length,
    paused: migrate.length,
    wake: migrate.filter((entry) => entry.kind === "wake").length,
    command: migrate.filter((entry) => entry.kind === "command").length,
    reasons: entries
      .filter((entry) => entry.decision === "skip")
      .reduce((acc, entry) => {
        const key = entry.reason ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
  };
  return {
    generatedAt: core.toIso(now),
    legacyFile,
    stateFile,
    entries,
    summary,
    writes: { legacyFile: false, stateFile: summary.migrate > 0 },
  };
}

function formatMigrationPlan(plan) {
  const lines = [];
  lines.push(`legacy file : ${plan.legacyFile ?? "(none)"}`);
  lines.push(`new state   : ${plan.stateFile ?? "(none)"}`);
  lines.push(`generated   : ${plan.generatedAt}`);
  lines.push(`summary     : ${plan.summary.total} legacy task(s): ${plan.summary.migrate} to migrate (paused), ${plan.summary.skip} skipped`);
  lines.push("");
  for (const entry of plan.entries) {
    if (entry.decision === "migrate") {
      const task = entry.task;
      const when = task.schedule.type === "once" ? task.schedule.expr : `${task.schedule.type} ${task.schedule.expr}`;
      lines.push(`MIGRATE ${entry.legacyId ?? "(no id)"} [${entry.action} -> ${task.kind}/${task.schedule.type}] ${when}`);
      lines.push(`        status=paused runs=0/${task.maxRuns} scope=${task.scope} id=${task.id}`);
      if (entry.preview) lines.push(`        payload preview (${entry.preview.chars} chars): ${entry.preview.text}`);
      for (const note of entry.notes) lines.push(`        note: ${note}`);
    } else {
      lines.push(`SKIP    ${entry.legacyId ?? "(no id)"} [${entry.action}] ${entry.reason}`);
    }
  }
  lines.push("");
  lines.push("dry-run only: no file was written. Re-run with --apply to write the paused tasks into the new state file.");
  lines.push("note: messages the old host already queued cannot be recalled by this migration.");
  return lines.join("\n");
}

/**
 * Apply a plan to the new state store. Idempotent per legacy id; never writes the
 * legacy file.
 */
function applyMigration(plan, { store, now = new Date() } = {}) {
  if (!store) return { ok: false, error: "state store is required" };
  const applied = [];
  const alreadyPresent = [];
  const result = store.updateSync((state) => {
    for (const entry of plan.entries ?? []) {
      if (entry.decision !== "migrate" || !entry.task) continue;
      const legacyId = entry.legacyId;
      const existing = (state.tasks ?? []).find(
        (task) => task.migratedFrom && legacyId !== null && task.migratedFrom.id === legacyId,
      );
      if (existing) {
        alreadyPresent.push(legacyId);
        continue;
      }
      state.tasks.push(entry.task);
      applied.push(entry.legacyId);
    }
    return { applied: applied.length, alreadyPresent: alreadyPresent.length };
  });
  return { ok: true, applied, alreadyPresent, result, stateFile: store.stateFile, writtenAt: core.toIso(now) };
}

function defaultLegacyFile(env = process.env) {
  return path.join(core.resolveAgentDir(env), "state", "scheduler", "tasks.json");
}

module.exports = {
  LEGACY_ACTIONS,
  LEGACY_TERMINAL_STATUSES,
  DEFAULT_MIGRATED_MAX_RUNS,
  readLegacyState,
  legacyWakeOn,
  legacySchedule,
  planMigration,
  formatMigrationPlan,
  applyMigration,
  defaultLegacyFile,
};
