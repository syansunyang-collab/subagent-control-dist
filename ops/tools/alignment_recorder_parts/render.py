"""从 alignment_recorder.py 原样搬出的规格书、讨论日志渲染与写后校验。"""

from __future__ import annotations

import copy
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

from _tool_common import ROOT, ToolError
from alignment_guard import ALIGNMENT_SURFACES, build_data, cross_rounds, index_by, round_ref
from alignment_recorder_parts.constants import COMPLETION_BY_STAGE
from alignment_recorder_parts.io import dump_yaml
from alignment_recorder_parts.state import confirmation, path_value, question_id

def render_spec(state: dict[str, Any], baseline_text: str) -> str:
    title_match = re.search(r"^#\s+(.+)$", baseline_text, flags=re.MULTILINE)
    title = title_match.group(1).strip() if title_match else str(state.get("task_slug") or "Alignment")
    completion = COMPLETION_BY_STAGE.get(str(state.get("current_stage") or ""), "draft")
    previews = index_by(state.get("surface_previews"), "surface")
    requirements = previews.get("requirements", {})
    source = state.get("source_context") if isinstance(state.get("source_context"), dict) else {}
    locks = state.get("locks") if isinstance(state.get("locks"), dict) else {}
    lock_sources = state.get("lock_sources") if isinstance(state.get("lock_sources"), dict) else {}

    lines = [
        f"# {title}",
        "",
        f"当前状态：`completion_state: {completion}`。业务真值位于文末 `Alignment State`；前文为确定性派生视图。",
        "",
        "## 1. 目标与不做",
        "",
        str(source.get("user_request_summary") or requirements.get("locked_statement") or "none"),
        "",
        "### 当前范围",
    ]
    for item in requirements.get("in_scope") or []:
        lines.append(f"- {item}")
    if not requirements.get("in_scope"):
        lines.append("- none")
    lines.extend(["", "### 不做范围"])
    for item in requirements.get("out_of_scope") or []:
        lines.append(f"- {item}")
    if not requirements.get("out_of_scope"):
        lines.append("- none")

    lines.extend(["", "## 2. 事实基础", ""])
    for ref in source.get("canonical_refs") or []:
        lines.append(f"- {ref}")
    if not source.get("canonical_refs"):
        lines.append("- none")

    lines.extend(["", "## 3. 锁定面总览", "", "| surface | status | decision source |", "| --- | --- | --- |"])
    for surface in ALIGNMENT_SURFACES:
        status = "locked" if locks.get(f"{surface}_locked") is True else "open"
        decision = lock_sources.get(surface, {}) if isinstance(lock_sources.get(surface), dict) else {}
        source_ref = path_value(decision, "decision_source.confirmation_ref") or "none"
        lines.append(f"| {surface} | {status} | {source_ref} |")

    lines.extend(["", "## 4. 锁定面 preview", ""])
    for surface in ALIGNMENT_SURFACES:
        item = previews.get(surface)
        if not item:
            continue
        lines.extend([f"### {surface}", "", f"- status: {item.get('status')}", f"- locked_statement: {item.get('locked_statement')}"])
        if surface == "product_experience" and item.get("product_surface"):
            lines.append(f"- product_surface: {item.get('product_surface')}")
        sections = item.get("sections") if isinstance(item.get("sections"), dict) else {}
        tech = sections.get("tech") if isinstance(sections.get("tech"), dict) else {}
        if tech.get("wheel"):
            lines.append(f"- wheel: {tech.get('wheel')}")
        lines.append(f"- validation_object: {item.get('validation_object')}")
        lines.append("")

    decisions = [item for item in state.get("decisions") or [] if isinstance(item, dict) and item.get("status") != "superseded"]
    lines.extend(["## 5. 决策账本", "", "### 要你拍板", ""])
    must_ask = [item for item in decisions if item.get("class") == "must_ask"]
    for item in must_ask:
        source_ref = path_value(item, "source.confirmation_ref") or "none"
        lines.append(f"- {item.get('id')} [{item.get('topic')}] {item.get('question')} → {item.get('selected')}（{item.get('status')}；{source_ref}）")
    if not must_ask:
        lines.append("- none")
    lines.extend(["", "### 我替你定了", ""])
    defaults = [item for item in decisions if item.get("class") == "disclosed_default"]
    for item in defaults:
        lines.append(f"- {item.get('id')} [{item.get('topic')}] {item.get('question')} → {item.get('selected')}；推翻代价：{item.get('override_cost')}")
    if not defaults:
        lines.append("- none")

    lines.extend(["", "## 6. 规格条目", ""])
    for item in state.get("alignment_spec") or []:
        if isinstance(item, dict):
            lines.append(f"- {item.get('spec_id')}: {item.get('statement')}")
    if not state.get("alignment_spec"):
        lines.append("- none")

    lines.extend(["", "## 7. 验收表", ""])
    for item in state.get("alignment_spec") or []:
        if not isinstance(item, dict):
            continue
        acceptance = "；".join(str(value) for value in item.get("acceptance") or []) or "none"
        lines.append(f"- {item.get('spec_id')} / {item.get('validation_object')}: {acceptance}")
    if not state.get("alignment_spec"):
        lines.append("- none")

    lines.extend(["", "## 8. 资源与边界", ""])
    for surface in ALIGNMENT_SURFACES:
        item = previews.get(surface) or {}
        for value in item.get("out_of_scope") or []:
            lines.append(f"- {surface}: {value}")
    if not any((previews.get(surface) or {}).get("out_of_scope") for surface in ALIGNMENT_SURFACES):
        lines.append("- none")

    review_refs = state.get("review_refs") if isinstance(state.get("review_refs"), dict) else {}
    lines.extend(["", "## 9. 审查与出站", ""])
    for item in review_refs.get("surface_slice") or []:
        if isinstance(item, dict):
            source = lock_sources.get(item.get("surface"), {}) if isinstance(lock_sources.get(item.get("surface")), dict) else {}
            decision = source.get("decision_source") if isinstance(source.get("decision_source"), dict) else {}
            disposition = f" / disposition: {decision.get('review_disposition')}" if decision.get("review_disposition") else ""
            lines.append(f"- surface {item.get('surface')} round {item.get('round') or 1}: {item.get('business_verdict')} / {item.get('report_ref')}{disposition}")
    for item in review_refs.get("proposal_challenge") or []:
        if isinstance(item, dict):
            resolution = f" / owner: {item.get('owner_resolution_ref')}" if item.get("owner_resolution_ref") else ""
            lines.append(f"- challenge {item.get('surface')} round {item.get('round') or 1}: {item.get('business_verdict')} / {item.get('report_ref')}{resolution}")
    cross = cross_rounds(review_refs)
    for item in cross:
        cross_disposition = f" / disposition: {item.get('review_disposition')}" if item.get("review_disposition") else ""
        cross_owner = f" / owner: {item.get('owner_resolution_ref')}" if item.get("owner_resolution_ref") else ""
        lines.append(f"- cross_surface round {item.get('round') or 1}: {item.get('business_verdict')} / {item.get('report_ref')}{cross_disposition}{cross_owner}")
    if not cross:
        lines.append("- cross_surface: none")
    action = state.get("next_action") if isinstance(state.get("next_action"), dict) else {}
    route = f" ({action.get('route_id')})" if action.get("route_id") else ""
    lines.append(f"- next_action: {action.get('type')}{route} — {action.get('reason')}")
    lines.extend(["", "## Alignment State", "", "```yaml", dump_yaml("alignment_state", state).rstrip(), "```", ""])
    return "\n".join(lines)


def render_discussion(delta: dict[str, Any], baseline: str, *, spec_ref: str) -> str:
    scope = delta.get("mutation_scope") if isinstance(delta.get("mutation_scope"), dict) else {}
    mode = scope.get("discussion_log")
    if mode == "unchanged":
        return baseline
    confirm = confirmation(delta)
    ref = str(confirm.get("confirmation_ref") or "")
    parsed = round_ref(ref)
    if parsed is None:
        raise ToolError(f"confirmation_ref must be <log>#round-N: {ref}")
    number = str(parsed[1])
    heading = f"## Round {number}"
    preview = delta.get("surface_preview") if isinstance(delta.get("surface_preview"), dict) else {}
    presented = ", ".join(str(item) for item in confirm.get("presented") or []) or "none"
    event = "\n".join([
        heading,
        "",
        f"- stage: {delta.get('stage')}",
        f"- mode: {confirm.get('mode')}",
        f"- presented: {presented}",
        f"- bulk_accept: {'true' if confirm.get('bulk_accept') else 'false'}",
        f"- question_id: {question_id(delta)}",
        f"- selected_option: {confirm.get('selected_option')}",
        f"- affected_surface: {preview.get('surface') or 'none'}",
        f"- locked_statement_ref: {spec_ref}#alignment-state",
        f"- confirmation_ref: {ref}",
    ])
    pattern = re.compile(rf"(?ms)^##\s+Round\s+0*{number}\s*$.*?(?=^##\s+Round\s+\d+\s*$|\Z)")
    if pattern.search(baseline):
        if mode != "replace_confirmation_round":
            raise ToolError(f"discussion log already contains {heading}")
        return pattern.sub(event + "\n", baseline).rstrip() + "\n"
    return baseline.rstrip() + "\n\n" + event + "\n"


def validate_rendered(
    baseline_state: dict[str, Any],
    delta: dict[str, Any],
    state: dict[str, Any],
    rendered: dict[str, str],
    outputs: dict[str, Path],
) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    preview_delta = delta.get("surface_preview") if isinstance(delta.get("surface_preview"), dict) else None
    if preview_delta is not None:
        affected = str(preview_delta.get("surface") or "")
        baseline_locks = baseline_state.get("locks") if isinstance(baseline_state.get("locks"), dict) else {}
        current_locks = state.get("locks") if isinstance(state.get("locks"), dict) else {}
        baseline_sources = baseline_state.get("lock_sources") if isinstance(baseline_state.get("lock_sources"), dict) else {}
        current_sources = state.get("lock_sources") if isinstance(state.get("lock_sources"), dict) else {}
        baseline_previews = index_by(baseline_state.get("surface_previews"), "surface")
        current_previews = index_by(state.get("surface_previews"), "surface")
        # 一次 preview 提交只动它自己的面；其余面的锁、锁来源与 preview 保持原样。
        for surface in set(ALIGNMENT_SURFACES) - {affected}:
            if current_locks.get(f"{surface}_locked") != baseline_locks.get(f"{surface}_locked"):
                issues.append({"code": "unlisted_lock_changed", "message": f"{affected} preview changed {surface} lock"})
            if current_sources.get(surface) != baseline_sources.get(surface):
                issues.append({"code": "unlisted_lock_source_changed", "message": f"{affected} preview changed {surface} lock source"})
            baseline_preview = copy.deepcopy(baseline_previews.get(surface))
            current_preview = copy.deepcopy(current_previews.get(surface))
            if current_preview != baseline_preview:
                issues.append({"code": "unlisted_preview_changed", "message": f"{affected} preview changed {surface} preview"})
        current_affected = copy.deepcopy(current_previews.get(affected))
        if current_affected != preview_delta:
            issues.append({"code": "affected_preview_mismatch", "message": f"rendered {affected} preview differs from delta"})
    baseline_refs = path_value(baseline_state, "source_context.canonical_refs") or []
    current_refs = path_value(state, "source_context.canonical_refs") or []
    if any(value not in current_refs for value in baseline_refs):
        issues.append({"code": "canonical_ref_removed", "message": "delta removed an existing canonical ref"})
    if any(str(value).replace("\\", "/").startswith("tmp/") for value in current_refs):
        issues.append({"code": "tmp_canonical_ref", "message": "canonical refs may not point to tmp"})

    confirm = confirmation(delta)
    confirmation_ref = str(confirm.get("confirmation_ref") or "")
    if confirmation_ref:
        parsed = round_ref(confirmation_ref)
        section = ""
        if parsed:
            found = re.search(
                rf"(?ms)^##\s+Round\s+{parsed[1]}\s*$.*?(?=^##\s+Round\s+\d+\s*$|\Z)",
                rendered["discussion_log"],
            )
            section = found.group(0) if found else ""
        expected_lines = {
            f"- mode: {confirm.get('mode')}",
            f"- selected_option: {confirm.get('selected_option')}",
            f"- confirmation_ref: {confirmation_ref}",
        }
        if not section or any(line not in section for line in expected_lines):
            issues.append({"code": "discussion_confirmation_mismatch", "message": "rendered confirmation round is incomplete"})

    tmp_root = ROOT / "tmp"
    tmp_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="alignment-recorder-guard-", dir=tmp_root) as name:
        spec = Path(name) / outputs["spec"].name
        spec.write_text(rendered["spec"], encoding="utf-8")
        guard = build_data(spec, "context")
        for issue in guard["issues"]:
            issues.append({"code": str(issue.get("code")), "message": str(issue.get("message"))})
    return issues
