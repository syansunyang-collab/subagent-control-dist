# verify-agent / code-verification 派发规范

> 职责：规定 verify-agent / code-verification 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：代码改动、运行配置、测试配置、构建配置、依赖配置、测试入口、测试证据、实现后验证、对抗变更审查或测试优先证据核验。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。本能力面向实现和测试验证；`PLAN.md` 审查与生产执行分别使用对应专职能力。

### 固定包头

```yaml task_package_agent
agent:
  role: verify-agent
  runtime_role: verify-agent
  capability:
    name: code-verification
    file: ops/agent-prompts/verify-agent/code-verification.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/_review-common.md
    - ops/agent-prompts/verify-agent/code-verification.md
```

以上字段按固定值原样写入 `task_package.agent`；角色、能力名和路径以本块为准。

### 差异卡（最小种子真源）

本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "代码验证、测试证据、实现对抗检查",
  "model_tier": "",
  "report_dir": "notes/verify",
  "slot": "verify",
  "required": [
    {"path": "goal", "hint": "使用中立描述点明测试执行、测试编写、配置验证、实现验证或对抗变更审查目标", "example": "对 src/cli.py 本次参数解析改动做对抗变更审查"},
    {"path": "scope.read", "hint": "覆盖 affected_files、changed_surfaces 对应文件、验证入口、测试入口和必要证据", "example": ["src/cli.py", "tests/test_cli.py"]},
    {"path": "contract.verify_mode", "enum": ["testing", "verification"], "hint": "testing=测试编写或执行；verification=实现后对抗验证", "example": "verification"},
    {"path": "contract.task_description", "hint": "写被验证任务的客观描述，并把实现者材料仅作为待核证输入", "example": "为 CLI 增加 --strict 参数并在参数冲突时报错"},
    {"path": "contract.review_goal", "hint": "写可观察验证目标，结论由实际检查产生", "example": "核验 --strict 参数解析和冲突报错是否真实生效"},
    {"path": "contract.affected_files", "hint": "受影响文件清单，必须被 scope.read 覆盖", "example": ["src/cli.py"]},
    {"path": "contract.require_test_first_evidence", "hint": "取值 true | false；true 时必须同时提供 contract.test_first_evidence（实现前证据、实现后复验证据、验证入口和对应 task）", "example": false},
    {"path": "contract.changed_surfaces", "required_when": {"path": "contract.verify_mode", "equals": "verification"}, "hint": "verify_mode=verification 时必填：本次 diff 触及的 file:line、hunk 或 function", "example": ["src/cli.py:42-88 parse_args"]},
    {"path": "contract.allowed_risk_triggers", "required_when": {"path": "contract.verify_mode", "equals": "verification"}, "hint": "verify_mode=verification 时必填：重点关注的风险类型，取值 input | auth | persistence | migration | concurrency | command | path | config_default | none", "example": ["input"]},
    {"path": "contract.disallowed_topics", "required_when": {"path": "contract.verify_mode", "equals": "verification"}, "hint": "verify_mode=verification 时必填：列出本轮审查边界外的话题", "example": ["泛安全加固", "历史遗留问题"]},
    {"path": "contract.issue_admission_required", "required_when": {"path": "contract.verify_mode", "equals": "verification"}, "hint": "verify_mode=verification 时必填：issue 必须满足 admission 五字段才可上报", "example": true}
  ],
  "optional": [
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "scope.write_extra", "hint": "需要编写测试时列测试文件或目录"},
    {"path": "contract.test_first_evidence", "hint": "require_test_first_evidence=true 时必填：实现前证据、实现后复验证据、验证入口和对应 task"},
    {"path": "contract.mechanical_checks", "hint": "verification 模式的机械检查列表；每项含 id、argv、cwd，可选 timeout_seconds 与 expected_exit_codes"},
    {"path": "contract.change_base", "hint": "本次变更开始前的提交（commit 或可解析的 ref）；给出后证据与审查覆盖该提交之后已提交和未提交的全部修改，缺省只覆盖相对 HEAD 的工作区修改", "example": "a1b2c3d"}
  ],
  "seed_defaults": {
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["Verdict", "Findings", "Evidence Gaps", "Scope"], "business_gate": "verdict"},
    "handoff_contract": {"accept_verdicts": ["done", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- `scope.write` 枚举验证报告、授权测试代码、测试结果目录、handoff 和其他显式写入路径；被审源码记录在 `scope_actual.read`。
- `verify_mode=testing` 需要编写测试时，把对应测试文件或目录加入 `scope.write`；仅执行现有测试时保持测试源码为只读。
- `verify_mode=verification` 时提供 `contract.mechanical_checks`；`dispatch_prepare.mjs` 只执行这些显式 `argv`，并把 scoped Git、changed surface 和检查结果写入机械证据包。
- `concurrency_contract` 的 `conflict_keys`、`parallel_policy` 必须与读取、测试写入、报告写入和 executor -> verify 屏障相容，不相容时子代理返回 `needs_owner`。
- `require_test_first_evidence=false` 表示本轮验证范围不包含测试优先证据审查。

## 回执接收

- 业务状态只读 `FINAL_HANDOFF.output.verdict`；审查完成出结论对应 `FINAL_HANDOFF.verdict=done`（verdict 只表示任务是否完成），被审对象是否通过只看 `output.verdict=pass | fail`，gate=fail 的合格回执按目标达成吸收，后续业务按验证未通过处理。
- 输入合同缺失、权限不足、Git 证据缺失或被要求处理非验证任务对应 `needs_owner`，或按能力提示词阻断字段处理。
- 报告、测试证据或 handoff 写入失败对应 `failed`。

能力特有核对：`FINAL_HANDOFF.output` 必须含 `verdict` 和 findings 数量；机械证据包提供 scoped Git 与测试事实，reviewer 按能力合同补齐缺少且可在授权范围内取得的 oracle 证据。
