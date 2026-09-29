# Role Fallback Policy

> 职责：规定角色回退和 CONTEXT 补齐动作。
> 真源：角色回退、CONTEXT 补齐和恢复规则
> 读取：命中读取

本文件定义目标子代理入口不可用时的降级规则。主代理只有在目标 `agent_type` 不存在或当前工具环境不可用时读取。

## 1. 总原则

- 目标角色不可用时，选择能履行原职责的替代入口并保留原验收要求。
- 降级后 `task_package.agent.role` 写原目标角色，`task_package.agent.runtime_role` 写实际入口。
- 替代入口沿用原任务包的授权面：scope、写入面与联网声明 `runtime_context.network_needed` 照原包写，不新增授权。

## 2. 降级表

| 目标角色 | 降级顺序 | 约束 |
| --- | --- | --- |
| `plan-checker` | `general-agent` 只读审查 → 主代理只读审查 | 按原 capability 边界审查 |
| `planner-agent` | `general-agent` 写编排产物 → 主代理只写原任务包已授权的 topology、fragment、dispatch_manifest 或 handoff 路径，并重新派发 | `alignment_native` 模式要求 `notes/context` + `alignment_state` 存在；`planning_context` 模式才要求 `.planning/phases/<phase>/CONTEXT.md` 存在 |
| `executor-agent` | 不降级；收窄 scope 后重新派发；executor 入口本身不可用时按阻断 / `needs_owner` / 用户批准的新任务收口 | 未经用户批准时主代理不得替写源码；用户批准后主代理可直接实施，并保留验证义务 |
| `verify-agent` | `general-agent` 只读验证 → 主代理只读验证 | 代码改动后必须保留验证结论 |
| `research-agent` | 主代理在原任务范围内查证 | 保留支撑结论的来源，不凑来源数量 |
| `explorer-agent / codebase-scan` | 主代理只读仓内扫描 | 必须保留 file:line 或命令证据 |
| `explorer-agent / runtime-env-scan` | 主代理只读环境扫描 | 必须保留命令、版本、路径或失败输出证据；不得安装 |
| `explorer-agent / network-readiness-scan` | 主代理只读网络扫描 | 只能访问任务包列明目标；保留 DNS、端口、代理或 HTTP 证据；不得改配置 |
| 其余未列角色 | 主代理在原范围内选择能履行原职责的替代入口 | 记录替代入口、职责覆盖和验证证据；原授权或能力无法满足时收口 `needs_owner` 并点名缺口 |

## 3. planner 特例

`alignment_native` 是 alignment workflow 默认 planner 入口，消费 `notes/context` 与 `alignment_state`；`planning_context` 才消费 `.planning/phases/<phase>/CONTEXT.md`。按实际 `input_mode` 补齐消费材料。缺 `input_mode`、`phase_goal`、`locked_decisions`、`phase_dir` 等字段时，回 `ops/workflows/alignment/exit.md` §4 重新生成 planner seed。
