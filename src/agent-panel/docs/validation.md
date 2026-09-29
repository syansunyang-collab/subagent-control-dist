# S5 验证清单

验证工作目录为当前仓的 `src/agent-panel`。下面的静态检查用于确认模块结构合同；三条命令用于确认启动链。

## 静态检查

| 检查 | 通过条件 |
| --- | --- |
| `package.json` | Node `>=24.0.0`；存在 `start` 和 `start:browser`；无生命周期脚本 |
| `package-lock.json` | lockfile version 3；根包与 `package.json` 的名称和版本一致 |
| 依赖边界 | 无 npm 依赖、无前端框架、无构建链 |
| `start` | 通过 `dotnet run --project shell/ -- --service-entry src/server/index.mjs` 启动桌面壳，由壳拥有 Node 服务生命周期 |
| `start:browser` | 调用 `src/server/index.mjs --browser`，只启动服务并打开浏览器 |
| 端口 | 采用 runtime contract 的路径哈希算法（`43000 + big-endian(SHA256(path)[0..1]) % 1000`），绑定 `127.0.0.1` |
| 路径 | 命令行 `--control-repo`（Node 还支持 `--control-root`）优先；浏览器服务环境变量为 `AGENT_PANEL_CONTROL_REPO_PATH`、`CONTROL_REPO_PATH`，桌面壳环境变量为 `AGENT_PANEL_CONTROL_REPO`，最后默认模块上两级目录，即所属仓根 |
| 白名单 | 模块内容仅落在 README、模块根三清单、`src/`、`shell/`、`tests/`、`docs/` |
| 隔离 | 生产运行产物落在用户级 `.subagent-control/agent-panel/`；隔离测试使用 `AGENT_PANEL_STATE_ROOT`；任务数据保留在项目 cockpit |

## 启动命令

按顺序运行（工作目录为模块目录）：

```powershell
npm ci
dotnet build shell/
npm run start
```

通过条件：`npm ci` 不修改锁文件；`dotnet build shell/` 以 `net10.0-windows` 成功构建；`npm run start` 打开壳窗口，首屏显示所属控制仓的真实任务列表或正确空态。开发期另行运行：

```powershell
npm run start:browser
```

通过条件：服务就绪信号出现、浏览器访问根路由、连接态和任务区域呈现真实数据或正确空态。

## 全局发布验收

发布链和正式入口见 [运行手册](../../../docs/operations/agent-panel.md)。从无面板源码的项目调用全局 launcher，检查壳与服务的实际进程路径均落全局目录；切换监控项目后再次调用应复用原实例。任务页和配置页需实际打开并检查截图，不能仅以测试数量或健康接口替代页面验收。

## 失败记录

缺少 Node 24、.NET 10 SDK 或 WebView2 Runtime 时，不把环境缺失误判为代码通过。控制仓路径错误、端口占用和兼容版本不匹配也必须保留原始错误，不能用静默回退掩盖。
