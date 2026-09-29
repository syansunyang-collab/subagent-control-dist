# general-agent / general-default 派发规范

> 职责：规定 general-agent / general-default 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

准入以本文件 `route_card.applies_to` 为唯一真源。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。

### 固定包头

```yaml task_package_agent
agent:
  role: general-agent
  runtime_role: general-agent
  capability:
    name: general-default
    file: ops/agent-prompts/general-agent/general-default.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/general-agent/general-default.md
```

将以上固定值逐字写入 `task_package.agent`，保持字段名和路径一致。

### 差异卡（最小种子真源）

本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "明确子代理任务但专职角色均不命中的兜底或无专职能力覆盖的独立验证",
  "model_tier": "",
  "report_dir": "notes/general",
  "required": [
    {"path": "goal", "hint": "写明有界任务目标、完成判据和交付物", "example": "独立核对一个已完成 skill 的任务级交付与预期输出是否一致"},
    {"path": "scope.read", "hint": "列出任务需要读取的来源文件、目录或材料；通用子代理不是只读角色，写入和删除范围另用 scope.write_extra / scope.delete 声明", "example": ["src/main.py", "README.md"]}
  ],
  "optional": [
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "inputs.constraints", "hint": "资料整合规则、摘要长度、输出格式和不确定性处理"},
    {"path": "scope.write_extra", "hint": "除报告和 handoff 外允许写入的业务文件或目录；任务需要产物落盘时填写"},
    {"path": "scope.delete", "hint": "允许删除的文件或目录；无删除任务时删除本字段"},
    {"path": "scope.out_of_scope_extra", "hint": "填写任务实例特有的补充边界；常规边界使用 scope 或 tool_contract"},
    {"path": "tool_contract.allowed", "hint": "限制本次任务可见工具时填写数组；普通任务不填"},
    {"path": "tool_contract.forbidden", "hint": "填写任务级行为边界"},
    {"path": "runtime_context.network_needed", "hint": "需要联网时显式写 yes；缺省 no"},
    {"path": "known_facts", "hint": "子代理需要的当前事实清单，默认空"}
  ],
  "seed_defaults": {
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["Verdict", "Files Touched", "Summary", "Out of Scope"]},
    "handoff_contract": {"accept_verdicts": ["done", "partial", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- 通用子代理可在任务包 `scope.write` / `scope.delete` 授权范围内写入、删除和运行本地命令；默认权限不是只读。最小种子的业务写入目录通过 `scope.write_extra` 添加。
- 本能力无专属 contract 槽位，只用通用字段表达任务；独立验证必须在 `goal`、`inputs.constraints` 和 `expected_output` 中写清被验对象、判据和证据。路由由主代理决定：派给兜底角色的验证 / 评审任务照单做，只有任务包自相矛盾（见 `ops/agent-prompts/general-agent/general-default.md §1`）才返回 `role_mismatch`。

## 回执接收

verdict 词表：`done | partial | needs_owner | failed`；先核对 `FINAL_HANDOFF` 结构、报告路径和机械自检，再看能力特有核对：

- `needs_owner` 时核对 `output.result` 是否写明 `role_mismatch`（仅任务包自相矛盾）、`scope_unclear` 或具体缺口。
