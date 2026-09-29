# agent-panel

本模块是全局 Agent Panel 的开发源码（位于 `src/agent-panel`）。生产资产由控制面发布到用户级 Pi 扩展槽，读取监控项目 `.runtime/cockpit` 的真实运行态，通过本机 loopback 服务展示任务、Fleet DAG、审查门待办和完成通知，支持带 `expected_revision` 的单任务取消，以及复用 Fleet `fleet_cancel` 的运行级结束。

页签依次为运行、角色与模型、角色资源、导入范围、模型档位、历史。四个配置页编辑以下内容：

- 角色与模型：各角色推荐行的顺序、标识、适用场景、模型、最低 / 默认 / 最高档位、任务类型与默认行，可新增与删除推荐行；任务类型条和角色头部的默认由表格派生。
- 角色资源：各角色可用的工具、插件、技能与项目技能，以及按任务类型收窄；只列出导入范围中设为可选的项目，默认开启的项目只读显示。
- 导入范围：本机 Pi 插件、工具与技能的开放方式（不开放 / 可选 / 默认开启）、显示名与工具分组；运行必需的交卷工具只改显示名。
- 模型档位：各模型的可选档位；推荐行的档位下拉只列出这些档位。

面板观察任务、取消任务、编辑上述配置，不负责派发、任务审查裁决或多仓聚合。项目仍是任务运行态的真源；面板配置真源为控制仓 `ops/agents/*.toml`、`ops/model-notes.toml` 与 `ops/templates/worker-resources.json`，保存后同步同名文件至已发现的运行槽。显示名来自控制仓 `ops/panel-labels.toml`（角色名、简介、分组、任务类型名、工具分组顺序）与导入范围文件，只由面板读取，不参与同步；缺少显示名时以灰色显示原标识。声明项目覆盖的工程仍按自身覆盖解析，面板不编辑项目覆盖。

推荐行与模型档位经 `ops/tools/dispatch-core/model_selection.mjs` 整套校验、双解析与 revision CAS 后多文件原子写回，校验错误定位到角色、推荐行与字段并拒写，警告不拒写；角色资源逐角色保存，任务类型收窄只允许收窄角色值；导入范围整文件 CAS 写回。资源候选来自控制仓 `resolveWorkerResourceCatalog`，项目技能按当前监控工程解析。模型选项通过正常 Pi RPC `get_available_models` 与 Pi 主页面同源。

## 机器前置

- Windows 环境
- Node.js 24 或更高版本（包含对应 npm）
- .NET 10 SDK
- WebView2 Runtime
- 可读取的控制仓；默认路径由模块位置解析为所属仓根

v1 不提供自包含发布包。WebView2 Runtime 缺失时，服务仍可用 `start:browser` 做开发检查，但桌面壳无法启动。

## 全局运行与源码开发

生产发布、跨仓启动和状态目录见 [运行手册](../../docs/operations/agent-panel.md)。消费项目不需要本模块源码。以下命令用于源码开发，公共 Async Core 使用已发布运行包；工作目录为 `src/agent-panel`：

```powershell
npm ci
dotnet build shell/
npm run start
```

`npm run start` 启动 .NET 桌面壳。桌面壳拥有内嵌 Node loopback 服务的生命周期；关闭面板时只清理面板自己的服务，不停止控制仓中正在运行的任务。成功信号是壳窗口打开，并且首屏显示真实任务列表或正确空态。

## 浏览器开发模式

开发期只启动服务并打开浏览器：

```powershell
npm run start:browser
```

该脚本调用 `src/server/index.mjs --browser`。服务入口、浏览器模式和桌面壳共享同一套控制仓路径、端口派生和兼容门逻辑。

## 控制仓路径

两种入口都支持命令行参数 `--control-repo <path>`。浏览器服务还接受别名 `--control-root`；命令行参数优先于环境变量。

浏览器服务入口 `start:browser` 的环境变量按以下优先级解析：

1. `AGENT_PANEL_CONTROL_REPO_PATH`；
2. `CONTROL_REPO_PATH`；
3. 默认路径：模块上两级目录，即所属仓根。

例如：

```powershell
$env:AGENT_PANEL_CONTROL_REPO_PATH = (Resolve-Path ..\..).Path
npm run start:browser
```

桌面壳入口 `start` 使用环境变量 `AGENT_PANEL_CONTROL_REPO`，也可以直接传参：

```powershell
npm run start -- --control-repo (Resolve-Path ..\..).Path
```

路径不存在、不可读或缺少预期 `.runtime` 数据时，面板显示全局阻断错误；不静默切换到其他目录，也不猜补数据。

## Loopback 端口

服务只绑定 `127.0.0.1`，不监听外部网卡，Web 静态资源不请求外部资源。模型目录查询会启动本机 Pi RPC，但不发送模型推理请求。端口只由面板模块路径派生，避免多个本地模块副本共享固定端口：

1. 取面板模块绝对路径并规范化；Windows 路径统一使用 `/` 分隔符并转小写；
2. 对规范化路径做 SHA-256；
3. 将摘要前 2 个字节按 big-endian 解释为无符号整数；
4. `port = 43000 + (整数 % 1000)`；
5. URL 固定为 `http://127.0.0.1:<port>/`。

端口范围为 `43000–43999`。同一面板资产路径始终得到同一端口，切换监控项目不改变端口。派生端口被其他进程占用时，服务报告明确错误并退出，不随机换端口，以免壳、浏览器和服务各连到不同实例。

## 运行卫生与目录边界

模块源码随控制面仓维护，生产运行与源码仓分离。模块目录保留以下产品目录和清单：

```text
README.md
src/
shell/
tests/
docs/
.gitignore
package.json
package-lock.json
```

面板本机运行产物（日志、WebView2 用户数据、构建缓存）落在用户目录的 `.subagent-control/agent-panel/`，不写进模块源码目录或监控项目。隔离测试通过 `AGENT_PANEL_STATE_ROOT` 指定独立目录。请求日志记录路径、HTTP 状态、时间戳和 handler 耗时，可附 `task_id`、`run_id`，不记录任务内容、凭据或完整业务载荷。控制仓写入面包括任务取消（`AsyncTaskService.cancel` 的 CAS）、当前监控项目中指定 Fleet 的结束（既有 `fleet_cancel`，只写该 run 的取消请求和调度状态，不删历史）、选型与角色资源白名单、模型笔记配置真源及对应运行槽同名文件；其余 `.runtime` 与仓内容保持只读。全部变更请求经 Host/Origin/每进程令牌三重护栏。

## 故障边界

- 单个任务 JSON 损坏：对应卡片进入错误态，其他区域继续展示；
- 首次加载前服务不可用：桌面壳显示启动错误；已加载后的连接中断由网页提示，保留数据、页签和草稿；
- 服务恢复：前端轮询自动恢复，不重新加载页面；写入前更新本进程令牌；
- 模型目录：本地配置先显示，目录单独异步读取；“重试目录”保留编辑内容，目录失败不影响任务刷新。模型目录不代表推理连通性；
- 写请求响应丢失：显示“结果待确认”并回读配置与运行槽同步状态，不自动重复保存；
- 配置页运行槽与真源不一致时显示一行横幅，「查看详情」列出槽与文件，「同步」将当前真源收敛到运行槽。各页草稿独立，任一页保存后重新读取，其它页草稿保留；保存期间的新编辑保留为草稿；
- 面板崩溃或退出：不影响控制仓中已经运行的任务。

详细的运行合同、路径派生和验证清单见 [`docs/runtime-contract.md`](docs/runtime-contract.md)、[`docs/validation.md`](docs/validation.md) 和 [`docs/structure.md`](docs/structure.md)。

## 回归验证

工作目录为 `src/agent-panel`。Node 测试覆盖配置 CAS、目录缓存与失败重试、20 秒慢查询并发 health，以及浏览器断连恢复。浏览器测试需要本机 Microsoft Edge 和 Playwright；生产服务不依赖 Playwright。设置 `AGENT_PANEL_SCREENSHOT_DIR` 时，配置页浏览器测试把四个页签在 1366 与 900 宽度下的整页截图写入该目录；未设置时不写截图。

```powershell
# Playwright 已全局安装时使用该入口；也可将变量指向项目级安装目录。
$env:AGENT_PANEL_PLAYWRIGHT_MODULE = Join-Path (npm root -g) 'playwright'
node --test --test-timeout=90000 tests/server/*.test.mjs tests/web/*.test.mjs tests/integration/*.test.mjs
dotnet run --project tests/shell/
node --test tests/shell/webview-smoke.mjs
```

最后一条打开隔离的真实 WebView2 测试窗口，使用临时仓和独立端口；完成后清理测试进程树与临时目录，不修改正式角色配置。`AGENT_PANEL_SHELL_EXE` 可指定已构建的壳路径，默认使用 `shell/bin/Debug/net10.0-windows/AgentPanel.Shell.exe`。

## 回滚

代码变更随控制面仓使用 `git revert` 回滚，重新发布后关闭旧面板并启动全局入口。运行中的任务不属于面板仓状态，不通过回滚操作处理。
