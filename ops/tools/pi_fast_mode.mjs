import { existsSync } from "node:fs";
import path from "node:path";

export const FAST_MODE_EXTENSION_NAMES = Object.freeze([
  "pi_fast_mode.mjs",
  "pi_fast_mode.bundle.mjs",
]);
export const FAST_MODE_DESCRIPTION = "请求更快推理：OpenAI 系约 2.5 倍额度、grok 2 倍价格；省略时 MCP 调用为关，Pi 主代理沿用其会话当前快速状态。";
const FAST_MODE_MODELS = Object.freeze({ "grok-4.7": "grok-4.7-build-fast" });

export function applyFastMode(payload, model) {
  if (["openai", "openai-codex"].includes(model?.provider)
    && ["openai-responses", "openai-codex-responses"].includes(model?.api)
    && !Object.hasOwn(payload, "service_tier")) {
    return { ...payload, service_tier: "priority" };
  }
  if (model?.provider === "xai" && Object.hasOwn(FAST_MODE_MODELS, payload.model)) {
    return { ...payload, model: FAST_MODE_MODELS[payload.model] };
  }
  return undefined;
}

export function isFastPayload(payload) {
  return payload?.service_tier === "priority"
    || (typeof payload?.model === "string" && payload.model.endsWith("-build-fast"));
}

// 派单入口把布尔覆盖投影进种子；CLI 继续使用既有 seed-stdin 合同。
export function fastModeSeed(seed, fast) {
  const runtime = { ...seed.runtime_context };
  if (fast === true) runtime.fast = true;
  else delete runtime.fast;
  return { ...seed, runtime_context: runtime };
}

export function fastModeExtensionPath(dir, exists = existsSync) {
  for (const name of FAST_MODE_EXTENSION_NAMES) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export default function fastMode(pi) {
  pi.on("before_provider_request", (event, ctx) => applyFastMode(event.payload, ctx.model));
}
