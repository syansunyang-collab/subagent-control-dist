"""Build isolated same-version pi-ai dist arms; reverse attribution using pinned originals.

No global writes. The three-way merge retains post-attribution WebSocket recovery.
"""
import base64
import gzip
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
GLOBAL = Path('C:/Users/67570/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent')
MANIFEST = json.loads((HERE / '../../pi-codex-attribution/manifest.json').resolve().read_text())
BACKUP = Path('E:/Pi_Coding_Agent/.runtime/pi-codex-attribution/backups/00105bd959c3f2cd')
PAYLOAD = Path('E:/Pi_Coding_Agent/.runtime/pi-codex-attribution/payload.json.gz')
PREFIX = 'node_modules/@earendil-works/pi-ai/dist/'
PROVIDER = 'api/openai-codex-responses.js'
SHA = lambda data: hashlib.sha256(data).hexdigest()
assert json.loads((GLOBAL / 'package.json').read_text())['version'] == MANIFEST['version'] == '0.87.1'
assert SHA(PAYLOAD.read_bytes()) == MANIFEST['payloadSha256']
original = {key: base64.b64decode(value) for key, value in json.loads(gzip.decompress(PAYLOAD.read_bytes())).items()}
for arm in ('on', 'off'):
    dest = HERE / 'pair' / arm
    if dest.exists():
        raise RuntimeError(f'Refusing to overwrite {dest}')
    shutil.copytree(GLOBAL / PREFIX, dest / 'dist')
    # The copied package sits under its own package root; local relative imports remain local.
    (dest / 'package.json').write_text(json.dumps({'name': '@earendil-works/pi-ai', 'version': '0.87.1', 'type': 'module'}))
    (dest / 'node_modules').symlink_to(GLOBAL / 'node_modules', target_is_directory=True)
for entry in MANIFEST['files']:
    if not entry['path'].startswith(PREFIX):
        continue
    relative = entry['path'][len(PREFIX):]
    on = HERE / 'pair/on/dist' / relative
    off = HERE / 'pair/off/dist' / relative
    if not on.exists() or SHA(on.read_bytes()) != entry['after']:
        # The provider received the separate WS recovery patch after attribution.
        if relative != PROVIDER:
            raise RuntimeError(f'Unexpected global source change: {relative}')
    if entry['before'] is None:
        off.unlink(missing_ok=True)
    else:
        saved = BACKUP / entry['path']
        assert SHA(saved.read_bytes()) == entry['before'], relative
        off.write_bytes(saved.read_bytes())
# Merge only the post-attribution WS fix onto the real pre-attribution provider.
# git merge-file ours=baseline, base=pinned attribution payload, theirs=installed recovery build.
base = HERE / 'pair/base-provider.js'
base.write_bytes(original[PREFIX + PROVIDER])
ours = HERE / 'pair/off/dist' / PROVIDER
current = HERE / 'pair/on/dist' / PROVIDER
result = subprocess.run(['git', 'merge-file', '-p', str(ours), str(base), str(current)], capture_output=True)
if result.returncode:
    raise RuntimeError(f'WS recovery merge conflicts ({result.returncode}); resolve only within isolated pair')
ours.write_bytes(result.stdout)
base.unlink()
on_files = {p.relative_to(HERE / 'pair/on/dist').as_posix(): SHA(p.read_bytes())
            for p in (HERE / 'pair/on/dist').rglob('*') if p.is_file()}
off_files = {p.relative_to(HERE / 'pair/off/dist').as_posix(): SHA(p.read_bytes())
             for p in (HERE / 'pair/off/dist').rglob('*') if p.is_file()}
changed = {p for p in on_files.keys() | off_files.keys() if on_files.get(p) != off_files.get(p)}
expected = {e['path'][len(PREFIX):] for e in MANIFEST['files']
            if e['path'].startswith(PREFIX) and e['before'] != e['after']}
assert changed == expected, {'unexpected': sorted(changed - expected), 'missing': sorted(expected - changed)}
print(json.dumps({'version': MANIFEST['version'], 'attributionUpstream': MANIFEST['upstream'],
                  'attributionBase': MANIFEST['base'], 'providerOnSha256': SHA(current.read_bytes()),
                  'providerOffSha256': SHA(ours.read_bytes()), 'attributionOriginalSha256': SHA(original[PREFIX + PROVIDER]),
                  'backupBeforeSha256': SHA((BACKUP / (PREFIX + PROVIDER)).read_bytes()),
                  'recoveryRetainedOn': b'websocketRecoveryProbes' in current.read_bytes(),
                  'recoveryRetainedOff': b'websocketRecoveryProbes' in ours.read_bytes(),
                  'onFiles': len(on_files), 'offFiles': len(off_files), 'onlyManifestAttributionDifferences': True,
                  'differentFiles': len(changed)}))
