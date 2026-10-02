"""从 alignment_recorder.py 原样搬出的状态路径、确认轮与合并助手。"""

from __future__ import annotations

import copy
import sys
from typing import Any

sys.dont_write_bytecode = True

from alignment_guard import FROZEN_STATE_VERSIONS, ROUTE_ID_RE, STATE_VERSION, index_by
from alignment_recorder_parts.constants import NEXT_ACTION_MAP

def path_value(value: Any, dotted: str) -> Any:
    current = value
    for part in dotted.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def patch_leaf_paths(value: dict[str, Any], prefix: str = "") -> list[str]:
    paths: list[str] = []
    for key, item in value.items():
        current = f"{prefix}.{key}" if prefix else str(key)
        if isinstance(item, dict) and item:
            paths.extend(patch_leaf_paths(item, current))
        else:
            paths.append(current)
    return paths


def normalize_state_path(value: Any) -> str:
    path = str(value or "").strip().strip(".")
    return path.removeprefix("alignment_state.")


def state_path_allowed(path: str, allowed: list[str]) -> bool:
    return any(path == candidate or path.startswith(f"{candidate}.") for candidate in allowed)


def confirmation(delta: dict[str, Any]) -> dict[str, Any]:
    value = delta.get("confirmation")
    return value if isinstance(value, dict) else {}


def coverage_source(delta: dict[str, Any], stable_id: str) -> dict[str, Any]:
    preview = delta.get("surface_preview") if isinstance(delta.get("surface_preview"), dict) else {}
    confirm = confirmation(delta)
    if stable_id.startswith("SURFACE-") and stable_id.endswith("-preview"):
        return preview
    if stable_id.startswith("SURFACE-") and stable_id.endswith("-state"):
        surface = str(preview.get("surface") or "")
        return {
            "locks": {f"{surface}_locked": preview.get("status") == "accepted"},
            "lock_sources": {surface: preview.get("decision_source")},
        }
    if stable_id.startswith("QUESTION-"):
        return {
            "closed_questions": delta.get("closed_questions", []),
            "open_questions": delta.get("open_questions", []),
            "next_action": delta.get("next_step"),
        }
    if stable_id.startswith("DISCUSSION-"):
        return {
            "stage": delta.get("stage"),
            "surface": preview.get("surface"),
            "mode": confirm.get("mode"),
            "presented": confirm.get("presented"),
            "bulk_accept": confirm.get("bulk_accept"),
            "question_id": question_id(delta),
            "selected_option": confirm.get("selected_option"),
            "affected_surface": preview.get("surface"),
            "user_response_summary": confirm.get("selected_option"),
            "decision_delta": delta.get("changed"),
            "downstream_impact": preview.get("planner_impact"),
            "next": delta.get("next_step"),
        }
    if stable_id.startswith("D-"):
        return index_by(delta.get("decisions"), "id").get(stable_id, {})
    if stable_id.startswith("AS-"):
        return index_by(delta.get("alignment_spec"), "spec_id").get(stable_id, {})
    return {}


def question_id(delta: dict[str, Any]) -> str:
    closed = delta.get("closed_questions")
    if isinstance(closed, list) and closed:
        return str(closed[0])
    preview = delta.get("surface_preview") if isinstance(delta.get("surface_preview"), dict) else {}
    return f"{preview['surface']}_surface" if preview.get("surface") else "round"


def check_next_step(value: dict[str, Any], issue: Any) -> None:
    next_step = value.get("next_step")
    if next_step not in (None, "") and (not isinstance(next_step, str) or next_step not in NEXT_ACTION_MAP):
        issue("next_step_invalid", f"invalid next_step={next_step!r}")
    route_id = value.get("next_route_id")
    if next_step == "dispatch_fact" and not ROUTE_ID_RE.match(str(route_id or "")):
        issue("next_route_id_missing", "next_step=dispatch_fact requires next_route_id (role__capability)")
    elif route_id not in (None, "") and next_step != "dispatch_fact":
        issue("next_route_id_unexpected", "next_route_id is only valid with next_step=dispatch_fact")


def write_next_action(state: dict[str, Any], next_step: str, route_id: str | None, reason: str) -> None:
    action = NEXT_ACTION_MAP.get(next_step, next_step)
    previous = state.get("next_action") if isinstance(state.get("next_action"), dict) else {}
    same_target = previous.get("type") == action and previous.get("route_id") == route_id
    state["next_action"] = {
        "type": action,
        "reason": reason,
        # 同类型、同 route 的下一步沿用已写好的 seed；目标变化时旧 seed 不再适用。
        "dispatch_seed": previous.get("dispatch_seed") if same_target else None,
    }
    if route_id:
        state["next_action"]["route_id"] = route_id


def state_version_issue(state: dict[str, Any]) -> dict[str, str] | None:
    version = state.get("version")
    if version in FROZEN_STATE_VERSIONS:
        return {"code": "spec_version_frozen", "message": f"alignment_state.version={version} is frozen history; start a v4 spec instead"}
    if version not in (None, STATE_VERSION):
        return {"code": "state_version_invalid", "message": f"alignment_state.version must be {STATE_VERSION}, got {version!r}"}
    return None


def merge_by(items: Any, patches: Any, key: str) -> list[dict[str, Any]]:
    result = [copy.deepcopy(item) for item in items or [] if isinstance(item, dict)]
    positions = {str(item.get(key)): index for index, item in enumerate(result) if item.get(key)}
    for patch in patches or []:
        if not isinstance(patch, dict) or not patch.get(key):
            continue
        identity = str(patch[key])
        if identity in positions:
            result[positions[identity]] = copy.deepcopy(patch)
        else:
            positions[identity] = len(result)
            result.append(copy.deepcopy(patch))
    return result


def deep_merge(target: dict[str, Any], patch: dict[str, Any]) -> None:
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            deep_merge(target[key], value)
        else:
            target[key] = copy.deepcopy(value)
