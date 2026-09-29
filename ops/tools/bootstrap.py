#!/usr/bin/env python3
"""Preview or apply the per-machine install of the Pi rail: dependencies, host registrations, Pi setup, then release.

首装与升级同一入口，各步本机已满足时跳过；默认只预览，--apply 才写入。
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[2]
HOME = Path.home()
NPM_DIRS = (("ops", ()), ("adapters/pi", ("--ignore-scripts",)), ("src/agent-panel", ()))
ALIAS_EXTENSION = ROOT / "adapters/pi/user-extensions/openai-codex-sol-context-alias.ts"
PI_AGENT = HOME / ".pi/agent"
CLAUDE_JSON = HOME / ".claude.json"
CODEX_CONFIG = HOME / ".codex/config.toml"
PRODUCER_REGISTRY = HOME / ".subagent-control/bridge-producer.json"
TASK_ROOT = HOME / ".subagent-control/async_tasks"
SKILLS_PATH = (HOME / ".subagent-control/releases/consumer/current/ops/skills").as_posix()


class BootstrapError(Exception):
    pass


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise BootstrapError(f"无法读取 {path}：{error}") from error
    if not isinstance(data, dict):
        raise BootstrapError(f"{path} 顶层不是对象。")
    return data


def check_prerequisites() -> dict:
    if sys.version_info < (3, 12):
        raise BootstrapError("需要 Python 3.12+。")
    found = {name: shutil.which(name) for name in ("node", "npm", "git", "pi")}
    missing = [name for name, path in found.items() if not path]
    if missing:
        raise BootstrapError(f"PATH 上缺少：{', '.join(missing)}（Pi 用 npm i -g @earendil-works/pi-coding-agent 安装）。")
    with tempfile.TemporaryDirectory() as scratch:
        try:
            os.symlink(scratch, Path(scratch) / "link", target_is_directory=True)
        except OSError as error:
            raise BootstrapError(f"当前用户不能创建符号链接（{error}）；Windows 需开启「开发者模式」。") from error
    node = subprocess.run([found["node"], "--version"], capture_output=True, text=True, check=True).stdout.strip()
    return {"node": node, "node_path": found["node"], "panel_dotnet": bool(shutil.which("dotnet"))}


def npm_tree_matches(directory: Path) -> bool:
    """lock 的非可选、非 peer 条目与 npm 记录已装的条目（含本平台 optional 原生包）逐一有实体目录且同版本。"""
    hidden = directory / "node_modules/.package-lock.json"
    if not hidden.is_file():
        return False
    installed = json.loads(hidden.read_text(encoding="utf-8"))["packages"]
    locked = json.loads((directory / "package-lock.json").read_text(encoding="utf-8"))["packages"]
    required = {key for key, entry in locked.items() if key and not entry.get("optional") and not entry.get("peer")}
    if not required <= installed.keys():
        return False
    for key in required | {key for key in installed if key}:
        manifest = directory / key / "package.json"
        expected = locked.get(key, installed[key]).get("version")
        if not manifest.is_file() or json.loads(manifest.read_text(encoding="utf-8")).get("version") != expected:
            return False
    return True


def step_npm(apply: bool) -> list[dict]:
    npm = shutil.which("npm")
    results = []
    for relative, flags in NPM_DIRS:
        directory = ROOT / relative
        if npm_tree_matches(directory):
            results.append({"step": f"npm:{relative}", "status": "ok"})
            continue
        if apply:
            subprocess.run([npm, "ci", "--no-audit", "--no-fund", *flags], cwd=directory, check=True)
        results.append({"step": f"npm:{relative}", "status": "done" if apply else "todo", "detail": "npm ci"})
    return results


def step_claude_registration(apply: bool, node: str) -> dict:
    """发布只改写已有注册，首装在这里建占位，指向由发布切到发布槽。"""
    data = read_json(CLAUDE_JSON) if CLAUDE_JSON.exists() else {}
    if isinstance(data.get("mcpServers", {}).get("asyncSubagent"), dict):
        return {"step": "claude-mcp", "status": "ok"}
    if apply:
        data.setdefault("mcpServers", {})["asyncSubagent"] = {
            "type": "stdio", "command": node,
            "args": [str(ROOT / "ops/tools/subagent_service.mjs"), "mcp"],
            "env": {"SUBAGENT_TASK_ROOT": str(TASK_ROOT)},
        }
        write_json(CLAUDE_JSON, data)
    return {"step": "claude-mcp", "status": "done" if apply else "todo", "detail": str(CLAUDE_JSON)}


def step_codex_registration(apply: bool, node: str) -> dict:
    """MCP 发布事务以 Codex 注册为基准做握手与回滚，未装 Codex 也需要这一节。"""
    text = CODEX_CONFIG.read_text(encoding="utf-8") if CODEX_CONFIG.exists() else ""
    if isinstance(tomllib.loads(text).get("mcp_servers", {}).get("asyncSubagent"), dict):
        return {"step": "codex-mcp", "status": "ok"}
    paths = (node, str(ROOT / "ops/tools/subagent_service.mjs"), str(ROOT), str(TASK_ROOT))
    if any("'" in item for item in paths):
        raise BootstrapError("路径含单引号，无法写成 TOML 字面量字符串。")
    section = (
        "\n[mcp_servers.asyncSubagent]\n"
        f"command = '{paths[0]}'\n"
        f"args = ['{paths[1]}', 'mcp']\n"
        f"cwd = '{paths[2]}'\n"
        'default_tools_approval_mode = "approve"\n'
        "tool_timeout_sec = 660.0\n\n"
        "[mcp_servers.asyncSubagent.env]\n"
        f"SUBAGENT_TASK_ROOT = '{paths[3]}'\n"
    )
    if apply:
        CODEX_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        with CODEX_CONFIG.open("a", encoding="utf-8") as handle:
            handle.write(section)
    return {"step": "codex-mcp", "status": "done" if apply else "todo", "detail": str(CODEX_CONFIG)}


def step_alias_extension(apply: bool) -> dict:
    target = PI_AGENT / "extensions" / ALIAS_EXTENSION.name
    source = ALIAS_EXTENSION.read_bytes()
    if target.is_file() and target.read_bytes() == source:
        return {"step": "pi-alias-extension", "status": "ok"}
    detail = str(target)
    if apply:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            backup = target.with_name(f"{target.name}.bak-{datetime.now():%Y%m%d%H%M%S}")
            target.replace(backup)
            detail += f"（旧文件备份为 {backup.name}）"
        target.write_bytes(source)
    return {"step": "pi-alias-extension", "status": "done" if apply else "todo", "detail": detail}


def step_pi_skills(apply: bool) -> dict:
    settings_path = PI_AGENT / "settings.json"
    settings = read_json(settings_path) if settings_path.exists() else {}
    skills = settings.get("skills", [])
    if any(Path(item) == Path(SKILLS_PATH) for item in skills):
        return {"step": "pi-skills", "status": "ok"}
    if apply:
        settings["skills"] = [*skills, SKILLS_PATH]
        write_json(settings_path, settings)
    return {"step": "pi-skills", "status": "done" if apply else "todo", "detail": SKILLS_PATH}


def step_producer_registration(apply: bool) -> dict:
    if PRODUCER_REGISTRY.exists():
        registered = read_json(PRODUCER_REGISTRY).get("producer_root")
        if not registered or os.path.normcase(os.path.abspath(registered)) != os.path.normcase(str(ROOT)):
            raise BootstrapError(f"本机发布源登记为 {registered}，不是 {ROOT}；改从登记的仓发布，或删除 {PRODUCER_REGISTRY} 后重跑。")
        return {"step": "producer-registration", "status": "ok"}
    if apply:
        write_json(PRODUCER_REGISTRY, {"producer_root": str(ROOT),
                                       "registered_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    return {"step": "producer-registration", "status": "done" if apply else "todo", "detail": str(ROOT)}


def step_release(apply: bool) -> dict:
    argv = [sys.executable, "-B", str(ROOT / "ops/tools/release_control_plane.py"), "--project-scope", "all"]
    if not apply:
        return {"step": "release", "status": "todo", "detail": subprocess.list2cmdline([*argv, "--apply"])}
    code = subprocess.run([*argv, "--apply"], cwd=ROOT).returncode
    if code != 0:
        raise BootstrapError(f"发布失败（exit {code}），日志在 {ROOT / 'tmp/release-runs'} 最新目录。")
    return {"step": "release", "status": "done"}


def main() -> int:
    parser = argparse.ArgumentParser(description="预览或执行本机 Pi 轨安装与升级；默认只预览。")
    parser.add_argument("--apply", action="store_true", help="执行写入与发布。")
    parser.add_argument("--format", choices=("json", "text"), default="text")
    args = parser.parse_args()
    steps: list[dict] = []
    try:
        environment = check_prerequisites()
        steps.extend(step_npm(args.apply))
        steps.append(step_claude_registration(args.apply, environment["node_path"]))
        steps.append(step_codex_registration(args.apply, environment["node_path"]))
        steps.append(step_alias_extension(args.apply))
        steps.append(step_pi_skills(args.apply))
        steps.append(step_producer_registration(args.apply))
        steps.append(step_release(args.apply))
        result = {"status": "applied" if args.apply else "plan", "environment": environment, "steps": steps}
        if args.apply:
            result["next"] = "重启 Claude Code 与 Pi，新会话才加载新的 MCP、扩展与技能；然后按 SETUP.md「验证」一节冒烟。"
        if not environment["panel_dotnet"]:
            result["panel"] = "未找到 dotnet：面板首次打开需要 .NET 10 SDK 与 WebView2，派发本身不受影响。"
    except (BootstrapError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        result = {"status": "failed", "error": str(error), "steps": steps}
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for step in result["steps"]:
            print(f"[{step['status']:>4}] {step['step']}" + (f"  {step['detail']}" if step.get("detail") else ""))
        for key in ("error", "panel", "next"):
            if key in result:
                print(f"{key}: {result[key]}")
        print(f"status: {result['status']}")
    return 0 if result["status"] in {"plan", "applied"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
