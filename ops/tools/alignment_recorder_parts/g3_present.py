"""从 alignment_recorder.py 原样搬出的确认轮呈现与讨论日志段落。"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

sys.dont_write_bytecode = True

from alignment_guard import round_ref, round_status
from alignment_recorder_parts.constants import (
    ANSWER_RECORD_PREFIX,
    MARKER_DEFAULTS,
    POPUP_HEADER_LIMIT,
    POPUP_UNIT_QUESTIONS,
    PREVIEW_ACCEPT_LABEL,
    PREVIEW_REVISE_LABEL,
    SURFACE_LABELS,
    TOPIC_LABELS,
)
from alignment_recorder_parts.g3_draft import is_default, item_key, one_line

def plan_units(number: int, mode: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """呈现单元：popup 一屏至多 4 题，默认项并入最后一屏的「其余全部按推荐」；card / conversation 整张卡一个单元。"""
    singles = [item_key(item) for item in items if not is_default(item)]
    defaults = [item_key(item) for item in items if is_default(item)]
    if mode != "popup":
        # card 的「整卡按推荐」覆盖卡上除 marker 外的全部项目（guard 只在卡片轮认批量接受必问项）；conversation 只覆盖默认项。
        markers = {item_key(item) for item in items if item["kind"] == "marker"}
        covers = [key for key in singles + defaults if key not in markers] if mode == "card" else defaults
        return [{"unit_id": f"R{number}-U1", "items": singles + defaults, "bulk_covers": covers}]
    groups = [singles[index:index + POPUP_UNIT_QUESTIONS] for index in range(0, len(singles), POPUP_UNIT_QUESTIONS)] or [[]]
    if defaults and len(groups[-1]) >= POPUP_UNIT_QUESTIONS:
        groups.append([])
    units = [{"unit_id": f"R{number}-U{index + 1}", "items": group, "bulk_covers": []} for index, group in enumerate(groups)]
    units[-1]["items"] = units[-1]["items"] + defaults
    units[-1]["bulk_covers"] = defaults
    return units


def recommended_first(options: list[dict[str, str]], recommended: Any) -> list[dict[str, str]]:
    ordered = sorted(options, key=lambda option: option["label"] != recommended)
    return [
        {"label": option["label"], "description": f"（推荐）{option['description']}" if option["label"] == recommended else option["description"]}
        for option in ordered
    ]


def preview_brief(preview: dict[str, Any]) -> str:
    def joined(value: Any) -> str:
        return "、".join(str(entry) for entry in value) if isinstance(value, list) and value else "无"

    brief = f"范围：{joined(preview.get('in_scope'))}；不做：{joined(preview.get('out_of_scope'))}；验收对象：{preview.get('validation_object')}"
    specs = preview.get("alignment_spec") if isinstance(preview.get("alignment_spec"), list) else []
    if specs:
        brief += "；需求条目：" + "；".join(f"{entry.get('spec_id')} {entry.get('statement')}" for entry in specs if isinstance(entry, dict))
    return brief


def popup_question(item: dict[str, Any]) -> dict[str, Any]:
    if item["kind"] == "decision":
        header = f"{item['id']} {TOPIC_LABELS[item['topic']]}"
        question, options = item["question"], recommended_first(item["options"], item["recommended"])
    elif item["kind"] == "preview":
        preview = item["preview"]
        header = SURFACE_LABELS[preview["surface"]]
        question = f"按此锁定{header}？{preview.get('locked_statement')}"
        options = [
            {"label": PREVIEW_ACCEPT_LABEL, "description": preview_brief(preview)},
            {"label": PREVIEW_REVISE_LABEL, "description": "选 Other 写明要改什么"},
        ]
    else:
        header, question, options = MARKER_DEFAULTS[item["marker"]]["header"], item["question"], item["options"]
    return {"question": question, "header": header[:POPUP_HEADER_LIMIT], "options": options, "multiSelect": False}


def bulk_question(defaults: list[dict[str, Any]]) -> dict[str, Any]:
    covered = "；".join(f"{item['id']} {item['question']} → {item['recommended']}" for item in defaults)
    return {
        "question": f"其余 {len(defaults)} 项默认项全部按推荐？",
        "header": "其余按推荐",
        "options": [
            {"label": "其余全部按推荐", "description": covered},
            {"label": "逐项调整", "description": "选 Other 写明编号与改法"},
        ],
        "multiSelect": False,
    }


def card_item_lines(index: int, item: dict[str, Any]) -> list[str]:
    if item["kind"] == "decision":
        lines = [f"{index}. {item['id']} [{item['topic']}] {item['question']}"]
        lines += [
            f"   - {option['label']}{'（推荐）' if option['label'] == item['recommended'] else ''}：{option['description']}"
            for option in sorted(item["options"], key=lambda option: option["label"] != item["recommended"])
        ]
        return lines + [f"   推荐理由：{item['reason']}"]
    if item["kind"] == "preview":
        preview = item["preview"]
        return [f"{index}. {SURFACE_LABELS[preview['surface']]} preview：{preview.get('locked_statement')}", f"   {preview_brief(preview)}"]
    lines = [f"{index}. {MARKER_DEFAULTS[item['marker']]['header']}：{item['question']}"]
    return lines + [f"   - {option['label']}：{option['description']}" for option in item["options"]]


def card_text(number: int, unit: dict[str, Any], by_key: dict[str, dict[str, Any]]) -> str:
    must = [by_key[key] for key in unit["items"] if not is_default(by_key[key])]
    defaults = [by_key[key] for key in unit["items"] if is_default(by_key[key])]
    lines = [f"第 {number} 轮确认（{unit['unit_id']}）", "", "要你拍板"]
    for index, item in enumerate(must, 1):
        lines.extend(card_item_lines(index, item))
    if not must:
        lines.append("- 无")
    lines += ["", "我替你定了"]
    for index, item in enumerate(defaults, len(must) + 1):
        lines.append(f"{index}. {item['id']} [{item['topic']}] {item['question']} → {item['recommended']}；推翻代价：{item['override_cost']}")
    if not defaults:
        lines.append("- 无")
    lines += ["", "可回复「整卡按推荐」，或按编号修改（如「2 改为 …」）。"]
    return "\n".join(lines)


def render_presentation(entry: dict[str, Any], *, only: set[str] | None = None) -> dict[str, Any]:
    """呈现物只读已登记的草案与单元。"""
    number = round_ref(entry["ref"])[1]
    by_key = {item_key(item): item for item in entry["items"]}
    units: list[dict[str, Any]] = []
    for unit in entry["units"]:
        if only is not None and unit["unit_id"] not in only:
            continue
        rendered: dict[str, Any] = {"unit_id": unit["unit_id"], "items": list(unit["items"])}
        if entry["mode"] == "popup":
            singles = [key for key in unit["items"] if key not in unit["bulk_covers"]]
            rendered["questions"] = [popup_question(by_key[key]) for key in singles]
            rendered["question_items"] = [[key] for key in singles]
            if unit["bulk_covers"]:
                rendered["questions"].append(bulk_question([by_key[key] for key in unit["bulk_covers"]]))
                rendered["question_items"].append(list(unit["bulk_covers"]))
        else:
            rendered["text"] = card_text(number, unit, by_key)
        units.append(rendered)
    return {"round": number, "mode": entry["mode"], "units": units}


def item_summary(item: dict[str, Any]) -> str:
    if item["kind"] == "decision":
        replaces = f"（替代 {item['supersedes']}）" if item.get("supersedes") else ""
        return one_line(f"{item['id']} [{item['topic']}] {item['question']}（推荐：{item['recommended']}）{replaces}")
    if item["kind"] == "preview":
        return one_line(f"{item['preview']['surface']} preview：{item['preview'].get('locked_statement')}")
    return one_line(f"{item['marker']}：{item['question']}")


def action_summary(action: dict[str, Any]) -> str:
    if "accept_revised" in action:
        preview = action["accept_revised"] if isinstance(action["accept_revised"], dict) else {}
        return one_line(f"accept_revised（{preview.get('locked_statement')}）")
    if "accept" in action:
        unaffected = action.get("unaffected_by") or []
        return "accept" + (f"（unaffected_by: {', '.join(unaffected)}）" if unaffected else "")
    name = next(iter(action))
    return one_line(f"{name} {action[name]}")


def answer_record(entry: dict[str, Any]) -> dict[str, Any]:
    unit_ids = {unit["unit_id"] for unit in entry.get("units") or []}
    answers = entry.get("answers") or {}
    return {
        "shown_units": list(entry.get("shown_units") or []),
        "bulk": [key for key in answers if key in unit_ids],
        "answers": {key: value for key, value in answers.items() if key not in unit_ids},
        **({"delegation_ref": entry["delegation_ref"]} if entry.get("delegation_ref") else {}),
    }


def round_section_pattern(number: int) -> re.Pattern[str]:
    return re.compile(rf"(?ms)^##\s+Round\s+0*{number}\s*$.*?(?=^##\s+Round\s+\d+\s*$|\Z)")


def render_round_section(entry: dict[str, Any], *, stage: Any, spec_ref: str, cancel: str | None = None) -> str:
    number = round_ref(entry["ref"])[1]
    status = round_status(entry)
    record = answer_record(entry)
    lines = [
        f"## Round {number}",
        "",
        f"- stage: {stage}",
        f"- mode: {entry['mode']}",
        f"- status: {status}",
        f"- confirmation_ref: {entry['ref']}",
        f"- locked_statement_ref: {spec_ref}#alignment-state",
        f"- presented: {', '.join(entry.get('presented') or []) or 'none'}",
        f"- bulk_accept: {'true' if entry.get('bulk_accept') else 'false'}",
        "- units:",
    ]
    for unit in entry.get("units") or []:
        flags = "已展示" if unit["unit_id"] in record["shown_units"] else "未展示"
        if unit["unit_id"] in record["bulk"]:
            flags += "，其余全部按推荐"
        covers = f"；批量覆盖：{', '.join(unit['bulk_covers'])}" if unit["bulk_covers"] else ""
        lines.append(f"  - {unit['unit_id']}（{flags}）：{', '.join(unit['items'])}{covers}")
    lines.append("- items:")
    lines.extend(f"  - {item_summary(item)}" for item in entry.get("items") or [])
    lines.append("- answers:" if record["answers"] else "- answers: none")
    lines.extend(f"  - {key}: {action_summary(action)}" for key, action in record["answers"].items())
    lines.append(f"- pending: {', '.join(entry.get('pending') or []) or 'none'}")
    if cancel is not None:
        lines.append(f"- cancel: {one_line(cancel)}")
    if status != "open":
        # 关闭或取消后进度字段离开状态；已关闭轮次的重试只比对这一行。
        lines.append(ANSWER_RECORD_PREFIX + json.dumps(record, ensure_ascii=False, sort_keys=True))
    return "\n".join(lines)


def upsert_round_section(log_text: str, number: int, section: str) -> str:
    pattern = round_section_pattern(number)
    if pattern.search(log_text):
        return pattern.sub(lambda _: section + "\n\n", log_text, count=1).rstrip() + "\n"
    return log_text.rstrip() + "\n\n" + section + "\n"


def recorded_answer(log_text: str, number: int) -> dict[str, Any] | None:
    found = round_section_pattern(number).search(log_text)
    for line in (found.group(0) if found else "").splitlines():
        if line.startswith(ANSWER_RECORD_PREFIX):
            try:
                record = json.loads(line[len(ANSWER_RECORD_PREFIX):])
            except json.JSONDecodeError:
                return None
            return record if isinstance(record, dict) else None
    return None


def next_round_number(state: dict[str, Any], log_text: str) -> int:
    numbers = [parsed[1] for entry in state.get("confirmations") or [] if isinstance(entry, dict) and (parsed := round_ref(entry.get("ref")))]
    numbers += [int(number) for number in re.findall(r"(?m)^##\s+Round\s+(\d+)\s*$", log_text)]
    return max(numbers, default=0) + 1
