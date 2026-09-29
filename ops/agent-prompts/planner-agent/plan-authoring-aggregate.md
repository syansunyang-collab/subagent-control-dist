# planner-agent / plan-authoring / aggregate

> 职责：规定 `planning_pass=aggregate` 的产物结构。
> 真源：dispatch manifest 输出形状
> 读取：不作为入口

## §1. 规划动作

汇总已锁定规格、需求、验收对象和 slice fragments，消解冲突并输出最终 `dispatch_manifest`。主线只保留执行 lane、必要 join 和验收引用；额外审查或规格修订需求回流对应流程，无法归位时返回 `needs_owner`。

## §2. Dispatch Manifest

写入 `notes/manifests/<phase>-dispatch-manifest.yaml`：

```yaml
dispatch_manifest:
  version: 1
  phase_id: <phase>
  trusted_spec_ref: <已审核规格引用>
  acceptance_contract_ref: notes/manifests/<phase>-acceptance-contract.yaml
  acceptance_join_ref: notes/manifests/<phase>-acceptance-join.json
  source_topology_ref: notes/manifests/<phase>-planning-topology.yaml
  source_fragments: []
  waves:
    - wave: 1
      lanes:
        - lane_id: L1
          task: <做什么>
          scope: {read: [], write: []}
          conflict_keys: []
          depends_on: []
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
      serial_lanes:
        - lane_id: L2
          reason: <mechanical_schema.serial_reason_values 中一项>
          evidence: <具体冲突点>
  conflict_resolution: []
  patch_intents: []
  join_gate:
    enter_validation_when: validation_object_lanes_done | all_lanes_done
```

## §3. 收敛

将可并发 lane 列入候选集，由执行期安排具体批次；存在真实写冲突、资源锁或依赖时使用机械闭集中的串行原因并附证据。无法形成一致 manifest 时返回 `needs_owner`。
