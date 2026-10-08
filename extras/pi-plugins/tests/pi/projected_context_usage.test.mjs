import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(process.env.PI_TEST_PACKAGE_ROOT || join(
  process.env.APPDATA,
  "npm/node_modules/@earendil-works/pi-coding-agent",
));
const { buildSessionProjection } = await import(pathToFileURL(join(root, "dist/core/session-manager.js")));
const { estimateProjectedContextTokens, estimateTokens } = await import(
  pathToFileURL(join(root, "dist/core/compaction/compaction.js")),
);

const timestamp = "2026-09-30T00:00:00.000Z";
const usage = { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010 };
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistant = (stopReason, content = [], reportedUsage = usage) => ({
  role: "assistant", content, stopReason, usage: reportedUsage,
  api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6.1-sol", timestamp: 0,
});
const message = (id, parentId, value) => ({ type: "message", id, parentId, timestamp, message: value });
const edit = (id, parentId, targetId, replacement) => ({
  type: "context_edit", id, parentId, targetId, replacement, timestamp,
});
const prefix = () => [
  message("input", null, user("x".repeat(12000))),
  message("usage", "input", assistant("stop", [{ type: "text", text: "OK" }])),
];
function estimate(entries) {
  const leaf = entries.at(-1).id;
  const projection = buildSessionProjection(entries, leaf, new Map(entries.map((entry) => [entry.id, entry])));
  return estimateProjectedContextTokens(projection, entries);
}

for (const stopReason of ["aborted", "error"]) {
  test(`deleting an empty ${stopReason} response preserves the preceding measured usage`, () => {
    const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    const entries = [
      ...prefix(),
      message("failure", "usage", assistant(stopReason, [], emptyUsage)),
      edit("cleanup", "failure", "failure", null),
    ];
    assert.equal(estimate(entries).tokens, usage.totalTokens);
    assert.equal(estimate(entries).usageTokens, usage.totalTokens);
  });
}

test("editing a message after measured usage recalculates only the trailing tokens", () => {
  const replacement = user("short");
  const entries = [
    ...prefix(),
    message("pending", "usage", user("z".repeat(20000))),
    edit("edit", "pending", "pending", replacement),
  ];
  assert.equal(estimate(entries).tokens, usage.totalTokens + estimateTokens(replacement));
  assert.equal(estimate(entries).usageTokens, usage.totalTokens);
});

test("editing the measured prefix still invalidates its old usage", () => {
  const entries = [...prefix(), edit("edit", "usage", "input", user("short"))];
  assert.equal(estimate(entries).usageTokens, 0);
  assert.ok(estimate(entries).tokens < usage.totalTokens);
});

test("compaction still invalidates measured usage from the previous prefix", () => {
  const entries = [...prefix(), {
    type: "compaction", id: "compact", parentId: "usage", timestamp,
    summary: "Earlier context", firstKeptEntryId: "usage", tokensBefore: usage.totalTokens,
  }];
  assert.equal(estimate(entries).usageTokens, 0);
});
