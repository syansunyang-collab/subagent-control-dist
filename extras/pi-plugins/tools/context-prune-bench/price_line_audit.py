"""Price-line behavior in Pi session files: how often requests crossed the long-context price tier, what that
premium cost, and whether the pruner's price line held the context under it.

  python price_line_audit.py [--since ISO-TIME] [--model ID] SESSION.jsonl [...]

Costs use the GPT-6 Sol list price (USD per 1M tokens: input 2, cache read 0.2, cache write 2.5, output 10;
requests above 272K input: 4 / 0.4 / 5 / 15) for every counted request, whatever model served it, so
sessions compare on one scale. A price-line firing is an `apply` lab event whose reason starts with
`price-line`; the cache counts as broken on the next request when uncached input exceeds 30% of it.
"""
import json
import statistics
import sys
from pathlib import Path

TIER = 272_000
BASE = {'input': 2, 'cacheRead': 0.2, 'cacheWrite': 2.5, 'output': 10}
HIGH = {'input': 4, 'cacheRead': 0.4, 'cacheWrite': 5, 'output': 15}


def audit(file, since='', model=None):
    s = {'requests': 0, 'overTier': 0, 'peak': 0, 'cost': 0.0, 'tierPremium': 0.0,
         'firings': 0, 'firingsUnder5k': 0, 'brokenAfterFiring': 0, 'brokenAfterFiringCost': 0.0}
    released, pending = [], False
    for line in Path(file).open(encoding='utf-8', errors='replace'):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if (e.get('timestamp') or '') < since:
            continue
        data = e.get('data') or {}
        if e.get('customType') == 'context-prune-lab-event' and data.get('event') == 'apply' and str(data.get('reason', '')).startswith('price-line'):
            s['firings'] += 1
            released.append(data.get('netTokens') or 0)
            pending = True
        m = e.get('message') or {}
        if e.get('type') != 'message' or m.get('role') != 'assistant' or (model and m.get('model') != model):
            continue
        u = m.get('usage') or {}
        context = sum(u.get(k, 0) for k in ('input', 'cacheRead', 'cacheWrite'))
        if not context:
            continue
        rates = HIGH if context > TIER else BASE
        cost = sum(u.get(k, 0) * r for k, r in rates.items()) / 1e6
        s['requests'] += 1
        s['overTier'] += context > TIER
        s['peak'] = max(s['peak'], context)
        s['cost'] += cost
        s['tierPremium'] += cost - sum(u.get(k, 0) * r for k, r in BASE.items()) / 1e6
        if pending:
            uncached = u.get('input', 0) + u.get('cacheWrite', 0)
            if uncached > 0.3 * context:
                s['brokenAfterFiring'] += 1
                s['brokenAfterFiringCost'] += (u.get('input', 0) * (rates['input'] - rates['cacheRead'])
                                              + u.get('cacheWrite', 0) * (rates['cacheWrite'] - rates['cacheRead'])) / 1e6
            pending = False
    s['firingsUnder5k'] = sum(n < 5000 for n in released)
    s['releasedMedian'] = statistics.median(released) if released else 0
    return {k: round(v, 2) if isinstance(v, float) else v for k, v in s.items()}


if __name__ == '__main__':
    argv = sys.argv[1:]
    since = argv[argv.index('--since') + 1] if '--since' in argv else ''
    model = argv[argv.index('--model') + 1] if '--model' in argv else None
    files = [a for i, a in enumerate(argv) if a not in ('--since', '--model') and (i == 0 or argv[i - 1] not in ('--since', '--model'))]
    for f in files:
        print(json.dumps({'session': Path(f).name, **audit(f, since, model)}, ensure_ascii=False))
