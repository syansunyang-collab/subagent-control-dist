# 三个锁定面

> 职责：规定标准规格三个面的锁定对象与完成条件。
> 真源：requirements、product_experience、execution 各自的锁定对象、合格标准与完成条件
> 读取：命中读取

## 1. 通用

| 面 | 锁定什么 | 提交阶段 |
| --- | --- | --- |
| `requirements` | 目标、痛点、成功口径、范围、不做、需求条目与验收意图 | `product` |
| `product_experience` | 用户怎么用、看到什么、怎样判断输出合格 | `product` |
| `execution` | 技术路线、落地、质量、验收合同、目录（五子节） | `solution` |

- 三个面恒为必锁；没有界面的任务照常锁 `product_experience`，`product_surface: not_needed`。
- preview 必填字段以 `python -B ops/tools/alignment_recorder.py --schema` 的 `surface_preview_required_fields` 与 `draft_item_fields.preview` 为准，接受规则见 `accepted_preview_rules`，错误码见 `issue_codes`。草案里的 preview 不写 `status` 与 `decision_source`，由 recorder 生成。
- 锁定条件：`still_open` 为空，用户在确认轮接受 preview。planner、executor 或 verify 仍需自行决定本面关键内容时，本面没写完。
- 同一面内的子节一次起草，子节间的输入依赖在草案里对齐。

## 2. requirements

锁定：目标、痛点、成功结果与成功口径、验收意图（必须证明什么、偏好的证据、不能冒充完成的证据）、本轮做与不做、需求条目。

需求条目写在 requirements preview 映射内部：`alignment_spec: [{spec_id, statement, acceptance, validation_object}]`，`statement` 为一句原子陈述，`acceptance` 为可观察的验收条件。preview 被接受时由 recorder 按 `spec_id` 合并进状态；用 `accept_revised` 提交修改后的 preview 时可带改过的条目，不带则沿用草案里的条目。S2 不带条目时，S5 生成 planner seed 会失败。合格条目同时满足：

- 面向结果，不把未确认的实现方案写成需求；
- 可验证：有命令、文件、报告字段，或 `ops/policies/test-tooling-governance.md` §4 定义的验收主体；
- 原子：一条只表达一个能力、规则或约束；
- 有边界，可追溯到用户确认或事实证据。

例：「给定 CAD 文件路径后，工具报告文件类型、可用读取方式和缺失依赖」，验收为报告含这三项，`validation_object: cad_intake_report`。

完成：成功口径、验收意图、不做事项（没有时写明原因）非空；每条 `alignment_spec` 有 `validation_object`。

## 3. product_experience

| `product_surface` | 适用 |
| --- | --- |
| `cli` | 命令行工具 |
| `web` | 浏览器界面 |
| `desktop` | 桌面图形界面 |
| `api` | 供程序调用的接口 |
| `report` | 报告或文档产物 |
| `workflow` | 自动化流程 |
| `agent` | 代理或提示词产物 |
| `not_needed` | 无用户可感知的产品面，写明理由 |

用户提到「图形界面」时按交付形态记 `web` 或 `desktop`。

锁定：主要使用者与场景、核心动作、入口、主路径（用户动作 → 系统响应 → 可见结果）、输出合同（格式、位置、信息顺序、消费方）、可见状态（运行中、空、错误、成功）、已约定放行或需要领域判断的确认点。

`web`、`desktop` 与交互式报告另锁两份契约，`web`、`desktop` 由 guard 校验非空：

- `surface_contract`：区域与用途、数据旅程、对比或趋势视图（轴、分组）、原因指标与阈值来源；锁到执行者无需自行发明布局、图表和交互。
- `ui_design_contract`：设计系统（组件库、图标、字体）、视觉规则（密度、间距、颜色、字号层级）、文案语气与必需的可见状态、响应式与溢出规则、第三方组件块及其审查证据。

已有设计系统时先读样式配置、组件目录或既有页面；没有时记 `project_default` 并列出最低视觉约定。选组件库会改变依赖、运行方式、目录或验证命令时，按 S3 的 `tech_route` 决策处理。契约写到区域、数据、指标和用户如何判断：「输出趋势图」要写出横轴、纵轴、分组与阈值来源。

完成：错误与成功状态非空；需要契约时，执行者无需自行发明设计系统、组件、布局、图表、交互或文案状态。

## 4. execution

`sections` 含五个子节：`tech` 与 `validation` 必写，其余不涉及时写 `not_needed: <理由>`。

### 4.1 tech

锁选定路线、有选择价值的候选与取舍理由、置信度，以及：

- `wheel`：查轮子报告引用，或 `not_needed: <理由>`（`ops/workflows/alignment/discovery.md` §2）；
- `user_constraints_ref`：S1 采访中坑点与约束的确认引用，由 recorder 填写。

关键风险转入 validation 或 quality，或由用户明确接受。

### 4.2 landing

锁运行面（windows / wsl2 / mixed / remote / container）、工作与源码目录、依赖范围、权限边界、回滚方式，以及对执行任务包读、写、删范围的影响。涉及本机执行时附 `runtime-env-scan` 证据；涉及联网或服务暴露时附 `network-readiness-scan` 证据。

### 4.3 quality

锁适用的质量预算（耗时、可靠性、资源、费用、兼容）、信任边界（破坏性动作、密钥、外发、数据留存）、失败处置（失败即停条件、回滚方式、失败时保留的证据）、日志与诊断入口、维护归属。

### 4.4 validation

本子节承担验收合同：把 requirements 的成功口径转成可运行、可截图、可审查或可确认的验收，不另立口径。`alignment_spec[].validation_object` 由 planning 派生 Acceptance Contract 验收项时消费。

锁：每条规格的 `validation_object`、smoke、功能验收、已约定放行或需要领域判断的确认点、失败即停条件与允许的降级、证据形式与落点、验收环境 `verify_env`（运行时、驱动、fixture、准备方）。将报告交付给用户；把必须在真实入口或特定运行状态下取证这类任务特定要求写进验收对象的通过依据与证据要求，供合同的 `oracle` / `evidence_requirements` 消费。

合格验收项可观察、可失败、能转成任务包的成功条件，覆盖每条规格与用户可见的主路径、输出和真实使用中的错误状态，能追到成功口径。按真实动作与约定结果确定场景，共享同一次实跑证据，结果不同时补充场景。另需：

- 数字硬门（时限、吞吐、资源）同时锁测量协议：样本数、冷热定义、取值口径（中位、p95 或全样本）、是否独占测量。
- 用户逐项点名的清单（列、字段、入口、菜单项）按原文以闭集写入，验收逐项核对实际对象与约定结果。
- 验收要起服务、驱动浏览器或用 fixture 时，`verify_env.provision` 指定准备方，环境在验收前装好；生成合同时，将必要环境集中写入 `entry_conditions`，作为执行前提。

### 4.5 structure

按 `ops/protocols/repository-structure.md` §9 准入规则直接确定，不问用户：启用的顶层目录及其职责与提交策略、模块布局，数据、输出、测试、外部源码与临时产物的落点，新建目录计划（父目录进入 `scope.write`），是否更新 `PROJECT.md`。影响架构的模块拆分是 `design_point` 决策；规范留有选择时按默认项记录门槛处理。
