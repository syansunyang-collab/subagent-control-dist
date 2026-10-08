import {
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  type Context,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

/** Adapt transcript state for Claude's legacy payload validator and serializer. */
export function hydrateContext(context: Context | TranscriptContext): Context {
  const transcript = normalizeContext(context);
  return {
    ...context,
    systemPrompt: getCurrentSystemPrompt(transcript.messages),
    tools: getCurrentTools(transcript.messages),
    messages: transcript.messages.filter((message) => message.role !== "system"),
  };
}
