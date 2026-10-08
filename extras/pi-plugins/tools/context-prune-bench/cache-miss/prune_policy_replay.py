"""Offline replay of pruning policies against one Pi session, with a prompt-cache cost model.

Usage: python prune_policy_replay.py SESSION.jsonl [--since ISO] [--until ISO] [--summary-seconds 20]

Stream. The active branch is walked from the first compaction at or after --since. For each request i the
unpruned context size G_i is the provider-reported input (input + cacheRead + cacheWrite) plus the net tokens the
real run had already removed in this compaction window (lab `apply` events: budget and mask add their net,
stage adds back its summary). Tool results are counted with o200k_base. A result's cut point is G at the request
that issued its tool call: the last request boundary before the result.

Cost model (Codex prompt cache, measured 2026-09-25). A request reuses the latest earlier request boundary whose
prefix is unchanged; a cut at point P recomputes everything after the latest boundary at or before P that no
later cut invalidated (a cut at P' invalidates every boundary after P' created before that cut). Boundaries do
not expire here (Luna probe: alive after 57 min). Random server misses, tool-list and system-prompt changes are
the same for every policy and left out. Prices per model (input / cacheRead, per M tokens) with the whole-request
tier above 272K doubling both. Compactions stay where the real run had them; requests whose context would exceed
the window are counted as overflow instead.

Policies
  none       never cut
  6k         current budget-summary: oldest releasable first, skip the last 2 tool turns, stop at 6000 raw tokens,
             one batch at a time, applied at the first request after the measured summary delay
  line       price line only: at 0.85 x 272K cut every releasable result except the newest tool turn
  6k+line    both (production before 2026-09-25)
  new-K      shallow cuts: results that left the last K tool turns one request ago and lie after the frontier
             (the latest cut point); cut when net release x expected remaining requests x cacheRead price covers
             depth x (input - cacheRead) price; expected remaining = (compaction line - context) / median growth
  new-K+line the same plus the price line
  shallow-K  cumulative shallow cuts, no gate and no frontier: every uncut result is cut one request after it leaves
             the last K tool turns (like 6k without the 6000 threshold and the queue, so the cut stays near the tail)
"""
import argparse
import json
import statistics
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import tiktoken

ENC = tiktoken.get_encoding('o200k_base')
LAB = 'context-prune-lab-event'
READBACK_TOOL = 'context_tree_query'
STUB_TOKENS = 7
PRICES = {  # input, cacheRead per M tokens; tier above 272K doubles both
    'gpt-6-astra': (10, 1), 'gpt-6-astra-500k': (10, 1),
}
WINDOWS = {'gpt-6-astra': 272000, 'gpt-6-astra-500k': 500000}
TIER = 272000
PRICE_LINE = int(272000 * 0.85)


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


def text_of(content):
    if isinstance(content, str):
        return content
    return '\n'.join(c.get('text', '') for c in content or [] if isinstance(c, dict) and c.get('type') == 'text')


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


def build_windows(chain, since, until):
    """Split the branch into compaction windows of requests with G, time, model and the results they issued."""
    windows, win, removed = [], None, 0
    pending_calls = {}  # toolCallId -> request index in window
    summary_ratio = []
    prepared = {}
    delays, durations = [], []
    for e in chain:
        t, m, d = e.get('type'), e.get('message') or {}, e.get('data') or {}
        stamp = e.get('timestamp', '')
        if t == 'compaction':
            if win and win['requests']:
                windows.append(win)
            win = {'start': stamp, 'requests': [], 'results': {}} if since <= stamp < until else None
            removed, pending_calls = 0, {}
            continue
        if win is None:
            continue
        if e.get('customType') == LAB:
            ids = tuple(d.get('candidateToolCallIds') or [])
            if d.get('event') == 'prepare':
                prepared[ids] = ts(stamp)
            elif d.get('event') == 'idle' and ids in prepared:
                durations.append(ts(stamp) - prepared[ids])
                if d.get('rawTokens') and d.get('summaryTokens'):
                    summary_ratio.append((d['rawTokens'], d['summaryTokens']))
            elif d.get('event') == 'apply':
                if ids in prepared:
                    delays.append(ts(stamp) - prepared[ids])
                phase = d.get('phase')
                if phase in ('budget', 'mask'):
                    removed += d.get('netTokens') or 0
                elif phase == 'stage':
                    removed -= d.get('summaryTokens') or 0
            continue
        if t != 'message':
            continue
        role = m.get('role')
        if role == 'assistant':
            u = m.get('usage') or {}
            total = u.get('input', 0) + u.get('cacheRead', 0) + u.get('cacheWrite', 0)
            if not total:
                continue
            calls = [c.get('id') for c in m.get('content') or [] if isinstance(c, dict) and c.get('type') == 'toolCall']
            idx = len(win['requests'])
            win['requests'].append({'t': ts(stamp), 'G': total + removed, 'model': m.get('model'), 'calls': calls,
                                    'input': u.get('input', 0) + u.get('cacheWrite', 0), 'cacheRead': u.get('cacheRead', 0)})
            for c in calls:
                pending_calls[c] = idx
        elif role == 'toolResult':
            cid = m.get('toolCallId')
            if cid in pending_calls and m.get('toolName') != READBACK_TOOL:
                win['results'][cid] = {'req': pending_calls[cid], 'tokens': len(ENC.encode(text_of(m.get('content')), disallowed_special=()))}
    if win and win['requests']:
        windows.append(win)
    return windows, summary_ratio, delays, durations


def summary_tokens(raw, ratio):
    return max(250, int(raw * ratio))


class Ledger:
    def __init__(self, name):
        self.name = name
        self.cost = 0.0
        self.cuts = 0
        self.recompute = []
        self.overflow = 0
        self.tier = 0
        self.peak = 0
        self.waits = []
        self.released = 0
        self.read_cost = 0.0      # cached part of every request
        self.growth_cost = 0.0    # uncached new content (the same for every policy apart from summaries)
        self.cut_cost = 0.0       # extra uncached re-send caused by cuts
        self.context_sum = 0
        self.requests = 0


def simulate(windows, policy, keep, ratio, delay, summary_seconds, growth, lookback):
    L = Ledger(policy)
    use_6k = policy.startswith('6k')
    use_line = policy.endswith('line')
    use_new = policy.startswith('new') or policy.startswith('shallow')
    gate = policy.startswith('new')
    for win in windows:
        reqs, results = win['requests'], win['results']
        # tool turns: request indices that issued calls, in order
        turn_reqs = [i for i, r in enumerate(reqs) if r['calls']]
        cut = set()           # cut result ids
        cut_points = []       # (request index of the cut, cut point G)
        cut_net = []          # (cut point G, net tokens removed by that cut)
        removed = 0           # tokens removed from context so far (net of stubs and summaries)
        pending = None        # 6k: (ready_time, ids)
        frontier_req = -1     # new: request index of the latest cut (its input end)
        for i, r in enumerate(reqs):
            G = r['G']
            price_in, price_cr = PRICES.get(r['model'], (10, 1))
            window = WINDOWS.get(r['model'], 272000)
            line_compact = int(window * 0.9)
            # results seen by the model before request i, outside the last `keep` complete tool turns
            done_turns = [j for j in turn_reqs if j < i]
            recent = set(done_turns[-keep:]) if keep else set()
            eligible = [cid for cid, x in results.items() if x['req'] < i and x['req'] not in recent and cid not in cut]
            batch = []
            if use_6k and pending and r['t'] >= pending[0]:
                batch += [c for c in pending[1] if c not in cut]
                pending = None
            if use_new:
                # left the keep window at least one request ago, and issued after the frontier
                prev_recent = set(j for j in turn_reqs if j < i - 1)
                prev_recent = set(sorted(prev_recent)[-keep:]) if keep else set()
                ready = [c for c in eligible if results[c]['req'] < i - 1 and results[c]['req'] not in prev_recent
                         and (not gate or results[c]['req'] > frontier_req)]
                if ready:
                    raw = sum(results[c]['tokens'] for c in ready)
                    net = raw - STUB_TOKENS * len(ready) - summary_tokens(raw, ratio)
                    point = min(reqs[results[c]['req']]['G'] for c in ready)
                    depth = G - point
                    context = G - removed
                    remaining = min(200, max(1, (line_compact - context) / growth))
                    tier = 2 if context > TIER else 1
                    if net > 0 and (not gate or net * remaining * price_cr >= depth * (price_in - price_cr) * tier):
                        batch += ready
                        gap = r['t'] - reqs[i - 1]['t'] if i else 0
                        L.waits.append(max(0.0, summary_seconds - gap))
            if use_line and (G - removed) >= PRICE_LINE:
                newest = done_turns[-1:] if done_turns else []
                batch += [c for c in eligible if results[c]['req'] not in newest and c not in batch]
            batch = [c for c in dict.fromkeys(batch) if c not in cut]
            extra = 0
            if batch:
                point = min(reqs[results[c]['req']]['G'] for c in batch)
                # latest boundary at or before the cut point that no later cut invalidated
                # reusable positions at or before the cut point: (a) an earlier request end whose prefix no later
                # cut changed; (b) a message ending within the last `lookback` endings of this request, inside a
                # prefix some earlier request already computed with the current layout (one ending per request)
                best = 0
                for j in range(i - 1, -1, -1):
                    bj = reqs[j]['G']
                    if bj > point:
                        continue
                    if i - j <= lookback or all(not (k > j and cp < bj) for k, cp in cut_points):
                        best = bj
                        break
                raw = sum(results[c]['tokens'] for c in batch)
                net = max(0, raw - STUB_TOKENS * len(batch) - summary_tokens(raw, ratio))
                removed += net
                L.released += net
                cut.update(batch)
                cut_points.append((i, point))
                cut_net.append((point, net))
                # tokens actually re-sent uncached: the pruned context after the reused boundary, minus normal growth
                after = (G - best) - sum(n for p_, n in cut_net if p_ >= best)
                extra = max(0, after - (G - reqs[i - 1]['G'] if i else 0))
                frontier_req = i
                L.cuts += 1
                L.recompute.append(extra)
            context = G - removed
            tier = 2 if context > TIER else 1
            growth_i = max(0, G - reqs[i - 1]['G']) if i else G
            uncached = min(context, growth_i + extra)
            extra_used = uncached - min(context, growth_i)
            L.cost += (uncached * price_in + (context - uncached) * price_cr) * tier / 1e6
            L.read_cost += (context - uncached) * price_cr * tier / 1e6
            L.growth_cost += (uncached - extra_used) * price_in * tier / 1e6
            L.cut_cost += extra_used * price_in * tier / 1e6
            L.context_sum += context
            L.requests += 1
            L.peak = max(L.peak, context)
            L.overflow += context > window
            L.tier += context > TIER
            # 6k: turn_end after request i -> prepare the next batch if none pending
            if use_6k and pending is None and r['calls']:
                done_turns_after = [j for j in turn_reqs if j <= i]
                recent_after = set(done_turns_after[-keep:]) if keep else set()
                sel, raw = [], 0
                for cid, x in sorted(results.items(), key=lambda kv: kv[1]['req']):
                    if x['req'] <= i and x['req'] not in recent_after and cid not in cut:
                        sel.append(cid)
                        raw += x['tokens']
                        if raw >= 6000:
                            break
                if raw >= 6000:
                    pending = (r['t'] + delay, sel)
    return L


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('session')
    ap.add_argument('--since', default='2026-09-22T14:00')
    ap.add_argument('--until', default='2099')
    ap.add_argument('--summary-seconds', type=float, default=None)
    ap.add_argument('--lookback', type=int, default=20, help='message endings a lookup searches back (one per request)')
    a = ap.parse_args()
    chain = load_branch(a.session)
    windows, ratios, delays, durations = build_windows(chain, a.since, a.until)
    ratio = statistics.median(s / r for r, s in ratios) if ratios else 0.12
    delay = statistics.median(delays) if delays else 43
    summary_seconds = a.summary_seconds if a.summary_seconds is not None else (statistics.median(durations) if durations else 20)
    growth = statistics.median(b['G'] - a_['G'] for w in windows for a_, b in zip(w['requests'], w['requests'][1:]) if 0 < b['G'] - a_['G'] < 30000)
    n_req = sum(len(w['requests']) for w in windows)
    n_res = sum(len(w['results']) for w in windows)
    print(f"windows {len(windows)}  requests {n_req}  tool results {n_res}  since {a.since}")
    print(f"measured: summary/raw {ratio:.3f}  prepare->apply {delay:.0f}s  summarizer {summary_seconds:.0f}s  growth/request {growth:.0f}")
    actual = 0.0
    for w in windows:
        for r in w['requests']:
            pin, pcr = PRICES.get(r['model'], (10, 1))
            tier = 2 if r['input'] + r['cacheRead'] > TIER else 1
            actual += (r['input'] * pin + r['cacheRead'] * pcr) * tier / 1e6
    print(f"actual input bill of the real run ${actual:.1f}  (lookback {a.lookback})")
    rows = []
    for policy, keep in [('none', 0), ('6k', 2), ('line', 0), ('6k+line', 2), ('new-2', 2), ('new-1', 1), ('new-2+line', 2), ('new-1+line', 1),
                         ('shallow-1', 1), ('shallow-2', 2), ('shallow-1+line', 1), ('shallow-2+line', 2)]:
        L = simulate(windows, policy, keep, ratio, delay, summary_seconds, growth, a.lookback)
        rc = sorted(L.recompute) or [0]
        rows.append(L)
        print(f"{policy:11s} cost ${L.cost:8.1f}  cuts {L.cuts:4d}  released {L.released/1e3:7.0f}K  "
              f"recompute p50 {rc[len(rc)//2]:6d} p90 {rc[int(len(rc)*0.9)]:6d} sum {sum(rc)/1e6:5.2f}M  "
              f"peak {L.peak/1e3:4.0f}K  >272K {L.tier:4d}  overflow {L.overflow:4d}  "
              f"waits {sum(1 for w in L.waits if w > 0)}/{len(L.waits)} mean {statistics.mean(L.waits) if L.waits else 0:.0f}s")
        print(f"{'':11s} avg context {L.context_sum / max(1, L.requests) / 1e3:5.0f}K  read ${L.read_cost:7.1f}  new-content ${L.growth_cost:6.1f}  cut re-send ${L.cut_cost:6.1f}")


if __name__ == '__main__':
    main()
