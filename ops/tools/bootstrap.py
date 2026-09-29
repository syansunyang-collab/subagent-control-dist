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
import platform
import shutil
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[2]
HOME = Path.home()
NPM_DIRS = (("ops", ()), ("adapters/pi", ("--ignore-scripts",)), ("src/agent-panel", ()))
ADDONS = ROOT / "adapters/pi/user-addons"
PI_AGENT = HOME / ".pi/agent"
WEB_SEARCH_CONFIG = HOME / ".pi/web-search.json"
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
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
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
    if int(node.removeprefix("v").split(".", 1)[0]) < 24:
        raise BootstrapError(f"需要 Node 24+（当前 {node}）。")
    return {"node": node, "node_path": found["node"]}


def optional_matches_host(entry: dict) -> bool:
    """有 os/cpu 限制且命中本机的 optional 才强制；无限制或异平台不要求。os 用 sys.platform，cpu 把 AMD64/x86_64 映到 x64、ARM64/aarch64 映到 arm64。"""
    if not entry.get("optional"):
        return False
    systems, cpus = entry.get("os"), entry.get("cpu")
    if not systems and not cpus:
        return False
    cpu = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine().lower())
    return (not systems or sys.platform in systems) and (not cpus or cpu in cpus)


def npm_tree_matches(directory: Path) -> bool:
    """非 peer 必需条目，加上命中本机的 optional，都要有实体目录且与 lock 同版本。"""
    hidden = directory / "node_modules/.package-lock.json"
    if not hidden.is_file():
        return False
    installed = json.loads(hidden.read_text(encoding="utf-8"))["packages"]
    locked = json.loads((directory / "package-lock.json").read_text(encoding="utf-8"))["packages"]
    required = {key for key, entry in locked.items()
                if key and not entry.get("peer") and (not entry.get("optional") or optional_matches_host(entry))}
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
    """发布只改写已有注册，首装在这里建占位，指向由发布切到发布槽。已有非对象值为冲突，不覆盖。"""
    data = read_json(CLAUDE_JSON) if CLAUDE_JSON.exists() else {}
    servers = data.get("mcpServers")
    if isinstance(servers, dict) and "asyncSubagent" in servers:
        if isinstance(servers["asyncSubagent"], dict):
            return {"step": "claude-mcp", "status": "ok"}
        return {"step": "claude-mcp", "status": "conflict",
                "detail": f"{CLAUDE_JSON} 的 asyncSubagent 已存在且不是对象，未改动"}
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


def step_addon_units(apply: bool) -> list[dict]:
    """快照里 extensions/、local-packages/、context-prune/ 下的每一项是一个单元：
    本机缺失则整份装入；快照文件逐字节相同为 ok（本机多出的文件不管）；其余为冲突，跳过不覆盖。"""
    root = ADDONS / "agent"
    results = []
    for unit in sorted(item for container in root.iterdir() for item in container.iterdir()):
        relative = unit.relative_to(root).as_posix()
        files = [unit] if unit.is_file() else sorted(path for path in unit.rglob("*") if path.is_file())
        targets = [(path, PI_AGENT / path.relative_to(root)) for path in files]
        if all(target.is_file() and target.read_bytes() == path.read_bytes() for path, target in targets):
            results.append({"step": f"pi-addon:{relative}", "status": "ok"})
        elif (PI_AGENT / relative).exists():
            results.append({"step": f"pi-addon:{relative}", "status": "conflict",
                            "detail": f"{PI_AGENT / relative} 已存在且内容不同，未覆盖"})
        else:
            if apply:
                for path, target in targets:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(path.read_bytes())
            results.append({"step": f"pi-addon:{relative}", "status": "done" if apply else "todo"})
    return results


def npm_name(entry: str) -> str:
    spec = entry.removeprefix("npm:")
    return spec[:spec.rindex("@")] if spec.rfind("@") > 0 else spec


def package_source(item) -> str | None:
    if isinstance(item, str):
        return item
    if isinstance(item, dict) and isinstance(item.get("source"), str):
        return item["source"]
    return None


def step_pi_packages(apply: bool, packages: list[str]) -> list[dict]:
    """npm 包经 `pi install` 安装并登记；本地包登记绝对路径。同名已登记但版本或来源不同为冲突。
    字符串与 {source: ...} 按 source 比较，对象上的过滤字段原样保留。"""
    settings_path = PI_AGENT / "settings.json"
    results = []
    for wanted in packages:
        settings = read_json(settings_path) if settings_path.exists() else {}
        sources = [source for source in map(package_source, settings.get("packages", [])) if source]
        step = f"pi-package:{wanted}"
        if wanted.startswith("npm:"):
            same = [item for item in sources if item.startswith("npm:") and npm_name(item) == npm_name(wanted)]
            if wanted in same:
                results.append({"step": step, "status": "ok"})
            elif same:
                results.append({"step": step, "status": "conflict", "detail": f"已登记 {same[0]}，未改动"})
            else:
                if apply:
                    subprocess.run([shutil.which("pi"), "install", wanted], stdin=subprocess.DEVNULL, check=True)
                results.append({"step": step, "status": "done" if apply else "todo"})
            continue
        path = (PI_AGENT / wanted).resolve()
        if any((PI_AGENT / item).resolve() == path for item in sources if not item.startswith(("npm:", "git:", "http"))):
            results.append({"step": step, "status": "ok"})
            continue
        if apply:
            settings["packages"] = [*settings.get("packages", []), path.as_posix()]
            write_json(settings_path, settings)
        results.append({"step": step, "status": "done" if apply else "todo"})
    return results


def step_json_keys(apply: bool, name: str, path: Path, wanted: dict) -> dict:
    """顶层键缺失则写入；已有且值不同为冲突，保留原值。"""
    data = read_json(path) if path.exists() else {}
    missing = [key for key in wanted if key not in data]
    differing = [key for key in wanted if key in data and data[key] != wanted[key]]
    if apply and missing:
        data.update({key: wanted[key] for key in missing})
        write_json(path, data)
    status = "conflict" if differing else ("done" if apply else "todo") if missing else "ok"
    detail = "; ".join(part for part in (f"写入 {', '.join(missing)}" if missing else "",
                                         f"保留本机不同值 {', '.join(differing)}" if differing else "") if part)
    return {"step": name, "status": status, **({"detail": f"{path}：{detail}"} if detail else {})}


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


PANEL_LAUNCHER = HOME / ".subagent-control/releases/consumer/current/ops/consumer-tools/agent_panel_launcher.mjs"


def powershell(script: str) -> str:
    encoded = __import__("base64").b64encode(script.encode("utf-16-le")).decode("ascii")
    return subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                          capture_output=True, text=True, encoding="utf-8", check=True).stdout.strip()


def step_panel_build(apply: bool, node: str) -> dict:
    """面板桌面壳需要 .NET 10 SDK 现场构建；首装时预先构建，避免第一次打开空等。
    是否可复用以启动器 --status 的 reusable 为准（与启动器 validManifest 同一判据）。"""
    if not shutil.which("dotnet"):
        return {"step": "panel-build", "status": "skipped", "detail": "未找到 dotnet，面板需要 .NET 10 SDK 与 WebView2；派发不受影响"}
    if not apply and not PANEL_LAUNCHER.is_file():
        return {"step": "panel-build", "status": "todo", "detail": "发布后构建"}
    status = json.loads(subprocess.run([node, str(PANEL_LAUNCHER), "--status"], cwd=ROOT, capture_output=True,
                                       text=True, encoding="utf-8", check=True).stdout)
    if status.get("reusable"):
        return {"step": "panel-build", "status": "ok"}
    if apply:
        subprocess.run([node, str(PANEL_LAUNCHER), "--build"], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    return {"step": "panel-build", "status": "done" if apply else "todo"}


def step_panel_shortcut(apply: bool, node: str, desktop: Path | None = None) -> dict:
    """桌面快捷方式经 consumer current 的启动器打开面板，升级后路径不变；同名快捷方式指向别处时为冲突。"""
    if not shutil.which("dotnet"):
        return {"step": "panel-shortcut", "status": "skipped", "detail": "面板未构建"}
    desktop = desktop or Path(powershell("[Environment]::GetFolderPath('Desktop')"))
    link = desktop / "Agent Panel.lnk"
    quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    wanted = f'{node}|"{PANEL_LAUNCHER}"|{ROOT}'
    if link.exists():
        current = powershell(f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut({quote(link)}); "
                             "\"$($s.TargetPath)|$($s.Arguments)|$($s.WorkingDirectory)\"")
        if os.path.normcase(current) == os.path.normcase(wanted):
            return {"step": "panel-shortcut", "status": "ok"}
        return {"step": "panel-shortcut", "status": "conflict", "detail": f"{link} 已指向 {current}，未改动"}
    if apply:
        state = HOME / ".subagent-control/agent-panel/build-manifest.json"
        icon = read_json(state).get("executable", "") if state.is_file() else ""
        powershell(f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut({quote(link)}); "
                   f"$s.TargetPath={quote(node)}; $s.Arguments={quote(f'\"{PANEL_LAUNCHER}\"')}; "
                   f"$s.WorkingDirectory={quote(ROOT)}; $s.WindowStyle=7; $s.Description='Agent Panel'; "
                   + (f"$s.IconLocation={quote(icon + ',0')}; " if icon else "") + "$s.Save()")
    return {"step": "panel-shortcut", "status": "done" if apply else "todo", "detail": str(link)}


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
        addons = read_json(ADDONS / "manifest.json")
        steps.extend(step_addon_units(args.apply))
        steps.extend(step_pi_packages(args.apply, addons["packages"]))
        steps.append(step_json_keys(args.apply, "pi-settings", PI_AGENT / "settings.json", addons["pi_settings"]))
        steps.append(step_json_keys(args.apply, "web-search-config", WEB_SEARCH_CONFIG, addons["web_search"]))
        steps.append(step_pi_skills(args.apply))
        steps.append(step_producer_registration(args.apply))
        steps.append(step_release(args.apply))
        steps.append(step_panel_build(args.apply, environment["node_path"]))
        steps.append(step_panel_shortcut(args.apply, environment["node_path"]))
        result = {"status": "applied" if args.apply else "plan", "environment": environment, "steps": steps}
        if args.apply:
            result["next"] = "重启 Claude Code 与 Pi，新会话才加载新的 MCP、扩展与技能；然后按 SETUP.md「验证」一节冒烟。"
    except (BootstrapError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        result = {"status": "failed", "error": str(error), "steps": steps}
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for step in result["steps"]:
            print(f"[{step['status']:>4}] {step['step']}" + (f"  {step['detail']}" if step.get("detail") else ""))
        for key in ("error", "next"):
            if key in result:
                print(f"{key}: {result[key]}")
        print(f"status: {result['status']}")
    return 0 if result["status"] in {"plan", "applied"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
