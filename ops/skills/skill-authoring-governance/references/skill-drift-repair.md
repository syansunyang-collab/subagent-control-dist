# 技能漂移修订

> 职责：把声明与行为偏差登记、分诊、回归并修订关闭。
> 真源：技能漂移登记与分诊；登记骨架沿用 ops/skills/tooling-iteration/SKILL.md 的工具 issue 格式。
> 读取：命中读取

## 登记

该触发没触发、近失配误触发、方法与现状不符、资源未读或读错时，当轮先登记再决定是否修复；同根因现象合并为一个 issue（问题记录）。

写入 `notes/tooling/<YYYYMMDD>-skill-drift-<技能名>.md`，记录：

```markdown
# <一句话现象>

> status: open | fixing | fixed | verified | wontfix
> severity: blocking | degrading | cosmetic
> component: <技能路径>
> registered: <YYYY-MM-DD>

## 现象
## 最小复现
## 影响面
## 分诊
## 修订记录
## 验证
```

最小复现写话术或可执行片段，影响面写场景与后果，分诊附证据；未修、未验部分留空。

## 分诊

| 类别 | 判定 | 修订方向 |
| --- | --- | --- |
| 触发漂移 | 话术与 description 错位、缺语言关键词 | 改触发词与反触发 |
| 内容漂移 | 方法、判据或命令过时 | 改正文 |
| 结构漂移 | 路由失灵、资源缺失或移位 | 修路由、指针或分层 |
| 应废弃 | 任务类已消失 | 按 ops/skills/skill-authoring-governance/references/skill-governance-routing.md 提出归档或删除候选 |

分诊未定时暂按影响最重的类别登记，补证后调整。

## 修订与关闭

1. 进入 fixing；涉及触发或行为判据时，先更新目标技能的 `references/trigger-cases.md` 中受影响判例，再改正文。无对应判例变化时，在修订记录说明原因。
2. 按 `ops/skills/skill-authoring-governance/SKILL.md` 区分轻修补和重操作，后者使用技能合同。
3. 按 `ops/skills/skill-authoring-governance/references/skill-quality-gate.md` 选择增量证据；触发漂移验受影响触发，纯内容或结构漂移核对相应行为、资源与机械结果。
4. 判例与修订记录同步后标 fixed；验证段写入实际结果与来源后标 verified。下一次真实使用自然复验，不另设关闭前置轮次。

获准提交时把判例与正文同批提交，提交说明引用 issue 路径，保持现象、判例与修订可互查。
