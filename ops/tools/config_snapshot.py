#!/usr/bin/env python3
"""仓外关键配置面的 hash-only 快照与比对工具。

用法:
  python -B ops/tools/config_snapshot.py snapshot
  python -B ops/tools/config_snapshot.py compare --snapshot <snapshot.json>
  python -B ops/tools/config_snapshot.py --self-test

snapshot 与 compare 报告固定写入 .runtime/config-snapshot/。compare 在干净、
有差异、扫描/输入错误时分别退出 0、1、2。无第三方依赖。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn, Protocol
from urllib.parse import quote

try:
    import winreg
except ImportError:  # pragma: no cover - 生产目标为 Windows，自测使用隔离 plan。
    winreg = None  # type: ignore[assignment]

from _tool_common import sha256_hex

PROJECT_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_DIR = PROJECT_ROOT / ".runtime" / "config-snapshot"
SNAPSHOT_SCHEMA = "config-snapshot/v2"
COMPARE_SCHEMA = "config-snapshot-compare/v2"
PRODUCTION_SCOPE = "windows-global-config/v1"
HASH_ALGORITHM = "sha256"
CHUNK_SIZE = 1024 * 1024
VALID_STATES = {"present", "absent", "error"}
ITEM_KEYS = {"id", "kind", "path", "state", "sha256", "error_code"}
SNAPSHOT_KEYS = {
    "schema",
    "scope",
    "hash_algorithm",
    "created_at",
    "status",
    "item_count",
    "error_count",
    "items",
}
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
USER_ENV_KEY = r"Environment"
SERVICE_KEY_PREFIX = r"SYSTEM\CurrentControlSet\Services"
SERVICE_NAMES = ("CodexContProxy", "KimiCodeBridge")


class ConfigSnapshotError(RuntimeError):
    """可安全显示的工具输入或运行错误。"""


class RegistryMissing(ConfigSnapshotError):
    """注册表键或值不存在。"""


class RegistryReadError(ConfigSnapshotError):
    """注册表读取失败；消息只含机械错误码，不含值明文。"""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class RegistryReader(Protocol):
    def enum_values(self, hive: str, subkey: str) -> list[tuple[str, Any, int]]: ...

    def query_value(self, hive: str, subkey: str, name: str) -> tuple[Any, int]: ...

    def expand_environment(self, value: str) -> str: ...


@dataclass(frozen=True)
class FileTarget:
    item_id: str
    path: Path
    kind: str = "file"


@dataclass(frozen=True)
class FileCollection:
    item_id: str
    root: Path
    pattern: str
    child_id_prefix: str


@dataclass(frozen=True)
class ScanPlan:
    scope: str
    static_files: tuple[FileTarget, ...]
    collections: tuple[FileCollection, ...] = ()
    include_windows_surfaces: bool = False
    service_names: tuple[str, ...] = ()


class NativeRegistryReader:
    """只读 Windows 注册表适配器。"""

    @staticmethod
    def _handle(hive: str) -> Any:
        if winreg is None:
            raise RegistryReadError("registry_unavailable")
        handles = {
            "HKCU": winreg.HKEY_CURRENT_USER,
            "HKLM": winreg.HKEY_LOCAL_MACHINE,
        }
        try:
            return handles[hive]
        except KeyError as exc:
            raise RegistryReadError("unsupported_hive") from exc

    @staticmethod
    def _raise(exc: OSError) -> NoReturn:
        if isinstance(exc, FileNotFoundError) or getattr(exc, "winerror", None) == 2:
            raise RegistryMissing("registry_missing") from exc
        raise RegistryReadError(_os_error_code(exc)) from exc

    def enum_values(self, hive: str, subkey: str) -> list[tuple[str, Any, int]]:
        if winreg is None:
            raise RegistryReadError("registry_unavailable")
        try:
            with winreg.OpenKey(self._handle(hive), subkey, 0, winreg.KEY_READ) as key:
                rows: list[tuple[str, Any, int]] = []
                index = 0
                while True:
                    try:
                        rows.append(winreg.EnumValue(key, index))
                    except OSError as exc:
                        if getattr(exc, "winerror", None) == 259:
                            break
                        self._raise(exc)
                    index += 1
                return rows
        except OSError as exc:
            self._raise(exc)

    def query_value(self, hive: str, subkey: str, name: str) -> tuple[Any, int]:
        if winreg is None:
            raise RegistryReadError("registry_unavailable")
        try:
            with winreg.OpenKey(self._handle(hive), subkey, 0, winreg.KEY_READ) as key:
                return winreg.QueryValueEx(key, name)
        except OSError as exc:
            self._raise(exc)

    def expand_environment(self, value: str) -> str:
        if winreg is None:
            raise RegistryReadError("registry_unavailable")
        try:
            return winreg.ExpandEnvironmentStrings(value)
        except OSError as exc:
            raise RegistryReadError(_os_error_code(exc)) from exc


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _output_name(prefix: str) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    return f"{prefix}-{stamp}-{os.getpid()}.json"


def _absolute_path(path: Path) -> str:
    return os.path.abspath(os.fspath(path))


def _os_error_code(exc: OSError) -> str:
    if isinstance(exc, PermissionError):
        return "permission_denied"
    if isinstance(exc, FileNotFoundError):
        return "not_found"
    if isinstance(exc, IsADirectoryError):
        return "not_regular_file"
    number = getattr(exc, "winerror", None)
    if number is None:
        number = getattr(exc, "errno", None)
    return f"os_error_{number}" if number is not None else "os_error"


def _item(
    item_id: str,
    kind: str,
    path: str,
    state: str,
    *,
    sha256: str | None = None,
    error_code: str | None = None,
) -> dict[str, Any]:
    row: dict[str, Any] = {"id": item_id, "kind": kind, "path": path, "state": state}
    if sha256 is not None:
        row["sha256"] = sha256
    if error_code is not None:
        row["error_code"] = error_code
    return row


def _stat_identity(info: os.stat_result) -> tuple[int, int, int, int]:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _scan_file(target: FileTarget) -> dict[str, Any]:
    path_text = _absolute_path(target.path)
    try:
        initial_path_stat = target.path.stat()
    except FileNotFoundError:
        return _item(target.item_id, target.kind, path_text, "absent")
    except OSError as exc:
        return _item(
            target.item_id,
            target.kind,
            path_text,
            "error",
            error_code=_os_error_code(exc),
        )

    if not stat.S_ISREG(initial_path_stat.st_mode):
        return _item(
            target.item_id,
            target.kind,
            path_text,
            "error",
            error_code="not_regular_file",
        )

    digest = hashlib.sha256()
    try:
        with target.path.open("rb") as stream:
            opened_stat = os.fstat(stream.fileno())
            while True:
                chunk = stream.read(CHUNK_SIZE)
                if not chunk:
                    break
                digest.update(chunk)
            final_open_stat = os.fstat(stream.fileno())
        final_path_stat = target.path.stat()
    except FileNotFoundError:
        return _item(
            target.item_id,
            target.kind,
            path_text,
            "error",
            error_code="changed_during_scan",
        )
    except OSError as exc:
        return _item(
            target.item_id,
            target.kind,
            path_text,
            "error",
            error_code=_os_error_code(exc),
        )

    identities = {
        _stat_identity(initial_path_stat),
        _stat_identity(opened_stat),
        _stat_identity(final_open_stat),
        _stat_identity(final_path_stat),
    }
    if len(identities) != 1:
        return _item(
            target.item_id,
            target.kind,
            path_text,
            "error",
            error_code="changed_during_scan",
        )
    return _item(
        target.item_id,
        target.kind,
        path_text,
        "present",
        sha256=digest.hexdigest(),
    )


def _scan_collection(collection: FileCollection) -> list[dict[str, Any]]:
    path_text = _absolute_path(collection.root / collection.pattern)
    try:
        root_stat = collection.root.stat()
    except FileNotFoundError:
        return [_item(collection.item_id, "file_collection", path_text, "absent")]
    except OSError as exc:
        return [
            _item(
                collection.item_id,
                "file_collection",
                path_text,
                "error",
                error_code=_os_error_code(exc),
            )
        ]
    if not stat.S_ISDIR(root_stat.st_mode):
        return [
            _item(
                collection.item_id,
                "file_collection",
                path_text,
                "error",
                error_code="not_directory",
            )
        ]

    try:
        matches = sorted(
            collection.root.glob(collection.pattern),
            key=lambda path: (path.as_posix().casefold(), path.as_posix()),
        )
    except OSError as exc:
        return [
            _item(
                collection.item_id,
                "file_collection",
                path_text,
                "error",
                error_code=_os_error_code(exc),
            )
        ]

    children: list[dict[str, Any]] = []
    for path in matches:
        relative = path.relative_to(collection.root).as_posix()
        child_id = f"{collection.child_id_prefix}/{relative}"
        children.append(_scan_file(FileTarget(child_id, path)))
    parent = _item(
        collection.item_id,
        "file_collection",
        path_text,
        "present",
    )
    return [parent, *children]


def _pack(blob: bytes) -> bytes:
    return len(blob).to_bytes(8, "big") + blob


def _encode_registry_value(value: Any, value_type: int) -> bytes:
    """生成确定性内存编码；调用方只持久化其 sha256。"""
    prefix = b"registry-value-v1\0" + _pack(str(value_type).encode("ascii"))
    if isinstance(value, str):
        body = b"s" + _pack(value.encode("utf-8", errors="surrogatepass"))
    elif isinstance(value, bytes):
        body = b"b" + _pack(value)
    elif isinstance(value, int) and not isinstance(value, bool):
        body = b"i" + _pack(str(value).encode("ascii"))
    elif isinstance(value, (list, tuple)) and all(
        isinstance(part, str) for part in value
    ):
        body = b"m" + len(value).to_bytes(8, "big")
        for part in value:
            body += _pack(part.encode("utf-8", errors="surrogatepass"))
    elif value is None:
        body = b"n"
    else:
        raise RegistryReadError("unsupported_registry_value_type")
    return prefix + body


def _registry_digest(value: Any, value_type: int) -> str:
    return sha256_hex(_encode_registry_value(value, value_type))


def _registry_error_item(
    item_id: str, kind: str, path: str, exc: RegistryReadError
) -> dict[str, Any]:
    return _item(item_id, kind, path, "error", error_code=exc.code)


def _scan_run_key(registry: RegistryReader) -> list[dict[str, Any]]:
    parent_id = "registry://HKCU/Software/Microsoft/Windows/CurrentVersion/Run"
    parent_path = rf"HKCU\{RUN_KEY}"
    try:
        values = registry.enum_values("HKCU", RUN_KEY)
    except RegistryMissing:
        return [_item(parent_id, "registry_collection", parent_path, "absent")]
    except RegistryReadError as exc:
        return [
            _registry_error_item(parent_id, "registry_collection", parent_path, exc)
        ]

    children: list[dict[str, Any]] = []
    for name, value, value_type in sorted(
        values, key=lambda row: (row[0].casefold(), row[0])
    ):
        segment = "@default" if name == "" else f"name/{quote(name, safe='')}"
        display_name = "(Default)" if name == "" else name
        item_id = f"{parent_id}/values/{segment}"
        item_path = f"{parent_path}::{display_name}"
        try:
            digest = _registry_digest(value, value_type)
        except RegistryReadError as exc:
            children.append(
                _registry_error_item(item_id, "registry_value", item_path, exc)
            )
        else:
            children.append(
                _item(item_id, "registry_value", item_path, "present", sha256=digest)
            )
    parent = _item(
        parent_id,
        "registry_collection",
        parent_path,
        "present",
    )
    return [parent, *children]


def _scan_user_path(registry: RegistryReader) -> dict[str, Any]:
    item_id = "registry://HKCU/Environment/Path"
    item_path = rf"HKCU\{USER_ENV_KEY}::Path"
    try:
        value, value_type = registry.query_value("HKCU", USER_ENV_KEY, "Path")
    except RegistryMissing:
        return _item(item_id, "registry_value", item_path, "absent")
    except RegistryReadError as exc:
        return _registry_error_item(item_id, "registry_value", item_path, exc)
    try:
        digest = _registry_digest(value, value_type)
    except RegistryReadError as exc:
        return _registry_error_item(item_id, "registry_value", item_path, exc)
    return _item(item_id, "registry_value", item_path, "present", sha256=digest)


def _extract_executable(image_path: str) -> tuple[str, str]:
    raw = image_path.strip()
    if not raw:
        raise ConfigSnapshotError("empty_service_image_path")
    if raw.startswith('"'):
        end = raw.find('"', 1)
        if end < 0:
            raise ConfigSnapshotError("invalid_service_image_path")
        executable = raw[1:end]
        remainder = raw[end + 1 :]
    else:
        match = re.match(r"(?is)^(.+?\.exe)(?:\s|$)", raw)
        if match is None:
            raise ConfigSnapshotError("invalid_service_image_path")
        executable = match.group(1)
        remainder = raw[match.end(1) :]
    if not executable.strip():
        raise ConfigSnapshotError("invalid_service_image_path")
    return executable.strip(), remainder.strip()


def _service_xml_candidates(
    image_path: str, service_name: str, registry: RegistryReader
) -> list[Path]:
    expanded = registry.expand_environment(image_path)
    executable_text, remainder = _extract_executable(expanded)
    executable = Path(executable_text)
    if not executable.is_absolute():
        system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
        executable = system_root / "System32" / executable

    candidates: list[Path] = []
    for match in re.finditer(
        r'(?i)(?:"([^"\r\n]+\.xml)"|([^\s"\r\n]+\.xml))', remainder
    ):
        explicit = match.group(1) or match.group(2)
        candidate = Path(explicit)
        if not candidate.is_absolute():
            candidate = executable.parent / candidate
        candidates.append(candidate)
    candidates.extend(
        (executable.with_suffix(".xml"), executable.parent / f"{service_name}.xml")
    )

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = os.path.normcase(_absolute_path(candidate))
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def _scan_winsw_service(service_name: str, registry: RegistryReader) -> dict[str, Any]:
    item_id = f"winsw://{service_name}/config.xml"
    logical_path = f"service://{service_name}/WinSW-config.xml"
    service_key = rf"{SERVICE_KEY_PREFIX}\{service_name}"
    try:
        image_path, _value_type = registry.query_value("HKLM", service_key, "ImagePath")
    except RegistryMissing:
        return _item(item_id, "winsw_xml", logical_path, "absent")
    except RegistryReadError as exc:
        return _registry_error_item(item_id, "winsw_xml", logical_path, exc)
    if not isinstance(image_path, str):
        return _item(
            item_id,
            "winsw_xml",
            logical_path,
            "error",
            error_code="invalid_service_image_path_type",
        )
    try:
        candidates = _service_xml_candidates(image_path, service_name, registry)
    except RegistryReadError as exc:
        return _registry_error_item(item_id, "winsw_xml", logical_path, exc)
    except ConfigSnapshotError as exc:
        return _item(item_id, "winsw_xml", logical_path, "error", error_code=str(exc))
    if not candidates:
        return _item(
            item_id,
            "winsw_xml",
            logical_path,
            "error",
            error_code="service_xml_unresolved",
        )

    for candidate in candidates:
        try:
            candidate_stat = candidate.stat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            return _item(
                item_id,
                "winsw_xml",
                _absolute_path(candidate),
                "error",
                error_code=_os_error_code(exc),
            )
        if not stat.S_ISREG(candidate_stat.st_mode):
            return _item(
                item_id,
                "winsw_xml",
                _absolute_path(candidate),
                "error",
                error_code="not_regular_file",
            )
        return _scan_file(FileTarget(item_id, candidate, "winsw_xml"))
    return _scan_file(FileTarget(item_id, candidates[0], "winsw_xml"))


def production_plan(home: Path | None = None) -> ScanPlan:
    home = home or Path.home()
    relative_files = (
        "ops/bridge-producer.json",
        "ops/hooks.json",
        ".claude.json",
        ".pi/agent/models.json",
        ".pi/agent/settings.json",
        ".pi/agent/extensions/subagent-control/deployment.json",
    )
    static_files = tuple(
        FileTarget(f"file://~/{relative}", home / Path(relative))
        for relative in relative_files
    )
    extension_root = home / ".pi" / "agent" / "extensions"
    collection = FileCollection(
        "collection://~/.pi/agent/extensions/*/config.json",
        extension_root,
        "*/config.json",
        "file://~/.pi/agent/extensions",
    )
    return ScanPlan(
        scope=PRODUCTION_SCOPE,
        static_files=static_files,
        collections=(collection,),
        include_windows_surfaces=True,
        service_names=SERVICE_NAMES,
    )


def scan(
    plan: ScanPlan, registry: RegistryReader | None = None
) -> list[dict[str, Any]]:
    items = [_scan_file(target) for target in plan.static_files]
    for collection in plan.collections:
        items.extend(_scan_collection(collection))
    if plan.include_windows_surfaces:
        registry = registry or NativeRegistryReader()
        items.extend(_scan_run_key(registry))
        items.append(_scan_user_path(registry))
        items.extend(_scan_winsw_service(name, registry) for name in plan.service_names)

    ordered = sorted(items, key=lambda row: row["id"])
    ids = [row["id"] for row in ordered]
    if len(ids) != len(set(ids)):
        raise ConfigSnapshotError("scan produced duplicate item ids")
    return ordered


def build_snapshot(
    plan: ScanPlan, registry: RegistryReader | None = None
) -> dict[str, Any]:
    items = scan(plan, registry)
    error_count = sum(row["state"] == "error" for row in items)
    return {
        "schema": SNAPSHOT_SCHEMA,
        "scope": plan.scope,
        "hash_algorithm": HASH_ALGORITHM,
        "created_at": _utc_now(),
        "status": "pass" if error_count == 0 else "error",
        "item_count": len(items),
        "error_count": error_count,
        "items": items,
    }


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def validate_snapshot(
    data: Any, *, expected_scope: str | None = None
) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ConfigSnapshotError("snapshot root must be an object")
    extra_top = set(data) - SNAPSHOT_KEYS
    missing_top = SNAPSHOT_KEYS - set(data)
    if extra_top or missing_top:
        raise ConfigSnapshotError("snapshot top-level schema mismatch")
    if data.get("schema") not in {SNAPSHOT_SCHEMA, "config-snapshot/v1"}:
        raise ConfigSnapshotError("unsupported snapshot schema")
    if data.get("hash_algorithm") != HASH_ALGORITHM:
        raise ConfigSnapshotError("unsupported snapshot hash algorithm")
    scope = data.get("scope")
    if not isinstance(scope, str) or not scope:
        raise ConfigSnapshotError("snapshot scope is invalid")
    if expected_scope is not None and scope != expected_scope:
        raise ConfigSnapshotError("snapshot scope does not match current scanner")
    if not isinstance(data.get("created_at"), str) or not data["created_at"]:
        raise ConfigSnapshotError("snapshot created_at is invalid")
    if data.get("status") not in {"pass", "error"}:
        raise ConfigSnapshotError("snapshot status is invalid")
    if not isinstance(data.get("items"), list):
        raise ConfigSnapshotError("snapshot items must be an array")

    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in data["items"]:
        if not isinstance(raw, dict) or set(raw) - ITEM_KEYS:
            raise ConfigSnapshotError("snapshot item schema mismatch")
        if not all(
            isinstance(raw.get(key), str) and raw[key] for key in ("id", "kind", "path")
        ):
            raise ConfigSnapshotError("snapshot item identity is invalid")
        item_id = raw["id"]
        if item_id in seen:
            raise ConfigSnapshotError("snapshot item id is duplicated")
        seen.add(item_id)
        state = raw.get("state")
        if state not in VALID_STATES:
            raise ConfigSnapshotError("snapshot item state is invalid")
        collection = raw["kind"] in {"file_collection", "registry_collection"}
        if state == "present":
            if "error_code" in raw or (not collection and not _is_sha256(raw.get("sha256"))):
                raise ConfigSnapshotError("present snapshot item has invalid content data")
        elif state == "absent":
            if "sha256" in raw or "error_code" in raw:
                raise ConfigSnapshotError("absent snapshot item has unexpected fields")
        else:
            if (
                not isinstance(raw.get("error_code"), str)
                or not raw["error_code"]
                or "sha256" in raw
            ):
                raise ConfigSnapshotError("error snapshot item is invalid")
        normalized.append({
            key: raw[key] for key in ITEM_KEYS
            if key in raw and not (collection and key == "sha256")
        })

    error_count = sum(row["state"] == "error" for row in normalized)
    if (
        data.get("item_count") != len(normalized)
        or data.get("error_count") != error_count
    ):
        raise ConfigSnapshotError("snapshot counts do not match items")
    expected_status = "pass" if error_count == 0 else "error"
    if data.get("status") != expected_status:
        raise ConfigSnapshotError("snapshot status does not match items")
    return {**data, "schema": SNAPSHOT_SCHEMA, "items": sorted(normalized, key=lambda row: row["id"])}


def _atomic_write_json(path: Path, data: dict[str, Any]) -> bytes:
    payload = (
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise
    return payload


def _load_snapshot(path: Path, *, expected_scope: str) -> dict[str, Any]:
    try:
        payload = path.read_bytes()
    except FileNotFoundError as exc:
        raise ConfigSnapshotError(
            f"snapshot file not found: {_absolute_path(path)}"
        ) from exc
    except OSError as exc:
        raise ConfigSnapshotError(
            f"cannot read snapshot ({_os_error_code(exc)}): {_absolute_path(path)}"
        ) from exc
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConfigSnapshotError("snapshot is not valid UTF-8 JSON") from exc
    return validate_snapshot(data, expected_scope=expected_scope)


def _missing_item(item_id: str, peer: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item_id,
        "kind": peer["kind"],
        "path": peer["path"],
        "state": "absent",
    }


def _change_type(before: dict[str, Any], after: dict[str, Any]) -> str:
    before_state = before["state"]
    after_state = after["state"]
    if before_state == "absent" and after_state == "present":
        return "absent_to_present"
    if before_state == "present" and after_state == "absent":
        return "present_to_absent"
    if before_state == "present" and after_state == "present":
        if before.get("sha256") != after.get("sha256"):
            return "content_changed"
        if before.get("path") != after.get("path"):
            return "location_changed"
    if before_state != after_state or "error" in {before_state, after_state}:
        return "scan_state_changed"
    return "metadata_changed"


def compare_items(
    baseline_items: list[dict[str, Any]], current_items: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    baseline = {row["id"]: row for row in baseline_items}
    current = {row["id"]: row for row in current_items}
    differences: list[dict[str, Any]] = []
    for item_id in sorted(set(baseline) | set(current)):
        before = baseline.get(item_id)
        after = current.get(item_id)
        if before is None:
            assert after is not None
            before = _missing_item(item_id, after)
        if after is None:
            after = _missing_item(item_id, before)
        if before != after:
            differences.append(
                {
                    "id": item_id,
                    "change": _change_type(before, after),
                    "before": before,
                    "after": after,
                }
            )
    return differences


def build_compare_report(
    baseline: dict[str, Any],
    current: dict[str, Any],
    differences: list[dict[str, Any]],
    *,
    baseline_path: Path,
) -> dict[str, Any]:
    has_errors = baseline["error_count"] > 0 or current["error_count"] > 0
    status = "error" if has_errors else "changed" if differences else "clean"
    return {
        "schema": COMPARE_SCHEMA,
        "scope": current["scope"],
        "hash_algorithm": HASH_ALGORITHM,
        "created_at": _utc_now(),
        "status": status,
        "baseline": {
            "path": _absolute_path(baseline_path),
            "created_at": baseline["created_at"],
            "status": baseline["status"],
            "item_count": baseline["item_count"],
            "error_count": baseline["error_count"],
        },
        "current": {
            "created_at": current["created_at"],
            "status": current["status"],
            "item_count": current["item_count"],
            "error_count": current["error_count"],
        },
        "difference_count": len(differences),
        "differences": differences,
    }


def _print_snapshot_result(snapshot: dict[str, Any], output: Path) -> None:
    present = sum(row["state"] == "present" for row in snapshot["items"])
    absent = sum(row["state"] == "absent" for row in snapshot["items"])
    print(f"snapshot: {snapshot['status']}")
    print(
        f"items: {snapshot['item_count']} "
        f"(present={present}, absent={absent}, error={snapshot['error_count']})"
    )
    print(f"path: {_absolute_path(output)}")
    for row in snapshot["items"]:
        if row["state"] == "error":
            print(f"- error: {row['id']} ({row['error_code']})")


def _print_compare_result(report: dict[str, Any], output: Path) -> None:
    print(f"compare: {report['status']}")
    print(f"differences: {report['difference_count']}")
    for difference in report["differences"]:
        print(f"- {difference['change']}: {difference['id']}")
    print(f"report: {_absolute_path(output)}")


def cmd_snapshot() -> int:
    snapshot = build_snapshot(production_plan())
    output = RUNTIME_DIR / _output_name("snapshot")
    _atomic_write_json(output, snapshot)
    _print_snapshot_result(snapshot, output)
    return 0 if snapshot["status"] == "pass" else 2


def cmd_compare(snapshot_path: Path) -> int:
    plan = production_plan()
    baseline = _load_snapshot(snapshot_path, expected_scope=plan.scope)
    current = build_snapshot(plan)
    differences = compare_items(baseline["items"], current["items"])
    report = build_compare_report(
        baseline,
        current,
        differences,
        baseline_path=snapshot_path,
    )
    output = RUNTIME_DIR / _output_name("compare")
    _atomic_write_json(output, report)
    _print_compare_result(report, output)
    return {"clean": 0, "changed": 1, "error": 2}[report["status"]]


def cmd_self_test() -> int:
    from config_snapshot_selftest import cmd_self_test as _cmd_self_test

    return _cmd_self_test()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="仓外关键配置面的 hash-only 快照与比对"
    )
    parser.add_argument("--self-test", action="store_true", help="运行隔离自测后退出")
    subparsers = parser.add_subparsers(dest="action")
    subparsers.add_parser("snapshot", help="扫描当前配置面并生成快照")
    compare_parser = subparsers.add_parser("compare", help="当前配置面与指定快照比对")
    compare_parser.add_argument(
        "--snapshot", required=True, type=Path, help="基线快照 JSON"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        if args.action is not None:
            print("--self-test cannot be combined with an action", file=sys.stderr)
            return 2
        return cmd_self_test()
    if args.action == "snapshot":
        return cmd_snapshot()
    if args.action == "compare":
        return cmd_compare(args.snapshot)
    print("choose snapshot, compare, or --self-test", file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigSnapshotError as exc:
        print(f"config_snapshot: ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
    except OSError as exc:
        print(f"config_snapshot: ERROR: {_os_error_code(exc)}", file=sys.stderr)
        raise SystemExit(2)
