# Task Package Design Guide

> 职责：规定任务包和派发规范设计方法。
> 真源：任务包、派发规范和能力对齐设计规则
> 读取：维护读取

本文件是任务包和专用派发规范的设计参考。它只在维护、扩展或修复派发协议时读取，不是主代理日常派发入口。

日常派发入口先由主代理高频路由规则命中 `ops/protocols/task-package-routes/<role>__<capability>.md`。主代理读取单个 route 后，必须能直接构造完整 `package_seed`，再通过 `ops/tools/dispatch_prepare.mjs` 派发对应子代理。

## 1. 读取场景

只在以下场景读取本文件：

- 新增子代理、能力提示词或 route 文件。
- 修订已有 route，使它和能力提示词严格一致。
- 任务包字段、回执字段或能力专属槽位需要新增、改名或废弃。
- route、能力提示词、字段词典、policy 或 workflow 出现规则冲突，需要判断归属。
- 需要把一次临时任务沉淀成可维护的专用派发规范。

不得在以下场景读取本文件：

- 主代理已经命中现有 route，准备派发子代理。
- 子代理运行中。
- 主代理为了补齐一个不自足 route 的上下文。
- 回执消费时替代命中 route 或主代理回执消费入口。

## 2. 产物分层

| 层 | 产物 | 职责 |
| --- | --- | --- |
| 主代理高频路由入口 | 任务对象到 route 的触发规则 | 写“遇到 AA，必须使用 AAAA，具体派发规则见 AAAAA”。 |
| 专用派发规范 | `ops/protocols/task-package-routes/<role>__<capability>.md` | 主代理日常构包唯一直接依据。 |
| 字段词典 | `ops/protocols/task-package-reference/field-dictionary.md` | 维护 `task_package` 与 `FINAL_HANDOFF` 字段含义和值域。 |
| 能力提示词 | `ops/agent-prompts/<role>/<capability>.md` | 子代理收到任务包后如何执行、拒收和输出。 |
| 主代理回执消费入口 | 目标达成和实例关闭规则 | 主代理判断目标是否达成、吸收结果、补充、重拆和关闭实例。 |

`task-package-routes/` 是运行期构包入口。`task-package-reference/` 是设计期备查资料。二者不能互相替代。

## 3. 新建 route 的步骤

1. 确认触发条件。
   - 写成可判定的“遇到 AA”。
   - AA 必须是主代理在当前上下文可观察的条件，不得依赖子代理读完材料后再判断。

2. 确认目标子代理和能力。
   - 写明 `role / capability`。
   - 在 `构包规则` 段写入唯一的 `task_package_agent` 固定包头。
   - 固定包头中的 `role`、`runtime_role`、`capability.name`、`capability.file` 和 `required_files` 必须能从 route 文件名 `<role>__<capability>.md` 机械推导。
   - `agent.required_files` 只放 `ops/agent-prompts/_common.md` 和该能力提示词。

3. 从能力提示词反推任务包。
   - 能力提示词要求的输入，必须在 route 的构包规则中给出路径、字段或授权。
   - 能力提示词的业务 verdict，必须在 route 的回执接收中映射到 `FINAL_HANDOFF.verdict`。

4. 填写通用任务包字段。
   - 主代理日常派发规则规定主代理只调用 `dispatch_prepare.mjs`，route 只负责让主代理填出完整 `package_seed`。
   - route 不重复全量通用机械字段，只写本能力需要的通用字段取值、scope / output / handoff 差异和拒收条件。
   - route 不得要求主代理再读取字段词典才能构包。

5. 定义能力专属槽位。
   - 默认放入 `task_package.extensions.capability_contract.<capability_key>`。
   - 字段名必须和能力提示词逐字一致。
   - 不得为单个能力新增 `task_package` 顶层字段。

6. 定义输出和回执。
   - `expected_output` 写业务产物要求。
   - `handoff_contract` 写最终 `FINAL_HANDOFF` 和 handoff 文件要求。
   - `expected_output.file_path`、`handoff_contract.require_final_handoff` 和 `handoff_contract.accept_verdicts` 是正本字段；旧别名不得写入新 route、`package_seed` 或 `task_package`。
   - 回执接收写清业务状态字段、协议 verdict 映射、必须存在的证据和不可接收条件。

7. 双向对齐。
   - route 与能力提示词不一致时，先改到一致再启用。
   - route 必须能让主代理只读一份文件完成构包。
   - 能力提示词必须能让子代理只读 `ops/agent-prompts/_common.md`、自身能力文件和任务包完成执行。

`固定包头` 格式：

```yaml task_package_agent
agent:
  role: <role>
  runtime_role: <role>
  capability:
    name: <capability>
    file: ops/agent-prompts/<role>/<capability>.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/<role>/<capability>.md
```

以上代码块是机器可读真源，不是示例。`ops/tools/cockpit_map.py --lint` 必须能校验其与 route 文件名和能力提示词路径一致。

通用派发准备链路不在每个 route 重复展开。route 的自足条件是：主代理已完成日常派发入口读取后，只读命中 route 即可确定本能力的专属输入、读写边界、输出形态、handoff 要求和拒收条件。

## 5. 任务包设计原则

任务包只写本次运行要消费的事实、路径、权限、产物和回执要求。

任务包不得写：

- 设计原因、历史复盘、主代理会话长摘录。
- 旧报告全文、旧 handoff 全文或归档目录。
- 对子代理的预设发现、预设失败、预设通过或作者动机判断。
- policy、workflow、protocol、route 或能力提示词正文。
- 主代理回执消费动作，例如结果吸收、补充、重拆、接管、释放任务面或关闭实例。

任务包必须写：

- 谁执行：`agent`。
- 做什么：`goal`。
- 能读写删什么：`scope`。
- 必须消费什么：`inputs` 和能力专属槽位。
- 能用什么工具：`tool_contract` 和 `runtime_context`。
- 产出什么：`expected_output`。
- 怎么交回：`handoff_contract` 和完整 `FINAL_HANDOFF` 要求。

非机械任务、派发动机不明显或存在关键灰区时，可写 `extensions.orchestration.delegation_intent`。它只回答“为什么派这个子代理、要消除哪个不确定、结果会影响主代理什么决定、哪些尝试已经没有增量”，不得写成第二份 scope、第二份事实清单、历史复盘或预设结论。

## 6. 回执接收设计

回执接收规则分两层：

1. route 的 `回执接收` 段负责本能力的业务合格条件。
   - 业务状态字段写在 `FINAL_HANDOFF.output` 下。
   - route 明确业务状态到 `FINAL_HANDOFF.verdict` 的映射。
   - route 明确哪些字段缺失时不得 accept。

2. 主代理回执消费入口负责消费后的处置。
   - 先按 `task_package.goal` 判断是否达成目标。
   - 达成则吸收结果并标记消费；未达成但缺口明确则补充；未达成且缺口不清则重拆任务面。

route 不复制主代理消费动作。主代理回执消费入口不复制能力业务验收。

## 7. 冲突裁决

出现规则冲突时按以下顺序判断：

1. 当前用户显式约束优先于仓库默认规则；但不能越过系统、开发者或工具安全约束。
2. 主代理高频路由入口决定是否必须派发，以及派哪个 `role / capability`。
3. 命中的 `task-package-routes/<role>__<capability>.md` 决定主代理如何构造本次任务包。
4. 能力提示词决定子代理收到任务包后如何执行、拒收和输出。
5. `ops/protocols/task-package-reference/field-dictionary.md` 决定字段含义、闭集和值域。
6. 主代理回执消费入口决定回执消费后的主代理处置。
7. workflow 文件决定阶段准入、出站 seed 和用户确认点。

具体冲突处理：

- route 与能力提示词不一致：停止派发，改 route 或能力提示词，直到二者一致。
- route 与字段词典不一致：字段语义以字段词典为准，修正 route。
- route 缺字段或不自足：不得在派发时读取参考文件补上下文；先修 route。
- 能力提示词要求子代理做主代理动作：能力提示词越界，改能力提示词。
- 主代理回执消费入口要求目标达成判定和消费记录，而 route 说可直接完成：实例关闭规则由主代理回执消费入口负责，route 不能覆盖。
- workflow 未放行但 route 可构包：workflow gate 优先，不能派发阶段性任务。

## 8. 新建子代理或能力

新增子代理或能力时，必须同步产出：

- 新建或更新 `ops/agents/<role>.toml`；文件名与根部 `name` 一致，并在根部 `description` 写短触发摘要。
- `ops/agent-prompts/<role>/<capability>.md` 能力提示词。
- `ops/protocols/task-package-routes/<role>__<capability>.md` 专用派发规范；新增后必须跑 `node ops/tools/dispatch_prepare.mjs --card-check <route_id>` 通过。
- 主代理高频路由入口的”遇到 AA / 必须使用 AAAA / 具体派发规则见 AAAAA”行。
  - workflow 专属能力只写入对应 workflow 的阶段→能力映射（planning 为 `ops/workflows/planning/agent-dispatch.md`，alignment 为 `ops/workflows/alignment/discovery.md` §1–§3 与 `ops/workflows/alignment/exit.md` §1）；除非成为跨 workflow 通用能力，否则不写入主代理高频路由入口。
- 必要时更新 `ops/protocols/task-package-reference/field-dictionary.md`，但不得让普通派发依赖字段词典。
- route 覆盖目录由 `node ops/tools/dispatch_prepare.mjs --list` 生成（不人工维护），无需手动登记清单。

删除能力时，同步删除 route 文件、能力提示词、`ops/agent-prompts/CAPABILITIES.md` 注册、触发入口或 workflow 阶段→能力映射条目；删除角色时再删除同名角色配置。

新增完成后做两项核对：

- 主代理只读 route 是否能构造任务包。
- 子代理只读 `ops/agent-prompts/_common.md`、`required_files` 列出的族公共层、能力提示词和任务包是否能执行并返回合格 `FINAL_HANDOFF`。

## 9. 单纯任务包

没有新能力时，优先使用现有 route。

如果现有 route 能表达任务，只按该 route 构包，不新增协议。

如果现有 route 不能表达任务：

- 任务是一次性杂项且没有专职能力命中，使用 `general-agent / general-default` route。
- 任务会重复出现、需要专门输入槽位或有专门回执验收，先设计新 route。
- 禁止绕过 route 手写临时任务包让主代理自由发挥。

## 10. 维护检查

每次修改 route、能力提示词或字段词典后，至少检查：

- 主代理高频路由入口的触发行是否指向正确 route。
- route 的 `agent.capability.file` 是否等于能力提示词路径。
- route 的能力专属槽位是否和能力提示词逐字一致。
- route 的回执接收是否覆盖能力提示词输出字段。
- 字段词典是否只定义字段语义，没有写主代理派发流程。
- 日常派发路径是否仍然不需要读取本参考目录。

## 11. 路由文件结构（裁剪后规范）

route 文件只保留：

1. 文件头三行 + 一句触发对象（与差异卡 `applies_to` 同义；route 只写本能力的触发对象，不承载主代理派发判断）。
2. `### 固定包头`（机器解析）与 `### 差异卡（最小种子真源）`（机器解析；构包合同的唯一真源）。
3. `### 构包要点`：仅差异卡无法表达的条件规则（跨仓、模式特例、条件授权、并发契约特殊要求），每条一行；卡的 required / defaults / enum / hint 已表达的不重复。
4. `## 回执接收`：业务 gate 与 verdict 的映射加能力特有核对项；通用 handoff 字段只写固定模板或接收动作，route 不复述入口消费流程。

任务包污染禁令写在构包入口；子代理可见材料由固定包头 `required_files` 加任务包本身组成，route 不另列清单。
