import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const packageName = "@local/pi-antigravity-native";
const upstreamName = "@tian.zuo/pi-antigravity";
const defaultRuntime = join(root, ".runtime", "pi-antigravity-native");
const defaultSettings = join(homedir(), ".pi", "agent", "settings.json");
const defaultSource = join(homedir(), ".pi", "agent", "npm", "node_modules", "@tian.zuo", "pi-antigravity");
const defaultDevelopmentSource = join(root, "packages", "pi-antigravity-native");
const backupPath = join(root, ".runtime", "pi-antigravity-native-install.json");
const patchPath = join(root, "tools", "pi-antigravity", "pi-antigravity-0.10.3-native.patch");
const hash = (content) => createHash("sha256").update(content).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const sourceOf = (entry) => typeof entry === "string" ? entry : entry?.source;
const normalized = (p) => resolve(p).replaceAll("\\", "/").toLowerCase();
const isUpstream = (entry) => /^npm:@tian\.zuo\/pi-antigravity(?:@[^/]+)?$/.test(sourceOf(entry) ?? "");
const isNative = (entry, runtime) => typeof sourceOf(entry) === "string" && !sourceOf(entry).startsWith("npm:") && normalized(sourceOf(entry)) === normalized(runtime);

function copyTree(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (["node_modules", ".git", ".trial-manifest.json", "trial-manifest.json", "native-manifest.json"].includes(entry.name)) continue;
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

function packageFiles(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "native-manifest.json") return [];
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return packageFiles(file, base);
    return [relative(base, file).replaceAll("\\", "/")];
  }).sort();
}

export function sealNativePackage(runtime) {
  const pkg = readJson(join(runtime, "package.json"));
  if (pkg.name !== packageName) throw new Error(`Expected ${packageName}, found ${pkg.name}`);
  const files = Object.fromEntries(packageFiles(runtime).map((name) => [name, hash(readFileSync(join(runtime, name)))]));
  const manifest = { name: packageName, version: pkg.version, upstreamVersion: "0.10.3", systemMode: "pi-effective-system-to-agent", toolMode: "pi-host-toolUse", files };
  writeFileSync(join(runtime, "native-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export function inspectNativePackage(runtime) {
  const file = join(runtime, "native-manifest.json");
  if (!existsSync(file)) return { runtime, state: "not-built" };
  const manifest = readJson(file);
  const missing = [], changed = [];
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!existsSync(join(runtime, name))) missing.push(name);
    else if (hash(readFileSync(join(runtime, name))) !== expected) changed.push(name);
  }
  const unexpected = packageFiles(runtime).filter((name) => !Object.hasOwn(manifest.files, name));
  return { runtime: realpathSync(runtime), state: missing.length || changed.length || unexpected.length ? "changed" : "ready", version: manifest.version, systemMode: manifest.systemMode, toolMode: manifest.toolMode, missing, changed, unexpected };
}

export function linkNativeDependencies(runtime) {
  const pkg = readJson(join(runtime, "package.json"));
  const shared = join(homedir(), ".pi", "agent", "npm", "node_modules");
  const host = join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent");
  const moduleRoot = join(runtime, "node_modules");
  for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]) {
    const source = name === "@earendil-works/pi-coding-agent" ? host : name === "@earendil-works/pi-ai" ? join(host, "node_modules", name) : join(shared, name);
    const target = join(moduleRoot, name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  }
}

function applyWindowsBaseline(directory) {
  const patched = spawnSync(process.execPath, [join(root, "tools", "pi-antigravity", "manage-pi-antigravity.mjs"), "apply", "--target", directory, "--json"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (patched.status !== 0) throw new Error(patched.stderr || patched.stdout || "Windows baseline patch failed");
}

function git(directory, ...args) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: directory, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(directory) } });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
  return result.stdout;
}

function requireUpstream(source) {
  const pkg = readJson(join(source, "package.json"));
  if (pkg.name !== upstreamName || pkg.version !== "0.10.3") throw new Error(`Expected ${upstreamName}@0.10.3 at ${source}, found ${pkg.name}@${pkg.version}`);
}

export function buildNativePackage({ source = defaultSource, runtime = defaultRuntime } = {}) {
  source = resolve(source); runtime = resolve(runtime);
  if (normalized(source) === normalized(runtime)) throw new Error("Source and runtime must differ");
  const pkg = readJson(join(source, "package.json"));
  if (pkg.name !== packageName) requireUpstream(source);
  if (existsSync(runtime)) {
    const oldPackage = join(runtime, "package.json");
    if (!existsSync(oldPackage) || ![packageName, upstreamName].includes(readJson(oldPackage).name)) throw new Error(`Refusing to replace a non-Antigravity directory: ${runtime}`);
    rmSync(runtime, { recursive: true, force: true });
  }
  copyTree(source, runtime);
  if (pkg.name === upstreamName) {
    applyWindowsBaseline(runtime);
    git(runtime, "apply", "--whitespace=nowarn", patchPath);
  }
  linkNativeDependencies(runtime);
  sealNativePackage(runtime);
  return inspectNativePackage(runtime);
}

/** Regenerate the native patch from a development copy, against the same base native-build patches. */
export function writeNativePatch({ source = defaultDevelopmentSource, upstream = defaultSource, patch = patchPath } = {}) {
  source = resolve(source); upstream = resolve(upstream); patch = resolve(patch);
  if (readJson(join(source, "package.json")).name !== packageName) throw new Error(`Expected a ${packageName} source at ${source}`);
  requireUpstream(upstream);
  const work = mkdtempSync(join(tmpdir(), "pi-agy-native-patch-"));
  try {
    copyTree(upstream, work);
    applyWindowsBaseline(work);
    git(work, "init", "-q");
    git(work, "add", "-A", "-f");
    git(work, "-c", "user.name=native-patch", "-c", "user.email=native-patch@localhost", "commit", "-qm", "base");
    for (const entry of readdirSync(work)) if (entry !== ".git") rmSync(join(work, entry), { recursive: true, force: true });
    copyTree(source, work);
    git(work, "add", "-A", "-f");
    writeFileSync(patch, git(work, "diff", "--cached", "--binary"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { patch, source, upstream };
}

export function nativeStatus({ settings = defaultSettings, runtime = defaultRuntime } = {}) {
  const configuration = readJson(settings);
  const packages = configuration.packages ?? [];
  return { ...inspectNativePackage(runtime), settings, configured: packages.some((entry) => isNative(entry, runtime)), upstreamConfigured: packages.some(isUpstream) };
}

export function installNativePackage({ settings = defaultSettings, runtime = defaultRuntime, backup = backupPath } = {}) {
  const status = inspectNativePackage(runtime);
  if (status.state !== "ready") throw new Error(`Native package is ${status.state}; build before installing`);
  const bytes = readFileSync(settings);
  const configuration = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  const packages = configuration.packages ?? [];
  if (packages.some((entry) => isNative(entry, runtime))) return { ...nativeStatus({ settings, runtime }), changed: false };
  const index = packages.findIndex(isUpstream);
  if (index < 0) throw new Error("No upstream Antigravity package entry found");
  const previous = packages[index];
  const replacement = typeof previous === "string" ? resolve(runtime) : { ...previous, source: resolve(runtime) };
  mkdirSync(dirname(backup), { recursive: true });
  writeFileSync(backup, JSON.stringify({ settings: resolve(settings), runtime: resolve(runtime), previous, replacement, originalSettingsHash: hash(bytes) }, null, 2) + "\n");
  configuration.packages[index] = replacement;
  writeFileSync(settings, JSON.stringify(configuration, null, 2) + "\n");
  return { ...nativeStatus({ settings, runtime }), changed: true, backup };
}

export function rollbackNativePackage({ settings = defaultSettings, runtime = defaultRuntime, backup = backupPath } = {}) {
  const saved = readJson(backup);
  if (normalized(settings) !== normalized(saved.settings) || normalized(runtime) !== normalized(saved.runtime)) throw new Error("Rollback backup belongs to another installation");
  const configuration = readJson(settings);
  const index = (configuration.packages ?? []).findIndex((entry) => isNative(entry, runtime));
  if (index < 0) return { ...nativeStatus({ settings, runtime }), changed: false };
  configuration.packages[index] = saved.previous;
  writeFileSync(settings, JSON.stringify(configuration, null, 2) + "\n");
  return { ...nativeStatus({ settings, runtime }), changed: true };
}

export function runNativeCommand(args) {
  const [command, ...flags] = args;
  const options = {};
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--json") continue;
    const key = { "--source": "source", "--runtime": "runtime", "--settings": "settings", "--backup": "backup", "--upstream": "upstream", "--patch": "patch" }[flags[i]];
    if (!key || !flags[i + 1]) throw new Error(`Unknown or missing native option: ${flags[i]}`);
    options[key] = resolve(flags[++i]);
  }
  const handlers = { "native-build": buildNativePackage, "native-patch": writeNativePatch, "native-status": nativeStatus, "native-install": installNativePackage, "native-rollback": rollbackNativePackage };
  if (!handlers[command]) throw new Error(`Unknown native command: ${command}`);
  const result = handlers[command](options);
  console.log(JSON.stringify({ command, ...result }, null, 2));
  return command === "native-status" && (!result.configured || result.upstreamConfigured || result.state !== "ready") ? 1 : 0;
}
