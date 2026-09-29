# verify-agent / prompt-bloat-inspection 派发规范

> 职责：规定 verify-agent / prompt-bloat-inspection 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：审查 `AGENTS.md`、workflow、policy、protocol 或 agent-prompt 是否存在膨胀、责任重复、受众错配、上下文污染、真源漂移、示例过专或对抗压力不足。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。

### 固定包头

```yaml task_package_agent
agent:
  role: verify-agent
  runtime_role: verify-agent
  capability:
    name: prompt-bloat-inspection
    file: ops/agent-prompts/verify-agent/prompt-bloat-inspection.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/_review-common.md
    - ops/agent-prompts/verify-agent/prompt-bloat-inspection.md
```

以上字段按固定值原样写入 `task_package.agent`；角色、能力名和路径以本块为准。

### 差异卡（最小种子真源）

本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "提示词膨胀、重复、污染或漂移审查",
  "model_tier": "",
  "report_dir": "notes/verify",
  "slot": "prompt_bloat_inspection",
  "required": [
    {"path": "goal", "hint": "使用中立描述点明膨胀、重复、污染或错层的审查范围", "example": "审查 AGENTS.md 是否存在膨胀、重复、污染或真源漂移"},
    {"path": "scope.read", "hint": "必须含全部 target_files 和 downstream_truth_sources", "example": ["AGENTS.md", "ops/protocols/task-package.md"]},
    {"path": "contract.target_files", "hint": "被审规则文件，必须落在 scope.read 内", "example": ["AGENTS.md"]},
    {"path": "contract.downstream_truth_sources", "hint": "用于判断归属和漂移的真源文件，必须落在 scope.read 内", "example": ["ops/protocols/task-package.md"]},
    {"path": "contract.inspection_focus", "hint": "本次检查面，取 bloat | duplicate_rule | wrong_audience | context_pollution | source_drift 的组合", "example": ["bloat", "duplicate_rule", "wrong_audience", "context_pollution", "source_drift"]}
  ],
  "optional": [
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "known_facts", "hint": "子代理需要的当前事实清单，默认空"},
    {"path": "contract.mechanical_checks", "hint": "可选机械事实命令；每项含 id、argv、cwd"}
  ],
  "contract_defaults": {
    "output_report": "$report_path"
  },
  "seed_defaults": {
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["Verdict", "Findings", "Evidence Gaps", "Scope"], "business_gate": "prompt_bloat_gate"},
    "handoff_contract": {"accept_verdicts": ["done", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- `scope.write` 枚举本次审查报告、handoff 和其他显式写入路径。
- 用户明确要求同时审模板副本时，把模板副本显式加入 `target_files` 和 `scope.read`。
- 需要覆盖示例过专、跨层判定口径泄漏、对抗压力不足或规则质量审查错层时，写入 `goal`、`expected_output.required_sections` 或报告要求，不扩展 `inspection_focus` 枚举。
- 仅在目标依赖当前在线文档、外部规范或版本事实时启用联网：把 `runtime_context.network_needed` 改为 `yes`，把 `tool_contract.network_allowed` 设为 `true`，使用当前已启用的联网工具；其余任务保持断网。

## 回执接收

业务状态读取 `FINAL_HANDOFF.output.prompt_bloat_gate`；`FINAL_HANDOFF.verdict` 只表示审查任务是否完成。`prompt_bloat_gate=pass | fail` 均对应 `verdict=done`，gate=fail 的合格回执按目标达成吸收，后续业务按未通过处理；输入、范围、真源、授权或任务对象不足对应 `verdict=needs_owner` 且 `prompt_bloat_gate=needs_owner`。

能力特有核对：`prompt_bloat_gate`、findings 数量和最高评分与报告一致。
