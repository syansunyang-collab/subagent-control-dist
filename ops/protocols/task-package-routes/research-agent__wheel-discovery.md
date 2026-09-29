# research-agent / wheel-discovery 派发规范

> 职责：规定 research-agent / wheel-discovery 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：新写工具、模块或组件之前，查找现成方案并输出固定对比表。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。

### 固定包头

```yaml task_package_agent
agent:
  role: research-agent
  runtime_role: research-agent
  capability:
    name: wheel-discovery
    file: ops/agent-prompts/research-agent/wheel-discovery.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/research-agent/wheel-discovery.md
```

将以上固定值逐字写入 `task_package.agent`，保持字段名和路径一致。

### 差异卡（最小种子真源）

本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "新写工具、模块或组件前的现成方案对比：固定对比表，「自己写」为基线一行；不安装、不运行候选",
  "model_tier": "",
  "report_dir": "notes/research",
  "slot": "wheel_discovery",
  "goal_from": "contract.target",
  "omit_delegation_intent": true,
  "required": [
    {"path": "contract.target", "hint": "要新写的工具、模块或组件及其用途，一句话", "example": "为对齐规格书生成单文件 HTML 预览的渲染组件"},
    {"path": "contract.requirements", "hint": "已锁范围内的需求条目，每条以 id 开头；对比表的能力覆盖列逐条对照", "example": ["R1 Markdown 转 HTML，支持表格与代码块", "R2 离线运行，不依赖常驻服务", "R3 输出单个 HTML 文件"]},
    {"path": "contract.user_constraints", "allow_empty": true, "hint": "S1 采访中坑点问题的回答：用户已知的坑、偏好与红线；用户答没有时填 []", "example": ["不引入 Python 以外的运行时"]}
  ],
  "input_defaults": {"scope.read": ["."]},
  "optional": [
    {"path": "contract.known_candidates", "hint": "已知候选的名称或链接，逐个纳入对比；缺省由 research-agent 自行发现", "example": ["markdown-it-py", "mistune"]},
    {"path": "scope.read", "hint": "省略为仓根 '.'，用于核对依赖清单、运行面、目录与现有验证命令", "example": ["ops/", "tests/"]},
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"}
  ],
  "contract_defaults": {
    "known_candidates": []
  },
  "seed_defaults": {
    "runtime_context": {"network_needed": "yes"},
    "tool_contract": {"network_allowed": true, "install_allowed": false, "forbidden": ["bash", "powershell"]},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["决策摘要", "对比表", "引用清单"]},
    "handoff_contract": {"accept_verdicts": ["done", "partial", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- 主代理提交目标、已锁需求条目、S1 采访中坑点问题的回答和已知候选；报告路径、handoff、整仓读面与工具边界由构包器补齐。
- 工具边界：`tool_contract.forbidden` 的 `bash`、`powershell` 由 worker 的研究工具门控执行，联网取证用 `research_search` / `research_fetch`，本地核查用读取类工具；写域只有报告与 handoff。
- 本能力不安装、不运行候选；对比表「待实测」列的缺口由主代理另派 `executor-agent / scoped-execution` 做 `local_probe`。

## 回执接收

verdict 词表：`done`（对比表覆盖「自己写」基线与全部入选候选，决策摘要四字段齐全且报告落盘）、`partial`（检索 / 抓取超时、输出截断、命中明确深度预算，或仍有需求条目未对照）、`needs_owner`（缺目标、需求条目或联网能力）、`failed`（检索或写入失败）；先核对 `FINAL_HANDOFF` 结构、报告路径和机械自检，再看能力特有核对：

- 核对对比表七列齐全、「自己写」一行存在、能力覆盖列逐条对应 `requirements` 的 id，「许可与维护」「源码核查」单元带真实 URL 或源码位置；缺列、缺行或缺引用时返回该 lane 修正后重试。
- 核对报告的 `decision_summary` 含 `summary`、`basis`、`unresolved`、`owner_decisions` 四个键；缺键时返回该 lane 补齐。
