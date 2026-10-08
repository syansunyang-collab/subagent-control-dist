import type { ToolCallIndexer } from "./indexer.js";
import { assistantToolCalls, isProtectedToolResult, skillDirectories } from "./protected-results.js";
import { CUSTOM_TYPE_SUMMARY } from "./types.js";
import { normalizeSummaryToolCallRefs } from "./summary-refs.js";

export const PRUNED_RESULT_MARKER = "[pi-context-prune]";

/**
 * Maps the `context` event message array.
 * ToolResultMessage entries whose toolCallId is in the index are replaced by a short stub
 * that points at the pruner-summary message and at `context_tree_query`.
 * Keeps ALL other messages including AssistantMessages with tool-call blocks.
 *
 * The stub is kept (rather than dropping the message) because every provider needs a result
 * for each tool call: pi-ai's transformMessages fills a missing one with an *error* result
 * ("No result provided", isError: true), and providers that bypass that transform send the
 * tool call unpaired. Both make the model believe the tool failed; a benign stub does not.
 */
export function pruneMessages(messages: any[], indexer: ToolCallIndexer): any[] {
  const directories = skillDirectories([...indexer.getIndex().values(), ...assistantToolCalls(messages)]);
  let changed = false;
  const out = messages.map((msg) => {
    if (msg.role !== "toolResult" || !indexer.isSummarized(msg.toolCallId)) return msg;
    if (isProtectedToolResult(msg, indexer.getRecord(msg.toolCallId), directories)) return msg;
    changed = true;
    return {
      ...msg,
      isError: false,
      content: [
        {
          type: "text",
          text:
            `${PRUNED_RESULT_MARKER} This ${msg.toolName ?? "tool"} result was summarized and pruned from context; ` +
            `see the pruner-summary message that follows. Full output: context_tree_query with id "${msg.toolCallId}".`,
        },
      ],
    };
  });
  return changed ? out : messages;
}

/**
 * Adds the summary messages that the running agent's message list lacks.
 *
 * Summaries persisted with `sessionManager.appendCustomMessageEntry` are in the session file but
 * not in the list of the request that wrote them. Pi 0.87.1 and later rebuild the list from the
 * session at every turn boundary (older Pi only on reload), and then the summary sits at its
 * session position.
 *
 * Each missing summary therefore goes where the session has it: right after the message produced
 * by the nearest earlier session entry that is in the list, or at the end. The request that writes
 * a summary and the requests after it then agree on its position, whether or not Pi rebuilt the
 * list in between, and the cached prefix holds. A summary whose covered results are no longer in the list is skipped. Summaries
 * already in the list are left alone.
 *
 * @param branch  the session branch (`ctx.sessionManager.getBranch()`)
 */
export function injectSummaryMessages(messages: any[], branch: any[]): any[] {
  // Pi deep-clones the list before the `context` hook, so content is compared by value; an
  // array of content blocks (which appendCustomMessageEntry also accepts) never matches by identity.
  const contentKey = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content));
  const present = new Set(
    messages
      .filter((m) => m?.role === "custom" && m.customType === CUSTOM_TYPE_SUMMARY)
      .map((m) => contentKey(m.content)),
  );
  // The list is a deep clone of what Pi projected from the session; role and timestamp identify
  // the message an entry produced.
  const messageKey = (m: any) => `${m?.role}:${m?.timestamp}`;
  const entryKey = (e: any) =>
    e?.type === "message" ? messageKey(e.message)
    : e?.type === "custom_message" ? `custom:${new Date(e.timestamp).getTime()}`
    : undefined;
  const positionOf = new Map<string | undefined, number>();
  messages.forEach((m, i) => positionOf.set(messageKey(m), i));

  const inserts = new Map<number, any[]>();
  for (const entry of branch) {
    if (entry?.type !== "custom_message" || entry.customType !== CUSTOM_TYPE_SUMMARY) continue;
    if (present.has(contentKey(entry.content))) continue;

    const ids = new Set(normalizeSummaryToolCallRefs(entry.details).map((ref) => ref.toolCallId));
    if (!messages.some((m) => m?.role === "toolResult" && ids.has(m.toolCallId))) continue;

    const written = new Date(entry.timestamp).getTime();
    let at = -1;
    for (let j = branch.indexOf(entry) - 1; j >= 0 && at < 0; j--) {
      const index = positionOf.get(entryKey(branch[j]));
      if (index !== undefined) at = index + 1;
    }
    if (at < 0) at = messages.length;

    // Same shape as Pi's createCustomMessage when it rebuilds the list from the session.
    const list = inserts.get(at) ?? [];
    list.push({
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: written,
    });
    inserts.set(at, list);
  }
  if (inserts.size === 0) return messages;

  const out: any[] = [];
  messages.forEach((m, i) => {
    out.push(...(inserts.get(i) ?? []));
    out.push(m);
  });
  out.push(...(inserts.get(messages.length) ?? []));
  return out;
}
