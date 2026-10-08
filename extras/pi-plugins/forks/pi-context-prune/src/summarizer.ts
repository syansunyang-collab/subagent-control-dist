import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CapturedBatch,
  ContextPruneConfig,
  SummarizerThinking,
  SummarizeBatchOptions,
  SummarizeBatchesOptions,
  SummarizeResult,
} from "./types.js";
import { serializeBatchForSummarizer } from "./batch-capture.js";

const SYSTEM_PROMPT = `You are writing a handoff note for an AI coding assistant. The raw outputs of the tool calls below are about to be removed from its context, and your note replaces them. The goal: the assistant can keep working from your note most of the time without fetching anything again. Details stay retrievable (it can re-read files and fetch any original output by its id), so leave them out unless the work depends on them.

Write about the work, not about each call:
- Group by what the assistant was trying to do: a few bullets per goal. Never list the calls one by one.
- Keep the facts, conclusions and state the next steps depend on: what was confirmed or ruled out (with the evidence in one clause); results of tests and commands; values the work relies on, such as configuration values, versions, ids, even when they came from reading a file or querying a status; state changes (failed then passed, deployed or not, running or finished); decisions made and what is left pending; errors hit, and whether and how they were resolved.
- Compress: repeated polling becomes one line with the final state; several reads of the same area become one line with the paths; bulk file contents become the path and, if it matters, the line range.
- Do not restate the "Assistant said" text included in the batch; it stays in the assistant's context.
- Copy exact values verbatim: paths, identifiers, hashes, numbers, versions, error messages, command lines. Do not round, translate or paraphrase them. State nothing the batch does not show.
- Keep every fact tied to where it was seen. When the batch shows the same file or code from more than one place (the local working copy, a fetched URL or upstream repository, another branch or commit), keep them apart and name the source in each bullet, for example "upstream master src/x.rs" versus "local src/x.rs". Never fold them into one statement about the file.
- A result marked "chars truncated" was cut before you saw all of it: say what is missing and that the full output is available by id. Do not suggest running the command again; its output may differ.
- If nothing in the batch needs keeping, write exactly: Nothing to keep.

Length is a target, not a limit: aim for about 1200 characters for a batch of up to 20 calls and about 2000 for a larger one, and go over only when keeping exact values requires it. Short bullets, no headings, no tables. Write in the language of the assistant's own text in the batch; use English when there is none.`;

export function summarizerThinkingOptions(config: ContextPruneConfig): Record<string, unknown> {
  const level: SummarizerThinking = config.summarizerThinking;
  if (level === "default") {
    return {};
  }

  // stream()/complete() accept provider-level options. For reasoning-capable providers,
  // pi-ai adapters translate reasoningEffort into the provider-specific field.
  // "off" intentionally sends no effort; adapters that support explicit disable
  // handle that the same way as an absent effort, while preserving compatibility.
  return { reasoningEffort: level === "off" ? undefined : level };
}

/**
 * Returns the model to use for summarization.
 * config.summarizerModel === "default" => ctx.model
 * "provider/model-id" => ctx.modelRegistry.find(provider, modelId), fallback to ctx.model with warning
 */
export /**
 * Headers for the direct provider.stream() call. Pi's own request path adds
 * session attribution headers for OpenCode providers; opencode-go rejects
 * requests without `x-opencode-session` (HTTP 400 MissingSessionID), so the
 * summarizer must add them itself when it bypasses that path.
 */
function summarizerHeaders(
  provider: string,
  authHeaders: Record<string, string> | undefined,
  ctx: ExtensionContext
): Record<string, string> | undefined {
  if (provider !== "opencode" && provider !== "opencode-go") return authHeaders;
  return {
    ...(authHeaders ?? {}),
    "x-opencode-session": ctx.sessionManager.getSessionId(),
    "x-opencode-client": "pi",
  };
}

function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): any {
  if (config.summarizerModel === "default") {
    return ctx.model;
  }

  const slashIndex = config.summarizerModel.indexOf("/");
  if (slashIndex === -1) {
    ctx.ui.notify(
      `pruner: invalid summarizerModel "${config.summarizerModel}", expected "provider/model-id". Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  const provider = config.summarizerModel.slice(0, slashIndex);
  const modelId = config.summarizerModel.slice(slashIndex + 1);

  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    ctx.ui.notify(
      `pruner: model "${config.summarizerModel}" not found in registry. Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  return found;
}

function receivedTextChars(message: AssistantMessage): number {
  return message.content.reduce((sum, content) => {
    return content.type === "text" ? sum + content.text.length : sum;
  }, 0);
}

/**
 * Local 500k-window aliases of Codex models; the upstream only knows the real ids.
 * Ported from the patch applied directly to the deployed 1.5.4-budget bundles on 2026-09-22.
 */
const CODEX_WIRE_ALIASES: Record<string, string> = {
  "gpt-5.6-sol-500k": "gpt-5.6-sol",
  "gpt-6-astra-500k": "gpt-6-astra",
};

function codexWireModel<M extends { provider?: string; id: string }>(model: M): M {
  if (!model || model.provider !== "openai-codex") return model;
  const upstream = CODEX_WIRE_ALIASES[model.id];
  return upstream ? { ...model, id: upstream } : model;
}

/**
 * Summarizes a captured batch. Returns formatted markdown string, or null on failure.
 * Shows user-visible errors via ctx.ui.notify.
 */
export async function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {}
): Promise<SummarizeResult | null> {
  // Fast-fail if already aborted before we even start.
  if (options.signal?.aborted) throw new Error("summarizeBatch: aborted before start");

  try {
    const model = resolveModel(config, ctx);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      ctx.ui.notify(`pruner: summarization failed: ${authMessage}`, "error");
      return null;
    }

    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider) {
      ctx.ui.notify(`pruner: summarization failed: unknown provider \"${model.provider}\"`, "error");
      return null;
    }

    const serialized = serializeBatchForSummarizer(batch, config.summarizerMaxCharsPerResult);
    const userMessage =
      SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";

    // Use the provider-owned stream API directly. The compatibility registry
    // facade still exposes auth/header resolution, but no longer exposes a
    // top-level stream() helper of its own.
    const wireModel = codexWireModel(model);
    const responseStream = provider.stream(
      auth.baseUrl ? { ...wireModel, baseUrl: auth.baseUrl } : wireModel,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: summarizerHeaders(model.provider, auth.headers, ctx),
        env: auth.env,
        signal: options.signal,
        ...summarizerThinkingOptions(config),
      }
    );

    let lastReportedChars = -1;
    options.onTextProgress?.(0);
    const reportTextProgress = (message: AssistantMessage) => {
      const chars = receivedTextChars(message);
      if (chars !== lastReportedChars) {
        lastReportedChars = chars;
        options.onTextProgress?.(chars);
      }
    };

    for await (const event of responseStream) {
      // Belt-and-suspenders: break early when signal fires mid-stream.
      if (options.signal?.aborted) break;
      if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
        reportTextProgress(event.partial);
      }
    }

    // If signal fired while we were iterating, propagate the abort so
    // flushPending can detect it and restore batches.
    if (options.signal?.aborted) throw new Error("summarizeBatch: aborted during stream");

    const response = await responseStream.result();
    reportTextProgress(response);
    // stopReason "aborted" means the provider cut the stream short (e.g. signal
    // fired just before the final chunk). Treat identically to the signal check
    // above — throw so flushPending's catch can detect options.signal.aborted.
    if (response.stopReason === "aborted") {
      throw new Error("summarizeBatch: stream stopped with reason aborted");
    }
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "Summarizer stopped with reason: error");
    }

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    return {
      summaryText: llmText,
      usage: response.usage,
    };
  } catch (err: any) {
    // Propagate abort errors upward so flushPending can check signal.aborted
    // and return { ok: false, reason: "aborted" } without showing a UI error.
    if (options.signal?.aborted) throw err;
    ctx.ui.notify(
      `pruner: summarization failed: ${err.message}`,
      "error"
    );
    return null;
  }
}

/**
 * Summarizes multiple captured batches — one LLM call per batch, run in parallel.
 *
 * Returns an array of per-batch results. Each element is either a SummarizeResult
 * (success) or null (that specific batch's call failed). The array length always
 * equals batches.length so callers can zip by index.
 *
 * Rationale for parallel-per-batch instead of a single merged call:
 *   • Each batch becomes its own summary message (one per turn), so they can be
 *     rendered, browsed, and recovered independently via context_tree_query.
 *   • Parallel calls give similar end-to-end latency to a single merged call while
 *     keeping the summaries strictly separated.
 */
export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {}
): Promise<Array<SummarizeResult | null>> {
  if (batches.length === 0) return [];
  // Single batch — delegate to the single-batch path (no extra overhead)
  if (batches.length === 1) {
    return [
      await summarizeBatch(batches[0], config, ctx, {
        signal: options.signal,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(0, 1, batches[0], receivedChars);
        },
      }),
    ];
  }

  // Multiple batches — run in parallel; each produces its own SummarizeResult
  return Promise.all(
    batches.map((batch, index) =>
      summarizeBatch(batch, config, ctx, {
        signal: options.signal,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(index, batches.length, batch, receivedChars);
        },
      })
    )
  );
}
