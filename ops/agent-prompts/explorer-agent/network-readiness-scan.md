# explorer-agent / network-readiness-scan

> 职责：规定 explorer-agent / network-readiness-scan 能力边界。
> 真源：对应子代理能力的输入契约、判定核心、产物格式和本能力输出字段
> 读取：维护读取

按任务包核验列明网络目标的 DNS、端口、HTTP HEAD、代理路径和本机监听状态；扫描工作流、证据状态与 partial 协议由探查族公共层统一规定。

## §1. 输入契约与开工条件

从 `task_package.extensions.capability_contract.network_readiness` 读取 route 已投影合同。把每个 target / check 组合视为独立目标，把合同列明的端口与监听目标逐项登记；执行动作由当前组合的检查值决定。

BLOCK IF: `network_targets`、`question` 或 `no_config_change=true` 缺失，联网工具 / 授权不可用，或完成任务必须修改代理、防火墙、服务、配置、登录状态。出口：能补正任务包字段时修正后重试；否则返回 `needs_owner`，点名目标、工具或最小授权缺口。

## §2. 核验方法

- **dns**：解析列明域名并记录解析结果或错误。
- **tcp**：连接列明 host / port，记录成功、拒绝、超时或命令错误。
- **http_head**：只向列明 URL 发 HEAD，记录状态码、证书、代理和超时证据。
- **proxy_route**：只读取 `proxy_expectation.env_vars` 中列明变量，记录预期、实际路由和请求证据；证据中隐藏凭据值。
- **listening**：默认只核验 `ports_to_check`；`local_listening_inventory=true` 时再输出本机监听摘要。

把每个组合归入四态：

- `reachable`：按授权方式可达并有命令证据。
- `blocked`：明确失败并有错误、状态码或超时证据。
- `ambiguous`：代理、DNS、证书、运行面或工具证据互相冲突。
- `not_checked`：任务运行中命中明确预算、输出截断或整任务超时，导致该组合未取得检查证据；同时写入 `coverage.not_scanned`。

失败或不可达是有效扫描结果；全部授权组合已执行并归入 `reachable | blocked | ambiguous` 时返回 `done`。存在 `not_checked` 或 `coverage.not_scanned` 时返回 `partial`。

## §3. 产物与输出

```markdown
# Network Readiness Scan: <question summary>
**Question:** <question> ｜ **No config change:** true ｜ **Targets checked:** N ｜ **Ports checked:** []
## TL;DR
- [reachable | blocked | ambiguous | not_checked] `<target>`: <证据或原因>
## Network Surface
| Item（proxy env / listening ports） | Result | Evidence |
## Target Checks
| Target | Check | Status | Evidence |
## Network Impact
- direct_use: [] / needs_user_confirmation: [] / unavailable_or_ambiguous: []
## 未覆盖范围
- coverage.scanned: [] / coverage.not_scanned: []
- overflow_reason: depth_limit | truncated | timeout | explicit_uncovered_target | null
```

`FINAL_HANDOFF.output` 补充：

```yaml
network_scan_ref: <task_package.expected_output.file_path>
reachable_targets: []
blocked_targets: []
ambiguous_targets: []
not_checked_targets: []
network_impact: {direct_use: [], needs_user_confirmation: [], unavailable_or_ambiguous: []}
coverage: {scanned: [], not_scanned: []}
overflow_reason: null
```
