"""Copy and patch a native helper crate. Never install or replace a live helper."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True, help='Read-only upstream bridge-rs directory')
parser.add_argument('--work-dir', type=Path, required=True, help='New isolated build directory')
parser.add_argument('--patch', type=Path, default=Path(__file__).with_name('native.patch'), help='Patch for the supplied source baseline')
args = parser.parse_args()
source = args.source.resolve()
work = args.work_dir.resolve()
patch = args.patch.resolve()
agent_home = (Path.home() / '.pi' / 'agent').resolve()
if source == work or source in work.parents or work in source.parents:
    parser.error('source and candidate directory must not overlap')
if work == agent_home or agent_home in work.parents:
    parser.error('candidate directory must be outside the installed Pi agent')
if work.exists():
    parser.error('work directory already exists; select a new isolated directory')
if not patch.is_file():
    parser.error('native.patch is missing')


def source_hashes():
    paths = [source / 'Cargo.toml', source / 'Cargo.lock', *sorted((source / 'src').rglob('*.rs'))]
    return {str(path.relative_to(source)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in paths if path.is_file()}


before = source_hashes()
shutil.copytree(source, work, ignore=shutil.ignore_patterns('target', '.git'))
env = dict(os.environ)
env['GIT_CEILING_DIRECTORIES'] = str(work.parent)
subprocess.run(['git', 'apply', '--no-index', str(patch)], cwd=work, env=env, check=True)
relative_paths = [line.split(' b/', 1)[1] for line in patch.read_text(encoding='utf-8').splitlines()
                  if line.startswith('diff --git ')]
candidate_hashes = {relative: hashlib.sha256((work / relative).read_bytes()).hexdigest()
                    for relative in relative_paths}
subprocess.run(['cargo', 'test', '--manifest-path', str(work / 'Cargo.toml'),
                '--target-dir', str(work / 'target')], env=env, check=True)
subprocess.run(['cargo', 'build', '--release', '--manifest-path', str(work / 'Cargo.toml'),
                '--target-dir', str(work / 'target')], env=env, check=True)
assert candidate_hashes == {relative: hashlib.sha256((work / relative).read_bytes()).hexdigest()
                            for relative in relative_paths}, 'candidate source changed during the build'
after = source_hashes()
assert before == after, 'read-only upstream source changed during the candidate build'
binary = work / 'target' / 'release' / 'windows-bridge.exe'
manifest = {'source': str(source), 'workDirectory': str(work), 'sourceHashes': before,
            'candidateHashes': candidate_hashes,
            'patchPath': str(patch), 'patchSha256': hashlib.sha256(patch.read_bytes()).hexdigest(),
            'candidateBinary': str(binary), 'candidateSha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
            'productionInstalled': False}
(work / 'candidate-build.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(json.dumps(manifest, indent=2))
