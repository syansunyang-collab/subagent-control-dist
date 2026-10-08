"""One table over every production-profile batch: quality, cost, time, cache and behaviour per chain and arm.
Reads each batch's analysis.json (run analyze.py first) plus usage and session files. No model calls.

  python summary_all.py <batch-dir> [<batch-dir> ...]
"""
import glob
import json
import sys
from collections import Counter
from pathlib import Path

GUARD_STEPS = {9, 10, 11}


def rows(p):
    return [json.loads(line) for line in Path(p).read_text(encoding='utf-8').splitlines() if line.strip()]


print('batch | arm | score(graded) | solved | score s9-11 | cost $ | minutes | requests | hit % | miss M | reads | readback | compactions')
for batch in map(Path, sys.argv[1:]):
    analysis = json.loads((batch / 'analysis.json').read_text(encoding='utf-8'))
    for arm, report in analysis['arms'].items():
        totals = report['totals']
        usage = rows(batch / arm / 'usage.jsonl')
        miss = sum(u['usage']['input'] for u in usage)
        hit = sum(u['usage']['cacheRead'] for u in usage)
        session = rows(glob.glob(str(batch / arm / 'sessions' / '*.jsonl'))[0])
        calls = Counter(c['name'] for e in session if e.get('type') == 'message' and e['message'].get('role') == 'assistant'
                        for c in e['message']['content'] if c.get('type') == 'toolCall')
        guard = sum(p['score'] for p in report['steps'] if p['step'] in GUARD_STEPS)
        compactions = sum(1 for e in session if e.get('type') == 'compaction')
        print(f"{batch.name.replace('ripgrep-chain-', '')} | {arm} | {totals['scoreSumGraded']:.2f} | {totals['resolvedGraded']}/{totals['graded']} | {guard:.2f} | "
              f"{totals['totalCost']:.2f} | {totals['agentSeconds'] / 60:.0f} | {totals['requests']} | {100 * hit / (hit + miss):.1f} | {miss / 1e6:.2f} | "
              f"{calls.get('read', 0) + calls.get('read_symbol', 0)} | {calls.get('context_tree_query', 0)} | {compactions}  [{report['status']}]")
