// ops/tools/pi_fast_mode.mjs
import { existsSync } from "node:fs";
import path from "node:path";
var FAST_MODE_EXTENSION_NAMES = Object.freeze([
  "pi_fast_mode.mjs",
  "pi_fast_mode.bundle.mjs"
]);
var FAST_MODE_DESCRIPTION = "\u8BF7\u6C42\u66F4\u5FEB\u63A8\u7406\uFF1AOpenAI \u7CFB\u7EA6 2.5 \u500D\u989D\u5EA6\u3001grok 2 \u500D\u4EF7\u683C\uFF1B\u7701\u7565\u65F6 MCP \u8C03\u7528\u4E3A\u5173\uFF0CPi \u4E3B\u4EE3\u7406\u6CBF\u7528\u5176\u4F1A\u8BDD\u5F53\u524D\u5FEB\u901F\u72B6\u6001\u3002";
var FAST_MODE_MODELS = Object.freeze({ "grok-4.7": "grok-4.7-build-fast" });
function applyFastMode(payload, model) {
  if (["openai", "openai-codex"].includes(model?.provider) && ["openai-responses", "openai-codex-responses"].includes(model?.api) && !Object.hasOwn(payload, "service_tier")) {
    return { ...payload, service_tier: "priority" };
  }
  if (model?.provider === "xai" && Object.hasOwn(FAST_MODE_MODELS, payload.model)) {
    return { ...payload, model: FAST_MODE_MODELS[payload.model] };
  }
  return void 0;
}
function isFastPayload(payload) {
  return payload?.service_tier === "priority" || typeof payload?.model === "string" && payload.model.endsWith("-build-fast");
}
function fastModeSeed(seed, fast) {
  const runtime = { ...seed.runtime_context };
  if (fast === true) runtime.fast = true;
  else delete runtime.fast;
  return { ...seed, runtime_context: runtime };
}
function fastModeExtensionPath(dir, exists = existsSync) {
  for (const name of FAST_MODE_EXTENSION_NAMES) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}
function fastMode(pi) {
  pi.on("before_provider_request", (event, ctx) => applyFastMode(event.payload, ctx.model));
}
export {
  FAST_MODE_DESCRIPTION,
  FAST_MODE_EXTENSION_NAMES,
  applyFastMode,
  fastMode as default,
  fastModeExtensionPath,
  fastModeSeed,
  isFastPayload
};
