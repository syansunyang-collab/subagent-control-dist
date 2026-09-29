# 模块结构白名单

agent-panel 的开发源码位于控制面仓 `src/agent-panel`；生产运行资产随全局 Pi 包发布。本文件约束模块目录内部结构。

## 模块根

模块根只保留产品入口和必要清单：

| 路径 | 用途 | 是否提交 |
| --- | --- | --- |
| `README.md` | 安装、启动和故障说明 | 是 |
| `package.json` | Node 运行脚本和 Node 版本门 | 是 |
| `package-lock.json` | npm 本地锁定依赖 | 是 |
| `.gitignore` | 依赖缓存和构建产物隔离 | 是 |
| `src/` | Node 服务与原生 HTML/JavaScript 真源 | 是 |
| `shell/` | .NET 10 WinForms/WebView2 壳真源 | 是 |
| `tests/` | 测试与夹具 | 是 |
| `docs/` | 设计、运行和验证文档 | 是 |

不放入控制面模板、第二状态文件、前端框架构建链或多仓聚合配置。

## 运行产物

面板运行产物（日志、WebView2 用户数据、构建缓存）落在用户级 `.subagent-control/agent-panel/`，不进入源码目录、监控项目或提交树。隔离测试使用 `AGENT_PANEL_STATE_ROOT` 指定临时状态目录。

以下内容属于本机产物，不进入提交树：

- 用户级面板状态目录及其日志、临时缓存；
- `node_modules/`；
- 所有 .NET 项目的 `**/bin/`、`**/obj/`；
- IDE 生成的 `.vs/`、`.vscode/` 和用户配置文件；
- 覆盖率和测试结果目录。

监控项目的 `.runtime/cockpit` 是任务数据源；面板自身产物使用独立用户目录，不复制任务状态。
