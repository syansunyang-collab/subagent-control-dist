// Offline reproduction against the exact installed pruning bundle. No model calls.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const source = path.resolve('tmp/context-prune-pause-fix');
const fixed = process.argv.includes('--fixed');
const installed = path.join(process.env.USERPROFILE, '.pi/agent/local-packages/pi-context-prune/dist/index.js');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceSha = sha(path.join(source, 'dist/policy-lab.js'));
assert.equal(sourceSha, sha(installed), 'Reproduction must use the installed bundle');
const { makeLabHarness, receiptsIn } = await import(pathToFileURL(path.join(source, 'test/lab-harness.ts')));
const resultText = id => `${id}:${'x'.repeat(800)}`;
const snapshot = messages => ({
  receiptIds: receiptsIn(messages).map(m => m.toolCallId),
  toolResultChars: messages.filter(m => m.role === 'toolResult')
    .reduce((n, m) => n + m.content.reduce((s, c) => s + (c.text?.length ?? 0), 0), 0),
});
const runs = [];
for (const reload of [false, true]) {
  const h = makeLabHarness({ mode: 'cold-mask', triggerTokens: 100, keepRecentToolTurns: 2, rawConfig: { stageSummary: false },
    model: { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-6-sol' } });
  try {
    await h.sessionStart();
    h.prompt('offline task');
    await h.turn(['a0'], { resultText });
    await h.request();
    await h.turn(['a1'], { resultText });
    await h.request();
    await h.turn(['a2'], { resultText });
    if (reload) await h.reloadExtension();
    const first = snapshot(await h.request());
    const second = snapshot(await h.request());
    assert.deepEqual(first.receiptIds, reload && !fixed ? [] : ['a0']);
    assert.deepEqual(second.receiptIds, ['a0']);
    assert.equal(h.summarizerPrompts().length, 0);
    // Already archived results must stay receipts after another full extension reload.
    await h.reloadExtension();
    const archivedReload = snapshot(await h.request());
    assert.deepEqual(archivedReload.receiptIds, ['a0']);
    runs.push({ reload, first, second, archivedReload });
  } finally { h.cleanup(); }
}
const record = { at: new Date().toISOString(), sourceSha, fixed, runs,
  extraFirstRequestResultChars: runs[1].first.toolResultChars - runs[0].first.toolResultChars,
  modelRequests: 0, limitations: ['Characters are not provider tokens or money.',
    'Only delayed eligibility of unarchived results is reproduced; archived receipts remain intact.'] };
const out = path.resolve(`test-results/cache-replay-20260927/reload-check${fixed ? '-fixed' : ''}.json`);
fs.writeFileSync(out, JSON.stringify(record, null, 2));
console.log(JSON.stringify(record));
