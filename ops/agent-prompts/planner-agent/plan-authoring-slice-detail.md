# planner-agent / plan-authoring / slice-detail

> 职责：规定 `planning_pass=slice_detail` 的产物结构。
> 真源：slice fragment 与 producer contract 输出形状
> 读取：不作为入口

## §1. 规划动作

只细化任务包指定的 `slice_id`，保持 topology 已确定的切片边界，并把 Acceptance Contract 的 requirement refs 复制到 fragment validation。

`final_ready=true` 表示依赖契约已锁、执行动作、写域和验证已完整到可派发；实现完成、测试通过和 candidate adopt 由后续状态表达。producer lane 定义完整时标 `final_ready=true`。

`contract_promotions[].to_stability=locked` 冻结消费者可依赖的规划接口；依据只取锁定规格、上游契约、当前源码 seam 与 Acceptance Contract。实现 pass、rework 或 needs_owner 仍由执行与验证阶段的 focused / Commit / Release Gate 裁决。

## §2. Slice Fragment

写入 `.planning/phases/<phase>/fragments/<slice_id>.md`：

```yaml
slice_fragment:
  slice_id: S1
  prep_ready: true
  final_ready: true | false
  blocked_by_contracts: []
  task: <执行动作>
  scope: {read: [], write: []}
  conflict_keys: []
  dependency_edges:
    - type: <mechanical_schema.dependency_type_values 中一项>
      release_gate: <mechanical_schema.release_gate_values 中一项>
  resource_locks: []
  write_ownership: {direct_paths: [], shared_paths: []}
  validation:
    object: <object>
    method: <method>
    pass_condition: <condition>
    requirement_refs: [<Acceptance Contract requirement id>]
  mode: <mechanical_schema.dispatch_mode_values 中一项>
  parallel_policy_basis: ready_if_no_hard_blocker | blocked_by_resource | blocked_by_dependency | merge_required | blocked_by_final_decision
```

## §3. Producer Contract

当前 slice 负责 producer contract 时，同时写：

```yaml
contract_fragment:
  - contract_id: <id>
    stability_after: locked
    contract: {}
    evidence: []
contract_promotions:
  - contract_id: <id>
    to_stability: locked
    basis: []
    consumer_slices: []
    promotion_target_manifest: notes/manifests/<phase>-interface-contracts.yaml
    manifest_update_owner: main_agent_after_handoff_consumption
```
