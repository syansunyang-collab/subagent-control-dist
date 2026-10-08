import assert from "node:assert/strict";
import test from "node:test";
import { makeLabHarness, receiptsIn } from "./lab-harness.ts";

test("pause keeps request bytes and read-back, survives fresh reload, then resumes", async () => {
  const h = makeLabHarness({ mode: "cold-mask", keepRecentToolTurns: 0, rawConfig: { stageSummary: false } });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["old"]);
    await h.request();
    const before = await h.request();
    assert.equal(receiptsIn(before).length, 1);
    await h.command("pause");
    assert.deepEqual(await h.request(), before);
    assert.match((await h.readBack(["old"])).text, /old:/);
    await h.turn(["new"]);
    await h.request();
    const paused = await h.request();
    assert.deepEqual(receiptsIn(paused).map(m => m.toolCallId), ["old"]);
    await h.reloadExtension();
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /已暂停/);
    assert.deepEqual(await h.request(), paused);
    await h.command("resume");
    assert.deepEqual(receiptsIn(await h.request()).map(m => m.toolCallId), ["old", "new"]);
    assert.equal(h.summarizerPrompts().length, 0);
  } finally { h.cleanup(); }
});

test("pause state follows branch history and remains after compaction", async () => {
  const h = makeLabHarness({ mode: "cold-mask" });
  try {
    await h.sessionStart();
    await h.command("pause");
    const fork = h.branch.length;
    await h.command("resume");
    await h.reloadExtension();
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /运行中/);
    h.branch.splice(fork);
    await h.sessionTree();
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /已暂停/);
    h.compact();
    await h.reloadExtension();
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /已暂停/);
    h.branch.length = 0;
    await h.sessionTree();
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /运行中/);
  } finally { h.cleanup(); }
});

test("pause blocks price-line releases and every new summary route", async () => {
  for (const mode of ["cold-mask", "budget-summary"] as const) {
    const h = makeLabHarness({ mode, keepRecentToolTurns: 0, model: { provider: "openai-codex", id: "gpt-6-astra" } });
    try {
      await h.sessionStart();
      await h.command("pause");
      h.prompt("task");
      await h.turn(["old"], { usage: { input: 250000 } });
      await h.request();
      await h.turn(["new"], { usage: { input: 250000 } });
      assert.equal(receiptsIn(await h.request()).length, 0);
      await h.agentEnd();
      await h.settle();
      assert.equal(h.summarizerPrompts().length, 0);
      assert.equal(h.indexedIds().length, 0);
    } finally { h.cleanup(); }
  }
});

test("pause discards an in-flight summary even if it finishes after resume", async () => {
  const h = makeLabHarness({ mode: "cold-mask", keepRecentToolTurns: 0, summarizerMode: "deferred" });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["old"]);
    await h.request();
    const before = await h.request();
    await h.agentEnd();
    assert.equal(h.summarizerPrompts().length, 1);
    await h.command("pause");
    await h.agentEnd();
    assert.equal(h.summarizerPrompts().length, 1);
    await h.command("resume");
    h.releaseSummarizer();
    await h.settle();
    assert.deepEqual(await h.request(), before);
    assert.equal(h.summaries().length, 0);
  } finally { h.cleanup(); }
});

test("pause preserves an existing summary and drops a ready unapplied summary", async () => {
  for (const applyFirst of [true, false]) {
    const h = makeLabHarness({ mode: "cold-mask", keepRecentToolTurns: 0 });
    try {
      await h.sessionStart();
      h.prompt("task");
      await h.turn(["old"]);
      await h.request();
      await h.request();
      await h.agentEnd();
      await h.settle();
      const before = applyFirst ? await h.request() : undefined;
      await h.command("pause");
      const after = await h.request();
      assert.equal(h.summaries().length, applyFirst ? 1 : 0);
      if (before) assert.deepEqual(after, before);
      await h.reloadExtension();
      assert.deepEqual(await h.request(), after);
    } finally { h.cleanup(); }
  }
});
