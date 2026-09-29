# explorer-agent / network-readiness-scan 派发规范

> 职责：规定 explorer-agent / network-readiness-scan 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：需要只读核验代理、DNS、端口、网络可达或本机监听风险。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。
## 构包规则
### 固定包头
```yaml task_package_agent
agent:
  role: explorer-agent
  runtime_role: explorer-agent
  capability:
    name: network-readiness-scan
    file: ops/agent-prompts/explorer-agent/network-readiness-scan.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/explorer-agent/_explorer-common.md
    - ops/agent-prompts/explorer-agent/network-readiness-scan.md
```
将以上固定值逐字写入 `task_package.agent`，保持字段名和路径一致。
### 差异卡（最小种子真源）
本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。
```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "代理、DNS、端口、网络可达、监听风险",
  "model_tier": "",
  "report_dir": "notes/explorer",
  "slot": "network_readiness",
  "required": [
    {"path": "goal", "hint": "要核验的网络可达、代理、DNS、端口或监听问题", "example": "确认当前网络能否直连 pypi.org，以及本机代理端口监听状态"},
    {"path": "scope.read", "allow_empty": true, "hint": "只列需要读取的现存本地配置、日志或证据路径；网络目标放 contract.network_targets，代理环境变量放 contract.proxy_expectation.env_vars；没有本地文件时填空数组", "example": []},
    {"path": "contract.network_targets", "hint": "每项必须含 host、purpose、checks；checks 只能取 dns、tcp、http_head、proxy_route", "example": [{"host": "pypi.org", "purpose": "确认依赖源可达", "checks": ["dns", "tcp", "http_head"]}]}
  ],
  "input_defaults": {"contract.question": "$goal"},
  "optional": [
    {"path": "contract.question", "hint": "省略使用goal；明确不同问题时填写", "example": "当前网络能否直连pypi.org"},
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "contract.ports_to_check", "hint": "需要 TCP 或监听核验的端口列表，默认空数组"},
    {"path": "contract.local_listening_inventory", "hint": "true 才允许输出本机监听端口摘要，默认 false"},
    {"path": "contract.proxy_expectation", "hint": "expected 取 yes|no|unknown 并列允许读取的代理环境变量，默认 unknown + 标准代理变量"},
    {"path": "known_facts", "hint": "子代理需要的当前事实清单，默认空"}
  ],
  "contract_defaults": {
    "ports_to_check": [],
    "local_listening_inventory": false,
    "proxy_expectation": {"expected": "unknown", "env_vars": ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]},
    "no_config_change": true
  },
  "seed_defaults": {
    "inputs": {"question": "$contract.question"},
    "runtime_context": {"network_needed": "yes"},
    "tool_contract": {"network_allowed": true},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["TL;DR", "Network Surface", "Target Checks", "Network Impact", "未覆盖范围"]},
    "handoff_contract": {"accept_verdicts": ["done", "partial", "needs_owner", "failed"]}
  }
}
```
### 构包要点

- 将联网需求写成 `runtime_context.network_needed=yes`，并用 `network_targets` 和 `checks` 限定访问目标；字段缺失时补正任务包后重试，无法补正时由子代理返回 `needs_owner`。

## 回执接收
- 每个授权组合都已执行并归入 `reachable | blocked | ambiguous` 时接收 `FINAL_HANDOFF.verdict=done`；检查因整任务超时、输出截断、明确预算或未覆盖目标而缺证据时接收 `partial`，并要求 `not_checked_targets`、`coverage.not_scanned` 与 `overflow_reason` 对齐；任务输入、工具、权限或 `network_needed` 不满足时接收 `needs_owner`；扫描或写入失败时接收 `failed`。
- 核对 `network_scan_ref` 以及 `reachable_targets`、`blocked_targets`、`ambiguous_targets`、`not_checked_targets` 四类状态与报告一致。`not_checked_targets` 非空时业务状态必须为 `partial`；证据或状态缺失时返回该 lane 补齐后重试。
