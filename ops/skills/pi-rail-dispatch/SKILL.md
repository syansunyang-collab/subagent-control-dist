---
name: pi-rail-dispatch
layer: orchestration
domain: codex-control-plane
capability_group: pi-rail-dispatch
portability: repo-bound
description: Use when sending work to a Pi-rail subagent (sol, grok, astra, luna and other external models) — implementation, read-only scans, research, reviews, one-shot expert consultations, or a background run whose result comes back later. 触发：派子代理、丢 pi 轨、让 sol / grok / astra 看一下、专家问询、派个调研、后台跑一单、等子代理结果、子代理交不了卷。Covers choosing the model, writing the seed, waiting asynchronously, collecting and checking the result, and known failure patterns. Not for Claude-native Agent-tool subagents, and not for planning a multi-slice fan-out (subagent-fleet-discipline).
---

# Pi 轨子代理派发

> 职责：Pi 轨子代理的选型、种子、异步等待与收结果。
> 真源：Pi 轨单任务派发的操作约定
> 读取：命中读取

## 入口

- Claude Code：用户级 MCP 工具 `subagent_prepare`（`action=template` 取种子骨架与可用 pick，`list` 查路由）、`subagent_dispatch`、`subagent_wait`、`subagent_get`、`subagent_result`、`subagent_cancel`；多节点批次用 `fleet_*`。
- Pi：全局扩展注册同一套工具与 `dispatch_prepare`，任务结束自动推送完成通知。
- 控制面发布后，已在运行的会话仍连着旧服务：`subagent_server_info` 的 `build_id` 与 `~/.subagent-control/releases/subagent/` 下最新目录不一致时，新开会话再派。旧服务派出的任务用旧 runner，今天修过的问题会原样复现。

## 选型

`pick` 与 `model` 至多给一个，都不给时用能力默认；`effort` 可单独给出，须在模型可选档位内。显式档位越出所在推荐行的 `[min–max]`（`effort_range`），或用不在本角色推荐行里的模型（`outside_pool`）时，带 `authorization: {quote: 用户原话, overrides: [...]}` 并显式给 `effort`。

| 模型 | 适合 |
| --- | --- |
| sol | 规格明确的实现、只读盘点与复核；做外部调研时容易交空壳报告 |
| grok | 根因诊断、第二视角复核；探查习惯重、费用高 |
| astra | 方案设计与专家问询；上限 medium |
| luna | 机械批处理、冒烟单 |

## 写种子

- 必填 `route_id`、`goal`、`scope.read`（路径须已存在）；写 `title`，二十字内的名词短语。
- 最小路由（`general-agent__general-default`）不收 `contract`，任务细节写进 `goal`、`inputs`、`known_facts`。
- 专家问询：`general-agent` 的 pick `consult_design` 或 `consult_diagnosis`，`tool_contract.allowed: []`，卷宗全文放进 `known_facts`；专家没有写文件工具时直接内联交卷。
- 调研与审查任务在 `known_facts` 写明：报告正文逐项给出结论与证据（文件:行或 URL），不写「完整报告见本文件」这类自我引用；bash 里写 `/dev/null`，不写 `NUL`。
- 派给 OpenAI 系模型的任务避开「红队」「攻击」一类措辞，写成「失效模式分析」「可靠性审查」，否则会被内容过滤拦下。

## 异步等待

- Claude Code：派出后，以后台命令运行
  `node <home>/.subagent-control/releases/consumer/current/ops/consumer-tools/async_watch.mjs --project <project_root> --tasks <id,...> --until-done`，
  命令退出即全部任务到达终态，期间继续做不冲突的工作。确需阻塞等待时用 `subagent_wait`（`timeout_ms` 最长 600000）。
- Pi：等完成通知，不轮询。

## 收结果

- `subagent_result` 取回执与报告路径；报告与 handoff 落在目标仓 `notes/`，按需提交。
- 先读报告正文核对，再使用结论：回执和子代理自述不是证据；改代码的任务看 `git diff` 与测试实跑。
- 子代理可能在仓根留下名为 `NUL` 的空文件，收尾时删除。
