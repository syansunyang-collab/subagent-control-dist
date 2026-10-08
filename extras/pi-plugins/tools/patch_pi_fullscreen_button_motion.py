#!/usr/bin/env python3
"""Downgrade Pi fullscreen mouse tracking from all-motion (1003) to button-motion (1002).

Pi 0.84.4 / 0.85.1 fullscreen TUI (``TuiAltScreen``) enables SGR mouse reporting with
all-motion tracking outside tmux/Zellij/screen, so every hover movement emits
an ``ESC[<btn;x;yM`` sequence. ``StdinBuffer`` holds an incomplete CSI for a
hardcoded 50 ms sequence timeout and then flushes it as input; a mouse
sequence fragmented across that boundary fails the whole-string matcher in
``isMouseSequence`` and its printable tail lands in the editor. This patch
constant-folds the mode selection to ``ENABLE_BUTTON_MOTION_MOUSE`` so hover
produces no events, shrinking fragmentation exposure while keeping clicks,
drag-selection, wheel and right-click paste intact.

The patch is exact-match, idempotent, backed up before mutation, and refuses
unknown source layouts. The bundled chunk file name carries a content hash
and changes between releases, so the target chunk is located by scanning for
the marker expression instead of a fixed file name.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SUPPORTED_VERSIONS = {"0.84.4", "0.85.1", "0.86.0"}
CHUNK_GLOB = "dist/bundle/chunks/chunk-*.js"
UNPATCHED = 'mouseSequence=process.env.TMUX!==void 0||process.env.ZELLIJ!==void 0||process.env.STY!==void 0||term.startsWith("tmux")||term.startsWith("screen")?ENABLE_BUTTON_MOTION_MOUSE:ENABLE_ALL_MOTION_MOUSE;'
PATCHED = "mouseSequence=ENABLE_BUTTON_MOTION_MOUSE;"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def default_pi_root() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA is not set; pass --pi-root explicitly")
    return Path(appdata) / "npm/node_modules/@earendil-works/pi-coding-agent"


def locate_target(root: Path) -> tuple[Path, int, int]:
    candidates = []
    for chunk in sorted(root.glob(CHUNK_GLOB)):
        text = chunk.read_text(encoding="utf-8")
        unpatched_count = text.count(UNPATCHED)
        patched_count = text.count(PATCHED)
        if unpatched_count or patched_count:
            candidates.append((chunk, unpatched_count, patched_count))
    if len(candidates) != 1:
        found = ", ".join(str(chunk) for chunk, _, _ in candidates) or "none"
        raise RuntimeError(
            f"Expected exactly one chunk containing the mouse-mode marker under "
            f"{root / CHUNK_GLOB}; found: {found}"
        )
    return candidates[0]


def inspect_root(root: Path) -> dict[str, Any]:
    package_path = root / "package.json"
    if not package_path.is_file():
        raise RuntimeError(f"Pi package.json not found: {package_path}")

    package = json.loads(package_path.read_text(encoding="utf-8"))
    version = str(package.get("version", ""))
    target, unpatched_count, patched_count = locate_target(root)
    if patched_count == 1 and unpatched_count == 0:
        state = "patched"
    elif patched_count == 0 and unpatched_count == 1:
        state = "unpatched"
    else:
        state = "unknown"

    return {
        "root": str(root.resolve()),
        "target": str(target.resolve()),
        "version": version,
        "supportedVersion": version in SUPPORTED_VERSIONS,
        "state": state,
        "sha256": sha256(target),
        "unpatchedMatches": unpatched_count,
        "patchedMatches": patched_count,
    }


def atomic_write(path: Path, content: str) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        newline="\n",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    try:
        shutil.copymode(path, temp_path)
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def apply_patch(root: Path, backup_root: Path) -> dict[str, Any]:
    before = inspect_root(root)
    if not before["supportedVersion"]:
        raise RuntimeError(
            f"Unsupported Pi version {before['version']} at {root}; "
            f"supported: {sorted(SUPPORTED_VERSIONS)}. Verify the new layout, "
            "extend SUPPORTED_VERSIONS, then re-run."
        )
    if before["state"] == "patched":
        return {**before, "action": "unchanged", "backup": None}
    if before["state"] != "unpatched":
        raise RuntimeError(
            f"Refusing unknown chunk layout at {before['target']} "
            f"(unpatched={before['unpatchedMatches']}, patched={before['patchedMatches']})"
        )

    target = Path(before["target"])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root_key = hashlib.sha256(before["root"].encode("utf-8")).hexdigest()[:8]
    backup_dir = (
        backup_root
        / f"pi-fullscreen-button-motion-{stamp}-{root_key}-{before['sha256'][:12]}"
    )
    backup_dir.mkdir(parents=True, exist_ok=False)
    backup = backup_dir / target.name
    shutil.copy2(target, backup)

    original = target.read_text(encoding="utf-8")
    patched = original.replace(UNPATCHED, PATCHED, 1)
    atomic_write(target, patched)
    after = inspect_root(root)
    if after["state"] != "patched":
        shutil.copy2(backup, target)
        raise RuntimeError(
            f"Post-write verification failed; restored {target} from {backup}"
        )

    manifest = {
        "schema": "pi-fullscreen-button-motion-backup/v1",
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "packageRoot": before["root"],
        "packageVersion": before["version"],
        "target": before["target"],
        "backup": str(backup.resolve()),
        "beforeSha256": before["sha256"],
        "afterSha256": after["sha256"],
    }
    manifest_path = backup_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {
        **after,
        "action": "patched",
        "backup": str(backup),
        "manifest": str(manifest_path),
    }


def run_self_test() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(
        prefix="pi-fullscreen-button-motion-test-"
    ) as temp:
        root = Path(temp) / "pi"
        target = root / "dist/bundle/chunks/chunk-TEST0000.js"
        target.parent.mkdir(parents=True)
        (root / "package.json").write_text(
            '{"version":"0.84.4","bin":{"pi":"dist/bundle/cli.js"}}\n',
            encoding="utf-8",
        )
        target.write_text(f"prefix;{UNPATCHED}suffix\n", encoding="utf-8")
        before_line_count = target.read_text(encoding="utf-8").count("\n")
        backup_root = Path(temp) / "backups"
        first = apply_patch(root, backup_root)
        second = apply_patch(root, backup_root)
        checked = inspect_root(root)
        after_line_count = target.read_text(encoding="utf-8").count("\n")

        (root / "package.json").write_text(
            '{"version":"0.0.0","bin":{"pi":"dist/bundle/cli.js"}}\n',
            encoding="utf-8",
        )
        refused = False
        try:
            apply_patch(root, backup_root)
        except RuntimeError:
            refused = True

        if (
            first["action"] != "patched"
            or second["action"] != "unchanged"
            or checked["state"] != "patched"
            or not refused
            or before_line_count != after_line_count
        ):
            raise RuntimeError("Self-test failed")
        return {
            "status": "pass",
            "firstAction": first["action"],
            "secondAction": second["action"],
            "finalState": checked["state"],
            "unsupportedVersionRefused": refused,
            "lineCountPreserved": True,
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("status", "verify", "apply", "self-test"))
    parser.add_argument(
        "--pi-root",
        action="append",
        type=Path,
        help="Pi package root; repeat for multiple installations. Defaults to the global npm package.",
    )
    parser.add_argument(
        "--backup-root",
        type=Path,
        default=Path.home() / ".pi/agent/backups",
        help="Directory that receives immutable pre-patch backups.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "self-test":
            print(json.dumps(run_self_test(), indent=2))
            return 0

        roots = args.pi_root or [default_pi_root()]
        if args.command == "apply":
            results = [
                apply_patch(root.resolve(), args.backup_root.resolve())
                for root in roots
            ]
        else:
            results = [inspect_root(root.resolve()) for root in roots]

        output = {"command": args.command, "results": results}
        print(json.dumps(output, indent=2))
        if args.command == "verify" and any(
            result["state"] != "patched" for result in results
        ):
            return 2
        if any(result["state"] == "unknown" for result in results):
            return 2
        return 0
    except Exception as error:
        print(
            json.dumps({"status": "error", "error": str(error)}, indent=2),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
