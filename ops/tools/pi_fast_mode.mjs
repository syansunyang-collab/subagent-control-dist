import { existsSync } from "node:fs";
import path from "node:path";

export const FAST_MODE_EXTENSION_NAMES = Object.freeze([
  "pi_fast_mode.mjs",
  "pi_fast_mode.bundle.mjs",
]);
export const FAST_MODE_DESCRIPTION = "请求更快推理：OpenAI 系约 2.5 倍额度、grok 2 倍价格；省略时 MCP 调用为关，Pi 主代理沿用其会话当前快速状态。";
export const GROK_MODEL_ID = "grok-4.7";
export const GROK_FAST_MODEL_ID = "grok-4.7-build-fast";
export const OPENAI_FAST_COST_MULTIPLIER = 2.5;

export function applyFastMode(payload, model) {
  if (["openai", "openai-codex"].includes(model?.provider)
    && ["openai-responses", "openai-codex-responses"].includes(model?.api)
    && !Object.hasOwn(payload, "service_tier")) {
    return { ...payload, service_tier: "priority" };
  }
  return undefined;
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

// Codex 回执恒为 default，Pi 按普通价记账；按模型基础价重算后乘订阅额度倍数。
export function fastPricedMessage(message, model) {
  const usage = message.usage;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let rates = model.cost;
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > (rates.inputTokensAbove ?? -1)) rates = tier;
  }
  const cost = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    cost[key] = rates[key] * usage[key] * OPENAI_FAST_COST_MULTIPLIER / 1_000_000;
  }
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return { ...message, usage: { ...usage, cost } };
}

// 只给真正加上 priority 的那次请求重新记账；主会话按开关，子任务恒开。
export function installFastMode(pi, enabled = () => true) {
  let priced = false;
  pi.on("before_provider_request", (event, ctx) => {
    const payload = enabled() ? applyFastMode(event.payload, ctx.model) : undefined;
    priced = Boolean(payload);
    return payload;
  });
  pi.on("message_end", (event, ctx) => {
    if (!priced || event.message?.role !== "assistant") return undefined;
    priced = false;
    // Pi 只认 { message } 形状的返回值，原地替换后再持久化与上报。
    return { message: fastPricedMessage(event.message, ctx.model) };
  });
}

export default function fastMode(pi) {
  installFastMode(pi);
}
