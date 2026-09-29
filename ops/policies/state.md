# State Policy

> 职责：规定 `STATUS.md`、`ROADMAP.md`、surface、milestone、任务记录、notes 和挂账台账的写入规则。
> 真源：状态生命周期、checkpoint、milestone、同步、归档、notes 写入规则和挂账台账生命周期
> 读取：命中读取

本文件只规定状态层的写入、生命周期和调和。workflow 规定流程，route 规定子代理任务包，规格与任务记录承载业务决定，`STATUS.md` 记录 checkpoint 及有效任务入口，`ROADMAP.md` 记录 milestone。

## 0. 写入原则

状态写入按变化寿命分层。高频变化不得直接写入低频文件。

| 寿命 | 写入位置 | 典型内容 | 写入触发 |
| --- | --- | --- | --- |
| 瞬时运行事件 | 不默认落盘；async 任务运行态由 `.runtime/cockpit/async_tasks/<task_id>/` 自行承载 | 后台任务提交与回执运输 | 任务收口后按 runtime-retention 清理 |
| 业务任务 | 当前任务的规格或已有任务记录，归属见 §0.2 | 用户目标、已确认决定及未决事项 | 相应业务内容变化 |
| checkpoint | `STATUS.md` | 当前 surface、所属 milestone、恢复入口、阻塞、最近有效验证 | checkpoint 触发 |
| milestone | `ROADMAP.md` | milestone 状态、关联 surface、退出条件、延后事项 | milestone 触发 |

子代理运行事件由任务服务保存；派发、普通等待、下一步变化和完成通知本身不触发额外任务文件或低频状态写入。

变化命中 §0.3 低频闭集事件且需更新 surface / 恢复入口 / blocker / 验证 / checkpoint：MUST 写 `STATUS.md`；BLOCK IF 未先归约闭集或把运行明细 / 日志 / 等待堆入 `STATUS.md`。

变化会创建 / 关闭 / 暂停 / 迁移 milestone 或改变其范围 / 退出条件 / 关联 surface / 延后事项：MUST 写 `ROADMAP.md`；BLOCK IF 仅因当前动作 / 回执 / 验证路径 / 临时下一步 / 等待状态改写 `ROADMAP.md`。

### 0.1 机械 checkpoint 写入工具

WHEN: 主代理确认变化命中 checkpoint 或 milestone，已形成完整 `state_delta`
ACTOR: 主代理
MUST: ① 串行 dry-run `state_checkpoint.py`；② 核对目标文件只含 `STATUS.md` / `ROADMAP.md`，并查看 dry-run 报告的 `dirty_other`；③ dry-run 成功且目标一致时才 `--apply`；④ `--apply` 必须用同轮 dry-run 的相同 `state_delta`，delta 变更后重新 dry-run；⑤ `dirty_other` 非空时（提交前工作树常态），确认脏文件与本次状态写入无关后加 `--allow-dirty-other` 执行 apply，不得据此跳过状态写入。
BLOCK IF: 未形成完整 `state_delta`；命中与否尚未判定；`state_delta` 让工具推断语义状态；工具计划写其他文件或返回失败；dry-run 和 `--apply` 并行；`--apply` 先于成功 dry-run 或用了未经 dry-run 的 delta。
STATE UPDATE: `STATUS.md` checkpoint 和 / 或 `ROADMAP.md` milestone。工具不写任务记录、notes、Git 暂存区或提交记录。

### 0.2 业务任务记录与派发事实

按用户目标归并同一任务的决定和未决事项，更新其现有载体：alignment 使用 canonical `Alignment State` 与确认记录；planning 使用 `planning_state` 和编排产物；任务卡与止血分别使用 `task_card`、`CONTAINMENT_CARD`。已有 task panel 作为任务记录使用时，由 `STATUS.md` 的恢复入口指向它。各载体引用相关产物，保持业务事实的唯一归属。

工程当前任务入口归 `STATUS.md`，里程碑目标和退出条件归 `ROADMAP.md`；写入时机沿用 §0.3。单次派发沿用任务包和结果报告，不另建任务记录。

子代理需要的最新事实与引用文件有差异时，在任务包 `known_facts` 中说明变化，并在 `scope.read` 中提供所需的已有来源。变化同时命中 §0.3 时，按 §0.1 同步工程状态。

### 0.3 状态解析和低频同步触发

本文件只管命中状态写入后怎么写；是否命中由入口状态刷新、workflow 阶段事件和提交边界共同决定。

低频闭集（六事件）：① workflow gate 结果改变推进资格；② 用户可见 blocker 新增 / 解除 / 替换；③ 恢复入口改变；④ surface 状态改变；⑤ milestone 状态 / 范围 / 退出条件 / 关联 surface / 延后事项改变；⑥ 提交前 checkpoint 检查。普通子代理回执吸收、普通报告落盘、等待项变化或 hook 摘要变化均不触发写入。

命中低频闭集事件：MUST 形成完整 `state_delta` 再按 §0.1 串行 dry-run -> apply 写入；BLOCK IF 未命中闭集就启动写入；无变化时 `state_checkpoint.py` no-op。

## 1. 分层

| 层 | 文件 | 负责什么 | 不负责什么 |
| --- | --- | --- | --- |
| 流程层 | `ops/workflows/**` | 阶段步骤、进入条件、回流规则 | 当前进度、最近动作 |
| 业务任务层 | §0.2 所列现有载体 | 当前任务的业务决定、未决事项及产物引用 | 子代理运行日志、milestone 退出条件 |
| 当前执行层 | `STATUS.md` | 当前 surface、所属 milestone、恢复入口、阻塞、最近有效验证 | 历史日志、高频运行事件、每轮下一步 |
| 里程碑层 | `ROADMAP.md` | 当前 milestone、关联 surface、退出条件、延后事项、历史档案入口 | 每轮细节、子代理回执全文、临时下一步 |
| 证据层 | `notes/**` | 报告、handoff、manifest、history、incident | 主入口状态 |

## 2. surface 规则

surface 是当前正在推进的任务面；每个 active surface 必须绑定一个 milestone。

用户打断导致 surface 改变 / 暂停 / 迁移 / 取消 / 恢复入口改变：MUST 写 `STATUS.md` checkpoint，未决业务事项按 §0.2 更新其现有载体；BLOCK IF 把打断当普通聊天不记恢复入口，或把打断过程全文堆入 `STATUS.md`。

子代理返回：MUST 先完成目标达成判定；默认不写运行账本或低频状态，只有命中 §0.3 闭集事件时才写 `STATUS.md`。

## 3. milestone 规则

milestone 是一组 surface 的完成目标。milestone 关闭前，关联 surface 必须全部处于 `closed`、`migrated` 或 `cancelled`；存在 active 或 blocked surface 时不得把 milestone 写为 done。

单个 surface 的变化按 §0.2 更新对应业务记录；涉及工程状态的变化按 §0.3 判定 checkpoint 或 milestone。

## 4. 同步归约

所有可能需要 checkpoint 或 milestone 同步的情况必须先归约到 §0.3 六类闭集事件；归约失败时不得写 `STATUS.md` 或 `ROADMAP.md`。归约规则：① 用户打断只在改变恢复入口、blocker、surface 或 milestone 状态时命中；② 出站门只在 gate 结果改变推进资格时命中；③ 验证结论只在改变 gate、blocker、surface 或提交前 checkpoint 时命中；④ 子代理回执消费只在改变 gate、blocker、恢复入口、surface 或 milestone 状态时命中；⑤ milestone 创建 / 关闭 / 暂停 / 迁移 / 范围 / 退出条件 / 关联 surface 变化直接归约到 §0.3 milestone 事件；⑥ 提交前留可恢复 checkpoint 时归约到提交前 checkpoint 检查。

同步只改当前 surface 和 current milestone 的必要字段。历史 checkpoint 保存在 `notes/archive/`，验证证据进入对应报告。

## 5. 冲突调和

发现以下冲突时先调和再继续：`STATUS.md` current surface 不属于 `ROADMAP.md` current milestone；`ROADMAP.md` 写 done 但 `STATUS.md` 仍有 active / blocked surface；恢复入口所指 workflow 不在当前 milestone；验证报告失败但状态文件写通过；打断后 `STATUS.md` 仍把旧任务写成 checkpoint。

调和动作：① 记录冲突来源；② 保留最新用户请求对应 surface；③ 按证据选旧 surface 状态（`closed` 需完成证据，`cancelled` 需明确取消，`migrated` 需写明接收方，`paused` 为无证据默认）；④ 变更 milestone 关联时更新 `ROADMAP.md`；⑤ 历史 checkpoint 的保存位置见 §4。失败验证、blocked surface、缺少可读交付物或缺少 handoff 证据不得调和为 `closed` 或 `cancelled`。

## 6. notes 规则

| 目录 | 用途 |
| --- | --- |
| `notes/archive/` | 已归档记录，保留批次目录与原相对路径 |
| `notes/context/` | alignment 上下文、决策简报、已有任务记录 |
| `notes/manifests/` | wave、并发派发和跨代理运行清单 |
| `notes/research/` | research-agent 调研报告 |
| `notes/explorer/` | explorer-agent 本地扫描报告 |
| `notes/verify/` | verify-agent 和 plan-checker 审查报告 |
| `notes/handoffs/` | 子代理 `FINAL_HANDOFF`、progress 和轻量状态小文件 |
| `notes/general/` | general-agent 兜底报告 |
| `notes/batch/` | batch-agent 机械处理报告 |
| `notes/incidents/` | 接管、重派失败、越界、连续回执缺口和权限失败复盘 |
| `notes/ledger/` | 挂账台账唯一真源（`DEBT.toml`，生命周期见 §8） |

正式规则进入 `ops/`。设计推导进入 `design/`。已确认长期文档进入 `docs/`。测试运行输出进入 `test-results/`。用户可消费交付物进入 `outputs/`。

## 7. 填充约束

- 不把历史日志堆在 `STATUS.md`。
- 不为补齐文件而创建无实际内容的大段模板。
- 业务事实按 §0.2 归属更新，工程入口引用对应载体。
- 未验证事项不得描述为"已完成"或用"已完成"作为 STATUS/ROADMAP 推进证据。

## 8. 挂账台账（工程债）

唯一真源：`notes/ledger/DEBT.toml`。字段闭集、状态闭集（open / in_progress / resolved / waived）与状态约束由 `ops/tools/ledger_check.py` 机械校验：resolved 必须带关闭证据 `evidence`，waived 必须带 owner 依据 `waived_by`，open / in_progress 必须带回流触发条件 `trigger`。

### 8.1 登记触发（create / link / waive 三选一）

WHEN: 出现未即修的工程债——审查 finding 未在本批修复、rationale `Possible Regressions` 中标为挂账的事项、notes/tooling 登记处于任何未决状态（open、fixing、investigating 等非终态）、ROADMAP 事项延后
ACTOR: 主代理
MUST: 提交前完成三选一并写台账 ID——① create：台账新增条目；② link：引用既有 `DEBT-\d{4}`；③ waive：台账写 waived 条目并带 owner 依据。引用必须能通过 `ledger_check.py` 校验解析。
BLOCK IF: 挂账事项只留在 rationale 风险段、审查报告或聊天上下文而无台账 ID；台账校验 fail 时提交。
STATE UPDATE: `notes/ledger/DEBT.toml`。

### 8.2 单向归约

台账是挂账状态的唯一写入点，其余文件只引用不复述：

- `STATUS.md` / `ROADMAP.md` 只引用台账 ID 或 `ledger_check.py --open` 生成的投影，不另行维护挂账摘要真源。
- notes/tooling 登记文件头部标 `tracked: <ID>` 后，其状态以台账为准；登记正文保留为证据，不再单独迁移状态。
- rationale 记录挂账时只写台账 ID 与一句指向，不复制台账字段。

BLOCK IF: 在 STATUS / ROADMAP / notes 中新建与台账并行的挂账状态记账。

### 8.3 关门核对

WHEN: surface 写入 `closed` 前，或 milestone 关闭前
ACTOR: 主代理
MUST: 跑 `python ops/tools/ledger_check.py --open` 核对现状；blocking 级 open / in_progress 必须为零，否则逐条转 resolved（带证据）或 waived（带 owner 依据）后再关门。`--gate` 退出非零时不得写 `closed`。
BLOCK IF: 未跑核对即关门；用降级严重度代替处置来清空 gate。
STATE UPDATE: `notes/ledger/DEBT.toml`（处置动作），随后按 §2 / §3 写状态文件。
