# 子代理能力索引

> 职责：登记子代理能力索引。
> 真源：子代理能力索引
> 读取：维护读取

本文件只记录能力索引，用于核对 `task_package.agent.capability.name` 和 `task_package.agent.capability.file`。主代理日常从 `dispatch_prepare(action=list)` 读取 route 与适用摘要。

子代理运行材料的完整构成由 `ops/protocols/subagent-information-injection.md §2` 维护；本索引只登记能力名与文件。

模型、effort 和候选池不在本索引维护；`dispatch_prepare(action=list)` 从 `ops/agents/<role>.toml` 动态投影当前角色画像。

## 当前能力表

| agent.role | capability.name | capability.file | 用途摘要 |
| --- | --- | --- | --- |
| `planner-agent` | `plan-authoring` | `ops/agent-prompts/planner-agent/plan-authoring.md` | 已审核规格进入 planning，需要生成 topology、slice fragment 或 dispatch_manifest |
| `planner-agent` | `acceptance-authoring` | `ops/agent-prompts/planner-agent/acceptance-authoring.md` | 已锁定规格进入 planning，与 implementation topology 并行生成 Acceptance Contract |
| `executor-agent` | `plan-execution` | `ops/agent-prompts/executor-agent/plan-execution.md` | dispatch_manifest lane 已存在，需要实施 lane 改动并写 SUMMARY / handoff |
| `executor-agent` | `scoped-execution` | `ops/agent-prompts/executor-agent/scoped-execution.md` | 无 PLAN，但用户已明确给出路径、动作和边界；只执行一个有界操作 |
| `research-agent` | `external-research` | `ops/agent-prompts/research-agent/external-research.md` | 外部事实、版本、官方文档、issue、论坛、阻塞外部参考 |
| `research-agent` | `document-scan` | `ops/agent-prompts/research-agent/document-scan.md` | 本地 PDF、扫描件、图片、图表、Office 文档的提取、读图与表格转录（需视觉模型） |
| `research-agent` | `wheel-discovery` | `ops/agent-prompts/research-agent/wheel-discovery.md` | 新写工具、模块或组件前的现成方案固定对比表，「自己写」为基线一行；不安装、不运行候选 |
| `docs-agent` | `documentation-authoring` | `ops/agent-prompts/docs-agent/documentation-authoring.md` | 已确认设计结论、运行证据、规则变更或操作流程沉淀为 `docs/` 长期正式文档 |
| `explorer-agent` | `codebase-scan` | `ops/agent-prompts/explorer-agent/codebase-scan.md` | 本地结构、引用关系、依赖追踪、阻塞根因周边扫描 |
| `explorer-agent` | `runtime-env-scan` | `ops/agent-prompts/explorer-agent/runtime-env-scan.md` | 本机软件、工具链、PATH、WSL、依赖入口和版本可用性扫描 |
| `explorer-agent` | `network-readiness-scan` | `ops/agent-prompts/explorer-agent/network-readiness-scan.md` | 只读网络、代理、DNS、端口可达和监听风险核验 |
| `verify-agent` | `ui-interaction-inspection` | `ops/agent-prompts/verify-agent/ui-interaction-inspection.md` | UI 交互、视觉合约、界面状态和真实操作路径验收 |
| `verify-agent` | `acceptance-synthesis` | `ops/agent-prompts/verify-agent/acceptance-synthesis.md` | 归并 Acceptance Contract 多维验收结果，输出可机械消费的 pass、rework 或 needs_owner disposition |
| `verify-agent` | `functional-inspection` | `ops/agent-prompts/verify-agent/functional-inspection.md` | 用户可见功能和真实产物体验验收 |
| `verify-agent` | `prompt-bloat-inspection` | `ops/agent-prompts/verify-agent/prompt-bloat-inspection.md` | AGENTS、workflow、policy、protocol、agent-prompt 的膨胀、重复规则和上下文注入审查 |
| `verify-agent` | `anti-defensive-inspection` | `ops/agent-prompts/verify-agent/anti-defensive-inspection.md` | 代码、说明、注释和提示词中的防御性兜法审查 |
| `semantic-review-agent` | `rule-quality-inspection` | `ops/agent-prompts/semantic-review-agent/rule-quality-inspection.md` | workflow、route、policy、protocol、agent-prompt 和调度规则的规则质量语义扫描 |
| `semantic-review-agent` | `contract-drift-inspection` | `ops/agent-prompts/semantic-review-agent/contract-drift-inspection.md` | 控制面改动的跨文件契约一致性：字段/值域/机制声明与消费两侧核对、退场残留清扫、工具接口实跑核对 |
| `verify-agent` | `code-verification` | `ops/agent-prompts/verify-agent/code-verification.md` | 代码、运行配置、测试配置、构建配置、依赖配置、测试入口和测试证据验证 |
| `plan-checker` | `plan-review` | `ops/agent-prompts/plan-checker/plan-review.md` | 用户明确点名时临时审查 dispatch_manifest；独立于 planning workflow |
| `plan-checker` | `requirement-granularity-review` | `ops/agent-prompts/plan-checker/requirement-granularity-review.md` | 标准规格 S4 的 all_surfaces 审查：requirements、product_experience、execution 三面与跨面的需求颗粒度、一致性和验收样例（每对象至多两轮；不审来源可追溯） |
| `plan-checker` | `proposal-challenge-review` | `ops/agent-prompts/plan-checker/proposal-challenge-review.md` | `execution` 面方案拍板前、用户看到之前，对 wheel-discovery 对比表与推荐方案的成本挑战（至多两轮）：替代路线对比、证据复核、需 owner 拍的价值取舍 |
| `batch-agent` | `mechanical-batch` | `ops/agent-prompts/batch-agent/mechanical-batch.md` | 文件清单可枚举、单一操作族、规则明确的机械批处理 |
| `general-agent` | `general-default` | `ops/agent-prompts/general-agent/general-default.md` | 专职职责均不命中时处理有界杂项、资料整合，或承担无专职能力覆盖的独立验证 |
