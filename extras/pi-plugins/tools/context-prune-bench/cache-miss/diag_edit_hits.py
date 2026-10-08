"""List every history-editing request in the payload-cache-diag log with its cache hit and first-change position.

Usage: python diag_edit_hits.py [~/.pi/agent/logs/payload-cache-diag.jsonl]

The log (written by ~/.pi/agent/extensions/payload-cache-diag.ts) records, per request, the first input item that
differs from the previous request and the characters before it, followed by the usage. The first-change position in
tokens is estimated as charsBeforeDiff / totalChars x context; the character-to-token ratio is not uniform, so the
estimate is a few thousand tokens off at 200K context.
"""
import json
import sys
from pathlib import Path

path = sys.argv[1] if len(sys.argv) > 1 else Path.home() / '.pi/agent/logs/payload-cache-diag.jsonl'
sessions = {}
for line in open(path, encoding='utf-8'):
    r = json.loads(line)
    sessions.setdefault(r['session'], []).append(r)
for session, rows in sessions.items():
    edits, request = [], None
    for r in rows:
        if r['kind'] == 'request':
            request = r
            continue
        q, request = request, None
        ctx = r['input'] + r['cacheRead']
        if q is None or q.get('appendOnly') or q.get('charsBeforeDiff') is None or not ctx:
            continue
        est = round(q['charsBeforeDiff'] / q['totalChars'] * ctx)
        changed = '' if q['instructionsSame'] and q['toolsSame'] else ' (instructions or tools changed)'
        edits.append(f"  {q['time']}  {q['diffItemType']:<20} first change ~{est:>7}  hit {r['cacheRead']:>7}  "
                     f"uncached {r['input']:>7}{changed}")
    if edits:
        print(f"{session} {rows[0]['model']}: {len(edits)} editing requests")
        print('\n'.join(edits))
