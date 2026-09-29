# 切片编译流程

> 职责：把舰队任务从 goal 稳定编译成一组切片（每片一个可独立回答的问题 + read_scope_layers + route + write_scope），给出拒绝条件。
> 真源：本文件承载切片编译决策树与产能规格；角色与模型档的运行投影以 `dispatch_prepare` list/template 为准；seed 构包、批量冲突检查与提交真源是 `ops/tools/dispatch_prepare.mjs`。
> 读取：命中读取

## 目录

- 机制前提与放量判据
- 切片编译：五步管线（Step 0–4）
- 每片四元组的确定填法
- 拒绝条件（自查 BLOCK IF）
- 单发产能规格
- 角色分档

## 机制前提与放量判据

经 `dispatch_prepare.mjs` 进入 AsyncTaskService 的任务是独立后台进程，互不占会话线程池。放量约束是单发产能上界（见下）、并发写集两两不相交、模型额度按角色分档控制，以及所选 route/model/派发通道当前可用。运行时不可用的切片保持 pending，恢复后补位；它不构成拓扑串行理由。

WHEN: 任务可拆出两个以上切片。
MUST: 先按下面五步管线编译出全部切片；再按 `ops/skills/subagent-fleet-discipline/references/fleet-dag-import-test-playbook.md`「入场边界」选择 seed JSON 数组或 Fleet Manifest。

保持串行的仅三类：切片间有真实依赖（下游消费上游产物，走波次轴）；共享写文件无法拆开（收敛给单一批次或主代理）；任务判断量集中不可拆（拆了每片都要完整上下文）。

## 切片编译：五步管线

不是"按文件簇切还是按维度切"的分类学——分类不产出切片。按下面五步从 goal 走到完整切片集。

### Step 0：把 goal 归一为问题集

把 goal 改写成一个总问题，列出回答它必须查清的子问题。逐个子问题判定：

- 判定问题：这个子问题能否让一个冷上下文子代理**单独**回答，而不需要另一个子问题的结论？
- 能 → 它是一片候选。
- 不能（要消费另一子问题的产物）→ 标记为下一波，依赖写进 `depends_on`。

产出：本波子问题清单 + 下波子问题清单。

### Step 1：选分解轴（决定切片如何铺开）

对本波子问题集，按下表一次定轴，不混轴：

| 判定问题：这批子问题主要沿什么分布？ | 轴 | 确定动作 |
| --- | --- | --- |
| 待改写 / 清扫 / 迁移，有明确写集 | 文件簇轴 | 列全部写文件，按目录或职责聚簇，一簇一片；多簇都要动的契约层 / 状态层 / 地图层抽出转 `serial_work` |
| 只读审查 / 审计 / 调研，各写各的报告 | 判断维度轴 | 一个维度一片，每片恰好一个可独立回答的问题；写集天然不相交 |
| 有依赖链，下游消费上游产物 | 波次轴 | 同波节点进入同一 DAG 层；下游声明 `depends_on` 和 `dependency_artifacts`，普通执行链等待成功，归并链按 reducer 规格消费全部终态 |
| 上面命中多条 | 先波次再簇/维度 | 先按波次分层，每层内再按文件簇或判断维度分 |

### Step 2：每片定四元组

对每一片，填死 `question / route / read_scope_layers / write_scope`（跨仓再加 `target_isolation`）。确定填法见下一节。

### Step 3：reducer 判定

- 判定问题：本波 explorer / 审查类切片是否 ≥3？
- 是 → 必须加一个 reducer 节点（第二波，`depends_on` 本波全部 explorer 片），依赖策略和输入合同见 `ops/skills/subagent-fleet-discipline/references/reducer-wave.md`。
- 否 → 主代理直接收割各片报告，不需 reducer。

### Step 4：拒绝条件自查

逐条过下面拒绝条件（下一节）。命中任一 → 回到对应 Step 重切，不带病批发。

产出：完整 FLEET_PLAN（`FLEET_PLAN` schema 见 `ops/skills/subagent-fleet-discipline/SKILL.md`，含每片四元组与 reducer 段）。

## 每片四元组的确定填法

### question

恰好一个可独立回答的问题。含"和 / 与 / 以及 / 同时 / and also"等连接词即为多问，拆开。

### route

按判断量 × 影响面 × 可验证性逐片选择角色，角色即档位（见"角色分档"）。

### read_scope_layers

四层填死，不留"酌情"：

| 层 | 放什么 | 子代理动作 |
| --- | --- | --- |
| `entry` | 该片必读全文的入口文件（数个具体文件） | 必读全文 |
| `index` | 只需列目录 / 清单不读内容的目录 | 只列不读 |
| `deep` | 命中特定条件才深入的目录，每项写 `{path, when}` | 仅命中 `when` 才深入 |
| `deferred` | 运行态 / 产物 / 依赖大目录（`runs/`、`outputs/`、`.runtime/`、`node_modules/`、`.venv/`、`dist/`） | 默认禁读，读前在报告说明理由 |

`scope_preflight` 只统计 `entry`+`index` 字节。旧 `read_scope` 兼容保留，等价全部落 `entry`。

### write_scope 与 target_isolation

- 同仓：`write_scope` 是该片唯一允许写入面，并发片按此判冲突。
- 跨仓只读扫描（read_scope 含控制仓外绝对路径）：`target_isolation=read_only`，`write_scope` 每项落 `notes/**` 或 `tmp/**`，`artifact_write_scope` 列允许的报告前缀。外仓物理只读由 codex sandbox 保证，字段是校验与任务书纪律层。

### contract-drift 的 target files 与 evidence roots

`semantic-review-agent__contract-drift-inspection` 的 `target_files` 只列标识符枚举对象，不代表完整读授权。把声明侧 target files 放 `entry`；把允许 grep、`--help` 或打开消费侧实现的目录放 `index/deep`，并同时列入 `scope.read`；把历史报告、运行态、依赖目录放 `deferred`。

缺少回答本片问题所需的 evidence root 时，先补构包或缩窄问题。不要让子代理为了完成消费侧取证越出 `scope.read`。

## 拒绝条件（自查 BLOCK IF）

| 命中 | 回到 |
| --- | --- |
| 一片多问（`question` 含多问连接词） | Step 2，拆成多片 |
| 大目录裸塞 `entry` 无分层 | Step 2，移入 `index` 或 `deferred` |
| explorer / 审查类 ≥3 片无 reducer | Step 3，加 reducer 节点，或路数降到 <3 |
| 全部片同一高档 route | Step 2，按分档表逐片重选 |
| 两并发片 `write_scope` 交集非空 | Step 1，共享文件转 `serial_work` |

## 单发产能规格

单发判定质量随任务面扩大而坍塌，超规格的单发被模型以抽样、略读绕过，回执看起来完整、覆盖是假的。

| 任务类型 | 单发上界 | 依据 |
| --- | --- | --- |
| 契约核对、语义审查 | 按独立审查问题切片；同一问题的目标文件完整保留，材料按注入协议承载 | `ops/protocols/subagent-information-injection.md` §3 |
| 机械改写、格式清扫 | 6–8 文件，验收必须可机械复跑 | 机械验证兜底，错了能被命令抓住 |
| 调研、检索、只读扫描 | 按问题切不按文件切，一片一个可独立回答的问题 | 问题混发导致回执各问题都浅 |
| 有界实施 | 一片一个有界目标，禁止合并多个独立目标 | route 卡 goal 字段口径 |

按独立目标拆小切片，不把多个问题塞进同一任务。语义审查材料大小的处理方式以注入协议为准，不改变问题边界。

## 角色分档

派发必须显式选角色，角色即档位；严禁所有切片无脑用同一高档角色。看判断量 × 影响面 × 可验证性，不看体量：

| 档 | 角色 | 工况 |
| --- | --- | --- |
| 机械档 | `batch-agent` | 需要跨文件批处理且可机械验收的操作；alignment 状态渲染直接调用 `alignment_recorder.py`，不派子代理 |
| 扫描档 | `explorer-agent`、`semantic-review-agent` | 只读扫描与语义审查：取证、分类、契约核对（纯文本，不看图） |
| 主力档 | `general-agent`、`docs-agent`、`research-agent` | 常规工程判断：按清晰规格改写、起草文档、外部调研、报告归并 |
| 收口档 | `executor-agent`、`verify-agent`、`plan-checker`、`planner-agent` | 高判断、高风险、收口：实施、最终验证、对抗审计、规划 |

升降档判据：输出能被编译、自测、grep-diff 机械验证的往下压一档；错了难发现、修起来贵的往上提一档。语义改写、契约设计、互锁多文件手术不为省额度降档。实际模型与推理档以 list/template 投影为准，seed 不写模型名。
