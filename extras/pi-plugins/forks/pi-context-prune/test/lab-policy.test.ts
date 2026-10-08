/**
 * Unit tests for the pure lab policy helpers (built as `dist/lab-policy.js`
 * because node's type stripping does not resolve the `.js` specifiers used by
 * the TypeScript sources).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLabStubs,
  collectLabToolTurns,
  currentUserTurn,
  DEFAULT_KEEP_RECENT_TOOL_TURNS,
  DEFAULT_READ_LINES,
  labLedger,
  labStubText,
  MAX_READ_LINES,
  readSnapshotPage,
  selectLabCandidates,
  toolResultIds,
  toolResultIdsFromEntries,
} from "../dist/lab-exports.js";
import { normalizeLabConfig, DEFAULT_LAB_CONFIG } from "../dist/lab-exports.js";
import { countTextTokens } from "../dist/lab-exports.js";
import { DEFAULT_PRICE_LINES, estimateRequestTokens, priceLineFor } from "../dist/lab-exports.js";

const text = (id: string, size = 40) => `${id}:${"x".repeat(size)}`;

test("countTextTokens treats special-token spellings as ordinary text", () => {
  for (const empty of [undefined, null, ""]) assert.equal(countTextTokens(empty), 0);
  assert.equal(countTextTokens("ordinary tool output"), 3);
  assert.equal(countTextTokens("<|endoftext|>"), 7);
  assert.equal(countTextTokens("Source example: <|endoftext|>"), 10);
});

function branchOf(turns: Array<{ id: string; toolName?: string; args?: any; resultText?: string; image?: boolean }>, options: { complete?: boolean } = {}) {
  const branch: any[] = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "task" }] }, timestamp: "2026-09-21T00:00:00.000Z" }];
  let clock = Date.parse("2026-09-21T00:00:01.000Z");
  for (const turn of turns) {
    const toolName = turn.toolName ?? "read";
    branch.push({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: turn.id, name: toolName, arguments: turn.args ?? { path: turn.id } }] },
      timestamp: new Date((clock += 1000)).toISOString(),
    });
    if (options.complete === false) continue;
    const content: any[] = [{ type: "text", text: turn.resultText ?? text(turn.id) }];
    if (turn.image) content.push({ type: "image", data: "aGk=", mimeType: "image/png" });
    branch.push({
      type: "message",
      message: { role: "toolResult", toolCallId: turn.id, toolName, content, isError: false },
      timestamp: new Date((clock += 1000)).toISOString(),
    });
  }
  return branch;
}

test("collectLabToolTurns keeps turn order, completeness and drops protected results", () => {
  const branch = branchOf([
    { id: "a0" },
    { id: "s0", toolName: "read", args: { path: "docs/SKILL.md" } },
    { id: "i0", image: true },
    { id: "a1" },
  ]);
  const turns = collectLabToolTurns(branch);
  assert.deepEqual(turns.map((turn) => turn.complete), [true, true, true, true]);
  assert.deepEqual(turns.map((turn) => turn.toolCalls.map((call) => call.toolCallId)), [["a0"], [], [], ["a1"]]);
  assert.deepEqual(turns.map((turn) => turn.turnIndex), [0, 1, 2, 3]);
  assert.deepEqual(turns[0].toolCalls[0].args, { path: "a0" }, "preserve real Pi toolCall.arguments");

  const incomplete = collectLabToolTurns(branchOf([{ id: "a0" }], { complete: false }));
  assert.equal(incomplete[0].complete, false);
});

test("selectLabCandidates protects recent turns, unseen, released, invisible and excluded results", () => {
  const branch = branchOf([{ id: "a0" }, { id: "a1" }, { id: "a2" }, { id: "a3" }]);
  const turns = collectLabToolTurns(branch);
  const base = {
    seenIds: new Set(["a0", "a1", "a2", "a3"]),
    releasedIds: new Set<string>(),
    keepRecentToolTurns: 2,
    excludeToolNames: ["context_tree_query"],
    triggerTokens: 100_000,
  };

  // The two newest complete turns (a2, a3) stay.
  assert.deepEqual(selectLabCandidates(turns, base).toolCalls.map((call) => call.toolCallId), ["a0", "a1"]);

  // A result the model has not received yet is never released.
  const unseen = selectLabCandidates(turns, { ...base, seenIds: new Set(["a0"]) });
  assert.deepEqual(unseen.toolCalls.map((call) => call.toolCallId), ["a0"]);

  // Already released ids are skipped.
  const released = selectLabCandidates(turns, { ...base, releasedIds: new Set(["a0"]) });
  assert.deepEqual(released.toolCalls.map((call) => call.toolCallId), ["a1"]);

  // Results no longer present in the request are skipped.
  const invisible = selectLabCandidates(turns, { ...base, visibleIds: new Set(["a1"]) });
  assert.deepEqual(invisible.toolCalls.map((call) => call.toolCallId), ["a1"]);

  // Read-back results are never summarized again.
  const readBack = collectLabToolTurns(branchOf([{ id: "r0", toolName: "context_tree_query" }, { id: "a1" }]));
  assert.deepEqual(
    selectLabCandidates(readBack, { ...base, seenIds: new Set(["r0", "a1"]), keepRecentToolTurns: 0 }).toolCalls.map((call) => call.toolCallId),
    ["a1"],
  );

  // keepRecentToolTurns = 0 releases every complete turn.
  assert.deepEqual(
    selectLabCandidates(turns, { ...base, keepRecentToolTurns: 0 }).toolCalls.map((call) => call.toolCallId),
    ["a0", "a1", "a2", "a3"],
  );
});

test("selectLabCandidates stops at the token budget and reports the batch anchor", () => {
  const branch = branchOf([
    { id: "a0", resultText: "a0:" + "x".repeat(400) },
    { id: "a1", resultText: "a1:" + "x".repeat(400) },
    { id: "a2", resultText: "a2:" + "x".repeat(400) },
    { id: "a3", resultText: "a3:" + "x".repeat(400) },
  ]);
  const turns = collectLabToolTurns(branch);
  const perResult = countTextTokens(turns[0].toolCalls[0].resultText);
  const selection = selectLabCandidates(turns, {
    seenIds: new Set(["a0", "a1", "a2", "a3"]),
    releasedIds: new Set(),
    keepRecentToolTurns: 0,
    excludeToolNames: [],
    triggerTokens: perResult + 1,
  });
  assert.deepEqual(selection.toolCalls.map((call) => call.toolCallId), ["a0", "a1"]);
  assert.ok(selection.rawTokens >= perResult + 1);
  assert.equal(selection.turnIndex, 1);

  const tooSmall = selectLabCandidates(turns, {
    seenIds: new Set(["a0", "a1", "a2", "a3"]),
    releasedIds: new Set(),
    keepRecentToolTurns: 0,
    excludeToolNames: [],
    triggerTokens: perResult * 10,
  });
  assert.deepEqual(tooSmall.toolCalls.map((call) => call.toolCallId), ["a0", "a1", "a2", "a3"]);
  assert.ok(tooSmall.rawTokens < perResult * 10);
});

test("labLedger and the short receipt measure raw text against receipts and summary", () => {
  const refs = [
    { shortId: "t1", toolCallId: "a0" },
    { shortId: "t2", toolCallId: "a1" },
  ];
  const rawTexts = ["a0:" + "x".repeat(400), "a1:" + "x".repeat(400)];
  const withoutSummary = labLedger(rawTexts, refs);
  assert.equal(withoutSummary.stubTokens, countTextTokens(labStubText("t1")) * 2);
  assert.equal(withoutSummary.summaryTokens, 0);
  assert.ok(withoutSummary.netTokens > 0);

  const tiny = labLedger(rawTexts, refs, "- short");
  assert.ok(tiny.netTokens > 0);

  const oversized = labLedger(rawTexts, refs, "y".repeat(4000));
  assert.ok(oversized.netTokens <= 0);
});

test("special-token text survives candidate selection and replacement accounting", () => {
  const raw = "<|endoftext|>\n" + "ordinary log output\n".repeat(100);
  const selection = selectLabCandidates(collectLabToolTurns(branchOf([{ id: "marker", resultText: raw }])), {
    seenIds: new Set(["marker"]),
    releasedIds: new Set(),
    keepRecentToolTurns: 0,
    excludeToolNames: [],
    triggerTokens: 100,
  });
  assert.equal(selection.toolCalls.length, 1);
  assert.equal(selection.toolCalls[0].resultText, raw);
  const ledger = labLedger([raw], [{ shortId: "t1", toolCallId: "marker" }], "Source example: <|endoftext|>");
  assert.equal(ledger.rawTokens, selection.rawTokens);
  assert.equal(ledger.summaryTokens, 10);
  assert.ok(ledger.netTokens > 0);
});

test("applyLabStubs replaces only released results and keeps isError and unknown metadata", () => {
  const messages: any[] = [
    { role: "toolResult", toolCallId: "a0", toolName: "read", content: [{ type: "text", text: "raw a0" }], isError: true, extra: 7 },
    { role: "toolResult", toolCallId: "a1", toolName: "read", content: [{ type: "text", text: "raw a1" }], isError: false },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ];
  const once = applyLabStubs(messages, new Map([["a0", labStubText("t1")]]));
  assert.equal(once[0].content[0].text, "[pruned:t1]");
  assert.equal(once[0].isError, true);
  assert.equal(once[0].extra, 7);
  assert.equal(once[1].content[0].text, "raw a1");
  assert.equal(once[2], messages[2]);

  const twice = applyLabStubs(once, new Map([["a0", labStubText("t1")]]));
  assert.equal(twice, once, "a second pass must not allocate a new message list");

  const untouched = applyLabStubs(messages, new Map());
  assert.equal(untouched, messages);
});

test("readSnapshotPage pages by 1-based lines and reports the next offset", () => {
  const snapshot = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n");

  const first = readSnapshotPage(snapshot);
  assert.equal(first.startLine, 1);
  assert.equal(first.endLine, DEFAULT_READ_LINES);
  assert.equal(first.totalLines, 500);
  assert.equal(first.nextOffset, DEFAULT_READ_LINES + 1);
  assert.equal(first.lines[0], "line 1");

  const second = readSnapshotPage(snapshot, first.nextOffset, 100);
  assert.equal(second.startLine, 201);
  assert.equal(second.endLine, 300);
  assert.equal(second.nextOffset, 301);

  const last = readSnapshotPage(snapshot, 480, 100);
  assert.equal(last.startLine, 480);
  assert.equal(last.endLine, 500);
  assert.equal(last.nextOffset, null);

  const past = readSnapshotPage(snapshot, 900, 10);
  assert.equal(past.endLine, 0);
  assert.equal(past.lines.length, 0);
  assert.equal(past.nextOffset, null);

  const capped = readSnapshotPage(Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n"), 1, 100_000);
  assert.equal(capped.endLine, MAX_READ_LINES);
  assert.equal(capped.lines.length, MAX_READ_LINES);

  const empty = readSnapshotPage("", 1, 10);
  assert.equal(empty.totalLines, 1);
  assert.equal(empty.endLine, 1);
});

test("normalizeLabConfig validates the experimental fields and falls back to defaults", () => {
  assert.deepEqual(normalizeLabConfig({}), DEFAULT_LAB_CONFIG);
  assert.equal(DEFAULT_LAB_CONFIG.triggerTokens, 6000);
  assert.equal(DEFAULT_LAB_CONFIG.keepRecentToolTurns, DEFAULT_KEEP_RECENT_TOOL_TURNS);

  const parsed = normalizeLabConfig({
    mode: "cold-mask",
    triggerTokens: 1234,
    keepRecentToolTurns: 0,
    summarizerModel: "opencode-go/deepseek-v4.1-flash",
    summarizerThinking: "low",
    summarizerMaxCharsPerResult: 500,
  });
  assert.equal(parsed.mode, "cold-mask");
  assert.equal(parsed.triggerTokens, 1234);
  assert.equal(parsed.keepRecentToolTurns, 0);
  assert.equal(parsed.summarizerModel, "opencode-go/deepseek-v4.1-flash");
  assert.equal(parsed.summarizerThinking, "low");
  assert.equal(parsed.summarizerMaxCharsPerResult, 500);

  for (const invalid of [{ mode: "nope" }, { triggerTokens: -5 }, { keepRecentToolTurns: -1 }, { summarizerThinking: "extreme" }]) {
    assert.throws(() => normalizeLabConfig(invalid));
  }
});

test("tool result id and user turn helpers read both message lists and session entries", () => {
  const branch = branchOf([{ id: "a0" }]);
  assert.deepEqual([...toolResultIds([{ role: "toolResult", toolCallId: "x" }, { role: "assistant" }])], ["x"]);
  assert.deepEqual([...toolResultIdsFromEntries(branch)], ["a0"]);
  assert.equal(currentUserTurn(branch), 1);
  assert.equal(currentUserTurn([...branch, { type: "message", message: { role: "user", content: [] } }]), 2);
});

test("price lines match provider/model patterns, including local window aliases", () => {
  assert.equal(priceLineFor({ provider: "openai-codex", id: "gpt-5.6-sol-500k" }, DEFAULT_PRICE_LINES), 272_000);
  assert.equal(priceLineFor({ provider: "openai-codex", id: "gpt-6-astra" }, DEFAULT_PRICE_LINES), 272_000);
  assert.equal(priceLineFor({ provider: "OpenAI-Codex", id: "GPT-5.6-Luna" }, DEFAULT_PRICE_LINES), 272_000);
  assert.equal(priceLineFor({ provider: "xai", id: "grok-4.6" }, DEFAULT_PRICE_LINES), 200_000);
  assert.equal(priceLineFor({ provider: "xai", id: "grok-4.7" }, DEFAULT_PRICE_LINES), undefined);
  assert.equal(priceLineFor({ provider: "opencode-go", id: "deepseek-v4.1-flash" }, DEFAULT_PRICE_LINES), undefined);
  assert.equal(priceLineFor(undefined, DEFAULT_PRICE_LINES), undefined);
  assert.equal(priceLineFor({ provider: "a", id: "b.c" }, { "a/b*": 5 }), 5);
  assert.equal(priceLineFor({ provider: "a", id: "bxc" }, { "a/b.c": 5 }), undefined, "dots are literal");
});

test("the request estimate is the last usable usage plus the messages after it", () => {
  const usage = { input: 1000, output: 50, cacheRead: 9000, cacheWrite: 0, totalTokens: 10_050 };
  const messages = [
    { role: "user", content: [{ type: "text", text: "task" }] },
    { role: "assistant", content: [], usage, stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "x".repeat(400) }], isError: false },
  ];
  const estimate = estimateRequestTokens(messages)!;
  assert.ok(estimate > 10_050 && estimate <= 10_450, String(estimate));
  assert.equal(estimateRequestTokens([messages[0]]), undefined);
  assert.equal(estimateRequestTokens([{ ...messages[1], stopReason: "aborted" }]), undefined);

  // The usage measured `before`; this request replaced a 4000-character result with a receipt.
  const old = { role: "toolResult", toolCallId: "o", toolName: "read", content: [{ type: "text", text: "y".repeat(4000) }], isError: false };
  const before = [messages[0], old, ...messages.slice(1)];
  const after = [messages[0], { ...old, content: [{ type: "text", text: "[pruned:t1]" }] }, ...messages.slice(1)];
  const adjusted = estimateRequestTokens(after, before)!;
  assert.ok(estimate - adjusted > 950 && estimate - adjusted <= 1000, `${estimate} -> ${adjusted}`);
  assert.equal(estimateRequestTokens(before, before), estimate);
});

test("price line config: valid explicit values and invalid fields rejected", () => {
  assert.equal(normalizeLabConfig({}).priceLineRatio, 0.85);
  assert.deepEqual(normalizeLabConfig({}).priceLines, DEFAULT_PRICE_LINES);
  assert.equal(normalizeLabConfig({ priceLineRatio: 0 }).priceLineRatio, 0);
  assert.throws(() => normalizeLabConfig({ priceLineRatio: 2 }));
  assert.deepEqual(normalizeLabConfig({ priceLines: { "xai/*": 150_000.7 } }).priceLines, { "xai/*": 150_000 });
  assert.throws(() => normalizeLabConfig({ priceLines: { x: -1 } }));
  assert.throws(() => normalizeLabConfig({ priceLines: [] }));
});
