#!/usr/bin/env python3
"""Preview or sync the distribution repository from this repository's HEAD.

分发仓只含安装、发布与运行所需文件，不带本仓工作历史（notes、docs、状态文件、测试与测试产物）；
每次同步在分发仓提交一次，接收方在自己的分支合并。默认只预览，--apply 才写入。
"""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
INCLUDE = (
    "AGENTS.md", "README.md", "SETUP.md", "HANDOVER.md", "COPY-INSTALL.ps1", ".gitattributes", ".gitignore",
    ".runtime/cockpit/.gitkeep", ".pi/settings.json", ".pi/extensions/", ".pi/prompts/",
    ".pi/control-plane-model-config.json", "ops/", "adapters/pi/", "src/agent-panel/",
)
EXCLUDE = ("src/agent-panel/tests/",)


def git(cwd: Path, *args: str, binary: bool = False):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, check=True, text=not binary)
    return result.stdout


def selected(path: str) -> bool:
    included = any(path == item or (item.endswith("/") and path.startswith(item)) for item in INCLUDE)
    return included and not path.startswith(EXCLUDE)


def export_files() -> tuple[str, dict[str, bytes]]:
    head = git(ROOT, "rev-parse", "HEAD").strip()
    archive = git(ROOT, "archive", "--format=tar", "HEAD", binary=True)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar.getmembers():
            if member.isfile() and selected(member.name):
                files[member.name] = tar.extractfile(member).read()
    return head, files


def sync(target: Path, head: str, files: dict[str, bytes], apply: bool) -> dict:
    tracked = set(filter(None, git(target, "ls-files", "-z").split("\0"))) if (target / ".git").exists() else set()
    removed = sorted(tracked - files.keys())
    changed = sorted(path for path, body in files.items()
                     if not (target / path).is_file() or (target / path).read_bytes() != body)
    committed = None
    if apply and (removed or changed or not tracked):
        if not (target / ".git").exists():
            target.mkdir(parents=True, exist_ok=True)
            git(target, "init", "-b", "main")
        for path in removed:
            (target / path).unlink(missing_ok=True)
        for path in changed:
            (target / path).parent.mkdir(parents=True, exist_ok=True)
            (target / path).write_bytes(files[path])
        # 已跟踪仓只提交本轮 changed+removed，pathspec 不带走无关暂存；无已跟踪文件时整体提交导出集合。
        paths = sorted(files) if not tracked else changed + removed
        if paths:
            spec = "\0".join(paths).encode("utf-8")
            subprocess.run(["git", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], cwd=target,
                           input=spec, capture_output=True, check=True)
            cached = set(filter(None, git(target, "diff", "--cached", "--name-only", "-z").split("\0")))
            if set(paths) & cached:
                subprocess.run(["git", "commit", "-q", "-m", f"sync: control plane {head[:12]}",
                                "--pathspec-from-file=-", "--pathspec-file-nul"],
                               cwd=target, input=spec, capture_output=True, check=True)
                committed = git(target, "rev-parse", "HEAD").strip()
    return {"status": "synced" if apply else "plan", "source_head": head, "target": str(target),
            "files": len(files), "changed": changed, "removed": removed, "commit": committed}


def main() -> int:
    parser = argparse.ArgumentParser(description="预览或同步分发仓；内容取本仓 HEAD，未提交改动不进分发仓。")
    parser.add_argument("--target", required=True, help="分发仓目录；不存在时 --apply 会 git init。")
    parser.add_argument("--apply", action="store_true", help="写入分发仓并提交。")
    args = parser.parse_args()
    target = Path(args.target).expanduser().resolve()
    if target == ROOT or ROOT in target.parents:
        parser.error("分发仓不能在本仓内。")
    head, files = export_files()
    result = sync(target, head, files, args.apply)
    result["changed"] = result["changed"] if len(result["changed"]) <= 50 else result["changed"][:50] + ["..."]
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
