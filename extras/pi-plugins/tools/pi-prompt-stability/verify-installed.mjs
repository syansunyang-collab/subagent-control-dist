// Offline installed SDK/bundle check. Uses in-memory credentials, settings and sessions,
// fixture named sections, and an in-process WS. Never loads user extensions or memory.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  root: { type: "string" }, "agent-dir": { type: "string" }, bundle: { type: "boolean" },
  compaction: { type: "string", default: "success" },
} });
const root = values.root ? resolve(values.root) : join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent");
const agentDir = resolve(values["agent-dir"] ?? "test-results/pi-0991-upgrade/host/offline-agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
const load = (relative) => import(pathToFileURL(join(root, relative)).href);
const sdk = await load(values.bundle ? "dist/bundle/index.js" : "dist/index.js");
const ai = await load("node_modules/@earendil-works/pi-ai/dist/index.js");
const originalSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
const frames = [];
let responses = 0;
let fetches = 0;
let failSummary = false;
class MockSocket {
  readyState = 1;
  listeners = new Map();
  constructor() { queueMicrotask(() => this.emit("open", {})); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  close() { this.readyState = 3; this.emit("close", { code: 1000 }); }
  send(data) {
    const frame = JSON.parse(data);
    frames.push(frame);
    const id = `resp_${++responses}`;
    const item = { type: "message", id: `msg_${responses}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "offline summary or reply" }] };
    const toolItem = { type: "function_call", id: "fc_probe", call_id: "probe-1", name: "probe", arguments: "{}", status: "completed" };
    const events = failSummary ? [{ type: "response.failed", response: { error: { message: "fixture summary failure" } } }] : responses === 1 ? [
      { type: "codex.response.metadata", headers: { "x-codex-turn-state": `fixture-state-${frame.client_metadata.turn_id}` } },
      { type: "response.output_item.added", output_index: 0, item: { ...toolItem, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
      { type: "response.output_item.done", output_index: 0, item: toolItem },
      { type: "response.completed", response: { id, status: "completed", output: [toolItem], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
    ] : [
      { type: "codex.response.metadata", headers: { "x-codex-turn-state": `fixture-state-${frame.client_metadata.turn_id}` } },
      { type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", part: { type: "output_text", text: "" } },
      { type: "response.output_text.delta", delta: "offline summary or reply" },
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { id, status: "completed", usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
    ];
    queueMicrotask(() => { for (const event of events) this.emit("message", { data: JSON.stringify(event) }); });
  }
}
globalThis.WebSocket = MockSocket;
globalThis.fetch = async () => { fetches++; throw new Error("network disabled in offline check"); };
const triggers = [];
let cancelSummary = false;
let toolCalls = 0;
const probe = (pi) => {
  pi.registerTool({ name: "probe", label: "Probe", description: "Offline tool fixture", parameters: { type: "object", properties: {} },
    execute: async () => { toolCalls++; return { content: [{ type: "text", text: "ok" }], details: {} }; } });
  pi.on("before_agent_start", (event) => {
    triggers.push(event.trigger);
    event.systemPromptOptions.sections.hermes_memory = "<hermes_memory>Fixture memory policy.</hermes_memory>";
    event.systemPromptOptions.sections.local_time = "<local_time>Fixture date.</local_time>";
  });
  pi.on("session_before_compact", () => cancelSummary ? { cancel: true } : undefined);
};
const jwt = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-check" } })).toString("base64")}.signature`;
const credentials = new ai.InMemoryCredentialStore();
await credentials.modify("openai-codex", async () => ({ type: "api_key", key: jwt }));
const model = {
  id: "local-codex-fixture", name: "Fixture", api: "openai-codex-responses", provider: "openai-codex",
  baseUrl: "https://offline-check.invalid/backend-api", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 1000,
  compat: { supportsMidConvoSystemMessages: true },
};
const resourceLoader = new sdk.DefaultResourceLoader({
  cwd: agentDir, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [probe],
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, []);
const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
const { id, name, api, baseUrl, reasoning, input, cost, contextWindow, maxTokens, compat } = model;
modelRuntime.registerProvider(model.provider, { baseUrl, apiKey: jwt, api, models: [{ id, name, api, reasoning, input, cost, contextWindow, maxTokens, compat }] });
const { session } = await sdk.createAgentSession({
  cwd: agentDir, agentDir, model, thinkingLevel: "off", resourceLoader, modelRuntime, tools: ["probe"],
  sessionManager: sdk.SessionManager.inMemory(),
  settingsManager: sdk.SettingsManager.inMemory({ transport: "auto", retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } }),
});
const extensionErrors = [];
await session.bindExtensions({ onError: (error) => extensionErrors.push(String(error?.error ?? error)) });
session.setActiveToolsByName(["probe"]);
try {
  await session.prompt("first");
  await session.sendCustomMessage({ customType: "subagent-completion", content: "background task finished", display: true },
    { deliverAs: "followUp", triggerTurn: true });
  await session.prompt("second");
  assert.deepEqual(triggers, ["prompt", "custom", "prompt"]);
  assert.equal(toolCalls, 1);
  assert.equal(frames.length, 4);
  assert.equal(new Set(frames.map((frame) => frame.instructions)).size, 1);
  assert.deepEqual(frames.map((frame) => Boolean(frame.previous_response_id)), [false, true, true, true]);
  assert.equal(frames[0].client_metadata.turn_id, frames[1].client_metadata.turn_id);
  assert.equal(frames[1].client_metadata["x-codex-turn-state"], `fixture-state-${frames[0].client_metadata.turn_id}`);
  let text = "";
  for (const frame of frames) {
    if (!frame.previous_response_id) text = frame.instructions;
    for (const item of frame.input ?? []) if (item.role === "developer") text += JSON.stringify(item.content);
    assert.ok(text.includes("<hermes_memory>") && text.includes("<local_time>"));
  }
  assert.equal(session.messages.filter((message) => message.role === "system" &&
    Object.values(message.sections ?? {}).some((value) => value === null)).length, 0);
  assert.equal(new Set(frames.map((frame) => frame.client_metadata.turn_id)).size, 3);
  for (const frame of [frames[0], frames[2], frames[3]]) assert.equal(frame.client_metadata["x-codex-turn-state"], undefined, "previous turn state leaked");

  failSummary = values.compaction === "failure";
  cancelSummary = values.compaction === "cancel";
  if (values.compaction === "success") await session.compact();
  else await assert.rejects(session.compact(), values.compaction === "cancel" ? /cancel/i : /fixture summary failure/);
  failSummary = false;
  const summaries = frames.filter((frame) => JSON.parse(frame.client_metadata["x-codex-turn-metadata"]).request_kind === "compaction");
  for (const frame of frames) assert.equal(frame.client_metadata["x-codex-window-id"], `${session.sessionId}:0`);
  if (values.compaction === "success") {
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].client_metadata.turn_id, summaries[1].client_metadata.turn_id);
    assert.equal(summaries[1].client_metadata["x-codex-turn-state"], `fixture-state-${summaries[0].client_metadata.turn_id}`);
  }
  await session.prompt("after compaction attempt");
  assert.equal(frames.at(-1).client_metadata["x-codex-window-id"], `${session.sessionId}:${values.compaction === "success" ? 1 : 0}`);
  assert.deepEqual(extensionErrors, []);
  assert.equal(fetches, 0);
  console.log(JSON.stringify({ pass: true, runtime: values.bundle ? "bundle" : "sdk", compaction: values.compaction,
    triggers, requests: frames.length, toolCalls, sameTurnStable: true, summaries: summaries.length, namedSectionsStable: true, turnStateReplayed: values.compaction === "success", networkRequests: fetches }));
} finally {
  await session.abort();
  session.dispose();
  // The bundled host has its own provider instance; disposing the session releases its socket.
  ai.cleanupSessionResources();
  globalThis.WebSocket = originalSocket;
  globalThis.fetch = originalFetch;
}
