import assert from "node:assert/strict";
import test from "node:test";
import { MAX_READ_CHARS, readSnapshotPage } from "../dist/lab-exports.js";
import { makeLabHarness } from "./lab-harness.ts";
import { wireToolText } from "./host-responses.ts";

const archivedBody = (text: string, count: number) => {
  const header = /Snapshot: lines [^\n]*\n/.exec(text)!;
  return text.slice(header.index + header[0].length, header.index + header[0].length + count);
};

test("long single lines and CRLF pages reconstruct the exact archived text", () => {
  for (const original of ["x".repeat(2000000), "a".repeat(17000) + "\r\n" + "b".repeat(32000) + "\r\nend\n"]) {
    let offset = 1, charOffset = 0, restored = "", pages = 0;
    do {
      const page = readSnapshotPage(original, offset, 1, charOffset);
      assert(page.text.length <= MAX_READ_CHARS);
      restored += page.text;
      pages++;
      if (page.nextOffset === null) break;
      offset = page.nextOffset; charOffset = page.nextCharOffset;
      assert(pages < 200);
    } while (true);
    assert.equal(restored, original);
  }
});

test("Unicode pages survive the installed Responses text conversion without losing code points", () => {
  for (const original of ["x".repeat(MAX_READ_CHARS - 1) + "😀tail",
    "x".repeat(MAX_READ_CHARS - 2) + "😀\r\nnext😀\n", "😀".repeat(MAX_READ_CHARS)]) {
    let offset = 1, charOffset = 0, restored = "";
    do {
      const page = readSnapshotPage(original, offset, 1, charOffset);
      assert(page.text.length > 0 && page.text.length <= MAX_READ_CHARS);
      assert.equal(wireToolText(page.text), page.text);
      restored += wireToolText(page.text);
      if (page.nextOffset === null) break;
      offset = page.nextOffset; charOffset = page.nextCharOffset;
    } while (true);
    assert.equal(restored, original);
  }
  const boundary = "x".repeat(MAX_READ_CHARS - 1) + "😀tail";
  const first = readSnapshotPage(boundary, 1, 1);
  assert.equal(first.text.length, MAX_READ_CHARS - 1);
  assert.equal(first.nextCharOffset, MAX_READ_CHARS - 1, "cursor points to the whole unreturned emoji");
  const insufficient = readSnapshotPage("😀tail", 1, 1, 0, 1);
  assert.equal(insufficient.text, "");
  assert.equal(insufficient.nextCharOffset, 0);
  const insidePair = readSnapshotPage("😀tail", 1, 1, 1);
  assert.equal(insidePair.charOffset, 0);
  assert.equal(wireToolText(insidePair.text), "😀tail");
});

test("registered read-back defers a ref when the remaining budget cannot fit its code point", async () => {
  const originals = { first: "a".repeat(MAX_READ_CHARS - 1) + "😀tail", second: "😀" + "a".repeat(18000) };
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 3000, keepRecentToolTurns: 0, rawConfig: { stageSummary: false } });
  try {
    await h.sessionStart(); h.prompt("task");
    await h.turn(["first", "second"], { resultText: id => originals[id] });
    await h.request(); await h.request();
    const first = await h.readBack(["first", "second"], 1, 1);
    assert.equal(first.details.first.bodyChars, MAX_READ_CHARS - 1);
    assert.equal(first.details.first.nextCharOffset, MAX_READ_CHARS - 1);
    assert.equal(first.details.second.deferred, true);
    assert.equal(first.details.second.nextCharOffset, 0);
    assert.equal(wireToolText(first.text), first.text);
    for (const id of ["first", "second"]) {
      let restored = id === "first" ? archivedBody(wireToolText(first.text), first.details.first.bodyChars) : "";
      let offset = first.details[id].nextOffset, charOffset = first.details[id].nextCharOffset;
      do {
        const result = await h.readTool.execute("read", { toolCallIds: [id], offset, charOffset, limit: 1 });
        const cursor = result.details[id];
        const text = result.content[0].text;
        assert(cursor.bodyChars > 0 && cursor.bodyChars <= MAX_READ_CHARS);
        assert.equal(wireToolText(text), text);
        restored += archivedBody(wireToolText(text), cursor.bodyChars);
        if (cursor.nextOffset === null) break;
        offset = cursor.nextOffset; charOffset = cursor.nextCharOffset;
      } while (true);
      assert.equal(restored, originals[id]);
    }
  } finally { h.cleanup(); }
});

test("multiple refs share a body budget and deferred refs remain recoverable", async () => {
  const h = makeLabHarness({ mode: "cold-mask", triggerTokens: 3000, keepRecentToolTurns: 0, rawConfig: { stageSummary: false } });
  const original = "a".repeat(18000);
  try {
    await h.sessionStart(); h.prompt("task");
    await h.turn(["first", "second"], { resultText: () => original });
    await h.request(); await h.request();
    const result = await h.readBack(["first", "second"], 1, 1);
    assert.equal(result.details.first.bodyChars, MAX_READ_CHARS);
    assert.equal(result.details.second.deferred, true);
    assert(result.text.length < MAX_READ_CHARS + 1000);
    const firstBody = archivedBody(result.text, result.details.first.bodyChars);
    const next = result.details.first;
    const tail = await h.readTool.execute("read", { toolCallIds: ["first"], offset: next.nextOffset, charOffset: next.nextCharOffset, limit: 1 });
    assert.equal(tail.details.first.bodyChars, original.length - MAX_READ_CHARS);
    assert.equal(firstBody + archivedBody(tail.content[0].text, tail.details.first.bodyChars), original);
    const second = await h.readBack(["second"], 1, 1);
    assert.equal(second.details.second.bodyChars, MAX_READ_CHARS);
    const secondTail = await h.readTool.execute("read", { toolCallIds: ["second"], offset: second.details.second.nextOffset, charOffset: second.details.second.nextCharOffset, limit: 1 });
    assert.equal(archivedBody(second.text, second.details.second.bodyChars)
      + archivedBody(secondTail.content[0].text, secondTail.details.second.bodyChars), original);
  } finally { h.cleanup(); }
});
