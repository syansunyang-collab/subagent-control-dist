# 交接说明：Claude Code + Pi 子代理控制面

本仓让 Claude Code 或 Pi 的主会话把任务派给后台 Pi 子代理执行，配套角色选型、写域控制、回执核验、多任务编排（Fleet）和桌面监控面板 Agent Panel。安装与升级按 `SETUP.md` 执行；本文说明相对原版 Pi 与 Claude Code 改了什么、每处的原因、哪些内容没有随分发、需要自备哪些账号凭据，以及出问题或要修改时从哪里入手。

## 1. 这是什么

整体相当于一套派工单系统：主代理开工单（做什么、能读写哪些路径、派哪个角色、用什么模型和档位），子代理按单在后台施工并交回执，面板是调度大屏。落到实现上，工单是经编译校验的任务包，施工方是独立的后台 Pi 进程，回执由交卷工具提交，通过机械核验后才交还主代理。

日常流程：

1. 主代理调用 `subagent_prepare`（Claude Code，MCP 全名 `mcp__asyncSubagent__subagent_prepare`）或 `dispatch_prepare`（Pi）的 `list`，查看角色与推荐行；按技能 `pi-rail-dispatch` 写种子并派出。多个相互依赖或可并行的任务用 `fleet_start` 一次提交。
2. 子代理在后台运行，主代理继续其它工作。Pi 会话在任务结束时自动收到完成通知；Claude Code 侧以后台命令运行 `async_watch.mjs` 等待，或用 `subagent_wait` 阻塞等待。
3. `subagent_result` 取回执与报告路径，报告与交接文件写在目标仓 `notes/`。
4. 每次成功派发后自动启动或复用 Agent Panel，面板显示各项目的任务、Fleet 依赖图、模型、token 与耗时，并提供选型与档位等配置页。

Pi 另有 `delegate_work`：带当前会话上下文的后台分身，选型取自 `ops/agents/delegate-work.toml`。

作用范围：派发工具、面板和技能在本机所有项目生效（bootstrap 以 `--project-scope all` 发布）；`AGENTS.md` 的主代理规则只约束含该文件的仓，其它项目需要这套规则时按 `README.md`「消费者安装与更新」用 `COPY-INSTALL.ps1` 接入。

## 2. 获取与安装

获取方式二选一，之后步骤相同：

- clone 私有 GitHub 分发仓；
- 解压维护者提供的 zip，解压结果是带 git 历史的仓；升级前按 `SETUP.md`「升级」第 1 步确认 `upstream` 远程。

安装、验证、升级、macOS 适配与常见故障一律以 `SETUP.md` 为准：本机改动提交在 `local` 分支，`python -B ops/tools/bootstrap.py` 预览，加 `--apply` 执行，完成后完全退出并重启 Claude Code 与 Pi。

需要自备：

| 项 | 用途 | 缺少时 |
| --- | --- | --- |
| Claude Code | 主代理，经 MCP 工具派发 | 只能在 Pi 主会话里派发 |
| ChatGPT 订阅，在 Pi 内 `/login` 登录 `openai-codex` | 37 条角色推荐行中的 27 条（`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-luna` 及其别名）、压缩写手、OpenAI 联网搜索 | 对应推荐行在 `list` 警告段报 `model_not_in_pi`，按 `SETUP.md`「适配本机模型」换成本机可用型号 |
| xAI 凭据（按 Pi 的认证方式配置） | 其余 10 条推荐行（`xai/grok-4.7`）与 `/fast` 的 Grok 快速型号 | 同上 |
| 搜索服务密钥（可选） | Brave、Tavily 等搜索后端，写在 `~/.pi/web-search.json` | 搜索走 Exa 与 Codex 登录态 |
| 运行环境 | Windows 10/11 开发者模式、Python 3.12+、Node.js 24+、Git、Pi 0.87+、.NET 10 SDK、WebView2 Runtime | 以 `SETUP.md`「前置条件」为准；缺 .NET 或 WebView2 只影响面板 |

## 3. 相对原版的改动

原版指 npm 安装的 Pi 与 Claude Code 本体。本分发不修改两者的程序文件，全部改动以 MCP 服务、Pi 扩展、Pi 插件、用户级配置和技能的形式装进用户目录。原因栏括号内的日期是对应决策的记录日期，记录本身不随分发；没有记录的项标「原因未留档」。

### 3.1 子代理派发控制面

| 项 | 改了什么 | 原因 | 关闭或调整 |
| --- | --- | --- | --- |
| 入口 | Claude Code 的 MCP 服务 `asyncSubagent`（注册在 `~/.claude.json`，`~/.codex/config.toml` 同步注册）提供 `subagent_*`、`fleet_*`；Pi 用户级扩展 `~/.pi/agent/extensions/subagent-control/` 提供 `dispatch_prepare`、`delegate_work`、`subagent_*`、`fleet_*` 及 `/fast`、`/control-deployment-info` 等命令。两侧任务数据都在 `<项目>/.runtime/cockpit/` | 子代理执行体原有 Codex、Kimi、Pi 多条轨道，对照实测后收敛到 Pi：各家模型统一经 Pi 的 provider 与认证调用，运行器不处理凭据（2026-08-25、2026-08-29） | 限定启用项目见表下 |
| 角色卡 | `ops/agents/*.toml` 共 11 张，每张的 `[[picks]]` 推荐行直写 Pi 模型全名、默认档位与 `effort_min`–`effort_max`。派发给 `pick` 或 `model`；档位越出该行范围需授权 `effort_range`，模型不在推荐行需授权 `outside_pool`，授权须引用用户原话 | 旧方案的代号、工种位、情景和自动换模兜底几层命名难以理解也难以调整，改为推荐行直写（2026-09-29） | 面板「角色与模型」页，或直接改角色卡 |
| 资源白名单 | 子代理可用的工具、插件、技能由角色卡 `tools`、`extensions`、`skills`、`project_skills` 与导入范围 `ops/templates/worker-resources.json`（不开放 / 可选 / 默认开启）决定，不继承主会话；本机未装的条目只记 warning | 默认继承时每个子代理拿到全部用户级扩展和十几个主代理流程技能，项目技能反而拿不到（2026-09-28） | 面板「角色资源」「导入范围」页 |
| 写域 | 种子声明 `scope.write`；子代理的 `write`、`edit` 在执行前按写域拦截并写审计，回执的 `scope_compliant` 由审计生成，越界时要求主代理复核；每个任务另有独享临时目录，计入写域 | 派发期声明只能证明任务之间没有声明同一路径，证明不了实际写在声明内，此前合规标记由模型自报（2026-09-03）；2026-10-08 统计 725 个任务，被标越界的 46 个多数是临时目录与测试夹具的如实申报，因此放行任务自有目录（2026-10-08） | 写域随种子声明；任务临时目录的基底由用户环境变量 `PI_CONTROL_BASH_SCRATCH` 改，缺省值见 `ops/tools/pi_child_bash_process_tree.mjs` |
| 回执 | 子代理用 `submit_task_result`（审查类用 `submit_review_result`）交卷；运行回合完成、必要工具调用与声明产物核验通过后，`subagent_result` 才放出结果 | 业务终态以状态行和运行层信号为准，正文里的完成措辞不算数（2026-07-16、2026-08-25） | 无开关 |
| 验收角色 | `verify-agent`（代码验收、功能巡检、界面交互巡检等）与 `semantic-review-agent`；`AGENTS.md` §6 要求改了仓内文件的任务在报告完成前派一次独立验收 | 连续漏检的主因是局部证据被当成整体完成，测试全绿也可能没证明用户要的结果（2026-09-15） | 改 `AGENTS.md` §6 |
| Fleet | `fleet_start` 一次提交多节点依赖图，依赖满足的节点并行，写域重叠的节点由调度器串行；run 级完成通知，支持整组取消 | 对照实测中手工逐个派发与轮询的编排空转 41%，Fleet 自动驱动为 0%（2026-08-25） | 不调用即无影响 |

推荐行与档位的修改入口见第 6 节。只在部分仓启用时执行 `python -B ops/tools/release_control_plane.py --project-scope listed --allowed-project <仓路径> --apply`；bootstrap 每次都以 `--project-scope all` 发布，重跑后恢复全仓启用。

### 3.2 模型可选档位（2026-10-08 起）

- 规则：模型可选档位 = `ops/model-notes.toml` 的 `efforts` ∩ Pi 支持档；笔记未写 `efforts` 时取 Pi 支持档，读不到 Pi 目录或模型不在目录时退回笔记 `efforts`。图像输入、Pi 支持档与实际发送值读 Pi 模型目录（RPC `get_available_models`），面板「模型档位」页只读展示。Pi 不支持的档位在派发前拒绝，面板置灰。
- 原因：手写笔记与 Pi 目录各维护一份同类事实。2026-10-08 对账时，Pi 目录 27 个模型里有 25 个的档位或图像与面板展示不符，例如 Claude 系不支持 `off`、`minimal`，haiku 只有 `off`，笔记却默认七档全开。派发按笔记放行后，Pi 会静默改档，回执只留 warning。
- 调整：笔记只能收窄档位；在面板「模型档位」页或直接改 `ops/model-notes.toml`。

### 3.3 Agent Panel

- 改了什么：Windows 桌面面板（WinForms + WebView2 壳，Node 服务只监听 `127.0.0.1`，端口由路径算出、落在 43000–43999）。显示各项目运行中与历史任务、Fleet 依赖图、模型、档位、token、耗时和产物路径，可取消单个任务；四个配置页为「角色与模型」「角色资源」「导入范围」「模型档位」。保存写入本仓 `ops/agents/*.toml`、`ops/model-notes.toml`、`ops/templates/worker-resources.json`，校验通过后同步到各发布槽，下一次派发生效。面板启动失败只记诊断，不影响已提交的任务。
- 原因：此前的项目内 Async Cockpit 只覆盖局部任务观察，缺 Fleet、历史和安全的配置写入，两套 UI 并存要重复维护状态适配、端口与壳（2026-08-28）。派发读取发布槽里的配置，面板只改源文件时出现过「面板改源文件、派发吃发布包」，因此保存时同步发布槽（2026-09-16）。
- 调整：关窗口只结束面板自身服务，不停任务。面板保存的是本仓文件，保存后在 `local` 分支提交。非 Windows 平台用浏览器模式，命令见 `SETUP.md`「macOS」。

### 3.4 Pi 插件与配置

快照在 `adapters/pi/user-addons/agent/`，按相对路径部署到 `~/.pi/agent/`；npm 包、模型登记与设置项列在 `adapters/pi/user-addons/manifest.json`。bootstrap 的处理规则：

- 快照文件本机缺失或内容不同时整份写入，被换掉的旧文件先备份到 `~/.pi/agent/backups/addons-<时间>-*/`，本机多出的文件不动。原因：此前遇到本机不同就跳过，本机直接改过的插件与快照长期分叉。
- npm 包、`models.json` 登记、`~/.pi/agent/settings.json` 与 `~/.pi/web-search.json` 的顶层键只补缺失；已有不同值报 `conflict` 并保留本机值。

因此只删 `~/.pi/agent/` 下的快照文件，下次 bootstrap 会装回；永久去掉要在 `local` 分支删除快照文件或 manifest 条目，已装的 npm 包用 `pi remove <source>` 卸载。设置项直接改本机文件即可保留。

| 项 | 改了什么 | 原因 | 关闭或调整 |
| --- | --- | --- | --- |
| Codex 型号别名 `extensions/openai-codex-sol-context-alias.ts` | 请求发出前把 `gpt-5.6-sol-500k`、`gpt-6.1-sol-500k`、`gpt-6-astra-500k`、`gpt-6-luna-fast-700k` 改写为上游型号，普通轮次与压缩等直调路径都覆盖；只有 `gpt-6-luna-fast-700k` 加 `service_tier=priority`。改写表固定为这四条，新增的 `-500k` 型号不会自动改写 | Codex 不接受这些本地型号 ID（源码注释），扩展未加载时报 `model is not supported when using Codex with a ChatGPT account`。设立大窗口本地型号、luna 走 priority 的原因未留档 | 用到别名的是 `delegate-work.toml` 三条推荐行与 `compactionModel`；改成目录内型号后可删扩展 |
| 搜索档位补丁 `extensions/search-effort-patch/` | 挂在全局 `fetch` 上，只处理发往 Codex responses 且带 `web_search` 工具的请求：把 `openaiSearchModel` 的 `:档位` 后缀拆成型号与 `reasoning.effort`；档位被拒（HTTP 400）时去掉档位重试一次；每次调用记入 `~/.pi/agent/state/search-calls.jsonl` | 不注入时搜索走服务端默认档（实测 `medium`）；补丁同时采集每次调用的档位与用量 | 改 `~/.pi/web-search.json` 的 `openaiSearchModel` 后缀，同型号下次搜索即生效；去掉后缀且不设 `openaiSearchReasoning` 即不注入 |
| 联网搜索 `npm:pi-web-access@0.21.0` | settings 精确钉 0.21.0；`~/.pi/web-search.json` 写入 `searchRouting`（依次 openai、brave、tavily、exa、xai、duckduckgo，遇配额、临时错误、网络、无效响应换下一家）、`workflow`、`openaiSearchModel`、`pageAnswer`。子代理的 `web_search`、`fetch_content`、`get_search_content` 来自此包 | 钉 0.21.0 的原因未留档。已知关联：维护者本机在该版本上另打了网页问答补丁（未随分发） | 升级时同时改 manifest 与本机 settings 的版本串；搜索档位补丁要求插件走全局 `fetch`，0.21.0 与 0.29.0 已核对满足 |
| 中途压缩 `npm:pi-midrun-compact` | 上下文占用 90% 时压缩并自动续跑（`extensions/pi-midrun-compact/config.json`）；设置 `compaction.enabled=false` 关掉 Pi 原生自动压缩，`compaction.reserveTokens=65536` | 2026-09-03 记录时（Pi 0.84.4），原生自动压缩只按 `contextTokens > contextWindow - reserveTokens` 触发，默认 `reserveTokens=16384` 在 500k 窗口约 96.7% 才动手；两者同开形成两个触发源。`reserveTokens=65536` 的取值原因未留档 | 改 `thresholdPercent`；停用插件时把 `compaction.enabled` 改回 `true`，否则没有自动压缩 |
| 压缩写手 `local-packages/pi-compaction-model-recovery` | 压缩时把摘要交给 `compactionModel`（`openai-codex/gpt-6-luna-fast-700k` @ `xhigh`）；写手失败时退回当前主模型并提示；日志在 `~/.pi/agent/logs/compaction/` | 压缩交给指定型号，不占用当前会话型号；本地包让压缩请求经已注册的 provider 发出，型号别名与 `service_tier` 因此生效，并补上压缩请求身份（源码注释） | 改 `~/.pi/agent/settings.json` 的 `compactionModel.model` |
| Codex 别名型号登记 | 在 `~/.pi/agent/models.json` 的 `openai-codex` 下登记 `gpt-5.6-sol-500k`、`gpt-6.1-sol-500k`、`gpt-6-astra-500k`（上下文 500000）与 `gpt-6-luna-fast-700k`（上下文 700000），单价与档位映射照搬上游型号 | 型号别名扩展只改写请求，型号本身要在 Pi 目录里存在；分身 `delegate_work` 三个选型与 `compactionModel` 用到这些型号 | 没有 ChatGPT 订阅时无影响；本机已有同 id 不同定义时保留本机并报 `conflict` |
| Grok 快速型号 | 在 `~/.pi/agent/models.json` 的 `xai` 下登记 `grok-4.7-build-fast`，单价按快版（普通版两倍） | `/fast` 与子任务 `fast` 要切到该型号，Pi 内置目录没有它（Pi 0.99.1 核对） | 没有 xAI 凭据时无影响；本机已有同 id 不同定义时保留本机并报 `conflict` |
| 快速模式 `/fast`（`subagent-control` 扩展内，`ops/tools/pi_fast_mode.mjs`） | 命令 `/fast`、`/fast-on`、`/fast-off`、`/fast-status`，状态随会话保存；开启后 OpenAI 系请求加 `service_tier=priority`，`xai/grok-4.7` 切到快速型号。派发与 `fleet_start` 有 `fast` 参数，MCP 调用缺省为关，Pi 主代理缺省沿用会话状态 | 用额度换速度：OpenAI 系约 2.5 倍额度，Grok 两倍价格。Codex 回执恒报 `default` 档，Pi 按普通价记账，扩展按基础价乘 2.5 重算费用（源码注释） | 默认关闭，不开即无影响 |

### 3.5 Claude 搜索工具

- 改了什么：本机另装 Pi 插件 `pi-claude-code-provider`（0.6.0 起）时，设置用户环境变量 `PI_CLAUDE_CODE_PROVIDER_WEB_SEARCH=off`，该 provider 不再注册自带的搜索工具 `pi_claude_code_provider_web_search`，搜索统一走 `web_search`。
- 原因：不设时两个搜索工具同时进入提示词。0.6.0 起该变量只认 `on` / `off`：未设置或 `on` 注册，`off` 不注册，其它值也不注册并告警。2026-10-08 之前由一个搜索路由插件在主会话隐藏该工具，provider 自带开关效果相同，插件已删除。
- 范围：分发不含该 provider，bootstrap 不写这个变量；Pi 进程启动时读取，修改后重启 Pi。子代理按角色卡白名单装配工具，本就不含该工具。

### 3.6 技能、主代理规则与工作流程

| 项 | 改了什么 | 原因 | 关闭或调整 |
| --- | --- | --- | --- |
| 技能 `ops/skills/` | 12 个技能，含派发 `pi-rail-dispatch`、多路并发 `subagent-fleet-discipline`、Git 异常处理 `git-recovery`、规则写作 `rule-authoring`、文档写作 `writing-governance`、界面设计 `tool-ui-design`。发布包 `package.json` 的 `pi.skills` 指向 `ops/skills`；Claude Code 侧在 `~/.claude/skills/<名称>` 建链接（同名真实目录跳过），Pi 侧把 `~/.subagent-control/releases/consumer/current/ops/skills` 加入 `~/.pi/agent/settings.json` 的 `skills` | 控制面技能经用户级入口在所有项目生效；项目级接线已拆除，避免与全局入口同名冲突 | 在 `local` 分支删改 `ops/skills/<名称>/` 后重跑 bootstrap，发布会删掉指向已不存在技能的链接；`AGENTS.md` 与部分技能按名称互相引用 |
| 主代理规则 `AGENTS.md` | 主代理的任务分流、委派、并发、验收与 Git 收口约定 | 主代理按完整工作块决定亲自做或委派，可在用户目标与授权内裁剪内部流程（2026-09-23）；项目材料按需读取，不设开工必读清单（2026-09-13） | 只约束含该文件的仓，修改后新会话或 reload 生效 |
| 工作流程 `ops/workflows/` | 对齐 `alignment/`、任务卡 `task-card.md`、跨会话规划 `planning/`、事故止损 `incident-containment.md`，由 `AGENTS.md` §3 的分流表进入 | 范围、验收、技术路线、架构设计、用户可见形态、与已定内容冲突六类必问项逐题交用户拍板，起因是主代理判断空间过大、方案级取舍常在用户不知情时被锁定（2026-09-23）；完整周期对账显示 planner 与大型执行清单产出低，规划链改为只在跨会话交接时使用（2026-09-28） | 改 `AGENTS.md` §3 的分流表或对应 workflow 文件 |

## 4. 未随分发的内容

| 内容 | 说明 | 缺少时 |
| --- | --- | --- |
| 维护者本机插件仓管理的插件与补丁 | 上下文裁剪 `pi-context-prune`、缓存诊断 `cache-wire-observer` 与 `payload-cache-diag`、`pi-cursor-host`、`pi-read-symbol`、scheduler、全局系统尾注 `APPEND_SYSTEM.md`、`/img` 粘贴图片；全局 Pi 补丁 Codex attribution、prompt stability、WS recovery；`pi-web-access` 网页问答补丁；antigravity 与 computer-use 补丁；Pi web 自启动与运维 | 派发、Fleet、面板、搜索与压缩链都不依赖它们。角色卡列出的未装插件（如 `pi-read-symbol`、`payload-cache-diag`）只记 warning、不加载；`~/.pi/web-search.json` 的 `pageAnswer` 默认值在未打补丁的 0.21.0 上不生效，网页问答按上游行为运行 |
| 用户级手动安装的第三方 Pi 包 | `pi-mcp-adapter`、`@narumitw/pi-lsp`、`visual-explainer`、`pi-hermes-memory`、`@alexanderfortin/pi-token-usage`、`@juicesharp/rpiv-ask-user-question` 等 | 角色卡引用的 MCP、LSP、图示等工具缺席，只记 warning；需要时用 `pi install` 自行安装 |
| 模型凭据与搜索密钥 | Pi 的登录态与 `~/.pi/web-search.json` 中的 key，bootstrap 都不写 | 见第 2 节 |
| 维护记录与测试 | 决策记录 `docs/`、工作记录 `notes/`、`PROJECT.md`、`STATUS.md`、`ROADMAP.md`、回归测试 `tests/`，以及各项目 `.runtime/cockpit/` 的任务数据 | 运行不受影响；本地改动用 `SETUP.md`「验证」冒烟，需要追溯某项设计时向维护者索取对应记录 |

## 5. 已知限制

- 只在 Windows 10/11 上实测；macOS 需要改动的位置列在 `SETUP.md`「macOS」。
- 子代理没有 OS 沙箱，以当前用户的完整权限运行。写域只拦截 `write`、`edit` 两个路径型写工具，`bash`、`powershell` 的写入只能在回执里事后标出；权限档（`read-only`、`workspace-write` 等）只改变交给子代理的提示词措辞。
- 发布后，已打开的 Claude Code 与 Pi 会话仍连着旧的 MCP、扩展与技能，旧服务派出的任务用旧运行器；`subagent_server_info` 的 `build_id` 与部署不一致时新开会话再派。
- `ops/dist` 是发布构建产物，每次发布带构建时间而变化；合并上游前先 `git restore ops/dist`。
- 同机只认一个发布源（`~/.subagent-control/bridge-producer.json`），同机多份 checkout 只能从登记的那份发布。发布槽由本机所有项目共用，后发布的版本接管全部项目，任务数据仍按项目隔离。
- 面板端口按路径固定在 43000–43999，被占用时直接失败、不换端口；端口落在 Windows 保留段时见 `SETUP.md`「常见故障」。

## 6. 排查、修改与回传

### 出问题先看

安装与发布阶段的问题见 `SETUP.md`「常见故障」。运行期问题按下表定位：

| 现象 | 先看 |
| --- | --- |
| 任务失败、卡住或结果不对 | `subagent_get`（`detail=diagnostic`）的当前阶段、最近调用与日志；任务数据在 `<项目>/.runtime/cockpit/` |
| 派发报型号或档位错误 | `subagent_prepare` / `dispatch_prepare` 的 `list` 警告段；Pi 支持档看面板「模型档位」页，本机型号用 `pi --list-models` |
| 部署版本对不上 | Claude Code 调 `subagent_server_info`，Pi 执行 `/control-deployment-info` |
| 压缩没触发或写手失败 | `~/.pi/agent/logs/compaction/<会话 id>.jsonl` |
| 搜索档位不对 | `~/.pi/agent/state/search-calls.jsonl` 最后一行的 `effortActual`、`injected`、`effortSource` |
| 面板异常 | `~/.subagent-control/agent-panel/logs/` |
| 发布失败 | `tmp/release-runs/` 最新目录下的 `*.stderr.log` 与 `result.json` |

### 改哪里

| 目的 | 修改位置 | 生效方式 |
| --- | --- | --- |
| 角色推荐行、模型可选档位、子代理导入范围 | 面板配置页，或 `ops/agents/*.toml`、`ops/model-notes.toml`、`ops/templates/worker-resources.json` | 面板保存即写本仓并同步发布槽；直接改文件后重跑 bootstrap |
| 自研 Pi 插件、npm 包与模型登记 | `adapters/pi/user-addons/agent/`、`adapters/pi/user-addons/manifest.json` | 重跑 bootstrap，重启 Pi |
| 压缩型号、搜索配置等用户级设置 | `~/.pi/agent/settings.json`、`~/.pi/web-search.json` | 重启 Pi；bootstrap 对这些键报 `conflict` 并保留本机值 |
| 派发、Fleet、面板代码 | `adapters/pi/src/`、`ops/tools/`、`src/agent-panel/` | 重跑 bootstrap（发布会重新构建 `ops/dist` 并部署），重启 Claude Code 与 Pi |
| 技能、主代理规则、工作流程 | `ops/skills/`、`AGENTS.md`、`ops/workflows/` | 技能重跑 bootstrap；`AGENTS.md` 在新会话或 reload 后生效，workflow 文件按需读取、改后即用 |

`~/.subagent-control/releases/` 与 `~/.pi/agent/extensions/subagent-control/` 下的文件由发布生成，直接修改会在下次发布时被覆盖。所有改动提交在 `local` 分支；本机型号适配与通用改进分开提交，便于单独回传。

### 回传改进

分发仓的提交由维护者从源仓导出生成（提交说明为 `sync: control plane <提交号>`）。导出时覆盖分发仓中与源仓不同的文件，并删除不在导出清单内的已跟踪文件，直接合进分发仓 `main` 的改动会在下次同步时丢失。回传方式：

1. 问题与建议：在私有分发仓提 issue，写明现象、复现步骤和期望结果，附 `python -B ops/tools/bootstrap.py --format json` 的输出或 `subagent_get` 诊断。
2. 补丁：从上游另开分支，只放通用改进，导出补丁文件交给维护者：

   ```bash
   git switch -c fix/<主题> upstream/main
   # 提交改动后
   git format-patch upstream/main -o <补丁目录>
   ```

维护者在源仓合入并重新导出后，`local` 分支按 `SETUP.md`「升级」合并上游即可取回。
