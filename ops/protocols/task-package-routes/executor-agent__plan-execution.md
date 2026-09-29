# executor-agent / plan-execution 派发规范

> 职责：规定 executor-agent / plan-execution 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：`dispatch_manifest` 已通过 P5 机械准入，需要执行指定 wave lane。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架。

### 固定包头

```yaml task_package_agent
agent:
  role: executor-agent
  runtime_role: executor-agent
  capability:
    name: plan-execution
    file: ops/agent-prompts/executor-agent/plan-execution.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/executor-agent/plan-execution.md
```

### 差异卡（最小种子真源）

```json route_card
{
  "dispatch_phase": {"kind": "workflow", "step": "planning P6"},
  "applies_to": "按 dispatch_manifest 的指定 lane 实施（planning P6 内派发）",
  "model_tier": "",
  "report_dir": ".planning/phases",
  "slot": "executor",
  "required": [
    {"path": "goal", "hint": "执行指定 dispatch_manifest lane 的实施目标", "example": "执行 p1 wave 1 lane L1 并落 SUMMARY"},
    {"path": "scope.read", "hint": "必须包含 dispatch_manifest_ref、trusted_spec_ref、任务输入和执行所需事实文件", "example": ["notes/manifests/<phase>-dispatch-manifest.yaml", "src/app.py"]},
    {"path": "scope.write_extra", "hint": "本 lane 允许修改或创建的文件清单", "example": ["src/app.py"]},
    {"path": "slug", "hint": "SUMMARY 相对 .planning/phases/ 的路径名，写 <phase>/<phase>-<lane>-SUMMARY", "example": "p1/p1-L1-SUMMARY"},
    {"path": "contract.dispatch_manifest_ref", "hint": "notes/manifests/<phase>-dispatch-manifest.yaml", "example": "notes/manifests/<phase>-dispatch-manifest.yaml"},
    {"path": "contract.trusted_spec_ref", "hint": "已审核规格引用", "example": "notes/context/<task>-alignment.md#alignment_spec"},
    {"path": "contract.lane_id", "hint": "要执行的 lane id", "example": "L1"},
    {"path": "contract.planning_wave", "hint": "wave 编号", "example": 1},
    {"path": "contract.task", "hint": "lane.task 原文", "example": "更新 planning workflow 主线"},
    {"path": "contract.scope", "hint": "lane.scope，含 read/write 边界", "example": {"read": ["AGENTS.md"], "write": ["ops/workflows/planning/WORKFLOW.md"]}},
    {"path": "contract.validation", "hint": "lane.validation，含 object/method/pass_condition", "example": {"object": "planning workflow", "method": "cockpit_map.py --lint", "pass_condition": "issues=0"}},
    {"path": "contract.lane_execution_mode", "enum": ["direct_write", "patch_proposal", "merge_lane", "read_only", "validation"], "hint": "本 lane 的执行写入模式"},
    {"path": "contract.dependency_edges", "allow_empty": true, "hint": "依赖边清单；根 lane 使用 []，其余每条必须带 release_gate", "example": [{"target": "L0", "type": "soft_order", "resolved": true, "release_gate": "execution_done"}]},
    {"path": "contract.resource_locks", "allow_empty": true, "hint": "资源锁清单；每项含 lock_id、holder_lane、exclusive、blocks、release_events、observed_release_events；无锁使用 []", "example": [{"lock_id": "shared-config", "type": "shared_file", "holder_lane": "L0", "exclusive": true, "blocks": "code", "release_events": ["execution_done"], "observed_release_events": []}]},
    {"path": "contract.write_ownership", "hint": "direct_paths 与 shared_paths 的写入所有权", "example": {"direct_paths": ["src/app.py"], "shared_paths": []}}
  ],
  "optional": [
    {"path": "contract.execution_adjustment_policy", "hint": "缺省使用现有三种现场调整；显式 allowed_kinds 可为合法子集或空集，不扩张收窄授权", "example": {"allowed_kinds": ["equivalent_command", "unique_path_resolution", "semantics_preserving_step_reorder"]}},
    {"path": "scope.delete", "hint": "只列 dispatch_manifest 明确允许删除的路径，缺省为空"},
    {"path": "known_facts", "hint": "子代理需要的当前事实清单，默认空"}
  ],
  "seed_defaults": {
    "inputs": {"files": "$scope_read"},
    "planning_policy": {"plan_required": false, "reason": "dispatch_manifest P6 wave execution"},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["Lane Status", "Validation", "Commit Draft", "Deviations / Blockers", "Execution Adjustments", "Files Touched"]},
    "handoff_contract": {"accept_verdicts": ["done", "partial", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- 并发分片时 `lane_id`、`scope.write`、`lane_execution_mode`、`dependency_edges`、`resource_locks`、`write_ownership` 与 `dispatch_manifest` 对应 lane 必须一致。排他锁必须列 `lock_id`、`holder_lane` 与非空 `release_events`；释放事件只取 `contract_locked | execution_done | validation_passed`，`observed_release_events` 只登记已有状态证据。
- `lane_execution_mode=patch_proposal` 时只落补丁意图或 SUMMARY；`merge_lane` 只合并已授权 patch intent。
- 执行所需环境或网络前提未知且会影响实施路线时，先在授权目标范围内扫描并把结果写入 `runtime_context`；已知前提复用当前证据，不要求每次执行附扫描票据。联网、下载、代理、端口或服务暴露仍按任务声明的网络授权与目标范围执行。
- `execution_adjustment_policy`缺省时由构包器填现有三种调整；显式合法子集或空集原样保留，按实际授权执行调整。

## 回执接收

全部 lane 目标完成接收 `done`，且 `FINAL_HANDOFF.output.commit_msg_draft` 必须存在；部分完成或有偏差按 lane 状态接收 `partial`。

缺执行前字段、scope、validation、写入所有权、用户确认或必要资源声明且无法现场消化时接收 `needs_owner`，并要求 `FINAL_HANDOFF.output.dispatch_defect=hard_dispatch_blocker` 写明缺口。

出现伪造 verify 证据、写入失败或验证未通过且无法在授权范围内收口时接收 `failed`。

能力特有核对：lane 状态须有 verify 或 diff 证据支撑；`execution_adjustments` 是可消费结果的一部分，不等于失败。
