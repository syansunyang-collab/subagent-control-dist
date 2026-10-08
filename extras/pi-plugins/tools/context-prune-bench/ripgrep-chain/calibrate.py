"""Windows calibration: run each milestone's official test command at its start and end tags and compare with
the official classification. Tests that do not behave on Windows as the classification says are reported
per category. One shared CARGO_TARGET_DIR keeps rebuilds incremental. No model calls.
Usage: calibrate.py [milestone ...]   (default: every step of the scenario)"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

CACHE = Path('E:/Pi_Coding_Agent/tmp/ripgrep-chain')  # local cache, not in git: testbeds, blobs, gold checks, cargo targets
TESTBEDS = CACHE / 'testbeds'
DATA = Path('E:/Pi_Coding_Agent/tmp/cf-ripgrep-work/data/test_results')
SCENARIO = Path(__file__).resolve().parent / 'scenario.json'
TARGET = CACHE / 'target'
OUT = CACHE / 'calibration'
RESULT = re.compile(r'^test (.+?) \.\.\. (ok|FAILED|ignored)\s*$', re.M)
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def git(repo, *args):
    return subprocess.run(['git', '-c', 'core.filemode=false', '-C', str(repo), *args], capture_output=True, text=True, check=True, creationflags=NO_WINDOW).stdout


def parse(log):
    results = {}
    for name, status in RESULT.findall(Path(log).read_text(encoding='utf-8', errors='replace')):
        results[name] = 'passed' if status == 'ok' else 'failed' if status == 'FAILED' else 'skipped'
    return results


def run_tests(repo, log):
    if Path(log).exists() and 'test result:' in Path(log).read_text(encoding='utf-8', errors='replace'):
        return {'exit': None, 'seconds': None, 'results': parse(log), 'compileError': False, 'reusedLog': True}
    env = {**__import__('os').environ, 'CARGO_TARGET_DIR': str(TARGET)}
    started = time.time()
    with open(log, 'w', encoding='utf-8', errors='replace') as fh:
        proc = subprocess.run(['cargo', 'test', '--workspace', '--no-fail-fast', '--', '--test-threads=4'], cwd=repo, env=env,
                              stdout=fh, stderr=subprocess.STDOUT, creationflags=NO_WINDOW, timeout=3600)
    text = Path(log).read_text(encoding='utf-8', errors='replace')
    return {'exit': proc.returncode, 'seconds': round(time.time() - started), 'results': parse(log), 'compileError': 'error[E' in text or 'could not compile' in text}


def classification(milestone):
    path = DATA / milestone / f'{milestone}_classification.json'
    return json.loads(path.read_text(encoding='utf-8'))['stable_classification'] if path.exists() else None


def main(milestones):
    OUT.mkdir(exist_ok=True)
    for milestone in milestones:
        report = OUT / f'{milestone}.json'
        if report.exists():
            continue
        repo = TESTBEDS / milestone
        states = {}
        for state in ('start', 'end'):
            git(repo, 'checkout', '-f', '-q', f'milestone-{milestone}-{state}')
            git(repo, 'clean', '-fdq')
            states[state] = run_tests(repo, OUT / f'{milestone}.{state}.log')
        cls = classification(milestone)
        summary = {'milestone': milestone, 'start': {k: v for k, v in states['start'].items() if k != 'results'},
                   'end': {k: v for k, v in states['end'].items() if k != 'results'}, 'categories': {}}
        if cls:
            expect = {'fail_to_pass': ('failed', 'passed'), 'pass_to_pass': ('passed', 'passed'), 'none_to_pass': (None, 'passed'), 'fail_to_fail': ('failed', 'failed')}
            for category, want in expect.items():
                names = [n for n in cls.get(category, []) if isinstance(n, str)]
                matched, mismatched = [], []
                for name in names:
                    got = (states['start']['results'].get(name), states['end']['results'].get(name))
                    ok = got[1] == want[1] and (got[0] == want[0] or (want[0] == 'failed' and got[0] is None))
                    (matched if ok else mismatched).append({'test': name, 'start': got[0], 'end': got[1]})
                summary['categories'][category] = {'total': len(names), 'windowsMatches': len(matched), 'mismatched': mismatched[:40], 'mismatchedCount': len(mismatched)}
        report.write_text(json.dumps({**summary, 'results': {s: states[s]['results'] for s in states}}, indent=1), encoding='utf-8')
        print(milestone, json.dumps({'start': summary['start'], 'end': summary['end'],
                                     'categories': {k: f"{v['windowsMatches']}/{v['total']}" for k, v in summary['categories'].items()}}), flush=True)


if __name__ == '__main__':
    steps = [step['id'] for step in json.loads(SCENARIO.read_text())['steps']]
    main(sys.argv[1:] or steps)
