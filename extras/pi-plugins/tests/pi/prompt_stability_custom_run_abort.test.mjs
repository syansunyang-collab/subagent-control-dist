import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = process.env.PI_0991_TEST_ROOT;
for (const bundled of [false, true]) {
  test(`custom preparation abort settles without a provider request (${bundled ? "bundle" : "SDK"})`, {
    skip: !root && "Set PI_0991_TEST_ROOT to the isolated patched npm candidate",
    timeout: 15000,
  }, async () => {
    const agentDir = resolve("test-results/pi-0991-upgrade/host", bundled ? "abort-bundle" : "abort-sdk");
    mkdirSync(agentDir, { recursive: true });
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error("External network forbidden in host regression"); };
    let session;
    let ai;
    let release;
    try {
      const sdk = await import(pathToFileURL(join(resolve(root), bundled ? "dist/bundle/index.js" : "dist/index.js")));
      ai = await import(pathToFileURL(join(resolve(root), "node_modules/@earendil-works/pi-ai/dist/index.js")));
      let entered;
      const gate = new Promise((accept) => { release = accept; });
      const preparing = new Promise((accept) => { entered = accept; });
      let settled = 0;
      const loader = new sdk.DefaultResourceLoader({
        cwd: agentDir, agentDir, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [(pi) => {
          pi.on("before_agent_start", async () => { entered(); await gate; });
          pi.on("agent_settled", () => { settled++; });
        }],
      });
      await loader.reload();
      const runtime = await sdk.ModelRuntime.create({
        credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false,
      });
      const model = {
        id: "offline", name: "Offline", api: "openai-responses", provider: "fixture",
        baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1000,
      };
      runtime.registerProvider("fixture", { api: model.api, baseUrl: model.baseUrl, apiKey: "fixture", models: [model] });
      ({ session } = await sdk.createAgentSession({
        cwd: agentDir, agentDir, model, modelRuntime: runtime, resourceLoader: loader, tools: [],
        sessionManager: sdk.SessionManager.inMemory(),
        settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
      }));
      await session.bindExtensions({ onError: (error) => { throw new Error(String(error)); } });
      let calls = 0;
      session.agent.streamFunction = () => {
        calls++;
        const message = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "offline" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        const stream = new ai.EventStream((event) => event.type === "done", (event) => event.message);
        queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
        return stream;
      };
      const notice = { customType: "completion", content: "wake", display: true };
      const turn = session.sendCustomMessage(notice, { triggerTurn: true });
      await preparing;
      assert.equal(session.isStreaming, true);
      await session.sendCustomMessage({ ...notice, content: "queued display" }, { triggerTurn: false });
      const idle = session.waitForIdle();
      const abort = session.abort();
      release();
      await Promise.all([turn, abort, idle]);
      assert.equal(calls, 0, "preparation cancellation must prevent provider startup");
      assert.equal(session.isIdle, true);
      assert.equal(settled, 1);
      assert.ok(session.messages.some((message) => message.content === "queued display"));
      // A cancelled run must not poison the next custom run's abort state.
      await session.sendCustomMessage(notice, { triggerTurn: true });
      await session.waitForIdle();
      assert.equal(calls, 1);
      assert.equal(settled, 2);
      console.log(JSON.stringify({ runtime: bundled ? "bundle" : "sdk", providerCallsAfterAbort: 0,
        subsequentProviderCalls: calls, settled, idleWaitResolved: true }));
    } finally {
      release?.();
      if (session) { await session.abort(); session.dispose(); }
      ai?.cleanupSessionResources();
      globalThis.fetch = originalFetch;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
}
