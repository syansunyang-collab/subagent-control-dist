"""Q7: how pruning and compaction interact. No model calls.

Per compaction: the context midrun believed it had (its notify line), the billed context of the last successful response
before it, whether a retry context_edit preceded it (Pi then estimates from the unpruned session), and the billed hit of
the first response after it. A compaction whose believed size exceeds the billed size by more than 20 % is flagged as
triggered by the unpruned estimate.

  python q7_compaction.py <batch-dir> [arm ...]
"""
import json
import re
import sys
from pathlib import Path

BATCH = Path(sys.argv[1])
ARMS = sys.argv[2:] or [p.name for p in sorted(BATCH.iterdir()) if (p / 'usage.jsonl').exists()]
TRIGGER = re.compile(r'starting Pi compaction at ([\d,]+)/([\d,]+) tokens')


def rows(p):
    return [json.loads(line) for line in Path(p).read_text(encoding='utf-8').splitlines() if line.strip()]


for arm in ARMS:
    out = BATCH / arm
    session = rows(next((out / 'sessions').glob('*.jsonl')))
    compactions = [e for e in session if e['type'] == 'compaction']
    triggers = [int(m.group(1).replace(',', '')) for line in open(out / 'rpc.jsonl', encoding='utf-8') if (m := TRIGGER.search(line))]
    report = []
    for n, c in enumerate(compactions):
        index = session.index(c)
        before_index = next((i for i in range(index - 1, -1, -1) if session[i]['type'] == 'message' and session[i]['message'].get('role') == 'assistant'
                             and session[i]['message'].get('stopReason') not in ('error', 'aborted') and session[i]['message'].get('usage')), None)
        before = session[before_index]['message'] if before_index is not None else None
        billed = before['usage']['input'] + before['usage']['cacheRead'] if before else None
        edit = before_index is not None and any(e['type'] == 'context_edit' for e in session[before_index:index])
        after = next((e['message'] for e in session[index:] if e['type'] == 'message' and e['message'].get('role') == 'assistant'
                      and e['message'].get('usage') and e['message'].get('stopReason') not in ('error', 'aborted')), None)
        believed = triggers[n] if n < len(triggers) else c.get('tokensBefore')
        report.append({'at': c['timestamp'][11:19], 'believed': believed, 'billedBefore': billed, 'retryEditBefore': edit,
                       'unprunedEstimate': bool(billed and believed and believed > billed * 1.2),
                       'firstAfter': (after['usage']['input'], after['usage']['cacheRead']) if after else None})
    print(f'== {arm}: compactions={len(compactions)} unpruned-estimate triggers={sum(r["unprunedEstimate"] for r in report)}')
    for r in report:
        print('   ', r)
