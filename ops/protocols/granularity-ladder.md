# 工作粒度词表（granularity ladder）

> 职责：定义工作粒度层级词的唯一拼写和状态真源指针；裁决"任务 / 阶段 / 轮"的歧义用词。
> 真源：粒度词定义与用词裁决（surface / milestone 的状态机仍归 `ops/policies/state.md`，本表不复制）
> 读取：命中读取

规则文件提到工作粒度时，用词以本表为准。对模型，一个粒度词的定义包括三个信息：**怎么称呼、指向哪个状态真源、不得混用成什么词**。进入、完成和状态写入规则归各自状态真源，本表只做命名裁决和单跳指针。

## §1 五级阶梯

| 级 | 唯一词 | 一句语义 | 状态真源指针 |
| --- | --- | --- | --- |
| L0 | 委托 | 用户一次原始诉求 | 本表；载体为聊天与 alignment 规格书 |
| L1 | milestone | 一组 surface 的完成目标 | `ops/policies/state.md` §3；长任务字段结构见 `ops/policies/long-task.md` §2 |
| L2 | surface（任务面） | 可独立推进、可独立验收的一段工作 | `ops/policies/state.md` §2 |
| L3 | 派发实例 | 一次子代理往返（一个 task_package） | 本表；字段语义见 `ops/protocols/task-package-reference/field-dictionary.md` |
| L4 | turn（轮） | 主代理一次模型回合 | 本表 |

跨级直接宣布完成（如拿一个派发实例的 done 当 surface 完成、拿 surface 完成当 milestone 完成）是越级，按各级状态真源逐级核对。

surface 起立判定：预计跨多轮推进、或具有独立验收命令的工作才立 surface；单轮完结的工作不立 surface。

## §2 域内时钟与子阶梯（指针，不展开）

- planning 子阶梯：phase → slice → wave / lane → task（executor 逐条执行的原子单位），归 `ops/workflows/planning/WORKFLOW.md` 与 `ops/workflows/planning/planner-flow.md`。其中 **phase 指交付物分期**（`.planning/phases/<phase>/`）。
- workflow 阶段（S1–S5、P0–P8）：**流程步骤**，不是交付物分期；归各 workflow 的 `WORKFLOW.md`。
- 确认轮：alignment 标准规格道内"主代理呈现 → 用户回答"的一次往返，轮号由 recorder 登记，与 L4 turn 不是同一个时钟；归 `ops/workflows/alignment/WORKFLOW.md` §3。

## §3 易混词裁决

| 想表达 | 用词 | 不要写 |
| --- | --- | --- |
| 用户那次原始要求 | 委托 | 裸的"任务" |
| 当前推进的这摊工作 | surface / 任务面 | "当前任务" |
| 派给子代理的一单 | 派发实例 / 任务包 | 裸的"任务" |
| PLAN 内逐条执行单位 | task（仅 planning 域内） | 与任务包混用 |
| 主代理一次回合 | turn / 轮 | 泛指的"每轮" |
| alignment 一次确认往返 | 确认轮 | "每轮" |
| 流程步骤段 | workflow 阶段（如 S2、P1B） | 裸的"阶段" |
| 交付物分期 | phase | 裸的"阶段" |

派发实例的“任务对象”是本次派发的路由匹配键。

存量文件的裸用词不回溯清洗；新写或改写的规则段落按本表用词，R 系审查把消不了歧义的裸用词按用词漂移报，不另设机器门。

## §4 原子修改链与可提交点

原子修改链：同一目标下的连续修改序列，中途打断会留下验证跑不绿（或交付物不完整）的中间态。**验证能跑绿的点即链的边界；链界即可提交点。**

"阶段性完成"即各级完成判定成立并触发提交纪律的统称：原子修改链收尾（链界）、L2 任务面验收、workflow 阶段出站、checkpoint（`ops/policies/state.md` §0.3 闭集事件）、用户暂停 / 切换 / 收口（L0 事件）、最终交付边界（L0 / L1 完成）。L4 turn 的出口本身不触发提交。
