#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultSource = path.join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "npm", "node_modules", "@tian.zuo", "pi-antigravity");
const flags = process.argv.slice(2);
const flag = (name, fallback) => flags.includes(name) ? flags[flags.indexOf(name) + 1] : fallback;
const source = path.resolve(flag("--source", defaultSource));
const target = path.resolve(flag("--target", "tmp/antigravity-pi-tools-trial/package-reviewed"));
const hash = (text) => createHash("sha256").update(text).digest("hex");

export function patchTrialSources(files) {
  const output = { ...files };
  const replace = (name, before, after) => {
    const text = output[name];
    if (text.split(before).length !== 2) throw new Error(`Trial patch anchor mismatch: ${name}: ${before.slice(0, 90)}`);
    output[name] = text.replace(before, after);
  };

  replace("lib/bridge.ts", 'import { createHash, randomUUID } from "node:crypto";', 'import { createHash, randomUUID } from "node:crypto";\nimport { PI_CORE_TOOLS, trialEnabled } from "./pi-tool-trial.mjs";');
  replace("lib/bridge.ts", '    if (!MCP_ADAPTER_SOURCE.test(tool.sourceInfo?.source ?? "")) continue;', '    if (!MCP_ADAPTER_SOURCE.test(tool.sourceInfo?.source ?? "") && !(trialEnabled() && PI_CORE_TOOLS.has(tool.name))) continue;');
  replace("lib/bridge.ts", "    for (const pending of this.#pending.values()) {\n      clearTimeout(pending.timer);\n      pending.resolve({\n        content: \"antigravity: pi session shut down while the tool call was pending.\",\n        isError: true,\n      });\n    }\n    this.#pending.clear();", '    this.cancelPending("antigravity: pi session shut down while the tool call was pending.");');
  replace("lib/bridge.ts", "  /** True when the provider is still waiting for pi to execute this call. */", `  /** Settle pending calls without closing the workspace bridge. */
  cancelPending(content: string): void {
    for (const id of this.#pending.keys()) {
      this.resolveCall(id, { content, isError: true });
    }
  }

  /** True when the provider is still waiting for pi to execute this call. */`);

  replace("index.ts", 'import { randomUUID } from "node:crypto";', 'import { randomUUID } from "node:crypto";\nimport { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";\nimport { registerWorkspaceBridge, PI_CORE_TOOLS, trialEnabled, trimBridgeText } from "./lib/pi-tool-trial.mjs";');
  replace("index.ts", '  pi.on("session_compact", async (_event, ctx: ExtensionContext) => {', '  pi.on("tool_result", (event, ctx) => {\n    if (!trialEnabled() || !PI_CORE_TOOLS.has(event.toolName)) return;\n    return { content: event.content.map((item) => item.type === "text"\n      ? { ...item, text: trimBridgeText(item.text, event.toolName, ctx.cwd, { head: truncateHead, tail: truncateTail }) }\n      : item) };\n  });\n\n  pi.on("session_compact", async (_event, ctx: ExtensionContext) => {');
  replace("index.ts", "  const bridgeManager = createBridgeLifecycleManager({", "  let removeWorkspaceBridge: (() => void) | undefined;\n  const bridgeManager = createBridgeLifecycleManager({");
  replace("index.ts", "    pruneStaleRegistrations: pruneStaleBridgeRegistrations,", "    // Trial processes register only in their temporary workspace.\n    pruneStaleRegistrations: undefined,");
  replace("index.ts", '      await execAgy([\n        "mcp",\n        "add",\n        "--type",\n        "http",\n        "--header",\n        `x-pi-bridge-token: ${token}`,\n        serverName,\n        url,\n      ]);', "      removeWorkspaceBridge = registerWorkspaceBridge(process.cwd(), serverName, url, token, bridgeToolPrefix);");
  replace("index.ts", '      await execAgy(["mcp", "remove", serverName], SHUTDOWN_AGY_TIMEOUT_MS);', "      removeWorkspaceBridge?.();\n      removeWorkspaceBridge = undefined;");
  replace("index.ts", "    evictMcpCache: removeMcpCacheEntry,", "    evictMcpCache: async () => {},");
  replace("index.ts", '  pi.on("agent_settled", (_event, ctx) => {', `  pi.on("agent_settled", async (_event, ctx) => {
    if (trialEnabled() && bridge.pendingCount > 0) {
      // Pi skips agent_before_settle when cancelled and will not re-enter the provider.
      // Stop agy before settling MCP calls so it cannot continue the ended turn.
      await runAntigravity(runtime, service.abortTurn);
      bridge.cancelPending("antigravity: pi turn ended before the tool call completed.");
    }`);
  replace("src/runtime.ts", "  readonly reset: Effect.Effect<void, AntigravityRuntimeClosedError>;", "  readonly abortTurn: Effect.Effect<void, AntigravityRuntimeClosedError>;\n  readonly reset: Effect.Effect<void, AntigravityRuntimeClosedError>;");
  replace("src/runtime.ts", "      reset: ensureOpen.pipe(", `      abortTurn: ensureOpen.pipe(Effect.andThen(Effect.promise(() => recycle("abort")))),

      reset: ensureOpen.pipe(`);

  replace("lib/agy-client.ts", "  if (request.agent) args.push(\"--agent\", request.agent);", "  const agent = process.env.PI_ANTIGRAVITY_PI_TOOLS_TRIAL === \"1\" ? \"pi-tools-trial\" : request.agent;\n  if (agent) args.push(\"--agent\", agent);");
  return output;
}

export function prepareTrial(sourceDir, targetDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8"));
  if (manifest.version !== "0.10.3") throw new Error(`Trial supports pi-antigravity 0.10.3, found ${manifest.version}`);
  if (fs.existsSync(targetDir)) throw new Error(`Trial target already exists: ${targetDir}`);
  const names = ["index.ts", "lib/bridge.ts", "lib/agy-client.ts", "src/runtime.ts"];
  const originals = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(sourceDir, name), "utf8")]));
  const patched = patchTrialSources(originals);
  fs.cpSync(sourceDir, targetDir, { recursive: true, filter: (p) => path.basename(p) !== "node_modules" });
  for (const name of names) fs.writeFileSync(path.join(targetDir, name), patched[name]);
  const helper = fs.readFileSync(path.join(here, "pi-tool-trial.mjs"), "utf8");
  fs.writeFileSync(path.join(targetDir, "lib", "pi-tool-trial.mjs"), helper);
  const npmModules = path.dirname(path.dirname(sourceDir));
  fs.symlinkSync(npmModules, path.join(targetDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const prepared = { source: sourceDir, target: targetDir, version: manifest.version, helperSha256: hash(helper), files: names.map(name => ({ path: name, sourceSha256: hash(originals[name]), trialSha256: hash(patched[name]) })) };
  fs.writeFileSync(path.join(targetDir, "trial-manifest.json"), JSON.stringify(prepared, null, 2) + "\n");
  return prepared;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(prepareTrial(source, target), null, 2));
}
