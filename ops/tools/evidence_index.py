#!/usr/bin/env python3
"""List recent evidence files from approved evidence directories."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

from _tool_common import ROOT, ToolError, emit, file_fingerprint, rel


DEFAULT_DIRS = ["notes", "docs", ".planning"]
SKIP_PARTS = {"archive", ".git", "__pycache__"}


def iter_files(roots: list[str], keyword: str | None) -> list[Path]:
    files: list[Path] = []
    default_roots = roots == DEFAULT_DIRS
    for item in roots:
        base = ROOT / item
        if not base.exists():
            if default_roots:
                continue
            raise ToolError(f"evidence root not found: {item}")
        if not base.is_dir():
            raise ToolError(f"evidence root is not a directory: {item}")
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            rel_parts = set(path.relative_to(ROOT).parts)
            if rel_parts & SKIP_PARTS:
                continue
            if keyword and keyword.lower() not in rel(path).lower():
                continue
            files.append(path)
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def build_data(args: argparse.Namespace) -> dict[str, Any]:
    roots = args.root or DEFAULT_DIRS
    files = iter_files(roots, args.keyword)
    selected = files[: args.limit]
    return {
        "tool": "evidence_index",
        "status": "pass",
        "exit_code": 0,
        "roots": roots,
        "keyword": args.keyword,
        "limit": args.limit,
        "total_matched": len(files),
        "files": [file_fingerprint(path) for path in selected],
    }


def build_text(data: dict[str, Any]) -> str:
    lines = [
        "# Evidence Index",
        "",
        f"status: {data['status']}",
        f"roots: {', '.join(data['roots'])}",
        f"keyword: {data['keyword'] or 'none'}",
        f"total_matched: {data['total_matched']}",
        "",
        "## Files",
    ]
    if data["files"]:
        for row in data["files"]:
            lines.append(f"- {row['mtime_iso']} | {row['size']} bytes | {row['path']}")
    else:
        lines.append("- none")
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "按修改时间倒序列出证据目录下的文件，供代理快速定位最新 notes / docs / 计划产物。\n"
            "主代理在派发前或事实收集阶段调用，了解仓库内已有哪些参考文件。"
        ),
        epilog=(
            "典型用法：\n"
            "  python -B evidence_index.py --keyword alignment --limit 10 --format text\n\n"
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
    parser.add_argument(
        "--limit",
        type=int,
        default=30,
        help="最多返回多少个文件（按修改时间从新到旧排序后截取前 N 个）。必须 >= 1。（默认：30）",
    )
    parser.add_argument(
        "--keyword",
        help="路径过滤关键词（大小写不敏感）；只返回相对路径中包含该关键词的文件。留空则返回全部文件。",
    )
    parser.add_argument(
        "--root",
        action="append",
        help="要扫描的证据根目录（相对于仓库根），可多次指定。默认扫描 notes、docs、.planning 三个目录。",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.limit < 1:
        raise SystemExit("limit must be >= 1")
    data = build_data(args)
    return emit(data, args.format, build_text(data))


if __name__ == "__main__":
    raise SystemExit(main())
