# plan-checker / requirement-granularity-review 派发规范

> 职责：规定 plan-checker / requirement-granularity-review 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：标准规格 S4 审查。一次 `all_surfaces` 审查用一份报告覆盖 requirements、product_experience、execution 三面与跨面，每对象至多两轮。使用 `node ops/tools/dispatch_prepare.mjs --seed-template` 生成骨架。

### 固定包头

```yaml task_package_agent
agent:
  role: plan-checker
  runtime_role: plan-checker
  capability:
    name: requirement-granularity-review
    file: ops/agent-prompts/plan-checker/requirement-granularity-review.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/plan-checker/requirement-granularity-review.md
```

MUST: 将以上固定值逐字写入 `task_package.agent`。

### 差异卡（最小种子真源）

```json route_card
{
  "dispatch_phase": {"kind": "workflow", "step": "alignment S4"},
  "applies_to": "标准规格 S4 的 all_surfaces 审查：三面与跨面一份报告，每对象至多两轮",
  "model_tier": "",
  "report_dir": "notes/verify",
  "slot": "requirement_granularity_review",
  "required": [
    {"path": "goal", "hint": "写明被审规格书和 review_round；第二轮写明第一轮各面 verdict 与已完成修订", "example": "审查 demo 规格书三面与跨面的需求颗粒度（review_round 1）"},
    {"path": "scope.read", "hint": "列入仓根 . 以授权整仓取证，并列入规格书、discussion log、事实 brief；第二轮列入 previous report", "example": [".", "notes/context/demo-alignment.md", "notes/context/demo-discussion-log.md"]},
    {"path": "alignment.state_ref", "hint": "写入规格书路径；使用 project_positioning.canonical_refs 时改用完整种子", "example": "notes/context/demo-alignment.md"},
    {"path": "contract.review_round", "enum": ["1", "2"], "hint": "本次派发的最高轮次：surface_rounds 或跨面本轮为 2 时写 2，否则写 1"},
    {"path": "contract.target_refs", "hint": "被审规格书", "example": ["notes/context/demo-alignment.md"]},
    {"path": "contract.review_focus", "hint": "从 requirements | alignment_spec | lock_surfaces | open_questions | acceptance_examples | spec_adversarial_review | cross_surface_consistency 中选择；包含 spec_adversarial_review 与 cross_surface_consistency", "example": ["spec_adversarial_review", "cross_surface_consistency", "acceptance_examples"]},
    {"path": "contract.surface_rounds", "hint": "all_surfaces 逐面轮次：逐字取 alignment_recorder.py --phase review 查询输出的 surface_rounds，键覆盖三面，值取 1 | 2 | carried（已 PASS 面标 carried）；原样进入任务材料，由审查者核对", "example": {"requirements": "1", "product_experience": "1", "execution": "1"}}
  ],
  "optional": [
    {"path": "contract.previous_report", "hint": "第二轮第一轮报告路径", "example": "notes/verify/demo-all-surfaces-review-r1.md"},
    {"path": "slug", "hint": "报告短名，建议 <target>-all-surfaces-review-r<round>"}
  ],
  "contract_defaults": {
    "output_report": "$report_path",
    "review_mode": "all_surfaces",
    "required_lock_surfaces": ["requirements", "product_experience", "execution"]
  },
  "seed_defaults": {
    "runtime_context": {"network_needed": "yes"},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["verdict", "review_mode", "review_round", "reviewed_inputs", "surface_lock_review", "surface_coverage", "open_questions", "findings", "required_changes", "planner_impact", "adversarial_questions", "cross_surface_findings", "evidence_refs", "Alignment Review"], "business_gate": "business_verdict"},
    "tool_contract": {"network_allowed": true},
    "handoff_contract": {"accept_verdicts": ["pass", "fail", "needs_owner"]}
  }
}
```

### 构包动作

1. 运行 `python -B ops/tools/alignment_recorder.py --phase review --spec <规格书>`，把输出的 `surface_rounds` 逐字写入合同；输出的跨面 `action` 为 `dispatch` 且跨面已有 PASS 登记时，在 goal 写明重审跨面。第二轮把 previous report 列入合同和 `scope.read`。
2. 把仓根 `.` 列入 `scope.read`，让 reviewer 在同一 owner 边界内核实仓内事实；用 `network_allowed=true` 核实外部事实。
3. `scope.read` 覆盖规格书（三面 preview、决策账本、`alignment_spec`、`review_refs`）、discussion log 与事实 brief。
4. 把来源追溯和伪锁事实作为 recorder / guard 的机械输入，不在本审查中重做。

BLOCK IF: 规格书缺某一面的 preview，或 `surface_rounds` 与 review 查询输出不一致。重跑查询补齐后重试；无法补齐时收口 `needs_owner` 并点名缺口。

## 回执接收

读取 `FINAL_HANDOFF.output.business_verdict`：`PASS` 对应 `pass`；`MISSING_LOCK`、`AMBIGUOUS`、`OVER_SCOPED`、`UNDER_SPECIFIED` 对应 `fail`；`NEEDS_OWNER` 对应 `needs_owner`。

核对 `surface_lock_review` 存在、`surface_coverage` 覆盖三面、`output.review_round` 与任务包一致。核对报告的 `## Alignment Review` 块写出 `summary`、`basis`、`unresolved`、`owner_decisions` 四键，`unresolved` 为显式列表、无问题时写 `[]`；缺该键时 recorder 不放行 planner（`exit_blocked: [unresolved_missing]`），返回该 lane 补齐。该块经 `--phase bind-review --from-report` 登记；登记拒收时把返回原因交同一 reviewer 修正该块后重试，块内 verdict 不由主代理改写。
