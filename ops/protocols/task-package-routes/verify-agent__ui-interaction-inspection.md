# verify-agent / ui-interaction-inspection 派发规范

> 职责：规定 verify-agent / ui-interaction-inspection 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：执行完成后验收 Web、桌面、GUI、交互式报告、界面控件、用户操作路径、加载/空/错误/成功/禁用状态、响应式布局、视觉层级、文案或 UI 设计合约。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。界面能否被识别、操作、给出反馈并兑现已确认样稿由本能力判断；业务计算、持久化结果或产物内容需要另一种判据时，另派 `verify-agent / functional-inspection`，两者可共用同一次操作证据。

### 固定包头

```yaml task_package_agent
agent:
  role: verify-agent
  runtime_role: verify-agent
  capability:
    name: ui-interaction-inspection
    file: ops/agent-prompts/verify-agent/ui-interaction-inspection.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/_review-common.md
    - ops/agent-prompts/verify-agent/ui-interaction-inspection.md
    - ops/skills/tool-ui-design/SKILL.md
```

以上字段按固定值原样写入 `task_package.agent`；角色、能力名和路径以本块为准。

### 差异卡（最小种子真源）

本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "UI 交互、视觉合约、主路径、控件、响应式或截图",
  "model_tier": "",
  "model_requirements": ["vision"],
  "report_dir": "notes/verify",
  "slot": "ui_interaction_inspection",
  "required": [
    {"path": "goal", "hint": "使用中立描述点明界面入口、操作路径、状态覆盖和视觉合约的检查目标", "example": "检查清洗结果浏览页的入口、主路径、状态覆盖和视觉合约是否真实成立"},
    {"path": "scope.read", "hint": "覆盖 source_refs、UI 合约来源、真实入口、待检查页面或组件、样式实现、运行说明和已有产物路径", "example": ["docs/requirements.md", "src/ui/"]},
    {"path": "scope.write_extra", "hint": "授权固定证据根目录；route 按 package_id 生成 work_dir，构包器把本授权投影到 scope.write 和写冲突键", "example": ["test-results/ui-interaction-inspection/"]},
    {"path": "contract.inspection_target", "hint": "被审界面、页面、窗口、报告或组件", "example": "清洗结果浏览页"},
    {"path": "contract.source_refs", "hint": "用户需求、alignment context、PLAN 或执行目标原文", "example": ["docs/requirements.md"]},
    {"path": "contract.ui_entrypoints", "hint": "结构化真实入口：target 是 URL 或窗口名，start_command 是可选应用启动命令；驱动发现、探活和替代选择由 verifier 完成", "example": {"target": "http://127.0.0.1:8000/", "start_command": "python src/ui/app.py"}}
  ],
  "optional": [
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "contract.screens_or_components", "hint": "可省略；省略时 verifier 从 source_refs、已确认样稿与 scope 定位本次页面、窗口或区域", "example": ["结果列表页", "详情面板"]},
    {"path": "contract.interaction_paths", "hint": "可省略；省略时按 source_refs 与样稿推出用户主路径和关键动作", "example": ["选择输入文件 -> 执行清洗 -> 查看结果 -> 导出报告"]},
    {"path": "contract.state_scenarios", "hint": "可省略；省略时只覆盖本次改动涉及的真实状态，不套用全状态清单", "example": ["加载", "空", "错误", "成功", "数据加载后"]},
    {"path": "contract.viewport_requirements", "hint": "可省略；省略时覆盖该界面常用窗口尺寸，并在报告写明", "example": ["1280x800", "375x667"]},
    {"path": "contract.implementation_refs", "hint": "可省略；省略时从 scope.read 中的界面实现定位", "example": ["src/ui/views/results.py"]},
    {"path": "contract.ui_contract_refs", "hint": "product_experience.ui_design_contract、设计规格或 UI 合约；缺省按差异卡默认 null"},
    {"path": "contract.artifact_paths", "hint": "已有截图、报告、导出物或 UI 产物路径；缺省按差异卡默认空列表"},
    {"path": "contract.design_system_refs", "hint": "组件配置、样式配置、设计系统文档或既有组件路径"},
    {"path": "contract.registry_safety_refs", "hint": "第三方组件块、来源、查看记录或用户批准证据"},
    {"path": "contract.subject_confirmation_points", "hint": "需要用户或领域负责人确认的视觉、品牌、手感或主观质量点"}
  ],
  "contract_defaults": {
    "ui_contract_refs": null,
    "artifact_paths": [],
    "work_dir": "test-results/ui-interaction-inspection/$package_id/"
  },
  "seed_defaults": {
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["Verdict", "Findings", "Evidence Gaps", "Scope"], "business_gate": "ui_interaction_gate"},
    "tool_contract": {"install_allowed": true},
    "handoff_contract": {"accept_verdicts": ["done", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- 结合 `model_requirements: [vision]` 与模型笔记选择模型，视觉需求不触发名单准入检查。
- 授权 `scope.write_extra=["test-results/ui-interaction-inspection/"]`。route 生成 `work_dir=test-results/ui-interaction-inspection/<package_id>/`，构包器把授权根投影到 `scope.write` 与 `concurrency_contract.conflict_keys.write`；报告、handoff、截图、录屏索引、命令输出和浏览器运行态均使用该 package 叶子目录。
- 提供 `ui_entrypoints.target`、可选 `start_command`、读取范围和运行授权。让 verifier 在授权范围内发现驱动、探活候选、选择替代并记录命令证据。
- 把浏览器工具的 home、用户数据、daemon 状态和日志指向 `work_dir`，收尾结束本任务启动的进程。
- 仅在验收需要官方组件行为、浏览器兼容、第三方组件来源或设计系统在线文档时启用联网：把 `runtime_context.network_needed` 改为 `yes`，把 `tool_contract.network_allowed` 设为 `true`，使用当前已启用的联网工具；其余任务保持断网。
- BLOCK IF: 证据根授权未投影到 `scope.write` 与写冲突键，生成的 work_dir 不在该授权根内，或 UI 启动授权与 executor -> verify 屏障冲突。出口：修正构包结果后重试；无法修正时返回 `needs_owner` 并点名缺口。
- 用真实入口、主路径、状态、视口和可视证据判定结果。

## 回执接收

业务状态读取 `FINAL_HANDOFF.output.ui_interaction_gate`；`FINAL_HANDOFF.verdict` 只表示验收任务是否完成。`ui_interaction_gate=pass | fail` 均对应 `verdict=done`，gate=fail 表示验收完成且 UI 存在阻断事实，按目标达成吸收，后续业务按未通过处理；`ui_interaction_gate=needs_owner` 对应 `verdict=needs_owner`；报告、截图、命令输出索引或 handoff 写入失败对应 `failed`。

能力特有接收条件：`FINAL_HANDOFF.output` 含报告路径、`ui_interaction_gate`、阻断项和截图或可视证据引用；真实 UI 证据使用截图、录屏索引或命令输出。先核对 `FINAL_HANDOFF` 结构、报告路径和机械自检。
