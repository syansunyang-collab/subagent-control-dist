"""Q4, second test: after a rewrite, does the cache resume at the end of an earlier request whose input is a prefix of
this one (rather than at the first changed item)? No model calls.

For each rewrite request i, the candidates are earlier requests j of the same session with the same instructions and
tools whose input items are an exact prefix of i's items. The prediction is the billed input of the longest such j
(its request end), with its age. The billed hit is compared with that prediction and with the first-change position.

  python q4_boundary.py <batch-dir> [arm ...]
"""
import json
import sys
from collections import Counter
from pathlib import Path

BATCH = Path(sys.argv[1])
ARMS = sys.argv[2:] or [p.name for p in BATCH.iterdir() if (p / 'requests.jsonl').exists()]


def rows(p):
    return [json.loads(line) for line in Path(p).read_text(encoding='utf-8').splitlines() if line.strip()]


def run(arm):
    requests = rows(BATCH / arm / 'requests.jsonl')
    usage = [u for u in rows(BATCH / arm / 'usage.jsonl') if u.get('stopReason') != 'error' and (u['usage']['input'] + u['usage']['cacheRead']) > 0]
    billed_by_seq, hit_by_seq = {}, {}
    j = 0
    for u in usage:
        while j + 1 < len(requests) and requests[j + 1]['time'] <= u['time']:
            j += 1
        billed_by_seq[requests[j]['seq']] = u['usage']['input'] + u['usage']['cacheRead']
        hit_by_seq[requests[j]['seq']] = u['usage']['cacheRead']
    verdicts = Counter()
    ages = []
    for i, r in enumerate(requests):
        if r['appendOnly'] is not False or r['seq'] not in hit_by_seq:
            continue
        hashes = [item[2] for item in r['items']]
        best = None
        for q in requests[:i]:
            if q['seq'] not in billed_by_seq or q['instructionsSha'] != r['instructionsSha'] or q['toolsSha'] != r['toolsSha']:
                continue
            n = len(q['items'])
            if n <= len(hashes) and [item[2] for item in q['items']] == hashes[:n]:
                if best is None or billed_by_seq[q['seq']] > billed_by_seq[best['seq']]:
                    best = q
        hit = hit_by_seq[r['seq']]
        if best is None:
            verdicts['no-prefix-request'] += 1
            continue
        predicted = billed_by_seq[best['seq']] // 128 * 128
        age = (r['time'] - best['time']) / 1000
        ages.append(age)
        if abs(hit - predicted) <= 256:
            verdicts['hit = earlier request end'] += 1
        elif hit < predicted:
            verdicts['hit below earlier end'] += 1
        else:
            verdicts['hit above earlier end'] += 1
    ages.sort()
    median = ages[len(ages) // 2] if ages else None
    print(f'== {arm}: rewrites judged={sum(verdicts.values())} {dict(verdicts)}  median age of best prefix request {median}s')


for arm in ARMS:
    run(arm)
