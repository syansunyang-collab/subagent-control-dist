# planner-agent / plan-authoring / topology

> 职责：规定 `planning_pass=topology` 的产物结构。
> 真源：topology 与 interface contracts 输出形状
> 读取：不作为入口

## §1. 规划动作

先定 `execution_mode`，再输出 planning topology、切片清单、接口契约骨架和 `parallelism_contract`；`fragments_inline=true` 时同一回执连各切片 fragment 一起写出。

- `single_soldier`：写域由一个执行者独占，且拆分不会带来可并行工作或独立接口取证。只出一个切片，fragment 内联，执行期由一条 lane 完成规格，P7 独立验收。
- `sliced`：存在互不冲突、可独立验收的写域或必须先锁定的接口依赖。切片按写域与依赖拆；各 fragment 已能在同一计划中完整表达时内联，需要独立取证或分头细化时进入 slice-detail。

## §2. Topology

写入 `notes/manifests/<phase>-planning-topology.yaml`：

```yaml
phase_id: <phase>
trusted_spec_ref: <已审核规格引用>
execution_mode: single_soldier | sliced
fragments_inline: true | false
planning_slices:
  - slice_id: S1
    trusted_spec_refs: []
    validation_objects: {}
    tasks: []
    requires_contracts: []
    producer_contracts: []
    conflict_keys: []
    dependency_edges: []
    resource_locks: []
    write_ownership:
      direct_paths: []
      shared_paths: []
parallelism_contract:
  candidate_lanes:
    - lane_id: L1
      slice_ids: [S1]
      conflict_keys: []
      blocked_by: null
  serial_lanes:
    - lane_id: L2
      blocked_by: <mechanical_schema.serial_reason_values 中一项>
      evidence: <具体证据>
slice_parallelism:
  max_lanes: <规划上无硬阻塞或写冲突的候选并发 lane 数；执行期 capacity 再与可用派发通道取较小值>
  ready_order: []
```

## §3. Interface Contracts

把接口契约写入 `notes/manifests/<phase>-interface-contracts.yaml`。每项包含 `contract_id / producer_slice / consumer_slices / kind / contract / stability / required_by_slices / promoted_by / promoted_at`；`kind` 与 `stability` 分别取 `mechanical_schema.interface_contract_kind_values` 和 `mechanical_schema.interface_contract_stability_values`。
