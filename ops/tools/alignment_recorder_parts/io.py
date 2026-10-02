"""从 alignment_recorder.py 原样搬出的路径、YAML 与原子写入。"""

from __future__ import annotations

import argparse
import os
import re
import sys
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None

try:
    import msvcrt
except ImportError:  # POSIX
    msvcrt = None

try:
    import yaml
except ImportError as exc:  # pragma: no cover
    yaml = None
    YAML_IMPORT_ERROR = exc
else:
    YAML_IMPORT_ERROR = None

from _tool_common import ROOT, ToolError, rel, repo_path

@dataclass
class RecorderInputs:
    delta_path: Path
    source_paths: dict[str, Path]
    output_paths: dict[str, Path]
    transaction_id: str


def load_yaml(path: Path, *, root_key: str) -> dict[str, Any]:
    if yaml is None:
        raise ToolError("PyYAML is required for alignment_recorder.py") from YAML_IMPORT_ERROR
    try:
        parsed = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ToolError(f"cannot parse {rel(path)}: {exc}") from exc
    if not isinstance(parsed, dict) or not isinstance(parsed.get(root_key), dict):
        raise ToolError(f"{rel(path)} missing mapping root {root_key}")
    return parsed[root_key]


def dump_yaml(root_key: str, value: dict[str, Any]) -> str:
    if yaml is None:
        raise ToolError("PyYAML is required for alignment_recorder.py") from YAML_IMPORT_ERROR
    return yaml.safe_dump(
        {root_key: value},
        allow_unicode=True,
        sort_keys=False,
        width=120,
    )


def alignment_paths(args: argparse.Namespace, output_root: Path | None) -> tuple[dict[str, Path], dict[str, Path]]:
    values = {
        "spec": args.spec,
        "discussion_log": args.discussion_log,
    }
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise ToolError(f"direct mode missing paths: {missing}")
    source_paths = {key: repo_path(str(value), label=key, must_exist=False) for key, value in values.items()}
    present = {key: path.is_file() for key, path in source_paths.items()}
    if any(present.values()) and not all(present.values()):
        raise ToolError(f"alignment file set is partial; missing {[key for key, exists in present.items() if not exists]}")
    output_paths = {
        key: (output_root / path.name if output_root else path)
        for key, path in source_paths.items()
    }
    return source_paths, output_paths


def load_direct(args: argparse.Namespace, output_root: Path | None) -> RecorderInputs:
    source_paths, output_paths = alignment_paths(args, output_root)
    delta_path = repo_path(str(args.delta or ""), label="delta", must_exist=True)
    delta = load_yaml(delta_path, root_key="alignment_delta")
    transaction_id = str(args.transaction_id or delta.get("delta_id") or "")
    return RecorderInputs(delta_path, source_paths, output_paths, transaction_id)


def reject_retired_cache_args(args: argparse.Namespace) -> None:
    retired = [
        flag
        for flag, value in (
            ("--state-pack", getattr(args, "state_pack", None)),
            ("--checkpoint", getattr(args, "checkpoint", None)),
        )
        if value
    ]
    if retired:
        raise ToolError(
            "alignment cache arguments are retired: "
            + ", ".join(retired)
            + "; remove them and recover from the canonical Alignment State in --spec"
        )


def file_bytes(path: Path) -> bytes | None:
    if not path.is_file():
        return None
    return path.read_bytes()


@contextmanager
def recorder_lock(outputs: dict[str, Path]):
    anchor = outputs.get("spec") or next(iter(outputs.values()))
    # 锁文件名 = 规格书仓内相对路径的文件名安全形态；同一规格书恒得同一锁。
    lock_id = re.sub(r"[^A-Za-z0-9._-]+", "_", rel(anchor.resolve()).replace("\\", "/")).strip("_")[-180:]
    lock_path = ROOT / ".runtime" / "cockpit" / "alignment_locks" / f"{lock_id}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+b")
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"\0")
        handle.flush()
    handle.seek(0)
    try:
        if msvcrt is not None:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        elif fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:  # pragma: no cover
            raise ToolError("alignment recorder lock is unsupported on this platform")
    except OSError as exc:
        handle.close()
        raise ToolError("alignment recorder is busy for this spec") from exc
    try:
        yield
    finally:
        handle.close()


def atomic_write(outputs: dict[str, Path], rendered: dict[str, str]) -> list[str]:
    with recorder_lock(outputs):
        return atomic_write_locked(outputs, rendered)


def sibling_temp(target: Path, tag: str) -> Path:
    # 临时文件建在目标父目录内：安全描述符继承目标目录，随后同目录 os.replace 不跨目录搬运。
    # 跨目录搬运会把源目录（旧实现用 tmp/）的受保护 DACL 带到目标，剥掉目标目录继承的 sandbox 读权限。
    return target.parent / f".{target.name}.{tag}.{uuid.uuid4().hex}.tmp"


def atomic_write_locked(outputs: dict[str, Path], rendered: dict[str, str]) -> list[str]:
    backups = {key: file_bytes(path) for key, path in outputs.items()}
    committed: list[str] = []
    staged: dict[str, Path] = {}
    rollbacks: list[Path] = []
    try:
        for key, text in rendered.items():
            target = outputs[key]
            target.parent.mkdir(parents=True, exist_ok=True)
            path = sibling_temp(target, "staged")
            path.write_text(text, encoding="utf-8", newline="\n")
            staged[key] = path
        if any(file_bytes(outputs[key]) != backups[key] for key in outputs):
            raise ToolError("alignment outputs changed during transaction")
        try:
            for key, target in outputs.items():
                os.replace(staged[key], target)
                staged.pop(key)
                committed.append(key)
        except OSError as exc:
            for key in reversed(committed):
                target = outputs[key]
                backup = backups[key]
                if backup is None:
                    target.unlink(missing_ok=True)
                else:
                    restore = sibling_temp(target, "rollback")
                    rollbacks.append(restore)
                    restore.write_bytes(backup)
                    os.replace(restore, target)
            raise ToolError(f"alignment transaction commit failed and was rolled back: {exc}") from exc
    finally:
        for leftover in list(staged.values()) + rollbacks:
            leftover.unlink(missing_ok=True)
    return [rel(outputs[key]) for key in committed]
