#!/usr/bin/env python3
"""Print a compact health summary for the cockpit repository."""

from __future__ import annotations

import argparse
import sys
from typing import Any

sys.dont_write_bytecode = True

from _tool_common import ROOT, emit, file_fingerprint, run_git, status_lines


KEY_FILES = [
    "AGENTS.md",
    "PROJECT.md",
    "STATUS.md",
    "ROADMAP.md",
    "ops/policies/runtime-tools.md",
    "ops/skills/rule-authoring/SKILL.md",
]


def build_data() -> dict[str, Any]:
    branch = run_git(["branch", "--show-current"])
    head = run_git(["rev-parse", "--short=12", "HEAD"])
    git_available = branch["exit_code"] == 0 and head["exit_code"] == 0
    status = status_lines() if git_available else []
    data = {
        "tool": "cockpit_health",
        "status": "dirty" if status else ("pass" if git_available else "no_git"),
        "exit_code": 0,
        "repo_root": str(ROOT),
        "git": {
            "available": git_available,
            "branch": branch["stdout"] or ("(unavailable)" if not git_available else "(detached)"),
            "head": head["stdout"] or "",
            "error": "" if git_available else (branch["stderr"] or head["stderr"]),
            "dirty_count": len(status),
            "dirty_entries": status[:30],
        },
        "key_files": [file_fingerprint(ROOT / item) for item in KEY_FILES],
    }
    return data


def build_text(data: dict[str, Any]) -> str:
    lines = [
        "# Cockpit Health",
        "",
        f"status: {data['status']}",
        f"repo_root: {data['repo_root']}",
        f"git_available: {data['git']['available']}",
        f"branch: {data['git']['branch']}",
        f"head: {data['git']['head']}",
        f"dirty_count: {data['git']['dirty_count']}",
        "",
        "## Key Files",
    ]
    for row in data["key_files"]:
        marker = "ok" if row.get("exists") else "missing"
        lines.append(f"- {marker}: {row['path']}")
    if data["git"]["dirty_entries"]:
        lines.extend(["", "## Dirty Entries"])
        lines.extend(f"- {entry}" for entry in data["git"]["dirty_entries"])
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "汇总仓库整体健康状态：git 分支、脏文件数和关键文档指纹。\n"
            "当前 hook 主流程不维护运行态缓存，健康摘要不读取子代理生命周期记录。"
        ),
        epilog=(
            "典型用法：\n"
            "  python -B cockpit_health.py --format text\n\n"
            "规则真源：ops/policies/runtime-tools.md"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="json",
        help="输出格式：text 输出人类可读的文本摘要；json 输出机器可读的完整结构体。（默认：json）",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    data = build_data()
    return emit(data, args.format, build_text(data))


if __name__ == "__main__":
    raise SystemExit(main())
