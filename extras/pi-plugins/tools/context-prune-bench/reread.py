"""Re-read behavior in Pi session files: how often a model reads a file again, split by why the earlier copy was gone.

  python reread.py [--since ISO-TIME] [--until ISO-TIME] [--paths] SESSION.jsonl [...]

A read (read / read_symbol) that overlaps an earlier read of the same path (line ranges from offset/limit; a symbol
overlaps the same symbol or a whole-file read) is classified by the latest overlapping earlier read:
  afterEdit   an edit/write to the path happened after that read (the copy is stale, re-reading is expected)
  pruned      that read's result had been released by the pruner before this call, no edit in between
  compacted   Pi compaction dropped the entry holding that read before this call, no edit in between
  intact      none of these: the earlier result was still in context (or the file changed outside this session)
Counts are per model of the assistant message that issued the call; --since counts only calls at or after that time
(earlier entries still build the history). File order is used; branches are not separated.
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def norm(path, cwd):
    p = str(path or '').replace('\\', '/').strip()
    c = (cwd or '').replace('\\', '/').rstrip('/')
    if c and p.lower().startswith(c.lower() + '/'):
        p = p[len(c) + 1:]
    return p[2:] if p.startswith('./') else p


def span(name, args):
    if name == 'read_symbol':
        return ('sym', str(args.get('symbol') or args.get('name') or ''))
    start = int(args.get('offset') or 1)
    return (start, start + int(args['limit']) - 1 if args.get('limit') else float('inf'))


def overlaps(a, b):
    whole = (1, float('inf'))
    if a[0] == 'sym' or b[0] == 'sym':
        return a == b or whole in (a, b)
    return a[0] <= b[1] and b[0] <= a[1]


def analyze(file, since='', until='~'):
    cwd, pruned, stats = '', set(), defaultdict(lambda: defaultdict(int))
    history = defaultdict(list)  # path -> [(span, tool call id)] in order
    last_edit = {}   # path -> sequence number of the latest edit
    read_seq = {}    # call id -> sequence number
    read_entry = {}  # call id -> index of the entry that issued it
    entry_index = {} # entry id -> index in file order
    compacted = set()
    pruned_paths = Counter()
    seq = 0
    for index, line in enumerate(Path(file).open(encoding='utf-8', errors='replace')):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        entry_index[e.get('id')] = index
        if e.get('type') == 'compaction':
            kept = entry_index.get(e.get('firstKeptEntryId'), index)
            compacted |= {cid for cid, at in read_entry.items() if at < kept}
            stats['*']['compactions'] += 1
        elif e.get('type') == 'session':
            cwd = e.get('cwd', '')
        elif e.get('customType') == 'context-prune-lab-event' and (e.get('data') or {}).get('event') == 'apply':
            pruned |= set(e['data'].get('candidateToolCallIds') or [])
            stats['*']['applies'] += 1
        elif e.get('type') == 'message' and (e.get('message') or {}).get('role') == 'assistant':
            model = e['message'].get('model') or '?'
            counted = since <= (e.get('timestamp') or '') < until
            content = e['message'].get('content')
            for c in content if isinstance(content, list) else []:
                if c.get('type') != 'toolCall':
                    continue
                seq += 1
                args = c.get('arguments') or {}
                s = stats[model] if counted else defaultdict(int)
                s['calls'] += 1
                if c['name'] in ('edit', 'write'):
                    last_edit[norm(args.get('path'), cwd)] = seq
                elif c['name'] in ('read', 'read_symbol'):
                    path = norm(args.get('path'), cwd)
                    here = span(c['name'], args)
                    s['reads'] += 1
                    prev = next((cid for sp, cid in reversed(history[path]) if overlaps(sp, here)), None)
                    if prev is not None:
                        s['rereads'] += 1
                        if last_edit.get(path, -1) > read_seq[prev]:
                            s['afterEdit'] += 1
                        elif prev in pruned:
                            s['pruned'] += 1
                            pruned_paths[path] += counted
                        elif prev in compacted:
                            s['compacted'] += 1
                        else:
                            s['intact'] += 1
                    history[path].append((here, c['id']))
                    read_seq[c['id']] = seq
                    read_entry[c['id']] = index
    meta = stats.pop('*', {})
    analyze.pruned_paths = pruned_paths
    return meta.get('applies', 0), meta.get('compactions', 0), len(pruned), {m: dict(v) for m, v in stats.items()}


if __name__ == '__main__':
    argv = sys.argv[1:]
    since = argv[argv.index('--since') + 1] if '--since' in argv else ''
    until = argv[argv.index('--until') + 1] if '--until' in argv else '~'
    files = [a for i, a in enumerate(argv) if a not in ('--since', '--until', '--paths') and (i == 0 or argv[i - 1] not in ('--since', '--until'))]
    for f in files:
        applies, compactions, released, per_model = analyze(f, since, until)
        for model, s in sorted(per_model.items(), key=lambda kv: -kv[1].get('calls', 0)):
            if s.get('reads', 0) < 20:
                continue
            reads = s['reads']
            pct = lambda k: f"{100 * s.get(k, 0) / reads:.1f}%"
            print(f"{Path(f).parent.name[:40]:40} {model:18} calls={s['calls']:5} reads={reads:5} reread={pct('rereads'):>6}"
                  f"  afterEdit={pct('afterEdit'):>6} pruned={pct('pruned'):>6} compacted={pct('compacted'):>6} intact={pct('intact'):>6}"
                  f"  applies={applies} released={released} compactions={compactions}")
        if '--paths' in sys.argv:
            for path, n in analyze.pruned_paths.most_common(15):
                print(f'    {n:3} {path}')
