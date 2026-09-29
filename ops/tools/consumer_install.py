#!/usr/bin/env python3
"""CR-CONSUMER-v1：消费者项目安装事务（marker、归属、dry-run 冲突、原子升级与恢复）。

单入口语义：preflight -> snapshot -> stage -> verifier -> 切换资源与 marker -> 安装回执。
默认链接模式把清单内资源挂到项目上；``--resource-mode projection`` 用文件投影替代链接。
只更新上一份 marker 归属且内容仍匹配的路径；项目自有内容一律不覆盖。
卸载只 unlink 已归属链接，绝不递归删除链接目标。

用法：
  python -B ops/tools/consumer_install.py --target <项目绝对路径> --runtime-root <已验证运行包>
  python -B ops/tools/consumer_install.py --target <项目> --runtime-root <包> --dry-run
  python -B ops/tools/consumer_install.py --target <项目> --runtime-root <包> --update
  python -B ops/tools/consumer_install.py --target <项目> --uninstall
  python -B ops/tools/consumer_install.py --target <项目> --verify
  python -B ops/tools/consumer_install.py --target <项目> --rollback
  python -B ops/tools/consumer_install.py --self-test
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Iterable

sys.dont_write_bytecode = True

SCHEMA_VERSION = 1
MARKER_RELATIVE = ".pi/control-plane-consumer.json"
RECEIPT_RELATIVE = ".pi/control-plane-consumer.receipt.json"
RUNTIME_LINK_RELATIVE = ".pi/control-plane-runtime"
BACKUP_DIR_RELATIVE = ".pi/control-plane-backups"
STAGING_SUFFIX = ".control-plane-staging"
ROLLBACK_SUFFIX = ".control-plane-rollback"
INVENTORY_NAME = "consumer-release-manifest.json"
DEFAULT_TRUSTED_SLOTS = ("~/.subagent-control/releases/consumer",)
MODE_LINKS = "links"
MODE_PROJECTION = "projection"
KIND_LINK = "link"
KIND_FILE = "file"

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_CONFLICT = 2
EXIT_UPDATE_REQUIRED = 3


class InstallError(RuntimeError):
    """事务、marker 或信任边界违约。"""


# --------------------------------------------------------------------------------------
# 基础工具


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def same_path(left: Path | str, right: Path | str) -> bool:
    try:
        return os.path.normcase(os.path.realpath(str(left))) == os.path.normcase(os.path.realpath(str(right)))
    except OSError:
        return False


def is_inside(path: Path | str, root: Path | str) -> bool:
    try:
        child = os.path.normcase(os.path.realpath(str(path)))
        parent = os.path.normcase(os.path.realpath(str(root)))
    except OSError:
        return False
    return child == parent or child.startswith(parent.rstrip(os.sep) + os.sep)


def lexists(path: Path) -> bool:
    try:
        os.lstat(path)
        return True
    except OSError:
        return False


def link_target(path: Path) -> str | None:
    """目录 junction / 文件 symlink 的目标；普通文件与目录返回 None。"""
    try:
        return os.readlink(path)
    except (OSError, ValueError):
        return None


def link_resolved(path: Path) -> str | None:
    """链接目标的归一化真实路径；非链接返回 None。"""
    if link_target(path) is None:
        return None
    return os.path.realpath(path)


def toml_free_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise InstallError(f"required JSON file is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise InstallError(f"invalid JSON: {path}:{exc.lineno}: {exc.msg}") from exc
    if not isinstance(value, dict):
        raise InstallError(f"JSON root must be an object: {path}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def read_json_if_exists(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    return toml_free_json(path)


def normalize_relative(value: Any, label: str) -> str:
    text = str(value or "").strip().replace("\\", "/")
    if not text:
        raise InstallError(f"{label} must be a non-empty relative path")
    if text.startswith("/") or (len(text) > 1 and text[1] == ":"):
        raise InstallError(f"{label} must be relative: {text}")
    normalized = posixpath.normpath(text)
    if normalized.startswith("..") or normalized == ".":
        raise InstallError(f"{label} must not escape the project root: {text}")
    return normalized


def trusted_slots(values: Iterable[str]) -> list[Path]:
    slots: list[Path] = []
    for value in values:
        candidate = Path(value).expanduser()
        if not candidate.is_absolute():
            raise InstallError(f"trusted slot must be an absolute path: {value}")
        slots.append(candidate.resolve())
    return slots


def under_trusted_slot(runtime_root: Path, slots: list[Path]) -> Path | None:
    for slot in slots:
        if is_inside(runtime_root, slot):
            return slot
    return None


# --------------------------------------------------------------------------------------
# 链接原语


def create_directory_link(target: Path, link: Path) -> str:
    """目录链接：优先原生 symlink，Windows 无权限时回退 junction。只创建链接本身。"""
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.symlink(target, link, target_is_directory=True)
        return "symlink"
    except (OSError, NotImplementedError) as exc:
        first_error = exc
    if os.name == "nt":
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode == 0 and lexists(link):
            return "junction"
        raise InstallError(
            "directory link could not be created (symlink and junction both failed): "
            f"{link} -> {target}: {first_error}; mklink={result.stderr.strip() or result.stdout.strip()}"
        ) from first_error
    raise InstallError(f"directory link could not be created: {link} -> {target}: {first_error}") from first_error


def create_file_link(target: Path, link: Path) -> str:
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.symlink(target, link)
        return "symlink"
    except (OSError, NotImplementedError) as exc:
        raise InstallError(f"file link could not be created: {link} -> {target}: {exc}") from exc


def remove_link(path: Path) -> None:
    """只移除链接本身，绝不递归进入目标。"""
    if not lexists(path):
        return
    if link_target(path) is None:
        raise InstallError(f"refusing to remove a non-link path: {path}")
    os.unlink(path)


def remove_any_owned(path: Path) -> None:
    """移除已归属的链接或文件；目录（非链接）一律拒绝，避免递归删除。"""
    if not lexists(path):
        return
    if link_target(path) is not None:
        os.unlink(path)
        return
    if path.is_dir():
        raise InstallError(f"refusing to remove a directory: {path}")
    path.unlink()


def copy_tree_files(source: Path, dest: Path) -> list[str]:
    written: list[str] = []
    for candidate in sorted(path for path in source.rglob("*") if path.is_file()):
        relative = candidate.relative_to(source)
        target = dest / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(candidate, target)
        written.append(relative.as_posix())
    return written


def iter_tree_files(source: Path) -> list[Path]:
    return sorted(path for path in source.rglob("*") if path.is_file())


# --------------------------------------------------------------------------------------
# 运行包与 marker


def load_runtime(runtime_root: Path, slots: list[Path]) -> dict[str, Any]:
    runtime_root = runtime_root.expanduser()
    if not runtime_root.is_absolute():
        raise InstallError(f"runtime root must be an absolute path: {runtime_root}")
    if not runtime_root.is_dir():
        raise InstallError(f"runtime root is not an existing directory: {runtime_root}")
    runtime_root = runtime_root.resolve()
    if under_trusted_slot(runtime_root, slots) is None:
        raise InstallError(
            "runtime root is outside every trusted release slot; pass --trusted-slot with the slot that "
            f"contains the verified package: {runtime_root}"
        )
    inventory_path = runtime_root / INVENTORY_NAME
    if not inventory_path.is_file():
        raise InstallError(f"runtime package has no inventory: {inventory_path}")
    inventory = toml_free_json(inventory_path)
    if inventory.get("schema_version") != SCHEMA_VERSION:
        raise InstallError("runtime inventory schema_version must be 1")
    build_id = str(inventory.get("build_id") or "")
    if not build_id:
        raise InstallError("runtime inventory build_id must be non-empty")
    package_id = str(inventory.get("package_id") or "")
    if not package_id:
        raise InstallError("runtime inventory package_id must be non-empty")
    files = inventory.get("files")
    if not isinstance(files, list) or not files:
        raise InstallError("runtime inventory files must be a non-empty list")
    digests = {str(record["target"]): str(record["sha256"]) for record in files}
    entrypoints = inventory.get("entrypoints") or {}
    missing_entrypoints = [
        str(path) for path in entrypoints.values() if not (runtime_root / str(path)).is_file()
    ]
    if missing_entrypoints:
        raise InstallError(
            "runtime package entrypoints are missing: " + ", ".join(sorted(missing_entrypoints))
        )
    if not (runtime_root / "package.json").is_file():
        raise InstallError(f"runtime package has no package.json: {runtime_root}")
    mounts = inventory.get("resource_mounts")
    if not isinstance(mounts, list) or not mounts:
        raise InstallError("runtime inventory resource_mounts must be a non-empty list")
    for index, mount in enumerate(mounts):
        relative = normalize_relative(mount.get("runtime_path"), f"resource_mounts[{index}].runtime_path")
        if not (runtime_root / relative).exists():
            raise InstallError(
                f"runtime package is missing mounted resource {relative}; rebuild the package from the "
                "positive manifest"
            )
    return {
        "root": runtime_root,
        "inventory": inventory,
        "build_id": build_id,
        "package_id": package_id,
        "digests": digests,
        "mounts": mounts,
        "template_files": inventory.get("template_files") or [],
        "skills": inventory.get("skills") or [],
        "entrypoints": entrypoints,
    }


def marker_path(project_root: Path) -> Path:
    return project_root / MARKER_RELATIVE


def read_marker(project_root: Path) -> dict[str, Any] | None:
    return read_json_if_exists(marker_path(project_root))


def managed_index(marker: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    if not marker:
        return index
    for record in marker.get("managed_paths") or []:
        if isinstance(record, dict) and record.get("path"):
            index[str(record["path"])] = record
    return index


def validate_marker(
    marker: dict[str, Any], project_root: Path, slots: list[Path]
) -> list[str]:
    """无效 marker fail closed：结构、项目根、受信槽、路径逃逸。"""
    problems: list[str] = []
    if marker.get("schema_version") != SCHEMA_VERSION:
        problems.append("marker schema_version must be 1")
    if marker.get("mode") != "consumer":
        problems.append("marker mode must be consumer")
    recorded_project = marker.get("project_root")
    if not recorded_project or not same_path(recorded_project, project_root):
        problems.append(
            f"marker project_root does not match this project: {recorded_project} != {project_root}"
        )
    recorded_runtime = marker.get("runtime_root")
    if not recorded_runtime or not Path(str(recorded_runtime)).is_absolute():
        problems.append("marker runtime_root must be an absolute path")
    elif under_trusted_slot(Path(str(recorded_runtime)), slots) is None:
        problems.append(f"marker runtime_root is outside every trusted slot: {recorded_runtime}")
    if not str(marker.get("build_id") or ""):
        problems.append("marker build_id must be non-empty")
    if not str(marker.get("install_id") or ""):
        problems.append("marker install_id must be non-empty")
    if str(marker.get("resource_mode") or "") not in {MODE_LINKS, MODE_PROJECTION}:
        problems.append("marker resource_mode must be links or projection")
    records = marker.get("managed_paths")
    if not isinstance(records, list) or not records:
        problems.append("marker managed_paths must be a non-empty list")
        return problems
    for record in records:
        if not isinstance(record, dict):
            problems.append("marker managed_paths entries must be objects")
            continue
        try:
            normalize_relative(record.get("path"), "marker managed_paths.path")
        except InstallError as exc:
            problems.append(str(exc))
            continue
        if str(record.get("kind") or "") not in {KIND_LINK, "file"}:
            problems.append(f"marker managed path kind must be link or file: {record.get('path')}")
        target = record.get("target")
        if target:
            candidate = Path(str(target))
            if not candidate.is_absolute():
                problems.append(f"marker link target must be absolute: {record.get('path')}")
            elif not is_inside(candidate, recorded_runtime):
                problems.append(
                    f"marker link target escapes the runtime root: {record.get('path')} -> {target}"
                )
    return problems


# --------------------------------------------------------------------------------------
# 计划


def factory_entries(runtime: dict[str, Any], project_root: Path) -> list[dict[str, Any]]:
    """初始项目资料参与安装事务，创建后归项目所有。"""
    paths = ["PROJECT.md", "STATUS.md", "ROADMAP.md", "notes/ledger/DEBT.toml"]
    missing = [name for name in paths if not (project_root / name).exists()]
    if not missing:
        return []
    templates = runtime["root"] / "ops" / "templates"
    contents: dict[str, str] = {}
    if "PROJECT.md" in missing:
        contents["PROJECT.md"] = (templates / "factory-project.md").read_text(encoding="utf-8")
    if "notes/ledger/DEBT.toml" in missing:
        contents["notes/ledger/DEBT.toml"] = (templates / "factory-ledger.toml").read_text(encoding="utf-8")
    if "STATUS.md" in missing or "ROADMAP.md" in missing:
        import state_checkpoint
        delta = state_checkpoint.validate_delta(toml_free_json(templates / "factory-state-delta.json"))
        contents.update(state_checkpoint.plan_writes(delta))
    return [{"path": name, "kind": KIND_FILE, "runtime_path": None,
             "optional_if_local": False, "role": "project-state", "content": contents[name]}
            for name in missing]


def planned_entries(
    runtime: dict[str, Any], project_root: Path, resource_mode: str
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = factory_entries(runtime, project_root)
    for mount in runtime["mounts"]:
        project_path = normalize_relative(mount["project_path"], "resource_mounts.project_path")
        runtime_path = normalize_relative(mount["runtime_path"], "resource_mounts.runtime_path")
        entries.append(
            {
                "path": project_path,
                "kind": KIND_LINK if resource_mode == MODE_LINKS else KIND_FILE,
                "runtime_path": runtime_path,
                "optional_if_local": bool(mount.get("optional_if_local")),
                "role": "mount",
            }
        )
    if resource_mode == MODE_LINKS:
        entries.append(
            {
                "path": RUNTIME_LINK_RELATIVE,
                "kind": KIND_LINK,
                "runtime_path": ".",
                "optional_if_local": False,
                "role": "runtime_package",
            }
        )
    for template in runtime["template_files"]:
        source = normalize_relative(template["source"], "template_files.source")
        target = normalize_relative(template["target"], "template_files.target")
        policy = str(template.get("policy"))
        if resource_mode == MODE_PROJECTION and target == ".pi/settings.json":
            continue
        entries.append(
            {
                "path": target,
                "kind": KIND_FILE,
                "runtime_path": source,
                "optional_if_local": False,
                "role": "template",
                "policy": policy,
            }
        )
    if resource_mode == MODE_PROJECTION:
        entries.append(
            {
                "path": ".pi/settings.json",
                "kind": KIND_FILE,
                "runtime_path": None,
                "optional_if_local": False,
                "role": "projection_settings",
                "content": json.dumps({"packages": []}, ensure_ascii=False, indent=2) + "\n",
            }
        )
        for skill_root in runtime["skills"]:
            root = normalize_relative(skill_root, "skills")
            source_dir = runtime["root"] / root
            for candidate in iter_tree_files(source_dir):
                relative = candidate.relative_to(source_dir).as_posix()
                entries.append(
                    {
                        "path": f".pi/skills/{relative}",
                        "kind": KIND_FILE,
                        "runtime_path": f"{root}/{relative}",
                        "optional_if_local": False,
                        "role": "projection_skill",
                    }
                )
    ignored_mounts = []
    if resource_mode == MODE_LINKS:
        for mount in runtime["mounts"]:
            local = project_root / mount["project_path"]
            if mount.get("optional_if_local") and local.exists() and link_resolved(local) is None:
                continue
            if mount["project_path"].startswith("ops/"):
                ignored_mounts.append("/" + mount["project_path"][4:])
    for target, content in {
        "ops/.gitignore": "\n".join(["/map/", *ignored_mounts]) + "\n",
        ".pi/.gitignore": "/control-plane-*\n*.control-plane-staging\n",
    }.items():
        entries.append({"path": target, "kind": KIND_FILE, "runtime_path": None,
                        "optional_if_local": False, "role": "local_ignore", "content": content})
    return entries


def expand_mount_files(
    runtime: dict[str, Any], entry: dict[str, Any]
) -> list[dict[str, Any]]:
    """projection 模式：把目录挂载展开成逐文件投影。"""
    runtime_dir = runtime["root"] / str(entry["runtime_path"])
    expanded: list[dict[str, Any]] = []
    for candidate in iter_tree_files(runtime_dir):
        relative = candidate.relative_to(runtime_dir).as_posix()
        expanded.append(
            {
                "path": f"{entry['path']}/{relative}",
                "kind": "file",
                "runtime_path": f"{entry['runtime_path']}/{relative}",
                "role": entry.get("role", "mount"),
                "optional_if_local": False,
            }
        )
    return expanded


def classify_path(
    project_root: Path, entry: dict[str, Any], owned: dict[str, Any] | None
) -> str:
    path = project_root / str(entry["path"])
    if not lexists(path):
        return "absent"
    resolved = link_resolved(path)
    if resolved is not None:
        if owned and str(owned.get("kind")) == KIND_LINK and same_path(resolved, str(owned.get("target") or "")):
            if not Path(resolved).exists():
                return "owned-broken"
            return "owned-link"
        return "foreign-link"
    if entry["kind"] == KIND_LINK:
        return "foreign-dir" if path.is_dir() else "foreign-file"
    if path.is_dir():
        return "foreign-dir"
    if owned and str(owned.get("kind")) == "file" and owned.get("installed_digest") == sha256_file(path):
        return "owned-file"
    return "foreign-file"


def reported_conflict(action: dict[str, Any], reason: str) -> dict[str, Any]:
    """对外冲突记录：只保留定位与判定字段，不带内部 staging 细节。"""
    return {
        "path": action["path"],
        "kind": action["kind"],
        "role": action.get("role"),
        "state": action.get("state"),
        "reason": reason,
    }


def build_plan(
    project_root: Path,
    runtime: dict[str, Any],
    marker: dict[str, Any] | None,
    *,
    resource_mode: str,
    update: bool,
) -> dict[str, Any]:
    owned = managed_index(marker)
    entries: list[dict[str, Any]] = []
    for entry in planned_entries(runtime, project_root, resource_mode):
        if entry["kind"] == KIND_LINK and entry.get("runtime_path") not in (None, "."):
            if not (runtime["root"] / str(entry["runtime_path"])).is_dir():
                raise InstallError(
                    f"runtime package is missing mounted directory: {entry['runtime_path']}"
                )
        if resource_mode == MODE_PROJECTION and entry.get("role") == "mount":
            entries.extend(expand_mount_files(runtime, entry))
        else:
            entries.append(entry)

    actions: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []
    advisories: list[dict[str, Any]] = []
    for entry in entries:
        owned_record = owned.get(str(entry["path"]))
        state = classify_path(project_root, entry, owned_record)
        action = {
            "path": entry["path"],
            "kind": entry["kind"],
            "role": entry.get("role"),
            "state": state,
            "runtime_path": entry.get("runtime_path"),
            "content": entry.get("content"),
            "optional_if_local": bool(entry.get("optional_if_local")),
        }
        desired_target = None
        if entry["kind"] == KIND_LINK:
            desired_target = str(
                (runtime["root"] / str(entry["runtime_path"])).resolve()
                if entry.get("runtime_path") not in (None, ".")
                else runtime["root"]
            )
        desired_digest = None
        if entry["kind"] == "file":
            if entry.get("content") is not None:
                desired_digest = sha256_text(str(entry["content"]))
            elif entry.get("runtime_path"):
                desired_digest = runtime["digests"].get(str(entry["runtime_path"]))
        action["desired_digest"] = desired_digest
        if state == "absent":
            # 上一份 marker 归属过、现在缺失（含被删的断链）→ 记为修复而不是新建。
            action["decision"] = "repair" if owned_record else "create"
        elif state == "owned-link":
            if desired_target is not None and same_path(desired_target, owned_record.get("target") or ""):
                action["decision"] = "keep"
            elif update:
                action["decision"] = "refresh"
            else:
                action["decision"] = "conflict"
                conflicts.append(
                    reported_conflict(
                        action, "归属链接指向另一个运行包版本；用 --update 才刷新"
                    )
                )
        elif state == "owned-file":
            if desired_digest is None or owned_record.get("installed_digest") == desired_digest:
                action["decision"] = "keep"
            else:
                action["decision"] = "refresh"
        elif state == "owned-broken":
            action["decision"] = "repair"
        elif state == "foreign-file" and entry.get("role") == "template":
            if desired_digest and sha256_file(project_root / str(entry["path"])) == desired_digest:
                action["decision"] = "adopt"
            else:
                action["decision"] = "conflict"
                conflicts.append(
                    reported_conflict(action, "项目自有文件与安装归属不符：列明不覆盖")
                )
        elif state == "foreign-dir" and entry.get("optional_if_local"):
            action["decision"] = "skip"
            advisories.append(
                {
                    "path": entry["path"],
                    "reason": "项目自有同名目录：保留本地内容，技能/资源改由运行包清单发现",
                }
            )
        else:
            action["decision"] = "conflict"
            conflicts.append(
                reported_conflict(
                    action,
                    "路径已存在且不归本安装器所有：列明不覆盖（-Force 不再授权覆盖用户内容）",
                )
            )
        actions.append(action)

    marker_build = str(marker.get("build_id") or "") if marker else ""
    marker_runtime = str(marker.get("runtime_root") or "") if marker else ""
    same_build = bool(marker) and marker_build == runtime["build_id"] and same_path(marker_runtime, runtime["root"])
    same_mode = bool(marker) and str(marker.get("resource_mode") or "") == resource_mode
    update_required = bool(marker) and not same_build and not update
    changed = [action for action in actions if action["decision"] in {"create", "refresh", "repair"}]
    # 保留控制面路径（运行包注册点）被外部占用时无法交付资源发现：阻塞而不是静默降级。
    blocking = [
        item for item in conflicts if item["path"] == RUNTIME_LINK_RELATIVE
    ]
    return {
        "actions": actions,
        "conflicts": conflicts,
        "blocking": blocking,
        "advisories": advisories,
        "changed": changed,
        "same_build": same_build,
        "same_mode": same_mode,
        "update_required": update_required,
        "marker_present": bool(marker),
        "noop": bool(marker) and same_build and same_mode and not changed and not conflicts,
        "resource_mode": resource_mode,
    }


# --------------------------------------------------------------------------------------
# 事务


def snapshot_state(
    project_root: Path, rel: str, backup_dir: Path | None = None
) -> dict[str, Any]:
    path = project_root / rel
    record: dict[str, Any] = {"path": rel, "existed": False, "kind": None, "target": None, "digest": None}
    if not lexists(path):
        return record
    record["existed"] = True
    target = link_target(path)
    if target is not None:
        record["kind"] = KIND_LINK
        record["target"] = os.path.realpath(path)
        return record
    if path.is_dir():
        record["kind"] = "dir"
        return record
    record["kind"] = "file"
    record["digest"] = sha256_file(path)
    if backup_dir is not None:
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_file = backup_dir / (hashlib.sha256(rel.encode("utf-8")).hexdigest()[:16] + ".bin")
        shutil.copy2(path, backup_file)
        record["backup_file"] = backup_file.name
    return record


def apply_plan(
    project_root: Path,
    runtime: dict[str, Any],
    plan: dict[str, Any],
    marker: dict[str, Any] | None,
    *,
    resource_mode: str,
    fault_hook: Any = None,
) -> dict[str, Any]:
    install_id = uuid.uuid4().hex[:12]
    backups = project_root / BACKUP_DIR_RELATIVE / install_id
    files_backup = backups / "files"
    backups.mkdir(parents=True, exist_ok=True)
    previous_entries = [
        snapshot_state(project_root, str(action["path"]), files_backup) for action in plan["changed"]
    ]
    snapshot = {
        "schema_version": SCHEMA_VERSION,
        "install_id": install_id,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "project_root": str(project_root),
        "previous_marker": marker,
        "previous_marker_existed": marker_path(project_root).is_file(),
        "previous_runtime_root": str(marker.get("runtime_root")) if marker else None,
        "previous_build_id": str(marker.get("build_id")) if marker else None,
        "entries": previous_entries,
    }
    write_json(backups / "snapshot.json", snapshot)

    switched: list[dict[str, Any]] = []
    staged: list[Path] = []
    marker_written = False
    receipt_path = project_root / RECEIPT_RELATIVE
    previous_receipt = read_json_if_exists(receipt_path)

    def stage_entry(action: dict[str, Any]) -> dict[str, Any]:
        final = project_root / str(action["path"])
        stage_name = final.with_name(final.name + f".{install_id}{STAGING_SUFFIX}")
        if lexists(stage_name):
            remove_any_owned(stage_name)
        stage_name.parent.mkdir(parents=True, exist_ok=True)
        staged.append(stage_name)
        runtime_path = action.get("runtime_path")
        if action["kind"] == KIND_LINK:
            target = runtime["root"] if runtime_path in (None, ".") else runtime["root"] / str(runtime_path)
            mechanism = create_directory_link(target, stage_name)
            return {"stage": stage_name, "target": str(target.resolve()), "mechanism": mechanism}
        content = action.get("content")
        if content is not None:
            stage_name.write_text(str(content), encoding="utf-8", newline="\n")
            return {"stage": stage_name, "digest": sha256_text(str(content))}
        if runtime_path is None:
            raise InstallError(f"entry has neither runtime source nor content: {action['path']}")
        source = runtime["root"] / str(runtime_path)
        stage_name.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, stage_name)
        return {"stage": stage_name, "digest": sha256_file(stage_name)}

    def verify_stage(action: dict[str, Any], staged_record: dict[str, Any]) -> None:
        stage_path = Path(staged_record["stage"])
        if action["kind"] == KIND_LINK:
            if not same_path(stage_path, staged_record["target"]):
                raise InstallError(f"staged link does not resolve to the runtime package: {stage_path}")
            if not Path(os.path.realpath(stage_path)).exists():
                raise InstallError(f"staged link target is missing: {staged_record['target']}")
            return
        digest = sha256_file(stage_path)
        expected = staged_record.get("digest")
        if expected and digest != expected:
            raise InstallError(f"staged file digest mismatch: {action['path']}")

    try:
        for index, action in enumerate(plan["changed"]):
            staged_record = stage_entry(action)
            verify_stage(action, staged_record)
            if fault_hook is not None:
                fault_hook("after_stage", action)
            final = project_root / str(action["path"])
            rollback_name = final.with_name(final.name + f".{install_id}{ROLLBACK_SUFFIX}")
            moved = None
            if lexists(final):
                if lexists(rollback_name):
                    remove_any_owned(rollback_name)
                os.replace(final, rollback_name)
                moved = rollback_name
            os.replace(staged_record["stage"], final)
            switched.append(
                {
                    "action": action,
                    "final": final,
                    "rollback": moved,
                    "staged": staged_record,
                    "index": index,
                }
            )
            if fault_hook is not None:
                fault_hook("after_switch", action)
            if not same_path(final, staged_record.get("target") or final):
                raise InstallError(f"switched link does not resolve to the runtime package: {final}")

        if fault_hook is not None:
            fault_hook("before_marker", None)

        managed_paths: list[dict[str, Any]] = []
        for action in plan["actions"]:
            if action.get("role") == "project-state":
                continue
            if action["decision"] not in {"keep", "create", "refresh", "repair", "adopt"}:
                continue
            final = project_root / str(action["path"])
            record: dict[str, Any] = {"path": action["path"], "kind": action["kind"], "role": action.get("role")}
            if action["kind"] == KIND_LINK:
                record["target"] = os.path.realpath(final) if lexists(final) else None
            else:
                record["installed_digest"] = sha256_file(final) if final.is_file() else None
            managed_paths.append(record)

        new_marker = {
            "schema_version": SCHEMA_VERSION,
            "mode": "consumer",
            "project_root": str(project_root),
            "runtime_root": str(runtime["root"]),
            "build_id": runtime["build_id"],
            "install_id": install_id,
            "resource_mode": resource_mode,
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "managed_paths": managed_paths,
        }
        write_json(marker_path(project_root), new_marker)
        marker_written = True

        for item in switched:
            if item["rollback"] is not None and lexists(item["rollback"]):
                remove_any_owned(item["rollback"])
        shutil.rmtree(files_backup, ignore_errors=True)

        receipt = {
            "schema_version": SCHEMA_VERSION,
            "status": "updated" if marker else "installed",
            "install_id": install_id,
            "build_id": runtime["build_id"],
            "package_id": runtime["package_id"],
            "project_root": str(project_root),
            "runtime_root": str(runtime["root"]),
            "resource_mode": resource_mode,
            "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "created": [a["path"] for a in plan["changed"] if a["decision"] == "create"],
            "refreshed": [a["path"] for a in plan["changed"] if a["decision"] == "refresh"],
            "repaired": [a["path"] for a in plan["changed"] if a["decision"] == "repair"],
            "adopted": [a["path"] for a in plan["actions"] if a["decision"] == "adopt"],
            "kept": [a["path"] for a in plan["actions"] if a["decision"] == "keep"],
            "skipped": [a["path"] for a in plan["actions"] if a["decision"] == "skip"],
            "snapshot": str(backups.relative_to(project_root).as_posix()),
        }
        write_json(receipt_path, receipt)
    except Exception as exc:
        rollback_failures: list[str] = []
        for item in reversed(switched):
            try:
                if lexists(item["final"]):
                    remove_any_owned(item["final"])
                if item["rollback"] is not None and lexists(item["rollback"]):
                    os.replace(item["rollback"], item["final"])
            except OSError as rollback_exc:  # pragma: no cover - 需要真实文件系统故障
                rollback_failures.append(f"{item['final']}: {rollback_exc}")
        for path in staged:
            try:
                if lexists(path):
                    remove_any_owned(path)
            except OSError as staged_exc:
                rollback_failures.append(f"{path}: {staged_exc}")
        try:
            if marker_written:
                if snapshot["previous_marker_existed"] and snapshot["previous_marker"] is not None:
                    write_json(marker_path(project_root), snapshot["previous_marker"])
                elif marker_path(project_root).is_file():
                    marker_path(project_root).unlink()
            if previous_receipt is None:
                if receipt_path.is_file():
                    receipt_path.unlink()
            else:
                write_json(receipt_path, previous_receipt)
        except OSError as restore_exc:  # pragma: no cover
            rollback_failures.append(f"marker/receipt restore: {restore_exc}")
        if rollback_failures:
            raise InstallError(
                f"install transaction failed and recovery is incomplete: {exc}; "
                + "; ".join(rollback_failures)
            ) from exc
        raise InstallError(f"install transaction rolled back to the previous state: {exc}") from exc

    return {
        "status": "updated" if marker else "installed",
        "install_id": install_id,
        "build_id": runtime["build_id"],
        "snapshot": str(backups),
        "created": [a["path"] for a in plan["changed"] if a["decision"] == "create"],
        "refreshed": [a["path"] for a in plan["changed"] if a["decision"] == "refresh"],
        "repaired": [a["path"] for a in plan["changed"] if a["decision"] == "repair"],
        "adopted": [a["path"] for a in plan["actions"] if a["decision"] == "adopt"],
        "kept": [a["path"] for a in plan["actions"] if a["decision"] == "keep"],
        "skipped": [a["path"] for a in plan["actions"] if a["decision"] == "skip"],
        "marker": str(marker_path(project_root)),
    }


def prune_snapshots(project_root: Path, keep: int = 2) -> list[str]:
    root = project_root / BACKUP_DIR_RELATIVE
    if not root.is_dir():
        return []
    removed: list[str] = []
    directories = sorted(
        (path for path in root.iterdir() if path.is_dir()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for directory in directories[keep:]:
        try:
            shutil.rmtree(directory)
        except OSError as exc:  # pragma: no cover
            removed.append(f"{directory} (skipped: {exc})")
            continue
        removed.append(str(directory))
    return removed


def restore_snapshot(project_root: Path, snapshot_dir: Path) -> dict[str, Any]:
    snapshot = toml_free_json(snapshot_dir / "snapshot.json")
    restored: list[str] = []
    for record in snapshot.get("entries") or []:
        rel = normalize_relative(record.get("path"), "snapshot.entries.path")
        path = project_root / rel
        if lexists(path):
            remove_any_owned(path)
        if record.get("existed"):
            if record.get("kind") == KIND_LINK and record.get("target"):
                create_directory_link(Path(str(record["target"])), path)
            elif record.get("kind") == "dir":
                path.mkdir(parents=True, exist_ok=True)
            elif record.get("kind") == "file" and record.get("backup_file"):
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(snapshot_dir / "files" / str(record["backup_file"]), path)
            elif record.get("kind") == "file":
                raise InstallError("snapshot has no file backup for: " + rel)
        restored.append(rel)
    previous_marker = snapshot.get("previous_marker")
    if snapshot.get("previous_marker_existed") and previous_marker is not None:
        write_json(marker_path(project_root), previous_marker)
        restored.append(MARKER_RELATIVE)
    elif marker_path(project_root).is_file():
        marker_path(project_root).unlink()
        restored.append(MARKER_RELATIVE)
    return {"status": "rolled_back", "snapshot": str(snapshot_dir), "restored": restored}


def uninstall(project_root: Path, slots: list[Path]) -> dict[str, Any]:
    marker = read_marker(project_root)
    if marker is None:
        return {"status": "noop", "removed": [], "kept": [], "detail": "no consumer marker"}
    problems = validate_marker(marker, project_root, slots)
    if problems:
        raise InstallError("marker is invalid, refusing to uninstall: " + "; ".join(problems))
    removed: list[str] = []
    kept: list[str] = []
    for record in marker.get("managed_paths") or []:
        rel = normalize_relative(record.get("path"), "marker managed_paths.path")
        path = project_root / rel
        if not lexists(path):
            continue
        if record.get("kind") == KIND_LINK:
            resolved = link_resolved(path)
            if resolved is None:
                kept.append(rel)
                continue
            if not is_inside(resolved, str(marker.get("runtime_root"))):
                kept.append(rel)
                continue
            remove_link(path)
            removed.append(rel)
        else:
            if link_target(path) is not None:
                kept.append(rel)
                continue
            if record.get("installed_digest") and sha256_file(path) == record["installed_digest"]:
                path.unlink()
                removed.append(rel)
            else:
                kept.append(rel)
    for rel in (MARKER_RELATIVE, RECEIPT_RELATIVE):
        path = project_root / rel
        if path.is_file():
            path.unlink()
            removed.append(rel)
    return {
        "status": "uninstalled",
        "build_id": marker.get("build_id"),
        "removed": removed,
        "kept": kept,
        "detail": "只移除本安装器归属的链接与文件；共享包目标保持不变",
    }


def verify_install(project_root: Path, slots: list[Path]) -> dict[str, Any]:
    marker = read_marker(project_root)
    if marker is None:
        raise InstallError(f"consumer marker is missing: {marker_path(project_root)}")
    problems = validate_marker(marker, project_root, slots)
    if problems:
        raise InstallError("marker is invalid: " + "; ".join(problems))
    runtime_root = Path(str(marker["runtime_root"]))
    missing: list[str] = []
    for record in marker.get("managed_paths") or []:
        rel = str(record.get("path"))
        path = project_root / rel
        if not lexists(path):
            missing.append(f"{rel} (missing)")
            continue
        if record.get("kind") == KIND_LINK:
            if link_target(path) is None:
                missing.append(f"{rel} (not a link)")
                continue
            if not Path(os.path.realpath(path)).exists():
                missing.append(f"{rel} (broken link)")
                continue
            if record.get("target") and not same_path(os.path.realpath(path), str(record["target"])):
                missing.append(f"{rel} (link target changed)")
        elif record.get("installed_digest"):
            if not path.is_file() or sha256_file(path) != record["installed_digest"]:
                missing.append(f"{rel} (digest mismatch)")
    if missing:
        raise InstallError("consumer install is inconsistent: " + ", ".join(missing[:10]))
    return {
        "status": "pass",
        "build_id": marker.get("build_id"),
        "runtime_root": str(runtime_root),
        "resource_mode": marker.get("resource_mode"),
        "managed_paths": len(marker.get("managed_paths") or []),
    }


def install(
    project_root: Path,
    runtime: dict[str, Any],
    *,
    resource_mode: str,
    update: bool,
    dry_run: bool,
    slots: list[Path],
    fault_hook: Any = None,
) -> dict[str, Any]:
    marker = read_marker(project_root)
    if marker is not None:
        problems = validate_marker(marker, project_root, slots)
        if problems:
            raise InstallError("existing marker is invalid (fail closed): " + "; ".join(problems))
    plan = build_plan(project_root, runtime, marker, resource_mode=resource_mode, update=update)
    status = "planned"
    if plan["update_required"]:
        status = "update_required"
    elif plan["blocking"]:
        status = "blocked"
    elif plan["noop"]:
        status = "noop"
    result: dict[str, Any] = {
        "status": status,
        "project_root": str(project_root),
        "runtime_root": str(runtime["root"]),
        "resource_mode": resource_mode,
        "build_id": runtime["build_id"],
        "marker_build_id": str(marker.get("build_id")) if marker else None,
        "conflicts": plan["conflicts"],
        "advisories": plan["advisories"],
        "changed": [action["path"] for action in plan["changed"]],
        "kept": [action["path"] for action in plan["actions"] if action["decision"] == "keep"],
        "skipped": [action["path"] for action in plan["actions"] if action["decision"] == "skip"],
        "writes": [],
    }
    if plan["update_required"]:
        result["detail"] = "marker 记录了另一个 build；需要 --update 才允许刷新归属链接"
        return result
    if plan["blocking"]:
        result["detail"] = "保留控制面路径被外部内容占用：先人工处理再安装"
        return result
    if plan["conflicts"]:
        result["detail"] = "冲突路径已列明并保留原内容；其余归属路径照常安装"
    if plan["noop"]:
        result["detail"] = "同版本重复安装：项目事实保持不变"
        return result
    if dry_run:
        result["detail"] = "dry-run：只报告计划动作，未写入任何路径"
        return result
    applied = apply_plan(
        project_root, runtime, plan, marker, resource_mode=resource_mode, fault_hook=fault_hook
    )
    result.update(applied)
    result["status"] = applied["status"]
    result["writes"] = [
        str(project_root / path)
        for path in [*applied["created"], *applied["refreshed"], *applied["repaired"]]
    ]
    result["snapshot_removed"] = prune_snapshots(project_root)
    return result


# --------------------------------------------------------------------------------------
# CLI


def self_test() -> dict[str, Any]:
    import tempfile

    checks: dict[str, bool] = {}
    with tempfile.TemporaryDirectory(prefix="consumer-install-self-test-") as raw:
        root = Path(raw)
        checks["parent_escape_is_rejected"] = False
        try:
            normalize_relative("../escape", "probe")
        except InstallError:
            checks["parent_escape_is_rejected"] = True

        project = root / "project"
        project.mkdir()
        target = root / "shared" / "policies"
        target.mkdir(parents=True)
        (target / "a.md").write_text("a", encoding="utf-8")
        link = project / "ops" / "policies"
        create_directory_link(target, link)
        checks["link_reads_target"] = (link / "a.md").read_text(encoding="utf-8") == "a"
        checks["link_target_resolves"] = same_path(link, target)
        remove_link(link)
        checks["unlink_preserves_target"] = (target / "a.md").is_file() and not lexists(link)

        foreign = project / "AGENTS.md"
        foreign.write_text("mine", encoding="utf-8")
        checks["refuses_to_remove_directories"] = False
        try:
            remove_any_owned(project)
        except InstallError:
            checks["refuses_to_remove_directories"] = True
        checks["refuses_to_unlink_non_links"] = False
        try:
            remove_link(foreign)
        except InstallError:
            checks["refuses_to_unlink_non_links"] = True

    return {"status": "ok" if all(checks.values()) else "failed", "checks": checks}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target")
    parser.add_argument("--runtime-root")
    parser.add_argument("--trusted-slot", action="append", default=[])
    parser.add_argument("--resource-mode", choices=(MODE_LINKS, MODE_PROJECTION), default=MODE_LINKS)
    parser.add_argument("--update", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--rollback")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--format", choices=("json", "text"), default="text")
    return parser.parse_args()


def emit(result: dict[str, Any], fmt: str, message: str) -> int:
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    print(payload if fmt == "json" else message)
    status = str(result.get("status"))
    if status in {"blocked", "conflict"}:
        return EXIT_CONFLICT
    if status in {"update_required"}:
        return EXIT_UPDATE_REQUIRED
    return EXIT_OK if status in {
        "installed",
        "updated",
        "noop",
        "uninstalled",
        "pass",
        "planned",
        "rolled_back",
        "ok",
    } else EXIT_ERROR


def main() -> int:
    args = parse_args()
    try:
        if args.self_test:
            result = self_test()
            return emit(result, args.format, f"consumer install self-test: {result['status']}")
        if not args.target:
            raise InstallError("--target is required")
        project_root = Path(args.target).expanduser()
        if not project_root.is_absolute():
            raise InstallError(f"--target must be an absolute path: {args.target}")
        project_root = project_root.resolve()
        slots = trusted_slots(args.trusted_slot or DEFAULT_TRUSTED_SLOTS)
        if args.rollback:
            result = restore_snapshot(project_root, Path(args.rollback).resolve())
            return emit(result, args.format, f"consumer install rolled back: {result['snapshot']}")
        if not project_root.is_dir():
            if args.verify or args.uninstall:
                raise InstallError(f"--target is not an existing directory: {project_root}")
            if not args.dry_run:
                project_root.mkdir(parents=True, exist_ok=True)
        if args.uninstall:
            result = uninstall(project_root, slots)
            return emit(result, args.format, f"consumer install {result['status']}")
        if args.verify:
            result = verify_install(project_root, slots)
            return emit(result, args.format, f"consumer install verified: build={result['build_id']}")
        if not args.runtime_root:
            raise InstallError("--runtime-root is required (verified release package root)")
        runtime = load_runtime(Path(args.runtime_root), slots)
        if is_inside(project_root, runtime["root"]) or is_inside(runtime["root"], project_root):
            raise InstallError(
                f"project and runtime package must not contain each other: {project_root} / {runtime['root']}"
            )
        result = install(
            project_root,
            runtime,
            resource_mode=args.resource_mode,
            update=args.update,
            dry_run=args.dry_run,
            slots=slots,
        )
        return emit(
            result,
            args.format,
            f"consumer install {result['status']}: build={result['build_id']} changed={len(result['changed'])}",
        )
    except (InstallError, OSError) as exc:
        print(
            json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False, indent=2)
            if args.format == "json"
            else f"consumer install failed: {exc}"
        )
        return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
