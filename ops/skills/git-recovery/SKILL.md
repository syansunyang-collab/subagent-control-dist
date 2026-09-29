---
name: git-recovery
layer: orchestration
domain: control-plane
capability_group: git-recovery
portability: repo-bound
description: Use when a Git operation in this repo goes wrong or needs unwinding — 回退、revert、收口失败、提交异常、工作区归属不明、分支操作、误提交处理. Covers exception triage, rollback boundaries, revert flow, and ownership-unclear worktree changes. Not for routine staging, commits, or status checks.
---

# Git Workflow Policy

> 职责：处理日常 Git 收口失败、回退、revert、分支动作和工作区归属不明变更。
> 真源：异常 Git 处置、回退边界和工作区归属不明处置规则
> 读取：命中读取

本文件不负责每轮入口现场检查，也不负责阶段性完成后的日常提交收口。日常路径：动文件前查看 Git 现场；阶段性完成后只提交本任务文件。

主代理只在 Git 收口失败、需要回退 / revert / 分支操作、处理提交异常、工作区归属不清，或用户明确点名 Git policy 时读取本文件。本文件不覆盖日常入口现场检查和提交纪律。

## 1. 异常入口

WHEN: 命中任一 Git 异常处置触发项
ACTOR: 主代理
MUST: 进入本文件完成分析、修正、提交、回退、revert 或请求用户决定

Git 异常处置触发项：

- 用户明确要求回退当前工作区改动。
- 用户撤销当前任务，且已有未提交改动。
- 校验失败，且当前轮无法修正到可提交状态。
- 写入结果偏离用户最新要求，且当前轮无法继续修改收敛。
- 工作区出现主代理无法解释来源、用途或保留价值的未提交改动。
- 暂存失败、提交失败、revert 失败或提交后 `git status --short` 仍非空。

BLOCK IF:

- 命中异常入口后继续按日常提交收口硬冲。
- 未分析归属不明变更就删除、回退或提交。
- 用户要求提交当前工作区全部改动时，用旧式归属理由拒绝提交。

## 2. 归属不明分析

WHEN: 工作区存在来源、用途或保留价值不清的未提交改动
ACTOR: 主代理
MUST: 分析后选择保留、删除、回退、修正或请求用户决定

必查命令：

```bash
git status --short
git diff -- <path>
git diff --cached -- <path>
```

处置标准：

- 能确认是当前任务或子代理产物：保留，随当前工作区提交。
- 能确认是临时文件、中间产物、误生成文件或无保留价值文件：删除或回退。
- 能确认偏离用户最新要求：修正或回退。
- 无法确认来源或价值：停止处置，询问用户提交、删除或保留待查。

BLOCK IF:

- 把归属不明直接等同于“不能提交”。
- 对来源和价值不明的改动执行回退。

## 3. 回退和 revert

WHEN: 需要放弃改动或撤销已提交改动
ACTOR: 主代理
MUST: 区分未提交回退和已提交撤销

允许回退未提交改动：

- 用户明确要求回退。
- 当前任务撤销，且改动尚未提交。
- 校验失败且无法修正。
- 写入结果偏离最新要求且无法收敛。
- 变更确认是临时文件、中间产物、误生成文件或无保留价值文件。

Git 风险动作：

- 已提交改动需要撤销：优先用新的修正提交或 `git revert <commit>`；用户明确要求改写历史时，说明影响范围后执行对应 Git 动作。
- 来源和价值不明的未提交改动：先按 §2 分析，仍不清楚时问用户。
- 用户明确要求提交当前工作区全部改动：不得用旧式归属理由拒绝提交。
- `git reset --hard`、`git clean -fd`、`git checkout -- <path>`、`git commit --amend`、`git rebase`、`git push --force`：先说明影响范围、目标路径或 commit、恢复方式，再按用户确认执行。
- 凭证、环境文件、大文件、缓存目录或未知二进制：先判断来源、用途和保留价值；能确认属于当前任务且用户要求保留时，随当前工作区提交。

BLOCK IF:

- 未判断改动属于未提交回退还是已提交撤销就执行处置。
- 用户已要求提交当前工作区全部改动，却用文件数量、路径数量、大文件、缓存目录或旧式风险标签阻断提交。
- 发现凭证、环境文件、大文件、缓存目录或未知二进制时，不判断来源、用途和保留价值就删除、回退或阻断提交。
