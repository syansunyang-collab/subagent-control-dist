import assert from "node:assert/strict";
import { test } from "node:test";
import { replayBudgetChars, serializeHostPrompt } from "../src/prompt.ts";

const TAG = "pi-test0001";
const user = (timestamp, content) => ({ role: "user", content, timestamp });
const assistant = (timestamp, text, call) => ({
	role: "assistant",
	timestamp,
	content: [{ type: "text", text }, ...(call ? [{ type: "toolCall", id: call, name: "read", arguments: { path: `${call}.txt` } }] : [])],
});
const result = (id, text) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }] });

function history(rounds, resultSize, tailUser = true) {
	const messages = [user(1, "TASK ONE: fix the zebra bug")];
	for (let i = 0; i < rounds; i++) {
		if (i === Math.floor(rounds / 2)) messages.push(user(5000 + i, "TASK TWO: fix the yak bug"));
		messages.push(assistant(10 + i * 2, `step ${i}`, `c${i}`), result(`c${i}`, `R${i}:` + "x".repeat(resultSize)));
	}
	if (tailUser) messages.push(user(9999, "LATEST: what next?"));
	return messages;
}

test("budget scales with the model's context window", () => {
	assert.equal(replayBudgetChars(200000), 240000);
	assert.equal(replayBudgetChars(1000000), 1200000);
	assert.equal(replayBudgetChars(undefined), 240000);
});

test("a transcript within budget is replayed in full", () => {
	const prompt = serializeHostPrompt(history(5, 100), 100000, TAG);
	assert.equal(prompt.text.includes("omitted"), false);
	for (let i = 0; i < 5; i++) assert.ok(prompt.text.includes(`R${i}:`));
});

test("an oversized transcript stays within budget and keeps first message, newest messages and a marker", () => {
	for (const budget of [6000, 10000, 25000]) {
		const prompt = serializeHostPrompt(history(40, 1000), budget, TAG);
		assert.ok(prompt.text.length <= budget, `budget ${budget}, length ${prompt.text.length}`);
		assert.ok(prompt.text.includes("TASK ONE: fix the zebra bug"));
		assert.ok(prompt.text.trimEnd().endsWith("LATEST: what next?"));
		assert.match(prompt.text, /Earlier transcript omitted: \d+ messages to fit the context budget\]/);
		assert.ok(prompt.text.includes("R39:"));
		assert.equal(prompt.text.includes("R0:"), false);
	}
});

test("the latest user message survives even when tool results come after it", () => {
	// Replay after an abort mid-task: the current task's prompt is far from the end of the transcript.
	const messages = history(40, 1000, false);
	const prompt = serializeHostPrompt(messages, 8000, TAG);
	assert.ok(prompt.text.length <= 8000);
	assert.ok(prompt.text.includes("TASK TWO: fix the yak bug"), "current task prompt must be kept");
	assert.ok(prompt.text.includes("TASK ONE"));
	assert.ok(prompt.text.includes("R39:"));
	// order is preserved: task one, (marker), task two, (marker or newer messages), newest result
	assert.ok(prompt.text.indexOf("TASK ONE") < prompt.text.indexOf("TASK TWO"));
	assert.ok(prompt.text.indexOf("TASK TWO") < prompt.text.indexOf("R39:"));
});

test("one huge tool result is elided in the middle instead of pushing everything else out", () => {
	const messages = [user(1, "TASK"), assistant(2, "reading", "big"), result("big", "HEAD" + "y".repeat(50000) + "TAIL"), user(3, "LATEST")];
	const prompt = serializeHostPrompt(messages, 8000, TAG);
	assert.ok(prompt.text.length <= 8000);
	assert.ok(prompt.text.includes("HEAD") && prompt.text.includes("TAIL"));
	assert.match(prompt.text, /\[\.\.\. \d+ characters, middle omitted \.\.\.\]/);
	assert.ok(prompt.text.includes("LATEST"));
});

test("fresh replay keeps image-only and mixed tool results with tool/call attribution", () => {
	const messages = [user(1, "inspect screenshots"),
		{ role: "toolResult", toolName: "screenshot", toolCallId: "image-call", content: [{ type: "image", data: "ONLY", mimeType: "image/png" }] },
		{ role: "toolResult", toolName: "read", toolCallId: "mixed-call", content: [{ type: "text", text: "image caption" }, { type: "image", data: "MIXED", mimeType: "image/jpeg" }] },
	];
	const prompt = serializeHostPrompt(messages, 10000, TAG);
	assert.deepEqual(prompt.images, [{ data: "ONLY", mimeType: "image/png" }, { data: "MIXED", mimeType: "image/jpeg" }]);
	assert.match(prompt.text, /Tool result: screenshot, call image-call/);
	assert.match(prompt.text, /Tool result: read, call mixed-call/);
	assert.match(prompt.text, /attached image\(s\) belong to this tool result/);
	assert.match(prompt.text, /image caption/);
	assert.doesNotMatch(prompt.text, /\(empty\)/);
});

test("budget-discarded tool results leave no attached images", () => {
	const messages = [user(1, "TASK"),
		{ role: "toolResult", toolName: "screenshot", toolCallId: "old", content: [{ type: "image", data: "OLD-TOOL", mimeType: "image/png" }] },
	];
	for (let i = 0; i < 12; i++) messages.push(assistant(10 + i, `filler ${i} ` + "z".repeat(600)));
	messages.push(user(99, "LATEST"));
	const prompt = serializeHostPrompt(messages, 3000, TAG);
	assert.match(prompt.text, /Earlier transcript omitted/);
	assert.doesNotMatch(prompt.text, /call old/);
	assert.deepEqual(prompt.images, []);
});

test("images of dropped messages are dropped with them", () => {
	const messages = [
		user(1, "TASK"),
		user(2, [{ type: "text", text: "old " + "z".repeat(600) }, { type: "image", data: "OLD", mimeType: "image/png" }]),
	];
	for (let i = 0; i < 12; i++) messages.push(assistant(10 + i, `filler ${i} ` + "z".repeat(600)));
	messages.push(user(99, [{ type: "text", text: "new" }, { type: "image", data: "NEW", mimeType: "image/png" }]));
	const prompt = serializeHostPrompt(messages, 3000, TAG);
	assert.match(prompt.text, /Earlier transcript omitted/);
	assert.deepEqual(prompt.images.map((image) => image.data), ["NEW"]);
});
