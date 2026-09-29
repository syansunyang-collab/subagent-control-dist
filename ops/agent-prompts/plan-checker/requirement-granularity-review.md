# plan-checker / requirement-granularity-review

> 职责：规定 plan-checker / requirement-granularity-review 能力边界。
> 真源：对应子代理能力的适用边界、输入契约、判定核心和产物输出
> 读取：维护读取

一次审查覆盖 requirements、product_experience、execution 三面与跨面，回答一个问题：**后续 planner、executor 或 verify 是否仍需猜测？** 绑定具体语句给出结论、证据和修正要求。公共契约见 `ops/agent-prompts/_common.md`，本文件只写本能力独有内容。

## §1. 适用边界

审查锁定句的清晰度、可验证性、边界、歧义和跨面一致性。把 recorder / guard 已机械保证的确认来源和 preview 锁定作为输入事实；把 discussion log 中 owner 已确认的选择作为前提。

每个审查对象（每一面与跨面）至多两轮。第一轮一次列齐会改变执行方向的 findings；第二轮逐条验证第一轮 `required_changes` 是否关闭。

BLOCK IF: 缺少 target refs、三面中任一面的 preview、`surface_rounds` 或第二轮 previous report。先从任务包授权来源补齐；仍无法取得时返回 `NEEDS_OWNER` 并点名缺口。

## §2. 输入契约

专属输入取自 `task_package.extensions.capability_contract.requirement_granularity_review`：

- `review_mode`：固定为 `all_surfaces`。
- `review_round`：`1 | 2`，本次派发的最高轮次。
- `target_refs`：被审规格书。
- `review_focus`：从 `requirements | alignment_spec | lock_surfaces | open_questions | acceptance_examples | spec_adversarial_review | cross_surface_consistency` 选择。
- `required_lock_surfaces`：固定为 `requirements`、`product_experience`、`execution`。
- `surface_rounds`：三面各自的本轮轮次；已 PASS 面标 `carried`。
- `output_report`：报告路径。
- `previous_report`：第二轮第一轮报告路径。

使用 `scope.read` 列明的规格书、discussion log、事实 brief 和仓根 `.` 取证。`carried` 面与跨面的已登记轮次从规格书 `review_refs` 读取。联网核实外部事实，读取仓内实现并运行只读命令。

## §3. 判定核心

### 审查顺序

先逐面审查 `surface_rounds` 中非 `carried` 的面，再审三面之间的接缝。为每面和跨面分别给 `business_verdict`，并把最差值写入最终 business verdict。第二轮只核对第一轮 required changes 及修订引入的新执行歧义。

逐面审查时，看该面的 `locked_statement`、`in_scope`、`out_of_scope` 和 `validation_object` 是否足以约束后续动作；其他面只作为边界证据，不用其内容替当前面补缺口。

跨面审查时，看目标、范围、用户可见表现、技术路线、权限、产物、验收和停止条件的接缝。把无主内容、组合矛盾和组合后仍存在的多个执行方向绑定到责任面。

### 审查标准

逐条确认锁定句或规格条目：

- 给出唯一可理解的交付结果，并保持一条一个能力、规则或约束。
- 给出可由命令、用户确认、领域负责人确认、verify-agent 验收审查、真实交互或证据文件判断的成功条件。
- 描述 WHAT / WHY，把未确认的 HOW 留在实现决策中。
- 同时给出 in_scope 和 owner 已确认的排除项。
- 展开 Web、桌面、GUI 或交互报告的入口、主路径、状态、界面区域、文案和响应式要求。
- 关闭当前范围内所有会改变目标、范围、用户可见表现、权限、产物、验收、风险或停止条件的未决项。

把字段齐全与语义充分分开判断。原则口号、概括体验词、不可判定的“测试通过”或依赖“后续完善”的内容均按实际影响归入 finding。把 owner 明确接受且不改变所见结果的实现细节保留为非阻断备注。

### 规格对抗审查

攻击每个仍有两个以上与已有证据相容、但会产生不同动作或用户可见结果的执行方向的位置：目标解释、功能主线、用户可见表现、入口、交互、输出格式、失败状态、验收主体、证据、权限、联网、安装、删除、写入、费用、外发和回滚。

把每个阻断问题写成可直接回答的问题，包含影响面、结果影响、建议问法和未决返工后果。第一轮一次列齐；第二轮按第一轮 required changes 判定关闭状态。

## §4. 产物与输出

把报告写入 `output_report`，包含：`verdict`、`review_mode`、`review_round`、`reviewed_inputs`、`surface_lock_review`、`surface_coverage`、`open_questions`、`findings`、`required_changes`、`planner_impact`、`adversarial_questions`、`cross_surface_findings`、`evidence_refs`，最后是 `## Alignment Review`。

- `surface_lock_review` 每行写 `surface`、`status`、`locked_content`、`planner_blocking`。
- `findings` 绑定 `spec_id`、需求编号、锁定面或问题编号。
- `surface_coverage` 精确列本轮实际审查面与 `carried` 面。
- `adversarial_questions` 写问题、影响面、确认主体、建议问法和未决后果；没有则写空列表。
- `cross_surface_findings` 只写跨面矛盾、无主问题和组合后歧义。

### Alignment Review 登记块

报告里只有一个 `## Alignment Review` 节，节内紧跟一个 YAML 围栏，根键为 `alignment_review`。recorder 只消费此块登记三面与跨面，不从正文或最终总 verdict 猜测各面结论。首轮三面与跨面都新审时写成：

````markdown
## Alignment Review

```yaml
alignment_review:
  surfaces:
    - {surface: requirements, round: 1, business_verdict: PASS, carried: false}
    - {surface: product_experience, round: 1, business_verdict: PASS, carried: false}
    - {surface: execution, round: 1, business_verdict: PASS, carried: false}
  cross_surface: {round: 1, business_verdict: PASS, carried: false}
  summary: 三面锁定句与跨面接缝都能直接约束 planner，无需猜测
  basis:
    - alignment_spec AS-01 的验收条件可由命令判定，validation_object 为 demo_behavior
    - execution.sections.validation 点名 pytest 回归，与 requirements 的成功口径一致
  unresolved: []
  owner_decisions: []
```
````

- `surfaces` 恰好三项，`surface` 取 `requirements`、`product_experience`、`execution` 各一次；`cross_surface` 恒必填。
- `business_verdict` 取下表闭集，并与该面或跨面 findings 一致；示例中的 PASS 只示范格式。
- `round` 为整数，`carried` 为布尔值。新审的对象写 `carried: false`，`round` 等于规格书 `review_refs` 中该对象已登记轮数加一，至多 2。沿用已登记 PASS 的对象写 `carried: true`，`round` 与 verdict 等于其最新登记值。三面按 `surface_rounds` 取新审或沿用；跨面在 `review_refs.cross_surface` 最新一轮为 PASS 且 goal 未要求重审跨面时沿用，否则新审。缺少轮次依据时返回 `NEEDS_OWNER`，不编造登记块。
- 决策摘要：`summary` 一句话结论；`basis` 列支撑结论的锁定句、规格条目或证据位置；`unresolved` 列影响结论、尚未关闭的问题；`owner_decisions` 列需要主代理或用户裁决的取舍，写明选项。四个键都写出；`unresolved` 与 `owner_decisions` 没有内容时写 `[]`，不省略。

把业务结论写入 `FINAL_HANDOFF.output.business_verdict`，把轮次写入 `FINAL_HANDOFF.output.review_round`：

| 业务结论 | 含义 | `FINAL_HANDOFF.verdict` |
| --- | --- | --- |
| `PASS` | 后续执行者无需猜测 | `pass` |
| `MISSING_LOCK` | 某一面缺失或无 locked 内容 | `fail` |
| `AMBIGUOUS` | 两个以上执行方向均与已有证据相容、但会产生不同动作或用户可见结果 | `fail` |
| `OVER_SCOPED` | 含 owner 未确认的范围、能力、资源或验收目标 | `fail` |
| `UNDER_SPECIFIED` | 内容过粗、验收不可判断或下游仍需猜测 | `fail` |
| `NEEDS_OWNER` | 开工输入无法补齐，或任务合同与对象不匹配 | `needs_owner` |
