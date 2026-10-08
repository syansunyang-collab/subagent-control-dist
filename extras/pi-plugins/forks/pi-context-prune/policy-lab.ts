/**
 * context-prune policy lab — experiment-only entry point.
 *
 * Two release policies share one base (protected results, index archive,
 * summary refs, the original summarizer, the token ledger):
 *
 *   budget-summary
 *     At the end of a tool turn, collect the oldest releasable results until the
 *     raw token budget is reached, merge them into one batch, and summarize that
 *     batch in the background. At the next context boundary the ready result is
 *     applied only when it saves tokens; otherwise the raw text stays. When the
 *     request about to be sent reaches `priceLineRatio` of the active model's price
 *     line, every releasable result except the newest tool turn is archived behind
 *     receipts at once and summarized afterwards as a stage summary.
 *
 *   cold-mask
 *     At the context boundary, archive the budgeted old results verbatim and
 *     replace them with short receipts, without calling a model first. After a
 *     user turn ends, newly released results that have no stage summary yet are
 *     merged and summarized once; the stage summary is injected at a later
 *     context boundary, once ready and only when it saves tokens.
 *
 * The production entry (index.ts) is untouched. This file does not register the
 * `context_prune` tool or its prompt guidance; the only tool it registers is the
 * read-back tool (`context_tree_query`) with line-based pagination.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ToolCallIndexer } from "./src/indexer.js";
import { summarizeBatch } from "./src/summarizer.js";
import { StatsAccumulator } from "./src/stats.js";
import { injectSummaryMessages } from "./src/pruner.js";
import {
  formatSummaryToolCallRefs,
  makeSummaryDetails,
  normalizeSummaryToolCallRefs,
  wrapSummaryForContext,
} from "./src/summary-refs.js";
import {
  CUSTOM_TYPE_INDEX,
  CUSTOM_TYPE_SUMMARY,
  type CapturedBatch,
  type CapturedToolCall,
  type SummarizeResult,
  type SummaryToolCallRef,
} from "./src/types.js";
import { countTextTokens, shouldSkipOversizedReplacement, type ReplacementLedger } from "./src/token-count.js";
import {
  applyLabStubs,
  collectLabToolTurns,
  currentUserTurn,
  estimateRequestTokens,
  labLedger,
  labRecords,
  labStubText,
  mergeLabBatch,
  priceLineFor,
  READ_TOOL_NAME,
  selectLabCandidates,
  toolResultIds,
  toolResultIdsFromEntries,
  type LabCandidateSelection,
  type LabEvent,
  type LabEventConfig,
  type LabEventName,
  type LabPhase,
  LAB_EVENT_ENTRY_TYPE,
  LAB_MODE_BUDGET_SUMMARY,
  LAB_MODE_COLD_MASK,
  LAB_PHASE_BUDGET,
  LAB_PHASE_MASK,
  LAB_PHASE_SESSION,
  LAB_PHASE_STAGE,
} from "./src/lab-policy.js";
import { DEFAULT_LAB_CONFIG, loadLabConfig, toSummarizerConfig, type LabConfig } from "./src/lab-config.js";
import { registerLabReadTool } from "./src/lab-read-tool.js";

/** Same bound the production flush uses, so a stalled summarizer cannot hold a plan forever. */
const JOB_TIMEOUT_MS = 180_000;
const PAUSE_ENTRY_TYPE = "context-prune-paused";
const THRESHOLD_ENTRY_TYPE = "context-prune-threshold";
const SEEN_ENTRY_TYPE = "context-prune-seen-results";
const THRESHOLDS = [6000, 15000, 30000, 60000];

/** Minimal view of the session manager method used to persist a summary message. */
interface SessionAppender {
  appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): void;
}

interface LabJob {
  phase: LabPhase;
  generation: number;
  userTurn: number;
  batch: CapturedBatch;
  refs: SummaryToolCallRef[];
  rawTexts: string[];
  rawTokens: number;
  stubTokens: number;
  status: "pending" | "ready" | "skipped" | "failed";
  summaryText?: string;
  ledger?: ReplacementLedger;
  reason?: string;
  invalidatedReason?: string;
  signal?: AbortSignal;
  controller?: AbortController;
}

interface EventPayload {
  refs?: SummaryToolCallRef[];
  toolCalls?: CapturedToolCall[];
  rawTokens?: number;
  stubTokens?: number;
  summaryTokens?: number;
  netTokens?: number;
  userTurn: number;
  config?: LabEventConfig;
}

export default function policyLab(pi: ExtensionAPI): void {
  let labConfig: LabConfig = DEFAULT_LAB_CONFIG;
  let configPath: string | null = null;
  let configuredTriggerTokens = DEFAULT_LAB_CONFIG.triggerTokens;

  const indexer = new ToolCallIndexer();
  /** Cumulative usage of every summarizer API call, applied or not. */
  const stats = new StatsAccumulator();
  /** Tool results the main model has already received in an earlier request. */
  const seenIds = new Set<string>();
  // Results are acknowledged only after a provider hook and successful response, then survive reload.
  let pendingSeenIds = new Map<string, string>();
  let submittedSeenIds: string[] = [];
  /** Lab events of the current branch, used to decide stage-summary coverage. */
  const labEvents: LabEvent[] = [];
  /** short ref -> tool call id, restored from the persisted archive entries. */
  const shortIdByToolCallId = new Map<string, string>();

  let hydrated = false;
  let paused = false;
  let generation = 0;
  let pendingJob: LabJob | null = null;

  const emit = (name: LabEventName, phase: LabPhase, pending: boolean, reason: string | undefined, payload: EventPayload): void => {
    const event: LabEvent = {
      event: name,
      mode: labConfig.mode,
      phase,
      pending,
      candidateIds: (payload.refs ?? []).map((ref) => ref.shortId),
      candidateToolCallIds: (payload.toolCalls ?? []).map((toolCall) => toolCall.toolCallId),
      rawTokens: payload.rawTokens ?? 0,
      stubTokens: payload.stubTokens ?? 0,
      summaryTokens: payload.summaryTokens ?? 0,
      netTokens: payload.netTokens ?? 0,
      userTurn: payload.userTurn,
      timestamp: Date.now(),
    };
    if (reason) event.reason = reason;
    if (payload.config) event.config = payload.config;
    labEvents.push(event);
    try {
      pi.appendEntry(LAB_EVENT_ENTRY_TYPE, event);
    } catch {
      // The session may be closing; the in-memory record still drives this run.
    }
  };

  const configSnapshot = (): LabEventConfig => ({
    mode: labConfig.mode,
    triggerTokens: labConfig.triggerTokens,
    keepRecentToolTurns: labConfig.keepRecentToolTurns,
    summarizerModel: labConfig.summarizerModel,
    summarizerThinking: labConfig.summarizerThinking,
    summarizerMaxCharsPerResult: labConfig.summarizerMaxCharsPerResult,
    priceLineRatio: labConfig.priceLineRatio,
    compactionHoldRatio: labConfig.compactionHoldRatio,
    priceLines: labConfig.priceLines,
    stageSummary: labConfig.stageSummary,
    path: configPath,
  });

  /** Rebuilds index, aliases and lab events from the current branch only. */
  const hydrate = (ctx: ExtensionContext): void => {
    indexer.reconstructFromSession(ctx);
    stats.reconstructFromSession(ctx);
    shortIdByToolCallId.clear();
    labEvents.length = 0;
    seenIds.clear();
    pendingSeenIds.clear();
    submittedSeenIds = [];
    paused = false;
    labConfig = { ...labConfig, triggerTokens: configuredTriggerTokens };

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry?.type === "custom" && entry.customType === SEEN_ENTRY_TYPE) {
        for (const id of entry.data?.toolCallIds ?? []) if (typeof id === "string") seenIds.add(id);
      } else if (entry?.type === "custom" && entry.customType === THRESHOLD_ENTRY_TYPE) {
        if (THRESHOLDS.includes(entry.data?.tokens)) labConfig.triggerTokens = entry.data.tokens;
      } else if (entry?.type === "custom" && entry.customType === PAUSE_ENTRY_TYPE) {
        if (typeof entry.data?.paused === "boolean") paused = entry.data.paused;
      } else if (entry?.type === "custom" && entry.customType === CUSTOM_TYPE_INDEX) {
        // The lab writes `refs` next to `toolCalls` so receipts survive a reload;
        // production entries without `refs` are still read by reconstructFromSession.
        const refs = normalizeSummaryToolCallRefs({ toolCallRefs: (entry.data as { refs?: unknown } | undefined)?.refs });
        indexer.registerSummaryRefs(refs);
        for (const ref of refs) shortIdByToolCallId.set(ref.toolCallId, ref.shortId);
      } else if (entry?.type === "custom_message" && entry.customType === CUSTOM_TYPE_SUMMARY) {
        for (const ref of normalizeSummaryToolCallRefs(entry.details)) shortIdByToolCallId.set(ref.toolCallId, ref.shortId);
      } else if (entry?.type === "custom" && entry.customType === LAB_EVENT_ENTRY_TYPE) {
        const event = entry.data as LabEvent | undefined;
        if (event && typeof event.event === "string") labEvents.push(event);
      }
    }

    hydrated = true;
  };

  /** Drops any pending or ready plan; an in-flight summarizer call settles as skipped. */
  const invalidatePlans = (reason: string): void => {
    generation++;
    if (pendingJob) {
      pendingJob.invalidatedReason = reason;
      pendingJob = null;
    }
  };

  const releasedIds = (): Set<string> => new Set(indexer.getIndex().keys());

  /** Receipt text for every archived result. */
  const stubMap = (): Map<string, string> => {
    const map = new Map<string, string>();
    for (const id of indexer.getIndex().keys()) map.set(id, labStubText(shortIdByToolCallId.get(id) ?? id));
    return map;
  };

  const persistRelease = (job: LabJob, ctx: ExtensionContext): void => {
    const records = labRecords(job.batch);
    pi.appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records, refs: job.refs });
    (ctx.sessionManager as unknown as SessionAppender).appendCustomMessageEntry(
      CUSTOM_TYPE_SUMMARY,
      job.summaryText ?? "",
      false,
      makeSummaryDetails(job.batch, job.refs),
    );
    indexer.registerSummaryRefs(job.refs);
    for (const record of records) indexer.getIndex().set(record.toolCallId, record);
    for (const ref of job.refs) shortIdByToolCallId.set(ref.toolCallId, ref.shortId);
  };

  const persistStageSummary = (job: LabJob, ctx: ExtensionContext): void => {
    (ctx.sessionManager as unknown as SessionAppender).appendCustomMessageEntry(
      CUSTOM_TYPE_SUMMARY,
      job.summaryText ?? "",
      false,
      makeSummaryDetails(job.batch, job.refs),
    );
    indexer.registerSummaryRefs(job.refs);
  };

  const jobPayload = (job: LabJob): EventPayload => ({
    refs: job.refs,
    toolCalls: job.batch.toolCalls,
    rawTokens: job.rawTokens,
    stubTokens: job.stubTokens,
    userTurn: job.userTurn,
  });

  /** Settles a background summarizer call; only net-positive results become `ready`. */
  const settleJob = (job: LabJob, result: SummarizeResult | null, error: unknown, signal: AbortSignal): void => {
    const invalidated = job.generation !== generation || job.invalidatedReason !== undefined;
    const zeroLedger = { summaryTokens: 0, netTokens: job.rawTokens - job.stubTokens };

    if (invalidated || signal.aborted) {
      job.status = "skipped";
      job.reason = job.invalidatedReason ?? (signal.aborted ? "aborted" : "invalidated");
      emit("skip", job.phase, false, job.reason, { ...jobPayload(job), ...zeroLedger });
    } else if (!result) {
      job.status = "failed";
      job.reason = error instanceof Error ? error.message : String(error ?? "summarizer returned no result");
      emit("failure", job.phase, false, job.reason, { ...jobPayload(job), ...zeroLedger });
    } else {
      // Every call is accounted with the existing stats entry shape, even when the
      // result is later skipped or invalidated before it reaches the context.
      stats.add(result.usage);
      stats.persist(pi);
      const summaryText = wrapSummaryForContext(result.summaryText + formatSummaryToolCallRefs(job.refs));
      const ledger = labLedger(job.rawTexts, job.refs, summaryText);
      job.summaryText = summaryText;
      job.ledger = ledger;
      if (shouldSkipOversizedReplacement(ledger)) {
        job.status = "skipped";
        job.reason = "net-tokens<=0";
        emit("skip", job.phase, false, job.reason, {
          ...jobPayload(job),
          summaryTokens: ledger.summaryTokens,
          netTokens: ledger.netTokens,
        });
      } else {
        job.status = "ready";
        // `idle` marks the background summarizer as finished; the result is applied
        // at the next context boundary.
        emit("idle", job.phase, false, "ready", {
          ...jobPayload(job),
          summaryTokens: ledger.summaryTokens,
          netTokens: ledger.netTokens,
        });
      }
    }

    if (job.status !== "ready" && pendingJob === job) pendingJob = null;
  };

  const startJob = (
    phase: LabPhase,
    selection: LabCandidateSelection,
    userTurn: number,
    ctx: ExtensionContext,
    providedRefs?: SummaryToolCallRef[],
  ): void => {
    const batch = mergeLabBatch(selection);
    const refs = providedRefs ?? indexer.allocateSummaryRefs(batch);
    const rawTexts = batch.toolCalls.map((toolCall) => toolCall.resultText);
    const rawTokens = rawTexts.reduce((sum, text) => sum + countTextTokens(text), 0);
    const stubTokens = refs.reduce((sum, ref) => sum + countTextTokens(labStubText(ref.shortId)), 0);

    const job: LabJob = {
      phase,
      generation,
      userTurn,
      batch,
      refs,
      rawTexts,
      rawTokens,
      stubTokens,
      status: "pending",
    };
    pendingJob = job;
    emit("prepare", phase, true, undefined, {
      refs,
      toolCalls: batch.toolCalls,
      rawTokens,
      stubTokens,
      summaryTokens: 0,
      netTokens: rawTokens - stubTokens,
      userTurn,
    });

    job.controller = new AbortController();
    const signals: AbortSignal[] = [AbortSignal.timeout(JOB_TIMEOUT_MS), job.controller.signal];
    if (phase === LAB_PHASE_BUDGET) {
      // A budget plan only matters for the run that created it; a cancel drops it.
      // The stage plan is created after the run ended, so it only has the deadline.
      try {
        if (ctx.signal) signals.push(ctx.signal);
      } catch {
        // Stale context: keep the deadline signal.
      }
    }
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    job.signal = signal;

    void summarizeBatch(batch, toSummarizerConfig(labConfig), ctx, { signal })
      .then((result) => settleJob(job, result, null, signal))
      .catch((error) => settleJob(job, null, error, signal));
  };

  /** Persists a ready plan; the context hook re-applies receipts and summaries afterwards. */
  const applyReadyJob = (ctx: ExtensionContext): void => {
    const job = pendingJob;
    if (!job || job.status !== "ready" || !job.summaryText) return;
    if (job.signal?.aborted) {
      emit("skip", job.phase, false, "aborted", jobPayload(job));
      invalidatePlans("aborted");
      return;
    }
    if (job.generation !== generation || job.invalidatedReason !== undefined) {
      pendingJob = null;
      return;
    }

    try {
      if (job.phase === LAB_PHASE_BUDGET) persistRelease(job, ctx);
      else persistStageSummary(job, ctx);
    } catch (error) {
      job.status = "failed";
      job.reason = `persist-failed: ${error instanceof Error ? error.message : String(error)}`;
      emit("failure", job.phase, false, job.reason, {
        ...jobPayload(job),
        summaryTokens: job.ledger?.summaryTokens ?? 0,
        netTokens: job.ledger?.netTokens ?? 0,
      });
      pendingJob = null;
      return;
    }

    const ledger = job.ledger;
    emit("apply", job.phase, false, undefined, {
      ...jobPayload(job),
      summaryTokens: ledger?.summaryTokens ?? 0,
      netTokens: ledger?.netTokens ?? 0,
    });
    pendingJob = null;
  };

  /**
   * Archives a selection verbatim and replaces it with short receipts in this request.
   * Returns null when the receipts would not save tokens or the archive could not be written.
   */
  const releaseAsReceipts = (
    selection: LabCandidateSelection,
    branch: any[],
    messages: any[],
    reason?: string,
  ): { messages: any[]; refs: SummaryToolCallRef[] } | null => {
    const batch = mergeLabBatch(selection);
    const refs = indexer.allocateSummaryRefs(batch);
    const ledger = labLedger(
      batch.toolCalls.map((toolCall) => toolCall.resultText),
      refs,
    );
    const payload: EventPayload = { refs, toolCalls: batch.toolCalls, userTurn: currentUserTurn(branch) };

    if (shouldSkipOversizedReplacement(ledger)) {
      emit("skip", LAB_PHASE_MASK, false, reason ? `${reason} net-tokens<=0` : "net-tokens<=0", {
        ...payload,
        rawTokens: ledger.rawTokens,
        stubTokens: ledger.stubTokens,
        summaryTokens: ledger.summaryTokens,
        netTokens: ledger.netTokens,
      });
      return null;
    }

    const records = labRecords(batch);
    try {
      pi.appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records, refs });
    } catch (error) {
      emit("failure", LAB_PHASE_MASK, false, `persist-failed: ${error instanceof Error ? error.message : String(error)}`, {
        ...payload,
        rawTokens: ledger.rawTokens,
        stubTokens: ledger.stubTokens,
        summaryTokens: ledger.summaryTokens,
        netTokens: ledger.netTokens,
      });
      return null;
    }

    indexer.registerSummaryRefs(refs);
    for (const record of records) indexer.getIndex().set(record.toolCallId, record);
    for (const ref of refs) shortIdByToolCallId.set(ref.toolCallId, ref.shortId);

    emit("apply", LAB_PHASE_MASK, false, reason, {
      ...payload,
      rawTokens: ledger.rawTokens,
      stubTokens: ledger.stubTokens,
      summaryTokens: ledger.summaryTokens,
      netTokens: ledger.netTokens,
    });
    return { messages: applyLabStubs(messages, stubMap()), refs };
  };

  /** True once Pi's context usage reaches `compactionHoldRatio` of the window: compaction is near. */
  const nearCompaction = (ctx: ExtensionContext): boolean => {
    if (labConfig.compactionHoldRatio <= 0) return false;
    const usage = ctx.getContextUsage?.();
    return typeof usage?.tokens === "number" && usage.contextWindow > 0
      && usage.tokens >= usage.contextWindow * labConfig.compactionHoldRatio;
  };

  /** cold-mask: archive the budgeted old set and replace it with short receipts. */
  const maskColdCandidates = (ctx: ExtensionContext, messages: any[]): any[] => {
    if (pendingJob || nearCompaction(ctx)) return messages;
    const branch = ctx.sessionManager.getBranch();
    const selection = selectLabCandidates(collectLabToolTurns(branch), {
      seenIds,
      visibleIds: toolResultIds(messages),
      releasedIds: releasedIds(),
      keepRecentToolTurns: labConfig.keepRecentToolTurns,
      excludeToolNames: [READ_TOOL_NAME],
      triggerTokens: labConfig.triggerTokens,
    });
    if (selection.toolCalls.length === 0 || selection.rawTokens < labConfig.triggerTokens) return messages;
    return releaseAsReceipts(selection, branch, messages)?.messages ?? messages;
  };

  /**
   * budget-summary price line: when the request about to be sent reaches the configured share
   * of the active model's price line, every releasable result except the newest tool turn is
   * archived behind receipts in this request, and a stage summary of them is prepared for a
   * later boundary. Budget batches wait for a summary first, which is too late at this size.
   */
  const enforcePriceLine = (ctx: ExtensionContext, messages: any[], before?: any[]): any[] => {
    const line = priceLineFor(ctx.model, labConfig.priceLines);
    if (!line || labConfig.priceLineRatio <= 0) return messages;
    const threshold = Math.floor(line * labConfig.priceLineRatio);
    const estimate = estimateRequestTokens(messages, before);
    if (estimate === undefined || estimate < threshold) return messages;

    const branch = ctx.sessionManager.getBranch();
    const selection = selectLabCandidates(collectLabToolTurns(branch), {
      seenIds,
      visibleIds: toolResultIds(messages),
      releasedIds: releasedIds(),
      keepRecentToolTurns: Math.min(1, labConfig.keepRecentToolTurns),
      excludeToolNames: [READ_TOOL_NAME],
      triggerTokens: Number.POSITIVE_INFINITY,
    });
    if (selection.toolCalls.length === 0) return messages;

    // A pending budget batch may cover the same results; drop it before archiving them here.
    // A pending stage summary covers results archived earlier and stays; the results archived
    // now get theirs at a later turn end (stageUncoveredReleases).
    if (pendingJob?.phase === LAB_PHASE_BUDGET) invalidatePlans("price-line");
    const released = releaseAsReceipts(selection, branch, messages, `price-line ${estimate}>=${threshold}`);
    if (!released) return messages;
    if (!pendingJob) startJob(LAB_PHASE_STAGE, selection, currentUserTurn(branch), ctx, released.refs);
    return released.messages;
  };

  /** Starts one stage summary for archived results that are still on the branch. */
  const startStageFor = (ids: Set<string>, branch: any[], userTurn: number, ctx: ExtensionContext): boolean => {
    if (ids.size === 0) return false;
    const turns = collectLabToolTurns(branch).filter((turn) => turn.toolCalls.some((toolCall) => ids.has(toolCall.toolCallId)));
    const toolCalls = turns.flatMap((turn) => turn.toolCalls).filter((toolCall) => ids.has(toolCall.toolCallId));
    if (toolCalls.length === 0) return false;

    const last = turns[turns.length - 1];
    const selection: LabCandidateSelection = {
      toolCalls,
      rawTokens: 0,
      turnIndex: last.turnIndex,
      timestamp: last.timestamp,
    };
    const refs = toolCalls.map((toolCall) => ({
      shortId: shortIdByToolCallId.get(toolCall.toolCallId) ?? toolCall.toolCallId,
      toolCallId: toolCall.toolCallId,
    }));
    startJob(LAB_PHASE_STAGE, selection, userTurn, ctx, refs);
    return true;
  };

  /**
   * budget-summary: results the price line archived without a stage summary (another summary was
   * pending, or the call failed) get one. Each result is tried at most twice, and only while it is
   * still in the context.
   */
  const stageUncoveredReleases = (branch: any[], ctx: ExtensionContext): boolean => {
    const archived = new Set<string>();
    const covered = new Set<string>();
    const attempts = new Map<string, number>();
    for (const labEvent of labEvents) {
      if (labEvent.phase === LAB_PHASE_MASK && labEvent.event === "apply") {
        for (const id of labEvent.candidateToolCallIds) archived.add(id);
      } else if (labEvent.phase === LAB_PHASE_STAGE) {
        for (const id of labEvent.candidateToolCallIds) {
          if (labEvent.event === "apply") covered.add(id);
          if (labEvent.event === "prepare") attempts.set(id, (attempts.get(id) ?? 0) + 1);
        }
      }
    }
    const visible = toolResultIdsFromEntries(ctx.sessionManager.buildContextEntries());
    const uncovered = new Set([...archived].filter((id) => !covered.has(id) && (attempts.get(id) ?? 0) < 2 && visible.has(id)));
    return startStageFor(uncovered, branch, currentUserTurn(branch), ctx);
  };

  registerLabReadTool(pi, indexer);

  for (const [action, description] of [
    ["pause", "暂停新增裁剪，保留已有回执"],
    ["resume", "恢复新增裁剪"],
    ["status", "查看裁剪运行状态"],
  ] as const) {
    pi.registerCommand(`pruner-${action}`, {
      description,
      handler: async (_args, ctx) => {
        if (!hydrated) hydrate(ctx);
        if (action !== "status" && paused !== (action === "pause")) {
          // Persist before changing runtime state so reload sees the same policy.
          pi.appendEntry(PAUSE_ENTRY_TYPE, { paused: action === "pause" });
          paused = action === "pause";
          if (paused) {
            pendingJob?.controller?.abort();
            invalidatePlans("paused");
          }
        }
        ctx.ui.notify((paused
          ? "裁剪已暂停：保留已有回执和原文查询，不再新增裁剪或摘要。"
          : "裁剪运行中：已有回执保留。可用 /pruner-pause 暂停。")
          + ` 当前阈值：${labConfig.triggerTokens.toLocaleString("en-US")} token。`, "info");
      },
    });
  }

  pi.registerCommand("pruner-threshold", {
    description: "选择裁剪阈值，立即生效：6K / 15K / 30K / 60K",
    handler: async (args, ctx) => {
      if (!hydrated) hydrate(ctx);
      let choice = args.trim().toLowerCase();
      if (!choice) {
        if (!ctx.hasUI) {
          ctx.ui.notify("用法：/pruner-threshold 6k | 15k | 30k | 60k", "info");
          return;
        }
        const labels = THRESHOLDS.map(tokens => `${tokens / 1000}K${tokens === labConfig.triggerTokens ? "（当前）" : ""}`);
        const selected = await ctx.ui.select("裁剪阈值：可释放的旧工具输出", labels);
        if (!selected) return;
        choice = String(THRESHOLDS[labels.indexOf(selected)]);
      }
      const tokens = /^\d+k$/.test(choice) ? Number(choice.slice(0, -1)) * 1000 : Number(choice);
      if (!THRESHOLDS.includes(tokens)) {
        ctx.ui.notify("可选阈值：6K、15K、30K、60K。", "warning");
        return;
      }
      if (tokens !== labConfig.triggerTokens) {
        pi.appendEntry(THRESHOLD_ENTRY_TYPE, { tokens });
        labConfig = { ...labConfig, triggerTokens: tokens };
        pendingJob?.controller?.abort();
        invalidatePlans("threshold-changed");
      }
      ctx.ui.notify(`裁剪阈值已设为 ${tokens / 1000}K，下一次裁剪判断生效；当前${paused ? "已暂停" : "运行中"}。`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const loaded = await loadLabConfig();
    labConfig = loaded.config;
    configuredTriggerTokens = labConfig.triggerTokens;
    configPath = loaded.path;
    hydrate(ctx);
    invalidatePlans("session-start");
    if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
    emit("idle", LAB_PHASE_SESSION, false, "session-start", {
      userTurn: currentUserTurn(ctx.sessionManager.getBranch()),
      config: configSnapshot(),
    });
  });

  pi.on("session_shutdown", async (event) => {
    pendingSeenIds.clear();
    submittedSeenIds = [];
    invalidatePlans(`session-shutdown:${event.reason}`);
  });

  pi.on("session_tree", async (_event, ctx) => {
    hydrate(ctx);
    invalidatePlans("session-tree");
  });

  pi.on("session_before_compact", async () => {
    invalidatePlans("compaction");
  });

  pi.on("session_compact", async (_event, ctx) => {
    hydrate(ctx);
    invalidatePlans("compaction");
  });

  pi.on("context", async (event, ctx) => {
    if (!hydrated) hydrate(ctx);
    let messages: any[] = event.messages;
    let changed = false;

    // The price line measures against the last usage, which predates what this boundary
    // replaces; keep the request as it stood so the difference can be counted.
    const before =
      labConfig.mode === LAB_MODE_BUDGET_SUMMARY && pendingJob?.status === "ready"
        ? injectSummaryMessages(applyLabStubs(messages, stubMap()), ctx.sessionManager.getBranch())
        : undefined;
    if (!paused) applyReadyJob(ctx);

    const stubbed = applyLabStubs(messages, stubMap());
    if (stubbed !== messages) {
      messages = stubbed;
      changed = true;
    }

    // Summaries already on the branch (this run or an earlier one) are re-injected
    // on every request, so a reload or a later turn keeps seeing them.
    const injected = injectSummaryMessages(messages, ctx.sessionManager.getBranch());
    if (injected !== messages) {
      messages = injected;
      changed = true;
    }

    if (!paused && labConfig.mode === LAB_MODE_COLD_MASK) {
      const masked = maskColdCandidates(ctx, messages);
      if (masked !== messages) {
        messages = masked;
        changed = true;
      }
    }

    if (!paused && labConfig.mode === LAB_MODE_BUDGET_SUMMARY) {
      const lined = enforcePriceLine(ctx, messages, before);
      if (lined !== messages) {
        messages = lined;
        changed = true;
      }
    }

    // Pi 0.99.1 transformMessages normalizes only cross-model calls, carrying that
    // mapping to their results. Responses then uses the first part of the mapped ID.
    const normalizedIds = new Map<string, string>();
    pendingSeenIds = new Map();
    const compositeIds = ["openai", "openai-codex", "opencode"].includes(ctx.model?.provider ?? "");
    for (const message of messages) {
      if (message.role === "toolResult" && !seenIds.has(message.toolCallId)
          && !indexer.getIndex().has(message.toolCallId)) {
        const id = message.toolCallId;
        pendingSeenIds.set(id, (normalizedIds.get(id) ?? id).split("|")[0]);
      }
      if (message.role !== "assistant") continue;
      const sameModel = message.provider === ctx.model?.provider
        && message.api === ctx.model?.api && message.model === ctx.model?.id;
      if (sameModel) continue;
      for (const block of message.content ?? []) {
        if (block.type !== "toolCall") continue;
        const part = compositeIds ? block.id.split("|")[0] : block.id;
        const normalized = part.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, "");
        normalizedIds.set(block.id, normalized);
      }
    }
    submittedSeenIds = [];

    return changed ? { messages } : undefined;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!["openai-codex-responses", "openai-responses"].includes(ctx.model?.api ?? "")) {
      // Other adapters expose no Responses IDs: acknowledge the pending request only after success.
      submittedSeenIds = [...pendingSeenIds.keys()];
      return;
    }
    const payload = event.payload as { input?: { type?: string; call_id?: string }[] };
    const sent = new Set((Array.isArray(payload?.input) ? payload.input : [])
      .filter(item => item.type === "function_call_output" || item.type === "custom_tool_call_output")
      .map(item => item.call_id));
    submittedSeenIds = [...pendingSeenIds]
      .filter(([, wireId]) => wireId.length > 0 && sent.has(wireId))
      .map(([id]) => id);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const ids = submittedSeenIds;
    submittedSeenIds = [];
    pendingSeenIds.clear();
    if (!["stop", "toolUse", "length"].includes(event.message.stopReason) || ids.length === 0) return;
    // Custom entries do not enter model context. Persist only newly acknowledged results.
    pi.appendEntry(SEEN_ENTRY_TYPE, { toolCallIds: ids });
    for (const id of ids) seenIds.add(id);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (paused) return;
    if (labConfig.mode !== LAB_MODE_BUDGET_SUMMARY) return;
    if (!hydrated) hydrate(ctx);
    if (pendingJob) return;

    const branch = ctx.sessionManager.getBranch();
    if (stageUncoveredReleases(branch, ctx)) return;
    const selection = selectLabCandidates(collectLabToolTurns(branch), {
      seenIds,
      visibleIds: toolResultIdsFromEntries(ctx.sessionManager.buildContextEntries()),
      releasedIds: releasedIds(),
      keepRecentToolTurns: labConfig.keepRecentToolTurns,
      excludeToolNames: [READ_TOOL_NAME],
      triggerTokens: labConfig.triggerTokens,
    });
    if (selection.toolCalls.length === 0 || selection.rawTokens < labConfig.triggerTokens) return;

    startJob(LAB_PHASE_BUDGET, selection, currentUserTurn(branch), ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (paused) return;
    if (labConfig.mode !== LAB_MODE_COLD_MASK || !labConfig.stageSummary) return;
    if (!hydrated) hydrate(ctx);
    if (pendingJob) return;

    const branch = ctx.sessionManager.getBranch();
    const userTurn = currentUserTurn(branch);
    const releasedThisTurn = new Set<string>();
    const covered = new Set<string>();
    for (const labEvent of labEvents) {
      if (labEvent.event !== "apply") continue;
      if (labEvent.phase === LAB_PHASE_MASK && labEvent.userTurn === userTurn) {
        for (const id of labEvent.candidateToolCallIds) releasedThisTurn.add(id);
      }
      if (labEvent.phase === LAB_PHASE_STAGE) {
        for (const id of labEvent.candidateToolCallIds) covered.add(id);
      }
    }

    const uncovered = new Set([...releasedThisTurn].filter((id) => !covered.has(id)));
    startStageFor(uncovered, branch, userTurn, ctx);
  });
}
