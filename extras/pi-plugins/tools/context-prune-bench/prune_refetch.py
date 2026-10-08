"""What the main model does with pruned tool results: read-back calls, identical re-runs and re-reads.

  python prune_refetch.py SESSION.jsonl [...]

Per session, in file order:
- pruned: tool results archived by the pruner (context-prune-index entries), by tool name.
- readback: context_tree_query calls.
- rerun: a call with the same tool name and identical arguments as an earlier call; split by whether that earlier
  call's result had been pruned before this call (after-prune) or was still in context (intact).
- reread: a read of a path whose latest earlier read was pruned before this call, with no edit/write to the path
  in between (overlapping ranges are not required; any read of the same path counts).
Rates are per earlier call: after-prune reruns / pruned calls, intact reruns / calls never pruned.
"""
import json
import sys
from collections import Counter

EDIT_TOOLS = {'edit', 'write', 'multi_edit', 'apply_patch'}
READ_TOOLS = {'read', 'read_symbol'}


def canon(args):
    return json.dumps(args or {}, sort_keys=True, ensure_ascii=False)


def path_of(args):
    return str((args or {}).get('path') or (args or {}).get('file_path') or '').replace('\\', '/').lstrip('./').lower()


def analyse(path):
    calls = {}           # id -> (name, key)
    first_by_key = {}    # (name, argsJson) -> earlier call ids
    pruned_at = {}       # call id -> order index when archived
    last_read = {}       # path -> call id of latest read
    edited_after = {}    # path -> order index of latest edit
    pruned_tools = Counter()
    readback = 0
    rerun_pruned, rerun_intact, reread = Counter(), Counter(), Counter()
    total_calls = Counter()
    order = 0
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        order += 1
        if e.get('customType') == 'context-prune-index':
            for tc in (e.get('data') or {}).get('toolCalls') or []:
                if tc.get('toolCallId') not in pruned_at:
                    pruned_at[tc['toolCallId']] = order
                    pruned_tools[tc.get('toolName')] += 1
            continue
        m = e.get('message') or {}
        if m.get('role') != 'assistant':
            continue
        for c in m.get('content') or []:
            if not isinstance(c, dict) or c.get('type') != 'toolCall':
                continue
            name, args = c.get('name'), c.get('arguments') or {}
            total_calls[name] += 1
            if name == 'context_tree_query':
                readback += 1
                continue
            key = (name, canon(args))
            for earlier in first_by_key.get(key, []):
                (rerun_pruned if earlier in pruned_at else rerun_intact)[name] += 1
                break
            if name in READ_TOOLS:
                p = path_of(args)
                prev = last_read.get(p)
                if prev in pruned_at and edited_after.get(p, -1) < pruned_at[prev]:
                    reread[name] += 1
                last_read[p] = c.get('id')
            if name in EDIT_TOOLS:
                edited_after[path_of(args)] = order
            first_by_key.setdefault(key, []).insert(0, c.get('id'))
            calls[c.get('id')] = key
    n_pruned = sum(pruned_tools.values())
    n_calls = sum(total_calls.values())
    return {
        'session': path.replace('\\', '/').split('/')[-3] if '/sessions/' in path.replace('\\', '/') else path[-60:],
        'calls': n_calls, 'pruned': n_pruned, 'prunedByTool': dict(pruned_tools.most_common(6)),
        'readback': readback,
        'rerunAfterPrune': sum(rerun_pruned.values()), 'rerunAfterPruneByTool': dict(rerun_pruned.most_common(5)),
        'rerunIntact': sum(rerun_intact.values()),
        'rerunAfterPruneRate': round(sum(rerun_pruned.values()) / n_pruned, 3) if n_pruned else None,
        'rerunIntactRate': round(sum(rerun_intact.values()) / max(1, n_calls - n_pruned), 3),
        'rereadAfterPrune': sum(reread.values()),
    }


if __name__ == '__main__':
    for p in sys.argv[1:]:
        print(json.dumps(analyse(p), ensure_ascii=False))
