/**
 * Pure policy helpers for the policy-lab entry point (policy-lab.ts).
 *
 * Everything here is deterministic and side-effect free so the offline tests can
 * exercise the release rules directly:
 *   - which old tool turns are eligible for release,
 *   - how the token budget slices them into one batch,
 *   - the short receipt text the model sees,
 *   - line-based pagination for the read-back tool.
 */
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, CapturedToolCall, SummaryToolCallRef, ToolCallRecord } from "./types.js";
import { assistantToolCalls, isProtectedToolResult, skillDirectories } from "./protected-results.js";
import { countTextTokens, evaluateReplacementNet, type ReplacementLedger } from "./token-count.js";

/** Experimental release policies. */
export const LAB_MODE_BUDGET_SUMMARY = "budget-summary";
export const LAB_MODE_COLD_MASK = "cold-mask";
export const LAB_MODES = [LAB_MODE_BUDGET_SUMMARY, LAB_MODE_COLD_MASK] as const;
export type LabMode = (typeof LAB_MODES)[number];

/** Releasable raw tokens that trigger one release round. */
export const DEFAULT_TRIGGER_TOKENS = 6000;

/** Newest complete tool turns that are never released. */
export const DEFAULT_KEEP_RECENT_TOOL_TURNS = 2;

/** Share of a model's price line at which every old result is released at once (0 disables). */
export const DEFAULT_PRICE_LINE_RATIO = 0.85;

/**
 * cold-mask holds new releases once Pi's context usage reaches this share of the model's window
 * (0 disables). Automatic compaction rewrites the history at 90%, so a release just before it pays
 * a cache rebuild that the compaction discards; replaying production sessions put the hold at 80%
 * of that line.
 */
export const DEFAULT_COMPACTION_HOLD_RATIO = 0.72;

/**
 * Request input size above which the provider bills the whole request at a higher rate
 * (list prices: OpenAI API pricing page checked 2026-09-23, xAI docs checked 2026-09-19).
 * Keys match "provider/model-id" case-insensitively; `*` matches any run of characters.
 */
export const DEFAULT_PRICE_LINES: Readonly<Record<string, number>> = {
  "openai-codex/gpt-5.6-sol*": 272_000,
  "openai-codex/gpt-6-astra*": 272_000,
  "openai-codex/gpt-5.6-luna*": 272_000,
  "xai/grok-4.6*": 200_000,
};

/** Price line of the active model, or undefined when none is configured for it. */
export function priceLineFor(
  model: { provider?: string; id?: string } | undefined,
  lines: Readonly<Record<string, number>>,
): number | undefined {
  if (!model?.provider || !model.id) return undefined;
  const key = `${model.provider}/${model.id}`.toLowerCase();
  for (const [pattern, tokens] of Object.entries(lines)) {
    const body = pattern
      .toLowerCase()
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    if (new RegExp(`^${body}$`).test(key)) return tokens;
  }
  return undefined;
}

/**
 * Input tokens of the request about to be sent, the way Pi estimates context size: the last
 * usable assistant usage (input, cache read/write and its own output) plus an estimate for every
 * message after it. Undefined before the first usable response.
 *
 * `before` is the request as the last usage measured it, when this request replaces parts of it
 * (results archived at this boundary, a summary added); the difference is counted with the same
 * per-message estimate.
 */
export function estimateRequestTokens(messages: readonly any[], before?: readonly any[]): number | undefined {
  const measured = before ?? messages;
  for (let i = measured.length - 1; i >= 0; i--) {
    const message = measured[i];
    if (message?.role !== "assistant" || !message.usage) continue;
    if (message.stopReason === "aborted" || message.stopReason === "error") continue;
    const base = calculateContextTokens(message.usage);
    if (!(base > 0)) continue;
    let trailing = 0;
    for (let j = i + 1; j < measured.length; j++) trailing += estimateTokens(measured[j]);
    if (!before) return base + trailing;
    const total = (list: readonly any[]) => list.reduce((sum, m) => sum + estimateTokens(m), 0);
    return Math.max(0, base + trailing - (total(before) - total(messages)));
  }
  return undefined;
}

/** Model-visible receipt that replaces a released tool result. */
export function labStubText(shortId: string): string {
  return `[pruned:${shortId}]`;
}

/** Read-back tool name (same name as the production recovery tool). */
export const READ_TOOL_NAME = "context_tree_query";

/** Custom entry that records every lab transition for the driver's JSONL scan. */
export const LAB_EVENT_ENTRY_TYPE = "context-prune-lab-event";

export const LAB_PHASE_BUDGET = "budget";
export const LAB_PHASE_MASK = "mask";
export const LAB_PHASE_STAGE = "stage";
export const LAB_PHASE_SESSION = "session";
export type LabPhase =
  | typeof LAB_PHASE_BUDGET
  | typeof LAB_PHASE_MASK
  | typeof LAB_PHASE_STAGE
  | typeof LAB_PHASE_SESSION;

export type LabEventName = "prepare" | "apply" | "skip" | "failure" | "idle";

/** Effective experiment config, recorded once per session so the driver can read the arm. */
export interface LabEventConfig {
  mode: LabMode;
  triggerTokens: number;
  keepRecentToolTurns: number;
  summarizerModel: string;
  summarizerThinking: string;
  summarizerMaxCharsPerResult: number;
  priceLineRatio: number;
  compactionHoldRatio: number;
  stageSummary: boolean;
  priceLines: Record<string, number>;
  path: string | null;
}

/** One `context-prune-lab-event` entry. Never contains credentials. */
export interface LabEvent {
  event: LabEventName;
  mode: LabMode;
  phase: LabPhase;
  pending: boolean;
  reason?: string;
  candidateIds: string[];
  candidateToolCallIds: string[];
  rawTokens: number;
  stubTokens: number;
  summaryTokens: number;
  netTokens: number;
  userTurn: number;
  timestamp: number;
  /** Present on the session-start record. */
  config?: LabEventConfig;
}

/** One assistant turn with tool calls, as seen on the session branch. */
export interface LabToolTurn {
  turnIndex: number;
  timestamp: number;
  toolCalls: CapturedToolCall[];
  /** Every tool call of the turn has a result on the branch. */
  complete: boolean;
}

export interface LabCandidateOptions {
  /** Results the main model already received in an earlier request. */
  seenIds: ReadonlySet<string>;
  /** Ids still present in the model's message list; undefined disables the filter. */
  visibleIds?: ReadonlySet<string>;
  /** Ids already archived in the index. */
  releasedIds: ReadonlySet<string>;
  keepRecentToolTurns: number;
  excludeToolNames: readonly string[];
  /** Stop collecting once the accumulated raw tokens reach this budget. */
  triggerTokens: number;
}

export interface LabCandidateSelection {
  toolCalls: CapturedToolCall[];
  rawTokens: number;
  turnIndex: number;
  timestamp: number;
}

/** Text blocks of a tool result message (images and other blocks are ignored). */
export function toolResultText(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

/** Tool result ids present in a context message list. */
export function toolResultIds(messages: readonly any[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") ids.add(message.toolCallId);
  }
  return ids;
}

/** Tool result ids present in raw session entries (`buildContextEntries()` / `getBranch()`). */
export function toolResultIdsFromEntries(entries: readonly any[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry?.type === "message" && entry.message?.role === "toolResult" && typeof entry.message.toolCallId === "string") {
      ids.add(entry.message.toolCallId);
    }
  }
  return ids;
}

/** Number of user messages on the branch; identifies the current user turn. */
export function currentUserTurn(branch: readonly any[]): number {
  let count = 0;
  for (const entry of branch) {
    if (entry?.type === "message" && entry.message?.role === "user") count++;
  }
  return count;
}

/**
 * Walks a session branch and returns its assistant tool turns in order.
 *
 * Protected tool results (skill reads, image results, and anything the
 * protected-results rules cover) are dropped from `toolCalls`; the turn stays
 * `complete` because it still pairs every tool call with a result.
 */
export function collectLabToolTurns(branch: readonly any[]): LabToolTurn[] {
  const resultById = new Map<string, any>();
  for (const entry of branch) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") resultById.set(message.toolCallId, message);
  }
  const directories = skillDirectories(assistantToolCalls(branch.map((entry) => entry?.message)));

  const turns: LabToolTurn[] = [];
  let turnIndex = 0;
  for (const entry of branch) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const callBlocks = content.filter((block: any) => block?.type === "toolCall");
    const index = turnIndex++;
    if (callBlocks.length === 0) continue;

    const toolCalls: CapturedToolCall[] = [];
    let complete = true;
    for (const block of callBlocks) {
      const result = resultById.get(block.id);
      if (!result) {
        complete = false;
        continue;
      }
      if (isProtectedToolResult(result, block, directories)) continue;
      toolCalls.push({
        toolCallId: block.id,
        toolName: block.name,
        args: block.arguments ?? block.input ?? block.args ?? {},
        resultText: toolResultText(result),
        isError: result.isError ?? false,
      });
    }
    const rawTimestamp = entry.timestamp ?? message.timestamp;
    const parsed = typeof rawTimestamp === "number" ? rawTimestamp : rawTimestamp ? Date.parse(rawTimestamp) : 0;
    turns.push({ turnIndex: index, timestamp: Number.isFinite(parsed) ? parsed : 0, toolCalls, complete });
  }
  return turns;
}

/**
 * Selects the oldest eligible tool calls up to the token budget.
 *
 * Eligibility: complete turn, not one of the newest `keepRecentToolTurns`
 * complete turns, already seen by the model, still visible in the request,
 * not archived yet, not produced by an excluded tool.
 */
export function selectLabCandidates(turns: readonly LabToolTurn[], options: LabCandidateOptions): LabCandidateSelection {
  const completeTurns = turns.filter((turn) => turn.complete);
  const recent = options.keepRecentToolTurns > 0 ? completeTurns.slice(-options.keepRecentToolTurns) : [];
  const recentTurns = new Set(recent.map((turn) => turn.turnIndex));

  const toolCalls: CapturedToolCall[] = [];
  let rawTokens = 0;
  let turnIndex = 0;
  let timestamp = 0;
  for (const turn of turns) {
    if (!turn.complete || recentTurns.has(turn.turnIndex)) continue;
    for (const toolCall of turn.toolCalls) {
      if (options.excludeToolNames.includes(toolCall.toolName)) continue;
      if (options.releasedIds.has(toolCall.toolCallId)) continue;
      if (!options.seenIds.has(toolCall.toolCallId)) continue;
      if (options.visibleIds && !options.visibleIds.has(toolCall.toolCallId)) continue;
      toolCalls.push(toolCall);
      rawTokens += countTextTokens(toolCall.resultText);
      turnIndex = turn.turnIndex;
      timestamp = turn.timestamp;
      if (rawTokens >= options.triggerTokens) break;
    }
    if (rawTokens >= options.triggerTokens) break;
  }
  return { toolCalls, rawTokens, turnIndex, timestamp };
}

/** Merges a selection into the single batch sent to the original summarizer. */
export function mergeLabBatch(selection: LabCandidateSelection): CapturedBatch {
  return {
    turnIndex: selection.turnIndex,
    timestamp: selection.timestamp,
    assistantText: "",
    toolCalls: selection.toolCalls,
  };
}

/** Archive records for a released batch (the read-back snapshot). */
export function labRecords(batch: CapturedBatch): ToolCallRecord[] {
  return batch.toolCalls.map((toolCall) => ({
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    args: toolCall.args,
    resultText: toolCall.resultText,
    isError: toolCall.isError,
    turnIndex: batch.turnIndex,
    timestamp: batch.timestamp,
  }));
}

/** Token ledger for a release: raw results against receipts and (optionally) a summary. */
export function labLedger(rawTexts: readonly string[], refs: readonly SummaryToolCallRef[], summaryText = ""): ReplacementLedger {
  return evaluateReplacementNet({
    rawTexts,
    stubTexts: refs.map((ref) => labStubText(ref.shortId)),
    summaryText,
  });
}

/** Replaces released tool results with their short receipt, keeping other metadata. */
export function applyLabStubs(
  messages: readonly any[],
  stubByToolCallId: ReadonlyMap<string, string>,
): any[] {
  let changed = false;
  const out = messages.map((message) => {
    if (message?.role !== "toolResult") return message;
    const stub = stubByToolCallId.get(message.toolCallId);
    if (!stub) return message;
    if (Array.isArray(message.content) && message.content.length === 1 && message.content[0]?.type === "text" && message.content[0].text === stub) {
      return message;
    }
    changed = true;
    return { ...message, content: [{ type: "text", text: stub }] };
  });
  return changed ? out : (messages as any[]);
}

// ── Read-back pagination ────────────────────────────────────────────────────

/** Lines returned when the caller does not pass `limit`. */
export const DEFAULT_READ_LINES = 200;

/** Hard cap on `limit`, so one call cannot flood the context. */
export const MAX_READ_LINES = 1000;

export const MAX_READ_CHARS = 16_000;

export interface SnapshotPage {
  /** Exact archived substring, including original newline spelling. */
  text: string;
  charOffset: number;
  nextCharOffset: number | null;
  lines: string[];
  /** 1-based first line of the page. */
  startLine: number;
  /** 1-based last line of the page; 0 when the page is empty. */
  endLine: number;
  totalLines: number;
  /** Offset for the next page, or null when the snapshot is exhausted. */
  nextOffset: number | null;
}

/** Slices by line and in-line character cursor, preserving the exact archived text. */
export function readSnapshotPage(text: string, offset?: number, limit?: number, charOffset = 0, maxChars = MAX_READ_CHARS): SnapshotPage {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const requestedStart = Math.floor(offset ?? 1);
  const startLine = Math.min(Math.max(1, Number.isFinite(requestedStart) ? requestedStart : 1), totalLines + 1);
  const requestedLimit = Math.floor(limit ?? DEFAULT_READ_LINES);
  const count = Math.min(Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_READ_LINES), MAX_READ_LINES);
  const startChar = Number.isFinite(charOffset) ? Math.max(0, Math.floor(charOffset)) : 0;
  let cursor = Math.min(startChar, lines[startLine - 1]?.length ?? 0);
  const line = lines[startLine - 1] ?? "";
  // An explicit cursor inside a surrogate pair resumes at the whole code point.
  if (cursor > 0 && /[\uD800-\uDBFF]/.test(line[cursor - 1])
      && /[\uDC00-\uDFFF]/.test(line[cursor] ?? "")) cursor--;
  const base = lines.slice(0, startLine - 1).reduce((sum, line) => sum + line.length + 1, 0);
  const start = base + cursor;
  const lastLine = Math.min(totalLines, startLine + count - 1);
  const boundary = lines.slice(0, lastLine).reduce((sum, line, i) => sum + line.length + (i < totalLines - 1 ? 1 : 0), 0);
  let end = Math.min(boundary, start + Math.max(0, Math.min(MAX_READ_CHARS, Math.floor(maxChars))));
  // Keep both UTF-16 units on the next page when the budget cuts a code point.
  if (end > start && /[\uD800-\uDBFF]/.test(text[end - 1])
      && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  const body = startLine <= totalLines ? text.slice(start, end) : "";
  let nextLine = startLine, nextChar = cursor;
  for (const character of body) {
    if (character === "\n") { nextLine++; nextChar = 0; }
    else nextChar += character.length;
  }
  const exhausted = startLine > totalLines || end >= text.length;
  const endLine = startLine > totalLines ? 0 : Math.min(totalLines, nextLine - (body.endsWith("\n") ? 1 : 0));
  return {
    text: body, charOffset: cursor,
    lines: startLine > totalLines ? [] : body.replace(/\r?\n$/, "").split(/\r?\n/),
    startLine, endLine, totalLines,
    nextOffset: exhausted ? null : nextLine,
    nextCharOffset: exhausted ? null : nextChar,
  };
}
