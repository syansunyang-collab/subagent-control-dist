# 本机安装与升级（Claude Code + Pi）

本仓装好后，Claude Code 通过 MCP 工具 `mcp__asyncSubagent__*`、Pi 通过扩展工具 `dispatch_prepare` / `delegate_work` / `subagent_*` / `fleet_*` 把任务派给 Pi 子代理执行；技能、面板和异步监听一并安装。安装与升级共用 `python -B ops/tools/bootstrap.py`：默认只预览，加 `--apply` 执行，本机已满足的步骤自动跳过。安装不包含模型账号凭据，也不改动 Claude Code 与 Pi 的其它配置项。

## 前置条件

必需：

- Windows 10/11，已开启「开发者模式」（发布需要创建符号链接；bootstrap 会先检查）
- Python 3.12+、Node.js 24+、Git，均在 PATH 上
- Pi 0.87+：`npm i -g @earendil-works/pi-coding-agent`
- Claude Code
- Pi 中至少登录一个模型服务商（`pi` 内执行 `/login`）；角色卡默认用 `openai-codex/gpt-6-*`（ChatGPT 订阅）与 `xai/grok-4.7`，没有的型号按「适配本机模型」替换

可选：

- .NET 10 SDK 与 WebView2 运行时：面板首次打开时现场构建桌面壳；缺少时派发不受影响
- Pi 插件 `pi-web-access`（联网搜索与抓取）、`pi-mcp-adapter`、`@narumitw/pi-lsp` 等：角色卡列出但本机未装的插件和技能只记 warning、不加载；调研类任务依赖联网插件

## 安装

1. clone 分发仓，在仓根建本机分支，本机改动都提交在这个分支上：

   ```bash
   git switch -c local
   ```

2. 预览，确认每步状态（`ok` 已满足、`todo` 将执行）：

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
   - 安装 Codex 型号别名扩展到 `~/.pi/agent/extensions/`；`-700k` / `-500k` 型号依赖它
   - 把技能目录加入 `~/.pi/agent/settings.json` 的 `skills`
   - 登记本仓为本机发布源（`~/.subagent-control/bridge-producer.json`）
   - 发布：构建后部署 Pi 扩展、MCP 服务、consumer 包，并把技能链接到 `~/.claude/skills/`

   原有配置只追加、不覆盖；别名扩展内容不同时，旧文件改名为 `.bak-<时间>` 备份。

4. 完全退出并重启 Claude Code 与 Pi。已打开的会话继续使用旧的 MCP、扩展与技能。

## 验证

1. Claude Code 新会话：调用 `mcp__asyncSubagent__subagent_server_info`，`build_id` 与 `~/.pi/agent/extensions/subagent-control/deployment.json` 的 `build_id` 相同；再用 `mcp__asyncSubagent__subagent_prepare` 的 `list` 动作，返回角色与型号的逐行目录。
2. Pi 新会话：调用 `dispatch_prepare` 的 `list` 动作，返回同一目录。
3. 真实派发：按技能 `pi-rail-dispatch` 派一单只读小任务，等到终态 `completed`。
4. 面板（可选）：在本仓根执行下面这条命令，首次打开会构建桌面壳，耗时数分钟。

   ```powershell
   node "$HOME\.subagent-control\releases\consumer\current\ops\consumer-tools\agent_panel_launcher.mjs"
   ```

## 适配本机模型

型号、档位、插件与技能白名单集中在三类受管配置：

| 文件 | 内容 |
| --- | --- |
| `ops/agents/*.toml` | 各角色的推荐选型（`[[picks]]` 的 `model` / `effort`）与可加载的工具、插件、技能 |
| `ops/model-notes.toml` | 各型号的说明、可选档位 |
| `ops/templates/worker-resources.json` | 子代理可导入的工具、插件、技能及默认开关 |

1. 找出本机缺的型号：`list` 输出的「警告」段逐条列出 `model_not_in_pi`（角色卡文件、`picks` 序号、型号）；本机可用型号用 `pi --list-models` 查看。
2. 把这些 `model` 换成可用型号；换成的新型号在 `ops/model-notes.toml` 补一节说明，直到 `list` 不再报 `model_not_in_pi`。
3. 两种生效方式：在面板「选型」「模型档位」「导入范围」页修改，面板同时写本仓与各发布槽；或直接改文件后重跑 `python -B ops/tools/bootstrap.py --apply`。
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

## 常见故障

| 现象 | 处理 |
| --- | --- |
| `model is not supported when using Codex with a ChatGPT account` | 别名扩展未加载：检查 `~/.pi/agent/extensions/openai-codex-sol-context-alias.ts` 存在，且启动参数没有 `--no-extensions`；与账号权限无关 |
| Claude Code 里 `subagent_server_info` 的 build 与部署不一致，或新工具缺失 | 会话仍连旧 MCP，重启 Claude Code |
| bootstrap 报「不能创建符号链接」 | 开启 Windows「开发者模式」后重跑 |
| bootstrap 报「本机发布源登记为 …」 | 本机已由另一份仓发布；改在那份仓执行，或删除 `~/.subagent-control/bridge-producer.json` 后重跑 |
| 发布失败 | 看 `tmp/release-runs/` 最新目录下各步的 `*.stderr.log` 与 `result.json` |
| 面板报端口被占用，但查不到占用进程 | 端口落在 Windows 保留段（`netsh int ipv4 show excludedportrange protocol=tcp`）；重启系统或调整保留段 |
| 首次打开面板「导入范围」页要等十几秒 | 首次探测已装插件的工具表，结果缓存后变快 |

发布槽 `~/.subagent-control/releases/` 下的文件由发布生成，改动一律改本仓后重跑 bootstrap。
