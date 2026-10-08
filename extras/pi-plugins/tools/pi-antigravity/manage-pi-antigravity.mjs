#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeCommand } from "./native-install.mjs";

if (process.argv[2]?.startsWith("native-")) {
  process.exit(runNativeCommand(process.argv.slice(2)));
}

const toolRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(toolRoot, "..", "..");
const patchPath = join(toolRoot, "pi-antigravity-0.9.0-windows-no-flash.patch");
const patchHash = "4e7308e26fc25ada226fb900e5f94ad224b6579006631c20688b2fe53e8fcbd1";
const fileHashes = {
  "lib/agy-children.ts": {
    baseline: "9c9ac037ebf3ac79c8ea9a918fe234c1137bf2a3d44c5f63130300fb787542f5",
    patched: "a64ee9934f73caa2615027db1429a700e2bef7e2bfd09e0fd1834538c18905d6",
  },
  "lib/agy-client.ts": {
    baseline: "03532d3cbb8b7cce0ec62b5dc5c8d9559c101f11f72c44c31844ea677ab7d110",
    patched: "013f29ecd77be2bf8c05e9d670d57349f9a234f51714fa0297da397e41968d8e",
  },
  "lib/agy-diagnostics.ts": {
    baseline: "12658154934fabac3e9a90d26a215ec19576b4900330ab15188fc9188bc73e3e",
    patched: "7047590c505c87c2f1fa437e01399e21c51bc3cd9a7eaa0700e3fde60d501c98",
  },
  "lib/agy-driver.ts": {
    baseline: "78a48f3704a029fb1e2673ffe7d25af17b8504d91050c258e4f5663bd4560e54",
    patched: "82e61f6f8b30d900d83545cf4f5e690187d7aa9eae956e247a7ecefe4ed040a0",
  },
  "lib/usage.ts": {
    baseline: "2884946768debeab935d0f435524bb722c9faf924c86594abd11c124e8a3e824",
    patched: "1acdd39b592ae7bce8426593c2e4a1ad93702663e33d3db51a6ccb68c3e4fbdf",
  },
};
// 0.9.0 and 0.10.1 share source hashes; 0.10.3 changes client and driver only.
// The same patch applies to all three, with version-specific output verification.
const hashesByVersion = {
  "0.9.0": fileHashes,
  "0.10.1": fileHashes,
  "0.10.3": {
    ...fileHashes,
    "lib/agy-client.ts": {
      baseline: "00d36a16b007f8a74ca11a140910ff84549ae77f4e8b61b07ce1d3bb31e37416",
      patched: "0fc042669aa267d69dc68ea72fd941ed7faffb193d4edf139af8bf0f3bce7dc3",
    },
    "lib/agy-driver.ts": {
      baseline: "cd727adea665af880ac20e9a5ca989c42cf59c71cef3063ce9caae4d227c082a",
      patched: "1104f3e7cf6eacdc15d9b17bd0b8a9e4e89428e5664026c72ff5e14a5f15b263",
    },
  },
};
const managedFiles = Object.keys(fileHashes);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function parseArgs(argv) {
  const command = argv[0] ?? "status";
  if (!new Set(["status", "apply", "rollback"]).has(command)) {
    throw new Error(
      "Usage: node manage-pi-antigravity.mjs [status|apply|rollback] [--json] [--target package-directory]",
    );
  }
  let json = false;
  let target;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--target") {
      const value = argv[++index];
      if (!value) throw new Error("--target requires a package directory");
      target = resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { command, json, target };
}

function defaultTarget() {
  return join(
    homedir(),
    ".pi",
    "agent",
    "npm",
    "node_modules",
    "@tian.zuo",
    "pi-antigravity",
  );
}

function inspectTarget(packageDirectory) {
  const packageJsonPath = join(packageDirectory, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`pi-antigravity package not found at ${packageDirectory}`);
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== "@tian.zuo/pi-antigravity" || !Object.hasOwn(hashesByVersion, packageJson.version)) {
    throw new Error(`expected @tian.zuo/pi-antigravity ${Object.keys(hashesByVersion).join(" or ")}, found ${packageJson.name}@${packageJson.version}`);
  }
  const expectedHashes = hashesByVersion[packageJson.version];

  const files = managedFiles.map((relativePath) => {
    const path = join(packageDirectory, relativePath);
    if (!existsSync(path)) throw new Error(`pi-antigravity missing ${relativePath}`);
    const hash = sha256File(path);
    const expected = expectedHashes[relativePath];
    const state =
      hash === expected.baseline ? "baseline" : hash === expected.patched ? "patched" : "unknown";
    return { path: relativePath, hash, state };
  });
  const states = new Set(files.map(({ state }) => state));
  const state = states.size === 1 ? files[0].state : "mixed";
  return {
    packageDirectory: realpathSync(packageDirectory),
    version: packageJson.version,
    state,
    files,
  };
}

function transform(packageDirectory, reverse) {
  const scratch = mkdtempSync(join(tmpdir(), "pi-antigravity-patch-"));
  try {
    for (const relativePath of managedFiles) {
      const destination = join(scratch, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(packageDirectory, relativePath), destination);
    }
    const result = spawnSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "apply",
        "--unidiff-zero",
        "--whitespace=nowarn",
        ...(reverse ? ["--reverse"] : []),
        patchPath,
      ],
      { cwd: scratch, encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) {
      throw new Error(
        [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n") ||
          "git apply failed",
      );
    }
    return new Map(
      managedFiles.map((relativePath) => [relativePath, readFileSync(join(scratch, relativePath))]),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function transition(target, desiredState) {
  if (target.state === desiredState) return { ...target, changed: false };
  const sourceState = desiredState === "patched" ? "baseline" : "patched";
  if (target.state !== sourceState) {
    const summary = target.files.map(({ path, state, hash }) => `${path}=${state}:${hash}`).join(", ");
    throw new Error(`refusing ${target.state} pi-antigravity state (${summary})`);
  }

  const output = transform(target.packageDirectory, desiredState === "baseline");
  for (const [relativePath, content] of output) {
    const expected = hashesByVersion[target.version][relativePath][desiredState];
    const actual = sha256(content);
    if (actual !== expected) {
      throw new Error(`transformed ${relativePath} hash ${actual}, expected ${expected}`);
    }
  }

  const backupRoot = join(projectRoot, ".runtime", "pi-antigravity-backups", target.version, target.state);
  const originals = new Map();
  for (const relativePath of managedFiles) {
    const source = join(target.packageDirectory, relativePath);
    const backup = join(backupRoot, relativePath);
    const original = readFileSync(source);
    originals.set(relativePath, original);
    mkdirSync(dirname(backup), { recursive: true });
    if (!existsSync(backup)) writeFileSync(backup, original);
  }

  try {
    for (const [relativePath, content] of output) {
      writeFileSync(join(target.packageDirectory, relativePath), content);
    }
    const after = inspectTarget(target.packageDirectory);
    if (after.state !== desiredState) {
      throw new Error(`write verification found ${after.state}`);
    }
    return { ...after, changed: true, backupRoot };
  } catch (error) {
    for (const [relativePath, content] of originals) {
      writeFileSync(join(target.packageDirectory, relativePath), content);
    }
    throw error;
  }
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync(patchPath)) throw new Error(`Patch file missing: ${patchPath}`);
if (sha256File(patchPath) !== patchHash) throw new Error(`Patch SHA-256 mismatch: ${patchPath}`);
const inspected = inspectTarget(options.target ?? defaultTarget());
const desiredState =
  options.command === "apply" ? "patched" : options.command === "rollback" ? "baseline" : undefined;
const target = desiredState ? transition(inspected, desiredState) : inspected;
const result = { command: options.command, patchHash, target };
if (options.json) console.log(JSON.stringify(result, null, 2));
else console.log(`pi-antigravity ${target.version}: ${target.state}${target.changed ? " (changed)" : ""}`);
if (options.command === "status" && target.state !== "patched") process.exitCode = 1;
