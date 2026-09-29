#!/usr/bin/env python3
"""Prepare scope slicing evidence with Repomix before dispatch."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

from _tool_common import ROOT, ToolError, emit


ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
TOP_FILE_RE = re.compile(
    r"^\s*\d+\.\s+(?P<path>.+?)\s+"
    r"\((?P<tokens>[\d,]+)\s+tokens,\s+(?P<chars>[\d,]+)\s+chars"
)
TREE_ENTRY_RE = re.compile(
    r"^(?P<prefix>[\s│]*)[├└]──\s+(?P<path>.+?)\s+\((?P<tokens>[\d,]+)\s+tokens\)"
)
SUMMARY_RE = re.compile(r"^\s*(?P<label>Total Files|Total Tokens|Total Chars):\s+(?P<value>[\d,]+)")
DEFAULT_REPOMIX_VERSION = "1.16.0"


def npx_executable() -> str:
    for name in ("npx.cmd", "npx.exe", "npx"):
        found = shutil.which(name)
        if found:
            return found
    return "npx"


def clean_stdout(text: str) -> str:
    text = ANSI_RE.sub("", text)
    return "\n".join(line.rstrip() for line in text.splitlines())


def int_text(value: str) -> int:
    return int(value.replace(",", ""))


def tree_depth(prefix: str) -> int:
    return len(prefix.expandtabs(4)) // 4


def tree_full_path(stack: list[str], label: str) -> str:
    normalized = label.replace("\\", "/")
    has_trailing_slash = normalized.endswith("/")
    cleaned = normalized.strip("/")
    parent = stack[-1] if stack else ""
    if parent and cleaned and "/" not in cleaned:
        full = f"{parent}/{cleaned}"
    else:
        full = cleaned
    if has_trailing_slash and full and not full.endswith("/"):
        full += "/"
    return full or normalized.strip()


def parse_repomix_stdout(text: str) -> dict[str, Any]:
    clean = clean_stdout(text)
    top_files: list[dict[str, Any]] = []
    token_tree: list[dict[str, Any]] = []
    summary: dict[str, int] = {}
    tree_stack: list[str] = []
    for line in clean.splitlines():
        top_match = TOP_FILE_RE.match(line)
        if top_match:
            top_files.append(
                {
                    "path": top_match.group("path").strip(),
                    "tokens": int_text(top_match.group("tokens")),
                    "chars": int_text(top_match.group("chars")),
                }
            )
            continue
        tree_match = TREE_ENTRY_RE.match(line)
        if tree_match:
            depth = tree_depth(tree_match.group("prefix"))
            tree_stack = tree_stack[:depth]
            label = tree_match.group("path").strip()
            full_path = tree_full_path(tree_stack, label)
            stack_entry = full_path.rstrip("/")
            if stack_entry:
                tree_stack.append(stack_entry)
            token_tree.append(
                {
                    "path": full_path,
                    "tokens": int_text(tree_match.group("tokens")),
                }
            )
            continue
        summary_match = SUMMARY_RE.match(line)
        if summary_match:
            key = summary_match.group("label").lower().replace(" ", "_")
            summary[key] = int_text(summary_match.group("value"))
    return {"summary": summary, "top_files": top_files, "token_tree": token_tree, "stdout_clean": clean}


def target_path(value: str) -> str:
    path = Path(value)
    resolved = path if path.is_absolute() else (ROOT / path)
    return str(resolved)


def build_repomix_command(args: argparse.Namespace, output_path: Path) -> list[str]:
    cmd = [
        npx_executable(),
        f"repomix@{args.repomix_version}",
        "--style",
        "json",
        "--output",
        str(output_path),
        "--token-count-tree",
        str(args.token_count_tree),
        "--top-files-len",
        str(args.top_files_len),
        "--output-file-path-style",
        args.output_file_path_style,
    ]
    if not args.with_files:
        cmd.append("--no-files")
    if args.compress:
        cmd.append("--compress")
    if args.token_budget and args.with_files:
        cmd.extend(["--token-budget", str(args.token_budget)])
    for pattern in args.include:
        cmd.extend(["--include", pattern])
    for pattern in args.ignore:
        cmd.extend(["--ignore", pattern])
    cmd.extend(target_path(path) for path in args.path)
    return cmd


def run_command(cmd: list[str], timeout: int) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(ROOT),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise ToolError("npx executable not found; install Node.js/npm before using Repomix scope slicing") from exc
    except subprocess.TimeoutExpired as exc:
        raise ToolError(f"repomix timed out after {timeout}s") from exc
    return {
        "command": cmd,
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }


def read_repomix_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def first_segment(path: str) -> str:
    normalized = path.replace("\\", "/").strip("/")
    if not normalized:
        return "."
    return normalized.split("/", 1)[0]


def hot_dirs(top_files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, int]] = defaultdict(lambda: {"tokens": 0, "files": 0})
    for item in top_files:
        key = first_segment(str(item.get("path") or ""))
        grouped[key]["tokens"] += int(item.get("tokens") or 0)
        grouped[key]["files"] += 1
    return [
        {"path": key, "tokens": value["tokens"], "top_file_count": value["files"]}
        for key, value in sorted(grouped.items(), key=lambda entry: (-entry[1]["tokens"], entry[0]))
    ]


def slice_candidates(parsed: dict[str, Any], *, token_budget: int) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for item in parsed.get("token_tree") or []:
        tokens = int(item.get("tokens") or 0)
        reason = "over_token_budget" if token_budget and tokens > token_budget else "token_tree_hotspot"
        candidates.append({"path": item.get("path"), "estimated_tokens": tokens, "reason": reason})
    if candidates:
        return candidates
    for item in parsed.get("top_files") or []:
        candidates.append(
            {
                "path": item.get("path"),
                "estimated_tokens": int(item.get("tokens") or 0),
                "reason": "top_file_hotspot",
            }
        )
    return candidates


def build_recommendations(data: dict[str, Any], args: argparse.Namespace) -> list[str]:
    recommendations: list[str] = []
    summary = data.get("repomix_summary") or {}
    top_files = data.get("top_files") or []
    candidates = data.get("slice_candidates") or []
    total_tokens = int(summary.get("total_tokens") or 0)
    over_budget_candidates = [
        item for item in candidates if item.get("reason") == "over_token_budget"
    ]
    if args.token_budget and args.with_files and total_tokens > args.token_budget:
        recommendations.append("current packed output exceeds token budget; split before dispatch")
    if over_budget_candidates:
        recommendations.append("one or more token-tree entries exceed the candidate token budget")
    if top_files:
        recommendations.append("start slicing from top_files or hot_dirs instead of dispatching the root scope")
    if candidates:
        recommendations.append("turn slice_candidates into separate scope.read entries with non-overlapping conflict_keys")
    if args.with_files:
        recommendations.append("with_files was enabled; keep this output out of committed evidence unless contents are intended")
    if not recommendations:
        recommendations.append("scope looks small enough for normal dispatch preflight")
    return recommendations


def prepare_scope(args: argparse.Namespace) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="scope-slice-repomix-") as tmp:
        output_path = Path(tmp) / "repomix-output.json"
        cmd = build_repomix_command(args, output_path)
        run = run_command(cmd, args.timeout)
        parsed = parse_repomix_stdout(run["stdout"] + "\n" + run["stderr"])
        repomix_json = read_repomix_json(output_path)
        data: dict[str, Any] = {
            "status": "ok" if run["exit_code"] == 0 else "failed",
            "component": "ops/tools/scope_slice_prepare.py",
            "repomix_version": args.repomix_version,
            "paths": args.path,
            "resolved_paths": [target_path(path) for path in args.path],
            "include": args.include,
            "ignore": args.ignore,
            "compress": args.compress,
            "with_files": args.with_files,
            "token_budget": args.token_budget,
            "repomix_token_budget_applied": bool(args.token_budget and args.with_files),
            "token_count_tree_threshold": args.token_count_tree,
            "repomix_command": cmd,
            "repomix_exit_code": run["exit_code"],
            "repomix_summary": parsed["summary"],
            "top_files": parsed["top_files"],
            "hot_dirs": hot_dirs(parsed["top_files"]),
            "token_tree": parsed["token_tree"],
            "slice_candidates": slice_candidates(parsed, token_budget=args.token_budget),
            "directory_structure_available": bool(repomix_json.get("directoryStructure")),
            "stderr_tail": clean_stdout(run["stderr"])[-2000:],
        }
        data["recommendations"] = build_recommendations(data, args)
        if args.keep_stdout:
            data["repomix_stdout"] = parsed["stdout_clean"]
        return data


def self_test() -> dict[str, Any]:
    fixture = """
Top 2 Files by Token Count:
1.  tools/a.py (12,345 tokens, 50,000 chars, 50%)
2.  docs/b.md (678 tokens, 2,000 chars, 2%)

Token Count Tree:
Showing entries with 500+ tokens:
├── tools (12,345 tokens)
│   └── a.py (12,345 tokens)
└── docs (678 tokens)
    └── b.md (678 tokens)

Pack Summary:
  Total Files: 2 files
 Total Tokens: 13,023 tokens
  Total Chars: 52,000 chars
"""
    nested_fixture = """
Token Count Tree:
├── tools (10,000 tokens)
│   ├── a.py (6,000 tokens)
│   └── b.py (4,000 tokens)
└── docs (2,000 tokens)
"""
    parsed = parse_repomix_stdout(fixture)
    nested = parse_repomix_stdout(nested_fixture)
    checks = {
        "top_files_parsed": parsed["top_files"][0]["path"] == "tools/a.py",
        "top_file_tokens_parsed": parsed["top_files"][0]["tokens"] == 12345,
        "token_tree_parsed": parsed["token_tree"][3]["path"] == "docs/b.md",
        "nested_token_tree_child_parsed": nested["token_tree"][1]["path"] == "tools/a.py",
        "summary_parsed": parsed["summary"]["total_tokens"] == 13023,
        "hot_dirs_groups": hot_dirs(parsed["top_files"])[0]["path"] == "tools",
        "slice_candidates_from_tree": slice_candidates(parsed, token_budget=1000)[0]["reason"] == "over_token_budget",
    }
    return {"status": "ok" if all(checks.values()) else "failed", "checks": checks}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run Repomix as a dispatch preflight helper and emit token hotspots, "
            "hot directories, and slice candidates. This tool does not submit subagents."
        )
    )
    parser.add_argument("path", nargs="*", help="Scope root(s) to inspect. Relative paths resolve from repo root.")
    parser.add_argument("--include", action="append", default=[], help="Repomix include glob; repeatable.")
    parser.add_argument("--ignore", action="append", default=[], help="Repomix ignore glob; repeatable.")
    parser.add_argument(
        "--token-budget",
        type=int,
        default=0,
        help=(
            "Candidate token budget. With --with-files, also passes Repomix --token-budget; "
            "metadata-only mode uses it for slice candidate marking."
        ),
    )
    parser.add_argument("--token-count-tree", type=int, default=1000, help="Repomix token tree threshold.")
    parser.add_argument("--top-files-len", type=int, default=20, help="Number of top token files to report.")
    parser.add_argument("--repomix-version", default=DEFAULT_REPOMIX_VERSION, help="Repomix npm version to run.")
    parser.add_argument("--timeout", type=int, default=120, help="Repomix timeout in seconds.")
    parser.add_argument("--compress", action="store_true", help="Use Repomix Tree-sitter compression.")
    parser.add_argument("--with-files", action="store_true", help="Include file contents in Repomix output.")
    parser.add_argument(
        "--output-file-path-style",
        choices=("target-relative", "cwd-relative"),
        default="target-relative",
        help="Repomix file path style.",
    )
    parser.add_argument("--keep-stdout", action="store_true", help="Include cleaned Repomix stdout in JSON output.")
    parser.add_argument("--self-test", action="store_true", help="Run parser regression tests and exit.")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.self_test:
        data = self_test()
        text = f"status={data['status']} checks={sum(1 for v in data['checks'].values() if v)}/{len(data['checks'])}"
        return emit(data, args.format, text)
    if not args.path:
        raise ToolError("provide at least one scope path, or use --self-test")
    data = prepare_scope(args)
    top = data["top_files"][:5]
    text_lines = [
        f"status={data['status']} repomix_exit_code={data['repomix_exit_code']}",
        f"paths={', '.join(data['paths'])}",
        f"summary={data['repomix_summary']}",
    ]
    if top:
        text_lines.append("top_files:")
        text_lines.extend(f"- {item['path']} ({item['tokens']} tokens)" for item in top)
    if data["slice_candidates"]:
        text_lines.append("slice_candidates:")
        text_lines.extend(
            f"- {item['path']} ({item['estimated_tokens']} tokens, {item['reason']})"
            for item in data["slice_candidates"][:10]
        )
    text_lines.append("recommendations:")
    text_lines.extend(f"- {item}" for item in data["recommendations"])
    return emit(data, args.format, "\n".join(text_lines))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ToolError, KeyError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
