---
name: writing-governance
layer: orchestration
domain: codex-control-plane
capability_group: writing-governance
portability: repo-bound
description: Use for repo document writing (README, PROJECT, handoffs, verification reports, notes) or deciding which writing criteria apply to mixed documents, rules, and model-facing tool text. 触发：写 README、验证报告或 handoff；混合写作分流；区分源码里的模型接口文案与普通注释。Direct rule or model-facing tool-text writing/review uses rule-authoring; skill files use skill-authoring-governance. Not for pure implementation edits, ordinary code comments, or uncommitted scratch notes.
---

# writing-governance

> 职责：把仓内书写任务路由到对应判据，并要求落盘前完成对应自检。
> 真源：本技能只承载路由与落盘门；规则判据真源是 `ops/skills/rule-authoring/SKILL.md`，文档判据真源是本技能 references
> 读取：命中读取

## 核心口径

按内容功能和受众分流，不按文件扩展名。源码里的模型可见description、参数说明、seed模板、错误提示和运行通知同属模型接口文案；普通实现、注释及面向人的UI文案不是模型规则。

动笔前先回答三问：受众是谁；这个事实的真源在哪；删掉这段后读者行为是否改变。已有真源时复用对应消费面，不独立维护第二份事实。

## 路由

| 写作对象 | 判据 | 落盘门 |
| --- | --- | --- |
| 控制面规则与模型接口文案：AGENTS、workflow / policy / protocol / route / prompt，以及源码或模板中的工具说明、参数帮助、错误与通知 | `ops/skills/rule-authoring/SKILL.md` §1 写作原则 + §2 R1–R12 | 该文件 §3 变更流程（含 CHANGE_PLAN 与派审条件） |
| 文档：README、PROJECT、handoff、验证与审查报告、rationale、notes 沉淀 | `ops/skills/writing-governance/references/document-writing.md` | 该文件「落盘自检」逐项过 |
| 技能文件：`ops/skills/**` | 转 `skill-authoring-governance` 技能，本技能不承载 | — |

WHEN: 同一批改动同时涉及规则与文档
MUST: 分别按对应判据自查；规则侧命中 `ops/skills/rule-authoring/SKILL.md` §3 派审条件时照常派审，文档侧不因混批豁免自检
OUTPUT: 两侧自检结论

BLOCK IF: Markdown治理文档落盘后未运行 `python -B ops/tools/reference_resolution_check.py --source <file>`。出口：补跑，失败时修正对应缺口后重跑；已知存量误报按台账记录依据。

源码中的模型接口文案使用所属工具的schema、渲染或接口测试验证，不套用Markdown路径扫描。

## 边界

- 本技能不修改判据本身；判据变更走各真源文件的维护流程。
- 状态文件（`STATUS.md` / `ROADMAP.md`）由 `state_checkpoint.py` 渲染生成，不属于本技能写作范围。
