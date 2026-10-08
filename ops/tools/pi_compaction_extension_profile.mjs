#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";

import { registeredPiPackages, resolvePiAgentDir } from "./pi_settings_packages.mjs";

export const PI_CHILD_COMPACTION_EXTENSION_PROFILE = "pi-child-compaction-extensions/v1";

// 子进程 -ne 后只显式加载主会话同一套压缩插件：settings.json 登记的包按 package.json name 认。
// 写手只认本地恢复包（name 沿用 pi-compaction-model）；同名的退役 npm 写手不经已登记 provider 改写型号，登记了也不加载。
export const PI_CHILD_COMPACTION_PACKAGES = Object.freeze(["pi-compaction-model", "pi-midrun-compact"]);
const isRetiredNpmWriter = (item) => item.name === "pi-compaction-model" && item.source.startsWith("npm:");

/** 已登记且入口在盘的压缩包，按登记顺序返回 [{ name, extensions }]。 */
export function resolvePiChildCompactionPackages(options = {}) {
  const env = options.env || process.env;
  if (String(env.PI_CONTROL_PI || "").trim()) return [];
  const exists = options.exists || existsSync;
  const agentDir = path.resolve(options.agentDir || resolvePiAgentDir(env));
  return registeredPiPackages(agentDir, PI_CHILD_COMPACTION_PACKAGES)
    .filter((item) => !isRetiredNpmWriter(item))
    .map(({ name, extensions }) => ({ name, extensions: extensions.filter((file) => exists(file)) }))
    .filter((item) => item.extensions.length > 0);
}

export function resolvePiChildCompactionExtensions(options = {}) {
  return resolvePiChildCompactionPackages(options).flatMap((item) => item.extensions);
}

export function isPiCompactionExtensionProfileCli(argv1 = process.argv[1]) {
  return path.basename(String(argv1 || "")).toLowerCase() === "pi_compaction_extension_profile.mjs";
}

if (isPiCompactionExtensionProfileCli()) {
  if (process.argv.slice(2).some((arg) => arg !== "--json")) {
    process.stderr.write("Usage: node ops/tools/pi_compaction_extension_profile.mjs [--json]\n");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify({
    profile: PI_CHILD_COMPACTION_EXTENSION_PROFILE,
    extensions: resolvePiChildCompactionExtensions(),
  })}\n`);
}
