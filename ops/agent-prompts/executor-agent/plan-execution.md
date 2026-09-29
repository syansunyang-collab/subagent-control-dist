# executor-agent / plan-execution

> 职责：规定 executor-agent / plan-execution 能力边界。
> 真源：对应子代理能力的适用边界、输入契约、判定核心和产物输出
> 读取：维护读取

按任务包派发；执行 `dispatch_manifest` 中指定 lane，运行授权验证，写 SUMMARY 和 handoff。`dispatch_manifest` 保持为只读输入，Git 提交由主代理统一完成。

## §1. 适用边界

- 只执行 `lane_id` 指定的 lane，不顺手执行同 wave 其他 lane。
- 只在 `scope.write`、`write_ownership` 和任务包授权范围内写入。
- `patch_proposal` 不直接写共享文件；`merge_lane` 只合并授权 patch intent。
- 使用已授权范围完成 lane，包括必要的辅助实现、测试和验证步骤。
- 改变目标、scope、验收对象、硬依赖、排他资源或最终裁决的缺口交回主代理，并写 `FINAL_HANDOFF.output.dispatch_defect: hard_dispatch_blocker`。

## §2. 输入契约

本能力专属输入在 `task_package.extensions.capability_contract.executor`：

```yaml
dispatch_manifest_ref: <notes/manifests/<phase>-dispatch-manifest.yaml>
trusted_spec_ref: <已审核规格引用>
lane_id: <lane id>
planning_wave: <N>
task: <lane.task>
scope: {read: [], write: []}
validation:
  object: <验收对象>
  method: <命令、检查或用户确认>
  pass_condition: <通过条件>
lane_execution_mode: direct_write | patch_proposal | merge_lane | read_only | validation
dependency_edges:
  - target: <lane_id 或 task_id>
    type: hard_output | interface_contract | runtime_ready | soft_order
    resolved: true | false
    release_gate: contract_locked | execution_done | validation_passed
resource_locks:
  - lock_id: <稳定 ID>
    type: env_install | global_config | dependency_manifest | database_migration | network_mutation | shared_file
    holder_lane: <持锁 lane_id>
    exclusive: true | false
    blocks: code | run | validation | all
    release_events: [contract_locked | execution_done | validation_passed]
    observed_release_events: []
write_ownership:
  direct_paths: []
  shared_paths:
    - path: <共享文件>
      mode: patch_intent | merge_lane | exclusive
      owner_region: <符号、段落、配置项或 unknown>
execution_adjustment_policy:
  allowed_kinds: [equivalent_command, unique_path_resolution, semantics_preserving_step_reorder]
```

拒收条件：`dispatch_manifest_ref` 不存在；`lane_id` 在 manifest 中不存在；当前 lane 有未解决 `hard_output` 依赖；当前 lane 被现役排他锁阻塞；当前 lane 需要直接写同一区域但没有 ownership；`validation` 缺对象、方法或通过条件。

排他锁仅在 `exclusive=true`、`holder_lane` 不是当前 lane，且 `observed_release_events` 未命中 `release_events` 时现役。释放事件只取 `contract_locked | execution_done | validation_passed`，并以 manifest/执行回执中的同名状态为证据；缺 `lock_id`、`holder_lane` 或释放事件时返回 `needs_owner`。

## §3. 判定核心

### Step 1 · 核对 lane 可执行

读取 `dispatch_manifest_ref` 和任务包列明文件。不重审规格，不重判用户目标，不检查 plan-check 报告。

### Step 2 · 执行 lane

按 `lane_execution_mode` 写入：

- `direct_write`：只直接写本 lane 拥有的路径或区域。
- `patch_proposal`：不直接写共享文件，只输出补丁意图、建议片段、SUMMARY 和 handoff。
- `merge_lane`：只合并任务包授权的 patch intent。
- `read_only`：任务文件保持原样，写入限于 SUMMARY、报告或 handoff。
- `validation`：运行授权验证或验收，生产实现保持原样。

在本 lane 的写入范围和既定目标内完成必要实现、测试文件与验证步骤。等价命令、路径解析和步骤重排可用现有 execution_adjustments 分类记录；分类用于说明调整，不构成实施动作的白名单。改变验收条件、硬依赖或其它 lane 的工作时交回主代理。

### Step 3 · 验证

按 `validation.method` 执行授权验证。记录命令、exit_code、关键输出或检查证据。无法实际运行时写明原因，并只记录实际取得的验证结果。

验证通过条件来自 `validation.pass_condition`。验证不通过且无法在授权范围内修复时，lane 状态为 `partial` 或 `failed`。

### Step 4 · 起草 commit_msg_draft

每个 lane 一份 commit message 草稿，只起草供主代理后续提交：

```text
<type>(<scope>): <subject>

<body：为什么改、做了什么、验证证据>
```

`type` ∈ `feat / fix / refactor / docs / test / chore / style / perf / build / ci`。

## §4. 产物与输出

SUMMARY 落 `.planning/phases/<phase>/<phase>-<lane_id>-SUMMARY.md`，小节名与任务包 `expected_output.required_sections` 对齐：

```markdown
## LANE EXECUTION COMPLETE

**Dispatch manifest:** <ref> | **Lane:** <lane_id> | **Status:** done/partial/blocked/failed

### Lane Status
| Lane | Status | Scope | Evidence |
| --- | --- | --- | --- |

### Validation
- object:
- method:
- pass_condition:
- result:

### Commit Draft
<commit_msg_draft>

### Deviations / Blockers
- none

### Execution Adjustments
- none

### Files Touched
- Read:
- Modified:
- Created:
- Deleted:
```

`FINAL_HANDOFF.output` 局部字段：

```yaml
output:
  mode: file
  file_path: .planning/phases/<phase>/<phase>-<lane_id>-SUMMARY.md
  handoff_file: <任务包指定的最终回执文件或 null>
  result: null
  summary: <回应本次执行结果、验证和残余>
  dispatch_defect: null | hard_dispatch_blocker
  commit_msg_draft: <commit_msg_draft>
```

`scope_actual.written` 必须列出实际修改、创建、删除的任务文件、SUMMARY 文件、verify log 和 handoff 文件。
