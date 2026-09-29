# planner-agent / acceptance-authoring 派发规范

> 职责：规定 planner-agent / acceptance-authoring 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：已锁定规格进入 planning P1，需要与 implementation topology 并行生成 Acceptance Contract。

### 固定包头

```yaml task_package_agent
agent:
  role: planner-agent
  runtime_role: planner-agent
  capability:
    name: acceptance-authoring
    file: ops/agent-prompts/planner-agent/acceptance-authoring.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/planner-agent/acceptance-authoring.md
```

### 差异卡（最小种子真源）

```json route_card
{
  "dispatch_phase": {"kind": "workflow", "step": "planning P1"},
  "applies_to": "planning P1 从已锁定规格独立生成 Acceptance Contract",
  "model_tier": "",
  "report_dir": "notes/manifests",
  "slot": "acceptance_authoring",
  "required": [
    {"path": "goal", "hint": "为指定 phase 的已锁定规格生成可机械编译的 Acceptance Contract", "example": "为 sample-acceptance-phase 已锁定规格生成可机械编译的 Acceptance Contract"},
    {"path": "scope.read", "hint": "列出 trusted spec、alignment state、guard 报告和规格点名的来源，覆盖真实使用动作、证据要求、必要环境及已约定的确认点", "example": ["ops/fixtures/acceptance-authoring-route-context.md", "ops/fixtures/acceptance-authoring-route-guard.json"]},
    {"path": "scope.write_extra", "hint": "列出目标 Acceptance Contract 路径", "example": ["notes/manifests/<phase>-acceptance-contract.yaml"]},
    {"path": "contract.phase_id", "hint": "planning phase id", "example": "sample-acceptance-phase"},
    {"path": "contract.trusted_spec_ref", "hint": "已锁定规格引用", "example": "ops/fixtures/acceptance-authoring-route-context.md"},
    {"path": "contract.spec_revision", "hint": "规格修订标识", "example": "accepted-sample"},
    {"path": "contract.requirement_ids", "hint": "已锁定规格中的 requirement/spec id 闭集", "example": ["AR-01"]},
    {"path": "contract.source_refs", "hint": "验收合同允许引用的规格来源文件", "example": ["ops/fixtures/acceptance-authoring-route-context.md"]},
    {"path": "contract.alignment_state_ref", "hint": "alignment state 路径", "example": "ops/fixtures/acceptance-authoring-route-context.md"},
    {"path": "contract.alignment_guard_ref", "hint": "alignment_guard.py --target planner 的 pass 报告", "example": "ops/fixtures/acceptance-authoring-route-guard.json"},
    {"path": "contract.acceptance_contract_ref", "hint": "notes/manifests/<phase>-acceptance-contract.yaml", "example": "notes/manifests/<phase>-acceptance-contract.yaml"}
  ],
  "optional": [
    {"path": "slug", "hint": "缺省使用 <phase>-acceptance-contract"}
  ],
  "seed_defaults": {
    "alignment": {
      "planner_allowed": true,
      "guard": {"required": true, "verdict": "pass", "target": "planner", "report_path": "$contract.alignment_guard_ref"}
    },
    "planning_policy": {"plan_required": false, "reason": "planning P1 验收轨产物"},
    "runtime_context": {"network_needed": "no"},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["acceptance_contract"]},
    "handoff_contract": {"accept_verdicts": ["done", "needs_owner", "failed"]}
  }
}
```

### 构包与接收

- 构包器在 seed overlay 后注入 `extensions.capability_contract.acceptance_authoring.mechanical_schema`，并以该注入值为唯一 schema 输入。
- 本任务与 P1A topology 无写域和硬依赖冲突时并发派发。
- 按已注入的 `ops/agent-prompts/planner-agent/acceptance-authoring.md` §2 编写合同：该节规定场景与共享证据、独立代码观察、环境前提和确认点的落位。
- 报告与合同分文件：报告按 `report_dir` 落 `notes/manifests/` 下的 Markdown，合同 YAML 写入 `contract.acceptance_contract_ref`。`done` 时接收 `output.acceptance_contract_ref` 等于任务包目标的回执，主代理消费前对该文件运行 `acceptance_contract_check.py`。
- BLOCK IF: 锁定规格、requirement id、guard、机械 schema 或 oracle 来源缺失。先修正任务包后重试；无法补齐时只接收 `needs_owner`，让 Acceptance Contract 保持未生成状态。
