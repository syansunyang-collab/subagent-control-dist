"""Fetch the /testbed repository of every ripgrep SWE-Milestone image without Docker.

Only the layers written after `rm -rf /testbed` that touch /testbed are downloaded (the testbed COPY and
the environment-patch commits); base system and toolchain layers are skipped. Each blob is checked
against its digest. Layers are applied in order into testbeds/<milestone>/ with OCI whiteouts honoured.
Also fetches each milestone's test_config.json from the HF dataset. Writes fetch-log.json.
"""
import gzip
import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path

CACHE = Path('E:/Pi_Coding_Agent/tmp/ripgrep-chain')  # local cache, not in git: testbeds, blobs, gold checks, cargo targets
DIGESTS = Path('E:/tmp/pi-github-repos/DeepCommit-ai/SWE-Milestone/manifests/digests-v1.0.2.tsv')
REPO = 'burntsushi_ripgrep_14.1.1_15.0.0'
HF = 'https://huggingface.co/datasets/DeepCommit-ai/SWE-Milestone-data/resolve/main/BurntSushi_ripgrep_14.1.1_15.0.0/dockerfiles'
BLOBS = CACHE / 'blobs'
OUT = CACHE / 'testbeds'
ACCEPT = ','.join(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
                   'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'])


class NoAuthRedirect(urllib.request.HTTPRedirectHandler):
    """Blob redirects go to a presigned CDN URL; do not forward the registry token there."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None:
            new.remove_header('Authorization')
        return new


opener = urllib.request.build_opener(NoAuthRedirect)


def token(name):
    url = f'https://auth.docker.io/token?service=registry.docker.io&scope=repository:{name}:pull'
    return json.load(opener.open(url, timeout=60))['token']


def get(name, tok, path, accept='*/*'):
    req = urllib.request.Request(f'https://registry-1.docker.io/v2/{name}/{path}', headers={'Authorization': f'Bearer {tok}', 'Accept': accept})
    return opener.open(req, timeout=300).read()


def blob(name, tok, digest, size):
    target = BLOBS / digest.replace(':', '_')
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == digest.split(':')[1]:
        return target, False
    data = get(name, tok, f'blobs/{digest}')
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest.split(':')[1]:
        raise RuntimeError(f'blob {digest} failed verification ({len(data)} bytes)')
    BLOBS.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return target, True


def apply_layer(path, dest):
    """Extract the testbed/ part of one layer into dest, honouring whiteouts."""
    raw = path.read_bytes()
    stream = gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw
    with tarfile.open(fileobj=io.BytesIO(stream)) as tar:
        members = [m for m in tar.getmembers() if m.name.lstrip('./').startswith('testbed/') or m.name.lstrip('./') == 'testbed']
        for m in members:
            rel = m.name.lstrip('./')[len('testbed/'):] if m.name.lstrip('./') != 'testbed' else ''
            parent, base = os.path.split(rel)
            if base == '.wh..wh..opq':
                opaque = dest / parent
                if opaque.exists():
                    for child in opaque.iterdir():
                        shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()
                continue
            if base.startswith('.wh.'):
                gone = dest / parent / base[len('.wh.'):]
                if gone.is_dir() and not gone.is_symlink():
                    shutil.rmtree(gone)
                elif gone.exists() or gone.is_symlink():
                    gone.unlink()
                continue
        extract = []
        for m in members:
            rel = m.name.lstrip('./')[len('testbed/'):] if m.name.lstrip('./') != 'testbed' else ''
            if not rel or os.path.basename(rel).startswith('.wh.'):
                continue
            target = dest / rel
            if m.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif m.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() or target.is_symlink():
                    target.unlink()
                target.write_bytes(tar.extractfile(m).read())
            elif m.issym():
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() or target.is_symlink():
                    target.unlink()
                try:
                    os.symlink(m.linkname, target)
                except OSError:
                    extract.append(rel)  # recorded; git restores links on checkout if needed
        return len(members), extract


def main():
    rows = [line.split('\t') for line in DIGESTS.read_text(encoding='utf-8').splitlines() if f'swe-milestone/{REPO}__' in line]
    log = {'images': {}, 'downloadedBytes': 0}
    for local, remote in rows:
        milestone = local.split('__', 1)[1].split(':')[0]
        if milestone.startswith('base'):
            continue
        name, ref = remote.strip().split('@')
        tok = token(name)
        manifest = json.loads(get(name, tok, f'manifests/{ref}', ACCEPT))
        if 'manifests' in manifest:
            chosen = next(x for x in manifest['manifests'] if x.get('platform', {}).get('architecture') == 'amd64')
            manifest = json.loads(get(name, tok, f"manifests/{chosen['digest']}", ACCEPT))
        config = json.loads(get(name, tok, f"blobs/{manifest['config']['digest']}"))
        layers = iter(manifest['layers'])
        wanted, after_rm = [], False
        for step in config['history']:
            layer = None if step.get('empty_layer') else next(layers)
            cmd = step.get('created_by', '')
            if 'rm -rf /testbed' in cmd:
                after_rm = True
            if layer and after_rm and '/testbed' in cmd:
                wanted.append((layer, cmd[:160]))
        dest = OUT / milestone
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        entry = {'image': remote.strip(), 'layers': []}
        for layer, cmd in wanted:
            path, fresh = blob(name, tok, layer['digest'], layer['size'])
            log['downloadedBytes'] += layer['size'] if fresh else 0
            count, unlinked = apply_layer(path, dest)
            entry['layers'].append({'digest': layer['digest'], 'size': layer['size'], 'fresh': fresh, 'members': count, 'symlinksNotCreated': unlinked, 'cmd': cmd})
        config_url = f'{HF}/{milestone}/test_config.json'
        try:
            (dest.parent / f'{milestone}.test_config.json').write_bytes(opener.open(config_url, timeout=60).read())
            entry['testConfig'] = True
        except Exception as error:
            entry['testConfig'] = f'missing: {error}'
        log['images'][milestone] = entry
        print(milestone, [(l['size'], l['fresh']) for l in entry['layers']], flush=True)
    (CACHE / 'fetch-log.json').write_text(json.dumps(log, indent=1), encoding='utf-8')
    print('downloaded MB', round(log['downloadedBytes'] / 1e6, 1))


if __name__ == '__main__':
    main()
