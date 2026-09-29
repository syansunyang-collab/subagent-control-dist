# research-agent / document-scan 派发规范

> 职责：规定 research-agent / document-scan 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：需要读取本地 PDF、扫描件、图片、图表或 Office 文档的内容、读图或表格转录。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。

### 固定包头

```yaml task_package_agent
agent:
  role: research-agent
  runtime_role: research-agent
  capability:
    name: document-scan
    file: ops/agent-prompts/research-agent/document-scan.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/research-agent/document-scan.md
```

将以上固定值逐字写入 `task_package.agent`，保持字段名和路径一致。

### 差异卡（最小种子真源）

本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "本地 PDF、扫描件、图片、图表、Office 文档的内容提取、读图与表格转录",
  "model_tier": "",
  "model_requirements": ["vision"],
  "report_dir": "notes/research",
  "slot": "document",
  "required": [
    {"path": "goal", "hint": "要从文档拿到什么，一句话", "example": "读取 async cockpit 截图中的状态标签、节点关系和错误提示"},
    {"path": "scope.read", "hint": "只列允许读取的文档路径", "example": ["notes/verify/async-cockpit-current-scope.png"]},
    {"path": "contract.extraction_targets", "hint": "要回答或提取的目标，非空且互不重复", "example": ["截图有哪些任务状态标签", "当前选中节点显示哪些字段", "界面是否显示错误提示"]}
  ],
  "input_defaults": {"contract.document_paths": "$scope_read"},
  "optional": [
    {"path": "contract.document_paths", "hint": "省略使用scope.read；显式值仍须一致，不反向扩大读授权", "example": ["notes/verify/async-cockpit-current-scope.png"]},
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "contract.focus_pages", "hint": "页码或范围提示，缺省全文"},
    {"path": "known_facts", "hint": "子代理需要的当前事实清单，默认空"}
  ],
  "contract_defaults": {
    "focus_pages": ""
  },
  "seed_defaults": {
    "runtime_context": {"network_needed": "no"},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["结论前置", "逐目标发现", "无法读取部分", "页码引用清单"]},
    "handoff_contract": {"accept_verdicts": ["done", "partial", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- 按目标内容与模型笔记选择模型；`model_requirements: [vision]` 提供视觉需求信息，供主代理判断。
- 本地离线：把文档路径列入 `scope.read`；URL 来源先由 external-research 或用户取得本地文件，再派本能力。

## 回执接收

verdict 词表：`done`（全部目标已有答案或证据不足状态且报告落盘）、`partial`（输出截断、处理超时、命中明确深度预算或仍有明确目标未检查）、`needs_owner`（路径缺失、文件不可读、缺视觉能力或目标为空）、`failed`（读取或写入失败）；先核对 `FINAL_HANDOFF` 结构、报告路径和机械自检，再看能力特有核对：

- 核对回执中的页码 / 图表号引用和报告来源定位；缺引用时返回该 lane 补齐后重试。
- 让 `unreadable_parts` 与报告“无法读取部分”一致，并让标记为 `unreadable` 的数字保持不可确定状态。
