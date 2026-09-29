---
name: change-rationale
layer: orchestration
domain: control-plane
capability_group: change-rationale
portability: repo-bound
description: Use when a change reverses a decision already recorded, or moves a gate, permission or ownership boundary, and the diff plus commit message do not explain it — 这次改动要不要留决策记录、写变更理由、推翻旧决策怎么记. Covers the record threshold, record fields, and how a follow-up change updates an existing record. Not for wording edits, single-rule changes, prompt phrasing, trial toggles, commit messages, notes, or status updates.
---

# Change Rationale Policy

> 职责：规定控制面决策记录的留档门槛、记录内容和提交引用。
> 真源：留档门槛、记录字段、检索与提交引用规则
> 读取：命中读取

决策记录存放在 `docs/decisions/change-rationale/`，读者是几个月后接手同一处改动的人。

## 1. 留档门槛

只有两类改动写记录，且理由从 diff 加 commit message 看不出来：

- 推翻已有记录里的决定。
- 移动 gate、权限或归属边界（含删除其它位置依赖的门禁）。

其余改动不写记录，理由写进 commit message 或本轮回复：缺陷修复、工具行为调整、措辞与文风、单条规则的增删改、提示词表述、试用开关。

## 2. 写前检索

WHEN: 本轮拟改路径落在下列控制面位置

- `AGENTS.md`
- `PROJECT.md` 中的工程边界、目录约定和提交策略
- `ops/workflows/**`、`ops/policies/**`、`ops/protocols/**`
- `ops/agent-prompts/**`、`ops/agents/**`、`ops/hooks/**`、`ops/tools/**`
- 模板副本目录（存在时）
- `docs/architecture/**`、`docs/operations/**`、`docs/modules/**`、`docs/review/**` 中描述控制面不变量的正式文档

ACTOR: 主代理
MUST: 用路径关键词检索 `docs/decisions/change-rationale/`，读取命中的记录后再改
STATE UPDATE: 命中的记录路径在本轮回复或任务 notes 中点名。

```powershell
rg -n "<仓库相对路径或稳定文件名>" docs/decisions/change-rationale
```

目录不存在时检索结果为空，直接继续。

## 3. 记录位置

一个决策一份记录：`docs/decisions/change-rationale/<YYYYMMDD>-<slug>.md`。同一决策的后续改动更新这份记录，不新建文件。推翻旧决策时新建记录并写 `Supersedes`。旧记录只被推翻部分条款时补一行 `superseded_by` 指回新记录；核心决定整体被推翻时，把旧记录 `git mv` 到 `docs/archive/decisions/change-rationale/`，不再留在检索目录。

BLOCK IF: 把记录正文写进 `AGENTS.md`、workflow、agent prompt 或 commit message 替代记录文件；或原地改写旧记录使被推翻的决定消失。出口：新建记录并写 supersede 链。

## 4. 必填字段

WHEN: 新增或更新记录
ACTOR: 主代理
MUST: 写标题、日期和下列三节，`Supersedes` 无内容时删掉该节
OUTPUT: `docs/decisions/change-rationale/<YYYYMMDD>-<slug>.md`

```markdown
# <标题>

> 日期：YYYY-MM-DD

## Change and Why

<改了什么，为什么这么改>

## Supersedes

<被替代的记录路径，以及这次推翻了它的哪一条>

## Signals It Was Wrong

<出现什么现象说明这个决定选错了>
```

受影响文件、验证证据和后续项按需写，只在读者判断这条决定时用得上才出现。

## 5. 提交前引用

WHEN: 本次提交包含达到 §1 门槛的改动
ACTOR: 主代理
MUST: commit message 正文写 `Rationale: docs/decisions/change-rationale/<file>.md`
BLOCK IF: 达到门槛且没有可引用的记录。出口：补记录后提交。
STATE UPDATE: 记录文件长期保留。

executor 的授权写入范围包含达到门槛的改动时，构包要求其 `commit_msg_draft` 含 `Rationale:` 行。
