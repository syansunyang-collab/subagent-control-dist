import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareTrial } from "../../tools/pi-antigravity/prepare-pi-tool-trial.mjs";

const source = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@tian.zuo", "pi-antigravity");
const piRoot = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@earendil-works", "pi-coding-agent");
const localOnly = { timeout: 20_000, skip: !existsSync(path.join(source, "index.ts")) || !existsSync(path.join(piRoot, "package.json")) };

async function loadCandidate(t, relative) {
  const tempRoot = path.resolve("tmp");
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, "agy-cancel-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "package");
  prepareTrial(source, target);
  const require = createRequire(path.join(piRoot, "package.json"));
  const { createJiti } = require("jiti");
  return createJiti(import.meta.url, { moduleCache: false, fsCache: false }).import(path.join(target, relative));
}

function toolCall(url, id) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "pi__bash", arguments: { command: "echo test" } } }),
  }).then((response) => response.json());
}

const tool = { name: "bash", description: "", parameters: { type: "object" } };

test("cancel settles every pending MCP call and leaves the bridge reusable", localOnly, async (t) => {
  const { AgyPiBridge } = await loadCandidate(t, "lib/bridge.ts");
  const calls = [];
  let received;
  let resumed;
  const arrival = new Promise((resolve) => { received = resolve; });
  const resumeArrival = new Promise((resolve) => { resumed = resolve; });
  const bridge = new AgyPiBridge();
  bridge.setOnCall((call) => {
    calls.push(call);
    if (calls.length === 2) received();
    if (calls.length === 3) resumed();
    return true;
  });
  await bridge.start();
  t.after(() => bridge.close());
  bridge.setToolSource(() => [tool]);
  bridge.refreshTools();
  const url = bridge.url;
  const replies = [toolCall(url, 1), toolCall(url, 2)];
  await arrival;
  assert.equal(bridge.pendingCount, 2);
  bridge.cancelPending("cancelled by Pi");
  assert.equal(bridge.pendingCount, 0);
  for (const call of calls) {
    assert.equal(bridge.isAwaiting(call.id), false);
    assert.equal(bridge.resolveCall(call.id, { content: "late result", isError: false }), false);
  }
  for (const reply of await Promise.all(replies)) {
    assert.equal(reply.result.isError, true);
    assert.deepEqual(reply.result.content, [{ type: "text", text: "cancelled by Pi" }]);
  }
  assert.equal(bridge.running, true);
  assert.equal(bridge.url, url);
  const next = toolCall(url, 3);
  await resumeArrival;
  assert.equal(bridge.resolveCall(calls[2].id, { content: "resumed", isError: false }), true);
  assert.deepEqual((await next).result.content, [{ type: "text", text: "resumed" }]);
  assert.equal(bridge.pendingCount, 0);
});

test("abort invalidates the current native turn without resetting its conversation", localOnly, async (t) => {
  const { AntigravityRuntime, createAntigravityRuntime, runAntigravity } = await loadCandidate(t, "src/runtime.ts");
  const requests = [];
  const closed = [];
  const runtime = createAntigravityRuntime({
    run(request) {
      requests.push(request);
      return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    },
    async close(reason) { closed.push(reason); },
    snapshot: () => ({ mode: "one-shot", state: "idle", lifecycle: [] }),
  });
  const service = await runtime.runPromise(AntigravityRuntime);
  t.after(async () => { await runAntigravity(runtime, service.close); await runtime.dispose(); });
  const cwd = path.resolve("tmp");
  await runAntigravity(runtime, service.restoreConversation({ conversationId: "kept-conversation", modelId: "test-model", cwd, turns: 2, usage: { inputTokens: 17 } }));
  const original = await runAntigravity(runtime, service.beginStreamTurn({ prompt: "first", modelId: "test-model" }));
  assert.equal(requests.length, 1);
  assert.equal(service.pushBridgeCall({ id: "pending", tool: "bash", args: {} }), true);
  closed.length = 0;
  await runAntigravity(runtime, service.abortTurn);
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(closed, ["abort"]);
  assert.equal(service.pushBridgeCall({ id: "late", tool: "bash", args: {} }), false);
  const state = await runAntigravity(runtime, service.snapshot);
  assert.equal(state.conversationId, "kept-conversation");
  assert.equal(state.turns, 2);
  assert.deepEqual(state.conversationUsage, { inputTokens: 17 });
  const resumed = await runAntigravity(runtime, service.beginStreamTurn({ prompt: "next", modelId: "test-model" }));
  assert.notEqual(resumed, original);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].conversationId, "kept-conversation");
  assert.equal(requests[1].signal.aborted, false);
});
