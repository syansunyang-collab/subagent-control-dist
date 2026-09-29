# 对齐状态

> 职责：规定对齐状态 v4 的读法、写入入口与写入责任。
> 真源：规格书与讨论日志的分工、状态各部分的含义、写入入口与责任、恢复顺序、v3 冻结
> 读取：命中读取

字段、闭集、`next_step` 映射与错误码以 `python -B ops/tools/alignment_recorder.py --schema` 为唯一真源；本文只写含义与入口。

## 1. 两份文件

| 文件 | 内容 | 读法 |
| --- | --- | --- |
| `notes/context/<task>-alignment.md` | 正式结果。正文是 recorder 渲染的派生视图：目标与不做、事实基础、锁定面总览与 preview、决策账本（要你拍板 / 我替你定了）、规格条目、验收表、资源与边界、审查与出站；文末 `## Alignment State` 是唯一机器状态 | planner 与恢复读这份 |
| `notes/context/<task>-discussion-log.md` | 确认轮追溯：每轮的呈现单元、已展示单元、逐项回答（含一行机器可读的回答），以及取消与撤回记录 | 核对某次确认时，只读引用指向的那一轮 |

规格书只带正式结果；轮次的过程材料在关闭或取消时写进讨论日志，不留在状态里。

## 2. 状态各部分

| 部分 | 含义 |
| --- | --- |
| `current_stage` | `intake`、`product`、`solution`、`review`、`exit` 对应 S1–S5；`complete` 为已出站；`paused` 为暂停 |
| `locks`、`lock_sources` | 三面锁与 `planner_allowed`；锁来源由接受 preview 的确认轮派生 |
| `surface_previews` | 三面 preview：`proposed` 待确认，`accepted` 已锁，`superseded` 已被替换 |
| `confirmations` | 确认轮账本：`ref`、`mode`、`presented`、`bulk_accept`、`status`（`open` / `closed` / `cancelled`）。`open` 期间另带草案、呈现单元与回答进度，关闭或取消时移入讨论日志 |
| `decisions` | 决策账本条目（`ops/workflows/alignment/decision-ledger.md`）；`deferred` 为用户推迟、不进入本轮范围，`superseded` 为已被新决定替代 |
| `alignment_spec` | 规格条目与 `validation_object` |
| `open_questions` | 待决项，出站前清零 |
| `review_refs` | 按轮登记的审查：`surface_slice`、`proposal_challenge`、`cross_surface`；`latest_report_ref` 指向最近登记的 all_surfaces 摘要，供修订确认后核对未决项 |
| `next_action` | 下一步类型与原因；`dispatch_fact` 带 `route_id` |

决策与面锁引用已关闭的轮次；升级时，未改变的任务卡决策保留原卡片确认引用，由 guard 核对。轮次 `open` 期间的回答不产生正式结果。

## 3. 写入入口

recorder 是规格书、讨论日志与状态的唯一写入者；每次写入先过 guard，拒收时不写入任何字节，按返回的 issue code 与提示补唯一缺口。

| `--phase` | 用途 |
| --- | --- |
| `init` | 建 v4 空骨架规格书与讨论日志，可同时开首轮 |
| `open-round` | 登记待呈现草案，渲染呈现物 |
| `answer` | 提交已展示单元与回答；整轮答完时生成决策、面锁与 preview 状态，写讨论日志，推导下一步 |
| `review` | 只读查询：是否派审、第几轮 |
| `bind-review` | 登记后满足出站条件即写 `planner_allowed`，用户指定的 `pause` 保留；登记审查：`--from-report`（三面与跨面）、`--review-kind challenge`（成本挑战）、`--review-disposition`（跨面两轮用尽后的裁决） |
| `record` | 底层 delta 通道，承接上列入口不覆盖的写入，写法见 `--schema` |

主代理负责判断性内容：草案、用户回答的归类、preview 语义、`accept_revised` 与原修改一致、方向性修订声明 `direction_rereview`。规格正文与状态块不手写。

## 4. 恢复

1. 读规格书文末 `Alignment State`：`current_stage`、锁、`open_questions` 与 `next_action` 给出当前位置。
2. 有 `open` 轮时，用 `answer` 继续展示剩余单元，或 `cancel` 后重开；同一回答重复提交不会重复登记。
3. 需要确认来源时读讨论日志的对应轮；需要审查证据时只读 `review_refs` 指向的报告。
4. 审查与挑战的轮次从 `review_refs` 读回，不重新推断，不因会话中断重派。
5. 相关输入变化后按 `ops/workflows/alignment/exit.md` §2 回对应步修订。

## 5. v3 规格冻结

`version: 3` 的规格是冻结的历史记录：guard 报 `state_version_frozen`，recorder 拒写（`spec_version_frozen`）。新工作另起 v4 规格，旧规格不迁移。
