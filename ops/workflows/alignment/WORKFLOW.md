# alignment workflow

> 职责：规定对齐入口判定、标准规格五步和交付报告。
> 真源：三道入口判定、S1–S5 的当前动作与本步需读、确认轮调用方式、交付报告结构
> 读取：命中读取

对齐把目标、范围、决策和验收锁定到执行者不必猜。三条道共用一本决策账本：必问 topic、默认项记录门槛与呈现规则见 `ops/workflows/alignment/decision-ledger.md`。

## 1. 入口判定

先判标准规格条件，命中即走标准规格；未命中时，目标和范围已明确且不命中必问 topic 的走直接做，其余走任务卡。

| 道 | 进入条件 | 用户触点 | 产物 |
| --- | --- | --- | --- |
| 标准规格 | 用户要求走标准规格 | 采访、产品拍板、方案拍板 | `notes/context/<task>-alignment.md` 与讨论日志 |
| 任务卡 | 单次交付或试错，不命中标准规格条件 | 一次确认 | `notes/context/<task>-card.md`，流程见 `ops/workflows/task-card.md` |
| 直接做 | 目标和范围已明确，且不命中必问 topic | 执行中遇到必问 topic 时即问 | 交付报告（§9） |

- 用户随时可要求改走标准规格。
- 直接做与任务卡不写对齐状态。事故止血不经本入口。

## 2. 标准规格五步

| 步 | 当前动作 | 用户触点 | 锁定 | `current_stage` |
| --- | --- | --- | --- | --- |
| S1 采访 | 问目标、痛点、成功口径与已知坑点 | 问题数量不设上限 | — | `intake` |
| S2 产品拍板 | 起草范围、不做、验收意图与用户可见形态 | 必问项逐题 | `requirements`、`product_experience` | `product` |
| S3 方案 | 事实侦察与查轮子 → 成本挑战 → 方案拍板 | 方案必问项逐题、默认项 | `execution` | `solution` |
| S4 审查 | 一次 all_surfaces 审查，至多两轮 | 仅需用户裁决时 | — | `review` |
| S5 出站 | 审查通过或已裁决后写 planner_allowed、过 guard | 有真实授权取舍时确认 | `planner_allowed` | `exit` → `complete` |

- 技术路线服务于范围和验收意图；把已成熟且相互一致的 preview 与待定决策同轮呈现，已确认内容复用，新增取舍再问。
- 事实侦察可在任一步之前触发（`ops/workflows/alignment/discovery.md` §1）。
- 每步按「本步需读」取材料；已确认的材料进入下一步后不重读。
- 中断后从规格书末尾的 `Alignment State` 恢复，读法见 `ops/workflows/alignment/state.md` §4。

## 3. 确认轮

标准规格道的每次用户拍板走一轮确认。主代理提交要呈现的内容与用户的回答；轮号、引用、来源字段、面锁、讨论日志与下一步由 recorder 生成。

recorder 命令的公共参数（下文记作 `<公共参数>`）：`--spec notes/context/<task>-alignment.md --discussion-log notes/context/<task>-discussion-log.md`。草案与回答用 `--input -` 从标准输入传入，也可写 YAML / JSON 文件路径。

1. 开轮：`python -B ops/tools/alignment_recorder.py --phase open-round <公共参数> --input -`。草案顶层写一次 `mode`（popup / card / conversation）与 `stage`，`items` 列决策、preview、marker；字段见 `--schema` 的 `g3_phases.open-round` 与 `draft_item_fields`，内容写法见 `ops/workflows/alignment/decision-ledger.md` §4。逐项的 `source.mode` 等来源字段由 recorder 生成。
2. 呈现：popup 模式把返回的 `presentation.units[].questions` 逐屏交给提问工具；card 与 conversation 模式把 `units[].text` 发给用户。
3. 回答：`python -B ops/tools/alignment_recorder.py --phase answer <公共参数> --input -`，提交 `round`、实际展示过的单元（`shown_units`）与各项回答，按下表归类。只有本次回答会让该轮关闭、且下一轮内容已确定时，才随回答带 `next`；该轮仍有待答项时带 `next` 会被 `next_round_premature` 整体拒收。
4. 读返回：变化摘要、`pending`、下一步与 `reads`。有待答项时继续展示剩余单元再 `answer`；草案要改时提交 `{round, cancel: <理由>}` 取消该轮，重开新轮。

| 用户的回应 | 提交 | 决策来源 `source.type` |
| --- | --- | --- |
| 选了某个选项；推荐理由展示后说「按推荐」 | `{choose: <选项>}` | `user_selected_option` |
| 在单元上点「其余全部按推荐」或回复「整卡按推荐」 | 该单元列入 `bulk` | 被覆盖的项记 `user_bulk_accepted` |
| 给出自己的说法 | `{modify: <原话>}` | `user_explicit` |
| 以后再定 | `{defer: <理由>}` | `user_explicit`，状态 `deferred` |
| 认为不必问 | `{withdraw: <理由>}` | 不生成决策 |
| 接受 preview | `{accept: true}`；同轮有 `modify` 时，改用 `accept_revised` 提交改后的 preview，或写 `unaffected_by` 声明修改不影响 preview | — |
| 要求改 preview | `{revise: <说明>}` | — |
| 回答坑点征询，含「没有」 | `{text: <原话>}` | — |
| 「随便」「差不多」这类含糊回答 | 不提交，重问具体选项 | — |

- 改动同一 `open` 轮里已提交的回答时，在 `amend` 列出被改项目。同一回答重复提交返回 `noop` 或当前进度，不会重复登记。
- 已关闭轮次的决定要改：开新一轮，新决策草案带 `supersedes: <旧 id>`；新决定生效时由 recorder 把旧条目改成 `superseded`。
- 用户提出新方向时，先作为 `goal_scope` 决策问是否纳入本轮。
- recorder 拒收时按返回的 issue code 与提示补唯一缺口；码表见 `--schema`。

## 4. S1 采访

当前动作：`python -B ops/tools/alignment_recorder.py --phase init --task-slug <task> --summary "<一句话>" <公共参数>` 建规格书与讨论日志（两个文件都不得已存在）；加 `--input -` 可同时开首轮。随后问用户要做什么、当前痛点、看到什么才算完成；同轮用 marker `user_constraints` 收集已知的坑、偏好和红线，回答「没有」也登记。已有约束在题目中复用。

- 目标只有方向词（如「连接 CAD」）时继续追问，直到能写出连接目的、当前卡点和期望结果。
- 能归结为选项的目标、范围、完成口径作为 `goal_scope`、`acceptance` 决策草案开轮（`stage: intake`）；用户自由作答时用 `modify` 提交原话。
- 能查证的事实不问用户，按 `ops/workflows/alignment/discovery.md` §1 侦察。

本步需读：本文件 §3；`ops/workflows/alignment/decision-ledger.md` §1、§4。
完成：目标、痛点、成功口径足以起草 requirements。

## 5. S2 产品拍板

当前动作：起草 `requirements` 与 `product_experience` 两个 preview，requirements 草案带上 `alignment_spec` 需求条目；连同范围、不做、验收意图、用户可见形态等必问决策和默认项，以 `stage: product` 开轮确认。preview 的 `accept` 由 recorder 转为面锁并写入条目。

本步需读：`ops/workflows/alignment/surfaces.md` §1、§2、§3；`ops/workflows/alignment/decision-ledger.md` §2、§3。
完成：`requirements_locked` 与 `product_experience_locked` 为 true。

## 6. S3 方案

当前动作按顺序：

1. 事实侦察与查轮子：要新写工具、模块或组件，或草案含 `tech_route` 决策时派查轮子；需要实测的缺口派 `local_probe`。
2. 成本挑战：存在 `tech_route` 决策时，在用户看到对比表之前派挑战。
3. 方案拍板：起草 `execution` preview（五子节），连同 `tech_route`、`design_point` 必问决策、对比表、挑战意见与默认项，以 `stage: solution` 开轮确认。采访中坑点回答的引用由 recorder 填入 `sections.tech.user_constraints_ref`。

本步需读：`ops/workflows/alignment/discovery.md` §1、§2、§3、§4、§5；`ops/workflows/alignment/surfaces.md` §4。
完成：`execution_locked` 为 true。

## 7. S4 审查

当前动作：三面锁定后查询审查动作，派一次 `plan-checker / requirement-granularity-review`（`review_mode: all_surfaces`），报告回来后用 `--from-report` 一次登记三面与跨面，读决策摘要后处置。

本步需读：`ops/workflows/alignment/exit.md` §1、§2。
完成：三面与跨面最新一轮 PASS，或两轮用尽且有用户裁决。

## 8. S5 出站

当前动作：读审查决策摘要；三面已接受、未决项处理完且审查通过或已裁决时，recorder 写 `planner_allowed`。随后过 guard，主代理按规格写接口契约与执行种子直接派发，按 `acceptance` 条目用真实入口逐条验收。执行需要跨会话或跨天交接时，改为生成 planner seed 进入 planning。用户要求暂不执行时保持 `pause`，按其授权恢复。

本步需读：`ops/workflows/alignment/exit.md` §3；进入 planning 时加 §4。
完成：`current_stage: complete`。

## 9. 交付报告

三条道收口时按以下顺序写交付报告：

1. 结果与证据：按 `acceptance` 或 `validation_object` 逐条给证据；未验证的项点名。
2. 替你定了什么：直接做道与主代理亲自执行的任务卡，列出主代理决定且满足记录门槛的默认项（来源 `agent_default_reported`）；委派执行的任务卡与标准规格道汇总执行回执 `off_spec_decisions[]` 中的默认项，写成「执行中替你定了什么」。每条写决定、理由、推翻代价。
3. 流程裁剪：本次按 `ops/workflows/alignment/decision-ledger.md` §6 做过的编排裁剪。
4. 操作清单：末尾一行，列出 `ops/workflows/alignment/decision-ledger.md` §3 界定的操作及其可回退性。
