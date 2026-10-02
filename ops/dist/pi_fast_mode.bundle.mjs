// ops/tools/pi_fast_mode.mjs
import { existsSync } from "node:fs";
import path from "node:path";
var FAST_MODE_EXTENSION_NAMES = Object.freeze([
  "pi_fast_mode.mjs",
  "pi_fast_mode.bundle.mjs"
]);
var FAST_MODE_DESCRIPTION = "\u8BF7\u6C42\u66F4\u5FEB\u63A8\u7406\uFF1AOpenAI \u7CFB\u7EA6 2.5 \u500D\u989D\u5EA6\u3001grok 2 \u500D\u4EF7\u683C\uFF1B\u7701\u7565\u65F6 MCP \u8C03\u7528\u4E3A\u5173\uFF0CPi \u4E3B\u4EE3\u7406\u6CBF\u7528\u5176\u4F1A\u8BDD\u5F53\u524D\u5FEB\u901F\u72B6\u6001\u3002";
var GROK_MODEL_ID = "grok-4.7";
var GROK_FAST_MODEL_ID = "grok-4.7-build-fast";
var OPENAI_FAST_COST_MULTIPLIER = 2.5;
function applyFastMode(payload, model) {
  if (["openai", "openai-codex"].includes(model?.provider) && ["openai-responses", "openai-codex-responses"].includes(model?.api) && !Object.hasOwn(payload, "service_tier")) {
    return { ...payload, service_tier: "priority" };
  }
  return void 0;
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
function fastPricedMessage(message, model) {
  const usage = message.usage;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let rates = model.cost;
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > (rates.inputTokensAbove ?? -1)) rates = tier;
  }
  const cost = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    cost[key] = rates[key] * usage[key] * OPENAI_FAST_COST_MULTIPLIER / 1e6;
  }
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return { ...message, usage: { ...usage, cost } };
}
function installFastMode(pi, enabled = () => true) {
  let priced = false;
  pi.on("before_provider_request", (event, ctx) => {
    const payload = enabled() ? applyFastMode(event.payload, ctx.model) : void 0;
    priced = Boolean(payload);
    return payload;
  });
  pi.on("message_end", (event, ctx) => {
    if (!priced || event.message?.role !== "assistant") return void 0;
    priced = false;
    return { message: fastPricedMessage(event.message, ctx.model) };
  });
}
function fastMode(pi) {
  installFastMode(pi);
}
export {
  FAST_MODE_DESCRIPTION,
  FAST_MODE_EXTENSION_NAMES,
  GROK_FAST_MODEL_ID,
  GROK_MODEL_ID,
  OPENAI_FAST_COST_MULTIPLIER,
  applyFastMode,
  fastMode as default,
  fastModeExtensionPath,
  fastModeSeed,
  fastPricedMessage,
  installFastMode
};
