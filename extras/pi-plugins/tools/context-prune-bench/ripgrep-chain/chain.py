"""Sequential ripgrep milestone chain on native Windows: one Pi session per arm works through the 13
SWE-Milestone ripgrep milestones in the official order in one workspace that is never reset
(develop-in-place). After each milestone the working tree is scored in isolation by score.py.

  python chain.py prepare            batch dir, isolated homes, warmed workspaces (no model calls)
  python chain.py preflight          load each arm's runtime, check identity, tools, config, bash + cargo (no model calls)
  python chain.py worker --arm N|R|L one arm, all milestones
  python chain.py supervise          all arms in parallel

Profiles sol-ab and sol-ab-k30 run the production setup: native 272K window, pi-midrun-compact at 90% with the
Luna Fast compaction writer, production reserve and retry, and per-request cache telemetry (sdk-rpc --prod-settings).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'harness'))
sys.path.insert(0, str(HERE))
import driver_lib as driver  # noqa: E402
import score as scorer  # noqa: E402

REPO = Path('E:/Pi_Coding_Agent')
REAL = Path.home() / '.pi/agent'
# Price-line table of the 1.6.0-local.3 bundle plus the GPT-6 models it lacks (OpenAI model docs checked 2026-09-23).
SOL_PRICE_LINES = {'openai-codex/gpt-5.6-sol*': 272_000, 'openai-codex/gpt-6-astra*': 272_000, 'openai-codex/gpt-5.6-luna*': 272_000,
                   'xai/grok-4.6*': 200_000, 'openai-codex/gpt-6-sol*': 272_000, 'openai-codex/gpt-6-luna*': 272_000}
PROFILES = {
    'luna': {'batch': 'ripgrep-chain-20260923b', 'model': 'openai-codex/gpt-5.6-luna', 'thinking': 'medium', 'stepTimeout': 2400, 'lPriceLines': None},
    'sol': {'batch': 'ripgrep-chain-sol-20260923', 'model': 'openai-codex/gpt-6-sol', 'thinking': 'high', 'stepTimeout': 3600, 'lPriceLines': SOL_PRICE_LINES},
    'sol-ab': {'batch': 'ripgrep-chain-sol-ab-20260926c', 'model': 'openai-codex/gpt-6-sol', 'thinking': 'high', 'stepTimeout': 3600, 'prod': True, 'arms': ['N', 'K', 'R']},
    'sol-ab-k30': {'batch': 'ripgrep-chain-sol-ab-k30-20260926', 'model': 'openai-codex/gpt-6-sol', 'thinking': 'high', 'stepTimeout': 3600, 'prod': True, 'arms': ['K30']},
    'astra-ab': {'batch': 'ripgrep-chain-astra-ab-20260926', 'model': 'openai-codex/gpt-6-astra', 'thinking': 'medium', 'stepTimeout': 3600, 'prod': True,
                 'arms': ['N', 'K', 'R', 'K30']},
    # Replicates, run after the WS recovery patch was applied (2f26f7c); transport differs from the first chains.
    'sol-ab-r2': {'batch': 'ripgrep-chain-sol-ab-r2-20260926', 'model': 'openai-codex/gpt-6-sol', 'thinking': 'high', 'stepTimeout': 3600, 'prod': True, 'arms': ['N', 'K', 'R']},
    'astra-ab-r2': {'batch': 'ripgrep-chain-astra-ab-r2-20260926', 'model': 'openai-codex/gpt-6-astra', 'thinking': 'medium', 'stepTimeout': 3600, 'prod': True,
                    'arms': ['N', 'K']},
    'astra-ab-high': {'batch': 'ripgrep-chain-astra-ab-high-20260926', 'model': 'openai-codex/gpt-6-astra', 'thinking': 'high', 'stepTimeout': 3600, 'prod': True,
                      'arms': ['N', 'K']},
    'astra-ab-xhigh': {'batch': 'ripgrep-chain-astra-ab-xhigh-20260926', 'model': 'openai-codex/gpt-6-astra', 'thinking': 'xhigh', 'stepTimeout': 3600, 'prod': True,
                       'arms': ['N', 'K']},
    'sol-ab-fix': {'batch': 'ripgrep-chain-sol-ab-fix-20260926', 'model': 'openai-codex/gpt-6-sol', 'thinking': 'high', 'stepTimeout': 3600, 'prod': True,
                   'arms': ['N', 'K'], 'midrunFix': True},
    'astra-high-kf-n70': {'batch': 'ripgrep-chain-astra-high-kf-n70-20260926', 'model': 'openai-codex/gpt-6-astra', 'thinking': 'high', 'stepTimeout': 3600, 'prod': True,
                          'arms': ['KF', 'N70']},
    # The user's daily Astra setup: 500K window (list price doubles above 272K input), compaction at 90 % (450K), network blocked.
    'astra-500k': {'batch': 'ripgrep-chain-astra-500k-medium', 'model': 'openai-codex/gpt-6-astra-500k', 'thinking': 'medium', 'stepTimeout': 3600, 'prod': True,
                   'arms': ['N', 'K'], 'contextWindow': 500_000, 'noNetwork': True, 'midrunFix': True},
    'astra-500k-high': {'batch': 'ripgrep-chain-astra-500k-high', 'model': 'openai-codex/gpt-6-astra-500k', 'thinking': 'high', 'stepTimeout': 3600, 'prod': True,
                        'arms': ['N', 'K'], 'contextWindow': 500_000, 'noNetwork': True, 'midrunFix': True},
    # Paid smoke of the production setup: compaction at 25 % (about 68K) so it fires after pruning, within a few reads, three short prompts, no scoring.
    'sol-ab-smoke': {'batch': 'ripgrep-chain-sol-ab-smoke-20260926b', 'model': 'openai-codex/gpt-6-sol', 'thinking': 'high', 'stepTimeout': 900, 'prod': True,
                     'arms': ['N', 'K', 'R'], 'smoke': True, 'midrunThreshold': 25},
}
PROFILE_NAME = sys.argv[sys.argv.index('--profile') + 1] if '--profile' in sys.argv else 'luna'
PROFILE = PROFILES[PROFILE_NAME]
BATCH = REPO / 'test-results/context-prune-bench' / PROFILE['batch']
WORK = Path('C:/pib') / PROFILE['batch']
MODEL = PROFILE['model']
THINKING = PROFILE['thinking']
SCENARIO = json.loads((HERE / 'scenario.json').read_text(encoding='utf-8'))
STEPS = SCENARIO['steps']
SMOKE = PROFILE.get('smoke', False)
if SMOKE:
    SMOKE_FILES = ['crates/searcher/src/searcher/mod.rs', 'crates/searcher/src/sink.rs', 'crates/printer/src/standard.rs', 'crates/matcher/src/lib.rs',
                   'crates/regex/src/matcher.rs', 'crates/ignore/src/walk.rs']
    STEPS = [
        {'id': 'smoke-reads', 'graded': False, 'prompt': 'Read these files one at a time with the read tool, one file per tool call: ' + ', '.join(SMOKE_FILES)
         + '. After each read, state in one line the main type the file defines. After the last file, reply DONE.'},
        {'id': 'smoke-short', 'graded': False, 'prompt': 'Run `git status --short` and `ls crates`, then reply with the number of entries under crates.'},
        {'id': 'smoke-stop', 'graded': False, 'prompt': 'Read crates/core/flags/defs.rs in chunks of 400 lines, one chunk per tool call, at most 6 chunks, then reply DONE.'},
    ]
BASE_TESTBED = scorer.TESTBEDS / 'base-offline'  # official agent image: 14.1.1 + Rust 2024 compatibility patch
BASE_COMMIT = subprocess.run(['git', '-C', str(BASE_TESTBED), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
TEMPLATE = Path('E:/tmp/pi-github-repos/DeepCommit-ai/SWE-Milestone/harness/e2e/prompt/milestone_v1.md')
PROD = PROFILE.get('prod', False)
WINDOW = PROFILE.get('contextWindow', 272_000)
if PROD:
    BUILD = REAL / 'local-packages/pi-context-prune-releases/1.6.0-local.5-edcfb1f/dist/index.js'  # frozen 1.6.0-local.5 release
else:
    BUILD = REPO / 'tmp/prune-luna-real-20260923b/frozen/policy-lab.js'  # 1.6.0-local.3 production bundle
READ_SYMBOL = REPO / 'tools/pi-read-symbol/src/index.ts'  # production tool, loaded in every arm
driver.TOOLS += ',read_symbol'
# Production compaction stack: midrun trigger, compaction writer, and the Codex alias provider the Luna Fast writer needs.
KEEPTOOLS_BUILD = REPO / 'tmp/context-prune-bench/frozen-keeptools/policy-lab.js'  # fork 9354edf, 1.6.0-local.5 + keepTools
ARM_BUILD = {'KF': KEEPTOOLS_BUILD}
ARM_MIDRUN = {'N70': 70}
# midrunFix profiles load tmp/midrun-fix: midrun judges the threshold on the billed context, not Pi's post-retry estimate.
MIDRUN = REPO / 'tmp/midrun-fix/index.ts' if PROFILE.get('midrunFix') else REAL / 'npm/node_modules/pi-midrun-compact/index.ts'
PROD_EXTENSIONS = [MIDRUN, REAL / 'local-packages/pi-compaction-model-recovery/src/index.ts',
                   REAL / 'extensions/openai-codex-sol-context-alias.ts']
# noNetwork profiles block shell commands that reach the network (the upstream sources are the reference solution).
NO_NETWORK = [HERE / 'harness/no-network.ts'] if PROFILE.get('noNetwork') else []
# A step that ends on a provider error Pi does not retry (for example a transient 401) is resumed like a user would.
RESUME_PROMPT = 'Continue the task.'
RESUME_LIMIT = 3
if PROD:
    # Explicit arm configurations of the 1.6.0-local.5 policy lab; priceLines replaces the bundled table, which lacks gpt-6-sol.
    RECEIPTS = {'mode': 'cold-mask', 'triggerTokens': 6000, 'keepRecentToolTurns': 2, 'stageSummary': False, 'priceLines': SOL_PRICE_LINES}
    SUMMARY = {'mode': 'budget-summary', 'triggerTokens': 6000, 'keepRecentToolTurns': 2, 'summarizerModel': 'openai-codex/gpt-6-luna-fast-700k',
               'summarizerThinking': 'high', 'summarizerMaxCharsPerResult': 8000, 'priceLines': SOL_PRICE_LINES}
    # KF keeps file reads (read, read_symbol) and releases only other results; it needs the keepTools build.
    # N70 is N with the midrun compaction line at 70 % instead of 90 %.
    ALL_ARMS = {'N': None, 'K': RECEIPTS, 'K30': {**RECEIPTS, 'triggerTokens': 30_000}, 'R': SUMMARY,
                'KF': {**RECEIPTS, 'keepTools': ['read', 'read_symbol']}, 'N70': None}
    ARMS = {arm: ALL_ARMS[arm] for arm in PROFILE['arms']}
else:
    PRODUCTION = json.loads((REAL / 'context-prune/policy-lab.json').read_text(encoding='utf-8'))
    ARMS = {'N': None, 'R': dict(PRODUCTION), 'L': {**PRODUCTION, 'triggerTokens': 1_000_000_000, **({'priceLines': PROFILE['lPriceLines']} if PROFILE['lPriceLines'] else {})}}
STEP_TIMEOUT = PROFILE['stepTimeout']
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def stamp():
    return datetime.now(timezone.utc).isoformat()


def load(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))


def save(p, data):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + '.writing')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    tmp.replace(p)


def layout(arm):
    root = WORK / arm
    # Production profiles keep the scoring checkout away from the agent's workspace.
    target = Path('C:/pib-score') / PROFILE['batch'] / arm if PROD else root / 'score-target'
    return {'out': BATCH / arm, 'home': root / 'home', 'agent': root / 'home/.pi/agent', 'ws': root / 'ripgrep', 'target': target}


def extensions(arm):
    base = [READ_SYMBOL, *PROD_EXTENSIONS, *NO_NETWORK] if PROD else [READ_SYMBOL, *NO_NETWORK]
    return base if ARMS[arm] is None else [*base, ARM_BUILD.get(arm, BUILD)]


def midrun_threshold(arm):
    return ARM_MIDRUN.get(arm) or PROFILE.get('midrunThreshold') or 90


def prod_files(arm=None):
    """Isolated copies of the production midrun and compaction-writer settings (the writer has no DS fallback here)."""
    settings = json.loads((REAL / 'settings.json').read_text(encoding='utf-8'))
    writer = {k: v for k, v in settings['compactionModel'].items() if k not in ('fallbackModel', 'fallbackThinkingLevel')}
    midrun = json.loads((REAL / 'extensions/pi-midrun-compact/config.json').read_text(encoding='utf-8'))
    midrun['thresholdPercent'] = midrun_threshold(arm)
    return {'extensions/pi-midrun-compact/config.json': midrun, 'settings.json': {'compactionModel': writer}}


def isolate(arm):
    agent = layout(arm)['agent']
    (agent / 'context-prune').mkdir(parents=True, exist_ok=True)
    shutil.copyfile(REAL / 'APPEND_SYSTEM.md', agent / 'APPEND_SYSTEM.md')
    if ARMS[arm] is not None:
        save(agent / 'context-prune/policy-lab.json', ARMS[arm])
    if PROD:
        for rel, data in prod_files(arm).items():
            save(agent / rel, data)


def git(ws, *args):
    return subprocess.run(['git', '-c', 'core.autocrlf=false', '-c', 'core.filemode=false', *args], cwd=ws, capture_output=True, text=True, check=True, creationflags=NO_WINDOW).stdout


def cargo(ws, *args, log):
    env = {**os.environ, 'CARGO_NET_OFFLINE': 'true'}
    with open(log, 'w', encoding='utf-8', errors='replace') as fh:
        return subprocess.run(['cargo', *args], cwd=ws, env=env, stdout=fh, stderr=subprocess.STDOUT, creationflags=NO_WINDOW, timeout=3600).returncode


def prepare_workspace(arm):
    """ripgrep 14.1.1 as a fresh one-commit repository, built once like the official base image."""
    ws = layout(arm)['ws']
    if ws.exists():
        raise RuntimeError(f'{ws} exists; refusing to reuse a workspace')
    ws.mkdir(parents=True)
    scorer.extract(BASE_TESTBED, BASE_COMMIT, ws)
    git(ws, 'init', '-q')
    git(ws, 'config', 'core.autocrlf', 'false')
    git(ws, 'config', 'core.filemode', 'false')
    git(ws, 'config', 'user.name', 'ripgrep chain')
    git(ws, 'config', 'user.email', 'chain@example.invalid')
    (ws / '.git/info/exclude').write_text('.pi/\ntarget/\n', encoding='utf-8')
    git(ws, 'add', '-A')
    git(ws, 'commit', '-qm', 'ripgrep 14.1.1 baseline')
    out = layout(arm)['out']
    out.mkdir(parents=True, exist_ok=True)
    if SMOKE:
        return {'baseline': git(ws, 'rev-parse', 'HEAD').strip(), 'warmBuild': None, 'warmTests': None}
    build = cargo(ws, 'build', '--workspace', log=out / 'warm-build.log')
    tests = cargo(ws, 'test', '--workspace', '--no-run', log=out / 'warm-tests.log')
    return {'baseline': git(ws, 'rev-parse', 'HEAD').strip(), 'warmBuild': build, 'warmTests': tests}


def prompt_for(step):
    if SMOKE:
        return step['prompt']
    text = TEMPLATE.read_text(encoding='utf-8')
    srs = Path(step['promptFile']).read_text(encoding='utf-8')
    text = text.replace('- **Working Directory**: `/testbed` (the repository root)', '- **Working Directory**: the current directory (the repository root)')
    return text.replace('{srs_content}', srs).replace('{milestone_id}', step['id'])


def prepare():
    if (BATCH / 'manifest.json').exists():
        raise RuntimeError('batch exists; refusing to prepare over it')
    assert SMOKE or all((scorer.VALID / f"{s['id']}.json").exists() for s in STEPS), 'gold checks missing'
    BATCH.mkdir(parents=True, exist_ok=True)
    workspaces = {}
    for arm in ARMS:
        isolate(arm)
        workspaces[arm] = prepare_workspace(arm)
    files = [HERE / 'chain.py', HERE / 'score.py', HERE / 'harness/driver_lib.py', HERE / 'harness/sdk-rpc.mjs', BUILD, READ_SYMBOL, REAL / 'APPEND_SYSTEM.md', TEMPLATE,
             *(PROD_EXTENSIONS if PROD else []), *NO_NETWORK, *{ARM_BUILD[a] for a in ARMS if a in ARM_BUILD}]
    save(BATCH / 'manifest.json', {'profile': PROFILE_NAME, 'model': MODEL, 'thinking': THINKING, 'arms': {k: v for k, v in ARMS.items()}, 'steps': [s['id'] for s in STEPS],
                                   'graded': [s['id'] for s in STEPS if s['graded']], 'scenario': SCENARIO['id'], 'baseCommit': BASE_COMMIT,
                                   'workspaces': workspaces, 'files': {str(p): driver.sha256_file(p) for p in files}, 'stepTimeoutSeconds': STEP_TIMEOUT, 'contextWindow': WINDOW, 'noNetwork': bool(NO_NETWORK),
                                   **({'prodFiles': {a: prod_files(a) for a in ARMS}} if PROD else {}),
                                   'scoring': 'score.py: official evaluation re-implemented on Windows; tests restricted to those the reference passes on Windows'})
    print(json.dumps(workspaces, indent=1))


def rpc_for(arm, out):
    paths = layout(arm)
    args = SimpleNamespace(model=MODEL, thinking=THINKING, home=str(paths['home']), agent_dir=str(paths['agent']), prod_settings=PROD)
    return driver.PiRpc(paths['ws'], out / 'sessions', args, out, extensions(arm), approve=True)


def preflight():
    result = {}
    for arm in ARMS:
        out = BATCH / 'preflight' / arm
        out.mkdir(parents=True, exist_ok=True)
        rpc = rpc_for(arm, out)
        try:
            state = rpc.command('get_state', 'state0')
            identity = driver.assert_model_identity(state, MODEL)
            assert identity['thinkingLevel'] == THINKING
            projected = [json.loads(line) for line in (out / 'projection.jsonl').read_text(encoding='utf-8').splitlines()]
            startup = next(e for e in projected if e['kind'] == 'session_start')
            assert ('context_tree_query' in startup['activeTools']) == (ARMS[arm] is not None), startup['activeTools']
            assert 'read_symbol' in startup['activeTools'], startup['activeTools']
            if ARMS[arm] is not None:
                config = startup['labConfig'][0]
                for key, value in ARMS[arm].items():
                    assert config[key] == value, (arm, key, config.get(key))
            if PROD:
                runtime = next(e for e in projected if e['kind'] == 'runtime')
                assert runtime['model']['contextWindow'] == WINDOW, runtime['model']
                assert runtime['settings']['compaction']['reserveTokens'] == 65536 and runtime['settings']['retry']['enabled'], runtime['settings']
                agent = layout(arm)['agent']
                assert load(agent / 'extensions/pi-midrun-compact/config.json')['thresholdPercent'] == midrun_threshold(arm)
                assert load(agent / 'settings.json')['compactionModel']['model'] == 'openai-codex/gpt-6-luna-fast-700k'
                manifest = load(BATCH / 'manifest.json')
                changed = [f for f, h in manifest['files'].items() if driver.sha256_file(f) != h]
                assert not changed, f'files changed since prepare: {changed}'
            shell = rpc.command('bash', 'bash0', command='cargo --version && rustc --version && echo "offline=$CARGO_NET_OFFLINE"')
            assert shell.get('exitCode') == 0 and 'cargo ' in shell.get('output', '') and 'offline=true' in shell.get('output', ''), shell
            result[arm] = {'identity': identity, 'activeTools': startup['activeTools'], 'labConfig': startup['labConfig'], 'bash': shell.get('output', '').strip()}
        finally:
            rpc.close()
    save(BATCH / 'preflight/result.json', {'passed': True, 'modelRequests': 0, 'arms': result})
    print('PASS', json.dumps({k: v['bash'] for k, v in result.items()}))


def step_error(out, n):
    """Error text when the step's last main-model response ended on a provider error, else None."""
    rows = [json.loads(line) for line in (out / 'usage.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()] if (out / 'usage.jsonl').exists() else []
    last = next((u for u in reversed(rows) if u.get('step') == n), None)
    return (last.get('errorMessage') or 'error')[:300] if last and last.get('stopReason') == 'error' else None


class SmokeNoScore(Exception):
    pass


def stop_reason(arm):
    """STOP halts every arm, STOP-<arm> one arm; the file text is the reason."""
    for name in ('STOP', f'STOP-{arm}'):
        if (BATCH / name).exists():
            return (BATCH / name).read_text(encoding='utf-8').strip() or name
    return None


def worker(arm):
    paths = layout(arm)
    out = paths['out']
    manifest = load(BATCH / 'manifest.json')
    baseline = manifest['workspaces'][arm]['baseline']
    run = {'arm': arm, 'model': MODEL, 'status': 'starting', 'started': stamp(), 'steps': []}
    save(out / 'run.json', run)
    rpc = None
    try:
        rpc = rpc_for(arm, out)
        state = rpc.command('get_state', 'state0')
        run['identity'] = driver.assert_model_identity(state, MODEL)
        run['status'] = 'running'
        for n, step in enumerate(STEPS, 1):
            if stop_reason(arm):
                run['status'] = 'stopped'
                break
            prompt = prompt_for(step)
            sdir = out / f"step{n:02d}-{step['id']}"
            sdir.mkdir(parents=True, exist_ok=True)
            (sdir / 'prompt.md').write_text(prompt, encoding='utf-8')
            rec = {'step': n, 'milestone': step['id'], 'graded': step['graded'], 'started': stamp()}
            run.update(currentStep=n, phase='agent')
            save(out / 'run.json', run)
            t0 = time.time()
            stopped = None
            if SMOKE and arm == 'N' and step['id'] == 'smoke-stop':
                # Exercise the stop path: a stop file 10 s into the step must abort it.
                threading.Timer(10, lambda: (BATCH / 'STOP-N').write_text('smoke stop test', encoding='utf-8')).start()
            try:
                if PROD:
                    (out / 'step.txt').write_text(str(n), encoding='utf-8')
                    results = [rpc.run_step(f'step{n}', prompt, STEP_TIMEOUT, stop_check=lambda: stop_reason(arm))]
                    rec['errorResumes'] = []
                    while len(rec['errorResumes']) < RESUME_LIMIT and (error := step_error(out, n)):
                        rec['errorResumes'].append(error)
                        time.sleep(30)
                        results.append(rpc.run_step(f'step{n}-resume{len(rec["errorResumes"])}', RESUME_PROMPT, STEP_TIMEOUT, stop_check=lambda: stop_reason(arm)))
                    save(sdir / 'events.json', results)
                    rec.update({k: sum(r[k] for r in results) for k in ('compactions', 'continuations', 'retries', 'missingContinuation')})
                    if step_error(out, n):
                        rec['agent_error'] = f'provider error after {RESUME_LIMIT} resumes: {step_error(out, n)}'
                else:
                    rpc.prompt_and_settle(f'step{n}', prompt, STEP_TIMEOUT)
                rec.setdefault('agent_error', None)
            except driver.StepStopped as stop:
                stopped = rec['stopped'] = str(stop)
                rec['agent_error'] = None
            except Exception as error:
                rec['agent_error'] = f'{type(error).__name__}: {error}'
                if rpc.proc.poll() is None:
                    try:
                        rpc.command('abort', f'abort{n}')
                    except Exception as abort_error:
                        rec['abort_error'] = str(abort_error)
            rec['agent_seconds'] = round(time.time() - t0, 1)
            rec['diff_stat'] = git(paths['ws'], 'diff', '--stat', baseline).strip().splitlines()[-1:]
            run['phase'] = 'score'
            save(out / 'run.json', run)
            try:
                if SMOKE:
                    raise SmokeNoScore()
                rec['score'] = scorer.evaluate(paths['ws'], step['id'], baseline, sdir / 'eval', paths['target'], restrict=True)[0]
            except SmokeNoScore:
                rec['score'] = {'skipped': 'smoke', 'score': 0.0, 'resolved': False}
            except Exception as error:
                rec['score'] = {'error': f'{type(error).__name__}: {error}', 'score': 0.0, 'resolved': False}
            run['steps'].append(rec)
            save(sdir / 'record.json', rec)
            save(out / 'run.json', run)
            s = rec['score']
            print(arm, n, step['id'], 'resolved' if s.get('resolved') else 'unresolved', round(s.get('score', 0), 3), rec['agent_seconds'], flush=True)
            if rpc.proc.poll() is not None:
                run['status'] = 'infrastructure_error'
                run['fatal'] = f'Pi exited {rpc.proc.returncode}'
                break
            if stopped:
                run['status'] = 'stopped'
                break
        else:
            run['status'] = 'completed'
        run['phase'] = 'summary-drain'
        save(out / 'run.json', run)
        t0 = time.monotonic()
        meter_file = out / ('provider-calls.jsonl' if PROD else 'summary-meter.jsonl')
        while time.monotonic() - t0 < 180:
            meter = [json.loads(line) for line in meter_file.read_text(encoding='utf-8').splitlines()] if meter_file.exists() else []
            if not ({m['call'] for m in meter if m['phase'] == 'start'} - {m['call'] for m in meter if m['phase'] in ('end', 'error')}):
                break
            time.sleep(2)
        if rpc.proc.poll() is None:
            save(out / 'session-stats.json', rpc.command('get_session_stats', 'stats'))
    except Exception as error:
        run['status'] = 'infrastructure_error'
        run['fatal'] = f'{type(error).__name__}: {error}'
        (out / 'exception.txt').write_text(traceback.format_exc(), encoding='utf-8')
    finally:
        if rpc:
            rpc.close()
        run['finished'] = stamp()
        run['phase'] = 'finished'
        save(out / 'run.json', run)
    return 1 if run['status'] == 'infrastructure_error' else 0


def supervise():
    if (BATCH / 'supervisor.json').exists():
        raise RuntimeError('supervisor already ran for this batch')
    assert load(BATCH / 'preflight/result.json')['passed']
    state = {'status': 'running', 'started': stamp(), 'workers': {}}
    save(BATCH / 'supervisor.json', state)
    handles, logs = {}, []
    for arm in ARMS:
        log = (BATCH / arm / 'worker.log').open('w', encoding='utf-8')
        logs.append(log)
        cmd = [sys.executable, str(HERE / 'chain.py'), 'worker', '--arm', arm, '--profile', PROFILE_NAME]
        handles[arm] = subprocess.Popen(cmd, cwd=HERE, stdout=log, stderr=subprocess.STDOUT, creationflags=NO_WINDOW)
        state['workers'][arm] = {'pid': handles[arm].pid}
    save(BATCH / 'supervisor.json', state)
    while any(h.poll() is None for h in handles.values()):
        time.sleep(30)
    for log in logs:
        log.close()
    state.update(status='completed', finished=stamp(), exitCodes={a: h.returncode for a, h in handles.items()})
    save(BATCH / 'supervisor.json', state)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'preflight', 'worker', 'supervise'])
    parser.add_argument('--arm', choices=list(ARMS))
    parser.add_argument('--profile', choices=list(PROFILES), default='luna')
    a = parser.parse_args()
    if a.action == 'prepare':
        prepare()
    elif a.action == 'preflight':
        preflight()
    elif a.action == 'worker':
        raise SystemExit(worker(a.arm))
    else:
        supervise()
