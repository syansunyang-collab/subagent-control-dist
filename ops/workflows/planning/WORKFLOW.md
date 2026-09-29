# planning 工作流

> 职责：规定已审核规格进入执行编排、派发、验证和收口的主线。
> 真源：planning 入口、阶段顺序、按需读取路由和职责边界
> 读取：命中读取

本工作流承接 alignment 出站后、执行需要跨会话或跨天交接的已审核规格。目标是并行生成实施拓扑与 Acceptance Contract，经机械 join 后编译可并发执行的 `dispatch_manifest`，再按合同生成验收 DAG、归并裁决并定向闭环。

本文件只在以下情况加载：

- 已审核规格的执行需要跨会话或跨天交接。
- 已有 `dispatch_manifest`，用户要求继续 planning、进入执行、修订执行编排或验收回流。

验收对象或锁定决策缺失时，回 `ops/workflows/alignment/exit.md` §2 的 S2 / S3 修订；规格引用或 planner seed 缺失时，按该文件 §4 重新生成 seed。

---

## 1. 按需加载

主代理进入 planning 时先读本文件。后续只按当前阶段打开对应文件，不整目录读取 `ops/workflows/planning/`。

| 场景 | 读取 | 做什么 |
| --- | --- | --- |
| planning 内部子代理调度 | `ops/workflows/planning/agent-dispatch.md` | 确定 P1/P4/P6/P7 的 role、capability 和 route |
| 需要读取或写入 planning 状态字段 | `ops/workflows/planning/planning-state.md` | 使用 `planning_state`、`dispatch_manifest` 和 `execute_gate` 字段结构 |
| 进入执行编排、生成或修订 dispatch manifest | `ops/workflows/planning/planner-flow.md` | 执行 P0、P1、P3、P4 |
| dispatch manifest 已生成，需要进入 executor 前准入 | `ops/workflows/planning/execution-gate.md` | 执行 P5，只做机械一致性核对和 executor seed 编译 |
| executor 执行 wave | `ops/workflows/planning/execution-wave.md` | 执行 P6，使用运行池、局部 join 和 lane 失败处理 |
| 执行后进入验收闭环 | `ops/workflows/planning/validation-dispatch.md` | 执行 P7，按 Acceptance Contract 编译验收 DAG 并机械消费 disposition |
| 验收后推进状态、输出或失败回流 | `ops/workflows/planning/state-transition.md` | 执行 P8、状态推进、输出路径和失败回流 |

`ops/workflows/planning/WORKFLOW.md` 只保留入口、阶段顺序和职责边界。字段结构、P1/P5/P6/P7/P8 细则以本表列出的专项文件为准；子代理 role / capability / route 映射以 `ops/workflows/planning/agent-dispatch.md` 为准。

---

## 2. 职责边界

主代理负责：

- 消费已审核规格、alignment 出站 seed、planner handoff、executor handoff，以及不属于 Acceptance Contract Fleet 的独立 verify 回执。
- 调用工具编译 planner、executor 任务包和 P7 verifier Fleet；不手工拼装 Acceptance Contract 叶子或 reducer seed。
- 对普通 handoff 按任务目标判定是否达成；P7 只把 reducer report（单 item 合同为叶子报告，经 `--leaf-decision-report`）交给 `acceptance_contract_check.py`，并处理工具返回的 `needs_owner`、结构损坏或运输异常。
- 组织用户确认或修订选择。
- 按 `ops/policies/state.md` 更新业务记录与工程状态。

planner-agent 负责执行编排：拓扑切片、切片细化、汇总和冲突消解。

executor-agent 负责执行被派发的 lane。executor 按 `dispatch_manifest` 实施、验证、写 SUMMARY 和 handoff，不修改 `dispatch_manifest` 或 Acceptance Contract。

planning workflow 不派 plan-checker 审 PLAN 或审 `dispatch_manifest`。用户明确点名审查某个 `dispatch_manifest` 时，主代理可作为独立临时审查处理；该审查不写入 planning 阶段流，不替代 P5、P6 或 P7。

执行后 verifier DAG 编译、Reducer disposition 和返工复验只看 `ops/workflows/planning/validation-dispatch.md`。主代理不在 P7 临时选择 route 或重算 finding 到 lane 的映射。

---

## 3. 阶段流

```text
P0 准入复核
  ↓
P1A planner 拓扑切片 + P1V Acceptance Contract（并行）
↓
P1J topology / Acceptance Contract 机械 join
↓
P1B planner 并发细化切片
  ↓
P1C planner 汇总与冲突消解，输出 dispatch_manifest
  ↓
主代理语义裁决并冻结 manifest identity
  ↓
P3 用户确认或自动继续
  ↓
P4 planner 修订执行编排
  ↓
P5 执行准入
  ↓
P6 executor 执行 wave
  ↓
P7 合同编译、多维验收、Reducer 裁决与机械消费
  ↓
P8 状态推进或回流
```

planning 没有 P2 审计划阶段。P1C 结束后由主代理完成实施编排语义裁决与冻结；Acceptance Contract 的覆盖与 traceability 由 P1J 和 identity gate 提供机械证据。

### 串行和并行边界

| 阶段 | 执行方式 | 原因 |
| --- | --- | --- |
| P0 准入复核 | 串行 | planning 入口只能有一个准入结论。 |
| P1A 拓扑切片 | 单写者，可与 P1V 并行 | 切片边界和冲突键只有一个来源，但不依赖验收合同成稿。 |
| P1V 验收合同 | 单写者，可与 P1A 并行 | 只从锁定规格派生 oracle、样例、route 与证据要求。 |
| P1J 机械 join | 串行工具 | topology 与合同均终态后检查 phase、spec identity 和 requirement 覆盖。 |
| P1B 切片细化 | 并行池 | P1B 只写各自 fragment；满足 ready 条件的 slice 进入候选集，优先并行安排。 |
| P1C 汇总与冲突消解 | 串行 | `dispatch_manifest`、wave、lane、串行理由和 join 条件必须汇总成一个执行口径。 |
| P3 用户确认 | 串行 | 用户确认只能消费一个 `dispatch_manifest` 和一个执行选择。 |
| P4 修订执行编排 | 混合 | 受影响切片可并行修订，最终 manifest 仍由一个 planner 汇总。 |
| P5 执行准入 | 串行 | 主代理只做机械一致性核对和 executor seed 编译。 |
| P6 executor 执行 | 并行池 | 从无硬阻塞、无写入冲突且 route / model / 派发通道可用的 `dispatchable_ready` lane 中按 capacity 同轮派发。 |
| P7 验收 | Fleet DAG | checker 从 Acceptance Contract 编译 verifier 节点；多 item 由 Reducer all-settled 归并，单 item 叶子直判；loop 机械消费 disposition。 |
| P8 状态推进 | 串行 | 状态文件只能由主代理按最终验收结果推进。 |

并发规则：按 `ops/workflows/planning/execution-wave.md` 计算候选集与容量上限，结合任务耗时和协作成本安排批次，优先并发推进。route、model 或派发通道暂不可用时保留 lane，待恢复后补位，不把运行时不可用改写成拓扑串行理由。

---

## 4. 主代理最小执行摘要

按 §3 阶段表顺序执行，并按 §1 只读取当前阶段的专项文件。增量动作仅有：

- P1C 结束后消费 handoff 并关闭 planner。
- P7 只把 Reducer report（单 item 为经 `--leaf-decision-report` 转换的叶子报告）交给 `acceptance_contract_check.py`；后续动作只按 `ops/workflows/planning/validation-dispatch.md`。
