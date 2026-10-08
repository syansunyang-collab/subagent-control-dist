import { getCurrentSystemPrompt, getCurrentTools, type Context } from "@earendil-works/pi-ai";

/** 0.86.0 provider 只收到 transcript。用官方 API 填回旧 Context 字段，供现有 provider 代码读取。 */
export function hydrateContext(context: Context): Context {
  const messages = context.messages ?? [];
  return {
    ...context,
    systemPrompt: getCurrentSystemPrompt(messages),
    tools: getCurrentTools(messages),
  };
}
