#!/usr/bin/env node
// Local patch for pi-claude-code-provider 0.6.0: status | apply | rollback [--target <package dir>]
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.6.0";
const PATCH = join(dirname(fileURLToPath(import.meta.url)), `pi-claude-code-provider-${VERSION}.patch`);
// Same table shape the provider's doctor reads (src/claude-models.ts).
const ALIAS_ENTRY = String.raw`(?:sonnet|opus|haiku|fable):\{default:"[A-Za-z0-9._-]{1,64}"(?:,per_provider:\{[^{}]{0,512}\})?\}`;
const TABLE = new RegExp(String.raw`\baliases:\{(${ALIAS_ENTRY}(?:,${ALIAS_ENTRY}){0,7})\}`, "g");
const ALIAS = /\b(sonnet|opus|haiku|fable):\{default:"([A-Za-z0-9._-]{1,64})"/g;

export function defaultTarget(env = process.env) {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "npm", "node_modules", "pi-claude-code-provider");
}

function gitApply(target, ...flags) {
  return spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", ...flags, PATCH], {
    cwd: target,
    encoding: "utf8",
    windowsHide: true,
    // Without a ceiling, a target inside a Git work tree is patched relative to that tree's root.
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(target) },
  });
}

export function patchState(target) {
  if (gitApply(target, "--reverse", "--check").status === 0) return "patched";
  if (gitApply(target, "--check").status === 0) return "baseline";
  return "unknown";
}

export function offeredModels(target) {
  const source = readFileSync(join(target, "src", "catalog.ts"), "utf8");
  return [...source.matchAll(/providerModel\("([^"]+)"/g)].map((match) => match[1]);
}

/** The model each alias resolves to, from the alias table embedded in the Claude Code executable. */
export function servedModels(executable) {
  const found = new Map();
  const fd = openSync(executable, "r");
  try {
    const buffer = Buffer.alloc(8 << 20);
    let tail = "";
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
      const text = tail + buffer.toString("latin1", 0, read);
      for (const [, entries] of text.matchAll(TABLE)) {
        for (const [, alias, model] of entries.matchAll(ALIAS)) found.set(alias, (found.get(alias) ?? new Set()).add(model));
      }
      tail = text.slice(-8192);
    }
  } finally {
    closeSync(fd);
  }
  // Two different values for one alias mean the table changed shape; report nothing for it.
  return Object.fromEntries([...found].filter(([, models]) => models.size === 1).map(([alias, models]) => [alias, [...models][0]]));
}

export function status(target, env = process.env) {
  let version;
  try {
    version = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version;
  } catch {
    return { target, installed: false };
  }
  const offered = offeredModels(target);
  const result = { target, installed: true, version, patch: patchState(target), offered };
  const executable = env.PI_CLAUDE_CODE_PROVIDER_PATH?.trim();
  if (!executable) return { ...result, claude: "PI_CLAUDE_CODE_PROVIDER_PATH is not set" };
  const claude = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true });
  const served = servedModels(executable);
  // A pinned id that no longer matches its alias is a model Claude Code has moved past.
  const stale = Object.entries(served).flatMap(([alias, model]) => {
    const id = offered.find((candidate) => candidate.startsWith(`claude-${alias}-`));
    return id && id !== model ? [{ alias, offered: id, served: model }] : [];
  });
  return { ...result, claude: { executable, version: claude.stdout?.trim() || claude.error?.message }, served, stale };
}

function change(target, desired) {
  const before = status(target);
  if (!before.installed) throw new Error(`pi-claude-code-provider is not installed at ${target}`);
  if (before.version !== VERSION) throw new Error(`patch targets ${VERSION}; installed version is ${before.version}`);
  if (before.patch === "unknown") throw new Error("the patched files match neither upstream 0.6.0 nor the patch; reinstall the package first");
  if (before.patch !== desired) {
    const result = gitApply(target, ...(desired === "baseline" ? ["--reverse"] : []));
    if (result.status !== 0) throw new Error(result.stderr.trim() || "git apply failed");
  }
  return { ...status(target), changed: before.patch !== desired, note: "Restart Pi and Pi Web to load the change" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const targetIndex = rest.indexOf("--target");
  const target = resolve(targetIndex >= 0 ? rest[targetIndex + 1] : defaultTarget());
  const actions = { status: () => status(target), apply: () => change(target, "patched"), rollback: () => change(target, "baseline") };
  if (!actions[command]) {
    process.stderr.write("Usage: node manage.mjs <status|apply|rollback> [--target <package dir>]\n");
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(actions[command](), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
