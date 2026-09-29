# subagent-fleet-discipline 触发判例

> 职责：本技能触发的回归基线，竞争性触发验收与漂移修订以此为准。
> 真源：本技能触发判例（正判例、反判例、行为判例）
> 读取：维护读取

## 正判例（该触发，用户真实话术）

1. "派几个子代理并发把这批文件改了。"
2. "这个仓库并发了解一下，分头看几个方向。"
3. "fan out 一下，多个方向同时审计。"
4. "这活能拆，批量派子代理跑。"
5. "多路并行排查一下这些问题。"
6. "并发处理这十几个切片。"
7. "帮我把这个大扫描切一下，分头派出去。"
8. "这个任务怎么编排舰队？"
9. "前面八个审查完成后自动启动 reducer，别让我手动接力。"

## 反判例（近失配不该触发，注明去处）

1. "派一个子代理跑个小任务。" → 单个小子代理（无技能层触发）。
3. "把这个大问题投给外部深研。" → external-review-rescue。
4. "查一下这个 route 怎么走。" → 普通 route 查询（无技能）。
5. "帮我并发跑几个只读 grep 看看。" → 本地命令并发，非子代理舰队（无技能层触发）。

## 行为判例

1. 任务提示："并发了解这个仓库的流程慢点和工具接缝。" / 期望首动作：形成 FLEET_PLAN（slice / route / read_scope / write_scope / conflict_keys）。 / 期望产出：seed JSON 数组批量派发 + 收割核验，async 通道不可用则显式收口阻塞。
2. 任务提示："批量改 20 个文件的措辞。" / 期望首动作：按文件不相交切片 + 任务书四件套。 / 期望产出：同一 batch 内并发任务 + 每批 git diff 亲核。
3. 任务提示："帮我把这个大扫描切一下。" / 期望首动作：走切片编译流程（parallel-slicing 决策树）形成 FLEET_PLAN，不凭手感切。 / 期望产出：≥2 路切片一次批量派发；explorer 类 ≥3 路时规划下一波 reducer 节点。
4. 任务提示："子代理进度条还在动，为什么要改派发？" / 期望首动作：确认运输态仍为 `submitted | queued | running` 后离开该任务，推进非冲突工作。 / 期望产出：工具次数、运行时长、静默时间只作遥测；没有权威终态或用户取消时不检查报告、不取消、不改派。
5. 任务提示："单个子代理真实失败后怎么处理？" / 期望首动作：从完成通知读取 `state / failure_type / contract_state / business_state / error`，进入主代理恢复裁决。 / 期望产出：按可用产物和副作用选择 `accepted / blocked / requeued`；重派只发生在原任务已经终止之后。
6. 任务提示："并发核对外仓二十四份规则的同一组字段是否被工具消费。" / 期望首动作：把二十四份规则完整列为 contract target files，把允许 grep 的工具目录单独列为 evidence root，不按文件数拆同一问题。 / 期望产出：target files 进入 entry，evidence root 进入 index/deep，运行态与依赖目录进入 deferred；材料按语义审查注入合同承载，缺 evidence root 时先补构包。
7. 任务提示："八个审查结束后自动跑归并。" / 期望首动作：形成含八个上游和一个 reducer 的 Fleet Manifest，reducer 声明全部 `depends_on`、报告输入和 all-settled 依赖。 / 期望产出：scheduler 后台收齐终态，注入依赖结果索引与可用 report 后提交 reducer；上游 `partial / failed` 不要求主代理逐份裁决。
8. 任务提示："有验收合同，归并后别再让我重新审一遍。" / 期望首动作：使用 `verify-agent__acceptance-synthesis` 输出结构化 disposition，再交 `acceptance_contract_check.py` 消费。 / 期望产出：`pass` 收口、首轮 `rework` 生成定向 follow-up DAG、`needs_owner` 或第二轮仍失败才交主代理。
9. 任务提示："同一个契约问题的材料超过当前注入阈值，终审怎么派？" / 期望首动作：保留完整目标清单并提交一个语义审查任务。 / 期望产出：按注入协议的大材料模式执行，不因材料大小改变任务 identity、问题边界或默认模型选择。
