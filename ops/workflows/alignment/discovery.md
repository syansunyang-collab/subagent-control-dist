# 事实侦察与查轮子

> 职责：规定对齐中的事实侦察、查轮子、成本挑战、实测与子代理报告读法。
> 真源：事实类型到能力的映射、查轮子触发与对比表、成本挑战时机与处置、`local_probe` 用法、决策摘要读法
> 读取：命中读取

## 1. 事实侦察

仓内结构、工具版本、网络可达、官方限制、既有代码这类事实由侦察取得，不问用户。主代理已知答案的小事直接答，不派出。

| 事实类型 | 能力 |
| --- | --- |
| 仓库结构、引用、依赖、源码根因 | `explorer-agent / codebase-scan` |
| 本机软件、工具链、PATH、WSL、依赖版本 | `explorer-agent / runtime-env-scan` |
| 代理、DNS、端口、下载源、服务可达 | `explorer-agent / network-readiness-scan` |
| 官方文档、API / SDK、版本、兼容性、issue 与论坛 | `research-agent / external-research` |
| 本地 PDF、图片、Office、截图 | `research-agent / document-scan` |
| 只有文档承诺、缺本机实证的关键能力 | `local_probe`（§4） |
| 规则、契约与提示词质量 | `semantic-review-agent / rule-quality-inspection`、`contract-drift-inspection`；`verify-agent / prompt-bloat-inspection`、`anti-defensive-inspection` |

- 每个事实问题交一个能力；互不冲突的问题同轮派出。冲突只看写域、删除域、报告与 handoff 路径，只读同一仓库不算冲突。
- 标准规格道派出时登记下一步：在关闭当前轮的 `answer` 里带 `next_step: dispatch_fact` 与 `next_route_id`（`<role>__<capability>`）；没有可答的轮时经 delta 通道登记：`python -B ops/tools/alignment_recorder.py --phase record --spec <规格书> --discussion-log <讨论日志> --delta <delta.yaml>`；delta 根键为 `alignment_delta:`，字段见 `--schema`。恢复时据此找回在途任务。
- 事实摘要只写结论、证据引用与置信度，不写用户是否接受、范围、风险接受或授权。事实来源（`evidence_derived`）只锁事实，不锁必问项。
- 用户在讨论要不要派、怎么派时，只用 `node ops/tools/dispatch_prepare.mjs --action preview` 预览，不提交派发。

## 2. 查轮子

WHEN: 要新写工具、模块或组件，或草案含 `tech_route` 决策
ACTOR: 主代理
MUST: 派 `research-agent / wheel-discovery`，输入目标、已锁范围、坑点征询的回答与已知候选；把报告引用写进 `execution.sections.tech.wheel`
OUTPUT: 固定对比表，「自己写」固定为一行基线

| 列 | 内容 |
| --- | --- |
| 候选 | 名称、版本 |
| 许可与维护 | 许可证、最近发布、维护活跃度 |
| 能力覆盖 | 对照需求条目逐项 |
| 适配缺口 | 需要自己补的部分 |
| 接入代价 | 依赖、运行面、目录、验证命令的变化 |
| 源码核查 | 读过的源码位置与结论 |
| 待实测 | 需要 `local_probe` 才能关闭的缺口 |

- 派发时指定模型 `openai-codex/gpt-6.1-sol`（fleet 的 `route.model` 或 `--async-model`）；research-agent 角色默认仍是 Luna，Sol 在其候选池中。
- 查轮子不持有 bash 与安装权限；「待实测」列的缺口交 §4。
- 不新写组件且没有 `tech_route` 时，`wheel` 写 `not_needed: <理由>`；存在已锁定的 `tech_route` 时 guard 不接受 `not_needed`。
- 只需要轮子对比、不形成规格时，直接派该能力，不启动对齐。

## 3. 成本挑战

WHEN: 草案含 `tech_route` 决策，对比表与推荐已就绪
ACTOR: 主代理
MUST:

1. 在用户看到对比表之前，运行 `python -B ops/tools/alignment_recorder.py --phase review --spec <规格书> --surface execution --review-kind challenge`；`action: dispatch` 时派 `plan-checker / proposal-challenge-review`，输入对比表、推荐与坑点征询的回答。
2. 报告回来后登记：`python -B ops/tools/alignment_recorder.py --phase bind-review --spec <规格书> --review-kind challenge --surface execution --review-report <报告> --review-verdict <verdict>`。
3. 挑战意见与对比表在方案拍板轮同屏呈现。

OUTPUT: 挑战登记与方案拍板轮草案

| verdict | 处置 |
| --- | --- |
| `proposal_stands` | 按推荐进入方案拍板 |
| `cheaper_path_exists` | 两条路线并列交用户选；用户选报告推荐的路线时改写方案，还有轮次则再挑战一轮；用户坚持原方案时以该确认轮登记 `--owner-resolution-ref` |
| `needs_owner`，报告点名取舍分歧 | 把该取舍作为必问项开轮交用户裁决，登记 `--owner-resolution-ref` |
| `needs_owner`，报告点名材料缺失 | 补齐材料后重派一次，计入两轮上限 |

两轮用尽（`action: owner_decision`）时不派第三轮，把最新对比表交用户三选一：按当前方案锁定、换用报告推荐的路线、`pause`；选定后登记 `--owner-resolution-ref`。owner 裁决的登记命令：`python -B ops/tools/alignment_recorder.py --phase bind-review --spec <规格书> --review-kind challenge --surface execution --owner-resolution-ref <讨论日志>#round-N`，落在最新一轮。挑战员需要实测的缺口交 §4。execution 锁定前，guard 要求挑战最新一轮为 `proposal_stands` 或带 owner 裁决。

## 4. 实测（`local_probe`）

需要实测才能关闭的缺口统一派 `executor-agent / scoped-execution`：候选路线的关键能力只有文档承诺、版本兼容拿不准、用户点名实测。

- 在任务授权的写域内跑最小示例并记录结果；安装与联网是操作，记入操作清单。
- 探针失败是该路线的事实证据，不据此扩大试验范围。

## 5. 读子代理报告

默认读报告的决策摘要：结论、依据、未解决问题、需要主代理决定什么。

- 未解决问题非空、依据与已知事实矛盾、或结论依赖未核实的前提时，打开对应证据核对，只读相关段落。
- 报告缺失或回执不可解析时只补回执，不重扫范围。
