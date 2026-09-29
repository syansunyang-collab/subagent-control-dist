# executor-agent / scoped-execution 派发规范

> 职责：规定 executor-agent / scoped-execution 的专用派发规范。
> 真源：对应能力的 task_package 构造和回执接收规则。
> 读取：命中读取。

承接目标和工作范围明确、未命中其它专职能力的有界实施。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 获取骨架。

### 固定包头

```yaml task_package_agent
agent:
  role: executor-agent
  runtime_role: executor-agent
  capability:
    name: scoped-execution
    file: ops/agent-prompts/executor-agent/scoped-execution.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/executor-agent/scoped-execution.md
```

### 差异卡

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "目标和工作范围明确、未命中其它专职能力的有界实施",
  "model_tier": "",
  "report_dir": "notes/general",
  "slot": "executor",
  "required": [
    {"path": "goal", "hint": "描述需要完成的结果", "example": "在 src/app.py 增加重试上限并验证行为"},
    {"path": "scope.read", "hint": "列出相关源码、测试和必要输入", "example": ["src/app.py"]},
    {"path": "scope.write_extra", "hint": "覆盖实现和验证需要修改的文件或目录；报告和handoff由编译器加入", "example": ["src/app.py", "tests/"]},
    {"path": "contract.scoped.operation_type", "enum": ["source_clone_only", "file_create", "file_update", "file_move", "bounded_probe"], "hint": "主要操作类型", "example": "file_update"},
    {"path": "contract.scoped.success_conditions", "hint": "可观察的完成条件；测试写定向用例通过，全量套件写不新增失败", "example": ["重试达到上限后结束，相关测试通过，全量测试不新增失败"]}
  ],
  "optional": [
    {"path": "contract.scoped.target_paths", "hint": "可选的重点文件或目录，用于定位工作对象", "example": ["src/app.py"]},
    {"path": "contract.scoped.allowed_actions", "hint": "可选的实施建议，不是命令或操作白名单", "example": ["增加重试上限并补回归测试"]},
    {"path": "slug", "hint": "报告文件名短名，缺省自动生成"},
    {"path": "contract.scoped.operation_id", "hint": "短 ID，缺省等于报告 slug"},
    {"path": "contract.scoped.verify_commands", "hint": "已有的验证入口；省略时由执行者根据完成条件选择"},
    {"path": "contract.scoped.ref_resolution", "hint": "source_clone_only 使用：repo_url、candidate_ref、resolution_mode、verification_commands、cache_path、cache_integrity_oracle"},
    {"path": "contract.scoped.ref_resolution.if_missing", "enum": ["needs_owner", "partial", "fallback_default_branch"], "hint": "candidate 不存在时的处理方式"},
    {"path": "contract.scoped.ref_resolution.fallback_ref", "required_when": {"path": "contract.scoped.ref_resolution.if_missing", "equals": "fallback_default_branch"}, "hint": "所选替代引用"},
    {"path": "scope.delete", "hint": "本次需要删除的路径，缺省为空"},
    {"path": "tool_contract.network_allowed", "hint": "实施需要联网（查文档、拉取依赖）时设 true；缺省 false"},
    {"path": "tool_contract.install_allowed", "hint": "实施需要安装依赖时设 true；缺省 false"},
    {"path": "known_facts", "hint": "子代理需要的当前事实"}
  ],
  "contract_defaults": {
    "scoped": {
      "operation_id": "$slug",
      "ref_resolution": {"repo_url": null, "candidate_ref": null, "resolution_mode": null, "verification_commands": [], "cache_path": null, "cache_integrity_oracle": null, "if_missing": "needs_owner", "fallback_ref": null},
      "verify_commands": [],
      "commit_msg_draft_required": true
    }
  },
  "seed_defaults": {
    "inputs": {"files": "$scope_read"},
    "alignment": {"guard": {"required": false, "reason": "目标和工作范围已明确；来自任务卡时引用相应确认记录"}},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["Evidence", "Commit Draft", "Residuals"]},
    "handoff_contract": {"accept_verdicts": ["done", "partial", "needs_owner", "failed"]}
  }
}
```

### 构包与接收

- 以 goal、scope 和 success_conditions 交代完整工作。target_paths 与 allowed_actions 可省略，也不缩小 scope。
- 执行者自行完成目标需要的辅助编辑、目录准备、依赖准备和验证；已有验证命令作为入口，不要求穷举全部动作。
- 来自任务卡的任务引用已确认的任务卡及写入范围。
- source_clone_only 解析并记录 resolved_ref 后使用该引用；替代引用按 ref_resolution 的明确选择处理。
- 完成条件与实际验证满足时接收 done；有成果但存在不能解决的外部缺口时接收 partial；需要改变目标或范围时接收 needs_owner；无法完成时接收 failed。
- 有写入时提供 commit_msg_draft，Evidence 包含实际变更和验证结果；scope_actual.written 记录实际写入及 handoff。
