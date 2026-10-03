#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  resolvePiAgentDir,
  resolvePiChildCompactionExtensions,
} from "./pi_compaction_extension_profile.mjs";

export const PI_CHILD_PUBLISH_GATE = "pi-child-publish-gate/v2";
export const PI_AGENT_SETTINGS_FILE = "settings.json";
export const PI_AGENT_TRUST_FILE = "trust.json";

export const EXPECTED_SHARED_SETTINGS = Object.freeze({
  "compaction.enabled": false,
  "retry.enabled": true,
  "retry.baseDelayMs": 2000,
  "retry.provider.maxRetries": 0,
});

function readJsonObject(file, read = readFileSync) {
  let parsed;
  try {
    parsed = JSON.parse(read(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error?.message ?? error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed;
}

function readValue(source, dottedKey) {
  return dottedKey.split(".").reduce((current, part) => (
    current && typeof current === "object" && !Array.isArray(current) ? current[part] : undefined
  ), source);
}

function localPackageDirectory(file) {
  const parts = path.resolve(String(file || "")).split(path.sep);
  const index = parts.lastIndexOf("local-packages");
  if (index < 0 || index + 1 >= parts.length) return null;
  return parts.slice(0, index + 2).join(path.sep);
}

function packageNameFromPackageJson(packageDir, exists, read) {
  const packageJson = path.join(packageDir, "package.json");
  if (!exists(packageJson)) return null;
  try {
    const parsed = JSON.parse(read(packageJson, "utf8"));
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    return name || null;
  } catch {
    return null;
  }
}

function packageNameFromExtension(file, exists = existsSync, read = readFileSync) {
  const packageDir = localPackageDirectory(file);
  if (packageDir) return packageNameFromPackageJson(packageDir, exists, read);
  const normalized = String(file || "").replaceAll("\\", "/");
  const marker = "/npm/node_modules/";
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return null;
  const rest = normalized.slice(index + marker.length);
  const [name] = rest.split("/");
  // npm 路径只认 midrun；写手由本地恢复包的 package.json name 识别。
  return name === "pi-midrun-compact" ? name : null;
}

export function runPiChildPublishGate(options = {}) {
  const env = options.env || process.env;
  const exists = options.exists || existsSync;
  const read = options.read || readFileSync;
  const mode = options.mode === "postflight" ? "postflight" : "preflight";
  const agentDir = path.resolve(options.agentDir || resolvePiAgentDir(env));
  const settingsPath = path.join(agentDir, PI_AGENT_SETTINGS_FILE);
  const trustPath = path.join(agentDir, PI_AGENT_TRUST_FILE);
  const errors = [];

  const result = {
    gate: PI_CHILD_PUBLISH_GATE,
    mode,
    agent_dir: agentDir,
    settings_path: settingsPath,
    trust_path: trustPath,
    extensions: [],
    errors,
  };

  if (!exists(settingsPath)) errors.push(`${settingsPath} is missing`);
  if (!exists(trustPath)) errors.push(`${trustPath} is missing`);
  if (errors.length > 0) {
    return { ...result, ok: false };
  }

  let settings;
  try {
    settings = readJsonObject(settingsPath, read);
  } catch (error) {
    errors.push(String(error.message || error));
    return { ...result, ok: false };
  }

  for (const [key, expected] of Object.entries(EXPECTED_SHARED_SETTINGS)) {
    const actual = readValue(settings, key);
    if (actual !== expected) {
      errors.push(`${PI_AGENT_SETTINGS_FILE} ${key}=${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }

  const extensions = resolvePiChildCompactionExtensions({ agentDir, env, exists });
  result.extensions = extensions;
  const names = new Set(extensions.map((file) => packageNameFromExtension(file, exists, read)));
  for (const required of ["pi-compaction-model", "pi-midrun-compact"]) {
    if (!names.has(required)) errors.push(`missing compaction extension package ${required}`);
  }

  return { ...result, ok: errors.length === 0 };
}

function parseCli(argv) {
  const allowed = new Set(["--json", "--preflight", "--postflight", "--agent-dir"]);
  const unknown = argv.filter((value, index) => !allowed.has(value) && argv[index - 1] !== "--agent-dir");
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);
  const preflight = argv.includes("--preflight");
  const postflight = argv.includes("--postflight");
  if (preflight === postflight) throw new Error("exactly one of --preflight or --postflight is required");
  const agentIndex = argv.indexOf("--agent-dir");
  return {
    mode: postflight ? "postflight" : "preflight",
    agentDir: agentIndex >= 0 ? argv[agentIndex + 1] : undefined,
  };
}

if (path.basename(String(process.argv[1] || "")).toLowerCase() === "pi_child_publish_gate.mjs") {
  try {
    const parsed = parseCli(process.argv.slice(2));
    const result = runPiChildPublishGate(parsed);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 2;
  } catch (error) {
    process.stderr.write(`Usage: node ops/tools/pi_child_publish_gate.mjs --preflight|--postflight [--json] [--agent-dir <dir>]\n${error?.message ?? error}\n`);
    process.exitCode = 2;
  }
}
