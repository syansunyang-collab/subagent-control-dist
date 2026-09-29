# Long Task Policy（瘦身版）

> 职责：规定长任务推进、阻塞和终止上报。
> 真源：长任务推进、阻塞讨论和终止上报规则
> 读取：命中读取

命中长任务后读取本文件。

长任务当前值与派发快照的分工见 §3；复用现有 `long_task` 字段。

长任务沿 planning P1 入口启用（见 `ops/workflows/planning/planner-flow.md` §1.5），按 §1 判断是否需要里程碑跟踪。

## §1 触发

任务需要跨里程碑持续推进并跟踪实施尝试、回退时，由主代理按需启用；用户明确指定长任务模式时启用。

单条长命令按宿主能力后台执行，文件数量和所在路径不作为长任务模式的触发条件。

## §2 里程碑结构

将任务拆成里程碑，每个含 4 字段：

| 字段 | 要求 |
| --- | --- |
| `name` | 描述性名称，不使用 M-编号 |
| `deliverable` | 本段交付 |
| `verify_cmd` | 验收命令或可替代检查；命令不可执行而需任务外主体参与时，按 `ops/policies/test-tooling-governance.md` §4 点名验收主体和审查对象 |
| `checkpoint` | 不通过不前进 |

命中 planning 时，里程碑 `verify_cmd` 只是里程碑级检查，正式验收仍由 planning P7 的 Acceptance Contract 决定（`ops/workflows/planning/validation-dispatch.md`）；两者不互相替代，P7 结论优先。

里程碑顺序与交付范围由 `planning_state.planning_topology_ref`、`dispatch_manifest_ref` 指向的拓扑和执行清单承载；验证安排由 `acceptance_contract_ref` 指向的验收合同承载。当前里程碑记录在 `planning_state.long_task.milestone`，完成证据由 `planning_state.validation_refs` 引用。`ROADMAP.md` 的当前目标、关联 surface 和退出条件按 `ops/policies/state.md` 更新。

## §3 里程碑级别计数器

每个里程碑维护以下 4 项运行状态，当前值真源为 `planning_state.long_task`。派发时复制当次取值到 `task_package.extensions.long_task`，作为该次执行快照；后续变化更新 `planning_state.long_task`。

| 字段 | 含义 | 重置时机 |
| --- | --- | --- |
| `attempt_id` | 当前实施尝试编号（首次=1，每次回退后 +1） | 进入下一里程碑清零为 1 |
| `rollback_count` | 本里程碑被回退次数（0 起算） | 进入下一里程碑清零 |
| `verify_round_in_attempt` | 本次 attempt 内 verify 已跑轮数（0 起算） | 每次 `attempt_id += 1` 时清零；进入下一里程碑清零 |
| `push_through_active` | 当前里程碑是否启用 push_through | 进入下一里程碑清零；用户主动取消时清零 |

派发给子代理时，里程碑字段写入：

```yaml
task_package:
  extensions:
    capability_contract: <按选中能力填写；无则 null>
    long_task:
      milestone: <里程碑名>
      attempt_id: <正整数>
      rollback_count: <非负整数>
      verify_round_in_attempt: <非负整数>
      push_through_active: true | false
```

### verify 轮次上限

- `push_through_active = false`（默认）：上限 = 2
- `push_through_active = true`：上限 = 3

### push_through 跨里程碑不持续

- 每个里程碑首次进入 `push_through_active = false`
- 用户在某里程碑启用 push_through 仅对当前生效；下一里程碑必须重新询问
- 同一里程碑内 push_through 跨多次 attempt 持续（`attempt_id += 1` 不重置 `push_through_active`）
- 用户在 push_through 期间要求取消 push_through → 立即清零 `push_through_active` 并重置当前 attempt 的 `verify_round_in_attempt`

## §4 连续推进硬规则

进入长任务后，同一轮内持续执行直到命中终止条件。**不得在里程碑之间输出"等确认"/"准备进入下一步"/"先总结一下"后停住**。

## §5 终止条件（a-f）

允许停止的条件：

| 代码 | 条件 |
| --- | --- |
| a | 本次实施编排无剩余工作，`planning_state.state=complete`；工程里程碑满足 `ROADMAP.md` 当前 milestone 的退出条件并记为 `closed` |
| b | 某里程碑 `rollback_count >= 2` |
| c | `verify_round_in_attempt` 达上限（普通 2 / push_through 3），未进入阻塞讨论、主代理判定不回退 |
| c' | 阻塞讨论后仍 fail，或讨论产出权衡 / 无解 |
| d | 子代理重试耗尽且缺口无法由主代理当轮直接修复 |
| e | 遇到不可逆 / 破坏性操作需用户授权 |
| f | 用户主动中断或新指令 |

### 优先级

命中即停，按顺序判定：

```
e/f → b → c → c' → d → a
```

b 与 c 同时可命中时 **b 优先**（rollback 已穷尽时不再消耗 verify 轮次）。

## §6 里程碑原子闭环

每个里程碑按顺序执行：

1. 执行里程碑内容（主代理做核心调度；辅助任务是否派子代理取决于当前线程授权摘要）
2. 跑 `verify_cmd` 或可替代检查，保留完整输出
3. 该次检查结束后立即 `verify_round_in_attempt += 1`
4. 失败处理：
   - `< 上限`：修复并重跑（回 2）
   - `≥ 上限`：主代理判定回退或终止
     - 回退：`rollback_count += 1`，`attempt_id += 1`，`verify_round_in_attempt = 0`；若 `rollback_count >= 2` → 触发 b（优先于 c）
     - 不回退：触发 c
5. 通过后的业务记录与工程状态更新按 `ops/policies/state.md` 执行。
6. 有下一里程碑 → 更新当前里程碑并继续步骤 1；无下一项 → 终止条件 a

步骤 5 和 6 之间**不得交权**。

## §7 终止上报

触发 c 或 c' 时，说明当前卡点、已尝试的方案及证据、仍需用户决定的取舍。按实际内容组织报告，引用已有结果；缺少事实时如实说明，不为固定段数或字段补造材料。

结合当前阻塞与 `push_through_active` 状态，只提供可行的选项及其后续动作和风险：

| 触发 | `push_through_active = false` | `push_through_active = true` |
| --- | --- | --- |
| c | 启用 push_through 续 1 轮 / 回退里程碑改方案 / 跳过本里程碑并记录确认 / 接管 / 进入阻塞讨论 | 进入阻塞讨论 / 回退里程碑改方案 / 跳过本里程碑并记录确认 / 接管 / 废弃长任务 |
| c' | 启用 push_through 后按讨论结论重审 / 回退里程碑改方案 / 跳过本里程碑并记录确认 / 接管 / 废弃长任务 | 取消 push_through 后重审 / 回退里程碑改方案 / 跳过本里程碑并记录确认 / 接管 / 废弃长任务 |

跳过决定的确认来源写入 `planning_state.user_confirmation.evidence`，受影响范围按既有 alignment／planning 修订流程更新。跳过项保留取消决定，与验收通过证据分开记录。

用户可以提出表外方案，按实际授权与可行性判断。

## §8 进度保护

- 验收通过才标记里程碑完成
- 未完成不得说完成
- 遇阻塞先诊断；诊断无解才上报
- 不为推进而跳过验证
- 长任务中的状态更新只服务当前推进，**不把 `STATUS.md` 当日志**
