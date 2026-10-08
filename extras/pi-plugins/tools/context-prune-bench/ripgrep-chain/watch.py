"""Monitor stream for the ripgrep chain: each scored step, status changes, errors, and the supervisor's end."""
import json
import sys
import time
from pathlib import Path

BATCH = Path('E:/Pi_Coding_Agent/test-results/context-prune-bench') / (sys.argv[1] if len(sys.argv) > 1 else 'ripgrep-chain-20260923b')
try:
    ARMS = list(json.loads((BATCH / 'manifest.json').read_text(encoding='utf-8'))['arms'])
except FileNotFoundError:
    ARMS = ['N', 'R', 'L']


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None


seen_steps = {arm: 0 for arm in ARMS}
status = {}
errors = set()
while True:
    for arm in ARMS:
        run = load(BATCH / arm / 'run.json')
        if not run:
            continue
        if status.get(arm) != run['status']:
            status[arm] = run['status']
            print(f"{arm} -> {run['status']}" + (f" fatal={run.get('fatal')}" if run.get('fatal') else ''), flush=True)
        steps = run.get('steps', [])
        for rec in steps[seen_steps[arm]:]:
            s = rec.get('score', {})
            flag = 'SOLVED' if s.get('resolved') else 'unsolved'
            extra = f" ERR={s['error'][:120]}" if s.get('error') else ''
            extra += f" agentErr={rec['agent_error'][:120]}" if rec.get('agent_error') else ''
            print(f"{arm} step{rec['step']} {rec['milestone']} {flag} score={s.get('score', 0):.2f} f2p={s.get('f2p')} n2p={s.get('n2p')} p2p={s.get('p2p')} {rec['agent_seconds']}s{extra}", flush=True)
        seen_steps[arm] = len(steps)
        if (BATCH / arm / 'exception.txt').exists() and arm not in errors:
            errors.add(arm)
            print(f"{arm} exception: {(BATCH / arm / 'exception.txt').read_text(encoding='utf-8')[-400:]}", flush=True)
    sup = load(BATCH / 'supervisor.json') or {}
    if sup.get('status') == 'completed':
        print(f"supervisor completed exitCodes={sup.get('exitCodes')}", flush=True)
        break
    time.sleep(20)
