---
name: skill-authoring-governance
layer: orchestration
domain: codex-control-plane
capability_group: skill-governance
portability: repo-bound
description: Use when creating, rewriting, reviewing, merging, archiving, deleting, or governing Codex skills or project-local skills — any work on skill entry files or directories under ops/skills/. 创建技能、写技能、改技能、重写技能、审查技能、合并归档删除技能、技能触发不准要修. Start by reading the authoring model, then route to governance or quality checks as needed, and run mechanical validation before final handoff. Not for authoring ordinary repo rule files (policies, workflows, routes — those follow ops/skills/rule-authoring/SKILL.md), and not for one-off task notes, status records, or memory content.
---

# skill-authoring-governance

> 职责：路由技能创建、重写、审查、合并、归档、删除和漂移修订。
> 真源：本技能入口与资源；通用写作判据依赖 ops/skills/rule-authoring/SKILL.md。
> 读取：命中读取

## 首动作与分流

重操作（新建、重写、扩展、合并、归档、删除、归属判定）：先读创建规程，按治理判定确认归属，再用一张「技能合同」记录决策；审查已有技能时直接进入质量门。写前自查与写后审查使用同一质量判据。

轻修补（错字、等义措辞、路径修正）：直接修改并核对差异，不填合同。
BLOCK IF: 以轻修补名义改变触发边界、资源路由或工作流。出口：转重操作，补齐技能合同后继续。

出现声明与行为偏差时进入漂移修订；登记与本轮是否修复分开处理。

## 资源路由

| 情况 | 资源 | 产出 |
| --- | --- | --- |
| 新建、重写、扩展或其他重操作 | ops/skills/skill-authoring-governance/references/skill-authoring-model.md | 八项技能合同、结构与资源安排 |
| 判断归属、重叠、合并或退出 | ops/skills/skill-authoring-governance/references/skill-governance-routing.md | 合同中的相邻技能、归属与用户决策 |
| 写前自查、审查或改后收口 | ops/skills/skill-authoring-governance/references/skill-quality-gate.md | 质量结论、采用的证据、必须修补项 |
| 触发不准、方法过时或资源路由失灵 | ops/skills/skill-authoring-governance/references/skill-drift-repair.md | 漂移登记与修订证据 |
| 编写触发描述、核对触发或回归行为 | ops/skills/skill-authoring-governance/references/trigger-cases.md | 受影响判例及实际结果 |
| 修改元数据、目录结构或资源引用 | ops/skills/skill-authoring-governance/scripts/validate_skill_structure.py | 按质量门命令运行，取得机械证据 |

## 编写与交付

用指令式中文写正文；触发描述、固定字段、命令、API、路径和代码保留所需语言。用用途命名技能和资源，把研究背景、来源说明、会话占位名留在任务材料中。

按质量门限定验证范围并交付结论；遇到缺少的输入或授权，说明缺口和合法下一步，交用户决定。实际修改、证据与未解决项合并说明，不另造流程表。
