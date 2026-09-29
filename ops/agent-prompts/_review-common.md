# 审查族公共层

> 职责：规定审查能力共用的输入、finding、业务 gate 和输出合同。
> 真源：审查族公共契约
> 读取：维护读取

适用于 verify-agent 和 semantic-review-agent 的审查能力；各能力文件只补专属输入与判定标准。

## §1. 输入与边界

- 审查对象是能力合同点名的对象（如 `target_files`）及其本次变更，finding 围绕它们和直接受影响的行为。取证按通用层补读调用方、被调用方、配置、schema、状态和测试，补读的材料可作为 finding 的证据引用。判定需要越出目标工作区的材料或业务取舍时，把缺口写进 `evidence_gaps` 并返回 `needs_owner`。
- 从 `extensions.capability_contract.<slot>` 读取本能力输入。必填字段缺失、被审对象不在 `scope.read`、输出路径不可满足或任务对象错路时，返回 `needs_owner`。
- 审查期间保持被审对象和 Git 状态不变。结果写入任务包声明的产物；复现用的夹具和实验放在普通产物目录或内存中，随报告保留。证据来源使用任务包列明的本轮依赖报告和现场材料。
- 语义判断不由脚本、正则、计数或格式完整性替代。能力明确允许的机械取证只负责提供事实。

## §2. Finding

每条 finding 必须包含：可定位位置、违反的能力判据、实际影响、修复方向和证据引用。缺少任一项不入 findings；无合格 finding 是合法结果。检查范围不足以决定 gate 时写入 `evidence_gaps` 并返回 `needs_owner`，不做猜测性补面。


## §3. 两轴结论

- `FINAL_HANDOFF.verdict` 表示审查任务是否完成：完成审查为 `done`；输入或授权不足为 `needs_owner`；产物写入失败为 `failed`。
- 被审对象是否通过只写入 `expected_output.business_gate` 指定的 `FINAL_HANDOFF.output` 字段，取 `pass | fail | needs_owner`。gate=fail 时审查仍可 `verdict=done`。
- gate、摘要、findings 数量和报告结论保持一致。

## §4. 输出

结构化 review 按任务材料末尾的「## 结构化结果」返回本轮结果；finding 与业务 gate 使用本文件 §2–§3 的语义，能力专属统计按对应能力文件填写。

非结构化 review 任务写四节报告：`Verdict`、`Findings`、`Evidence Gaps`、`Scope`，再按通用层生成 `FINAL_HANDOFF`。能力特有统计放入 handoff `output`，不扩展报告章节。携带 `acceptance_context` 的叶子规则由条件注入的 `ops/agent-prompts/_acceptance-leaf-common.md` 承载。
