#!/usr/bin/env python3
"""Summarize the current git worktree without changing it.

默认模式是只读快照：分支名、脏文件总数、staged / unstaged / untracked 列表与目录分组。

`--closeout-task DIR` 进入普通任务收口预览：从任务目录的 task.json / status.json /
task-package.json、task-result.json（结构化结果）或 FINAL_HANDOFF 回执（兼容手写 YAML）提取
实际 written / deleted、业务 report / handoff、commit_msg_draft 与 evidence_refs，核对声明写域
与当前 Git 状态，产出候选清单、证据归档计划和缺口。预览只读：不写 index、不复制文件。

`--save-plan PATH` 落盘预览计划；`--apply-plan PATH --decision accept` 才按计划把任务 artifacts
内被 evidence_refs 直接引用的证据复制到 notes/verify/evidence/task-closeout/<task_id>/，并按精确
文件名清单一次暂存；`--decision rework|needs_owner` 只投影下一步，不改变暂存与业务文件。本工具不执行
commit / push，不清除其他暂存，不修改原任务状态，也不把写域清单当暂存清单。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

from _tool_common import (
    ROOT,
    ToolError,
    atomic_write_bytes,
    emit,
    load_yaml,
    normalize_conflict_path,
    path_conflict,
    rel,
    run_git,
    status_lines,
    utc_now,
)

CLOSEOUT_DECISIONS = ("accept", "rework", "needs_owner")
CLOSEOUT_EVIDENCE_ROOT = "notes/verify/evidence/task-closeout"
PLAN_MODE = "closeout-preview"
PLAN_VERSION = 1
# 路径参数一律按字面量处理：模型给的文件名可能含 *、?、[，不能当 Git 模式解释。
LITERAL_PATHSPECS = "--literal-pathspecs"
TASK_SOURCE_NAMES = ("task.json", "status.json", "task-package.json", "task-result.json", "handoff.md")
COMMAND_REF_PREFIXES = ("command:", "cmd:", "bash:", "shell:", "$ ")
EVIDENCE_SKIP_NAMES = {".env", "credentials", "credentials.json", "id_rsa", "id_ed25519"}
EVIDENCE_SKIP_SUFFIXES = {".key", ".pem", ".pfx", ".p12"}
MAX_DETAIL = 200


# ---------- 默认只读快照（行为不变） ----------


def parse_status(lines: list[str]) -> dict[str, Any]:
    rows: list[dict[str, str]] = []
    groups: Counter[str] = Counter()
    staged: list[str] = []
    unstaged: list[str] = []
    untracked: list[str] = []

    for line in lines:
        if len(line) < 4:
            raise ToolError(f"invalid git status line: {line!r}")
        code = line[:2]
        path = line[3:] if len(line) > 3 else ""
        if not path:
            raise ToolError(f"missing path in git status line: {line!r}")
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        first = path.split("/", 1)[0] if path else "(root)"
        groups[first] += 1
        row = {"code": code, "path": path}
        rows.append(row)
        if code == "??":
            untracked.append(path)
            continue
        if code[0] != " ":
            staged.append(path)
        if code[1] != " ":
            unstaged.append(path)

    return {
        "dirty": bool(rows),
        "total": len(rows),
        "staged": staged,
        "unstaged": unstaged,
        "untracked": untracked,
        "groups": dict(sorted(groups.items())),
        "entries": rows,
    }


def build_text(data: dict[str, Any]) -> str:
    checkpoint = data["checkpoint"]
    lines = [
        "# Git Checkpoint",
        "",
        f"status: {data['status']}",
        f"branch: {data['branch']}",
        f"total_changes: {checkpoint['total']}",
        f"staged: {len(checkpoint['staged'])}",
        f"unstaged: {len(checkpoint['unstaged'])}",
        f"untracked: {len(checkpoint['untracked'])}",
        "",
        "## Groups",
    ]
    if checkpoint["groups"]:
        for key, count in checkpoint["groups"].items():
            lines.append(f"- {key}: {count}")
    else:
        lines.append("- none")
    lines.extend(["", "## Entries"])
    if checkpoint["entries"]:
        for row in checkpoint["entries"]:
            lines.append(f"- {row['code']} {row['path']}")
    else:
        lines.append("- none")
    return "\n".join(lines) + "\n"


# ---------- 收口预览与应用 ----------


def git_raw(args: list[str], data: bytes | None = None) -> dict[str, Any]:
    """在 ROOT 运行 git 并保留 stdout 字节：porcelain -z 的文件名不能被本地代码页解码。"""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(ROOT),
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ToolError("git executable not found") from exc
    return {
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": os.fsdecode(proc.stderr).strip(),
    }


def git_checked(args: list[str], label: str) -> bytes:
    result = git_raw(args)
    if result["exit_code"] != 0:
        raise ToolError(f"{label} failed: {short_detail(result['stderr']) or result['exit_code']}")
    return result["stdout"]


def git_path(args: list[str], path: str) -> dict[str, Any]:
    return git_raw([LITERAL_PATHSPECS, *args, "--", path])


def short_detail(value: Any) -> str:
    text = str(value or "").strip().replace("\n", " ")
    return text[:MAX_DETAIL]


def split_z(raw: bytes) -> list[str]:
    return [os.fsdecode(item) for item in raw.split(b"\0") if item]


def status_records() -> list[dict[str, str]]:
    parts = git_checked(
        ["status", "--porcelain", "-z", "--untracked-files=all"], "git status"
    ).split(b"\0")
    rows: list[dict[str, str]] = []
    index = 0
    while index < len(parts):
        chunk = parts[index]
        index += 1
        if not chunk:
            continue
        if len(chunk) < 4:
            raise ToolError(f"invalid git status record: {os.fsdecode(chunk)!r}")
        code = os.fsdecode(chunk[:2])
        path = os.fsdecode(chunk[3:])
        if code[0] in ("R", "C") and index < len(parts) and parts[index]:
            index += 1  # 重命名/复制记录后面跟原始路径
        rows.append({"code": code, "path": path})
    return rows


def status_map(rows: list[dict[str, str]]) -> dict[str, dict[str, bool]]:
    states: dict[str, dict[str, bool]] = {}
    for row in rows:
        entry = states.setdefault(row["path"], {"staged": False, "unstaged": False, "untracked": False})
        if row["code"] == "??":
            entry["untracked"] = True
            continue
        if row["code"][0] != " ":
            entry["staged"] = True
        if row["code"][1] != " ":
            entry["unstaged"] = True
    return states


def classify_path(
    path: str, states: dict[str, dict[str, bool]], exists: bool, ignored: bool = False
) -> str:
    if ignored:
        return "ignored"
    entry = states.get(path)
    if entry is None:
        return "clean" if exists else "missing"
    if entry["untracked"]:
        return "untracked"
    if entry["staged"] and entry["unstaged"]:
        return "partial-staged"
    if entry["staged"]:
        return "staged"
    if not exists:
        return "deleted"
    return "modified"


def head_commit() -> str:
    return os.fsdecode(git_checked(["rev-parse", "HEAD"], "git rev-parse HEAD")).strip()


def branch_name() -> str:
    return os.fsdecode(git_checked(["branch", "--show-current"], "git branch")).strip() or "(detached)"


def index_blob(path: str) -> str | None:
    result = git_path(["ls-files", "-s"], path)
    if result["exit_code"] != 0 or not result["stdout"]:
        return None
    fields = os.fsdecode(result["stdout"]).split("\n", 1)[0].strip().split()
    return fields[1] if len(fields) >= 2 else None


def is_ignored(path: str) -> bool:
    # check-ignore 不支持 literal pathspec 魔法，改用 --stdin：路径按名字读入，不当 Git 模式。
    try:
        proc = subprocess.run(
            ["git", "check-ignore", "-q", "-z", "--stdin"],
            cwd=str(ROOT),
            input=os.fsencode(path) + b"\0",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ToolError("git executable not found") from exc
    if proc.returncode == 0:
        return True
    if proc.returncode == 1:
        return False
    raise ToolError(
        f"git check-ignore failed: {short_detail(os.fsdecode(proc.stderr)) or proc.returncode}"
    )


def staged_paths() -> set[str]:
    return set(split_z(git_checked(["diff", "--cached", "--name-only", "-z"], "git diff --cached")))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            items.append(item.strip())
        elif isinstance(item, dict) and len(item) == 1:
            # 手写 YAML 里 `- command: ...` 会被解析成单键映射，还原成文本继续消费。
            key, body = next(iter(item.items()))
            if isinstance(key, str) and isinstance(body, str) and body.strip():
                items.append(f"{key.strip()}: {body.strip()}")
    return items


def object_field(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def read_json_object(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ToolError(f"invalid json: {rel(path)}: {short_detail(exc)}") from exc
    return data if isinstance(data, dict) else None


def cli_path(value: str, label: str) -> Path:
    """CLI 给的路径必须落在项目根内；仓外路径直接短错误。"""
    raw = str(value or "").strip()
    if not raw:
        raise ToolError(f"{label} must not be empty")
    candidate = Path(raw)
    resolved = candidate.resolve() if candidate.is_absolute() else (ROOT / raw).resolve()
    try:
        resolved.relative_to(ROOT.resolve())
    except ValueError as exc:
        raise ToolError(f"{label} escapes the project root: {raw}") from exc
    return resolved


def extract_handoff_block(text: str) -> str | None:
    lines = text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip().rstrip(":").strip() == "FINAL_HANDOFF":
            start = index
            break
    if start is None:
        return None
    body: list[str] = []
    for line in lines[start + 1 :]:
        stripped = line.strip()
        if stripped.startswith("```"):
            break
        if stripped and not line[:1].isspace():
            break  # 回执块结束：下一段非缩进正文或标题
        body.append(line)
    return "\n".join(body).rstrip() or None


def parse_yaml_mapping(text: str, label: str) -> dict[str, Any]:
    try:
        import yaml
    except ImportError as exc:
        raise ToolError("PyYAML is required to read handoff yaml") from exc
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ToolError(f"invalid handoff yaml: {label}: {short_detail(exc)}") from exc
    if not isinstance(data, dict):
        raise ToolError(f"handoff yaml root is not mapping: {label}")
    return data


def read_handoff_payload(path: Path) -> dict[str, Any] | None:
    """读 FINAL_HANDOFF：规范回执先整文件复用 load_yaml，手写回执再按块提取。"""
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise ToolError(f"cannot read handoff file: {rel(path)}: {short_detail(exc)}") from exc
    if not text.strip():
        return None
    if text.lstrip().startswith("FINAL_HANDOFF"):
        try:
            data = load_yaml(path, label="handoff")
        except ToolError:
            data = None
        body = object_field(data.get("FINAL_HANDOFF")) if data else {}
        if body:
            return body
    block = extract_handoff_block(text)
    if block is None:
        return None
    return parse_yaml_mapping(block, rel(path))


def resolve_reference(value: str, task_dir: Path) -> Path | None:
    """证据引用先按项目根解析，再退回任务目录；都不在根内时返回 None。"""
    raw = str(value or "").strip().replace("\\", "/")
    if not raw:
        return None
    candidate = Path(raw)
    resolved = candidate.resolve() if candidate.is_absolute() else (ROOT / raw).resolve()
    inside = resolved if _inside_root(resolved) else None
    if inside is not None and inside.exists():
        return inside
    if not candidate.is_absolute():
        alternative = (task_dir / raw).resolve()
        if _inside_root(alternative) and alternative.exists():
            return alternative
    return inside


def _inside_root(path: Path) -> bool:
    try:
        path.relative_to(ROOT.resolve())
    except ValueError:
        return False
    return True


def strip_line_suffix(value: str) -> str:
    """`path:1384` 形式的行引用回退到文件本身；Windows 盘符不会被误剥。"""
    head, separator, tail = value.rpartition(":")
    if separator and tail.isdigit() and head and not head.endswith(":") and len(head) > 1:
        return head
    return value


def is_sensitive_evidence(path: Path) -> bool:
    name = path.name.casefold()
    if name in EVIDENCE_SKIP_NAMES or name.startswith(".env"):
        return True
    if path.suffix.casefold() in EVIDENCE_SKIP_SUFFIXES:
        return True
    return "credential" in name or "secret" in name


def task_source_files(task_dir: Path) -> list[Path]:
    return [task_dir / name for name in TASK_SOURCE_NAMES if (task_dir / name).is_file()]


def task_fingerprint(files: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(rel(path).encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def task_fingerprint_now(task: dict[str, Any]) -> str:
    files = task_source_files(cli_path(task["task_dir"], "task directory"))
    files.extend(cli_path(item, "task source") for item in task["sources"])
    return task_fingerprint(sorted({path for path in files if path.is_file()}))


def find_handoff_payload(task_dir: Path, task_json: dict[str, Any], package: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    contract = object_field(package.get("handoff_contract"))
    candidates: list[str] = ["handoff.md"]
    for value in (
        task_json.get("handoff_path"),
        contract.get("resolved_handoff_file"),
        contract.get("handoff_file"),
    ):
        if isinstance(value, str) and value.strip():
            candidates.append(value.strip())
    seen: set[str] = set()
    for value in candidates:
        resolved = resolve_reference(value, task_dir)
        key = str(resolved) if resolved is not None else value
        if key in seen:
            continue
        seen.add(key)
        if resolved is None or not resolved.is_file():
            continue
        payload = read_handoff_payload(resolved)
        if payload:
            return payload, rel(resolved)
    return {}, None


def collect_task(task_dir: Path) -> dict[str, Any]:
    if not task_dir.is_dir():
        raise ToolError(f"closeout task directory not found: {rel(task_dir)}")
    sources = task_source_files(task_dir)
    if not sources:
        raise ToolError(
            f"closeout task directory has no task.json / task-package.json / handoff.md: {rel(task_dir)}"
        )
    task_json = read_json_object(task_dir / "task.json") or {}
    status_json = read_json_object(task_dir / "status.json") or {}
    package = read_json_object(task_dir / "task-package.json") or {}
    package = object_field(package.get("task_package")) or package
    submission = read_json_object(task_dir / "task-result.json") or {}
    result = object_field(submission.get("result"))
    handoff, handoff_source = find_handoff_payload(task_dir, task_json, package)

    task_id = task_json.get("task_id")
    if not isinstance(task_id, str) or not task_id or task_id in (".", "..") or any(c in task_id for c in '/\\:'):
        raise ToolError("task.json requires a safe task_id")
    if status_json.get("task_id") != task_id:
        raise ToolError("status.json task_id missing or mismatched")
    if status_json.get("state") not in ("done", "failed", "cancelled", "completed"):
        raise ToolError(f"task is not terminal: {task_id}: {status_json.get('state')}")
    if not (result.get("verdict") or handoff.get("verdict")):
        raise ToolError(f"task result verdict missing: {task_id}")
    if not (package.get("package_id") or task_json.get("package_id")):
        raise ToolError(f"task package_id missing: {task_id}")
    if handoff_source:
        sources = sorted(set(sources + [cli_path(handoff_source, "handoff source")]))

    # 结构化结果优先；历史手写 FINAL_HANDOFF 兜底。
    result_source = "task-result.json" if result else ("handoff" if handoff else "none")
    scope_actual = object_field(result.get("scope_actual")) or object_field(handoff.get("scope_actual"))
    output = object_field(result.get("output")) or object_field(handoff.get("output"))
    written = string_list(scope_actual.get("written"))
    deleted = string_list(scope_actual.get("deleted"))
    evidence_refs = string_list(result.get("evidence_refs")) or string_list(handoff.get("evidence_refs"))

    expected = object_field(package.get("expected_output"))
    contract = object_field(package.get("handoff_contract"))
    declared: list[str] = []
    for value in (
        submission.get("report_path"),
        output.get("file_path"),
        output.get("resolved_file_path"),
        expected.get("file_path"),
        expected.get("resolved_file_path"),
        submission.get("handoff_path"),
        output.get("handoff_file"),
        output.get("resolved_handoff_file"),
        contract.get("handoff_file"),
        contract.get("resolved_handoff_file"),
    ):
        if isinstance(value, str) and value.strip():
            declared.append(value.strip())

    scope = object_field(package.get("scope"))
    domain: list[str] = []
    for value in (
        string_list(task_json.get("write_domain_paths"))
        + string_list(task_json.get("write_domain_delete_paths"))
        + string_list(scope.get("write"))
        + string_list(scope.get("delete"))
    ):
        normalized = normalize_conflict_path(value)
        if normalized and not normalized.startswith("external:"):
            domain.append(normalized)

    commit_msg_draft = output.get("commit_msg_draft")
    return {
        "task_id": task_id,
        "task_dir": rel(task_dir),
        "package_id": package.get("package_id") or task_json.get("package_id"),
        "verdict": result.get("verdict") or handoff.get("verdict"),
        "result_source": result_source,
        "handoff_source": handoff_source,
        "rev": status_json.get("rev"),
        "state": status_json.get("state"),
        "fingerprint": task_fingerprint(sources),
        "sources": [rel(path) for path in sources],
        "written": written,
        "deleted": deleted,
        "declared": declared,
        "evidence_refs": evidence_refs,
        "write_domain": sorted(set(domain)),
        "commit_msg_draft": commit_msg_draft if isinstance(commit_msg_draft, str) else None,
        "summary": result.get("summary") or handoff.get("summary"),
    }


def add_candidate(
    registry: dict[str, dict[str, Any]],
    order: list[dict[str, Any]],
    gaps: list[dict[str, str]],
    value: str,
    source: str,
    kind: str,
    task: dict[str, Any] | None,
) -> dict[str, Any] | None:
    text = str(value or "").strip()
    if not text:
        return None
    normalized = normalize_conflict_path(text)
    if not normalized:
        return None
    if normalized.startswith("external:") or not _inside_root((ROOT / normalized).resolve()):
        # 越界候选不进入暂存清单，但必须作为缺口显式返回，不静默丢弃。
        gaps.append(
            {
                "kind": "outside-project-root",
                "subject": text,
                "detail": f"{source} 声明的路径不在项目根内",
            }
        )
        return None
    entry = registry.get(normalized)
    if entry is None:
        entry = {
            "path": normalized,
            "kind": kind,
            "sources": [],
            "tasks": [],
        }
        registry[normalized] = entry
        order.append(entry)
    if source not in entry["sources"]:
        entry["sources"].append(source)
    if kind == "delete":
        entry["kind"] = "delete"
    if task is not None and task["task_id"] not in entry["tasks"]:
        entry["tasks"].append(task["task_id"])
    return entry


def ignored_worktree_path(path: str) -> bool:
    return is_ignored(path) and (
        (ROOT / path).is_dir() or is_ignored(str(Path(path).parent))
    )


def build_evidence_plan(
    task: dict[str, Any], task_dir: Path, declared_paths: set[str], skipped: list[dict[str, str]]
) -> list[dict[str, Any]]:
    artifacts_dir = (task_dir / "artifacts").resolve()
    entries: list[dict[str, Any]] = []
    for ref in task["evidence_refs"]:
        lowered = ref.casefold()
        if lowered.startswith(COMMAND_REF_PREFIXES):
            skipped.append({"ref": ref, "reason": "command-reference"})
            continue
        path_text = strip_line_suffix(ref)
        resolved = resolve_reference(path_text, task_dir)
        if resolved is None:
            skipped.append({"ref": ref, "reason": "outside-project-root"})
            continue
        if str(resolved) in declared_paths:
            skipped.append({"ref": ref, "reason": "durable-artifact"})
            continue
        try:
            relative = resolved.relative_to(artifacts_dir)
        except ValueError:
            project_path = normalize_conflict_path(str(resolved))
            if (project_path.startswith("external:") or not ignored_worktree_path(project_path)
                    or not any(path_conflict(project_path, item) for item in task["write_domain"])):
                skipped.append({"ref": ref, "reason": "not-task-artifact"})
                continue
            source_id = hashlib.sha256(project_path.encode("utf-8")).hexdigest()[:10]
            relative = Path("worktree") / f"{source_id}-{resolved.name}"
        if resolved.is_dir():
            skipped.append({"ref": ref, "reason": "directory-reference"})
            continue
        if not resolved.is_file():
            entries.append(
                {
                    "ref": ref,
                    "source_path": rel(resolved),
                    "action": "reject",
                    "reason": "missing-artifact",
                }
            )
            continue
        if is_sensitive_evidence(resolved):
            skipped.append({"ref": ref, "reason": "sensitive-name"})
            continue
        target = f"{CLOSEOUT_EVIDENCE_ROOT}/{task['task_id']}/{relative.as_posix()}"
        target_abs = cli_path(target, "evidence target")
        source_sha = sha256_file(resolved)
        if target_abs.is_file():
            target_state = "same" if sha256_file(target_abs) == source_sha else "differs"
        else:
            target_state = "missing"
        entries.append(
            {
                "ref": ref,
                "source_path": rel(resolved),
                "target": target,
                "action": "copy" if target_state != "differs" else "reject",
                "sha256": source_sha,
                "target_state": target_state,
                "baseline": path_baseline(target),
                "reason": None if target_state != "differs" else "evidence-target-differs",
            }
        )
    return entries


def build_closeout_plan(task_dirs: list[Path], include_files: list[str]) -> dict[str, Any]:
    tasks = [collect_task(task_dir) for task_dir in task_dirs]
    rows = status_records()
    states = status_map(rows)
    registry: dict[str, dict[str, Any]] = {}
    order: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    gaps: list[dict[str, str]] = []
    evidence: list[dict[str, Any]] = []

    for task, task_dir in zip(tasks, task_dirs):
        declared_paths: set[str] = set()
        for value in task["declared"]:
            resolved = resolve_reference(value, task_dir)
            if resolved is None:
                add_candidate(registry, order, gaps, value, "declared-output", "write", task)
                continue
            declared_paths.add(str(resolved))
            if _inside_task_dir(resolved, task_dir):
                # 运行目录里的 report/handoff 是任务运行副本，不是仓内交付物。
                skipped.append({"ref": value, "reason": "task-runtime-copy"})
                continue
            add_candidate(registry, order, gaps, value, "declared-output", "write", task)
        for source, kind, values in (
            ("scope_actual.written", "write", task["written"]),
            ("scope_actual.deleted", "delete", task["deleted"]),
        ):
            for value in values:
                resolved = resolve_reference(value, task_dir)
                if resolved is not None and _inside_task_dir(resolved, task_dir):
                    # 任务目录内的 artifacts/报告副本属于运行时状态，不进入暂存清单。
                    skipped.append({"ref": value, "reason": "task-runtime-copy"})
                    continue
                normalized = normalize_conflict_path(value)
                if normalized and not normalized.startswith("external:") and ignored_worktree_path(normalized):
                    skipped.append({"ref": value, "reason": "ignored-worktree-change"})
                    continue
                add_candidate(registry, order, gaps, value, source, kind, task)
        evidence.extend(build_evidence_plan(task, task_dir, declared_paths, skipped))

    for value in include_files:
        text = str(value or "").strip()
        resolved = cli_path(text, "--include-file")
        entry = add_candidate(registry, order, gaps, text, "include-file", "write", None)
        if entry is None:
            continue
        if not resolved.is_file():
            gaps.append(
                {"kind": "missing-file", "subject": entry["path"], "detail": "include-file 不是可读文件"}
            )

    candidates: list[dict[str, Any]] = []
    for entry in order:
        path = entry["path"]
        resolved = ROOT / path
        exists = resolved.is_file()
        blob = index_blob(path)
        ignored = not blob and is_ignored(path)
        state = classify_path(path, states, exists, ignored)
        in_domain = all(any(path_conflict(path, item) for item in task["write_domain"])
                        for task in tasks if task["task_id"] in entry["tasks"])
        entry.update(
            {
                "exists": exists,
                "state": state,
                "in_write_domain": in_domain,
                "content_sha256": sha256_file(resolved) if exists else None,
                "index_blob": blob,
                "ignored": ignored,
                "action": "stage",
                "baseline": path_baseline(path),
            }
        )
        if not in_domain:
            entry["action"] = "reject"
            gaps.append(
                {
                    "kind": "outside-write-domain",
                    "subject": path,
                    "detail": "候选超出某个来源任务的声明写域；不能借用其他任务的授权",
                }
            )
        elif state == "missing":
            entry["action"] = "reject"
            gaps.append({"kind": "missing-file", "subject": path, "detail": "候选文件不存在"})
        elif state == "ignored":
            entry["action"] = "reject"
            gaps.append({"kind": "ignored", "subject": path, "detail": "候选被 .gitignore 忽略"})
        elif state == "partial-staged":
            entry["action"] = "reject"
            gaps.append(
                {
                    "kind": "partial-staged",
                    "subject": path,
                    "detail": "候选已有部分暂存，暂存会扩大范围",
                }
            )
        candidates.append(entry)

    for item in evidence:
        if item.get("reason") == "evidence-target-differs":
            gaps.append(
                {
                    "kind": "evidence-target-differs",
                    "subject": item["target"],
                    "detail": "证据归档目标已存在且内容不同",
                }
            )
        elif item.get("reason") == "missing-artifact":
            gaps.append(
                {
                    "kind": "evidence-missing",
                    "subject": item["source_path"],
                    "detail": "evidence_refs 指向的 artifacts 文件不存在",
                }
            )

    manifest = [{"path": item["path"], "baseline": item["baseline"],
                 "sha256": item["content_sha256"], "source_path": None}
                for item in candidates if item["action"] == "stage"]
    for item in evidence:
        if item["action"] != "copy":
            continue
        target = item["target"]
        if classify_path(target, states, (ROOT / target).is_file()) == "partial-staged":
            gaps.append({"kind": "partial-staged", "subject": target, "detail": "证据目标已有部分暂存"})
        if is_ignored(target):
            gaps.append({"kind": "ignored", "subject": target, "detail": "证据目标被忽略"})
        manifest.append({"path": target, "baseline": item["baseline"],
                         "sha256": item["sha256"], "source_path": item["source_path"]})
    for item in manifest:
        source = item["source_path"] or item["path"]
        item["expected_index"] = expected_index(item["path"], ROOT / source if item["sha256"] else None)
    if len({item["path"] for item in manifest}) != len(manifest):
        gaps.append({"kind": "target-conflict", "subject": "manifest", "detail": "动作目标重叠"})
    candidate_paths = {entry["path"] for entry in manifest}
    other_dirty = [{"code": row["code"], "path": row["path"]} for row in rows if row["path"] not in candidate_paths]
    commit_msg_draft = next((task["commit_msg_draft"] for task in tasks if task["commit_msg_draft"]), None)
    data: dict[str, Any] = {
        "tool": "git_checkpoint",
        "mode": PLAN_MODE,
        "plan_version": PLAN_VERSION,
        "status": "ready" if not gaps else "partial",
        "exit_code": 0 if not gaps else 1,
        "created_at": utc_now(),
        "project_root": str(ROOT),
        "head": head_commit(),
        "branch": branch_name(),
        "plan_path": None,
        "commit_msg_draft": commit_msg_draft,
        "tasks": tasks,
        "candidates": candidates,
        "manifest": manifest,
        "evidence": evidence,
        "skipped": skipped,
        "other_dirty": other_dirty,
        "gaps": gaps,
    }
    data["next_steps"] = next_steps_for(data)
    return data


def _inside_task_dir(path: Path, task_dir: Path) -> bool:
    try:
        path.relative_to(task_dir.resolve())
    except ValueError:
        return False
    return True


def next_steps_for(plan: dict[str, Any], decision: str | None = None) -> list[str]:
    steps = [
        f"{gap.get('kind')}: {gap.get('subject')}"
        for gap in plan.get("gaps") or []
    ]
    if decision in ("rework", "needs_owner"):
        steps.append("按缺口修正后重跑 --closeout-task 预览，再决定是否 accept")
    elif decision == "accept":
        steps.append("逐条修正缺口后重跑 --closeout-task 预览")
    return steps[:20]


def path_baseline(path: str) -> dict[str, Any]:
    """记录落盘类型/内容和完整 index 条目（包括 mode 和冲突 stage）。"""
    resolved = cli_path(path, "manifest path")
    if resolved.is_symlink() or (ROOT / path).is_symlink():
        raise ToolError(f"symlink is not a closeout file: {path}")
    if resolved.exists() and not resolved.is_file():
        raise ToolError(f"closeout path is not a file: {path}")
    if any(parent.exists() and not parent.is_dir() for parent in resolved.parents):
        raise ToolError(f"closeout parent is not a directory: {path}")
    return {"sha256": sha256_file(resolved) if resolved.is_file() else None,
            "index": os.fsdecode(git_checked(
                [LITERAL_PATHSPECS, "ls-files", "--stage", "-z", "--", path], "git ls-files"))}


def expected_index(path: str, source: Path | None) -> str:
    """预览时计算期望 index；重放不能把当前任意 staged 状态当成成功。"""
    if source is None:
        return ""
    result = git_raw(["hash-object", "--path=" + path, "--stdin"], source.read_bytes())
    if result["exit_code"]:
        raise ToolError(f"git hash-object failed: {short_detail(result['stderr'])}")
    blob = os.fsdecode(result["stdout"]).strip()
    entries = git_path(["ls-files", "--stage", "-z"], path)["stdout"]
    mode = os.fsdecode(entries).split(" ", 1)[0] if entries else "100644"
    if git_raw(["config", "--bool", "core.filemode"])["stdout"].strip() == b"true":
        target = ROOT / path
        mode = "100755" if target.is_file() and target.stat().st_mode & 0o111 else "100644"
    return f"{mode} {blob} 0\t{path}\0"


def read_plan(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ToolError(f"closeout plan not found: {rel(path)}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ToolError(f"invalid closeout plan: {rel(path)}: {short_detail(exc)}") from exc
    if not isinstance(data, dict):
        raise ToolError(f"closeout plan root is not an object: {rel(path)}")
    if data.get("mode") != PLAN_MODE:
        raise ToolError(f"closeout plan is not a preview: {rel(path)}")
    if data.get("plan_version") != PLAN_VERSION:
        raise ToolError(f"unsupported closeout plan version: {data.get('plan_version')!r}")
    return data


def apply_plan(plan_path: Path, decision: str) -> dict[str, Any]:
    plan = read_plan(plan_path)
    recorded_root = str(plan.get("project_root") or "")
    if recorded_root and Path(recorded_root).resolve() != ROOT.resolve():
        raise ToolError("closeout plan was produced for a different project root")
    base: dict[str, Any] = {
        "tool": "git_checkpoint",
        "mode": "closeout-apply",
        "plan_version": PLAN_VERSION,
        "decision": decision,
        "applied_at": utc_now(),
        "plan_path": rel(plan_path),
        "head": plan.get("head"),
        "staged": [],
        "already_staged": [],
        "no_changes": [],
        "evidence_copied": [],
        "evidence_unchanged": [],
        "gaps": [],
    }
    if decision in ("rework", "needs_owner"):
        # 只投影下一步：不改暂存，也不碰业务文件。
        return {
            **base,
            "status": decision,
            "exit_code": 0,
            "gaps": list(plan.get("gaps") or []),
            "next_steps": next_steps_for(plan, decision),
        }

    gaps = list(plan.get("gaps") or [])

    def gap(kind: str, subject: str, detail: str) -> None:
        gaps.append({"kind": kind, "subject": subject, "detail": detail})

    def finish() -> dict[str, Any]:
        needs_owner = any(item["kind"] in ("head-changed", "task-version-changed") for item in gaps)
        return {**base, "status": "needs_owner" if needs_owner else ("partial" if gaps else "applied"),
                "exit_code": 1 if gaps else 0, "gaps": gaps,
                "next_steps": next_steps_for({"gaps": gaps}, "accept") if gaps else []}

    if head_commit() != plan.get("head"):
        gap("head-changed", "HEAD", "预览后 HEAD 改变")
    for task in plan.get("tasks") or []:
        if task_fingerprint_now(task) != task.get("fingerprint"):
            gap("task-version-changed", str(task.get("task_id")), "预览后任务材料改变")
    if gaps:
        return finish()
    manifest = plan.get("manifest")
    if not isinstance(manifest, list):
        raise ToolError("closeout plan missing manifest; regenerate preview")
    before = staged_paths()
    pending: list[str] = []
    copies: list[tuple[Path, bytes]] = []
    # 完整清单预检后才能复制或暂存；读取源内容留在内存，避免复制阶段重读变化的证据。
    for item in manifest:
        path = item["path"]
        target = cli_path(path, "manifest target")
        now = path_baseline(path)
        desired_sha = item["sha256"]
        source_path = item.get("source_path")
        content = None
        if source_path:
            source = cli_path(source_path, "evidence source")
            content = source.read_bytes() if source.is_file() else None
            if content is None or hashlib.sha256(content).hexdigest() != desired_sha:
                gap("evidence-changed", source_path, "预览后证据内容改变或消失")
        complete = now["sha256"] == desired_sha and now["index"] == item["expected_index"]
        if now != item["baseline"] and not complete:
            kind = "index-changed" if now["index"] != item["baseline"]["index"] else "content-changed"
            gap(kind, path, "预览后目标内容或 index 改变")
            continue
        if not source_path and now["sha256"] != desired_sha:
            gap("content-changed", path, "预览后候选内容改变")
        if is_ignored(path):
            gap("ignored", path, "目标被忽略")
        if source_path:
            if now["sha256"] == desired_sha:
                base["evidence_unchanged"].append(path)
            elif content is not None:
                copies.append((target, content))
        if complete:
            base["already_staged" if path in before else "no_changes"].append(path)
        else:
            pending.append(path)
    if gaps:
        return finish()
    # 文件复制与 Git index 不是跨文件系统事务；错误保留已复制清单，绝不谎报成功。
    try:
        for target, content in copies:
            target.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(target, content, label="evidence target")
            base["evidence_copied"].append(rel(target))
    except (OSError, ToolError) as exc:
        gap("copy-failed", rel(target), short_detail(exc))
        return finish()
    if pending:
        result = git_raw([LITERAL_PATHSPECS, "add", "--pathspec-from-file=-", "--pathspec-file-nul"],
                         b"".join(os.fsencode(path) + b"\0" for path in pending))
        if result["exit_code"]:
            gap("stage-failed", "manifest", short_detail(result["stderr"]))
        else:
            base["staged"] = pending
    base["newly_staged"] = sorted(staged_paths() - before)
    if not gaps:
        for item in manifest:
            now = path_baseline(item["path"])
            if now != {"sha256": item["sha256"], "index": item["expected_index"]}:
                gap("postcondition-failed", item["path"], "落盘或 index 未达计划预期；可能有并发写入")
    return finish()


def build_preview_text(data: dict[str, Any]) -> str:
    lines = [
        "# Task Closeout Preview",
        "",
        f"status: {data['status']}",
        f"head: {data.get('head')}",
        f"plan: {data.get('plan_path') or 'none'}",
        f"commit_msg_draft: {'yes' if data.get('commit_msg_draft') else 'no'}",
        "",
        "## Tasks",
    ]
    for task in data.get("tasks") or []:
        lines.append(
            f"- {task['task_id']} | verdict {task.get('verdict')} | source {task.get('result_source')}"
            f" | written {len(task.get('written') or [])} | deleted {len(task.get('deleted') or [])}"
        )
    lines.extend(["", "## Candidates"])
    if data.get("candidates"):
        for entry in data["candidates"]:
            lines.append(
                f"- {entry['action']} | {entry['state']} | {entry['path']} | {', '.join(entry['sources'])}"
            )
    else:
        lines.append("- none")
    lines.extend(["", "## Evidence"])
    if data.get("evidence"):
        for item in data["evidence"]:
            suffix = item.get("target") if item.get("action") == "copy" else item.get("reason")
            lines.append(f"- {item['action']} | {item.get('source_path')} | {suffix}")
    else:
        lines.append("- none")
    lines.extend(["", "## Skipped"])
    if data.get("skipped"):
        for item in data["skipped"]:
            lines.append(f"- {item['reason']} | {item['ref']}")
    else:
        lines.append("- none")
    lines.extend(["", "## Other Dirty"])
    if data.get("other_dirty"):
        for row in data["other_dirty"]:
            lines.append(f"- {row['code']} {row['path']}")
    else:
        lines.append("- none")
    lines.extend(["", "## Gaps"])
    if data.get("gaps"):
        for gap in data["gaps"]:
            lines.append(f"- {gap['kind']}: {gap['subject']}")
    else:
        lines.append("- none")
    lines.extend(["", "## Next Steps"])
    if data.get("next_steps"):
        for step in data["next_steps"]:
            lines.append(f"- {step}")
    else:
        lines.append("- none")
    return "\n".join(lines) + "\n"


def build_apply_text(data: dict[str, Any]) -> str:
    lines = [
        "# Task Closeout Apply",
        "",
        f"status: {data['status']}",
        f"decision: {data['decision']}",
        f"plan: {data.get('plan_path')}",
        "",
        "## Staged",
    ]
    for path in data.get("staged") or []:
        lines.append(f"- {path}")
    if not data.get("staged"):
        lines.append("- none")
    lines.extend(["", "## Already Staged"])
    for path in data.get("already_staged") or []:
        lines.append(f"- {path}")
    if not data.get("already_staged"):
        lines.append("- none")
    lines.extend(["", "## No Changes"])
    for path in data.get("no_changes") or []:
        lines.append(f"- {path}")
    if not data.get("no_changes"):
        lines.append("- none")
    lines.extend(["", "## Evidence"])
    for path in data.get("evidence_copied") or []:
        lines.append(f"- copied {path}")
    for path in data.get("evidence_unchanged") or []:
        lines.append(f"- unchanged {path}")
    if not data.get("evidence_copied") and not data.get("evidence_unchanged"):
        lines.append("- none")
    lines.extend(["", "## Gaps"])
    if data.get("gaps"):
        for gap in data["gaps"]:
            lines.append(f"- {gap['kind']}: {gap['subject']}")
    else:
        lines.append("- none")
    lines.extend(["", "## Next Steps"])
    if data.get("next_steps"):
        for step in data["next_steps"]:
            lines.append(f"- {step}")
    else:
        lines.append("- none")
    return "\n".join(lines) + "\n"


def build_closeout_text(data: dict[str, Any]) -> str:
    if data.get("mode") == "closeout-apply":
        return build_apply_text(data)
    return build_preview_text(data)


def save_plan(data: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    atomic_write_bytes(path, payload.encode("utf-8"), label="closeout plan")


# ---------- CLI ----------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "只读快照当前 git 工作树状态：分支名、脏文件总数、staged / unstaged / untracked 文件列表及目录分组。\n"
            "主代理在提交前或派发子代理前调用，确认工作树干净度，不会对仓库做任何修改。\n"
            "给定 --closeout-task 后进入普通任务收口预览：整理任务实际写入/删除、证据归档计划和缺口，\n"
            "再用 --apply-plan --decision accept 按精确清单一次暂存；rework / needs_owner 只投影下一步。"
        ),
        epilog=(
            "典型用法：\n"
            "  python -B git_checkpoint.py --format text\n"
            "  python -B git_checkpoint.py --closeout-task .runtime/cockpit/async_tasks/<task_id>"
            " --save-plan tmp/closeout-plan.json --format text\n"
            "  python -B git_checkpoint.py --apply-plan tmp/closeout-plan.json --decision accept\n\n"
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
        "--closeout-task",
        action="append",
        default=[],
        metavar="DIR",
        help="任务目录（相对项目根或绝对路径），可重复指定；给定后进入收口预览，只读且不改 index。",
    )
    parser.add_argument(
        "--include-file",
        action="append",
        default=[],
        metavar="PATH",
        help="额外把主代理自己的文件补进候选清单，可重复；路径必须落在项目根内。",
    )
    parser.add_argument(
        "--save-plan",
        metavar="PATH",
        help="把预览计划写入该路径（项目根内），供 --apply-plan 使用。",
    )
    parser.add_argument(
        "--apply-plan",
        metavar="PATH",
        help="应用已保存的预览计划；必须同时给 --decision。",
    )
    parser.add_argument(
        "--decision",
        choices=CLOSEOUT_DECISIONS,
        help="accept 复制证据并按精确文件名暂存；rework / needs_owner 只投影下一步，不改暂存与业务文件。",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.apply_plan:
            if not args.decision:
                raise ToolError("--apply-plan requires --decision accept|rework|needs_owner")
            if args.closeout_task or args.save_plan or args.include_file:
                raise ToolError(
                    "--apply-plan cannot be combined with --closeout-task / --save-plan / --include-file"
                )
            data = apply_plan(cli_path(args.apply_plan, "--apply-plan"), args.decision)
            return emit(data, args.format, build_closeout_text(data))
        if args.decision:
            raise ToolError("--decision requires --apply-plan")
        if args.save_plan and not args.closeout_task:
            raise ToolError("--save-plan requires --closeout-task")
        if args.closeout_task:
            task_dirs = [cli_path(value, "--closeout-task") for value in args.closeout_task]
            data = build_closeout_plan(task_dirs, args.include_file)
            if args.save_plan:
                plan_path = cli_path(args.save_plan, "--save-plan")
                data["plan_path"] = rel(plan_path)
                save_plan(data, plan_path)
            return emit(data, args.format, build_closeout_text(data))

        branch = run_git(["branch", "--show-current"])
        if branch["exit_code"] != 0:
            raise ToolError(f"git branch failed: {branch['stderr']}")
        checkpoint = parse_status(status_lines())
        data = {
            "tool": "git_checkpoint",
            "status": "dirty" if checkpoint["dirty"] else "clean",
            "branch": branch["stdout"] or "(detached)",
            "exit_code": 0,
            "checkpoint": checkpoint,
        }
        return emit(data, args.format, build_text(data))
    except (ToolError, OSError) as exc:
        message = short_detail(exc)
        print(f"error: {message}", file=sys.stderr)
        if args.format == "json":
            return emit({
                "tool": "git_checkpoint",
                "status": "error",
                "exit_code": 1,
                "error": {
                    "code": "io_error" if isinstance(exc, OSError) else "tool_error",
                    "message": message,
                    "next_step": "修正所报参数或路径后重试；需要收口计划时先运行 --closeout-task。",
                },
            }, "json", "")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
