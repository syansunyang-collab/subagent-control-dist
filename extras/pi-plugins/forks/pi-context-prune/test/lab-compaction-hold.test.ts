import assert from "node:assert/strict";
import test from "node:test";
import { makeLabHarness, receiptsIn } from "./lab-harness.ts";

const usageAt = (state: { tokens: number | null }) => () => ({
  tokens: state.tokens,
  contextWindow: 1000,
  percent: state.tokens === null ? null : state.tokens / 10,
});

test("cold-mask holds releases near compaction and resumes below the hold line", async () => {
  const state = { tokens: 720 as number | null };
  const h = makeLabHarness({ mode: "cold-mask", keepRecentToolTurns: 0, rawConfig: { stageSummary: false }, contextUsage: usageAt(state) });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a"]);
    await h.request();
    assert.equal(receiptsIn(await h.request()).length, 0);
    assert.equal(h.labEvents().filter((event) => event.event === "apply").length, 0);
    state.tokens = 719;
    assert.equal(receiptsIn(await h.request()).length, 1);
  } finally { h.cleanup(); }
});

test("a zero hold ratio or unknown usage never holds a release", async () => {
  for (const [ratio, tokens] of [[0, 990], [undefined, null]] as const) {
    const state = { tokens: tokens as number | null };
    const h = makeLabHarness({
      mode: "cold-mask",
      keepRecentToolTurns: 0,
      rawConfig: { stageSummary: false, ...(ratio === undefined ? {} : { compactionHoldRatio: ratio }) },
      contextUsage: usageAt(state),
    });
    try {
      await h.sessionStart();
      h.prompt("task");
      await h.turn(["a"]);
      await h.request();
      assert.equal(receiptsIn(await h.request()).length, 1, `ratio ${ratio}, tokens ${tokens}`);
    } finally { h.cleanup(); }
  }
});
