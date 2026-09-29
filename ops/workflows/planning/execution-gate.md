# planning 执行准入

> 职责：规定 dispatch_manifest 进入 executor 前的编译准入。
> 真源：P5 execute_gate、dispatch_manifest 机械核对和 executor 派发种子规则
> 读取：命中读取

### P5 执行准入

P5 只做机械一致性核对和 executor seed 编译。

execute_gate 字段全集见 `ops/workflows/planning/planning-state.md`。

进入布尔核对前，主代理先运行机械校验工具：

```bash
python -B ops/tools/planning_manifest_check.py --dispatch notes/manifests/<phase>-dispatch-manifest.yaml --format json
python -B ops/tools/acceptance_contract_check.py --contract notes/manifests/<phase>-acceptance-contract.yaml --dispatch notes/manifests/<phase>-dispatch-manifest.yaml --format json
python -B ops/tools/planning_manifest_check.py --review-binding notes/context/<task>-planning-state.yaml --format json
python -B ops/tools/planning_manifest_check.py --review-state notes/context/<task>-planning-state.yaml --format json
```

按工具输出核对机械项与语义审查绑定（refs / phase_id / manifest_revision）；主代理裁定 `trusted_spec_present` 和 `user_confirmation` 两个语义项。工具发生技术故障时保留已有证据，原地恢复后重试；输入身份或真实授权改变时，失效对应审查与冻结证据，修订后重新核对。

进入 executor 前必须满足：

- 全部机械项以上述四条工具命令的输出为准且均通过。
- 主代理裁定 `trusted_spec_present=true`，且 `user_confirmation=confirmed | not_needed`。
- 放行时把 `git rev-parse HEAD` 的结果记入 `execute_gate.change_base`，作为本阶段 P7 各轮验收的变更基线。
- 依赖边 `type` / `release_gate` 与串行 lane 的 reason 只取 `ops/tools/planning_manifest_check.py` 的闭集（planner 侧经注入的 `mechanical_schema.dependency_type_values` / `release_gate_values` / `serial_reason_values` 消费，P5 由 `--dispatch` 校验）；每个串行 lane 必须有具体 evidence。

四类冲突定义：

| reason | 判定 |
| --- | --- |
| `same_object_write` | 两个 lane 直接写同一文件的同一区域、同一符号或同一配置项，且无法拆成 patch intent。 |
| `hard_dependency` | 当前 lane 必须读取另一个 lane 尚未产出的真实文件、数据或运行结果。 |
| `resource_lock` | 两个 lane 争用同一个排他资源，且该资源锁命中当前动作。 |
| `final_decision_owner` | 两个 lane 都要决定同一最终口径、最终 manifest、最终状态或最终裁决。 |

只读重叠、同文件不同区域、已锁接口依赖、运行时准备、soft order 和共享文件可合并 patch 不构成串行理由。

执行准入失败出口：

- 缺机械字段时，在原授权与锁定合同内局部补齐并重跑相关检查；合同或 traceability 需要修订时，按归属回 P1V、P4 或 `ops/workflows/alignment/exit.md` §2 的 S2 / S3。
- 缺审查或冻结证据时补齐；审查失败或 `deviations` 非空时修复对应问题并复验。输入身份或真实授权改变时失效对应旧证据；locked decision 变化时回 S2 / S3 修订。
- 可并发但当前串行时，按真实依赖与资源锁优化后续派发，复用仍有效的审查证据。
- 缺口暂时无法归类时，记录实际错误、受影响 lane 与下一步取证或修复动作；需要新增授权或用户选择时，带具体缺口进入用户确认门或 `needs_owner`。
- 缺已审核规格引用：按 `ops/workflows/alignment/exit.md` §4 重新生成 seed；缺验收对象：回 S2 / S3 修订。

### 资源新增原则

`dispatch_manifest` 可以安排实现用户需要所必需的资源、依赖、工具、目录、脚本、验证手段和网络目标。新增本身不是失败。新增资源必须写清：新增什么、服务哪个验收对象或 lane、影响范围、如何验证、如何回滚或清理。新增测试、工具或脚本资产时，同时执行 `ops/policies/test-tooling-governance.md`。涉及 `ops/workflows/planning/planner-flow.md` P3 所列确认动作时，进入 P3 用户确认，或回 S3 修订补 execution 面的权限边界；其余删除、覆盖、联网读取、本机安装与耗时验证按操作处理。

### locked decision 修订

普通 execution orchestration 不得修改 locked decisions。执行编排发现必须修改 locked decisions 时，回 S2 / S3 修订由用户重新拍板；修订后的规格重新出站，再继续 planning。

P5 的 executor 任务包种子由工具编译，不手工抄写 manifest 字段：

```bash
python -B ops/tools/planning_manifest_check.py --compile-executor-seeds --dispatch notes/manifests/<phase>-dispatch-manifest.yaml --wave <N> --format json
```

manifest 校验失败时不产出种子。输出的 `parallel_seeds` 作为 seed JSON 数组直接交 `node ops/tools/dispatch_prepare.mjs --seed-stdin` 同轮批量派发；`serial_seeds` 按 serial_lanes 的串行理由逐个派发。执行 lane 的模型与档位直接按当前 executor 角色模板返回的默认、候选、选型点评和允许请求档位选择；使用默认时省略模型和档位覆盖参数，使用候选时按任务需要显式选择。单兵模式、任务数量和返工次数只描述执行现场，不触发固定模型选择或自动升档。返工时主代理根据具体缺口重新判断任务与模型是否匹配，仍在当前角色模型池和用户授权范围内选择。goal、slug、`known_facts` 等语义字段可在派发前由主代理修订，`contract` 内的 lane 字段以编译输出为准。下方结构为编译产物的字段合同：

```yaml
package_seed:
  route_id: executor-agent__plan-execution
  goal: 执行 <phase_id> wave <N> lane <lane_id>: <lane.task>
  scope:
    read: [<dispatch_manifest 路径>, <trusted_spec 文件路径>, <lane.scope.read 各项>]
    write_extra: <lane.scope.write>
    delete: <lane.scope.delete；lane 无 delete 时该键省略>
  slug: <phase_id>/<phase_id>-<lane_id>-SUMMARY
  contract:
    dispatch_manifest_ref: notes/manifests/<phase>-dispatch-manifest.yaml
    trusted_spec_ref: <manifest.trusted_spec_ref 原文，可含 #fragment>
    lane_id: <lane_id>
    planning_wave: <N>
    task: <lane.task 原文>
    scope: <lane.scope 原文>
    validation: <lane.validation 原文>
    lane_execution_mode: <lane.mode>
    dependency_edges: <lane.dependency_edges 原文>
    resource_locks: <lane.resource_locks 原文>
    write_ownership: <lane.write_ownership 原文>
    execution_adjustment_policy:
      local_adjustment_allowed: true
      plan_return_only_for: [target_changed, validation_object_changed, scope_expansion_required, exclusive_resource_blocked, unresolvable_dispatch_direction]
```

`dependency_edges.type`、`release_gate`、`lane_execution_mode`、`resource_locks` 与 `write_ownership` 的取值闭集以 `planning_manifest_check.py` 的 checker-owned 校验为唯一真源，本文件不维护第二份枚举。
