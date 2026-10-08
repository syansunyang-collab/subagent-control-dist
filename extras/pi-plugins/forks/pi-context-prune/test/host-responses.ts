/** Offline oracle: use the installed Pi host's Responses converter, never a network provider. */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Same installed-host location as the plugin repository's cache_wire_observer tests.
const ai = process.env.PI_CONTEXT_PRUNE_TEST_AI_DIST
  ?? join(process.env.APPDATA!, "npm/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist");
const { convertResponsesMessages } = await import(pathToFileURL(join(ai, "api/openai-responses-shared.js")).href);
const allowedToolCallProviders = new Set(["openai", "openai-codex", "opencode"]);

export function responsesPayload(model: any, messages: any[]): { input: any[] } {
  return { input: convertResponsesMessages({ input: ["text"], reasoning: false, ...model }, { messages }, allowedToolCallProviders) };
}

export function wireToolText(text: string): string {
  const model = { provider: "xai", api: "openai-responses", id: "offline-xai" };
  const messages = [
    { role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason: "toolUse", timestamp: 1,
      content: [{ type: "toolCall", id: "query|fc_query", name: "context_tree_query", arguments: {} }] },
    { role: "toolResult", toolCallId: "query|fc_query", toolName: "context_tree_query", isError: false, timestamp: 2,
      content: [{ type: "text", text }] },
  ];
  return responsesPayload(model, messages).input.find(item => item.type === "function_call_output").output;
}
