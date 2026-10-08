"""Aggregate a ripgrep chain batch (N/R/L): per-step scores, pairing, API-price cost, context, pruning, tool behavior. No model calls."""
import json
import math
import sys
from collections import Counter
from pathlib import Path

BATCH = Path(sys.argv[1] if len(sys.argv) > 1 else 'E:/Pi_Coding_Agent/test-results/context-prune-bench/ripgrep-chain-20260923b')
MANIFEST = json.loads((BATCH / 'manifest.json').read_text(encoding='utf-8'))
ARMS = list(MANIFEST['arms'])
PROD = (BATCH / ARMS[0] / 'provider-calls.jsonl').exists()
TIER = 272_000
KEYS = ('input', 'output', 'cacheRead', 'cacheWrite')


def rows(p):
    return [json.loads(line) for line in Path(p).read_text(encoding='utf-8').splitlines() if line.strip()] if Path(p).exists() else []


def mcnemar(wins, losses):
    n = wins + losses
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(min(wins, losses) + 1)) / 2 ** n)


def context_tokens(u):
    return u.get('input', 0) + u.get('cacheRead', 0) + u.get('cacheWrite', 0)


def model_rates(arm):
    """Base and above-tier list prices the run's model was billed with (runtime line of the projection)."""
    cost = next(r for r in rows(BATCH / arm / 'projection.jsonl') if r['kind'] == 'runtime')['model']['costRates']
    tier = (cost.get('tiers') or [{}])[0]
    return tier.get('inputTokensAbove', float('inf')), {k: cost[k] for k in KEYS}, {k: tier.get(k, cost[k]) for k in KEYS}


def own_cost(u, rates):
    above, base, high = rates
    table = high if context_tokens(u) > above else base
    return sum(u.get(k, 0) * r for k, r in table.items()) / 1e6


def is_continuation(message):
    content = message.get('content')
    text = content if isinstance(content, str) else ''.join(b.get('text', '') for b in content or [] if isinstance(b, dict))
    return text.startswith('[pi-midrun-compact/')


def session_steps(arm):
    """Split the session at each driver prompt (compaction continuations stay in their step). Per step: tool counts, and
    reads of a file whose earlier read result was already pruned."""
    session = next((BATCH / arm / 'sessions').glob('*.jsonl'))
    steps, pruned, applies, reads = [], set(), [], []
    for e in rows(session):
        if e['type'] == 'message' and e['message']['role'] == 'user' and not is_continuation(e['message']):
            steps.append({'calls': 0, 'byTool': Counter(), 'reread': 0, 'rereadPruned': 0})
        elif e['type'] == 'message' and e['message']['role'] == 'assistant' and steps:
            for c in (c for c in e['message']['content'] if c.get('type') == 'toolCall'):
                steps[-1]['calls'] += 1
                steps[-1]['byTool'][c['name']] += 1
                if c['name'] in ('read', 'read_symbol'):
                    path = str((c.get('arguments') or {}).get('path', '')).replace('\\', '/')
                    steps[-1]['reread'] += any(p == path for p, _ in reads)
                    steps[-1]['rereadPruned'] += any(p == path and cid in pruned for p, cid in reads)
                    reads.append((path, c['id']))
        elif e.get('customType') == 'context-prune-lab-event' and e['data']['event'] == 'apply':
            d = e['data']
            pruned |= set(d.get('candidateToolCallIds') or [])
            applies.append({'step': len(steps), 'phase': d['phase'], 'reason': d.get('reason', ''), 'results': len(d.get('candidateToolCallIds') or []),
                            'rawTokens': d['rawTokens'], 'summaryTokens': d['summaryTokens'], 'netTokens': d['netTokens']})
    return [{**s, 'byTool': dict(s['byTool'])} for s in steps], applies


def arm_report(arm):
    run = json.loads((BATCH / arm / 'run.json').read_text(encoding='utf-8'))
    usage = rows(BATCH / arm / 'usage.jsonl')
    for u in usage:
        u['task'] = u.get('step') or u['task']
    if PROD:
        # provider-calls holds every call; the prune summaries are the Luna Fast stream() calls, the writer uses streamSimple.
        calls = [m for m in rows(BATCH / arm / 'provider-calls.jsonl') if m['model'] != MANIFEST['model'].split('/', 1)[1]]
        meter = [{**m, 'task': m.get('step') or m['task']} for m in calls if m['method'] == 'stream']
        writer = [m for m in calls if m['method'] == 'streamSimple' and m['phase'] == 'end']
    else:
        meter = rows(BATCH / arm / 'summary-meter.jsonl')
        writer = []
    behavior, applies = session_steps(arm)
    rates = model_rates(arm)
    per = []
    for rec in run['steps']:
        n = rec['step']
        us = [u['usage'] for u in usage if u['task'] == n]
        sm = [m for m in meter if m['task'] == n and m['phase'] == 'end']
        s = rec['score']
        per.append({'step': n, 'milestone': rec['milestone'], 'graded': rec['graded'], 'score': round(s.get('score', 0), 4), 'resolved': bool(s.get('resolved')),
                    'f2p': s.get('f2p'), 'n2p': s.get('n2p'), 'p2p': s.get('p2p'), 'error': s.get('error'), 'agentError': rec.get('agent_error'),
                    'agentSeconds': rec['agent_seconds'], 'requests': len(us), 'peakContext': max((context_tokens(u) for u in us), default=0),
                    'over272k': sum(1 for u in us if context_tokens(u) > TIER), 'mainCost': round(sum(u['cost']['total'] for u in us), 4),
                    'mainCostOwn': round(sum(own_cost(u, rates) for u in us), 4), 'summaryCalls': len(sm),
                    'summaryCost': round(sum(m['usage']['cost']['total'] for m in sm), 4),
                    'prunes': [a for a in applies if a['step'] == n], **(behavior[n - 1] if n <= len(behavior) else {})})
    main = sum(u['usage']['cost']['total'] for u in usage)
    summ = sum(m['usage']['cost']['total'] for m in meter if m['phase'] == 'end')
    compaction = sum(m['usage']['cost']['total'] for m in writer)
    return {'status': run['status'], 'steps': per,
            'totals': {'steps': len(per), 'graded': sum(p['graded'] for p in per), 'resolvedGraded': sum(p['resolved'] for p in per if p['graded']),
                       'scoreSumGraded': round(sum(p['score'] for p in per if p['graded']), 3), 'agentSeconds': round(sum(p['agentSeconds'] for p in per)),
                       'requests': len(usage), 'cumulativeContext': sum(context_tokens(u['usage']) for u in usage),
                       'peakContext': max((context_tokens(u['usage']) for u in usage), default=0),
                       'over272k': sum(1 for u in usage if context_tokens(u['usage']) > TIER), 'mainCost': round(main, 3),
                       'mainCostOwn': round(sum(own_cost(u['usage'], rates) for u in usage), 3), 'summaryCost': round(summ, 3), 'compactionCost': round(compaction, 3),
                       'compactions': len(writer), 'totalCost': round(main + summ + compaction, 3),
                       'summaryCalls': sum(1 for m in meter if m['phase'] == 'end'), 'summaryErrors': sum(1 for m in meter if m['phase'] == 'error'),
                       'prunes': len(applies), 'priceLinePrunes': sum(1 for a in applies if a['reason'].startswith('price-line')),
                       'reread': sum(p.get('reread', 0) for p in per), 'rereadPruned': sum(p.get('rereadPruned', 0) for p in per)}}


def main():
    out = {'batch': BATCH.name, 'arms': {a: arm_report(a) for a in ARMS if (BATCH / a / 'run.json').exists()}, 'paired': {}}
    for base, cand in [('N', 'R'), ('N', 'L'), ('R', 'L'), ('N', 'K'), ('K', 'R'), ('N', 'K30'), ('K', 'K30')]:
        if base not in out['arms'] or cand not in out['arms']:
            continue
        left = {p['step']: p for p in out['arms'][base]['steps'] if p['graded']}
        right = {p['step']: p for p in out['arms'][cand]['steps'] if p['graded']}
        common = sorted(left.keys() & right.keys())
        wins = sum(1 for k in common if right[k]['resolved'] and not left[k]['resolved'])
        losses = sum(1 for k in common if left[k]['resolved'] and not right[k]['resolved'])
        out['paired'][f'{base}->{cand}'] = {'steps': len(common), 'wins': wins, 'losses': losses, 'mcnemarP': round(mcnemar(wins, losses), 3),
                                           'scoreDelta': round(sum(right[k]['score'] - left[k]['score'] for k in common), 3)}
    (BATCH / 'analysis.json').write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    for arm, r in out['arms'].items():
        print(arm, r['status'], json.dumps(r['totals'], ensure_ascii=False))
        for p in r['steps']:
            print('  ', p['step'], p['milestone'][:34].ljust(34), 'G' if p['graded'] else '-', f"{p['score']:.2f}", f"{p['agentSeconds']:>6}s",
                  f"req={p['requests']:>3} peak={p['peakContext']:>6} >272k={p['over272k']:>2} ${p['mainCost']:.3f}+{p['summaryCost']:.3f}",
                  f"prunes={len(p['prunes'])} reread={p.get('reread')}/{p.get('rereadPruned')} calls={p.get('calls')}")
    print(json.dumps(out['paired'], indent=1))


if __name__ == '__main__':
    main()
