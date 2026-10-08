import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildNativePackage, inspectNativePackage, installNativePackage, nativeStatus, rollbackNativePackage, sealNativePackage, writeNativePatch } from "../../tools/pi-antigravity/native-install.mjs";

const upstream = join(homedir(), ".pi/agent/npm/node_modules/@tian.zuo/pi-antigravity");
const installedRuntime = join(import.meta.dirname, "../../.runtime/pi-antigravity-native");
const committedPatch = join(import.meta.dirname, "../../tools/pi-antigravity/pi-antigravity-0.10.3-native.patch");
const manifestFiles = (runtime) => JSON.parse(readFileSync(join(runtime, "native-manifest.json"), "utf8")).files;

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "pi-native-install-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const runtime = join(base, "runtime"), settings = join(base, "settings.json"), backup = join(base, "backup.json");
  mkdirSync(runtime);
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "@local/pi-antigravity-native", version: "0.10.3-native.1" }));
  writeFileSync(join(runtime, "index.ts"), "export default function extension() {}\n");
  const config = { packages: ["npm:unrelated", { source: "npm:@tian.zuo/pi-antigravity", extensions: ["index.ts"] }], defaultModel: "keep", custom: { untouched: true } };
  writeFileSync(settings, JSON.stringify(config));
  sealNativePackage(runtime);
  return { runtime, settings, backup, config };
}

test("native installation changes only the Antigravity source and rollback preserves later settings", (t) => {
  const f = fixture(t);
  const installed = installNativePackage(f);
  assert.equal(installed.configured, true);
  assert.equal(installed.upstreamConfigured, false);
  const expected = structuredClone(f.config);
  expected.packages[1].source = f.runtime;
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), expected);
  assert.equal(installNativePackage(f).changed, false);
  expected.newSetting = 123;
  writeFileSync(f.settings, JSON.stringify(expected));
  assert.equal(rollbackNativePackage(f).configured, false);
  expected.packages[1] = f.config.packages[1];
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), expected);
  assert.equal(nativeStatus(f).upstreamConfigured, true);
});

test("native build copies a native source, links dependencies and seals the runtime", (t) => {
  const f = fixture(t), runtime = join(f.runtime, "..", "built");
  const result = buildNativePackage({ source: f.runtime, runtime });
  assert.equal(result.state, "ready");
  assert.equal(result.systemMode, "pi-effective-system-to-agent");
  assert.equal(readFileSync(join(runtime, "index.ts"), "utf8"), readFileSync(join(f.runtime, "index.ts"), "utf8"));
});

test("native build refuses an upstream copy without the transcript-hydrate hooks", (t) => {
  const base = mkdtempSync(join(tmpdir(), "pi-native-hydrate-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, "upstream"), runtime = join(base, "runtime");
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "@tian.zuo/pi-antigravity", version: "0.10.3" }));
  writeFileSync(join(source, "src", "provider.ts"), "export {}\n");
  assert.throws(() => buildNativePackage({ source, runtime }), /transcript-hydrate/);
  assert.equal(existsSync(runtime), false);
});

test("committed native patch rebuilds the installed runtime and regenerates from it", {
  skip: !(existsSync(upstream) && existsSync(join(installedRuntime, "native-manifest.json"))) && "needs upstream 0.10.3 and a built .runtime/pi-antigravity-native",
}, (t) => {
  const base = mkdtempSync(join(tmpdir(), "pi-native-patch-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const runtime = join(base, "runtime");
  assert.equal(buildNativePackage({ runtime }).state, "ready");
  // A difference means the runtime was built from an edited copy whose changes never reached the patch.
  assert.deepEqual(manifestFiles(runtime), manifestFiles(installedRuntime), "run native-patch, then native-build");
  const patch = join(base, "regenerated.patch");
  writeNativePatch({ source: installedRuntime, patch });
  assert.equal(readFileSync(patch, "utf8"), readFileSync(committedPatch, "utf8"));
});

test("native install refuses an unbuilt or modified runtime without touching settings", (t) => {
  const f = fixture(t), before = readFileSync(f.settings);
  writeFileSync(join(f.runtime, "index.ts"), "changed\n");
  assert.equal(inspectNativePackage(f.runtime).state, "changed");
  assert.throws(() => installNativePackage(f), /build before installing/);
  assert.deepEqual(readFileSync(f.settings), before);
});
