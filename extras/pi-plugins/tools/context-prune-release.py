#!/usr/bin/env python3
"""Release the self-maintained pi-context-prune build to the one global package path.

Global Pi settings list a single prune package at ~/.pi/agent/local-packages/pi-context-prune.
A release builds a committed revision of the fork, keeps a copy under
~/.pi/agent/local-packages/pi-context-prune-releases/<version>-<commit>/, loads that copy in a
headless Pi (no session, no model call), and only then copies it into the fixed path. Every
project .pi/settings.json that references any prune package gets an explicit entry for the fixed
path, so projects that disable pruning, or pin their own build, keep doing so.

  python -B tools/context-prune-release.py status
  python -B tools/context-prune-release.py release [--source DIR] [--entry policy-lab|index] [--apply]
  python -B tools/context-prune-release.py release --apply --replace-global OLD_PACKAGE_PATH
  python -B tools/context-prune-release.py rollback RELEASE_ID [--apply]

Without --apply the build is staged in a temporary directory and load-checked; nothing under
~/.pi/agent is written. Running Pi sessions keep the instance they loaded; new sessions and
/reload pick up the release.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import io
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

AGENT = os.path.join(os.path.expanduser("~"), ".pi", "agent")
LOCAL_PACKAGES = os.path.join(AGENT, "local-packages")
STABLE = os.path.join(LOCAL_PACKAGES, "pi-context-prune")
STABLE_SETTING = STABLE.replace("\\", "/")
RELEASES = os.path.join(LOCAL_PACKAGES, "pi-context-prune-releases")
BACKUPS = os.path.join(AGENT, "backups")
GLOBAL_SETTINGS = os.path.join(AGENT, "settings.json")
DEFAULT_SOURCE = "E:/Pi_Coding_Agent/forks/pi-context-prune"
PRODUCTION_BRANCH = "codex/restore-pruner-seen-state"
PROJECT_ROOTS = ["E:/Pi_Coding_Agent", "E:/Workspace", "E:/ControlPlane"]
SKIP_DIRS = {"node_modules", ".git", "target", "test-results", "__pycache__", "dist", ".runtime", "sessions"}
ENTRIES = {"policy-lab": "dist/policy-lab.js", "index": "dist/index.js"}
CONFIG_FILES = {"policy-lab": "context-prune/policy-lab.json", "index": "context-prune/settings.json"}
PI = os.path.join(os.environ.get("APPDATA", ""), "npm", "pi.cmd")


def fail(message: str) -> None:
    print(f"停止：{message}")
    sys.exit(1)


def norm(path: str) -> str:
    return path.replace("\\", "/").rstrip("/").lower()


def sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def git(src: str, *args: str) -> str:
    return subprocess.run(["git", "-C", src, *args], capture_output=True, text=True, check=True).stdout.strip()


def source_of(entry) -> str | None:
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict) and isinstance(entry.get("source"), str):
        return entry["source"]
    return None


def is_prune(entry) -> bool:
    source = source_of(entry)
    return bool(source) and "pi-context-prune" in norm(source)


def is_stable(entry) -> bool:
    source = source_of(entry)
    return bool(source) and norm(source) == norm(STABLE_SETTING)


def read_text(path: str) -> str:
    return io.open(path, encoding="utf-8", newline="").read()


def write_text(path: str, text: str) -> None:
    io.open(path, "w", encoding="utf-8", newline="").write(text)


def project_settings() -> list[str]:
    found = []
    for root in PROJECT_ROOTS:
        base_depth = norm(root).count("/")
        for dirpath, dirnames, filenames in os.walk(root):
            depth = norm(dirpath).count("/") - base_depth
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and depth < 7]
            if os.path.basename(dirpath) == ".pi" and "settings.json" in filenames:
                path = os.path.join(dirpath, "settings.json")
                try:
                    data = json.loads(read_text(path))
                except Exception:
                    continue
                if any(is_prune(p) for p in data.get("packages") or []):
                    found.append(path)
    return sorted(found)


def load_check(package_dir: str, entry: str) -> dict:
    """Start Pi in RPC mode with only this package; report extension errors and the startup event."""
    env = dict(os.environ, PI_OFFLINE="1")
    proc = subprocess.Popen([PI, "--mode", "rpc", "--no-session", "--no-extensions", "-e", package_dir],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace", bufsize=1, env=env, cwd=tempfile.gettempdir())
    lines: queue.Queue = queue.Queue()
    threading.Thread(target=lambda: [lines.put(l) for l in proc.stdout], daemon=True).start()
    threading.Thread(target=lambda: [None for _ in proc.stderr], daemon=True).start()
    events = []

    def ask(cmd: dict, rid: str):
        proc.stdin.write(json.dumps(dict(cmd, id=rid)) + "\n")
        proc.stdin.flush()
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                event = json.loads(lines.get(timeout=1))
            except (queue.Empty, ValueError):
                continue
            events.append(event)
            if event.get("type") == "response" and event.get("id") == rid:
                return event
        return None

    try:
        state = ask({"type": "get_state"}, "state")
        entries = ask({"type": "get_entries"}, "entries")
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass
        time.sleep(2)
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    data = (entries or {}).get("data")
    items = data.get("entries", []) if isinstance(data, dict) else (data or [])
    started = [e.get("data") or {} for e in items if e.get("customType") == "context-prune-lab-event"]
    result = {
        "state": bool(state and state.get("success")),
        "extensionErrors": [e for e in events if e.get("type") == "extension_error"],
        "labStart": [{"event": d.get("event"), "reason": d.get("reason"), "mode": d.get("mode"),
                      "config": (d.get("config") or {}).get("path")} for d in started],
    }
    ok = result["state"] and not result["extensionErrors"]
    if entry == "policy-lab":
        ok = ok and any(s["reason"] == "session-start" for s in result["labStart"])
    result["ok"] = ok
    return result


def build(src: str, entry: str, allow_branch: bool) -> dict:
    if git(src, "status", "--porcelain"):
        fail(f"{src} 有未提交改动；只发布已提交的源码")
    commit, branch = git(src, "rev-parse", "HEAD"), git(src, "rev-parse", "--abbrev-ref", "HEAD")
    if branch != PRODUCTION_BRANCH and not allow_branch:
        fail(f"当前分支 {branch}，不是生产分支 {PRODUCTION_BRANCH}；确需发布加 --allow-branch")
    print(f"源码 {src}  {branch} @ {commit[:7]}，运行 npm test（含构建）…")
    run = subprocess.run("npm test", shell=True, cwd=src, capture_output=True, text=True, encoding="utf-8", errors="replace")
    passed = re.search(r"ℹ pass (\d+)", run.stdout)
    failed = re.search(r"ℹ fail (\d+)", run.stdout)
    if run.returncode != 0 or not passed or not failed or failed.group(1) != "0":
        print(run.stdout[-3000:], run.stderr[-2000:])
        fail("测试未全部通过")
    if git(src, "status", "--porcelain"):
        fail("重新构建后工作区出现改动：已提交的 dist 与源码构建结果不一致，先提交构建产物")
    version = json.loads(read_text(os.path.join(src, "package.json")))["version"]
    built = os.path.join(src, ENTRIES[entry])
    return {"release": f"{version}-{commit[:7]}", "version": version, "commit": commit, "branch": branch,
            "source": src.replace("\\", "/"), "entry": entry, "built": built, "sha256": sha256(built),
            "tests": {"pass": int(passed.group(1)), "fail": 0},
            "config": os.path.join(AGENT, CONFIG_FILES[entry]).replace("\\", "/")}


def stage(info: dict, target: str) -> None:
    os.makedirs(os.path.join(target, "dist"), exist_ok=True)
    shutil.copyfile(info["built"], os.path.join(target, "dist", "index.js"))
    license_file = os.path.join(info["source"], "LICENSE")
    if os.path.exists(license_file):
        shutil.copyfile(license_file, os.path.join(target, "LICENSE"))
    package = {"name": "pi-context-prune-local", "version": info["version"], "type": "module", "license": "MIT",
               "pi": {"extensions": ["./dist/index.js"]}}
    write_text(os.path.join(target, "package.json"), json.dumps(package, ensure_ascii=False, indent=2) + "\n")
    record = {k: v for k, v in info.items() if k != "built"}
    record["builtAt"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    write_text(os.path.join(target, "BUILD.json"), json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    write_text(os.path.join(target, "README.md"),
               f"# pi-context-prune（本机发布）\n\n由 `tools/context-prune-release.py` 生成，不要手改。"
               f"来源提交、构建哈希与生效配置见 `BUILD.json`。本版本读取 `{record['config']}`。\n")


def promote(release_dir: str) -> None:
    incoming, previous = STABLE + ".incoming", STABLE + ".previous"
    # An interrupted swap leaves the old package only in .previous; put it back before cleaning up.
    if not os.path.exists(STABLE) and os.path.exists(previous):
        os.replace(previous, STABLE)
    for path in (incoming, previous):
        if os.path.exists(path):
            shutil.rmtree(path)
    shutil.copytree(release_dir, incoming)
    if os.path.exists(STABLE):
        os.replace(STABLE, previous)
    try:
        os.replace(incoming, STABLE)
    except OSError:
        if os.path.exists(previous):
            os.replace(previous, STABLE)
        raise
    if os.path.exists(previous):
        shutil.rmtree(previous)


def backup_dir() -> str:
    path = os.path.join(BACKUPS, "context-prune-release-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    os.makedirs(path)
    return path


def plan_global(replace: str | None) -> str | None:
    """New global settings text that points the prune package at the fixed path; None if it already does."""
    raw = read_text(GLOBAL_SETTINGS)
    data = json.loads(raw)
    packages = data.get("packages") or []
    prune = [p for p in packages if is_prune(p)]
    if len(prune) == 1 and is_stable(prune[0]):
        return None
    if not replace:
        fail(f"全局设置里的裁剪包是 {[source_of(p) for p in prune]}，不是固定路径；首次切换加 --replace-global <旧路径>")
    if [source_of(p) for p in packages].count(replace) != 1:
        fail(f"全局设置 packages 里 source 恰好等于 {replace} 的条目不是 1 个")
    old = json.dumps(replace)[1:-1]
    if raw.count(old) != 1:
        fail(f"全局设置里 {replace} 出现 {raw.count(old)} 次，需要恰好 1 次")
    text = raw.replace(old, json.dumps(STABLE_SETTING)[1:-1])
    after = json.loads(text)
    if {k: v for k, v in after.items() if k != "packages"} != {k: v for k, v in data.items() if k != "packages"}:
        fail("替换会改动全局设置里 packages 以外的内容")
    changed = [(a, b) for a, b in zip(packages, after["packages"]) if a != b]
    if len(packages) != len(after["packages"]) or len(changed) != 1 or \
            source_of(changed[0][0]) != replace or source_of(changed[0][1]) != STABLE_SETTING:
        fail(f"替换结果超出预期：{changed}")
    return text


def write_global(text: str, backup: str) -> None:
    shutil.copy2(GLOBAL_SETTINGS, os.path.join(backup, "settings.json"))
    write_text(GLOBAL_SETTINGS, text)


def isolate_projects(backup: str) -> list[str]:
    done = []
    for path in project_settings():
        raw = read_text(path)
        data = json.loads(raw)
        if any(is_stable(p) for p in data["packages"]):
            continue
        before = json.loads(raw)
        data["packages"].append({"source": STABLE_SETTING, "extensions": []})
        indent = 2
        for line in raw.splitlines()[1:]:
            if line.strip():
                indent = len(line) - len(line.lstrip(" ")) or 2
                break
        text = json.dumps(data, ensure_ascii=False, indent=indent) + ("\n" if raw.endswith("\n") else "")
        if "\r\n" in raw:
            text = text.replace("\n", "\r\n")
        shutil.copy2(path, os.path.join(backup, re.sub(r"[^\w.-]+", "_", path) ))
        write_text(path, text)
        after = json.loads(read_text(path))
        if after["packages"] != before["packages"] + [{"source": STABLE_SETTING, "extensions": []}] or \
                {k: v for k, v in after.items() if k != "packages"} != {k: v for k, v in before.items() if k != "packages"}:
            fail(f"{path} 改动超出预期（已备份）")
        done.append(path)
    return done


def cmd_status(_args) -> None:
    data = json.loads(read_text(GLOBAL_SETTINGS))
    print("全局裁剪包：", [source_of(p) for p in data.get("packages") or [] if is_prune(p)])
    build_file = os.path.join(STABLE, "BUILD.json")
    if os.path.exists(build_file):
        record = json.loads(read_text(build_file))
        actual = sha256(os.path.join(STABLE, "dist", "index.js"))
        print(f"固定路径：{record['release']}  {record['branch']} @ {record['commit'][:7]}  入口 {record['entry']}  "
              f"哈希{'一致' if actual == record['sha256'] else '不一致（被改过）'}  配置 {record['config']}")
    else:
        print("固定路径：尚未发布")
    if os.path.isdir(RELEASES):
        print("存档版本：", sorted(os.listdir(RELEASES)))
    for path in project_settings():
        packages = json.loads(read_text(path))["packages"]
        stable = next((p for p in packages if is_stable(p)), None)
        state = "未覆盖" if stable is None else ("禁用" if isinstance(stable, dict) and stable.get("extensions") == [] else "启用")
        print(f"  项目 {path}：固定路径{state}")


def cmd_release(args) -> None:
    src = os.path.abspath(args.source)
    global_text = plan_global(args.replace_global)
    info = build(src, args.entry, args.allow_branch)
    target = os.path.join(RELEASES, info["release"]) if args.apply else tempfile.mkdtemp(prefix="pi-context-prune-stage-")
    if args.apply and os.path.exists(target):
        existing = json.loads(read_text(os.path.join(target, "BUILD.json")))
        if existing["sha256"] != info["sha256"]:
            fail(f"存档 {target} 已存在且构建不同")
    else:
        stage(info, target)
    check = load_check(target, args.entry)
    print("加载检查：", json.dumps(check, ensure_ascii=False))
    if not check["ok"]:
        fail("加载检查未通过")
    if not args.apply:
        print(f"预演完成：{info['release']}  哈希 {info['sha256'][:16]}  暂存于 {target}；加 --apply 发布")
        return
    backup = backup_dir()
    # Projects first, then the package, then the global pointer: a failure at any step leaves
    # projects isolated and the global settings on a package that is in place.
    for path in isolate_projects(backup):
        print(f"  已为项目补上固定路径的禁用项：{path}")
    promote(target)
    print(f"已发布到 {STABLE_SETTING}：{info['release']}  哈希 {info['sha256'][:16]}")
    if global_text is None:
        print("全局设置已指向固定路径，未改动")
    else:
        write_global(global_text, backup)
        print(f"全局设置：{args.replace_global} → {STABLE_SETTING}")
    print(f"备份：{backup}。已在运行的会话保留原实例，新会话或 /reload 后生效。")


def cmd_rollback(args) -> None:
    target = os.path.join(RELEASES, args.release)
    if not os.path.isdir(target):
        fail(f"没有存档 {args.release}；可选：{sorted(os.listdir(RELEASES)) if os.path.isdir(RELEASES) else []}")
    record = json.loads(read_text(os.path.join(target, "BUILD.json")))
    if sha256(os.path.join(target, "dist", "index.js")) != record["sha256"]:
        fail("存档内容与其 BUILD.json 哈希不一致")
    check = load_check(target, record["entry"])
    print("加载检查：", json.dumps(check, ensure_ascii=False))
    if not check["ok"]:
        fail("加载检查未通过")
    if not args.apply:
        print(f"预演完成：将回退到 {args.release}；加 --apply 执行")
        return
    promote(target)
    print(f"已回退到 {args.release}。已在运行的会话保留原实例，新会话或 /reload 后生效。")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(func=cmd_status)
    rel = sub.add_parser("release")
    rel.add_argument("--source", default=DEFAULT_SOURCE)
    rel.add_argument("--entry", choices=sorted(ENTRIES), default="policy-lab")
    rel.add_argument("--allow-branch", action="store_true")
    rel.add_argument("--replace-global")
    rel.add_argument("--apply", action="store_true")
    rel.set_defaults(func=cmd_release)
    back = sub.add_parser("rollback")
    back.add_argument("release")
    back.add_argument("--apply", action="store_true")
    back.set_defaults(func=cmd_rollback)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
