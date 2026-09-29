---
name: tooling-iteration
layer: orchestration
domain: codex-control-plane
capability_group: tooling-iteration
portability: repo-bound
description: Use when a repo control-plane tool misbehaves during real use — dispatch_prepare / async wrapper / checkers / hooks / map errors out, behaves contrary to its docs, mislabels task outcomes (usable results reported as failed), or produces friction that forced a manual workaround. 触发：工具报错、工具行为跟文档不符、工具把能用产物标 failed、校验器误报迫使手工绕过、工具问题登记与修复验证。Registers the issue, triages root cause, verifies the affected behavior, and closes with evidence; reuses or adds lasting regression coverage when it protects an ongoing contract. Not for business-task failures caused by task content, not for feature requests with no observed friction, and not for one-off environment glitches that do not reproduce.
---

# tooling-iteration

> 职责：记录工具使用中的问题，驱动分诊、修复、受影响行为验证和证据关闭。
> 真源：本技能承载登记格式、分诊闭集与修复纪律；各工具行为真源是其源码与自测
> 读取：命中读取

## 核心口径

把现场绕过的问题登记下来，使后续使用者能找到原因和处理结果。按「登记 → 分诊 → 修复 → 验证关闭」推进。修复时复用能覆盖受影响行为的现有用例；持续有效的功能契约缺少覆盖时补充回归用例。文档或使用引导修正采用对应的内容与入口核对。长期资产准入和临时资产退场按 `ops/policies/test-tooling-governance.md` §2 处理。

## 登记

WHEN: 工具报错、行为与文档不符、结果标签与事实错位（可用产物被标 failed、失败被标 done）、或摩擦迫使临时手工绕过。
MUST: 当轮先落盘登记，再决定修不修；登记与修复解耦，不因暂时不修而不登记。
OUTPUT: `notes/tooling/<YYYYMMDD>-<slug>.md`，头部字段与正文段：

```markdown
# <一句话现象>

> status: open | fixing | fixed | verified | wontfix
> severity: blocking | degrading | cosmetic
> component: <工具文件相对路径>
> registered: <YYYY-MM-DD>

## 现象
## 最小复现（命令与输入，可实跑）
## 影响面（谁在什么场景踩到，误判后果）
## 分诊（按分诊闭集，含证据）
## 修复记录（改动文件、验证方式与证据、回归用例处置、适用的 rationale 引用；未修留空）
## 验证（关闭前实跑证据；未验留空）
```

BLOCK IF: 只在会话里口头描述摩擦、不落盘登记。出口：按上表补登记。

## 分诊闭集

| 类别 | 判定 | 修复方向 |
| --- | --- | --- |
| 工具实病 | 行为违背自身声明或产生错误结果 | 修工具源码 |
| 契约漂移 | 两层各自正确、接口期望不一致（构包层 vs 收集层、状态层 vs 消费层） | 对齐契约并写入唯一真源，两侧同步 |
| 文档滞后 | 工具对、文档描述过时 | 修文档 |
| 使用误姿 | 工具与文档均对、使用方式错 | 修引导：报错文案、seed 骨架提示或对应技能 |
| 规格外期望 | 现有设计不覆盖的新需求 | 不算病；转拍板项，由 owner 决定立项或 wontfix |

同根因的多条现象合并登记为一条 issue，现象列表附于正文；分诊拿不准时按最重类别登记，修复时再降级。

## 修复纪律

WHEN: issue 进入 fixing。
MUST:

1. 读该工具源码定位真源，最小修，不顺手重构相邻逻辑。
2. 按分诊结果选择能验证受影响行为的方式。复用已有覆盖；持续有效的功能契约缺少覆盖时补相应用例，并登记其与 issue 的关系。将一次性复现的输入与结果记为修复证据；需要长期保留的用例按资产准入处理，临时探针按已记录的退场条件处理。
3. 只测试验证本次修改部分，复用已有有效结果；治理文档仅核对修改涉及的引用。
4. 控制面语义变更按 `ops/skills/change-rationale/SKILL.md` 落 rationale；issue 修复记录段引用 rationale 路径。
5. 修复后记 fixed，取得本次修改的验证证据后记 verified 并收口。

## 升级判据

同一 component 累计 3 条 verified 或 open 的同根因 issue 时，停止逐条打补丁：起草重构提案（问题清单、根因归纳、方案与迁移成本）交 owner 拍板。逐条修补是战术，根因归纳是本技能对控制面的长期义务。

## 收口

每批修复完成后，同步登记文件状态与台账，记录适用的 rationale 和本次验证结果，按批提交。说明复用了哪些证据、保留了哪些回归覆盖，以及临时资产的处置。commit message 引用 issue 文件路径，使现象、修复证据与提交可互查。
