/**
 * pi-scheduler-native — standalone Pi scheduler extension.
 *
 * Replaces the patched @jl1990/pi-scheduler 0.x usage with real source:
 * - three slim tools (`wake_agent`, `schedule_command`, `manage_wake_tasks`)
 *   instead of one 21-field universal tool
 * - one pending delivery per task: while the agent is busy, repeated triggers
 *   merge instead of appending followUp messages to the host
 * - delivery re-reads the durable state after idle/agent_settled, so a cancelled
 *   or updated task never injects its stale event
 * - a delivery is marked delivered only after its custom message is in the session
 * - per-task cross-process lock + claim so two Pi instances cannot run the same
 *   task twice
 * - shellPath resolution through SettingsManager/getShellConfig (Windows source,
 *   not a patch) with both argv and stdin shell transports
 * - pi-web liveness keep-alive while tasks are pending
 * - dry-run legacy migration that never replays old prompts and never writes the
 *   legacy file
 */

import { SettingsManager, getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// jiti loads extension modules with a CommonJS-compatible `require` in scope,
// the same pattern the upstream @jl1990/pi-scheduler package uses.
const core = require("./core.cjs");
const shell = require("./shell.cjs");
const legacy = require("./legacy.cjs");
const liveness = require("./liveness.cjs");

const EXTENSION_NAME = "pi-scheduler-native";
const CUSTOM_TYPE = "pi-scheduler";
const LOCK_TTL_MS = 30_000;

function safeIsIdle(ctx: ExtensionContext | null): boolean {
  if (!ctx) return false;
  try {
    return ctx.isIdle() === true;
  } catch {
    return false;
  }
}

function safeProjectTrusted(ctx: ExtensionContext | null): boolean {
  if (!ctx) return false;
  try {
    return ctx.isProjectTrusted() === true;
  } catch {
    return false;
  }
}

function parseCommandArgs(raw: string): { when: string; payload: string } {
  const text = (raw ?? "").trim();
  if (!text) return { when: "", payload: "" };
  const separator = text.indexOf("::");
  if (separator >= 0) {
    return { when: text.slice(0, separator).trim(), payload: text.slice(separator + 2).trim() };
  }
  const match = text.match(/^(\S+)\s+(.*)$/s);
  if (!match) return { when: text, payload: "" };
  return { when: match[1], payload: match[2].trim() };
}

export default function schedulerNative(pi: ExtensionAPI) {
  let tasks: any[] = [];
  let activeCtx: ExtensionContext | null = null;
  let generation = 0;
  let store: any = null;
  let livenessRegistration: { supported: boolean; reason?: string | null; release: () => void } | null = null;
  let delivering = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const shellCache = new Map<string, any>();

  function ensureStore(): any {
    if (!store) {
      store = core.createStateStore({
        stateFile: process.env.PI_SCHEDULER_NATIVE_STATE_FILE || undefined,
      });
    }
    return store;
  }

  function sessionInfo(ctx?: ExtensionContext | null): { sessionFile: string | null; cwd: string } {
    const source = activeCtx ?? ctx ?? null;
    let sessionFile: string | null = null;
    try {
      sessionFile = source?.sessionManager?.getSessionFile?.() ?? null;
    } catch {
      sessionFile = null;
    }
    return { sessionFile: sessionFile ?? null, cwd: source?.cwd ?? process.cwd() };
  }

  function isActive(gen: number): boolean {
    return gen === generation && activeCtx !== null;
  }

  function loadTasks(): any[] {
    tasks = ensureStore().loadSync().tasks;
    return tasks;
  }

  function persist(mutator: (state: any) => any): any {
    return ensureStore().updateSync((state: any) => {
      const result = mutator(state);
      tasks = state.tasks;
      return result;
    });
  }

  function updateUi(): void {
    const ctx = activeCtx;
    if (!ctx || !ctx.hasUI) return;
    const info = sessionInfo();
    const live = core.visibleTasks(tasks, info, { all: false });
    if (live.length === 0) {
      ctx.ui.setStatus(EXTENSION_NAME, undefined);
      ctx.ui.setWidget(EXTENSION_NAME, undefined);
      return;
    }
    const pending = live.filter((task: any) => task.status === "pending").length;
    const toDeliver = core.pendingDeliveryTasks(live, info).length;
    const running = live.filter((task: any) => task.status === "running").length;
    const parts = [`${pending} pending`];
    if (toDeliver > 0) parts.push(`${toDeliver} to deliver`);
    if (running > 0) parts.push(`${running} running`);
    ctx.ui.setStatus(EXTENSION_NAME, `scheduler: ${parts.join(", ")}`);
    const lines = live.slice(0, 3).map((task: any) => core.formatTaskLine(task, new Date()));
    if (live.length > 3) lines.push(`… ${live.length - 3} more (/wakes)`);
    ctx.ui.setWidget(EXTENSION_NAME, lines);
  }

  // -------------------------------------------------------------------------
  // Delivery: at most one pending delivery per task, only while idle
  // -------------------------------------------------------------------------

  // deliveryId -> send that must not be marked delivered until the session contains it.
  const pendingSends = new Map<string, { taskId: string; gen: number; sawActive: boolean; checks: number; timer: ReturnType<typeof setTimeout> | null }>();

  function clearPendingSend(deliveryId: string): void {
    const pending = pendingSends.get(deliveryId);
    if (pending?.timer) clearTimeout(pending.timer);
    pendingSends.delete(deliveryId);
  }

  function clearPendingSends(): void {
    for (const deliveryId of [...pendingSends.keys()]) clearPendingSend(deliveryId);
  }

  function sessionHasDelivery(sessionManager: any, deliveryId: string): boolean {
    if (!sessionManager || typeof sessionManager.getBranch !== "function") return false;
    try {
      return core.deliveryWritten(sessionManager.getBranch(), CUSTOM_TYPE, deliveryId);
    } catch {
      return false;
    }
  }

  function noteDeliveryWritten(deliveryId: string, taskId?: string): void {
    const pending = pendingSends.get(deliveryId);
    const resolvedTaskId = pending?.taskId ?? taskId;
    if (!resolvedTaskId || !activeCtx) return;
    if (!sessionHasDelivery(activeCtx.sessionManager, deliveryId)) return;
    if (pending) clearPendingSend(deliveryId);
    persist((state: any) => {
      const task = core.findTask(state, resolvedTaskId);
      if (!task) return;
      core.applyDeliveryObservation(task, deliveryId, { written: true }, new Date());
    });
    updateUi();
    if (activeCtx) scheduleAllTimers();
  }

  function failSendStartup(deliveryId: string, error: string): void {
    const pending = pendingSends.get(deliveryId);
    if (!pending || !isActive(pending.gen)) return;
    if (sessionHasDelivery(activeCtx?.sessionManager, deliveryId)) {
      noteDeliveryWritten(deliveryId, pending.taskId);
      return;
    }
    clearPendingSend(deliveryId);
    persist((state: any) => {
      const task = core.findTask(state, pending.taskId);
      if (!task) return;
      core.applyDeliveryObservation(task, deliveryId, { startupError: error }, new Date());
    });
    updateUi();
    if (isActive(pending.gen)) void flushDeliveries(pending.gen);
  }

  function watchSend(deliveryId: string): void {
    const tick = () => {
      const pending = pendingSends.get(deliveryId);
      if (!pending || !isActive(pending.gen)) {
        if (pending) clearPendingSend(deliveryId);
        return;
      }
      if (sessionHasDelivery(activeCtx?.sessionManager, deliveryId)) {
        noteDeliveryWritten(deliveryId, pending.taskId);
        return;
      }
      const idle = safeIsIdle(activeCtx);
      if (!idle) {
        pending.sawActive = true;
        pending.timer = setTimeout(tick, 25);
        if (typeof (pending.timer as any).unref === "function") (pending.timer as any).unref();
        return;
      }
      // One idle tick is not enough: a send during agent_settled is queued and
      // starts on the next host turn. After that, idle with no session entry is a miss.
      if (pending.sawActive || pending.checks > 0) {
        failSendStartup(deliveryId, "scheduler send did not write the custom message to the session");
        return;
      }
      pending.checks += 1;
      pending.timer = setTimeout(tick, 0);
      if (typeof (pending.timer as any).unref === "function") (pending.timer as any).unref();
    };
    const pending = pendingSends.get(deliveryId);
    if (!pending) return;
    pending.timer = setTimeout(tick, 0);
    if (typeof (pending.timer as any).unref === "function") (pending.timer as any).unref();
  }

  function installSessionWriteWatch(sessionManager: any): void {
    if (!sessionManager || typeof sessionManager.appendCustomMessageEntry !== "function") return;
    if (typeof sessionManager.__piSchedulerAppendOriginal === "function") {
      sessionManager.appendCustomMessageEntry = sessionManager.__piSchedulerAppendOriginal;
    }
    const original = sessionManager.appendCustomMessageEntry;
    sessionManager.__piSchedulerAppendOriginal = original;
    sessionManager.appendCustomMessageEntry = function(customType: string, content: unknown, display: boolean, details: any, ...rest: unknown[]) {
      const entryId = original.call(this, customType, content, display, details, ...rest);
      const deliveryId = details && details.deliveryId;
      const taskId = details && details.taskId;
      if (customType === CUSTOM_TYPE && typeof deliveryId === "string" && typeof this.getBranch === "function" && core.deliveryWritten(this.getBranch(), CUSTOM_TYPE, deliveryId)) {
        noteDeliveryWritten(deliveryId, typeof taskId === "string" ? taskId : undefined);
      }
      return entryId;
    };
  }

  async function flushDeliveries(gen: number = generation): Promise<void> {
    if (delivering) return;
    delivering = true;
    try {
      for (let i = 0; i < 5; i += 1) {
        if (!isActive(gen)) return;
        const ctx = activeCtx;
        if (!safeIsIdle(ctx)) return;
        const sent = persist((state: any) => {
          core.pruneStaleDeliveries(state.tasks, new Date());
          if (!safeIsIdle(activeCtx)) return false;
          const plan = core.planDelivery(state.tasks, { ...sessionInfo(), idle: true, now: new Date() });
          if (!plan || pendingSends.has(plan.deliveryId)) return false;
          const task = core.findTask(state, plan.taskId);
          if (!task) return false;
          try {
            pi.sendMessage(
              { customType: CUSTOM_TYPE, content: plan.message, display: true, details: plan.details },
              { deliverAs: "steer", triggerTurn: true },
            );
          } catch (error) {
            core.applyDeliveryObservation(task, plan.deliveryId, { startupError: String(error) }, new Date());
            return false;
          }
          pendingSends.set(plan.deliveryId, { taskId: plan.taskId, gen, sawActive: false, checks: 0, timer: null });
          return plan.deliveryId;
        });
        if (typeof sent === "string") watchSend(sent);
        updateUi();
        if (!sent) return;
      }
    } finally {
      delivering = false;
      if (isActive(gen)) scheduleAllTimers();
    }
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  function clearTimers(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  function armTask(task: any, delayMs: number): void {
    if (timers.has(task.id)) return;
    const gen = generation;
    const timer = setTimeout(() => {
      timers.delete(task.id);
      void fireTask(task.id, gen);
    }, Math.max(0, Math.min(delayMs, core.MAX_TIMER_DELAY_MS)));
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    timers.set(task.id, timer);
  }

  function scheduleAllTimers(): void {
    clearTimers();
    if (!activeCtx) return;
    const now = new Date();
    const current = ensureStore().loadSync();
    if ((current.tasks ?? []).some((task: any) => task && task.status === "running" && !core.isProcessAlive(task.claim && task.claim.pid))) {
      persist((state: any) => {
        core.recoverInterruptedTasks(state.tasks, now);
      });
    }
    tasks = ensureStore().loadSync().tasks;
    const info = sessionInfo();
    const nowMs = now.getTime();
    for (const task of core.selectDueTasks(tasks, new Date(nowMs))) {
      if (!core.taskMatchesScope(task, info)) continue;
      armTask(task, 0);
    }
    for (const task of tasks) {
      if (timers.has(task.id)) continue;
      if (!core.isLiveTask(task) || task.status !== "pending") continue;
      if (task.pendingDelivery && task.kind !== "command") continue;
      if (!core.taskMatchesScope(task, info)) continue;
      const next = task.nextRun ? Date.parse(task.nextRun) : Number.NaN;
      if (!Number.isFinite(next)) continue;
      armTask(task, next - nowMs);
    }
    updateUi();
  }

  function armAfterMutation(): void {
    const ctx = activeCtx;
    if (!ctx) return;
    if (ctx.mode === "print" || ctx.mode === "json") {
      updateUi();
      return;
    }
    scheduleAllTimers();
  }

  // -------------------------------------------------------------------------
  // Command execution
  // -------------------------------------------------------------------------

  async function executeScheduledCommand(task: any, signal?: AbortSignal): Promise<any> {
    const info = sessionInfo();
    const cwd = task.cwd ?? info.cwd;
    const resolved = shell.resolveShellConfig({
      cwd,
      agentDir: getAgentDir(),
      projectTrusted: safeProjectTrusted(activeCtx),
      settingsManagerClass: SettingsManager,
      getShellConfig,
      override: task.shell,
      cache: shellCache,
    });
    return shell.executeShellCommand({
      shellConfig: resolved,
      command: task.command,
      cwd,
      timeoutMs: task.timeoutMs ?? core.DEFAULT_SHELL_TIMEOUT_MS,
      exec: (command: string, args: string[], options: any) => pi.exec(command, args, { ...options, signal }),
    });
  }

  async function fireTask(taskId: string, gen: number): Promise<void> {
    if (!isActive(gen)) return;
    const storeRef = ensureStore();
    const info = sessionInfo();
    const outcome = await core.runDueTaskOnce({
      store: storeRef,
      taskId,
      now: new Date(),
      lockTtlMs: LOCK_TTL_MS,
      matches: (task: any) => core.taskMatchesScope(task, info),
      execute: (task: any) => executeScheduledCommand(task),
    });
    if (!isActive(gen)) return;
    tasks = storeRef.loadSync().tasks;
    if (outcome.status === "executed") void flushDeliveries(gen);
    updateUi();
    scheduleAllTimers();
  }

  // -------------------------------------------------------------------------
  // Liveness (pi-web keep-alive)
  // -------------------------------------------------------------------------

  function registerLiveness(): void {
    livenessRegistration?.release();
    livenessRegistration = null;
    const ctx = activeCtx;
    if (!ctx) return;
    if (ctx.mode === "print" || ctx.mode === "json") return;
    const info = sessionInfo();
    const identity = info.sessionFile ?? `cwd:${info.cwd}`;
    livenessRegistration = liveness.registerLivenessProvider({
      name: EXTENSION_NAME,
      sessionId: identity,
      sessionFile: info.sessionFile,
      isActive: () => {
        if (!activeCtx) return false;
        return core
          .visibleTasks(tasks, sessionInfo(), { all: false })
          .some((task: any) => task.status === "pending" || task.status === "waiting" || task.status === "running");
      },
    });
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    generation += 1;
    activeCtx = ctx;
    shellCache.clear();
    try {
      store = core.createStateStore({
        stateFile: process.env.PI_SCHEDULER_NATIVE_STATE_FILE || undefined,
      });
      loadTasks();
    } catch (error) {
      tasks = [];
      store = null;
      ctx.ui.notify(`pi-scheduler-native: ${String((error as any)?.message ?? error)}`, "error");
      return;
    }
    clearPendingSends();
    installSessionWriteWatch(ctx.sessionManager);
    persist((state: any) => {
      const recovered = core.recoverInterruptedTasks(state.tasks, new Date());
      const pruned = core.pruneStaleDeliveries(state.tasks, new Date());
      return { recovered, pruned };
    });
    registerLiveness();
    if (ctx.mode === "print" || ctx.mode === "json") {
      updateUi();
      return;
    }
    scheduleAllTimers();
    void flushDeliveries(generation);
  });

  pi.on("message_end", (event: any) => {
    const message = event?.message;
    if (!message || message.role !== "custom" || message.customType !== CUSTOM_TYPE) return;
    const deliveryId = message.details && message.details.deliveryId;
    if (typeof deliveryId !== "string" || !pendingSends.has(deliveryId)) return;
    const sessionManager = activeCtx?.sessionManager;
    setImmediate(() => {
      if (sessionHasDelivery(sessionManager, deliveryId)) noteDeliveryWritten(deliveryId, message.details.taskId);
    });
  });

  pi.on("session_shutdown", async () => {
    generation += 1;
    clearPendingSends();
    clearTimers();
    livenessRegistration?.release();
    livenessRegistration = null;
    activeCtx = null;
    tasks = [];
  });

  pi.on("agent_settled", async () => {
    void flushDeliveries(generation);
  });

  pi.on("agent_end", async () => {
    void flushDeliveries(generation);
  });

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "wake_agent",
    label: "Wake Agent",
    description:
      "Use when the user requests a later reminder or follow-up (for example, 'remind me in ten minutes'), or when continuing the current task requires a future check and no completion notification is available. For a delayed shell check, use schedule_command; for background work with completion notifications, use those notifications. Schedule after immediate work is complete, then finish your response. Defaults to one wake. While busy, each task retains one pending wake until idle. Timers require the Pi process to remain running.",
    promptSnippet: "Schedule a future wake-up in this session; one-shot by default",
    promptGuidelines: [
      "Keep reason to the next action, such as 'Check the build result'; the session already contains the background.",
      "Use schedule_command for deferred shell execution and manage_wake_tasks to inspect, update, or cancel tasks.",
    ],
    parameters: Type.Object({
      after: Type.String({
        description:
          "One-shot wake time: 10m, tomorrow at 9am, or an ISO timestamp with a timezone. Clock times use the host's local timezone. When repeat is set, repeat determines timing and after is ignored.",
      }),
      reason: Type.String({
        description: "The next action on waking, such as 'Check the build result'. Omit background already in the session.",
      }),
      repeat: Type.Optional(
        Type.String({ description: "Recurring wake interval, such as 5m; requires maxRuns. The first wake waits this interval; subsequent intervals start after delivery. Omit for one wake." }),
      ),
      maxRuns: Type.Optional(
        Type.Integer({ minimum: 2, maximum: core.MAX_RUNS_LIMIT, description: "Total number of wakes including the first; required with repeat." }),
      ),
      label: Type.Optional(Type.String({ description: "Short label shown in /wakes output." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const info = sessionInfo(ctx);
      const created = core.createTask(
        {
          kind: "wake",
          after: params.after,
          reason: params.reason,
          repeat: params.repeat,
          maxRuns: params.maxRuns,
          label: params.label,
          cwd: info.cwd,
          sessionFile: info.sessionFile,
        },
        new Date(),
      );
      if (!created.ok) throw new Error(created.error);
      persist((state: any) => {
        state.tasks.push(created.task);
      });
      armAfterMutation();
      const text = `Wake scheduled: ${created.task.id} at ${created.task.nextRun} (${core.describeSchedule(created.task)}). It delivers only when the agent is idle; a busy agent keeps a single pending wake for this task.`;
      return { content: [{ type: "text", text }], details: { taskId: created.task.id, nextRun: created.task.nextRun, status: created.task.status } };
    },
  });

  pi.registerTool({
    name: "schedule_command",
    label: "Schedule Command",
    description:
      "Use when a non-interactive shell command should run at a future time or on a bounded interval, such as a delayed health check, and its result determines whether the agent needs to follow up. Run commands needed now directly; use existing completion notifications for background work that already provides them. Schedule after immediate work is complete, then finish your response. Uses the host's configured shell and wakes on failure by default. Timers require the Pi process to remain running.",
    promptSnippet: "Run a shell command later and wake the agent according to its result",
    promptGuidelines: [
      "Set wakeOn=always to wake on both success and failure, or never when no agent follow-up is needed.",
      "Use manage_wake_tasks to inspect or cancel scheduled commands.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run when the schedule fires." }),
      after: Type.String({
        description: "One-shot execution time: 30s, tomorrow at 3am, or an ISO timestamp with a timezone. Clock times use the host's local timezone. When repeat is set, repeat determines timing and after is ignored.",
      }),
      repeat: Type.Optional(Type.String({ description: "Interval for a bounded recurring run, for example \"10m\". Requires maxRuns." })),
      maxRuns: Type.Optional(
        Type.Integer({ minimum: 2, maximum: core.MAX_RUNS_LIMIT, description: "Total number of runs including the first; required with repeat." }),
      ),
      wakeOn: Type.Optional(
        StringEnum(["always", "failure", "success", "never"], {
          description: "When to wake the agent after the run. Default failure.",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory for the command. Defaults to the session cwd." })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Command execution timeout in milliseconds. Default 300000; range 1000–86400000." })),
      label: Type.Optional(Type.String({ description: "Short label shown in /wakes output." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const info = sessionInfo(ctx);
      const created = core.createTask(
        {
          kind: "command",
          command: params.command,
          after: params.after,
          repeat: params.repeat,
          maxRuns: params.maxRuns,
          wakeOn: params.wakeOn,
          cwd: params.cwd ?? info.cwd,
          timeoutMs: params.timeoutMs,
          label: params.label,
          sessionFile: info.sessionFile,
        },
        new Date(),
      );
      if (!created.ok) throw new Error(created.error);
      persist((state: any) => {
        state.tasks.push(created.task);
      });
      armAfterMutation();
      const text = `Command scheduled: ${created.task.id} at ${created.task.nextRun} (${core.describeSchedule(created.task)}), wakeOn=${created.task.wakeOn}.`;
      return {
        content: [{ type: "text", text }],
        details: { taskId: created.task.id, nextRun: created.task.nextRun, wakeOn: created.task.wakeOn },
      };
    },
  });

  pi.registerTool({
    name: "manage_wake_tasks",
    label: "Manage Scheduled Tasks",
    description:
      "Use when the user wants to inspect, reschedule, pause, resume, or cancel a scheduled task, or when task progress makes an existing schedule obsolete. Manages this session's scheduled tasks. Updating or cancelling clears plugin-pending events; it cannot retract messages already submitted to the host or terminate commands already running.",
    promptSnippet: "Manage this session's scheduled wakes and commands",
    promptGuidelines: [
      "Use list for task IDs or current state; use cancel when future execution is no longer needed.",
      "Pause with update and enabled=false; resume with update and enabled=true.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "cancel", "update", "cleanup"], {
        description: "list shows visible tasks; cancel stops one task; update changes schedule/reason/enabled; cleanup removes finished tasks.",
      }),
      id: Type.Optional(Type.String({ description: "Task id. Required for cancel and update." })),
      after: Type.Optional(Type.String({ description: "New schedule for update: delay, clock time, or ISO timestamp." })),
      repeat: Type.Optional(Type.String({ description: "New interval for update; requires maxRuns when the task was one-shot." })),
      maxRuns: Type.Optional(Type.Integer({ minimum: 2, maximum: core.MAX_RUNS_LIMIT, description: "New run budget for update." })),
      reason: Type.Optional(Type.String({ description: "New reason for an update of a wake task." })),
      enabled: Type.Optional(Type.Boolean({ description: "false pauses a task, true resumes it." })),
      label: Type.Optional(Type.String({ description: "New label." })),
      all: Type.Optional(Type.Boolean({ description: "For list: include finished and cancelled tasks." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const info = sessionInfo(ctx);
      loadTasks();
      if (params.action === "list") {
        const rows = core.visibleTasks(tasks, info, { all: params.all === true });
        return {
          content: [{ type: "text", text: core.formatTaskList(rows, { now: new Date(), all: true }) }],
          details: { count: rows.length, tasks: rows.map((task: any) => ({ id: task.id, kind: task.kind, status: task.status, nextRun: task.nextRun })) },
        };
      }
      if (params.action === "cleanup") {
        const result = persist((state: any) => {
          const result = core.cleanupTasks(state.tasks, info, new Date());
          state.tasks = result.kept;
          return result;
        });
        armAfterMutation();
        return { content: [{ type: "text", text: `Removed ${result.removedCount} finished task(s).` }], details: result };
      }
      if (!params.id) throw new Error(`${params.action} requires id`);
      const found = core.visibleTasks(tasks, info, { all: true }).find((task: any) => task.id === params.id);
      if (!found) throw new Error(`no scheduled task with id ${params.id} is visible to this session`);
      if (params.action === "cancel") {
        persist((state: any) => {
          const task = core.findTask(state, params.id);
          if (task) core.cancelTask(task, new Date());
        });
        armAfterMutation();
        return { content: [{ type: "text", text: `Cancelled ${params.id}; plugin-pending delivery cleared. Already submitted messages and running commands are unaffected.` }], details: { taskId: params.id } };
      }
      const updates: any = {};
      if (params.after !== undefined) updates.after = params.after;
      if (params.repeat !== undefined) updates.repeat = params.repeat;
      if (params.maxRuns !== undefined) updates.maxRuns = params.maxRuns;
      if (params.reason !== undefined) updates.reason = params.reason;
      if (params.enabled !== undefined) updates.enabled = params.enabled;
      if (params.label !== undefined) updates.label = params.label;
      const updated = persist((state: any) => {
        const task = core.findTask(state, params.id);
        if (!task) return { ok: false, error: `no scheduled task with id ${params.id}` };
        return core.updateTask(task, updates, new Date());
      });
      if (!updated.ok) throw new Error(updated.error);
      armAfterMutation();
      return {
        content: [{ type: "text", text: `Updated ${params.id}: ${core.formatTaskLine(updated.task, new Date())}` }],
        details: { taskId: params.id, status: updated.task.status, nextRun: updated.task.nextRun },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  pi.registerCommand("wake", {
    description: "Schedule a wake-up: /wake <after> :: <reason>",
    handler: async (args, ctx) => {
      const { when, payload } = parseCommandArgs(args);
      if (!when || !payload) {
        ctx.ui.notify("Usage: /wake <after> :: <reason>  (example: /wake 10m :: check the build)", "warning");
        return;
      }
      const info = sessionInfo(ctx);
      const created = core.createTask(
        { kind: "wake", after: when, reason: payload, cwd: info.cwd, sessionFile: info.sessionFile },
        new Date(),
      );
      if (!created.ok) {
        ctx.ui.notify(`/wake: ${created.error}`, "error");
        return;
      }
      persist((state: any) => {
        state.tasks.push(created.task);
      });
      armAfterMutation();
      ctx.ui.notify(`Wake ${created.task.id} scheduled for ${created.task.nextRun}`, "info");
    },
  });

  pi.registerCommand("wake-shell", {
    description: "Schedule a shell command: /wake-shell <after> :: <command>",
    handler: async (args, ctx) => {
      const { when, payload } = parseCommandArgs(args);
      if (!when || !payload) {
        ctx.ui.notify("Usage: /wake-shell <after> :: <command>", "warning");
        return;
      }
      const info = sessionInfo(ctx);
      const created = core.createTask(
        { kind: "command", command: payload, after: when, wakeOn: "always", cwd: info.cwd, sessionFile: info.sessionFile },
        new Date(),
      );
      if (!created.ok) {
        ctx.ui.notify(`/wake-shell: ${created.error}`, "error");
        return;
      }
      persist((state: any) => {
        state.tasks.push(created.task);
      });
      armAfterMutation();
      ctx.ui.notify(`Command ${created.task.id} scheduled for ${created.task.nextRun}`, "info");
    },
  });

  pi.registerCommand("wakes", {
    description: "List scheduled tasks (pass 'all' to include finished ones)",
    handler: async (args, ctx) => {
      const all = args.trim().toLowerCase() === "all";
      const rows = core.visibleTasks(tasks, sessionInfo(ctx), { all });
      const text = core.formatTaskList(rows, { now: new Date(), all: true });
      ctx.ui.notify(text, "info");
      pi.appendEntry(CUSTOM_TYPE, { kind: "list", text, count: rows.length });
    },
  });

  pi.registerCommand("wake-cancel", {
    description: "Cancel a scheduled task: /wake-cancel <id>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /wake-cancel <id>", "warning");
        return;
      }
      const found = core.visibleTasks(tasks, sessionInfo(ctx), { all: true }).find((task: any) => task.id === id);
      if (!found) {
        ctx.ui.notify(`No scheduled task with id ${id}`, "warning");
        return;
      }
      persist((state: any) => {
        const task = core.findTask(state, id);
        if (task) core.cancelTask(task, new Date());
      });
      armAfterMutation();
      ctx.ui.notify(`Cancelled ${id}`, "info");
    },
  });

  pi.registerCommand("scheduler-migrate", {
    description: "Review legacy @jl1990/pi-scheduler tasks; pass --apply to write them as paused tasks",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const apply = tokens.includes("--apply");
      const legacyIndex = tokens.indexOf("--legacy");
      const legacyFile = legacyIndex >= 0 && tokens[legacyIndex + 1] ? tokens[legacyIndex + 1] : legacy.defaultLegacyFile();
      const read = legacy.readLegacyState(legacyFile);
      if (!read.ok) {
        ctx.ui.notify(`Migration: ${read.error}`, "warning");
        return;
      }
      const plan = legacy.planMigration({ legacyTasks: read.tasks, legacyFile, stateFile: ensureStore().stateFile });
      if (!apply) {
        const text = legacy.formatMigrationPlan(plan);
        ctx.ui.notify(text, "info");
        pi.appendEntry(CUSTOM_TYPE, { kind: "migration-plan", text });
        return;
      }
      const applied = legacy.applyMigration(plan, { store: ensureStore() });
      loadTasks();
      const text = `Migration applied: ${applied.applied.length} task(s) written paused to ${ensureStore().stateFile}; ${applied.alreadyPresent.length} already present. Enable each task explicitly after review.`;
      ctx.ui.notify(text, "info");
      pi.appendEntry(CUSTOM_TYPE, { kind: "migration-applied", text, applied: applied.applied });
    },
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  pi.registerMessageRenderer(CUSTOM_TYPE, (message, options, theme) => {
    let text = theme.fg("accent", "[pi-scheduler] ");
    text += message.content;
    if (options.expanded && message.details) {
      text += `\n${theme.fg("dim", JSON.stringify(message.details, null, 2))}`;
    }
    return new Text(text, options.outputPad, 0);
  });

  pi.registerEntryRenderer(CUSTOM_TYPE, (entry, _options, theme) => {
    const data: any = entry.data ?? {};
    const text = typeof data.text === "string" ? data.text : JSON.stringify(data, null, 2);
    return new Text(theme.fg("dim", text), 0, 0);
  });
}
