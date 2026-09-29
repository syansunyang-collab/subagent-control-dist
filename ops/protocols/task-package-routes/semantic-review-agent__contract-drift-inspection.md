# semantic-review-agent / contract-drift-inspection 派发规范

> 职责：规定 semantic-review-agent / contract-drift-inspection 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：控制面改动涉及字段、取值、闭集、机制声明与消费、工具接口时的跨文件契约一致性审查；机制退场后的残留清扫核对。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。

### 固定包头

```yaml task_package_agent
agent:
  role: semantic-review-agent
  runtime_role: semantic-review-agent
  capability:
    name: contract-drift-inspection
    file: ops/agent-prompts/semantic-review-agent/contract-drift-inspection.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/_review-common.md
    - ops/agent-prompts/semantic-review-agent/contract-drift-inspection.md
```

以上字段按固定值原样写入 `task_package.agent`；角色、能力名和路径以本块为准。

### 差异卡（最小种子真源）

本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "跨文件契约一致性审查：字段/值域/机制、退场残留，以及工具可见说明与schema/实现的一致性",
  "model_tier": "",
  "report_dir": "notes/verify",
  "slot": "contract_drift_inspection",
  "required": [
    {"path": "goal", "hint": "使用中立描述点明本次要核对的改动和契约面，结论由现场证据产生", "example": "核对 hook 派发退役改动在六层（workflow/schema/提示词/route/工具/fixture）的契约一致性与残留"},
    {"path": "scope.read", "hint": "列明全部target_files及声明、实际可见投影和实现的取证范围；按声明的读面取证", "example": ["ops/workflows/", "ops/tools/", "AGENTS.md"]},
    {"path": "contract.target_files", "hint": "被审改动涉及的文件，必须落在 scope.read 内", "example": ["ops/workflows/planning/execution-gate.md", "ops/tools/planning_manifest_check.py"]},
    {"path": "contract.change_summary", "hint": "一句话说明改动性质：新增机制/修改字段/机制退场/值域调整", "example": "deletion_test 疤痕机制从运行态退场"}
  ],
  "optional": [
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "contract.retired_mechanisms", "hint": "本次退场的机制名或标识符清单；默认空，空时不产生残留清扫维度结论"},
    {"path": "known_facts", "hint": "子代理需要的当前事实清单，默认空"},
    {"path": "contract.mechanical_checks", "hint": "可选机械取证命令；每项含 id、argv、cwd"}
  ],
  "contract_defaults": {
    "retired_mechanisms": [],
    "output_report": "$report_path",
    "gate_values": "pass | fail | needs_owner"
  },
  "seed_defaults": {
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["Verdict", "Findings", "Evidence Gaps", "Scope"], "business_gate": "contract_drift_gate"},
    "handoff_contract": {"accept_verdicts": ["done", "needs_owner", "failed"]}
  }
}
```

`model_tier` 是空值兼容键。`dispatch_prepare.mjs` 从 `ops/agents/semantic-review-agent.toml` 投影实际模型与 effort；route 不参与运行时选模。

### 构包要点

- `target_files` 完整列出同一审查问题的主审对象；材料容量按 `ops/protocols/subagent-information-injection.md` §3 处理，不因文件数量拆任务。独立审查问题仍按问题边界分片。
- `dispatch_prepare.mjs` 识别本 route 后调用 `review_evidence.attachReviewEvidence`，由该现役构包步骤投影 `extensions.review_execution.profile=semantic_review_v2` 与 material mode，再解析运行选项。
- `runtime_context.network_needed` 固定 `no`；契约核对全部在仓内完成。
- 使用 grep、`--help` 等只读机械取证定位事实；每条 finding 补充语义裁决，gate 以语义影响为依据。
- 按本次需要核对的退场对象填写 `contract.retired_mechanisms`；省略时默认 `[]`，为空时不产生残留清扫维度结论，其余已声明契约面照常核对。

## 回执接收

业务状态只看 `FINAL_HANDOFF.output.contract_drift_gate`，`FINAL_HANDOFF.verdict` 只表示审查任务是否完成：审查完成时写 `verdict=done` 和 `contract_drift_gate=pass | fail`；输入、范围或任务对象不足时两者写 `needs_owner`；任务执行或产物写入失败时才写 `verdict=failed`。

能力特有接收条件：每条 finding 的 `evidence_refs` 同时包含声明侧与消费侧证据，`impact` 写出语义影响；`contract_drift_gate` 完整；`identifiers_enumerated` 与 `identifiers_checked` 是去重的精确标识符字符串数组。gate=pass 时枚举数组非空且两者集合相同；覆盖不全时使用 `needs_owner` 并列明未检查项。
