import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolRoot = dirname(fileURLToPath(import.meta.url));
const canonicalPath = join(toolRoot, "transcript-compat.ts");
const backupRoot = join(toolRoot, "..", "..", ".runtime", "pi-transcript-hydrate-backups");

export const legacyTargets = [
  {
    id: "pi-claude-code-provider",
    legacy: true,
    canonicalPath: join(toolRoot, "claude-transcript-compat.ts"),
    root: join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-claude-code-provider"),
    compatRel: join("src", "transcript-compat.ts"),
    hookFiles: [join("src", "provider.ts"), join("src", "context-serializer.ts")],
  },
];

// Only consumers that still import our helper participate in default maintenance.
export const targets = [
  {
    id: "@tian.zuo/pi-antigravity",
    root: join(homedir(), ".pi", "agent", "npm", "node_modules", "@tian.zuo", "pi-antigravity"),
    compatRel: join("src", "transcript-compat.ts"),
    hookFiles: [join("src", "provider.ts")],
  },
];

export function canonicalSource(target) {
  return readFileSync(target?.canonicalPath ?? canonicalPath, "utf8");
}

export function inspectTarget(target, rootOverride) {
  const root = rootOverride ?? target.root;
  const compat = join(root, target.compatRel);
  const source = existsSync(compat) ? readFileSync(compat, "utf8") : "";
  const missingHooks = target.hookFiles.filter((rel) => {
    const path = join(root, rel);
    if (!existsSync(path)) return true;
    const text = readFileSync(path, "utf8");
    return !text.includes('from "./transcript-compat.ts"') || !text.includes("hydrateContext(");
  });
  return {
    id: target.id,
    root,
    present: existsSync(root),
    compatMatches: source === canonicalSource(target),
    missingHooks,
  };
}

function backupFile(id, rel, text, root) {
  const dest = join(root, id.replaceAll("/", "_"), rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  return dest;
}

export function applyTarget(target, rootOverride, backupOverride = backupRoot) {
  const info = inspectTarget(target, rootOverride);
  if (!info.present) throw new Error(`package missing: ${info.root}`);
  if (info.missingHooks.length) {
    throw new Error(`${target.id} missing hydrateContext hooks: ${info.missingHooks.join(", ")}`);
  }
  const dest = join(info.root, target.compatRel);
  if (existsSync(dest)) backupFile(target.id, target.compatRel, readFileSync(dest, "utf8"), backupOverride);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(target.canonicalPath ?? canonicalPath, dest);
  const after = inspectTarget(target, rootOverride);
  if (!after.compatMatches) throw new Error(`${target.id} write verify failed`);
  return after;
}

export function selectTargets(ids = []) {
  if (!ids.length) return targets;
  return [...new Set(ids)].map(id => {
    const target = [...targets, ...legacyTargets].find(item => item.id === id);
    if (!target) throw new Error(`unknown target: ${id}`);
    return target;
  });
}

export function parseArgs(args) {
  const command = args[0] ?? "status";
  const ids = [];
  if (!["status", "apply", "verify"].includes(command)) throw new Error(`unknown command: ${command}`);
  for (let i = 1; i < args.length; i++) {
    if (args[i] !== "--target" || !args[i + 1]) {
      throw new Error("usage: node tools/pi-transcript-hydrate/apply.mjs status|apply|verify [--target <id>]");
    }
    ids.push(args[++i]);
  }
  return { command, selected: selectTargets(ids) };
}

export function runTargets(command, selected = targets, rootOverrides = new Map(), backupOverride = backupRoot) {
  const reports = selected.map(target => command === "apply"
    ? applyTarget(target, rootOverrides.get(target.id), backupOverride)
    : inspectTarget(target, rootOverrides.get(target.id)));
  const ok = command !== "verify" || reports.every(item => item.present && item.compatMatches && !item.missingHooks.length);
  return { ok, command, reports };
}

function runCli() {
  try {
    const { command, selected } = parseArgs(process.argv.slice(2));
    const result = runTargets(command, selected);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) runCli();
