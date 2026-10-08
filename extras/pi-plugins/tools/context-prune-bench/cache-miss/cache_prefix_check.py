"""Check where the provider cache hit lands on pruning requests, against the longest-common-prefix rule.

Usage: python cache_prefix_check.py BLOCK SESSION.jsonl [...] [-v]
       BLOCK is the hit granularity: 128 for gpt-6-sol, 1024 for the Luna models (hits are 512 + 1024n).

Per session it prints the hit granularity (share of cacheRead values that are multiples of 128, of 1024, and of the
form 512 + 1024n), the gap between the previous request's context and the hit on requests without a cut, and, for
every request after a lab apply, the real hit next to two predictions:
- first change: the position of the earliest newly stubbed tool result in the previous request's layout, floored to
  BLOCK. The position is the issuing request's unpruned context plus its output, minus the net the lab had removed
  by the previous request (budget and mask add their net, stage adds back its summary).
- nearest end: the previous request context closest to the hit (the old "reuse only at request ends" rule). Request
  ends are a few hundred tokens apart in a long session, so a small distance here is weak evidence.
Price-line applies release items anywhere in the history; their first-change position is not reliable here.
"""
import json
import statistics
import sys

LAB = 'context-prune-lab-event'


def load(path):
    reqs, removed, produced, pend = [], 0, {}, []
    for line in open(path, encoding='utf-8'):
        e = json.loads(line)
        d = e.get('data') or {}
        if e.get('customType') == LAB and d.get('event') == 'apply':
            phase = d.get('phase')
            if phase in ('budget', 'mask'):
                removed += d.get('netTokens') or 0
            elif phase == 'stage':
                removed -= d.get('summaryTokens') or 0
            pend += [i for i in d.get('candidateToolCallIds') or [] if i in produced]
            continue
        m = e.get('message') or {}
        if e.get('type') != 'message' or m.get('role') != 'assistant':
            continue
        u = m.get('usage') or {}
        ctx = u.get('input', 0) + u.get('cacheRead', 0) + u.get('cacheWrite', 0)
        if not ctx:
            continue
        reqs.append({'ctx': ctx, 'hit': u.get('cacheRead', 0), 'out': u.get('output', 0), 'removed': removed, 'cut': pend})
        for c in m.get('content') or []:
            if isinstance(c, dict) and c.get('type') == 'toolCall':
                produced[c['id']] = len(reqs) - 1
        pend = []
    return reqs, produced


def check(path, block, verbose):
    reqs, produced = load(path)
    hits = [r['hit'] for r in reqs if r['hit']]
    gaps = [reqs[i - 1]['ctx'] - reqs[i]['hit'] for i in range(1, len(reqs)) if not reqs[i]['cut']]
    print(path)
    print(f"  hits {len(hits)}: %128==0 {sum(h % 128 == 0 for h in hits)}  %1024==0 {sum(h % 1024 == 0 for h in hits)}  "
          f"512+1024n {sum(h % 1024 == 512 for h in hits)}")
    print(f"  no-cut gap (previous context - hit): median {statistics.median(gaps):.0f}  "
          f"p90 {sorted(gaps)[int(0.9 * len(gaps))]}  over 2000: {sum(g > 2000 for g in gaps)}")
    rows = []
    for i, r in enumerate(reqs):
        if not i or not r['cut']:
            continue
        p = min(produced[x] for x in r['cut'])
        pos = reqs[p]['ctx'] + reqs[p]['removed'] + reqs[p]['out'] - reqs[i - 1]['removed']
        pred = min(pos, reqs[i - 1]['ctx']) // block * block
        near = min((reqs[j]['ctx'] for j in range(i)), key=lambda x: abs(x - r['hit']))
        rows.append((i, p, r['hit'], pred, r['hit'] - pred, r['hit'] - near))
    if not rows:
        return
    diff = [x[4] for x in rows]
    print(f"  cuts {len(rows)}: hit within one block of first change {sum(abs(x) <= block for x in diff)}, "
          f"within 2K {sum(abs(x) <= 2000 for x in diff)}")
    if verbose:
        for x in rows:
            print('    req %d  pruned from req %d  hit %d  first change %d (%+d)  nearest end %+d' % x)


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if a != '-v']
    for session in args[1:]:
        check(session, int(args[0]), '-v' in sys.argv)
