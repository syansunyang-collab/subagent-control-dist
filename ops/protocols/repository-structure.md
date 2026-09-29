# repository-structure.md

> 职责：规定目录归属和新目录准入。
> 真源：目录归属、新目录准入和任务包路径写入规则
> 读取：命中读取

目录职责协议。`PROJECT.md` 记录当前项目已经启用的目录；本文件记录可复用的目录判定规则。新增顶层目录、创建模块、编写任务包时，先按本文确定资产归属。

## 1. 分层原则

| 层级 | 路径 | 职责 |
| --- | --- | --- |
| 真源入口 | `AGENTS.md` / `PROJECT.md` / `STATUS.md` / `ROADMAP.md` | 执行入口、项目事实、当前状态、里程碑 |
| cockpit | `ops/` | Codex 规则、配置、hook 实现和自用维护工具 |
| 运行热区 | `.runtime/` | preload 票据和本地临时运行残留 |
| 计划产物 | `.planning/` | planning workflow 生成的 PLAN、SUMMARY 和阶段计划产物 |
| 运行证据 | `notes/` | 子代理报告、上下文、调度清单、交接、异常复盘、状态历史 |
| 设计推导 | `design/` | 需求、方案、权衡、草案、图和参考 |
| 业务地图 | `map/` | 业务能力地图、业务入口索引和能力关系 |
| 正式文档 | `docs/` | 已确认、可长期阅读和执行的文档 |
| 源码模块 | `src/` | 本项目源码和模块边界 |
| 验证 | `tests/` / `test-baselines/` / `test-results/` | 测试代码、测试基线、测试运行结果 |
| 数据与输出 | `data/` / `outputs/` / `artifacts/` | 输入数据、最终输出、工程产物和模板产物 |
| 运维与工具 | `configs/` / `scripts/` / `tools/` / `deploy/` | 配置样例、脚本、项目级工具、部署入口 |
| 外部与临时 | `refs/` / `repos/` / `sandbox/` / `tmp/` | 外部参考、源码镜像、实验和临时文件 |

## 2. 顶层目录职责

| 路径 | 放置内容 | 默认提交策略 | 禁止内容 |
| --- | --- | --- | --- |
| `AGENTS.md` | 主代理入口规则、路由、硬门禁 | 提交 | 长篇项目背景、子代理提示词全文 |
| `PROJECT.md` | 项目身份、工程边界、已启用目录 | 提交 | 临时状态、执行日志 |
| `STATUS.md` | 当前阶段、上次动作、下一步、阻塞 | 提交 | 长历史、完整报告 |
| `ROADMAP.md` | 里程碑、wave、验收依据 | 提交 | 日常流水 |
| `.planning/` | `phases/<phase>/` 下的 PLAN、SUMMARY 和计划修订 | 里程碑引用或执行依据时提交 | 运行证据、handoff、正式文档、源码 |
| `ops/` | agent、prompt、protocol、policy、workflow、skill、task-card、hook 注册与实现、Codex 自用维护工具 | 提交 | 业务源码、密钥、运行缓存、运行账本、临时生成物、模板产物 |
| `.runtime/` | preload 票据和本地临时运行残留 | 不提交 | 长期规则、模板产物、正式文档、业务源码、密钥 |
| `notes/` | `context/`、`manifests/`、`research/`、`explorer/`、`verify/`、`handoffs/`、`general/`、`batch/`、`incidents/` | 选择性提交 | 源码副本、依赖缓存、生产数据、正式文档、设计草案 |
| `map/` | `business-capability-map.md`、业务能力入口索引和能力关系 | 提交 | Codex 编排地图、临时扫描报告、未确认报告全文 |
| `docs/` | 架构、决策、运维、使用、依赖、迁移、审查文档 | 提交 | 子代理中间报告、未验证草案 |
| `design/` | 需求、候选方案、权衡、图、接口草案、参考 | 提交 | 已接受决策的替代真源 |
| `src/` | 本项目源码、模块实现、模块近场说明 | 提交 | 测试运行产物、调研报告 |
| `tests/` | 单元、集成、端到端、性能、回归测试代码 | 提交 | 测试运行输出 |
| `test-baselines/` | golden、snapshot、benchmark 基线 | 选择性提交 | 每次运行日志 |
| `test-results/` | 每次测试运行结果、`INDEX.md`、`TEST-RUN-TEMPLATE.md` | 默认只提交索引和模板 | 源码、长期文档、长期脚本资产 |
| `data/` | 原始数据、样例数据、合成数据、处理后数据 | 默认只提交脱敏小样例和索引 | 密钥、客户真实敏感数据、大文件 |
| `outputs/` | 最终报告、导出文件、交付物 | 选择性提交 | 缓存、测试运行输出 |
| `artifacts/` | 构建包、发布包、工程中间产物和 `artifacts/templates/` 模板产物 | 默认不提交大产物；模板源选择性提交 | 源码真源、敏感数据、运行账本 |
| `configs/` | 可提交配置样例、非密钥默认值 | 提交 | `.env`、token、私钥 |
| `scripts/` | 可复用检查、安装、维护、导出脚本 | 提交 | 一次性命令流水、语义审查替代品 |
| `tools/` | 项目级工具 | 选择性提交 | Codex 自用维护工具、未授权二进制、大依赖缓存 |
| `deploy/` | Docker、systemd、nginx、k8s 等部署入口 | 提交 | 生产密钥、机器专属配置 |
| `diagnostics/` | profile、trace、dump、排障证据索引 | 默认不提交大产物 | 密钥日志、未脱敏数据 |
| `logs/` | 本地日志、运行日志 | 默认不提交 | 密钥日志、生产日志原文 |
| `examples/` | 最小示例、完整流程、期望输出 | 提交 | 生产数据 |
| `sandbox/` | 可删除实验、小型试跑 | 默认不提交 | 长期真源 |
| `refs/` | 用户提供材料、PDF、截图、第三方参考 | 默认不提交 | 需要执行的源码真源、密钥 |
| `repos/` | clone 下来的外部源码镜像 | 默认不提交 | 本项目源码 |
| `tmp/` | 临时文件 | 不提交 | 任何需要追溯的证据 |

## 2.1 `ops/` 内部分层

`ops/` 内部分层归 `ops/protocols/cockpit-layering.md`。本文件只判断顶层目录归属和新目录准入，不复制 `ops/` 内部职责表。

## 3. `notes/` 颗粒度

`notes/` 是运行态证据层。它保存当前任务或近期任务产生的上下文、扫描、调研、审查、handoff、运行清单、异常复盘和状态归档。

`notes/` 不保存正式规则、正式文档、设计推导、源码副本、依赖缓存、生产数据或测试运行大产物。

| 路径 | 职责 |
| --- | --- |
| `notes/context/` | alignment 上下文、决策简报、当前任务上下文 |
| `notes/manifests/` | wave、并发派发和跨代理运行清单 |
| `notes/research/` | research-agent 调研报告 |
| `notes/explorer/` | explorer-agent 本地代码、环境、网络扫描报告和运行态地形图 |
| `notes/verify/` | verify-agent 和 plan-checker 审查报告 |
| `notes/handoffs/` | 子代理 `FINAL_HANDOFF`、progress 和轻量状态小文件 |
| `notes/general/` | general-agent 兜底报告 |
| `notes/batch/` | batch-agent 机械处理报告 |
| `notes/incidents/` | 接管、重派失败、越界、连续漂移和权限失败复盘 |
| `notes/archive/` | 历史记录按批次归档，保留原相对目录结构 |
| `notes/notes_all.md` | 高价值闭环记忆和反复失败原因 |

命名规则：

- 报告使用 `<对象>-<产物类型>-<YYYYMMDD>[-rN|-partN].md`。
- 大 scope 地形图使用 `notes/explorer/<对象>-terrain-map-<YYYYMMDD>.md`。
- wave 清单使用 `notes/manifests/<phase>-wave-<N>-dispatch.yaml`。
- handoff 使用 `notes/handoffs/<package_id>.md`。
- progress 使用 `notes/handoffs/<package_id>.progress.yaml`。
- 当前 alignment 上下文使用 `notes/context/<task>-alignment.md`。

落盘裁决：

- 运行证据进入 `notes/`。
- 设计推导进入 `design/`。
- 业务能力地图进入 `map/`，具体入口和规则见 `ops/protocols/business-map.md`。
- 已确认长期说明进入 `docs/`。
- 已确认的长期代码地图进入 `docs/modules/` 或 `docs/architecture/`。
- 测试运行输出进入 `test-results/`。
- 用户可消费交付物进入 `outputs/`。

## 4. `docs/` 颗粒度

`docs/` 只放已经确认、面向人长期阅读的内容。设计过程、候选方案和未验证假设进入 `design/`。

explorer-agent 产出的地形图先进入 `notes/explorer/`。主代理消费并确认稳定后，长期代码地图才进入 `docs/modules/` 或 `docs/architecture/`；正式文档写入按 `docs-agent / documentation-authoring` 执行。

| 路径 | 职责 |
| --- | --- |
| `docs/architecture/` | 架构、系统边界、组件关系 |
| `docs/decisions/` 或 `docs/adr/` | 已接受决策；旧决策改为 superseded，不原地改成新含义 |
| `docs/modules/` | 跨模块视角的模块索引、代码地图和关系说明 |
| `docs/operations/` | 安装、运行、维护、排障手册 |
| `docs/usage/` | 用户使用说明 |
| `docs/dependencies/` | 依赖、许可、版本约束 |
| `docs/migrations/` | 路线变化、迁移记录 |
| `docs/review/` | 发布清单、风险清单、审查清单 |
| `docs/archive/` | 过期但需要留痕的文档 |

## 5. `design/` 颗粒度

| 路径 | 职责 |
| --- | --- |
| `design/requirements/` | 需求拆解、约束、用户场景 |
| `design/proposals/` | 候选方案、活跃方案、废弃方案 |
| `design/tradeoffs/` | 对比矩阵、取舍说明 |
| `design/diagrams/` | 架构图、流程图、数据流图源码 |
| `design/specs/` | 接口、协议、状态机、数据模型草案 |
| `design/reviews/` | 设计审查记录 |
| `design/references/` | 官方资料、论坛材料、论文、源码阅读笔记 |
| `design/glossary.md` | 项目术语表 |

设计文件可以推动对齐和决策，但不能直接替代 `docs/decisions/`、`STATUS.md` 或 `ROADMAP.md`。

## 6. 模块目录

多模块项目启用以下结构：

```text
src/modules/<module>/
├── MODULE.md
├── public_api.md
├── src/
└── tests/unit/
```

模块规则：

- `MODULE.md` 写模块职责、边界、状态和依赖。
- `public_api.md` 写外部可依赖接口。
- `src/modules/<module>/src/` 放模块内部实现。
- `src/modules/<module>/tests/unit/` 放模块近场单测。
- 跨模块依赖只能依赖 `public_api.md` 中声明的接口。
- 跨模块测试放 `tests/integration/`、`tests/e2e/` 或 `tests/regression/`。
- 模块测试基线放 `test-baselines/<scope>/<module>/`。
- 模块测试运行输出放 `test-results/<scope>/<module>/runs/<run_id>/`。
- 跨模块长期说明放 `docs/modules/`，不放进单个模块内部。

## 7. 数据、输出和产物

| 路径 | 放置内容 | 提交边界 |
| --- | --- | --- |
| `data/raw/` | 原始输入数据 | 默认不提交 |
| `data/samples/` | 脱敏小样例 | 可提交 |
| `data/synthetic/` | 合成数据 | 小规模可提交 |
| `data/processed/` | 处理后的中间数据 | 默认不提交 |
| `outputs/reports/` | 最终报告 | 选择性提交 |
| `outputs/exports/` | 导出文件、表格、文档、图片 | 选择性提交 |
| `outputs/deliverables/` | 明确交付给用户或下游的结果 | 选择性提交 |
| `outputs/temp/` | 输出过程临时文件 | 不提交 |
| `artifacts/builds/` | 构建产物 | 默认不提交 |
| `artifacts/releases/` | 发布包索引和小型元数据 | 选择性提交 |
| `artifacts/reports/` | 工程产物报告 | 选择性提交 |
| `artifacts/templates/` | 可复制到新工程的模板产物源 | 选择性提交 |
| `artifacts/temp/` | 临时工程产物 | 不提交 |

敏感数据、密钥、客户真实数据和无法公开的大文件不得进入可提交路径。必须保留证据时，先脱敏并写清来源、时间、采样范围和限制。

## 8. 测试分层

| 路径 | 职责 |
| --- | --- |
| `tests/unit/` | 跨模块单元测试入口 |
| `tests/integration/` | 集成测试 |
| `tests/e2e/` | 端到端测试 |
| `tests/performance/` | 性能测试 |
| `tests/regression/` | 回归测试 |
| `tests/fixtures/` | 小型测试夹具 |
| `test-baselines/` | golden、snapshot、benchmark |
| `test-results/INDEX.md` | 最新测试结果索引 |
| `test-results/<scope>/<module>/runs/<run_id>/` | 单次运行输出 |

测试代码、测试基线和测试运行输出必须分离。完成验证时，报告中写命令、结果路径、是否满足验收和残留风险。

测试、工具和脚本资产的准入、提升和主体明确验收规则见 `ops/policies/test-tooling-governance.md`。`test-results/` 中的单次运行证据不能自动提升为 `tests/`、`test-baselines/`、`ops/tools/` 或 `scripts/` 的长期资产。

## 9. 新目录准入

新增目录前必须完成以下判断：

1. 该目录属于哪个层级。
2. 是否已有标准目录可以承载。
3. 是否需要长期提交。
4. 是否会成为新的真源入口。
5. 是否需要同步更新 `PROJECT.md` 的目录约定。

准入规则：

- 稳定源码进入 `src/` 或 `src/modules/<module>/`。
- 稳定测试进入 `tests/`。
- 测试基线进入 `test-baselines/`。
- 测试输出进入 `test-results/`。
- 输入数据进入 `data/`。
- 用户可消费的最终输出进入 `outputs/`。
- 构建和发布产物进入 `artifacts/`。
- PLAN、SUMMARY 和计划修订进入 `.planning/phases/<phase>/`。
- 调研、扫描、验证、handoff、wave 清单和异常复盘进入 `notes/`。
- 设计推导进入 `design/`。
- 业务能力地图进入 `map/`。
- 已确认文档进入 `docs/`。
- 外部参考进入 `refs/`。
- 外部源码镜像进入 `repos/`。
- 临时实验进入 `sandbox/` 或 `tmp/`。

稳定顶层目录一旦启用，必须更新 `PROJECT.md`。临时目录未更新 `PROJECT.md` 时，任务包必须说明临时边界和清理方式。

## 9.1 alignment 接口

对齐阶段需要决定工程骨架时，按 §9 准入规则直接确定目录，写入 `ops/workflows/alignment/surfaces.md` §4 的 `execution.sections.structure`，不经用户确认。

进入 planner 或 executor 前，`structure` 至少回答：

1. 哪些顶层目录稳定启用。
2. PLAN 产物是否使用 `.planning/phases/<phase>/`，以及 phase 名称。
3. 每个启用目录的职责和提交策略。
4. 源码、测试、数据、输出、构建产物、外部源码镜像和临时实验分别放在哪里。
5. 新目录创建时，父目录是否进入 `task_package.scope.write`。
6. 是否需要同步更新 `PROJECT.md` 的目录约定。

缺少上述任一项时，不得让 planner 或 executor 自行决定目录归属。

## 10. 任务包路径要求

子代理或 executor 需要创建目录时，`task_package.scope.write` 必须同时列出父目录和目标目录或文件。

示例：

```yaml
scope:
  write:
    - data/
    - data/samples/
    - data/samples/sample-index.md
```

禁止写法：

```yaml
scope:
  write:
    - data/samples/sample-index.md
```

如果目标目录是新的顶层目录，任务包必须写明：

- 创建原因。
- 所属层级。
- 提交策略。
- 是否同步更新 `PROJECT.md`。

planner 生成 PLAN 时，`task_package.scope.write` 必须列出 `.planning/`、`.planning/phases/`、`.planning/phases/<phase>/` 和目标 PLAN 文件。plan-checker 或 executor 只读取 PLAN 时，把对应 PLAN 文件放入 `scope.read`。
