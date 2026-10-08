#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { transformOpenAICodexBundle } from "./bundle-transform.mjs";

const toolRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(toolRoot, "..", "..");
const piAiPatchPath = join(toolRoot, "pi-ai-ws-recovery-0.84.1-0.84.4.patch");
const piAiPatchHash = "75d9ebc4234afbfc6d5e2f766ec3f8450a11e2a1db7782db1514b838d85cf1d1";
const piAiPatch086Path = join(toolRoot, "pi-ai-ws-recovery-0.86.0.patch");
const piAiPatch086Hash = "eb210996965466f52e4143edd3d9981109476e6a89e33dad4c50b714a485b968";
const piAiPatch0871Path = join(toolRoot, "pi-ai-ws-recovery-0.87.1.patch");
const piAiPatch0871Hash = "eb210996965466f52e4143edd3d9981109476e6a89e33dad4c50b714a485b968";
const bundleTransformPath = join(toolRoot, "bundle-transform.mjs");
const bundleTransformHash = "e5bc7fe3f4b8f412fc9b77f4adbb10181777c23010f2963d76d57f8a70caf063";
const piAiFiles = ["dist/api/openai-codex-responses.js", "dist/api/openai-codex-responses.d.ts"];

function modularPatchFor(version) {
  if (version === "0.87.1") {
    return { path: piAiPatch0871Path, hash: piAiPatch0871Hash };
  }
  if (version === "0.86.0") {
    return { path: piAiPatch086Path, hash: piAiPatch086Hash };
  }
  return { path: piAiPatchPath, hash: piAiPatchHash };
}

const piAiHashes = {
  "0.87.1": {
    "dist/api/openai-codex-responses.js": {
      baseline: "6e69310d77278231cfc87d7f03ee815d4a0f2ff273e6c43fcee6835e7df2b0c7",
      patched: "c885af5b4bf4b83ac12c18f2428be3020563fa9f0a0ec7e898a976e069b480da",
    },
    "dist/api/openai-codex-responses.d.ts": {
      baseline: "a1e45bf4733690b417c463f450c36c0c42b8060cfa14213b9281c0d35770d030",
      patched: "918c7c4bc55aba012744c9f7b9bb1e14f29e26616e8d5853037009298688a077",
    },
  },
  "0.86.0": {
    "dist/api/openai-codex-responses.js": {
      baseline: "6e69310d77278231cfc87d7f03ee815d4a0f2ff273e6c43fcee6835e7df2b0c7",
      patched: "c885af5b4bf4b83ac12c18f2428be3020563fa9f0a0ec7e898a976e069b480da",
    },
    "dist/api/openai-codex-responses.d.ts": {
      baseline: "a1e45bf4733690b417c463f450c36c0c42b8060cfa14213b9281c0d35770d030",
      patched: "918c7c4bc55aba012744c9f7b9bb1e14f29e26616e8d5853037009298688a077",
    },
  },
  "0.85.1": {
    "dist/api/openai-codex-responses.js": {
      baseline: "f5705d45ae72102110238d6265a548df3aef50b777f654f1f91a32d563c91b3e",
      patched: "e9f3a35baeba60e55273c713a44c340efebb06c650780bcf3681bad6416620a1",
    },
    "dist/api/openai-codex-responses.d.ts": {
      baseline: "a1e45bf4733690b417c463f450c36c0c42b8060cfa14213b9281c0d35770d030",
      patched: "918c7c4bc55aba012744c9f7b9bb1e14f29e26616e8d5853037009298688a077",
    },
  },
  "0.84.1": {
    "dist/api/openai-codex-responses.js": {
      baseline: "f0699749b06045244fd6ced26aee4f2627e7218199fd2955b0003fe08592aead",
      patched: "02d5a4a6ae187c6ddb1f9a460f0a1a81a14f21bbeaa4406a7a8ceb9f61af170e",
    },
    "dist/api/openai-codex-responses.d.ts": {
      baseline: "a1e45bf4733690b417c463f450c36c0c42b8060cfa14213b9281c0d35770d030",
      patched: "918c7c4bc55aba012744c9f7b9bb1e14f29e26616e8d5853037009298688a077",
    },
  },
  "0.84.3": {
    "dist/api/openai-codex-responses.js": {
      baseline: "0a6904d4869a09a2d9b4144f3364b575306bede11647835dddd9d80032a7f53e",
      patched: "5190962515f2de7ee55a9b752b4fd809fe19e32e9a5a1b5046e03701ca645871",
    },
    "dist/api/openai-codex-responses.d.ts": {
      baseline: "a1e45bf4733690b417c463f450c36c0c42b8060cfa14213b9281c0d35770d030",
      patched: "918c7c4bc55aba012744c9f7b9bb1e14f29e26616e8d5853037009298688a077",
    },
  },
  "0.84.4": {
    "dist/api/openai-codex-responses.js": {
      baseline: "0a6904d4869a09a2d9b4144f3364b575306bede11647835dddd9d80032a7f53e",
      patched: "5190962515f2de7ee55a9b752b4fd809fe19e32e9a5a1b5046e03701ca645871",
    },
    "dist/api/openai-codex-responses.d.ts": {
      baseline: "a1e45bf4733690b417c463f450c36c0c42b8060cfa14213b9281c0d35770d030",
      patched: "918c7c4bc55aba012744c9f7b9bb1e14f29e26616e8d5853037009298688a077",
    },
  },
};

const bundleHashes = Object.fromEntries(
  ["0.84.3", "0.84.4"].map((version) => [
    version,
    {
      "dist/bundle/chunks/openai-codex-responses-GJVBJXLB.js": {
        baseline: "76aa6d2dc53ec549efa299e67585a45c659581458fbc798bd800f2a28f64d1e7",
        patched: "0e17c808ae911d02c96f5233c04869235dcd845e4aef9edc0d7398272c7b7713",
      },
    },
  ]),
);

bundleHashes["0.85.1"] = {
  "dist/bundle/chunks/openai-codex-responses-R6VYZTVY.js": {
    baseline: "c13b23c9799a1ec70a91e0b6a8c794e50c80fb2802593f0441199506168057df",
    patched: "1f797599d5a782145a74f08652c90d7016ea8eb46ebff90b607e614351d4b269",
  },
};
bundleHashes["0.86.0"] = {
  "dist/bundle/chunks/openai-codex-responses-QDSOTBBO.js": {
    baseline: "cec5815a36e82be42749ba6691e0b3d444bed940776b484f2fa26da22abe979b",
    patched: "dd1d626e69f039aa20bcc4853c8da9ab7fe2758a5cb2eb127c8eb4dbd66f39ec",
  },
};
bundleHashes["0.87.1"] = {
  "dist/bundle/chunks/openai-codex-responses-QDSOTBBO.js": {
    baseline: "cec5815a36e82be42749ba6691e0b3d444bed940776b484f2fa26da22abe979b",
    patched: "dd1d626e69f039aa20bcc4853c8da9ab7fe2758a5cb2eb127c8eb4dbd66f39ec",
  },
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function parseArgs(argv) {
  const command = argv[0] ?? "status";
  if (!new Set(["status", "apply", "rollback"]).has(command)) {
    throw new Error("Usage: node manage-pi-ws-recovery.mjs [status|apply|rollback] [--json] [--target label=pi-ai-directory] [--bundle-target label=pi-coding-agent-directory]");
  }
  const targets = [];
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--target" || arg === "--bundle-target") {
      const value = argv[++index];
      if (!value?.includes("=")) throw new Error(`${arg} requires label=package-directory`);
      const separator = value.indexOf("=");
      targets.push({
        kind: arg === "--bundle-target" ? "bundle" : "pi-ai",
        label: value.slice(0, separator),
        packageDirectory: resolve(value.slice(separator + 1)),
      });
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { command, json, targets };
}

function installedPiAiRoot(parentRoot) {
  for (let current = parentRoot; ; current = dirname(current)) {
    const candidate = join(current, "node_modules", "@earendil-works", "pi-ai");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(current) === current) break;
  }
  throw new Error(`pi-ai dependency not found from ${parentRoot}`);
}

function defaultTargets() {
  const npmRoot = process.env.PI_GLOBAL_NPM_ROOT
    || join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm", "node_modules");
  const piWebRoot = process.env.PI_WEB_APP_ROOT || "E:\\ControlPlane\\web\\app";
  const subagentRoot = process.env.PI_SUBAGENT_ADAPTER_ROOT
    || join(homedir(), ".pi", "agent", "extensions", "subagent-control", "adapters", "pi");
  const globalPiRoot = join(npmRoot, "@earendil-works", "pi-coding-agent");
  const piWebAgentRoot = join(piWebRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const workerAgentRoot = join(subagentRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  return [
    {
      kind: "bundle",
      label: "global-terminal-pi",
      packageDirectory: globalPiRoot,
    },
    {
      kind: "pi-ai",
      label: "global-terminal-pi-modular",
      packageDirectory: installedPiAiRoot(globalPiRoot),
    },
    {
      kind: "pi-ai",
      label: "pi-web-root",
      packageDirectory: join(piWebRoot, "node_modules", "@earendil-works", "pi-ai"),
    },
    {
      kind: "pi-ai",
      label: "pi-web-coding-agent",
      packageDirectory: installedPiAiRoot(piWebAgentRoot),
    },
    {
      kind: "bundle",
      label: "pi-web-rpc-bundle",
      packageDirectory: piWebAgentRoot,
    },
    {
      kind: "pi-ai",
      label: "subagent-worker-root",
      packageDirectory: join(subagentRoot, "node_modules", "@earendil-works", "pi-ai"),
    },
    {
      kind: "pi-ai",
      label: "subagent-worker-coding-agent",
      packageDirectory: installedPiAiRoot(workerAgentRoot),
    },
    ...(existsSync(join(workerAgentRoot, "dist", "bundle", "cli.js")) ? [{
      kind: "bundle",
      label: "subagent-worker-bundle",
      packageDirectory: workerAgentRoot,
    }] : []),
  ];
}

function profileFor(kind, version) {
  if (version === "0.99.1") {
    const manifest = JSON.parse(readFileSync(join(toolRoot, "manifest-0.99.1.json"), "utf8"));
    const prefix = kind === "pi-ai" ? "node_modules/@earendil-works/pi-ai/" : "";
    const entries = manifest.files.filter((entry) => kind === "pi-ai"
      ? entry.path.startsWith(prefix) : entry.path.startsWith("dist/bundle/"));
    return { files: entries.map((entry) => entry.path.slice(prefix.length)),
      hashes: Object.fromEntries(entries.map((entry) => [entry.path.slice(prefix.length), { baseline: entry.before, patched: entry.after }])),
      transform: "payload", prefix, payloadSha256: manifest.payloadSha256 };
  }
  if (kind === "pi-ai") {
    const hashes = piAiHashes[version];
    if (!hashes) throw new Error(`unsupported pi-ai version ${version}`);
    return { files: piAiFiles, hashes, transform: "patch" };
  }
  if (kind === "bundle") {
    const hashes = bundleHashes[version];
    if (!hashes) throw new Error(`unsupported pi-coding-agent bundle version ${version}`);
    return { files: Object.keys(hashes), hashes, transform: "bundle" };
  }
  throw new Error(`unsupported target kind ${kind}`);
}

function inspectBundleEntrypoints(packageDirectory, packageJson) {
  const binEntry = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.pi;
  const cliPath = typeof binEntry === "string" ? join(packageDirectory, binEntry) : undefined;
  const cli = cliPath && existsSync(cliPath) ? readFileSync(cliPath, "utf8") : "";
  const activeRuntime = cli.includes('import "../cli.js"')
    ? "modular-redirect"
    : cli.includes("./chunks/") || (cli.includes("./cli-runtime.js") && existsSync(join(packageDirectory, "dist/bundle/cli-runtime.js")))
      ? "bundled"
      : "unknown";
  const rpcEntry = packageJson.exports?.["./rpc-entry"]?.import;
  return { binEntry, activeRuntime, rpcEntry };
}

function inspectTarget(target) {
  const packageJsonPath = join(target.packageDirectory, "package.json");
  if (!existsSync(packageJsonPath)) throw new Error(`${target.label}: package not found at ${target.packageDirectory}`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const version = packageJson.version;
  if (target.expectedVersion && version !== target.expectedVersion) {
    throw new Error(`${target.label}: expected ${target.kind} ${target.expectedVersion}, found ${version}`);
  }
  if (version === "0.99.1") {
    const combined = JSON.parse(readFileSync(join(toolRoot, "../pi-codex-attribution/manifest-0.99.1.json"), "utf8"));
    const overlay = JSON.parse(readFileSync(join(toolRoot, "../pi-prompt-stability/manifest-0.99.1.json"), "utf8")).host.files;
    const prefix = target.kind === "pi-ai" ? "node_modules/@earendil-works/pi-ai/" : "";
    const select = (entry) => target.kind === "pi-ai" ? entry.path.startsWith(prefix) : entry.path.startsWith("dist/bundle/");
    const entries = combined.files.filter(select);
    const hashes = Object.fromEntries([...entries, ...overlay.filter(select)].map((entry) => {
      const file = entry.path.slice(prefix.length);
      return [file, existsSync(join(target.packageDirectory, file)) ? sha256File(join(target.packageDirectory, file)) : null];
    }));
    const plain = Object.fromEntries(entries.map((entry) => [entry.path.slice(prefix.length), entry.after]));
    const overlaid = { ...plain, ...Object.fromEntries(overlay.filter(select).map((entry) => [entry.path.slice(prefix.length), entry.after])) };
    if ([plain, overlaid].some((expected) => Object.entries(expected).every(([file, hash]) => hashes[file] === hash))) {
      return { ...target, version, hashes, state: "patched", combinedPatch: "codex-attribution-9488",
        ...(target.kind === "bundle" ? inspectBundleEntrypoints(target.packageDirectory, packageJson) : {}) };
    }
  }
  // The attribution build already contains WS recovery. Verify its pinned
  // outputs rather than trying to apply the old provider-only diff again.
  if (version === "0.87.1") {
    const combined = JSON.parse(readFileSync(join(toolRoot, "../pi-codex-attribution/manifest.json"), "utf8"));
    const prefix = target.kind === "pi-ai" ? "node_modules/@earendil-works/pi-ai/" : "";
    const entries = combined.files.filter((entry) => target.kind === "pi-ai"
      ? entry.path.startsWith(`${prefix}dist/api/`)
      : entry.path.startsWith("dist/bundle/"));
    const marker = entries.find((entry) => entry.before === null);
    if (marker && existsSync(join(target.packageDirectory, marker.path.slice(prefix.length)))) {
      const hashes = Object.fromEntries(entries.map((entry) => {
        const file = entry.path.slice(prefix.length);
        const path = join(target.packageDirectory, file);
        return [file, existsSync(path) ? sha256File(path) : null];
      }));
      // The prompt-stability rebuild keeps WS recovery but replaces some bundle outputs.
      const overlayPath = join(toolRoot, "../pi-prompt-stability/manifest.json");
      const overlay = existsSync(overlayPath)
        ? new Map(JSON.parse(readFileSync(overlayPath, "utf8")).host.files.map((entry) => [entry.path, entry.after]))
        : new Map();
      const current = (entry) => hashes[entry.path.slice(prefix.length)];
      return { ...target, version, hashes, combinedPatch: "codex-attribution-9488",
        state: entries.every((entry) => current(entry) === entry.after || current(entry) === overlay.get(entry.path)) ? "patched" : "unknown" };
    }
  }
  let profile;
  try {
    profile = profileFor(target.kind, version);
  } catch (error) {
    throw new Error(`${target.label}: ${error.message}`);
  }
  const hashes = Object.fromEntries(
    profile.files.map((file) => {
      const path = join(target.packageDirectory, file);
      if (!existsSync(path)) {
        if (profile.transform === "payload") return [file, null];
        throw new Error(`${target.label}: missing ${file}`);
      }
      return [file, sha256File(path)];
    }),
  );
  const matches = (state) => profile.files.every((file) => hashes[file] === profile.hashes[file][state]);
  const state = matches("baseline") ? "baseline" : matches("patched") ? "patched" : "unknown";
  const entrypoints = target.kind === "bundle" ? inspectBundleEntrypoints(target.packageDirectory, packageJson) : {};
  return {
    ...target,
    packageDirectory: realpathSync(target.packageDirectory),
    version,
    hashes,
    state,
    ...entrypoints,
  };
}

function transformedFiles(target, desiredState) {
  const profile = profileFor(target.kind, target.version);
  if (profile.transform === "payload") {
    const packed = readFileSync(join(projectRoot, ".runtime/pi-codex-attribution/0.99.1/ws-payload.json.gz"));
    if (sha256(packed) !== profile.payloadSha256) throw new Error("WS payload hash mismatch");
    const payload = JSON.parse(gunzipSync(packed).toString("utf8"))[desiredState];
    return Object.fromEntries(profile.files.map((file) => [file,
      payload[profile.prefix + file] === undefined ? null : Buffer.from(payload[profile.prefix + file], "base64")]));
  }
  if (profile.transform === "bundle") {
    const file = profile.files[0];
    const source = readFileSync(join(target.packageDirectory, file), "utf8");
    return { [file]: Buffer.from(transformOpenAICodexBundle(source, desiredState), "utf8") };
  }

  const scratch = mkdtempSync(join(tmpdir(), "pi-ws-recovery-"));
  try {
    for (const file of profile.files) {
      const source = join(target.packageDirectory, file);
      const destination = join(scratch, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
    const modularPatch = modularPatchFor(target.version);
    const result = spawnSync(
      "git",
      ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", ...(desiredState === "baseline" ? ["--reverse"] : []), modularPatch.path],
      { cwd: scratch, encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) {
      throw new Error([result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n") || "git apply failed");
    }
    return Object.fromEntries(profile.files.map((file) => [file, readFileSync(join(scratch, file))]));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function backupTarget(target) {
  const profile = profileFor(target.kind, target.version);
  const backupRoot = target.version === "0.99.1"
    ? join(projectRoot, ".runtime/pi-codex-attribution/0.99.1/ws-backups", sha256(target.packageDirectory.toLowerCase()).slice(0, 16), target.state)
    : join(projectRoot, ".runtime", "pi-ws-recovery-backups", target.label, target.version, target.state);
  mkdirSync(backupRoot, { recursive: true });
  for (const file of profile.files) {
    const destination = join(backupRoot, file.replaceAll("/", "__"));
    if (!existsSync(destination) && existsSync(join(target.packageDirectory, file))) copyFileSync(join(target.packageDirectory, file), destination);
  }
  return backupRoot;
}

function transition(target, desiredState) {
  if (target.state === desiredState) return { ...target, changed: false };
  if (target.combinedPatch) {
    throw new Error(`${target.label}: use tools/pi-codex-attribution/manage.py rollback for the combined patch`);
  }
  const sourceState = desiredState === "patched" ? "baseline" : "patched";
  if (target.state !== sourceState) {
    throw new Error(`${target.label}: refusing unknown hashes ${JSON.stringify(target.hashes)}`);
  }
  const profile = profileFor(target.kind, target.version);
  const outputs = transformedFiles(target, desiredState);
  for (const file of profile.files) {
    const actual = outputs[file] === null ? null : sha256(outputs[file]);
    if (actual !== profile.hashes[file][desiredState]) {
      throw new Error(`${target.label}: transformed ${file} hash ${actual}, expected ${profile.hashes[file][desiredState]}`);
    }
  }
  const backup = backupTarget(target);
  for (const file of profile.files) {
    const path = join(target.packageDirectory, file);
    if (outputs[file] === null) { if (existsSync(path)) unlinkSync(path); }
    else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, outputs[file]); }
  }
  const after = inspectTarget(target);
  if (after.state !== desiredState) throw new Error(`${target.label}: write verification found ${after.state}`);
  return { ...after, changed: true, backup };
}

function format(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const target of result.targets) {
    const runtime = target.activeRuntime ? `, runtime ${target.activeRuntime}` : "";
    console.log(`${target.label}: ${target.kind} ${target.version}, ${target.state}${runtime}${target.changed ? " (changed)" : ""}`);
  }
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync(piAiPatchPath)) throw new Error(`Patch file missing: ${piAiPatchPath}`);
if (sha256File(piAiPatchPath) !== piAiPatchHash) throw new Error(`Patch SHA-256 mismatch: ${piAiPatchPath}`);
if (!existsSync(piAiPatch086Path)) throw new Error(`Patch file missing: ${piAiPatch086Path}`);
if (sha256File(piAiPatch086Path) !== piAiPatch086Hash) throw new Error(`Patch SHA-256 mismatch: ${piAiPatch086Path}`);
if (!existsSync(piAiPatch0871Path)) throw new Error(`Patch file missing: ${piAiPatch0871Path}`);
if (sha256File(piAiPatch0871Path) !== piAiPatch0871Hash) throw new Error(`Patch SHA-256 mismatch: ${piAiPatch0871Path}`);
if (sha256File(bundleTransformPath) !== bundleTransformHash) {
  throw new Error(`Bundle transform SHA-256 mismatch: ${bundleTransformPath}`);
}
const configuredTargets = options.targets.length > 0 ? options.targets : defaultTargets();
const seen = new Set();
const inspected = [];
for (const target of configuredTargets) {
  const item = inspectTarget(target);
  const identity = `${item.kind}:${item.packageDirectory.toLowerCase()}`;
  if (seen.has(identity)) continue;
  seen.add(identity);
  inspected.push(item);
}
const desiredState = options.command === "apply" ? "patched" : options.command === "rollback" ? "baseline" : undefined;
const targets = desiredState ? inspected.map((target) => transition(target, desiredState)) : inspected;
const result = { command: options.command, piAiPatchHash, bundleTransformHash, targets };
format(result, options.json);
if (options.command === "status" && targets.some((target) => target.state !== "patched")) process.exitCode = 1;
