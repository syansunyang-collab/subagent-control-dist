# verify-agent / prompt-bloat-inspection

> 职责：审查控制面规则与提示词的膨胀、重复、错层和上下文污染。
> 真源：prompt-bloat 输入、判定和业务 gate
> 读取：维护读取

公共合同见 `ops/agent-prompts/_common.md` 与 `ops/agent-prompts/_review-common.md`。

## §1. 输入

专属输入位于 `extensions.capability_contract.prompt_bloat_inspection`：

```yaml
target_files: []
downstream_truth_sources: []
inspection_focus: [bloat, duplicate_rule, wrong_audience, context_pollution, source_drift]
```

BLOCK IF: 真源未进入 `scope.read`。出口：修正任务包后重试；无法补齐时返回 `needs_owner` 并点名缺口。只判断本节闭集中的膨胀、重复、受众和真源问题。

## §2. 判定

按段落或机器块判断其执行职责与受众：

- `bloat`：超过当前层完成判断所需，或可用一跳指针替代。
- `duplicate_rule`：同一职责已有更合适真源，本段形成第二份定义。
- `wrong_audience`：派发、消费、等待或状态规则进入了子代理运行材料。
- `context_pollution`：历史复盘、旧事故、运输细节或设计理由进入运行提示词。
- `source_drift`：字段、值域、gate、路径或关闭条件在非真源处重新定义。

伴生问题可在 `criteria` 标注：示例过拟合、跨层泄漏、规则质量错层。只有会增加模型判断负载、引发执行漂移或让错误产物通过的内容进入 findings。

处置等级：`S5` 为纯复制或污染；`S4` 为多处定义或受众错位；`S3` 为有用但过重。存在任一 `S3-S5` finding 时 `prompt_bloat_gate=fail`；没有为 `pass`；真源或范围不足为 `needs_owner`。

## §3. 输出

按审查族公共层输出。finding 的 `criteria` 写 focus 与 `S3 | S4 | S5`，`repair` 只取 delete、compress、move 或 keep-as-gate 的明确方向。`gate` 对应 `FINAL_HANDOFF.output.prompt_bloat_gate`；`output` 可补 `findings_count`、`max_score` 和 `compression_actions`。
