"""Snapshot and package fixed v0.99.1 builds against the actual npm distribution.
Stages: snapshot baseline separately, then snapshot ws, attribution, prompt; package last.
The existing 0.87.1 payloads and manifests are never destinations.
"""
import argparse
import base64
import gzip
import hashlib
import json
import shutil
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
BUILD = PROJECT / "tmp/pi-0991-host-build"
SNAPSHOTS = BUILD / "snapshots"
VERSION = "0.99.1"
RESOLVED_REF = "d86654abb8862e201933517d6f1fce9f88dd117f"


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def files(root):
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*")
            if p.is_file() and (p.relative_to(root).as_posix().startswith("dist/") or
                               "/dist/" in p.relative_to(root).as_posix())}


def pack(before, after, destination, bidirectional=False):
    entries = [{"path": p, "before": digest(before.get(p)), "after": digest(data)}
               for p, data in sorted(after.items()) if before.get(p) != data]
    def encode(data):
        return {e["path"]: base64.b64encode(data[e["path"]]).decode()
                for e in entries if e["path"] in data}
    content = {"baseline": encode(before), "patched": encode(after)} if bidirectional else encode(after)
    payload = gzip.compress(json.dumps(content, sort_keys=True).encode(), mtime=0)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(payload)
    return {"payloadSha256": digest(payload), "files": entries}


def baseline(root):
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    if package["name"] != "@earendil-works/pi-coding-agent" or package["version"] != VERSION:
        raise RuntimeError("Use the actual 0.99.1 npm distribution")
    manifest_path = Path(__file__).parent / "manifest-0.99.1.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for entry in manifest["files"]:
            path = root / entry["path"]
            if digest(path.read_bytes() if path.exists() else None) != entry["before"]:
                raise RuntimeError(f"Baseline has modified content: {entry['path']}")
    destination = SNAPSHOTS / "baseline"
    for relative in ["dist", "node_modules/@earendil-works/pi-ai/dist", "node_modules/@earendil-works/pi-agent-core/dist"]:
        source = root / relative
        if not source.is_dir():
            raise RuntimeError(f"Installation is incomplete: {source}")
        if (destination / relative).exists():
            shutil.rmtree(destination / relative)
        shutil.copytree(source, destination / relative)
    shutil.copyfile(root / "package.json", destination / "package.json")
    data = root / "node_modules/@earendil-works/pi-ai/dist/providers/data"
    shutil.copytree(data, BUILD / "packages/ai/src/providers/data", dirs_exist_ok=True)
    print(json.dumps({"baseline": str(destination), "modelData": str(data)}))


def snapshot(stage):
    root = SNAPSHOTS / stage
    for package, target in [("coding-agent", ""), ("ai", "node_modules/@earendil-works/pi-ai"),
                            ("agent", "node_modules/@earendil-works/pi-agent-core")]:
        dest = root / target / "dist"
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(BUILD / "packages" / package / "dist", dest)
    print(json.dumps({"snapshot": str(root)}))


def package():
    baseline = files(SNAPSHOTS / "baseline")
    attribution = files(SNAPSHOTS / "attribution")
    # Preserve old immutable chunks so each overlay rolls back only its own changes.
    attr_runtime = PROJECT / ".runtime/pi-codex-attribution" / VERSION
    manifest = {"version": VERSION, "sourceRef": "v0.99.1", "resolvedRef": RESOLVED_REF, **pack(baseline, attribution, attr_runtime / "payload.json.gz")}
    (PROJECT / "tools/pi-codex-attribution/manifest-0.99.1.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    prompt = files(SNAPSHOTS / "prompt")
    attr_installed = {**baseline, **attribution}
    prompt_manifest = {"piVersion": VERSION, "sourceRef": "v0.99.1", "resolvedRef": RESOLVED_REF, "extensions": [],
                       "host": pack(attr_installed, prompt, PROJECT / ".runtime/pi-prompt-stability" / VERSION / "host-payload.json.gz")}
    (PROJECT / "tools/pi-prompt-stability/manifest-0.99.1.json").write_text(json.dumps(prompt_manifest, indent=2) + "\n", encoding="utf-8")
    ws = files(SNAPSHOTS / "ws")
    def select(data):
        return {p: b for p, b in data.items() if p.startswith("dist/bundle/") or
                p in ["node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
                      "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.d.ts"]}
    ws_manifest = {"version": VERSION, "sourceRef": "v0.99.1", "resolvedRef": RESOLVED_REF, **pack(select(baseline), select(ws), attr_runtime / "ws-payload.json.gz", True)}
    (PROJECT / "tools/pi-ws-recovery/manifest-0.99.1.json").write_text(json.dumps(ws_manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"attributionFiles": len(manifest["files"]), "promptFiles": len(prompt_manifest["host"]["files"]),
                      "wsFiles": len(ws_manifest["files"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["baseline", "ws", "attribution", "prompt", "package"])
    parser.add_argument("--root", type=Path)
    args = parser.parse_args()
    if args.stage == "baseline":
        if args.root is None:
            parser.error("baseline requires --root pointing to a pristine isolated npm installation")
        baseline(args.root.resolve())
    elif args.stage == "package":
        package()
    else:
        snapshot(args.stage)
