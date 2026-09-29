# verify-agent / acceptance-synthesis

> 职责：按 Acceptance Contract 归并多维验收证据并给出可机械消费的 disposition。
> 真源：acceptance-synthesis 的输入、归并判定和结构化输出
> 读取：维护读取

专属输入位于 `extensions.capability_contract.acceptance_synthesis`。本能力归并既有验收结果；被审对象、需求和风险处置保持输入状态。

## §1. 输入

先读取 Fleet 注入的 dependency result index，再按索引读取存在的正式报告。必须同时读取 `acceptance_contract_ref`；`dispatch_manifest_ref` 只用于 requirement 到 lane 的追溯。

`node_acceptance_map` 的值是列表：一个叶子按 route 并了多个 `acceptance_id`。每个 `acceptance_id` 只从该叶子报告的 ```json acceptance_results 块逐条读取。块缺失、无法解析或缺某条 id 时，将对应 id 写入 `coverage.missing`，在 `evidence_gaps` 点名 producer 与缺失 id；保留其余有效结果。由 producer 补回执后重新合成，复用已有证据。叶子的整叶 `gate` 只作参考，不覆盖逐条结论。

按索引区分执行与报告缺口：已知叶子未运行或尚未完成取证时记 `coverage.uncertain` / `uncertainty.unverified`；已有执行证据但回执缺失或格式损坏时记 `coverage.missing`。复用可证明 oracle 的有效证据，保留其他项的通过结论。

`review_round >= 2` 时先读取 `prior_decision_ref`。`carried_acceptance_ids` 沿用此前明确通过且未受本次修改影响的证据；本轮报告只替换 `node_acceptance_map` 点名项，最终 coverage 仍必须覆盖完整 `acceptance_ids`。

## §2. 裁决

逐个 `acceptance_id` 记录 route 结论、证据、finding、缺口和 requirement refs，再做跨报告去重与冲突处理：

- 所有 blocking 验收项满足 oracle，已有通过证据，且其余缺口不改变放行结论：`disposition=pass`、`gate=pass`；non_blocking 缺口仍保留在 coverage 与报告中。
- 原 lane 范围内可定位、可修复的产品失败，或可在原授权内补齐的未取证项：`disposition=rework`、`gate=fail`。此协议值表示后续工作，产品修复只针对 failed 项；未取证项只补证据。
- 需要修复 producer 回执、解决规格或合同冲突、扩大 scope、裁决真实证据冲突，或达到 `max_review_rounds` 仍未完成：`disposition=needs_owner`、`gate=needs_owner`，点名能处理缺口的 producer 或主代理；只有真实用户取舍才询问用户。

按缺口性质划分 `coverage.uncertain`：`uncertainty.environment` 为环境故障，`uncertainty.unverified` 为未运行或尚未完成取证，`uncertainty.evidence` 为真实证据冲突或待裁决项。三组并集等于 uncertain。定向取证项列入 `confirmation_acceptance_ids`；产品失败同时列入 `failed_acceptance_ids`。`regression_acceptance_ids` 只列受修复影响的项。补回执后直接重新合成，能复用的证据继续使用。

## §3. 输出

按审查族公共层和启动材料的输出要求交付结果。每条 finding 额外包含 `acceptance_refs` 与 `requirement_refs`。`output` 固定为：

```json
{
  "disposition": "pass | rework | needs_owner",
  "acceptance_ids_considered": [],
  "failed_acceptance_ids": [],
  "confirmation_acceptance_ids": [],
  "regression_acceptance_ids": [],
  "coverage": {"passed": [], "failed": [], "uncertain": [], "missing": []},
  "uncertainty": {"environment": [], "unverified": [], "evidence": []}
}
```

`acceptance_ids_considered` 必须与任务包 `acceptance_ids` 闭集完全一致。`pass` 时确认与回归列表为空，blocking 项均在 coverage.passed；其余未完成项随报告交付。`rework` 时 findings 与 failed ids 一致；`needs_owner` 时在 `evidence_gaps` 写明具体缺口、接手者和下一步。
