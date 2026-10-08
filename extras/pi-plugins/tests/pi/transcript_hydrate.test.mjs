import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyTarget, canonicalSource, inspectTarget, legacyTargets, targets, parseArgs, runTargets } from "../../tools/pi-transcript-hydrate/apply.mjs";

const canonical = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "pi-transcript-hydrate", "transcript-compat.ts");

test("canonical helper uses official transcript APIs only", async () => {
  const source = await readFile(canonical, "utf8");
  assert.match(source, /getCurrentSystemPrompt/);
  assert.match(source, /getCurrentTools/);
  assert.doesNotMatch(source, /systemPromptFromMessages/);
  assert.doesNotMatch(source, /toolsFromMessages/);
  assert.equal(canonicalSource(), source);
});

test("apply copies canonical file when hooks exist", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-transcript-hydrate-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const claude = join(fixture, "claude");
  const agy = join(fixture, "agy");
  await mkdir(join(claude, "src"), { recursive: true });
  await mkdir(join(agy, "src"), { recursive: true });
  const hook = 'import { hydrateContext } from "./transcript-compat.ts";\nhydrateContext(context);\n';
  await writeFile(join(claude, "src", "provider.ts"), hook);
  await writeFile(join(claude, "src", "context-serializer.ts"), hook);
  await writeFile(join(agy, "src", "provider.ts"), hook);
  await writeFile(join(claude, "src", "transcript-compat.ts"), "old claude\n");
  await writeFile(join(agy, "src", "transcript-compat.ts"), "old agy\n");

  const claudeTarget = { ...legacyTargets[0], id: `fixture-claude-${fixture.split(/[\\/]/).at(-1)}` };
  const agyTarget = { ...targets[0], id: `fixture-agy-${fixture.split(/[\\/]/).at(-1)}` };
  const backupRoot = join(fixture, "backups");
  assert.equal(inspectTarget(claudeTarget, claude).compatMatches, false);
  assert.equal(applyTarget(claudeTarget, claude, backupRoot).compatMatches, true);
  assert.equal(await readFile(join(claude, "src", "transcript-compat.ts"), "utf8"), canonicalSource(claudeTarget));
  assert.equal(applyTarget(agyTarget, agy, backupRoot).compatMatches, true);
  assert.equal(await readFile(join(agy, "src", "transcript-compat.ts"), "utf8"), canonicalSource(agyTarget));
});

test("default and target-id maintenance ignores retired Claude, explicit legacy and broken active hooks fail", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "hydrate-selection-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const claude = join(fixture, "claude"), agy = join(fixture, "agy");
  await mkdir(join(claude, "src"), { recursive: true });
  await mkdir(join(agy, "src"), { recursive: true });
  await writeFile(join(claude, "src", "provider.ts"), "export {}\n");
  await writeFile(join(agy, "src", "provider.ts"), 'import { hydrateContext } from "./transcript-compat.ts";\nhydrateContext(context);\n');
  const activeId = targets[0].id, legacyId = legacyTargets[0].id;
  const roots = new Map([[activeId, agy], [legacyId, claude]]);
  const backup = join(fixture, "backups");
  const defaults = parseArgs(["apply"]);
  assert.deepEqual(defaults.selected.map(t => t.id), [activeId]);
  assert.equal(runTargets(defaults.command, defaults.selected, roots, backup).ok, true);
  assert.equal(runTargets("verify", undefined, roots, backup).ok, true);
  const directed = parseArgs(["verify", "--target", activeId]);
  assert.equal(runTargets(directed.command, directed.selected, roots, backup).ok, true);
  const legacy = parseArgs(["apply", "--target", legacyId]);
  assert.equal(legacy.selected[0].legacy, true);
  assert.throws(() => runTargets(legacy.command, legacy.selected, roots, backup), /missing hydrateContext hooks/);
  assert.equal(runTargets("verify", legacy.selected, roots, backup).ok, false);
  assert.throws(() => parseArgs(["verify", "--target", "unknown"]), /unknown target/);
  await writeFile(join(agy, "src", "provider.ts"), "export {}\n");
  assert.equal(runTargets("verify", undefined, roots, backup).ok, false);
  assert.throws(() => runTargets("apply", undefined, roots, backup), /missing hydrateContext hooks/);
});

test("apply refuses packages without hydrate hooks", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-transcript-hydrate-miss-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "src"), { recursive: true });
  await writeFile(join(fixture, "src", "provider.ts"), "export {}\n");
  assert.throws(() => applyTarget(targets[0], fixture), /missing hydrateContext hooks/);
});
