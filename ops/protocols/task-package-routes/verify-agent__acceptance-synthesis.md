# verify-agent / acceptance-synthesis 派发规范

> 职责：规定 verify-agent / acceptance-synthesis 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：Acceptance Contract 编译出的多维 verifier Fleet 已全部进入终态，需要 reducer 形成统一 disposition。

### 固定包头

```yaml task_package_agent
agent:
  role: verify-agent
  runtime_role: verify-agent
  capability:
    name: acceptance-synthesis
    file: ops/agent-prompts/verify-agent/acceptance-synthesis.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/_review-common.md
    - ops/agent-prompts/verify-agent/acceptance-synthesis.md
```

### 差异卡（最小种子真源）

```json route_card
{
  "dispatch_phase": {"kind": "workflow", "step": "planning P8"},
  "applies_to": "归并 Acceptance Contract 多维验收结果并输出结构化 disposition",
  "model_tier": "",
  "report_dir": "notes/verify",
  "slot": "acceptance_synthesis",
  "required": [
    {"path": "goal", "hint": "归并指定合同和轮次的全部验收结果，不预设通过", "example": "归并 p1 第 1 轮 Acceptance Contract 验收结果"},
    {"path": "scope.read", "hint": "Acceptance Contract、dispatch manifest；Fleet 在提交时追加 dependency result index 与存在的叶子报告", "example": ["notes/manifests/<phase>-acceptance-contract.yaml", "notes/manifests/<phase>-dispatch-manifest.yaml"]},
    {"path": "contract.acceptance_contract_ref", "hint": "已机械校验的 Acceptance Contract", "example": "notes/manifests/<phase>-acceptance-contract.yaml"},
    {"path": "contract.dispatch_manifest_ref", "hint": "已冻结的 dispatch manifest", "example": "notes/manifests/<phase>-dispatch-manifest.yaml"},
    {"path": "contract.acceptance_ids", "hint": "本轮必须逐项覆盖的 acceptance id 闭集", "example": ["AC-01"]},
    {"path": "contract.node_acceptance_map", "hint": "Fleet 叶子 node id 到其并桌的 acceptance id 列表（一个 route 一个叶子）", "example": {"verify-functional-inspection": ["AC-01", "AC-03"]}},
    {"path": "contract.review_round", "hint": "当前验收轮次（1..轮次预算）", "example": 1},
    {"path": "contract.max_review_rounds", "hint": "由 checker 注入的轮次预算", "example": 5}
  ],
  "optional": [
    {"path": "slug", "hint": "缺省使用 <phase>-acceptance-reducer-r<round>"},
    {"path": "contract.prior_decision_ref", "hint": "第 2 轮必填，指向第 1 轮 reducer report"},
    {"path": "contract.carried_acceptance_ids", "hint": "第 2 轮未重跑、沿用第 1 轮 pass 证据的 acceptance id；第 1 轮为空"}
  ],
  "seed_defaults": {
    "extensions": {"review_execution": {"profile": "acceptance_synthesis_v1", "result_schema": "review_result_v1", "artifact_writer": "async child runner"}},
    "scope": {"out_of_scope": []},
    "runtime_context": {"network_needed": "no"},
    "expected_output": {"required_sections": ["Verdict", "Findings", "Evidence Gaps", "Scope"], "business_gate": "acceptance_gate"},
    "handoff_contract": {"accept_verdicts": ["done", "needs_owner", "failed"]}
  }
}
```

### 构包与接收

- 本 route 只作为 `dependency_policy=all_settled` 的 reducer 节点；scheduler 把 dependency result index 置于注入读取列表首位。
- 业务状态读取 `FINAL_HANDOFF.output.acceptance_gate`：`pass | fail | needs_owner`；任务完成状态仍看 `FINAL_HANDOFF.verdict`。
- `output.disposition` 必须与 gate 对应：`pass→pass`、`fail→rework`、`needs_owner→needs_owner`。
- `acceptance_ids_considered` 必须覆盖闭集；`uncertainty.environment` 与 `uncertainty.evidence` 必须无重叠且并集等于 `coverage.uncertain`。环境型 uncertain 可进入 `rework` 并列入 confirmation；证据型 uncertain 进入 `needs_owner`。
- `rework` 给出产品失败、环境确认和回归 id；producer 结构化字段缺口使用 `needs_owner`，写入 `coverage.missing` 与 `evidence_gaps`，修复 producer 后重新合成。
