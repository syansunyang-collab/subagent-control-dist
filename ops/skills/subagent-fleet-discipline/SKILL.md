---
name: subagent-fleet-discipline
layer: orchestration
domain: project-orchestration
capability_group: subagent-fleet-discipline
portability: repo-bound
description: Use when dispatching two or more subagents for parallel work — batch edits, fan-out investigation, parallel audits, multi-slice migration, or any task splittable into independent slices. 触发：派多个子代理、并发处理、并发了解、分头看、多路审计、并行排查、fan out、舰队作业、批量迁移整修、多个方向同时看、把这个大扫描切一下分头派、这个任务怎么编排舰队、怎么切片编排. Covers when to scale out, compile a goal into bounded slices, layer read scopes, plan reducer waves, batch dispatch through dispatch_prepare, harvest completion events, and recover terminal failures. Not for a single small subagent, ordinary route lookup, short self work, local command-level parallelism that is not subagent fan-out, or user-forbidden delegation.
---

# subagent-fleet-discipline

> 职责：教主代理完成多子代理并发作业的放量判定、切片、批量派发、并行推进、收割核验和审计收口。
> 真源：本技能入口负责判定与硬线；切片方法论、批量剧本、收割审计细则在本技能 references。派发工具只负责构包和启动，不承载舰队纪律语义。
> 读取：命中读取

## 核心口径

以下口径用于切片与消费：

1. 经 `dispatch_prepare.mjs` 构包、由 AsyncTaskService 内部适配器提交的任务是独立后台进程，不占会话线程池；任务可拆就放量并发。
2. seed 写成 JSON 数组即一次批量构包派发，可混用不同 route；批量结果带 `batch_id`、`committed_task_ids` 与 `failed_seed_indexes`，失败切片单独重发。
3. 直接批次与 Fleet DAG 的完整分流条件只在 `ops/skills/subagent-fleet-discipline/references/fleet-dag-import-test-playbook.md`「入场边界」维护；命中 Fleet DAG 后由 Fleet Scheduler 自动推进完整节点图，节点构包仍只走 `dispatch_prepare.mjs`。
4. 单发子代理产能有界：超规格的大包会被抽样、略读变相绕过，回执完整是假象。宁多发小切片，不发大包。
5. 普通探索可按需提前交付已核实的局部发现；阶段消费不替代本波全量归并或正式验收。

舰队作业的主要事故来自三类：任务书没写死、并发写同一文件、把回执当磁盘事实。子代理是冷上下文执行者，只知道任务包里写了什么。

## 入场判定

WHEN: 任务可拆成两个以上切片，或准备一次派出两个以上子代理。
MUST: 先形成 `FLEET_PLAN`，再构包。
OUTPUT:

```yaml
FLEET_PLAN:
  goal:
  batches:
    - id:
      route:
      read_scope_layers:   # {entry, index, deep:[{path,when}], deferred}；旧 read_scope（等价全 entry）兼容保留
      target_isolation:    # read_only | writable（默认 writable）；跨仓只读扫描填 read_only
      write_scope:
      conflict_keys:
      depends_on:
      validation:
  reducer:                 # explorer/审查类 ≥3 路时必填
    id:
    depends_on:            # 第一波全部 explorer/审查节点
    dependency_artifacts:  # [report]；由 scheduler 在放行时注入正式路径
    route:
    input_reports:         # 直接批量模式由主代理填写；Fleet DAG 模式由 scheduler 注入
  shared_files:
  serial_work:
  audit_plan:
  final_validation:
```

`route` 写该切片使用的 route_id，角色即档位，按判断量选档不按体量选档。其余字段口径：`write_scope` 是该批唯一允许写入面，并发批次按此判冲突；`shared_files` 多批可读、任何批不得写；`serial_work` 收敛共享写文件与契约层、状态层、地图层的串行批或主代理自留活；`audit_plan` 与 `final_validation` 是收口承诺，构包前就写好。`read_scope_layers` / `target_isolation` 的确定填法与 `reducer` 段配置见下方路由表。

BLOCK IF:

- 任意两个并发批次的 `write_scope` 有交集。出口：重切、共享文件转 `serial_work`，或主代理亲手处理。
- 全部批次不加判断地使用同一个高档角色。出口：按分档表逐批重选。
- 语义审查把多个独立问题塞进同一切片。出口：按问题边界重切；同一问题的完整目标文件仍保留在同一任务，材料承载交给 `ops/protocols/subagent-information-injection.md` 的 `semantic_review_v2`。
- explorer / 审查类切片 ≥3 路却未规划 reducer 节点。出口：加 reducer 节点，或路数降到 <3。
- 对运行中任务做同步阻塞等待。出口：批量派发后转身干 `serial_work` 或下一波准备。

需要观察任务状态或恢复异常任务时，读取 `ops/policies/runtime-tools.md`。

## 任务书底线

每个切片的任务包写死四件套：先读清单；必修与必留清单（字段名、枚举、标题锚点、机器读取块逐项列为必留）；验收命令（子代理自己跑到通过，修不了回滚本批文件报告 skipped）；回报格式（每文件改动点、skipped、验收输出末行）。再写三条边界：不提交、不动清单外文件、不创建 / 删除 / 重命名文件，除非该批任务本身就是。

工具输出不完整时先补任务定义，不把不清楚的任务硬派出去。

## 路由

| 场景 | 读取 |
| --- | --- |
| 从 goal 编译出切片：决策树、read_scope 分层、拒绝条件、drill walkthrough | `ops/skills/subagent-fleet-discipline/references/parallel-slicing.md` |
| 六类标准切片模板（workflow seam 8 路、rule audit、failure review 等）与 reducer 配置 | `ops/skills/subagent-fleet-discipline/references/slice-patterns.md` |
| explorer / 审查 ≥3 路的归并波与阶段消费：普通证据归并或 Acceptance Contract 裁决 | `ops/skills/subagent-fleet-discipline/references/reducer-wave.md` |
| 批量构包、批量派发、partial 处理与事件驱动收割的命令级操作 | `ops/skills/subagent-fleet-discipline/references/batch-dispatch-playbook.md` |
| 跨波依赖、自动 reducer、运行期写锁或并发节流的 manifest 与自动驾驶 | `ops/skills/subagent-fleet-discipline/references/fleet-dag-import-test-playbook.md` |
| 收割核验、批次回滚、互补审计、常见事故 | `ops/skills/subagent-fleet-discipline/references/harvest-and-audit.md` |

## 收口承诺

全部切片收割后，主代理结合实际修改和已有证据确认目标达成并按批提交。只测试验证本次修改部分，复用已有有效结果；提交信息与证据保持一致。
