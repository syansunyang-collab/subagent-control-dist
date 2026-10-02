"""从 alignment_recorder.py 原样搬出的 delta 前置校验。"""

from __future__ import annotations

import copy
import sys
from typing import Any

sys.dont_write_bytecode = True

from _tool_common import rel
from alignment_guard import (
    ALIGNMENT_SURFACES,
    CONFIRMATION_MODES,
    LOCK_SOURCE_TYPES,
    REVIEW_DISPOSITIONS,
    STAGE_SURFACES,
    extract_alignment_state,
    one_of,
    preview_issues,
    round_ref,
)
from alignment_recorder_parts.constants import (
    ALLOWED_DISCUSSION_MODES,
    ALLOWED_STAGES,
    CONFIRMATION_REQUIRED_FIELDS,
    ISSUE_CODE_HINTS,
)
from alignment_recorder_parts.io import RecorderInputs, load_yaml
from alignment_recorder_parts.state import (
    check_next_step,
    confirmation,
    coverage_source,
    normalize_state_path,
    patch_leaf_paths,
    path_value,
    state_path_allowed,
    state_version_issue,
)

def preflight(inputs: RecorderInputs) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    delta = load_yaml(inputs.delta_path, root_key="alignment_delta")
    if inputs.source_paths["spec"].is_file():
        block, parse_issues = extract_alignment_state(inputs.source_paths["spec"])
        state = block.get("alignment_state") if isinstance(block, dict) else None
        issues = list(parse_issues)
        if isinstance(state, dict) and state.get("version") is None:
            issues.append({"code": "state_version_invalid", "message": "existing spec has no alignment_state.version"})
    else:
        state = copy.deepcopy(delta.get("initial_state")) if isinstance(delta.get("initial_state"), dict) else None
        issues = []
        if state is None:
            issues.append({"code": "initial_state_missing", "message": "new alignment requires alignment_delta.initial_state"})
    if not isinstance(state, dict):
        issues.append({"code": "baseline_alignment_state_missing", "message": "baseline spec has no alignment_state mapping"})
        state = {}
    version_issue = state_version_issue(state)
    if version_issue:
        issues.append(version_issue)

    delta_id = str(delta.get("delta_id") or "").strip()
    stage = str(delta.get("stage") or "").strip()
    active_surface = delta.get("active_surface")
    preview = delta.get("surface_preview") if isinstance(delta.get("surface_preview"), dict) else None
    mutation_scope = delta.get("mutation_scope") if isinstance(delta.get("mutation_scope"), dict) else None
    confirm = confirmation(delta)
    discussion_mode = mutation_scope.get("discussion_log") if isinstance(mutation_scope, dict) else None

    def issue(code: str, message: str) -> None:
        issues.append({"code": code, "message": message})

    if not delta_id:
        issue("delta_id_missing", "alignment_delta.delta_id is required")
    if stage not in ALLOWED_STAGES:
        issue("stage_invalid", f"invalid alignment_delta.stage={stage or 'missing'}")
    if active_surface not in ALIGNMENT_SURFACES and active_surface is not None:
        issue("active_surface_invalid", f"invalid active_surface={active_surface}")
    if not isinstance(mutation_scope, dict):
        issue("mutation_scope_missing", "alignment_delta.mutation_scope is required")
    else:
        if not one_of(discussion_mode, ALLOWED_DISCUSSION_MODES):
            issue("discussion_mode_invalid", f"invalid mutation_scope.discussion_log={discussion_mode}")
        if not isinstance(mutation_scope.get("alignment_state_paths"), list):
            issue("mutation_scope_alignment_state_paths_invalid", "mutation_scope.alignment_state_paths must be a list")
        else:
            allowed_paths = [normalize_state_path(item) for item in mutation_scope["alignment_state_paths"]]
            if any(not path for path in allowed_paths):
                issue("mutation_scope_alignment_state_path_empty", "mutation_scope.alignment_state_paths contains an empty path")
            state_patch = delta.get("state_patch")
            if state_patch is not None and not isinstance(state_patch, dict):
                issue("state_patch_invalid", "alignment_delta.state_patch must be a mapping")
            elif isinstance(state_patch, dict):
                unauthorized = sorted(
                    path for path in patch_leaf_paths(state_patch)
                    if not state_path_allowed(path, allowed_paths)
                )
                if unauthorized:
                    issue(
                        "state_patch_outside_mutation_scope",
                        f"state_patch paths are not authorized: {unauthorized}",
                    )
                if "surface_previews" in state_patch:
                    issue("state_patch_touches_surface_previews", "state_patch may not modify surface_previews; submit a surface_preview instead")
                if "review_refs" in state_patch:
                    issue("state_patch_touches_review_refs", "state_patch may not modify review_refs; use --phase bind-review")
                if "lock_sources" in state_patch:
                    issue("state_patch_touches_lock_sources", "state_patch may not modify lock_sources; they derive from accepted surface previews")
                if "confirmations" in state_patch:
                    issue("state_patch_touches_confirmations", "state_patch may not modify confirmations; submit alignment_delta.confirmation")
                if "alignment_state" in state_patch:
                    issue("state_patch_wrapped_root", "state_patch keys are alignment_state fields; do not nest another alignment_state")
    initial_state = delta.get("initial_state")
    if isinstance(initial_state, dict) and not inputs.source_paths["spec"].is_file():
        initial_reviews = initial_state.get("review_refs") if isinstance(initial_state.get("review_refs"), dict) else {}
        bound = [key for key in ("surface_slice", "proposal_challenge", "cross_surface") if initial_reviews.get(key)]
        if bound:
            issue("initial_state_review_bindings_forbidden", f"initial_state carries review bindings in review_refs.{bound}; use --phase bind-review")
        if initial_state.get("confirmations"):
            issue("initial_state_confirmations_forbidden", "initial_state.confirmations must be []; put the first round in alignment_delta.confirmation")
        initial_locks = initial_state.get("locks") if isinstance(initial_state.get("locks"), dict) else {}
        carried = [key for key, value in initial_locks.items() if value is True]
        carried += [key for key in ("lock_sources", "surface_previews", "decisions") if initial_state.get(key)]
        if carried:
            issue("initial_state_not_blank", f"initial_state must be a blank skeleton; it carries {carried}")
    check_next_step(delta, issue)

    if "confirmation" in delta:
        presented = confirm.get("presented")
        parsed_ref = round_ref(confirm.get("confirmation_ref"))
        # 隔离输出（--output-root）时轮次渲染进输出副本，引用可写规范路径或副本路径；其余日志一律拒收。
        logs = {rel(inputs.source_paths["discussion_log"]), rel(inputs.output_paths["discussion_log"])}
        if parsed_ref and parsed_ref[0] not in logs:
            issue("confirmation_ref_wrong_log", f"confirmation_ref points at {parsed_ref[0]}, not the discussion log {sorted(logs)[0]}")
        if (
            not confirm
            or any(key not in confirm for key in CONFIRMATION_REQUIRED_FIELDS)
            or parsed_ref is None
            or not one_of(confirm.get("mode"), CONFIRMATION_MODES)
            or not isinstance(presented, list)
            or not presented
            or not all(isinstance(item, str) and item.strip() for item in presented)
            or not isinstance(confirm.get("bulk_accept", False), bool)
        ):
            issue("confirmation_invalid", "confirmation needs confirmation_ref (#round-N), mode, non-empty presented and selected_option; bulk_accept is a bool")
        if discussion_mode == "unchanged":
            issue("confirmation_requires_discussion_round", "confirmation writes a discussion round; use append_one_round or replace_confirmation_round")
    elif discussion_mode in {"append_one_round", "replace_confirmation_round"}:
        issue("confirmation_missing", f"discussion_log={discussion_mode} requires alignment_delta.confirmation")

    if isinstance(preview, dict):
        surface = str(preview.get("surface") or "")
        if surface not in ALIGNMENT_SURFACES:
            issue("surface_preview_surface_invalid", f"invalid surface_preview.surface={surface or 'missing'}")
        elif surface not in STAGE_SURFACES.get(stage if stage in STAGE_SURFACES else "", set()):
            issue("surface_preview_stage_mismatch", f"stage={stage} does not accept a {surface} preview")
        for code, message in preview_issues(preview):
            issue(code, message)
        source = preview.get("decision_source") if isinstance(preview.get("decision_source"), dict) else {}
        if preview.get("status") == "accepted":
            if not one_of(source.get("type"), LOCK_SOURCE_TYPES):
                issue("accepted_preview_source_invalid", "accepted preview requires a user or owner decision_source.type")
            if not confirm:
                if "confirmation" not in delta:
                    issue("confirmation_missing", "accepted preview requires alignment_delta.confirmation")
            else:
                if source.get("confirmation_ref") != confirm.get("confirmation_ref"):
                    issue("confirmation_ref_mismatch", "preview decision_source differs from the confirmation round")
                if surface not in (confirm.get("presented") or []):
                    issue("confirmation_presented_missing_surface", f"the confirmation round does not present {surface}")
            disposition = source.get("review_disposition")
            if disposition is not None and not one_of(disposition, REVIEW_DISPOSITIONS):
                issue("invalid_review_disposition", f"invalid review_disposition={disposition!r}")

    manifest = delta.get("coverage_manifest")
    coverage: list[dict[str, str]] = []
    if manifest is not None and not isinstance(manifest, list):
        issue("coverage_manifest_invalid", "coverage_manifest must be a list when present")
        manifest = []
    seen: set[str] = set()
    for item in manifest or []:
        if not isinstance(item, dict):
            issue("coverage_item_invalid", "coverage_manifest item must be a mapping")
            continue
        stable_id = str(item.get("stable_id") or "")
        required_fields = item.get("required_fields") if isinstance(item.get("required_fields"), list) else []
        if not stable_id or stable_id in seen:
            issue("coverage_stable_id_invalid", f"missing or duplicate stable_id={stable_id or 'missing'}")
            continue
        seen.add(stable_id)
        source = coverage_source(delta, stable_id)
        missing = [str(field) for field in required_fields if path_value(source, str(field)) is None]
        status = "covered" if not missing else "missing"
        coverage.append({"stable_id": stable_id, "status": status})
        if missing:
            issue("coverage_required_fields_missing", f"{stable_id} missing {missing}")

    # 每条 issue 自带修复动作：hint 查 ISSUE_CODE_HINTS，未登记的 code 取 null。
    issues = [
        {**item, "hint": ISSUE_CODE_HINTS.get(str(item.get("code") or ""))}
        for item in issues
    ]
    status = "pass" if not issues else "fail"
    data = {
        "tool": "alignment_recorder",
        "phase": "preflight",
        "status": status,
        "exit_code": 0 if status == "pass" else 1,
        "delta_id": delta_id,
        "delta_path": rel(inputs.delta_path),
        "transaction_id": inputs.transaction_id,
        "coverage": coverage,
        "issues": issues,
        "model_started": False,
    }
    return data, delta, state
