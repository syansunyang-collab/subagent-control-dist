"""Check the prompt-cache model against a real session: predict each request's uncached input from the pruning
cuts that actually happened, and compare with the provider-reported usage.

Usage: python cache_model_check.py SESSION.jsonl [--price-in 2 --price-cache 0.2] [--since ISO] [--until ISO]

Model. Request i's context is taken from the real usage (input + cacheRead + cacheWrite), so only the split into
cached and uncached is predicted. The unpruned position of everything is G = context + tokens the real run had
removed so far in the compaction window (lab apply events: budget and mask add their net, stage adds back its
summary). Without a cut before request i, the previous request end is reused: uncached = G_i - G_(i-1). With a cut,
the latest earlier request end at or before the cut point whose prefix no later cut changed is reused, and
everything after it is re-sent. A compaction, model change or the first request re-sends everything.
Prices apply to input only; the whole request doubles above 272K. Output is not modeled.

Status: the request-end reuse rule fails on pruned sessions (Sol R +47%); see
notes/verify/codex-cache-prefix-rule-20260925.md and cache_prefix_check.py.
"""
import argparse
import json
import statistics
from datetime import datetime
from pathlib import Path

LAB = 'context-prune-lab-event'
TIER = 272000


def load_branch(path):
    entries, order = {}, []
    for line in Path(path).open(encoding='utf-8', errors='replace'):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if 'id' in e:
            entries[e['id']] = e
            order.append(e['id'])
    chain, cur = [], order[-1]
    while cur in entries:
        chain.append(entries[cur])
        cur = entries[cur].get('parentId')
    return chain[::-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('session')
    ap.add_argument('--price-in', type=float, default=10)
    ap.add_argument('--price-cache', type=float, default=1)
    ap.add_argument('--since', default='')
    ap.add_argument('--until', default='9999')
    ap.add_argument('--recent', type=int, default=0,
                    help='prefixes inside the last N requests are reusable even when a later cut changed an earlier position')
    a = ap.parse_args()

    reqs = []            # dicts: G, input, cacheRead, cold, cuts (list of cut points applied before it)
    removed = 0
    produced_at = {}     # toolCallId -> index of the request that issued the call
    pending_cuts = []    # cut points waiting for the next request
    cold = True
    model = None
    for e in load_branch(a.session):
        t, m, d = e.get('type'), e.get('message') or {}, e.get('data') or {}
        stamp = e.get('timestamp', '')
        if t == 'compaction':
            removed, produced_at, pending_cuts, cold = 0, {}, [], True
            reqs.append(None)  # window separator
            continue
        if e.get('customType') == LAB and d.get('event') == 'apply':
            phase = d.get('phase')
            ids = [i for i in d.get('candidateToolCallIds') or [] if i in produced_at]
            if phase in ('budget', 'mask'):
                removed += d.get('netTokens') or 0
            elif phase == 'stage':
                removed -= d.get('summaryTokens') or 0
            if ids and phase in ('budget', 'mask', 'stage'):
                pending_cuts.append(min(produced_at[i] for i in ids))
            continue
        if t in ('model_change', 'thinking_level_change'):
            cold = True
            continue
        if t != 'message' or m.get('role') != 'assistant':
            continue
        u = m.get('usage') or {}
        context = u.get('input', 0) + u.get('cacheRead', 0) + u.get('cacheWrite', 0)
        if not context:
            continue
        if m.get('model') != model:
            cold, model = True, m.get('model')
        idx = len(reqs)
        reqs.append({'G': context + removed, 'context': context, 'input': u.get('input', 0) + u.get('cacheWrite', 0),
                     'cacheRead': u.get('cacheRead', 0), 'cold': cold, 'cut_reqs': list(pending_cuts),
                     'keep': since_ok(stamp, a)})
        for c in m.get('content') or []:
            if isinstance(c, dict) and c.get('type') == 'toolCall':
                produced_at[c.get('id')] = idx
        pending_cuts, cold = [], False

    real = model_cost = 0.0
    real_unc = model_unc = 0
    errors = []
    cut_hist = []  # (request index, cut point G) within the current window
    for i, r in enumerate(reqs):
        if r is None:
            cut_hist = []
            continue
        prev = reqs[i - 1] if i and reqs[i - 1] is not None else None
        if r['cold'] or prev is None:
            unc = r['context']
        elif not r['cut_reqs']:
            unc = max(0, r['G'] - prev['G'])
        else:
            point = min(reqs[j]['G'] for j in r['cut_reqs'])
            reused = 0
            for j in range(i - 1, -1, -1):
                if reqs[j] is None:
                    break
                bj = reqs[j]['G']
                if bj > point:
                    continue
                if i - j <= a.recent or all(not (k > j and cp < bj) for k, cp in cut_hist):
                    reused = reqs[j]['context']  # that request's whole input is an unchanged prefix of this one
                    break
            unc = r['context'] - reused
            cut_hist.append((i, point))
        unc = min(unc, r['context'])
        if not r['keep']:
            continue
        tier = 2 if r['context'] > TIER else 1
        real += (r['input'] * a.price_in + r['cacheRead'] * a.price_cache) * tier / 1e6
        model_cost += (unc * a.price_in + (r['context'] - unc) * a.price_cache) * tier / 1e6
        real_unc += r['input']
        model_unc += unc
        errors.append(r['input'] - unc)
    n = len(errors)
    big = sum(1 for x in errors if abs(x) > 5000)
    print(f"requests {n}  real input bill ${real:.2f}  model ${model_cost:.2f}  error {100 * (model_cost - real) / real:+.1f}%")
    print(f"uncached tokens real {real_unc / 1e6:.2f}M  model {model_unc / 1e6:.2f}M")
    print(f"per-request |real - model| > 5K: {big}  median error {statistics.median(errors):.0f}  "
          f"real>model by >5K: {sum(1 for x in errors if x > 5000)}  model>real by >5K: {sum(1 for x in errors if x < -5000)}")


def since_ok(stamp, a):
    return a.since <= stamp < a.until


if __name__ == '__main__':
    main()
