# docs-agent / documentation-authoring 派发规范

> 职责：规定 docs-agent / documentation-authoring 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：把已确认的设计结论、运行证据、规则变更或操作流程沉淀为控制仓或 `runtime_context.target_repo` 的长期正式文档（含 alignment A7 `dispatch_docs` 出站）。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。

### 固定包头

```yaml task_package_agent
agent:
  role: docs-agent
  runtime_role: docs-agent
  capability:
    name: documentation-authoring
    file: ops/agent-prompts/docs-agent/documentation-authoring.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/docs-agent/documentation-authoring.md
```

将以上固定值逐字写入 `task_package.agent`，保持字段名和路径一致。

### 差异卡（最小种子真源）

本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "已确认材料沉淀为正式文档",
  "model_tier": "",
  "report_dir": "docs",
  "slot": "documentation_authoring",
  "required": [
    {"path": "goal", "hint": "要沉淀的正式文档目标", "example": "把已确认的派发工具链设计结论沉淀为正式架构文档"},
    {"path": "scope.read", "hint": "只列本次允许使用的来源文件、报告、回执或已确认材料", "example": ["notes/explorer/20260825-pi-debug-repo-recon.md", "notes/handoffs/pkg-executor-agent-scoped-execution-20260828T014642Z-af5ce8e7.md"]},
    {"path": "slug", "hint": "缺省 docs 目标的路径名，可含子目录，如 guides/setup；README 等根文档用 contract.target_doc_path 明确指定", "example": "architecture/dispatch-toolchain"},
    {"path": "contract.doc_type", "enum": ["architecture", "operations", "decisions", "migrations", "usage", "review", "dependencies", "modules"], "hint": "文档类型"},
    {"path": "contract.source_refs", "hint": "本次使用的来源文件、报告或回执路径，必须全部列入 scope.read", "example": ["notes/explorer/20260825-pi-debug-repo-recon.md", "notes/handoffs/pkg-executor-agent-scoped-execution-20260828T014642Z-af5ce8e7.md"]},
    {"path": "contract.confirmed_decisions", "hint": "已确认结论列表，每条必须能回溯到 source_refs", "example": ["派发工具链以 route 差异卡作为最小种子真源，结论见地形图报告"]},
    {"path": "contract.audience", "hint": "目标读者", "example": "维护派发工具链的开发者"},
    {"path": "contract.status", "enum": ["accepted", "superseded", "draft_for_owner_review"], "hint": "确认状态；draft_for_owner_review 按等待用户确认的草案呈现"}
  ],
  "optional": [
    {"path": "scope.write_extra", "hint": "目标文档在 runtime_context.target_repo 时，把目标绝对路径列入这里", "example": ["<target-repo>/docs/openai-current-contract.md"]},
    {"path": "contract.target_doc_path", "hint": "目标文档路径；缺省为控制仓 docs/<slug>.md；非缺省位置使用绝对路径并列入 scope.write_extra", "example": "<target-repo>/README.md"},
    {"path": "contract.required_sections", "hint": "有指定章节时填写列表；省略时由文档代理按用途和读者组织正文", "example": ["概览", "使用方法"]},
    {"path": "known_facts", "hint": "只补额外背景，默认空；不重复 confirmed_decisions，推测和过程材料留在来源报告"}
  ],
  "contract_defaults": {
    "target_doc_path": "$report_path",
    "required_sections": []
  },
  "seed_defaults": {
    "inputs": {"files": "$contract.source_refs"},
    "scope": {"out_of_scope": []},
    "expected_output": {"file_path": "$contract.target_doc_path", "required_sections": "$contract.required_sections"},
    "handoff_contract": {"accept_verdicts": ["done", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- 把关键确认结论写入 `confirmed_decisions`，引用 `source_refs` 中的确认记录；`known_facts` 仅补额外背景，不重复结论。需要先产生外部事实、本地结构、实现证据或规则裁决时，先取得对应能力的报告，再把已确认结果交给本文档能力。
- 有指定结构时填写 `required_sections`；省略时投影为空列表，由文档代理组织正文。`doc_type`、`status` 保持必填，不自动补值。
- 目标文档在目标仓或缺省 `docs/<slug>.md` 之外时，同时填写 `runtime_context.target_repo`（跨仓时）、`contract.target_doc_path` 和 `scope.write_extra`。让 `expected_output.file_path`、回执 `output.file_path` 和正式文档共同指向该目标路径。

## 回执接收

先核对 `FINAL_HANDOFF` 结构、报告路径和机械自检；仅在任务声明了 `required_sections` 时逐项核对指定章节，省略章节要求仍须交付正式正文。再读取 `output.documentation_gate`：`pass→done`、`needs_owner→needs_owner`、`fail→failed`。接收时确认 `output.doc_type`、`output.target_doc_path`、`output.source_refs` 与任务包一致，`output.file_path` 等于 `target_doc_path`，`output.confirmed_decisions_used` 覆盖实际写入的确认结论。来源、archive 点名证据或 gate 映射不一致时返回该 lane 修正后重试。
