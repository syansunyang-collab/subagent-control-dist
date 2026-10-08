import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Blocks shell commands that reach the network, so an agent cannot download the upstream ripgrep sources (the
 * reference solution). Each command segment (split on ; & | ( ) ` and newlines) is checked by its first word after
 * environment assignments, wrappers and shell keywords; script interpreters are blocked when the command carries an
 * http(s) URL.
 */
const NETWORK_COMMANDS = new Set(["curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "gh", "nc", "ncat",
  "ssh", "scp", "sftp", "ftp", "aria2c", "start-bitstransfer"]);
const GIT_REMOTE = new Set(["clone", "fetch", "pull", "ls-remote", "submodule"]);
const WRAPPERS = new Set(["command", "time", "xargs", "sudo", "env", "exec", "nohup", "do", "then", "else", "elif", "if", "while", "until", "!", "{"]);
const SCRIPTS = new Set(["python", "python3", "py", "node", "deno", "bun", "perl", "ruby", "pwsh", "powershell"]);

function firstWords(segment: string): string[] {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(words[i]) || /^-/.test(words[i]) && i > 0)) i++;
  return words.slice(i).map(w => w.replace(/^["']|["']$/g, ""));
}

export function networkReason(command: string): string | undefined {
  for (const segment of command.split(/[;&|()`\n]|\$\(/)) {
    const words = firstWords(segment);
    if (words.length === 0) continue;
    const name = words[0].toLowerCase().replace(/\.exe$/, "").replace(/^.*[\\/]/, "");
    if (NETWORK_COMMANDS.has(name)) return name;
    const sub = name === "git" ? words.slice(1).find(w => !w.startsWith("-")) : undefined;
    if (sub && GIT_REMOTE.has(sub)) return `git ${sub}`;
    if (SCRIPTS.has(name) && /https?:\/\//i.test(command)) return `${name} with a URL`;
  }
  return undefined;
}

export default function noNetwork(pi: ExtensionAPI): void {
  pi.on("tool_call", event => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string") return;
    const reason = networkReason(command);
    if (!reason) return;
    return { block: true, reason: `Network access is disabled in this environment (${reason}). Work from the local repository and the local cargo registry only.` };
  });
}
