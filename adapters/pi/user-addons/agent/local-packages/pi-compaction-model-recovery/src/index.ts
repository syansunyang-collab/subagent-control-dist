import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { compact, getAgentDir, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig, parseModelReference } from "./config.js";

const RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 2000, maxAgentDelayMs: 10000 };

function restorePreviousFileOperations(event: SessionBeforeCompactEvent) {
  for (let i = event.branchEntries.length - 1; i >= 0; i--) {
    const entry = event.branchEntries[i];
    if (entry.type !== "compaction") continue;
    const details = entry.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
    for (const [key, destination] of [["readFiles", event.preparation.fileOps.read], ["modifiedFiles", event.preparation.fileOps.edited]] as const) {
      const files = details?.[key];
      if (Array.isArray(files)) for (const file of files) if (typeof file === "string") destination.add(file);
    }
    break;
  }
}

function createLog(ctx: ExtensionContext, reason: string) {
  const sessionId = ctx.sessionManager.getSessionId();
  const runId = randomUUID();
  const directory = join(getAgentDir(), "logs", "compaction");
  const file = join(directory, `${sessionId}.jsonl`);
  const secrets: string[] = [];
  const started = Date.now();
  let warned = false;
  return {
    runId,
    rememberSecret(value: string | undefined) { if (value) secrets.push(value); },
    error(error: unknown) {
      let text = error instanceof Error ? error.message : String(error);
      for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
      return text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 1500);
    },
    write(event: string, data: Record<string, unknown> = {}) {
      try {
        mkdirSync(directory, { recursive: true });
        appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), sessionId, runId, reason, event, elapsedMs: Date.now() - started, ...data }) + "\n");
      } catch (error) {
        if (!warned) console.warn("[pi-compaction-model] Could not write diagnostic log:", error instanceof Error ? error.message : String(error));
        warned = true;
      }
    },
  };
}

type PendingRun = { log: ReturnType<typeof createLog>; stage: string; model: string };

export default function compactionModel(pi: ExtensionAPI) {
  let pending: PendingRun | undefined;

  pi.on("session_before_compact", async (event, ctx) => {
    const config = loadConfig(ctx);
    if (!config || !config.reasons.includes(event.reason)) return;
    const log = createLog(ctx, event.reason);
    const primaryModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
    const run = { log, stage: "writer", model: config.model };
    pending = run;
    log.write("start", { tokensBefore: event.preparation.tokensBefore, primaryModel });
    restorePreviousFileOperations(event);
    const writers = [
      { stage: "writer", model: config.model, thinkingLevel: config.thinkingLevel },
      ...(config.fallbackModel && config.fallbackModel !== config.model ? [{ stage: "backup", model: config.fallbackModel, thinkingLevel: config.fallbackThinkingLevel }] : []),
    ];
    for (const writer of writers) {
      if (event.signal.aborted) { log.write("cancelled"); pending = undefined; return { cancel: true }; }
      run.stage = writer.stage;
      run.model = writer.model;
      const started = Date.now();
      log.write("writer_start", { ...writer, retry: RETRY });
      try {
        const reference = parseModelReference(writer.model);
        if (!reference) throw new Error(`Invalid model reference: ${writer.model}`);
        const model = ctx.modelRegistry.find(reference.provider, reference.modelId);
        if (!model) throw new Error(`Model unavailable: ${writer.model}`);
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) throw new Error(`Authentication failed: ${auth.error}`);
        log.rememberSecret(auth.apiKey);
        const sessionId = ctx.sessionManager.getSessionId();
        const headers = { ...auth.headers, ...(model.provider === "opencode-go" ? { "x-opencode-session": sessionId, "x-opencode-client": "pi" } : {}) };
        // Stream through the session's registered provider so provider wrappers (model aliases, service tier) apply.
        const provider = ctx.modelRegistry.getProvider(model.provider);
        const streamFn = provider ? (m: typeof model, context: any, options: any) => {
          const stream = provider.streamSimple(auth.baseUrl ? { ...m, baseUrl: auth.baseUrl } : m, context, options);
          return { result: async () => {
            const response = await stream.result();
            log.write("writer_response", {
              stage: writer.stage, model: writer.model,
              requestedMaxTokens: options.maxTokens, thinkingLevel: options.reasoning,
              stopReason: response.stopReason, rawStopReason: response.rawStopReason,
              responseId: response.responseId,
              usage: response.usage,
              textChars: response.content.filter((block: any) => block.type === "text")
                .reduce((sum: number, block: any) => sum + block.text.length, 0),
            });
            return response;
          } };
        } : undefined;
        const result = await compact(event.preparation, model, auth.apiKey, headers, event.customInstructions, event.signal, writer.thinkingLevel, streamFn, auth.env, RETRY, {
          onRetryScheduled(attempt, maxAttempts, delayMs, error) {
            log.write("retry_scheduled", { stage: writer.stage, model: writer.model, attempt, maxAttempts, delayMs, error: log.error(error) });
          },
          onRetryAttemptStart() { log.write("retry_started", { stage: writer.stage, model: writer.model }); },
          onRetryFinished(success, attempt, error) {
            log.write("retry_finished", { stage: writer.stage, model: writer.model, success, attempt, ...(error ? { error: log.error(error) } : {}) });
          },
        }, sessionId);
        if (event.signal.aborted) { log.write("cancelled", { stage: writer.stage }); pending = undefined; return { cancel: true }; }
        log.write("writer_success", { stage: writer.stage, model: writer.model, durationMs: Date.now() - started, usage: result.usage });
        return { compaction: { ...result, details: { ...(result.details as Record<string, unknown>), compactionRoute: { runId: log.runId, stage: writer.stage, model: writer.model } } } };
      } catch (error) {
        if (event.signal.aborted) { log.write("cancelled", { stage: writer.stage }); pending = undefined; return { cancel: true }; }
        log.write("writer_failed", { stage: writer.stage, model: writer.model, durationMs: Date.now() - started, error: log.error(error) });
      }
    }
    run.stage = "primary";
    run.model = primaryModel;
    log.write("primary_fallback", { model: primaryModel });
    ctx.ui.notify("压缩写手与备用路径均未完成，改用当前主模型继续；诊断已记录。", "warning");
    // Returning no override delegates the last tier to Pi, retaining its payload hooks and retry policy.
  });

  pi.on("session_compact", (event) => {
    if (!pending) return;
    pending.log.write("complete", { stage: pending.stage, model: pending.model, fromExtension: event.fromExtension, usage: event.compactionEntry.usage });
    pending = undefined;
  });
  pi.on("session_compact_failed", (event) => {
    if (!pending) return;
    pending.log.write(event.aborted ? "cancelled" : "failed", { stage: pending.stage, model: pending.model, ...(event.errorMessage ? { error: pending.log.error(event.errorMessage) } : {}) });
    pending = undefined;
  });
}
