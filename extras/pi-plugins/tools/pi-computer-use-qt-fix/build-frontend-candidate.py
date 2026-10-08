"""Copy the installed frontend files touched by the frontend patches into a new candidate directory, apply
the patches in order and write frontend-build.json. Never changes the installed package."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--package', type=Path, required=True, help='Installed @injaneity/pi-computer-use directory (read-only)')
parser.add_argument('--work-dir', type=Path, required=True, help='New isolated candidate directory')
parser.add_argument('--patch', type=Path, action='append',
                    help='Frontend patch, repeatable, applied in the given order '
                         '(default: frontend-focus.patch, then visual-observation-frontend.patch)')
args = parser.parse_args()
package = args.package.resolve()
work = args.work_dir.resolve()
patches = [path.resolve() for path in args.patch or [HERE / 'frontend-focus.patch', HERE / 'visual-observation-frontend.patch']]
if work.exists():
    parser.error('work directory already exists; select a new isolated directory')
if work == package or package in work.parents:
    parser.error('candidate directory must be outside the installed package')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


relative_paths = sorted({line.split(' b/', 1)[1] for patch in patches
                         for line in patch.read_text(encoding='utf-8').splitlines() if line.startswith('diff --git ')})
source_hashes = {relative: digest(package / relative) for relative in relative_paths}
for relative in relative_paths:
    (work / relative).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(package / relative, work / relative)
env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(work.parent))
for patch in patches:
    # The package's TypeScript sources are LF while some patch files are stored with CRLF.
    subprocess.run(['git', '-c', 'core.autocrlf=false', 'apply', '--no-index'], input=patch.read_bytes().replace(b'\r\n', b'\n'),
                   cwd=work, env=env, check=True)
manifest = {'sourceHashes': source_hashes,
            'candidateHashes': {relative: digest(work / relative) for relative in relative_paths}}
(work / 'frontend-build.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(json.dumps(manifest, indent=2))
