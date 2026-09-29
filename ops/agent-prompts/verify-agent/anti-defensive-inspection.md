# verify-agent / anti-defensive-inspection

> 职责：审查代码和文字中的吞错、静默兜底、重复校验、失败软化与拒发必要性。
> 真源：anti-defensive 输入、判定和业务 gate
> 读取：维护读取

公共合同见 `ops/agent-prompts/_common.md` 与 `ops/agent-prompts/_review-common.md`。

## §1. 输入

专属输入位于 `extensions.capability_contract.anti_defensive_inspection`：

```yaml
target_files: []
inspection_targets: [code, docs, comments, prompts]
```

BLOCK IF: `target_files` 缺失或 `inspection_targets` 不在闭集。出口：修正任务包后重试；无法补齐时返回 `needs_owner` 并点名缺口。

## §2. 判定

先检查目标范围内编译器、运行时和Pi适配器的拒发点：追踪输入来源、实际消费者和删除拒发后的最坏副作用。最坏仅为任务失败、回执说明并由主代理重派时，将该偏好拒发判为finding，修复建议写为执行引导或可见结果，而非转移为脚本拒发。保留真实授权、输入形状、身份信封和资源边界的保护；仅有旧throw或规则禁令不构成保护必要性的证据。按实际行为区分公开默认、派生与授权扩张，不因使用默认或继续派发本身判错。

按用途判定其余防御。断网重试、限流退避、崩溃恢复、取消清理、用户可感知的降级属于功能，不是 finding。沿调用方和失败路径说明该处理保护什么、删后有什么影响。只把证据已证明不服务真实功能或风险的处理列为 finding，如吞错、静默兜底、重复校验、对不变坏输入的无效重试、把错误洗成默认值、假旋钮、永不可达的兜底。核对校验是否有独立用途、重试能否恢复、测试是否保护真实契约，不凭内部或外部、用了 catch 或测试报红定性；用途仍不明的记入 evidence_gaps，按下文 gate 收口。

跨文件假旋钮需要系统性对照时，只在 `evidence_gaps` 指向 contract-drift，不代审。

存在任一合格 finding 时 `anti_defensive_gate=fail`；没有为 `pass`；证据不足以判断该防御是否服务真实功能或真实风险时为 `needs_owner`。

## §3. 输出

按审查族公共层输出。finding 的 `criteria` 写未通过的判定；`impact` 写哪个错误被吞、哪条失败路径被错误放行，或哪项无真实保护收益的拒发阻断任务；拒发finding的`criteria`写最坏副作用与必要性判据。`gate` 对应 `FINAL_HANDOFF.output.anti_defensive_gate`；`output` 可补 `findings_count` 和 `survived_count`。
