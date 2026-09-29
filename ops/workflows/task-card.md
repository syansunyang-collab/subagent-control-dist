# 任务卡

> 职责：规定任务卡道的卡片结构、一次确认、校验、执行、升级与收口。
> 真源：任务卡字段、deliver / explore 差异、三个确认出口、界面样稿确认与升级条件
> 读取：命中读取

任务卡服务单次交付或试错：目标、范围或必问项需要用户确认一次（入口判定见 `ops/workflows/alignment/WORKFLOW.md` §1）。任务卡不写对齐状态。

## 1. 卡片

写在 `notes/context/<task>-card.md` 的 `## Task Card` 小节，YAML 围栏，根键 `task_card:`。

```yaml
task_card:
  task_slug: <kebab-slug>
  kind: deliver | explore
  confirm_mode: popup | card
  goal: <一句话>
  not_doing: []
  acceptance:
    - check: <命令或可观察动作>
      pass_when: <通过条件>
  stop_when: []          # 失败即停条件；explore 含「连续尝试无新信息」
  decisions: []          # 决策账本条目，必问项与默认项同表
  wheel: <查过什么、结论；不涉及写 not_needed: <理由>>
  expert_review: <专家报告路径、采纳情况与残余分歧；未派审写 not_needed: <理由>>
  write_scope: []
  attempts: []           # 仅 explore
  status: draft | confirmed | running | closed | promoted
```

- `deliver` 交付产物；`explore` 产出认知（可行性、方案比较、试错结论），`acceptance` 可以是认知型信号，如「知道 X 是否可行」。
- `decisions` 按 `ops/workflows/alignment/decision-ledger.md` 分类与记录。要新写组件或存在 `tech_route` 时，按 `ops/workflows/alignment/discovery.md` §2 查轮子后填 `wheel`。

## 2. 一次确认

起草卡片时先核对推荐所依赖的事实，本地短验证能关闭的就地核实。`tech_route` 或 `design_point` 决策仍依赖未经独立核对的事实，或存在替代路线时，呈现前做一轮专家审核：材料能内联时，专家人选与同轮 pick 数按 `ops/skills/external-review-rescue/SKILL.md` 选择；需要自行翻仓核对事实时，派能完整覆盖的专职角色，无专职覆盖时用 `general-agent / general-default` 的 `deep` pick 并保留读取工具。任务书要求核对事实、给出反例与更简单路线，并对新增的门或维护面说明保护对象、删除后的副作用与更简单替代。仅对未闭合争点或新的关键差异开第二轮；仍有分歧作为选项随卡呈现。结论写入 `expert_review`。

按 `ops/workflows/alignment/decision-ledger.md` §4 呈现，所用模式记在 `confirm_mode`，只取 popup 或 card。

卡片涉及新增或改版用户界面时，随卡附一份用真实内容做的静态样稿（做法见 `ops/skills/tool-ui-design/SKILL.md` §2），与卡片同轮确认；成品交付后请用户对照样稿看过再收口。提问工具不可用时在对话中发卡片文本，记 `confirm_mode: card`。

| 用户回应 | 动作 |
| --- | --- |
| 确认执行，含「整卡按推荐」 | 按回应写各决策的 `source`，`status: confirmed` |
| 按编号修改 | 改卡后再确认一次 |
| 升级为标准规格 | 按 §4 转入 |

卡片本身是呈现物，guard 不核对确认轮，但每个决策仍写全 `source`：

- `type`：按用户回应取值，对照 `ops/workflows/alignment/WORKFLOW.md` §3 的回应表；`user_bulk_accepted` 用于必问项时要求 `confirm_mode: card`；
- `mode`：与 `confirm_mode` 相同；
- `confirmation_ref`：`notes/context/<task>-card.md#confirmation`；升级后仍用此来源，guard 核对卡片状态与决策内容一致。

## 3. 校验与执行

1. 确认后运行 `python -B ops/tools/alignment_guard.py --context notes/context/<task>-card.md --target card`，按报出的码补齐后重跑。
2. 主代理直接执行，或派 `executor-agent / scoped-execution`；多步或可并行的工作按写域拆成多单或一个 fleet 派发；`status: running`。写入限于 `write_scope`，需要越出时改卡并重新确认。
3. explore 每轮一个假设、一次动作，把「假设 → 动作 → 结果 → 所得」追加到 `attempts`。动作可以是自做、派事实侦察或 `local_probe`、派 executor。命中 `stop_when` 即停。
4. 执行中遇到必问 topic 时停下问用户，把回答写进 `decisions` 后继续。

## 4. 升级为标准规格

执行前或执行中命中 `ops/workflows/alignment/WORKFLOW.md` §1 的标准规格条件时，沿本节升级，`status: promoted`。用 recorder `init` 建规格书，再用 `record` 将卡上已确认的 `decisions` 原样登记，保留 `source.confirmation_ref` 的卡片引用；`fact_refs` 带卡片路径，`mutation_scope.discussion_log: unchanged`。复用卡上的目标、范围与验收起草 preview，只询问新增差异；三面新增的合同内容仍按标准规格拍板。必问项数量、呈现模式与写域跨度不是升级条件。

## 5. 收口

- deliver：按 `acceptance` 逐条给证据，写交付报告（`ops/workflows/alignment/WORKFLOW.md` §9），`status: closed`；执行中定下的默认项按该节第 2 项区分亲自执行与委派执行。
- explore 命中停止条件时请用户三选一：结束，结论进交付报告，`status: closed`；转正，按 §4 升级，卡片作为事实证据引用；换方向，改 `goal` 与 `stop_when`，重新确认后继续。
- 试错产物用于实际交付前，确认新增的写域。
