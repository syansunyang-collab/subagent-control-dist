import assert from "node:assert/strict";
import test from "node:test";
import { makeLabHarness, receiptsIn } from "./lab-harness.ts";

test("threshold selection is immediate, persists through reload, and follows the branch", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 6000, keepRecentToolTurns: 0, selectChoice: "30K", rawConfig: { stageSummary: false } });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["large"], { resultText: () => "hello world ".repeat(4000) });
    await h.request();
    await h.threshold("");
    assert.equal(receiptsIn(await h.request()).length, 0);
    await h.reloadExtension();
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /30,000/);
    await h.request();
    assert.equal(receiptsIn(await h.request()).length, 0);
    const fork = h.branch.length;
    await h.threshold("6k");
    assert.equal(receiptsIn(await h.request()).length, 1);
    h.branch.splice(fork);
    await h.sessionTree();
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /30,000/);
    assert.equal(h.summarizerPrompts().length, 0);
  } finally { h.cleanup(); }
});

test("threshold cancellation and invalid values preserve state; changing threshold does not resume", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 6000 });
  try {
    await h.sessionStart();
    const n = h.branch.length;
    await h.threshold("");
    await h.threshold("0");
    await h.threshold("30001");
    assert.equal(h.branch.length, n);
    await h.command("pause");
    await h.threshold("30000");
    await h.reloadExtension();
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /已暂停.*30,000/);
  } finally { h.cleanup(); }
});
