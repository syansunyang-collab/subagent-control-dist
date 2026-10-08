import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATE = path.join(ROOT, "artifacts/templates/pi-global-system-tail");

function cleanEnv() {
  const env = { ...process.env };
  delete env.SUBAGENT_RUNTIME_ROOT;
  delete env.SUBAGENT_TASK_ROOT;
  return env;
}

function runCheck(args) {
  return spawnSync(process.execPath, ["tools/render-pi-global-system-tail.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: cleanEnv(),
  });
}

function mirroredAgentRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-tail-"));
  cpSync(TEMPLATE, path.join(root, "local-packages", "pi-global-system-tail"), { recursive: true });
  cpSync(path.join(TEMPLATE, "APPEND_SYSTEM.md"), path.join(root, "APPEND_SYSTEM.md"));
  return root;
}

test("generated append contains only the maintained global style", () => {
  const append = readFileSync(path.join(TEMPLATE, "APPEND_SYSTEM.md"), "utf8");
  const style = readFileSync(path.join(TEMPLATE, "global-style.md"), "utf8");
  assert.equal(append, `${style.replace(/\r\n/g, "\n").trim()}\n`);
  assert.doesNotMatch(append, /ultimate-reminders|<worker-runtime>/u);
  assert.doesNotMatch(append, /已有依据足够时直接回答/u);
});

test("check compares template, package, and agent-root hashes", () => {
  const root = mirroredAgentRoot();
  try {
    const ok = runCheck(["--check", "--agent-root", root]);
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    assert.match(ok.stdout, /DEPLOYMENT_OK template=([0-9a-f]{64}) package=\1 agent=\1/u);

    writeFileSync(path.join(root, "APPEND_SYSTEM.md"), "drift\n");
    const agentDrift = runCheck(["--check", "--agent-root", root]);
    assert.equal(agentDrift.status, 1);
    assert.match(agentDrift.stderr, /agent root drift APPEND_SYSTEM.md/u);

    cpSync(path.join(TEMPLATE, "APPEND_SYSTEM.md"), path.join(root, "APPEND_SYSTEM.md"));
    writeFileSync(path.join(root, "local-packages", "pi-global-system-tail", "README.md"), "drift\n");
    const packageDrift = runCheck(["--check", "--agent-root", root]);
    assert.equal(packageDrift.status, 1);
    assert.match(packageDrift.stderr, /package drift README.md/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package retains time injection without a tail mover or marker prerequisite", async () => {
  const manifest = JSON.parse(readFileSync(path.join(TEMPLATE, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./local-time.ts"]);
  for (const obsolete of ["system-tail.ts", "ultimate-reminders.md", "response-calibration.md"]) {
    assert.equal(existsSync(path.join(TEMPLATE, obsolete)), false);
  }
  const handlers = [];
  for (const entry of manifest.pi.extensions) {
    const extension = await import(pathToFileURL(path.join(TEMPLATE, entry)).href);
    extension.default({ on(event, handler) { if (event === "before_agent_start") handlers.push(handler); } });
  }
  const RealDate = globalThis.Date;
  let instant = "2026-09-13T00:00:00Z";
  globalThis.Date = class extends RealDate { constructor() { super(instant); } };
  try {
    const prompts = [];
    for (instant of ["2026-09-13T00:00:00Z", "2026-09-13T15:59:59Z", "2026-09-13T16:00:00Z"]) {
      // The date is a named section, so Pi records it as a transcript delta instead of replacing the prompt.
      const event = { systemPrompt: "Pi base", systemPromptOptions: { sections: { existing: "kept" } } };
      for (const handler of handlers) assert.equal(await handler(event), undefined);
      const { existing, local_time: prompt } = event.systemPromptOptions.sections;
      assert.equal(existing, "kept");
      assert.match(prompt, /^<time-discipline>\n今日日期: [^\n]+ \(UTC\+8\)。\n<\/time-discipline>$/u);
      prompts.push(prompt);
    }
    assert.equal(prompts[0], prompts[1]);
    assert.notEqual(prompts[1], prompts[2]);
    assert.match(prompts[1], /2026\/09\/13/u);
    assert.match(prompts[2], /2026\/09\/14/u);
  } finally {
    globalThis.Date = RealDate;
  }
});
