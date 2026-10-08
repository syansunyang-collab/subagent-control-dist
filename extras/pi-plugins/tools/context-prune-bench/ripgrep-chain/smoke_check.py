"""Acceptance checks for the sol-ab-smoke batch: each arm behaves as its label says, compaction runs through the Luna Fast
writer and its continuation stays inside the step, telemetry fields are present, and a stop file aborts a running step.

  python smoke_check.py [batch-name]
"""
import json
import sys
from pathlib import Path

BATCH = Path('E:/Pi_Coding_Agent/test-results/context-prune-bench') / (sys.argv[1] if len(sys.argv) > 1 else 'ripgrep-chain-sol-ab-smoke-20260926b')
MAIN = 'gpt-6-sol'
WRITERS = ('gpt-6-luna-fast-700k', 'gpt-6-luna')
results = []


def rows(p):
    return [json.loads(line) for line in Path(p).read_text(encoding='utf-8').splitlines() if line.strip()] if Path(p).exists() else []


def check(arm, name, ok, detail=''):
    results.append((arm, name, bool(ok), detail))


for arm in ('N', 'K', 'R'):
    out = BATCH / arm
    run = json.loads((out / 'run.json').read_text(encoding='utf-8'))
    session = rows(next((out / 'sessions').glob('*.jsonl')))
    calls = [c for c in rows(out / 'provider-calls.jsonl') if c['phase'] != 'start']
    side = [c for c in calls if c['model'] != MAIN]
    summaries = [c for c in side if c['method'] == 'stream']
    writers = [c for c in side if c['method'] == 'streamSimple']
    applies = [e for e in session if e.get('customType') == 'context-prune-lab-event' and (e.get('data') or {}).get('event') == 'apply']
    summary_messages = [e for e in session if e.get('customType') == 'context-prune-summary']
    compactions = [e for e in session if e.get('type') == 'compaction']
    usage = rows(out / 'usage.jsonl')
    requests = rows(out / 'requests.jsonl')
    prompts = [e for e in rows(out / 'projection.jsonl') if e['kind'] == 'prompt']
    events = {s['step']: json.loads((out / f"step{s['step']:02d}-{s['milestone']}" / 'events.json').read_text(encoding='utf-8'))
              for s in run['steps'] if (out / f"step{s['step']:02d}-{s['milestone']}" / 'events.json').exists()}

    if arm == 'N':
        check(arm, 'no pruning', not applies and not summaries, f'applies={len(applies)} summaryCalls={len(summaries)}')
        stop_step = next((s for s in run['steps'] if s['milestone'] == 'smoke-stop'), {})
        check(arm, 'stop file aborts the running step', stop_step.get('stopped') and stop_step.get('agent_seconds', 999) < 120 and run['status'] == 'stopped',
              f"stopped={stop_step.get('stopped')} seconds={stop_step.get('agent_seconds')} status={run['status']}")
    if arm == 'K':
        check(arm, 'receipts applied', applies, f'applies={len(applies)}')
        check(arm, 'no summary calls', not summaries and not summary_messages, f'summaryCalls={len(summaries)} summaryMessages={len(summary_messages)}')
    if arm == 'R':
        # A summary cut off by the compaction abort is expected; every other summary call is billed.
        billed = [c for c in summaries if c['phase'] == 'end' and ((c.get('usage') or {}).get('cost') or {}).get('total', 0) > 0]
        check(arm, 'summary calls billed unless aborted', all(c in billed or c.get('stopReason') == 'aborted' for c in summaries), '')
        check(arm, 'summaries written and billed', billed and all(c['model'] in WRITERS for c in summaries), f'summaryCalls={len(summaries)} billed={len(billed)}')
        check(arm, 'summary enters the context', summary_messages, f'summaryMessages={len(summary_messages)}')
    if arm != 'N':
        check(arm, 'status completed', run['status'] == 'completed', run['status'])

    # K prunes enough to stay under the smoke threshold; its compaction stack is the one N and R exercise.
    if arm != 'K':
        check(arm, 'compaction happened', compactions, f'compactions={len(compactions)}')
        check(arm, 'writer is Luna Fast', writers and all(c['model'] in WRITERS for c in writers) and len(writers) >= len(compactions),
              f"writers={[c['model'] for c in writers]}")
        first = events.get(1, {})
        check(arm, 'continuation inside step 1', first.get('compactions', 0) >= 1 and first.get('continuations', 0) >= 1 and not first.get('missingContinuation'),
              {k: first.get(k) for k in ('compactions', 'continuations', 'missingContinuation', 'retries')})
        continuation_steps = {p['step'] for p in prompts if p.get('continuation')}
        check(arm, 'step number kept across continuation', continuation_steps <= {1} and continuation_steps, f'continuationSteps={continuation_steps}')
    check(arm, 'usage rows carry steps', usage and all(u.get('step') in (1, 2, 3) for u in usage), f"steps={sorted({u.get('step') for u in usage}, key=str)}")
    check(arm, 'request fingerprints', requests and all(r['items'] and r['instructionsSha'] for r in requests) and any(r['firstDiff'] is not None for r in requests),
          f'requests={len(requests)}')
    ws = [u.get('websocket') for u in usage]
    check(arm, 'websocket counters', ws and all(w and 'delta' in w for w in ws) and any(w['delta'].get('deltaRequests', 0) or w['delta'].get('fullContextRequests', 0) for w in ws),
          f"delta={sum((w or {}).get('delta', {}).get('deltaRequests', 0) for w in ws)} full={sum((w or {}).get('delta', {}).get('fullContextRequests', 0) for w in ws)}")
    main_cost = sum(u['usage']['cost']['total'] for u in usage)
    side_cost = sum(((c.get('usage') or {}).get('cost') or {}).get('total', 0) for c in side)
    print(f'{arm}: main ${main_cost:.3f} side ${side_cost:.3f} requests={len(usage)}')

failed = [r for r in results if not r[2]]
for arm, name, ok, detail in results:
    print(f"{'PASS' if ok else 'FAIL'} {arm} {name}: {detail}")
print(f'{len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
