# 子代理材料分层

> 职责：定义子代理系统身份、配置注册、角色提示词和任务材料的职责边界。
> 真源：子代理系统身份与任务材料层归属、错层阻断和按需读取入口
> 读取：命中读取

本文件只在构造、审查或整改子代理系统身份与任务材料时读取。它不决定是否派发、派给谁、日常任务包如何构造、`FINAL_HANDOFF` 字段值域或主代理如何消费回执。

本文件所称“执行材料”是作为指令交给 child 完成业务任务的系统身份、角色提示词、公共提示词、能力提示词、任务包、补充材料和输出要求。任务包授权审查的目标文件与机械证据属于取证对象，不因其正文描述运输机制而命中污染门；只有这些内容被复制进执行指令正文，或 child 被要求把它们当作本次运行方式遵守时，才按 §4 判定。

## §1. 入口

WHEN: 构造、审查或整改子代理系统身份、配置注册、角色运行提示词、启动材料、任务包、公共提示词、能力提示词、补充材料或输出要求
ACTOR: 主代理
MUST: 按§3识别材料受众与职责，形成层归属判断，再定位对应真源；构包、字段和回执问题转向各自入口。
OUTPUT: `MATERIAL_LAYER_DECISION`

## §2. 污染收口

WHEN: 任一子代理执行材料命中 §4 错层污染门
ACTOR: 主代理
MUST:

1. 判定命中材料为 `contaminated`，暂停其派发、预览复用与审查放行。
2. 按§4将内容归位并重写污染材料；生成材料废弃后从修复后的真源重新生成。
3. 对修复结果重新形成 `MATERIAL_LAYER_DECISION`，以污染是否消除判断放行，不以改词、搬段或机械lint通过替代判层。

BLOCK IF: 修复后仍命中§4污染门。出口：继续归位、重写并重判；无法消除时收口 `needs_owner` 并说明缺口。

STATE UPDATE: none；污染和重写证据只进入本轮审查报告、rationale 或对应任务记录，不写低频状态。

## §3. 材料职责

| 材料 | 职责 | 真源 |
| --- | --- | --- |
| 系统身份层 | 声明正式 child 是后台 worker、任务包是实例权威、结果交付给父代理；不承载主代理交互风格、项目治理、任务实例或输出模板 | `ops/templates/worker-system-prompt.md`；启动选择由 `ops/tools/run-pi-task.mjs` 负责 |
| 角色运行层 | 以 `<role>.toml` 文件名和根部 `name` 注册角色，承载短触发摘要、模型运行配置和跨能力槽默认姿态；每句话必须对该 role 当前已注册的全部 capability 成立 | `ops/agents/<role>.toml` |
| 任务包 | 承载本次任务实例：goal、scope、expected output、known facts、tool / handoff 合同和能力输入；内部 route / agent 元数据只供 build、lint、渲染定位，不供子代理改判职责 | `ops/protocols/task-package.md`；字段维护看 `ops/protocols/task-package-reference/field-dictionary.md`；能力输入和 route 固定包头看命中 `ops/protocols/task-package-routes/<role>__<capability>.md` |
| 公共提示词 | 承载所有子代理共同执行边界、证据要求、拒收口径、最终回执动作和退出前机械自检 | `ops/agent-prompts/_common.md` |
| 能力提示词 | 承载单一 role / capability 可观察、可执行、可拒收、可举证的动作和产物结构 | `task_package.agent.capability.file` 指向的 `ops/agent-prompts/<role>/<capability>.md`；固定格式看 `ops/protocols/subagent-capability-prompt-format.md` |
| 补充材料 | 承载本次任务额外授权读取的规则正文或上下文，不替代任务包实例参数 | `task_package.agent.required_files` 中除公共提示词和能力提示词外的路径 |
| 输出要求 | 承载完整 `FINAL_HANDOFF` 骨架和当前允许的机械字段形态 | `ops/tools/dispatch-core/subagent_preload.mjs` 生成；字段值域维护看 `ops/protocols/task-package-reference/field-dictionary.md` |

写入角色运行层前，从 `dispatch_prepare(action=list)` 取得该 role 当前已注册的 capability 集合，逐句核对是否对集合内每一项都成立。通过测试的内容留在 `ops/agents/<role>.toml`；只对单一 capability 成立的内容放入能力提示词；只对单次任务成立的内容放入任务包。新增 capability 时重新执行同一测试；不通过就把专属内容移入 capability prompt，或拆分 role。

不要在子代理材料内维护本地优先级表，但字段值域、输出模板和任务实例参数各自仍由对应真源提供正本。

注入顺序和 MCP async 材料形态，只看 `ops/protocols/subagent-information-injection.md`。
能力提示词的章节骨架、标题闭集和格式重写准入，只看 `ops/protocols/subagent-capability-prompt-format.md`。

## §4. 错层污染门

先用 §3 判定内容归属；只有命中本节污染门时才按 §2 重写。未命中污染门的归属偏差，改回正确层即可。

| 污染门 | 判定 | 收口 |
| --- | --- | --- |
| 跨层正文复制 | 某层承载其他层的完整正文、教程、模板、字段全集或操作手册 | 移回真源；生成材料废弃重做 |
| 任务实例错层 | 角色运行层、公共提示词、能力提示词、补充材料或输出要求提供本次 `goal`、`scope`、`known_facts`、`expected_output`、`handoff_contract`、`tool_contract` 或读写范围正本 | 移回任务包；字段值域问题回字段词典或 route |
| 角色和能力错层 | 角色运行层写单一 capability 字段、业务 gate 或报告模板；公共提示词写单一能力细节；能力提示词写其他 role 职责、路由矩阵或跨能力比较 | 移回对应 role、capability、route 或主代理常驻入口 |
| 运输机制泄露 | 执行指令正文解释 hook、pending、preload、bundle、SubagentStart、SubagentStop、direct、已退役运行账本、回执消费或等待管理；任务包授权的审查对象和机械证据不按本行判定 | 移回 `ops/protocols/subagent-information-injection.md` 或运行工具真源 |
| 主代理职责下沉 | 子代理材料要求子代理选择 role、改派、重派、等待、消费回执、关闭实例、写状态、提交 Git、与最终用户协商或判断主代理如何吸收结果 | 移回主代理常驻入口、对应 workflow 或 policy |
| 主代理系统污染 | 系统身份层包含全局交互风格、Ultimate Reminders、项目治理、Memory policy、本地时间纪律或 task package 正文 | 系统身份层只保留 worker actor；其余内容回主代理提示词或任务材料真源 |
| 历史复盘污染 | 旧事故、parser 错法、字段别名黑名单、旧 finding 全文、上一轮报告全文、prompt friction 或“为了避免模型……”类复盘进入执行材料 | 移入 notes / docs；确需长期化的字段和值域放入字段词典或 route |

归属示例：

| 要表达的内容 | 放置位置 |
| --- | --- |
| 什么时候考虑某个子代理 | `dispatch_prepare(action=list)` 的 route / role 投影 |
| 正式 child 的后台 worker 身份 | `ops/templates/worker-system-prompt.md` |
| 某个 role 的默认站位 | `ops/agents/<role>.toml` |
| 某个 capability 如何检查、判定和输出局部 gate | `ops/agent-prompts/<role>/<capability>.md` |
| 本次任务要读什么、写哪里、以什么作为完成条件 | 任务包 |
| `FINAL_HANDOFF` 机械字段长什么样 | 输出要求模板和字段词典 |
| MCP async 如何把材料送给子代理 | `ops/protocols/subagent-information-injection.md` |

常见错层问题：

| 表现 | 归位 |
| --- | --- |
| 任务包塞入公共提示词、能力提示词、补充材料或输出模板正文 | 按跨层正文复制处理，任务包只留本次实例参数 |
| 任务包解释派发判断、候选 role 比较、改派方案、等待、回执吸收、状态写入或 Git 动作 | 按主代理职责下沉处理，回到主代理常驻入口、对应 workflow 或 policy |
| 角色运行层写单一 capability 的输入字段、业务 gate、报告模板或默认输出路径 | 按角色和能力错层处理，移入能力提示词或任务包 |
| 公共提示词写单个 role / capability 的专属字段、报告结构、扫描步骤或默认 notes 目录 | 按角色和能力错层处理，移入族公共层、能力提示词或任务包 |
| 能力提示词写主代理如何消费结果、失败后如何重派、用户如何批准接管、planning / state 后续如何推进 | 按主代理职责下沉处理，移回主代理入口或对应 workflow / policy |
| 补充材料让子代理反推出本次输出路径、读写权限、验收标准或旧 handoff 上下文 | 按任务实例错层处理，回到任务包 |
| 输出要求塞入本次业务目标、scope、验收标准、能力步骤或报告正文要求 | 按任务实例错层或跨层正文复制处理，回到任务包或能力提示词 |
| 执行指令正文解释 hook、preload、bundle、运行账本或 SubagentStop 工作方式 | 按运输机制泄露处理，回到信息注入协议或运行工具真源；任务包授权的审查对象和机械证据仍只作取证 |
| 旧字段别名或根级输出形态复活，例如 `expected_output.path`、根级 `report_path`、小写 `final_handoff` | 回到字段词典或 route 修正字段正本 |

## §6. 输出形态

`MATERIAL_LAYER_DECISION` 至少包含：

```yaml
material_target:
trigger:
selected_layer:
source_file:
allowed_content:
blocked_content:
contamination_status:
rewrite_required:
follow_up_source:
```

`follow_up_source` 只写下一步应读的单个真源或 `none`。不得写目录、glob 或整批候选文件。

`contamination_status` 只能写 `clean | contaminated`。命中 §4 任一污染门时，`rewrite_required` 必须为 `true`。

## §7. 验证

WHEN: 修改本文件、`AGENTS.md` 材料分层入口、公共提示词、能力提示词、启动材料模板或输出要求
ACTOR: 主代理
MUST: 按改动面选择验证

- `python -B ops/tools/cockpit_map.py --lint`
- `git diff --check`
- 修改系统身份层时，运行 `node ops/tools/run-pi-task.mjs --self-test` 和真实 child system prompt 探针
- 修改启动材料模板时，运行 `node ops/tools/subagent_preload.mjs --self-test`
- 修改 handoff 输出要求时，运行 `node ops/tools/subagent_handoff_check.mjs --self-test`

BLOCK IF: 修改机制或材料真源后只做文案确认，没有取得对应机械验证结果。
