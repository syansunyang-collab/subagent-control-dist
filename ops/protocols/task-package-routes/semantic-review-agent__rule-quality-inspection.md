# semantic-review-agent / rule-quality-inspection 派发规范

> 职责：规定 semantic-review-agent / rule-quality-inspection 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：控制规则与模型接口文案的执行质量审查，包括源码中的工具描述、参数说明、模板、错误与通知；纯实现和普通UI文案不在此范围。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。

### 固定包头

```yaml task_package_agent
agent:
  role: semantic-review-agent
  runtime_role: semantic-review-agent
  capability:
    name: rule-quality-inspection
    file: ops/agent-prompts/semantic-review-agent/rule-quality-inspection.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/_review-common.md
    - ops/agent-prompts/semantic-review-agent/rule-quality-inspection.md
```

以上字段按固定值原样写入 `task_package.agent`；角色、能力名和路径以本块为准。

### 差异卡（最小种子真源）

本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "控制规则与模型接口文案的质量语义审查",
  "model_tier": "",
  "report_dir": "notes/verify",
  "slot": "rule_quality_inspection",
  "required": [
    {"path": "goal", "hint": "使用中立描述点明本次规则质量审查范围，结论由现场证据产生", "example": "语义审查 AGENTS.md 的规则质量门"},
    {"path": "scope.read", "hint": "必须含全部 target_files 和 `ops/skills/rule-authoring/SKILL.md`；预计检查面超出列举文件时直接声明目录根，runner 按目录包含校验 scope.reviewed", "example": ["ops/workflows/", "ops/skills/rule-authoring/SKILL.md"]},
    {"path": "contract.target_files", "hint": "被审规则或模型接口文案所在文件（可含源码），必须落在scope.read内", "example": ["AGENTS.md"]},
    {"path": "contract.inspection_focus", "hint": "本次检查面，取 deletion_test | single_direction | mechanism_priority | forced_format | soft_terms | failure_exit | prewrite_self_check 的组合", "example": ["deletion_test", "single_direction", "mechanism_priority", "forced_format", "soft_terms", "failure_exit", "prewrite_self_check"]}
  ],
  "optional": [
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "contract.truth_sources", "hint": "覆盖默认值时必须仍包含 `ops/skills/rule-authoring/SKILL.md`，且全部落在 scope.read 内"},
    {"path": "known_facts", "hint": "子代理需要的当前事实清单，默认空"},
    {"path": "contract.mechanical_checks", "hint": "可选机械事实命令；每项含 id、argv、cwd"}
  ],
  "contract_defaults": {
    "truth_sources": ["ops/skills/rule-authoring/SKILL.md"],
    "output_report": "$report_path",
    "gate_values": "pass | fail | needs_owner"
  },
  "seed_defaults": {
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["Verdict", "Findings", "Evidence Gaps", "Scope"], "business_gate": "rule_quality_gate"},
    "handoff_contract": {"accept_verdicts": ["done", "needs_owner", "failed"]}
  }
}
```

`model_tier` 是空值兼容键。`dispatch_prepare.mjs` 从 `ops/agents/semantic-review-agent.toml` 投影实际模型与 effort；route 不参与运行时选模。

### 构包要点

- `dispatch_prepare.mjs` 识别本 route 后调用 `review_evidence.attachReviewEvidence`，由该现役构包步骤投影 `extensions.review_execution.profile=semantic_review_v2` 与 material mode，再解析运行选项。
- `runtime_context.network_needed` 默认写 `no`；审查对象依赖当前在线规范或外部事实时改为 `yes`，编译器生成联网授权投影，使用当前已启用的联网工具。`bash` 继续承载任务材料授权的命令型联网动作；任务材料必须给出来源边界或检索问题。
- 按审查目标选择当前工作工具定位证据，由语义判断给出规则质量 gate；结果按注入的输出要求提交，canonical report 与 handoff 由 runner 生成。

## 回执接收

业务状态只看 `FINAL_HANDOFF.output.rule_quality_gate`，`FINAL_HANDOFF.verdict` 只表示审查任务是否完成：审查完成时写 `verdict=done` 和 `rule_quality_gate=pass | fail`；输入、范围、真源、授权或任务对象不足时两者写 `needs_owner`；任务执行或产物写入失败时才写 `verdict=failed`。

能力特有核对：`rule_quality_gate`、findings 数量和路由建议与报告一致；机械证据不替代规则质量结论。
