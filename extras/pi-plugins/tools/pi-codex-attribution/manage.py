"""Install or roll back a version-pinned Pi Codex attribution build."""
import argparse
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent
MANIFEST = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
OVERLAY = PROJECT / "tools/pi-prompt-stability/manifest.json"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def target(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise RuntimeError(f"Path outside installation: {relative}")
    return path


def manifest_for(root):
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    if package["name"] != "@earendil-works/pi-coding-agent":
        raise RuntimeError("Expected pi-coding-agent installation")
    version = package["version"]
    path = HERE / ("manifest.json" if version == MANIFEST["version"] else f"manifest-{version}.json")
    if not path.exists():
        raise RuntimeError(f"Unsupported Pi version: {version}")
    return json.loads(path.read_text(encoding="utf-8"))


def runtime_for(manifest):
    base = PROJECT / ".runtime/pi-codex-attribution"
    return base if manifest["version"] == MANIFEST["version"] else base / manifest["version"]


def hash_at(root, relative):
    path = target(root, relative)
    return digest(path.read_bytes()) if path.exists() else None


def inspect(root):
    manifest = manifest_for(root)
    actual = {e["path"]: hash_at(root, e["path"]) for e in manifest["files"]}
    for name, key in [("baseline", "before"), ("patched", "after")]:
        if all(actual[e["path"]] == e[key] for e in manifest["files"]):
            return name
    overlay_path = OVERLAY if manifest["version"] == MANIFEST["version"] else OVERLAY.with_name(f'manifest-{manifest["version"]}.json')
    if overlay_path.exists():
        overlay = json.loads(overlay_path.read_text(encoding="utf-8"))["host"]["files"]
        expected = {e["path"]: e["after"] for e in manifest["files"]}
        expected.update({e["path"]: e["after"] for e in overlay})
        if all(hash_at(root, path) == value for path, value in expected.items()):
            return "patched+prompt-stability"
    return "unknown"


def transition(root, command, payload_path=None):
    manifest = manifest_for(root)
    runtime = runtime_for(manifest)
    payload_path = payload_path or runtime / "payload.json.gz"
    state = inspect(root)
    desired = "patched" if command == "apply" else "baseline"
    if state == desired:
        return {"state": state, "changed": False}
    if state == "patched+prompt-stability":
        raise RuntimeError("Roll back tools/pi-prompt-stability/manage.py first")
    if state == "unknown":
        raise RuntimeError("Installation differs from both pinned states; refusing overwrite")
    backup = runtime / "backups" / digest(str(root).lower().encode())[:16]
    if command == "apply":
        packed = payload_path.read_bytes()
        if digest(packed) != manifest["payloadSha256"]:
            raise RuntimeError("Payload hash mismatch")
        content = {k: base64.b64decode(v) for k, v in json.loads(gzip.decompress(packed)).items()}
        for entry in manifest["files"]:
            if digest(content[entry["path"]]) != entry["after"]:
                raise RuntimeError(f"Bad payload: {entry['path']}")
        backup.mkdir(parents=True, exist_ok=True)
        for entry in manifest["files"]:
            if entry["before"] is None:
                continue
            saved = target(backup.resolve(), entry["path"])
            saved.parent.mkdir(parents=True, exist_ok=True)
            if not saved.exists():
                saved.write_bytes(target(root, entry["path"]).read_bytes())
            if digest(saved.read_bytes()) != entry["before"]:
                raise RuntimeError(f"Backup hash mismatch: {entry['path']}")
    else:
        content = {}
        for entry in manifest["files"]:
            if entry["before"] is not None:
                data = target(backup.resolve(), entry["path"]).read_bytes()
                if digest(data) != entry["before"]:
                    raise RuntimeError(f"Backup hash mismatch: {entry['path']}")
                content[entry["path"]] = data
    originals = {e["path"]: target(root, e["path"]).read_bytes()
                 if target(root, e["path"]).exists() else None for e in manifest["files"]}
    try:
        for entry in manifest["files"]:
            path = target(root, entry["path"])
            if entry["path"] in content:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content[entry["path"]])
            else:
                path.unlink(missing_ok=True)
        if inspect(root) != desired:
            raise RuntimeError("Post-write verification failed")
    except Exception:
        for relative, data in originals.items():
            path = target(root, relative)
            if data is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(data)
        raise
    return {"state": desired, "changed": True, "backup": str(backup)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["status", "apply", "rollback"])
    parser.add_argument("--root", type=Path, default=Path(os.environ["APPDATA"]) / "npm/node_modules/@earendil-works/pi-coding-agent")
    parser.add_argument("--payload", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    result = {"state": inspect(root)} if args.command == "status" else transition(root, args.command, args.payload)
    print(json.dumps({"root": str(root), "version": manifest_for(root)["version"], **result}, indent=2))
