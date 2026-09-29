#!/usr/bin/env python3
"""Shared helpers for cockpit runtime tools."""

from __future__ import annotations

import hashlib
import json
import locale
import os
import re
import stat as stat_module
import subprocess
import sys
import time
import tomllib
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True


def _force_utf8_stdio() -> None:
    # Windows defaults stdout/stderr to the console codepage (e.g. cp936), which
    # mangles Chinese tool output when captured or redirected. Tool output is
    # consumed by the agent harness as UTF-8, so emit UTF-8 unconditionally.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8")
            except (ValueError, OSError):
                pass


_force_utf8_stdio()


class ToolError(RuntimeError):
    """Tool input or runtime error."""


def repo_root() -> Path:
    explicit_root = os.environ.get("SUBAGENT_CONTROL_REPO_ROOT", "").strip()
    if explicit_root:
        candidate = Path(explicit_root)
        if not candidate.is_absolute():
            raise ToolError("SUBAGENT_CONTROL_REPO_ROOT must be an absolute path")
        resolved = candidate.resolve()
        if not resolved.is_dir():
            raise ToolError(f"SUBAGENT_CONTROL_REPO_ROOT is not a directory: {explicit_root}")
        return resolved

    script_root = Path(__file__).resolve().parents[2]
    if (script_root / "ops").exists():
        return script_root

    cur = Path(os.getcwd()).resolve()
    for path in (cur, *cur.parents):
        if (path / ".git").exists() or ((path / "AGENTS.md").exists() and (path / "ops").exists()):
            return path
    raise ToolError(f"cannot locate cockpit repository root from {cur}")


def _declared_directory(env_key: str) -> Path | None:
    explicit = os.environ.get(env_key, "").strip()
    if not explicit:
        return None
    candidate = Path(explicit)
    if not candidate.is_absolute():
        raise ToolError(f"{env_key} must be an absolute path")
    resolved = candidate.resolve()
    if not resolved.is_dir():
        raise ToolError(f"{env_key} is not a directory: {explicit}")
    return resolved


def project_root() -> Path:
    """项目根：会话项目的一切项目面路径（PROJECT/STATUS/ROADMAP、scope、output、
    task_root、临时材料、map、台账、.runtime）以此为本。

    消费模式由装配面显式下发 SUBAGENT_PROJECT_ROOT；无值时沿用旧开发口径
    （显式 SUBAGENT_CONTROL_REPO_ROOT 或自 cwd 上溯）。
    """
    explicit = _declared_directory("SUBAGENT_PROJECT_ROOT")
    if explicit is not None:
        return explicit
    if os.environ.get("SUBAGENT_CONTROL_REPO_ROOT", "").strip():
        return repo_root()
    cur = Path(os.getcwd()).resolve()
    for path in (cur, *cur.parents):
        if (path / ".git").exists() or ((path / "AGENTS.md").exists() and (path / "ops").exists()):
            return path
    return repo_root()


def runtime_root() -> Path:
    """运行根：角色 TOML、routes、模板、checker 等只读生产资产以此为本；与项目根严格分离。"""
    explicit = _declared_directory("SUBAGENT_RUNTIME_ROOT")
    if explicit is not None:
        return explicit
    if os.environ.get("SUBAGENT_CONTROL_REPO_ROOT", "").strip():
        return repo_root()
    script_root = Path(__file__).resolve().parents[2]
    if (script_root / "ops").exists():
        return script_root
    return repo_root()


# ROOT 是 project_root 兼容别名：绝不保持 producer 根语义。
# RUNTIME_ROOT 才是只读生产资产根；共享包写入由写域守卫与 scope 校验拒绝。
ROOT = project_root()
PROJECT_ROOT = ROOT
RUNTIME_ROOT = runtime_root()
ROLE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
# 角色配置里 pi 执行轨的模型与档位键；--list 运行投影、seed 模板模型行与提交路径同用此真源。
PI_MODEL_KEYS = ("pi_model", "pi_model_reasoning_effort")


def role_config_path(role: str) -> Path:
    normalized = str(role or "").strip()
    if not ROLE_NAME_RE.fullmatch(normalized):
        raise ToolError(f"invalid runtime role: {normalized or '(empty)'}")
    return RUNTIME_ROOT / "ops" / "agents" / f"{normalized}.toml"


def runtime_asset_path(*segments: str) -> Path:
    """运行包只读资产：给出绝对路径，供调用方读取角色、模板、routes 等生产材料。"""
    return RUNTIME_ROOT.joinpath(*(str(segment) for segment in segments))


def load_role_config(role: str) -> dict[str, Any]:
    path = role_config_path(role)
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ToolError(f"runtime role config not found: {rel(path)}") from exc
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ToolError(f"runtime role config is unreadable: {rel(path)}") from exc
    declared_name = str(data.get("name") or "").strip()
    if declared_name != path.stem:
        raise ToolError(
            f"runtime role name mismatch: {rel(path)} declares {declared_name or '(empty)'}"
        )
    return data


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except (OSError, ValueError):
        return path.as_posix()


def run_git(args: list[str]) -> dict[str, Any]:
    cmd = ["git", *args]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(ROOT),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ToolError("git executable not found") from exc
    return {
        "command": cmd,
        "exit_code": proc.returncode,
        "stdout": proc.stdout.rstrip("\n"),
        "stderr": proc.stderr.rstrip("\n"),
    }


def node_json(argv: list[str], *, stdin: str | None = None, timeout: int = 60) -> dict[str, Any]:
    """Run a repo JS tool from ROOT and parse its JSON stdout.

    派发编译链已迁到 ops/tools/dispatch-core/*.mjs;留在 Python 的离线校验器与 canary 经本函数
    取结果,不再 import 那些模块。非零退出把 stderr(退化时用 stdout)收成 ToolError。
    """
    cmd = ["node", *argv]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(ROOT),
            input=stdin,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ToolError("node executable not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise ToolError(f"node {' '.join(argv)} timed out after {timeout}s") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip() or f"exit {proc.returncode}"
        raise ToolError(f"node {' '.join(argv)} failed: {detail}")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ToolError(f"node {' '.join(argv)} did not return JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ToolError(f"node {' '.join(argv)} did not return a JSON object")
    return data


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ToolError(f"json file not found: {rel(path)}") from exc
    except OSError as exc:
        raise ToolError(f"cannot read json file: {rel(path)}") from exc
    except json.JSONDecodeError as exc:
        raise ToolError(f"invalid json file: {rel(path)}:{exc.lineno}") from exc
    if not isinstance(data, dict):
        raise ToolError(f"json root is not object: {rel(path)}")
    return data


def file_fingerprint(path: Path) -> dict[str, Any]:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return {"path": rel(path), "exists": False}
    except OSError as exc:
        raise ToolError(f"cannot stat path: {rel(path)}") from exc
    return {
        "path": rel(path),
        "exists": True,
        "size": stat.st_size,
        "mtime": int(stat.st_mtime),
        "mtime_iso": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime)),
    }


def emit(data: dict[str, Any], fmt: str, text: str) -> int:
    if fmt == "json":
        print(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(text.rstrip() if text.rstrip() else "(empty)")
    if "exit_code" in data:
        return int(data["exit_code"])
    return 1 if data.get("status") in ("failed", "error") else 0


def status_lines() -> list[str]:
    status = run_git(["status", "--short", "--untracked-files=all"])
    if status["exit_code"] != 0:
        raise ToolError(f"git status failed: {status['stderr']}")
    if not status["stdout"]:
        return []
    return [line for line in str(status["stdout"]).splitlines() if line.strip()]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def repo_path(value: str, label: str, *, must_exist: bool = True) -> Path:
    """Resolve a repo-relative or absolute path and refuse escapes outside ROOT."""
    path = Path(value)
    resolved = path.resolve() if path.is_absolute() else (ROOT / path).resolve()
    try:
        resolved.relative_to(ROOT.resolve())
    except ValueError as exc:
        raise ToolError(f"{label} escapes repository: {value}") from exc
    if must_exist and not resolved.is_file():
        raise ToolError(f"{label} is not a readable file: {value}")
    return resolved


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_stdin_text(source_label: str) -> str:
    raw = sys.stdin.buffer.read()
    encodings = [
        "utf-8-sig",
        sys.stdin.encoding,
        locale.getpreferredencoding(False),
        "utf-16",
        "utf-16-le",
    ]
    seen: set[str] = set()
    for encoding in encodings:
        if not encoding or encoding in seen:
            continue
        seen.add(encoding)
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ToolError(f"invalid {source_label} input encoding; expected UTF-8, UTF-16 or locale text")


def load_yaml(path: Path, *, label: str = "yaml") -> dict[str, Any]:
    try:
        import yaml
    except ImportError as exc:
        raise ToolError("PyYAML is required to read yaml files") from exc
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ToolError(f"{label} file not found: {rel(path)}") from exc
    except OSError as exc:
        raise ToolError(f"cannot read {label} file: {rel(path)}") from exc
    except yaml.YAMLError as exc:
        raise ToolError(f"invalid {label} file: {rel(path)}: {exc}") from exc
    if not isinstance(data, dict):
        raise ToolError(f"{label} root is not mapping: {rel(path)}")
    return data


def normalize_conflict_path(value: str) -> str:
    """把写作用域路径归一为 ROOT 相对 posix 路径，供 path_conflict 比较；仓外路径记 external: 前缀。"""
    raw = str(value or "").replace("\\", "/").strip().rstrip("/")
    if not raw:
        return ""
    path = Path(raw)
    try:
        resolved = path.resolve() if path.is_absolute() else (ROOT / path).resolve()
        return resolved.relative_to(ROOT.resolve()).as_posix()
    except (OSError, ValueError):
        return "external:" + raw.lower()


def path_conflict(left: str, right: str) -> bool:
    if not left or not right:
        return False
    return left == right or left.startswith(right + "/") or right.startswith(left + "/")


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def add(issues: list[dict[str, str]], code: str, location: str) -> None:
    """Append one checker issue as {code, message}; message carries the offending location."""
    issues.append({"code": code, "message": location})


def issue_text(issue: dict[str, Any]) -> str:
    """Render one {code, message} issue as a single human-readable line."""
    return f"{issue.get('code', '')}: {issue.get('message', '')}"


def lexical_absolute(path: Path | str) -> Path:
    """Normalise a path lexically, falling back to cwd for relative input.

    Unlike absolute_path this never raises; use it where a relative path is a
    caller convenience rather than a gate violation.
    """
    return Path(os.path.abspath(os.fspath(Path(path))))


def absolute_path(path: Path | str, label: str, *, error: type[Exception] = ToolError) -> Path:
    candidate = Path(path)
    if not candidate.is_absolute():
        raise error(f"{label} must be absolute: {path}")
    # Keep the lexical path for writes and lstat gates.  Resolving a destination
    # before replace would make a replaced symlink a write-through primitive.
    return Path(os.path.abspath(os.fspath(candidate)))


def is_reparse_stat(stat_result: os.stat_result) -> bool:
    # Windows junctions/reparse points are represented by this flag; on POSIX it is 0.
    return bool(getattr(stat_result, "st_file_attributes", 0) & 0x400)


def assert_no_reparse_components(
    path: Path,
    *,
    allow_missing: bool = False,
    label: str = "path",
    error: type[Exception] = ToolError,
) -> None:
    """Reject reparse components using lexical lstat, without following them."""
    candidate = absolute_path(path, label, error=error)
    current = Path(candidate.anchor)
    for index, part in enumerate(candidate.parts):
        if index == 0 and part == candidate.anchor:
            continue
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if allow_missing:
                return
            raise error(f"{label} component does not exist: {current}")
        except OSError as exc:
            raise error(f"cannot inspect {label} component {current}: {exc}") from exc
        if stat_module.S_ISLNK(info.st_mode) or is_reparse_stat(info):
            raise error(f"symlink/reparse {label} is not permitted: {current}")


def ensure_controlled_directory(
    path: Path,
    *,
    mode: int = 0o700,
    label: str = "controlled directory",
    error: type[Exception] = ToolError,
) -> Path:
    """Create controlled ancestors one at a time, checking each with lstat."""
    candidate = absolute_path(path, label, error=error)
    current = Path(candidate.anchor)
    for index, part in enumerate(candidate.parts):
        if index == 0 and part == candidate.anchor:
            continue
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            try:
                current.mkdir(mode=mode)
            except FileExistsError:
                pass
            except OSError as exc:
                raise error(f"cannot create {label} {current}: {exc}") from exc
            try:
                info = current.lstat()
            except OSError as exc:
                raise error(f"cannot recheck {label} {current}: {exc}") from exc
        except OSError as exc:
            raise error(f"cannot inspect {label} {current}: {exc}") from exc
        if not stat_module.S_ISDIR(info.st_mode) or stat_module.S_ISLNK(info.st_mode) or is_reparse_stat(info):
            raise error(f"{label} is not a real directory: {current}")
    return candidate


def assert_regular_file(path: Path, label: str, *, error: type[Exception] = ToolError) -> None:
    checked = absolute_path(path, label, error=error)
    assert_no_reparse_components(checked.parent, allow_missing=False, error=error)
    try:
        result = checked.lstat()
    except OSError as exc:
        raise error(f"{label} is unavailable: {checked}") from exc
    if not stat_module.S_ISREG(result.st_mode) or stat_module.S_ISLNK(result.st_mode) or is_reparse_stat(result):
        raise error(f"{label} is not a regular file: {checked}")


def atomic_write_bytes(
    path: Path,
    data: bytes,
    *,
    ensure_parent: bool = False,
    label: str = "write destination",
    error: type[Exception] = ToolError,
) -> None:
    """Atomically write a regular file after lexical no-reparse gates.

    These are application-level checks, not a hostile-OS race-proof sandbox.  The
    parent and target are rechecked immediately before replace and POSIX uses
    O_NOFOLLOW where available.  With ensure_parent the parent chain is created
    through the same lstat-per-component gate before the write starts.
    """
    path = absolute_path(path, label, error=error)
    if ensure_parent:
        ensure_controlled_directory(path.parent, error=error)
    assert_no_reparse_components(path.parent, allow_missing=False, error=error)
    try:
        existing = path.lstat()
    except FileNotFoundError:
        existing = None
    except OSError as exc:
        raise error(f"cannot inspect {label} {path}: {exc}") from exc
    if existing is not None and (
        not stat_module.S_ISREG(existing.st_mode)
        or stat_module.S_ISLNK(existing.st_mode)
        or is_reparse_stat(existing)
    ):
        raise error(f"{label} is not a regular file: {path}")
    temp = path.with_name(f".{path.name}.tmp-{uuid.uuid4().hex}")
    fd: int | None = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        nofollow = getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(str(temp), flags | nofollow, 0o600)
        info = os.fstat(fd)
        if not stat_module.S_ISREG(info.st_mode):
            raise error(f"temporary write is not a regular file: {temp}")
        with os.fdopen(fd, "wb") as handle:
            fd = None
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        assert_no_reparse_components(path.parent, allow_missing=False, error=error)
        try:
            current = path.lstat()
        except FileNotFoundError:
            current = None
        except OSError as exc:
            raise error(f"cannot recheck {label} {path}: {exc}") from exc
        if current is not None and (
            not stat_module.S_ISREG(current.st_mode)
            or stat_module.S_ISLNK(current.st_mode)
            or is_reparse_stat(current)
        ):
            raise error(f"{label} changed to a non-regular file: {path}")
        os.replace(str(temp), str(path))
        assert_regular_file(path, "written file", error=error)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
