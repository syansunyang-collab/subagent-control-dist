import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Local selector IDs that Codex does not accept, mapped to the upstream model and request tier. */
const ALIASES: Record<string, { upstream: string; serviceTier?: string }> = {
  "gpt-5.6-sol-500k": { upstream: "gpt-5.6-sol" },
  "gpt-6-sol-500k": { upstream: "gpt-6-sol" },
  "gpt-6-astra-500k": { upstream: "gpt-6-astra" },
  "gpt-6-luna-fast-700k": { upstream: "gpt-6-luna", serviceTier: "priority" },
};

function aliasOf(modelId: unknown) {
  if (typeof modelId !== "string" || modelId.length === 0) return undefined;
  return ALIASES[modelId.slice(modelId.lastIndexOf("/") + 1)];
}

/** Shared request mapping for normal turns and auxiliary page-answer requests. */
export function rewriteCodexPayload(payload: unknown, model?: { provider?: string; id?: string }) {
  if (model?.provider && model.provider !== "openai-codex") return;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const body = payload as Record<string, unknown>;
  const alias = aliasOf(body.model) ?? aliasOf(model?.id);
  if (!alias) return;
  return { ...body, model: alias.upstream, ...(alias.serviceTier ? { service_tier: alias.serviceTier } : {}) };
}

// Compaction and summarizers call provider.stream directly, without the normal-turn hook.
export function withCodexAliases<T extends { stream: (...args: any[]) => any; streamSimple: (...args: any[]) => any }>(provider: T): T {
  const wrap = (method: "stream" | "streamSimple") => (model: any, context: any, options: any) => {
    const alias = model.provider === "openai-codex" ? aliasOf(model.id) : undefined;
    if (!alias) return provider[method](model, context, options);
    const routed = alias.serviceTier ? {
      ...options, serviceTier: alias.serviceTier,
      async onPayload(payload: any) {
        const transformed = await options?.onPayload?.(payload);
        return { ...(transformed ?? payload), service_tier: alias.serviceTier };
      },
    } : options;
    return provider[method]({ ...model, id: alias.upstream }, context, routed);
  };
  return { ...provider, stream: wrap("stream"), streamSimple: wrap("streamSimple") };
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => rewriteCodexPayload(event.payload, ctx.model));
  pi.on("session_start", (_event, ctx) => {
    const provider = ctx.modelRegistry.getProvider("openai-codex");
    if (provider) pi.registerProvider(withCodexAliases(provider));
  });
}
