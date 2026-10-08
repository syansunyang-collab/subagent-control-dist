#!/usr/bin/env python3
"""Preview or sync the distribution repository from this repository's HEAD.

分发仓只含安装、发布与运行所需文件，不带本仓工作历史（notes、docs、状态文件、测试与测试产物）；
每次同步在分发仓提交一次，接收方在自己的分支合并。默认只预览，--apply 才写入。
给出 --plugin-repo 时，把插件仓 HEAD 的可选插件、补丁与运维工具镜像到 extras/pi-plugins/（bootstrap 不安装，
由接收方按 extras/pi-plugins/EXTRAS.md 自选）；不给时保留分发仓已有的 extras/。
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
EXTRAS = "extras/pi-plugins/"
# 插件仓里随分发的部分：插件、补丁、运维脚本、配套测试、运维手册、模板与技能；工作记录不带。
PLUGIN_PREFIXES = ("tools/", "tests/pi/", "docs/operations/pi-", "artifacts/templates/", ".pi/skills/", "test-baselines/")
PLUGIN_FILES = ("EXTRAS.md",)
# 研究工具目录里的 .jsonl 是真实会话抓包数据，不随分发。
PLUGIN_DATA = ("tools/context-prune-bench/", ".jsonl")
# 维护者个人部署（Pi Web 自启动，含个人公网地址），不随分发。
PLUGIN_PRIVATE = ("tools/pi-web/", "tests/pi/pi_web_autostart_contract.test.mjs")
# 插件仓内的独立 git 仓，取各自 HEAD。
PLUGIN_FORKS = ("forks/pi-context-prune",)
# Pi 本体补丁的构建载荷不入插件仓提交（在被忽略的 .runtime/ 下），从插件仓工作目录取；管理脚本应用前按清单校验哈希。
PLUGIN_PAYLOADS = (
    ".runtime/pi-codex-attribution/0.99.1/payload.json.gz",
    ".runtime/pi-codex-attribution/0.99.1/ws-payload.json.gz",
    ".runtime/pi-prompt-stability/0.99.1/host-payload.json.gz",
)


def git(cwd: Path, *args: str, binary: bool = False):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, check=True, text=not binary)
    return result.stdout


def selected(path: str) -> bool:
    included = any(path == item or (item.endswith("/") and path.startswith(item)) for item in INCLUDE)
    return included and not path.startswith(EXCLUDE)


def plugin_selected(path: str) -> bool:
    if path.startswith(PLUGIN_DATA[0]) and path.endswith(PLUGIN_DATA[1]):
        return False
    return (path in PLUGIN_FILES or path.startswith(PLUGIN_PREFIXES)) and not path.startswith(PLUGIN_PRIVATE)


def head_files(repo: Path, keep, prefix: str = "") -> tuple[str, dict[str, bytes]]:
    head = git(repo, "rev-parse", "HEAD").strip()
    # 关掉 core.autocrlf：没有 eol 属性的仓（如 fork）按提交原字节导出，不随本机 git 配置转 CRLF。
    archive = git(repo, "-c", "core.autocrlf=false", "archive", "--format=tar", "HEAD", binary=True)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar.getmembers():
            if member.isfile() and keep(member.name):
                files[prefix + member.name] = tar.extractfile(member).read()
    return head, files


def export_files(plugin_repo: Path | None) -> tuple[dict[str, str], dict[str, bytes]]:
    head, files = head_files(ROOT, selected)
    heads = {"control": head}
    if plugin_repo:
        heads["plugins"], extras = head_files(plugin_repo, plugin_selected, EXTRAS)
        files.update(extras)
        for payload in PLUGIN_PAYLOADS:
            source = plugin_repo / payload
            if not source.is_file():
                raise SystemExit(f"插件仓缺少补丁载荷：{source}；先按 tools/pi-codex-attribution/README-0.99.1.md 构建。")
            files[EXTRAS + payload] = source.read_bytes()
        for fork in PLUGIN_FORKS:
            heads[fork], extras = head_files(plugin_repo / fork, lambda path: True, f"{EXTRAS}{fork}/")
            files.update(extras)
    return heads, files


def sync(target: Path, heads: dict[str, str], files: dict[str, bytes], apply: bool) -> dict:
    tracked = set(filter(None, git(target, "ls-files", "-z").split("\0"))) if (target / ".git").exists() else set()
    # 本轮不导出插件仓时，分发仓已有的 extras/ 原样保留。
    keep_extras = "plugins" not in heads
    removed = sorted(path for path in tracked - files.keys() if not (keep_extras and path.startswith(EXTRAS)))
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
            # -f：补丁载荷位于分发仓忽略的 extras/pi-plugins/.runtime/ 下，按导出清单强制入库。
            subprocess.run(["git", "add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], cwd=target,
                           input=spec, capture_output=True, check=True)
            cached = set(filter(None, git(target, "diff", "--cached", "--name-only", "-z").split("\0")))
            if set(paths) & cached:
                message = f"sync: control plane {heads['control'][:12]}" + (
                    f", plugins {heads['plugins'][:12]}" if "plugins" in heads else "")
                subprocess.run(["git", "commit", "-q", "-m", message,
                                "--pathspec-from-file=-", "--pathspec-file-nul"],
                               cwd=target, input=spec, capture_output=True, check=True)
                committed = git(target, "rev-parse", "HEAD").strip()
    return {"status": "synced" if apply else "plan", "source_heads": heads, "target": str(target),
            "files": len(files), "changed": changed, "removed": removed, "commit": committed}


def main() -> int:
    parser = argparse.ArgumentParser(description="预览或同步分发仓；内容取本仓 HEAD，未提交改动不进分发仓。")
    parser.add_argument("--target", required=True, help="分发仓目录；不存在时 --apply 会 git init。")
    parser.add_argument("--apply", action="store_true", help="写入分发仓并提交。")
    parser.add_argument("--plugin-repo", help="插件仓目录；给出时把其 HEAD 的可选插件镜像到 extras/pi-plugins/。")
    args = parser.parse_args()
    target = Path(args.target).expanduser().resolve()
    if target == ROOT or ROOT in target.parents:
        parser.error("分发仓不能在本仓内。")
    plugin_repo = Path(args.plugin_repo).expanduser().resolve() if args.plugin_repo else None
    heads, files = export_files(plugin_repo)
    result = sync(target, heads, files, args.apply)
    result["changed"] = result["changed"] if len(result["changed"]) <= 50 else result["changed"][:50] + ["..."]
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
