# pi-cursor-host

Pi 模型提供者。通过官方 `@cursor/sdk` 跑 Cursor local agent；工具执行和系统提示词归 Pi，Cursor 自带的文件、终端类工具全部关闭。

前置条件：Node.js 22.19+，Cursor 账号的 User API key（用量记在该账号的套餐上，dashboard 里标为 SDK）。

## 安装

在包目录安装依赖：

```bash
npm install
```

一次性加载（必须指向入口文件，不能只给目录）：

```bash
pi -e E:/Pi_Coding_Agent/tools/pi-cursor-host/index.ts
```

登录：

```text
/login cursor-host
```

或设置环境变量 `CURSOR_API_KEY`。登录状态：

```text
/cursor-host-status
```

选择模型：

```text
/model cursor-host/composer-2.5
```

要在 Pi 模型列表里长期显示，把 `cursor-host/*` 加进 `enabledModels`。

## 模型与思考档位

模型列表取自 `Cursor.models.list()`。启动时尝试在线更新；查询失败、超时或返回空目录时，使用当前账号最近一次成功目录。目录保存在 `~/.pi/agent/pi-cursor-host/catalog/`，文件名按账号凭据和后端地址的摘要隔离，内容仅包含模型元数据。成功响应原子替换缓存；失败和超时后迟到的响应保留旧目录。没有缓存时使用 `src/models.ts` 中的离线目录；可用性仍受账号登录状态限制。

- 上下文：有多档上下文的模型，最小一档用原名（如 `claude-opus-5` 为 300k），更大的档位加后缀（`claude-opus-5-1m`），与 Cursor 自己的默认档无关。`contextWindow` 随档位设置。目录只给可选档位的模型标上下文；其余模型的窗口取自 Cursor 的模型文档页（`https://cursor.com/docs/models/<slug>`，2026-09-17 读取）：`grok-4.6`、`grok-4.5` 为 256k（Cursor 版本按设计如此，与 xAI 自家的 500k 不同），`gpt-5.3-codex`、`gpt-5.2`、`gpt-5.4-mini`、`gpt-5.4-nano`、`gpt-5-mini` 为 272k，`kimi-k2.7-code` 为 262k，其余 200k。Cursor 新增模型后需对照文档页补 `src/models.ts` 里的表。
- 思考档位：Pi 的 `--thinking` / `/thinking` 映射到该模型自己的参数（`effort`、`reasoning` 或 `reasoning_effort`；`xhigh` 在部分模型上写作 `extra-high`），带 `thinking` 开关的模型同时置位。模型不提供的档位在 Pi 里标为不可用。关闭思考时，有 `none` 档的模型用 `none`，有开关的关掉开关。
- `fast` 参数固定为 `false`。
- 只发送 Cursor 在 `variants` 里列出的参数组合；档位可以在同一个会话里逐轮切换，不会重建 agent。

## 通道映射

| Pi | Cursor | 说明 |
|---|---|---|
| `context.tools` | `local.customTools`，能力组只开 `mcp` | 名字和 schema 是 Pi 的。`tools: ["mcp"]` 关掉 shell、read、edit 等内置工具；去掉 `mcp` 会连 customTools 一起关掉 |
| `context.systemPrompt` | `systemPrompt`，整段替换 Cursor 内置人设 | 该选项按账号放行。未放行时写成当前用户私有目录里的 `AGENTS.md`（Windows 为 `%LOCALAPPDATA%/pi-cursor-host/instr/<内容哈希>`，可用 `PI_CURSOR_HOST_INSTR_DIR` 改），经 `local.dirs` + `settingSources: ["project"]` 作为项目规则加载，Cursor 内置人设保留 |
| `context.messages` | 对话 | 系统提示词不进用户消息 |
| 磁盘上的 Cursor 配置 | `mcpServers: {}`；系统槽可用时 `settingSources: []` | 不加载 `~/.cursor` 的 MCP 和规则 |

Cursor 的工作目录按 `session_start` 登记的 `sessionId -> ctx.cwd` 选择，模型给出的路径与 Pi 工具执行的路径一致。复用该 id 的无工具辅助请求也用同一目录；未登记会话的直接 provider 调用使用 `process.cwd()`。会话 shutdown 只清理该会话的 agent 与目录登记。

## 工具调用怎么走

一个 Pi 会话对应一个常驻的 Cursor agent。

1. 模型调用工具时，SDK 进入 `customTools.execute`。插件把这次调用作为 Pi 的 `toolCall` 交出去，本条 Pi 消息以 `toolUse` 结束，`execute` 保持挂起，Cursor 的 run 不取消。同一步里的并行调用在 150 ms 窗口内合并进同一条消息。
2. Pi 用自己的工具实现执行，下一次请求带着 `toolResult` 回来。插件按 `toolCallId` 把结果（文本、图片、错误标记）交还给挂起的 `execute`，同一个 run 继续。
3. run 结束后 agent 保留。下一条用户消息只发送新增文本，不重放历史。

每次请求按消息身份（角色 + 时间戳，工具结果按 `toolCallId`）核对历史是否与 agent 已知的一致：

| 情形 | 处理 |
|---|---|
| 新增的恰好是全部挂起调用的结果，run 仍存活 | 续接同一个 run |
| 同上，结果后面还跟着用户消息（工具执行期间的插话） | 先用 `run.steer()` 送入插话，再回填结果；Cursor 把插话接在工具结果之后，与 Pi 的顺序一致。Cursor 退回或调用失败时，插话在当前 run 结束后作为下一个 run 发出，仍属同一条 Pi 回复。插话带图片时改走重放 |
| agent 空闲（没有存活的 run），新增的只有用户消息 | 作为下一个 run 发送；`pi-context-prune` 的摘要消息不发送，agent 手里有原文 |
| 其它：压缩、`/tree`、中止、切换过模型、系统提示词或工具集变了 | 关闭旧 agent，新建并重放转录 |
| 没有工具的请求（Pi 的压缩、分支摘要复用同一个会话 id），或会话正在服务另一个请求 | 用一次性 agent 完成，不动会话的常驻 agent |

上下文裁剪只改工具结果的正文、不改 `toolCallId`，不会打断续接。

连接中断时 SDK 自动重连（`enableAgentRetries`，默认开），从最近的检查点续跑，并以同一个 `toolCallId` 再次调用 `execute`，包括结果已经交还、流里已报 `completed` 的调用（`npm run probe:retry` 实测）。每个调用只交给 Pi 一次：结果未到的重放并入同一个等待，结果已交还的重放直接拿到当时的结果（每个 run 保留最近 64 个）。

重放转录的规则：

- 每段以带随机标签的行开头（如 `[pi-3fa9c1d2 User]`），标签每次重放重新生成，工具输出和文件内容里出现的 `[User]` 之类文字不会被当成真实轮次。
- 保留每次工具调用的参数；没有对应结果的调用标明「未记录结果，不要假定已执行」，避免新 agent 把有副作用的调用再发一遍。
- 工具结果中的图片随结果段一起重放，正文标明工具、调用 id 与图片归属；只有图片的结果标为图片结果。
- 超出预算（模型上下文窗口的 60%，按每 token 2 字符折算）时保留第一条消息、最近一条用户消息和最新的若干条消息，其余以标记代替；单段过长的内容从中间省略。丢弃结果段时也丢弃该段图片。

没有请求挂接超过 30 分钟的 agent 自动释放（请求进行中不计时）；Pi 会话结束时释放其对应 agent。凭据解析、agent 创建及 send 等待阶段都可中止；迟到的 agent 立即关闭，迟到的 run 立即取消。释放、run 异常结束或被取消时，挂接中的请求立即以错误结束，不会悬挂；只有调用方自己的中止信号才报告为 aborted。

## 用量

Cursor 按 run 汇总上报用量，一个 run 可以跨多条 Pi 消息。以 `toolUse` 结束的消息用量为 0，run 的最后一条消息带整个 run 的 input、output、cacheRead、cacheWrite。steer 退回 followup 时，同一条 Pi 回复累加每段 run 的这四个字段，`totalTokens` 仍取最后一段的上下文估计。费用字段为 0：SDK 的 `agent.getUsage()` 能返回实际计费，但按账号开放，未开放的账号返回 `feature_unavailable`。被取消或丢弃的 run 不上报用量。

- 口径：Cursor 的 `inputTokens` 是整段提示词、含缓存命中部分（连续多轮对话实测：`input 15046 / cacheRead 14968`，下一轮 `15106 / 15045`）。写入 Pi 时 `input` 取未命中部分（`inputTokens - cacheReadTokens`），两者相加正好是提示词一次。
- 缓存命中由 Cursor 和上游模型决定，本插件每轮发送的前缀不变。`composer-2.5` 从第 2 轮起稳定命中约 99%。`grok-4.6` 在 2026-09-19 复测中与 Composer 同类：无工具 8 轮从第 2 轮起 96–98%；带 `read` 的 8 轮从第 2 轮起平均 98%，第 1 轮 65%（框架前缀部分命中）。2026-09-17 曾测到「0 或 512 / 整段」台阶和长任务 45–55%，视为当日上游波动，不作现行基线。记录见 `notes/verify/pi-cursor-host-cache-reprobe-20260919.md`。xAI 文档说明缓存按服务器存放、命中不保证；`x-grok-conv-id` 由 Cursor 后端决定，SDK 没有对应选项。
- `totalTokens`（Pi 和按阈值触发压缩的扩展用它估算上下文占用）是 run 最后一次模型调用的提示词量。SDK 只给整个 run 的合计：公开事件流和 `send` 的 `onDelta` 底层通道都只在 run 结束时给一次用量，本地 run 不发 `step-started`（`npm run probe:steps` 实测），所以这个值由合计除以模型调用次数得到。
  - 模型调用次数取事件流里完成的思考块数（带 `thinking_duration_ms` 的 `thinking` 事件），实测每次模型调用恰好一个。工具调用的批数不能当次数用：Cursor 会自己多调模型而不出工具事件（例如首次调用自定义工具前查工具 schema，2 次工具调用的 run 实测 4 次模型调用），同一次模型调用的并行工具调用也可能分两条 Pi 消息到达。
  - 没有工具调用的 run：合计除以次数。有工具调用的 run：提示词随工具结果增长，按线性增长从平均值外推最后一次，起点取上一个 run 结束时的上下文，没有时按本 run 交还的工具结果和输出的大小估算增长。
  - 模型不出思考块时次数未知：按工具批数加一计；没有工具调用时，以「上一个 run 的上下文 + 本次发出的文本」为基准把合计里的倍数除回去。
  - 实测（`composer-2.5`，生产配置）：带 2 次工具调用的 run 估计 14,985，紧接着的单次调用 run 上报 14,893。真实上下文在 Cursor 一侧，这里始终是估计。

## 已知限制

- `before_provider_request` 对 Cursor 提供者只读：`onPayload` 提供 provider、model、工具名摘要用于观察，返回的替换 payload 或原地修改不改变 SDK 的创建与续接计划。需要改变系统提示词、消息或工具集时，在 Pi context 进入 provider 前处理。

- 系统槽未放行时，Cursor 内置人设仍在，Pi 的系统提示词是项目规则。项目规则通道会让 SDK 从磁盘加载 Cursor 自带的 42 个技能（`~/.cursor/skills-cursor`），但它们不作为目录进入模型上下文：工作目录里没有下一条所列的技能目录时，模型能列出的技能只有 Pi 的 `<available_skills>`，整条通道实测每次请求多约 170 个输入 token。SDK 没有关闭技能加载的选项；升级 `@cursor/sdk` 后用 `npm run probe:skills` 复核。
- 未放行模式下 Cursor 会按自己的规则读取工作目录里的说明文件（`npm run probe:rules` 实测，`@cursor/sdk` 1.0.31）：
  - 会读：`AGENTS.md`、`CLAUDE.md`、`CLAUDE.local.md`、`.cursor/rules/*.mdc` 中 `alwaysApply: true` 的正文和带 `description` 的规则的描述，以及 `.cursor/skills`、`.claude/skills`、`.agents/skills` 下技能的名称与描述。
  - 不读：上级目录和子目录里的同名文件、`.cursorrules`、`AGENT.md`、`GEMINI.md`、`.windsurfrules`、`.clinerules`、`.github/copilot-instructions.md`、`.claude/CLAUDE.md`、`.cursor/rules/*.md`、按 glob 触发的规则正文、技能正文。
  - Pi 每个目录只嵌入一个说明文件（`AGENTS.md` 优先，其次 `CLAUDE.md`）。工作目录的这两个文件在 Pi 系统提示词里对应的 `<project_instructions>` 块写入规则文件前去掉，同一份内容只进一次上下文；其它文件名和其它目录的块保留。
  - 差异：工作目录同时有 `AGENTS.md` 和 `CLAUDE.md` 时 Pi 只用前者，Cursor 两个都给模型；`CLAUDE.local.md`、`.cursor/rules`、`.cursor/skills`、`.claude/skills` 是 Pi 不读而 Cursor 会给模型的内容；`.agents/skills` 两边都列。系统槽放行后这些都不加载（`settingSources` 为空时实测一个都不读）。
- 连接中断后的自动重连从检查点续跑，检查点之后已经流出的助手文字会重新生成并再流一遍，流里没有重连标记，Pi 消息里会出现重复的文字。工具调用不受影响。
- 网络完全不通（连接能建立但无应答）时 SDK 不报错也不出事件，实测 7 分钟内请求一直挂着；在 Pi 里中止即可，取消是本地操作，毫秒级返回（`npm run probe:cancel -- --mode=wedged`）。
- Cursor 自己的运行框架每个模型步约占 5k 输入 token，无法裁剪。
- 常驻 agent 的上下文由 Cursor 管理，Pi 侧的裁剪不会缩小它。内置压缩、`pi-midrun-compact`、`pi-context-prune` 的安装、开关与接法见 [docs/compaction-plugins.md](docs/compaction-plugins.md)。
- 消息身份只看角色和时间戳：其它扩展原地改写用户或助手消息正文时，Cursor 一侧保留的仍是改写前的原文。
- 模型不提供的思考档位取最接近的一档（偏低），例如 Grok 4.6 请求 `max` 实发 `xhigh`。

## 探测与测试

```bash
npm test                          # 单元测试：裁剪合同、续接判定、会话状态机、转录与截断、用量、模型与思考档位
npm run probe                     # 工具面与系统槽放行状态
npm run probe:hold -- --hold=75   # execute 长时间挂起、并行调用、跨 send 保留上下文
npm run probe:skills              # 模型只看得到 Pi 的技能目录，Cursor 自带技能不进上下文
npm run probe:steer               # 工具挂起期间 run.steer() 的回执与注入位置
npm run probe:retry -- --drop=pending        # 掐断到 Cursor 的连接：execute 是否以同一 id 重放（pending|after-result|streaming）
npm run probe:rules -- --sources=project     # Cursor 自己会读哪些说明文件（project|none）
npm run probe:cancel -- --mode=wedged        # 释放序列能否让流返回（pending|pending-keep|streaming|wedged|wedged-wait）
npm run probe:steps                          # onDelta 底层通道：模型调用次数、每个 run 几次用量上报
```

本机 Cursor host 通过目录联接加载本仓源码，修改不需要复制部署；已加载的实例需新会话或 `/reload` 才使用新实现。

`PI_CURSOR_HOST_DEBUG=1` 在 stderr 打印每次请求的判定（`plan=fresh|resume|followup`）和发给 Cursor 的模型参数。`PI_CURSOR_HOST_IDLE_MS` 调整常驻 agent 的闲置释放时间（默认 30 分钟）。`PI_CURSOR_HOST_SYSTEM_PROMPT=0|1` 强制关闭或开启系统槽。放行状态记在 `~/.pi/agent/cursor-host.json`。
