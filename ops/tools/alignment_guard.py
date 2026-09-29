#!/usr/bin/env python3
"""Check alignment state (v4) and task cards before planner or executor consumption."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

try:
    import yaml
except ImportError as exc:  # pragma: no cover
    yaml = None
    YAML_IMPORT_ERROR = exc
else:
    YAML_IMPORT_ERROR = None

from _tool_common import ROOT, ToolError, emit, rel


STATE_VERSION = 4
FROZEN_STATE_VERSIONS = {3}

ALLOWED_NEXT_ACTIONS = {
    "ask_user",
    "dispatch_fact",
    "dispatch_plan_check",
    "dispatch_docs",
    "write_context",
    "enter_planner",
    "pause",
    "resume",
}
ROUTE_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]*__[a-z0-9][a-z0-9-]*", re.ASCII)
# 确认轮引用只有一种写法：<log 路径>#round-N，小写、ASCII 数字、无前导零、无首尾空白；否则同一轮能换个写法另立一条账本。
ROUND_REF_RE = re.compile(r"(?P<log>[^#\s][^#]*)#round-(?P<number>[1-9][0-9]*)", re.ASCII)
DECISION_ID_RE = re.compile(r"D-(?P<number>[0-9]+)", re.ASCII)
PLACEHOLDER_VALUES = {"null", "none", "[]"}

# 三个面恒为 required；顺序即渲染顺序。
ALIGNMENT_SURFACES = ("requirements", "product_experience", "execution")
LOCK_FIELDS = {f"{surface}_locked": surface for surface in ALIGNMENT_SURFACES}
STAGE_COMPLETION_STATES = {
    "intake": "draft",
    "product": "draft",
    "solution": "draft",
    "review": "surface_review",
    "exit": "locked_pending_gate",
    "complete": "dispatch_ready",
    "paused": "paused",
}
STAGES = tuple(STAGE_COMPLETION_STATES)
CLOSING_STAGES = {"exit", "complete"}
# 阶段用于组织材料；成熟且一致的 preview 可以同轮确认。
STAGE_SURFACES = {
    stage: set(ALIGNMENT_SURFACES) for stage in ("intake", "product", "solution")
}

MUST_ASK_TOPICS = {"goal_scope", "acceptance", "tech_route", "design_point", "user_visible", "conflict"}
DEFAULT_TOPICS = {"layout", "parameter", "naming", "internal"}
DECISION_TOPICS = MUST_ASK_TOPICS | DEFAULT_TOPICS
DECISION_CLASSES = {"must_ask", "disclosed_default"}
DECISION_STATUSES = {"locked", "deferred", "superseded"}
DECISION_SOURCE_TYPES = {
    "user_explicit",
    "user_selected_option",
    "user_bulk_accepted",
    "domain_owner_confirmed",
    "evidence_derived",
    "agent_default_reported",
}
# 来自一次呈现给用户（或领域负责人）的确认；只有这些类型核对确认轮。
PRESENTED_SOURCE_TYPES = {
    "user_explicit",
    "user_selected_option",
    "user_bulk_accepted",
    "domain_owner_confirmed",
}
LOCK_SOURCE_TYPES = PRESENTED_SOURCE_TYPES
CONFIRMATION_MODES = {"popup", "card", "conversation"}
# open：草案已登记、用户尚未答完；只有 closed 轮能支撑决策与面锁。缺省视为 closed，兼容 delta 通道写入的轮次。
CONFIRMATION_STATUSES = ("open", "closed", "cancelled")

PREVIEW_STATUSES = {"proposed", "accepted", "superseded"}
SURFACE_PREVIEW_REQUIRED_FIELDS = (
    "surface", "status", "locked_statement", "in_scope", "out_of_scope",
    "validation_object", "decision_source", "still_open", "planner_impact",
)
PRODUCT_SURFACES = {"cli", "web", "desktop", "api", "report", "workflow", "agent", "not_needed"}
UI_PRODUCT_SURFACES = {"web", "desktop"}
EXECUTION_SECTIONS = ("tech", "landing", "quality", "validation", "structure")
# tech 承载技术路线与查轮子结论，validation 承载验收合同，两者不能整节 not_needed。
EXECUTION_SECTIONS_REQUIRED = {"tech", "validation"}

SURFACE_REVIEW_VERDICTS = {
    "PASS",
    "MISSING_LOCK",
    "AMBIGUOUS",
    "OVER_SCOPED",
    "UNDER_SPECIFIED",
    "NEEDS_OWNER",
}
PROPOSAL_CHALLENGE_VERDICTS = {
    "proposal_stands",
    "cheaper_path_exists",
    "needs_owner",
}
# 每种子代理审查对同一对象最多两轮；第二轮之后交 owner 裁决，不再派发。
REVIEW_ROUND_CAP = 2
# 主代理显式声明，不从正文、diff 或 hash 推断。前两项只在两轮用尽且最新一轮非 PASS 时被消费。
REVIEW_DISPOSITIONS = {
    "accept_residual_risk",
    "revise_without_rereview",
    "direction_rereview",
}
RESIDUAL_RISK_DISPOSITIONS = {
    "accept_residual_risk",
    "revise_without_rereview",
}
# 成本挑战只挑战技术路线，技术路线在 execution 面。
CHALLENGE_SURFACES = {"execution"}

RETIRED_STATE_FIELDS = ("task_tier", "lock_plan")
RETIRED_REVIEW_SLOTS = ("readiness", "guard")

TASK_CARD_KINDS = {"deliver", "explore"}
TASK_CARD_CONFIRM_MODES = {"popup", "card"}
TASK_CARD_STATUSES = {"draft", "confirmed", "running", "closed", "promoted"}
TASK_CARD_SOURCE_CHECK_STATUSES = {"confirmed", "running", "closed"}
TASK_CARD_REQUIRED_FIELDS = (
    "task_slug", "kind", "confirm_mode", "goal", "not_doing", "acceptance",
    "stop_when", "decisions", "wheel", "write_scope", "status",
)

NON_SEMANTIC_KEYS = {
    "updated_at",
    "last_package_id",
    "last_transaction_id",
    "last_handoff_ref",
    "package_id",
    "handoff_ref",
    "recording_gate",
}


def semantic_projection(value: Any) -> Any:
    """Return the business-semantic projection (non-semantic bookkeeping keys removed, keys sorted).

    Used only for structural equality (delta replay is a no-op when the projection is unchanged);
    no digest is ever derived from it.
    """
    if isinstance(value, dict):
        return {
            str(key): semantic_projection(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
            if key not in NON_SEMANTIC_KEYS
        }
    if isinstance(value, list):
        return [semantic_projection(item) for item in value]
    return value


def business_view(state: dict[str, Any]) -> Any:
    """Business content of an alignment state: everything except review metadata and recording bookkeeping."""
    return semantic_projection({
        key: value
        for key, value in state.items()
        if key not in {"recording", "review_refs"}
    })


def review_rounds(entries: Any, surface: str) -> list[dict[str, Any]]:
    """Entries for one surface ordered by round (missing round counts as 1)."""
    if not isinstance(entries, list):
        return []
    rows = [item for item in entries if isinstance(item, dict) and item.get("surface") == surface]
    return sorted(rows, key=lambda item: int(item.get("round") or 1))


def cross_rounds(reviews: dict[str, Any]) -> list[dict[str, Any]]:
    """Cross-surface rounds ordered by round; v4 stores them as a list."""
    entries = reviews.get("cross_surface") if isinstance(reviews, dict) else None
    if not isinstance(entries, list):
        return []
    rows = [item for item in entries if isinstance(item, dict)]
    return sorted(rows, key=lambda item: int(item.get("round") or 1))


def latest_round(entries: Any, surface: str) -> dict[str, Any] | None:
    rows = review_rounds(entries, surface)
    return rows[-1] if rows else None


def _present(value: Any) -> bool:
    """非空内容：非空白字符串（不是占位词）或非空映射 / 列表。布尔与数字不算填写。"""
    if isinstance(value, str):
        return bool(value.strip()) and value.strip().lower() not in PLACEHOLDER_VALUES
    if isinstance(value, (list, dict)):
        return bool(value)
    return False


def is_ref(value: Any) -> bool:
    """引用类字段（confirmation_ref、owner_resolution_ref 等）只能是非空白字符串。"""
    return isinstance(value, str) and _present(value)


def one_of(value: Any, allowed: Any) -> bool:
    """闭集成员判断；列表、映射等不可哈希值直接判为不在闭集内，不抛异常。"""
    return isinstance(value, str) and value in allowed


def round_ref(value: Any) -> tuple[str, int] | None:
    """解析规范写法的确认轮引用，返回 (log 路径, 轮号)；任何变体写法返回 None。"""
    if not isinstance(value, str):
        return None
    match = ROUND_REF_RE.fullmatch(value)
    if not match or match.group("log") != match.group("log").strip():
        return None
    return match.group("log"), int(match.group("number"))


def not_needed_reason(value: Any) -> str | None:
    """not_needed 标记的理由：`not_needed: <理由>` 字符串、`{not_needed: <理由>}` 映射或只含这一项的列表。

    不是 not_needed 标记时返回 None；是标记但理由为空时返回空串。
    """
    if isinstance(value, list) and len(value) == 1:
        return not_needed_reason(value[0])
    if isinstance(value, dict) and len(value) == 1:
        key, reason = next(iter(value.items()))
        if str(key).strip().lower() == "not_needed":
            return str(reason).strip() if isinstance(reason, str) else ""
        return None
    if isinstance(value, str):
        head, _, reason = value.strip().partition(":")
        if head.strip().lower() == "not_needed":
            return reason.strip()
    return None


def is_not_needed(value: Any) -> bool:
    return not_needed_reason(value) is not None


def _extract_block(path: Path, label: str) -> tuple[dict[str, Any], list[dict[str, str]]]:
    if yaml is None:
        raise ToolError("PyYAML is required for alignment_guard.py") from YAML_IMPORT_ERROR
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ToolError(f"context file not found: {rel(path)}") from exc
    except OSError as exc:
        raise ToolError(f"cannot read context file: {rel(path)}") from exc

    code = label.lower().replace(" ", "_")
    if path.suffix.lower() in {".yaml", ".yml"}:
        block_text = text
    else:
        lines = text.splitlines()
        heading_index = None
        for index, line in enumerate(lines):
            if line.strip().lower() == f"## {label}".lower():
                heading_index = index
                break
        if heading_index is None:
            return {}, [{"level": "error", "code": f"missing_{code}_heading", "message": f"missing `## {label}` section"}]

        fence_start = None
        for index in range(heading_index + 1, len(lines)):
            if lines[index].strip().startswith("```"):
                fence_start = index
                break
            if lines[index].startswith("## "):
                break
        if fence_start is None:
            return {}, [{"level": "error", "code": f"missing_{code}_fence", "message": f"`## {label}` has no fenced YAML block"}]

        block_lines: list[str] = []
        terminated = False
        for index in range(fence_start + 1, len(lines)):
            if lines[index].strip().startswith("```"):
                terminated = True
                break
            block_lines.append(lines[index])
        if not terminated:
            return {}, [{"level": "error", "code": f"unterminated_{code}_fence", "message": f"`## {label}` fenced block is not closed"}]
        block_text = "\n".join(block_lines)

    try:
        parsed = yaml.safe_load(block_text)
    except yaml.YAMLError as exc:
        return {}, [{"level": "error", "code": f"invalid_{code}_yaml", "message": f"{label} YAML block failed to parse: {exc}"}]
    if parsed is None or parsed == {}:
        return {}, [{"level": "error", "code": f"empty_{code}_yaml", "message": f"{label} YAML block is empty"}]
    if not isinstance(parsed, dict):
        return {}, [{"level": "error", "code": f"{code}_root_not_mapping", "message": f"{label} YAML block did not parse to a mapping"}]
    return parsed, []


def extract_alignment_state(path: Path) -> tuple[dict[str, Any], list[dict[str, str]]]:
    return _extract_block(path, "Alignment State")


def extract_task_card(path: Path) -> tuple[dict[str, Any], list[dict[str, str]]]:
    return _extract_block(path, "Task Card")


def extract_completion_state(path: Path) -> str | None:
    if path.suffix.lower() in {".yaml", ".yml"}:
        return None
    text = path.read_text(encoding="utf-8")
    match = re.search(r"`completion_state:\s*([a-z_]+)`", text)
    return match.group(1) if match else None


def list_item_blocks(data: dict[str, Any], top_key: str) -> list[dict[str, Any]]:
    value = data.get(top_key)
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def index_by(items: Any, key: str) -> dict[str, dict[str, Any]]:
    if not isinstance(items, list):
        return {}
    return {
        str(item[key]): item
        for item in items
        if isinstance(item, dict) and key in item and str(item[key]).strip()
    }


def add_issue(issues: list[dict[str, str]], code: str, message: str, level: str = "error") -> None:
    issues.append({"level": level, "code": code, "message": message})


def validate_pass_report_ref(
    issues: list[dict[str, str]],
    *,
    verdict: Any,
    report_ref: Any,
    location: str,
    pass_verdicts: frozenset[str] = frozenset({"PASS"}),
) -> None:
    if verdict not in pass_verdicts:
        return
    if not isinstance(report_ref, str) or not report_ref.strip():
        add_issue(issues, "missing_review_report_ref", f"{location} has {verdict} without report_ref")
        return
    path_text = report_ref.split("#", 1)[0]
    candidate = Path(path_text)
    if candidate.is_absolute():
        add_issue(issues, "invalid_review_report_ref", f"{location}.report_ref must be repository-relative")
        return
    resolved = (ROOT / candidate).resolve()
    try:
        resolved.relative_to(ROOT.resolve())
    except ValueError:
        add_issue(issues, "invalid_review_report_ref", f"{location}.report_ref escapes repository root")
        return
    if not resolved.is_file():
        add_issue(issues, "missing_review_report_file", f"{location}.report_ref does not resolve: {report_ref}")


def validate_review_round(issues: list[dict[str, str]], value: Any, location: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > REVIEW_ROUND_CAP:
        add_issue(issues, "invalid_review_round", f"{location}.round must be an integer in 1..{REVIEW_ROUND_CAP}, got {value!r}")


def validate_round_cap(issues: list[dict[str, str]], entries: list[Any], location: str, *, per_surface: bool = True) -> None:
    groups: dict[str, list[Any]] = {}
    for item in entries:
        if isinstance(item, dict):
            name = str(item.get("surface")) if per_surface else "cross_surface"
            groups.setdefault(name, []).append(item.get("round"))
    for name, numbers in sorted(groups.items()):
        if len(numbers) > REVIEW_ROUND_CAP:
            add_issue(issues, "review_round_cap_exceeded", f"{location}[{name}] has {len(numbers)} rounds; at most {REVIEW_ROUND_CAP} are allowed, then the owner decides")
        if sorted(number for number in numbers if isinstance(number, int) and not isinstance(number, bool)) != list(range(1, len(numbers) + 1)):
            add_issue(issues, "review_round_sequence_invalid", f"{location}[{name}] rounds must be 1..{len(numbers)} without gaps or repeats, got {numbers}")


def validate_review_disposition(
    issues: list[dict[str, str]],
    value: Any,
    location: str,
    *,
    allow_direction_rereview: bool,
) -> None:
    """Shape-check an explicit review disposition. Absence is valid; this is not a release gate."""
    if value is None:
        return
    allowed = REVIEW_DISPOSITIONS if allow_direction_rereview else RESIDUAL_RISK_DISPOSITIONS
    if not one_of(value, allowed):
        add_issue(issues, "invalid_review_disposition", f"{location}.review_disposition is invalid: {value!r}")


def surface_review_disposition(state: dict[str, Any], surface: str) -> str | None:
    """Read an explicit surface disposition. Ordinary lock decision_source without the field is not an adjudication."""
    locks = state.get("locks") if isinstance(state.get("locks"), dict) else {}
    if locks.get(f"{surface}_locked") is not True:
        return None
    sources = state.get("lock_sources") if isinstance(state.get("lock_sources"), dict) else {}
    entry = sources.get(surface) if isinstance(sources.get(surface), dict) else {}
    source = entry.get("decision_source") if isinstance(entry.get("decision_source"), dict) else {}
    value = source.get("review_disposition")
    if not one_of(value, REVIEW_DISPOSITIONS) or not is_ref(source.get("confirmation_ref")):
        return None
    if not one_of(source.get("type"), LOCK_SOURCE_TYPES):
        return None
    return value


def cross_review_disposition(cross: dict[str, Any] | None) -> str | None:
    if not isinstance(cross, dict):
        return None
    value = cross.get("review_disposition")
    if not one_of(value, RESIDUAL_RISK_DISPOSITIONS) or not is_ref(cross.get("owner_resolution_ref")):
        return None
    return value


def path_get(value: Any, *keys: str) -> Any:
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def locked_tech_route(decisions: Any) -> list[str]:
    return [
        str(item.get("id"))
        for item in decisions or []
        if isinstance(item, dict) and item.get("topic") == "tech_route" and item.get("status") == "locked"
    ]


def challenge_passed(state: dict[str, Any]) -> bool:
    reviews = state.get("review_refs") if isinstance(state.get("review_refs"), dict) else {}
    latest = latest_round(reviews.get("proposal_challenge"), "execution")
    if not isinstance(latest, dict):
        return False
    return latest.get("business_verdict") == "proposal_stands" or is_ref(latest.get("owner_resolution_ref"))


def round_status(entry: dict[str, Any]) -> Any:
    return entry.get("status", "closed")


def shown_unit_items(entry: dict[str, Any]) -> list[str]:
    """open 轮已展示单元（shown_units）里的全部项目，按单元与单元内顺序去重。"""
    shown = entry.get("shown_units") if isinstance(entry.get("shown_units"), list) else []
    items: list[str] = []
    units = entry.get("units")
    for unit in units if isinstance(units, list) else []:
        if isinstance(unit, dict) and unit.get("unit_id") in shown and isinstance(unit.get("items"), list):
            items.extend(item for item in unit["items"] if item not in items)
    return items


def index_confirmations(issues: list[dict[str, str]], value: Any) -> dict[str, dict[str, Any]]:
    """Validate the confirmation-round ledger and index it by ref."""
    if value is None:
        add_issue(issues, "missing_confirmations", "alignment_state.confirmations is missing")
        return {}
    if not isinstance(value, list):
        add_issue(issues, "confirmations_not_list", "alignment_state.confirmations must be a list")
        return {}
    rounds: dict[str, dict[str, Any]] = {}
    open_refs: list[str] = []
    for index, item in enumerate(value):
        location = f"confirmations[{index}]"
        if not isinstance(item, dict):
            add_issue(issues, "confirmation_invalid", f"{location} must be a mapping")
            continue
        ref = item.get("ref")
        if round_ref(ref) is None:
            add_issue(issues, "confirmation_invalid", f"{location}.ref must be <log>#round-N (lowercase, ASCII digits, no leading zero or padding), got {ref!r}")
            continue
        if not one_of(item.get("mode"), CONFIRMATION_MODES):
            add_issue(issues, "confirmation_invalid", f"{location}.mode must be one of {sorted(CONFIRMATION_MODES)}")
        presented = item.get("presented")
        if not isinstance(presented, list) or not all(isinstance(entry, str) and entry.strip() for entry in presented):
            add_issue(issues, "confirmation_invalid", f"{location}.presented must be a list of decision ids / surface names")
        if not isinstance(item.get("bulk_accept", False), bool):
            add_issue(issues, "confirmation_invalid", f"{location}.bulk_accept must be true or false")
        status = round_status(item)
        if not one_of(status, CONFIRMATION_STATUSES):
            add_issue(issues, "confirmation_invalid", f"{location}.status must be one of {list(CONFIRMATION_STATUSES)}, got {status!r}")
        for key in ("items", "pending", "shown_units"):
            if key in item and not isinstance(item[key], list):
                add_issue(issues, "confirmation_invalid", f"{location}.{key} must be a list")
        if "answers" in item and not isinstance(item["answers"], dict):
            add_issue(issues, "confirmation_invalid", f"{location}.answers must be a mapping")
        units = item.get("units")
        if units is not None and not (
            isinstance(units, list)
            and all(isinstance(unit, dict) and isinstance(unit.get("items"), list) for unit in units)
        ):
            add_issue(issues, "confirmation_invalid", f"{location}.units must be a list of mappings with items")
        elif status == "open" and isinstance(presented, list):
            # 渲染成功不等于用户看过：open 轮的 presented 只能来自实际展示过的单元；关闭后 presented 为定稿。
            shown = shown_unit_items(item)
            outside = [entry for entry in presented if entry not in shown]
            if outside:
                add_issue(issues, "presented_outside_shown_units", f"{location}.presented lists {outside}, which no shown unit carries")
        if ref in rounds:
            add_issue(issues, "confirmation_ref_duplicate", f"{location}.ref duplicates {ref}")
            continue
        if status == "open":
            open_refs.append(ref)
        rounds[ref] = item
    if len(open_refs) > 1:
        add_issue(issues, "open_round_duplicate", f"at most one confirmation round may be open; open rounds: {open_refs}")
    return rounds


def check_confirmation_round(
    issues: list[dict[str, str]],
    rounds: dict[str, dict[str, Any]],
    *,
    ref: Any,
    item_id: str,
    source_type: Any,
    source_mode: Any,
    location: str,
) -> None:
    """设计稿 §2.3 第 5 条：确认只支撑该轮实际呈现过的项。"""
    entry = rounds.get(ref) if round_ref(ref) is not None else None
    if entry is None:
        add_issue(issues, "confirmation_round_missing", f"{location} cites {ref!r}, which is not a recorded confirmation round")
        return
    status = round_status(entry)
    if status != "closed":
        add_issue(issues, "confirmation_round_not_closed", f"{location} cites {ref}, which is {status}; decisions and surface locks cite closed rounds only")
    presented = entry.get("presented") if isinstance(entry.get("presented"), list) else []
    if item_id not in presented:
        add_issue(issues, "not_presented_in_confirmation_round", f"{location}: {ref} did not present {item_id}")
    if source_mode is not None and entry.get("mode") != source_mode:
        add_issue(issues, "confirmation_mode_mismatch", f"{location}.source.mode={source_mode} but {ref} was a {entry.get('mode')} round")
    if source_type == "user_bulk_accepted" and entry.get("bulk_accept") is not True:
        add_issue(issues, "bulk_accept_not_recorded", f"{location} is user_bulk_accepted but {ref} has no bulk_accept")


def validate_decisions(
    issues: list[dict[str, str]],
    decisions: Any,
    *,
    location: str,
    rounds: dict[str, dict[str, Any]] | None,
    check_sources: bool,
    card_confirm_mode: str | None = None,
) -> None:
    """决策账本（设计稿 §2.2）。rounds=None 表示任务卡：卡片本身是呈现物，不核对确认轮。"""
    if decisions is None:
        decisions = []
    if not isinstance(decisions, list):
        add_issue(issues, "decisions_not_list", f"{location} must be a list")
        return
    seen: set[int] = set()
    for index, item in enumerate(decisions):
        where = f"{location}[{index}]"
        if not isinstance(item, dict):
            add_issue(issues, "decision_invalid", f"{where} must be a mapping")
            continue
        decision_id = item.get("id")
        id_match = DECISION_ID_RE.fullmatch(decision_id) if isinstance(decision_id, str) else None
        # 按数值判重：D-1 与 D-01 是同一条。
        if not id_match or int(id_match.group("number")) in seen:
            add_issue(issues, "decision_id_invalid", f"{where}.id must be a unique D-<digits>, got {decision_id!r}")
        else:
            seen.add(int(id_match.group("number")))
            where = f"{location}[{decision_id}]"
        topic = item.get("topic")
        topic_valid = one_of(topic, DECISION_TOPICS)
        if not topic_valid:
            add_issue(issues, "decision_topic_invalid", f"{where}.topic must be one of {sorted(DECISION_TOPICS)}, got {topic!r}")
        expected_class = "must_ask" if one_of(topic, MUST_ASK_TOPICS) else "disclosed_default"
        decision_class = item.get("class")
        if not one_of(decision_class, DECISION_CLASSES):
            add_issue(issues, "decision_class_invalid", f"{where}.class must be must_ask or disclosed_default, got {decision_class!r}")
        elif topic_valid and decision_class != expected_class:
            add_issue(issues, "decision_class_topic_mismatch", f"{where}: topic {topic} is {expected_class}, got class {decision_class}")
        status = item.get("status")
        if not one_of(status, DECISION_STATUSES):
            add_issue(issues, "decision_status_invalid", f"{where}.status must be one of {sorted(DECISION_STATUSES)}, got {status!r}")
        for key in ("question", "selected", "reason"):
            value = item.get(key)
            # 是 / 否类决策的 selected 可以是布尔或数字；其余字段必须是有内容的文本。
            filled = _present(value) or (key == "selected" and isinstance(value, (bool, int, float)))
            if not filled:
                add_issue(issues, "decision_field_missing", f"{where}.{key} is required")
        # override_cost 是默认项的结构字段；superseded 只免来源校验。
        if decision_class == "disclosed_default" and not _present(item.get("override_cost")):
            add_issue(issues, "decision_override_cost_missing", f"{where} is disclosed_default without override_cost")
        if not check_sources or status == "superseded":
            continue
        source = item.get("source")
        if not isinstance(source, dict):
            add_issue(issues, "decision_source_missing", f"{where}.source is required")
            continue
        source_type = source.get("type")
        source_mode = source.get("mode")
        if not one_of(source_type, DECISION_SOURCE_TYPES):
            add_issue(issues, "decision_source_type_invalid", f"{where}.source.type is invalid: {source_type!r}")
            continue
        if not one_of(source_mode, CONFIRMATION_MODES):
            add_issue(issues, "decision_source_mode_invalid", f"{where}.source.mode must be one of {sorted(CONFIRMATION_MODES)}, got {source_mode!r}")
        if not is_ref(source.get("confirmation_ref")):
            add_issue(issues, "missing_confirmation_ref", f"{where}.source.confirmation_ref is required")
        if source_type == "agent_default_reported":
            add_issue(issues, "decision_not_presented", f"{where} uses agent_default_reported; it belongs to the delivery report, not the ledger")
            continue
        if decision_class == "must_ask" and source_type == "evidence_derived":
            add_issue(issues, "evidence_derived_forbidden", f"{where} is must_ask; evidence_derived only locks facts")
            continue
        if decision_class == "must_ask" and source_type == "user_bulk_accepted":
            if source_mode != "card" or (card_confirm_mode is not None and card_confirm_mode != "card"):
                add_issue(issues, "must_ask_bulk_outside_card", f"{where} is must_ask; bulk acceptance only covers items listed on a card")
        if rounds is not None and source_type in PRESENTED_SOURCE_TYPES and id_match:
            ref = source.get("confirmation_ref")
            if isinstance(ref, str) and ref.endswith("#confirmation"):
                validate_card_decision(issues, item, location=where)
                continue
            check_confirmation_round(
                issues,
                rounds,
                ref=source.get("confirmation_ref"),
                item_id=decision_id,
                source_type=source_type,
                source_mode=source_mode,
                location=where,
            )


def validate_card_decision(issues: list[dict[str, str]], item: dict[str, Any], *, location: str) -> None:
    """Reuse an unchanged confirmed card decision, preserving its original source."""
    ref = item["source"]["confirmation_ref"]
    path = (ROOT / ref.removesuffix("#confirmation")).resolve()
    if not path.is_relative_to(ROOT.resolve()) or not path.is_file():
        add_issue(issues, "card_confirmation_missing", f"{location}: confirmed task card {ref} is unavailable")
        return
    block, parse_issues = extract_task_card(path)
    card = block.get("task_card") or {}
    if parse_issues or card.get("status") not in TASK_CARD_SOURCE_CHECK_STATUSES | {"promoted"}:
        add_issue(issues, "card_confirmation_invalid", f"{location}: {ref} must cite a confirmed or promoted task card")
        return
    originals = card.get("decisions") or []
    source_issues: list[dict[str, str]] = []
    validate_decisions(source_issues, originals, location="task_card.decisions", rounds=None,
                       check_sources=True, card_confirm_mode=card.get("confirm_mode"))
    if source_issues or item not in originals:
        add_issue(issues, "card_decision_changed", f"{location}: reuse the confirmed card decision unchanged; present new differences in a confirmation round")


def preview_issues(preview: dict[str, Any]) -> list[tuple[str, str]]:
    """Surface-specific shape of one preview. Accepted previews carry the full v4 contract."""
    problems: list[tuple[str, str]] = []
    surface = preview.get("surface")
    for key in SURFACE_PREVIEW_REQUIRED_FIELDS:
        if key not in preview:
            problems.append(("surface_preview_field_missing", f"{surface} preview missing {key}"))
    status = preview.get("status")
    if not one_of(status, PREVIEW_STATUSES):
        problems.append(("surface_preview_status_invalid", f"{surface} preview status must be one of {sorted(PREVIEW_STATUSES)}, got {status!r}"))
    if status != "accepted":
        return problems
    if preview.get("still_open") not in ([], None):
        problems.append(("accepted_preview_still_open", f"accepted {surface} preview has still_open items"))
    if surface == "product_experience":
        product_surface = preview.get("product_surface")
        if not one_of(product_surface, PRODUCT_SURFACES):
            problems.append(("product_surface_invalid", f"product_experience.product_surface must be one of {sorted(PRODUCT_SURFACES)}, got {product_surface!r}"))
        elif product_surface in UI_PRODUCT_SURFACES:
            for key in ("surface_contract", "ui_design_contract"):
                if not _present(preview.get(key)):
                    problems.append(("ui_contract_missing", f"product_surface={product_surface} requires {key}"))
    if surface == "execution":
        sections = preview.get("sections")
        if not isinstance(sections, dict):
            problems.append(("execution_sections_missing", "accepted execution preview requires sections with tech / landing / quality / validation / structure"))
            return problems
        for key in EXECUTION_SECTIONS:
            value = sections.get(key)
            reason = not_needed_reason(value)
            if not _present(value):
                problems.append(("execution_section_missing", f"execution.sections.{key} is empty"))
            elif reason is not None and key in EXECUTION_SECTIONS_REQUIRED:
                problems.append(("execution_section_not_needed_forbidden", f"execution.sections.{key} cannot be not_needed"))
            elif reason == "":
                problems.append(("not_needed_reason_missing", f"execution.sections.{key} says not_needed without a reason"))
        tech = sections.get("tech")
        if isinstance(tech, dict):
            wheel = tech.get("wheel")
            wheel_reason = not_needed_reason(wheel)
            if not ((isinstance(wheel, str) and _present(wheel)) or wheel_reason is not None):
                problems.append(("tech_wheel_missing", "execution.sections.tech.wheel must cite the wheel-discovery report or say not_needed: <reason>"))
            elif wheel_reason == "":
                problems.append(("not_needed_reason_missing", "execution.sections.tech.wheel says not_needed without a reason"))
            if round_ref(tech.get("user_constraints_ref")) is None:
                problems.append(("user_constraints_ref_missing", "execution.sections.tech.user_constraints_ref must cite the interview answer (<log>#round-N)"))
        elif _present(tech) and not is_not_needed(tech):
            problems.append(("tech_wheel_missing", "execution.sections.tech must be a mapping with wheel and user_constraints_ref"))
    return problems


def validate_exit_gate(issues: list[dict[str, str]], state: dict[str, Any]) -> None:
    """出站核对未决项、面锁、审查/裁决、成本挑战与未完成确认轮。"""
    if state.get("open_questions"):
        add_issue(issues, "open_questions_not_empty", "open_questions must be [] before leaving alignment")
    confirmations = state.get("confirmations") if isinstance(state.get("confirmations"), list) else []
    open_refs = [
        item.get("ref") for item in confirmations
        if isinstance(item, dict) and round_status(item) == "open"
    ]
    if open_refs:
        add_issue(issues, "open_round_pending", f"confirmation rounds {open_refs} are still open; answer or cancel them before leaving alignment")
    locks = state.get("locks") if isinstance(state.get("locks"), dict) else {}
    for surface in ALIGNMENT_SURFACES:
        if locks.get(f"{surface}_locked") is not True:
            add_issue(issues, "surface_not_locked", f"{surface} must be locked before leaving alignment")
    reviews = state.get("review_refs") if isinstance(state.get("review_refs"), dict) else {}
    for surface in ALIGNMENT_SURFACES:
        rounds = review_rounds(reviews.get("surface_slice"), surface)
        if not rounds:
            add_issue(issues, "surface_review_not_passed", f"{surface} has no surface_slice review record")
            continue
        verdict = rounds[-1].get("business_verdict")
        if verdict == "PASS":
            if surface_review_disposition(state, surface) == "direction_rereview" and len(rounds) < REVIEW_ROUND_CAP:
                add_issue(issues, "surface_rereview_pending", f"{surface} declares direction_rereview; round {len(rounds) + 1} review must run before leaving alignment")
            continue
        if surface_review_disposition(state, surface) in RESIDUAL_RISK_DISPOSITIONS:
            continue
        add_issue(
            issues,
            "surface_review_not_passed",
            f"{surface} latest surface_slice round {len(rounds)} is {verdict} without an accept_residual_risk / revise_without_rereview adjudication",
        )
    cross = cross_rounds(reviews)
    latest = cross[-1] if cross else None
    if not (latest and latest.get("business_verdict") == "PASS") and not (
        cross_review_disposition(latest)
    ):
        add_issue(
            issues,
            "cross_surface_review_not_passed",
            f"cross_surface latest round {len(cross) or '-'} is {latest.get('business_verdict') if latest else None} without an accept_residual_risk / revise_without_rereview adjudication and owner_resolution_ref",
        )
    if locked_tech_route(state.get("decisions")) and not challenge_passed(state):
        add_issue(issues, "proposal_challenge_not_passed", "tech_route decisions require the execution cost challenge to stand or carry an owner resolution")


def validate_review_refs(issues: list[dict[str, str]], state: dict[str, Any]) -> None:
    if "review_refs" not in state:
        add_issue(issues, "missing_review_refs", "alignment_state.review_refs is missing")
        return
    review_refs = state["review_refs"]
    if not isinstance(review_refs, dict):
        add_issue(issues, "review_refs_not_mapping", "alignment_state.review_refs must be a mapping")
        return
    for slot in RETIRED_REVIEW_SLOTS:
        if slot in review_refs:
            add_issue(issues, "retired_field", f"review_refs.{slot} is retired in v4")

    surface_slice = review_refs.get("surface_slice")
    if not isinstance(surface_slice, list):
        add_issue(issues, "surface_slice_not_list", "review_refs.surface_slice must be a list")
    else:
        for index, item in enumerate(surface_slice):
            location = f"review_refs.surface_slice[{index}]"
            if not isinstance(item, dict):
                add_issue(issues, "surface_slice_item_not_mapping", f"{location} must be a mapping")
                continue
            surface = item.get("surface")
            if not one_of(surface, ALIGNMENT_SURFACES):
                add_issue(issues, "invalid_surface_review_surface", f"{location}.surface is invalid: {surface}")
            else:
                location = f"review_refs.surface_slice[{surface}]"
            verdict = item.get("business_verdict")
            if not one_of(verdict, SURFACE_REVIEW_VERDICTS):
                add_issue(issues, "invalid_surface_review_verdict", f"{location}.business_verdict is invalid: {verdict}")
            validate_review_round(issues, item.get("round"), location)
            validate_pass_report_ref(issues, verdict=verdict, report_ref=item.get("report_ref"), location=location)
        validate_round_cap(issues, surface_slice, "review_refs.surface_slice")

    cross = review_refs.get("cross_surface")
    if not isinstance(cross, list):
        add_issue(issues, "cross_surface_not_list", "review_refs.cross_surface must be a list of rounds")
    else:
        for index, item in enumerate(cross):
            location = f"review_refs.cross_surface[{index}]"
            if not isinstance(item, dict):
                add_issue(issues, "cross_surface_item_not_mapping", f"{location} must be a mapping")
                continue
            verdict = item.get("business_verdict")
            if not one_of(verdict, SURFACE_REVIEW_VERDICTS):
                add_issue(issues, "invalid_cross_surface_review_verdict", f"{location}.business_verdict is invalid: {verdict}")
            validate_review_round(issues, item.get("round"), location)
            validate_review_disposition(issues, item.get("review_disposition"), location, allow_direction_rereview=False)
            resolution = item.get("owner_resolution_ref")
            if resolution is not None and not is_ref(resolution):
                add_issue(issues, "invalid_owner_resolution_ref", f"{location}.owner_resolution_ref must be a non-empty string when present")
            validate_pass_report_ref(issues, verdict=verdict, report_ref=item.get("report_ref"), location=location)
        validate_round_cap(issues, cross, "review_refs.cross_surface", per_surface=False)

    proposal_challenge = review_refs.get("proposal_challenge")
    if not isinstance(proposal_challenge, list):
        add_issue(issues, "proposal_challenge_not_list", "review_refs.proposal_challenge must be a list")
        return
    for index, item in enumerate(proposal_challenge):
        location = f"review_refs.proposal_challenge[{index}]"
        if not isinstance(item, dict):
            add_issue(issues, "proposal_challenge_item_not_mapping", f"{location} must be a mapping")
            continue
        surface = item.get("surface")
        if not one_of(surface, CHALLENGE_SURFACES):
            add_issue(issues, "proposal_challenge_surface_not_allowed", f"{location}: only {sorted(CHALLENGE_SURFACES)} may be challenged, got {surface!r}")
        else:
            location = f"review_refs.proposal_challenge[{surface}]"
        verdict = item.get("business_verdict")
        if not one_of(verdict, PROPOSAL_CHALLENGE_VERDICTS):
            add_issue(issues, "invalid_proposal_challenge_verdict", f"{location}.business_verdict is invalid: {verdict}")
        validate_review_round(issues, item.get("round"), location)
        resolution = item.get("owner_resolution_ref")
        if resolution is not None and not is_ref(resolution):
            add_issue(issues, "invalid_owner_resolution_ref", f"{location}.owner_resolution_ref must be a non-empty string when present")
        validate_pass_report_ref(
            issues,
            verdict=verdict,
            report_ref=item.get("report_ref"),
            location=location,
            pass_verdicts=frozenset({"proposal_stands"}),
        )
    validate_round_cap(issues, proposal_challenge, "review_refs.proposal_challenge")


def validate_state(
    issues: list[dict[str, str]],
    state: dict[str, Any],
    *,
    completion_state: str | None,
    target: str,
) -> dict[str, Any] | None:
    version = state.get("version")
    if version in FROZEN_STATE_VERSIONS:
        add_issue(issues, "state_version_frozen", f"alignment_state.version={version} is frozen history; v4 tools neither consume nor write it")
        return None
    if version != STATE_VERSION:
        add_issue(issues, "state_version_invalid", f"alignment_state.version must be {STATE_VERSION}, got {version!r}")
        return None

    for key in RETIRED_STATE_FIELDS:
        if key in state:
            add_issue(issues, "retired_field", f"alignment_state.{key} is retired in v4")

    current_stage = state.get("current_stage") if isinstance(state.get("current_stage"), str) else ""
    if current_stage not in STAGE_COMPLETION_STATES:
        add_issue(issues, "stage_invalid", f"current_stage must be one of {list(STAGES)}, got {current_stage or 'missing'}")
    elif completion_state and completion_state != STAGE_COMPLETION_STATES[current_stage]:
        add_issue(
            issues,
            "completion_state_stage_mismatch",
            f"current_stage={current_stage} requires completion_state {STAGE_COMPLETION_STATES[current_stage]}, got {completion_state}",
        )
    active_surface = state.get("active_surface")
    if active_surface is not None and not one_of(active_surface, ALIGNMENT_SURFACES):
        add_issue(issues, "active_surface_invalid", f"active_surface must be one of {list(ALIGNMENT_SURFACES)} or null, got {active_surface!r}")

    next_action = state.get("next_action") if isinstance(state.get("next_action"), dict) else {}
    action_type = next_action.get("type")
    if not action_type:
        add_issue(issues, "missing_next_action_type", "alignment_state.next_action.type is missing")
    elif not one_of(action_type, ALLOWED_NEXT_ACTIONS):
        add_issue(issues, "invalid_next_action_type", f"alignment_state.next_action.type={action_type} is not allowed")
    elif action_type == "dispatch_fact" and not (isinstance(next_action.get("route_id"), str) and ROUTE_ID_RE.fullmatch(next_action["route_id"])):
        add_issue(issues, "dispatch_fact_route_missing", "next_action.type=dispatch_fact requires route_id (role__capability)")

    seed = next_action.get("dispatch_seed") if isinstance(next_action.get("dispatch_seed"), dict) else {}
    if target == "planner":
        if action_type != "enter_planner":
            add_issue(issues, "planner_target_not_enter_planner", "planner target requires next_action.type=enter_planner")
        if seed.get("route") and seed.get("route") != "planner-agent":
            add_issue(issues, "planner_target_route_mismatch", f"enter_planner route must be planner-agent, got {seed.get('route')}")
        if seed.get("capability") and seed.get("capability") != "plan-authoring":
            add_issue(issues, "planner_target_capability_mismatch", f"enter_planner capability must be plan-authoring, got {seed.get('capability')}")

    rounds = index_confirmations(issues, state.get("confirmations"))

    locks = state.get("locks")
    if not isinstance(locks, dict):
        add_issue(issues, "locks_not_mapping", "alignment_state.locks must be a mapping")
        locks = {}
    sources = state.get("lock_sources") if isinstance(state.get("lock_sources"), dict) else {}
    for surface in ALIGNMENT_SURFACES:
        value = locks.get(f"{surface}_locked")
        if value not in (True, False):
            add_issue(issues, "lock_value_invalid", f"locks.{surface}_locked must be true or false, got {value!r}")
        if value is not True:
            continue
        entry = sources.get(surface) if isinstance(sources.get(surface), dict) else {}
        source = entry.get("decision_source") if isinstance(entry.get("decision_source"), dict) else {}
        location = f"lock_sources.{surface}"
        source_type = source.get("type")
        if not source_type:
            add_issue(issues, "missing_decision_source_type", f"{location} missing decision_source.type")
            continue
        if source_type == "evidence_derived":
            add_issue(issues, "evidence_derived_forbidden", f"{location} uses evidence_derived; surface locks need a user or owner confirmation")
            continue
        if not one_of(source_type, LOCK_SOURCE_TYPES):
            add_issue(issues, "lock_source_type_invalid", f"{location} has decision_source.type={source_type}")
            continue
        if not is_ref(source.get("confirmation_ref")):
            add_issue(issues, "missing_confirmation_ref", f"{location} missing decision_source.confirmation_ref")
            continue
        round_entry = rounds.get(source.get("confirmation_ref")) if round_ref(source.get("confirmation_ref")) else None
        check_confirmation_round(
            issues,
            rounds,
            ref=source.get("confirmation_ref"),
            item_id=surface,
            source_type=source_type,
            source_mode=None,
            location=location,
        )
        if source_type == "user_bulk_accepted" and isinstance(round_entry, dict) and round_entry.get("mode") != "card":
            add_issue(issues, "must_ask_bulk_outside_card", f"{location}: bulk acceptance locks a surface only in a card round")
        validate_review_disposition(
            issues,
            source.get("review_disposition"),
            f"{location}.decision_source",
            allow_direction_rereview=True,
        )
    planner_allowed = locks.get("planner_allowed", False)
    if planner_allowed not in (True, False):
        add_issue(issues, "lock_value_invalid", f"locks.planner_allowed must be true or false, got {planner_allowed!r}")

    previews = state.get("surface_previews")
    if not isinstance(previews, list):
        add_issue(issues, "surface_previews_not_list", "alignment_state.surface_previews must be a list")
        previews = []
    seen_previews: set[str] = set()
    for preview in previews:
        if not isinstance(preview, dict) or not one_of(preview.get("surface"), ALIGNMENT_SURFACES):
            add_issue(issues, "surface_preview_surface_invalid", f"surface_previews item has invalid surface: {preview.get('surface') if isinstance(preview, dict) else preview!r}")
            continue
        if preview["surface"] in seen_previews:
            add_issue(issues, "surface_preview_duplicate", f"surface_previews lists {preview['surface']} twice")
            continue
        seen_previews.add(preview["surface"])
        for code, message in preview_issues(preview):
            add_issue(issues, code, message)
        tech = (preview.get("sections") or {}).get("tech") if isinstance(preview.get("sections"), dict) else None
        constraints = round_ref(tech.get("user_constraints_ref")) if isinstance(tech, dict) else None
        if preview.get("status") == "accepted" and constraints is not None:
            ref = tech["user_constraints_ref"]
            entry = rounds.get(ref)
            accepted_by = round_ref(path_get(preview, "decision_source", "confirmation_ref"))
            if entry is None:
                add_issue(issues, "user_constraints_round_missing", f"execution.sections.tech.user_constraints_ref {ref} is not a recorded confirmation round")
            elif round_status(entry) != "closed" or "user_constraints" not in (entry.get("presented") or []):
                add_issue(issues, "user_constraints_round_invalid", f"{ref} did not present user_constraints (the pitfalls question)")
            elif accepted_by and accepted_by[0] == constraints[0] and constraints[1] > accepted_by[1]:
                add_issue(issues, "user_constraints_round_invalid", f"{ref} must come no later than the round that accepts execution ({accepted_by[1]})")
    indexed = index_by(previews, "surface")
    for surface in ALIGNMENT_SURFACES:
        if locks.get(f"{surface}_locked") is not True:
            continue
        preview = indexed.get(surface)
        if not isinstance(preview, dict) or preview.get("status") != "accepted":
            add_issue(issues, "locked_surface_preview_not_accepted", f"{surface} is locked without accepted preview")
    if locks.get("execution_locked") is True and not (
        locks.get("requirements_locked") is True and locks.get("product_experience_locked") is True
    ):
        add_issue(issues, "solution_before_product", "execution is locked before requirements and product_experience")

    validate_decisions(issues, state.get("decisions"), location="decisions", rounds=rounds, check_sources=True)
    tech_route = locked_tech_route(state.get("decisions"))
    execution_preview = indexed.get("execution") or {}
    if tech_route and locks.get("execution_locked") is True:
        if not challenge_passed(state):
            add_issue(issues, "execution_locked_without_challenge", f"tech_route decisions {tech_route} need the execution cost challenge to stand or carry an owner resolution before execution locks")
        tech = (execution_preview.get("sections") or {}).get("tech") if isinstance(execution_preview.get("sections"), dict) else None
        if isinstance(tech, dict) and is_not_needed(tech.get("wheel")):
            add_issue(issues, "tech_route_without_wheel_discovery", "tech_route decisions exist but execution.sections.tech.wheel is not_needed")

    validate_review_refs(issues, state)

    closing_posture = (
        current_stage in CLOSING_STAGES
        or completion_state in {"locked_pending_gate", "dispatch_ready"}
        or planner_allowed is True
    )
    if closing_posture or target == "planner":
        validate_exit_gate(issues, state)

    recording = state.get("recording") if isinstance(state.get("recording"), dict) else {}
    if recording.get("recording_gate") != "pass":
        add_issue(issues, "recording_gate_not_pass", "alignment_state.recording.recording_gate must be pass")

    if not tech_route:
        return {"result": "not_needed"}
    return {"result": "true" if challenge_passed(state) else "false", "tech_route_decisions": tech_route}


def build_data(context: Path, target: str) -> dict[str, Any]:
    if target == "card":
        return build_card_data(context)
    block, issues = extract_alignment_state(context)
    challenge: dict[str, Any] | None = None
    if block and "alignment_state" not in block:
        add_issue(issues, "missing_alignment_state_root", "Alignment State block does not contain `alignment_state:` root")
    state = block.get("alignment_state") if isinstance(block, dict) else None
    if block and not isinstance(state, dict):
        add_issue(issues, "alignment_state_not_mapping", "`alignment_state` root must be a mapping")
    if isinstance(state, dict):
        challenge = validate_state(issues, state, completion_state=extract_completion_state(context), target=target)
    return finish(issues, context=context, target=target, checks={
        "allowed_next_actions": sorted(ALLOWED_NEXT_ACTIONS),
        "decision_source_types": sorted(DECISION_SOURCE_TYPES),
        "proposal_challenge_passed": challenge,
    })


def build_card_data(context: Path) -> dict[str, Any]:
    """任务卡校验（设计稿 §4.3）：字段齐全、acceptance 与 write_scope 非空、决策来源合规。"""
    block, issues = extract_task_card(context)
    card = block.get("task_card") if isinstance(block, dict) else None
    if block and not isinstance(card, dict):
        add_issue(issues, "task_card_root_missing", "Task Card block must be a mapping rooted at `task_card:`")
    if isinstance(card, dict):
        for key in TASK_CARD_REQUIRED_FIELDS:
            if key not in card:
                add_issue(issues, "task_card_field_missing", f"task_card.{key} is required")
        kind = card.get("kind")
        status = card.get("status")
        confirm_mode = card.get("confirm_mode")
        if not one_of(kind, TASK_CARD_KINDS):
            add_issue(issues, "task_card_kind_invalid", f"task_card.kind must be one of {sorted(TASK_CARD_KINDS)}, got {kind!r}")
        if not one_of(confirm_mode, TASK_CARD_CONFIRM_MODES):
            add_issue(issues, "task_card_confirm_mode_invalid", f"task_card.confirm_mode must be popup or card, got {confirm_mode!r}")
        if not one_of(status, TASK_CARD_STATUSES):
            add_issue(issues, "task_card_status_invalid", f"task_card.status must be one of {sorted(TASK_CARD_STATUSES)}, got {status!r}")
        for key in ("task_slug", "goal"):
            if key in card and not (isinstance(card.get(key), str) and _present(card.get(key))):
                add_issue(issues, "task_card_field_empty", f"task_card.{key} must be a non-empty string")
        wheel = card.get("wheel")
        if "wheel" in card:
            wheel_reason = not_needed_reason(wheel)
            if not ((isinstance(wheel, str) and _present(wheel)) or wheel_reason is not None):
                add_issue(issues, "task_card_field_empty", "task_card.wheel must cite what was checked or say not_needed: <reason>")
            elif wheel_reason == "":
                add_issue(issues, "not_needed_reason_missing", "task_card.wheel says not_needed without a reason")
        for key in ("not_doing", "stop_when", "write_scope", "decisions"):
            if key in card and not isinstance(card.get(key), list):
                add_issue(issues, "task_card_field_not_list", f"task_card.{key} must be a list")
        acceptance = card.get("acceptance")
        if not isinstance(acceptance, list) or not acceptance:
            add_issue(issues, "task_card_acceptance_empty", "task_card.acceptance needs at least one check")
        else:
            for index, item in enumerate(acceptance):
                if not isinstance(item, dict) or not _present(item.get("check")) or not _present(item.get("pass_when")):
                    add_issue(issues, "task_card_acceptance_item_invalid", f"task_card.acceptance[{index}] needs check and pass_when")
        if not (isinstance(card.get("write_scope"), list) and card["write_scope"]):
            add_issue(issues, "task_card_write_scope_empty", "task_card.write_scope must not be empty")
        attempts = card.get("attempts")
        if kind == "deliver" and attempts:
            add_issue(issues, "task_card_attempts_on_deliver", "task_card.attempts belongs to kind=explore")
        if kind == "explore":
            if not (isinstance(card.get("stop_when"), list) and card["stop_when"]):
                add_issue(issues, "task_card_stop_when_empty", "kind=explore needs stop_when (at least: stop after attempts yield no new information)")
            if attempts is not None and not isinstance(attempts, list):
                add_issue(issues, "task_card_field_not_list", "task_card.attempts must be a list")
        validate_decisions(
            issues,
            card.get("decisions"),
            location="task_card.decisions",
            rounds=None,
            check_sources=one_of(status, TASK_CARD_SOURCE_CHECK_STATUSES),
            card_confirm_mode=confirm_mode if isinstance(confirm_mode, str) else None,
        )
        if locked_tech_route(card.get("decisions")) and is_not_needed(card.get("wheel")):
            add_issue(issues, "tech_route_without_wheel_discovery", "task card has tech_route decisions but wheel is not_needed")
    return finish(issues, context=context, target="card", checks={
        "decision_source_types": sorted(DECISION_SOURCE_TYPES),
        "card_statuses": sorted(TASK_CARD_STATUSES),
    })


def finish(issues: list[dict[str, str]], *, context: Path, target: str, checks: dict[str, Any]) -> dict[str, Any]:
    error_count = sum(1 for issue in issues if issue["level"] == "error")
    status = "pass" if error_count == 0 else "fail"
    return {
        "tool": "alignment_guard",
        "status": status,
        "exit_code": 0 if status == "pass" else 1,
        "context": rel(context),
        "target": target,
        "checks": checks,
        "issues": issues,
    }


def run_self_test() -> None:
    from alignment_guard_selftest import run_self_test as _run_self_test

    _run_self_test()


def emit_planner_seed(context: Path, args: argparse.Namespace) -> dict[str, Any]:
    """Project the approved state into the existing topology route."""
    data = build_data(context, "planner")
    if data["status"] != "pass":
        return data
    block, _ = extract_alignment_state(context)
    state = block["alignment_state"]
    prior = (state.get("next_action") or {}).get("dispatch_seed") or {}
    contract, refs, scope = (prior.get(key) or {} for key in ("contract", "required_refs", "scope"))
    issues = data["issues"]
    phase = {key: getattr(args, key) or contract.get(key) for key in ("phase_id", "phase_goal", "phase_dir")}
    missing = [key for key, value in phase.items() if not value]
    writes = args.write_path or scope.get("write_extra") or scope.get("write") or []
    if not writes:
        missing.append("scope.write_extra")
    if str((state.get("locks") or {}).get("planner_allowed")).lower() != "true":
        add_issue(issues, "planner_not_authorized", "planner_allowed must be true before emitting a seed")

    def project_path(value: str, *, reference: bool = False) -> str | None:
        path = (ROOT / value.split("#", 1)[0]).resolve()
        try:
            path.relative_to(ROOT.resolve())
        except ValueError:
            add_issue(issues, "planner_path_outside_project", f"path escapes project root: {value}")
            return None
        if reference and not path.exists():
            add_issue(issues, "planner_reference_missing", f"reference does not exist: {value}")
        return rel(path)

    context_ref = project_path(str(context), reference=True)
    seed_ref = project_path(args.emit_planner_seed)
    guard_ref = project_path(args.report or str(Path(args.emit_planner_seed).with_suffix(".guard.json")))
    if context_ref in (seed_ref, guard_ref) or seed_ref == guard_ref:
        add_issue(issues, "planner_output_collision", "seed, guard report and source context must use distinct paths")
    for value in writes + ([phase["phase_dir"]] if phase["phase_dir"] else []):
        project_path(value)
    objects = {}
    specs = state.get("alignment_spec") or []
    for item in specs if isinstance(specs, list) else []:
        spec_id = item.get("spec_id") if isinstance(item, dict) else None
        validation = item.get("validation_object") if isinstance(item, dict) else None
        if not spec_id or not validation or spec_id in objects:
            add_issue(issues, "planner_validation_object_invalid", f"spec needs unique spec_id and validation_object: {spec_id}")
        else:
            objects[spec_id] = validation
    if not objects:
        add_issue(issues, "planner_validation_objects_missing", "alignment_spec has no validation objects")
    basis = {}
    for key, alias in (("runtime_basis_ref", "env_scan_ref"), ("network_basis_ref", "network_scan_ref")):
        value = contract.get(key) or refs.get(key) or refs.get(alias)
        if value and value != "not_needed":
            basis[key] = value
    reads = list(dict.fromkeys([context_ref] + list(scope.get("read") or []) + list(basis.values())))
    for value in reads:
        if value:
            project_path(value, reference=True)
    data["missing_inputs"] = missing
    for key in missing:
        add_issue(issues, "planner_input_missing", f"supply {key}; it is not derivable from the approved state")
    data.update(status="fail" if issues else "pass", exit_code=1 if issues else 0)
    if issues:
        return data
    decisions = [item["id"] for item in state.get("decisions", []) if item.get("status") == "locked" and item.get("id")]
    seed = {
        "route_id": "planner-agent__plan-authoring", "goal": phase["phase_goal"],
        "scope": {"read": list(dict.fromkeys(reads + [guard_ref])), "write_extra": writes},
        "contract": {
            "input_mode": "alignment_native", "planning_pass": "topology", **phase,
            "context_path": context_ref, "trusted_spec_ref": context_ref + "#alignment_spec",
            "alignment_state_ref": context_ref, "alignment_guard_ref": guard_ref,
            "validation_objects": objects, "locked_decisions": decisions, **basis,
        },
    }
    for ref, value in ((guard_ref, data), (seed_ref, seed)):
        path = ROOT / ref
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    data.update(planner_seed_ref=seed_ref, planner_guard_ref=guard_ref)
    return data


def build_text(data: dict[str, Any]) -> str:
    lines = [
        "# Alignment Guard",
        "",
        f"status: {data['status']}",
        f"context: {data['context']}",
        f"target: {data['target']}",
        f"issue_count: {len(data['issues'])}",
    ]
    if data["issues"]:
        lines.extend(["", "## Issues"])
        for issue in data["issues"]:
            lines.append(f"- {issue['level']} {issue['code']}: {issue['message']}")
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "校验 alignment state（v4）与任务卡，防止带病决策流入规划器或执行器。\n"
            "由主代理在派发 planner 或按任务卡执行前调用：面锁来源、确认轮、决策账本、审查轮次与出站门禁。"
        ),
        epilog=(
            "典型用法：\n"
            "  python -B alignment_guard.py --context notes/context/<task>-alignment.md --target planner --format text\n"
            "  python -B alignment_guard.py --context notes/context/<task>-card.md --target card --format text\n\n"
            "合同：notes/context/alignment-v4-batch2-contract.md"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--context",
        help="待校验文件路径：规格书含 `## Alignment State` YAML 围栏；任务卡含 `## Task Card` YAML 围栏。",
    )
    parser.add_argument(
        "--target",
        choices=("context", "planner", "card"),
        default="context",
        help=(
            "context：校验规格书状态结构，收口态（exit / complete / planner_allowed=true）同时执行出站门禁；"
            "planner：另要求 next_action.type=enter_planner 且 route=planner-agent，并执行出站门禁；"
            "card：校验任务卡。（默认：context）"
        ),
    )
    parser.add_argument(
        "--report",
        help="可选，将 JSON 结果同时写入该仓库内路径（相对于仓库根），便于后续工具读取。",
    )
    parser.add_argument("--emit-planner-seed", help="从已批准状态生成首轮 topology seed，不派发模型")
    parser.add_argument("--phase-id")
    parser.add_argument("--phase-goal")
    parser.add_argument("--phase-dir")
    parser.add_argument("--write-path", action="append", default=[], help="明确的 planner 产物写域，可重复；省略时复用状态写域")
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="json",
        help="输出格式：text 输出人类可读的文本摘要；json 输出机器可读的完整结构体。（默认：json）",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="运行内置机械测试用例（不需要 --context），验证工具本身行为正确。",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.self_test:
        run_self_test()
        print("alignment_guard self-test: pass")
        return 0
    if args.context:
        context = (ROOT / args.context).resolve()
    else:
        raise ToolError("--context is required unless --self-test is used")
    try:
        context.relative_to(ROOT)
    except ValueError as exc:
        raise ToolError(f"context is outside repository: {context}") from exc
    if args.emit_planner_seed and args.target == "card":
        raise ToolError("--emit-planner-seed reads an alignment spec; task cards do not enter the planner")

    data = emit_planner_seed(context, args) if args.emit_planner_seed else build_data(context, args.target)
    if args.report and not args.emit_planner_seed:
        report = (ROOT / args.report).resolve()
        try:
            report.relative_to(ROOT)
        except ValueError as exc:
            raise ToolError(f"report is outside repository: {report}") from exc
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    text = build_text(data)
    if data.get("planner_seed_ref"):
        text += f"\nplanner_seed: {data['planner_seed_ref']}\nguard_report: {data['planner_guard_ref']}"
    return emit(data, args.format, text)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ToolError as exc:
        print(f"alignment_guard: {exc}", file=sys.stderr)
        raise SystemExit(2)
