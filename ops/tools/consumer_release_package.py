#!/usr/bin/env python3
"""CR-PACKAGE-v1：正向清单校验、运行包展开与 inventory 自检。

真源清单是 ``ops/templates/consumer-release-manifest.json``：只列消费者运行所需资产。
本工具把清单展开成逐文件 inventory（target + role + sha256），staging 出可直接装配的
运行包，并在 ``--verify`` 时重算摘要、拒绝开发测试/源码泄漏。

用法：
  python -B ops/tools/consumer_release_package.py --dest <runtime 包目录>
  python -B ops/tools/consumer_release_package.py --dest <runtime 包目录> --dry-run
  python -B ops/tools/consumer_release_package.py --verify <runtime 包目录>
  python -B ops/tools/consumer_release_package.py --template-dest <模板目录>
  python -B ops/tools/consumer_release_package.py --self-test
"""

from __future__ import annotations

import argparse
import ast
import fnmatch
import hashlib
import json
import os
import posixpath
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Iterable

sys.dont_write_bytecode = True

MANIFEST_RELATIVE = Path("ops/templates/consumer-release-manifest.json")
INVENTORY_NAME = "consumer-release-manifest.json"
PACKAGE_JSON_NAME = "package.json"
GENERATOR_RELATIVE = "ops/tools/consumer_release_package.py"
REQUIRED_BUNDLES = (
    "ops/dist/agent_panel_launcher.bundle.mjs",
    "ops/dist/agent_panel_server.bundle.mjs",
    "ops/dist/agent_panel_aggregation_worker.bundle.mjs",
    "ops/dist/agent_panel_config_worker.bundle.mjs",
    "ops/dist/dispatch_prepare.bundle.mjs",
    "ops/dist/pi_fast_mode.bundle.mjs",
    "ops/dist/fleet_manifest_check.bundle.mjs",
    "ops/dist/fleet_scheduler.bundle.mjs",
    "ops/dist/review_evidence.bundle.mjs",
    "ops/dist/runtime_retention.bundle.mjs",
    "ops/dist/subagent_preload.bundle.mjs",
    "ops/dist/task_package_build.bundle.mjs",
    "ops/dist/task_package_lint.bundle.mjs",
)
# Pi 适配器按 "../../../ops/tools/<x>" 解析的运行模块闭包（deploy_pi_control.CORE_FILES）。
# 这些是运行必需模块；整棵开发 ops/tools（dispatch-core 编排器、build/deploy/sync 工具、fixtures）不得入包。
APPROVED_RUNTIME_MODULES = (
    "ops/tools/_dispatch-prepare-argv.mjs",
    "ops/tools/_fs-utils.mjs",
    "ops/tools/fleet-tools-core.mjs",
    # 全局默认角色/模型配置的来源解析：适配器与 runner 都按此模块读取同一份来源。
    "ops/tools/model_config.mjs",
    "ops/tools/subagent_runtime.mjs",
    "ops/tools/pi_child_bash_process_tree.mjs",
    "ops/tools/pi_write_domain_extension.mjs",
    "ops/tools/pause-surface.mjs",
    "ops/tools/task-outcome.mjs",
    "ops/tools/pi_transient_retry.mjs",
    "ops/tools/pi_fast_mode.mjs",
    "ops/tools/async-core",
)


class PackageError(RuntimeError):
    """清单、闭包或 inventory 违约。"""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def posix_relative(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def matches_pattern(path: str, pattern: str) -> bool:
    """target 路径匹配：``dir/**`` 前缀、``**/x`` 任意后缀、含斜杠的完整 glob、否则 basename。"""
    if pattern.endswith("/**"):
        prefix = pattern[:-3]
        return path == prefix or path.startswith(prefix + "/")
    if pattern.startswith("**/"):
        tail = pattern[3:]
        parts = path.split("/")
        return any(matches_pattern("/".join(parts[index:]), tail) for index in range(len(parts)))
    if "/" in pattern:
        return fnmatch.fnmatchcase(path, pattern)
    return fnmatch.fnmatchcase(posixpath.basename(path), pattern)


def matches_any(path: str, patterns: Iterable[str]) -> bool:
    return any(matches_pattern(path, pattern) for pattern in patterns)


def excluded_patterns(manifest: dict[str, Any]) -> list[str]:
    raw = manifest.get("excluded")
    if not isinstance(raw, list) or not raw:
        raise PackageError("manifest.excluded must be a non-empty list")
    return [str(item) for item in raw]


def normalize_manifest_path(value: Any, label: str) -> str:
    text = str(value or "").strip().replace("\\", "/")
    if not text:
        raise PackageError(f"{label} must be a non-empty relative path")
    if text.startswith("/") or (len(text) > 1 and text[1] == ":"):
        raise PackageError(f"{label} must be relative: {text}")
    normalized = posixpath.normpath(text)
    if normalized.startswith("..") or normalized == ".":
        raise PackageError(f"{label} must not escape the package root: {text}")
    return normalized


def load_manifest(source_root: Path, manifest_path: Path | None = None) -> dict[str, Any]:
    path = manifest_path or (source_root / MANIFEST_RELATIVE)
    if not path.is_file():
        raise PackageError(f"consumer release manifest is missing: {path}")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PackageError(f"invalid manifest JSON: {path}:{exc.lineno}: {exc.msg}") from exc
    if not isinstance(manifest, dict):
        raise PackageError("manifest root must be an object")
    return manifest


def validate_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("schema_version") != 1:
        raise PackageError("manifest.schema_version must be 1")
    if not str(manifest.get("package_id") or "").strip():
        raise PackageError("manifest.package_id must be non-empty")
    if not str(manifest.get("build_id") or "").strip():
        raise PackageError("manifest.build_id must be non-empty")

    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise PackageError("manifest.files must be a non-empty list")

    targets: dict[str, str] = {}
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise PackageError(f"manifest.files[{index}] must be an object")
        for key in ("source", "target", "role"):
            if not str(entry.get(key) or "").strip():
                raise PackageError(f"manifest.files[{index}].{key} must be non-empty")
        source = normalize_manifest_path(entry["source"], f"manifest.files[{index}].source")
        target = normalize_manifest_path(entry["target"], f"manifest.files[{index}].target")
        if str(entry.get("role")) not in {"consumer-tool", "bundle", "rule", "skill", "template", "agent-config", "adapter", "dependency"}:
            raise PackageError(f"manifest.files[{index}].role is not an approved role: {entry.get('role')}")
        kind = str(entry.get("kind") or "file")
        if kind not in {"file", "dir"}:
            raise PackageError(f"manifest.files[{index}].kind must be file or dir")
        if target.startswith("ops/tools/") and not approved_runtime_module(target):
            raise PackageError(
                f"manifest.files[{index}].target is outside the approved runtime closure: {target}"
            )
        if source in targets and kind == "file":
            raise PackageError(f"duplicate manifest source: {source}")
        if kind == "file":
            if target in targets:
                raise PackageError(f"duplicate manifest target: {target}")
            targets[target] = source

    entrypoints = manifest.get("entrypoints")
    if not isinstance(entrypoints, dict) or not entrypoints:
        raise PackageError("manifest.entrypoints must be a non-empty object")
    for name, value in entrypoints.items():
        normalize_manifest_path(value, f"manifest.entrypoints.{name}")

    mounts = manifest.get("resource_mounts")
    if not isinstance(mounts, list) or not mounts:
        raise PackageError("manifest.resource_mounts must be a non-empty list")
    seen_mounts: set[str] = set()
    for index, mount in enumerate(mounts):
        if not isinstance(mount, dict):
            raise PackageError(f"manifest.resource_mounts[{index}] must be an object")
        project_path = normalize_manifest_path(mount.get("project_path"), f"manifest.resource_mounts[{index}].project_path")
        normalize_manifest_path(mount.get("runtime_path"), f"manifest.resource_mounts[{index}].runtime_path")
        if project_path in seen_mounts:
            raise PackageError(f"duplicate resource mount project_path: {project_path}")
        seen_mounts.add(project_path)

    if not isinstance(manifest.get("skills"), list) or not manifest["skills"]:
        raise PackageError("manifest.skills must be a non-empty list")
    for index, template in enumerate(manifest.get("template_files") or []):
        if not isinstance(template, dict):
            raise PackageError(f"manifest.template_files[{index}] must be an object")
        normalize_manifest_path(template.get("source"), f"manifest.template_files[{index}].source")
        normalize_manifest_path(template.get("target"), f"manifest.template_files[{index}].target")
        if str(template.get("policy")) not in {"same_source", "create_if_missing"}:
            raise PackageError(f"manifest.template_files[{index}].policy is not approved: {template.get('policy')}")
    dependencies = manifest.get("dependencies")
    if not isinstance(dependencies, dict) or not {"node", "python", "native"} <= set(dependencies):
        raise PackageError("manifest.dependencies must define node, python and native")
    excluded_patterns(manifest)


def expand_entries(manifest: dict[str, Any], source_root: Path) -> list[dict[str, Any]]:
    """清单展开：文件条目与目录递归逐文件条目（保留 role）。"""
    expanded: list[dict[str, Any]] = []
    targets: dict[str, str] = {}
    for index, entry in enumerate(manifest["files"]):
        source = normalize_manifest_path(entry["source"], f"manifest.files[{index}].source")
        target = normalize_manifest_path(entry["target"], f"manifest.files[{index}].target")
        source_path = source_root / source
        if not source_path.exists():
            raise PackageError(f"manifest source is missing: {source}")
        role = str(entry["role"])
        if str(entry.get("kind") or "file") == "file":
            if not source_path.is_file():
                raise PackageError(f"manifest source is not a file: {source}")
            if target in targets:
                raise PackageError(f"duplicate manifest target: {target}")
            targets[target] = source
            expanded.append({"source": source, "target": target, "role": role})
            continue
        if not source_path.is_dir():
            raise PackageError(f"manifest source is not a directory: {source}")
        include = [str(item) for item in entry.get("include") or []]
        exclude = [str(item) for item in entry.get("exclude") or []]
        for candidate in sorted(path for path in source_path.rglob("*") if path.is_file()):
            relative = candidate.relative_to(source_path).as_posix()
            if include and not matches_any(relative, include):
                continue
            if exclude and matches_any(relative, exclude):
                continue
            item_target = normalize_manifest_path(
                posixpath.join(target, relative), f"manifest.files[{index}].target"
            )
            if item_target in targets:
                raise PackageError(f"duplicate manifest target: {item_target}")
            targets[item_target] = candidate.relative_to(source_root).as_posix()
            expanded.append(
                {
                    "source": candidate.relative_to(source_root).as_posix(),
                    "target": item_target,
                    "role": role,
                }
            )
    if not expanded:
        raise PackageError("manifest expansion produced no files")
    return expanded


def python_closure(manifest: dict[str, Any], source_root: Path) -> dict[str, Any]:
    """按实际 import 验证 Python 消费入口闭包；维护自测不打包但必须具名。"""
    closure = manifest.get("python_closure")
    if not isinstance(closure, dict):
        raise PackageError("manifest.python_closure must be an object")
    seeds = [str(item) for item in closure.get("seeds") or []]
    approved = set(seeds) | {str(item) for item in closure.get("approved_extra_modules") or []}
    maintenance = [str(item) for item in closure.get("maintenance_only_patterns") or []]
    tools_dir = source_root / "ops" / "tools"
    local_modules = {path.stem for path in tools_dir.glob("*.py")}
    visited: set[str] = set()
    queue = list(seeds)
    while queue:
        name = queue.pop()
        if name in visited:
            continue
        visited.add(name)
        path = tools_dir / name
        if not path.is_file():
            raise PackageError(f"python closure entry is missing: ops/tools/{name}")
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError as exc:
            raise PackageError(f"python closure entry is not parseable: ops/tools/{name}: {exc}") from exc
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module.split(".")[0]]
            for imported in names:
                if imported not in local_modules:
                    continue
                module = f"{imported}.py"
                if module in visited or module in queue:
                    continue
                if module in approved:
                    queue.append(module)
                    continue
                if matches_any(module, maintenance):
                    continue
                raise PackageError(
                    "python closure requires an unapproved module: "
                    f"ops/tools/{module} (imported by {name}); "
                    "更新 manifest.python_closure.approved_extra_modules 与闭包测试后才可打包"
                )
    return {
        "seeds": seeds,
        "closure": sorted(visited),
        "maintenance_only": [name for name in sorted(local_modules) if matches_any(f"{name}.py", maintenance)],
    }


def launcher_text(name: str, bundle_target: str) -> str:
    relative = posixpath.relpath(bundle_target, "ops/consumer-tools")
    return (
        "#!/usr/bin/env node\n"
        f"// 消费薄入口：{name} 转发到版本化运行包的 bundle；包内不携带开发源码。\n"
        f'await import(new URL("{relative}", import.meta.url).href);\n'
    )


def package_json_text(manifest: dict[str, Any]) -> str:
    value = {
        "name": "subagent-control-runtime",
        "version": "0.0.0",
        "private": True,
        "type": "module",
        "description": "subagent-control 消费者运行包（正向清单展开，无开发测试与源码树）",
        "pi": {
            "skills": list(manifest["skills"]),
            "extensions": [],
        },
        "dependencies": {},
    }
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def approved_runtime_module(target: str) -> bool:
    return target.startswith("ops/tools/") and any(
        target == module or target.startswith(f"{module}/") for module in APPROVED_RUNTIME_MODULES
    )


def planned_files(
    manifest: dict[str, Any], source_root: Path, *, include_launchers: bool = True
) -> dict[str, dict[str, Any]]:
    entries = expand_entries(manifest, source_root)
    excluded = excluded_patterns(manifest)
    plan: dict[str, dict[str, Any]] = {}
    for entry in entries:
        target = entry["target"]
        # 正向例外：Pi 适配器所需的运行模块闭包（不是整棵开发 ops/tools）。
        if matches_any(target, excluded) and not approved_runtime_module(target):
            raise PackageError(f"manifest entry violates the excluded patterns: {target}")
        source_path = source_root / entry["source"]
        plan[target] = {
            "target": target,
            "source": entry["source"],
            "role": entry["role"],
            "sha256": sha256_file(source_path),
            "size": source_path.stat().st_size,
        }
    if include_launchers:
        for name in manifest.get("cli_launchers") or []:
            bundle_target = normalize_manifest_path(
                manifest["entrypoints"].get(name), f"manifest.entrypoints.{name}"
            )
            if bundle_target not in plan:
                raise PackageError(f"cli launcher {name} has no packaged bundle: {bundle_target}")
            text = launcher_text(str(name), bundle_target)
            target = f"ops/consumer-tools/{name}.mjs"
            plan[target] = {
                "target": target,
                "source": None,
                "role": "launcher",
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "size": len(text.encode("utf-8")),
                "content": text,
            }
    plan[PACKAGE_JSON_NAME] = {
        "target": PACKAGE_JSON_NAME,
        "source": None,
        "role": "package-metadata",
        "sha256": hashlib.sha256(package_json_text(manifest).encode("utf-8")).hexdigest(),
        "size": len(package_json_text(manifest).encode("utf-8")),
        "content": package_json_text(manifest),
    }
    return plan


def inventory_build_id(files: dict[str, dict[str, Any]]) -> str:
    canonical = json.dumps(
        sorted((target, record["sha256"]) for target, record in files.items()),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return "scp" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def inventory_document(
    manifest: dict[str, Any], source_root: Path, files: dict[str, dict[str, Any]], *, build_id: str
) -> dict[str, Any]:
    dist_manifest = source_root / "ops" / "dist" / "subagent_service.manifest.json"
    dist_build_id = None
    if dist_manifest.is_file():
        dist_build_id = str(json.loads(dist_manifest.read_text(encoding="utf-8")).get("build_id") or "") or None
    return {
        "schema_version": 1,
        "package_id": manifest["package_id"],
        "build_id": build_id,
        "manifest_build_id": manifest["build_id"],
        "dist_build_id": dist_build_id,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source_manifest": MANIFEST_RELATIVE.as_posix(),
        "generator": GENERATOR_RELATIVE,
        "entrypoints": dict(manifest["entrypoints"]),
        "resource_mounts": [dict(mount) for mount in manifest["resource_mounts"]],
        "skills": list(manifest["skills"]),
        "template_files": [dict(item) for item in manifest.get("template_files") or []],
        "dependencies": manifest["dependencies"],
        "node_modules_roots": ["node_modules"],
        "files": [
            {
                "target": record["target"],
                "role": record["role"],
                "sha256": record["sha256"],
                "size": record["size"],
            }
            for record in sorted(files.values(), key=lambda item: item["target"])
        ],
    }


def missing_required_bundles(source_root: Path) -> list[str]:
    return [relative for relative in REQUIRED_BUNDLES if not (source_root / relative).is_file()]


def build_package(
    source_root: Path,
    dest: Path,
    *,
    manifest_path: Path | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    source_root = source_root.resolve()
    manifest = load_manifest(source_root, manifest_path)
    validate_manifest(manifest)
    closure = python_closure(manifest, source_root)
    missing = missing_required_bundles(source_root)
    if missing:
        raise PackageError(
            "runtime bundles are missing; run `node ops/tools/build_subagent_bundle.mjs` first: "
            + ", ".join(missing)
        )
    files = planned_files(manifest, source_root)
    build_id = inventory_build_id(files)
    inventory = inventory_document(manifest, source_root, files, build_id=build_id)
    result: dict[str, Any] = {
        "status": "ok",
        "mode": "dry-run" if dry_run else "apply",
        "package_id": manifest["package_id"],
        "build_id": build_id,
        "dist_build_id": inventory["dist_build_id"],
        "dest": str(dest),
        "file_count": len(files),
        "roles": sorted({record["role"] for record in files.values()}),
        "byte_count": sum(record["size"] for record in files.values()),
        "python_closure": closure,
        "writes": [],
    }
    if dry_run:
        return result

    dest = dest.resolve()
    if dest.exists():
        raise PackageError(f"destination already exists: {dest}")
    dest.mkdir(parents=True)
    try:
        for record in sorted(files.values(), key=lambda item: item["target"]):
            target_path = dest / record["target"]
            target_path.parent.mkdir(parents=True, exist_ok=True)
            if record.get("content") is not None:
                target_path.write_bytes(record["content"].encode("utf-8"))
            else:
                shutil.copy2(source_root / str(record["source"]), target_path)
        (dest / INVENTORY_NAME).write_text(
            json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        verified = verify_package(dest)
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    result["writes"] = [str(dest)]
    result["verification"] = verified
    return result


def verify_package(package_root: Path) -> dict[str, Any]:
    package_root = package_root.resolve()
    inventory_path = package_root / INVENTORY_NAME
    if not inventory_path.is_file():
        raise PackageError(f"inventory is missing: {inventory_path}")
    try:
        inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PackageError(f"invalid inventory JSON: {inventory_path}:{exc.lineno}") from exc
    if inventory.get("schema_version") != 1:
        raise PackageError("inventory.schema_version must be 1")
    records = inventory.get("files")
    if not isinstance(records, list) or not records:
        raise PackageError("inventory.files must be a non-empty list")

    declared = {str(record["target"]): record for record in records}
    if len(declared) != len(records):
        raise PackageError("inventory has duplicate targets")
    changed: list[str] = []
    for target, record in declared.items():
        path = package_root / target
        if not path.is_file():
            changed.append(f"{target} (missing)")
            continue
        if sha256_file(path) != record["sha256"]:
            changed.append(f"{target} (digest mismatch)")
    if changed:
        raise PackageError("inventory digest mismatch: " + ", ".join(sorted(changed)[:10]))

    entrypoints = inventory.get("entrypoints")
    if not isinstance(entrypoints, dict) or not entrypoints:
        raise PackageError("inventory.entrypoints must be a non-empty object")
    missing_entrypoints = [
        str(path) for path in entrypoints.values() if not (package_root / str(path)).is_file()
    ]
    if missing_entrypoints:
        raise PackageError("entrypoint is missing from the package: " + ", ".join(sorted(missing_entrypoints)))

    excluded = [
        "tests/**",
        "**/*.selftest.*",
        "**/selftest.mjs",
        "**/*_selftest.py",
        "**/*benchmark*",
        "ops/map/**",
        "src/agent-panel/tests/**",
        "src/agent-panel/docs/**",
        "src/agent-panel/tools/**",
        "src/agent-panel/src/server/**",
        "src/agent-panel/shell/bin/**",
        "src/agent-panel/shell/obj/**",
        "notes/**",
        "docs/**",
        ".runtime/**",
        "**/__pycache__/**",
        "**/*.pyc",
    ]
    available = {
        path.relative_to(package_root).as_posix()
        for path in package_root.rglob("*")
        if path.is_file() and path.name != INVENTORY_NAME
    }
    leaks = sorted(target for target in available if matches_any(target, excluded))
    unapproved_tools = sorted(
        target for target in available if target.startswith("ops/tools/") and not approved_runtime_module(target)
    )
    undeclared = sorted(available - set(declared))
    if leaks:
        raise PackageError("package leaks development assets: " + ", ".join(leaks[:10]))
    if unapproved_tools:
        raise PackageError(
            "package carries ops/tools content outside the approved runtime closure: "
            + ", ".join(unapproved_tools[:10])
        )
    if undeclared:
        raise PackageError("package contains undeclared files: " + ", ".join(undeclared[:10]))
    recomputed = inventory_build_id(
        {target: {"sha256": record["sha256"]} for target, record in declared.items()}
    )
    if recomputed != inventory.get("build_id"):
        raise PackageError(
            f"inventory build_id mismatch: declared={inventory.get('build_id')} recomputed={recomputed}"
        )
    return {
        "status": "pass",
        "package_id": inventory.get("package_id"),
        "build_id": inventory.get("build_id"),
        "file_count": len(declared),
        "entrypoints": sorted(entrypoints),
        "skills": list(inventory.get("skills") or []),
    }


def render_factory_state(root: Path, dest: Path) -> dict[str, Any]:
    """出厂空白身份：PROJECT/STATUS/ROADMAP 与台账只在缺失时生成。"""
    written: list[str] = []
    skipped: list[str] = []
    project_source = root / "ops" / "templates" / "factory-project.md"
    if not project_source.is_file():
        raise PackageError(f"factory project template is missing: {project_source}")
    project_target = dest / "PROJECT.md"
    if project_target.exists():
        skipped.append("PROJECT.md")
    else:
        project_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(project_source, project_target)
        written.append("PROJECT.md")

    delta_path = root / "ops" / "templates" / "factory-state-delta.json"
    ledger_source = root / "ops" / "templates" / "factory-ledger.toml"
    if not delta_path.is_file():
        raise PackageError(f"factory state delta is missing: {delta_path}")
    tools_dir = Path(__file__).resolve().parent
    if str(tools_dir) not in sys.path:
        sys.path.insert(0, str(tools_dir))
    try:
        import state_checkpoint  # noqa: PLC0415 - 开发侧渲染器，不随包分发
    except ImportError as exc:  # pragma: no cover - 依赖缺失时报告具名缺口
        raise PackageError(
            f"state renderer is unavailable (ops/tools/state_checkpoint.py): {exc}"
        ) from exc
    delta = state_checkpoint.validate_delta(
        json.loads(delta_path.read_text(encoding="utf-8"))
    )
    for relative, content in state_checkpoint.plan_writes(delta).items():
        target = dest / relative
        if target.exists():
            skipped.append(relative)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
        written.append(relative)
    if not ledger_source.is_file():
        raise PackageError(f"factory ledger template is missing: {ledger_source}")
    ledger_target = dest / "notes" / "ledger" / "DEBT.toml"
    if ledger_target.exists():
        skipped.append("notes/ledger/DEBT.toml")
    else:
        ledger_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ledger_source, ledger_target)
        written.append("notes/ledger/DEBT.toml")
    return {"written": written, "skipped": skipped}


def build_template(
    source_root: Path,
    dest: Path,
    *,
    manifest_path: Path | None = None,
    runtime_package: Path | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """出厂模板：通用 AGENTS 同源字节、空白身份状态、安装入口与最小 Pi 配置。

    ``runtime_package`` 给定时从已验证运行包生成（模板可从同一版本包生成）；
    否则从开发真源生成并校验清单一致。
    """
    source_root = source_root.resolve()
    if runtime_package is not None:
        root = runtime_package.resolve()
        inventory = toml_free_json(root / INVENTORY_NAME)
        templates = [dict(item) for item in inventory.get("template_files") or []]
        if not templates:
            raise PackageError(f"runtime inventory has no template_files: {root}")
        agents_reference = root / "AGENTS.md"
    else:
        root = source_root
        manifest = load_manifest(source_root, manifest_path)
        validate_manifest(manifest)
        templates = [dict(item) for item in manifest.get("template_files") or []]
        agents_reference = source_root / "AGENTS.md"
    plan: dict[str, str] = {}
    for template in templates:
        source = normalize_manifest_path(template["source"], "template_files.source")
        target = normalize_manifest_path(template["target"], "template_files.target")
        if not (root / source).is_file():
            raise PackageError(f"template source is missing: {root / source}")
        plan[target] = source
    result: dict[str, Any] = {
        "status": "ok",
        "mode": "dry-run" if dry_run else "apply",
        "dest": str(dest),
        "source": str(root),
        "files": sorted(plan),
        "writes": [],
    }
    if dry_run:
        return result
    dest = dest.resolve()
    for target, source in sorted(plan.items()):
        destination = dest / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / source, destination)
    result["writes"] = [str(dest)]
    result["factory_state"] = render_factory_state(root, dest)
    result["agents_matches_runtime_source"] = (
        (dest / "AGENTS.md").is_file()
        and agents_reference.is_file()
        and sha256_file(dest / "AGENTS.md") == sha256_file(agents_reference)
    )
    if not result["agents_matches_runtime_source"]:
        raise PackageError("template AGENTS.md is not the same source as the runtime AGENTS.md")
    return result


def record_current_release(slot: Path, release: Path, build_id: str) -> None:
    update_current_link(slot, release)
    pointer = slot / "current.json"
    temporary = slot / f".current-{os.getpid()}.tmp"
    try:
        temporary.write_text(json.dumps({"schema_version": 1, "runtime_root": str(release),
                                         "build_id": build_id}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, pointer)
    finally:
        temporary.unlink(missing_ok=True)


# 全局入口：<slot>/current 目录链接恒指向最新发布，用户级技能入口经它跟随发布，不随 build 改写。
def update_current_link(slot: Path, release: Path) -> None:
    link = slot / "current"
    if link.exists() and not (link.is_junction() or link.is_symlink()):
        raise PackageError(f"release slot current is a real directory, not a link: {link}")
    temporary = slot / f".current-link-{os.getpid()}.tmp"
    os.symlink(release, temporary, target_is_directory=True)
    try:
        if link.is_junction():
            os.rmdir(link)
        elif link.is_symlink():
            link.unlink()
        os.rename(temporary, link)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def _link_target(entry: Path) -> str:
    return os.path.normcase(os.readlink(entry).removeprefix("\\\\?\\"))


# 用户级技能入口：<user_skills>/<name> 链到 <slot>/current/ops/skills/<name>。仓主自有的真实目录同名时跳过，
# 指向 current 但已不在发布物里的链接删除；其余条目不碰。
def sync_user_skill_links(slot: Path, user_skills: Path) -> dict[str, Any]:
    skills_root = slot / "current" / "ops" / "skills"
    names = sorted(p.name for p in skills_root.iterdir() if (p / "SKILL.md").is_file())
    user_skills.mkdir(parents=True, exist_ok=True)
    prefix = os.path.normcase(str(skills_root))
    linked: list[str] = []
    skipped: list[str] = []
    removed: list[str] = []
    for name in names:
        entry = user_skills / name
        if entry.is_symlink() or entry.is_junction():
            if _link_target(entry) == os.path.join(prefix, os.path.normcase(name)):
                continue
            (os.rmdir if entry.is_junction() else os.unlink)(entry)
        elif entry.exists():
            skipped.append(name)
            continue
        os.symlink(skills_root / name, entry, target_is_directory=True)
        linked.append(name)
    expected_names = {os.path.normcase(name) for name in names}
    for entry in sorted(user_skills.iterdir()):
        if (entry.is_symlink() or entry.is_junction()) and os.path.normcase(entry.name) not in expected_names \
                and os.path.dirname(_link_target(entry)) == prefix:
            (os.rmdir if entry.is_junction() else os.unlink)(entry)
            removed.append(entry.name)
    return {"skills": names, "linked": linked, "skipped_owned": skipped, "removed": removed}


def publish_package(
    source_root: Path,
    slot: Path,
    *,
    manifest_path: Path | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """版本化发布：staging 构建 → 按 build_id 原子落位；已存在同 build 只校验不覆盖。"""
    slot = slot.expanduser()
    if not slot.is_absolute():
        raise PackageError(f"release slot must be an absolute path: {slot}")
    slot = slot.resolve()
    staging = slot / f".staging-{os.getpid()}"
    result: dict[str, Any] = {
        "status": "ok",
        "slot": str(slot),
        "dry_run": bool(dry_run),
    }
    if dry_run:
        planned = build_package(source_root, staging, manifest_path=manifest_path, dry_run=True)
        result.update(
            {
                "mode": "dry-run",
                "build_id": planned["build_id"],
                "release": str(slot / planned["build_id"]),
                "file_count": planned["file_count"],
            }
        )
        return result
    slot.mkdir(parents=True, exist_ok=True)
    if staging.exists():
        shutil.rmtree(staging)
    try:
        built = build_package(source_root, staging, manifest_path=manifest_path)
        release = slot / built["build_id"]
        if release.exists():
            existing = verify_package(release)
            if existing["build_id"] != built["build_id"]:
                raise PackageError(f"release slot already holds another build: {release}")
            result.update(
                {
                    "mode": "already-present",
                    "build_id": built["build_id"],
                    "release": str(release),
                    "file_count": existing["file_count"],
                }
            )
            record_current_release(slot, release, built["build_id"])
            return result
        os.replace(staging, release)
        result.update(
            {
                "mode": "published",
                "build_id": built["build_id"],
                "release": str(release),
                "file_count": built["file_count"],
                "verification": built["verification"],
            }
        )
        record_current_release(slot, release, built["build_id"])
        return result
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def self_test() -> dict[str, Any]:
    import tempfile
    from unittest.mock import patch

    checks: dict[str, bool] = {}
    with tempfile.TemporaryDirectory(prefix="consumer-release-package-self-test-") as raw:
        root = Path(raw)
        (root / "ops" / "templates").mkdir(parents=True)
        (root / "ops" / "tools").mkdir(parents=True)
        (root / "ops" / "tools" / "_tool_common.py").write_text("", encoding="utf-8")
        (root / "ops" / "tools" / "__init__.py").write_text("", encoding="utf-8")
        (root / "ops" / "tools" / "state_checkpoint.py").write_text(
            "import _tool_common\n", encoding="utf-8"
        )
        (root / "ops" / "tools" / "state_checkpoint_selftest.py").write_text(
            "import state_checkpoint\n", encoding="utf-8"
        )
        (root / "ops" / "tools" / "alignment_guard.py").write_text("", encoding="utf-8")
        (root / "ops" / "tools" / "alignment_guard_selftest.py").write_text("", encoding="utf-8")
        (root / "ops" / "rules").mkdir()
        (root / "ops" / "rules" / "policy.md").write_text("rule", encoding="utf-8")
        (root / "ops" / "rules" / "dev.selftest.mjs").write_text("selftest", encoding="utf-8")
        real_templates = Path(__file__).resolve().parents[1] / "templates"
        for name in ("factory-project.md", "factory-state-delta.json", "factory-ledger.toml"):
            shutil.copy2(real_templates / name, root / "ops" / "templates" / name)
        (root / "AGENTS.md").write_text("agents", encoding="utf-8")
        (root / "ops" / "templates" / "consumer-template" / ".pi").mkdir(parents=True)
        (root / "ops" / "templates" / "consumer-template" / ".gitignore").write_text(
            "ignore\n", encoding="utf-8"
        )
        (root / "ops" / "templates" / "consumer-template" / ".pi" / "settings.json").write_text(
            "{\n  \"packages\": [\".pi/control-plane-runtime\"]\n}\n", encoding="utf-8"
        )
        manifest = {
            "schema_version": 1,
            "package_id": "demo",
            "build_id": "demo/v1",
            "files": [
                {"source": "ops/tools/_tool_common.py", "target": "ops/consumer-tools/_tool_common.py", "role": "consumer-tool"},
                {"source": "ops/tools/alignment_guard.py", "target": "ops/consumer-tools/alignment_guard.py", "role": "consumer-tool"},
                {"source": "ops/tools/state_checkpoint.py", "target": "ops/consumer-tools/state_checkpoint.py", "role": "consumer-tool"},
                {"source": "ops/rules", "target": "ops/rules", "role": "rule", "kind": "dir", "exclude": ["*.selftest.*"]},
            ],
            "entrypoints": {"state_checkpoint": "ops/consumer-tools/state_checkpoint.py"},
            "cli_launchers": [],
            "resource_mounts": [{"project_path": "ops/rules", "runtime_path": "ops/rules", "kind": "dir"}],
            "skills": ["ops/rules"],
            "template_files": [
                {"source": "AGENTS.md", "target": "AGENTS.md", "policy": "same_source"},
                {
                    "source": "ops/templates/consumer-template/.gitignore",
                    "target": ".gitignore",
                    "policy": "create_if_missing",
                },
            ],
            "python_closure": {
                "seeds": ["_tool_common.py", "alignment_guard.py", "state_checkpoint.py"],
                "approved_extra_modules": [],
                "maintenance_only_patterns": ["*_selftest.py"],
            },
            "dependencies": {"node": {}, "python": {}, "native": {}},
            "excluded": ["tests/**", "**/*.selftest.*", "**/*_selftest.py", "ops/tools/**"],
        }
        manifest_path = root / "ops" / "templates" / "consumer-release-manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        closure = python_closure(manifest, root)
        checks["closure_excludes_maintenance_selftests"] = closure["closure"] == [
            "_tool_common.py",
            "alignment_guard.py",
            "state_checkpoint.py",
        ]
        plan = planned_files(manifest, root)
        checks["directory_expansion_skips_excluded_files"] = "ops/rules/dev.selftest.mjs" not in plan
        checks["launchers_and_metadata_are_planned"] = PACKAGE_JSON_NAME in plan

        unapproved = json.loads(json.dumps(manifest))
        unapproved["python_closure"]["seeds"] = ["state_checkpoint.py"]
        try:
            python_closure(unapproved, root)
        except PackageError:
            checks["unapproved_closure_import_is_rejected"] = True
        else:
            checks["unapproved_closure_import_is_rejected"] = False

        broken = json.loads(json.dumps(manifest))
        broken["files"].append({"source": "ops/rules", "target": "ops/rules", "role": "rule", "kind": "dir"})
        try:
            expand_entries(broken, root)
        except PackageError:
            checks["duplicate_targets_are_rejected"] = True
        else:
            checks["duplicate_targets_are_rejected"] = False

        escaping = json.loads(json.dumps(manifest))
        escaping["files"][0]["target"] = "../escape.txt"
        try:
            validate_manifest(escaping)
        except PackageError:
            checks["parent_escape_is_rejected"] = True
        else:
            checks["parent_escape_is_rejected"] = False

        template_dest = root / "template-out"
        template = build_template(root, template_dest, manifest_path=manifest_path)
        checks["template_is_agents_same_source"] = template["agents_matches_runtime_source"]
        checks["template_renders_blank_identity"] = (
            (template_dest / "PROJECT.md").is_file()
            and (template_dest / "STATUS.md").is_file()
            and (template_dest / "notes" / "ledger" / "DEBT.toml").is_file()
            and (template_dest / ".gitignore").is_file()
        )

        slot = root / "slot"
        for build in ("b1", "b2"):
            (slot / build / "ops" / "skills" / "alpha").mkdir(parents=True)
            (slot / build / "ops" / "skills" / "alpha" / "SKILL.md").write_text("a", encoding="utf-8")
        (slot / "b1" / "ops" / "skills" / "gone").mkdir()
        (slot / "b1" / "ops" / "skills" / "gone" / "SKILL.md").write_text("g", encoding="utf-8")
        user = root / "user-skills"
        (user / "own").mkdir(parents=True)
        (user / "own" / "SKILL.md").write_text("own", encoding="utf-8")
        update_current_link(slot, slot / "b1")
        first = sync_user_skill_links(slot, user)
        update_current_link(slot, slot / "b2")
        second = sync_user_skill_links(slot, user)
        checks["current_link_follows_latest_release"] = (
            os.path.realpath(slot / "current") == os.path.realpath(slot / "b2"))
        checks["user_skill_links_follow_current"] = (
            first["linked"] == ["alpha", "gone"] and second["linked"] == [] and second["removed"] == ["gone"]
            and (user / "alpha" / "SKILL.md").read_text(encoding="utf-8") == "a" and not (user / "gone").exists()
        )
        checks["owned_user_skills_are_untouched"] = (user / "own" / "SKILL.md").read_text(encoding="utf-8") == "own"

        record_current_release(slot, slot / "b2", "b2")
        pointer_before = (slot / "current.json").read_bytes()
        link_before = os.readlink(slot / "current")
        with patch.object(os, "symlink", side_effect=OSError("injected symlink failure")):
            try:
                record_current_release(slot, slot / "b1", "b1")
            except OSError:
                checks["symlink_failure_preserves_current_and_json"] = (
                    os.readlink(slot / "current") == link_before
                    and (slot / "current.json").read_bytes() == pointer_before
                    and (user / "alpha" / "SKILL.md").read_text(encoding="utf-8") == "a"
                )
            else:
                checks["symlink_failure_preserves_current_and_json"] = False

        skills = slot / "b2" / "ops" / "skills"
        (skills / "alpha").rename(skills / "ALPHA")
        sync_user_skill_links(slot, user)
        checks["case_renamed_skill_link_remains_readable"] = (
            (user / "ALPHA").is_symlink()
            and (user / "ALPHA" / "SKILL.md").read_text(encoding="utf-8") == "a"
        )

    return {"status": "ok" if all(checks.values()) else "failed", "checks": checks}


def toml_free_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise PackageError(f"required JSON file is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise PackageError(f"invalid JSON: {path}:{exc.lineno}: {exc.msg}") from exc
    if not isinstance(value, dict):
        raise PackageError(f"JSON root must be an object: {path}")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", default=".")
    parser.add_argument("--dest")
    parser.add_argument("--publish-slot")
    parser.add_argument("--template-dest")
    parser.add_argument("--template-from-runtime")
    parser.add_argument("--verify")
    parser.add_argument("--manifest")
    parser.add_argument("--user-skills", help="发布后把控制面技能链接同步到此用户级技能目录")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--format", choices=("json", "text"), default="text")
    return parser.parse_args()


def emit(result: dict[str, Any], fmt: str, message: str) -> int:
    if fmt == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(message)
    return 0 if result.get("status") in {"ok", "pass"} else 1


def main() -> int:
    args = parse_args()
    try:
        if args.self_test:
            result = self_test()
            return emit(result, args.format, f"consumer release package self-test: {result['status']}")
        source_root = Path(args.source_root).expanduser().resolve()
        manifest_path = Path(args.manifest).resolve() if args.manifest else None
        if args.verify:
            result = verify_package(Path(args.verify))
            return emit(result, args.format, f"runtime package verified: {result['build_id']}")
        if args.template_dest:
            result = build_template(
                source_root,
                Path(args.template_dest),
                manifest_path=manifest_path,
                runtime_package=Path(args.template_from_runtime) if args.template_from_runtime else None,
                dry_run=args.dry_run,
            )
            return emit(result, args.format, f"template built: {result['dest']}")
        if args.publish_slot:
            result = publish_package(
                source_root,
                Path(args.publish_slot),
                manifest_path=manifest_path,
                dry_run=args.dry_run,
            )
            if args.user_skills and not args.dry_run:
                result["user_skill_links"] = sync_user_skill_links(
                    Path(args.publish_slot).expanduser().resolve(), Path(args.user_skills))
            return emit(
                result,
                args.format,
                f"runtime package {result['mode']}: {result['release']}",
            )
        if not args.dest:
            raise PackageError(
                "provide --dest, --publish-slot, --template-dest, --verify or --self-test"
            )
        result = build_package(
            source_root,
            Path(args.dest),
            manifest_path=manifest_path,
            dry_run=args.dry_run,
        )
        return emit(
            result,
            args.format,
            f"runtime package {'planned' if args.dry_run else 'built'}: {result['build_id']} "
            f"files={result['file_count']}",
        )
    except (PackageError, OSError) as exc:
        print(
            json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False, indent=2)
            if args.format == "json"
            else f"consumer release package failed: {exc}"
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
