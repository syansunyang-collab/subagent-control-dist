import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const manager = join(projectRoot, "tools", "pi-antigravity", "manage-pi-antigravity.mjs");
const patch = join(
  projectRoot,
  "tools",
  "pi-antigravity",
  "pi-antigravity-0.9.0-windows-no-flash.patch",
);
const pluginPackage = process.env.PI_ANTIGRAVITY_TEST_PACKAGE || join(
  homedir(),
  ".pi",
  "agent",
  "npm",
  "node_modules",
  "@tian.zuo",
  "pi-antigravity",
);
const managedFiles = [
  "lib/agy-children.ts",
  "lib/agy-client.ts",
  "lib/agy-diagnostics.ts",
  "lib/agy-driver.ts",
  "lib/usage.ts",
];

function runManager(command, fixture) {
  return spawnSync(process.execPath, [manager, command, "--json", "--target", fixture], {
    encoding: "utf8",
    windowsHide: true,
  });
}

async function createBaselineFixture() {
  const fixture = await mkdtemp(join(tmpdir(), "pi-antigravity-manager-test-"));
  for (const relativePath of ["package.json", ...managedFiles]) {
    const destination = join(fixture, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(pluginPackage, relativePath), destination);
  }

  const status = runManager("status", fixture);
  assert.ok(status.stdout.trim(), status.stderr);
  const state = JSON.parse(status.stdout).target.state;
  if (state === "patched") {
    const reverse = spawnSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "apply",
        "--unidiff-zero",
        "--whitespace=nowarn",
        "--reverse",
        patch,
      ],
      { cwd: fixture, encoding: "utf8", windowsHide: true },
    );
    assert.equal(reverse.status, 0, reverse.stderr || reverse.stdout);
  } else {
    assert.equal(state, "baseline");
  }
  return fixture;
}

function occurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

test("DEBT-0011 manager applies, verifies, reapplies, and rolls back the Windows spawn patch", async (t) => {
  const fixture = await createBaselineFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const originals = new Map();
  for (const relativePath of managedFiles) {
    originals.set(relativePath, await readFile(join(fixture, relativePath)));
  }

  const baseline = runManager("status", fixture);
  assert.equal(baseline.status, 1);
  assert.equal(JSON.parse(baseline.stdout).target.state, "baseline");

  const applied = runManager("apply", fixture);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const appliedTarget = JSON.parse(applied.stdout).target;
  assert.equal(appliedTarget.state, "patched");
  assert.equal(appliedTarget.changed, true);
  assert.ok(appliedTarget.files.every(({ state }) => state === "patched"));
  const verified = runManager("status", fixture);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal(JSON.parse(verified.stdout).target.version, appliedTarget.version);

  const expectations = new Map([
    ["lib/agy-client.ts", 1],
    ["lib/agy-diagnostics.ts", 2],
    ["lib/agy-driver.ts", 1],
    ["lib/usage.ts", 1],
  ]);
  for (const [relativePath, expectedCount] of expectations) {
    const source = await readFile(join(fixture, relativePath), "utf8");
    assert.equal(occurrences(source, 'detached: process.platform !== "win32"'), expectedCount);
    assert.equal(occurrences(source, "windowsHide: true"), expectedCount);
    assert.doesNotMatch(source, /detached:\s*true/);
  }

  const idempotent = runManager("apply", fixture);
  assert.equal(idempotent.status, 0, idempotent.stderr || idempotent.stdout);
  assert.equal(JSON.parse(idempotent.stdout).target.changed, false);

  const rolledBack = runManager("rollback", fixture);
  assert.equal(rolledBack.status, 0, rolledBack.stderr || rolledBack.stdout);
  assert.equal(JSON.parse(rolledBack.stdout).target.state, "baseline");
  for (const relativePath of managedFiles) {
    assert.deepEqual(await readFile(join(fixture, relativePath)), originals.get(relativePath));
  }
});

test("DEBT-0011 manager binds 0.10.3 hashes to its version rather than accepting legacy hashes", async (t) => {
  const fixture = await createBaselineFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const packagePath = join(fixture, "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  pkg.version = pkg.version === "0.10.3" ? "0.10.1" : "0.10.3";
  await writeFile(packagePath, JSON.stringify(pkg));
  const before = await Promise.all(managedFiles.map((file) => readFile(join(fixture, file))));
  for (const command of ["apply", "rollback"]) {
    const result = runManager(command, fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing mixed pi-antigravity state/);
    assert.deepEqual(await Promise.all(managedFiles.map((file) => readFile(join(fixture, file)))), before);
  }
});

test("DEBT-0011 manager refuses a partially patched known tree without writing", async (t) => {
  const fixture = await createBaselineFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const driverPath = join(fixture, "lib/agy-driver.ts");
  const original = await readFile(driverPath);
  const applied = runManager("apply", fixture);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  await writeFile(driverPath, original);
  const status = runManager("status", fixture);
  assert.equal(status.status, 1);
  const target = JSON.parse(status.stdout).target;
  assert.equal(target.state, "mixed");
  assert.equal(target.files.filter(({ state }) => state === "patched").length, 4);
  const before = await Promise.all(managedFiles.map((file) => readFile(join(fixture, file))));
  for (const command of ["apply", "rollback"]) {
    const result = runManager(command, fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing mixed pi-antigravity state/);
    assert.deepEqual(await Promise.all(managedFiles.map((file) => readFile(join(fixture, file)))), before);
  }
});

test("manager rejects an unsupported version even when its file hashes match", async (t) => {
  const fixture = await createBaselineFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
  pkg.version = "99.0.0";
  await writeFile(join(fixture, "package.json"), JSON.stringify(pkg));
  const result = runManager("apply", fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected @tian\.zuo\/pi-antigravity/);
});

test("manager rejects a foreign package name with supported version and matching hashes", async (t) => {
  const fixture = await createBaselineFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
  pkg.name = "unrelated-package";
  await writeFile(join(fixture, "package.json"), JSON.stringify(pkg));
  const before = await Promise.all(managedFiles.map((file) => readFile(join(fixture, file))));
  const result = runManager("apply", fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected @tian\.zuo\/pi-antigravity/);
  assert.deepEqual(await Promise.all(managedFiles.map((file) => readFile(join(fixture, file)))), before);
});

test("DEBT-0011 manager refuses a mixed or foreign source tree without overwriting it", async (t) => {
  const fixture = await createBaselineFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const foreignPath = join(fixture, "lib/agy-driver.ts");
  await writeFile(foreignPath, `${await readFile(foreignPath, "utf8")}\n// foreign edit\n`);
  const before = await Promise.all(managedFiles.map((file) => readFile(join(fixture, file))));

  const result = runManager("apply", fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing (?:mixed|unknown) pi-antigravity state/);
  const after = await Promise.all(managedFiles.map((file) => readFile(join(fixture, file))));
  assert.deepEqual(after, before);
});
