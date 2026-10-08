// Records, per provider request, where the outgoing body first differs from the same session's previous body,
// and the usage of the response. Only hashes, counts and positions are written; no message content.
// Log: ~/.pi/agent/logs/payload-cache-diag.jsonl
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getWireObserver, latestPrune } from "./cache-wire-observer.mjs";

const dir = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "logs");
const file = join(dir, "payload-cache-diag.jsonl");
const hash = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v ?? null)).digest("hex").slice(0, 12);
const write = (o: object) => { try { mkdirSync(dir, { recursive: true }); appendFileSync(file, JSON.stringify(o) + "\n"); } catch {} };
const last = new Map<string, { instructions: string; tools: string; rest: string; items: string[]; sizes: number[] }>();

// Read the existing recovery patch's shared counters without importing another provider instance.
function transportSnapshot(session: string) {
  const state = (globalThis as any).__piOpenAICodexWebSocketRecoveryState;
  const stats = state?.websocketDebugStats?.get(session);
  if (!stats) return null;
  const fields = ["requests", "connectionsCreated", "connectionsReused", "fullContextRequests", "deltaRequests", "lastInputItems", "lastDeltaInputItems", "websocketFailures", "sseFallbacks", "websocketRecoveryProbes", "websocketRecoveries", "oversizeFallbacks", "websocketFallbackActive", "fallbackReason"];
  return Object.fromEntries(fields.filter(key => stats[key] !== undefined).map(key => [key, stats[key]]));
}

export default function payloadCacheDiag(pi: ExtensionAPI) {
  const wire = getWireObserver((row: object) => {
    try { mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, "payload-cache-wire.jsonl"), JSON.stringify(row) + "\n"); } catch {}
  });
  pi.on("before_provider_request", (event, ctx) => {
    const p = event.payload as Record<string, any>;
    if (!p || typeof p !== "object" || !Array.isArray(p.input)) return;
    const session = ctx.sessionManager.getSessionId();
    const route = ctx.model?.api === "openai-codex-responses" ? "codex"
      : ctx.model?.provider === "xai" && ctx.model?.api === "openai-responses" ? "xai" : null;
    if (route) wire.prepare(session, p, latestPrune(ctx.sessionManager.getBranch(), p.input), route);
    const { input, instructions, tools, ...others } = p;
    const now = {
      instructions: hash(instructions),
      tools: hash(tools),
      rest: hash(Object.keys(others).sort().map((k) => [k, others[k]])),
      items: input.map((item: unknown) => hash(item)),
      sizes: input.map((item: unknown) => JSON.stringify(item).length),
    };
    const prev = last.get(session);
    let firstDiff = -1;
    if (prev) {
      const n = Math.min(prev.items.length, now.items.length);
      firstDiff = n;
      for (let i = 0; i < n; i++) if (prev.items[i] !== now.items[i]) { firstDiff = i; break; }
    }
    const diffItem = firstDiff >= 0 && firstDiff < input.length ? input[firstDiff] : undefined;
    write({
      kind: "request", time: new Date().toISOString(), session, model: p.model,
      instructionsSame: prev ? prev.instructions === now.instructions : null,
      toolsSame: prev ? prev.tools === now.tools : null,
      restSame: prev ? prev.rest === now.rest : null,
      restKeys: Object.keys(others).sort(),
      items: now.items.length, prevItems: prev?.items.length ?? null, firstDiff,
      charsBeforeDiff: firstDiff >= 0 ? now.sizes.slice(0, firstDiff).reduce((a, b) => a + b, 0) : null,
      totalChars: now.sizes.reduce((a, b) => a + b, 0),
      diffItemType: diffItem ? (diffItem as any).type ?? (diffItem as any).role ?? null : null,
      appendOnly: prev ? firstDiff === prev.items.length : null,
      cacheKey: hash(p.prompt_cache_key),
      transportBefore: transportSnapshot(session),
    });
    last.set(session, now);
  });
  pi.on("message_end", (event, ctx) => {
    const m = event.message as any;
    if (m?.role !== "assistant") return;
    const session = ctx.sessionManager.getSessionId();
    if (m.api === "openai-codex-responses" || (m.provider === "xai" && m.api === "openai-responses")) wire.finish(session, m);
    write({ kind: "usage", time: new Date().toISOString(), session, model: m.model, responseId: m.responseId, input: m.usage?.input, cacheRead: m.usage?.cacheRead, cacheWrite: m.usage?.cacheWrite, transportAfter: transportSnapshot(session), transportFailures: (m.diagnostics ?? []).filter((d: any) => d.type === "provider_transport_failure").map((d: any) => ({ type: d.type, timestamp: d.timestamp, details: d.details })) });
  });
  pi.on("session_shutdown", (_event, ctx) => wire.release(ctx.sessionManager.getSessionId()));
}
