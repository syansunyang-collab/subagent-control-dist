// Offline check of the no-network extension against every shell command the 2026-09-26 chain arms ran.
// Run from the repo root: node --test tools/context-prune-bench/ripgrep-chain/harness/no-network.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { networkReason } from "./no-network.ts";

const ROOT = "test-results/context-prune-bench";

function shellCommands() {
  const out = [];
  if (!fs.existsSync(ROOT)) return out;
  for (const batch of fs.readdirSync(ROOT).filter(b => /^ripgrep-chain-.*20260926/.test(b))) {
    for (const arm of fs.readdirSync(path.join(ROOT, batch))) {
      const dir = path.join(ROOT, batch, arm, "sessions");
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"))) {
        for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
          if (!line.includes('"toolCall"')) continue;
          const entry = JSON.parse(line);
          for (const part of entry.message?.content ?? []) {
            if (part.type === "toolCall" && (part.name === "bash" || part.name === "powershell") && typeof part.arguments?.command === "string")
              out.push(part.arguments.command);
          }
        }
      }
    }
  }
  return out;
}

test("unit cases", () => {
  for (const blocked of ["curl -L https://raw.githubusercontent.com/BurntSushi/ripgrep/master/x.rs", "cd x && curl --noproxy '*' -sS https://a.b",
    "HTTPS_PROXY= wget https://a.b", "xargs -n1 curl < urls", "git clone https://github.com/BurntSushi/ripgrep", "git fetch origin",
    "python -c \"import urllib.request; urllib.request.urlopen('https://a.b')\"", "Invoke-WebRequest https://a.b -OutFile x", "echo $(curl -s https://a.b)"])
    assert.ok(networkReason(blocked), blocked);
  for (const allowed of ["cargo test --offline", "rg -nc curl src", "git log --oneline", "git commit -m 'fix pull handling'", "git diff --stat",
    "echo curl is blocked", "python -c 'print(1)'", "grep -rn 'https://' crates/printer", "sed -n 1,20p crates/core/flags/defs.rs"])
    assert.equal(networkReason(allowed), undefined, allowed);
});

test("every recorded download of the upstream ripgrep sources is blocked", t => {
  const commands = shellCommands();
  if (commands.length === 0) return t.skip("no local batch data");
  const upstream = commands.filter(c => /BurntSushi\/ripgrep/.test(c) && /curl|wget|git |gh /.test(c));
  assert.ok(upstream.length > 0);
  const missed = upstream.filter(c => !networkReason(c));
  assert.deepEqual(missed, []);
  const blocked = commands.filter(c => networkReason(c));
  const withoutUrl = blocked.filter(c => !/https?:\/\/|git (clone|fetch|pull)/.test(c));
  t.diagnostic(`commands ${commands.length}, upstream downloads ${upstream.length}, blocked ${blocked.length}, blocked without a URL ${withoutUrl.length}`);
  for (const c of withoutUrl.slice(0, 20)) t.diagnostic(`no-url block: ${c.slice(0, 160)}`);
});
