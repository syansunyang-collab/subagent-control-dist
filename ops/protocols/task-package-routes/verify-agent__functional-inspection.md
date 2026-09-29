# verify-agent / functional-inspection 派发规范

> 职责：规定 verify-agent / functional-inspection 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：执行完成后验收用户可见功能、真实产物体验、用户使用文档、报告、图像、曲线、导出物、算法结果或数据处理结果。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。UI 交互、视觉合约、界面主路径、控件状态和响应式布局按 `verify-agent / ui-interaction-inspection` 派发；代码对象、规则结构对象和防御性表达对象按各自验收能力派发。

### 固定包头

```yaml task_package_agent
agent:
  role: verify-agent
  runtime_role: verify-agent
  capability:
    name: functional-inspection
    file: ops/agent-prompts/verify-agent/functional-inspection.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/_review-common.md
    - ops/agent-prompts/verify-agent/functional-inspection.md
```

以上字段按固定值原样写入 `task_package.agent`；角色、能力名和路径以本块为准。

### 差异卡（最小种子真源）

本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "功能验收",
  "model_tier": "",
  "report_dir": "notes/verify",
  "slot": "functional_inspection",
  "required": [
    {"path": "goal", "hint": "从用户目标写出可观察的功能检查目标，结论由真实运行产生", "example": "从用户目标检查清洗结果导出功能是否真实成立"},
    {"path": "scope.read", "hint": "显式授予需求原文、真实入口、输入资产、产物路径、实现引用和必要参考资料", "example": ["docs/requirements.md", "src/export/", "output/report/"]},
    {"path": "contract.inspection_target", "hint": "被审功能、模块或产物", "example": "清洗结果导出功能"},
    {"path": "contract.source_refs", "hint": "列需求原文、alignment context 或阶段目标出处；历史报告和实现者材料只作待核证输入", "example": ["docs/requirements.md"]},
    {"path": "contract.entrypoints", "hint": "用户真实运行或打开的入口", "example": ["python src/export/cli.py --report"]},
    {"path": "contract.input_assets", "hint": "真实输入资产路径", "example": ["data/input/sample.csv"]},
    {"path": "contract.artifact_paths", "hint": "用户最终接触的产物路径", "example": ["output/report/clean-report.html"]},
    {"path": "contract.implementation_refs", "hint": "实现文件或代码引用", "example": ["src/export/report.py"]},
    {"path": "contract.work_dir", "hint": "运行证据、截图和统计表工作区，必须位于 test-results/functional-inspection/<package_id>/", "example": "test-results/functional-inspection/pkg-functional-demo/"}
  ],
  "optional": [
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "scope.write_extra", "hint": "需要保存截图、统计表、渲染图或命令输出索引时列 work_dir 对应目录"}
  ],
  "seed_defaults": {
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["Verdict", "Findings", "Evidence Gaps", "Scope"], "business_gate": "function_gate"},
    "handoff_contract": {"accept_verdicts": ["done", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- `scope.write` 枚举功能检查报告、handoff 和其他显式写入路径。
- 仅在验收需要外部事实、官方行为、算法背景或同类工具对照时启用联网：把 `runtime_context.network_needed` 改为 `yes`，把 `tool_contract.network_allowed` 设为 `true`，使用当前已启用的联网工具；其余任务保持断网。
- `concurrency_contract` 必须与读取、写入、executor -> verify 屏障和 scope ownership 相容。
- 功能 gate 使用真实入口、真实输入、用户可消费输出和业务 oracle；烟测、文件/截图存在、窗口出现或历史报告只作辅助事实。

## 回执接收

业务状态只看 `FINAL_HANDOFF.output.function_gate`；`FINAL_HANDOFF.verdict` 只表示验收任务是否完成。`function_gate=pass | fail` 均对应 `verdict=done`，gate=fail 表示验收完成且功能未通过，按目标达成吸收，后续业务按未通过处理；输入、权限、入口、产物、实现引用或工作区不足对应 `needs_owner`；报告、截图、统计表或 handoff 写入失败对应 `failed`。
能力特有核对：合格回执包含 `failed_functional_facts`、真实证据路径和运行或可视证据；任务材料含 locked decisions 时同时包含 `locked_decision_recheck`；functional-inspection 保持独立业务 gate。先核对 `FINAL_HANDOFF` 结构、报告路径和机械自检。
