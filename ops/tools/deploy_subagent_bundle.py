#!/usr/bin/env python3
"""Publish one immutable Async Subagent MCP release and atomically switch global config."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import tomllib
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from _tool_common import ROOT, ToolError, atomic_write_bytes, emit

sys.dont_write_bytecode = True

OPS_DIR = ROOT / "ops"
DIST_DIR = OPS_DIR / "dist"
MANIFEST_PATH = DIST_DIR / "subagent_service.manifest.json"
# ~/.codex 是 codex CLI 自管的家目录，只承载它自己的注册面（config.toml）；
# 发布产物、producer 注册与任务定位索引都住中性的 ~/.subagent-control/。
GLOBAL_CODEX = Path.home() / ".codex"
GLOBAL_CONFIG = GLOBAL_CODEX / "config.toml"
CLAUDE_JSON = Path.home() / ".claude.json"
SUBAGENT_CONTROL_HOME = Path.home() / ".subagent-control"
PRODUCER_REGISTRY = SUBAGENT_CONTROL_HOME / "bridge-producer.json"
REGISTRY_ROOT = SUBAGENT_CONTROL_HOME / "async_task_registry"
RELEASES_ROOT = SUBAGENT_CONTROL_HOME / "releases" / "subagent"
PANEL_RUNTIME_POINTER = SUBAGENT_CONTROL_HOME / "agent-panel" / "runtime-root.json"
DEPLOY_LOCK_PATH = RELEASES_ROOT.parent / "subagent.deploy.lock"
SECTION = "mcp_servers.asyncSubagent"
LOCK_STALE_SECONDS = 900
PRUNE_GRACE_HOURS = 24
TERMINAL_TASK_STATES = {"done", "failed", "cancelled"}
RUNTIME_TEMPLATE_NAMES = (
    "handoff-prompt-template.md",
    "review-evidence-prompt-template.md",
    "worker-system-prompt.md",
    "worker-resources.json",
)
# 全局默认角色/模型配置：发布槽自带一份，runner 缺它就会退回目标项目内旧 ops 副本。
RUNTIME_CONFIG_FILES = ("ops/model-notes.toml",)
RUNTIME_CONFIG_DIRS = ("ops/agents",)
BOOTSTRAP_STEPS = (
    "node ops/tools/build_subagent_bundle.mjs",
    "python -B ops/tools/deploy_subagent_bundle.py --apply",
)


def bootstrap_guidance() -> str:
    """Return the one canonical build-to-verification recovery sequence."""
    return "Async MCP bootstrap (build -> transactional apply with one handshake):\n" + "\n".join(
        f"{index}. {command}" for index, command in enumerate(BOOTSTRAP_STEPS, start=1)
    )


def bootstrap_error(message: str) -> ToolError:
    return ToolError(f"{message}\n\n{bootstrap_guidance()}")


def require_deployed_candidate(release: Path) -> None:
    if not release.exists():
        raise bootstrap_error(
            "release is not deployed; publish the candidate before activation"
        )


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        # Windows 的 os.kill(pid, 0) 会直接 TerminateProcess，只能走 OpenProcess 探活。
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED：进程存在但无权限
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return True
            return exit_code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_lock_record(lock_path: Path) -> dict[str, Any]:
    try:
        record = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return record if isinstance(record, dict) else {}


def lock_is_stale(lock_path: Path, record: dict[str, Any]) -> bool:
    try:
        age = time.time() - lock_path.stat().st_mtime
    except OSError:
        return False
    if age < LOCK_STALE_SECONDS:
        return False
    host = str(record.get("host") or "")
    if host and host != socket.gethostname():
        return False  # 跨主机无法核实 pid，不自动回收
    pid = record.get("pid")
    if isinstance(pid, int) and pid_alive(pid):
        return False
    return True


@contextmanager
def deployment_lock(lock_path: Path = DEPLOY_LOCK_PATH, wait_seconds: float = 0.0) -> Iterator[None]:
    """用户级部署锁：O_CREAT|O_EXCL 原子创建，覆盖读 config、候选验证、切换、复验与 prune 全事务。

    拿不到锁默认报错并显示持锁方；wait_seconds>0 时轮询等待。锁文件超时（LOCK_STALE_SECONDS）
    且持锁 pid 不存活视为陈旧锁回收：回收先原子改名到墓碑文件再删除——多个竞争者同判陈旧时
    只有 rename 赢家执行回收，避免误删他人刚建立的新锁；释放前回读锁记录核对本进程身份，
    不符不删。回收动作打印到 stderr。"""
    deadline = time.monotonic() + max(wait_seconds, 0.0)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    token = f"{os.getpid()}-{os.urandom(8).hex()}"
    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if not lock_path.exists():
                continue  # 持锁方刚释放，立即重试
            record = read_lock_record(lock_path)
            if lock_is_stale(lock_path, record):
                tombstone = lock_path.with_name(f"{lock_path.name}.stale.{os.getpid()}.{os.urandom(4).hex()}")
                try:
                    os.replace(lock_path, tombstone)
                except OSError:
                    continue  # 另一竞争者赢得回收(或持锁方刚释放),重试获取
                tombstone.unlink(missing_ok=True)
                print(
                    f"reclaimed stale deployment lock: {lock_path} "
                    f"(holder pid={record.get('pid')} host={record.get('host')} "
                    f"acquired_at={record.get('acquired_at')})",
                    file=sys.stderr,
                )
                continue
            if time.monotonic() < deadline:
                time.sleep(1.0)
                continue
            raise ToolError(
                "another deployment holds the lock "
                f"(pid={record.get('pid')} host={record.get('host')} acquired_at={record.get('acquired_at')}); "
                f"retry later, use --wait-lock <seconds>, or remove {lock_path} if the holder is gone"
            )
        try:
            record = {
                "pid": os.getpid(),
                "host": socket.gethostname(),
                "token": token,
                "acquired_at": datetime.now(timezone.utc).isoformat(),
            }
            os.write(fd, json.dumps(record).encode("utf-8"))
        finally:
            os.close(fd)
        break
    try:
        yield
    finally:
        current = read_lock_record(lock_path)
        if not lock_path.exists() or current.get("token") == token:
            lock_path.unlink(missing_ok=True)
        else:
            print(
                f"deployment lock at {lock_path} no longer owned by this process (token mismatch); not removing",
                file=sys.stderr,
            )


def release_for_path(path: Path, releases_root: Path = RELEASES_ROOT) -> Path | None:
    """Map a file path inside a release dir back to that release dir, else None."""
    root = releases_root.resolve()
    try:
        relative = path.resolve().relative_to(root)
    except (OSError, ValueError):
        return None
    if not relative.parts:
        return None
    return root / relative.parts[0]


def config_target_release(
    config_path: Path = GLOBAL_CONFIG,
    releases_root: Path = RELEASES_ROOT,
) -> Path | None:
    """Resolve the release dir the global config currently points at, else None."""
    try:
        with config_path.open("rb") as handle:
            parsed = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError):
        return None
    server = parsed.get("mcp_servers", {}).get("asyncSubagent", {})
    args = server.get("args") if isinstance(server, dict) else None
    first = str(args[0]) if isinstance(args, list) and args else ""
    if not first:
        return None
    return release_for_path(Path(first), releases_root)


def active_task_releases(
    registry_root: Path = REGISTRY_ROOT,
    releases_root: Path = RELEASES_ROOT,
) -> set[Path]:
    """Collect release dirs still referenced by non-terminal async task runners.

    读全局任务注册表（task_id → task_root），对每个非终态任务把 task.json 的
    runner_path 所在 release 加入集合；status 读不到按非终态处理（保守保留）。"""
    releases: set[Path] = set()
    if not registry_root.is_dir():
        return releases
    for record_path in registry_root.glob("*.json"):
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            print(
                f"prune warning: unreadable registry record {record_path.name}; its runner release (if any) is not protected",
                file=sys.stderr,
            )
            continue
        if not isinstance(record, dict):
            continue
        task_id = str(record.get("task_id") or "")
        task_root = str(record.get("task_root") or "")
        if not task_id or not task_root:
            continue
        task_dir = Path(task_root) / task_id
        try:
            status = json.loads((task_dir / "status.json").read_text(encoding="utf-8"))
            state = str(status.get("state") or "")
        except (OSError, json.JSONDecodeError):
            state = ""
        if state in TERMINAL_TASK_STATES:
            continue
        try:
            task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            print(
                f"prune warning: unreadable task.json for non-terminal task {task_id}; its runner release is not protected",
                file=sys.stderr,
            )
            continue
        runner = str(task.get("runner_path") or "") if isinstance(task, dict) else ""
        if not runner:
            continue
        release = release_for_path(Path(runner), releases_root)
        if release is not None:
            releases.add(release)
    return releases


def read_manifest() -> dict[str, Any]:
    try:
        data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        raise bootstrap_error("async MCP build manifest is missing or invalid") from exc
    if not isinstance(data, dict) or not data.get("build_id"):
        raise ToolError("async MCP build manifest is invalid")
    return data


def verify_dist(manifest: dict[str, Any]) -> dict[str, Path]:
    """Require every declared runtime artifact; execution probes validate behavior later."""
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict) or not artifacts:
        raise ToolError("dist artifact manifest declares no artifacts")
    files: dict[str, Path] = {}
    for key, item in artifacts.items():
        path = DIST_DIR / str((item or {}).get("file") or "")
        if not path.is_file():
            raise ToolError(f"dist artifact is missing: {key}")
        files[key] = path
    return files


def compiler_files(manifest: dict[str, Any]) -> list[Path]:
    from deploy_pi_control import compiler_resource_files
    return sorted(set(compiler_resource_files(ROOT)) | {
        Path("ops/dist") / item["file"] for item in manifest["artifacts"].values()
    })


def publish_release(manifest: dict[str, Any], artifacts: dict[str, Path]) -> Path:
    build_id = str(manifest["build_id"])
    release = RELEASES_ROOT / build_id
    expected = [
        release / "ops" / "tools" / "subagent_handoff_check.bundle.mjs",
        release / "ops" / "tools" / "subagent_service.mjs",
        release / "ops" / "tools" / "run-pi-task.mjs",
        # run-pi-task.mjs 按“同目录同名”解析该扩展,货架文件名必须与 HUB 源文件一致。
        release / "ops" / "tools" / "pi_review_result_extension.mjs",
        release / "ops" / "tools" / "pi_task_result_extension.mjs",
        release / "ops" / "tools" / "pi_write_domain_extension.mjs",
        release / "ops" / "tools" / "pi_worker_tools_extension.mjs",
        release / "ops" / "tools" / "pi_search_extension.mjs",
        release / "ops" / "tools" / "pi_transient_retry.mjs",
        *(release / "ops" / "templates" / name for name in RUNTIME_TEMPLATE_NAMES),
        *(release / name for name in RUNTIME_CONFIG_FILES),
        *(release / name for name in compiler_files(manifest)),
    ]
    if release.exists():
        if all(path.is_file() for path in expected) and all(
            (release / name).is_dir() for name in RUNTIME_CONFIG_DIRS
        ):
            return release
        raise ToolError(f"existing release is incomplete: {release}")

    RELEASES_ROOT.mkdir(parents=True, exist_ok=True)
    staging = RELEASES_ROOT / f".{build_id}.{os.getpid()}.tmp"
    if staging.exists():
        shutil.rmtree(staging)
    try:
        # 发布槽按运行根契约铺 ops/tools 与 ops/templates：runner 与服务端都按入口上两级找 ops/ 资产。
        (staging / "ops" / "tools").mkdir(parents=True)
        (staging / "ops" / "templates").mkdir(parents=True)
        shutil.copy2(artifacts["server_bundle"], staging / "ops" / "tools" / "subagent_service.mjs")
        shutil.copy2(artifacts["pi_runner_bundle"], staging / "ops" / "tools" / "run-pi-task.mjs")
        shutil.copy2(artifacts["command_jobs_bundle"], staging / "ops" / "tools" / "pi_child_command_jobs.mjs")
        shutil.copy2(artifacts["review_result_extension_bundle"], staging / "ops" / "tools" / "pi_review_result_extension.mjs")
        shutil.copy2(artifacts["task_result_extension_bundle"], staging / "ops" / "tools" / "pi_task_result_extension.mjs")
        shutil.copy2(artifacts["write_domain_extension_bundle"], staging / "ops" / "tools" / "pi_write_domain_extension.mjs")
        shutil.copy2(artifacts["worker_tools_extension_bundle"], staging / "ops" / "tools" / "pi_worker_tools_extension.mjs")
        shutil.copy2(artifacts["search_extension_bundle"], staging / "ops" / "tools" / "pi_search_extension.mjs")
        shutil.copy2(artifacts["transient_retry_extension_bundle"], staging / "ops" / "tools" / "pi_transient_retry.mjs")
        shutil.copy2(artifacts["handoff_check_bundle"], staging / "ops" / "tools" / "subagent_handoff_check.bundle.mjs")
        for name in RUNTIME_TEMPLATE_NAMES:
            shutil.copy2(OPS_DIR / "templates" / name, staging / "ops" / "templates" / name)
        # 全局默认角色/模型配置：与 ops/tools、ops/templates 同级落地，成为父子两端的缺省来源。
        for name in RUNTIME_CONFIG_FILES:
            shutil.copy2(ROOT / name, staging / name)
        for name in RUNTIME_CONFIG_DIRS:
            shutil.copytree(ROOT / name, staging / name, dirs_exist_ok=True)
        for relative in compiler_files(manifest):
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, target)
        shutil.copy2(MANIFEST_PATH, staging / MANIFEST_PATH.name)
        shutil.copy2(artifacts["licenses"], staging / artifacts["licenses"].name)
        shutil.copy2(artifacts["third_party_licenses"], staging / artifacts["third_party_licenses"].name)
        shutil.copy2(OPS_DIR / "THIRD_PARTY_NOTICES.md", staging / "THIRD_PARTY_NOTICES.md")
        os.replace(staging, release)
    except OSError:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return release


def parse_built_at(text: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def prune_releases(
    current_release: Path,
    keep_recent: int = 3,
    releases_root: Path = RELEASES_ROOT,
    config_release: Path | None = None,
    referenced_releases: Iterable[Path] = (),
    grace_hours: float = PRUNE_GRACE_HOURS,
    now: datetime | None = None,
) -> dict[str, list[str]]:
    """Remove release build dirs that carry no live reference. The keep set is the union of:
    current_release, the release the global config points at (config_release), releases
    referenced by non-terminal async tasks (referenced_releases), the keep_recent most
    recent by built_at, and releases built within grace_hours. Never removes the current
    or config target."""
    if not releases_root.is_dir():
        return {"removed": [], "kept": []}
    builds = [d for d in releases_root.iterdir() if d.is_dir() and not d.name.startswith(".")]

    def built_at(build_dir: Path) -> str:
        try:
            data = json.loads((build_dir / MANIFEST_PATH.name).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return ""
        return str(data.get("built_at") or "")

    moment = now or datetime.now(timezone.utc)
    keep: set[Path] = {current_release.resolve()}
    if config_release is not None:
        keep.add(config_release.resolve())
    for referenced in referenced_releases:
        keep.add(referenced.resolve())
    ordered = sorted(builds, key=lambda d: (built_at(d), d.name), reverse=True)
    for build_dir in ordered[:keep_recent]:
        keep.add(build_dir.resolve())
    for build_dir in builds:
        built = parse_built_at(built_at(build_dir))
        if built is not None and moment - built < timedelta(hours=grace_hours):
            keep.add(build_dir.resolve())
    removed: list[str] = []
    kept: list[str] = []
    skipped: list[str] = []
    for build_dir in builds:
        if build_dir.resolve() in keep:
            kept.append(build_dir.name)
            continue
        try:
            shutil.rmtree(build_dir)
            removed.append(build_dir.name)
        except OSError:
            # 旧 release 被运行中的 MCP 进程占用（Windows 文件锁）时跳过并上报，
            # 清理失败不阻断发布；当前指向的 release 永不进入删除集。
            skipped.append(build_dir.name)
    return {"removed": sorted(removed), "kept": sorted(kept), "skipped": sorted(skipped)}


def replace_setting(body: str, key: str, value: str) -> str:
    pattern = re.compile(rf"(?m)^\s*{re.escape(key)}\s*=.*$")
    line = f"{key} = {value}"
    if pattern.search(body):
        return pattern.sub(lambda _match: line, body, count=1)
    return body.rstrip() + "\n" + line + "\n"


def literal(path: Path) -> str:
    text = str(path)
    if "'" in text:
        raise ToolError("deployment path contains an unsupported TOML literal quote")
    return f"'{text}'"


def normalized_path(path: Path) -> str:
    return os.path.normcase(str(path.expanduser().resolve()))


def read_producer_registration(
    registry_path: Path = PRODUCER_REGISTRY,
    producer_root: Path = ROOT,
) -> tuple[dict[str, Any], bytes] | None:
    if not registry_path.exists():
        print(
            f"bridge producer registration missing: {registry_path}; "
            "continuing first deployment, but registration is recommended",
            file=sys.stderr,
        )
        return None
    try:
        body = registry_path.read_bytes()
        data = json.loads(body.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ToolError(f"bridge producer registration is unreadable: {registry_path}") from exc
    if not isinstance(data, dict) or not data.get("producer_root"):
        raise ToolError(f"bridge producer registration has no producer_root: {registry_path}")
    registered = Path(str(data["producer_root"]))
    if normalized_path(registered) != normalized_path(producer_root):
        raise ToolError(
            f"bridge producer is registered to {registered}; current repository is {producer_root}; "
            "refusing --apply"
        )
    return data, body


def update_expected_build(
    registry_path: Path,
    build_id: str,
    expected_body: bytes,
) -> None:
    original = registry_path.read_bytes()
    if original != expected_body:
        raise ToolError("bridge producer registration changed concurrently; retry deployment")
    try:
        data = json.loads(original.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ToolError(f"bridge producer registration is unreadable: {registry_path}") from exc
    if not isinstance(data, dict):
        raise ToolError(f"bridge producer registration is invalid: {registry_path}")
    data["expected_build"] = build_id
    updated = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if registry_path.read_bytes() != expected_body:
        raise ToolError("bridge producer registration changed concurrently during deployment; retry deployment")
    atomic_write_bytes(registry_path, updated)


def switch_config(release: Path, expected_text: str | None = None) -> None:
    text = GLOBAL_CONFIG.read_text(encoding="utf-8")
    if expected_text is not None and text != expected_text:
        raise ToolError(
            "global config changed concurrently since the deployment lock was taken; retry deployment"
        )
    header = f"[{SECTION}]"
    start = text.find(header)
    if start < 0:
        raise ToolError(f"global config missing [{SECTION}]")
    body_start = start + len(header)
    next_header = re.search(r"(?m)^\[", text[body_start:])
    body_end = body_start + next_header.start() if next_header else len(text)
    body = text[body_start:body_end]
    server = release / "ops" / "tools" / "subagent_service.mjs"
    body = replace_setting(body, "args", f"[{literal(server)}, 'mcp']")
    body = replace_setting(body, "cwd", literal(release))
    body = replace_setting(body, "default_tools_approval_mode", '"approve"')
    updated = text[:body_start] + body + text[body_end:]
    temp = GLOBAL_CONFIG.with_name(f"{GLOBAL_CONFIG.name}.{os.getpid()}.tmp")
    temp.write_text(updated, encoding="utf-8")
    with temp.open("rb") as handle:
        parsed = tomllib.load(handle)
    server_config = parsed.get("mcp_servers", {}).get("asyncSubagent", {})
    if server_config.get("default_tools_approval_mode") != "approve":
        temp.unlink(missing_ok=True)
        raise ToolError("global config would not auto-approve Async Subagent MCP tools")
    # compare-and-swap：写入前再读一次原文，把锁外其它写方被旧快照回写的窗口
    # 缩到「本次读取与 os.replace 之间」；这是缩窗不是消除，真互斥仍以部署锁为准。
    if GLOBAL_CONFIG.read_text(encoding="utf-8") != text:
        temp.unlink(missing_ok=True)
        raise ToolError("global config changed concurrently during deployment; retry deployment")
    os.replace(temp, GLOBAL_CONFIG)


def switch_claude_json(release: Path, claude_json_path: Path | None = None) -> bytes | None:
    """同步 Claude Code 宿主的用户级 MCP 注册（若存在）。

    ~/.claude.json 的 mcpServers.asyncSubagent 与 config.toml 是两个平行注册面，
    只切 toml 会让两个宿主各吃一个 release（2026-08-30 实测漂移：codex 指新
    release、Claude Code 停旧 release）。文件或注册不存在时跳过，不替用户创建。
    返回切换前的原始字节供回滚；跳过时返回 None。
    """
    target = claude_json_path if claude_json_path is not None else CLAUDE_JSON
    if not target.exists():
        return None
    before = target.read_bytes()
    try:
        data = json.loads(before.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ToolError(f"claude.json is unreadable: {target}: {exc}") from exc
    server = data.get("mcpServers", {}).get("asyncSubagent")
    if not isinstance(server, dict):
        return None
    args = server.get("args")
    if not isinstance(args, list) or not any("subagent_service.mjs" in str(item) for item in args):
        raise ToolError(
            f"claude.json asyncSubagent registration has no subagent_service.mjs arg; refusing to rewrite: {target}"
        )
    entry = release / "ops" / "tools" / "subagent_service.mjs"
    server["args"] = [str(entry) if "subagent_service.mjs" in str(item) else item for item in args]
    server.pop("cwd", None)
    updated = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    atomic_write_bytes(target, updated)
    return before


def configured_server() -> dict[str, Any]:
    with GLOBAL_CONFIG.open("rb") as handle:
        parsed = tomllib.load(handle)
    server = parsed.get("mcp_servers", {}).get("asyncSubagent", {})
    if not isinstance(server, dict):
        raise ToolError("global Async Subagent MCP config is missing")
    return server


def server_for_release(release: Path) -> dict[str, Any]:
    server = dict(configured_server())
    server["args"] = [str(release / "ops" / "tools" / "subagent_service.mjs"), "mcp"]
    server["cwd"] = str(release)
    server["default_tools_approval_mode"] = "approve"
    return server


def verify_config_target(release: Path) -> dict[str, Any]:
    server = configured_server()
    configured_path = Path(str((server.get("args") or [""])[0])).resolve()
    expected_path = (release / "ops" / "tools" / "subagent_service.mjs").resolve()
    if configured_path != expected_path:
        raise ToolError(f"global config points to {configured_path}, expected {expected_path}")
    if server.get("default_tools_approval_mode") != "approve":
        raise ToolError("global Async Subagent MCP approval mode is not approve")
    return server


def handshake(server: dict[str, Any], build_id: str, expected_tools: list[str]) -> dict[str, Any]:
    command = str(server.get("command") or "")
    args = [str(item) for item in server.get("args") or []]
    cwd = str(server["cwd"])
    env = dict(os.environ)
    env.update({str(key): str(value) for key, value in (server.get("env") or {}).items()})
    requests = "\n".join(
        [
            json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "async-mcp-deploy", "version": "1.0.0"},
                },
            }),
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
            "",
        ]
    )
    completed = subprocess.run(
        [command, *args],
        input=requests,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    if completed.returncode != 0:
        raise ToolError(f"deployed MCP handshake failed: {(completed.stderr or completed.stdout)[:600]}")
    messages = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    initialize = next((item.get("result") for item in messages if item.get("id") == 1), None)
    listed = next((item.get("result") for item in messages if item.get("id") == 2), None)
    names = [item.get("name") for item in (listed or {}).get("tools", [])]
    version = str((initialize or {}).get("serverInfo", {}).get("version") or "")
    if names != expected_tools or not version.endswith(f"+{build_id}"):
        raise ToolError(f"deployed MCP identity mismatch: version={version} tools={names}")
    return {"protocol_version": initialize.get("protocolVersion"), "server_version": version, "tools": names}


def verify_release(release: Path, manifest: dict[str, Any], server: dict[str, Any]) -> dict[str, Any]:
    """Check release files and target path only; no subprocesses or runner tests."""
    configured_path = Path(str((server.get("args") or [""])[0])).resolve()
    expected_path = (release / "ops" / "tools" / "subagent_service.mjs").resolve()
    if configured_path != expected_path:
        raise ToolError(f"global config points to {configured_path}, expected {expected_path}")
    pi_runner = release / "ops" / "tools" / "run-pi-task.mjs"
    required_paths = [
        expected_path,
        pi_runner,
        release / "ops" / "tools" / "pi_child_command_jobs.mjs",
        release / "ops" / "tools" / "subagent_handoff_check.bundle.mjs",
        release / "ops" / "tools" / "pi_review_result_extension.mjs",
        release / "ops" / "tools" / "pi_task_result_extension.mjs",
        release / "ops" / "tools" / "pi_write_domain_extension.mjs",
        release / "ops" / "tools" / "pi_worker_tools_extension.mjs",
        release / "ops" / "tools" / "pi_search_extension.mjs",
        release / "ops" / "tools" / "pi_transient_retry.mjs",
        *(release / "ops" / "templates" / name for name in RUNTIME_TEMPLATE_NAMES),
        *(release / name for name in RUNTIME_CONFIG_FILES),
        *(release / name for name in compiler_files(manifest)),
    ]
    missing = [str(path) for path in required_paths if not path.is_file()]
    missing.extend(str(release / name) for name in RUNTIME_CONFIG_DIRS if not (release / name).is_dir())
    if missing:
        raise ToolError("release is incomplete: " + ", ".join(missing))
    return {
        "approval_mode": server.get("default_tools_approval_mode"),
        "release_files": "present",
        "config_target": "matched",
    }


def rollback_deployment(
    *,
    config_before: bytes,
    registry_before: bytes | None,
    old_release: Path | None,
    candidate_release: Path,
    candidate_existed: bool,
    claude_json_before: bytes | None = None,
) -> tuple[list[str], list[str]]:
    restored: list[str] = []
    errors: list[str] = []

    if claude_json_before is not None:
        try:
            if not CLAUDE_JSON.exists() or CLAUDE_JSON.read_bytes() != claude_json_before:
                atomic_write_bytes(CLAUDE_JSON, claude_json_before)
                restored.append("claude_json")
        except Exception as exc:  # rollback must continue across independent restoration steps
            errors.append(f"claude_json: {exc}")

    try:
        if not GLOBAL_CONFIG.exists() or GLOBAL_CONFIG.read_bytes() != config_before:
            atomic_write_bytes(GLOBAL_CONFIG, config_before)
            restored.append("config")
        if GLOBAL_CONFIG.read_bytes() != config_before:
            raise ToolError("restored global config does not match its pre-transaction snapshot")
        if old_release is not None:
            verify_config_target(old_release)
    except Exception as exc:  # rollback must continue across independent restoration steps
        errors.append(f"config: {exc}")

    if registry_before is not None:
        try:
            if not PRODUCER_REGISTRY.exists() or PRODUCER_REGISTRY.read_bytes() != registry_before:
                atomic_write_bytes(PRODUCER_REGISTRY, registry_before)
                restored.append("producer_registry")
            if PRODUCER_REGISTRY.read_bytes() != registry_before:
                raise ToolError("restored producer registration does not match its pre-transaction snapshot")
        except Exception as exc:  # keep trying to restore the candidate directory
            errors.append(f"producer_registry: {exc}")

    if not candidate_existed and candidate_release.exists():
        try:
            shutil.rmtree(candidate_release)
            restored.append("candidate_release")
        except OSError as exc:
            errors.append(f"candidate_release: {exc}")
    return restored, errors


def deploy_release_transaction(
    manifest: dict[str, Any],
    artifacts: dict[str, Path],
) -> dict[str, Any]:
    registration = read_producer_registration(PRODUCER_REGISTRY, ROOT)
    registry_before = registration[1] if registration is not None else None
    config_before_text = GLOBAL_CONFIG.read_text(encoding="utf-8")
    config_before = GLOBAL_CONFIG.read_bytes()
    old_release = config_target_release(config_path=GLOBAL_CONFIG, releases_root=RELEASES_ROOT)
    candidate_release = RELEASES_ROOT / str(manifest["build_id"])
    candidate_existed = candidate_release.exists()
    claude_json_before: bytes | None = None

    try:
        candidate_release = publish_release(manifest, artifacts)
        candidate_verification = verify_release(
            candidate_release,
            manifest,
            server_for_release(candidate_release),
        )
        switch_config(candidate_release, expected_text=config_before_text)
        claude_json_before = switch_claude_json(candidate_release)
        switched_server = verify_config_target(candidate_release)
        switched_verification = verify_release(candidate_release, manifest, switched_server)
        switched_verification["handshake"] = handshake(
            switched_server, str(manifest["build_id"]), list(manifest["public_tools"]),
        )
        if registry_before is not None:
            update_expected_build(
                PRODUCER_REGISTRY,
                str(manifest["build_id"]),
                registry_before,
            )
        # 面板从当前发布槽运行，不占用 pi 扩展目录；旧槽留给仍在运行的面板进程。
        PANEL_RUNTIME_POINTER.parent.mkdir(parents=True, exist_ok=True)
        PANEL_RUNTIME_POINTER.write_text(json.dumps({"root": str(candidate_release)}) + "\n", encoding="utf-8")
    except (OSError, subprocess.SubprocessError, ToolError, tomllib.TOMLDecodeError) as exc:
        restored, rollback_errors = rollback_deployment(
            config_before=config_before,
            registry_before=registry_before,
            old_release=old_release,
            candidate_release=candidate_release,
            candidate_existed=candidate_existed,
            claude_json_before=claude_json_before,
        )
        rollback = f"restored={','.join(restored) or 'unchanged'}"
        if rollback_errors:
            rollback += f"; rollback_errors={'; '.join(rollback_errors)}"
        raise ToolError(f"deployment transaction failed: {exc}; {rollback}") from exc

    return {
        "transaction_committed": True,
        "candidate_verification": candidate_verification,
        "switched_verification": switched_verification,
        "producer_registration": "updated" if registry_before is not None else "missing_not_updated",
        "claude_json_registration": "updated" if claude_json_before is not None else "absent_skipped",
        "release": candidate_release,
    }


def apply_deployment(manifest: dict[str, Any], artifacts: dict[str, Path]) -> dict[str, Any]:
    transaction = deploy_release_transaction(manifest, artifacts)
    try:
        retention = prune_releases(
            transaction["release"],
            config_release=config_target_release(
                config_path=GLOBAL_CONFIG,
                releases_root=RELEASES_ROOT,
            ),
            referenced_releases=active_task_releases(
                registry_root=REGISTRY_ROOT,
                releases_root=RELEASES_ROOT,
            ),
            releases_root=RELEASES_ROOT,
        )
    except OSError as exc:
        retention = {"removed": [], "kept": [], "skipped": [], "errors": [str(exc)]}
    transaction["retention"] = retention
    return transaction


def activate_release(
    release: Path,
    manifest: dict[str, Any],
    *,
    verify_candidate: Any = None,
    switch: Any = None,
    expected_config_text: str | None = None,
) -> dict[str, Any]:
    verify_fn = verify_candidate or (
        lambda candidate, candidate_manifest: verify_release(
            candidate,
            candidate_manifest,
            server_for_release(candidate),
        )
    )
    switch_fn = switch or (lambda candidate: switch_config(candidate, expected_config_text))
    verification = verify_fn(release, manifest)
    switch_fn(release)
    return verification


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=bootstrap_guidance(),
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="publish files, switch config, verify one MCP handshake, and commit producer build identity",
    )
    parser.add_argument(
        "--wait-lock",
        type=float,
        default=0.0,
        metavar="SECONDS",
        help="seconds to wait for the user-level deployment lock (default: fail immediately)",
    )
    parser.add_argument("--self-test", action="store_true", help="run Windows-path replacement regression")
    parser.add_argument(
        "--bootstrap-guide",
        action="store_true",
        help="print the canonical build, transactional apply, and post-deploy verification sequence",
    )
    parser.add_argument("--format", choices=["text", "json"], default="text")
    args = parser.parse_args()
    try:
        if args.bootstrap_guide:
            return emit(
                {"status": "ok", "bootstrap_steps": list(BOOTSTRAP_STEPS)},
                args.format,
                bootstrap_guidance(),
            )
        if args.self_test:
            sample = "\nargs = ['C:\\old\\server.mjs', 'mcp']\ncwd = 'C:\\old'\n"
            updated = replace_setting(sample, "args", "['C:\\Users\\test\\server.mjs', 'mcp']")
            updated = replace_setting(updated, "cwd", "'C:\\Users\\test\\release'")
            events: list[str] = []
            activate_release(
                Path("candidate"),
                {},
                verify_candidate=lambda _release, _manifest: events.append("verify") or {"status": "ok"},
                switch=lambda _release: events.append("switch"),
            )
            failed_events: list[str] = []
            def fail_candidate(_release: Path, _manifest: dict[str, Any]) -> dict[str, Any]:
                raise ToolError("candidate failed")

            try:
                activate_release(
                    Path("candidate"),
                    {},
                    verify_candidate=fail_candidate,
                    switch=lambda _release: failed_events.append("switch"),
                )
            except ToolError:
                verification_failure_preserves_config = failed_events == []
            else:
                verification_failure_preserves_config = False
            windows_path_replacement = (
                "C:\\Users\\test\\server.mjs" in updated and "C:\\Users\\test\\release" in updated
            )
            with tempfile.TemporaryDirectory() as tmp:
                releases = Path(tmp)
                built_ats = {
                    "current": "2026-07-11T10:00:00.000Z",
                    "newest": "2026-07-11T20:00:00.000Z",
                    "second": "2026-07-11T18:00:00.000Z",
                    "third": "2026-07-11T16:00:00.000Z",
                    "oldest": "2026-07-11T09:00:00.000Z",
                    "older": "2026-07-11T08:00:00.000Z",
                }
                for name, built in built_ats.items():
                    build_dir = releases / name
                    build_dir.mkdir()
                    (build_dir / MANIFEST_PATH.name).write_text(
                        json.dumps({"built_at": built}), encoding="utf-8"
                    )
                current_dir = releases / "current"
                retention = prune_releases(
                    current_dir,
                    keep_recent=3,
                    releases_root=releases,
                    now=datetime(2026, 7, 13, tzinfo=timezone.utc),
                )
                # keep = current(config target) ∪ 最近 3 个(newest/second/third)；oldest/older 删除。
                retention_keeps_current_and_recent = (
                    retention["kept"] == ["current", "newest", "second", "third"]
                    and retention["removed"] == ["older", "oldest"]
                    and retention["skipped"] == []
                )
                current_never_removed = current_dir.is_dir() and "current" not in retention["removed"]

            # claude.json 注册切换三态：有注册→改写 args 并移除非标准 cwd；无注册/无文件→跳过不创建
            with tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp)
                release_dir = base / "releases" / "newbuild"
                cj = base / "claude.json"
                cj.write_text(json.dumps({
                    "mcpServers": {"asyncSubagent": {
                        "args": ["C:\\old\\tools\\subagent_service.mjs", "mcp"],
                        "cwd": "C:\\old",
                        "env": {"SUBAGENT_TASK_ROOT": "C:\\tasks"},
                    }},
                    "otherKey": True,
                }), encoding="utf-8")
                before = switch_claude_json(release_dir, claude_json_path=cj)
                after = json.loads(cj.read_text(encoding="utf-8"))
                switched = after["mcpServers"]["asyncSubagent"]
                claude_json_switched = (
                    before is not None
                    and switched["args"][0] == str(release_dir / "ops" / "tools" / "subagent_service.mjs")
                    and switched["args"][1] == "mcp"
                    and "cwd" not in switched
                    and switched["env"]["SUBAGENT_TASK_ROOT"] == "C:\\tasks"
                    and after["otherKey"] is True
                )
                cj_no_server = base / "claude-empty.json"
                cj_no_server.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
                skip_no_server = switch_claude_json(release_dir, claude_json_path=cj_no_server) is None
                skip_missing_file = switch_claude_json(release_dir, claude_json_path=base / "absent.json") is None
                claude_json_skips_when_absent = skip_no_server and skip_missing_file

            checks = {
                "windows_path_replacement": windows_path_replacement,
                "claude_json_switched": claude_json_switched,
                "claude_json_skips_when_absent": claude_json_skips_when_absent,
                "candidate_verified_before_config_switch": events == ["verify", "switch"],
                "verification_failure_preserves_config": verification_failure_preserves_config,
                "retention_keeps_current_and_recent": retention_keeps_current_and_recent,
                "retention_current_never_removed": current_never_removed,
            }
            passed = all(checks.values())
            return emit(
                {"status": "ok" if passed else "failed", "checks": checks},
                args.format,
                f"deploy_subagent_bundle self-test: {'pass' if passed else 'failed'}",
            )
        if not args.apply:
            current = config_target_release(config_path=GLOBAL_CONFIG, releases_root=RELEASES_ROOT)
            data = {
                "status": "ok",
                "applied": False,
                "mode": "deployment_status",
                "build_id": current.name if current else None,
                "release": str(current) if current else None,
                "release_exists": current.is_dir() if current else False,
                "config": str(GLOBAL_CONFIG),
            }
            return emit(data, args.format, f"async MCP configured deployment: {data['build_id'] or 'none'} (read only)")
        manifest = read_manifest()
        artifacts = verify_dist(manifest)
        release = RELEASES_ROOT / str(manifest["build_id"])
        with deployment_lock(wait_seconds=args.wait_lock):
            transaction = apply_deployment(manifest, artifacts)
        release = transaction["release"]
        verification = transaction["switched_verification"]
        retention = transaction["retention"]
        transaction_summary = {
            "transaction_committed": transaction["transaction_committed"],
            "candidate_verification": transaction["candidate_verification"],
            "producer_registration": transaction["producer_registration"],
        }
        data = {
            "status": "ok",
            "applied": args.apply,
            "mode": "apply_transaction",
            "build_id": manifest["build_id"],
            "release": str(release),
            "config": str(GLOBAL_CONFIG),
            "verification": verification,
            "transaction": transaction_summary,
            "retention": retention,
        }
        message = f"async MCP deployment transaction committed: build={manifest['build_id']}"
        return emit(data, args.format, message)
    except (OSError, subprocess.SubprocessError, ToolError, tomllib.TOMLDecodeError) as exc:
        return emit({"status": "failed", "error": str(exc)}, args.format, f"async MCP deployment failed: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
