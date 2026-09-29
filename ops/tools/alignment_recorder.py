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


OUTPUT_KEYS = {
    "spec": "output_spec_path",
    "discussion_log": "output_discussion_log_path",
}
ALLOWED_STAGES = set(STAGE_COMPLETION_STATES)
ALLOWED_DISCUSSION_MODES = {"append_one_round", "replace_confirmation_round", "unchanged"}
REVIEW_VERDICTS = SURFACE_REVIEW_VERDICTS
# 全量审查报告内的机器可读块：recorder 只消费它，不解析报告正文措辞。
REVIEW_REPORT_HEADING = "## Alignment Review"
REVIEW_REPORT_ROOT_KEY = "alignment_review"
NEXT_ACTION_MAP = {
    "ask_user": "ask_user",
    "dispatch_fact": "dispatch_fact",
    "rewrite_surface": "ask_user",
    "review": "dispatch_plan_check",
    "challenge": "dispatch_plan_check",
    "render_spec": "write_context",
    "gate": "enter_planner",
    "pause": "pause",
}
COMPLETION_BY_STAGE = dict(STAGE_COMPLETION_STATES)
CONFIRMATION_REQUIRED_FIELDS = ("confirmation_ref", "mode", "presented", "selected_option")

# G3 决策提交接口：init / open-round / answer。
G3_PHASES = ("init", "open-round", "answer")
ROUND_ITEM_KINDS = ("decision", "preview", "marker")
ROUND_MARKERS = ("user_constraints",)
# 各项目种类可用的回答动作；「其余全部按推荐 / 整卡按推荐」走顶层 bulk，不写进单项回答。
ANSWER_ACTIONS = {
    "decision": ("choose", "modify", "defer", "withdraw"),
    "preview": ("accept", "revise", "accept_revised", "withdraw"),
    "marker": ("choose", "text", "withdraw"),
}
ALL_ANSWER_ACTIONS = {name for names in ANSWER_ACTIONS.values() for name in names}
DRAFT_KEYS = {"stage", "mode", "active_surface", "items"}
DECISION_ITEM_KEYS = {"kind", "id", "topic", "class", "question", "options", "recommended", "reason", "override_cost", "supersedes"}
SUPERSEDABLE_STATUSES = {"locked", "deferred"}
ALIGNMENT_SPEC_REQUIRED = ("spec_id", "statement", "acceptance", "validation_object")
# 下一步所处阶段 → 本步需读（与 ops/workflows/alignment/WORKFLOW.md 各步「本步需读」一致；锚点只写小节号）。
STAGE_READS = {
    "intake": (
        "ops/workflows/alignment/WORKFLOW.md#3",
        "ops/workflows/alignment/decision-ledger.md#1",
        "ops/workflows/alignment/decision-ledger.md#4",
    ),
    "product": (
        "ops/workflows/alignment/surfaces.md#1",
        "ops/workflows/alignment/surfaces.md#2",
        "ops/workflows/alignment/surfaces.md#3",
        "ops/workflows/alignment/decision-ledger.md#2",
        "ops/workflows/alignment/decision-ledger.md#3",
    ),
    "solution": (
        "ops/workflows/alignment/discovery.md#1",
        "ops/workflows/alignment/discovery.md#2",
        "ops/workflows/alignment/discovery.md#3",
        "ops/workflows/alignment/discovery.md#4",
        "ops/workflows/alignment/discovery.md#5",
        "ops/workflows/alignment/surfaces.md#4",
    ),
    "review": ("ops/workflows/alignment/exit.md#1", "ops/workflows/alignment/exit.md#2"),
    "exit": ("ops/workflows/alignment/exit.md#3", "ops/workflows/alignment/exit.md#4"),
}
MARKER_ITEM_KEYS = {"kind", "marker", "question", "options"}
ANSWER_KEYS = {"round", "shown_units", "answers", "bulk", "amend", "next", "next_step", "next_route_id", "delegation_ref"}
# 进度字段只在轮次 open 期间留在状态里；关闭或取消时写进讨论日志后删去。
ROUND_PROGRESS_KEYS = ("items", "units", "shown_units", "answers", "pending")
ANSWER_RECORD_PREFIX = "- answer_record: "
REVIEW_SUMMARY_KEYS = ("summary", "basis", "unresolved", "owner_decisions")
POPUP_UNIT_QUESTIONS = 4
POPUP_HEADER_LIMIT = 12
POPUP_OPTION_RANGE = (2, 4)
PREVIEW_ACCEPT_LABEL = "接受"
PREVIEW_REVISE_LABEL = "需要修改"
TOPIC_LABELS = {
    "goal_scope": "目标范围", "acceptance": "验收", "tech_route": "技术路线", "design_point": "设计要点",
    "user_visible": "用户可见", "conflict": "冲突", "layout": "布局", "parameter": "参数",
    "naming": "命名", "internal": "内部",
}
SURFACE_LABELS = {"requirements": "需求面", "product_experience": "产品体验面", "execution": "方案面"}
MARKER_DEFAULTS = {
    "user_constraints": {
        "header": "坑点红线",
        "question": "已知的坑、偏好和红线？",
        "options": [
            {"label": "没有", "description": "没有额外的坑点、偏好或红线"},
            {"label": "有，我来补充", "description": "选 Other 直接写"},
        ],
    },
}


ISSUE_CODE_HINTS = {
    "initial_state_missing": "规格书与 discussion log 都不存在时，delta 必须带完整 alignment_delta.initial_state",
    "baseline_alignment_state_missing": "规格书存在但 ## Alignment State 块缺失或不可解析",
    "spec_version_frozen": "version 3 规格是冻结的历史记录，v4 recorder 不读不写；新工作另起 v4 规格",
    "state_version_invalid": "alignment_state.version 必须为 4；initial_state 可省略 version，由程序写 4",
    "delta_id_missing": "delta_id 必填，形如 AD-<nn>",
    "stage_invalid": "stage 取 stage_values 之一",
    "active_surface_invalid": "active_surface 取 surface_values 之一或 null",
    "mutation_scope_missing": "mutation_scope 必填，含 alignment_state_paths 列表与 discussion_log 模式",
    "discussion_mode_invalid": "mutation_scope.discussion_log 取 discussion_log_modes 之一",
    "mutation_scope_alignment_state_paths_invalid": "mutation_scope.alignment_state_paths 必须是列表",
    "mutation_scope_alignment_state_path_empty": "alignment_state_paths 不得含空路径",
    "state_patch_invalid": "state_patch 必须是映射",
    "state_patch_outside_mutation_scope": "state_patch 的每个叶子路径都必须列入 mutation_scope.alignment_state_paths（可省略 alignment_state. 前缀）",
    "state_patch_touches_surface_previews": "state_patch 不得改 surface_previews；preview 内容只能经 intake / product / solution 阶段的 surface_preview 提交（接受即消费一条确认轮）",
    "state_patch_touches_review_refs": "state_patch 不得改 review_refs；审查 / 挑战绑定只能经 --phase bind-review 提交（两轮封顶由程序执行）",
    "state_patch_touches_lock_sources": "state_patch 不得改 lock_sources；锁来源只由 accepted surface_preview 的 decision_source 派生（含 review_disposition），改来源就重新提交该面 preview 并带确认轮",
    "state_patch_touches_confirmations": "state_patch 不得改 confirmations；确认轮只经 delta.confirmation 写入，并同时渲染 discussion log 的同号 Round",
    "initial_state_review_bindings_forbidden": "initial_state.review_refs 只能是空绑定：surface_slice / proposal_challenge / cross_surface 均为 []；审查与挑战结果建档后经 --phase bind-review 登记",
    "initial_state_confirmations_forbidden": "initial_state.confirmations 必须为 []；首轮确认放进同一 delta 的 confirmation",
    "initial_state_not_blank": "initial_state 只建空骨架：三面锁为 false、lock_sources / surface_previews / decisions 为空；面与决策经 surface_preview、decisions 与 confirmation 提交",
    "state_patch_wrapped_root": "state_patch 的键直接写 alignment_state 下的字段，不要再包一层 alignment_state",
    "confirmation_ref_wrong_log": "confirmation.confirmation_ref 的路径必须是本次 --discussion-log 指定的日志",
    "next_step_invalid": (
        f"next_step 只取 next_step_values：{'、'.join(NEXT_ACTION_MAP)}。"
        "旧写法改写：dispatch_research / dispatch_explorer → dispatch_fact（带 next_route_id）；"
        "review_surface / cross_surface_review → review（一次 all_surfaces 审查含跨面）；ask_more / enter_gray_area → ask_user；"
        "domain_owner_review → ask_user（等外部负责人时用 pause）；none → 删去 next_step，保留现有 next_action。"
        "写成 next_action.type 值的（如 enter_planner），改用 next_step_to_next_action 里映射到它的键"
    ),
    "next_route_id_missing": "next_step=dispatch_fact 必须带 next_route_id（role__capability，如 research-agent__wheel-discovery）",
    "next_route_id_unexpected": "next_route_id 只随 next_step=dispatch_fact 提交",
    "surface_preview_surface_invalid": "surface_preview.surface 取 surface_values 之一",
    "surface_preview_stage_mismatch": "在 intake / product / solution 提交成熟且一致的 preview；审查后的修订回到拍板阶段提交",
    "surface_preview_field_missing": "surface_preview 缺 surface_preview_required_fields 中的字段",
    "surface_preview_status_invalid": "surface_preview.status 取 proposed / accepted / superseded",
    "accepted_preview_source_invalid": "status=accepted 时 decision_source.type 取 lock_source_types（用户或领域负责人确认）",
    "accepted_preview_still_open": "status=accepted 时 still_open 必须为 []",
    "product_surface_invalid": "accepted product_experience preview 须带 product_surface，取 product_surface_values",
    "ui_contract_missing": "product_surface=web / desktop 时须带非空 surface_contract 与 ui_design_contract",
    "execution_sections_missing": "accepted execution preview 须带 sections：tech / landing / quality / validation / structure",
    "execution_section_missing": "execution.sections 五键都要有内容；不涉及的写 not_needed: <理由>",
    "execution_section_not_needed_forbidden": "execution.sections.tech 与 validation 不能整节 not_needed",
    "not_needed_reason_missing": "not_needed 要写理由：not_needed: <理由>",
    "tech_wheel_missing": "execution.sections.tech 须为映射，wheel 写查轮子报告引用或 not_needed: <理由>",
    "user_constraints_ref_missing": "execution.sections.tech.user_constraints_ref 引用采访中 user_constraints 的回答（<log>#round-N）；G3 草案省略时填最近一个已关闭且呈现过该题的轮次",
    "confirmation_missing": "discussion_log 为 append_one_round / replace_confirmation_round，或 surface_preview 为 accepted 时，必须带 confirmation",
    "confirmation_invalid": "confirmation 须含 confirmation_ref（<log>#round-N：小写 round、ASCII 数字、无前导零、无首尾空白）、mode（popup / card / conversation）、非空 presented 列表、selected_option；bulk_accept 为布尔",
    "confirmation_requires_discussion_round": "带 confirmation 时 discussion_log 取 append_one_round 或 replace_confirmation_round",
    "confirmation_ref_mismatch": "accepted surface_preview.decision_source.confirmation_ref 必须等于 confirmation.confirmation_ref",
    "confirmation_presented_missing_surface": "接受 surface_preview 的确认轮 presented 须含该面名",
    "invalid_review_disposition": "decision_source.review_disposition 只能是 accept_residual_risk、revise_without_rereview、direction_rereview",
    "coverage_manifest_invalid": "coverage_manifest 若提供必须是列表",
    "coverage_item_invalid": "coverage_manifest 项必须是映射",
    "coverage_stable_id_invalid": "coverage_manifest 项 stable_id 缺失或重复",
    "coverage_required_fields_missing": "按 stable_id 前缀定位的来源对象缺 required_fields 中的路径",
    "init_input_invalid": "init 需要 --task-slug（kebab-case）与 --summary（一句话需求）",
    "init_spec_exists": "规格书或讨论日志已存在；init 只建新规格，继续对齐用 open-round / answer",
    "draft_invalid": "草案为映射：mode 取 confirmation_modes，items 为非空列表；可选 stage、active_surface（缺省取当前值），不接受其他键",
    "draft_item_invalid": "草案项 kind 取 decision / preview / marker，同一项目只出现一次；preview 内容写在 preview 键下；各 kind 的键见 draft_item_fields",
    "draft_options_invalid": "options 为 {label, description} 列表，label 非空且不重复；popup 每题 2–4 个选项",
    "draft_recommended_invalid": "recommended 写 options 中某个 label 的原文",
    "marker_invalid": "marker 取 round_markers：user_constraints",
    "decision_id_invalid": "决策 id 写 D-<数字> 且不重复；草案可省略 id，由工具分配",
    "decision_topic_invalid": "topic 取 decision_topics 之一；class 由 topic 推出，不用填",
    "decision_class_topic_mismatch": "class 由 topic 推出：必问 topic 为 must_ask，其余为 disclosed_default；草案删去 class 即可",
    "decision_field_missing": "决策草案须有非空 question 与 reason",
    "decision_override_cost_missing": "默认项（disclosed_default）须写 override_cost：推翻它的代价",
    "supersedes_invalid": "supersedes 写一个已存在且 status 为 locked 或 deferred 的决策 id，不能指向草案自己，同一轮不能有两项替代同一决策",
    "alignment_spec_invalid": "alignment_spec 只写在 requirements 的 preview 草案里，为列表；每条含非空 spec_id、statement、acceptance、validation_object，spec_id 不重复",
    "open_round_duplicate": "同一时刻只能有一个 open 轮：先用 answer 答完，或提交 {round, cancel: 理由} 取消后再开新轮",
    "round_unknown": "round 写 open-round / answer 输出里的轮号；该轮号不在本规格书的确认轮账本里",
    "round_cancelled": "该轮已取消，轮号与单元标识随之失效；按新一轮的轮号与单元作答",
    "round_already_closed": "该轮已关闭，本次回答与讨论日志该轮的 answer_record 不一致；要改结论就开新轮",
    "answer_invalid": "answer 输入为 {round, shown_units, answers, bulk?, amend?, next?, next_step?, next_route_id?, delegation_ref?} 或 {round, cancel: 理由}；delegation_ref 引用记录用户授权原话的 <讨论日志>#round-N；每个项目的回答是只含一个动作的映射，动作见 answer_actions",
    "unit_unknown": "shown_units 与 bulk 只写该轮的单元标识 R<轮号>-U<序号>",
    "answer_not_presented": "只能回答已展示单元里的项目；先把展示过的单元写进 shown_units，未展示的单元展示后再答",
    "answer_option_invalid": "choose 写该项 options 里某个 label 的原文",
    "answer_ambiguous": "每个项目只写一个动作：choose / modify / defer / withdraw（决策），accept / revise / accept_revised / withdraw（preview），choose / text / withdraw（marker）",
    "answer_conflict": "该项已有保存的回答（含批量覆盖）；要改就在顶层 amend 列出该项目",
    "preview_conflicts_with_modification": "同轮有决策被 modify 时，接受 preview 须用 accept_revised 提交修改后的完整 preview，或 accept 并在 unaffected_by 列出这些决策；也可 revise 或暂不回答，preview 不锁定",
    "next_round_premature": "该轮仍有待答项目；next 只在本次 answer 使该轮关闭时携带",
    "confirmation_round_not_closed": "确认轮来源只引用 closed 轮次：open 轮先答完；cancelled 轮的意见在新一轮重新呈现确认",
    "card_confirmation_missing": "补齐 source.confirmation_ref 指向的任务卡文件（<card>#confirmation）",
    "card_confirmation_invalid": "复用已确认或 promoted 的任务卡；草案先按任务卡流程确认",
    "card_decision_changed": "原样复用卡上已确认决策；新增差异用 open-round 呈现确认",
    "open_round_pending": "出站前不能有 open 轮：先答完或取消",
    "presented_outside_shown_units": "open 轮的 presented 只能含 shown_units 所列单元里的项目；presented 由 answer 按实际展示推出，不手写",
}


def build_schema() -> dict[str, Any]:
    return {
        "tool": "alignment_recorder",
        "phase": "schema",
        "status": "pass",
        "exit_code": 0,
        "root_key": "alignment_delta",
        "fields": {
            "delta_id": {"required": True, "type": "string", "hint": "AD-<nn>"},
            "stage": {"required": True, "type": "enum", "values": "stage_values"},
            "active_surface": {"required": False, "type": "enum|null", "values": "surface_values"},
            "mutation_scope": {
                "required": True,
                "type": "mapping",
                "fields": {
                    "alignment_state_paths": {"required": True, "type": "list[string]", "hint": "state_patch 叶子路径白名单，可省略 alignment_state. 前缀"},
                    "discussion_log": {"required": True, "type": "enum", "values": "discussion_log_modes"},
                },
            },
            "surface_preview": {
                "required": False,
                "type": "mapping",
                "required_fields": list(SURFACE_PREVIEW_REQUIRED_FIELDS),
                "hint": "在 stage=intake / product / solution 提交成熟且一致的 preview；status=accepted 时见 accepted_preview_rules",
            },
            "confirmation": {
                "required": "discussion_log 非 unchanged，或 surface_preview.status=accepted",
                "type": "mapping",
                "fields": {
                    "confirmation_ref": {"required": True, "hint": "<discussion-log 路径>#round-N；决定写入的 Round 标题，也是 confirmations[].ref"},
                    "mode": {"required": True, "values": "confirmation_modes"},
                    "presented": {"required": True, "type": "list[string]", "hint": "本轮实际呈现的决策 id 与面名；决策与面锁只能引用呈现过它的轮次"},
                    "bulk_accept": {"required": False, "type": "bool", "hint": "用户点了「其余全部按推荐」或「整卡按推荐」时为 true"},
                    "selected_option": {"required": True, "hint": "用户回答摘要，写入确认事件"},
                },
                "hint": "一次 delta 登记一轮确认，写入 confirmations 并渲染 discussion log 同号 Round",
            },
            "closed_questions": {"required": False, "type": "list[string]", "hint": "首项写入确认事件 question_id；缺省为 <surface>_surface 或 round"},
            "open_questions": {"required": False, "type": "list[string|mapping]", "hint": "待决项；字符串可写 <surface>_surface 由程序展开"},
            "decisions": {"required": False, "type": "list[mapping]", "hint": "按 id 合并（D-<nn>）；字段见 decision_fields；升级时可原样复用已确认任务卡的决策及 <card>#confirmation 来源"},
            "alignment_spec": {"required": False, "type": "list[mapping]", "hint": "按 spec_id 合并（AS-<nn>）"},
            "next_step": {"required": False, "type": "enum", "values": "next_step_values", "hint": "映射为 next_action.type，见 next_step_to_next_action"},
            "next_route_id": {"required": "next_step=dispatch_fact", "type": "string", "hint": "role__capability，写入 next_action.route_id"},
            "state_patch": {"required": False, "type": "mapping", "hint": "深合并到 alignment_state；每个叶子路径须在 mutation_scope.alignment_state_paths 内"},
            "initial_state": {"required": "规格书与 discussion log 均不存在", "type": "mapping", "hint": "完整 alignment_state（version 可省略，程序写 4）"},
            "coverage_manifest": {"required": False, "type": "list[mapping]", "item_fields": {"stable_id": {"required": True}, "required_fields": {"required": False, "type": "list[dotted-path]"}}, "hint": "可选自检；stable_id 前缀决定来源对象，见 coverage_stable_id_sources"},
            "fact_refs": {"required": False, "type": "list", "hint": "并入 source_context.canonical_refs"},
            "review_refs": {"required": False, "type": "list", "hint": "并入 source_context.canonical_refs"},
            "changed": {"required": False, "type": "any", "hint": "旧字段，仅供 coverage 自检"},
        },
        "state_version": STATE_VERSION,
        "stage_values": list(STAGE_COMPLETION_STATES),
        "stage_surfaces": {stage: sorted(surfaces) for stage, surfaces in STAGE_SURFACES.items()},
        "surface_values": list(ALIGNMENT_SURFACES),
        "discussion_log_modes": sorted(ALLOWED_DISCUSSION_MODES),
        "confirmation_modes": sorted(CONFIRMATION_MODES),
        "decision_source_types": sorted(DECISION_SOURCE_TYPES),
        "lock_source_types": sorted(LOCK_SOURCE_TYPES),
        "decision_fields": ["id", "topic", "class", "question", "selected", "reason", "override_cost", "source.type", "source.mode", "source.confirmation_ref", "status"],
        "next_step_values": list(NEXT_ACTION_MAP.keys()),
        "next_step_to_next_action": dict(NEXT_ACTION_MAP),
        "completion_by_stage": dict(COMPLETION_BY_STAGE),
        "review_verdicts": sorted(REVIEW_VERDICTS),
        "product_surface_values": sorted(PRODUCT_SURFACES),
        "surface_preview_required_fields": list(SURFACE_PREVIEW_REQUIRED_FIELDS),
        "accepted_preview_rules": [
            "decision_source.type 取 lock_source_types；user_bulk_accepted 只在 mode=card 的确认轮有效",
            "still_open 为 []",
            "confirmation 必带，confirmation.confirmation_ref == decision_source.confirmation_ref，presented 含该面名",
            "confirmation_ref 以 #round-N 结尾；discussion_log=append_one_round 时该 Round 不得已存在，replace_confirmation_round 时替换同号 Round",
            "product_experience 带 product_surface；web / desktop 另带 surface_contract 与 ui_design_contract",
            "execution 带 sections 五键；sections.tech 含 wheel 与 user_constraints_ref；execution 锁定时 requirements 与 product_experience 也须锁定（可同轮）",
            "存在 locked tech_route 决策时，execution 锁定前成本挑战须 proposal_stands 或带 owner_resolution_ref，且 wheel 不为 not_needed",
            "accepted 后程序写 locks.<surface>_locked=true 与 lock_sources.<surface>",
            "decision_source.review_disposition 可选，取 review_dispositions；不写则查询只按轮次。程序不从正文或 hash 推断",
        ],
        "review_dispositions": sorted(REVIEW_DISPOSITIONS),
        "residual_risk_dispositions": sorted(RESIDUAL_RISK_DISPOSITIONS),
        "coverage_stable_id_sources": {
            "SURFACE-<surface>-preview": "surface_preview",
            "SURFACE-<surface>-state": "由 preview 派生的 locks / lock_sources",
            "QUESTION-*": "closed_questions / open_questions / next_step",
            "DISCUSSION-*": "确认事件字段（stage / mode / presented / bulk_accept / question_id / selected_option / affected_surface / next）",
            "D-<nn>": "decisions[id]",
            "AS-<nn>": "alignment_spec[spec_id]",
        },
        "g3_phases": {
            "init": {
                "summary": "新建 v4 空骨架规格书与讨论日志；--input 带草案时同时开首轮",
                "input": {
                    "--task-slug": "必填，kebab-case",
                    "--summary": "必填，一句话需求，写入 source_context.user_request_summary",
                    "--spec / --discussion-log": "必填，两个文件都不得已存在",
                    "--input": "可选，首轮草案，字段同 open-round",
                },
                "output": "changes、next_action、reads；带草案时另有 round 与 presentation",
            },
            "open-round": {
                "summary": "登记待呈现草案，分配轮号、引用、缺省决策 id 与呈现单元；已有 open 轮时拒收",
                "input": {
                    "mode": "必填，取 confirmation_modes；按实际可用的提问工具选",
                    "items": "必填，非空列表；各 kind 字段见 draft_item_fields",
                    "stage": "可选，取 stage_values，缺省取当前阶段；preview 须与阶段相符（stage_surfaces）",
                    "active_surface": "可选，取 surface_values 或 null，缺省取当前值",
                },
                "output": "round、presentation（popup：units[].questions 可直接传给提问工具，question_items 对应各题项目；card / conversation：units[].text）、changes、next_action、reads",
            },
            "answer": {
                "summary": "登记用户实际看到的单元与回答；整轮处理完才一次生成决策、面锁与 preview 状态并关闭该轮，否则只存进度",
                "input": {
                    "round": "必填，轮号",
                    "shown_units": "必填，本次实际展示过的单元标识；多次 answer 累加",
                    "answers": "可选，{项目标识: 一个动作}；动作见 answer_actions；preview 的 accept 可带 unaffected_by；accept / accept_revised 可带 review_disposition（两轮审查用尽后的拍板处置）",
                    "bulk": "可选，用户选了「其余全部按推荐 / 整卡按推荐」的单元；popup 只覆盖该单元批量题所列默认项，card 覆盖卡上除 marker 外的全部项目，conversation 只覆盖默认项",
                    "amend": "可选，改动已保存回答时列出被改的项目标识",
                    "next": "可选，下一轮草案（字段同 open-round），只在本次 answer 使该轮关闭时生效",
                    "next_step / next_route_id": "可选，显式下一步，取值同 delta；缺省由工具推导",
                    "delegation_ref": "可选，记录用户授权原话的 <讨论日志>#round-N；本轮决策与面锁来源记 domain_owner_confirmed",
                    "cancel": "取消该轮：只写 {round, cancel: 理由}；草案作废，不生成正式结果",
                },
                "output": "round_status、changes、pending、仍有待答单元的 presentation、next_round、next_action、reads；已关闭轮次重复提交且与讨论日志 answer_record 一致时 status=noop",
            },
        },
        "draft_item_fields": {
            "decision": ["id（可省略）", "topic", "question", "options[{label, description}]", "recommended", "reason", "override_cost（默认项必填）", "supersedes（可选：被替代的已关闭决策 id；新决策生成时旧条目改 superseded）"],
            "preview": ["preview：surface_preview_required_fields 中除 status、decision_source 外的字段与各面附加字段；execution 可省略 sections.tech.user_constraints_ref；requirements 可带 alignment_spec[{spec_id, statement, acceptance, validation_object}]，preview 被接受时按 spec_id 合并进状态"],
            "marker": ["marker", "question（可省略）", "options（可省略）"],
        },
        "decision_topics": {"must_ask": sorted(MUST_ASK_TOPICS), "disclosed_default": sorted(DEFAULT_TOPICS)},
        "answer_actions": {kind: list(names) for kind, names in ANSWER_ACTIONS.items()},
        "round_markers": list(ROUND_MARKERS),
        "confirmation_statuses": list(CONFIRMATION_STATUSES),
        "stage_reads": {stage: list(reads) for stage, reads in STAGE_READS.items()},
        "reads_rule": "写状态的调用输出 reads：下一步所处阶段的本步需读。有 open 轮取当前阶段；下一步是审查取 review；产品两面已锁、execution 未锁取 solution；complete 取 exit",
        "issue_codes": dict(ISSUE_CODE_HINTS),
        "example_delta": "ops/fixtures/alignment-recorder-example-delta.yaml",
        "model_started": False,
    }


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


@dataclass
class RecorderInputs:
    delta_path: Path
    source_paths: dict[str, Path]
    output_paths: dict[str, Path]
    transaction_id: str


def load_yaml(path: Path, *, root_key: str) -> dict[str, Any]:
    if yaml is None:
        raise ToolError("PyYAML is required for alignment_recorder.py") from YAML_IMPORT_ERROR
    try:
        parsed = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ToolError(f"cannot parse {rel(path)}: {exc}") from exc
    if not isinstance(parsed, dict) or not isinstance(parsed.get(root_key), dict):
        raise ToolError(f"{rel(path)} missing mapping root {root_key}")
    return parsed[root_key]


def dump_yaml(root_key: str, value: dict[str, Any]) -> str:
    if yaml is None:
        raise ToolError("PyYAML is required for alignment_recorder.py") from YAML_IMPORT_ERROR
    return yaml.safe_dump(
        {root_key: value},
        allow_unicode=True,
        sort_keys=False,
        width=120,
    )


def alignment_paths(args: argparse.Namespace, output_root: Path | None) -> tuple[dict[str, Path], dict[str, Path]]:
    values = {
        "spec": args.spec,
        "discussion_log": args.discussion_log,
    }
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise ToolError(f"direct mode missing paths: {missing}")
    source_paths = {key: repo_path(str(value), label=key, must_exist=False) for key, value in values.items()}
    present = {key: path.is_file() for key, path in source_paths.items()}
    if any(present.values()) and not all(present.values()):
        raise ToolError(f"alignment file set is partial; missing {[key for key, exists in present.items() if not exists]}")
    output_paths = {
        key: (output_root / path.name if output_root else path)
        for key, path in source_paths.items()
    }
    return source_paths, output_paths


def load_direct(args: argparse.Namespace, output_root: Path | None) -> RecorderInputs:
    source_paths, output_paths = alignment_paths(args, output_root)
    delta_path = repo_path(str(args.delta or ""), label="delta", must_exist=True)
    delta = load_yaml(delta_path, root_key="alignment_delta")
    transaction_id = str(args.transaction_id or delta.get("delta_id") or "")
    return RecorderInputs(delta_path, source_paths, output_paths, transaction_id)


def reject_retired_cache_args(args: argparse.Namespace) -> None:
    retired = [
        flag
        for flag, value in (
            ("--state-pack", getattr(args, "state_pack", None)),
            ("--checkpoint", getattr(args, "checkpoint", None)),
        )
        if value
    ]
    if retired:
        raise ToolError(
            "alignment cache arguments are retired: "
            + ", ".join(retired)
            + "; remove them and recover from the canonical Alignment State in --spec"
        )


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


def file_bytes(path: Path) -> bytes | None:
    if not path.is_file():
        return None
    return path.read_bytes()


@contextmanager
def recorder_lock(outputs: dict[str, Path]):
    anchor = outputs.get("spec") or next(iter(outputs.values()))
    # 锁文件名 = 规格书仓内相对路径的文件名安全形态；同一规格书恒得同一锁。
    lock_id = re.sub(r"[^A-Za-z0-9._-]+", "_", rel(anchor.resolve()).replace("\\", "/")).strip("_")[-180:]
    lock_path = ROOT / ".runtime" / "cockpit" / "alignment_locks" / f"{lock_id}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+b")
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"\0")
        handle.flush()
    handle.seek(0)
    try:
        if msvcrt is not None:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        elif fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:  # pragma: no cover
            raise ToolError("alignment recorder lock is unsupported on this platform")
    except OSError as exc:
        handle.close()
        raise ToolError("alignment recorder is busy for this spec") from exc
    try:
        yield
    finally:
        handle.close()


def atomic_write(outputs: dict[str, Path], rendered: dict[str, str]) -> list[str]:
    with recorder_lock(outputs):
        return atomic_write_locked(outputs, rendered)


def sibling_temp(target: Path, tag: str) -> Path:
    # 临时文件建在目标父目录内：安全描述符继承目标目录，随后同目录 os.replace 不跨目录搬运。
    # 跨目录搬运会把源目录（旧实现用 tmp/）的受保护 DACL 带到目标，剥掉目标目录继承的 sandbox 读权限。
    return target.parent / f".{target.name}.{tag}.{uuid.uuid4().hex}.tmp"


def atomic_write_locked(outputs: dict[str, Path], rendered: dict[str, str]) -> list[str]:
    backups = {key: file_bytes(path) for key, path in outputs.items()}
    committed: list[str] = []
    staged: dict[str, Path] = {}
    rollbacks: list[Path] = []
    try:
        for key, text in rendered.items():
            target = outputs[key]
            target.parent.mkdir(parents=True, exist_ok=True)
            path = sibling_temp(target, "staged")
            path.write_text(text, encoding="utf-8", newline="\n")
            staged[key] = path
        if any(file_bytes(outputs[key]) != backups[key] for key in outputs):
            raise ToolError("alignment outputs changed during transaction")
        try:
            for key, target in outputs.items():
                os.replace(staged[key], target)
                staged.pop(key)
                committed.append(key)
        except OSError as exc:
            for key in reversed(committed):
                target = outputs[key]
                backup = backups[key]
                if backup is None:
                    target.unlink(missing_ok=True)
                else:
                    restore = sibling_temp(target, "rollback")
                    rollbacks.append(restore)
                    restore.write_bytes(backup)
                    os.replace(restore, target)
            raise ToolError(f"alignment transaction commit failed and was rolled back: {exc}") from exc
    finally:
        for leftover in list(staged.values()) + rollbacks:
            leftover.unlink(missing_ok=True)
    return [rel(outputs[key]) for key in committed]


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


def review_decision(state: dict[str, Any], surface: str | None, *, kind: str = "surface") -> dict[str, Any]:
    """Round-capped dispatch advice for one review object; never derives anything from content or hashes.

    action: reuse（最新一轮已通过，且未声明 direction_rereview）| dispatch（还有轮次额度）
            | owner_decision（两轮用尽仍未通过）| owner_resolved（challenge 由 owner 看过对比表后裁决）。
    continuation 只消费显式 review_disposition。owner_decision 不改写成 reuse，失败 verdict 留在 latest_verdict。
    不带 surface 的跨面查询额外给出 all_surfaces_action，作为下一次 all_surfaces 派发的触发，不是新调度器。
    """
    reviews = state.get("review_refs") if isinstance(state.get("review_refs"), dict) else {}

    def report_exists(value: Any) -> bool:
        if not isinstance(value, str) or not value.strip():
            return False
        try:
            candidate = repo_path(value.split("#", 1)[0], label="review_report", must_exist=False)
        except ToolError:
            return False
        return candidate.is_file()

    def decide(
        *,
        scope: str,
        rounds: list[dict[str, Any]],
        pass_verdicts: set[str],
        disposition: str | None,
        honor_owner_resolved: bool,
    ) -> dict[str, Any]:
        latest = rounds[-1] if rounds else None
        latest_verdict = latest.get("business_verdict") if isinstance(latest, dict) else None
        latest_report = latest.get("report_ref") if isinstance(latest, dict) else None
        owner_resolved = honor_owner_resolved and is_ref(latest.get("owner_resolution_ref")) if isinstance(latest, dict) else False
        passed = latest_verdict in pass_verdicts and report_exists(latest_report)
        residual = (
            disposition in RESIDUAL_RISK_DISPOSITIONS
            and len(rounds) >= REVIEW_ROUND_CAP
            and not passed
        )
        continuation = None
        rereview_blocked = None
        if passed and disposition == "direction_rereview" and len(rounds) < REVIEW_ROUND_CAP:
            action = "dispatch"
            continuation = "direction_rereview"
        elif passed:
            action = "reuse"
            if disposition == "direction_rereview" and len(rounds) >= REVIEW_ROUND_CAP:
                rereview_blocked = "round_cap"
        elif owner_resolved:
            action = "owner_resolved"
        elif residual:
            action = "owner_decision"
            continuation = disposition
        elif len(rounds) < REVIEW_ROUND_CAP:
            action = "dispatch"
        else:
            action = "owner_decision"
        return {
            "review_scope": scope,
            "rounds_used": len(rounds),
            "round_cap": REVIEW_ROUND_CAP,
            "next_round": len(rounds) + 1 if len(rounds) < REVIEW_ROUND_CAP else None,
            "latest_verdict": latest_verdict,
            "action": action,
            "report_ref": latest_report if action in {"reuse", "owner_resolved"} else None,
            "continuation": continuation,
            "rereview_blocked": rereview_blocked,
        }

    if kind == "challenge":
        if surface not in CHALLENGE_SURFACES:
            raise ToolError(f"only {sorted(CHALLENGE_SURFACES)} can be challenged, got {surface}")
        return decide(
            scope=f"challenge:{surface}",
            rounds=review_rounds(reviews.get("proposal_challenge"), surface),
            pass_verdicts={"proposal_stands"},
            disposition=None,
            honor_owner_resolved=True,
        )
    if surface:
        if not index_by(state.get("surface_previews"), "surface").get(surface):
            raise ToolError(f"surface preview not found: {surface}")
        return decide(
            scope=surface,
            rounds=review_rounds(reviews.get("surface_slice"), surface),
            pass_verdicts={"PASS"},
            disposition=surface_review_disposition(state, surface),
            honor_owner_resolved=False,
        )
    rounds = cross_rounds(reviews)
    decision = decide(
        scope="cross_surface",
        rounds=rounds,
        pass_verdicts={"PASS"},
        disposition=cross_review_disposition(rounds[-1] if rounds else None),
        honor_owner_resolved=False,
    )
    decision.update(review_dispatch_plan(state, decision))
    return decision


def review_dispatch_plan(state: dict[str, Any], cross_decision: dict[str, Any]) -> dict[str, Any]:
    """Advice for the one-shot all_surfaces dispatch (S4). Does not schedule a new reviewer."""
    previews = index_by(state.get("surface_previews"), "surface")
    missing_previews = [surface for surface in ALIGNMENT_SURFACES if not previews.get(surface)]
    surface_decisions = {
        surface: review_decision(state, surface)
        for surface in ALIGNMENT_SURFACES
        if previews.get(surface)
    }
    blocking = [
        surface for surface, item in surface_decisions.items()
        if item["action"] == "owner_decision" and item.get("continuation") not in RESIDUAL_RISK_DISPOSITIONS
    ]
    dispatching = [surface for surface, item in surface_decisions.items() if item["action"] == "dispatch"]
    carried = [surface for surface, item in surface_decisions.items() if item["action"] == "reuse"]
    rereview = [surface for surface, item in surface_decisions.items() if item.get("continuation") == "direction_rereview"]
    adjudicated = [
        surface for surface, item in surface_decisions.items()
        if item.get("continuation") in RESIDUAL_RISK_DISPOSITIONS
    ]
    unsafe = [
        surface for surface, item in surface_decisions.items()
        if item["action"] not in {"reuse", "dispatch"}
    ]
    cross_blocks = (
        cross_decision["action"] == "owner_decision"
        and cross_decision.get("continuation") not in RESIDUAL_RISK_DISPOSITIONS
    )
    cross_needs = cross_decision["action"] == "dispatch"
    needs_round = bool(dispatching) or cross_needs
    batch_blocked = None
    if missing_previews:
        action = "not_ready"
        reason = "none"
        batch_blocked = "surface_preview_missing"
    elif blocking or cross_blocks:
        action = "owner_decision"
        reason = "none"
    elif needs_round and unsafe:
        action = "owner_decision"
        reason = "none"
        batch_blocked = "non_pass_surface_not_carriable"
    elif needs_round:
        action = "dispatch"
        if cross_needs and not dispatching:
            reason = "cross_only"
        elif dispatching and not cross_needs:
            reason = "surface"
        else:
            reason = "mixed"
    else:
        action = "reuse"
        reason = "none"
    # 直接填进 all_surfaces seed 的 contract.surface_rounds；owner_decision 与缺 preview 的面不进表，由 all_surfaces_action 表达。
    surface_rounds = {
        surface: item["next_round"] if item["action"] == "dispatch" else "carried"
        for surface, item in surface_decisions.items()
        if item["action"] in {"dispatch", "reuse"}
    }
    return {
        "all_surfaces_action": action,
        "dispatch_reason": reason,
        "surface_rounds": surface_rounds,
        "carried_surfaces": carried,
        "rereview_surfaces": rereview,
        "owner_pending_surfaces": blocking,
        "adjudicated_surfaces": adjudicated,
        "missing_preview_surfaces": missing_previews,
        "batch_blocked": batch_blocked,
    }


def extract_review_report(path: Path) -> dict[str, Any]:
    """Read the machine-readable `## Alignment Review` block of an all_surfaces report."""
    if yaml is None:
        raise ToolError("PyYAML is required for alignment_recorder.py") from YAML_IMPORT_ERROR
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ToolError(f"cannot read review report {rel(path)}: {exc}") from exc
    lines = text.splitlines()
    heading = next(
        (index for index, line in enumerate(lines) if line.strip().lower() == REVIEW_REPORT_HEADING.lower()),
        None,
    )
    if heading is None:
        raise ToolError(
            f"{rel(path)} has no `{REVIEW_REPORT_HEADING}` section; "
            f"an all_surfaces report must carry the {REVIEW_REPORT_ROOT_KEY} block"
        )
    fence_start = None
    for index in range(heading + 1, len(lines)):
        if lines[index].strip().startswith("```"):
            fence_start = index
            break
        if lines[index].startswith("## "):
            break
    if fence_start is None:
        raise ToolError(f"{rel(path)} `{REVIEW_REPORT_HEADING}` section has no fenced YAML block")
    block_lines: list[str] = []
    closed = False
    for index in range(fence_start + 1, len(lines)):
        if lines[index].strip().startswith("```"):
            closed = True
            break
        block_lines.append(lines[index])
    if not closed:
        raise ToolError(f"{rel(path)} `{REVIEW_REPORT_HEADING}` fenced block is not closed")
    try:
        parsed = yaml.safe_load("\n".join(block_lines))
    except yaml.YAMLError as exc:
        raise ToolError(f"{rel(path)} `{REVIEW_REPORT_HEADING}` block failed to parse: {exc}") from exc
    block = parsed.get(REVIEW_REPORT_ROOT_KEY) if isinstance(parsed, dict) else None
    if not isinstance(block, dict):
        raise ToolError(
            f"{rel(path)} `{REVIEW_REPORT_HEADING}` block must be a mapping rooted at {REVIEW_REPORT_ROOT_KEY}"
        )
    return block


def review_batch_item(
    problems: list[str],
    *,
    scope: str,
    item: Any,
    rounds: list[dict[str, Any]],
    report_ref: str,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Validate one report entry against the rounds already bound.

    Returns (summary binding, new round entry): carried entries keep their bound round and write nothing;
    new entries must declare the round the recorder is about to assign. Invalid entries return (None, None)
    after appending the reason to `problems`.
    """
    if not isinstance(item, dict):
        problems.append(f"{scope} entry must be a mapping")
        return None, None
    verdict = item.get("business_verdict")
    round_value = item.get("round")
    carried = item.get("carried", False)
    if not isinstance(carried, bool):
        problems.append(f"{scope}.carried must be true or false")
        return None, None
    if verdict not in REVIEW_VERDICTS:
        problems.append(f"{scope}.business_verdict is invalid: {verdict!r}")
        return None, None
    if isinstance(round_value, bool) or not isinstance(round_value, int) or round_value < 1:
        problems.append(f"{scope}.round must be an integer >= 1")
        return None, None
    latest = rounds[-1] if rounds else None
    if carried:
        bound_round = int(latest.get("round") or 1) if isinstance(latest, dict) else None
        bound_verdict = latest.get("business_verdict") if isinstance(latest, dict) else None
        if (
            not isinstance(latest, dict)
            or bound_round != round_value
            or bound_verdict != verdict
            or verdict != "PASS"
            or not str(latest.get("report_ref") or "").strip()
        ):
            problems.append(
                f"carried {scope} does not match the bound round: declared round={round_value} verdict={verdict}, "
                f"bound round={bound_round} verdict={bound_verdict}"
            )
            return None, None
        return {"round": round_value, "business_verdict": verdict, "carried": True}, None
    expected = len(rounds) + 1
    if round_value != expected:
        problems.append(f"{scope} round mismatch: report declares {round_value}, current round is {expected}")
        return None, None
    if round_value > REVIEW_ROUND_CAP:
        problems.append(f"review_round_cap: {scope} already has {len(rounds)} review rounds; owner decides now")
        return None, None
    return (
        {"round": round_value, "business_verdict": verdict, "carried": False},
        {"round": round_value, "report_ref": report_ref, "business_verdict": verdict},
    )


def plan_review_batch(state: dict[str, Any], block: dict[str, Any], report_ref: str) -> dict[str, Any]:
    """Validate one all_surfaces report block against current review state; return the single write plan."""
    problems: list[str] = []
    reviews = state.get("review_refs") if isinstance(state.get("review_refs"), dict) else {}
    if not isinstance(state.get("review_refs"), dict):
        problems.append("alignment_state.review_refs must be a mapping")
    entries = block.get("surfaces")
    declared: dict[str, dict[str, Any]] = {}
    if not isinstance(entries, list):
        problems.append(f"{REVIEW_REPORT_ROOT_KEY}.surfaces must be a list")
        entries = []
    for index, item in enumerate(entries):
        if not isinstance(item, dict):
            problems.append(f"{REVIEW_REPORT_ROOT_KEY}.surfaces[{index}] must be a mapping")
            continue
        surface = item.get("surface")
        if not isinstance(surface, str) or surface not in ALIGNMENT_SURFACES:
            problems.append(f"{REVIEW_REPORT_ROOT_KEY}.surfaces[{index}].surface is invalid: {surface!r}")
            continue
        if surface in declared:
            problems.append(f"{REVIEW_REPORT_ROOT_KEY} declares {surface} twice")
            continue
        declared[surface] = item
    previews = index_by(state.get("surface_previews"), "surface")
    for surface in ALIGNMENT_SURFACES:
        if surface not in declared:
            problems.append(f"surface {surface} is missing from the report")
        elif not previews.get(surface):
            problems.append(f"surface preview not found: {surface}")

    bindings: list[dict[str, Any]] = []
    planned: list[dict[str, Any]] = []
    for surface, item in declared.items():
        summary, write = review_batch_item(
            problems,
            scope=surface,
            item=item,
            rounds=review_rounds(reviews.get("surface_slice"), surface),
            report_ref=report_ref,
        )
        if summary is None:
            continue
        bindings.append({"surface": surface, **summary})
        if write is not None:
            planned.append({"surface": surface, **write})

    cross = cross_rounds(reviews)
    cross_declared = block.get("cross_surface")
    cross_write: dict[str, Any] | None = None
    if cross_declared is None:
        problems.append("cross_surface is missing from the report")
    else:
        summary, write = review_batch_item(
            problems,
            scope="cross_surface",
            item=cross_declared,
            rounds=cross,
            report_ref=report_ref,
        )
        if summary is not None:
            bindings.append({"surface": "cross_surface", **summary})
            if write is not None:
                cross_write = write

    if problems:
        raise ToolError(
            "all_surfaces review binding rejected (nothing written): " + "; ".join(problems)
        )

    surface_slice = reviews.get("surface_slice") if isinstance(reviews.get("surface_slice"), list) else []
    newly_bound = {entry["surface"] for entry in planned}
    # 已绑定面（含 carried）保持原相对位置，新登记面按报告声明顺序接在末尾。
    remaining = [
        item for item in surface_slice
        if not (isinstance(item, dict) and item.get("surface") in newly_bound)
    ]
    ordered: list[dict[str, Any]] = []
    for surface in declared:
        if surface not in newly_bound:
            continue
        ordered.extend(review_rounds(surface_slice, surface))
        ordered.extend(entry for entry in planned if entry["surface"] == surface)
    return {
        "surface_slice": remaining + ordered,
        "cross_surface": cross + ([cross_write] if cross_write is not None else []),
        "bindings": bindings,
    }


def commit_review_binding(spec_path: Path, state: dict[str, Any]) -> None:
    """Render the spec with the mutated review metadata, gate it with alignment_guard, then write once."""
    baseline = spec_path.read_text(encoding="utf-8")
    text = render_spec(state, baseline)
    guard_root = ROOT / "tmp"
    guard_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="alignment-review-bind-", dir=guard_root) as name:
        staged = Path(name) / spec_path.name
        staged.write_text(text, encoding="utf-8")
        guard = build_data(staged, "context")
        if guard["status"] != "pass":
            raise ToolError(f"review binding failed guard: {[item['code'] for item in guard['issues']]}")
    atomic_write({"spec": spec_path}, {"spec": text})


def read_v4_state(spec_path: Path) -> dict[str, Any]:
    block, issues = extract_alignment_state(spec_path)
    if issues or not isinstance(block.get("alignment_state"), dict):
        raise ToolError(f"cannot read alignment state from {rel(spec_path)}")
    state = block["alignment_state"]
    version_issue = state_version_issue(state)
    if version_issue or state.get("version") is None:
        raise ToolError(f"{version_issue['code'] if version_issue else 'state_version_invalid'}: {rel(spec_path)} is not a v4 alignment spec")
    return state


def bind_review_batch(spec_path: Path, report_path: Path) -> dict[str, Any]:
    """Bind all three surfaces and the cross surface of one all_surfaces report in a single transaction.

    审查通过或已裁决且无未解决问题时直接出站；保留用户指定的 pause。
    报告块的决策摘要只透传到输出，不写入状态。
    """
    state = read_v4_state(spec_path)
    report_block = extract_review_report(report_path)
    report_ref = rel(report_path)
    plan = plan_review_batch(state, report_block, report_ref)
    reviews = state.setdefault("review_refs", {})
    reviews["surface_slice"] = plan["surface_slice"]
    reviews["cross_surface"] = plan["cross_surface"]
    reviews["latest_report_ref"] = report_ref
    result: dict[str, Any] = {
        "tool": "alignment_recorder",
        "phase": "bind-review",
        "status": "pass",
        "exit_code": 0,
        "review_mode": "all_surfaces",
        "report_ref": report_ref,
        "round_cap": REVIEW_ROUND_CAP,
        "bindings": plan["bindings"],
        "review_summary": {key: report_block[key] for key in REVIEW_SUMMARY_KEYS if key in report_block},
        "planner_allowed": False,
        "files_written": [rel(spec_path)],
        "model_started": False,
    }
    result["exit_blocked"] = advance_after_review(state, report_block)
    commit_review_binding(spec_path, state)
    result["planner_allowed"] = state["locks"].get("planner_allowed", False)
    result["next_action"] = state["next_action"]
    result["reads"] = next_reads(state)
    return result


def bind_review(
    spec_path: Path,
    *,
    surface: str | None,
    report_ref: str | None,
    verdict: str | None,
    kind: str,
    owner_resolution_ref: str | None = None,
    review_disposition: str | None = None,
) -> dict[str, Any]:
    """挑战登记（报告或 owner 裁决）与跨面剩余风险裁决；按面与跨面审查结果只经 --from-report 登记。"""
    state = read_v4_state(spec_path)
    reviews = state.setdefault("review_refs", {})
    written: dict[str, Any]

    if kind == "challenge":
        if surface not in CHALLENGE_SURFACES:
            raise ToolError(f"only {sorted(CHALLENGE_SURFACES)} can be challenged, got {surface}")
        decision = review_decision(state, surface, kind="challenge")
        report = repo_path(report_ref, label="review_report", must_exist=True) if report_ref else None
        rounds = review_rounds(reviews.get("proposal_challenge"), surface)
        others = [item for item in reviews.get("proposal_challenge") or [] if not (isinstance(item, dict) and item.get("surface") == surface)]
        if report is None:
            # 只登记 owner 裁决：owner 看过对比表后拍板，落在最新一轮上。
            if not rounds:
                raise ToolError("no challenge round to attach owner_resolution_ref to")
            if not is_ref(owner_resolution_ref):
                raise ToolError("challenge binding requires --review-report or a non-blank --owner-resolution-ref")
            rounds[-1]["owner_resolution_ref"] = owner_resolution_ref
            written = rounds[-1]
        else:
            if verdict not in PROPOSAL_CHALLENGE_VERDICTS:
                raise ToolError(f"challenge verdict must be one of {sorted(PROPOSAL_CHALLENGE_VERDICTS)}, got {verdict}")
            if len(rounds) >= REVIEW_ROUND_CAP:
                raise ToolError(f"review_round_cap: {surface} already has {len(rounds)} challenge rounds; owner decides now")
            written = {"surface": surface, "round": len(rounds) + 1, "report_ref": rel(report), "business_verdict": verdict}
            if owner_resolution_ref:
                written["owner_resolution_ref"] = owner_resolution_ref
            rounds.append(written)
        reviews["proposal_challenge"] = others + rounds
    elif kind == "cross":
        if surface:
            raise ToolError("cross residual-risk adjudication takes no --surface")
        if review_disposition not in RESIDUAL_RISK_DISPOSITIONS:
            raise ToolError(
                f"cross binding only records a residual-risk adjudication ({sorted(RESIDUAL_RISK_DISPOSITIONS)}); "
                "cross review results are bound with --from-report"
            )
        if report_ref or verdict:
            raise ToolError("cross review_disposition does not accept a new report or verdict")
        if not is_ref(owner_resolution_ref):
            raise ToolError("cross review_disposition requires a non-blank --owner-resolution-ref")
        decision = review_decision(state, None)
        rounds = cross_rounds(reviews)
        latest = rounds[-1] if rounds else None
        if len(rounds) < REVIEW_ROUND_CAP or not isinstance(latest, dict) or latest.get("business_verdict") not in REVIEW_VERDICTS - {"PASS"}:
            raise ToolError("cross residual risk disposition requires a non-PASS round at the cap; the failure verdict is kept")
        latest["review_disposition"] = review_disposition
        latest["owner_resolution_ref"] = owner_resolution_ref
        reviews["cross_surface"] = rounds
        written = latest
    else:
        raise ToolError("per-surface review binding is retired in v4; bind the all_surfaces report with --from-report")

    if kind == "cross":
        advance_after_review(state)
    commit_review_binding(spec_path, state)
    return {
        "tool": "alignment_recorder",
        "phase": "bind-review",
        "status": "pass",
        "exit_code": 0,
        "review_scope": decision["review_scope"],
        "round": written.get("round"),
        "round_cap": REVIEW_ROUND_CAP,
        "report_ref": written.get("report_ref"),
        "business_verdict": written.get("business_verdict"),
        "owner_resolution_ref": written.get("owner_resolution_ref"),
        "review_disposition": written.get("review_disposition"),
        "reads": next_reads(state),
        "files_written": [rel(spec_path)],
        "model_started": False,
    }


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


def next_reads(state: dict[str, Any]) -> list[str]:
    """下一步所处阶段的本步需读：有 open 轮取当前阶段；否则按锁推出下一步落在哪一步。"""
    stage = state.get("current_stage")
    locks = state.get("locks") if isinstance(state.get("locks"), dict) else {}
    product = locks.get("requirements_locked") is True and locks.get("product_experience_locked") is True
    if open_round_number(state) is None:
        if stage == "complete":
            stage = "exit"
        elif product and locks.get("execution_locked") is True and stage != "exit":
            stage = "review"
        elif product and locks.get("execution_locked") is not True:
            stage = "solution"
    return list(STAGE_READS.get(stage, ()))


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


def open_round_number(state: dict[str, Any]) -> int | None:
    for entry in state.get("confirmations") or []:
        if isinstance(entry, dict) and round_status(entry) == "open":
            return round_ref(entry.get("ref"))[1] if round_ref(entry.get("ref")) else None
    return None


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


def advance_after_review(state: dict[str, Any], block: dict[str, Any] | None = None) -> list[str]:
    """Reuse the exit gate after review or adjudication, preserving an explicit pause."""
    issues: list[dict[str, str]] = []
    validate_exit_gate(issues, state)
    blockers = [item["code"] for item in issues]
    if state.get("current_stage") == "paused" or (state.get("next_action") or {}).get("type") == "pause":
        blockers.append("paused")
    if blockers:
        state.setdefault("locks", {})["planner_allowed"] = False
        return blockers
    cross = cross_rounds(state.get("review_refs") or {})[-1]
    if not cross_review_disposition(cross):
        if block is None:
            # Carried cross reviews can point to an older report than the latest surface revision.
            report_ref = state["review_refs"].get("latest_report_ref", cross["report_ref"])
            block = extract_review_report(repo_path(report_ref, label="review_report", must_exist=True))
        if not isinstance(block.get("unresolved"), list):
            blockers.append("unresolved_missing")
        elif block["unresolved"]:
            blockers.append("unresolved")
    state["locks"]["planner_allowed"] = not blockers
    if not blockers:
        state["current_stage"] = "complete"
        write_next_action(state, "gate", None, "审查通过或已裁决：运行 guard --target planner 与 --emit-planner-seed。")
    return blockers


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
