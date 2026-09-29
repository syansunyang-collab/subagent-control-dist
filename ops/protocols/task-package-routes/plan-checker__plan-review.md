# plan-checker / plan-review 派发规范

> 职责：规定 plan-checker / plan-review 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：用户明确点名的 `dispatch_manifest` 审查。使用 `node ops/tools/dispatch_prepare.mjs --seed-template` 生成骨架。

### 固定包头

```yaml task_package_agent
agent:
  role: plan-checker
  runtime_role: plan-checker
  capability:
    name: plan-review
    file: ops/agent-prompts/plan-checker/plan-review.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/plan-checker/plan-review.md
```

MUST: 将以上固定值逐字写入 `task_package.agent`。

### 差异卡（最小种子真源）

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "用户点名的 dispatch_manifest 临时审查",
  "model_tier": "",
  "report_dir": "notes/verify",
  "slot": "plan_check",
  "required": [
    {"path": "goal", "hint": "写成审查指定 dispatch_manifest 的只读目标", "example": "审查 p1 dispatch_manifest 的并发安排是否存在无证据串行"},
    {"path": "scope.read", "hint": "列入 dispatch_manifest、相关 fragments、P5 缺口报告和用户点名记录", "example": ["notes/manifests/p1-dispatch-manifest.yaml", ".planning/phases/p1/fragments/S1.md", "notes/context/pi-dispatch-adaptation-plan.md"]},
    {"path": "contract.dispatch_manifest_ref", "hint": "要审查的 dispatch_manifest 路径", "example": "notes/manifests/p1-dispatch-manifest.yaml"},
    {"path": "contract.phase_id", "hint": "phase 编号", "example": "p1"},
    {"path": "contract.review_lane", "enum": ["manifest_integrity", "concurrency", "execution_readiness", "aggregate"], "hint": "本次审查 lane"},
    {"path": "contract.user_request_ref", "hint": "用户明确点名本次 dispatch_manifest 审查的 canonical 消息、记录或 handoff 引用", "example": "notes/context/pi-dispatch-adaptation-plan.md"}
  ],
  "optional": [
    {"path": "slug", "hint": "普通 lane 使用 plancheck-<phase_id>-<review_lane>；aggregate 使用 plancheck-<phase_id>"},
    {"path": "contract.lane_report_refs", "hint": "aggregate 时列入普通 lane 报告"}
  ],
  "contract_defaults": {
    "lane_report_refs": []
  },
  "seed_defaults": {
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["TL;DR", "Findings", "Verdict", "结果索引"], "business_gate": "overall"},
    "handoff_contract": {"accept_verdicts": ["pass", "partial", "fail", "needs_owner", "failed"]}
  }
}
```

### 构包动作

1. 把用户明确点名本次审查的唯一证据写入 `contract.user_request_ref`，并把对应记录列入 `scope.read`。
2. 把 manifest 和本 lane 所需引用列入 `scope.read`。
3. 并行派发互不冲突的普通 lane；在所需 lane 报告落盘后构造 aggregate。
4. 把审查目标限制为 manifest 编排，不把本 route 放入默认 planning 主线。

BLOCK IF: `contract.user_request_ref` 缺失。补入 canonical 用户请求引用后重试；无法补入时收口 `needs_owner` 并点名缺失引用。

BLOCK IF: `review_lane=aggregate` 且缺少必要 `lane_report_refs`。补齐报告引用后重试。

## 回执接收

读取 `FINAL_HANDOFF.output.overall`：`APPROVED` 对应 `pass`；`APPROVED_WITH_FLAGS` 对应 `partial`；`BLOCKED` 对应 `fail`；输入合同不匹配对应 `needs_owner`；产物写入失败对应 `failed`。

核对 `scope_actual.read` 含被审 manifest，`scope_actual.written` 只含本轮报告与 handoff。
