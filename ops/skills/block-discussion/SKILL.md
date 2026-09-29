---
name: block-discussion
layer: orchestration
domain: control-plane
capability_group: block-discussion
portability: repo-bound
description: 'Use when a task is blocked and the blocker must be escalated to the owner as a structured discussion — 受阻、卡住需要用户裁决、blocked 收口、needs_owner 汇报格式. Covers the blocker discussion contract: facts, attempts, options, and the ask. Not for ordinary progress updates or review findings.'
---

# Block Discussion Policy

> 职责：规定阻塞讨论触发、输入和出路。
> 真源：阻塞讨论触发条件、输入要求和出路规则
> 读取：命中读取

本文件用于多轮验证失败或用户要求讨论卡点时的阻塞分析。

阻塞讨论字段统一放入 `task_package.extensions.block_context`。不得绕过 `ops/protocols/task-package.md` 另起任务包格式。

## §1 触发

任一情况触发：

1. `push_through` 模式第 3 轮验证仍 fail，且用户在 `ops/policies/long-task.md` §7 终止上报中选择进入阻塞讨论
2. 同一里程碑 `rollback_count = 1` 后重新实施仍 fail，且用户**显式要求**讨论卡点
3. 用户主动发起"讨论卡点"/ "再撑一下"等指令

普通模式第 2 轮验证仍 fail 时**不自动**进入讨论，除非用户明确要求；避免子代理配额空转。

## §2 派发

主代理先检查当前线程授权摘要（字段以 `ops/protocols/task-package-reference/field-dictionary.md` 为真源）：

- `agent_runtime_consent.subagents_allowed=false`：不进入子代理讨论，改为向用户说明需要重新授权或缩小排障范围。
- `concurrency_contract.parallel_policy=forbidden | barrier_required`：按下表串行派发，先 explorer 后 research。
- `concurrency_contract.parallel_policy=allowed_if_no_conflict`：并发派**无记忆子代理**。

| 子代理 | 任务 | 落盘 |
| --- | --- | --- |
| `explorer-agent` | 扫卡点周边代码 / 依赖链 / 相关历史改动 / 配置漂移 | `notes/explorer/block-${milestone}.md` |
| `research-agent` | 仅当卡点涉及外部库 / API / 规范时检索官方和公开问题 | `notes/research/block-${milestone}.md` |

**`verify-agent` 不参与讨论**（审查者立场必须中立）。

**`plan-checker` 不参与讨论**（PLAN 已通过审查才进入实施，卡点不是 PLAN 问题）。

**`general-agent` 不参与**（block_context 由 research + explorer 承担）。

## §3 block_context 字段

任务包除常规字段外必须包含：

| 字段 | 内容 |
| --- | --- |
| `milestone` | 卡住的里程碑名 |
| `fail_history` | 轮次、target_kind、file:line（多行写 `file:start-end`）、description |
| `attempted_fixes` | diff 摘要和失败原因 |
| `current_diff` | 当前 diff 或非 git 变更证据 |
| `task_description` | 原任务目标 |

结构位置：

```yaml
task_package:
  extensions:
    capability_contract: <按选中能力填写；无则 null>
    block_context:
      milestone: <卡住的里程碑名>
      fail_history: <按上表 fail_history 合同填写>
      attempted_fixes: <diff 摘要和失败原因>
      current_diff: <当前 diff 或非 git 变更证据>
      task_description: <原任务目标>
```

## §4 输出

子代理必须给出三类结论之一：

- `方案明确` — 可重新实施
- `需要权衡` — 需要用户决策
- `方案无解` — 当前路径已穷尽

未给明确分类，按"需要权衡"处理并上报用户。

## §5 出路

| 评估结果 | 主代理动作 |
| --- | --- |
| 方案明确 | 重新实施，验证轮数清零 |
| 需要权衡 | 上报用户附两份分析（research + explorer 双产出） |
| 方案无解 | 上报用户附已穷尽路径（关联 `ops/policies/long-task.md` §7 终止上报三段式）|

## §6 重复讨论限制

**同一卡点最多触发一次讨论**。同一卡点判定：取两次触发时 `fail_history` 各自最近一轮的记录比较，`target_kind` 一致，且 `file:line` 所指文件相同、行区间重叠比例（交集行数 / 较小区间行数；单行视为闭区间 `[n,n]`）≥ 70%。

讨论后重新实施仍 fail → 必须上报用户，**不得再次讨论**（避免无限循环）。
