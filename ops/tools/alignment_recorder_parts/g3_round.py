"""从 alignment_recorder.py 原样搬出的 G3 开轮、回答与提交。"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
import time
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

from _tool_common import ToolError, read_stdin_text, rel, repo_path
from alignment_guard import (
    ALIGNMENT_SURFACES,
    REVIEW_DISPOSITIONS,
    STATE_VERSION,
    business_view,
    one_of,
    round_ref,
    round_status,
)
from alignment_recorder_parts.constants import (
    ALL_ANSWER_ACTIONS,
    ANSWER_ACTIONS,
    ANSWER_KEYS,
    ISSUE_CODE_HINTS,
    ROUND_PROGRESS_KEYS,
)
from alignment_recorder_parts.g3_draft import (
    G3Paths,
    Issues,
    filled,
    is_default,
    item_key,
    normalize_draft,
    normalize_preview,
    one_line,
    revise_question_id,
)
from alignment_recorder_parts.g3_present import (
    answer_record,
    next_round_number,
    plan_units,
    recorded_answer,
    render_presentation,
    render_round_section,
    round_section_pattern,
    upsert_round_section,
)
from alignment_recorder_parts.io import alignment_paths, atomic_write
from alignment_recorder_parts.render import render_spec, validate_rendered
from alignment_recorder_parts.review import advance_after_review, read_v4_state
from alignment_recorder_parts.stage_nav import next_reads, open_round_number
from alignment_recorder_parts.state import check_next_step, merge_by, write_next_action

def read_input(value: str) -> dict[str, Any]:
    if yaml is None:
        raise ToolError("PyYAML is required for alignment_recorder.py") from YAML_IMPORT_ERROR
    text = read_stdin_text("--input -") if value == "-" else repo_path(value, label="input", must_exist=True).read_text(encoding="utf-8")
    try:
        parsed = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ToolError(f"--input is neither YAML nor JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ToolError("--input must be a YAML or JSON mapping")
    # 统一成 JSON 值：讨论日志的 answer_record 按 JSON 存取，重试比对前后同形。
    return json.loads(json.dumps(parsed, ensure_ascii=False, default=str))


def open_round(
    state: dict[str, Any],
    draft: Any,
    *,
    paths: G3Paths,
    log_text: str,
    issue: Issues,
    where: str = "draft",
) -> tuple[str, dict[str, Any], int] | None:
    """登记待呈现草案：分配轮号、引用、缺省 id 与呈现单元；presented 为空，等 answer 写明实际展示。"""
    confirmations = state.setdefault("confirmations", [])
    if any(isinstance(entry, dict) and round_status(entry) == "open" for entry in confirmations):
        issue("open_round_duplicate", "a confirmation round is already open; answer it or cancel it first")
        return None
    number = next_round_number(state, log_text)
    ref = f"{paths.log_rel}#round-{number}"
    before = len(issue)
    plan = normalize_draft(draft, state, ref=ref, log_text=log_text, issue=issue, where=where)
    if plan is None or len(issue) > before:
        return None
    entry = {
        "ref": ref,
        "mode": plan["mode"],
        "status": "open",
        "presented": [],
        "bulk_accept": False,
        "items": plan["items"],
        "units": plan_units(number, plan["mode"], plan["items"]),
        "shown_units": [],
        "answers": {},
        "pending": [item_key(item) for item in plan["items"]],
    }
    confirmations.append(entry)
    state["locks"]["planner_allowed"] = False
    state["current_stage"] = plan["stage"]
    state["active_surface"] = plan["active_surface"]
    if (state.get("next_action") or {}).get("type") != "pause":
        write_next_action(state, "ask_user", None, f"第 {number} 轮待呈现：把呈现物交给提问工具，再用 answer 提交实际展示的单元与回答。")
    section = render_round_section(entry, stage=plan["stage"], spec_ref=paths.spec_ref)
    return upsert_round_section(log_text, number, section), render_presentation(entry), number


def check_action(item: dict[str, Any], action: Any, *, state: dict[str, Any], ref: str, issue: Issues, key: str) -> bool:
    if not isinstance(action, dict) or not action:
        issue("answer_invalid", f"{key}: an answer is a mapping with one action, such as {{choose: <label>}}")
        return False
    names = [name for name in action if name in ALL_ANSWER_ACTIONS]
    if len(names) > 1:
        issue("answer_ambiguous", f"{key} carries several actions {names}")
        return False
    allowed = ANSWER_ACTIONS[item["kind"]]
    extras = [name for name in action if name not in ALL_ANSWER_ACTIONS and name not in ("unaffected_by", "review_disposition")]
    if extras or not names or names[0] not in allowed:
        issue("answer_invalid", f"{key} is a {item['kind']}; it takes exactly one of {list(allowed)}, got {sorted(action)}")
        return False
    name, value = names[0], action[names[0]]
    unaffected = action.get("unaffected_by")
    if "unaffected_by" in action and (name != "accept" or not isinstance(unaffected, list) or not all(isinstance(entry, str) for entry in unaffected)):
        issue("answer_invalid", f"{key}.unaffected_by is a list of decision ids and only goes with accept")
        return False
    if "review_disposition" in action and (name not in ("accept", "accept_revised") or not one_of(action["review_disposition"], REVIEW_DISPOSITIONS)):
        issue("invalid_review_disposition", f"{key}.review_disposition goes with accept / accept_revised and is one of {sorted(REVIEW_DISPOSITIONS)}")
        return False
    if name == "choose":
        labels = [option["label"] for option in item["options"]]
        if value not in labels:
            issue("answer_option_invalid", f"{key}: {value!r} is not one of {labels}")
            return False
    elif name == "accept":
        if value is not True:
            issue("answer_invalid", f"{key}.accept must be true")
            return False
    elif name == "accept_revised":
        if not isinstance(value, dict) or value.get("surface") != key:
            issue("answer_invalid", f"{key}.accept_revised must be a full {key} preview")
            return False
        before = len(issue)
        normalize_preview(value, state, stage=None, ref=ref, issue=issue, where=f"answers.{key}.accept_revised")
        return len(issue) == before
    elif not filled(value):
        issue("answer_invalid", f"{key}.{name} needs non-empty text")
        return False
    return True


def bulk_covered(units: dict[str, dict[str, Any]], saved: dict[str, Any]) -> set[str]:
    """批量接受只覆盖该单元 bulk_covers 里没有单独作答的项目。"""
    return {
        key
        for unit_id, unit in units.items()
        if unit_id in saved
        for key in unit["bulk_covers"]
        if key not in saved
    }


def record_progress(state: dict[str, Any], entry: dict[str, Any], request: dict[str, Any], *, issue: Issues) -> dict[str, Any]:
    """把本次回答并入 open 轮进度，推出 presented 与待答；不生成任何正式结果。"""
    number = round_ref(entry["ref"])[1]
    by_key = {item_key(item): item for item in entry["items"]}
    units = {unit["unit_id"]: unit for unit in entry["units"]}
    shown = list(entry.get("shown_units") or [])
    saved = copy.deepcopy(entry.get("answers") or {})
    for unit_id in request["shown_units"]:
        if unit_id not in units:
            issue("unit_unknown", f"{unit_id} is not a unit of round {number}; units: {sorted(units)}")
        elif unit_id not in shown:
            shown.append(unit_id)
    visible = {key for unit_id in shown for key in units.get(unit_id, {}).get("items", [])}
    covered_before = bulk_covered(units, saved)
    for unit_id in request["bulk"]:
        if unit_id not in units:
            issue("unit_unknown", f"{unit_id} is not a unit of round {number}; units: {sorted(units)}")
        elif unit_id not in shown:
            issue("answer_not_presented", f"bulk names {unit_id}, which was never shown; list it in shown_units")
        elif not units[unit_id]["bulk_covers"]:
            issue("answer_invalid", f"{unit_id} has no bulk option to accept")
    for key in request["amend"]:
        if key not in request["answers"]:
            issue("answer_invalid", f"amend lists {key} without a new answer for it")
    for key, action in request["answers"].items():
        item = by_key.get(key)
        if item is None or key not in visible:
            issue("answer_not_presented", f"{key} is not in a shown unit of round {number}")
            continue
        if not check_action(item, action, state=state, ref=entry["ref"], issue=issue, key=key):
            continue
        previous = saved.get(key)
        changed = previous != action if previous is not None else key in covered_before
        if changed and key not in request["amend"]:
            issue("answer_conflict", f"{key} already has a saved answer ({previous or 'bulk'}); list it in amend to change it")
            continue
        saved[key] = action
    for unit_id in request["bulk"]:
        if unit_id in units:
            saved[unit_id] = {"bulk": True}
    covered = bulk_covered(units, saved)
    modified = [key for key, action in saved.items() if key in by_key and "modify" in action]
    for key, item in by_key.items():
        if item["kind"] != "preview" or not modified:
            continue
        action = saved.get(key)
        if action is not None and "accept" in action:
            missing = [entry_id for entry_id in modified if entry_id not in (action.get("unaffected_by") or [])]
            if missing:
                issue("preview_conflicts_with_modification", f"{key} is accepted while {missing} were modified in this round")
        elif action is None and key in covered:
            issue("preview_conflicts_with_modification", f"bulk acceptance would lock {key} while {modified} were modified in this round")
    pending = [key for key in by_key if key not in saved and key not in covered]
    entry.update(
        shown_units=shown,
        answers=saved,
        pending=pending,
        presented=[key for unit in entry["units"] if unit["unit_id"] in shown for key in unit["items"]],
        bulk_accept=any(unit_id in saved for unit_id in units),
    )
    return {"covered": covered, "pending": pending}


def close_round(state: dict[str, Any], entry: dict[str, Any], covered: set[str], *, issue: Issues, delegation_ref: str | None = None) -> dict[str, Any]:
    """整轮处理完：按 answers 一次生成决策、面锁与 preview 状态。"""
    ref, mode, saved = entry["ref"], entry["mode"], entry["answers"]
    changes: list[str] = []
    decisions: list[dict[str, Any]] = []
    superseded: list[str] = []
    revised: list[str] = []
    for item in entry["items"]:
        key = item_key(item)
        action = saved.get(key) or {}
        if "withdraw" in action:
            changes.append(one_line(f"{key} 撤回：{action['withdraw']}"))
            continue
        if item["kind"] == "decision":
            recommended, status = item["recommended"], "locked"
            if key in covered:
                selected, source_type, reason = recommended, "user_bulk_accepted", item["reason"]
            elif "choose" in action:
                selected, source_type = action["choose"], "user_selected_option"
                reason = item["reason"] if selected == recommended else f"用户选定（原推荐：{recommended}）"
            elif "modify" in action:
                selected, source_type, reason = action["modify"], "user_explicit", f"用户修改（原推荐：{recommended}）"
            else:
                selected, source_type, reason, status = recommended, "user_explicit", action["defer"], "deferred"
            decision = {
                "id": key,
                "topic": item["topic"],
                "class": "disclosed_default" if is_default(item) else "must_ask",
                "question": item["question"],
                "selected": selected,
                "reason": reason,
                "source": {"type": source_type, "mode": mode, "confirmation_ref": ref},
                "status": status,
            }
            if delegation_ref is not None:
                source_type = "domain_owner_confirmed"
                decision["source"].update(type=source_type, delegation_ref=delegation_ref)
            if is_default(item):
                decision["override_cost"] = item["override_cost"]
            decisions.append(decision)
            changes.append(one_line(f"{key} {'推迟' if status == 'deferred' else '锁定'}：{selected}（{source_type}）"))
            if item.get("supersedes"):
                superseded.append(item["supersedes"])
                changes.append(f"{item['supersedes']} 改为 superseded（由 {key} 替代）")
        elif item["kind"] == "preview":
            if "revise" in action:
                question = {
                    "id": revise_question_id(key),
                    "surface": key,
                    "question": action["revise"],
                    "why_blocking": f"用户要求修改 {key} preview；改完重新呈现确认。",
                    "next_step": "ask_user",
                }
                state["open_questions"] = merge_by(state.get("open_questions"), [question], "id")
                revised.append(key)
                changes.append(f"{key} 未锁定，保持待改；已加 open_question {question['id']}")
                continue
            if "accept_revised" in action:
                preview = normalize_preview(action["accept_revised"], state, stage=None, ref=ref, issue=issue, where=f"answers.{key}.accept_revised")
                source_type = "user_explicit"
                # 改后的 preview 没带需求条目时沿用草案里的条目。
                if preview is not None and "alignment_spec" not in preview and "alignment_spec" in item["preview"]:
                    preview["alignment_spec"] = copy.deepcopy(item["preview"]["alignment_spec"])
            else:
                preview = copy.deepcopy(item["preview"])
                source_type = "user_bulk_accepted" if key in covered else "user_selected_option"
            if preview is None:
                continue
            spec_entries = preview.pop("alignment_spec", None)
            if spec_entries:
                state["alignment_spec"] = merge_by(state.get("alignment_spec"), spec_entries, "spec_id")
                changes.append(f"alignment_spec 合并：{', '.join(str(entry['spec_id']) for entry in spec_entries)}")
            preview["status"] = "accepted"
            if delegation_ref is not None:
                source_type = "domain_owner_confirmed"
            preview["decision_source"] = {**preview["decision_source"], "type": source_type, "confirmation_ref": ref}
            if delegation_ref is not None:
                preview["decision_source"]["delegation_ref"] = delegation_ref
            if action.get("review_disposition"):
                preview["decision_source"]["review_disposition"] = action["review_disposition"]
            state["surface_previews"] = merge_by(state.get("surface_previews"), [preview], "surface")
            state.setdefault("locks", {})[f"{key}_locked"] = True
            state.setdefault("lock_sources", {})[key] = {"decision_source": copy.deepcopy(preview["decision_source"])}
            state["open_questions"] = [
                question for question in state.get("open_questions") or []
                if not (isinstance(question, dict) and question.get("id") == revise_question_id(key))
            ]
            changes.append(f"{key} 锁定（{source_type}）")
        else:
            changes.append(one_line(f"{key} 已答：{action.get('text', action.get('choose'))}"))
    if decisions:
        state["decisions"] = merge_by(state.get("decisions"), decisions, "id")
    for item in state.get("decisions") or []:
        if isinstance(item, dict) and item.get("id") in superseded:
            item["status"] = "superseded"
    entry["status"] = "closed"
    return {"changes": changes, "revised": revised}


def settle_round(entry: dict[str, Any]) -> None:
    for key in ROUND_PROGRESS_KEYS:
        entry.pop(key, None)


def derive_next_step(state: dict[str, Any]) -> tuple[str, str]:
    """未显式给 next_step 时的下一步：确定性动作连续做，缺判断就停在 ask_user。"""
    confirmations = [entry for entry in state.get("confirmations") or [] if isinstance(entry, dict)]
    if any(round_status(entry) == "open" for entry in confirmations):
        return "ask_user", "有待答项目：先答完当前轮。"
    deferred = [item.get("id") for item in state.get("decisions") or [] if isinstance(item, dict) and item.get("status") == "deferred"]
    if state.get("open_questions") or deferred:
        return "ask_user", "有 revise 或未决项：先处理 open_questions 与 deferred 决策。"
    locks = state.get("locks") if isinstance(state.get("locks"), dict) else {}
    product = locks.get("requirements_locked") is True and locks.get("product_experience_locked") is True
    reviews = state.get("review_refs") if isinstance(state.get("review_refs"), dict) else {}
    if product and locks.get("execution_locked") is True and not reviews.get("surface_slice") and not reviews.get("cross_surface"):
        return "review", "三面已锁：派 all_surfaces 审查。"
    return "ask_user", "等主代理决定下一轮。"


def g3_failure(phase: str, issues: list[dict[str, Any]], started: float) -> dict[str, Any]:
    return {
        "tool": "alignment_recorder",
        "phase": phase,
        "status": "fail",
        "exit_code": 1,
        "issues": [{**item, "hint": ISSUE_CODE_HINTS.get(str(item.get("code") or ""))} for item in issues],
        "files_written": [],
        "model_started": False,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
    }


def g3_noop(phase: str, started: float, state: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {
        "tool": "alignment_recorder",
        "phase": phase,
        "status": "noop",
        "exit_code": 0,
        **extra,
        "next_action": state.get("next_action"),
        "reads": next_reads(state),
        "files_written": [],
        "model_started": False,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
    }


def commit_g3(
    paths: G3Paths,
    phase: str,
    baseline_state: dict[str, Any],
    state: dict[str, Any],
    log_text: str,
    *,
    transaction_id: str,
    started: float,
    result: dict[str, Any],
    rounds: list[dict[str, Any]],
) -> dict[str, Any]:
    """与 delta 通道同一写入事务：渲染 → validate_rendered（含 guard）→ atomic_write；任何问题都不写字节。"""
    state["recording"] = {
        "last_delta_id": f"{phase}:round-{result['round']}" if result.get("round") else phase,
        "last_transaction_id": transaction_id,
        "recording_gate": "pass",
    }
    spec = paths.source["spec"]
    baseline_spec = spec.read_text(encoding="utf-8") if spec.is_file() else f"# {state.get('task_slug') or 'Alignment'}\n"
    rendered = {"spec": render_spec(state, baseline_spec), "discussion_log": log_text}
    issues = validate_rendered(baseline_state, {}, state, rendered, paths.output)
    for entry in rounds:
        found = round_section_pattern(round_ref(entry["ref"])[1]).search(log_text)
        section = found.group(0) if found else ""
        if f"- confirmation_ref: {entry['ref']}" not in section or f"- status: {round_status(entry)}" not in section:
            issues.append({"code": "discussion_confirmation_mismatch", "message": f"rendered {entry['ref']} section is incomplete"})
    if issues:
        return g3_failure(phase, issues, started)
    files_written = atomic_write(paths.output, rendered)
    return {
        "tool": "alignment_recorder",
        "phase": phase,
        "status": "pass",
        "exit_code": 0,
        **result,
        "next_action": state.get("next_action"),
        "reads": next_reads(state),
        "files_written": files_written,
        "model_started": False,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
    }


def blank_state(task_slug: str, summary: str) -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "task_slug": task_slug,
        "current_stage": "intake",
        "active_surface": None,
        "source_context": {"user_request_summary": summary, "canonical_refs": []},
        "locks": {**{f"{surface}_locked": False for surface in ALIGNMENT_SURFACES}, "planner_allowed": False},
        "lock_sources": {},
        "surface_previews": [],
        "confirmations": [],
        "decisions": [],
        "alignment_spec": [],
        "open_questions": [],
        "review_refs": {"surface_slice": [], "proposal_challenge": [], "cross_surface": []},
        "next_action": {"type": "ask_user", "reason": "空骨架已建：用 open-round 开首轮。", "dispatch_seed": None},
    }


def read_g3_baseline(paths: G3Paths) -> tuple[dict[str, Any], str]:
    spec = paths.source["spec"]
    if not spec.is_file():
        raise ToolError(f"{rel(spec)} does not exist; start with --phase init")
    state = read_v4_state(spec)
    if not isinstance(state.get("confirmations"), list):
        raise ToolError(f"{rel(spec)} alignment_state.confirmations must be a list")
    return state, paths.source["discussion_log"].read_text(encoding="utf-8")


def run_init(paths: G3Paths, args: argparse.Namespace, payload: dict[str, Any] | None, transaction_id: str, started: float) -> dict[str, Any]:
    issue = Issues()
    existing = [rel(path) for path in paths.source.values() if path.is_file()]
    if existing:
        issue("init_spec_exists", f"{existing} already exist; continue with open-round / answer")
    slug = args.task_slug or ""
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
        issue("init_input_invalid", f"--task-slug must be kebab-case, got {slug!r}")
    if not filled(args.summary):
        issue("init_input_invalid", "--summary must be a one-line request summary")
    if issue:
        return g3_failure("init", issue, started)
    state = blank_state(slug, args.summary.strip())
    log_text = f"# {slug} Discussion Log\n"
    result: dict[str, Any] = {"task_slug": slug, "changes": [f"新建 {rel(paths.output['spec'])} 与 {rel(paths.output['discussion_log'])}"]}
    rounds: list[dict[str, Any]] = []
    if payload is not None:
        opened = open_round(state, payload, paths=paths, log_text=log_text, issue=issue)
        if opened is None or issue:
            return g3_failure("init", issue, started)
        log_text, presentation, number = opened
        result.update(round=number, presentation=presentation)
        result["changes"].append(f"第 {number} 轮开启：{len(presentation['units'])} 个单元待呈现")
        rounds.append(state["confirmations"][-1])
    return commit_g3(paths, "init", {}, state, log_text, transaction_id=transaction_id, started=started, result=result, rounds=rounds)


def run_open_round(paths: G3Paths, payload: dict[str, Any], transaction_id: str, started: float) -> dict[str, Any]:
    state, log_text = read_g3_baseline(paths)
    baseline = copy.deepcopy(state)
    issue = Issues()
    opened = open_round(state, payload, paths=paths, log_text=log_text, issue=issue)
    if opened is None or issue:
        return g3_failure("open-round", issue, started)
    log_text, presentation, number = opened
    result = {
        "round": number,
        "round_status": "open",
        "presentation": presentation,
        "changes": [f"第 {number} 轮开启：{len(presentation['units'])} 个单元待呈现"],
    }
    return commit_g3(paths, "open-round", baseline, state, log_text, transaction_id=transaction_id, started=started, result=result, rounds=[state["confirmations"][-1]])


def run_answer(paths: G3Paths, payload: dict[str, Any], transaction_id: str, started: float) -> dict[str, Any]:
    state, log_text = read_g3_baseline(paths)
    baseline = copy.deepcopy(state)
    issue = Issues()
    number = payload.get("round")
    if isinstance(number, bool) or not isinstance(number, int) or number < 1:
        issue("answer_invalid", f"round must be a positive integer, got {number!r}")
        return g3_failure("answer", issue, started)
    ref = f"{paths.log_rel}#round-{number}"
    entry = next((item for item in state["confirmations"] if isinstance(item, dict) and item.get("ref") == ref), None)
    if entry is None:
        issue("round_unknown", f"{ref} is not a recorded confirmation round")
        return g3_failure("answer", issue, started)
    status = round_status(entry)
    stage = state.get("current_stage")

    if "cancel" in payload:
        if sorted(set(payload) - {"round", "cancel"}) or not filled(payload.get("cancel")):
            issue("answer_invalid", "cancel takes {round, cancel: <reason>} and nothing else")
        elif status == "closed":
            issue("round_already_closed", f"round {number} is closed; it cannot be cancelled")
        if issue:
            return g3_failure("answer", issue, started)
        if status == "cancelled":
            return g3_noop("answer", started, state, round=number, round_status="cancelled", open_round=open_round_number(state))
        discarded = list(answer_record(entry)["answers"])
        entry["status"] = "cancelled"
        log_text = upsert_round_section(log_text, number, render_round_section(entry, stage=stage, spec_ref=paths.spec_ref, cancel=payload["cancel"]))
        settle_round(entry)
        if (state.get("next_action") or {}).get("type") != "pause":
            write_next_action(state, "ask_user", None, f"第 {number} 轮已取消；取消前的意见要生效，放进新一轮重新呈现确认。")
        result = {
            "round": number,
            "round_status": "cancelled",
            "discarded_answers": discarded,
            "changes": [f"第 {number} 轮取消：草案作废，不生成决策、面锁或 accepted preview"],
        }
        return commit_g3(paths, "answer", baseline, state, log_text, transaction_id=transaction_id, started=started, result=result, rounds=[entry])

    request = {
        "shown_units": payload.get("shown_units"),
        "answers": payload.get("answers", {}),
        "bulk": payload.get("bulk", []),
        "amend": payload.get("amend", []),
    }
    unknown = sorted(set(payload) - ANSWER_KEYS)
    if unknown:
        issue("answer_invalid", f"answer has unknown keys {unknown}")
    for key in ("shown_units", "bulk", "amend"):
        if not isinstance(request[key], list) or not all(isinstance(value, str) for value in request[key]):
            issue("answer_invalid", f"{key} must be a list of identifiers")
    if not isinstance(request["answers"], dict):
        issue("answer_invalid", "answers must be a mapping of item id to one action")
    if "next" in payload and not isinstance(payload["next"], dict):
        issue("answer_invalid", "next must be a draft mapping (same fields as open-round)")
    check_next_step(payload, issue)
    delegation_ref = payload.get("delegation_ref")
    if delegation_ref is not None:
        parsed_delegation = round_ref(delegation_ref)
        if parsed_delegation is None or parsed_delegation[0] != paths.log_rel or not round_section_pattern(parsed_delegation[1]).search(log_text):
            issue("answer_invalid", "delegation_ref must cite an existing <log>#round-N in this discussion log containing the user's authorization")
    if issue:
        return g3_failure("answer", issue, started)
    if status == "cancelled":
        issue("round_cancelled", f"round {number} was cancelled; its units no longer accept answers")
        return g3_failure("answer", issue, started)
    if status == "closed":
        record = recorded_answer(log_text, number)
        answers = record.get("answers") if isinstance(record, dict) and isinstance(record.get("answers"), dict) else {}
        # 关轮重放未带引用时沿用 answer_record 已保存的授权引用；显式不同引用仍按 round_already_closed 拒绝。
        saved_delegation = record.get("delegation_ref") if isinstance(record, dict) else None
        replay_delegation = saved_delegation if delegation_ref is None else delegation_ref
        if (
            record is not None
            and set(request["shown_units"]) <= set(record.get("shown_units") or [])
            and set(request["bulk"]) <= set(record.get("bulk") or [])
            and all(answers.get(key) == value for key, value in request["answers"].items())
            and saved_delegation == replay_delegation
        ):
            return g3_noop("answer", started, state, round=number, round_status="closed", open_round=open_round_number(state))
        issue("round_already_closed", f"round {number} is closed and this answer differs from its answer_record")
        return g3_failure("answer", issue, started)

    if delegation_ref is not None:
        if entry.get("delegation_ref") not in (None, delegation_ref):
            issue("answer_conflict", "delegation_ref differs from the saved authorization reference")
        else:
            entry["delegation_ref"] = delegation_ref
    progress = record_progress(state, entry, request, issue=issue)
    if progress["pending"] and "next" in payload and not issue:
        issue("next_round_premature", f"round {number} still has pending items {progress['pending']}; next only rides on the answer that closes it")
    if issue:
        return g3_failure("answer", issue, started)

    if progress["pending"]:
        write_next_action(
            state,
            str(payload.get("next_step") or ("pause" if (state.get("next_action") or {}).get("type") == "pause" else "ask_user")),
            str(payload.get("next_route_id") or "") or None,
            f"第 {number} 轮待答 {len(progress['pending'])} 项：{', '.join(progress['pending'])}。",
        )
        pending_units = {unit["unit_id"] for unit in entry["units"] if set(unit["items"]) & set(progress["pending"])}
        result = {
            "round": number,
            "round_status": "open",
            "pending": progress["pending"],
            "presentation": render_presentation(entry, only=pending_units),
        }
        if business_view(state) == business_view(baseline):
            return g3_noop("answer", started, baseline, **result)
        log_text = upsert_round_section(log_text, number, render_round_section(entry, stage=stage, spec_ref=paths.spec_ref))
        result["changes"] = [f"第 {number} 轮保存进度：已展示 {', '.join(entry['shown_units']) or 'none'}，待答 {len(progress['pending'])} 项"]
        return commit_g3(paths, "answer", baseline, state, log_text, transaction_id=transaction_id, started=started, result=result, rounds=[entry])

    closed = close_round(state, entry, progress["covered"], issue=issue, delegation_ref=entry.get("delegation_ref"))
    if issue:
        return g3_failure("answer", issue, started)
    log_text = upsert_round_section(log_text, number, render_round_section(entry, stage=stage, spec_ref=paths.spec_ref))
    settle_round(entry)
    result = {"round": number, "round_status": "closed", "pending": [], "changes": [f"第 {number} 轮关闭"] + closed["changes"]}
    rounds = [entry]
    if payload.get("next_step"):
        write_next_action(state, payload["next_step"], str(payload.get("next_route_id") or "") or None, f"第 {number} 轮关闭；主代理指定下一步。")
    if "next" in payload:
        opened = open_round(state, payload["next"], paths=paths, log_text=log_text, issue=issue, where="next")
        if opened is None or issue:
            return g3_failure("answer", issue, started)
        log_text, presentation, next_number = opened
        result["next_round"] = {"round": next_number, "presentation": presentation}
        result["changes"].append(f"第 {next_number} 轮开启：{len(presentation['units'])} 个单元待呈现")
        rounds.append(state["confirmations"][-1])
    else:
        if not payload.get("next_step") and (state.get("next_action") or {}).get("type") != "pause":
            step, reason = derive_next_step(state)
            write_next_action(state, step, None, reason)
        advance_after_review(state)
    return commit_g3(paths, "answer", baseline, state, log_text, transaction_id=transaction_id, started=started, result=result, rounds=rounds)


def run_g3(args: argparse.Namespace, output_root: Path | None) -> dict[str, Any]:
    started = time.perf_counter()
    source, output = alignment_paths(args, output_root)
    paths = G3Paths(source, output)
    payload = read_input(args.input) if args.input else None
    transaction_id = str(args.transaction_id or args.phase)
    if args.phase == "init":
        return run_init(paths, args, payload, transaction_id, started)
    if payload is None:
        raise ToolError(f"--phase {args.phase} requires --input (a YAML / JSON file path, or - for stdin)")
    if args.phase == "open-round":
        return run_open_round(paths, payload, transaction_id, started)
    return run_answer(paths, payload, transaction_id, started)
