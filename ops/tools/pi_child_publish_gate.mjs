#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  PI_CHILD_COMPACTION_PACKAGES,
  resolvePiChildCompactionPackages,
} from "./pi_compaction_extension_profile.mjs";
import { resolvePiAgentDir } from "./pi_settings_packages.mjs";

export const PI_CHILD_PUBLISH_GATE = "pi-child-publish-gate/v2";
export const PI_AGENT_SETTINGS_FILE = "settings.json";
export const PI_AGENT_TRUST_FILE = "trust.json";

export const EXPECTED_SHARED_SETTINGS = Object.freeze({
  "compaction.enabled": false,
  "retry.enabled": true,
  "retry.baseDelayMs": 2000,
  "retry.provider.maxRetries": 0,
});

function readJsonObject(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
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

export function runPiChildPublishGate(options = {}) {
  const env = options.env || process.env;
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

  if (!existsSync(settingsPath)) errors.push(`${settingsPath} is missing`);
  if (!existsSync(trustPath)) errors.push(`${trustPath} is missing`);
  if (errors.length > 0) {
    return { ...result, ok: false };
  }

  let settings;
  try {
    settings = readJsonObject(settingsPath);
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

  const packages = resolvePiChildCompactionPackages({ agentDir, env });
  result.extensions = packages.flatMap((item) => item.extensions);
  const names = new Set(packages.map((item) => item.name));
  for (const required of PI_CHILD_COMPACTION_PACKAGES) {
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
