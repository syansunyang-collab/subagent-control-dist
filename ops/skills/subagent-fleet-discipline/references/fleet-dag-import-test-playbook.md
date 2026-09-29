# Fleet DAG 自动驾驶剧本

> 职责：规定有依赖、自动 reducer 或并发节流的舰队如何交给仓内 Fleet Scheduler 持续推进。
> 真源：manifest 字段与校验在 `ops/tools/fleet_manifest_check.mjs`；运行状态机在 `ops/tools/fleet_scheduler.mjs`。
> 读取：命中读取

## 入场边界

本剧本只承接不属于 planning P6 `wave_execution_manifest` 的子代理舰队。planning lane 的运行池、`release_gate` 和补位继续以 `ops/workflows/planning/execution-wave.md` 为唯一真源，不编译为 Fleet Manifest。

同波节点互不依赖且无需运行期节流时，继续用 seed JSON 数组直接交给 `dispatch_prepare.mjs`。命中以下任一条件时使用 Fleet DAG：

- 下游必须等上游任务产物。
- explorer / 审查波完成后需要自动启动 reducer。
- 运行中节点需要写域互斥。
- 需要限制总并发、单轮提交量或角色并发。

Fleet Scheduler 只持有 DAG 运行状态。每个节点仍由 `dispatch_prepare.mjs` 构包并交给 AsyncTaskService 执行；任务终态、completion notice 和正式产物路径仍以 AsyncTaskService 为准。

## Manifest

字段、闭集、默认值和当前版本由 checker 唯一生成：

```powershell
node ops/tools/fleet_manifest_check.mjs --schema --format json
```

可复制的有效样例也由同一工具生成，不在剧本手抄字段副本：

```powershell
node ops/tools/fleet_manifest_check.mjs --example --format json
```

行为解释：普通节点使用默认 success-only 依赖，只在直接上游到 `done` 后放行。归并节点选择 schema 中的 all-settled 依赖后，等待全部直接上游到终态，再把依赖结果索引和可用正式产物追加到下游 seed。

WHEN: 节点 `scope.read` 含控制仓外绝对路径。
MUST: `target_isolation` 使用 checker schema 输出的只读枚举值；报告仍写控制仓声明路径。
BLOCK IF: 外仓节点请求写隔离或未声明合法隔离；由 checker 拒绝 manifest，修正后重试。

机制事实：success-only 下游声明的正式产物缺失时，scheduler 不提交空输入，把下游转为 `needs_parent_review`。all-settled 下游把缺产物记录进依赖结果索引，继续提交 reducer；缺失本身是归并证据。

WHEN: success-only 节点因 `contract_state=dependency_artifact_missing` 等待父级裁决。
ACTOR: 主代理。
MUST: 按下表选择恰好一个出口，并把证据路径写入 `fleet_scheduler.mjs review --evidence`。

| 条件 | 裁决与后继动作 |
| --- | --- |
| 可恢复声明产物 | 对缺产物的原上游执行 `review --requeue` 并恢复 run；上游重新到 `done` 且正式产物存在后，对当前下游执行 `review --requeue` 并再次恢复 run |
| 产物不可恢复 | 执行 `review --block` |
| 现有证据已完成下游业务目标 | 执行 `review --accept` |

success-only 链中的 `needs_parent_review` 只占住依赖门；父级未裁决前不把它当成功或失败。all-settled 归并链不在上游逐节点开门，scheduler 将上游原始执行态、业务态、产物态和错误摘要写入依赖结果索引。

声明 `dependency_artifacts` 的下游允许在 manifest 中保留空 `scope.read`。checker 只用仓内探针完成 route 静态展开；scheduler 提交下游前必须用真实依赖产物替换空输入。

## 启动

先做静态检查：

```powershell
node ops/tools/fleet_manifest_check.mjs --manifest tmp/fleet/<run>.json --format json
```

通过后启动后台自动驾驶：

```powershell
node ops/tools/fleet_scheduler.mjs run --manifest tmp/fleet/<run>.json --run-id <run> --format json
# 整批统一上下文模式时，在首次 run/start 追加（续跑沿用启动时的值）：
# --async-context-mode isolated
```

`run` 创建 run state 并启动隐藏后台 driver，命令立即返回。driver 循环执行：刷新 completion notice、提交 ready 节点、等待任一活动节点完成、释放依赖和补充并发槽位。全部节点终态后退出；只剩未被 all-settled 下游消费的父级裁决门时以 `needs_parent_review` 退出。

需要在真实提交前看准入结果时：

```powershell
node ops/tools/fleet_scheduler.mjs start --manifest tmp/fleet/<run>.json --run-id <run> --format json
node ops/tools/fleet_scheduler.mjs tick --run-id <run> --dry-run --format json
node ops/tools/fleet_scheduler.mjs run --run-id <run> --format json
```

## 观察

```powershell
node ops/tools/fleet_scheduler.mjs status --run-id <run> --summary --format json
```

节点任务使用公共 Async task root，并以 `run_id` 作为 `batch_id`，因此 Agent Panel 直接按 run 分组展示模型、token、工具调用和进展。Fleet Scheduler 的 `state.json` 只承载 DAG 节点、依赖、预算、写锁和 review 决策，不复制 Async 任务正文或完整产物。

## 例外裁决与恢复

未被 all-settled 下游消费的普通终态任务，或 reducer 发生运输失败、结构损坏和 `needs_owner` 时，先按 `ops/policies/runtime-tools.md` 核对正式产物与副作用，再记录裁决：

```powershell
node ops/tools/fleet_scheduler.mjs review --run-id <run> --node-id <node> --accept --evidence <repo-relative-evidence> --format json
node ops/tools/fleet_scheduler.mjs run --run-id <run> --format json
```

`--block` 永久阻断依赖节点；`--requeue` 只重置已经终止的节点。driver 崩溃或 Codex 会话结束后，同一条 `run --run-id` 命令从 `state.json` 恢复；已提交 Async 任务不重复提交。

Acceptance Contract 验收 reducer 不走父级裁决门。reducer report 的消费与例外出口只看 `ops/workflows/planning/validation-dispatch.md`。

## 验收

至少覆盖以下用例：

| 用例 | 通过条件 |
| --- | --- |
| 静态图 | 环、无效依赖、同层写冲突和非法 `dependency_artifacts` 被拒绝 |
| 并发层 | 无依赖节点按 budget 并发提交 |
| success-only 依赖层 | 上游未 `done` 时下游不提交 |
| 自动 reducer | 上游全部到终态后无需主代理逐份裁决；依赖结果索引与可用 report 自动进入 reducer `scope.read` |
| all-settled 缺口 | `partial / failed / cancelled / missing artifact` 进入依赖结果索引，reducer 继续启动 |
| acceptance reducer | 结构化 disposition 覆盖全部 acceptance id；`pass/rework` 由 checker 消费，`needs_owner` 才停主代理 |
| 定向复验 | 第 1 轮 `rework` 只生成受影响 lane、确认项和邻接回归；第 2 轮仍失败不生成第 3 轮 |
| review gate | 未被 all-settled 消费的 `needs_parent_review` 不放行；accept 后恢复，block 后阻断，requeue 后重跑原节点 |
| 崩溃恢复 | driver 退出后 `run --run-id` 不重复提交已在飞或已完成节点 |
| UI | 当前 run 节点在默认 Cockpit 中按 `batch_id=run_id` 分组 |

机械回归：

```powershell
node ops/tools/fleet_manifest_check.mjs --self-test --format json
node ops/tools/fleet_scheduler.mjs self-test --format json
python -B ops/tools/acceptance_contract_check.py --self-test --format json
node --check ops/tools/fleet_manifest_check.mjs ops/tools/fleet_scheduler.mjs
```

普通无合同舰队仍由主代理消费证据归并。Acceptance Contract 舰队的裁决消费边界只看 `ops/workflows/planning/validation-dispatch.md`。driver 只负责依赖等待、产物路径注入、槽位补充和下游提交。
