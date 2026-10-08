// Read only the allowlisted usage and verification fields from the replay log.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const file = process.argv[2];
assert(file, 'Provide the redacted JSONL path');
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const arms = Object.fromEntries(['none', 'production', 'boundary'].map(arm => {
  const trials = rows.filter(r => r.kind === 'trial' && r.arm === arm);
  const sum = key => trials.reduce((n, r) => n + (r.usage?.[key] ?? 0), 0);
  return [arm, { requests: trials.length, successful: trials.filter(r => r.success).length,
    correct: trials.filter(r => r.correct).length, releases: trials.reduce((n,r) => n+r.releaseCount,0),
    firstCacheRead: trials[0]?.usage?.cacheRead ?? null, input: sum('input'), cacheRead: sum('cacheRead'),
    output: sum('output'), localCost: trials.reduce((n,r) => n+(r.usage?.cost?.total ?? 0),0),
    peakContext: Math.max(0,...trials.map(r => (r.usage?.input ?? 0)+(r.usage?.cacheRead ?? 0))),
    retainedInputItemsAtFirstCut: trials.find(r => r.releaseCount)?.retainedInputItems ?? null,
    releaseItems: trials.reduce((n,r) => n+r.releasedInputItems,0),
    rereads: 0, // fixture has no live tool execution; never infer production re-read behavior
    latencyMs: trials.reduce((n,r) => n+r.elapsedMs,0),
    postCutTrials: trials.filter((r,i) => i > trials.findIndex(x=>x.releaseCount > 0) && trials.some(x=>x.releaseCount>0)).length,
    effectiveChainVerified: trials.every(r => r.reconstructed),
    reasons: trials.map(r => r.releaseReason) }];
}));
const complete = Object.values(arms).every(a => a.requests === 8 && a.successful === 8);
console.log(JSON.stringify({ complete, calls: Object.values(arms).reduce((n,a)=>n+a.requests,0), arms,
  limits: ['Costs are Pi catalog estimates, not subscription debits.',
    'No interactive tools or re-read opportunity; quality is exact checksum reply, not coding-task correctness.'],
}, null, 2));
