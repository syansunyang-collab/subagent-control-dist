#!/usr/bin/env python3
"""Render STATUS.md and ROADMAP.md from a main-agent supplied state delta."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

from _tool_common import ROOT, ToolError, emit, load_json, read_stdin_text, rel, status_lines


STATUS_PATH = ROOT / "STATUS.md"
ROADMAP_PATH = ROOT / "ROADMAP.md"

STATUS_STATES = {"active", "blocked", "paused", "ready_for_commit", "closed"}
MILESTONE_STATES = {"active", "blocked", "paused", "closed"}
SURFACE_STATES = {"active", "blocked", "paused", "ready_for_commit", "closed", "cancelled", "migrated"}
ALLOWED_DIRTY_PATHS = {"STATUS.md", "ROADMAP.md"}


def require_obj(data: dict[str, Any], key: str) -> dict[str, Any]:
    value = data.get(key)
    if not isinstance(value, dict):
        raise ToolError(f"{key} must be an object")
    return value


def require_str(data: dict[str, Any], key: str, *, allow_empty: bool = False) -> str:
    value = data.get(key)
    if not isinstance(value, str):
        raise ToolError(f"{key} must be a string")
    if not allow_empty and not value.strip():
        raise ToolError(f"{key} must not be empty")
    return value.strip()


def require_str_list(data: dict[str, Any], key: str) -> list[str]:
    value = data.get(key, [])
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ToolError(f"{key} must be a list of strings")
    return [item.strip() for item in value if item.strip()]


def validate_status(status: dict[str, Any]) -> dict[str, Any]:
    state = require_str(status, "state")
    if state not in STATUS_STATES:
        raise ToolError(f"status.state must be one of {sorted(STATUS_STATES)}")
    return {
        "surface": require_str(status, "surface"),
        "milestone": require_str(status, "milestone"),
        "state": state,
        "restore_entry": require_str(status, "restore_entry"),
        "blocker": require_str(status, "blocker"),
        "confirmed": require_str_list(status, "confirmed"),
        "verification": require_str_list(status, "verification"),
        "next": require_str_list(status, "next"),
    }


def validate_surfaces(raw_surfaces: Any) -> list[dict[str, str]]:
    if not isinstance(raw_surfaces, list) or not raw_surfaces:
        raise ToolError("roadmap.surfaces must be a non-empty list")
    surfaces: list[dict[str, str]] = []
    for index, raw_surface in enumerate(raw_surfaces, start=1):
        if not isinstance(raw_surface, dict):
            raise ToolError(f"roadmap.surfaces[{index}] must be an object")
        state = require_str(raw_surface, "state")
        if state not in SURFACE_STATES:
            raise ToolError(f"roadmap.surfaces[{index}].state must be one of {sorted(SURFACE_STATES)}")
        surfaces.append(
            {
                "id": require_str(raw_surface, "id"),
                "state": state,
                "note": require_str(raw_surface, "note"),
            }
        )
    return surfaces


def validate_roadmap(roadmap: dict[str, Any]) -> dict[str, Any]:
    state = require_str(roadmap, "state")
    if state not in MILESTONE_STATES:
        raise ToolError(f"roadmap.state must be one of {sorted(MILESTONE_STATES)}")
    return {
        "milestone": require_str(roadmap, "milestone"),
        "state": state,
        "goal": require_str(roadmap, "goal"),
        "surfaces": validate_surfaces(roadmap.get("surfaces")),
        "exit_criteria": require_str_list(roadmap, "exit_criteria"),
        "next": require_str_list(roadmap, "next"),
        "deferred": require_str_list(roadmap, "deferred"),
    }


def validate_delta(delta: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(delta, dict):
        raise ToolError("delta root must be an object")
    result: dict[str, Any] = {}
    if "status" in delta:
        result["status"] = validate_status(require_obj(delta, "status"))
    if "roadmap" in delta:
        result["roadmap"] = validate_roadmap(require_obj(delta, "roadmap"))
    if not result:
        raise ToolError("delta must contain status or roadmap")
    return result


def bullet_lines(items: list[str]) -> list[str]:
    if not items:
        return ["- 无"]
    return [f"- {item}" for item in items]


def numbered_lines(items: list[str]) -> list[str]:
    if not items:
        return ["1. 无"]
    return [f"{index}. {item}" for index, item in enumerate(items, start=1)]


def render_status(status: dict[str, Any]) -> str:
    lines = [
        "# STATUS.md",
        "",
        "> **主代理读这个文件了解**：当前 surface / 恢复入口 / 阻塞 / 最近有效验证。",
        "> 状态写入按 `ops/policies/state.md` 执行；本文件记录工程 checkpoint。",
        "",
        "## 当前 checkpoint",
        "",
        f"- surface: `{status['surface']}`",
        f"- milestone: `{status['milestone']}`",
        f"- 状态: {status['state']}",
        f"- 恢复入口: {status['restore_entry']}",
        f"- 用户可见阻塞: {status['blocker']}",
        "",
        "## 本 checkpoint 已确认",
        "",
        *bullet_lines(status["confirmed"]),
        "",
        "## 最近有效验证",
        "",
        *bullet_lines(status["verification"]),
        "",
        "## 下一恢复动作",
        "",
        *numbered_lines(status["next"]),
    ]
    return "\n".join(lines) + "\n"


def render_roadmap(roadmap: dict[str, Any]) -> str:
    surface_lines = [
        f"- `{surface['id']}`: {surface['state']}，{surface['note']}。" for surface in roadmap["surfaces"]
    ]
    lines = [
        "# ROADMAP.md",
        "",
        "> 职责：记录当前 milestone、关联 surface、退出条件和延后事项。",
        "> 真源：当前路线、进行中里程碑和延后事项",
        "> 读取：固定读取",
        "",
        "历史里程碑归档按需创建；未启用前只读取本文件当前 milestone。",
        "",
        "## 当前 milestone",
        "",
        f"- milestone: `{roadmap['milestone']}`",
        f"- 状态: {roadmap['state']}",
        f"- 目标: {roadmap['goal']}",
        "",
        "## 关联 surface",
        "",
        *surface_lines,
        "",
        "## 退出条件",
        "",
        *bullet_lines(roadmap["exit_criteria"]),
        "",
        "## 下一步",
        "",
        *numbered_lines(roadmap["next"]),
        "",
        "## 延后事项",
        "",
        *bullet_lines(roadmap["deferred"]),
    ]
    return "\n".join(lines) + "\n"


def parse_delta_json(raw: str, source_label: str) -> dict[str, Any]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ToolError(f"invalid {source_label} JSON at line {exc.lineno}") from exc
    if not isinstance(data, dict):
        raise ToolError(f"{source_label} root must be an object")
    return data


def load_delta(args: argparse.Namespace) -> dict[str, Any]:
    sources = [bool(args.delta_json), bool(args.delta_file), bool(args.delta_stdin)]
    if sum(sources) != 1:
        raise ToolError("provide exactly one of --delta-json, --delta-file or --delta-stdin")
    if args.delta_json:
        return parse_delta_json(args.delta_json, "--delta-json")
    if args.delta_stdin:
        return parse_delta_json(read_stdin_text("--delta-stdin"), "--delta-stdin")
    if args.delta_file == "-":
        return parse_delta_json(read_stdin_text("--delta-file -"), "--delta-file -")
    return load_json(Path(args.delta_file).resolve())


def encode_planned_writes(planned: dict[str, str]) -> dict[str, bytes]:
    encoded: dict[str, bytes] = {}
    for path_text, content in planned.items():
        try:
            encoded[path_text] = content.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise ToolError(f"rendered {path_text} is not valid UTF-8 at character {exc.start}") from exc
    return encoded


def changed_planned_paths(encoded_planned: dict[str, bytes]) -> list[str]:
    changed: list[str] = []
    for path_text, content in encoded_planned.items():
        path = ROOT / path_text
        try:
            if path.read_bytes() == content:
                continue
        except FileNotFoundError:
            pass
        changed.append(path_text)
    return changed


def dirty_path(line: str) -> str:
    if len(line) < 4:
        raise ToolError(f"invalid git status line: {line!r}")
    path = line[3:]
    if " -> " in path:
        path = path.split(" -> ", 1)[1]
    return path.replace("\\", "/")


def dirty_other_paths() -> list[str]:
    return [path for path in (dirty_path(line) for line in status_lines()) if path not in ALLOWED_DIRTY_PATHS]


def plan_writes(delta: dict[str, Any]) -> dict[str, str]:
    planned: dict[str, str] = {}
    if "status" in delta:
        planned[rel(STATUS_PATH)] = render_status(delta["status"])
    if "roadmap" in delta:
        planned[rel(ROADMAP_PATH)] = render_roadmap(delta["roadmap"])
    return planned


def build_text(data: dict[str, Any]) -> str:
    lines = [
        "# State Checkpoint",
        "",
        f"status: {data['status']}",
        f"mode: {data['mode']}",
        "",
        "## 文件",
    ]
    for path in data["files"]:
        lines.append(f"- {path}")
    if "changed_files" in data:
        lines.extend(["", "## 变更文件"])
        if data["changed_files"]:
            lines.extend(f"- {path}" for path in data["changed_files"])
        else:
            lines.append("- 无")
    if data.get("dirty_other"):
        lines.extend(["", "## 其他脏文件", *[f"- {path}" for path in data["dirty_other"]]])
    if data.get("message"):
        lines.extend(["", data["message"]])
    return "\n".join(lines) + "\n"


def run_self_test() -> dict[str, Any]:
    sample = {
        "status": {
            "surface": "demo-surface",
            "milestone": "demo-milestone",
            "state": "active",
            "restore_entry": "继续 demo。",
            "blocker": "无",
            "confirmed": ["已确认入口。"],
            "verification": ["demo check pass。"],
            "next": ["继续下一步。"],
        },
        "roadmap": {
            "milestone": "demo-milestone",
            "state": "active",
            "goal": "验证机械渲染。",
            "surfaces": [{"id": "demo-surface", "state": "active", "note": "用于自测"}],
            "exit_criteria": ["自测通过。"],
            "next": ["继续验证。"],
            "deferred": ["无"],
        },
    }
    valid = validate_delta(sample)
    planned = plan_writes(valid)
    encode_planned_writes(planned)
    if set(planned) != {"STATUS.md", "ROADMAP.md"}:
        raise ToolError("self-test planned files mismatch")
    if "demo-surface" not in planned["STATUS.md"] or "demo-milestone" not in planned["ROADMAP.md"]:
        raise ToolError("self-test render output missing sample values")
    if "工程 checkpoint" not in planned["STATUS.md"] or "任务面板" in planned["STATUS.md"]:
        raise ToolError("self-test status header must describe the engineering checkpoint")
    stdin_delta = parse_delta_json(json.dumps({"status": sample["status"]}), "--delta-stdin")
    validate_delta(stdin_delta)
    file_dash_delta = parse_delta_json(json.dumps({"roadmap": sample["roadmap"]}), "--delta-file -")
    validate_delta(file_dash_delta)
    try:
        parse_delta_json("[1, 2, 3]", "--delta-stdin")
    except ToolError:
        pass
    else:
        raise ToolError("self-test expected stdin root array to fail")
    try:
        validate_delta({"status": {"surface": "x"}})
    except ToolError:
        pass
    else:
        raise ToolError("self-test expected incomplete status to fail")
    try:
        validate_delta({"roadmap": {"milestone": "m", "state": "done", "goal": "g", "surfaces": []}})
    except ToolError:
        pass
    else:
        raise ToolError("self-test expected invalid roadmap to fail")
    return {
        "tool": "state_checkpoint",
        "status": "pass",
        "exit_code": 0,
        "checks": [
            "status render",
            "status header responsibility",
            "roadmap render",
            "stdin delta parse",
            "stdin root rejection",
            "incomplete status rejection",
            "invalid roadmap rejection",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "根据主代理提供的状态增量（delta），将 STATUS.md 和 ROADMAP.md 渲染并写入仓库根。\n"
            "主代理在每个检查点结束时调用，确保进度文件内容由机器渲染，格式统一、不出现手动拼写差异。"
        ),
        epilog=(
            "典型用法：\n"
            "  python -B state_checkpoint.py --delta-file delta.json --apply\n"
            "  python -B state_checkpoint.py --delta-stdin --apply  # 从 stdin 读 JSON\n\n"
            "规则真源：ops/policies/state.md"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--delta-json",
        help=(
            "直接在命令行传入状态增量 JSON 字符串（内联模式）；"
            "JSON 根须为对象，可包含 status 和/或 roadmap 两个字段。"
        ),
    )
    parser.add_argument(
        "--delta-file",
        help="状态增量 JSON 文件路径；传 '-' 表示从 stdin 读取文件内容。",
    )
    parser.add_argument(
        "--delta-stdin",
        action="store_true",
        help="从 stdin 读取状态增量 JSON 对象（与 --delta-file - 行为相同，但语义更明确）。",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="将渲染结果实际写入 STATUS.md 和 ROADMAP.md；不加此参数时为 dry-run，只校验不写文件。",
    )
    parser.add_argument(
        "--allow-dirty-other",
        action="store_true",
        help="允许 --apply 在 STATUS.md / ROADMAP.md 以外的文件也有未提交修改时仍执行写入；默认拒绝，防止误覆盖。",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="运行内置机械测试用例（不写文件），验证 delta 校验和渲染逻辑正确。",
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
    if args.self_test:
        data = run_self_test()
        return emit(data, args.format, "# State Checkpoint\n\nstatus: pass\n")

    delta = validate_delta(load_delta(args))
    planned = plan_writes(delta)
    encoded_planned = encode_planned_writes(planned)
    changed_files = changed_planned_paths(encoded_planned)
    # dry-run 同样预演脏树检查（只报告不拒绝），apply 才拒绝：
    # 避免 dry-run 全绿而同一 delta 的 apply 必撞守卫的时序矛盾。
    dirty_other = dirty_other_paths() if changed_files else []
    if args.apply and dirty_other and not args.allow_dirty_other:
        raise ToolError(
            "refusing to apply with unrelated dirty paths: " + ", ".join(dirty_other[:20])
        )
    if args.apply:
        changed_set = set(changed_files)
        for path_text, content in encoded_planned.items():
            if path_text not in changed_set:
                continue
            (ROOT / path_text).write_bytes(content)
    if args.apply:
        message = "wrote checkpoint files" if changed_files else "no changes; checkpoint files already up to date"
    else:
        message = "dry-run only; no files were changed"
    data = {
        "tool": "state_checkpoint",
        "status": "pass",
        "mode": "apply" if args.apply else "dry-run",
        "exit_code": 0,
        "files": sorted(planned),
        "changed_files": sorted(changed_files),
        "dirty_other": dirty_other,
        "message": message,
    }
    return emit(data, args.format, build_text(data))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ToolError as exc:
        data = {
            "tool": "state_checkpoint",
            "status": "failed",
            "exit_code": 1,
            "error": str(exc),
        }
        raise SystemExit(emit(data, "text", f"# State Checkpoint\n\nstatus: failed\nerror: {exc}\n"))
