# 子代理信息注入方式

> 职责：说明子代理系统身份模板的选择、启动材料渲染和交付形态。
> 真源：worker system 选择、任务材料渲染顺序和 MCP async 交付机制
> 读取：命中读取

本文件只说明系统身份模板和任务材料由哪些机制选择、渲染与交付。系统身份、角色提示词和各任务材料允许承载什么，只看 `ops/protocols/subagent-material-layering.md`；本文件不复制层归属正文，也不决定是否派发、派给谁、任务包字段全集、`FINAL_HANDOFF` 字段词典、运行账本、等待策略、运行态清理或主代理如何消费回执。

## §1. 适用范围

本文件只维护以下机制的说明和修改边界：

- 正式 child 对 worker system 模板的显式选择和主代理 APPEND 自动发现替换。
- 子代理任务材料的读取、渲染顺序和失败方式。
- 子代理可见材料通过 MCP async 交付的形态。
- 子代理可见输出模板的选择与合成。

本文件不维护以下对象：

- 普通 hook 治理和事件注册。
- 非当前启动材料链路的历史运输机制。
- route、字段词典、状态写入或运行态清理入口。
- 一般验证失败或非注入合同迁移。

本文件自身不承载入口路由判断；入口命中后才读取本文件。

## §2. 子代理可见材料

WHEN: 子代理被启动
ACTOR: 构包器与child runner
MUST: 按以下来源组装完整正文并交付子代理；构包器负责任务材料，runner负责系统身份模板。

系统身份模板：

- `ops/tools/run-pi-task.mjs` 使用 `--append-system-prompt` 显式选择 `ops/templates/worker-system-prompt.md`。显式 append source 替代用户级 `APPEND_SYSTEM.md` 自动发现。
- worker system 的内容职责与污染门只看 `ops/protocols/subagent-material-layering.md` §3、§4；本文件只维护模板选择机制。
- worker system 文件缺失时 runner fail-closed，并要求重新构建和部署 child runner。

角色运行提示词：

- `subagent_preload.mjs` 根据任务包 `agent.runtime_role` 直接读取同名 `ops/agents/<role>.toml` 的 `developer_instructions`，并校验文件名与根部 `name` 一致。
- 角色没有注册、配置文件不存在或 `developer_instructions` 为空时，材料准备 fail-closed；回执点名实际缺口。角色层的内容职责只看 `ops/protocols/subagent-material-layering.md` §3、§4。
- `dispatch_prepare.mjs` 根据能力合同投影条件层：携带 `acceptance_context` 时加入验收叶子公共层；`plan-authoring` 按 `planning_pass` 加入 topology、slice-detail、aggregate 三者中的一份产物规则。

完整任务材料由 `node ops/tools/subagent_preload.mjs render` 统一渲染，顺序固定：

```text
## 角色运行提示词（ops/agents/<role>.toml）
<developer_instructions>

## 公共提示词
<!-- subagent-required-material:start {"path":"<公共提示词路径>"} -->
<公共提示词正文>
<!-- subagent-required-material:end -->

## 能力提示词
<!-- subagent-required-material:start {"path":"<能力提示词路径>"} -->
<能力提示词正文>
<!-- subagent-required-material:end -->

## 任务包
<task_package JSON>

## 补充材料
<!-- subagent-required-material:start {"path":"<其他必读文件路径>"} -->
<任务包要求的其他规则文件正文>
<!-- subagent-required-material:end -->

## 机械证据包
<静态终验命中时，由 review_evidence.mjs 生成并由 subagent_preload.mjs 注入；语义终审标注 full 或 index>

## 输出要求
<结构化 review 注入 review_result_v1 模板；普通任务注入 FINAL_HANDOFF 模板>
```

BLOCK IF:

- 系统身份或任务材料已被 `ops/protocols/subagent-material-layering.md` 判为 `contaminated`，仍进入渲染、发布或派发。

## §3. Async Subagent 派发路径

WHEN: 主代理使用默认 async subagent 路径派发子任务
ACTOR: 主代理、Pi `dispatch_prepare` 工具和 `ops/tools/subagent_service.mjs`
MUST:

1. Pi 主代理调用本控制面注册的扩展工具 `dispatch_prepare(action=preview|submit)`；未加载该扩展工具的宿主临时调用同名 JS 编译器。
2. `dispatch_prepare.mjs` 渲染完整任务材料与 Prepared Envelope。Pi 扩展工具的 `submit` 把已校验的 `dispatch_file` 交当前 session AsyncTaskService；MCP 适配宿主通过内部 adapter 提交。两条路径返回同一 durable `task_id` 合同，不向子代理暴露运输差异。
3. child runner 用显式 worker system 启动 Pi，再把完整任务材料包装为单条 user message；worker system 不复制任务材料正文。
4. verify静态终验默认使用`evidence_assisted_v1`：机械证据包预装进任务材料，工具按`tool_contract.allowed`投影，缺省继承工具面，受限非空集原样保留，沿用普通任务结果提交。任务包显式声明`tool_contract.allowed: []`、机械证据完整且未声明联网时使用封闭卷宗`evidence_only_v1`：child只返回紧凑语义结果，runner生成报告和handoff。声明`network_needed=yes`时的模式调整写入编译回执`warnings`。工具继承和结果提交由运行工具策略规定。
5. semantic review 的 profile 来源链固定为：semantic route id → `dispatch_prepare.mjs` 静态审查分支 → `review_evidence.attachReviewEvidence` 投影 `semantic_review_v2` 与 material mode → prepared task package → runner。`material_mode=full` 注入预算内的显式文件材料；`material_mode=index` 注入有界路径索引、声明角色及预算内的显式目标正文，其余材料由同一任务按需读取。`scope.read` 的目录授权不触发整棵目录正文预装；显式目标目录仍按目标预算取材。省略与未枚举范围随材料标明，读取授权及工具画像保持不变。实际工具由 runner 按运行工具策略投影；结构化结果提交按 `ops/policies/runtime-tools.md` §2 的提交机制执行，runner 独占 canonical report/handoff 写入。
6. Acceptance reducer 使用 `acceptance_synthesis_v1`，沿用六节 `review_result_v1` 与 runner 合成链；它读取任务包和 dependency index，不进入静态 evidence profile。

OUTPUT: 后台任务目录中的 `status.json`、`result.json`、`handoff.md`、`report.md`。
STATE UPDATE: none；普通后台任务 start / finish 不写低频状态。

## §4. Direct 渲染预览

WHEN: 只读预览、调试任务材料或工具自测
ACTOR: 主代理
MUST:

1. Pi 主代理使用本控制面注册的扩展工具 `dispatch_prepare(action=preview)`；未加载该扩展工具的宿主使用 `node ops/tools/dispatch_prepare.mjs --action preview`。工具自测或内部调试需要查看完整材料时，运行 `node ops/tools/subagent_preload.mjs render --package <task-package.json>`。
2. `direct` 只表示 file-ref 材料渲染形态，不是合法派发通道。

direct render 形态：

```text
node ops/tools/subagent_preload.mjs render --package tmp/dispatch_prepare/<package_id>.task-package.json
```

OUTPUT: 固定render命令输出完整任务材料；file-ref预览提供该命令，正式交付使用渲染全文。运输失败与内部路径错误按§7返回调用方，由调用方修复后重试。

## §5. 收尾质量

`evidence_only_v1`、`semantic_review_v2` 与 `acceptance_synthesis_v1` 的精简任务包必须保留 `agent.runtime_role`、`agent.capability`、完整 `agent.required_files` 和 `extensions.capability_contract`。能力合同存在 `acceptance_context` 时，构包器把 `ops/agent-prompts/_acceptance-leaf-common.md` 追加到 `agent.required_files`；不存在时不注入。角色运行提示词来自注册角色 TOML；每份 required file 正文位于带路径的 `subagent-required-material` 边界内。机械证据包不使用该边界，不计入必读材料证明。canonical 报告和 handoff 由 runner 根据已校验的结构化结果生成；structured child 不直接写这两个路径。静态审查由 `review_execution.contract_slot` 定位 route 已投影的能力合同。runner 按字段词典 §15 解释覆盖文件集合、展开 coverage 标记、核对语义审查的实际读取记录，并同时核对边界路径与完整正文、能力合同与证据合同及输出路径，再写 `mechanical_check=pass`。`require_final_handoff=true` 的候选成功任务由 Async worker 调用同一个父级 checker 复验，失败时进入 `invalid_handoff / needs_parent_review`，不得发布为 `contract_state=ok`。

## §6. 设计边界

- 系统身份和各任务材料的内容归属只看 `ops/protocols/subagent-material-layering.md`；本文件只维护模板选择、渲染顺序、交付和失败机制。
- handoff 是收尾动作；字段值域和字段解释归 `ops/protocols/task-package-reference/field-dictionary.md`、命中 route 和 handoff 自检工具维护。
- 开工阶段公共提示词不承担完整 handoff 教程；需要减少开工负载时，优先调整输出模板。

## §7. 失败边界

提交或材料准备失败时，运输层把错误返回调用方，不把 delivery、材料缺失或内部路径错误写进子代理可见材料。调用方的恢复动作由 `ops/policies/runtime-tools.md` 决定。

## §8. 维护入口

| 维护目标 | 入口 |
| --- | --- |
| child 系统身份 | `ops/templates/worker-system-prompt.md`；选择和 fail-closed 由 `ops/tools/run-pi-task.mjs` 负责 |
| 全文任务材料模板 | `ops/tools/dispatch-core/subagent_preload.mjs` |
| async 启动头、运输与状态 | `ops/tools/async-core/runtime.mjs`、`ops/tools/subagent_service.mjs` |
| handoff 机械自检 | `ops/tools/subagent_handoff_check.mjs` |
| 普通任务结构化交付（`submit_task_result`） | `ops/tools/task_result_synthesis.mjs`、`ops/tools/pi_task_result_extension.mjs` |
| 子代理输出模板 | `ops/tools/dispatch-core/subagent_preload.mjs` |
| task package 和 `FINAL_HANDOFF` 字段词典 | `ops/protocols/task-package-reference/field-dictionary.md` |
| 角色运行提示词 | `ops/agents/<role>.toml` |
| 子代理公共提示词 | `ops/agent-prompts/_common.md` |
| 静态终验机械证据 | `ops/tools/dispatch-core/review_evidence.mjs` |
| 静态终验紧凑启动模板 | `ops/templates/review-evidence-prompt-template.md` |
| 静态终验报告与 handoff 合成 | `ops/tools/review_result_synthesis.mjs` |
| Pi child 工具映射与进程树收口 | `ops/tools/pi_worker_resources.mjs` 从 Pi 配置发现工作资源并按任务包 `worker_resources` 白名单选取；`ops/templates/worker-resources.json`（version 2）给每项资源标 `off` / `optional` / `default_on` 并列出交卷通道的 `required_tools`；`task_package.tool_contract.allowed` 由角色 × 能力白名单编译；`ops/tools/pi_worker_tools_extension.mjs` 记录实际清单；`ops/tools/pi_child_bash_process_tree.mjs` 负责 Bash 进程树 |

## §9. 修改后验证

控制面维护者修改共享注入实现、公共输出模板、handoff 契约或公共提示词后，在开发仓按 `ops/policies/runtime-tools.md` §5 执行对应源码回归。修改 worker system 或其选择参数时，在开发仓运行 `node ops/tools/run-pi-task.mjs --self-test`、`node --test tests/control_plane/run_pi_task_security.test.mjs`，并取得真实 child system prompt 探针结果后完成该项维护验收。

消费者项目的主代理按任务验收合同验证自身材料和业务产物，在消费者仓执行所需的真实任务。控制面维护自测不作为消费者健康检查或业务收口的前置条件；健康检查也不替代上述 worker system 维护验收。
