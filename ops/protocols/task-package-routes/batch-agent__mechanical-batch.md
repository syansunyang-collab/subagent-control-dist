# batch-agent / mechanical-batch 派发规范

> 职责：规定 batch-agent / mechanical-batch 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：文件清单可枚举、同一操作族、规则明确的机械处理。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。

### 固定包头

```yaml task_package_agent
agent:
  role: batch-agent
  runtime_role: batch-agent
  capability:
    name: mechanical-batch
    file: ops/agent-prompts/batch-agent/mechanical-batch.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/batch-agent/mechanical-batch.md
```

### 差异卡（最小种子真源）

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "文件清单可枚举、同一操作族、规则明确的机械批处理",
  "model_tier": "",
  "report_dir": "notes/general",
  "slot": "batch",
  "required": [
    {"path": "goal", "hint": "写一个单一机械操作目标；业务判断、根因分析和跨模块改造使用对应专职 route", "example": "把 src/app.py 中的配置键 OLD_KEY 逐字替换为 NEW_KEY"},
    {"path": "scope.read", "hint": "必须覆盖 scope_manifest 点名的全部文件", "example": ["src/app.py"]},
    {"path": "scope.write_extra", "hint": "本次允许修改或创建的业务文件清单", "example": ["src/app.py"]},
    {"path": "contract.operation_type", "enum": ["translate", "replace", "normalize", "metadata_fill", "move_files", "simple_edit"], "hint": "单一操作族；一次任务只允许一个", "example": "replace"},
    {"path": "contract.exact_rules", "hint": "明确转换规则；规则不清会触发 needs_owner", "example": ["将 src/app.py 中的 OLD_KEY 逐字替换为 NEW_KEY", "规则未覆盖的内容保持原样"]},
    {"path": "contract.scope_manifest", "hint": "完整文件清单或可枚举目录；文件数量本身不构成拒收条件", "example": ["src/app.py"]},
    {"path": "contract.write_mode", "enum": ["in_place", "new_files"], "hint": "写入模式"},
    {"path": "contract.chunk_strategy", "enum": ["by_file", "by_heading", "by_line_range", "fixed_chars"], "hint": "任一可观察预算超限时的分块策略"},
    {"path": "contract.chunk_budget", "hint": "每个 chunk 的可观察上限，必须含正整数 max_files、max_bytes、max_lines", "example": {"max_files": 6, "max_bytes": 200000, "max_lines": 4000}},
    {"path": "contract.verification_checks", "hint": "可执行的轻量检查", "example": ["确认 src/app.py 不再包含 OLD_KEY", "确认替换后文件行数不变"]},
    {"path": "contract.stop_conditions", "hint": "停止并返回 needs_owner、needs_split 或 failed 的条件", "example": ["规则与文件内容冲突时停止并返回 needs_owner", "超出单次输入预算时返回 needs_split"]}
  ],
  "optional": [
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "scope.delete", "hint": "只有 operation_type=move_files 且用户明确允许删除或搬移源文件时才非空"},
    {"path": "known_facts", "hint": "子代理需要的当前事实清单，默认空"}
  ],
  "seed_defaults": {
    "inputs": {"files": "$contract.scope_manifest"},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["Operation", "Verdict", "Budget", "Manifest", "Verification Checks", "Remaining Manifest", "Files Touched"]},
    "handoff_contract": {"accept_verdicts": ["done", "partial", "needs_split", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- 构包时给完整 manifest、`chunk_strategy` 与 `chunk_budget`。执行者以 manifest 的文件数、字节数和行数分片；工具真实截断时记录已观察上限并缩小 chunk。当前任务仍无法完成时返回 `needs_split` 并附触发证据与 `remaining_manifest`；范围或规则不清时返回 `needs_owner`。

## 回执接收

`done`=全部处理完成且验证检查通过；`partial`=授权范围内部分完成且剩余项有明确原因；`needs_split`=超出预算；`needs_owner`=规则不清、字段缺失、越界或不适配；`failed`=写入失败或验证检查失败。能力特有核对：回执正文须含 Budget、Manifest、Verification Checks、Remaining Manifest 的分块结果表，`needs_split` 或 `partial` 时 `remaining_manifest` 必须存在。
