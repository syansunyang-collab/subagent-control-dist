/**
 * Wiring tests for the policy-lab entry (`dist/policy-lab.js`).
 *
 * Every test drives the real extension against the fake Pi runtime from
 * `lab-harness.ts`. The summarizer is a fake provider: no test may reach a real
 * model, and `npm test` runs offline.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { makeLabHarness, rawResultsIn, receiptsIn, summariesIn, CUSTOM_TYPES } from "./lab-harness.ts";

const stubOf = (messages: any[], id: string) =>
  messages.find((message) => message?.role === "toolResult" && message.toolCallId === id)?.content?.[0]?.text;
const shortIdOf = (text: string) => /^\[pruned:(.+)\]$/.exec(text ?? "")?.[1] ?? null;
const bigResult = (id: string) => `${id}:${"x".repeat(800)}`;
const eventsOf = (harness: ReturnType<typeof makeLabHarness>, event: string, phase?: string) =>
  harness.labEvents().filter((entry) => entry.event === event && (phase === undefined || entry.phase === phase));

test("cold-mask releases only old ordinary results and keeps skills, images and recent turns", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 2 });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["skill0"], { args: (id) => ({ path: `skills/${id}/SKILL.md` }) });
    await h.request();
    await h.turn(["img0"], { imageFor: ["img0"] });
    await h.request();
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.turn(["a1"], { resultText: bigResult });
    await h.request();
    await h.turn(["a2"], { resultText: bigResult });
    const messages = await h.request();

    assert.equal(receiptsIn(messages).length, 1, "exactly the old ordinary result is released");
    assert.match(stubOf(messages, "a0"), /^\[pruned:t\d+\]$/);
    assert.equal(stubOf(messages, "a1"), bigResult("a1"), "newest complete turns stay raw");
    assert.equal(stubOf(messages, "a2"), bigResult("a2"), "a result first seen in this request stays raw");
    assert.ok(stubOf(messages, "skill0").includes("skill0:"), "skill results are protected");
    assert.ok(stubOf(messages, "img0").includes("img0:"), "image results are protected");

    assert.deepEqual(h.indexedIds(), ["a0"]);
    const mask = eventsOf(h, "apply", "mask");
    assert.equal(mask.length, 1);
    assert.equal(mask[0].mode, "cold-mask");
    assert.equal(mask[0].pending, false);
    assert.deepEqual(mask[0].candidateToolCallIds, ["a0"]);
    assert.ok(mask[0].rawTokens > mask[0].stubTokens);
    assert.ok(mask[0].netTokens > 0);
  } finally {
    h.cleanup();
  }
});

test("cold-mask keeps a result until the model has seen it in an earlier request", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 0 });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });

    const first = await h.request();
    assert.equal(stubOf(first, "a0"), bigResult("a0"), "first sighting must stay raw");
    assert.equal(receiptsIn(first).length, 0);

    const second = await h.request();
    assert.match(stubOf(second, "a0"), /^\[pruned:t\d+\]$/, "second request may release it");
  } finally {
    h.cleanup();
  }
});

test("cold-mask does not release below the token budget", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100_000, keepRecentToolTurns: 0 });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    const messages = await h.request();
    assert.equal(receiptsIn(messages).length, 0);
    assert.equal(stubOf(messages, "a0"), bigResult("a0"));
    assert.equal(eventsOf(h, "apply", "mask").length, 0);
  } finally {
    h.cleanup();
  }
});

test("cold-mask archives the original snapshot and the read-back tool pages it", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 0 });
  try {
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`);
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["log0"], { resultText: () => lines.join("\n") });
    await h.request();
    const messages = await h.request();

    const shortId = shortIdOf(stubOf(messages, "log0"));
    assert.ok(shortId, "the receipt carries a short ref");

    const first = await h.readBack([shortId!]);
    assert.match(first.text, /Snapshot: lines 1-200 of 500/);
    assert.ok(first.text.includes("line 1"));
    assert.ok(first.text.includes("line 200"));
    assert.equal(first.details[shortId!].nextOffset, 201);
    assert.equal(first.details[shortId!].nextCharOffset, 0);
    assert.equal(first.details[shortId!].totalLines, 500);

    const second = await h.readBack([shortId!], 201, 100);
    assert.match(second.text, /Snapshot: lines 201-300 of 500/);
    assert.ok(second.text.includes("line 201"));
    assert.equal(second.details[shortId!].nextOffset, 301);

    const last = await h.readBack([shortId!], 480, 100);
    assert.match(last.text, /Snapshot: lines 480-500 of 500/);
    assert.equal(last.text.includes("[next:"), false);
    assert.equal(last.details[shortId!].nextOffset, null);

    const unknown = await h.readBack(["t999"]);
    assert.match(unknown.text, /no archived snapshot/);
  } finally {
    h.cleanup();
  }
});

test("cold-mask prepares one stage summary per user turn and injects it when ready", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 0 });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.request();
    await h.agentEnd();

    const prepared = eventsOf(h, "prepare", "stage");
    assert.equal(prepared.length, 1, "one merged stage job for the new releases");
    assert.equal(prepared[0].pending, true);
    assert.deepEqual(prepared[0].candidateToolCallIds, ["a0"]);
    assert.equal(h.summarizerPrompts().length, 1);

    await h.settle();
    assert.equal(eventsOf(h, "idle", "stage").length, 1, "background summarizer reports idle");

    const messages = await h.request();
    assert.match(stubOf(messages, "a0"), /^\[pruned:t\d+\]$/, "the receipt stays");
    assert.equal(summariesIn(messages).length, 1, "the stage summary is injected");
    assert.equal(eventsOf(h, "apply", "stage").length, 1);

    // No new releases in the same user turn: no second stage summary.
    await h.agentEnd();
    await h.settle();
    assert.equal(eventsOf(h, "prepare", "stage").length, 1);
    const after = await h.request();
    assert.equal(summariesIn(after).length, 1);
  } finally {
    h.cleanup();
  }
});

test("cold-mask with stageSummary off releases receipts and never summarizes", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 0, rawConfig: { stageSummary: false } });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    const masked = await h.request();
    assert.match(stubOf(masked, "a0"), /^\[pruned:t\d+\]$/, "released behind a receipt");
    await h.agentEnd();
    await h.settle();
    assert.equal(eventsOf(h, "prepare", "stage").length, 0, "no stage summary job");
    assert.equal(h.summarizerPrompts().length, 0, "the summarizer is never called");
    const after = await h.request();
    assert.equal(summariesIn(after).length, 0, "no summary message in the context");
  } finally {
    h.cleanup();
  }
});

test("a stage summary that is not ready yet leaves the material untouched", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 0, summarizerMode: "deferred" });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.request();
    await h.agentEnd();
    assert.equal(eventsOf(h, "prepare", "stage").length, 1);

    const pending = await h.request();
    assert.equal(summariesIn(pending).length, 0, "no summary before the job is ready");
    assert.match(stubOf(pending, "a0"), /^\[pruned:t\d+\]$/, "the receipt is already there");
    assert.equal(eventsOf(h, "apply", "stage").length, 0);

    h.releaseSummarizer();
    await h.settle();
    const ready = await h.request();
    assert.equal(summariesIn(ready).length, 1);
    assert.equal(eventsOf(h, "apply", "stage").length, 1);
  } finally {
    h.cleanup();
  }
});

test("a net-negative stage summary is skipped and the receipts stay", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 0, summarizerText: "y".repeat(4000) });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.request();
    await h.agentEnd();
    await h.settle();

    const skipped = eventsOf(h, "skip", "stage");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, "net-tokens<=0");
    assert.ok(skipped[0].netTokens <= 0);

    const messages = await h.request();
    assert.equal(summariesIn(messages).length, 0, "the oversized summary is not injected");
    assert.match(stubOf(messages, "a0"), /^\[pruned:t\d+\]$/);
    assert.equal(eventsOf(h, "apply", "stage").length, 0);
  } finally {
    h.cleanup();
  }
});

test("a branch switch invalidates a pending plan and its result is never applied", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 0, summarizerMode: "deferred" });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.request();
    await h.agentEnd();

    await h.sessionTree();
    h.releaseSummarizer();
    await h.settle();

    const skipped = eventsOf(h, "skip", "stage");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, "session-tree");
    const messages = await h.request();
    assert.equal(summariesIn(messages).length, 0);
  } finally {
    h.cleanup();
  }
});

test("reload restores receipts, aliases and the archived snapshot from the branch", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 0 });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    const masked = await h.request();
    const shortId = shortIdOf(stubOf(masked, "a0"))!;
    assert.ok(shortId);

    // Reload rebuilds the agent list from the session, where the raw result still lives.
    h.reload();
    const restored = await h.request();
    assert.equal(stubOf(restored, "a0"), `[pruned:${shortId}]`, "the receipt is re-applied after reload");
    const readBack = await h.readBack([shortId]);
    assert.ok(readBack.text.includes(bigResult("a0")), "the alias still resolves to the archived snapshot");

    // A later summary of the same branch can still resolve the alias.
    await h.agentEnd();
    await h.settle();
    const final = await h.request();
    assert.equal(summariesIn(final).length, 1);
    assert.ok(summariesIn(final)[0].content.includes(shortId));
  } finally {
    h.cleanup();
  }
});

test("legacy production index and summary entries stay released and keep their refs", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100_000, keepRecentToolTurns: 0 });
  try {
    h.prompt("task");
    h.assistantCall(["a0"], { resultText: bigResult });
    h.results(["a0"], { resultText: bigResult });
    h.branch.push({
      type: "custom",
      customType: CUSTOM_TYPES.index,
      data: {
        toolCalls: [
          { toolCallId: "a0", toolName: "read", args: { path: "a0" }, resultText: bigResult("a0"), isError: false, turnIndex: 0, timestamp: 1 },
        ],
      },
    });
    h.branch.push({
      type: "custom_message",
      customType: CUSTOM_TYPES.summary,
      content: "legacy summary\n\nUse context_tree_query with these refs: t9",
      display: false,
      details: { toolCallRefs: [{ shortId: "t9", toolCallId: "a0" }], toolNames: ["read"], turnIndex: 0, timestamp: 1 },
    });
    await h.sessionStart();
    h.reload();

    const messages = await h.request();
    assert.equal(stubOf(messages, "a0"), "[pruned:t9]", "legacy releases keep their short ref");
    const readBack = await h.readBack(["t9"]);
    assert.ok(readBack.text.includes(bigResult("a0")));
    assert.equal(receiptsIn(messages).length, 1);
  } finally {
    h.cleanup();
  }
});

test("budget-summary merges the budgeted candidates into one background batch and applies it once ready", async () => {
  const h = makeLabHarness({ mode: "budget-summary", triggerTokens: 150, keepRecentToolTurns: 2, summarizerMode: "deferred" });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.turn(["a1"], { resultText: bigResult });
    await h.request();
    await h.turn(["a2"], { resultText: bigResult });
    await h.request();
    await h.turn(["a3"], { resultText: bigResult });

    const prepared = eventsOf(h, "prepare", "budget");
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].pending, true);
    assert.deepEqual(prepared[0].candidateToolCallIds, ["a0", "a1"], "one merged batch");
    assert.equal(h.summarizerPrompts().length, 1, "exactly one summarizer call");
    assert.ok(h.summarizerPrompts()[0].includes("a0"));
    assert.ok(h.summarizerPrompts()[0].includes("a1"));

    const pending = await h.request();
    assert.equal(receiptsIn(pending).length, 0, "nothing is released before the summary is ready");
    assert.equal(summariesIn(pending).length, 0);
    assert.equal(stubOf(pending, "a0"), bigResult("a0"));

    h.releaseSummarizer();
    await h.settle();
    assert.equal(eventsOf(h, "idle", "budget").length, 1);

    const applied = await h.request();
    assert.match(stubOf(applied, "a0"), /^\[pruned:t\d+\]$/);
    assert.match(stubOf(applied, "a1"), /^\[pruned:t\d+\]$/);
    assert.equal(stubOf(applied, "a2"), bigResult("a2"), "the newest turns stay raw");
    assert.equal(summariesIn(applied).length, 1);
    const apply = eventsOf(h, "apply", "budget");
    assert.equal(apply.length, 1);
    assert.ok(apply[0].rawTokens > 0);
    assert.ok(apply[0].netTokens > 0);

    // The applied release is idempotent on the next request.
    const again = await h.request();
    assert.equal(receiptsIn(again).length, 2);
    assert.equal(summariesIn(again).length, 1);
    assert.deepEqual(h.indexedIds(), ["a0", "a1"]);
  } finally {
    h.cleanup();
  }
});

// Pi 0.87.1 rebuilds the agent's message list from the session at every turn boundary, so a
// summary written during the apply request reappears at its session position on the next one.
// The apply request must already carry it there, or the next request rewrites the history a
// second time and the provider cache misses again.
for (const rebuilds of [true, false]) {
  test(`budget-summary: the request after an apply extends it unchanged (${rebuilds ? "list rebuilt from the session" : "list kept"})`, async () => {
    const h = makeLabHarness({ mode: "budget-summary", triggerTokens: 150, keepRecentToolTurns: 2 });
    try {
      await h.sessionStart();
      h.prompt("task");
      for (const id of ["a0", "a1", "a2"]) {
        await h.turn([id], { resultText: bigResult });
        await h.request();
      }
      await h.turn(["a3"], { resultText: bigResult });
      await h.settle();

      const applied = await h.request();
      assert.equal(eventsOf(h, "apply", "budget").length, 1);
      assert.equal(summariesIn(applied).length, 1);

      if (rebuilds) h.reload();
      h.setSummarizerMode("deferred"); // keep the next batch pending so only the summary position can differ
      await h.turn(["a4"], { resultText: bigResult });
      const next = await h.request();
      assert.deepEqual(next.slice(0, applied.length), applied, "the apply request is a prefix of the next one");
      assert.equal(summariesIn(next).length, 1);
    } finally {
      h.cleanup();
    }
  });
}

test("budget-summary handles literal special tokens in raw output and summary without losing recall", async () => {
  const marker = "<|endoftext|>";
  const raw = `Source example: ${marker}\n` + "ordinary log output\n".repeat(100);
  const summary = `- source contains the literal ${marker}`;
  const h = makeLabHarness({ mode: "budget-summary", triggerTokens: 100, keepRecentToolTurns: 0, summarizerText: summary });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["marker"], { resultText: () => raw });
    assert.equal(stubOf(await h.request(), "marker"), raw);
    await h.turn(["next"], { resultText: bigResult });
    await h.settle();
    const projected = await h.request();
    const ref = shortIdOf(stubOf(projected, "marker"));
    assert.ok(ref);
    assert.equal(eventsOf(h, "apply", "budget").length, 1);
    assert.equal(eventsOf(h, "failure").length, 0);
    assert.ok(summariesIn(projected)[0].content.includes(summary));
    assert.ok((await h.readBack([ref!])).text.includes(raw));
    assert.equal(h.notifications.length, 0);
  } finally {
    h.cleanup();
  }
});

test("budget-summary keeps the raw text while the summary is not ready and skips negative results", async () => {
  const deferred = makeLabHarness({
    mode: "budget-summary",
    triggerTokens: 100,
    keepRecentToolTurns: 0,
    summarizerMode: "deferred",
    summarizerText: "y".repeat(4000),
  });
  try {
    await deferred.sessionStart();
    deferred.prompt("task");
    await deferred.turn(["a0"], { resultText: bigResult });
    await deferred.request();
    await deferred.turn(["a1"], { resultText: bigResult });
    assert.equal(eventsOf(deferred, "prepare", "budget").length, 1);

    const pending = await deferred.request();
    assert.equal(stubOf(pending, "a0"), bigResult("a0"), "raw text stays while the job is pending");
    assert.equal(receiptsIn(pending).length, 0);

    deferred.releaseSummarizer();
    await deferred.settle();
    const skipped = eventsOf(deferred, "skip", "budget");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, "net-tokens<=0");

    const afterSkip = await deferred.request();
    assert.equal(receiptsIn(afterSkip).length, 0, "a net-negative summary never replaces the raw text");
    assert.equal(summariesIn(afterSkip).length, 0);
  } finally {
    deferred.cleanup();
  }
});

test("a failed summarizer call is recorded and the next turn can retry", async () => {
  const h = makeLabHarness({ mode: "budget-summary", triggerTokens: 100, keepRecentToolTurns: 0, summarizerMode: "fail" });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.turn(["a1"], { resultText: bigResult });
    await h.settle();

    const failures = eventsOf(h, "failure", "budget");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].pending, false);
    const messages = await h.request();
    assert.equal(receiptsIn(messages).length, 0, "a failed call keeps the raw text");

    h.setSummarizerMode("auto");
    await h.turnEnd();
    assert.equal(eventsOf(h, "prepare", "budget").length, 2, "the same candidates are retried");
    await h.settle();
    const applied = await h.request();
    assert.equal(receiptsIn(applied).length, 1);
  } finally {
    h.cleanup();
  }
});

test("mode routing keeps each policy idle in the other mode", async () => {
  const cold = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 0 });
  const budget = makeLabHarness({ mode: "budget-summary", triggerTokens: 100, keepRecentToolTurns: 0 });
  try {
    await cold.sessionStart();
    cold.prompt("task");
    await cold.turn(["a0"], { resultText: bigResult });
    assert.equal(eventsOf(cold, "prepare").length, 0, "cold-mask never prepares a budget job");
    await cold.agentEnd();
    assert.equal(eventsOf(cold, "prepare").length, 0, "nothing was released, so no stage job either");

    await budget.sessionStart();
    budget.prompt("task");
    await budget.turn(["a0"], { resultText: bigResult });
    assert.equal(eventsOf(budget, "apply", "mask").length, 0, "budget-summary never masks cold results");
  } finally {
    cold.cleanup();
    budget.cleanup();
  }
});

test("the lab registers only the read-back tool and records credential-free lab events", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 0 });
  try {
    await h.sessionStart();
    assert.deepEqual(h.toolNames(), ["context_tree_query"], "no context_prune tool and no guidance tool");
    assert.ok(h.readTool.description.includes("archived output"));
    assert.ok(h.readTool.promptGuidelines.some((line: string) => line.includes("read the file again")), "files are re-read, not restored from the archive");
    assert.ok(h.readTool.description.includes("offset"));
    assert.ok(h.readTool.description.includes("limit"));

    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.request();
    await h.agentEnd();
    await h.settle();

    const events = h.labEvents();
    assert.ok(events.length >= 3);
    for (const entry of events) {
      assert.equal(entry.mode, "cold-mask");
      assert.equal(typeof entry.pending, "boolean");
      assert.ok(Array.isArray(entry.candidateIds));
      assert.ok(Array.isArray(entry.candidateToolCallIds));
      for (const key of ["rawTokens", "stubTokens", "summaryTokens", "netTokens"]) assert.equal(typeof entry[key], "number");
    }
    const start = events[0];
    assert.equal(start.event, "idle");
    assert.equal(start.phase, "session");
    assert.equal(start.config.mode, "cold-mask");
    assert.ok(start.config.path.endsWith("policy-lab.json"));

    const serialized = JSON.stringify(events);
    for (const secret of ["apiKey", "authorization", "sk-"]) assert.equal(serialized.includes(secret), false);
    assert.equal(h.notifications.length, 0);
  } finally {
    h.cleanup();
  }
});

test("shutdown invalidates pending and ready plans in both modes", async () => {
  for (const mode of ["budget-summary", "cold-mask"] as const) {
    for (const ready of [false, true]) {
      const h = makeLabHarness({ mode, triggerTokens: 100, keepRecentToolTurns: 0, summarizerMode: "deferred" });
      try {
        await h.sessionStart();
        h.prompt("task");
        await h.turn(["a0"], { args: () => ({ path: "original.txt", offset: 13 }), resultText: bigResult });
        await h.request();
        await h.turn(["a1"], { resultText: bigResult });
        if (mode === "cold-mask") {
          await h.request();
          await h.agentEnd();
          assert.match((await h.readBack(["t1"])).text, /original\.txt/);
        }
        if (ready) { h.releaseSummarizer(); await h.settle(); }
        await h.sessionShutdown("reload");
        h.releaseSummarizer();
        await h.settle();
        const projected = await h.request();
        assert.equal(summariesIn(projected).length, 0, `${mode}: stale summary must not apply`);
        if (mode === "budget-summary") assert.equal(receiptsIn(projected).length, 0);
      } finally { h.cleanup(); }
    }
  }
});

test("aborting an already-ready budget plan keeps the original results", async () => {
  const h = makeLabHarness({ mode: "budget-summary", triggerTokens: 100, keepRecentToolTurns: 0 });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.turn(["a1"], { resultText: bigResult });
    await h.settle();
    assert.equal(eventsOf(h, "idle", "budget").length, 1);
    h.abort();
    const projected = await h.request();
    assert.equal(receiptsIn(projected).length, 0);
    assert.equal(summariesIn(projected).length, 0);
    assert.ok(eventsOf(h, "skip", "budget").some(e => e.reason === "aborted"));
  } finally { h.cleanup(); }
});

test("the driver can tell from the JSONL whether background summarization is idle", async () => {
  const h = makeLabHarness({ mode: "budget-summary", triggerTokens: 100, keepRecentToolTurns: 0, summarizerMode: "deferred" });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.turn(["a1"], { resultText: bigResult });

    const busy = h.labEvents().at(-1)!;
    assert.equal(busy.event, "prepare");
    assert.equal(busy.pending, true);

    h.releaseSummarizer();
    await h.settle();
    const idle = h.labEvents().at(-1)!;
    assert.equal(idle.pending, false);
    assert.equal(idle.event, "idle");
    assert.ok(idle.netTokens > 0);
  } finally {
    h.cleanup();
  }
});

test("every summarizer API call is accounted with the existing stats entry shape", async () => {
  const applied = makeLabHarness({ mode: "budget-summary", triggerTokens: 100, keepRecentToolTurns: 0 });
  try {
    await applied.sessionStart();
    applied.prompt("task");
    await applied.turn(["a0"], { resultText: bigResult });
    await applied.request();
    await applied.turn(["a1"], { resultText: bigResult });
    await applied.settle();
    await applied.request();

    const stats = applied.statsEntries();
    assert.equal(stats.length, 1);
    assert.equal(stats[0].callCount, 1);
    assert.ok(stats[0].totalInputTokens > 0);
    assert.ok(stats[0].totalOutputTokens > 0);
  } finally {
    applied.cleanup();
  }

  const skipped = makeLabHarness({
    mode: "budget-summary",
    triggerTokens: 100,
    keepRecentToolTurns: 0,
    summarizerText: "y".repeat(4000),
  });
  try {
    await skipped.sessionStart();
    skipped.prompt("task");
    await skipped.turn(["a0"], { resultText: bigResult });
    await skipped.request();
    await skipped.turn(["a1"], { resultText: bigResult });
    await skipped.settle();
    assert.equal(eventsOf(skipped, "skip", "budget").length, 1);
    const stats = skipped.statsEntries();
    assert.equal(stats.length, 1, "a call that is not applied is still accounted");
    assert.equal(stats[0].callCount, 1);
  } finally {
    skipped.cleanup();
  }
});

test("an aborted run and a native compaction both invalidate a pending plan", async () => {
  const aborted = makeLabHarness({ mode: "budget-summary", triggerTokens: 100, keepRecentToolTurns: 0, summarizerMode: "deferred" });
  try {
    await aborted.sessionStart();
    aborted.prompt("task");
    await aborted.turn(["a0"], { resultText: bigResult });
    await aborted.request();
    await aborted.turn(["a1"], { resultText: bigResult });
    assert.equal(eventsOf(aborted, "prepare", "budget").length, 1);

    aborted.abort();
    aborted.releaseSummarizer();
    await aborted.settle();
    const abortedSkip = eventsOf(aborted, "skip", "budget");
    assert.equal(abortedSkip.length, 1);
    assert.equal(abortedSkip[0].reason, "aborted");
    const afterAbort = await aborted.request();
    assert.equal(receiptsIn(afterAbort).length, 0, "an aborted plan never replaces raw text");
  } finally {
    aborted.cleanup();
  }

  const compacted = makeLabHarness({ mode: "budget-summary", triggerTokens: 100, keepRecentToolTurns: 0, summarizerMode: "deferred" });
  try {
    await compacted.sessionStart();
    compacted.prompt("task");
    await compacted.turn(["a0"], { resultText: bigResult });
    await compacted.request();
    await compacted.turn(["a1"], { resultText: bigResult });
    assert.equal(eventsOf(compacted, "prepare", "budget").length, 1);

    await compacted.beforeCompact();
    compacted.releaseSummarizer();
    await compacted.settle();
    const compactSkip = eventsOf(compacted, "skip", "budget");
    assert.equal(compactSkip.length, 1);
    assert.equal(compactSkip[0].reason, "compaction");

    compacted.compact();
    const afterCompact = await compacted.request();
    assert.equal(receiptsIn(afterCompact).length, 0, "a compacted plan never replaces raw text");
    assert.equal(summariesIn(afterCompact).length, 0);
  } finally {
    compacted.cleanup();
  }
});

test("read-back results are never released again", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 0 });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["r0"], { toolName: "context_tree_query", resultText: bigResult });
    await h.request();
    const messages = await h.request();
    assert.equal(stubOf(messages, "r0"), bigResult("r0"), "a read-back result stays raw");
    assert.equal(receiptsIn(messages).length, 0);
    assert.equal(eventsOf(h, "apply", "mask").length, 0);
  } finally {
    h.cleanup();
  }
});

test("raw result helpers used by the other tests behave as expected", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 100, keepRecentToolTurns: 0 });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    const before = await h.request();
    assert.equal(rawResultsIn(before).length, 1);
    await h.request();
    const after = await h.request();
    assert.equal(rawResultsIn(after).length, 0);
    assert.equal(receiptsIn(after).length, 1);
  } finally {
    h.cleanup();
  }
});

const SOL = { provider: "openai-codex", id: "gpt-5.6-sol-500k" };

test("budget-summary price line archives every old result at once near the model's price tier, then summarizes them", async () => {
  const h = makeLabHarness({ mode: "budget-summary", triggerTokens: 1_000_000, keepRecentToolTurns: 2, model: SOL, summarizerMode: "deferred" });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.turn(["a1"], { resultText: bigResult });
    await h.request();
    await h.turn(["a2"], { resultText: bigResult, usage: { input: 1000, cacheRead: 240_000 } });
    const messages = await h.request();

    assert.match(stubOf(messages, "a0"), /^\[pruned:t\d+\]$/);
    assert.match(stubOf(messages, "a1"), /^\[pruned:t\d+\]$/, "the price line keeps only the newest tool turn");
    assert.equal(stubOf(messages, "a2"), bigResult("a2"));
    const mask = eventsOf(h, "apply", "mask");
    assert.equal(mask.length, 1);
    assert.match(mask[0].reason, /^price-line \d+>=231200$/);
    assert.deepEqual(mask[0].candidateToolCallIds, ["a0", "a1"]);
    assert.deepEqual(eventsOf(h, "prepare", "stage").map((event) => event.candidateToolCallIds), [["a0", "a1"]]);
    assert.equal(eventsOf(h, "prepare", "budget").length, 0, "the budget never triggered on its own");

    h.releaseSummarizer();
    await h.settle();
    const next = await h.request();
    assert.equal(summariesIn(next).length, 1, "the stage summary joins the context at a later boundary");
    assert.match(stubOf(next, "a0"), /^\[pruned:t\d+\]$/);
  } finally {
    h.cleanup();
  }
});

test("the price line stays off below the threshold and for models without a configured line", async () => {
  for (const [model, input] of [[SOL, 200_000], [{ provider: "fake", id: "fake-model" }, 400_000]] as const) {
    const h = makeLabHarness({ mode: "budget-summary", triggerTokens: 1_000_000, keepRecentToolTurns: 1, model });
    try {
      await h.sessionStart();
      h.prompt("task");
      await h.turn(["a0"], { resultText: bigResult });
      await h.request();
      await h.turn(["a1"], { resultText: bigResult, usage: { input } });
      const messages = await h.request();
      assert.equal(receiptsIn(messages).length, 0, `${model.id} at ${input}`);
      assert.equal(eventsOf(h, "apply", "mask").length, 0);
    } finally {
      h.cleanup();
    }
  }
});

test("a pending budget batch is dropped when the price line archives the same results", async () => {
  const h = makeLabHarness({ mode: "budget-summary", triggerTokens: 100, keepRecentToolTurns: 1, model: SOL, summarizerMode: "deferred" });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.turn(["a1"], { resultText: bigResult });
    assert.deepEqual(eventsOf(h, "prepare", "budget").map((event) => event.candidateToolCallIds), [["a0"]]);
    await h.request();
    await h.turn(["a2"], { resultText: bigResult, usage: { input: 250_000 } });
    const messages = await h.request();
    assert.match(stubOf(messages, "a0"), /^\[pruned:t\d+\]$/);
    assert.match(stubOf(messages, "a1"), /^\[pruned:t\d+\]$/);

    h.releaseSummarizer();
    await h.settle();
    assert.deepEqual(eventsOf(h, "skip", "budget").map((event) => event.reason), ["price-line"]);
    await h.request();
    assert.equal(eventsOf(h, "apply", "budget").length, 0);
    assert.equal(eventsOf(h, "apply", "stage").length, 1);
  } finally {
    h.cleanup();
  }
});

test("a second price-line crossing keeps the pending stage summary; the newly archived results get their own afterwards", async () => {
  const h = makeLabHarness({ mode: "budget-summary", triggerTokens: 1_000_000, keepRecentToolTurns: 2, model: SOL, summarizerMode: "deferred" });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: bigResult });
    await h.request();
    await h.turn(["a1"], { resultText: bigResult, usage: { input: 240_000 } });
    await h.request();
    await h.turn(["a2"], { resultText: bigResult, usage: { input: 240_000 } });
    const messages = await h.request();
    assert.match(stubOf(messages, "a1"), /^\[pruned:t\d+\]$/, "the second crossing still archives");
    assert.deepEqual(eventsOf(h, "prepare", "stage").map((event) => event.candidateToolCallIds), [["a0"]]);

    h.releaseSummarizer();
    await h.settle();
    assert.equal(eventsOf(h, "skip", "stage").length, 0, "the first stage summary is not dropped");
    await h.request();
    await h.turn(["a3"], { resultText: bigResult, usage: { input: 10_000 } });
    assert.deepEqual(eventsOf(h, "prepare", "stage").map((event) => event.candidateToolCallIds), [["a0"], ["a1"]]);

    h.releaseSummarizer();
    await h.settle();
    const next = await h.request();
    assert.deepEqual(eventsOf(h, "apply", "stage").map((event) => event.candidateToolCallIds), [["a0"], ["a1"]]);
    assert.equal(summariesIn(next).length, 2);
  } finally {
    h.cleanup();
  }
});

test("a budget summary applied at the same boundary counts before the price line decides", async () => {
  const large = (id: string) => `${id}:${"y".repeat(4000)}`;
  const h = makeLabHarness({ mode: "budget-summary", triggerTokens: 100, keepRecentToolTurns: 1, model: SOL, summarizerMode: "deferred" });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText: large });
    await h.request();
    await h.turn(["a1"], { resultText: large });
    assert.deepEqual(eventsOf(h, "prepare", "budget").map((event) => event.candidateToolCallIds), [["a0"]]);
    await h.request();
    h.releaseSummarizer();
    await h.settle();
    // The last usage still includes a0 in full; with it the request would be at 230,500 + a2 ≈ 231,500.
    await h.turn(["a2"], { resultText: large, usage: { input: 230_500 } });
    const messages = await h.request();
    assert.equal(eventsOf(h, "apply", "budget").length, 1);
    assert.match(stubOf(messages, "a0"), /^\[pruned:t\d+\]$/);
    assert.equal(eventsOf(h, "apply", "mask").length, 0, "archiving a0 already brought the request under the line");
    assert.equal(stubOf(messages, "a1"), large("a1"));
  } finally {
    h.cleanup();
  }
});
