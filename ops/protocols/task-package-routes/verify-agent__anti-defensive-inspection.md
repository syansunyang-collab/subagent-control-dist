# verify-agent / anti-defensive-inspection 派发规范

> 职责：规定 verify-agent / anti-defensive-inspection 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：审查代码、说明、注释或提示词中的防御性编程、兜底、吞异常、默认值、空值处理、软化描述、过度防御、不崩行为，以及编译器、运行时和Pi适配器的拒发必要性。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。本能力不接收 planning 的 PLAN、`dispatch_manifest` 或planning执行准入审查任务；这类缺口由 planning P1C、P5 和 `planning_manifest_check.py` 处理。

### 固定包头

```yaml task_package_agent
agent:
  role: verify-agent
  runtime_role: verify-agent
  capability:
    name: anti-defensive-inspection
    file: ops/agent-prompts/verify-agent/anti-defensive-inspection.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/_review-common.md
    - ops/agent-prompts/verify-agent/anti-defensive-inspection.md
```

以上字段按固定值原样写入 `task_package.agent`；角色、能力名和路径以本块为准。

### 差异卡（最小种子真源）

本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "反防御、兜底、吞异常、软化、自动重派，以及编译器、运行时、Pi适配器拒发必要性",
  "model_tier": "",
  "report_dir": "notes/verify",
  "slot": "anti_defensive_inspection",
  "required": [
    {"path": "goal", "hint": "使用中立描述点明防御性兜底、吞异常、静默 fallback、软化表达或拒发必要性的审查范围", "example": "审查 src/main.py 中的防御性兜底、吞异常和软化表达"},
    {"path": "scope.read", "hint": "必须覆盖全部 target_files；只列被审文件，不默认带归档目录或旧审查报告", "example": ["src/main.py"]},
    {"path": "contract.target_files", "hint": "被审文件清单，必须落在 scope.read 内", "example": ["src/main.py"]},
    {"path": "contract.inspection_targets", "hint": "被审对象类型，取 code | docs | comments | prompts 的一项或多项", "example": ["code"]}
  ],
  "optional": [
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "known_facts", "hint": "子代理需要的当前事实清单，默认空"},
    {"path": "contract.mechanical_checks", "hint": "可选机械事实命令；每项含 id、argv、cwd"}
  ],
  "contract_defaults": {
    "output_report": "$report_path",
    "gate_values": "pass | fail | needs_owner"
  },
  "seed_defaults": {
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["Verdict", "Findings", "Evidence Gaps", "Scope"], "business_gate": "anti_defensive_gate"},
    "handoff_contract": {"accept_verdicts": ["done", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- `scope.write` 枚举本次审查报告、handoff 和其他显式写入路径。
- 本能力产出语义审查报告和 handoff。脚本、探针与测试工具由对应验证能力负责；本能力只按 `ops/policies/test-tooling-governance.md` 评估其落盘准入。
- 仅在目标依赖当前在线规范或外部事实时启用联网：把 `runtime_context.network_needed` 改为 `yes`，编译器生成联网授权投影，使用当前已启用的联网工具；其余任务保持断网。
- 把防御性模式与拒发必要性作为审查维度。worker的具体判据由能力提示词承载。

## 回执接收

业务状态读取 `FINAL_HANDOFF.output.anti_defensive_gate`；`FINAL_HANDOFF.verdict` 只表示审查任务是否完成。`anti_defensive_gate=pass | fail` 均对应 `verdict=done`，gate=fail 的合格回执按目标达成吸收，后续业务按未通过处理；输入、范围、真源、授权或任务对象不足对应 `verdict=needs_owner` 且 `anti_defensive_gate=needs_owner`。

能力特有核对：`anti_defensive_gate`、findings 数量和报告结论一致；语义判断吸收机械证据后给出 gate。
