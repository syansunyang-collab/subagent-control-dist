# plan-checker / proposal-challenge-review 派发规范

> 职责：规定 plan-checker / proposal-challenge-review 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：`execution` 面方案拍板前，对 wheel-discovery 对比表与推荐方案做成本挑战，在用户看到对比表之前完成，至多两轮。使用 `node ops/tools/dispatch_prepare.mjs --seed-template` 生成骨架。

### 固定包头

```yaml task_package_agent
agent:
  role: plan-checker
  runtime_role: plan-checker
  capability:
    name: proposal-challenge-review
    file: ops/agent-prompts/plan-checker/proposal-challenge-review.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/plan-checker/proposal-challenge-review.md
```

MUST: 将以上固定值逐字写入 `task_package.agent`。

### 差异卡（最小种子真源）

```json route_card
{
  "dispatch_phase": {"kind": "workflow", "step": "alignment S3"},
  "applies_to": "execution 面方案拍板前、用户看到之前，对 wheel-discovery 对比表与推荐方案的成本挑战（至多两轮）",
  "model_tier": "",
  "report_dir": "notes/verify",
  "slot": "proposal_challenge",
  "required": [
    {"path": "goal", "hint": "写明推荐方案（对比表中的哪一行、怎么接入）和 review_round；第二轮写明第一轮 verdict 与 owner 后续选择", "example": "挑战 demo execution 面推荐方案『接入 markdown-it-py 渲染预览』的路线成本（review_round 1）"},
    {"path": "scope.read", "hint": "列入仓根 . 以授权整仓取证，并列入 wheel-discovery 报告、规格书和 discussion log", "example": [".", "notes/research/demo-wheel-discovery.md", "notes/context/demo-alignment.md", "notes/context/demo-discussion-log.md"]},
    {"path": "alignment.state_ref", "hint": "写入对齐规格书；使用 project_positioning.canonical_refs 时改用完整种子", "example": "notes/context/demo-alignment.md"},
    {"path": "contract.wheel_report", "hint": "wheel-discovery 报告路径，含对比表、「自己写」基线与推荐", "example": "notes/research/demo-wheel-discovery.md"},
    {"path": "contract.user_constraints", "allow_empty": true, "hint": "S1 采访中坑点问题的回答：用户已知的坑、偏好与红线；用户答没有时填 []", "example": ["不引入 Python 以外的运行时"]}
  ],
  "optional": [
    {"path": "slug", "hint": "报告短名，建议 <target>-execution-challenge-r<round>"}
  ],
  "seed_defaults": {
    "runtime_context": {"network_needed": "yes"},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["verdict", "decision_summary", "alternative_comparison", "feasibility_exposure", "evidence_refs"], "business_gate": "business_verdict"},
    "tool_contract": {"network_allowed": true, "install_allowed": false},
    "handoff_contract": {"accept_verdicts": ["pass", "fail", "needs_owner"]}
  }
}
```

### 构包动作

1. 从 review 状态读取本轮次，把推荐方案和 `review_round` 写入 `goal`；第二轮同时写入第一轮 verdict 与 owner 后续选择。
2. 把仓根 `.`、wheel-discovery 报告、规格书和 discussion log 列入 `scope.read`，让 reviewer 在同一 owner 边界内取得仓内证据。
3. 把 wheel-discovery 报告路径写入 `contract.wheel_report`，把 S1 采访中坑点问题的回答写入 `contract.user_constraints`。
4. 报告中的待实测项由主代理另派 `executor-agent / scoped-execution` 做 `local_probe`；本能力只读取证据并写报告与 handoff。

BLOCK IF: 规格书、wheel-discovery 报告、推荐方案或 review round 缺失。补齐后重试；无法补齐时构造可识别缺口的任务并接受 `needs_owner`。

## 回执接收

读取 `FINAL_HANDOFF.output.business_verdict`，并核对 `challenge_binding.surface=execution`、`challenge_binding.review_round` 与任务包一致，以及 `decision_summary`、`alternative_comparison`、`feasibility_exposure`、`evidence_refs` 四段完整；`decision_summary` 含 `summary`、`basis`、`unresolved`、`owner_decisions` 四个键。

`needs_owner` 必须只承载一个会改变技术路线、成本承诺或用户可见结果的价值取舍问题。输出不满足该边界时，修正合同后按同一轮重试。
