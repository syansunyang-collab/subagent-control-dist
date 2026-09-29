# 子代理能力提示词格式

> 职责：规定子代理能力提示词的分层与章节结构。
> 真源：能力提示词文件结构和写作边界
> 读取：维护读取

新增、重写或审查 `ops/agent-prompts/**` 能力提示词时读取本文件。材料层归属看 `ops/protocols/subagent-material-layering.md`；写作质量判据看 `ops/skills/rule-authoring/SKILL.md`。

## 1. 三层分工

- `ops/agents/<role>.toml`：单一 role 的运行配置、身份和跨 capability 默认姿态；不承载能力输入、任务实例、业务 gate 或报告模板。
- `ops/agent-prompts/_common.md`：全部子代理的公共执行边界、证据要求和最终回执动作。
- 族公共层：某一族能力在公共层之外的共享契约，经所属 route 的 `required_files` 注入。现有：`ops/agent-prompts/_review-common.md`（审查 / 验收族：verify-agent 全部能力、semantic-review-agent；输入校验通则、审查边界、两轴结论、finding 纪律）、`ops/agent-prompts/explorer-agent/_explorer-common.md`（探查族：扫描工作流、报告结构、partial 与预算协议）。
- 能力提示词：只写本能力独有的内容——适用边界、专属输入字段（slot 与必填清单）、判定核心、产物专属段与 `FINAL_HANDOFF.output` 局部字段。

能力提示词不得复制上层已维护的内容。与角色运行层、公共层或族公共层发生语义冲突时，按 `ops/protocols/subagent-material-layering.md` 收口，不在能力提示词内自设优先级。

## 2. 章节结构

能力提示词 = 文件头三行（职责 / 真源 / 读取）+ 一句定位 + 按需取用以下章节：

1. `## §1. 适用边界`（可选）：本能力能处理、不能处理、何时 `needs_owner` 的可观察边界。
2. `## §2. 输入契约`：slot 路径、必填字段清单、字段语义和枚举。
3. `## §3. 判定核心`：本能力的执行步骤、判定方法、证据要求和拒收点。
4. `## §4. 产物与输出`：报告专属段（模板放 fenced code block，模板内部标题只属于产物）、`FINAL_HANDOFF.output` 局部字段、业务 gate 字段名和取值。

不单独维护"返回前自查"和"失败边界"章节：输出检查归 `ops/agent-prompts/_common.md` §3 与 `ops/agent-prompts/_review-common.md` §4；失败处理一句话（缺什么补什么；补不了 `needs_owner` 并说明缺口），确属本能力的特殊拒收条件并入 §1 / §2，不展开穷举表。存量提示词向本结构迁移；迁移前残留的自查 / 失败边界章节视为待清理冗余，不再新增。

## 3. 写作边界

- 不写主代理动作：派发、等待、重派、状态提交、回执吸收。
- 不写完整任务包字段表、route 固定包头、完整 `FINAL_HANDOFF` 骨架或默认路径。
- 与差异卡（route_card）的 required / enum / business_gate 语义必须逐字一致；改任一侧后运行 `node ops/tools/dispatch_prepare.mjs --card-check <route_id>`。

## 4. 验证

修改能力提示词或本文件后：运行 `python -B ops/tools/cockpit_map.py --lint` 和对应 route 的 `--card-check`；章节错层属语义判断，按 `ops/protocols/subagent-material-layering.md` 处理，不得只凭标题扫描放行或拒收。
