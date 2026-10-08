"""Live monitor for a production-profile ripgrep chain batch (sol-ab, sol-ab-k30). No model calls.

Every 60 s it checks each arm and writes STOP-<arm> or STOP (the workers abort the running step on either):
  cost cap per arm or per wave, 429 / usage-limit errors, a compaction writer other than Luna Fast, prune summaries
  failing 10 times in a row or above 25 % of at least 20 calls, a billed request above the context window. It alerts on 30 idle minutes without a request in flight and on
  tool calls that reach outside the arm's workspace. Every 5 minutes it prints one status line per arm.

  python monitor.py ripgrep-chain-sol-ab-20260926
"""
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

BATCH = Path('E:/Pi_Coding_Agent/test-results/context-prune-bench') / sys.argv[1]
MANIFEST = json.loads((BATCH / 'manifest.json').read_text(encoding='utf-8'))
ARMS = list(MANIFEST['arms'])
MAIN = MANIFEST['model'].split('/', 1)[1]
WRITERS = ('gpt-6-luna-fast-700k', 'gpt-6-luna')
# Astra lists at five times the Sol price; its caps are scaled accordingly.
WINDOW = MANIFEST.get('contextWindow', 272_000)
# Above 272K input the list price doubles; a wider window lets a whole arm run there, so its caps double.
SCALE = 2 if WINDOW > 272_000 else 1
CAPS = {a: c * SCALE for a, c in ({'N': 120, 'K': 80, 'R': 100, 'K30': 100, 'KF': 100, 'N70': 120} if 'astra' in MAIN
                                   else {'N': 40, 'K': 25, 'R': 30, 'K30': 35, 'KF': 30, 'N70': 40}).items()}
DEFAULT_CAP = (150 if 'astra' in MAIN else 40) * SCALE
WAVE_CAP = (400 if 'astra' in MAIN else 110) * SCALE
LIMIT_ERROR = re.compile(r'\b429\b|rate.?limit|usage.?limit|quota', re.I)


class Tail:
    """Reads the JSON lines appended to a file since the previous call."""

    def __init__(self, path):
        self.path, self.offset = path, 0

    def read(self):
        if not self.path.exists():
            return []
        with open(self.path, 'rb') as fh:
            fh.seek(self.offset)
            data = fh.read()
        end = data.rfind(b'\n') + 1
        self.offset += end
        return [json.loads(line) for line in data[:end].decode('utf-8').splitlines() if line.strip()]


class Arm:
    def __init__(self, arm):
        self.arm, self.out = arm, BATCH / arm
        self.ws = str(Path('C:/pib') / MANIFEST.get('batch', BATCH.name) / arm / 'ripgrep').replace('\\', '/').lower()
        self.usage, self.calls, self.responses = Tail(self.out / 'usage.jsonl'), Tail(self.out / 'provider-calls.jsonl'), Tail(self.out / 'responses.jsonl')
        self.session = None
        self.cost = {'main': 0.0, 'summary': 0.0, 'writer': 0.0}
        self.requests = self.input = self.cache = 0
        self.context = self.delta = self.full = 0
        self.last_request = time.time()
        self.open_calls = set()
        self.summary_ok = self.summary_err = self.summary_streak = 0
        self.prunes = self.released = self.compactions = self.readback = self.reads = 0
        self.alerts = []

    def total(self):
        return sum(self.cost.values())

    def poll(self):
        for u in self.usage.read():
            us = u.get('usage') or {}
            self.requests += 1
            self.cost['main'] += (us.get('cost') or {}).get('total', 0)
            self.input += us.get('input', 0)
            self.cache += us.get('cacheRead', 0)
            self.context = us.get('input', 0) + us.get('cacheRead', 0) + us.get('cacheWrite', 0)
            self.last_request = u['time'] / 1000
            ws = (u.get('websocket') or {}).get('delta') or {}
            self.delta += ws.get('deltaRequests', 0)
            self.full += ws.get('fullContextRequests', 0)
            if self.context > WINDOW:
                self.stop(f'billed request {self.context} tokens above {WINDOW}')
            if u.get('stopReason') == 'error':
                self.alert(f'provider error: {(u.get("errorMessage") or "")[:120]}')
            if LIMIT_ERROR.search(u.get('errorMessage') or ''):
                stop_all(f'{self.arm}: {u["errorMessage"][:200]}')
        for c in self.calls.read():
            key = c['call']
            if c['phase'] == 'start':
                self.open_calls.add(key)
                continue
            self.open_calls.discard(key)
            if c['model'] == MAIN:
                continue
            cost = ((c.get('usage') or {}).get('cost') or {}).get('total', 0)
            if c['method'] == 'streamSimple':
                self.cost['writer'] += cost
                if c['model'] not in WRITERS:
                    self.stop(f'compaction writer is {c["model"]}')
            else:
                self.cost['summary'] += cost
                # A summary cut off by a compaction or a stop is aborted, not failed.
                if c['phase'] == 'end' and c.get('stopReason') in ('error',) or c['phase'] == 'error':
                    self.summary_err += 1
                    self.summary_streak += 1
                    self.alert(f'prune summary failed: {(c.get("errorMessage") or c.get("error") or "")[:120]}')
                elif c.get('stopReason') != 'aborted':
                    self.summary_ok += 1
                    self.summary_streak = 0
            if LIMIT_ERROR.search(c.get('errorMessage') or c.get('error') or ''):
                stop_all(f'{self.arm}: {(c.get("errorMessage") or c.get("error"))[:200]}')
        for r in self.responses.read():
            if r.get('status') == 429:
                stop_all(f'{self.arm}: HTTP 429')
        # A burst of transient failures is tolerated; a persistent outage stops the arm.
        attempts = self.summary_ok + self.summary_err
        if self.summary_streak >= 10 or (attempts >= 20 and self.summary_err / attempts > 0.25):
            self.stop(f'prune summaries failing {self.summary_err}/{attempts}, {self.summary_streak} in a row')
        self.poll_session()
        cap = CAPS.get(self.arm, DEFAULT_CAP)
        if self.total() > cap:
            self.stop(f'cost ${self.total():.2f} above cap ${cap}')
        run = load(self.out / 'run.json') or {}
        if run.get('phase') == 'agent' and not self.open_calls and time.time() - self.last_request > 1800:
            self.alert('30 minutes without a request in flight')

    def poll_session(self):
        if self.session is None:
            found = sorted((self.out / 'sessions').glob('*.jsonl'))
            if not found:
                return
            self.session = Tail(found[0])
        for e in self.session.read():
            if e.get('type') == 'compaction':
                self.compactions += 1
            elif e.get('customType') == 'context-prune-lab-event' and (e.get('data') or {}).get('event') == 'apply':
                self.prunes += 1
                self.released += e['data'].get('netTokens', 0)
            elif e.get('type') == 'message' and (e.get('message') or {}).get('role') == 'assistant':
                for c in e['message'].get('content') or []:
                    if c.get('type') != 'toolCall':
                        continue
                    args = c.get('arguments') or {}
                    if c['name'] == 'context_tree_query':
                        self.readback += 1
                    if c['name'] in ('read', 'read_symbol'):
                        self.reads += 1
                    text = json.dumps(args, ensure_ascii=False).replace('\\\\', '/').lower()
                    for hit in re.findall(r'(?<![a-z])[a-z]:/[^"\s]*', text):
                        if not hit.startswith(self.ws) and not hit.startswith(('c:/users/67570/.cargo', 'c:/users/67570/.rustup')):
                            self.alert(f'{c["name"]} reaches {hit[:120]}')
                    if re.search(r'pib-score|test-results|ripgrep-chain|swe-milestone', text):
                        self.alert(f'{c["name"]} names scoring material: {text[:160]}')

    def stop(self, reason):
        path = BATCH / f'STOP-{self.arm}'
        if not path.exists():
            path.write_text(reason, encoding='utf-8')
            print(f'{now()} STOP {self.arm}: {reason}', flush=True)

    def alert(self, message):
        if message not in self.alerts:
            self.alerts.append(message)
            print(f'{now()} ALERT {self.arm}: {message}', flush=True)

    def line(self):
        run = load(self.out / 'run.json') or {}
        hit = self.cache / (self.cache + self.input) if self.cache + self.input else 0
        return (f'{self.arm:<4} step={run.get("currentStep")} {run.get("phase", "-"):<8} {run.get("status", "-"):<10} req={self.requests:>4} '
                f'ctx={self.context:>6} ({self.context / WINDOW:.0%}) hit={hit:.1%} ${self.total():.2f} '
                f'(main {self.cost["main"]:.2f} sum {self.cost["summary"]:.2f} cmp {self.cost["writer"]:.2f}) '
                f'prunes={self.prunes}/{self.released} cmp={self.compactions} readback={self.readback} reads={self.reads} '
                f'ws delta/full={self.delta}/{self.full} sumErr={self.summary_err}')


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None


def now():
    return datetime.now().strftime('%H:%M:%S')


def stop_all(reason):
    if not (BATCH / 'STOP').exists():
        (BATCH / 'STOP').write_text(reason, encoding='utf-8')
        print(f'{now()} STOP ALL: {reason}', flush=True)


def main():
    arms = [Arm(a) for a in ARMS]
    tick = 0
    while True:
        for a in arms:
            a.poll()
        if sum(a.total() for a in arms) > WAVE_CAP:
            stop_all(f'wave cost above ${WAVE_CAP}')
        if tick % 5 == 0:
            print(now(), f'total ${sum(a.total() for a in arms):.2f}', flush=True)
            for a in arms:
                print('  ' + a.line(), flush=True)
            (BATCH / 'monitor.json').write_text(json.dumps({a.arm: {'cost': a.cost, 'requests': a.requests, 'alerts': a.alerts} for a in arms}, indent=1), encoding='utf-8')
        sup = load(BATCH / 'supervisor.json') or {}
        if sup.get('status') == 'completed':
            for a in arms:
                a.poll()
                print('  ' + a.line(), flush=True)
            print(now(), 'supervisor completed', flush=True)
            return
        tick += 1
        time.sleep(60)


if __name__ == '__main__':
    main()
