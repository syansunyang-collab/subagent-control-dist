import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { encode } = await import(pathToFileURL(path.resolve('tmp/context-prune-bench/pi-context-prune-fork/node_modules/gpt-tokenizer/esm/encoding/o200k_base.js')));
const dir = path.resolve('test-results/prune-luna-context-replay-20260927');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
const count = text => encode(text, { disallowedSpecial: new Set() }).length;
const summary = [];
for (const item of manifest.cases) {
  const file = path.join(dir, `${item.id}-result.json`);
  if (!fs.existsSync(file)) continue;
  const result = JSON.parse(fs.readFileSync(file));
  const input = JSON.parse(fs.readFileSync(path.join(dir, `${item.id}-input.json`)));
  const decisions = result.parsed?.decisions ?? [];
  let raw = 0, retained = 0;
  const identities = [];
  for (const c of input.candidates) {
    const d = decisions.find(d => d.id === c.id);
    raw += count(c.result);
    retained += d?.action === 'keep' || !d ? count(c.result)
      : count(`[pruned:${c.id}]${d.action === 'replace' ? '\n' + d.replacement : ''}`);
    // Deterministic check for task identity substitution, not a semantic quality score.
    if (d?.action === 'replace') {
      for (const task of d.replacement.match(/subagent-\d{4}-\d{2}-\d{2}T[\w-]+/g) ?? []) {
        if (!c.result.includes(task)) identities.push({ id: c.id, foreignTaskId: task });
      }
    }
  }
  summary.push({ id: item.id, ms: result.elapsedMs, input: result.usage.input,
    output: result.usage.output, costLogged: result.usage.cost.total, rawTokens: raw,
    replacementTokens: retained, netTokens: raw - retained,
    actions: Object.fromEntries(['keep', 'replace', 'drop'].map(a => [a, decisions.filter(d => d.action === a).length])),
    identityFlags: identities, validation: result.validation,
    targets: decisions.filter(d => ['t201', 't203'].includes(d.id)),
  });
}
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
