#!/usr/bin/env python3
"""Plan or publish build -> Pi -> MCP -> consumer, without running business tests."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PI_TARGET = Path.home() / ".pi/agent/extensions/subagent-control"
DEFAULT_CONSUMER_SLOT = Path.home() / ".subagent-control/releases/consumer"
PUBLISH_STEPS = ("pi", "mcp", "consumer")
RELEASE_LOCK = Path.home() / ".subagent-control/releases/control-plane.release.lock"


def make_plan(source_root: Path, pi_target: Path, consumer_slot: Path, allowed_projects: list[str] | None = None, project_scope: str | None = None) -> dict:
    source_root = source_root.expanduser().resolve()
    pi_target = pi_target.expanduser().resolve()
    consumer_slot = consumer_slot.expanduser().resolve()
    metadata = pi_target / "deployment.json"
    installed = json.loads(metadata.read_text(encoding="utf-8")) if metadata.is_file() else {}
    if project_scope is None:
        project_scope = "all" if installed.get("allow_any_project") is True else "listed"
    if project_scope not in {"all", "listed"}:
        raise ValueError("项目启用范围必须为 all 或 listed。")
    if allowed_projects is None:
        allowed_projects = installed.get("allowed_projects", [])
    if not isinstance(allowed_projects, list) or (not allowed_projects and project_scope == "listed"):
        raise ValueError("首次发布或 listed 范围需提供 --allowed-project 列表；all 在所有会话项目启用。")
    projects = []
    for item in allowed_projects:
        project = Path(item).expanduser()
        if not project.is_absolute() or not project.is_dir():
            raise ValueError(f"允许项目必须是已存在的绝对目录：{item}")
        projects.append(str(project.resolve()))
    node = shutil.which("node")
    if not node:
        raise ValueError("找不到 node。")
    tools = source_root / "ops/tools"
    for name in ("build_subagent_bundle.mjs", "deploy_pi_control.py", "deploy_subagent_bundle.py", "consumer_release_package.py"):
        if not (tools / name).is_file():
            raise ValueError(f"发布入口缺失：{tools / name}")
    pi_args = [sys.executable, "-B", str(tools / "deploy_pi_control.py"), "--source-root", str(source_root),
               "--target", str(pi_target), "--project-scope", project_scope, "--apply", "--format", "json"]
    for project in projects:
        pi_args.extend(["--allowed-project", project])
    return {
        "status": "plan", "source_root": str(source_root), "consumer_slot": str(consumer_slot), "allowed_projects": projects,
        "project_scope": project_scope,
        "steps": [
            {"name": "build", "argv": [node, str(tools / "build_subagent_bundle.mjs")]},
            {"name": "pi", "argv": pi_args},
            {"name": "mcp", "argv": [sys.executable, "-B", str(tools / "deploy_subagent_bundle.py"), "--apply", "--format", "json"]},
            {"name": "consumer", "argv": [sys.executable, "-B", str(tools / "consumer_release_package.py"), "--source-root", str(source_root),
                                            "--publish-slot", str(consumer_slot), "--format", "json",
                                            "--user-skills", str(Path.home() / ".claude" / "skills")]},
        ],
        "business_acceptance": "not_run_by_publisher",
        "activation": "restart_running_hosts_then_verify_real_session",
    }


def stop_process_tree(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        taskkill = Path(os.environ["SystemRoot"]) / "System32/taskkill.exe"
        subprocess.run([str(taskkill), "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=False)
    else:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=15)


def run_stage(step: dict, source_root: Path, log_dir: Path) -> dict:
    stdout_path = log_dir / f"{step['name']}.stdout.log"
    stderr_path = log_dir / f"{step['name']}.stderr.log"
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1",
           "SUBAGENT_PROJECT_ROOT": str(source_root), "SUBAGENT_RUNTIME_ROOT": str(source_root),
           "SUBAGENT_CONTROL_REPO_ROOT": str(source_root)}
    options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
    with stdout_path.open("w", encoding="utf-8") as stdout, stderr_path.open("w", encoding="utf-8") as stderr:
        process = subprocess.Popen(step["argv"], cwd=source_root, env=env, stdin=subprocess.DEVNULL,
                                   stdout=stdout, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", **options)
        def stream_stderr():
            for line in process.stderr:
                stderr.write(line)
                stderr.flush()
                print(f"[{step['name']}] {line.rstrip()}", file=sys.stderr, flush=True)
        reader = threading.Thread(target=stream_stderr, daemon=True)
        reader.start()
        started = time.monotonic()
        try:
            while True:
                try:
                    code = process.wait(timeout=10)
                    break
                except subprocess.TimeoutExpired:
                    print(f"[{step['name']}] running {time.monotonic() - started:.1f}s; {stderr_path}", file=sys.stderr, flush=True)
        except KeyboardInterrupt:
            stop_process_tree(process)
            raise
        finally:
            reader.join(timeout=5)
    payload = None
    try:
        payload = json.loads(stdout_path.read_text(encoding="utf-8"))
    except ValueError:
        pass
    return {"exit_code": code, "payload": payload, "stdout_log": str(stdout_path), "stderr_log": str(stderr_path)}


def execute_plan(plan: dict, log_dir: Path, runner=run_stage) -> dict:
    log_dir.mkdir(parents=True, exist_ok=False)
    result = {"status": "running", "steps": [], "published": [], "commit_reported": [], "business_acceptance": "not_run_by_publisher", "activation": "restart_running_hosts_then_verify_real_session", "log_dir": str(log_dir)}
    started = time.monotonic()
    print(f"[release] logs: {log_dir}", file=sys.stderr, flush=True)
    for step in plan["steps"]:
        record = {"name": step["name"], "status": "running"}
        result["steps"].append(record)
        print(f"[{step['name']}] start", file=sys.stderr, flush=True)
        step_started = time.monotonic()
        try:
            outcome = runner(step, Path(plan["source_root"]), log_dir)
            record.update({key: outcome[key] for key in ("exit_code", "stdout_log", "stderr_log") if key in outcome})
            payload = outcome.get("payload")
            ok = outcome["exit_code"] == 0 and isinstance(payload, dict)
            if step["name"] == "build":
                ok = ok and bool(payload.get("build_id"))
            else:
                ok = ok and payload.get("status") in {"ok", "pass"}
            transaction = payload.get("transaction") if isinstance(payload, dict) else None
            committed = (isinstance(transaction, dict) and transaction.get("transaction_committed") is True)
            if step["name"] == "consumer" and isinstance(payload, dict):
                committed = payload.get("dry_run") is False
            if step["name"] in PUBLISH_STEPS and committed:
                result["commit_reported"].append(step["name"])
            if not ok or (step["name"] in PUBLISH_STEPS and not committed):
                raise ValueError("子工具未返回已提交的成功回执；本步是否已改变状态以其日志为准。")
            record["build_id"] = payload.get("build_id")
            if step["name"] == "pi":
                record["build_id"] = payload.get("staged", {}).get("metadata", {}).get("build_id")
            if step["name"] == "build":
                result["build_id"] = record["build_id"]
            elif step["name"] in {"pi", "mcp"}:
                if record["build_id"] != result["build_id"]:
                    raise ValueError(f"{step['name']}实际版本与本次构建不一致：{record['build_id']} != {result['build_id']}")
            else:
                release = Path(payload["release"]).resolve()
                if not release.is_relative_to(Path(plan["consumer_slot"]).resolve()):
                    raise ValueError("consumer回执的安装包不在本次发布槽内。")
                manifest = json.loads((release / "ops/dist/subagent_service.manifest.json").read_text(encoding="utf-8"))
                record["code_build_id"] = manifest.get("build_id")
                if record["code_build_id"] != result["build_id"]:
                    raise ValueError("consumer安装包中的代码版本与本次构建不一致。")
                pointer = json.loads((Path(plan["consumer_slot"]) / "current.json").read_text(encoding="utf-8"))
                if Path(pointer["runtime_root"]).resolve() != release or pointer.get("build_id") != record["build_id"]:
                    raise ValueError("新工程默认安装指针未指向本次发布包。")
            record["status"] = "completed"
            if step["name"] in PUBLISH_STEPS:
                result["published"].append(step["name"])
        except KeyboardInterrupt:
            record.update(status="interrupted", error="已停止后续步骤；本步状态及进程清理需根据日志核对，不能假定整体回滚。")
            result["status"] = "interrupted"
        except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as error:
            record.update(status="failed", error=str(error))
            result["status"] = "partial" if result["commit_reported"] else "failed"
        record["duration_seconds"] = round(time.monotonic() - step_started, 3)
        print(f"[{step['name']}] {record['status']} {record['duration_seconds']:.3f}s", file=sys.stderr, flush=True)
        (log_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if record["status"] != "completed":
            result["failed_stage"] = step["name"]
            break
    else:
        result["status"] = "published"
    result["duration_seconds"] = round(time.monotonic() - started, 3)
    (log_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="预览或一键发布构建、Pi、MCP和新工程包；不运行业务测试，不提供跨三面的原子回滚。")
    parser.add_argument("--apply", action="store_true", help="执行发布；默认仅显示计划，不写文件。")
    parser.add_argument("--allowed-project", action="append", default=None, help="显式替换项目列表；省略则继承现有 Pi 部署列表，listed 范围要求非空。")
    parser.add_argument("--project-scope", choices=("all", "listed"), default=None, help="项目启用范围；省略则继承现有部署，首次部署默认 listed。all 保留任务权限校验。")
    parser.add_argument("--format", choices=("json", "text"), default="text")
    args = parser.parse_args()
    try:
        plan = make_plan(ROOT, DEFAULT_PI_TARGET, DEFAULT_CONSUMER_SLOT, args.allowed_project, args.project_scope)
        if args.apply:
            directory = Path(plan["source_root"]) / "tmp/release-runs" / f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:8]}"
            from deploy_subagent_bundle import deployment_lock, read_producer_registration, PRODUCER_REGISTRY
            with deployment_lock(RELEASE_LOCK):
                read_producer_registration(PRODUCER_REGISTRY, ROOT)
                result = execute_plan(plan, directory)
        else:
            result = plan
    except (OSError, ValueError, RuntimeError) as error:
        result = {"status": "failed", "error": str(error)}
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif result["status"] == "plan":
        print("发布计划（未执行）：")
        for step in result["steps"]:
            command = subprocess.list2cmdline(step["argv"]) if os.name == "nt" else shlex.join(step["argv"])
            print(f"  {step['name']}: {command}")
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] in {"plan", "published"} else 130 if result["status"] == "interrupted" else 1


if __name__ == "__main__":
    raise SystemExit(main())
