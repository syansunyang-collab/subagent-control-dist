import assert from "node:assert/strict";
import { test } from "node:test";
import { messageKey, planTurn } from "../src/continuity.ts";
import { applyRunUsage } from "../src/usage.ts";

const user = (timestamp, content = "u") => ({ role: "user", content, timestamp });
const assistant = (timestamp) => ({ role: "assistant", content: [], timestamp });
const result = (toolCallId, text = "r") => ({ role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }] });

test("no held agent means a fresh one", () => {
	assert.deepEqual(planTurn(undefined, [], [user(1)]), { kind: "fresh" });
});

test("pending calls answered exactly resume the live run", () => {
	const history = [user(1), assistant(2)];
	const known = history.map(messageKey);
	const plan = planTurn(known, ["a", "b"], [...history, result("a"), result("b")]);
	assert.equal(plan.kind, "resume");
	assert.deepEqual(plan.results.map((r) => r.toolCallId), ["a", "b"]);
	assert.deepEqual(plan.steered, []);
});

test("user messages queued behind the tool results ride along as steering", () => {
	const history = [user(1), assistant(2)];
	const known = history.map(messageKey);
	const plan = planTurn(known, ["a"], [...history, result("a"), user(3, "also do X"), user(4, "and Y")]);
	assert.equal(plan.kind, "resume");
	assert.deepEqual(plan.results.map((r) => r.toolCallId), ["a"]);
	assert.deepEqual(plan.steered.map((m) => m.content), ["also do X", "and Y"]);
});

test("a missing, extra, duplicated or out-of-order answer starts over", () => {
	const history = [user(1), assistant(2)];
	const known = history.map(messageKey);
	assert.equal(planTurn(known, ["a", "b"], [...history, result("a")]).kind, "fresh");
	assert.equal(planTurn(known, ["a"], [...history, result("a"), result("zzz")]).kind, "fresh");
	assert.equal(planTurn(known, ["a"], [...history, result("a"), result("a")]).kind, "fresh");
	// a user message before the results, or an assistant message after them, is not Pi's steering shape
	assert.equal(planTurn(known, ["a"], [...history, user(3), result("a")]).kind, "fresh");
	assert.equal(planTurn(known, ["a"], [...history, result("a"), assistant(3)]).kind, "fresh");
	assert.equal(planTurn(known, ["a"], [...history, result("a"), user(3), result("b")]).kind, "fresh");
});

test("pruned tool result bodies do not break continuity", () => {
	const history = [user(1), assistant(2), result("a", "full output"), assistant(3)];
	const known = history.map(messageKey);
	const pruned = [user(1), assistant(2), result("a", "[pi-context-prune] stub"), assistant(3), user(4)];
	assert.deepEqual(planTurn(known, [], pruned), { kind: "followup", added: [user(4)] });
});

test("rewritten history (compaction, tree navigation) starts over", () => {
	const known = [user(1), assistant(2)].map(messageKey);
	assert.equal(planTurn(known, [], [user(9, "summary"), user(10)]).kind, "fresh");
	assert.equal(planTurn(known, [], [user(1), assistant(2)]).kind, "fresh");
	assert.equal(planTurn(known, [], [user(1), assistant(2), assistant(3), user(4)]).kind, "fresh");
});

const blank = () => ({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } });

test("a one-call run reports its exact prompt as the context size", () => {
	const output = blank();
	// Measured, composer-2.5, second turn of a chat: Cursor's inputTokens already contains the cached part.
	const context = applyRunUsage(output, { inputTokens: 15046, outputTokens: 17, cacheReadTokens: 14968 }, { toolBatches: 0, modelCalls: 1 });
	assert.equal(output.usage.input, 15046 - 14968);
	assert.equal(output.usage.cacheRead, 14968);
	assert.equal(output.usage.totalTokens, 15046 + 17);
	assert.equal(context, output.usage.totalTokens);
});

test("model calls Cursor makes on its own are counted from the thinking blocks", () => {
	// Measured, chat turn: two thinking blocks, no tool call, 30072 reported against 14993 the turn before.
	const chat = blank();
	applyRunUsage(chat, { inputTokens: 30072, outputTokens: 30, cacheReadTokens: 30003 }, { toolBatches: 0, modelCalls: 2, previousContext: 14993 });
	assert.equal(chat.usage.cacheRead, 30003); // billed numbers stay as reported
	assert.equal(chat.usage.totalTokens, 15036 + 30);

	// Measured, two tool calls: four thinking blocks (one call looks up the tool schema), 21604 in total,
	// and the next one-call turn on the same agent reported 5626.
	const tools = blank();
	const context = applyRunUsage(tools, { inputTokens: 21604, outputTokens: 252 }, { toolBatches: 2, modelCalls: 4, resultChars: 40 });
	assert.ok(context > 5401 && context < 7500, String(context));
});

test("without thinking blocks a repeated call is caught by the size of what was sent", () => {
	const shape = { toolBatches: 0, modelCalls: 0, previousContext: 14993, sentChars: 31 };
	assert.ok(applyRunUsage(blank(), { inputTokens: 30072, outputTokens: 30 }, shape) < 18000);
	// Without a known previous context there is nothing to bound against.
	assert.equal(applyRunUsage(blank(), { inputTokens: 30072, outputTokens: 30 }, { toolBatches: 0, sentChars: 31 }), 30102);
	// A large paste is real growth, not a repeated call.
	assert.equal(applyRunUsage(blank(), { inputTokens: 40000, outputTokens: 0 }, { toolBatches: 0, previousContext: 15000, sentChars: 60000 }), 40000);
});

test("a cache read larger than the reported input does not produce a negative input", () => {
	const output = blank();
	applyRunUsage(output, { inputTokens: 100, outputTokens: 1, cacheReadTokens: 512 }, { toolBatches: 0 });
	assert.equal(output.usage.input, 0);
	assert.equal(output.usage.cacheRead, 512);
});

test("a run with tool calls extrapolates the last call from the average and the previous context", () => {
	// 4 calls growing 40k, 60k, 80k, 100k: sum 280k, average 70k, last call 100k.
	const output = blank();
	applyRunUsage(output, { inputTokens: 280000, cacheReadTokens: 80000, outputTokens: 1000 }, { toolBatches: 3, previousContext: 40000 });
	assert.equal(output.usage.input, 200000); // the uncached share; input + cacheRead is the run's prompt total
	assert.equal(output.usage.totalTokens, 100000 + 1000);

	const unknownStart = blank();
	applyRunUsage(unknownStart, { inputTokens: 280000, cacheReadTokens: 80000, outputTokens: 1000 }, { toolBatches: 3, resultChars: 177000 });
	assert.equal(unknownStart.usage.totalTokens, 100000 + 1000); // growth 59k + 1k: the same 40k to 100k ramp
});

test("the estimate never drops below the average nor exceeds the run's total prompt", () => {
	const output = blank();
	applyRunUsage(output, { inputTokens: 30000, outputTokens: 0 }, { toolBatches: 2, previousContext: 500000 }); // stale, oversized anchor
	assert.equal(output.usage.totalTokens, 10000);
	const tiny = blank();
	applyRunUsage(tiny, { inputTokens: 30000, outputTokens: 0 }, { toolBatches: 1, previousContext: 1 });
	assert.ok(tiny.usage.totalTokens <= 30000);
});
