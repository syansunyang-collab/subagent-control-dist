import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { values } = parseArgs({ options: { root: { type: "string" }, "agent-dir": { type: "string" } } });
const root = values.root ? resolve(values.root) : join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent");
if (values["agent-dir"]) process.env.PI_CODING_AGENT_DIR = resolve(values["agent-dir"]);
const { Agent } = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-agent-core/dist/agent.js")));
const { EventStream } = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-ai/dist/index.js")));
const model = { id: "local-mock", name: "Mock", api: "openai-responses", provider: "openai", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
const identities = [];
let toolCalls = 0;
const agent = new Agent({
  sessionId: "attribution-install-verification",
  initialState: { model, tools: [{ name: "probe", label: "probe", description: "Local check", parameters: { type: "object", properties: {} }, execute: async () => { toolCalls++; return { content: [{ type: "text", text: "ok" }], details: {} }; } }] },
  streamFn: (_model, _context, options) => {
    identities.push(options.requestIdentity);
    const first = identities.length === 1;
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: first ? "toolUse" : "stop", content: first ? [{ type: "toolCall", id: "probe-1", name: "probe", arguments: {} }] : [{ type: "text", text: "done" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new EventStream(event => event.type === "done", event => event.message);
    queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));
    return stream;
  },
});
await agent.prompt("first turn");
await agent.prompt("second turn");
assert.equal(toolCalls, 1);
assert.equal(identities.length, 3);
assert.deepEqual(identities[0], identities[1]);
assert.notEqual(identities[1].turnId, identities[2].turnId);
assert.equal(identities[0].threadId, "attribution-install-verification");
console.log(JSON.stringify({ pass: true, requests: identities.length, toolCalls, sameTurnStable: true, nextTurnRotates: true, networkRequests: 0 }));
