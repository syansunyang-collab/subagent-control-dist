# cockpit-layering.md

> 职责：规定 `ops/` 内部目录分层和归属。
> 真源：`ops/` 内部目录职责、话题属主表、跨层引用和拆分规则
> 读取：命中读取

`ops/` 内部目录必须按功能层分工。一个文件只能归属一个主职责；跨层引用只能引用，不得复制对方规则。写运行规则前先按本表判定归属。

| 路径 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `ops/workflows/` | 主代理阶段流程、阶段状态、进入条件、出站 seed、用户确认点 | 子代理任务包结构、子代理能力正文、回执消费策略 |
| `ops/workflows/<workflow>/` | 单个 workflow 的状态字段、阶段 gate、上下文输出和下一步 seed | 跨 workflow 通用合同、全局运行策略 |
| `ops/protocols/` | 跨 workflow、跨 agent 共享的数据合同和结构格式 | 单个 workflow 状态机、能力选择、回执消费策略 |
| `ops/protocols/file-convention.md` | 治理文件引用格式、文件头字段、读取值域和地图 lint 规则 | 日常读取入口、语义审查结论、孤儿文件删除裁决 |
| `ops/protocols/cockpit-layering.md` | `ops/` 内部目录分层和归属 | 运行期派发入口、任务包字段全集、具体能力提示词正文 |
| `ops/protocols/task-package.md` | 任务包协议入口、字段维护索引和运行期构包链路说明 | 日常派发入口、字段全集正文、回执消费策略 |
| `ops/protocols/task-package-reference/` | 新建子代理、能力、route 的设计指导；任务包和 `FINAL_HANDOFF` 字段词典；规则冲突裁决 | 日常派发入口、单能力构包规范、回执消费动作 |
| `ops/protocols/task-package-routes/` | 主代理已决定派发后，单个 agent/capability 的构包入口 | 全量任务包协议、工作流入口、回执消费策略 |
| `ops/policies/` | 横跨 workflow 的运行策略、门禁、异常处置和状态反写规则 | 数据结构全集、单个能力提示词、阶段状态字段 |
| `ops/policies/state.md` | `STATUS.md`、`ROADMAP.md`、notes 和回执吸收后的状态反写 | 子代理任务包协议、workflow 业务逻辑 |
| `ops/agent-prompts/` | 子代理收到任务包后的角色行为、输出要求、能力边界 | 主代理路由、任务包字段定义、回执消费策略 |
| `ops/agents/` | agent 运行配置、按 `<role>.toml` 文件名注册角色、模型/工具约束 | 工作流说明、任务包协议正文 |
| `ops/hooks.json` | Codex hook 注册配置 | hook 实现代码、运行态缓存、回执消费策略 |
| `ops/hooks/` | Codex hook 实现代码 | 回执消费策略、长期报告、业务逻辑 |
| `ops/tools/` | Codex 自用维护工具和运行辅助入口 | 模板产物、运行态缓存、业务语义判断脚本 |
| `ops/map/` | 自动生成的 Codex 编排治理文件地图，含编排型技能导航 | 规则正文、字段真源、执行入口、业务模块映射、业务内容索引 |
| `ops/skills/` | 项目级 Codex skill，用于低频维护流程、接手手册和专项操作索引 | 高频主代理入口、子代理能力提示词、一次性报告、运行态证据、业务真源 |

硬约束：

- workflow 状态文件必须放在对应 `ops/workflows/<workflow>/` 下；例如 alignment 状态字段归 `ops/workflows/alignment/`，不归 `ops/protocols/`。
- `ops/protocols/` 只保存跨层共享合同；只被一个 workflow 使用的字段不得放入 protocols。
- `ops/policies/` 只写行为策略，不复制 `task_package` 或 `FINAL_HANDOFF` 字段全集。
- `ops/agent-prompts/` 只塑形子代理，不教主代理如何选择能力。
- `ops/tools/` 只放 Codex 自用维护工具。
- `ops/map/` 只保存自动生成的编排治理地图；地图只定位编排文件和 `layer=orchestration` 的技能，不复制字段枚举、规则正文、业务模块、业务代码或业务内容。
- 业务材料不进入 `ops/map/`。真实业务目标出现后，按 `ops/protocols/business-map.md` 在根目录 `map/` 建立业务能力地图。
- 技能归属由各技能 `SKILL.md` frontmatter 的 `layer`、`domain` 和 `capability_group` 字段表达；正文 `职责 / 真源 / 读取` 不承担机器分类。
- `ops/skills/` 只放可复用专项维护流程和接手索引；不得替代主代理常驻入口或子代理能力提示词。
- `ops/` 不放运行态缓存、临时生成物或模板产物。
- 运行态热区和 blank-project 模板产物的顶层归属，按 `ops/protocols/repository-structure.md`。
- 任何新增运行规则文件必须先选择主职责；如果同时需要两个职责，拆成两个文件，互相引用。

## 话题属主表（唯一真源裁决）

同一话题只在属主文件维护；其他位置只允许一跳指针加一句语义。表外话题按上表目录归属判定；裁不了的先进 `notes/context/` 方案卡。

| 话题 | 属主 |
| --- | --- |
| 规则写作原则、R1–R12 判据、规则变更流程 | `ops/skills/rule-authoring/SKILL.md` |
| 入口调度、强制派发纪律、冲突裁决、等待门 | `AGENTS.md` |
| `package_seed` 内容红线 | `AGENTS.md` |
| 回执消费流程与合格 handoff 通用核对 | `AGENTS.md` |
| 状态触发类清单 | `AGENTS.md` |
| 状态写入分层、低频闭集、冲突调和、notes 目录用途 | `ops/policies/state.md` |
| 运行工具使用边界与子代理工具准入 | `ops/policies/runtime-tools.md`；命令细节归各工具 `--help` 与自测 |
| 运行态清理拒删条件 | `ops/policies/runtime-retention.md` |
| 单能力构包合同（必填字段、枚举、默认值、accept_verdicts、required_sections） | 对应 route 的 `route_card`（机器真源；改后必跑 `--card-check`） |
| 卡外条件构包规则 | 对应 route 的 `### 构包要点` |
| 单能力执行行为与判定核心 | 对应能力提示词 |
| 全员子代理通则（边界、证据、回执、自查） | `ops/agent-prompts/_common.md` |
| 审查族通则（两轴结论、finding 纪律、禁自动化） | `ops/agent-prompts/_review-common.md` |
| 探查族通则（扫描工作流、报告结构、partial 协议） | `ops/agent-prompts/explorer-agent/_explorer-common.md` |
| `task_package` / `FINAL_HANDOFF` 字段语义与值域 | `ops/protocols/task-package-reference/field-dictionary.md` |
| route 设计方法、新增能力同步清单、route 文件结构规范 | `ops/protocols/task-package-reference/design-guide.md` |
| 能力提示词分层与章节结构 | `ops/protocols/subagent-capability-prompt-format.md` |
| 子代理材料分层 | `ops/protocols/subagent-material-layering.md` |
| 启动材料注入机制（MCP async） | `ops/protocols/subagent-information-injection.md` |
| 治理文件引用格式与文件头 | `ops/protocols/file-convention.md` |
| 仓库顶层目录归属 | `ops/protocols/repository-structure.md` |
| 业务能力地图路径、结构和验收 | `ops/protocols/business-map.md` |
| workflow 阶段状态机 | 各 workflow 的 `WORKFLOW.md` 及阶段文件 |
| workflow 阶段→能力映射 | planning：`ops/workflows/planning/agent-dispatch.md`；alignment：事实侦察、查轮子与成本挑战见 `ops/workflows/alignment/discovery.md` §1–§3，审查见 `ops/workflows/alignment/exit.md` §1 |
| planning 状态与 execute_gate 字段 | `ops/workflows/planning/planning-state.md` |
| alignment 状态字段 | `ops/workflows/alignment/state.md`（含义与写入入口；字段与闭集以 `alignment_recorder.py --schema` 为准） |
| 角色注册 | `ops/agents/<role>.toml`；文件名与根部 `name` 必须一致 |
| 模型选型意图与失败裁决 | `ops/policies/model-selection.md`；角色默认与候选运行投影在 `ops/agents/<role>.toml`，Prepared Envelope 不含回退字段 |
| route 覆盖目录 | `node ops/tools/dispatch_prepare.mjs --list`（生成，不人工维护） |

快照豁免：任务包内 `known_facts` 和来源引用属于派发时快照，不算双真源；新鲜度纠偏按 `ops/policies/state.md` §0.2。
