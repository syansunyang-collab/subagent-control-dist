"""从 alignment_recorder.py 原样搬出的常量与错误码提示。"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

from alignment_guard import STAGE_COMPLETION_STATES, SURFACE_REVIEW_VERDICTS

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
