# planner-agent / acceptance-authoring

> 职责：从已锁定规格独立生成可机械校验的 Acceptance Contract。
> 真源：acceptance-authoring 的输入、判定和产物格式
> 读取：维护读取

本能力与 implementation topology 并行运行。直接消费已锁定规格，独立生成 Acceptance Contract。

## §1. 开工条件

按以下顺序准备输入：

1. 从 `extensions.capability_contract.acceptance_authoring` 读取 `trusted_spec_ref`、`spec_revision`、`phase_id`、`requirement_ids`、`source_refs`、目标合同路径和 `mechanical_schema`。
2. 读 `alignment_guard_ref` 报告，确认 `target=planner`、`status=pass`，目标规格仍为锁定状态。
3. 确认 `mechanical_schema.source=ops/tools/acceptance_contract_check.py`，并读取其中的字段闭集、route 要求快照、宏、枚举和 `max_review_rounds`。

BLOCK IF: 上述字段缺失、guard 未通过、规格未锁定、checker 来源不匹配，或 schema 闭集不完整。先修正输入后重试；无法在授权输入内修正时返回 `needs_owner`，点名缺口并停止生成合同。

## §2. 生成 Acceptance Contract

按以下步骤编写根键为 `acceptance_contract` 的产物：

1. **建立覆盖。** 从锁定规格提取 `requirement_ids`，为每个 requirement 建立至少一个可判定验收项；合同字段和值只取 `mechanical_schema`。
2. **定义验收对象。** `validation_object` 逐字取锁定规格对应条目的原值，同一 requirement 的多个验收项共用该值；用 `oracle` 写各验收项可观察的通过依据。
3. **选择方法和样例。** 从 `technique_values` 选择 `technique`，按真实使用动作编写 `cases` 及可观察的通过结果；共享同一次实跑证据，结果不同时补充场景，保留暂停确认、异常恢复、授权隔离等真实负向场景。让每个验收项只选择一个 `validation_route_values` 中的主要 `route_id`。
4. **编译 route 输入。** 用 `route_contract_requirements[route_id]` 填满 `route_contract`。实现路径尚未知时只使用 `route_contract_macros`。把规格 validation 面的必要运行环境（运行时、驱动、fixture 和安装位置）集中在 `entry_conditions` 写一次，作为执行前提。
5. **定义证据与复验。** 把取证方法及任务特定证据要求写入 `oracle` 或 `evidence_requirements`，把产品动作与结果写入 `cases`；用 `severity` 区分阻断级别；用 `confirmation_scope` 和 `regression_scope` 指定失败后的定向复验范围。

同时落实以下规格映射规则：

- 当 Alignment State 的 `locks.product_experience_locked=true` 时，至少一个验收项从 `entry_route_values` 选择 functional-inspection 或 ui-interaction-inspection；只为运行证据覆盖不到的代码观察建立 code-verification 验收项，保留对应的 `requirement_refs`。checker 用 `user_visible_spec_without_entry_route` 拒收缺少用户可见入口 route 的合同。
- UI route 的 `ui_entrypoints` 使用包含 `target`、`start_command`、`driver_command` 的对象；让 `driver_command` 指向 `verify_env.location` 中的无头驱动，由叶子记录 `start_command` 启动后的实际端口。
- 计时、吞吐和资源占用硬门设置 `exclusive_measurement: true`，并在 `oracle` 中写明样本数、冷/热定义、取值口径和允许的预热。
- 对 owner 逐项点名的闭集清单，在 `oracle` 或 `cases` 中按原文核对实际对象与约定结果。
- 对含 UI 面的交付，加入至少一条“真实数据关键视图”验收项：使用真实数据源截图并判读布局、信息可辨性，以及长文本、长时间跨度、大量条目和长期未终结记录下的可读性；fixture 继续承载行为判据。
- 将报告交付给用户；只把已约定放行或需要领域判断的事项留作确认点。
- 保持合同在锁定规格边界内，只确定验证方法类别、主要 route 和证据；具体 runner、驱动、软件接口和实现方案留给后续执行能力。

BLOCK IF: 锁定规格无法提供任一 requirement 的 `oracle`、`validation_object` 或必要 route 输入。先从已授权 `source_refs` 补齐；仍无法补齐时返回 `needs_owner` 并点名 requirement 与缺口。

把合同写成纯 YAML 文件落到 `acceptance_contract_ref`，报告另行提交，不把报告正文写进合同文件。落盘前按注入的 `mechanical_schema` 逐项核对闭集与必填字段；可运行命令时再执行 `python -B ops/tools/acceptance_contract_check.py --contract <acceptance_contract_ref> --format json`，按结果修正后重试；修正需要改变锁定规格或补充未授权输入时，返回 `needs_owner` 并附失败证据。

## §3. 输出

`FINAL_HANDOFF.output` 局部字段：

```yaml
output:
  acceptance_contract_ref: <acceptance_contract_ref>
  requirement_count: <正整数>
  acceptance_item_count: <正整数>
  summary: <回应验收合同产物、覆盖和残余>
```

`scope_actual.written` 只列 Acceptance Contract 和 handoff。
