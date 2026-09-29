# planning 状态推进

> 职责：规定 planning 验收后的状态推进、输出和失败回流。
> 真源：P8 状态推进、输出路径和失败条件
> 读取：命中读取

## 1. planning_state.state 迁移规则

`state` 九值只由主代理写入，迁移闭集如下；未列出的跳转视为非法：

| 事件 | 迁移 |
| --- | --- |
| P0 通过，进入 P1 | （初始）→ `orchestration_needed` |
| P1C dispatch_manifest 产出并通过机械检查 | `orchestration_needed` → `dispatch_ready` |
| P3 用户确认（或满足跳过条件） | `dispatch_ready` → `user_confirmed` |
| P3 用户要求修订 / P5 缺口 / 验收 traceability 失败回 P4 | `dispatch_ready` \| `user_confirmed` \| `executing` \| `validating` → `revision_needed` |
| P4 修订完成，manifest 重新通过 P1C 检查 | `revision_needed` → `dispatch_ready` |
| P5 execute_gate.status=allowed | `user_confirmed` → `execute_allowed` |
| P6 首个 lane 派发 | `execute_allowed` → `executing` |
| P6.3 局部 join 满足，进入 P7 | `executing` → `validating` |
| P7 disposition=`rework`，轮次预算允许（`ops/workflows/planning/validation-dispatch.md`） | 保持 `validating`，运行 checker 生成的下一轮定向返工复验 DAG |
| P7 action=`repair_reports` | 保持 `validating`，producer 补回执后重新合成，保留有效证据 |
| P8 disposition=`pass` 且无剩余 wave | `validating` → `complete`；non_blocking 残余随报告交付 |
| P7 action=`escalate`、验收预算用尽、用户暂停或不可解阻塞 | （任意）→ `blocked`；解除后回到进入 blocked 前的状态 |

## 2. P8 状态推进

通过验收后：

- 验收后的业务记录和工程状态按 `ops/policies/state.md` 更新；长任务当前值保存在 `planning_state.long_task`，派发快照按 `ops/policies/long-task.md` §3 生成。
- 必要的长期证据写入对应 `notes/` 子目录。
- 回到 P5 执行下一 wave，或结束 planning workflow。

步骤之间不得用“准备进入下一步”作为终止输出。只有命中用户确认门、阻塞、终止条件或全部完成时才停。

---

## 3. 阶段关系和质量门

| 质量机制 | 本工作流执行方式 |
| --- | --- |
| 执行编排 | P1A 拓扑、P1B 并发细化、P1C 汇总冲突并输出 `dispatch_manifest` |
| 用户确认 | P3 选项选择「重新对齐目标」，或修订改变 locked decision 时回 `ops/workflows/alignment/exit.md` §2 的 S2 / S3 修订 |
| 缺口回流 | P4 revision 输入保留用户意见、P5 缺口、执行或验收失败来源 |
| 执行派发 | P6 executor 按资源锁和 ready queue 执行 lane |
| 验收分流 | P7 记录 Acceptance Contract 编译 manifest、Reducer disposition 与必要 follow-up DAG |
| 状态推进 | P8 状态推进或回流 |

---

## 4. 输出和状态文件

推荐路径：

```text
notes/manifests/<phase>-dispatch-manifest.yaml
notes/manifests/<phase>-acceptance-contract.yaml
notes/manifests/<phase>-acceptance-join.json
notes/manifests/<phase>-acceptance-r<round>-fleet.json
notes/manifests/<phase>-wave-<N>-dispatch.yaml
.planning/phases/<phase>/<phase>-<lane_id>-SUMMARY.md
notes/handoffs/<planning-package>.md
notes/handoffs/<planning-package>.progress.yaml
notes/context/<task>-alignment.md
```

`planning_state` 可以写入：

- `notes/context/<task>-alignment.md` 的 `Planning State` 段。
- 或 `notes/handoffs/<task>-planning-state.yaml`。

同一任务中只选一种主状态路径，避免双状态系统。

---

## 5. 失败条件

前序与专项失败按一跳索引回流，不在此复抄：

- P0、P1、P3、P4：见 `ops/workflows/planning/planner-flow.md` 对应阶段小节；P6 lane 失败与需回 planning 的缺口：见 `ops/workflows/planning/execution-wave.md` P6.4。
- P5：见 `ops/workflows/planning/execution-gate.md`「执行准入失败出口」。
- P7：见 `ops/workflows/planning/validation-dispatch.md` §4。

本文件只保留 P8 状态推进独有失败：

| 失败 | 回退 |
| --- | --- |
| `planning_state.state` 发生 §1 闭集外取值或非法跳转 | 停止推进，恢复到跳转前的合法状态后按事件来源回流 |
