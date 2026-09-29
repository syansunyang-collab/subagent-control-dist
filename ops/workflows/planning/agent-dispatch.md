# planning/agent-dispatch.md

> 职责：规定 planning workflow 内部的子代理调度入口。
> 真源：planning 阶段到 role / capability 的映射
> 读取：命中读取

本文件只在 `ops/workflows/planning/WORKFLOW.md` 判断当前 planning 阶段需要派发子代理时读取。

本文件不定义 `task_package` 字段，不定义 `FINAL_HANDOFF`，不定义子代理行为。构包、拒收和回执接收只按命中的 `ops/protocols/task-package-routes/<role>__<capability>.md` 执行。

route 路径 = `ops/protocols/task-package-routes/<role>__<capability>.md`；构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架。

## 1. 调度原则

主代理先按 `ops/workflows/planning/WORKFLOW.md` 和当前专项阶段文件判断阶段，再按本文件选择 role / capability。

P1、P4、P6 和 P7 分别属于不同任务面。任务面可并发时，报告、handoff、progress、fragment 和写入路径不得重叠。

本文件不为 `plan-checker / plan-review` 提供 planning 阶段入口。用户明确点名审查 `dispatch_manifest` 时，按独立临时审查处理，不写 planning 阶段状态。

P5 只生成 executor 任务包 seed，不派子代理。P6 才消费 P5 seed 并派 `executor-agent / plan-execution`。

P7 的 route 集合由 Acceptance Contract 与 `ops/tools/acceptance_contract_check.py` 编译，不由主代理现场选择。本文件只登记编译节点与 reducer 的派发归属。

## 2. 阶段调度表

| planning 阶段 | 触发条件 | role / capability | seed 或输入来源 |
| --- | --- | --- | --- |
| P1A `planner_topology` | planning 准入复核通过，需要生成拓扑切片 | `planner-agent / plan-authoring` | `ops/workflows/planning/planner-flow.md` 与 alignment 出站 seed |
| P1V `acceptance_contract` | planning 准入复核通过，需要从锁定规格生成验收合同；与 P1A 无写冲突 | `planner-agent / acceptance-authoring` | `ops/workflows/planning/planner-flow.md` 与 alignment 出站 seed |
| P1J `acceptance_join` | P1A/P1V 均终态 | 不派子代理 | `acceptance_contract_check.py --topology` |
| P1B `planner_slice_detail` | P1A 生成的切片需要并发细化，且 ready 条件满足 | `planner-agent / plan-authoring` | `ops/workflows/planning/planner-flow.md` 与 P1A topology |
| P1C `planner_aggregate` | 必要切片片段已消费，需要汇总冲突并输出 dispatch_manifest | `planner-agent / plan-authoring` | `ops/workflows/planning/planner-flow.md` 与 P1B fragments |
| P4 `planner_revision` | P5/P6/P7 回流命中硬编排缺口，或用户要求修订 | `planner-agent / plan-authoring` | `ops/workflows/planning/planner-flow.md` 与失败来源 |
| P6 `execution_wave_lane` | P5 execute_gate 通过，当前 wave lane 满足运行池 ready 条件 | `executor-agent / plan-execution` | `ops/workflows/planning/execution-gate.md` 与 `ops/workflows/planning/execution-wave.md` |
| P7 `acceptance_leaf` | Acceptance Contract items 已通过 dispatch join；同 route 的 items 并为一个叶子 | 该 route 的 `route_id` | `acceptance_contract_check.py --compile-fleet` 生成的 node seed（`acceptance_context.items[]`） |
| P7 `acceptance_reducer` | 多 item 合同的本轮 acceptance leaf 全部进入终态；单 item 合同不挂 reducer，唯一叶子报告经 `--leaf-decision-report` 机械转换消费 | `verify-agent / acceptance-synthesis` | compiler 生成的 all-settled reducer seed |
| P7 `acceptance_rework` | reducer disposition=`rework`、未到轮次预算且未决集严格收缩（第 2 轮起 `--previous-decision-report` 机械校验） | `executor-agent / plan-execution` + 合同原 verifier route | `acceptance_contract_check.py --compile-followup` 生成的 Fleet manifest |

## 3. 失败回流

- 缺 planning 准入 seed 或 required refs 时，按 `ops/workflows/alignment/exit.md` §4 重新生成 seed；trusted spec 内容缺口回该文件 §2 的 S2 / S3 修订。
- 缺切片边界、验收对象、冲突键、资源锁、写入所有权或 dispatch manifest 时，回 `ops/workflows/planning/planner-flow.md`。
- P5 seed 缺字段时，回 `ops/workflows/planning/execution-gate.md`。
- executor lane 缺必要执行上下文、scope 或授权时，只补该 lane 所需字段；仍无法交付时回 P4 或 S2 / S3 修订。
- P7 合同 route、traceability 或 verdict 无法编译时，回 `ops/workflows/planning/validation-dispatch.md`；不得由主代理手拼替代 seed。
- 目标角色不可用或工具环境不可用时，读取 `ops/policies/role-fallback.md`。
