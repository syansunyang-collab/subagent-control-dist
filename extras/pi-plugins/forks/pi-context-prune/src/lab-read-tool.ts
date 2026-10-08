/**
 * Read-back tool for the policy lab.
 *
 * This is the only tool the lab registers: it serves the archived snapshot of a
 * released tool result (never the current file on disk) and supports 1-based
 * line and in-line pagination with a per-call archived body budget.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";
import { DEFAULT_READ_LINES, MAX_READ_LINES, MAX_READ_CHARS, READ_TOOL_NAME, readSnapshotPage } from "./lab-policy.js";

export function registerLabReadTool(pi: ExtensionAPI, indexer: ToolCallIndexer): void {
  pi.registerTool({
    name: READ_TOOL_NAME,
    label: "Read Archived Tool Output",
    description:
      "Read the archived output of an earlier tool call whose result was replaced by a [pruned:tN] receipt. " +
      "The archive holds the output exactly as it was returned then; it is not refreshed. " +
      `Archived text is limited to ${MAX_READ_CHARS} characters across all refs per call. ` +
      "Page with offset (1-based line), limit (lines), and charOffset (0-based position within that line). " +
      "Continue each ref with its returned nextOffset and nextCharOffset; deferred refs remain unread.",
    promptSnippet: "Read the archived output of an earlier tool call by its [pruned:tN] ref, with line pagination",
    promptGuidelines: [
      "A tool result shown as [pruned:tN] was archived to keep the context small; the call and its arguments are still above it, and nothing was lost.",
      "When you need a pruned file's content, read the file again: the archive is a copy from when it was read and may be out of date.",
      "When you need a pruned output that running the tool again would not reproduce (test or command output of an earlier state, errors, fetched pages, search results), call context_tree_query with its tN ref.",
      "Continue long archived outputs using each ref's nextOffset and nextCharOffset as offset and charOffset. Query deferred refs separately.",
    ],
    parameters: Type.Object({
      toolCallIds: Type.Array(Type.String({ description: "One or more short refs (for example t3) or tool call IDs to read" }), {
        description: "Refs whose archived snapshots should be returned",
      }),
      offset: Type.Optional(Type.Number({ description: "1-based first line of the snapshot to return (default 1)" })),
      charOffset: Type.Optional(Type.Number({ description: "0-based character position within offset's line (default 0); use nextCharOffset to continue" })),
      limit: Type.Optional(
        Type.Number({ description: `Maximum lines to return (default ${DEFAULT_READ_LINES}, max ${MAX_READ_LINES})` }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const blocks: string[] = [];
      const details: Record<string, unknown> = {};
      let remaining = MAX_READ_CHARS;

      for (const id of params.toolCallIds) {
        const record = indexer.getRecord(id);
        if (!record) {
          blocks.push(`## toolRef: ${id}\n(no archived snapshot for this ref)`);
          continue;
        }
        const page = remaining > 0
          ? readSnapshotPage(record.resultText, params.offset, params.limit, params.charOffset, remaining) : null;
        // A remaining unit cannot fit a two-unit code point: defer instead of an empty continuation.
        if (!page || (page.text.length === 0 && page.nextOffset !== null)) {
          details[id] = { deferred: true, nextOffset: page?.startLine ?? params.offset ?? 1,
            nextCharOffset: page?.charOffset ?? params.charOffset ?? 0 };
          blocks.push(`## toolRef: ${id}\n[deferred: body budget exhausted; query this ref separately]`);
          continue;
        }
        remaining -= page.text.length;
        details[id] = {
          toolName: record.toolName,
          totalLines: page.totalLines,
          startLine: page.startLine,
          endLine: page.endLine,
          nextOffset: page.nextOffset,
          charOffset: page.charOffset,
          nextCharOffset: page.nextCharOffset,
          bodyChars: page.text.length,
        };
        const header = [
          `## toolRef: ${id}`,
          `Tool: ${record.toolName}`,
          `Args: ${JSON.stringify(record.args).slice(0, 1000)}`,
          `Status: ${record.isError ? "error" : "ok"}`,
          `Turn: ${record.turnIndex}`,
          `Snapshot: lines ${page.startLine}-${page.endLine} of ${page.totalLines}`,
        ];
        const footer = page.nextOffset === null ? [] : [`[next: offset=${page.nextOffset} charOffset=${page.nextCharOffset}]`];
        blocks.push([...header, page.text, ...footer].join("\n"));
      }

      return {
        content: [{ type: "text" as const, text: blocks.join("\n\n") }],
        details,
      };
    },
  });
}
