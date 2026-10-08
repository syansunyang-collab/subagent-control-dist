// Handler-level checks of the patched extension sources. The installed host and extensions are checked
// end to end by verify-installed.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, "../..");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function handlerBody(file, header) {
  const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(header);
  assert.ok(start >= 0, `before_agent_start handler not found in ${file}`);
  const indent = source.slice(source.lastIndexOf("\n", start) + 1, start);
  const end = source.indexOf(`\n${indent}});`, start);
  return source.slice(start + header.length, end);
}

const event = (trigger) => ({ type: "before_agent_start", trigger, prompt: "", systemPrompt: "BASE", systemPromptOptions: { sections: {} } });

test("hermes memory writes its section instead of replacing the prompt", async () => {
  const body = handlerBody(join(here, "extensions/memory-index.ts"), 'pi.on("before_agent_start", async (event, _ctx) => {');
  const run = new AsyncFunction("event", "buildPromptContext", "config", "store", "projectStoreRef", "projectNameRef", "standingStore", body);
  for (const policy of ["POLICY", ""]) {
    const current = event("custom");
    assert.equal(await run(current, async () => policy, {}, {}, () => ({}), () => "p", {}), undefined);
    assert.deepEqual(current.systemPromptOptions.sections, policy ? { hermes_memory: policy } : {});
  }
});

test("local time writes its section instead of replacing the prompt", async () => {
  let handler;
  const { default: register } = await import(pathToFileURL(join(project, "artifacts/templates/pi-global-system-tail/local-time.ts")).href);
  register({ on: (_name, fn) => { handler = fn; } });
  const current = event("prompt");
  assert.equal(await handler(current), undefined);
  assert.match(current.systemPromptOptions.sections.local_time, /^<time-discipline>\n今日日期: .+ \(UTC\+8\)。\n<\/time-discipline>$/);
});
