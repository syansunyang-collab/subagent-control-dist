"""Install or roll back the prompt-stability fix: run preparation for custom-message wakes in the
Pi host, and prompt extensions that write named sections instead of replacing the system prompt."""
import argparse
import base64
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
MANIFEST = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
RUNTIME = PROJECT / ".runtime/pi-prompt-stability"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def lf(data):
    # Repository copies may be checked out with CRLF; installed extensions use LF.
    return data.replace(b"\r\n", b"\n")


def load_attribution():
    spec = importlib.util.spec_from_file_location("attribution", PROJECT / "tools/pi-codex-attribution/manage.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Host: pinned build outputs replacing part of the Codex attribution build.

def manifest_for(root):
    version = load_attribution().manifest_for(root)["version"]
    path = HERE / ("manifest.json" if version == MANIFEST["piVersion"] else f"manifest-{version}.json")
    return json.loads(path.read_text(encoding="utf-8"))


def runtime_for(root):
    version = manifest_for(root)["piVersion"]
    return RUNTIME if version == MANIFEST["piVersion"] else RUNTIME / version


def backup_for(root):
    runtime = runtime_for(root)
    # Preserve the legacy production backup contract; newer versions isolate installations.
    return runtime / "backups/host" if manifest_for(root)["piVersion"] == MANIFEST["piVersion"] else runtime / "backups" / digest(str(root).lower().encode())[:16]


def host_state(root):
    files = manifest_for(root)["host"]["files"]
    actual = {e["path"]: digest((root / e["path"]).read_bytes()) if (root / e["path"]).exists() else None for e in files}
    for state, key in [("patched", "after"), ("baseline", "before")]:
        if all(actual[e["path"]] == e[key] for e in files):
            return state
    return "unknown"


def write_host(root, content):
    """Write or delete every host file, restoring the previous bytes if anything fails."""
    originals = {e["path"]: (root / e["path"]).read_bytes() if (root / e["path"]).exists() else None
                 for e in manifest_for(root)["host"]["files"]}
    try:
        for path, data in content.items():
            if data is None:
                (root / path).unlink(missing_ok=True)
            else:
                (root / path).write_bytes(data)
    except Exception:
        for path, data in originals.items():
            if data is None:
                (root / path).unlink(missing_ok=True)
            else:
                (root / path).write_bytes(data)
        raise


def apply_host(root):
    state = host_state(root)
    if state == "patched":
        return state
    if state != "baseline" or load_attribution().inspect(root) != "patched":
        raise RuntimeError("Host must be the plain Codex attribution build (tools/pi-codex-attribution)")
    manifest = manifest_for(root)
    packed = (runtime_for(root) / "host-payload.json.gz").read_bytes()
    if digest(packed) != manifest["host"]["payloadSha256"]:
        raise RuntimeError("Host payload hash mismatch")
    payload = {k: base64.b64decode(v) for k, v in json.loads(gzip.decompress(packed)).items()}
    backup = backup_for(root)
    for entry in manifest["host"]["files"]:
        if digest(payload[entry["path"]]) != entry["after"]:
            raise RuntimeError(f"Bad payload: {entry['path']}")
        if entry["before"] is not None:
            saved = backup / entry["path"]
            saved.parent.mkdir(parents=True, exist_ok=True)
            saved.write_bytes((root / entry["path"]).read_bytes())
    write_host(root, payload)
    if host_state(root) != "patched":
        raise RuntimeError("Host verification failed after apply")
    return "patched"


def rollback_host(root):
    state = host_state(root)
    if state == "baseline":
        return state
    if state != "patched":
        raise RuntimeError("Host differs from both pinned states; refusing overwrite")
    content = {}
    for entry in manifest_for(root)["host"]["files"]:
        data = None
        if entry["before"] is not None:
            data = (backup_for(root) / entry["path"]).read_bytes()
            if digest(data) != entry["before"]:
                raise RuntimeError(f"Backup hash mismatch: {entry['path']}")
        content[entry["path"]] = data
    write_host(root, content)
    if host_state(root) != "baseline":
        raise RuntimeError("Host verification failed after rollback")
    return "baseline"


# Extensions: whole-file sources compared as LF text.

def extension_state(agent_dir, entry):
    target = agent_dir / entry["target"]
    actual = digest(lf(target.read_bytes())) if target.exists() else None
    if actual == entry["after"]:
        return "patched"
    if actual == entry["before"][0]:
        return "baseline"
    # Later entries in "before" are superseded intermediate installs that apply may replace.
    return "superseded" if actual in entry["before"] else "unknown"


def put_extension(agent_dir, entry, relative, expected, desired):
    data = lf((PROJECT / relative).read_bytes())
    if digest(data) != expected:
        raise RuntimeError(f"{entry['name']}: {relative} does not match the manifest")
    (agent_dir / entry["target"]).write_bytes(data)
    if extension_state(agent_dir, entry) != desired:
        raise RuntimeError(f"{entry['name']}: verification failed")
    return desired


def apply_extension(agent_dir, entry):
    state = extension_state(agent_dir, entry)
    if state == "patched":
        return state
    if state == "unknown":
        raise RuntimeError(f"{entry['name']}: unknown installed content; refusing overwrite")
    return put_extension(agent_dir, entry, entry["source"], entry["after"], "patched")


def rollback_extension(agent_dir, entry):
    state = extension_state(agent_dir, entry)
    if state == "baseline":
        return state
    if state != "patched":
        raise RuntimeError(f"{entry['name']}: installed content is {state}; refusing overwrite")
    return put_extension(agent_dir, entry, entry["original"], entry["before"][0], "baseline")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["status", "apply", "rollback"])
    parser.add_argument("--root", type=Path, default=Path(os.environ["APPDATA"]) / "npm/node_modules/@earendil-works/pi-coding-agent")
    parser.add_argument("--agent-dir", type=Path, default=Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi/agent"))
    parser.add_argument("--host-only", action="store_true", help="Do not inspect or modify agent extensions")
    args = parser.parse_args()
    root, agent_dir = args.root.resolve(), args.agent_dir.resolve()
    entries = [] if args.host_only else manifest_for(root)["extensions"]
    if args.command == "status":
        host = host_state(root)
        extensions = {e["name"]: extension_state(agent_dir, e) for e in entries}
    elif args.command == "apply":
        host = apply_host(root)
        extensions = {e["name"]: apply_extension(agent_dir, e) for e in entries}
    else:
        extensions = {e["name"]: rollback_extension(agent_dir, e) for e in entries}
        host = rollback_host(root)
    print(json.dumps({"root": str(root), "agentDir": str(agent_dir), "attribution": load_attribution().inspect(root),
                      "host": host, "extensions": extensions}, indent=2))
