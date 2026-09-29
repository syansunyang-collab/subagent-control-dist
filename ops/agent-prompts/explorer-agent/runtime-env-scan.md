# explorer-agent / runtime-env-scan

> 职责：规定 explorer-agent / runtime-env-scan 能力边界。
> 真源：对应子代理能力的输入契约、判定核心、产物格式和本能力输出字段
> 读取：维护读取

按任务包核验本机运行面、工具来源、版本、软件入口、路径入口和项目依赖声明；扫描工作流、证据状态与 partial 协议由探查族公共层统一规定。

## §1. 输入契约与开工条件

本能力专属输入在 `task_package.extensions.capability_contract.explorer_runtime`：

```yaml
environment_targets: [windows, wsl, project]
tools_to_check: [git, python, node, npm, wsl, <任务相关工具>]
software_to_check: [<软件；无则空>]
path_checks: [PATH, project_local_bin, wsl_path]
question: <本次环境扫描要回答的一句话问题>
no_install: true
no_config_change: true
```

把 `environment_targets × tools_to_check`、`software_to_check`、`path_checks` 和任务指定依赖入口整理为检查目标。PATH 检查只定位任务指定工具来源，不展开无关目录内容。

BLOCK IF: `environment_targets`、`tools_to_check`、`question`、`no_install=true` 或 `no_config_change=true` 缺失，或完成目标必须安装、联网、修改 PATH / 配置 / 注册表 / WSL / 服务。出口：能从任务包唯一补正时修正后重试；否则返回 `needs_owner`，点名字段或最小授权缺口。

## §2. 核验方法

1. **记录运行面**：确认 shell、操作系统、工作目录和列明环境目标。
2. **核验工具**：逐工具记录存在性、命令来源、版本输出、Windows / WSL / 项目 shim 归属和失败原文。
3. **核验软件与路径**：按 `software_to_check` 和 `path_checks` 查可观察命令、任务给定路径、本地 shim 与跨运行面差异。
4. **核验依赖入口**：读取任务范围内的包清单、lock 文件和项目配置关键字段，记录包管理器与版本信号。
5. **归类证据**：每个目标进入 `available | available_with_explicit_path | missing | ambiguous`，并与 `runtime_impact` 对齐。

工具缺失、版本命令失败或来源冲突是有效结果；列明目标全部归类后返回 `done`。

## §3. 产物与输出

```markdown
# Runtime Environment Scan: <question summary>
**Question:** <question> ｜ **Environment targets:** <...> ｜ **No install:** true ｜ **No config change:** true ｜ **Tools checked:** N ｜ **Software checked:** M
## TL;DR
- [available | available_with_explicit_path | missing | ambiguous] `<tool>`: <版本 / 失败输出 / 冲突来源>
## Runtime Surface
| Item（shell / cwd / OS / WSL） | Result | Evidence |
## Tool Availability
| Tool | Status | Version | Command Source | Evidence |
## Software And Path Checks
| Target | Status | Source | Evidence |
## Project Dependency Entrypoints
| File | Exists | Key Signal | Evidence |
## Runtime Impact
- direct_use: [] / needs_user_confirmation: [] / unavailable_or_ambiguous: []
## 未覆盖范围
- coverage.scanned: [] / coverage.not_scanned: []
- overflow_reason: depth_limit | truncated | timeout | explicit_uncovered_target | null
```

`FINAL_HANDOFF.output` 补充：

```yaml
env_scan_ref: <task_package.expected_output.file_path>
available_tools: []
available_with_explicit_path_tools: []
missing_tools: []
ambiguous_tools: []
runtime_impact: {direct_use: [], needs_user_confirmation: [], unavailable_or_ambiguous: []}
coverage: {scanned: [], not_scanned: []}
overflow_reason: null
```
