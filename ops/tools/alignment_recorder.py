#!/usr/bin/env python3
"""Deterministically validate and commit alignment deltas without a model turn."""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None

try:
    import msvcrt
except ImportError:  # POSIX
    msvcrt = None

sys.dont_write_bytecode = True

try:
    import yaml
except ImportError as exc:  # pragma: no cover
    yaml = None
    YAML_IMPORT_ERROR = exc
else:
    YAML_IMPORT_ERROR = None

from _tool_common import ROOT, ToolError, emit, read_stdin_text, rel, repo_path
from alignment_guard import (
    ALIGNMENT_SURFACES,
    CHALLENGE_SURFACES,
    CONFIRMATION_MODES,
    CONFIRMATION_STATUSES,
    DECISION_ID_RE,
    DECISION_SOURCE_TYPES,
    DECISION_TOPICS,
    DEFAULT_TOPICS,
    FROZEN_STATE_VERSIONS,
    LOCK_SOURCE_TYPES,
    MUST_ASK_TOPICS,
    PRODUCT_SURFACES,
    PROPOSAL_CHALLENGE_VERDICTS,
    RESIDUAL_RISK_DISPOSITIONS,
    REVIEW_DISPOSITIONS,
    REVIEW_ROUND_CAP,
    ROUTE_ID_RE,
    STAGE_COMPLETION_STATES,
    STAGE_SURFACES,
    STATE_VERSION,
    SURFACE_PREVIEW_REQUIRED_FIELDS,
    SURFACE_REVIEW_VERDICTS,
    build_data,
    business_view,
    cross_review_disposition,
    cross_rounds,
    extract_alignment_state,
    index_by,
    is_ref,
    one_of,
    preview_issues,
    round_ref,
    round_status,
    review_rounds,
    surface_review_disposition,
    validate_exit_gate,
)

# 拆分前的模块顶层公开名字仍从入口转出，调用方与 dir(alignment_recorder) 不变。
from alignment_recorder_parts.constants import (
    OUTPUT_KEYS,
    ALLOWED_STAGES,
    ALLOWED_DISCUSSION_MODES,
    REVIEW_VERDICTS,
    REVIEW_REPORT_HEADING,
    REVIEW_REPORT_ROOT_KEY,
    NEXT_ACTION_MAP,
    COMPLETION_BY_STAGE,
    CONFIRMATION_REQUIRED_FIELDS,
    G3_PHASES,
    ROUND_ITEM_KINDS,
    ROUND_MARKERS,
    ANSWER_ACTIONS,
    ALL_ANSWER_ACTIONS,
    DRAFT_KEYS,
    DECISION_ITEM_KEYS,
    SUPERSEDABLE_STATUSES,
    ALIGNMENT_SPEC_REQUIRED,
    STAGE_READS,
    MARKER_ITEM_KEYS,
    ANSWER_KEYS,
    ROUND_PROGRESS_KEYS,
    ANSWER_RECORD_PREFIX,
    REVIEW_SUMMARY_KEYS,
    POPUP_UNIT_QUESTIONS,
    POPUP_HEADER_LIMIT,
    POPUP_OPTION_RANGE,
    PREVIEW_ACCEPT_LABEL,
    PREVIEW_REVISE_LABEL,
    TOPIC_LABELS,
    SURFACE_LABELS,
    MARKER_DEFAULTS,
    ISSUE_CODE_HINTS,
)
from alignment_recorder_parts.schema import (
    build_schema,
)
from alignment_recorder_parts.io import (
    RecorderInputs,
    load_yaml,
    dump_yaml,
    alignment_paths,
    load_direct,
    reject_retired_cache_args,
    file_bytes,
    recorder_lock,
    atomic_write,
    sibling_temp,
    atomic_write_locked,
)
from alignment_recorder_parts.state import (
    path_value,
    patch_leaf_paths,
    normalize_state_path,
    state_path_allowed,
    confirmation,
    coverage_source,
    question_id,
    check_next_step,
    write_next_action,
    state_version_issue,
    merge_by,
    deep_merge,
)
from alignment_recorder_parts.stage_nav import (
    next_reads,
    open_round_number,
)
from alignment_recorder_parts.preflight import (
    preflight,
)
from alignment_recorder_parts.render import (
    render_spec,
    render_discussion,
    validate_rendered,
)
from alignment_recorder_parts.review import (
    review_decision,
    review_dispatch_plan,
    extract_review_report,
    review_batch_item,
    plan_review_batch,
    commit_review_binding,
    read_v4_state,
    bind_review_batch,
    bind_review,
    advance_after_review,
)
from alignment_recorder_parts.delta import (
    question_from,
    canonical_refs_from_delta,
    apply_delta,
)
from alignment_recorder_parts.g3_draft import (
    Issues,
    G3Paths,
    filled,
    one_line,
    item_key,
    is_default,
    decision_number,
    revise_question_id,
    closed_constraints_ref,
    normalize_options,
    normalize_preview,
    normalize_decision,
    normalize_marker,
    normalize_draft,
)
from alignment_recorder_parts.g3_present import (
    plan_units,
    recommended_first,
    preview_brief,
    popup_question,
    bulk_question,
    card_item_lines,
    card_text,
    render_presentation,
    item_summary,
    action_summary,
    answer_record,
    round_section_pattern,
    render_round_section,
    upsert_round_section,
    recorded_answer,
    next_round_number,
)
from alignment_recorder_parts.g3_round import (
    read_input,
    open_round,
    check_action,
    bulk_covered,
    record_progress,
    close_round,
    settle_round,
    derive_next_step,
    g3_failure,
    g3_noop,
    commit_g3,
    blank_state,
    read_g3_baseline,
    run_init,
    run_open_round,
    run_answer,
    run_g3,
)

def render_schema_text(schema: dict[str, Any]) -> str:
    lines = [f"alignment_delta 字段合同（真源：{rel(Path(__file__))} --schema）"]
    for key, spec in schema["fields"].items():
        req = spec.get("required")
        req_text = "必填" if req is True else ("可选" if req is False else f"条件必填（{req}）")
        detail = spec.get("hint") or ""
        if spec.get("values"):
            detail = f"取 {spec['values']}" + (f"；{detail}" if detail else "")
        if spec.get("required_fields"):
            detail = f"必含 {spec['required_fields']}" + (f"；{detail}" if detail else "")
        lines.append(f"- {key}（{req_text}，{spec.get('type')}）{('：' + detail) if detail else ''}")
        for sub_key, sub in {**(spec.get("fields") or {}), **(spec.get("item_fields") or {})}.items():
            sub_req = "必填" if sub.get("required") is True else "可选"
            sub_detail = sub.get("hint") or (f"取 {sub['values']}" if sub.get("values") else "")
            lines.append(f"    - {sub_key}（{sub_req}{('，' + sub['type']) if sub.get('type') else ''}）{('：' + sub_detail) if sub_detail else ''}")
    lines.append(f"state_version: {schema['state_version']}")
    lines.append(f"stage_values: {schema['stage_values']}")
    lines.append(f"stage_surfaces: {schema['stage_surfaces']}")
    lines.append(f"surface_values: {schema['surface_values']}")
    lines.append(f"discussion_log_modes: {schema['discussion_log_modes']}")
    lines.append(f"confirmation_modes: {schema['confirmation_modes']}")
    lines.append(f"decision_source_types: {schema['decision_source_types']}")
    lines.append(f"lock_source_types: {schema['lock_source_types']}")
    lines.append(f"decision_fields: {schema['decision_fields']}")
    lines.append("next_step → next_action.type: " + ", ".join(f"{k}→{v}" for k, v in schema["next_step_to_next_action"].items()))
    lines.append(f"review_dispositions: {schema['review_dispositions']}")
    lines.append(f"residual_risk_dispositions: {schema['residual_risk_dispositions']}")
    lines.append("accepted_preview_rules:")
    lines.extend(f"  - {rule}" for rule in schema["accepted_preview_rules"])
    lines.append("G3 阶段（--phase init / open-round / answer；--input 取文件路径或 - 读标准输入，YAML 或 JSON）：")
    for phase, spec in schema["g3_phases"].items():
        lines.append(f"- {phase}：{spec['summary']}")
        lines.extend(f"    - {key}：{hint}" for key, hint in spec["input"].items())
        lines.append(f"    输出：{spec['output']}")
    lines.append(f"draft_item_fields: {schema['draft_item_fields']}")
    lines.append(f"decision_topics: {schema['decision_topics']}")
    lines.append(f"answer_actions: {schema['answer_actions']}")
    lines.append(f"round_markers: {schema['round_markers']}")
    lines.append(f"confirmation_statuses: {schema['confirmation_statuses']}")
    lines.append(f"reads: {schema['reads_rule']}")
    lines.extend(f"  - {stage}: {', '.join(reads)}" for stage, reads in schema["stage_reads"].items())
    lines.append("issue_codes:")
    lines.extend(f"  - {code}: {hint}" for code, hint in schema["issue_codes"].items())
    lines.append(f"example_delta: {schema['example_delta']}")
    return "\n".join(lines)


def execute(inputs: RecorderInputs, phase: str) -> dict[str, Any]:
    started = time.perf_counter()
    preflight_data, delta, baseline_state = preflight(inputs)
    if preflight_data["status"] != "pass" or phase == "preflight":
        preflight_data["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 3)
        return preflight_data

    state = apply_delta(baseline_state, delta, inputs.transaction_id)
    baseline_view = copy.deepcopy(baseline_state)
    if inputs.source_paths["spec"].is_file() and business_view(state) == business_view(baseline_view):
        return {
            "tool": "alignment_recorder",
            "phase": phase,
            "status": "noop",
            "exit_code": 0,
            "delta_id": delta.get("delta_id"),
            "reads": next_reads(state),
            "files_written": [],
            "model_started": False,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
        }

    baseline_spec = (
        inputs.source_paths["spec"].read_text(encoding="utf-8")
        if inputs.source_paths["spec"].is_file()
        else f"# {state.get('task_slug') or 'Alignment'}\n"
    )
    baseline_discussion = (
        inputs.source_paths["discussion_log"].read_text(encoding="utf-8")
        if inputs.source_paths["discussion_log"].is_file()
        else f"# {state.get('task_slug') or 'Alignment'} Discussion Log\n"
    )
    rendered = {
        "spec": render_spec(state, baseline_spec),
        "discussion_log": render_discussion(delta, baseline_discussion, spec_ref=rel(inputs.output_paths["spec"])),
    }
    write_outputs = {key: inputs.output_paths[key] for key in rendered}
    issues = validate_rendered(baseline_state, delta, state, rendered, inputs.output_paths)
    if issues:
        return {
            "tool": "alignment_recorder",
            "phase": phase,
            "status": "fail",
            "exit_code": 1,
            "delta_id": delta.get("delta_id"),
            "issues": issues,
            "files_written": [],
            "model_started": False,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
        }
    files_written = atomic_write(write_outputs, rendered)
    affected = delta.get("surface_preview", {}).get("surface") if isinstance(delta.get("surface_preview"), dict) else None
    result = {
        "tool": "alignment_recorder",
        "phase": phase,
        "status": "pass",
        "exit_code": 0,
        "recording_gate": "pass",
        "delta_id": delta.get("delta_id"),
        "files_written": files_written,
        "surface_review": review_decision(state, str(affected)) if affected else None,
        "cross_surface_review": review_decision(state, None),
        "reads": next_reads(state),
        "model_started": False,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
    }
    if phase == "record":
        return {key: result[key] for key in (
            "tool", "phase", "status", "exit_code", "recording_gate", "delta_id",
            "files_written", "surface_review", "cross_surface_review", "reads",
            "model_started", "elapsed_ms",
        )}
    result["coverage"] = preflight_data["coverage"]
    result["issues"] = []
    return result


def self_test() -> None:
    from alignment_recorder_selftest import self_test as _self_test

    _self_test()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="对 alignment_delta（v4）做前置机械校验、确定性渲染、失败原子提交，登记确认轮与决策账本，并按两轮封顶登记审查 / 挑战绑定；--from-report 按报告内 alignment_review 块一次登记三个面与跨面；init / open-round / answer 由主代理只提交草案与用户回答，轮号、引用、来源字段、面锁、讨论日志与下一步由工具完成；version 3 规格冻结不写；不启动模型，不算任何 hash。",
    )
    parser.add_argument("--phase", choices=("preflight", "apply", "record", "review", "bind-review", *G3_PHASES), default="record")
    parser.add_argument("--input", help="init / open-round / answer 的输入：YAML 或 JSON 文件路径，- 读标准输入。字段见 --schema 的 g3_phases。")
    parser.add_argument("--task-slug", help="init：kebab-case 任务名。")
    parser.add_argument("--summary", help="init：一句话需求，写入 source_context.user_request_summary。")
    parser.add_argument("--delta", help="直接模式 alignment_delta YAML。")
    parser.add_argument("--spec", help="直接模式 alignment spec。")
    parser.add_argument("--state-pack", help="已退役；传入时拒绝并指向 canonical Alignment State。")
    parser.add_argument("--checkpoint", help="已退役；传入时拒绝并指向 canonical Alignment State。")
    parser.add_argument("--discussion-log", help="直接模式与 init / open-round / answer 的 discussion log；bind-review 只更新规格书，不新增讨论轮。")
    parser.add_argument("--transaction-id", default="", help="非语义事务标识；缺省使用 delta_id。")
    parser.add_argument("--output-root", help="隔离输出目录；保留原输出文件名。")
    parser.add_argument("--surface", choices=list(ALIGNMENT_SURFACES), help="review 的按面查询对象；challenge 取 execution；缺省表示跨面。")
    parser.add_argument("--review-kind", choices=("surface", "cross", "challenge"), default=None, help="review 的查询对象类型；缺省按 --surface 有无取 surface / cross。bind-review 只接受 challenge（--surface execution）与 cross（剩余风险裁决）；按面与跨面审查结果经 --from-report 登记。")
    parser.add_argument("--review-report", help="bind-review --review-kind challenge 的挑战报告路径。")
    parser.add_argument("--from-report", help="bind-review 全量事务：all_surfaces 报告路径；按报告内 alignment_review 块一次校验并登记三个面与跨面，不接受 --review-report / --review-verdict / --surface / --review-kind / --owner-resolution-ref。")
    parser.add_argument("--review-verdict", choices=sorted(PROPOSAL_CHALLENGE_VERDICTS), default=None, help="challenge 报告的业务 verdict：proposal_stands / cheaper_path_exists / needs_owner。")
    parser.add_argument("--owner-resolution-ref", help="challenge 专用：owner 看过对比表后的裁决引用（discussion round）；可单独提交，落在最新一轮上。跨面剩余风险裁决与 --review-disposition 同用，不新增轮次。")
    parser.add_argument("--review-disposition", choices=sorted(RESIDUAL_RISK_DISPOSITIONS), default=None, help="跨面两轮用尽后的用户裁决。只记到现有跨面轮次，不改 business_verdict、不加轮次。面上裁决写 decision_source.review_disposition，不走本参数。")
    parser.add_argument("--format", choices=("json", "text"), default="json")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--schema", action="store_true", help="输出 alignment_delta 字段合同、闭集与错误码提示；不读写任何文件。")
    return parser.parse_args()


def build_text(data: dict[str, Any]) -> str:
    return "\n".join(f"{key}: {value}" for key, value in data.items())


def main() -> int:
    args = parse_args()
    reject_retired_cache_args(args)
    if args.self_test:
        self_test()
        print("alignment_recorder self-test: pass")
        return 0
    if args.schema:
        schema = build_schema()
        emit(schema, args.format, render_schema_text(schema))
        return 0
    if args.phase == "bind-review" and args.output_root:
        raise ToolError("--output-root is not supported with --phase bind-review; bind-review updates --spec in place")
    output_root = repo_path(args.output_root, label="output_root", must_exist=False) if args.output_root else None
    if output_root:
        output_root.mkdir(parents=True, exist_ok=True)
    if args.from_report and args.phase != "bind-review":
        raise ToolError("--from-report is only valid with --phase bind-review")
    if args.phase in G3_PHASES:
        data = run_g3(args, output_root)
    elif args.phase in {"review", "bind-review"}:
        spec = repo_path(str(args.spec or ""), label="spec", must_exist=True)
        kind = args.review_kind or ("surface" if args.surface else "cross")
        if args.phase == "bind-review":
            if args.from_report:
                conflicting = [
                    flag for flag, value in (
                        ("--review-report", args.review_report),
                        ("--review-verdict", args.review_verdict),
                        ("--surface", args.surface),
                        ("--review-kind", args.review_kind),
                        ("--owner-resolution-ref", args.owner_resolution_ref),
                        ("--review-disposition", args.review_disposition),
                    ) if value
                ]
                if conflicting:
                    raise ToolError(
                        "--from-report binds the whole report; drop " + ", ".join(conflicting)
                    )
                data = bind_review_batch(
                    spec,
                    repo_path(str(args.from_report), label="review_report", must_exist=True),
                )
            else:
                if kind == "surface":
                    raise ToolError("per-surface review binding is retired in v4; bind the all_surfaces report with --from-report")
                if kind == "cross" and not args.review_disposition:
                    raise ToolError("cross review results are bound with --from-report; bind-review --review-kind cross only records --review-disposition with --owner-resolution-ref")
                if kind == "challenge" and not args.review_report and not args.owner_resolution_ref:
                    raise ToolError("challenge binding requires --review-report or --owner-resolution-ref")
                if args.review_report and not args.review_verdict:
                    raise ToolError("bind-review requires --review-verdict with --review-report")
                data = bind_review(
                    spec,
                    surface=args.surface,
                    report_ref=args.review_report,
                    verdict=args.review_verdict,
                    kind=kind,
                    owner_resolution_ref=args.owner_resolution_ref,
                    review_disposition=args.review_disposition,
                )
        else:
            state = read_v4_state(spec)
            data = {
                "tool": "alignment_recorder",
                "phase": "review",
                "status": "pass",
                "exit_code": 0,
                **review_decision(state, args.surface if kind != "cross" else None, kind=kind),
                "reads": next_reads(state),
                "model_started": False,
            }
    else:
        if not args.delta:
            raise ToolError("preflight/apply/record requires --delta and direct alignment paths")
        inputs = load_direct(args, output_root)
        data = execute(inputs, args.phase)
    emit(data, args.format, build_text(data))
    return int(data.get("exit_code") or 0)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ToolError as exc:
        print(f"alignment_recorder: {exc}", file=sys.stderr)
        raise SystemExit(2)
