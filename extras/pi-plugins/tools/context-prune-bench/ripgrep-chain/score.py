"""Windows re-implementation of the SWE-Milestone evaluation for the ripgrep chain (evaluate-in-isolation).

Evaluation tree: the milestone's official end tag, overlaid with the agent's snapshot (files under crates/
selected by the official src_filter, plus root build manifests the agent changed); every overlaid .rs file
gets its embedded #[cfg(test)] items replaced by the official end-tag version (official
merge_src_with_gt_tests). If `cargo build --workspace --features pcre2` fails, the start tag is used as base
instead and the test directories are grafted from the end tag. Then the official test command runs and
the official stable classification is tallied (after the milestone's filter_list), optionally restricted to
tests that pass for the reference solution on Windows. Score = official PR-F1 (collect_results.py).
All file times are reset to now after extraction, because cargo decides freshness by mtime.

  python score.py gold MILESTONE            reference solution through the pipeline (defines Windows-valid tests)
  python score.py agent WORKSPACE MILESTONE score an agent workspace
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

import yaml

HARNESS = Path('E:/tmp/pi-github-repos/DeepCommit-ai/SWE-Milestone')
sys.path.insert(0, str(HARNESS))
from harness.utils.rust_test_filter import merge_src_with_gt_tests  # noqa: E402
from harness.utils.snapshot import ROOT_BUILD_FILES, should_include_snapshot_file  # noqa: E402
from harness.utils.src_filter import SrcFileFilter  # noqa: E402

CACHE = Path('E:/Pi_Coding_Agent/tmp/ripgrep-chain')  # local cache, not in git: testbeds, blobs, gold checks, cargo targets
TESTBEDS = CACHE / 'testbeds'
DATA = Path('E:/Pi_Coding_Agent/tmp/cf-ripgrep-work/data')
CONFIG = yaml.safe_load((DATA / 'config/BurntSushi_ripgrep_14.1.1_15.0.0.yaml').read_text(encoding='utf-8'))
BUILD_CMD = ['cargo', 'build', '--workspace', '--features', 'pcre2']
TEST_CMD = ['cargo', 'test', '--workspace', '--no-fail-fast', '--', '--test-threads=4']
RESULT = re.compile(r'^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED|ignored)\s*$', re.M)
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
SRC_FILTER = SrcFileFilter(CONFIG['repo_src_dirs'], CONFIG['test_dirs'], CONFIG.get('exclude') or [])
VALID = CACHE / 'valid'


def git(repo, *args, binary=False):
    out = subprocess.run(['git', '-c', 'core.filemode=false', '-c', 'core.autocrlf=false', '-C', str(repo), *args], capture_output=True, check=True, creationflags=NO_WINDOW).stdout
    return out if binary else out.decode('utf-8', errors='replace')


def rmtree(path):
    def unlock(func, p, _):
        os.chmod(p, 0o700)
        func(p)
    if path.exists():
        shutil.rmtree(path, onexc=unlock)


def extract(testbed, tag, dest, paths=None):
    raw = git(testbed, 'archive', '--format=tar', tag, *(paths or []), binary=True)
    now = time.time()
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        for member in tar.getmembers():
            if member.issym() or member.islnk():
                continue  # the only link (HomebrewFormula) is irrelevant to building and testing
            target = dest / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tar.extractfile(member).read())
                os.utime(target, (now, now))


def agent_files(workspace, baseline):
    """The agent snapshot: working-tree files the official capture would include."""
    changed = set()
    for name in ROOT_BUILD_FILES:
        path = workspace / name
        if path.exists():
            try:
                before = git(workspace, 'show', f'{baseline}:{name}', binary=True)
            except subprocess.CalledProcessError:
                before = None
            if before != path.read_bytes():
                changed.add(name)
    files = []
    for root, dirs, names in os.walk(workspace / 'crates'):
        dirs[:] = [d for d in dirs if d not in ('target', '.git')]
        for name in names:
            rel = Path(root, name).relative_to(workspace).as_posix()
            if should_include_snapshot_file(rel, SRC_FILTER, extra_build_manifests=changed):
                files.append(rel)
    return sorted(files) + sorted(changed)


def overlay(workspace, files, testbed, milestone, dest):
    stats = {'files': len(files), 'rs': 0, 'unplaced': 0}
    now = time.time()
    for rel in files:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        data = (workspace / rel).read_bytes()
        if rel.endswith('.rs'):
            try:
                gt = git(testbed, 'show', f'milestone-{milestone}-end:{rel}')
            except subprocess.CalledProcessError:
                gt = ''
            merged, info = merge_src_with_gt_tests(data.decode('utf-8', errors='replace'), gt, rel)
            data = merged.encode('utf-8')
            stats['rs'] += 1
            stats['unplaced'] += int((info or {}).get('unplaced_count', 0) or 0)
        target.write_bytes(data)
        os.utime(target, (now, now))
    return stats


def run(cmd, cwd, target_dir, log):
    env = {**os.environ, 'CARGO_TARGET_DIR': str(target_dir), 'CARGO_NET_OFFLINE': 'true'}
    with open(log, 'w', encoding='utf-8', errors='replace') as fh:
        proc = subprocess.run(cmd, cwd=cwd, env=env, stdout=fh, stderr=subprocess.STDOUT, creationflags=NO_WINDOW, timeout=3600)
    return proc.returncode


def classification(milestone):
    root = DATA / 'test_results' / milestone
    cls = json.loads((root / f'{milestone}_classification.json').read_text(encoding='utf-8'))
    view = cls.get('stable_classification') or cls.get('classification') or cls
    lists = {k: [t for t in view.get(k, []) if isinstance(t, str)] for k in ('fail_to_pass', 'pass_to_pass', 'none_to_pass')}
    flt = root / f'{milestone}_filter_list.json'
    if flt.exists():
        drop = json.loads(flt.read_text(encoding='utf-8'))
        for key in lists:
            invalid = {e['test_id'] for e in drop.get(f'invalid_{key}', [])}
            lists[key] = [t for t in lists[key] if t not in invalid]
    return lists


def evaluate(workspace, milestone, baseline, out, target_dir, restrict=True):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    testbed = TESTBEDS / milestone
    tree = out / 'tree'
    files = agent_files(workspace, baseline)
    result = {'milestone': milestone, 'fallback_triggered': False}
    rmtree(tree)
    tree.mkdir(parents=True)
    extract(testbed, f'milestone-{milestone}-end', tree)
    result['overlay'] = overlay(workspace, files, testbed, milestone, tree)
    result['build_end'] = run(BUILD_CMD, tree, target_dir, out / 'build-end.log')
    if result['build_end'] != 0:
        result['fallback_triggered'] = True
        rmtree(tree)
        tree.mkdir(parents=True)
        extract(testbed, f'milestone-{milestone}-start', tree)
        tests = [p for tag in ('start', 'end') for p in git(testbed, 'ls-tree', '-r', '--name-only', f'milestone-{milestone}-{tag}').splitlines() if SRC_FILTER.is_test_file(p)]
        for p in set(tests):
            (tree / p).unlink(missing_ok=True)
        end_tests = sorted({p for p in git(testbed, 'ls-tree', '-r', '--name-only', f'milestone-{milestone}-end').splitlines() if SRC_FILTER.is_test_file(p)})
        if end_tests:
            extract(testbed, f'milestone-{milestone}-end', tree, end_tests)
        result['overlay'] = overlay(workspace, files, testbed, milestone, tree)
        result['build_start'] = run(BUILD_CMD, tree, target_dir, out / 'build-start.log')
    code = run(TEST_CMD, tree, target_dir, out / 'test.log')
    outcomes = {}
    for name, status in RESULT.findall((out / 'test.log').read_text(encoding='utf-8', errors='replace')):
        outcomes[name] = 'passed' if status == 'ok' else 'failed' if status == 'FAILED' else 'skipped'
    lists = classification(milestone)
    valid_file = VALID / f'{milestone}.json'
    if restrict and valid_file.exists():
        valid = json.loads(valid_file.read_text(encoding='utf-8'))
        lists = {k: [t for t in v if t in set(valid[k])] for k, v in lists.items()}
    f2p_ok = [t for t in lists['fail_to_pass'] if outcomes.get(t) == 'passed']
    n2p_ok = [t for t in lists['none_to_pass'] if outcomes.get(t) == 'passed']
    p2p_failed = [t for t in lists['pass_to_pass'] if outcomes.get(t) == 'failed']
    p2p_missing = [t for t in lists['pass_to_pass'] if outcomes.get(t) is None]
    target_n, fixed, broken = len(lists['fail_to_pass']) + len(lists['none_to_pass']), len(f2p_ok) + len(n2p_ok), len(p2p_failed) + len(p2p_missing)
    recall = (1.0 if fixed == 0 else 0.0) if target_n == 0 else fixed / target_n
    precision = (fixed + 1) / (fixed + broken + 1)
    score = 0.0 if precision == 0 and recall == 0 else 2 * precision * recall / (precision + recall)
    result.update(test_exit=code, tests=len(outcomes), f2p=[len(f2p_ok), len(lists['fail_to_pass'])], n2p=[len(n2p_ok), len(lists['none_to_pass'])],
                  p2p=[len(lists['pass_to_pass']) - broken, len(lists['pass_to_pass'])], p2p_failed=p2p_failed[:30], p2p_missing=p2p_missing[:30],
                  resolved=len(outcomes) > 0 and fixed == target_n and broken == 0, recall=recall, precision=precision, score=score,
                  restricted=restrict and valid_file.exists())
    (out / 'outcomes.json').write_text(json.dumps(outcomes), encoding='utf-8')
    (out / 'score.json').write_text(json.dumps(result, indent=1), encoding='utf-8')
    rmtree(tree)
    return result, outcomes


def gold(milestone):
    """Score the reference end state as if an agent had produced it; its passing tests define the Windows-valid lists."""
    testbed = TESTBEDS / milestone
    workspace = CACHE / 'gold-ws' / milestone
    rmtree(workspace)
    workspace.mkdir(parents=True)
    extract(testbed, f'milestone-{milestone}-end', workspace)
    subprocess.run(['git', 'init', '-q'], cwd=workspace, check=True, creationflags=NO_WINDOW)
    result, outcomes = evaluate(workspace, milestone, 'HEAD', CACHE / 'gold' / milestone, CACHE / 'target-gold', restrict=False)
    lists = classification(milestone)
    valid = {k: [t for t in v if outcomes.get(t) == 'passed'] for k, v in lists.items()}
    VALID.mkdir(exist_ok=True)
    (VALID / f'{milestone}.json').write_text(json.dumps(valid, indent=1), encoding='utf-8')
    rmtree(workspace)
    return {**{k: result[k] for k in ('fallback_triggered', 'build_end', 'tests', 'f2p', 'n2p', 'p2p', 'resolved', 'score')},
            'excluded': {k: len(lists[k]) - len(valid[k]) for k in lists}}


if __name__ == '__main__':
    if sys.argv[1] == 'gold':
        for m in sys.argv[2:]:
            print(m, json.dumps(gold(m)), flush=True)
    else:
        ws, m = Path(sys.argv[2]), sys.argv[3]
        print(json.dumps(evaluate(ws, m, 'HEAD~0', CACHE / 'adhoc' / m, CACHE / 'target-adhoc')[0], indent=1))
