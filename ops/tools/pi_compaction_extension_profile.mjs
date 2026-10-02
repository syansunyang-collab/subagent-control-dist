#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const PI_CHILD_COMPACTION_EXTENSION_PROFILE = "pi-child-compaction-extensions/v1";

// 子进程 -ne 后只显式加载主会话同一套压缩插件。
// 写手只用 settings 已登记的本地恢复包；入口缺失时不加载退役 npm 写手。
const COMPACTION_WRITER = "local-packages/pi-compaction-model-recovery/src/index.ts";
const MIDRUN_EXTENSION = "npm/node_modules/pi-midrun-compact/index.ts";

export function resolvePiAgentDir(env = process.env) {
  const configured = String(env.PI_CODING_AGENT_DIR || "").trim();
  return path.resolve(configured || path.join(homedir(), ".pi", "agent"));
}

export function resolvePiChildCompactionExtensions(options = {}) {
  const env = options.env || process.env;
  if (String(env.PI_CONTROL_PI || "").trim()) return [];
  const exists = options.exists || existsSync;
  const agentDir = path.resolve(options.agentDir || resolvePiAgentDir(env));
  const join = (relativePath) => path.join(agentDir, ...relativePath.split("/"));
  return [COMPACTION_WRITER, MIDRUN_EXTENSION].map(join).filter((file) => exists(file));
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
