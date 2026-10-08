"""Stops every running chain batch when the Codex weekly quota resets or falls to the floor. No model calls.

Every 10 minutes it reads the quota (tools/codex_quota.py). It writes STOP into each batch whose supervisor is still
running when the remaining percent jumps up by 30 points or more (the window reset) or drops to --floor or below.
Exits when no batch is running. Log: test-results/context-prune-bench/quota-guard.log.

  python quota_guard.py --floor 20
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import codex_quota  # noqa: E402

ROOT = Path('E:/Pi_Coding_Agent/test-results/context-prune-bench')
LOG = ROOT / 'quota-guard.log'


def log(message):
    line = f"{time.strftime('%H:%M:%S')} {message}"
    print(line, flush=True)
    with LOG.open('a', encoding='utf-8') as fh:
        fh.write(line + '\n')


def running():
    batches = []
    # Only today's batches; an older supervisor.json can be left at "running" by an interrupted run.
    for sup in ROOT.glob(f"ripgrep-chain-*{time.strftime('%Y%m%d')}*/supervisor.json"):
        try:
            if json.loads(sup.read_text(encoding='utf-8')).get('status') == 'running':
                batches.append(sup.parent)
        except Exception:
            pass
    return batches


def remaining():
    weekly = [w for w in codex_quota.summary(codex_quota.fetch())['windows'] if w['seconds'] == 604800]
    return weekly[0]['remainingPercent'] if weekly else None


parser = argparse.ArgumentParser()
parser.add_argument('--floor', type=float, default=20)
args = parser.parse_args()
previous = None
while True:
    batches = running()
    if not batches:
        log('no running batch; guard exits')
        break
    try:
        left = remaining()
    except Exception as error:
        log(f'quota read failed: {type(error).__name__}: {error}')
        time.sleep(600)
        continue
    reason = None
    if previous is not None and left is not None and left >= previous + 30:
        reason = f'quota reset: remaining {previous}% -> {left}%'
    elif left is not None and left <= args.floor:
        reason = f'quota floor: remaining {left}% <= {args.floor}%'
    log(f'remaining {left}%  running {[b.name for b in batches]}' + (f'  STOP: {reason}' if reason else ''))
    if reason:
        for batch in batches:
            (batch / 'STOP').write_text(reason, encoding='utf-8')
        break
    previous = left
    time.sleep(600)
