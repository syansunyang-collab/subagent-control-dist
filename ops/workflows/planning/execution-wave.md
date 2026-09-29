# planning 执行 wave

> 职责：规定 executor wave 的运行池、join 和失败处理。
> 真源：P6 wave_execution_manifest、运行池、局部 join 和 lane 失败处理规则
> 读取：命中读取

### P6 executor 执行 wave

主代理按 `dispatch_manifest` 的 wave 派执行 lane。派发前先读取 `ops/workflows/planning/agent-dispatch.md` 的 P6 条目确定 role、capability 和 route，再按 P5 seed 与命中 route 构造任务包。

#### P6.1 编译 wave_execution_manifest

进入派发前，主代理从 `dispatch_manifest` 编译 `wave_execution_manifest`，并写入 `notes/manifests/<phase>-wave-<N>-dispatch.yaml`。只有当前 wave 为单 lane 且不并发时可以不落盘；不落盘时必须在 `planning_state.wave_execution_manifest.not_written_reason` 记录原因。本步完成后置 `planning_state.wave_execution_manifest.ready=true`，才可进入 P6.2 派发；该字段属 P6.1 前置，不属 P5。

优先并发执行可独立完成的 lane，主代理结合任务耗时与协作成本确定实际并发量。读取重叠不阻塞；已锁接口依赖不阻塞；`runtime_ready` 只阻塞运行和验收，不阻塞代码、文档、测试草案或补丁意图；共享入口按实际写域选择串行或 `patch_proposal` 与 `merge_lane`。

P6 只认四类硬阻塞：

- `unresolved_hard_dependency`：当前 lane 必须读取另一个 lane 尚未产出的真实文件、数据或运行结果。
- `exclusive_resource_lock`：安装、迁移、全局配置、依赖清单或网络变更等排他资源正在被其他 lane 修改。
- `same_region_direct_write`：两个 lane 需要直接改同一文件的同一区域、同一符号或同一配置项，且不能拆成 patch intent。
- `final_decision_owner_conflict`：两个 lane 都要决定同一最终口径、最终 manifest、最终状态或最终裁决。

```yaml
wave_execution_manifest:
  version: 1
  phase_id: <phase>
  wave: <N>
  group_id: <phase>-wave-<N>
  source_dispatch_manifest_ref: notes/manifests/<phase>-dispatch-manifest.yaml
  capacity_limit: <dispatchable_ready lane 数与当前可用派发 slot 数的较小值>
  split_decision:
    bias: parallel_preferred
    applied: true | false
    not_split_reason: <未拆分的实际原因；已拆分时为 null>
    reason: <一行说明切片或不切片依据>
  mechanical_check:
    ids_checked: true
    dependency_edges_checked: true
    resource_locks_checked: true
    write_ownership_checked: true
    handoff_paths_checked: true
    planning_defect: null | missing_lane_id | duplicate_handoff | impossible_dependency | invalid_resource_lock | missing_write_owner
  join_gate:
    require_all_lanes_consumed: true
    require_all_agents_closed: true
    enter_validation_selection_when: validation_object_lanes_done | all_lanes_done
  lanes:
    - lane_id: <lane>
      dispatch_manifest_ref: notes/manifests/<phase>-dispatch-manifest.yaml
      task: <lane task>
      scope: {read: [], write: []}
      mode: direct_write | patch_proposal | merge_lane | read_only | validation
      dependency_edges: []
      resource_locks: []
      write_ownership:
        direct_paths: []
        shared_paths: []
      validation: {object: <object>, method: <method>, pass_condition: <condition>}
      parallel_policy_basis: ready_if_no_hard_blocker | blocked_by_resource | blocked_by_dependency | merge_required | blocked_by_final_decision
      handoff_file: notes/handoffs/<package_id>.md
      status: pending | running | done | failed | blocked
```

`dispatchable_ready` 只包含同时满足拓扑 ready、P6.2 冲突条件、`dispatch_prepare(action=list)` 中 route/model 可用、且当前派发入口可提交的 lane。`available_dispatch_slots` 取宿主当前可立即提交的可观察容量；Pi AsyncTaskService 未声明数值上限时，按本轮 `dispatchable_ready` 数量计算，不另建线程配置。`capacity_limit=min(dispatchable_ready 数, available_dispatch_slots)`。提交时若入口返回终态失败，该 lane 转运行时 blocked，入口恢复后重新计算并补位。

manifest 必须满足：

- 只读范围重叠不得作为 `not_split_reason`。
- `interface_contract`、已完成 review gate、`soft_order` 不构成并发阻塞。
- dependency 的 `release_gate` 未满足时，只阻塞依赖该上游的 lane。
- 同一共享文件被多个 lane 触碰时，按协作成本选择串行或补丁提案与合并通道，保持直接写域独占。
- `capacity_limit` 按上面的 `dispatchable_ready` 与 `available_dispatch_slots` 计算，表示可用上限，不要求填满。
- `handoff_file`、报告或 SUMMARY 路径互不相同。

#### P6.2 运行池并发派发 lane

允许并发派发的 lane 必须同时满足：

- 本轮至少有两个 `dispatchable_ready` lane。
- `parallel_policy_basis=ready_if_no_hard_blocker`。
- 所选 route 与 model 在 `dispatch_prepare(action=list)` 中为 available，且派发入口当前可提交。
- 没有 `type=hard_output` 且 `resolved=false` 的依赖边。
- 没有未满足的 `release_gate`。
- 没有与 running lane 冲突的 `exclusive=true` 资源锁。
- 没有与 running lane 相同 `owner_region` 的直接写入。
- 共享文件已声明 `patch_intent` 或独立 `merge_lane`。
- 不争夺最终裁决 owner。

派发方式使用运行池：

- 从 `dispatchable_ready` lane 中安排本轮派发，数量不超过 `capacity_limit`。
- 任一 lane 已消费并关闭后，重新计算 ready 集。
- pending lane 的硬依赖、dependency release gate、排他资源锁或运行时派发可用性恢复后，重新计算并立即补位。
- 不得为了等待同 wave 内无依赖 lane 全部结束而停止补位。

每个 lane 任务包必须：

- 使用相同 `concurrency_contract.group_id`。
- 使用不同 `concurrency_contract.lane_id`。
- 写入当前 `planning_wave`。
- 将 `dispatch_manifest_ref`、`lane_id`、`task`、`scope`、`validation`、`lane_execution_mode`、`dependency_edges`、`resource_locks` 和 `write_ownership` 写入 `extensions.capability_contract.executor`。
- 使用独立 `handoff_contract.handoff_file`。
- 任务包不得写入等待策略、固定轮询节奏、回执消费动作或关闭动作。

#### P6.3 局部 join gate

运行池执行期间，主代理按验收对象做局部 join。一个验收对象依赖的 lane 全部满足下列条件后，该验收对象可以进入 P7：

- 相关 lane 都收到 `FINAL_HANDOFF`。
- 相关 lane 已完成目标达成判定。
- 可接受 lane 已消费 handoff 并关闭子代理。
- `wave_execution_manifest.lanes[].status` 已更新为 `done`。

下游 lane 是否解锁只看 dependency 的 `release_gate`：

- `contract_locked`：接口契约已 `locked` 即可解锁。
- `execution_done`：上游 lane 执行目标达成、结果已消费后解锁。
- `validation_passed`：上游验收对象在 P7 通过后解锁。

#### P6.4 lane 失败处理

执行期默认不回 planning。executor 发现 dispatch 文字、步骤、路径或命令存在小偏差时，只要仍是同一 slice、同一授权范围、同一验收对象、同一用户目标，就在当前 lane 内调整并继续执行，最终回执记录 `execution_adjustments`。

任一 lane 返回 `failed`、`partial`、`needs_owner`、scope 越界、字段缺失或目标未达成时：

- 该 lane 关联的验收对象不得进入 P7。
- 不派发依赖该 lane 的后续 wave。
- 已在运行且无冲突的其他 lane 可以自然完成。
- 失败 lane 属于任务包缺字段、上下文缺引用或可补授权时，主代理只补发该 lane 所需字段或权限，不重跑 P5。
- 失败原因指向执行摩擦时，记录到 `execution_adjustments`，当前任务继续。
- 只有当前 lane 无法在授权范围内交付可验收结果，且问题命中目标改变、验收对象改变、scope 必须扩大、同一区域直接写入无法拆分、排他资源不可用或需求规格错误时，才进入 P4，或回 `ops/workflows/alignment/exit.md` §2 的 S2 / S3 修订。
- 修复后只派发未完成或受修订影响的 lane。

规则：

- 派发批次调整在当前 wave 内完成；仅有空余并发容量不触发失败或返回 P4。
- 文件路径相同不直接等于冲突。
- 回执等待和关闭节奏不得替代 `concurrency_contract` 的并发判断。
- executor 不 git commit。
- executor 必须输出 SUMMARY、验证结果和 handoff。
