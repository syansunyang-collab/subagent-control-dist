/**
 * Wiring checks against the built bundle (`dist/index.js`) with a fake Pi runtime that keeps the
 * session file and the running agent's message list apart, as Pi does: messages the agent
 * produces go to both, `sessionManager.appendCustomMessageEntry` writes the session only,
 * `pi.sendMessage` writes both, and the `context` hook receives the agent's list. Pi rebuilds
 * that list from the session only on reload and on compaction; the harness does both with Pi's own
 * `buildContextEntries`. `npm test` builds the bundle first (`pretest`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mirrored from src/types.ts, which cannot be imported here: it pulls in value imports written
// with `.js` specifiers that node's type stripping does not resolve to `.ts`.
const CUSTOM_TYPE_SUMMARY = "context-prune-summary";
const CUSTOM_TYPE_INDEX = "context-prune-index";

// config.ts resolves its settings path from the home directory at module load, so redirect the
// home directory before importing the bundle. Nothing under the real ~/.pi is read or written.
const fakeHome = mkdtempSync(join(tmpdir(), "pcp-live-"));
const settingsDir = join(fakeHome, ".pi", "agent", "context-prune");
mkdirSync(settingsDir, { recursive: true });
const writeSettings = (pruneOn: string) =>
  writeFileSync(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      enabled: true,
      pruneOn,
      batchingMode: "agent-message",
      showStartupNotice: false,
      showPruneStatusLine: true,
    }),
  );
writeSettings("agent-message");
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

// @ts-expect-error the bundle ships no declaration file; its shape is asserted below.
const extension = (await import("../dist/index.js")).default as (pi: any) => void;
const { buildContextEntries, sessionEntryToContextMessages } = await import("@earendil-works/pi-coding-agent");

// ── fake Pi runtime ────────────────────────────────────────────────────────

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeHarness() {
  const branch: any[] = []; // session file
  const agent: any[] = []; // the running agent's message list
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const notifications: string[] = [];
  let clock = Date.parse("2026-09-19T00:00:00Z");
  const tick = () => (clock += 1000);

  // Session entries are chained by id/parentId so Pi's buildContextEntries can walk the path.
  let lastId: string | null = null;
  const append = (entry: any) => {
    const id = `e${branch.length}`;
    branch.push({ ...entry, id, parentId: lastId });
    lastId = id;
    return id;
  };
  const rebuild = () => {
    agent.length = 0;
    agent.push(...buildContextEntries(branch).flatMap(sessionEntryToContextMessages));
  };

  // What Pi does at message_end for a message the agent produced.
  const record = (message: any) => {
    message.timestamp = tick();
    agent.push(message);
    append({ type: "message", message, timestamp: new Date(message.timestamp).toISOString() });
  };

  const stream = () => {
    const partial = { content: [{ type: "text", text: "- did a thing" }] };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "text_end", partial };
      },
      async result() {
        return { content: partial.content, usage, stopReason: "stop" };
      },
    };
  };

  const pi = {
    on(name: string, handler: any) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerTool() {},
    getActiveTools: () => [] as string[],
    setActiveTools() {},
    appendEntry(customType: string, data: unknown) {
      return append({ type: "custom", customType, data });
    },
    // Pi's own custom-message path writes the agent's list and the session.
    sendMessage(message: any) {
      const timestamp = tick();
      agent.push({ role: "custom", ...message, timestamp });
      append({ type: "custom_message", ...message, timestamp: new Date(timestamp).toISOString() });
    },
  };

  const ctx = {
    signal: new AbortController().signal,
    model: { provider: "fake", id: "model" },
    modelRegistry: {
      find: () => ctx.model,
      getAvailable: () => [],
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "k", headers: {}, env: {} };
      },
      getProvider: () => ({ stream }),
    },
    sessionManager: {
      getBranch: () => branch,
      buildContextEntries: () => buildContextEntries(branch),
      getSessionId: () => "session",
      appendCustomEntry(customType: string, data: unknown) {
        return append({ type: "custom", customType, data });
      },
      // The session only: the running agent's list is not touched.
      appendCustomMessageEntry(customType: string, content: string, display: boolean, details: unknown) {
        return append({ type: "custom_message", customType, content, display, details, timestamp: new Date(tick()).toISOString() });
      },
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus() {},
      setWidget() {},
    },
  };

  extension(pi as any);

  let runTurnIndex = 0;
  return {
    branch,
    agent,
    notifications,
    async sessionStart() {
      await handlers.get("session_start")!({}, ctx);
    },
    /** A new user prompt: Pi restarts `event.turnIndex` at 0 for every agent run. */
    prompt(text: string) {
      record({ role: "user", content: [{ type: "text", text }] });
      runTurnIndex = 0;
    },
    /** One assistant turn with one tool call per id. */
    async turn(ids: string[]) {
      const message = {
        role: "assistant",
        content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: id } })),
        stopReason: "toolUse",
      };
      record(message);
      const toolResults = ids.map((id) => ({
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text: `${id}:${"x".repeat(800)}` }],
        isError: false,
      }));
      for (const result of toolResults) record(result);
      await handlers.get("turn_end")!({ message, toolResults, turnIndex: runTurnIndex++ }, ctx);
    },
    /** A final text-only reply: the agent-message trigger. Pi persists it after the extension hooks ran. */
    async finalReply(text = "done") {
      const message: any = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: tick() };
      agent.push(message);
      await handlers.get("message_end")!({ message }, ctx);
      append({ type: "message", message, timestamp: new Date(message.timestamp).toISOString() });
    },
    /**
     * An assistant message that says something and may also call tools — Pi streams both in one
     * message. Like `finalReply`, Pi fires message_end before persisting the message, and the tools
     * it announces have not run yet, so they have no result in the session at that point.
     */
    async progressReply(text: string, ids: string[] = []) {
      const message: any = {
        role: "assistant",
        content: [
          { type: "text", text },
          ...ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: id } })),
        ],
        stopReason: ids.length > 0 ? "toolUse" : "stop",
        timestamp: tick(),
      };
      agent.push(message);
      await handlers.get("message_end")!({ message }, ctx);
      append({ type: "message", message, timestamp: new Date(message.timestamp).toISOString() });
      return message;
    },
    /**
     * An assistant message reaching message_end. Pi fires the hook before persisting the message;
     * `persistFirst: true` pins the capture guard for a host that persisted it already.
     */
    async assistantMessage(message: any, persistFirst = false) {
      message.timestamp = tick();
      agent.push(message);
      if (persistFirst) append({ type: "message", message, timestamp: new Date(message.timestamp).toISOString() });
      await handlers.get("message_end")!({ message }, ctx);
      if (!persistFirst) append({ type: "message", message, timestamp: new Date(message.timestamp).toISOString() });
    },
    /** The tool results for calls announced by an earlier assistant message. */
    toolResults(ids: string[]) {
      const results = ids.map((id) => ({
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text: `${id}:${"x".repeat(800)}` }],
        isError: false,
      }));
      for (const result of results) record(result);
      return results;
    },
    /** turn_end for an assistant message whose results are already recorded. */
    async turnEnd(message: any, toolResults: any[]) {
      await handlers.get("turn_end")!({ message, toolResults, turnIndex: runTurnIndex++ }, ctx);
    },
    async checkpoint() {
      await handlers.get("tool_execution_end")!({ toolName: "context_checkpoint" }, ctx);
    },
    /** One LLM request: the message list the model receives. Pi deep-clones the list first. */
    async request() {
      const messages = structuredClone(agent);
      const out = await handlers.get("context")!({ messages }, ctx);
      return (out?.messages ?? messages) as any[];
    },
    append,
    /** What Pi rebuilds from the session file on reload. */
    reload: rebuild,
    /** A native compaction that keeps nothing before it; the run continues from the rebuilt list. */
    compact() {
      append({ type: "compaction", summary: "earlier work", firstKeptEntryId: "", tokensBefore: 0, timestamp: new Date(tick()).toISOString() });
      rebuild();
    },
    indexedIds: () =>
      branch
        .filter((e) => e.type === "custom" && e.customType === CUSTOM_TYPE_INDEX)
        .flatMap((e: any) => e.data.toolCalls.map((tc: any) => tc.toolCallId)),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const summariesIn = (messages: any[]) =>
  messages.filter((m) => m.role === "custom" && m.customType === CUSTOM_TYPE_SUMMARY);
const isStub = (m: any) => m.role === "toolResult" && m.content[0].text.startsWith("[pi-context-prune]");

async function prunedFirstPrompt() {
  writeSettings("agent-message");
  const h = makeHarness();
  await h.sessionStart();
  h.prompt("read two files");
  await h.turn(["a0"]);
  await h.turn(["a1"]);
  await h.finalReply();
  await settle();
  return h;
}

// ── tests ──────────────────────────────────────────────────────────────────

for (const mode of ["agent-message", "every-turn"]) {
  test(`${mode}: reading skills and images does not queue or replace them`, async () => {
    writeSettings(mode);
    const h = makeHarness();
    await h.sessionStart();
    h.prompt("follow the skill and inspect an image");
    await h.turn(["/skills/example/SKILL.md", "/skills/example/references/steps.md"]);
    await h.assistantMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "image", name: "read", arguments: { path: "/image.png" } }],
      stopReason: "toolUse",
    });
    const results = h.toolResults(["image"]);
    results[0].content.push({ type: "image", data: "aGVsbG8=", mimeType: "image/png" } as any);
    const originals = structuredClone(h.agent.filter((m) => m.role === "toolResult"));
    // The normal turn_end hook must not queue the image either.
    const assistant = h.agent.findLast((m) => m.role === "assistant");
    await h.turnEnd(assistant, results);
    await h.progressReply("the instructions and image are loaded; continue", ["next"]);
    await settle();
    assert.deepEqual(h.indexedIds(), []);
    assert.equal(h.notifications.some((n) => n.includes("turn queued")), false);
    assert.deepEqual((await h.request()).filter((m) => m.role === "toolResult"), originals);
  });
}

test("a mixed batch still prunes ordinary text and preserves custom skill resources from earlier turns", async () => {
  writeSettings("agent-message");
  const h = makeHarness();
  await h.sessionStart();
  h.prompt("use a custom skill and read ordinary source");
  await h.turn(["/packages/custom-example/SKILL.md"]);
  await h.progressReply("skill loaded");
  await h.turn(["/packages/custom-example/references/steps.md", "/source.ts"]);
  await h.progressReply("continue using the reference");
  await settle();
  assert.deepEqual(h.indexedIds(), ["/source.ts"]);
  assert.deepEqual((await h.request()).filter(isStub).map((m) => m.toolCallId), ["/source.ts"]);
});

test("reload restores originals for legacy indexed skill, reference and image results", async () => {
  writeSettings("agent-message");
  const h = makeHarness();
  await h.sessionStart();
  h.prompt("legacy session");
  const paths = ["/custom-example/SKILL.md", "/custom-example/references/steps.md", "/image.png", "/source.ts"];
  await h.turn(paths);
  const originals = h.agent.filter((m) => m.role === "toolResult");
  originals[2].content.push({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  h.append({
    type: "custom", customType: CUSTOM_TYPE_INDEX,
    data: { toolCalls: paths.map((path, i) => ({
      toolCallId: path, toolName: "read", args: { path }, resultText: originals[i].content[0].text,
      isError: false, turnIndex: 0, timestamp: 0,
    })) },
  });
  h.append({
    type: "custom_message", customType: CUSTOM_TYPE_SUMMARY, content: "legacy summary", display: false,
    details: { toolCallIds: paths }, timestamp: new Date(0).toISOString(),
  });
  h.reload();
  await h.sessionStart();
  const results = (await h.request()).filter((m) => m.role === "toolResult");
  assert.deepEqual(results.slice(0, 3), originals.slice(0, 3));
  assert.equal(isStub(results[3]), true);
  assert.equal(summariesIn(await h.request()).length, 1, "legacy summaries remain readable");
  await h.progressReply("continue after reload");
  assert.equal(h.indexedIds().length, paths.length, "protected legacy records must not be reindexed");
});

test.after(() => rmSync(fakeHome, { recursive: true, force: true }));

test("a summary written to the session reaches the running agent's next request", async () => {
  const h = await prunedFirstPrompt();
  assert.equal(summariesIn(h.agent).length, 0, "precondition: the flush wrote the session only");

  h.prompt("next task");
  const messages = await h.request();
  assert.deepEqual(messages.filter(isStub).map((m) => m.toolCallId), ["a0", "a1"]);

  const summaries = summariesIn(messages);
  assert.equal(summaries.length, 1, "the model must receive the summary its stubs point at");
  // Placed where the session has it, so a list that Pi rebuilds from the session matches.
  h.reload();
  assert.deepEqual(await h.request(), messages, "same position as in the list rebuilt from the session");
});

test("the added summary stays at the same place on later requests", async () => {
  const h = await prunedFirstPrompt();
  h.prompt("next task");
  const first = await h.request();
  await h.turn(["b0"]);
  const second = await h.request();
  assert.deepEqual(second.slice(0, first.length), first, "earlier messages must not move between requests");
});

test("a summary already in the agent's list is not added again", async () => {
  const h = await prunedFirstPrompt();
  h.reload();
  await h.sessionStart();
  h.prompt("next task");
  assert.equal(summariesIn(await h.request()).length, 1);
});

test("a summary with array content already in the list is not added again", async () => {
  writeSettings("agent-message");
  const h = makeHarness();
  await h.sessionStart();
  h.prompt("task");
  await h.turn(["z0"]);
  // appendCustomMessageEntry also accepts TextContent[]; the list the hook sees is a deep clone.
  h.append({
    type: "custom",
    customType: CUSTOM_TYPE_INDEX,
    data: { toolCalls: [{ toolCallId: "z0", toolName: "read", args: {}, resultText: "z0", isError: false, turnIndex: 0, timestamp: 0 }] },
  });
  h.append({
    type: "custom_message",
    customType: CUSTOM_TYPE_SUMMARY,
    content: [{ type: "text", text: "saved summary" }],
    display: false,
    details: { toolCallIds: ["z0"] },
    timestamp: new Date(0).toISOString(),
  });
  h.reload();
  await h.sessionStart();
  assert.equal(summariesIn(await h.request()).length, 1);
});

test("results a native compaction folded away are not summarized", async () => {
  writeSettings("agent-message");
  const h = makeHarness();
  await h.sessionStart();
  h.prompt("long task");
  await h.turn(["old"]);
  h.compact(); // Pi's compaction summary now stands in for "old"
  await h.turn(["new"]);
  await h.finalReply();
  await settle();
  assert.deepEqual(h.indexedIds(), ["new"], "only results the model still receives are worth a summary");
});

test("a runtime-delivered summary is not duplicated", async () => {
  writeSettings("on-context-tag");
  const h = makeHarness();
  await h.sessionStart();
  h.prompt("task");
  await h.turn(["c0"]);
  await h.checkpoint();
  await settle();
  assert.deepEqual(h.indexedIds(), ["c0"]);
  assert.equal(summariesIn(await h.request()).length, 1);
});

test("the first turn of a later prompt is queued in agent-message mode", async () => {
  writeSettings("agent-message");
  const h = makeHarness();
  await h.sessionStart();
  h.prompt("first");
  await h.turn(["a0"]);
  await h.turn(["a1"]);
  await h.turn(["a2"]);
  await h.finalReply();
  await settle();
  h.notifications.length = 0;

  h.prompt("second");
  await h.turn(["b0"]);
  assert.ok(
    h.notifications.some((n) => n.startsWith("pruner: 1 turn queued")),
    `expected a queue notice, got ${JSON.stringify(h.notifications)}`,
  );
});

test("every-turn mode prunes the turns of a later prompt", async () => {
  writeSettings("every-turn");
  const h = makeHarness();
  await h.sessionStart();
  h.prompt("first");
  await h.turn(["a0"]);
  await h.turn(["a1"]);
  await h.turn(["a2"]);
  await settle();
  assert.deepEqual(h.indexedIds(), ["a0", "a1", "a2"]);

  h.prompt("second");
  await h.turn(["b0"]);
  await settle();
  assert.ok(h.indexedIds().includes("b0"), "b0 must be summarized at its own turn_end");
});

test("a mixed text + tool-call reply flushes the finished batch and leaves the in-flight call out", async () => {
  writeSettings("agent-message");
  const h = makeHarness();
  await h.sessionStart();
  h.prompt("read two files, then keep going");
  await h.turn(["a0"]);
  await h.turn(["a1"]);

  // Pi streams the prose and the next tool call in one message; message_end for it fires before
  // the message is persisted and before that call has a result.
  const mixed = await h.progressReply("a0 and a1 are read; now reading a2", ["a2"]);
  await settle();

  assert.deepEqual(h.indexedIds(), ["a0", "a1"], "only the finished batch may be summarized");
  const messages = await h.request();
  assert.deepEqual(messages.filter(isStub).map((m) => m.toolCallId), ["a0", "a1"]);
  assert.equal(summariesIn(messages).length, 1, "the mixed reply is the agent-message trigger");

  // The announced tool finishes later: its result is summarized at the next trigger, not earlier.
  const results = h.toolResults(["a2"]);
  await h.turnEnd(mixed, results);
  await h.finalReply();
  await settle();
  assert.deepEqual(h.indexedIds(), ["a0", "a1", "a2"]);
});

test("messages without non-empty text and failed stops do not trigger", async () => {
  writeSettings("agent-message");
  const h = makeHarness();
  await h.sessionStart();
  h.prompt("work");
  await h.turn(["a0"]);

  // None of these is the agent speaking: a pure tool-call step, a thinking-only step, blank text,
  // and the error/abort replies Pi retries.
  await h.assistantMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "b0", name: "read", arguments: { path: "b0" } }],
    stopReason: "toolUse",
  });
  await h.assistantMessage({ role: "assistant", content: [{ type: "thinking", thinking: "considering" }], stopReason: "stop" });
  await h.assistantMessage({ role: "assistant", content: [{ type: "text", text: "   \n" }], stopReason: "stop" });
  await h.assistantMessage({ role: "assistant", content: [{ type: "text", text: "retrying after the error" }], stopReason: "error" });
  await h.assistantMessage({ role: "assistant", content: [{ type: "text", text: "aborted" }], stopReason: "aborted" });
  await h.assistantMessage({
    role: "assistant",
    content: [{ type: "text", text: "starting a read" }, { type: "toolCall", id: "b1", name: "read", arguments: {} }],
    stopReason: "error",
  });
  await settle();
  assert.deepEqual(h.indexedIds(), [], "none of these may summarize the finished batch");

  // A plain text reply still triggers.
  await h.finalReply();
  await settle();
  assert.deepEqual(h.indexedIds(), ["a0"]);
});

test("a mixed reply already persisted when message_end fires still leaves the in-flight call out", async () => {
  writeSettings("agent-message");
  const h = makeHarness();
  await h.sessionStart();
  h.prompt("task");
  await h.turn(["a0"]);

  // The mixed message is on the branch before message_end fires; the call it announces has no
  // result yet and must stay out of the captured range even then.
  await h.assistantMessage(
    {
      role: "assistant",
      content: [
        { type: "text", text: "a0 is read; now reading a1" },
        { type: "toolCall", id: "a1", name: "read", arguments: { path: "a1" } },
      ],
      stopReason: "toolUse",
    },
    true,
  );
  await settle();
  assert.deepEqual(h.indexedIds(), ["a0"], "a call without a result must stay out of the captured range");
});
