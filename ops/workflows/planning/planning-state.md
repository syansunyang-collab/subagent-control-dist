# planning 状态模型

> 职责：规定 planning 状态字段。
> 真源：planning_state、dispatch_manifest、wave_execution_manifest、execute_gate、validation_selection 和 validation_refs 字段结构
> 读取：命中读取

## 1. 状态模型

planning 状态写入 alignment context 或独立 handoff 小文件，字段如下：

```yaml
planning_state:
  version: 1
  phase_id: <phase>
  state: orchestration_needed | dispatch_ready | user_confirmed | revision_needed | execute_allowed | executing | validating | complete | blocked
  source_alignment_ref: notes/context/<task>-alignment.md
  trusted_spec_ref: <已审核规格引用>
  planner_seed_ref: <alignment_state.next_action.dispatch_seed 来源>
  planning_topology_ref: notes/manifests/<phase>-planning-topology.yaml | null
  interface_contracts_ref: notes/manifests/<phase>-interface-contracts.yaml | null
  acceptance_contract_ref: notes/manifests/<phase>-acceptance-contract.yaml | null
  acceptance_join_ref: notes/manifests/<phase>-acceptance-join.json | null
  planning_fragments:
    - .planning/phases/<phase>/fragments/<slice_id>.md
  dispatch_manifest_ref: notes/manifests/<phase>-dispatch-manifest.yaml | null
  p1:
    mode: topology_slice_aggregate
    parallelism_contract_ref: notes/manifests/<phase>-planning-topology.yaml#parallelism_contract | null
    acceptance_contract_ready: true | false
    acceptance_join_passed: true | false
    dispatch_manifest_ready: true | false
  review_policy:
    plan_review_in_workflow: false
    explicit_user_manifest_review_ref: null | <用户明确点名审查的证据>
  semantic_review:
    status: pending | pass | fail
    reviewer: main_agent
    trusted_spec_ref: <已审核规格引用>
    acceptance_contract_ref: notes/manifests/<phase>-acceptance-contract.yaml
    acceptance_join_ref: notes/manifests/<phase>-acceptance-join.json
    dispatch_manifest_ref: notes/manifests/<phase>-dispatch-manifest.yaml
    coverage_checks:
      locked_spec_coverage: pass | fail
      fragment_coverage: pass | fail
      interface_contract_compatibility: pass | fail
      validation_object_coverage: pass | fail
      acceptance_contract_coverage: pass | fail
      acceptance_dispatch_traceability: pass | fail
      deviations: []
    manifest_revision: <被审 dispatch_manifest 的 revision，复制 planning_manifest_check.py --review-binding 输出>
    semantic_verdict: <基于 coverage_checks 的规格覆盖与偏差结论>
    reviewed_at: <ISO-8601 UTC>
  manifest_freeze:
    status: pending | frozen
    phase_id: <phase>
    manifest_revision: <正整数；等于 semantic_review.manifest_revision，复制 --review-binding 输出>
    frozen_at: <ISO-8601 UTC>
  p5:
    compile_mode: dispatch_manifest_mechanical_check
    dispatch_manifest_ref: notes/manifests/<phase>-dispatch-manifest.yaml | null
    wave_execution_manifest_ref: notes/manifests/<phase>-wave-<N>-dispatch.yaml | null
    semantic_review_allowed: false
  p6:
    pool_mode: dispatchable_ready_lanes
    capacity_limit: <dispatchable_ready lane 数与当前可用派发 slot 数的较小值>
    blocked_only_by:
      - unresolved_hard_dependency
      - exclusive_resource_lock
      - same_region_direct_write
      - final_decision_owner_conflict
      - route_or_model_unavailable
      - dispatch_channel_unavailable
    execution_adjustments_ref: notes/manifests/<phase>-execution-adjustments.yaml | null
  user_confirmation:
    required: true | false
    status: pending | confirmed | revision_requested | not_needed
    evidence: <用户确认摘要或 reason>
  revision:
    round: <非负整数>
    reason: p5_mechanical_gap | user_revision | acceptance_contract_gap | validation_traceability_gap | result_gap | validation_failure | concurrency_failure | none
  long_task:
    active: true | false
    milestone: <当前里程碑名> | null
    attempt_id: <正整数> | null
    rollback_count: <非负整数> | null
    verify_round_in_attempt: <非负整数> | null
    push_through_active: true | false
  wave_execution_manifest:
    ref: notes/manifests/<phase>-wave-<N>-dispatch.yaml | null
    ready: true | false
    not_written_reason: null | single_lane
  execute_gate:
    status: blocked | allowed
    reason: <原因>
    trusted_spec_present: true | false
    dispatch_manifest_ready: true | false
    acceptance_contract_ready: true | false
    acceptance_join_passed: true | false
    dispatch_manifest_ref: notes/manifests/<phase>-dispatch-manifest.yaml | null
    change_base: <放行时 git rev-parse HEAD 的提交> | null
    user_confirmation: confirmed | not_needed | pending
    wave: <下一执行 wave>
    wave_selected: true | false
    mechanical_consistency_checked: true | false
    lane_fields_ready: true | false
    validation_map_ready: true | false
    dependency_edges_checked: true | false
    resource_locks_checked: true | false
    write_ownership_checked: true | false
    serial_reasons_checked: true | false
    runtime_basis_available: true | false | not_needed
    network_basis_available: true | false | not_needed
  validation_selection:
    source_wave: <N> | null
    acceptance_contract_ref: notes/manifests/<phase>-acceptance-contract.yaml
    dispatch_manifest_ref: notes/manifests/<phase>-dispatch-manifest.yaml
    review_round: 1 | 2
    fleet_manifest_ref: notes/manifests/<phase>-acceptance-r<round>-fleet.json
    fleet_run_id: <run-id> | null
    reducer_report_ref: <多 item 为 reducer report；单 item 为经 --leaf-decision-report 消费的叶子报告> | null
    disposition: pending | pass | rework | needs_owner
    followup_manifest_ref: notes/manifests/<phase>-acceptance-r2-fleet.json | null
    compiler_check: pass | fail
  validation_refs:
    - <最终 acceptance decision 报告路径：多 item 为 reducer report，单 item 为叶子报告>
    - <发生返工时的定向 executor SUMMARY 路径>
```

`planning_state.state=execute_allowed` 是进入 executor 的唯一 planning 放行状态。只有 `execute_gate.status=allowed` 时，才允许把 `dispatch_manifest` 编译成 executor 任务包。`state` 九值的迁移规则（事件 → 写者 → 新值）见 `ops/workflows/planning/state-transition.md`。

`semantic_review` 只由 P1C handoff 消费后的主代理写入；六项 `coverage_checks` 全为 `pass` 且 `deviations=[]` 时才允许 `status=pass`。Acceptance Contract 两项只复制 P1J/dispatch join 的机械结论，不由主代理重新设计验收。`manifest_revision`、`phase_id` 只复制 `planning_manifest_check.py --review-binding` 的对应输出；planning 全链不算、不存、不比任何 hash，`semantic_review` / `manifest_freeze` 出现名字含 hash / sha 的键即 `--review-state` 报 `hash_key_forbidden`。绑定单位是 manifest revision：planner 每次改写 manifest 必须把 `dispatch_manifest.revision` +1，冻结后 revision 变化即 `--review-state` 失败并回 P4。`manifest_freeze` 同时绑定 `phase_id` 与 `manifest_revision`。

`review_policy.plan_review_in_workflow` 固定为 `false`。planning 状态不设置计划审查触发字段。

`validation_selection` 只记录 P7 编译与 disposition（多 item 来自 reducer，单 item 来自 `--leaf-decision-report` 机械转换），不保存叶子报告全文，也不替代 decision 报告。`validation_refs` 记录 decision 报告、必要 follow-up reducer 和最终执行证据。
