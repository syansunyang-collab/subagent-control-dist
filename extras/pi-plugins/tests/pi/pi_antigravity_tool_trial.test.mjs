import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { agentMarkdown, isPathInWorkspace, registerWorkspaceBridge, trimBridgeText, TRIAL_AGENT } from "../../tools/pi-antigravity/pi-tool-trial.mjs";

const piPath = path.join(process.env.APPDATA || "", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "tools", "truncate.js");
const truncate = fs.existsSync(piPath) ? await import(pathToFileURL(piPath).href).then(m => ({ head: m.truncateHead, tail: m.truncateTail })) : null;

function withFixture(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-trial-test-"));
  const previous = process.env.PI_ANTIGRAVITY_PI_TOOLS_TRIAL;
  process.env.PI_ANTIGRAVITY_PI_TOOLS_TRIAL = "1";
  try { return fn(cwd); }
  finally {
    if (previous === undefined) delete process.env.PI_ANTIGRAVITY_PI_TOOLS_TRIAL;
    else process.env.PI_ANTIGRAVITY_PI_TOOLS_TRIAL = previous;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("fixture runner rejects a real-project workspace before loading the SDK", () => {
  const script = fileURLToPath(new URL("../../tools/pi-antigravity/run-pi-tool-trial.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--workspace", os.tmpdir(), "--load-only"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert(result.stderr.includes("requires a workspace inside"));
});

test("workspace boundary permits new local files and rejects outside paths", () => withFixture(cwd => {
  assert(isPathInWorkspace(cwd, path.join(cwd, "new", "file.txt")));
  assert(!isPathInWorkspace(cwd, path.resolve(cwd, "..", "outside.txt")));
  assert(!isPathInWorkspace(cwd, path.join(os.homedir(), ".pi", "settings.json")));
}));

test("workspace boundary rejects a link into an external directory", () => withFixture(cwd => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-external-"));
  try {
    const link = path.join(cwd, "external-link");
    fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
    assert(!isPathInWorkspace(cwd, path.join(link, "new.txt")));
  } finally { fs.rmSync(external, { recursive: true, force: true }); }
}));

test("trial registers and removes only its workspace MCP entry", () => withFixture(cwd => {
  const configFile = path.join(cwd, ".agents", "mcp_config.json");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { existing: { serverUrl: "http://localhost:1/keep" } }, other: true }));
  const remove = registerWorkspaceBridge(cwd, "trial", "http://localhost:2/mcp", "secret", "pi__test__");
  let config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.equal(config.mcpServers.trial.headers["x-pi-bridge-token"], "secret");
  assert.equal(config.mcpServers.existing.serverUrl, "http://localhost:1/keep");
  assert(fs.readFileSync(path.join(cwd, ".agents", "agents", TRIAL_AGENT, "agent.md"), "utf8").includes("excludeDefaultComponents: true"));
  remove();
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.deepEqual(config, { mcpServers: { existing: { serverUrl: "http://localhost:1/keep" } }, other: true });
}));

test("trial does not replace an existing MCP server", () => withFixture(cwd => {
  registerWorkspaceBridge(cwd, "trial", "http://localhost:2/mcp", "secret", "pi__test__");
  assert.throws(() => registerWorkspaceBridge(cwd, "trial", "http://localhost:3/mcp", "next", "pi__next__"), /already exists/);
}));

test("agent uses the registered server name and actual tool prefix", () => {
  const text = agentMarkdown("pi-bridge-123", "pi__session__");
  assert(text.includes("pi-bridge-123 MCP server"));
  assert(text.includes("prefix pi__session__"));
  assert(text.includes("tools: []"));
  assert(text.includes("inheritCustomizations: false"));
});

test("bridge shortening preserves command tail and full output", { skip: !truncate }, () => withFixture(cwd => {
  const full = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n") + "\nFAILURE_AT_END";
  const result = trimBridgeText(full, "bash", cwd, truncate);
  assert(result.includes("FAILURE_AT_END"));
  assert(!result.includes("line 0\n"));
  const files = fs.readdirSync(path.join(cwd, ".pi", "antigravity-trial-output"));
  assert.equal(files.length, 1);
  assert.equal(fs.readFileSync(path.join(cwd, ".pi", "antigravity-trial-output", files[0]), "utf8"), full);
}));

test("a long single line keeps a visible UTF-8-safe tail and an exact archive", { skip: !truncate }, () => withFixture(cwd => {
  const full = "字".repeat(10_000) + "TAIL_MARKER";
  const result = trimBridgeText(full, "read", cwd, truncate);
  assert(result.includes("TAIL_MARKER"));
  assert(!result.includes("�"));
  const file = fs.readdirSync(path.join(cwd, ".pi", "antigravity-trial-output"))[0];
  assert.equal(fs.readFileSync(path.join(cwd, ".pi", "antigravity-trial-output", file), "utf8"), full);
}));

test("short output and disabled trial output remain unchanged", { skip: !truncate }, () => withFixture(cwd => {
  assert.equal(trimBridgeText("short", "read", cwd, truncate), "short");
  delete process.env.PI_ANTIGRAVITY_PI_TOOLS_TRIAL;
  const full = "x\n".repeat(400);
  assert.equal(trimBridgeText(full, "bash", cwd, truncate), full);
  assert(!fs.existsSync(path.join(cwd, ".pi", "antigravity-trial-output")));
}));
