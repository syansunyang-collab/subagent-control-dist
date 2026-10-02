"""从 alignment_recorder.py 原样搬出的 G3 草案规范化。"""

from __future__ import annotations

import copy
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

from _tool_common import rel
from alignment_guard import (
    ALIGNMENT_SURFACES,
    CONFIRMATION_MODES,
    DECISION_ID_RE,
    DECISION_TOPICS,
    MUST_ASK_TOPICS,
    REVIEW_DISPOSITIONS,
    STAGE_SURFACES,
    index_by,
    one_of,
    preview_issues,
    round_ref,
    round_status,
)
from alignment_recorder_parts.constants import (
    ALIGNMENT_SPEC_REQUIRED,
    ALLOWED_STAGES,
    DECISION_ITEM_KEYS,
    DRAFT_KEYS,
    MARKER_DEFAULTS,
    MARKER_ITEM_KEYS,
    POPUP_OPTION_RANGE,
    ROUND_ITEM_KINDS,
    ROUND_MARKERS,
    SUPERSEDABLE_STATUSES,
)
from alignment_recorder_parts.state import path_value

class Issues(list):
    """以 issue(错误码, 说明) 的形式收集问题；与 preflight 的 issue 同形，--schema 的提示覆盖检查按此识别错误码。"""

    def __call__(self, code: str, message: str) -> None:
        self.append({"code": code, "message": message})


@dataclass
class G3Paths:
    source: dict[str, Path]
    output: dict[str, Path]

    @property
    def log_rel(self) -> str:
        return rel(self.source["discussion_log"])

    @property
    def spec_ref(self) -> str:
        return rel(self.output["spec"])


def filled(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def one_line(value: Any) -> str:
    # 讨论日志按 `## Round N` 切节，自由文本里的换行不能带出新标题。
    return " ".join(str(value).split())


def item_key(item: dict[str, Any]) -> str:
    if item["kind"] == "decision":
        return str(item["id"])
    if item["kind"] == "preview":
        return str(item["preview"]["surface"])
    return str(item["marker"])


def is_default(item: dict[str, Any]) -> bool:
    return item["kind"] == "decision" and item["topic"] not in MUST_ASK_TOPICS


def decision_number(value: Any) -> int | None:
    match = DECISION_ID_RE.fullmatch(value) if isinstance(value, str) else None
    return int(match.group("number")) if match else None


def revise_question_id(surface: str) -> str:
    return f"Q-{surface.replace('_', '-').upper()}-REVISE"


def closed_constraints_ref(state: dict[str, Any]) -> str | None:
    """最近一个已关闭且呈现过 user_constraints 的轮次引用。"""
    best: tuple[int, str] | None = None
    for entry in state.get("confirmations") or []:
        if not isinstance(entry, dict) or round_status(entry) != "closed":
            continue
        parsed = round_ref(entry.get("ref"))
        presented = entry.get("presented") if isinstance(entry.get("presented"), list) else []
        if parsed and "user_constraints" in presented and (best is None or parsed[1] > best[0]):
            best = (parsed[1], entry["ref"])
    return best[1] if best else None


def normalize_options(value: Any, *, mode: str, issue: Issues, where: str) -> list[dict[str, str]] | None:
    if not isinstance(value, list) or not value or not all(
        isinstance(option, dict) and filled(option.get("label")) and isinstance(option.get("description", ""), str)
        for option in value
    ):
        issue("draft_options_invalid", f"{where}.options must be a non-empty list of {{label, description}}")
        return None
    options = [{"label": option["label"], "description": option.get("description", "")} for option in value]
    labels = [option["label"] for option in options]
    if len(set(labels)) != len(labels):
        issue("draft_options_invalid", f"{where}.options repeats a label: {labels}")
    low, high = POPUP_OPTION_RANGE
    if mode == "popup" and not low <= len(options) <= high:
        issue("draft_options_invalid", f"{where}: a popup question takes {low}-{high} options, got {len(options)}")
    return options


def normalize_preview(value: Any, state: dict[str, Any], *, stage: str | None, ref: str, issue: Issues, where: str) -> dict[str, Any] | None:
    """补 preview 状态与来源；execution 复用采访中的约束回答，按 accepted 形态预检。"""
    if not isinstance(value, dict):
        issue("draft_item_invalid", f"{where} must be a preview mapping")
        return None
    preview = copy.deepcopy(value)
    surface = preview.get("surface")
    if not one_of(surface, ALIGNMENT_SURFACES):
        issue("surface_preview_surface_invalid", f"{where}.surface is invalid: {surface!r}")
        return None
    if stage is not None and surface not in STAGE_SURFACES.get(stage, set()):
        issue("surface_preview_stage_mismatch", f"stage={stage} does not accept a {surface} preview")
    preview["status"] = "proposed"
    source = preview.get("decision_source") if isinstance(preview.get("decision_source"), dict) else {}
    # 来源类型与确认轮由回答推出；主代理只会带审查后的 review_disposition。
    preview["decision_source"] = {key: item for key, item in source.items() if key == "review_disposition"}
    disposition = preview["decision_source"].get("review_disposition")
    if disposition is not None and not one_of(disposition, REVIEW_DISPOSITIONS):
        issue("invalid_review_disposition", f"{where}.decision_source.review_disposition is invalid: {disposition!r}")
    if "alignment_spec" in preview:
        entries = preview["alignment_spec"]
        spec_ids = [entry.get("spec_id") for entry in entries] if isinstance(entries, list) and all(isinstance(entry, dict) for entry in entries) else None
        if surface != "requirements":
            issue("alignment_spec_invalid", f"{where}: only the requirements preview carries alignment_spec")
        elif spec_ids is None or not entries or not all(
            filled(entry.get(key)) or (key == "acceptance" and isinstance(entry.get(key), list) and entry[key])
            for entry in entries
            for key in ALIGNMENT_SPEC_REQUIRED
        ):
            issue("alignment_spec_invalid", f"{where}.alignment_spec needs entries with {list(ALIGNMENT_SPEC_REQUIRED)}")
        elif len(set(spec_ids)) != len(spec_ids):
            issue("alignment_spec_invalid", f"{where}.alignment_spec repeats a spec_id: {spec_ids}")
    tech = path_value(preview, "sections.tech")
    if surface == "execution" and isinstance(tech, dict) and not tech.get("user_constraints_ref"):
        constraints = closed_constraints_ref(state)
        if constraints:
            tech["user_constraints_ref"] = constraints
    probe = copy.deepcopy(preview)
    probe.update(status="accepted", decision_source={**preview["decision_source"], "type": "user_selected_option", "confirmation_ref": ref})
    for code, message in preview_issues(probe):
        issue(code, f"{where}: {message}")
    return preview


def normalize_decision(raw: dict[str, Any], state: dict[str, Any], *, mode: str, issue: Issues, where: str, allocate: Any) -> dict[str, Any] | None:
    unknown = sorted(set(raw) - DECISION_ITEM_KEYS)
    if unknown:
        issue("draft_item_invalid", f"{where} has unknown keys {unknown}")
    decision_id = raw.get("id")
    if decision_id is None:
        decision_id = allocate()
    elif decision_number(decision_id) is None:
        issue("decision_id_invalid", f"{where}.id must be D-<digits>, got {decision_id!r}")
        return None
    topic = raw.get("topic")
    if not one_of(topic, DECISION_TOPICS):
        issue("decision_topic_invalid", f"{where}.topic must be one of {sorted(DECISION_TOPICS)}, got {topic!r}")
        return None
    expected = "must_ask" if topic in MUST_ASK_TOPICS else "disclosed_default"
    if "class" in raw and raw["class"] != expected:
        issue("decision_class_topic_mismatch", f"{where}: topic {topic} is {expected}, got class {raw['class']!r}")
    for key in ("question", "reason"):
        if not filled(raw.get(key)):
            issue("decision_field_missing", f"{where}.{key} is required")
    options = normalize_options(raw.get("options"), mode=mode, issue=issue, where=where)
    recommended = raw.get("recommended")
    if options is not None and recommended not in [option["label"] for option in options]:
        issue("draft_recommended_invalid", f"{where}.recommended must be one of the option labels, got {recommended!r}")
    item = {
        "kind": "decision", "id": decision_id, "topic": topic, "question": raw.get("question"),
        "options": options, "recommended": recommended, "reason": raw.get("reason"),
    }
    if expected == "disclosed_default":
        if not filled(raw.get("override_cost")):
            issue("decision_override_cost_missing", f"{where} is a {topic} default without override_cost")
        item["override_cost"] = raw.get("override_cost")
    if "supersedes" in raw:
        target = raw["supersedes"]
        existing = index_by(state.get("decisions"), "id").get(target) if isinstance(target, str) else None
        if target == decision_id or not isinstance(existing, dict) or existing.get("status") not in SUPERSEDABLE_STATUSES:
            issue("supersedes_invalid", f"{where}.supersedes must name another locked or deferred decision, got {target!r}")
        item["supersedes"] = target
    return item


def normalize_marker(raw: dict[str, Any], *, mode: str, issue: Issues, where: str) -> dict[str, Any] | None:
    unknown = sorted(set(raw) - MARKER_ITEM_KEYS)
    if unknown:
        issue("draft_item_invalid", f"{where} has unknown keys {unknown}")
    marker = raw.get("marker")
    if not one_of(marker, ROUND_MARKERS):
        issue("marker_invalid", f"{where}.marker must be one of {list(ROUND_MARKERS)}, got {marker!r}")
        return None
    defaults = MARKER_DEFAULTS[marker]
    question = raw.get("question", defaults["question"])
    if not filled(question):
        issue("draft_item_invalid", f"{where}.question must be non-empty text")
    options = normalize_options(raw.get("options", defaults["options"]), mode=mode, issue=issue, where=where)
    return {"kind": "marker", "marker": marker, "question": question, "options": options}


def normalize_draft(draft: Any, state: dict[str, Any], *, ref: str, log_text: str, issue: Issues, where: str) -> dict[str, Any] | None:
    if not isinstance(draft, dict):
        issue("draft_invalid", f"{where} must be a mapping")
        return None
    unknown = sorted(set(draft) - DRAFT_KEYS)
    if unknown:
        issue("draft_invalid", f"{where} has unknown keys {unknown}")
    stage = draft.get("stage", state.get("current_stage"))
    if not one_of(stage, ALLOWED_STAGES):
        issue("stage_invalid", f"{where}.stage is invalid: {stage!r}")
        stage = None
    mode = draft.get("mode")
    if not one_of(mode, CONFIRMATION_MODES):
        issue("draft_invalid", f"{where}.mode must be one of {sorted(CONFIRMATION_MODES)}, got {mode!r}")
        return None
    active = draft.get("active_surface", state.get("active_surface"))
    if active is not None and not one_of(active, ALIGNMENT_SURFACES):
        issue("active_surface_invalid", f"{where}.active_surface is invalid: {active!r}")
    raw_items = draft.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        issue("draft_invalid", f"{where}.items must be a non-empty list")
        return None
    # 缺省 id 接在账本、本草案与讨论日志已用编号之后，撤回或取消过的编号也不复用。
    used = {decision_number(item.get("id")) for item in state.get("decisions") or [] if isinstance(item, dict)}
    used |= {decision_number(item.get("id")) for item in raw_items if isinstance(item, dict)}
    used |= {int(number) for number in re.findall(r"(?<![A-Za-z0-9])D-([0-9]+)", log_text)}
    counter = iter(range(max((number for number in used if number is not None), default=0) + 1, 10 ** 9))

    def allocate() -> str:
        return f"D-{next(counter):02d}"

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    seen_numbers: set[int] = set()
    for index, raw in enumerate(raw_items):
        at = f"{where}.items[{index}]"
        kind = raw.get("kind") if isinstance(raw, dict) else None
        if not one_of(kind, ROUND_ITEM_KINDS):
            issue("draft_item_invalid", f"{at}.kind must be one of {list(ROUND_ITEM_KINDS)}, got {kind!r}")
            continue
        if kind == "decision":
            item = normalize_decision(raw, state, mode=mode, issue=issue, where=at, allocate=allocate)
        elif kind == "preview":
            unknown = sorted(set(raw) - {"kind", "preview"})
            if unknown:
                issue("draft_item_invalid", f"{at} has unknown keys {unknown}; preview fields go under preview")
            preview = normalize_preview(raw.get("preview"), state, stage=stage, ref=ref, issue=issue, where=f"{at}.preview")
            item = {"kind": "preview", "preview": preview} if preview is not None else None
        else:
            item = normalize_marker(raw, mode=mode, issue=issue, where=at)
        if item is None:
            continue
        key = item_key(item)
        number = decision_number(key)
        if key in seen or (number is not None and number in seen_numbers):
            issue("draft_item_invalid", f"{at} repeats {key}")
            continue
        if item.get("supersedes") is not None and item["supersedes"] in {other.get("supersedes") for other in items}:
            issue("supersedes_invalid", f"{at} supersedes {item['supersedes']}, which another draft item already supersedes")
        seen.add(key)
        if number is not None:
            seen_numbers.add(number)
        items.append(item)
    return {"stage": stage, "mode": mode, "active_surface": active, "items": items}
