"""从 alignment_recorder.py 原样搬出的 delta 应用到状态。"""

from __future__ import annotations

import copy
import sys
from typing import Any

sys.dont_write_bytecode = True

from alignment_guard import ALIGNMENT_SURFACES, STATE_VERSION, index_by
from alignment_recorder_parts.review import advance_after_review
from alignment_recorder_parts.state import confirmation, deep_merge, merge_by, write_next_action

def question_from(surface: str, state: dict[str, Any]) -> dict[str, Any]:
    previews = index_by(state.get("surface_previews"), "surface")
    preview = previews.get(surface, {})
    return {
        "id": f"Q-{surface.replace('_', '-').upper()}-01",
        "surface": surface,
        "question": f"是否锁定 {surface} 当前方案。",
        "why_blocking": str(preview.get("planner_impact") or f"决定 {surface} 对后续范围、验收和执行的约束。"),
        "next_step": "ask_user",
    }


def canonical_refs_from_delta(delta: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for item in delta.get("fact_refs") or []:
        if isinstance(item, str):
            values.append(item)
    confirm = confirmation(delta)
    if isinstance(confirm.get("confirmation_ref"), str):
        values.append(confirm["confirmation_ref"])
    for item in delta.get("review_refs") or []:
        if isinstance(item, str):
            values.append(item)
        elif isinstance(item, dict):
            values.extend(str(value) for value in item.values() if isinstance(value, str))
    return [value for value in values if not value.replace("\\", "/").startswith("tmp/")]


def apply_delta(baseline: dict[str, Any], delta: dict[str, Any], transaction_id: str) -> dict[str, Any]:
    state = copy.deepcopy(baseline)
    state["version"] = STATE_VERSION
    state["current_stage"] = delta.get("stage")
    state["active_surface"] = delta.get("active_surface")

    source_context = state.setdefault("source_context", {})
    refs = source_context.setdefault("canonical_refs", [])
    if not isinstance(refs, list):
        refs = []
        source_context["canonical_refs"] = refs
    for value in canonical_refs_from_delta(delta):
        if value not in refs:
            refs.append(value)

    confirm = confirmation(delta)
    if confirm:
        entry = {
            "ref": confirm.get("confirmation_ref"),
            "mode": confirm.get("mode"),
            "presented": list(confirm.get("presented") or []),
            "bulk_accept": bool(confirm.get("bulk_accept", False)),
        }
        state["confirmations"] = merge_by(state.get("confirmations"), [entry], "ref")
    else:
        state.setdefault("confirmations", [])

    preview = delta.get("surface_preview") if isinstance(delta.get("surface_preview"), dict) else None
    if preview:
        surface = str(preview.get("surface") or "")
        state["surface_previews"] = merge_by(state.get("surface_previews"), [preview], "surface")
        locks = state.setdefault("locks", {})
        sources = state.setdefault("lock_sources", {})
        if preview.get("status") == "accepted":
            locks[f"{surface}_locked"] = True
            sources[surface] = {"decision_source": copy.deepcopy(preview.get("decision_source"))}
        else:
            # 重新提交为 proposed / superseded 的面机械解锁：锁只跟随当前 accepted preview，不靠主代理另行 patch。
            if locks.get(f"{surface}_locked") is True:
                locks[f"{surface}_locked"] = False
            sources.pop(surface, None)

    if isinstance(delta.get("decisions"), list):
        state["decisions"] = merge_by(state.get("decisions"), delta["decisions"], "id")
    if isinstance(delta.get("alignment_spec"), list):
        state["alignment_spec"] = merge_by(state.get("alignment_spec"), delta["alignment_spec"], "spec_id")

    if "open_questions" in delta:
        baseline_questions = index_by(state.get("open_questions"), "id")
        resolved: list[dict[str, Any]] = []
        for item in delta.get("open_questions") or []:
            if isinstance(item, dict):
                resolved.append(copy.deepcopy(item))
                continue
            text = str(item)
            exact = baseline_questions.get(text)
            if exact:
                resolved.append(copy.deepcopy(exact))
                continue
            surface = text.removesuffix("_surface")
            if surface in ALIGNMENT_SURFACES:
                resolved.append(question_from(surface, state))
        state["open_questions"] = resolved

    next_step = str(delta.get("next_step") or "")
    if next_step:
        write_next_action(
            state,
            next_step,
            str(delta.get("next_route_id") or "") or None,
            f"{delta.get('delta_id')} 已提交；下一步处理 {delta.get('active_surface') or next_step}。",
        )

    if isinstance(delta.get("state_patch"), dict):
        deep_merge(state, delta["state_patch"])

    if next_step == "pause":
        state.setdefault("locks", {})["planner_allowed"] = False
    elif preview and preview.get("status") == "accepted" and (preview.get("decision_source") or {}).get("review_disposition"):
        advance_after_review(state)

    state["recording"] = {
        "last_delta_id": delta.get("delta_id"),
        "last_transaction_id": transaction_id,
        "recording_gate": "pass",
    }
    return state
