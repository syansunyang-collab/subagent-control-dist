#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";

import { registeredPiPackages, resolvePiAgentDir } from "./pi_settings_packages.mjs";

export const PI_CHILD_MODEL_EXTENSION_PROFILE = "pi-child-model-extensions/v1";

// 目录探针及受控 worker 分支显式加载模型适配器；普通 worker 由 pi_worker_resources 目录加载 base 扩展与角色白名单资源。
const EXTENSION_FILES = Object.freeze(["extensions/openai-codex-sol-context-alias.ts"]);
// 模型适配器包按 settings.json 实际登记的来源取（如 Antigravity 改装本地原生包后随之切换）。
const MODEL_PROVIDER_PACKAGES = Object.freeze([
  "pi-claude-code-provider",
  "@tian.zuo/pi-antigravity",
  "@local/pi-antigravity-native",
  "pi-cursor-host",
]);

export function resolvePiChildModelExtensions(options = {}) {
  const env = options.env || process.env;
  // PI_CONTROL_PI 是测试/自定义 CLI 注入缝；其扩展目录由调用方用 --ext 显式提供。
  if (String(env.PI_CONTROL_PI || "").trim()) return [];
  const exists = options.exists || existsSync;
  const agentDir = path.resolve(options.agentDir || resolvePiAgentDir(env));
  return [
    ...EXTENSION_FILES.map((relativePath) => path.join(agentDir, ...relativePath.split("/"))),
    ...registeredPiPackages(agentDir, MODEL_PROVIDER_PACKAGES).flatMap((item) => item.extensions),
  ].filter((candidate) => exists(candidate));
}

export function isPiModelExtensionProfileCli(argv1 = process.argv[1]) {
  return path.basename(String(argv1 || "")).toLowerCase() === "pi_model_extension_profile.mjs";
}

if (isPiModelExtensionProfileCli()) {
  if (process.argv.slice(2).some((arg) => arg !== "--json")) {
    process.stderr.write("Usage: node ops/tools/pi_model_extension_profile.mjs [--json]\n");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify({
    profile: PI_CHILD_MODEL_EXTENSION_PROFILE,
    extensions: resolvePiChildModelExtensions(),
  })}\n`);
}
