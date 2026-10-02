# Task Package Field Dictionary

> 职责：解释 task_package 和 FINAL_HANDOFF 字段。
> 真源：task_package 和 FINAL_HANDOFF 字段含义和值域
> 读取：维护读取

本文件是 `task_package` 和 `FINAL_HANDOFF` 字段含义和值域词典。它只在设计、维护、审查字段或解决字段语义冲突时读取，不是主代理日常派发入口。

专用派发规范必须自足。主代理命中已有 route 时，不得为了构包默认读取本文件。

## 1. 闭集

| 字段 | 允许值 |
| --- | --- |
| `task_package.version` | `1` |
| `expected_output.mode` | `file` |
| `wait_policy.class` | `quick_scan | external_research | reproduction | adversarial_review | planning | execution | standard` |
| `runtime_context.network_needed` | `yes | no` |
| `runtime_context.scope_exists` | `yes | no | partial` |
| `runtime_context.target_repo_create_allowed` | `true | false` |
| `extensions.cross_repo_acceptance.result_mode` | `read_only_audit | simulated_planning | real_rerun`；跨仓省略时，报告与 handoff 之外有写域投影为 `real_rerun`，否则投影为 `read_only_audit`。 |
| `extensions.review_execution.profile` | `evidence_only_v1 | evidence_assisted_v1 | semantic_review_v2 | acceptance_synthesis_v1` |
| `extensions.review_execution.material_mode` | `full | index`；仅 `semantic_review_v2` 使用。 |
| `alignment.scope` | `none | light | phase | project | discovery | resume` |
| `planning_policy.verdict_model` | `two_gate | not_needed` |
| `concurrency_contract.parallel_policy` | `forbidden | allowed_if_no_conflict | barrier_required` |
| `FINAL_HANDOFF.verdict` | `done | partial | needs_owner | needs_split | failed | pass | fail` |

`read_only_audit`声明只做只读审计；在 `scope.write_extra` 声明目标树写域即按实施投影为`real_rerun`。`simulated_planning`推导`execution_profile=simulation`，仍需提供`simulation.role`与结构化`simulation.persona`。编译回执的`warnings`记录模式投影；Pi直接/批量回执及Fleet节点与状态摘要保留这些说明。

## 2. task_package 顶层

| 字段 | 含义 | 填写者 | 消费者 |
| --- | --- | --- | --- |
| `version` | 任务包协议版本。 | 主代理 | 主代理、子代理 |
| `package_id` | 本次派发唯一 ID，必须和本轮任务包、handoff 与消费记录中的派发 ID 一致。 | 主代理 | 主代理、子代理、hook |
| `agent` | 目标角色、能力和子代理必读文件。 | 主代理 | 子代理、主代理消费端 |
| `project_positioning` | 当前仓库、阶段和任务与项目目标的关系。 | 主代理 | 子代理 |
| `goal` | 一句话可交付目标。 | 主代理 | 子代理 |
| `scope` | 允许读取、写入、删除和禁止范围。 | 主代理 | 子代理、主代理回执消费端 |
| `ownership` | 派发后任务面的持有和接管边界。 | 主代理 | 主代理、子代理 |
| `concurrency_contract` | 并发互斥、依赖、屏障和冲突键。 | 主代理 | 主代理、子代理 |
| `inputs` | 本次必须消费的文件、URL、旧报告和源产物。 | 主代理 | 子代理 |
| `known_facts` | 已确定事实；禁止写评价和推测。 | 主代理 | 子代理 |
| `expected_output` | 业务产物模式、路径、必填段和必填字段。 | 主代理 | 子代理、主代理接收 |
| `wait_policy` | 任务性质与低侵入监控合同。 | 主代理 | 主代理、hook |
| `monitoring` | 可选短状态、结果小文件和长工具观察配置。 | 主代理 | 主代理 |
| `runtime_context` | cwd、网络、授权、环境、网络快照和 git 证据。 | 主代理 | 子代理 |
| `alignment` | alignment 状态、锁定决策和 planner 放行信息。 | 主代理 | planner、plan-checker、executor |
| `planning_policy` | planning 两级门禁和资源增量规则。 | 主代理 | planner、plan-checker |
| `tool_contract` | 允许、禁止和降级工具动作。 | 主代理 | 子代理 |
| `stop_conditions` | 必须返回 `partial / needs_owner / failed` 的条件。 | 主代理 | 子代理 |
| `extensions` | 能力专属输入和扩展合同。 | 主代理 | 子代理 |
| `handoff_contract` | 最终回执和 handoff 文件要求。 | 主代理 | 子代理、主代理接收 |

## 3. agent

| 字段 | 含义 |
| --- | --- |
| `agent.role` | 目标注册角色，例如 `verify-agent`。 |
| `agent.runtime_role` | 实际入口；无降级时等于 `agent.role`。 |
| `agent.capability.name` | 能力名，例如 `code-verification`。 |
| `agent.capability.file` | 子代理能力提示词路径。 |
| `agent.required_files` | route 固定声明的必读提示词列表，包含公共层、适用的角色族公共层和能力提示词；启动材料在带路径的 `subagent-required-material` 边界内无损携带这些正文。 |

## 4. project_positioning

| 字段 | 含义 |
| --- | --- |
| `repo_path` | 当前仓库绝对路径。 |
| `repo_identity` | 从 `PROJECT.md` 抽取；模板态写 `template_unfilled`。 |
| `current_phase` | 从 `STATUS.md` 抽取；未知写 `unknown` 和原因。 |
| `roadmap_position` | 从 `ROADMAP.md` 抽取；未知写 `unknown` 和原因。 |
| `canonical_refs` | 本任务必须参考的真相源路径或 URL。 |
| `task_relevance` | 本任务与工程目标或阶段的关系。 |

## 5. scope

| 字段 | 含义 |
| --- | --- |
| `scope.read` | 允许读取的文件、目录、URL 或对象；仓外只读输入使用已存在的真实绝对路径。 |
| `scope.write` | 允许写入的文件或目录；只读任务写 `[]`。 |
| `scope.delete` | 允许删除的文件或目录；无则写 `[]`。 |
| `scope.out_of_scope` | 明确禁止碰的路径、对象或行为。 |

相对读取路径按目标仓解析；相对路径经 junction/symlink 解析到仓外时仍拒绝（已有运行包只读挂载许可保持不变）。读取错误给出实际解析路径；把被拒的 `scope.read` 条目替换为该已有文件或目录的真实绝对路径后重试 preview。此许可仅供读取，`scope.write` / `scope.delete` 的仓外边界保持不变；业务写入仍需在仓根或目标仓内显式授权，不新增授权字段。

实际回执中的 `scope_actual` 是事实记录。结构化语义审查在 `review_result_v1.scope.actual_reads` 声明实际消费的输入；完整消费时可用 `$scope_read`，runner 展开后再生成 `scope_actual.read`。

报告与 handoff 的相对路径按 `runtime_context.output_root` 解析；`scope.write` 其余条目与 `scope.delete` 的相对路径按执行目录 `runtime_context.cwd` 解析，跨仓时即目标树。报告与 handoff 始终落在发起方仓。

## 6. ownership

| 字段 | 含义 |
| --- | --- |
| `scope_owner` | 默认 `child_agent`，表示派发后 scope 由子代理持有。 |
| `parent_forbidden_same_scope_probe` | true 时，主代理消费前不得对同一 scope 做侧证扫描。 |
| `explicit_takeover_authorization` | 用户授权主代理接管同一 scope 的摘要；无则 null。 |

`ownership` 只声明 scope 持有和释放条件，不承载接管、消费或关闭动作。

## 7. concurrency_contract

| 字段 | 含义 |
| --- | --- |
| `group_id` | 同一批可比较并发关系的编排组；无并发写 null。 |
| `lane_id` | 同组内任务 lane；单任务写 `default`。 |
| `planning_wave` | PLAN wave 编号；不适用写 null。 |
| `depends_on` | 必须先完成并被消费的 package_id 或 lane_id。 |
| `conflict_keys` | 互斥资源键，至少覆盖写入集合、删除集合、输出路径、handoff 路径和关键依赖；只读范围可记录，但只读重叠不构成冲突。 |
| `parallel_policy` | `forbidden | allowed_if_no_conflict | barrier_required`。 |
| `barrier_points` | 屏障点，例如 `before_dispatch` 或 `before_consume`。 |
| `reason` | 并发判断理由，必须可回溯到授权、PLAN、依赖或 scope。 |

lane、background、wait policy 或组号不授予额外读写权限。

## 8. inputs

| 字段 | 含义 |
| --- | --- |
| `files` | 本次必须消费的输入文件；无则 `[]`。 |
| `urls` | 本次必须消费的 URL；无则 `[]`。 |
| `prior_reports` | 允许引用的旧报告路径；无则 `[]`。 |
| `source_artifacts.required_report_paths` | 必须使用的源报告路径。 |
| `source_artifacts.required_handoff_paths` | 对应 handoff 小文件路径。 |
| `source_artifacts.latest_valid_only` | 是否只允许最新有效源产物。 |
| `source_artifacts.replacements` | 旧坏件到新有效件的替换关系。 |

旧报告和旧 handoff 只有在 route 或能力提示词允许时才能进入输入。

## 9. expected_output

| 字段 | 含义 |
| --- | --- |
| `mode` | 固定为 `file`，表示必须落盘。 |
| `file_path` | 业务产物路径，必须列入 `scope.write`。 |
| `resolved_file_path` | `file_path` 按输出根解析后的绝对路径。 |
| `required_sections` | Markdown 必填段；无则 `[]`。 |
| `required_fields` | 结构字段；无则 `[]`。 |
| `business_gate` | 业务门字段名（裸名即 `FINAL_HANDOFF.output.<gate>`）；由 route 差异卡声明，`subagent_handoff_check.mjs` 在 output 层级强制非空并按 route 的 `gate_values` 枚举校验取值。 |

`expected_output` 描述业务产物；`handoff_contract` 描述结构化交接。

`expected_output.path` 是旧别名。新建 route、`package_seed` 和 `task_package` 不得使用旧别名。

`concurrency_contract` 只声明并发关系和等待约束，不承载补充、重拆、接管或关闭动作。

## 10. wait_policy 与 monitoring

| 字段 | 含义 |
| --- | --- |
| `wait_policy.class` | 任务性质审计标签，不决定等待授权。 |
| `passive_monitoring` | 是否允许被动监控。 |
| `probe_default` | 默认探针策略；通常为 `disabled`。 |
| `close_on_silence` | 静默是否可关闭；通常 false。 |
| `allow_background_continue` | 是否允许后台继续。 |
| `progress_file` | 长任务 progress 文件路径或 null。 |
| `status_check_by_parent` | 主代理状态检查策略。 |
| `monitoring.monitor_id` | 默认等于 package_id。 |
| `monitoring.alias` | 可读短名。 |
| `monitoring.status_brief` | 低上下文状态摘要路径。 |
| `monitoring.result_file` | 可选精简结果小文件。 |
| `monitoring.raw_logs_read_by_parent` | 主代理是否读取原始日志；默认 false。 |
| `monitoring.progress_required_for_long_tool` | 长命令是否必须写 progress。 |
| `monitoring.progress_wrapper` | progress 包裹工具路径。 |

hook、notification 和运行提示不是完成证明。

## 11. runtime_context

| 字段 | 含义 |
| --- | --- |
| `cwd` | 子代理执行目录；跨仓时为目标树，`git` 快照同样取自该目录。 |
| `output_root` | 控制仓根记录，由编译器生成。 |
| `target_repo` | 可选跨仓目标绝对路径；扫描任务只影响扫描对象和相对读取路径；执行任务可在 `scope.write` 显式列出的 `target_repo` 子路径写入。 |
| `target_repo_create_allowed` | 目标仓尚不存在且本任务被授权创建时写 `true`；未授权创建目标仓时写 `false` 或省略。该字段只解除 `target_repo` 存在性检查，不放开任意外部路径。 |
| `network_needed` | 本任务的联网声明；yes时编译器生成network_allowed=true投影。 |
| `fast` | 可选，仅开启时写 `true`；主代理写，Pi 运行器读并加载加速扩展。派单参数省略时 Claude Code 为关，Pi 主代理沿用最近请求的快速状态；显式布尔值优先。 |
| `scope_exists` | scope 是否存在。 |
| `environment_snapshot` | 本机环境和工具基线。 |
| `network_snapshot` | 网络目标、可达性和授权快照。 |

## 12. alignment 与 planning_policy

| 字段 | 含义 |
| --- | --- |
| `alignment.state_ref` | alignment 状态或 context 引用。 |
| `alignment.scope` | alignment 覆盖范围。 |
| `alignment.required_locks` | 必须满足的锁。 |
| `alignment.decision_refs` | 锁定决策 ID。 |
| `alignment.planner_allowed` | 是否允许进入 planner。 |
| `planning_policy.verdict_model` | planning 审查模型。 |
| `planning_policy.user_need_gate_required` | 是否要求用户需要门禁。 |
| `planning_policy.execution_health_gate_required` | 是否要求执行健康门禁。 |
| `planning_policy.resource_delta_allowed` | 是否允许 planner 写资源增量。 |
| `planning_policy.block_on_irrelevant_task` | 是否阻断无关任务。 |
| `planning_policy.block_on_unproven_user_need` | 是否阻断未证明用户需要。 |
| `planning_policy.high_impact_resource_requires` | 高影响资源所需确认项。 |

workflow gate 是否放行看对应 workflow，不由字段本身推断。

## 13. tool_contract、stop_conditions、extensions

| 字段 | 含义 |
| --- | --- |
| `tool_contract.allowed` | 可选；缺省或 null 继承用户级 Pi 已启用的工作工具；显式非空字符串数组作为本任务工具限制传给 `pi -t`，工具名不维护闭集。空数组不暴露工作工具，runner 仍可补入结构化结果提交工具。资源选择与实际清单见 `ops/policies/runtime-tools.md` §7。 |
| `tool_contract.forbidden` | 任务级行为边界；不冒充 OS 沙箱或工具隐藏。 |
| `tool_contract.network_allowed` | 是否授权任务联网；与工具可见性分离。 |
| `tool_contract.install_allowed` | 是否授权任务安装或解析依赖；启动提示按该值表达动作边界。 |
| `stop_conditions` | 必须停下并返回非完成状态的条件。 |
| `extensions.capability_contract` | 当前能力专属输入；结构化 review 的启动投影必须完整保留。 |
| `extensions.capability_contract.<slot>.mechanical_checks` | 可选机械取证列表；每项包含 `id`、`argv`、`cwd`，可选 `timeout_seconds`、`expected_exit_codes`。只由 `dispatch_prepare.mjs` 执行。 |
| `extensions.capability_contract.planner.mechanical_schema` | planner 路由与产物闭集的只读快照，包含来源标识和非空允许值列表；planner 按对应列表消费。构包责任见 `planner-agent__plan-authoring` route。 |
| `extensions.orchestration.delegation_intent` | 可选派发动机说明：主代理说明为什么派、要消哪个不确定、结果影响什么决定；不承载事实、结论、scope、历史长摘录或消费动作。 |
| `extensions.review_execution` | structured review 执行画像；profile 与 material mode 的值域见 §1，材料构造、semantic profile 投影和分流规则由 `ops/protocols/subagent-information-injection.md` §3 维护；runner 根据结构化结果生成报告与 handoff。 |
| `extensions.review_execution.contract_slot` | 静态审查 route 的能力合同槽位；证据 producer 从 route 映射投影，preload 与 runner 用它读取同一 `capability_contract`。 |
| `extensions.review_evidence` | 机械证据包的路径、完整性、材料模式、实际材料预算统计和检查摘要；正文由启动材料渲染器注入。 |
| `extensions.long_task` | 长任务专属状态。 |
| `extensions.block_context` | 阻塞讨论上下文。 |
| `extensions.verify` | 已废弃：迁移至 `extensions.capability_contract.verify`。 |
| `extensions.batch_contract` | 已废弃：迁移至 `extensions.capability_contract.batch`。 |

能力专属字段不得新增 `task_package` 顶层格式。

只读、调研和审查类任务默认禁止 `write_outside_scope`，表示不得写 `scope.write` 以外的文件；它不禁止写入任务包授权的报告、handoff、截图索引或证据目录。需要真实修改业务文件的执行类任务，必须在 `scope.write` 显式列出目标，并按对应 route 授权写入动作。

## 14. handoff_contract

| 字段 | 含义 |
| --- | --- |
| `require_final_handoff` | 编译器固定为true，启用父级交接校验；调用者无需填写。 |
| `handoff_file` | 同一份 `FINAL_HANDOFF` 的落盘小文件路径或 null。 |
| `resolved_handoff_file` | `handoff_file` 按输出根解析后的绝对路径；无 handoff 文件时为 null。 |
| `handoff_file_required` | 是否必须写 handoff 文件。 |
| `accept_verdicts` | 本任务可接收的 `FINAL_HANDOFF.verdict` 值，必须取自闭集。 |

`final_response_required` 是旧别名。新建 route、`package_seed` 和 `task_package` 不得使用旧别名。

`parent_consume_action`是主代理消费记录字段；构包器剥离传入的`handoff_contract.parent_consume_action`，由主代理另行保存消费记录。

## 15. FINAL_HANDOFF

普通任务最终回复的最后一个代码块必须且只能是完整 `FINAL_HANDOFF:` YAML。结构化 review 的模型只返回 `review_result_v1`，runner 按同一字段合同生成并落盘 `FINAL_HANDOFF`。

| 字段 | 含义 |
| --- | --- |
| `package_id` | 必须匹配 `task_package.package_id`。 |
| `verdict` | 子代理协议结论，取闭集 `done | partial | needs_owner | needs_split | failed | pass | fail`。 |
| `summary` | 顶层一行结果摘要，供主代理快读；详细内容归报告。 |
| `output.target_repo` | 跨仓任务的扫描目标绝对路径；无跨仓目标时写 null。 |
| `output.file_path` | 业务产物路径，必须匹配 `expected_output.file_path`。 |
| `output.resolved_file_path` | file 模式业务产物绝对路径；任务包提供 `expected_output.resolved_file_path` 时必须匹配。 |
| `output.handoff_file` | handoff 小文件路径；无则 null。 |
| `output.resolved_handoff_file` | handoff 小文件绝对路径；任务包提供 `handoff_contract.resolved_handoff_file` 时必须匹配。 |
| `output.<能力专属字段>` | 能力业务状态、报告索引或结果摘要，只能追加。 |
| `scope_actual.read` | 实际读取内容。 |
| `scope_actual.written` | 实际写入内容。 |
| `scope_actual.deleted` | 实际删除内容；无则 `[]`。 |
| `evidence_refs` | 支撑结论的 `file:line`、URL 或命令证据。 |
| `validation.required_files_loaded` | 任务说明、公共规则、能力规则和输出要求是否可用；结构化 review 由 runner 核对必读文件正文已经进入任务材料。 |
| `validation.expected_output_satisfied` | 是否满足任务包输出要求；结构化 review 由 runner 在 schema、能力专属字段和输出路径检查通过后填写。 |
| `validation.scope_compliant` | 是否遵守 scope；具有覆盖文件集合的结构化 review 由 runner 核对目标覆盖，semantic review 同时核对 `actual_reads`，acceptance synthesis 核对 `reviewed` / `not_reviewed` 精确分割 `scope.read`。 |
| `validation.mechanical_check` | 退出前机械自检结论，必须为 `pass`；普通 handoff 由 `subagent_handoff_check.mjs` 产出（经 `submit_task_result` 提交时由工具渲染并当场调用同一 checker），结构化 review 由 runner 完成上述检查后填写。 |
| `validation.required_files_loaded_detail` | 可选明细，取 `provided | missing`。 |

能力合同的覆盖文件集合取非空 `target_files`，没有该字段时取非空 `affected_files`。结构化 review 的 `scope.reviewed=["$target_files"]` 表示完整覆盖该集合；runner 在 schema、报告和 handoff 处理前展开为精确路径。部分覆盖用精确 `reviewed` / `not_reviewed` 分割覆盖集合并返回 `needs_owner`。没有覆盖文件集合时，`reviewed` / `not_reviewed` 精确分割 `scope.read`。semantic review 的 `scope.actual_reads` 记录实际消费的授权路径；确已全部消费时可用 `$scope_read` 简写。`scope.read` 是许可范围，不要求全部消费；必要证据是否充分按本次目标判断，未读的非目标授权材料不构成缺口。任一 runner 校验失败时拒绝生成正式 handoff，validation 保持失败事实。

## 16. 兼容字段

以下历史字段只作兼容期维护辅助，不是长期协议：

| 旧字段 | 新字段 |
| --- | --- |
| `expected_output.path` | `expected_output.file_path` |
| `handoff_contract.final_response_required` | `handoff_contract.require_final_handoff` |
| `handoff_contract.parent_consume_action` | 主代理消费记录，构包器剥离输入，不进入任务包 |
| `ownership.unlock_conditions` | 父级生命周期记录，构包器剥离输入；写域释放仍由运行时确认 |
| `file_path` | `output.file_path` |
| `report_file` | `output.file_path` |
| `report_path` | `output.file_path` |
| `handoff_path` | `output.handoff_file` |
| `output.summary` | 顶层 `summary` |
| `files_touched` | `scope_actual` |
| `scope_actual.write` | `scope_actual.written` |
| `scope_actual.writes` | `scope_actual.written` |
| `skills_loaded` | 只能作为 `validation.required_files_loaded` 的辅助证据 |

主代理优先消费新结构。旧字段不得作为新增 route 的依据。
