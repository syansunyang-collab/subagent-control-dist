# explorer-agent / codebase-scan 派发规范

> 职责：规定 explorer-agent / codebase-scan 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：需要扫描本地代码结构、引用、依赖、约定或根因周边。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。
## 构包规则
### 固定包头
```yaml task_package_agent
agent:
  role: explorer-agent
  runtime_role: explorer-agent
  capability:
    name: codebase-scan
    file: ops/agent-prompts/explorer-agent/codebase-scan.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/explorer-agent/_explorer-common.md
    - ops/agent-prompts/explorer-agent/codebase-scan.md
```
将以上固定值逐字写入 `task_package.agent`，保持字段名和路径一致。
### 差异卡（最小种子真源）
本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。
```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "本地代码结构、引用、依赖、约定或根因",
  "model_tier": "",
  "report_dir": "notes/explorer",
  "slot": "explorer",
  "required": [
    {"path": "goal", "hint": "本次扫描要回答的一句话问题", "example": "哪些模块引用了 config.PROXY，引用方式是什么"}
  ],
  "input_defaults": {"scope.read": ["."], "contract.scan_mode": "terrain_map", "contract.question": "$goal", "contract.focus": "mixed"},
  "optional": [
    {"path": "contract.focus", "enum": ["structure", "dependencies", "conventions", "concerns", "mixed"], "hint": "扫描关注面；省略为 mixed，显式值优先"},
    {"path": "scope.read", "hint": "省略为已绑定项目的 '.'；显式路径优先，不增加写删授权", "example": ["src/", "config/"]},
    {"path": "contract.scan_mode", "enum": ["terrain_map", "slice_scan"], "hint": "省略为terrain_map；显式值优先，不按路径形状推测slice_scan", "example": "terrain_map"},
    {"path": "contract.question", "hint": "省略使用goal；不同问题可显式填写", "example": "哪些模块引用了config.PROXY"},
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "contract.depth_limit", "hint": "任务有明确资源边界时填写；缺省覆盖完整 scope.read"},
    {"path": "known_facts", "hint": "子代理需要的当前事实清单，默认空"}
  ],
  "contract_defaults": {
    "scope_paths": "$scope_read",
    "depth_limit": null
  },
  "seed_defaults": {
    "inputs": {"question": "$contract.question"},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["TL;DR", "详细发现", "已扫描清单", "未覆盖范围"]},
    "handoff_contract": {"accept_verdicts": ["done", "partial", "needs_owner", "failed"]}
  }
}
```
### 构包要点
- 扫描目标不是当前仓、但被用户明确作为本次扫描对象时，必须在 `runtime_context.target_repo` 写目标仓绝对路径；该字段只解释扫描对象和相对读取路径，不改变写入根。`scope.write`、`expected_output.file_path` 和 `handoff_contract.handoff_file` 均按 `runtime_context.output_root` 解释，跨仓 file 模式下任务包必须要求 `FINAL_HANDOFF.output` 同时写父仓相对路径和绝对解析路径。
## 回执接收
- 全部目标已有证据状态时接收 `FINAL_HANDOFF.verdict=done`；仅在命中 `depth_limit`、输出截断、检查超时或存在明确未覆盖目标时接收 `partial`；缺输入、缺权限或 scope 不清时接收 `needs_owner`；写入或扫描失败时接收 `failed`。
- `partial` 必须带 `coverage.scanned`、`coverage.not_scanned`、`overflow_reason` 和 `next_focus`（每项含 `lane_id`、`scope_paths`、`question`，作为下一轮 slice_scan 的切片来源）；缺 `coverage` 或 `next_focus` 时只能消费已清楚分界的部分。
- 用真实 `file:line` 支撑每条发现；跨仓模式同时核对 `output.target_repo`、`output.resolved_file_path` 和 `output.resolved_handoff_file`。证据或字段缺失时返回该 lane 补齐后重试。
