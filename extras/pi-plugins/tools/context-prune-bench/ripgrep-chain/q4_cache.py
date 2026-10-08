"""Q4: where does the cache resume after a request rewrites history? No model calls.

For every main-model request, requests.jsonl gives the first input item that differs from the previous request and the
characters before it; usage.jsonl gives the billed cache read. The characters are converted to tokens with the request's
own ratio (billed input + cache read over instructions + tools + input characters), so the estimated position P of the
first change can be compared with the billed hit H. Transport comes from the WebSocket counters of the response:
delta (previous_response_id), full (whole body over WebSocket) or sse (no WebSocket request counted).

  python q4_cache.py <batch-dir> [arm ...]
"""
import json
import sys
from collections import Counter
from pathlib import Path

BATCH = Path(sys.argv[1])
ARMS = sys.argv[2:] or [p.name for p in BATCH.iterdir() if (p / 'requests.jsonl').exists()]


def rows(p):
    return [json.loads(line) for line in Path(p).read_text(encoding='utf-8').splitlines() if line.strip()]


def transport(usage):
    delta = (usage.get('websocket') or {}).get('delta') or {}
    if delta.get('deltaRequests', 0) > 0:
        return 'ws-delta'
    if delta.get('fullContextRequests', 0) > 0:
        return 'ws-full'
    return 'sse'


def classify(hit, position, previous_total):
    """Where the billed hit sits relative to the first change (tokens; hits come in 128-token blocks)."""
    if hit >= position - 1024:
        return 'at-change' if hit <= position + 1024 else 'beyond-change'
    if hit < 30_000:
        return 'shared-prefix-only'
    return 'before-change'


def arm_report(arm):
    requests = rows(BATCH / arm / 'requests.jsonl')
    usage = [u for u in rows(BATCH / arm / 'usage.jsonl') if u.get('stopReason') != 'error' and (u['usage']['input'] + u['usage']['cacheRead']) > 0]
    out = []
    j = 0
    for u in usage:
        # the request this response belongs to: the last one sent before it
        while j + 1 < len(requests) and requests[j + 1]['time'] <= u['time']:
            j += 1
        r = requests[j]
        billed = u['usage']['input'] + u['usage']['cacheRead']
        chars = r['instructionsChars'] + r['toolsChars'] + sum(item[1] for item in r['items'])
        ratio = billed / chars if chars else 0
        position = None if r['firstDiff'] is None else (r['instructionsChars'] + r['toolsChars'] + r['charsBeforeDiff']) * ratio
        out.append({'seq': r['seq'], 'step': r['step'], 'appendOnly': r['appendOnly'], 'transport': transport(u), 'billed': billed,
                    'hit': u['usage']['cacheRead'], 'miss': u['usage']['input'], 'position': position, 'gapMs': r['gapMs']})
    for i, x in enumerate(out):
        prev = out[i - 1]['billed'] if i else None
        x['class'] = None if x['position'] is None else classify(x['hit'], x['position'], prev)
    return out


def summarize(arm, out):
    rewrites = [x for x in out if x['appendOnly'] is False]
    appends = [x for x in out if x['appendOnly'] is True]
    print(f'== {arm}: requests={len(out)} appendOnly={len(appends)} rewrites={len(rewrites)}  transport={dict(Counter(x["transport"] for x in out))}')
    for label, group in (('append-only', appends), ('rewrite', rewrites)):
        by = {}
        for x in group:
            by.setdefault(x['transport'], Counter())[x['class']] += 1
        miss = sum(x['miss'] for x in group)
        print(f'   {label:<11} miss tokens {miss / 1e6:.2f}M  ' + '  '.join(f'{t}: {dict(c)}' for t, c in sorted(by.items())))
    long_gaps = [x for x in out if (x['gapMs'] or 0) > 300_000]
    print(f'   gaps > 5 min: {len(long_gaps)}  classes {dict(Counter(x["class"] for x in long_gaps))}  miss {sum(x["miss"] for x in long_gaps) / 1e6:.2f}M')


if __name__ == '__main__':
    report = {}
    for arm in ARMS:
        report[arm] = arm_report(arm)
        summarize(arm, report[arm])
    (BATCH / 'q4-cache.json').write_text(json.dumps(report), encoding='utf-8')
