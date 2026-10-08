import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FALLBACK_MODELS, parseContextWindow, selectCursorModel, toHostModels } from "../src/models.ts";

const catalog = JSON.parse(readFileSync(new URL("./fixtures/cursor-models-2026-09-17.json", import.meta.url), "utf8"));
const hosts = toHostModels(catalog);
const host = (id) => hosts.find((model) => model.id === id);
const entry = (id) => catalog.find((model) => model.id === id);
const pick = (id, level) => Object.fromEntries((selectCursorModel(entry(host(id).cursorId), host(id), level).params ?? []).map((p) => [p.id, p.value]));

test("context sizes become separate Pi models with the right window", () => {
	assert.equal(parseContextWindow("272k"), 272000);
	assert.equal(parseContextWindow("1m"), 1000000);
	assert.equal(host("claude-opus-5").contextWindow, 300000);
	assert.equal(host("claude-opus-5-1m").contextWindow, 1000000);
	assert.equal(host("claude-opus-5-1m").cursorId, "claude-opus-5");
	assert.equal(host("composer-2.5").contextWindow, 200000);
});

test("models whose catalog entry has no context parameter use the window from Cursor's model pages", () => {
	assert.equal(host("grok-4.6").contextWindow, 256000);
	assert.equal(host("grok-4.5").contextWindow, 256000);
	assert.equal(host("gpt-5.3-codex").contextWindow, 272000);
	assert.equal(host("kimi-k2.7-code").contextWindow, 262000);
	assert.equal(host("glm-5.2").contextWindow, 200000);
	// The catalog wins where it does name a size.
	assert.equal(host("gpt-5.6-sol").contextWindow, 272000);
});

test("models without an effort or thinking parameter are not reasoning models", () => {
	assert.equal(host("composer-2.5").reasoning, false);
	assert.equal(host("grok-4.6").reasoning, true);
});

test("Pi thinking levels map to each model's own spelling, unsupported ones are null", () => {
	assert.equal(host("gpt-5.5").thinkingLevelMap.xhigh, "extra-high");
	assert.equal(host("grok-4.6").thinkingLevelMap.max, null);
	assert.equal(host("grok-4.6").thinkingLevelMap.off, null);
	assert.equal(host("gpt-5.6-luna").thinkingLevelMap.off, "none");
});

test("requests carry the matching Cursor parameters", () => {
	assert.deepEqual(pick("grok-4.6", "high"), { effort: "high", fast: "false" });
	assert.equal(pick("gpt-5.6-luna", undefined).reasoning, "none");
	assert.equal(pick("gpt-5.6-luna-1m", "medium").context, "1m");
	assert.equal(pick("claude-opus-5", undefined).thinking, "false");
	const opus = pick("claude-opus-5", "xhigh");
	assert.deepEqual([opus.thinking, opus.effort, opus.context, opus.fast], ["true", "xhigh", "300k", "false"]);
	assert.deepEqual(pick("composer-2.5", "high"), { fast: "false" });
});

test("every selection is a variant Cursor actually lists", () => {
	for (const model of hosts) {
		const source = entry(model.cursorId);
		for (const level of [undefined, "minimal", "low", "medium", "high", "xhigh", "max"]) {
			const chosen = selectCursorModel(source, model, level);
			const key = JSON.stringify([...(chosen.params ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
			const listed = source.variants.some((variant) => JSON.stringify([...variant.params].sort((a, b) => a.id.localeCompare(b.id))) === key);
			assert.ok(listed, `${model.id} @ ${level}`);
			if (model.context) assert.equal(chosen.params.find((p) => p.id === "context")?.value, model.context, `${model.id} context`);
		}
	}
});

test("a level the model lacks falls to the nearest one it has, never the opposite end", () => {
	assert.equal(host("claude-opus-5-1m").thinkingLevelMap.minimal, null);
	assert.equal(pick("claude-opus-5-1m", "minimal").effort, "low");
	assert.equal(pick("grok-4.6", "max").effort, "xhigh");
	assert.equal(pick("grok-4.6", "minimal").effort, "low");
	assert.equal(pick("gpt-5.5", "max").reasoning, "extra-high");
	assert.equal(pick("kimi-k3", "medium").reasoning, "low");
});

test("offline grok-4.6 still exposes Cursor effort levels", () => {
	const grok = toHostModels(FALLBACK_MODELS).find((model) => model.id === "grok-4.6");
	assert.equal(grok.reasoning, true);
	assert.equal(grok.thinkingLevelMap.low, "low");
	assert.equal(grok.thinkingLevelMap.medium, "medium");
	assert.equal(grok.thinkingLevelMap.high, "high");
	assert.equal(grok.thinkingLevelMap.xhigh, "xhigh");
	assert.equal(grok.thinkingLevelMap.off, null);
	assert.equal(grok.thinkingLevelMap.minimal, null);
});
