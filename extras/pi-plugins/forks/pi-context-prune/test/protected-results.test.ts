import test from "node:test";
import assert from "node:assert/strict";
import { isProtectedToolResult, skillDirectories } from "../src/protected-results.ts";

const read = (path: string) => ({ name: "read", arguments: { path } });
const text = { content: [{ type: "text", text: "instructions" }] };

test("skill documents and their conventional resource trees are protected, not all reads", () => {
  for (const path of [
    "SKILL.md", "C:\\Users\\u\\.pi\\skills\\example\\SKILL.md",
    "ops/skills/example/references/steps.md", ".pi/skills/example/scripts/run.py",
    "/packages/custom-example/SKILL.md", "/home/u/.agents/skills/example/references/a.md",
  ]) assert.equal(isProtectedToolResult(text, read(path)), true, path);
  for (const path of ["README.md", "src/skills.ts", "notes/skills-audit.md", "src/index.ts"]) {
    assert.equal(isProtectedToolResult(text, read(path)), false, path);
  }
  assert.equal(isProtectedToolResult(text, { name: "write", arguments: { path: "SKILL.md" } }), false);
});

test("resources of a previously read custom-location skill are protected without matching siblings", () => {
  const directories = skillDirectories([read("C:/Packages/custom-example/SKILL.md")]);
  assert.equal(isProtectedToolResult(text, read("c:\\Packages\\custom-example\\references\\steps.md"), directories), true);
  assert.equal(isProtectedToolResult(text, read("C:/Packages/custom-example-other/steps.md"), directories), false);
  assert.equal(isProtectedToolResult(text, read("C:/Packages/custom-example/../source.ts"), directories), false);
});

test("images from any tool are protected, including images following text", () => {
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  assert.equal(isProtectedToolResult({ content: [image] }, { name: "screenshot" }), true);
  assert.equal(isProtectedToolResult({ content: [...text.content, image] }, undefined), true);
  assert.equal(isProtectedToolResult(text, { name: "screenshot" }), false);
});
