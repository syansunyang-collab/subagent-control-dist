"""Replay pruning policies on real Pi sessions under three prompt-cache assumptions for a history rewrite.

Usage: python prune_econ_replay.py SESSION.jsonl [...]

The real trajectory supplies every request's unpruned context G (provider-reported context plus the net tokens the
real run had already pruned in the compaction window), its output, its tool calls and each tool result's size
(o200k_base). A result sits at G(issuing request) + output in unpruned coordinates. New content per request is the
same for every policy; policies differ only in which results they replace with a receipt and when.

A cut that first changes the context at position c is priced under three hit assumptions:
  A  the hit lands at the change point c (floored to 128)
  B  the hit falls back to the shared prefix of instructions and tools (25.7K on the production Astra session)
  C  per-session mix of A and B, weighted by the share of real cuts whose hit landed within 2K of c
  D  the hit lands at the latest cache entry at or before c: the shared prefix or the end of an earlier request
     whose prefix no later cut has changed. A cut that starts inside results kept by the previous cut therefore
     falls back to that cut's hit. `validate_d` compares this prediction with the real hits.
Measured on 2026-09-27: 17 of 53 production cuts and 5 of 155 bench cuts landed at c; the rest fell back.
Without a cut, a request reuses the previous context. Input above 272K doubles both prices. When a policy's context
reaches 90% of the window, the replay inserts a compaction that re-sends a 50K context uncached.

Policies
  real       the cuts the session actually made, at the requests where they happened
  none       never cut
  N-k        oldest seen results outside the last two tool turns, cut once they reach N thousand tokens
  econ-H     all such results as one batch, cut when net x R x cacheRead price >= tail x (input - cacheRead) price;
             tail is the pessimistic B re-send, R = min(H, requests left before the compaction line at median growth)
  Options appended to N-k with '+':
    gapG     no cut within G requests of the previous cut in the same compaction window
    nearP    no cut while the context is at or above P% of the compaction line
    keepK    protect the last K tool turns instead of 2
    freeze   results already on the context at the previous cut are never released: the next cut starts after
             the previous cut request, where that request left a cache entry
Usage: python prune_econ_replay.py [--policies=15k,15k+freeze,...] SESSION.jsonl [...]
"""
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from prune_policy_replay import ENC, LAB, READBACK_TOOL, load_branch, text_of  # noqa: E402

SHARED = 25728
STUB = 30
POST_COMPACT = 50000
PRICE = (10, 1)  # gpt-6-astra input / cacheRead per M tokens
TIER = 272000
POLICIES = ['real', 'none', '6k', '15k', '30k', 'econ-100',
            '15k+gap5', '15k+gap10', '15k+gap20', '15k+near70', '15k+near80', '15k+keep3', '15k+keep4',
            '15k+gap10+near80', '15k+gap10+near80+keep3', '30k+near80', '30k+near80+keep3']


def load(path):
    windows, win, removed, pending = [], None, 0, []
    for e in load_branch(path):
        m, d = e.get('message') or {}, e.get('data') or {}
        if e.get('type') == 'compaction':
            win = {'reqs': [], 'results': {}}
            windows.append(win)
            removed, pending = 0, []
            continue
        if win is None:
            win = {'reqs': [], 'results': {}}
            windows.append(win)
        if e.get('customType') == LAB and d.get('event') == 'apply' and d.get('phase') in ('budget', 'mask'):
            removed += d.get('netTokens') or 0
            pending += d.get('candidateToolCallIds') or []
        elif e.get('type') == 'message' and m.get('role') == 'assistant':
            u = m.get('usage') or {}
            ctx = u.get('input', 0) + u.get('cacheRead', 0) + u.get('cacheWrite', 0)
            if not ctx:
                continue
            calls = [c['id'] for c in m.get('content') or [] if isinstance(c, dict) and c.get('type') == 'toolCall']
            win['reqs'].append({'G': ctx + removed, 'ctx': ctx, 'hit': u.get('cacheRead', 0), 'out': u.get('output', 0),
                                'calls': calls, 'cut': pending})
            pending = []
        elif e.get('type') == 'message' and m.get('role') == 'toolResult' and m.get('toolName') != READBACK_TOOL:
            win['results'][m.get('toolCallId')] = len(ENC.encode(text_of(m.get('content')), disallowed_special=()))
    for w in windows:
        issued = {c: i for i, r in enumerate(w['reqs']) for c in r['calls']}
        w['results'] = {c: {'req': issued[c], 'tokens': t} for c, t in w['results'].items() if c in issued}
    return [w for w in windows if w['reqs']]


def measured_share(windows):
    """Share of real cuts whose hit landed within 2K of the change point (cache_prefix_check.py rule)."""
    near = total = 0
    for w in windows:
        reqs, res = w['reqs'], w['results']
        for i, r in enumerate(reqs):
            ids = [c for c in r['cut'] if c in res]
            if not i or not ids:
                continue
            p = min(res[c]['req'] for c in ids)
            removed_prev = reqs[i - 1]['G'] - reqs[i - 1]['ctx']
            c = min(reqs[p]['G'] + reqs[p]['out'] - removed_prev, reqs[i - 1]['ctx']) // 128 * 128
            near += abs(r['hit'] - c) <= 2000
            total += 1
    return near / total if total else 0.0, total


def parse_policy(policy):
    base, *opts = policy.split('+')
    o = {'gap': 0, 'near': None, 'keep': 2, 'freeze': False}
    for x in opts:
        if x == 'freeze':
            o['freeze'] = True
            continue
        for key in ('gap', 'near', 'keep'):
            if x.startswith(key):
                o[key] = int(x[len(key):])
    return base, o


def simulate(windows, policy, share, line, growth, trace=None):
    base, opt = parse_policy(policy)
    cost = {'A': 0.0, 'B': 0.0, 'C': 0.0, 'D': 0.0}
    stats = {'cuts': 0, 'released': 0, 'compactions': 0, 'tier': 0, 'peak': 0}
    pin, pcr = PRICE
    for w in windows:
        reqs, res = w['reqs'], w['results']
        turns = [i for i, r in enumerate(reqs) if r['calls']]
        cut, removed, prev_ctx, last_cut = set(), 0, None, None
        entries = [SHARED]  # D: cache entries (current coordinates) whose prefix is still intact
        for i, r in enumerate(reqs):
            G = r['G']
            recent = set([j for j in turns if j < i][-opt['keep']:]) if opt['keep'] > 0 else set()
            # a result is seen once a request carried it: issued at j, sent at j + 1 < i
            floor = last_cut if opt['freeze'] and last_cut is not None else -1
            eligible = sorted((c for c, x in res.items() if floor <= x['req'] < i - 1 and x['req'] not in recent
                               and c not in cut), key=lambda c: res[c]['req'])
            batch = []
            if base == 'real':
                batch = [c for c in r['cut'] if c in res and c not in cut]
            elif base.endswith('k') and base != 'none':
                need, raw = int(base[:-1]) * 1000, 0
                for c in eligible:
                    batch.append(c)
                    raw += res[c]['tokens']
                    if raw >= need:
                        break
                if raw < need:
                    batch = []
            elif base.startswith('econ') and eligible:
                raw = sum(res[c]['tokens'] for c in eligible)
                net = raw - STUB * len(eligible)
                after = G - removed - net
                left = min(int(base[5:]), max(1, (line - (G - removed)) / growth))
                tier = 2 if after > TIER else 1
                if net > 0 and net * left * pcr * tier >= (after - SHARED) * (pin - pcr) * tier:
                    batch = eligible
            if batch and base != 'real':
                if last_cut is not None and i - last_cut < opt['gap']:
                    batch = []
                elif opt['near'] is not None and G - removed >= opt['near'] / 100 * line:
                    batch = []
            growth_i = G - reqs[i - 1]['G'] if i else G
            extra = {'A': 0, 'B': 0, 'D': 0}
            if batch:
                change = min(reqs[res[c]['req']]['G'] + reqs[res[c]['req']]['out'] for c in batch) - removed
                net = sum(res[c]['tokens'] for c in batch) - STUB * len(batch)
                removed += net
                cut.update(batch)
                stats['cuts'] += 1
                stats['released'] += net
                last_cut = i
                context = G - removed
                entries = [e for e in entries if e <= change]
                hit_d = (max(entries) if entries else change) // 128 * 128
                for k, hit in (('A', min(change, prev_ctx or 0) // 128 * 128), ('B', SHARED), ('D', hit_d)):
                    extra[k] = max(0, context - hit - growth_i)
                if trace is not None:
                    trace.append((i, r['hit'], hit_d, change))
            context = G - removed
            if context >= line:  # policy-specific compaction; the real ones are window boundaries
                removed = G - POST_COMPACT
                cut.update(res)
                context = POST_COMPACT
                stats['compactions'] += 1
                extra = {'A': context, 'B': context, 'D': context}
                entries = [SHARED]
            tier = 2 if context > TIER else 1
            stats['tier'] += tier == 2
            stats['peak'] = max(stats['peak'], context)
            for k in ('A', 'B', 'D'):
                uncached = min(context, max(0, growth_i) + extra[k])
                cost[k] += (uncached * pin + (context - uncached) * pcr) * tier / 1e6
            entries.append(context)
            prev_ctx = context
    cost['C'] = share * cost['A'] + (1 - share) * cost['B']
    return cost, stats


def validate_d(windows, share, line, growth):
    """Real cuts: how often the D prediction lands within 2K of the real hit, and the A rule for comparison."""
    trace = []
    simulate(windows, 'real', share, line, growth, trace)
    within = sum(abs(real - pred) <= 2000 for _, real, pred, _ in trace)
    within_a = sum(abs(real - change // 128 * 128) <= 2000 for _, real, _, change in trace)
    return within, within_a, len(trace)


def main():
    chosen = [a.split('=', 1)[1].split(',') for a in sys.argv[1:] if a.startswith('--policies=')]
    policies = chosen[0] if chosen else POLICIES
    for path in [a for a in sys.argv[1:] if not a.startswith('--policies=')]:
        windows = load(path)
        real_ctx = [r['ctx'] for w in windows for r in w['reqs']]
        window = 500000 if max(real_ctx) > TIER else TIER
        line = int(window * 0.9)
        growth = statistics.median(b['G'] - a['G'] for w in windows for a, b in zip(w['reqs'], w['reqs'][1:])
                                   if 0 < b['G'] - a['G'] < 30000)
        share, n_cuts = measured_share(windows)
        pin, pcr = PRICE
        actual = sum(((r['ctx'] - r['hit']) * pin + r['hit'] * pcr) * (2 if r['ctx'] > TIER else 1) / 1e6
                     for w in windows for r in w['reqs'])
        print(f"{Path(path).name[:48]}  requests {len(real_ctx)}  windows {len(windows)}  window {window // 1000}K  "
              f"growth/request {growth:.0f}  real cuts {n_cuts} landed at change point {share:.0%}")
        within, within_a, n = validate_d(windows, share, line, growth)
        print(f"  actual input bill ${actual:.2f}   D prediction within 2K of the real hit: {within}/{n} (A rule: {within_a}/{n})")
        for policy in policies:
            cost, s = simulate(windows, policy, share, line, growth)
            print(f"  {policy:22s} A ${cost['A']:7.2f}  C ${cost['C']:7.2f}  D ${cost['D']:7.2f}  B ${cost['B']:7.2f}   "
                  f"cuts {s['cuts']:3d}  released {s['released'] / 1e3:5.0f}K  peak {s['peak'] / 1e3:4.0f}K  "
                  f">272K {s['tier']:4d}  compactions+{s['compactions']}")


if __name__ == '__main__':
    main()
