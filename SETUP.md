# 本机安装与升级（Claude Code + Pi）

本仓装好后，Claude Code 通过 MCP 工具 `mcp__asyncSubagent__*`、Pi 通过扩展工具 `dispatch_prepare` / `delegate_work` / `subagent_*` / `fleet_*` 把任务派给 Pi 子代理执行；技能、面板和异步监听一并安装。安装与升级共用 `python -B ops/tools/bootstrap.py`：默认只预览，加 `--apply` 执行。依赖、登记、插件与配置已满足的步骤自动跳过；发布步骤每次都重新构建并部署（`ops/dist` 随之变化），并恢复全仓启用，完成后仍需重启 Claude Code 与 Pi。安装不包含模型账号凭据与搜索服务密钥；插件以本仓快照为准，本机副本不同时先备份到 `~/.pi/agent/backups/` 再覆盖；其它已有配置只追加缺失项，同 id 模型或已有设置项内容不同时跳过并标为 `conflict`。

## 前置条件

必需：

- Windows 10/11，已开启「开发者模式」（发布需要创建符号链接；bootstrap 会先检查）
- Python 3.12+、Node.js 24+、Git，均在 PATH 上
- Pi 0.87+：`npm i -g @earendil-works/pi-coding-agent`
- Claude Code
- .NET 10 SDK 与 Microsoft Edge WebView2 Runtime：面板桌面壳在本机构建并用 WebView2 显示；bootstrap 只检查 `dotnet`，缺少时面板两步标 `skipped`，WebView2 不做检查；缺哪一项都不影响派发
- Pi 中至少登录一个模型服务商（`pi` 内执行 `/login`）；角色卡默认用 `openai-codex/gpt-6-*`（ChatGPT 订阅）与 `xai/grok-4.7`，没有的型号按「适配本机模型」替换

可选：

- Pi 插件 `pi-mcp-adapter`、`@narumitw/pi-lsp`、`visual-explainer` 等：角色卡列出但本机未装的插件和技能只记 warning、不加载

## 安装

1. clone 分发仓，在仓根建本机分支，本机改动都提交在这个分支上：

   ```bash
   git switch -c local
   ```

2. 预览，确认每步状态（`ok` 已满足、`todo` 将执行、`conflict` 本机已有不同内容，跳过；`skipped` 缺少可选前置条件）：

   ```bash
   python -B ops/tools/bootstrap.py
   ```

3. 执行：

   ```bash
   python -B ops/tools/bootstrap.py --apply
   ```

   依次完成：
   - `npm ci`（`ops`、`adapters/pi`、`src/agent-panel`）
   - 在 `~/.claude.json` 与 `~/.codex/config.toml` 建 `asyncSubagent` 注册；两处都由发布切到发布槽，未装 Codex 也需要后者
   - 部署 Pi 插件与补丁（见「Pi 插件与配置」），登记到 `~/.pi/agent/settings.json` 的 `packages`，合并 `~/.pi/agent/models.json` 的 Grok 快速型号与 Codex 别名型号定义，写入压缩设置与联网搜索配置
   - 把技能目录加入 `~/.pi/agent/settings.json` 的 `skills`
   - 登记本仓为本机发布源（`~/.subagent-control/bridge-producer.json`）
   - 发布：构建后部署 Pi 扩展、MCP 服务、consumer 包，并把技能链接到 `~/.claude/skills/`
   - 构建面板桌面壳（首次数分钟），在桌面建快捷方式 `Agent Panel`


4. 完全退出并重启 Claude Code 与 Pi。已打开的会话继续使用旧的 MCP、扩展与技能。

## Pi 插件与配置

插件快照在 `adapters/pi/user-addons/agent/`，按相对路径部署到 `~/.pi/agent/`，修改插件改本仓快照；登记项与设置在 `adapters/pi/user-addons/manifest.json`。

| 组 | 内容 | 作用 |
| --- | --- | --- |
| Grok 快速型号 | `models.json` 的 `xai/grok-4.7-build-fast`（由 manifest 的 `pi_models` 登记） | 控制面 `/fast` 自动切换 Grok 4.7；按快版真实单价记账（普通版两倍）；已有同 id 不同定义保留并报 conflict |
| 型号别名 | `extensions/openai-codex-sol-context-alias.ts`；四个型号的定义（上下文窗口、单价、档位映射）由 manifest 的 `pi_models` 登记进 `models.json` | 只改写 `gpt-5.6-sol-500k`、`gpt-6.1-sol-500k`、`gpt-6-astra-500k`、`gpt-6-luna-fast-700k` 四个固定 ID；前三个只换上游型号，只有 `gpt-6-luna-fast-700k` 加 `service_tier=priority` |
| 压缩链 | npm `pi-midrun-compact` 与 `extensions/pi-midrun-compact/config.json`（上下文 90% 时中途压缩并自动续跑）；本地包 `pi-compaction-model-recovery`；设置 `compaction.enabled=false`、`compactionModel`（`openai-codex/gpt-6-luna-fast-700k` @xhigh） | 压缩交给指定型号，不占用当前会话型号 |
| 联网搜索 | npm `pi-web-access@0.21.0`；补丁 `extensions/search-effort-patch/`（给 OpenAI 搜索注入 `openaiSearchModel` 的档位后缀）；`~/.pi/web-search.json` 的 `searchRouting`、`workflow`、`openaiSearchModel`、`pageAnswer` | 调研类子代理联网；不配密钥时走 Exa 与 Codex 登录态，Brave、Tavily 等需在 `~/.pi/web-search.json` 自行补 key |

本机另装了 Pi 插件 `pi-claude-code-provider`（0.6.0 起）时，设置用户环境变量 `PI_CLAUDE_CODE_PROVIDER_WEB_SEARCH=off`，它就不再注册自带的 Claude 搜索工具，搜索统一走 `web_search`；不设时两个搜索工具同时出现在提示词里。bootstrap 不写这个变量，设置后重启 Pi 生效。

## 验证

1. Claude Code 新会话：调用 `mcp__asyncSubagent__subagent_server_info`，`build_id` 与 `~/.pi/agent/extensions/subagent-control/deployment.json` 的 `build_id` 相同；再用 `mcp__asyncSubagent__subagent_prepare` 的 `list` 动作，返回角色与型号的逐行目录。
2. Pi 新会话：调用 `dispatch_prepare` 的 `list` 动作，返回同一目录。
3. 真实派发：按技能 `pi-rail-dispatch` 派一单只读小任务，等任务状态到 `done`，再用 `subagent_result` 核对 `business_state` 为 `completed` 且报告与交接路径存在；状态为 `failed` 或 `cancelled` 时用 `subagent_get` 读诊断。
4. 面板：双击桌面快捷方式 `Agent Panel`，窗口显示任务列表与「角色与模型」「角色资源」「导入范围」「模型档位」四个配置页。

## 适配本机模型

型号、档位、插件与技能白名单集中在三类受管配置：

| 文件 | 内容 |
| --- | --- |
| `ops/agents/*.toml` | 各角色的推荐选型（`[[picks]]` 的 `model` / `effort`）与可加载的工具、插件、技能 |
| `ops/model-notes.toml` | 各型号的说明、可选档位 |
| `ops/templates/worker-resources.json` | 子代理可导入的工具、插件、技能及默认开关 |

1. 找出本机缺的型号：`list` 输出的「警告」段逐条列出 `model_not_in_pi`（角色卡文件、`picks` 序号、型号）；本机可用型号用 `pi --list-models` 查看。
2. 把这些 `model` 换成可用型号；换成的新型号在 `ops/model-notes.toml` 补一节说明，直到 `list` 不再报 `model_not_in_pi`。
   Pi 侧另有两处用户级设置写了型号，本机没有时直接改：`~/.pi/agent/settings.json` 的 `compactionModel.model`、`~/.pi/web-search.json` 的 `openaiSearchModel` 与 `pageAnswer.model`。改过之后 bootstrap 对这几项报 `conflict` 并保留本机值。
3. 两种生效方式：在面板「角色与模型」「角色资源」「导入范围」「模型档位」页修改，面板同时写本仓与各发布槽；或直接改文件后重跑 `python -B ops/tools/bootstrap.py --apply`。
4. 在 `local` 分支提交。

代码改动同样提交在 `local` 分支，改完重跑 bootstrap 生效。

## 升级

1. 把上游分发仓加为远程（只需一次）：`git remote add upstream <分发仓地址>`
2. 还原发布重建的产物（`ops/dist` 带构建时间，每次发布都会变），再拉取并合并：

   ```bash
   git restore ops/dist
   git fetch upstream
   git merge upstream/main
   ```

   受管配置冲突时保留本机型号选择，同时吸收上游新增的字段、角色和条目。
3. `python -B ops/tools/bootstrap.py --apply`，重启 Claude Code 与 Pi，按「验证」冒烟。

## macOS

本仓只在 Windows 10/11 上实跑验证。派发运行时的进程管理多数写有 POSIX 分支，但从未在 macOS 上运行；已知需要改动的位置如下，改动提交在 `local` 分支。

| 位置 | 问题 | 改法 |
| --- | --- | --- |
| `ops/tools/run-pi-task/protocol.mjs` 的 `DEFAULT_PI_CLI`；`ops/tools/pi_worker_resources.mjs` 的 `PI_CLI` | 按 Windows 全局 npm 布局（`%APPDATA%/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`）拼 Pi CLI 路径，macOS 上不存在。运行器启动子代理时无论任务是否开放 bash 都先准备同目录的 bash 模块，路径不存在即以 `transport_failed` 失败 | 两处都改为 `npm root -g` 下的 `@earendil-works/pi-coding-agent/dist/cli.js`，最好共用一个定位函数。环境变量 `PI_CONTROL_PI` 是测试用的覆盖口，不能替代：设置后子代理不装配 bash 模块，也跳过已装插件与技能的发现 |
| `ops/tools/bootstrap.py` 的 `step_panel_build`、`step_panel_shortcut` | 只要有 `dotnet` 就构建 Windows 桌面壳（`net10.0-windows`），并调用 `powershell.exe` 建快捷方式，两步都会报错 | 非 Windows 平台跳过这两步，面板改用浏览器模式 |
| 面板 | 桌面壳是 WinForms + WebView2，只能在 Windows 上运行 | 浏览器模式，在仓根执行 `node "<root>/ops/dist/agent_panel_server.bundle.mjs" --browser --control-repo "$PWD"`，`<root>` 取 `~/.subagent-control/agent-panel/runtime-root.json` 的 `root`，服务就绪后由它调用 `open` 自动打开浏览器。可写成桌面上的 `Agent Panel.command` |
| 派发后自动拉起面板 | 启动器尝试构建 Windows 桌面壳并失败 | 只记诊断，不影响派发 |
| 面板端口计算 | 启动器（`ops/tools/dispatch-core/agent_panel_launcher.mjs` 的 `deriveEndpoint`）在非 Windows 平台按原大小写对路径取哈希，浏览器模式服务（`src/agent-panel/src/server/async-core.mjs`）先转小写再取哈希；用户目录含大写字母时两边端口不同，派发后自动拉起面板识别不到已开的浏览器面板 | 只影响自动拉起，不影响派发；统一两侧的路径归一化后一致 |
| 本文件的 Windows 专属项 | 开发者模式、.NET、WebView2、PowerShell 命令不适用；`COPY-INSTALL.ps1` 需要 `pwsh` | 前置条件改为 Homebrew 安装 node、python、git，npm 全局安装 Pi |

## 常见故障

| 现象 | 处理 |
| --- | --- |
| `model is not supported when using Codex with a ChatGPT account` | 别名扩展未加载：检查 `~/.pi/agent/extensions/openai-codex-sol-context-alias.ts` 存在，且启动参数没有 `--no-extensions`；与账号权限无关 |
| Claude Code 里 `subagent_server_info` 的 build 与部署不一致，或新工具缺失 | 会话仍连旧 MCP，重启 Claude Code |
| bootstrap 报「不能创建符号链接」 | 开启 Windows「开发者模式」后重跑 |
| bootstrap 报「本机发布源登记为 …」 | 本机已由另一份仓发布；改在那份仓执行，或删除 `~/.subagent-control/bridge-producer.json` 后重跑 |
| 发布失败 | 看 `tmp/release-runs/` 最新目录下各步的 `*.stderr.log` 与 `result.json` |
| 面板报端口被占用，但查不到占用进程 | 端口落在 Windows 保留段（`netsh int ipv4 show excludedportrange protocol=tcp`）；重启系统或调整保留段 |
| 面板进程启动后窗口不显示或报 WebView2 错误 | 本机缺 WebView2 运行时：安装 Microsoft Edge WebView2 Runtime（Evergreen）后再双击 |
| 双击 `Agent Panel` 没有新窗口 | 面板已由别的项目打开或旧桌面壳残留（派发会自动拉起面板）：关掉已有面板窗口；无窗口时结束 `AgentPanel.Shell` 进程后再双击 |
| 首次打开面板「导入范围」页要等十几秒 | 首次探测已装插件的工具表，结果缓存后变快 |
| bootstrap 某项报 `conflict` | 本机已有同名登记或设置项且内容不同，该项保留本机内容；设置文件按顶层键处理，同一文件中缺失的其它键照常写入，`detail` 分列写入与保留的键。要换成分发版本时删除或改名本机那一项后重跑 |

发布槽 `~/.subagent-control/releases/` 下的文件由发布生成，改动一律改本仓后重跑 bootstrap。
