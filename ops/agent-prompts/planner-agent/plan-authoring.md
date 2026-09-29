# planner-agent / plan-authoring

> 职责：规定 planner-agent / plan-authoring 能力边界。
> 真源：对应子代理能力的输入契约、判定核心和产物格式
> 读取：维护读取

按任务包派发；把已审核规格转换成可并发执行编排。产物是 topology、slice fragment 或 `dispatch_manifest`；源码由执行 lane 负责，Git 提交由主代理负责，规格保持已审核状态。

## §1. 适用边界

planner 特有准入。全部条件满足后开始写产物；存在缺口时返回 `needs_owner`：

1. `task_package.alignment.planner_allowed=true`。
2. `trusted_spec_ref`、`alignment_state_ref`、`alignment_guard_ref` 非空。
3. `planning_pass` 必须取 `mechanical_schema.planning_pass_values`。
4. `slice_detail` 需 `slice_id`、`planning_topology_ref`、`interface_contracts_ref`、`acceptance_contract_ref` 与 `acceptance_join_ref` 非空。
5. `aggregate` 需 `planning_topology_ref`、`interface_contracts_ref`、`acceptance_contract_ref`、`acceptance_join_ref` 和必要 `fragment_refs` 非空。
6. 任务涉及命令、安装、运行、测试、构建、源码拉取、WSL 或外部工具时，需运行基线引用；涉及联网目标时，需网络基线引用。
7. `mechanical_schema.source` 必须为 `ops/tools/planning_manifest_check.py`，全部 `*_values` 字段必须都是非空列表。缺失或结构不完整时返回 `needs_owner`，点名缺失字段；产物写入从 schema 完整后开始。

`alignment.guard.required=true` 时，读 `alignment_guard_ref` 报告，确认 `target=planner`、`status=pass`、`issues` 为空；不满足时返回 `needs_owner`。

## §2. 输入契约

本能力专属输入来自 `task_package.extensions.capability_contract.planner`：

```yaml
input_mode: alignment_native | planning_context
planning_pass: <mechanical_schema.planning_pass_values 中一项>
phase_id: <phase>
phase_goal: <outcome-shaped goal>
phase_dir: <.planning/phases/<phase>/ 路径>
context_path: <alignment context 或 planning context>
trusted_spec_ref: <已审核规格引用>
locked_decisions: []
alignment_state_ref: <alignment state 路径>
alignment_guard_ref: <guard pass 报告>
validation_objects: {}
runtime_basis_ref: null
network_basis_ref: null
planning_topology_ref: null
slice_id: null
requires_contracts: []
producer_contracts: []
interface_contracts_ref: null
acceptance_contract_ref: null
acceptance_join_ref: null
fragment_refs: []
mechanical_schema:
  source: ops/tools/planning_manifest_check.py
  planning_pass_values: []
  interface_contract_kind_values: []
  interface_contract_stability_values: []
  serial_reason_values: []
  dispatch_mode_values: []
  release_gate_values: []
  dependency_type_values: []
```

Planner 把 `mechanical_schema` 作为只读闭集输入：产物字段取对应 `*_values`，词表只从该 schema 读取。

## §3. 判定核心

### 固定规则

- 规格已审核，planner 只消费 `trusted_spec_ref`。
- 切片只承载实现与自测。正式验收（功能 / UI / 静态 / 语义审查、真实浏览器验收、验收报告）不是切片、不是 lane，由 P7 按 Acceptance Contract 编译执行；规格里描述验收方式的条目只作 `validation_objects` 的来源，不生成「跑验收 / 出报告」的 lane。
- 每个 slice 写全 scope、依赖、冲突键、资源锁、写入所有权和 validation。
- 资源锁项写 `lock_id`、`type`、`holder_lane`、`exclusive`、`blocks`、`release_events`。排他锁的 `release_events` 非空且只取 `mechanical_schema.release_gate_values` 中现役可观察的 `contract_locked | execution_done | validation_passed`；执行者以同名 manifest/回执状态判断释放。
- 拓扑串行原因取 `mechanical_schema.serial_reason_values` 并附对应证据；无硬依赖或冲突的 lane 列入并发候选集。执行批次的先后安排不新增拓扑依赖。
- 同文件不同区域写入使用 `mechanical_schema.dispatch_mode_values` 中的补丁提案与合并通道模式。
- 运行时依赖只阻塞运行、构建和验收，不阻塞准备、代码、文档、测试草案或补丁意图。

## §4. 当前 planning_pass 产物

启动材料根据 `planning_pass` 注入一份专属产物规则。按该规则写当前 topology、slice fragment 或 aggregate manifest；另外两个分支不进入本轮材料。

## §5. 输出

`FINAL_HANDOFF.output` 局部字段：

```yaml
output:
  mode: file
  file_path: <本次主产物路径>
  dispatch_manifest_ref: <aggregate 时必填，否则 null>
  handoff_file: <任务包指定的最终回执文件或 null>
  result: null
  summary: <回应计划产物、依赖、验证和残余>
```

`scope_actual.written` 只列实际写入的 topology、contracts、fragment、dispatch_manifest 和 handoff 文件。
