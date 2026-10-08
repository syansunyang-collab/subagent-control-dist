"""What a Pi session's provider-reported context is made of, and whether earlier reasoning is billed as input.

  python context_composition.py [--since ISO-TIME] [--model ID] [--at ENTRY-ID ...] SESSION.jsonl

1. Composition at checkpoints (the largest request, plus any --at assistant entry ids): the active branch from the
   last compaction is rebuilt with pruner stubs applied, each part counted with o200k_base; the rest of the
   provider-reported input (system prompt, tool schemas, message framing) is the residual. `reasoningProduced` is
   the reasoning the earlier requests in the window produced (Pi replays it as encrypted reasoning items);
   `reasoningEarlierTurns` is the part produced before the latest user message.
   Stubs are rebuilt from lab `apply` events only; windows that also contain results removed by the older
   frontier/summary mechanism (before 2026-09-22) overcount `toolResultKept`.
2. Consecutive-request deltas: for each pair of requests on one branch with no compaction, prune apply or model
   change in between, delta = reported context growth minus the visible content added. Within a turn and across a
   user message, the delta is compared with the reasoning tokens the earlier request produced: a delta near that
   number means the reasoning is sent back and billed; a delta near zero means it is not.
No message text is printed; only counts.
"""
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

import tiktoken

ENC = tiktoken.get_encoding('o200k_base')
LAB = 'context-prune-lab-event'


def tokens(text):
    return len(ENC.encode(text, disallowed_special=())) if text else 0


def blocks_text(content):
    if isinstance(content, str):
        return content
    return '\n'.join(c.get('text', '') for c in content or [] if isinstance(c, dict) and c.get('type') == 'text')


def load(file):
    entries, order = {}, []
    for line in Path(file).open(encoding='utf-8', errors='replace'):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if 'id' in e:
            entries[e['id']] = e
            order.append(e['id'])
    return entries, order


def branch(entries, leaf):
    chain, cur = [], leaf
    while cur in entries:
        chain.append(entries[cur])
        cur = entries[cur].get('parentId')
    return chain[::-1]


def context_of(entries, leaf):
    """Entries in the model context at `leaf` (last compaction summary + entries from its firstKeptEntryId)."""
    chain = branch(entries, leaf)
    start, summary = 0, None
    for i, e in enumerate(chain):
        if e.get('type') == 'compaction':
            summary = e
            kept = e.get('firstKeptEntryId')
            start = next((j for j, x in enumerate(chain) if x.get('id') == kept), i)
    return summary, chain[start:], chain


def composition(entries, leaf):
    summary, ctx, chain = context_of(entries, leaf)
    stubbed = set()
    for e in chain:
        d = e.get('data') or {}
        if e.get('customType') == LAB and d.get('event') == 'apply':
            stubbed |= set(d.get('candidateToolCallIds') or [])
    part = defaultdict(int)
    count = defaultdict(int)
    part['compactionSummary'] = tokens(summary.get('summary', '')) if summary else 0
    stub_tokens = []
    for e in ctx:
        if e.get('type') == 'custom_message':
            key = 'pruneSummary' if e.get('customType') == 'context-prune-summary' else 'otherInjected'
            part[key] += tokens(blocks_text(e.get('content')) or json.dumps(e.get('content'), ensure_ascii=False))
            count[key] += 1
            continue
        if e.get('type') != 'message':
            continue
        m = e['message']
        role = m.get('role')
        if role == 'user':
            part['user'] += tokens(blocks_text(m.get('content')))
            count['user'] += 1
        elif role == 'toolResult':
            body = tokens(blocks_text(m.get('content')))
            if m.get('toolCallId') in stubbed:
                count['toolResultStubbed'] += 1
                stub_tokens.append(body)
            else:
                part['toolResultKept'] += body
                count['toolResultKept'] += 1
        elif role == 'assistant' and e['id'] != leaf:
            for c in m.get('content') or []:
                t = c.get('type')
                if t == 'text':
                    part['assistantText'] += tokens(c.get('text'))
                elif t == 'toolCall':
                    part['toolCallArgs'] += tokens(json.dumps(c.get('arguments'), ensure_ascii=False))
                    count['toolCall'] += 1
                elif t == 'thinking':
                    part['thinkingSummaryText'] += tokens(c.get('thinking'))
                    count['reasoningItems'] += 1
            part['reasoningProduced'] += (m.get('usage') or {}).get('reasoning', 0)
        elif role == 'system':
            part['systemMessages'] += tokens(blocks_text(m.get('content')))
    # Stubbed results: the pruner replaces the body with a short receipt; count the receipts via apply events.
    applied = [(e.get('data') or {}) for e in chain if e.get('customType') == LAB and (e.get('data') or {}).get('event') == 'apply']
    stub_total = sum(d.get('stubTokens') or 0 for d in applied)
    stub_ids = sum(len(d.get('candidateToolCallIds') or []) for d in applied)
    part['toolResultStubs'] = round(stub_total / stub_ids * count['toolResultStubbed']) if stub_ids else 0
    part['toolResultStubbedRawBodies(not sent)'] = sum(stub_tokens)
    last_user = max((i for i, e in enumerate(ctx) if e.get('type') == 'message' and e['message'].get('role') == 'user'), default=0)
    part['reasoningEarlierTurns'] = sum((e['message'].get('usage') or {}).get('reasoning', 0) for e in ctx[:last_user]
                                        if e.get('type') == 'message' and e['message'].get('role') == 'assistant')
    u = entries[leaf]['message'].get('usage') or {}
    reported = u.get('input', 0) + u.get('cacheRead', 0) + u.get('cacheWrite', 0)
    sent = sum(v for k, v in part.items() if k not in ('reasoningProduced', 'reasoningEarlierTurns', 'toolResultStubbedRawBodies(not sent)'))
    return {'entry': leaf, 'timestamp': entries[leaf].get('timestamp'), 'reported': reported, 'visibleCounted': sent,
            'residualAfterReasoning': reported - sent - part['reasoningProduced'], 'parts': dict(part), 'counts': dict(count),
            'contextEntries': len(ctx)}


def deltas(entries, order, since, model):
    """Growth between consecutive requests on one branch, minus the visible content added between them."""
    rows = []
    for eid in order:
        e = entries[eid]
        m = e.get('message') or {}
        if e.get('type') != 'message' or m.get('role') != 'assistant' or (e.get('timestamp') or '') < since:
            continue
        if model and m.get('model') != model:
            continue
        u = m.get('usage') or {}
        rep = u.get('input', 0) + u.get('cacheRead', 0) + u.get('cacheWrite', 0)
        if not rep:
            continue
        # Walk back to the previous assistant request on this branch.
        between, cur = [], e.get('parentId')
        while cur in entries:
            x = entries[cur]
            xm = x.get('message') or {}
            if x.get('type') == 'message' and xm.get('role') == 'assistant' and (xm.get('usage') or {}).get('input', 0) + (xm.get('usage') or {}).get('cacheRead', 0) > 0:
                break
            between.append(x)
            cur = x.get('parentId')
        if cur not in entries:
            continue
        p = entries[cur]
        pm = p['message']
        if pm.get('model') != m.get('model'):
            continue
        if any(x.get('type') == 'compaction' or (x.get('customType') == LAB and (x.get('data') or {}).get('event') == 'apply') for x in between):
            continue
        pu = pm.get('usage') or {}
        prep = pu.get('input', 0) + pu.get('cacheRead', 0) + pu.get('cacheWrite', 0)
        added = 0
        for c in pm.get('content') or []:
            if c.get('type') == 'text':
                added += tokens(c.get('text'))
            elif c.get('type') == 'toolCall':
                added += tokens(json.dumps(c.get('arguments'), ensure_ascii=False))
            elif c.get('type') == 'thinking':
                added += tokens(c.get('thinking'))
        user_turn = False
        for x in between:
            xm = x.get('message') or {}
            if x.get('type') == 'message' and xm.get('role') in ('toolResult', 'user', 'system'):
                added += tokens(blocks_text(xm.get('content')))
                user_turn |= xm.get('role') == 'user'
            elif x.get('type') == 'custom_message':
                added += tokens(blocks_text(x.get('content')))
        rows.append({'entry': eid, 'userTurn': user_turn, 'growth': rep - prep, 'visibleAdded': added,
                     'delta': rep - prep - added, 'prevReasoning': pu.get('reasoning', 0),
                     'prevReasoningItems': sum(c.get('type') == 'thinking' for c in pm.get('content') or [])})
    return rows


def summarize(rows, user_turn):
    sel = [r for r in rows if r['userTurn'] == user_turn]
    with_r = [r for r in sel if r['prevReasoning'] > 0]
    if not with_r:
        return {'pairs': len(sel)}
    ratio = [r['delta'] / r['prevReasoning'] for r in with_r if r['prevReasoning'] >= 200]
    return {'pairs': len(sel), 'pairsWithPrevReasoning': len(with_r),
            'medianDelta': statistics.median(r['delta'] for r in with_r),
            'medianPrevReasoning': statistics.median(r['prevReasoning'] for r in with_r),
            'medianDeltaOverReasoning(prevReasoning>=200)': round(statistics.median(ratio), 3) if ratio else None,
            'medianDeltaNoPrevReasoning': statistics.median([r['delta'] for r in sel if r['prevReasoning'] == 0] or [0])}


if __name__ == '__main__':
    argv = sys.argv[1:]
    since = argv[argv.index('--since') + 1] if '--since' in argv else ''
    model = argv[argv.index('--model') + 1] if '--model' in argv else None
    at = [argv[i + 1] for i, a in enumerate(argv) if a == '--at']
    file = [a for i, a in enumerate(argv) if not a.startswith('--') and (i == 0 or argv[i - 1] not in ('--since', '--model', '--at'))][0]
    entries, order = load(file)
    req = [(entries[i]['message'].get('usage') or {}) for i in order if entries[i].get('type') == 'message'
           and entries[i]['message'].get('role') == 'assistant' and (entries[i].get('timestamp') or '') >= since
           and (not model or entries[i]['message'].get('model') == model)]
    ids = [i for i in order if entries[i].get('type') == 'message' and entries[i]['message'].get('role') == 'assistant'
           and (entries[i].get('timestamp') or '') >= since and (not model or entries[i]['message'].get('model') == model)]
    peak = max(ids, key=lambda i: sum((entries[i]['message'].get('usage') or {}).get(k, 0) for k in ('input', 'cacheRead', 'cacheWrite')))
    rows = deltas(entries, order, since, model)
    out = {'session': Path(file).name, 'checkpoints': [composition(entries, i) for i in [peak, *at]],
           'deltaWithinTurn': summarize(rows, False), 'deltaAcrossUserMessage': summarize(rows, True)}
    print(json.dumps(out, ensure_ascii=False, indent=1))
