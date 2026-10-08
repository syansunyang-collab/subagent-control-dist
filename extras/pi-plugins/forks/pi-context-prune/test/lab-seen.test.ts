import assert from "node:assert/strict";
import test from "node:test";
import { makeLabHarness, receiptsIn } from "./lab-harness.ts";
import { countTextTokens } from "../dist/lab-exports.js";

const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-sol" };
const xai = { provider: "xai", api: "openai-responses", id: "offline-xai" };

for (const sourceModel of [xai, { provider: "openai", api: "openai-responses", id: "foreign-openai" }]) {
  for (const [name, request] of [
    ["error", { stopReason: "error" }],
    ["aborted", { stopReason: "aborted" }],
    ["missing provider hook", { providerHook: false }],
    ["success", {}],
  ] as const) {
    test(`${sourceModel.provider} → xAI ${name} confirms only successful provider-visible results`, async () => {
      const h = makeLabHarness({ mode: "cold-mask", model: xai, keepRecentToolTurns: 0, rawConfig: { stageSummary: false } });
      try {
        await h.sessionStart();
        h.prompt("task");
        await h.turn(["call_a|fc_a"], { sourceModel, resultText: () => "x".repeat(800) });
        const source = h.agent.find(m => m.role === "assistant");
        assert.deepEqual([source.provider, source.api, source.model], [sourceModel.provider, sourceModel.api, sourceModel.id]);
        assert.equal(receiptsIn(await h.request({ ...request, inspectPayload(payload) {
          const output = payload.input.find(item => item.type === "function_call_output");
          assert.equal(output.call_id, sourceModel.provider === "xai" ? "call_a" : "call_a_fc_a");
        } })).length, 0);
        assert.equal(acknowledgements(h).length, name === "success" ? 1 : 0);
        assert.equal(receiptsIn(await h.request(request)).length, name === "success" ? 1 : 0);
        await h.reloadExtension();
        assert.equal(receiptsIn(await h.request(request)).length, name === "success" ? 1 : 0);
        assert.equal(h.summarizerPrompts().length, 0);
      } finally { h.cleanup(); }
    });
  }
}

test("xAI confirms only IDs in the actual Responses payload", async () => {
  const h = makeLabHarness({ mode: "cold-mask", model: xai, keepRecentToolTurns: 0 });
  try {
    await h.sessionStart(); h.prompt("task");
    await h.turn(["call_a|fc_a", "hidden"]);
    await h.request({ omitProviderIds: ["hidden"] });
    assert.deepEqual(acknowledgements(h).flatMap(e => e.data.toolCallIds), ["call_a|fc_a"]);
    assert.deepEqual(receiptsIn(await h.request()).map(m => m.toolCallId), ["call_a|fc_a"]);
  } finally { h.cleanup(); }
});
const resultText = (id: string) => `${id}:${"x".repeat(800)}`;
const acknowledgements = (h: ReturnType<typeof makeLabHarness>) =>
  h.branch.filter(e => e.customType === "context-prune-seen-results");

test("Responses native and cross-provider/api/model IDs agree with the installed host converter", async () => {
  const ids = ["call_a|fc_a", "call/with:chars|fc_item", "a".repeat(70) + "|fc_item"];
  const triggerTokens = ids.reduce((sum, id) => sum + countTextTokens(resultText(id)), 0);
  for (const target of [xai, model, { provider: "openai", api: "openai-responses", id: "offline-openai" }]) {
    for (const sourceModel of [target, { ...target, id: "other-model" },
      { ...target, api: "other-api" }, { provider: "opencode", api: "openai-responses", id: "foreign-model" }]) {
      const h = makeLabHarness({ mode: "cold-mask", model: target, triggerTokens,
        keepRecentToolTurns: 0, rawConfig: { stageSummary: false } });
      try {
        await h.sessionStart(); h.prompt("task");
        await h.turn(ids, { sourceModel, resultText });
        await h.request({ inspectPayload(payload) {
          assert.equal(payload.input.filter(item => item.type === "function_call_output").length, ids.length);
        } });
        assert.deepEqual(acknowledgements(h).flatMap(e => e.data.toolCallIds), ids);
        assert.deepEqual(receiptsIn(await h.request()).map(m => m.toolCallId), ids);
      } finally { h.cleanup(); }
    }
  }
});

test("Codex reload restores confirmed old results without releasing unread or recent results", async () => {
  const h = makeLabHarness({ mode: "cold-mask", model, triggerTokens: 100, keepRecentToolTurns: 2, rawConfig: { stageSummary: false } });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText });
    await h.request();
    await h.turn(["a1"], { resultText });
    await h.request();
    await h.turn(["a2"], { resultText });
    await h.reloadExtension();
    const sent = await h.request();
    assert.deepEqual(receiptsIn(sent).map(m => m.toolCallId), ["a0"]);
    assert.equal(sent.find(m => m.toolCallId === "a2").content[0].text, resultText("a2"));
    assert.equal(h.summarizerPrompts().length, 0);
    assert.equal(sent.some(m => m.customType === "context-prune-seen-results"), false, "acknowledgements never enter model context");
    await h.reloadExtension();
    assert.deepEqual(receiptsIn(await h.request()).map(m => m.toolCallId), ["a0"]);
  } finally { h.cleanup(); }
});

test("Codex failures and missing provider sends cannot grant pruning eligibility", async () => {
  for (const failure of [{ stopReason: "error" }, { stopReason: "aborted" }, { providerHook: false }]) {
    const h = makeLabHarness({ mode: "cold-mask", model, keepRecentToolTurns: 0 });
    try {
      await h.sessionStart();
      h.prompt("task");
      await h.turn(["a0"], { resultText });
      assert.equal(receiptsIn(await h.request(failure)).length, 0);
      assert.equal(acknowledgements(h).length, 0);
      assert.equal(receiptsIn(await h.request(failure)).length, 0, "failure must also stay unread without reload");
      await h.reloadExtension();
      assert.equal(receiptsIn(await h.request()).length, 0, "first successful read keeps the original");
      assert.equal(receiptsIn(await h.request()).length, 1);
    } finally { h.cleanup(); }
  }
});

test("Codex records only provider-visible results and persists each ID once", async () => {
  const h = makeLabHarness({ mode: "cold-mask", model, keepRecentToolTurns: 0 });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["call_a|fc_a", "hidden"], { resultText });
    await h.request({ omitProviderIds: ["hidden"] });
    assert.deepEqual(acknowledgements(h).flatMap(e => e.data.toolCallIds), ["call_a|fc_a"]);
    await h.reloadExtension();
    assert.deepEqual(receiptsIn(await h.request()).map(m => m.toolCallId), ["call_a|fc_a"]);
    await h.request();
    await h.request();
    assert.deepEqual(acknowledgements(h).flatMap(e => e.data.toolCallIds), ["call_a|fc_a", "hidden"]);
  } finally { h.cleanup(); }
});

test("Codex seen state follows the current branch and does not resurrect compacted material", async () => {
  const h = makeLabHarness({ mode: "cold-mask", model, keepRecentToolTurns: 0 });
  try {
    await h.sessionStart();
    h.prompt("task");
    await h.turn(["a0"], { resultText });
    const fork = h.branch.length;
    await h.request();
    assert.equal(acknowledgements(h).length, 1);
    h.branch.splice(fork);
    await h.sessionTree();
    h.reload();
    assert.equal(receiptsIn(await h.request()).length, 0, "a sibling branch's acknowledgement is absent");
    h.compact();
    await h.reloadExtension();
    const sent = await h.request();
    assert.equal(sent.some(m => m.role === "toolResult"), false);
    assert.equal(h.indexedIds().length, 0);
  } finally { h.cleanup(); }
});

test("Codex pause continues acknowledging reads and resume after reload uses them", async () => {
  const h = makeLabHarness({ mode: "cold-mask", model, keepRecentToolTurns: 0 });
  try {
    await h.sessionStart();
    await h.command("pause");
    h.prompt("task");
    await h.turn(["a0"], { resultText });
    await h.request();
    await h.reloadExtension();
    assert.equal(receiptsIn(await h.request()).length, 0);
    await h.command("resume");
    assert.equal(receiptsIn(await h.request()).length, 1);
    assert.equal(acknowledgements(h).length, 1);
  } finally { h.cleanup(); }
});
