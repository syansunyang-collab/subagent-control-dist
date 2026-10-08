import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Pi 在 Windows 上把 /c/…、/mnt/c/…、/cygdrive/c/… 当盘符路径（utils/paths.js 的 normalizeWindowsShellPath）。
const WINDOWS_SHELL_PATH = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;

export function resolvePiAgentDir(env = process.env) {
  const configured = String(env.PI_CODING_AGENT_DIR || "").trim();
  return path.resolve(configured || path.join(homedir(), ".pi", "agent"));
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

/**
 * settings.json 的包来源 → 包目录，判定顺序同 Pi 的 parseSource：npm: 前缀只认原文开头，前缀后的说明符再 trim，
 * 落在 agent 目录的 npm/node_modules；其余整体 trim 后按本地路径解析，相对路径按 agent 目录。
 */
function packageRoot(raw, agentDir) {
  if (raw.startsWith("npm:")) {
    const name = raw.slice(4).trim().match(/^(@[^/@]+\/[^@]+|[^@]+)/)?.[1];
    return name ? path.join(agentDir, "npm", "node_modules", ...name.split("/")) : undefined;
  }
  const source = raw.trim();
  if (source.startsWith("file://")) return fileURLToPath(source);
  if (source === "~" || source.startsWith("~/") || source.startsWith("~\\")) return path.join(homedir(), source.slice(1));
  if (/^[a-z][a-z0-9+.-]+:/i.test(source)) return undefined;
  const shell = process.platform === "win32" && !source.includes("\\") && source.match(WINDOWS_SHELL_PATH);
  return path.resolve(agentDir, shell ? `${shell[1].toUpperCase()}:\\${shell[2] ?? ""}` : source);
}

/**
 * settings.json 登记的包里 package.json name 在 names 内的那些，按登记顺序返回 [{ name, source, extensions }]；
 * extensions 是包内 pi.extensions 的绝对路径，与主会话加载同一份，包换入口或换安装位置时随之更新。
 */
export function registeredPiPackages(agentDir, names) {
  const packages = readJson(path.join(agentDir, "settings.json"))?.packages;
  const seen = new Set();
  return (Array.isArray(packages) ? packages : []).flatMap((entry) => {
    const filter = entry && typeof entry === "object" ? entry : {};
    const source = typeof entry === "string" ? entry : filter.source;
    if (typeof source !== "string" || !source.trim()) return [];
    let root;
    try {
      root = packageRoot(source, agentDir);
    } catch {
      return []; // One malformed source must not drop the other packages.
    }
    // Pi dedupes user packages by identity and keeps the first entry, even when that entry is disabled.
    if (!root || seen.has(root)) return [];
    seen.add(root);
    // Pi loads no extensions from an entry whose extensions filter is empty, or that turns autoload off without listing any.
    if (Array.isArray(filter.extensions) ? filter.extensions.length === 0 : filter.autoload === false) return [];
    const manifest = readJson(path.join(root, "package.json"));
    if (!names.includes(manifest?.name) || !Array.isArray(manifest.pi?.extensions)) return [];
    const extensions = manifest.pi.extensions.filter((file) => typeof file === "string").map((file) => path.resolve(root, file));
    return [{ name: manifest.name, source, extensions }];
  });
}
