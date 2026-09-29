#!/usr/bin/env python3
"""Check that workflow handoff references resolve under the active repo root."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

sys.dont_write_bytecode = True

from _tool_common import ROOT, RUNTIME_ROOT, ToolError, emit, rel


WINDOWS_ABS_RE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]:(?:\\|/(?!/))[^\s`\"'<>|、，。；]+")
RELATIVE_REF_RE = re.compile(
    r"(?<![A-Za-z0-9_./\\])(?:(?:ops|\.planning|notes|refs|outputs|test-results|artifacts|work|scripts|tools)"
    r"[\\/][^\s`\"'<>|、，。；]+|(?:AGENTS|PROJECT|STATUS|ROADMAP)\.md)"
)
TRAILING_CHARS = ".,;:)]}\"'"


@dataclass(frozen=True)
class RefToken:
    source: Path
    line: int
    raw: str
    token: str
    kind: str


def normalize_slashes(value: str) -> str:
    return value.replace("\\", "/")


def strip_current_dir_prefix(value: str) -> str:
    normalized = normalize_slashes(value)
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def clean_token(value: str) -> str:
    token = value.strip().strip("`\"'")
    while token and token[-1] in TRAILING_CHARS:
        token = token[:-1]
    token = re.sub(r":\d+$", "", token)
    # 审查 location 的 file.md:章节 后缀与 fragment 一样不属于文件路径；不吞路径分隔符。
    token = re.sub(r"(?<=\.md):[^/\\]+$", "", token)
    if "#" in token and not re.match(r"^[A-Za-z]:", token):
        token = token.split("#", 1)[0]
    return token.strip()


def is_placeholder(token: str) -> bool:
    return (
        not token
        or token.endswith(("/", "\\"))
        or "<" in token
        or ">" in token
        or "*" in token
        or "${" in token
        or token.startswith(("http://", "https://"))
    )


def extract_tokens(source: Path, text: str) -> list[RefToken]:
    tokens: list[RefToken] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        absolute_spans: list[tuple[int, int]] = []
        for match in WINDOWS_ABS_RE.finditer(line):
            absolute_spans.append(match.span())
            token = clean_token(match.group(0))
            if not is_placeholder(token):
                tokens.append(RefToken(source, line_number, match.group(0), token, "windows_absolute"))
        for match in RELATIVE_REF_RE.finditer(line):
            if any(match.start() >= start and match.end() <= end for start, end in absolute_spans):
                continue
            token = clean_token(match.group(0))
            if not is_placeholder(token):
                tokens.append(RefToken(source, line_number, match.group(0), token, "relative"))
    return tokens


def add_issue(
    issues: list[dict[str, Any]],
    code: str,
    token: RefToken | None,
    message: str,
    *,
    resolved: Path | None = None,
) -> None:
    item: dict[str, Any] = {"code": code, "message": message}
    if token is not None:
        item.update(
            {
                "source": rel(token.source),
                "line": token.line,
                "token": token.token,
                "kind": token.kind,
            }
        )
    if resolved is not None:
        item["resolved"] = rel(resolved)
    issues.append(item)


def source_is_under_refs(source: Path) -> bool:
    try:
        source.resolve().relative_to((ROOT / "refs").resolve())
        return True
    except (OSError, ValueError):
        return False


def under_root(path: Path) -> bool:
    try:
        path.resolve().relative_to(ROOT.resolve())
        return True
    except (OSError, ValueError):
        return False


def declared_runtime_reference(token: str, resolved: Path) -> bool:
    """仅放行 marker 对应 inventory 中已声明挂载和文件的只读引用。"""
    try:
        marker = json.loads((ROOT / ".pi/control-plane-consumer.json").read_text(encoding="utf-8"))
        inventory = json.loads((RUNTIME_ROOT / "consumer-release-manifest.json").read_text(encoding="utf-8"))
        if (Path(marker["project_root"]).resolve() != ROOT.resolve()
                or Path(marker["runtime_root"]).resolve() != RUNTIME_ROOT.resolve()
                or marker["build_id"] != inventory["build_id"]):
            return False
        relative = resolved.relative_to(RUNTIME_ROOT.resolve()).as_posix()
        if not any(item["target"] == relative or item["target"].startswith(relative + "/")
                   for item in inventory["files"]):
            return False
        for mount in inventory["resource_mounts"]:
            try:
                tail = Path(token).relative_to(mount["project_path"])
            except ValueError:
                continue
            if resolved == (RUNTIME_ROOT / mount["runtime_path"] / tail).resolve():
                return True
    except (OSError, ValueError, KeyError, TypeError):
        return False
    return False


def reject_prefix_match(token: str, prefixes: list[str]) -> str | None:
    normalized = strip_current_dir_prefix(token)
    for prefix in prefixes:
        normalized_prefix = strip_current_dir_prefix(prefix).strip("/")
        if normalized == normalized_prefix or normalized.startswith(normalized_prefix + "/"):
            return prefix
    return None


def check_token(
    token: RefToken,
    *,
    forbid_roots: list[str],
    reject_prefixes: list[str],
    allow_absolute: bool,
    issues: list[dict[str, Any]],
) -> dict[str, Any]:
    checked: dict[str, Any] = {
        "source": rel(token.source),
        "line": token.line,
        "token": token.token,
        "kind": token.kind,
        "status": "pass",
    }

    lowered = normalize_slashes(token.token).lower()
    for forbidden in forbid_roots:
        if normalize_slashes(forbidden).lower() in lowered:
            add_issue(
                issues,
                "forbidden_root_reference",
                token,
                f"reference contains forbidden root: {forbidden}",
            )
            checked["status"] = "fail"
            return checked

    if token.kind == "windows_absolute":
        resolved = Path(token.token)
        checked["resolved"] = str(resolved)
        if not allow_absolute:
            add_issue(
                issues,
                "absolute_reference_not_allowed",
                token,
                "absolute references are not allowed in active dispatch/planning refs",
                resolved=resolved,
            )
            checked["status"] = "fail"
            return checked
        if not resolved.exists():
            add_issue(issues, "absolute_reference_missing", token, "absolute reference does not exist", resolved=resolved)
            checked["status"] = "fail"
        return checked

    prefix = reject_prefix_match(token.token, reject_prefixes)
    if prefix is not None:
        add_issue(
            issues,
            "rejected_reference_prefix",
            token,
            f"reference uses rejected prefix: {prefix}",
        )
        checked["status"] = "fail"
        return checked

    normalized_token = strip_current_dir_prefix(token.token)
    resolved = (ROOT / normalized_token).resolve()
    checked["resolved"] = rel(resolved)
    if not under_root(resolved) and not declared_runtime_reference(normalized_token, resolved):
        add_issue(issues, "reference_escapes_root", token, "relative reference escapes active root", resolved=resolved)
        checked["status"] = "fail"
        return checked

    if resolved.exists():
        return checked

    shadow = (ROOT / "refs" / normalized_token).resolve()
    if source_is_under_refs(token.source) and shadow.exists():
        add_issue(
            issues,
            "reference_only_shadow",
            token,
            "reference only resolves under refs/ archive, not under active root",
            resolved=shadow,
        )
    else:
        add_issue(issues, "relative_reference_missing", token, "relative reference does not exist under active root", resolved=resolved)
    checked["status"] = "fail"
    return checked


def read_source(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ToolError(f"source not found: {rel(path)}") from exc
    except OSError as exc:
        raise ToolError(f"cannot read source: {rel(path)}") from exc


def check_sources(
    sources: list[Path],
    *,
    forbid_roots: list[str],
    reject_prefixes: list[str],
    allow_absolute: bool,
) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    checked_refs: list[dict[str, Any]] = []

    for source in sources:
        source_path = source if source.is_absolute() else ROOT / source
        text = read_source(source_path)
        tokens = extract_tokens(source_path, text)
        for token in tokens:
            checked_refs.append(
                check_token(
                    token,
                    forbid_roots=forbid_roots,
                    reject_prefixes=reject_prefixes,
                    allow_absolute=allow_absolute,
                    issues=issues,
                )
            )

    return {
        "status": "failed" if issues else "pass",
        "root": str(ROOT),
        "sources": [rel((source if source.is_absolute() else ROOT / source).resolve()) for source in sources],
        "checked_count": len(checked_refs),
        "checked_refs": checked_refs,
        "issues": issues,
    }


def text_report(data: dict[str, Any]) -> str:
    lines = [
        f"reference_resolution_check: {data['status']}",
        f"root: {data['root']}",
        f"sources: {len(data['sources'])}",
        f"checked_refs: {data['checked_count']}",
    ]
    issues = data.get("issues") or []
    if issues:
        lines.append("issues:")
        for item in issues:
            location = f"{item.get('source', '?')}:{item.get('line', '?')}"
            token = item.get("token", "")
            resolved = item.get("resolved")
            suffix = f" -> {resolved}" if resolved else ""
            lines.append(f"- {item['code']} {location} `{token}`{suffix}: {item['message']}")
    return "\n".join(lines)


def run_self_test() -> dict[str, Any]:
    refs_case_dir = ROOT / "refs" / "tmp-reference-resolution-check-self-test"
    shadow_dir = ROOT / "refs" / "notes" / "reference-resolution-check-self-test"
    try:
        with TemporaryDirectory(prefix="reference-resolution-check-", dir=str(ROOT)) as temp_dir:
            temp = Path(temp_dir)
            good = temp / "good.md"
            good.write_text("Refs: PROJECT.md and ops/tools/_tool_common.py\n", encoding="utf-8")

            missing = temp / "missing.md"
            missing.write_text("Missing: .planning/not-here.md\n", encoding="utf-8")

            stale = temp / "stale.md"
            stale.write_text(r"Old root: C:\old-codex-workspace\notes\bad.md" + "\n", encoding="utf-8")

            refs_case_dir.mkdir(parents=True, exist_ok=True)
            shadow_dir.mkdir(parents=True, exist_ok=True)
            shadow_file = shadow_dir / "marker.md"
            shadow_file.write_text("shadow only\n", encoding="utf-8")
            shadow_source = refs_case_dir / "sample.md"
            shadow_source.write_text("Shadow: notes/reference-resolution-check-self-test/marker.md\n", encoding="utf-8")

            locations = temp / "locations.md"
            locations.write_text(
                "ops/protocols/subagent-information-injection.md:§3(5), "
                "ops/protocols/subagent-information-injection.md:§5 "
                "ops/protocols/task-package-routes/semantic-review-agent__rule-quality-inspection.md:构包要点\n"
                "ops/model-notes.toml、APPEND_SYSTEM，PROJECT.md。 外部包dist/core/tools/read.js\n",
                encoding="utf-8",
            )
            cases = {
                "markdown_section_locations": check_sources([locations], forbid_roots=[], reject_prefixes=[], allow_absolute=False),
                "good": check_sources([good], forbid_roots=[], reject_prefixes=[], allow_absolute=False),
                "missing": check_sources([missing], forbid_roots=[], reject_prefixes=[], allow_absolute=False),
                "stale": check_sources([stale], forbid_roots=["old-codex-workspace"], reject_prefixes=[], allow_absolute=False),
                "shadow": check_sources([shadow_source], forbid_roots=[], reject_prefixes=[], allow_absolute=False),
            }
    finally:
        shutil.rmtree(refs_case_dir, ignore_errors=True)
        shutil.rmtree(shadow_dir, ignore_errors=True)

    expectations = {
        "markdown_section_locations": "pass",
        "good": "pass",
        "missing": "failed",
        "stale": "failed",
        "shadow": "failed",
    }
    failures = [
        f"{name}: expected {expected}, got {cases[name]['status']}"
        for name, expected in expectations.items()
        if cases[name]["status"] != expected
    ]
    return {
        "status": "failed" if failures else "pass",
        "root": str(ROOT),
        "sources": [src for case in cases.values() for src in case["sources"]],
        "checked_count": sum(case["checked_count"] for case in cases.values()),
        "cases": cases,
        "issues": [{"code": "self_test_failure", "message": item} for item in failures],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", action="append", default=[], help="source file to scan; repeatable")
    parser.add_argument("--forbid-root", action="append", default=[], help="substring/path that must not appear in references")
    parser.add_argument("--reject-prefix", action="append", default=[], help="relative path prefix to reject, e.g. refs")
    parser.add_argument("--allow-absolute", action="store_true", help="allow absolute paths when they exist")
    parser.add_argument("--self-test", action="store_true", help="run built-in fixture checks")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.self_test:
            data = run_self_test()
            return emit(data, args.format, text_report({"status": data["status"], "root": data["root"], "sources": data["sources"], "checked_count": data["checked_count"], "issues": data["issues"]}))
        if not args.source:
            raise ToolError("--source is required unless --self-test is used")
        data = check_sources(
            [Path(item) for item in args.source],
            forbid_roots=args.forbid_root,
            reject_prefixes=args.reject_prefix,
            allow_absolute=args.allow_absolute,
        )
        return emit(data, args.format, text_report(data))
    except ToolError as exc:
        data = {"status": "error", "message": str(exc)}
        return emit(data, args.format, f"reference_resolution_check: error\n{exc}")


if __name__ == "__main__":
    raise SystemExit(main())
