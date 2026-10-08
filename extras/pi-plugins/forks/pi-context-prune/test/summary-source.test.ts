import test from "node:test";
import assert from "node:assert/strict";
import { externalCopyIndexes } from "../src/summary-source.ts";
import { serializeBatchForSummarizer } from "../dist/lab-exports.js";

const RAW = "https://raw.githubusercontent.com/BurntSushi/ripgrep/master/crates/printer/src/summary.rs";
const call = (toolName: string, args: Record<string, unknown>) => ({ toolName, args });

test("a fetched copy of a file the batch reads locally is withheld", () => {
  const calls = [
    call("grep", { pattern: "match_count", path: "crates/printer/src/summary.rs", context: 4 }),
    call("fetch_content", { url: RAW, mode: "answer" }),
    call("fetch_content", { url: "https://raw.githubusercontent.com/BurntSushi/ripgrep/master/crates/searcher/src/searcher/glue.rs" }),
  ];
  assert.deepEqual([...externalCopyIndexes(calls)], [1]);
});

test("local paths match regardless of separators, case, leading ./ or absolute prefixes", () => {
  for (const path of ["E:\\work\\B\\crates\\printer\\src\\summary.rs", "./crates/printer/src/summary.rs", "Crates/Printer/src/summary.rs"]) {
    assert.deepEqual([...externalCopyIndexes([call("read", { path }), call("fetch_content", { url: RAW })])], [1], path);
  }
});

const SOURCE = [
  "pub fn has_match(&self) -> bool {",
  "    match self.summary.config.kind {",
  "        SummaryKind::PathWithoutMatch | SummaryKind::Quiet => {",
  "            self.match_count == 0",
  "        _ => self.match_count > 0,",
  "fn multi_line(&self, searcher: &Searcher) -> bool {",
].join("\n");

test("a short shared path counts only when the fetched text repeats the local lines", () => {
  const local = (path: string, resultText: string) => ({ toolName: "read", args: { path }, resultText });
  const grepped = SOURCE.split("\n").map((line, i) => `summary.rs-${510 + i}- ${line}`).join("\n");
  assert.deepEqual([...externalCopyIndexes([local("summary.rs", SOURCE), { ...call("fetch_content", { url: RAW }), resultText: `Quoted:\n${SOURCE}` }])], [1]);
  assert.deepEqual([...externalCopyIndexes([{ toolName: "grep", args: { path: "summary.rs", pattern: "x" }, resultText: grepped }, { ...call("fetch_content", { url: RAW }), resultText: SOURCE }])], [1]);
  assert.equal(externalCopyIndexes([local("summary.rs", SOURCE), { ...call("fetch_content", { url: RAW }), resultText: "unrelated text" }]).size, 0);
  assert.equal(externalCopyIndexes([call("read", { path: "summary.rs" }), call("fetch_content", { url: RAW })]).size, 0);
});

test("another project's README.md or src/index.ts is not taken for the local file", () => {
  const remote = (url: string) => ({ toolName: "fetch_content", args: { url }, resultText: "REMOTE_ONLY_API_FACT: the client retries twice" });
  const readme = { toolName: "read", args: { path: "README.md" }, resultText: "# Local project\nLicensed under either of Apache License, Version 2.0" };
  assert.equal(externalCopyIndexes([readme, remote("https://raw.githubusercontent.com/other/dependency/main/README.md")]).size, 0);
  const index = { toolName: "read", args: { path: "project-a/src/index.ts" }, resultText: "export const local = 1;" };
  assert.equal(externalCopyIndexes([index, remote("https://raw.githubusercontent.com/other/project-b/main/src/index.ts")]).size, 0);
});

test("unrelated fetches, directory greps, shared file names alone and non-http urls are kept", () => {
  assert.equal(externalCopyIndexes([call("read", { path: "src/lib.rs" }), call("fetch_content", { url: "https://docs.rs/regex/latest/regex/" })]).size, 0);
  assert.equal(externalCopyIndexes([call("grep", { pattern: "x", path: "crates/printer/src" }), call("fetch_content", { url: RAW })]).size, 0);
  assert.equal(externalCopyIndexes([call("read", { path: "crates/core/lib.rs" }), call("fetch_content", { url: "https://example.com/other/lib.rs" })]).size, 0);
  assert.equal(externalCopyIndexes([call("read", { path: "summary.rs" }), call("fetch_content", { url: "file:///c:/x/summary.rs" })]).size, 0);
  assert.equal(externalCopyIndexes([call("fetch_content", { url: RAW })]).size, 0);
});

test("the summarizer input carries the withheld fetch as a stub with its url, and leaves local reads intact", () => {
  const upstream = "fn matched() { count.max(1) }";
  const serialized = serializeBatchForSummarizer({
    turnIndex: 1,
    timestamp: 0,
    assistantText: "",
    toolCalls: [
      { toolCallId: "a", toolName: "read", args: { path: "crates/printer/src/summary.rs" }, resultText: "fn matched() {", isError: false },
      { toolCallId: "b", toolName: "fetch_content", args: { url: RAW }, resultText: upstream, isError: false },
    ],
  }, 8000);
  assert.ok(serialized.includes("fn matched() {"));
  assert.ok(serialized.includes(RAW));
  assert.ok(!serialized.includes("count.max(1)"));
  assert.ok(serialized.includes(`[external content not shown: ${upstream.length} chars; the assistant can fetch the original by id]`));
});
