// Real npm SDK or bundled provider transport contract, using offline WS/SSE fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

if (!process.env.PI_0991_TEST_ROOT) {
  test("installed 0.99.1 WS runtime", { skip: "Set PI_0991_TEST_ROOT to the isolated npm candidate" }, () => {});
} else {
  const root = resolve(process.env.PI_0991_TEST_ROOT);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"))).version, "0.99.1");
  const ai = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-ai/dist/index.js")));
  const manifest = JSON.parse(readFileSync("tools/pi-codex-attribution/manifest-0.99.1.json"));
  const bundleProvider = manifest.files.find((e) => e.path.startsWith("dist/bundle/chunks/openai-codex-responses-") && e.before === null).path;
  const provider = await import(pathToFileURL(join(root, process.env.PI_0991_WS_BUNDLE ? bundleProvider : "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js")));
  const model = { id: "fixture", name: "Fixture", api: "openai-codex-responses", provider: "openai-codex",
    baseUrl: "https://fixture.invalid/backend-api", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
  const jwt = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64")}.s`;

  function events() {
    const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] };
    return [
      { type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", part: { type: "output_text", text: "" } },
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { id: "resp_fixture", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
  }

  test("WS failure uses SSE, cooldown recovers, and 1009 waits for a smaller request", async () => {
    const original = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, now: Date.now };
    let now = Date.now();
    let mode = "transport";
    let sockets = 0;
    let sse = 0;
    class Socket {
      readyState = 1;
      listeners = new Map();
      constructor() { sockets++; queueMicrotask(() => this.emit("open", {})); }
      addEventListener(t, f) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(f); }
      removeEventListener(t, f) { this.listeners.get(t)?.delete(f); }
      emit(t, e) { for (const fn of this.listeners.get(t) ?? []) fn(e); }
      close() { this.readyState = 3; this.emit("close", { code: 1000 }); }
      send() { queueMicrotask(() => {
        if (mode !== "success") { this.readyState = 3; this.emit("close", { code: mode === "1009" ? 1009 : 1006 }); }
        else for (const e of events()) this.emit("message", { data: JSON.stringify(e) });
      }); }
    }
    globalThis.WebSocket = Socket;
    globalThis.fetch = async () => { sse++; return new Response(events().map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }); };
    Date.now = () => now;
    const request = async (sessionId, size = 1) => {
      const result = await provider.stream(model, ai.normalizeContext({ messages: [{ role: "user", content: "x".repeat(size), timestamp: 1 }] }),
        { apiKey: jwt, sessionId, transport: "auto", maxRetries: 0, env: {} }).result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
    };
    try {
      await request("recover");
      assert.equal(sockets, 1); assert.equal(sse, 1);
      await request("recover");
      assert.equal(sockets, 1); assert.equal(sse, 2);
      now += 30000; mode = "success";
      await request("recover");
      assert.equal(sockets, 2); assert.equal(sse, 2);
      assert.equal(provider.getOpenAICodexWebSocketDebugStats("recover").websocketRecoveries, 1);
      mode = "1009";
      await request("oversize", 10000);
      assert.equal(sockets, 3); assert.equal(sse, 3);
      now += 1000000; mode = "success";
      await request("oversize", 10000);
      assert.equal(sockets, 3); assert.equal(sse, 4);
      await request("oversize", 1000);
      assert.equal(sockets, 4); assert.equal(sse, 4);
      assert.equal(provider.getOpenAICodexWebSocketDebugStats("oversize").oversizeFallbacks, 1);
      assert.equal(provider.getOpenAICodexWebSocketDebugStats("oversize").websocketFallbackActive, false);
      console.log(JSON.stringify({ runtime: process.env.PI_0991_WS_BUNDLE ? "bundle" : "sdk", sockets, sse, externalNetworkRequests: 0 }));
    } finally {
      provider.closeOpenAICodexWebSocketSessions();
      provider.resetOpenAICodexWebSocketDebugStats();
      ai.cleanupSessionResources();
      globalThis.WebSocket = original.WebSocket; globalThis.fetch = original.fetch; Date.now = original.now;
    }
  });
}
