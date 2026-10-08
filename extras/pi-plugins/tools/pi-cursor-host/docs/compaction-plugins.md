# 压缩与摘要扩展

`pi-cursor-host` 把 Pi 会话接到常驻 Cursor agent。Pi 侧有三套彼此独立的压缩/摘要机制，开关不共用。本文件记录安装、选择与 cursor-host 的接法。

## 三套机制

| 名称 | 作用 | 开关 |
|---|---|---|
| Pi 内置压缩 | 回合结束时 `ctx.compact()` 的官方管线 | `~/.pi/agent/settings.json` 的 `compaction.enabled` |
| `pi-midrun-compact` | 工具批次完成后、下一轮模型请求前，在阈值处调用 `ctx.compact()` | 包是否安装；`~/.pi/agent/extensions/pi-midrun-compact/config.json` |
| 本地 `pi-compaction-model-recovery` | 指定压缩写手模型并接入 provider 恢复路径，不改压缩算法 | 本地包是否加载及 `compactionModel` 配置 |
| `pi-context-prune`（及同标记的实现） | 裁剪已完成的工具结果；摘要标记按实现选择 | 包是否安装及其策略配置 |

`compaction.enabled` 为 `false` 时，midrun 与 prune 仍按其自身配置运行。

## 现行加载入口（Pi 0.99.1）

压缩写手加载 `~/.pi/agent/local-packages/pi-compaction-model-recovery`，源码与部署入口由控制仓 `adapters/pi/user-addons` 维护。`npm:pi-compaction-model` 是退役副本，不用于现行维护。当前 `compactionModel` 为 `openai-codex/gpt-6-luna-fast-700k`，`thinkingLevel` 为 `xhigh`；配置真源是控制仓 `adapters/pi/user-addons/manifest.json`，现场由 `~/.pi/agent/settings.json` 承载。

midrun 使用 `pi-midrun-compact@0.1.2`；裁剪使用发布的本地 `pi-context-prune` fork，维护入口是插件仓 `tools/context-prune-release.py`。历史 npm 裁剪包 `@syansunyang/pi-context-prune@1.5.2` 不代表活跃安装。cursor-host 不按包名识别 prune，只认消息正文是否以 `<context-prune-summary>` 开头。

## 选择与配置

内置压缩：

```json
"compaction": { "enabled": false }
```

midrun 配置文件：`~/.pi/agent/extensions/pi-midrun-compact/config.json`

```json
{
  "enabled": true,
  "thresholdPercent": 90,
  "autoResume": true,
  "notify": true
}
```

状态命令：`/midrun-compact status`。默认阈值在未写配置时为 75%。

本地恢复包通过 `compactionModel` 选择 `ctx.compact()` 的摘要写手。未配置有效写手时退回主模型；不要改写退役 npm 副本来维护当前加载的扩展。

## cursor-host 如何处理

判定入口：`src/continuity.ts` 的 `planTurn`。消息身份是角色加时间戳；工具结果身份是 `toolCallId`。prune 改工具结果正文、保留 `toolCallId`，身份不变，续接不中断。

| 扩展行为 | 常驻 Cursor agent |
|---|---|
| 消息以 `<context-prune-summary>` 开头（`src/prompt.ts`） | 闲置 followup 不把该条发给 Cursor。agent 侧仍保留工具原文 |
| JSONL 历史被改写（压缩条目替换原消息、身份对不上 `known`） | `planTurn` 得到 `fresh`：关掉旧 agent，新建并重放当前转录 |
| 压缩/分支摘要等无工具、且复用同一会话 id 的请求 | 一次性 agent，不动会话的常驻 agent |

`pi-midrun-compact` 成功调用 `ctx.compact()` 后，历史通常变成压缩条目，下一次带工具的模型请求走新建 agent + 重放。`autoResume` 为 true 时，压缩结束后会继续当前任务，用户侧像同一轮，Cursor 侧已经换了 agent。

## 维护

- `PI_CURSOR_HOST_DEBUG=1`：stderr 打印 `plan=fresh|resume|followup`。midrun 压缩之后下一次请求应为 `fresh`。
- 续接合同：`npm test` 中 `test/continuity.test.mjs`。
- 升级 prune 实现时确认摘要仍以 `<context-prune-summary>` 开头，否则 followup 会把摘要当用户消息发给 Cursor。
- 升级 midrun 时确认仍走 `ctx.compact()` 改写 JSONL；若改为只改正文、保留时间戳，cursor-host 会误判为可续接。
