# planner-agent / plan-authoring 派发规范

> 职责：规定 planner-agent / plan-authoring 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：已审核规格进入 planning 后，需要生成或修订执行编排。planner 产物是拓扑、slice fragment 或 `dispatch_manifest`，不是默认长 PLAN。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架。

### 固定包头

```yaml task_package_agent
agent:
  role: planner-agent
  runtime_role: planner-agent
  capability:
    name: plan-authoring
    file: ops/agent-prompts/planner-agent/plan-authoring.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/planner-agent/plan-authoring.md
```

### 差异卡（最小种子真源）

```json route_card
{
  "dispatch_phase": {"kind": "workflow", "step": "planning P1"},
  "applies_to": "已审核规格进入执行编排（planning P1/P4 内派发）",
  "model_tier": "",
  "report_dir": "notes/manifests",
  "slot": "planner",
  "required": [
    {"path": "goal", "hint": "生成或修订执行编排产物，一句话", "example": "为 rule-cleanup 生成 dispatch_manifest：切片、细化并消解冲突"},
    {"path": "scope.read", "hint": "alignment_native 取 alignment_guard.py --emit-planner-seed 生成的读取项：规格书、出站 seed 点名的读取项、runtime/network 基线报告和 guard 报告", "example": ["notes/context/agent-panel-design-alignment.md", "tmp/planner-seed.guard.json"]},
    {"path": "scope.write_extra", "hint": "只列 topology、fragment、dispatch_manifest 和 handoff 的写入路径；源码与测试源码由执行任务负责，Git 提交由主代理负责", "example": ["notes/manifests/p1-dispatch-manifest.yaml", ".planning/phases/p1/fragments/"]},
    {"path": "contract.input_mode", "enum": ["alignment_native", "planning_context"], "hint": "alignment workflow 默认 alignment_native；旧式 planning context 才用 planning_context"},
    {"path": "contract.planning_pass", "hint": "取构包器注入的 mechanical_schema.planning_pass_values；各分支行为由 planner capability 与 planning workflow 说明", "example": "topology"},
    {"path": "contract.phase_id", "hint": "里程或短任务编号", "example": "p1"},
    {"path": "contract.phase_goal", "hint": "outcome-shaped 目标", "example": "把已审核规格转换成可并发执行派发清单"},
    {"path": "contract.phase_dir", "hint": ".planning/phases/<phase>/ 路径", "example": ".planning/phases/p1/"},
    {"path": "contract.context_path", "hint": "input_mode=alignment_native 指向 notes/context/ 下的 alignment context", "example": "notes/context/agent-panel-design-alignment.md"},
    {"path": "contract.trusted_spec_ref", "hint": "已审核规格或 alignment 出站规格引用", "example": "notes/context/agent-panel-design-alignment.md#alignment_spec"},
    {"path": "contract.alignment_state_ref", "hint": "alignment_state 路径", "example": "notes/context/agent-panel-design-alignment.md"},
    {"path": "contract.alignment_guard_ref", "hint": "alignment_guard.py --emit-planner-seed 在 seed 同目录写出的 .guard.json pass 报告", "example": "tmp/planner-seed.guard.json"},
    {"path": "contract.validation_objects", "hint": "alignment_spec 的 spec_id 到 validation_object 映射，非空", "example": {"AS-01": "rule_structure"}}
  ],
  "optional": [
    {"path": "slug", "hint": "产物短名；aggregate 用 <phase>-dispatch-manifest，slice_detail 用 fragments/<slice_id>"},
    {"path": "contract.locked_decisions", "hint": "规格书 decisions 中 status=locked 的编号；没有时省略并默认 []"},
    {"path": "contract.runtime_basis_ref", "hint": "任务涉及命令/安装/运行/测试/构建/WSL/外部工具时必填"},
    {"path": "contract.network_basis_ref", "hint": "任务涉及联网/下载/代理/DNS/端口/暴露时必填"},
    {"path": "contract.planning_topology_ref", "hint": "planning_pass=slice_detail|aggregate 必填"},
    {"path": "contract.slice_id", "hint": "planning_pass=slice_detail 必填"},
    {"path": "contract.requires_contracts", "hint": "slice_detail 消费的接口契约，默认 []"},
    {"path": "contract.producer_contracts", "hint": "当前切片负责锁定的接口契约，默认 []"},
    {"path": "contract.interface_contracts_ref", "hint": "planning_pass=slice_detail|aggregate 必填"},
    {"path": "contract.acceptance_contract_ref", "hint": "planning_pass=slice_detail|aggregate 必填，指向已通过机械 join 的 Acceptance Contract"},
    {"path": "contract.acceptance_join_ref", "hint": "planning_pass=slice_detail|aggregate 必填，指向 acceptance_contract_check.py 的 pass 结果"},
    {"path": "contract.fragment_refs", "hint": "planning_pass=aggregate 必填，列出已消费 fragment"}
  ],
  "contract_defaults": {
    "locked_decisions": [],
    "runtime_basis_ref": null,
    "network_basis_ref": null,
    "planning_topology_ref": null,
    "slice_id": null,
    "requires_contracts": [],
    "producer_contracts": [],
    "interface_contracts_ref": null,
    "acceptance_contract_ref": null,
    "acceptance_join_ref": null,
    "fragment_refs": []
  },
  "required_files_by_contract": {
    "path": "planning_pass",
    "map": {
      "topology": "ops/agent-prompts/planner-agent/plan-authoring-topology.md",
      "slice_detail": "ops/agent-prompts/planner-agent/plan-authoring-slice-detail.md",
      "aggregate": "ops/agent-prompts/planner-agent/plan-authoring-aggregate.md"
    }
  },
  "seed_defaults": {
    "inputs": {"context_path": "$contract.context_path", "trusted_spec_ref": "$contract.trusted_spec_ref", "phase_goal": "$contract.phase_goal"},
    "alignment": {
      "state_ref": "$contract.alignment_state_ref",
      "decision_refs": "$contract.locked_decisions",
      "planner_allowed": true,
      "guard": {"required": true, "verdict": "pass", "target": "planner", "report_path": "$contract.alignment_guard_ref"}
    },
    "planning_policy": {"plan_required": false, "reason": "planning P1 派发：本任务产出 dispatch_manifest 或其片段"},
    "runtime_context": {"network_needed": "no"},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["拓扑切片或切片细化或冲突消解", "dispatch_manifest 或 fragment", "Source Audit", "下一步"]},
    "handoff_contract": {"accept_verdicts": ["done", "partial", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- 构包器在所有 seed overlay 完成后，从 `ops/tools/planning_manifest_check.py` 写入 `extensions.capability_contract.planner.mechanical_schema`；快照缺失或不完整时，在任务材料写入前报错并停止提交。
- 构包器按 `contract.planning_pass` 向 `agent.required_files` 加入 topology、slice-detail、aggregate 三份专属产物规则中的一份；公共能力提示词只保留跨分支不变量。
- 调用方不在最小 seed 或完整 seed 填写 `mechanical_schema`；同名输入不形成覆盖权。
- `topology` 只写 topology 和 interface contracts。
- `slice_detail` 只写指定 `slice_id` 的 fragment。
- `slice_detail` 与 `aggregate` 只消费已通过机械 join 的 Acceptance Contract；每个 validation 携带对应 `requirement_refs`。
- 每个排他 `resource_locks` 项携带稳定 `lock_id`、`holder_lane` 和非空 `release_events`；释放事件只取机械闭集中的 `contract_locked | execution_done | validation_passed`，并对应 manifest/回执可观察状态。
- `aggregate` 只汇总 fragment、消解冲突并输出 `dispatch_manifest`，同时保留 Acceptance Contract 与 join 引用。
- 多个 `slice_detail` 可并行派发；`topology` 和 `aggregate` 必须单点执行。
- planner 不审规格；缺 seed 字段或引用时按 `ops/workflows/alignment/exit.md` §4 重新生成 seed，规格内容缺口回该文件 §2 的 S2 / S3 修订。

## 回执接收

verdict 词表：`done | partial | needs_owner | failed`。能力特有核对：

- `done` 时 `output.file_path` 指向本次 `planning_pass` 的实际产物。
- `planning_pass=aggregate` 时，`output.dispatch_manifest_ref` 必须指向 `notes/manifests/<phase>-dispatch-manifest.yaml`。
- `planning_pass=slice_detail` 且 `producer_contracts` 非空时，回执的 `mechanical_check: pass` 必须以 `ops/workflows/planning/planner-flow.md` P1B fragment gate 为依据。
- 缺 `input_mode`、`planning_pass`、`phase_goal`、`context_path`、`trusted_spec_ref`、`alignment_state_ref`、`alignment_guard_ref` 或必要运行基线时，期望回执为 `needs_owner`；主代理保持该结论并补齐缺口。
