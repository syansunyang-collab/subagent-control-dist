# planner 流程

> 职责：规定 planning 中 planner 执行编排的生成和修订流程。
> 真源：P0 准入复核、P1 dispatch_manifest 生成、P3 用户确认、P4 修订重排规则
> 读取：命中读取

## 1.5 长任务状态入口

进入 P1 时，按任务推进需要选择是否启用长任务跟踪。需要启用时读取 `ops/policies/long-task.md`，并记录现有状态字段：

- 当前里程碑与四项运行状态写入 `planning_state.long_task`；派发快照按上述 long-task 策略 §3 生成。
- 业务记录和工程状态的归属、写入时机按 `ops/policies/state.md` 执行。

---

### P0 准入复核

输入：

- `notes/context/<task>-alignment.md`。
- `alignment_state`。
- `dispatch_seed`。
- `ops/workflows/alignment/exit.md` §3 出站结论：`planner_allowed=true` 与 guard `--target planner` 报告。
- `trusted_spec_ref`，即已审核规格或 alignment 出站规格引用。
- `reference_resolution_ref`，即 dispatch seed 前置引用解析报告。

检查：

```yaml
planning_entry_checks:
  dispatch_seed_complete: true | false
  trusted_spec_present: true | false
  reference_resolution_passed: true | false
```

P0 只核对已审核规格是否可消费，不重审规格内容，也不重复自评出站门禁已核对项（planner_allowed、锁定决策、验收对象、运行与网络事实以出站结论为准）。缺 seed 字段或引用解析通过证据时，按 `ops/workflows/alignment/exit.md` §4 重新生成 seed；缺 `trusted_spec_ref` 或规格内容缺口时，回该文件 §2 的 S2 / S3 修订。

全部通过后进入 P1。任一失败时回对应来源补齐，禁止临时派 executor 造桥。

### P1 双轨生成 Acceptance Contract 与 dispatch_manifest

P1A topology 与 P1V Acceptance Contract 优先同轮并行派发；两者终态后先过 P1J 机械 join，再进入 P1B/P1C。主代理按 `ops/workflows/planning/agent-dispatch.md` 选择 route，不手写 task package。

#### P1A 拓扑切片

`planning_pass=topology`。本段只生成执行拓扑，不生成最终派发清单。

P1A 构包遵循 `ops/protocols/task-package-routes/planner-agent__plan-authoring.md`；本 workflow 不复述 capability 字段的生成或填写规则。P1A 回执仍以本节的 `planning_manifest_check.py --topology ... --contracts ...` 为机械出口。

P1A 先定 `execution_mode`（`single_soldier | sliced`，判据见 planner capability）：单兵模式只出一个切片并内联 fragment，执行期由一条 lane 完成规格；模型按 `ops/workflows/planning/execution-gate.md` 的P5选型入口确定。切片模式下切片 ≤ 3 且无 `estimated` 接口时也内联 fragment（`fragments_inline=true`）。切片只承载实现与自测，正式验收不作为切片或 lane 出现，统一由 P7 编译执行；规格 `verify_env.provision=executor_lane` 时，把验收环境安装（装到 `verify_env.location`）作为最后一条实现 lane 的一个动作，不单独成 lane。

P1A 必须输出：

- `notes/manifests/<phase>-planning-topology.yaml`（含 `execution_mode`、`fragments_inline`）。
- `notes/manifests/<phase>-interface-contracts.yaml`。
- `planning_slices[]`。
- 每个切片的 `slice_id`、`trusted_spec_refs`、`validation_objects`、预期写入边界、依赖、资源锁、写入所有权和验收对象。
- `parallelism_contract`，列出候选并发 lane、串行 lane、冲突键和串行证据。
- `slice_parallelism.max_lanes=<规划上无硬阻塞或写冲突的候选并发数>`；实际派发按 `ops/workflows/planning/execution-wave.md` 的 `dispatchable_ready` 与 capacity 计算。

P1A 是 topology 单写者。多个 planner 不得同时决定切片边界、冲突键或接口契约骨架；它与只写 Acceptance Contract 的 P1V 不冲突，可同轮并行。Topology 与 `parallelism_contract` 字段结构由 planner capability 消费，workflow 不维护第二份模板。

按实际依赖和冲突建立拓扑；可并发切片保留在候选集，具体派发批次由执行期安排。

P1A 可以把未细化的接口写成 `stability=estimated`。`estimated` 只表示下游知道存在依赖，不表示下游可以按该接口最终落地。

P1A 回执消费前，主代理运行：

```bash
python -B ops/tools/planning_manifest_check.py --topology notes/manifests/<phase>-planning-topology.yaml --contracts notes/manifests/<phase>-interface-contracts.yaml --format json
```

检查失败时，回 P1A 修正 topology / interface contracts。检查通过后，按 `summary.ready_slice_ids` 进入 P1B。

#### P1V Acceptance Contract

P1V 使用 `planner-agent / acceptance-authoring`，只从与 P1A 相同的锁定规格和 requirement id 闭集生成：

- `notes/manifests/<phase>-acceptance-contract.yaml`。
- 每个 requirement 的验收对象、oracle、测试技术、样例、主要 validation route、证据要求、阻断级别、确认范围和回归范围。
- route 专属输入；实现路径未知时只使用 checker 声明的宏。

P1V 不读取 topology、fragment 或 dispatch manifest，不决定实现切片。回执消费前运行：

```bash
python -B ops/tools/acceptance_contract_check.py --contract notes/manifests/<phase>-acceptance-contract.yaml --format json
```

合同检查失败时只回 P1V；缺 oracle 或 requirement 来源且不能在锁定规格内修正时回 S2 / S3 修订。

**机械同步轻量档**：phase 的全部动作均为机械同步（模板副本同步、格式或路径整修、重命名、纯文档移动）时，主代理可不派 acceptance-authoring，用 `acceptance_contract_check.py --mechanical-sync-template` 取单 item 合同骨架直填。资格由 checker 机械把关：直填合同必须携带 `mechanical_sync.write_paths`（逐项列出实际写入路径），checker 校验其非空且不落在规则对象前缀（AGENTS.md、`ops/agent-prompts|policies|protocols|skills|workflows`）内，命中即合同 fail 回 P1V。直填合同走完全相同的合同检查与 P1J join，不豁免任何机械门；动作含语义判断时不得使用本档，照常派 P1V。

#### P1J 双轨机械 join

P1A 与 P1V 均通过各自 checker 后运行：

```bash
python -B ops/tools/acceptance_contract_check.py \
  --contract notes/manifests/<phase>-acceptance-contract.yaml \
  --topology notes/manifests/<phase>-planning-topology.yaml \
  --join-output notes/manifests/<phase>-acceptance-join.json \
  --format json
```

join 只检查 `phase_id`、`trusted_spec_ref` 和 requirement 闭集覆盖，不评价实现方案。topology 漏 requirement 时回 P1A；合同漏 requirement 时回 P1V；两边 spec identity 不一致时回 P0 复核，需要回 alignment 时按 P0 的两路出口。仅 join=pass 时进入 P1B。

#### P1B 切片细化

`planning_pass=slice_detail`。topology 已 `fragments_inline=true` 时跳过 P1B，fragment 直接进 fragment checker 与 P1C。否则主代理按 P1A 的 `planning_slices[]` 优先并行为各切片派一个 planner（consumer 切片先做 `prep_ready` 细化，接口锁定后只补 final 动作），同时传入 Acceptance Contract 与 P1J pass 引用；不因接口 `estimated` 把细化排成串行。P1B 只写各自 fragment；主代理按当前 route/model/派发通道可用性，从无冲突 ready 切片中计算 `dispatchable_ready` 并按 capacity 同轮派发。运行时不可用的切片保持 pending，恢复后补位。

Fragment 字段结构由 planner capability 消费，P1B 只维护切片派发、ready 判定和 fragment checker 出口。

切片 ready 分两层：

```yaml
slice_ready:
  prep_ready: true | false
  final_ready: true | false
  blocked_by_contracts: []
```

- `prep_ready=true`：允许先细化文件范围、动作、验证入口、资源锁、补丁意图和等待项。
- `final_ready=true`：允许给出最终执行动作。
- 有 `requires_contracts` 时，所需接口契约必须为 `stability=locked` 才能 `final_ready=true`。
- producer 切片负责把 `estimated` contract 提升为 `locked`，再释放 consumer 的最终落地。
- 共享入口文件、待安装依赖或运行时依赖不阻塞准备细化；只阻塞需要运行、构建或验收的动作。

每个切片 planner 只允许细化被分配的 `slice_id`，输出：

- `.planning/phases/<phase>/fragments/<slice_id>.md`。
- 本切片的执行动作、文件范围、验证方式、资源锁、写入所有权、依赖边、局部 wave 口径。
- `validation.requirement_refs`，只复制本切片覆盖的 Acceptance Contract requirement id。
- 本切片负责的 `contract_fragment` 和 `contract_promotions[]`。
- 本切片可并发依据；若要求串行，必须写四类冲突之一和具体证据。

P1B 不得修改 P1A 的切片边界。发现边界错误、跨切片依赖缺失或无法独立细化时，返回 `needs_owner`，由 P1C 或 P4 处理。

每个 fragment 回执消费前，主代理运行：

```bash
python -B ops/tools/planning_manifest_check.py --fragment .planning/phases/<phase>/fragments/<slice_id>.md --slice-id <slice_id> --format json
```

检查失败时回该 slice 的 P1B 修正，不进入 P1C。

#### P1C 汇总与冲突消解

`planning_pass=aggregate`。主代理在必要切片 fragment 已消费后，派一个 planner 汇总最终 `dispatch_manifest`。

P1C 必须输出：

- `notes/manifests/<phase>-dispatch-manifest.yaml`。
- `notes/handoffs/<package_id>.md`。
- 在 manifest 固定记录 `acceptance_contract_ref` 与 `acceptance_join_ref`；每个 lane 保留 `validation.requirement_refs`。

`dispatch_manifest` 字段结构由 planner capability 消费并由 `planning_manifest_check.py --dispatch` 验收；workflow 不维护第二份模板。

P1C 冲突消解顺序：

1. 把没有 `mechanical_schema.serial_reason_values` 对应证据的 lane 放回并发池。
2. 同一共享文件不同区域写入使用闭集中的补丁提案与合并通道模式。
3. 未解决硬依赖只阻塞依赖该产物的下游 lane。
4. 排他资源锁只阻塞命中该资源的 lane。
5. 最终裁决冲突由 P1C 单点裁决后再派执行，不并发裁决。

P1C 发现默认 plan-checker、plan-review lane / aggregate、规格重审或长 PLAN 编写被重新塞回主线时，返回 P4 修正；不在 manifest 运行态携带自证块。

P1C 将无硬阻塞的 lane 保留为并发候选；执行批次选择不作为 manifest 失败理由。P1C 完成并关闭 planner 后，主代理先完成下述语义裁决与冻结，再进入 P3 或 P5。

主代理对照 `trusted_spec_ref`、`source_fragments` 与 `interface_contracts_ref` 裁决 manifest 是否仍实现已锁规格。裁决记录已锁规格覆盖、fragment 覆盖、接口契约兼容和验收对象覆盖；Acceptance Contract 覆盖与 dispatch traceability 分别复制 P1J 与 dispatch join 的机械结果。六项全通过且 `deviations=[]` 时写入 `planning_state.semantic_review.status=pass`。出现偏差时写入列表并标记 `fail`，回 P4；发现缺失或改变 locked decision 时回 S2 / S3 修订。

仅 `semantic_review.status=pass` 的 manifest 可冻结。主代理运行 `planning_manifest_check.py --review-binding <planning-state>`，把工具 `summary` 中的 `phase_id` 和 `manifest_revision` 原样写入 `semantic_review` 与 `manifest_freeze` 对应字段；不算任何 hash。冻结后再改 manifest 或任一契约输入时，planner 把 `dispatch_manifest.revision` +1，主代理清除两项证据并回 P4 重裁一次；P3 只消费冻结绑定，P5 用同一工具的 `--review-state` 核对 refs 与 revision。字段结构以 `ops/workflows/planning/planning-state.md` 为真源。

### P3 用户确认门

默认需要用户确认的情况：

- `dispatch_manifest` 含用户确认、领域负责人确认、对外发送或发布、费用、密钥或凭证、服务暴露、系统级安装或管理员权限、无法回退的删除。
- 执行会改变 `ROADMAP.md` 里程碑状态。
- 规格书的 execution 面或决策账本写明执行前需用户确认。

`dispatch_manifest` 不含上列确认动作时跳过用户确认。可备份的删除、覆盖、联网读取、本机安装与耗时验证属于操作，按 `ops/workflows/alignment/decision-ledger.md` §3 处理。

需要用户确认时，优先使用 `request_user_input`，最多 3 个互斥选项：

```text
继续执行当前 dispatch_manifest
先修订执行编排
暂停，重新对齐目标
```

用户未明确确认且命中确认条件时，禁止进入 executor。

### P4 planner 修订重排

触发：

- P5 发现 `dispatch_manifest` 机械缺口。
- 用户在 P3 要求修订。
- executor / verify-agent 回流表明当前 lane 无法在授权范围内交付可验收结果，且缺口不能由执行现场调整、补字段、补授权或补上下文解决。
- Acceptance Contract 与 topology / dispatch 的机械 join 失败，且缺口位于实施切片或 lane traceability。
- 可并发 lane 被串行安排，且没有四类冲突证据。

修订先读取 `ops/workflows/planning/agent-dispatch.md` 的 P4 条目确定 role、capability 和 route，再按命中 route 构包。P4 只处理硬编排缺口，不处理执行摩擦。

阻断项只影响部分切片时，按失败切片并发派 `planning_pass=slice_detail` 修订 fragment，再用 `planning_pass=aggregate` 汇总修订版 `dispatch_manifest`。阻断项影响切片边界、验收合同、locked decisions 或接口契约来源时，分别回 P1A、P1V 或 S2 / S3 修订，不默认重跑全部 planning。

未受失败影响的切片不得重跑。修复后只派发未完成或受修订影响的 lane。
