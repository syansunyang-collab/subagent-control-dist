# explorer-agent / runtime-env-scan 派发规范

> 职责：规定 explorer-agent / runtime-env-scan 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：需要扫描本机软件、工具链、PATH、WSL、项目依赖入口或版本可用性。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。
## 构包规则
### 固定包头
```yaml task_package_agent
agent:
  role: explorer-agent
  runtime_role: explorer-agent
  capability:
    name: runtime-env-scan
    file: ops/agent-prompts/explorer-agent/runtime-env-scan.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/explorer-agent/_explorer-common.md
    - ops/agent-prompts/explorer-agent/runtime-env-scan.md
```
将以上固定值逐字写入 `task_package.agent`，保持字段名和路径一致。
### 差异卡（最小种子真源）
本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。
```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "本机软件、工具链、PATH、WSL、依赖、版本",
  "model_tier": "",
  "report_dir": "notes/explorer",
  "slot": "explorer_runtime",
  "required": [
    {"path": "goal", "hint": "本次要确认的运行环境问题", "example": "确认本机能否直接调用 node、npm 和 git 跑前端构建"},
    {"path": "scope.read", "hint": "列出项目依赖描述文件、配置文件和获准查询的环境对象", "example": ["package.json", "package-lock.json"]},
    {"path": "contract.environment_targets", "hint": "限定运行面，取 windows、wsl、project 等", "example": ["windows", "project"]},
    {"path": "contract.tools_to_check", "hint": "要逐项核验的具体命令清单", "example": ["git", "node", "npm"]}
  ],
  "input_defaults": {"contract.question": "$goal"},
  "optional": [
    {"path": "contract.question", "hint": "省略使用goal；明确不同问题时填写", "example": "node、npm、git是否可直接调用"},
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "contract.software_to_check", "hint": "MATLAB、CUDA、Docker、CMake 等软件清单，默认空数组"},
    {"path": "contract.path_checks", "hint": "只能列 PATH、project_local_bin、wsl_path 或任务指定入口，默认只查 PATH"},
    {"path": "known_facts", "hint": "子代理需要的当前事实清单，默认空"}
  ],
  "contract_defaults": {
    "software_to_check": [],
    "path_checks": ["PATH"],
    "no_install": true,
    "no_config_change": true
  },
  "seed_defaults": {
    "inputs": {"question": "$contract.question"},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["TL;DR", "Runtime Surface", "Tool Availability", "Software And Path Checks", "Project Dependency Entrypoints", "Runtime Impact", "未覆盖范围"]},
    "handoff_contract": {"accept_verdicts": ["done", "partial", "needs_owner", "failed"]}
  }
}
```
## 回执接收
- 每个列明目标都已归类时接收 `FINAL_HANDOFF.verdict=done`，包括工具缺失、来源冲突或运行面不可用结果；仅在检查超时、输出截断、命中明确预算或存在明确未覆盖目标时接收 `partial`，且必须带 `coverage` 和 `overflow_reason`；缺少任务输入或权限时接收 `needs_owner`；扫描或写入失败时接收 `failed`。
- `env_scan_ref` 与 `available_tools`、`available_with_explicit_path_tools`、`missing_tools`、`ambiguous_tools` 四类工具状态列表及 `runtime_impact` 必须齐备并与报告一致；每个工具结论必须有命令、路径或文件证据。
- 按现场证据保留工具的 `missing` 或 `ambiguous` 状态；把安装或配置动作写入 `runtime_impact.needs_user_confirmation`。
