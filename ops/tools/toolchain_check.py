#!/usr/bin/env python3
"""显式全量工具链验收:运行编译检查、self-test 与 lint。

清单即真源:runtime-tools.md §5 只指向本脚本,不再内联命令。
退出码:全绿 0;任一步失败 1(逐项打印结果,失败项带末行错误摘要)。
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent.parent.parent

COMPILE_FILES = [
    "ops/tools/_tool_common.py",
    "ops/tools/cockpit_health.py",
    "ops/tools/git_checkpoint.py",
    "ops/tools/evidence_index.py",
    "ops/tools/cockpit_map.py",
    "ops/tools/acceptance_contract_check.py",
    "ops/tools/acceptance_contract_check_selftest.py",
    "ops/tools/alignment_guard.py",
    "ops/tools/alignment_guard_selftest.py",
    "ops/tools/alignment_recorder.py",
    "ops/tools/alignment_recorder_selftest.py",
    "ops/tools/config_snapshot.py",
    "ops/tools/config_snapshot_selftest.py",
    "ops/tools/planning_contract_promote.py",
    "ops/tools/planning_manifest_check.py",
    "ops/tools/planning_manifest_check_selftest.py",
    "ops/tools/state_checkpoint.py",
    "ops/tools/ledger_check.py",
    "ops/tools/reference_resolution_check.py",
    "ops/tools/scope_slice_prepare.py",
    "ops/tools/deploy_subagent_bundle.py",
    "ops/tools/deploy_pi_control.py",
    "ops/tools/toolchain_check.py",
]

COMMANDS: list[list[str]] = [
    [sys.executable, "-B", "ops/tools/acceptance_contract_check.py", "--self-test"],
    [sys.executable, "-B", "ops/tools/alignment_guard.py", "--self-test"],
    [sys.executable, "-B", "ops/tools/config_snapshot.py", "--self-test"],
    [sys.executable, "-B", "ops/tools/alignment_recorder.py", "--self-test"],
    [sys.executable, "-B", "ops/tools/planning_contract_promote.py", "--self-test"],
    [sys.executable, "-B", "ops/tools/planning_manifest_check.py", "--self-test"],
    [sys.executable, "-B", "ops/tools/state_checkpoint.py", "--self-test"],
    [sys.executable, "-B", "ops/tools/ledger_check.py", "--self-test"],
    [sys.executable, "-B", "ops/tools/reference_resolution_check.py", "--self-test"],
    [sys.executable, "-B", "ops/tools/deploy_subagent_bundle.py", "--self-test"],
    [sys.executable, "-B", "-m", "pytest", "-p", "no:cacheprovider", "tests/control_plane/test_worker_resource_release.py", "-q"],
    [sys.executable, "-B", "ops/tools/deploy_pi_control.py", "--self-test"],
    [sys.executable, "-B", "ops/tools/scope_slice_prepare.py", "--self-test"],
    ["node", "--check", "ops/tools/_stdio-jsonrpc.mjs"],
    ["node", "--check", "ops/tools/pi_model_extension_profile.mjs"],
    ["node", "--test", "tests/control_plane/pi_worker_resources.test.mjs"],
    ["node", "--check", "ops/tools/pi_child_bash_process_tree.mjs"],
    ["node", "--check", "ops/tools/run-pi-task.mjs"],
    ["node", "--check", "ops/tools/run-pi-task.selftest.mjs"],
    ["node", "--check", "ops/tools/_child-task-contract.selftest.mjs"],
    ["node", "ops/tools/_child-task-contract.mjs", "--self-test"],
    ["node", "--check", "ops/tools/subagent_service_contract_test.mjs"],
    ["node", "ops/tools/subagent_service_contract_test.mjs"],
    ["node", "--check", "ops/tools/review_result_synthesis.mjs"],
    ["node", "--check", "ops/tools/review_result_synthesis.selftest.mjs"],
    ["node", "--check", "ops/tools/task_result_synthesis.mjs"],
    ["node", "--check", "ops/tools/task_result_synthesis.selftest.mjs"],
    ["node", "--check", "ops/tools/pi_task_result_extension.mjs"],
    ["node", "--check", "ops/tools/async-core/selftest.mjs"],
    ["node", "ops/tools/review_result_synthesis.mjs", "self-test"],
    ["node", "ops/tools/task_result_synthesis.mjs", "self-test"],
    ["node", "--check", "ops/tools/subagent_service.mjs"],
    ["node", "--check", "ops/tools/fleet-tools-core.mjs"],
    # dispatch-core 迁移（notes/context/py-to-js-migration-plan.md）：JS 侧 CLI 自测。
    ["node", "ops/tools/subagent_handoff_check.mjs", "--self-test"],
    ["node", "ops/tools/agent_panel_launcher.mjs", "--self-test"],
    ["node", "ops/tools/dispatch_prepare.mjs", "--self-test", "--format", "json"],
    ["node", "ops/tools/fleet_manifest_check.mjs", "--self-test", "--format", "json"],
    ["node", "ops/tools/fleet_scheduler.mjs", "self-test", "--format", "json"],
    ["node", "ops/tools/seed_minimal.mjs", "--self-test"],
    ["node", "ops/tools/subagent_preload.mjs", "--self-test", "--format", "json"],
    ["node", "ops/tools/task_package_build.mjs", "--self-test"],
    ["node", "ops/tools/task_package_lint.mjs", "--self-test"],
    ["node", "ops/tools/review_evidence.mjs", "--self-test"],
    ["node", "ops/tools/runtime_retention.mjs", "--self-test"],
    ["node", "ops/tools/review_evidence_benchmark.mjs", "--self-test"],
    [sys.executable, "-B", "ops/tools/cockpit_map.py", "--lint"],
    [sys.executable, "-B", "ops/tools/cockpit_map.py", "--self-test"],
]

def git_whitespace_issues(root: Path = ROOT) -> list[str]:
    """检查 unstaged、staged 与 untracked 文件，不修改 index。"""
    issues: list[str] = []
    for label, argv in (
        ("unstaged", ["git", "diff", "--check"]),
        ("staged", ["git", "diff", "--cached", "--check"]),
    ):
        completed = subprocess.run(
            argv, cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if completed.returncode != 0:
            detail = (completed.stdout or completed.stderr).strip() or f"exit {completed.returncode}"
            issues.append(f"{label}: {detail}")

    listed = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if listed.returncode != 0:
        detail = (listed.stderr or listed.stdout).strip() or f"exit {listed.returncode}"
        issues.append(f"untracked-list: {detail}")
        return issues
    relatives = [item for item in listed.stdout.split("\0") if item]
    if not relatives:
        return issues

    checked_attrs = subprocess.run(
        ["git", "check-attr", "-z", "--stdin", "text", "binary", "diff"],
        cwd=root,
        input="\0".join(relatives) + "\0",
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if checked_attrs.returncode != 0:
        detail = (checked_attrs.stderr or checked_attrs.stdout).strip() or f"exit {checked_attrs.returncode}"
        issues.append(f"untracked-attributes: {detail}")
        return issues
    tokens = [item for item in checked_attrs.stdout.split("\0") if item]
    if len(tokens) % 3:
        issues.append("untracked-attributes: malformed git check-attr output")
        return issues
    attributes: dict[str, dict[str, str]] = {relative: {} for relative in relatives}
    for index in range(0, len(tokens), 3):
        relative, name, value = tokens[index : index + 3]
        attributes.setdefault(relative, {})[name] = value

    with tempfile.TemporaryDirectory(prefix="toolchain-empty-") as raw_empty_dir:
        empty_file = Path(raw_empty_dir) / "empty"
        empty_file.write_bytes(b"")
        for relative in relatives:
            attrs = attributes[relative]
            if attrs.get("text") == "unset" or attrs.get("binary") == "set" or attrs.get("diff") == "unset":
                continue
            completed = subprocess.run(
                ["git", "diff", "--no-index", "--check", "--", str(empty_file), relative],
                cwd=root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            # --no-index 用 1 表示“文件有正常差异”；空文件可返回 0。大于 1 才是空白错误或命令错误。
            if completed.returncode not in {0, 1}:
                detail = (completed.stdout or completed.stderr).strip() or f"exit {completed.returncode}"
                issues.append(f"untracked {relative}: {detail}")
    return issues


SIZE_ROOTS = ("ops/tools", "adapters")
MAX_FILE_LINES = 1500
MAX_FUNCTION_LINES = 150
_FUNCTION_START = re.compile(r"^(\s*)(?:export\s+)?(?:async\s+)?(?:function\s+([\w$]+)\s*\(|def\s+(\w+)\s*\()")


def oversized_sources(root: Path = ROOT) -> list[str]:
    """按 test-tooling-governance §2.1 列出超限文件与函数；只作提示，不计入失败。"""
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--", *SIZE_ROOTS, ":(exclude)adapters/pi/user-addons"],
        cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    notes: list[str] = []
    for relative in sorted(item for item in listed.stdout.split("\0") if item.endswith((".mjs", ".js", ".py"))):
        lines = (root / relative).read_text(encoding="utf-8", errors="replace").splitlines()
        if len(lines) > MAX_FILE_LINES:
            notes.append(f"{relative}: {len(lines)} lines")
        for index, line in enumerate(lines):
            match = _FUNCTION_START.match(line)
            if not match:
                continue
            indent, name = match.group(1), match.group(2) or match.group(3)
            end = index + 1
            closer = f"{indent}}}"
            while end < len(lines):
                current = lines[end]
                if relative.endswith(".py"):
                    if current.strip() and not current.startswith(indent + " ") and not current.startswith(indent + "\t"):
                        break
                elif current == closer:
                    end += 1
                    break
                end += 1
            if end - index > MAX_FUNCTION_LINES:
                notes.append(f"{relative}:{index + 1} {name}: {end - index} lines")
    return notes


def main() -> int:
    failures: list[str] = []
    try:
        for relative in COMPILE_FILES:
            path = ROOT / relative
            compile(path.read_text(encoding="utf-8"), relative, "exec")
        print(f"compile ok: {len(COMPILE_FILES)} files")
    except SyntaxError as exc:
        failures.append(f"compile: {exc.filename}:{exc.lineno}: {exc.msg}")
        print(f"FAIL compile: {exc.filename}:{exc.lineno}: {exc.msg}")

    for argv in COMMANDS:
        label = " ".join(argv[1:] if argv[0] == sys.executable else argv)
        completed = subprocess.run(
            argv, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if completed.returncode == 0:
            print(f"ok: {label}")
        else:
            tail = (completed.stderr or completed.stdout).strip().splitlines()
            summary = tail[-1] if tail else f"exit {completed.returncode}"
            failures.append(f"{label}: {summary}")
            print(f"FAIL: {label}: {summary}")

    whitespace_issues = git_whitespace_issues()
    if whitespace_issues:
        failures.extend(f"git whitespace: {item}" for item in whitespace_issues)
        for item in whitespace_issues:
            print(f"FAIL git whitespace: {item}")
    else:
        print("ok: git whitespace check (unstaged, staged, untracked)")

    pycache = ROOT / "ops" / "tools" / "__pycache__"
    if pycache.exists():
        failures.append("ops/tools/__pycache__ left behind")
        print("FAIL: ops/tools/__pycache__ left behind")

    for note in oversized_sources():
        print(f"size note: {note} (test-tooling-governance §2.1)")

    if failures:
        print(f"toolchain check failed: {len(failures)} item(s)")
        return 1
    print("toolchain check ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
