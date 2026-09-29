# research-agent / external-research 派发规范

> 职责：规定 research-agent / external-research 的专用派发规范。
> 真源：对应能力的 task_package 构造、拒收条件和回执接收规则
> 读取：命中读取

触发对象：需要官方文档、版本、API、SDK、changelog、issue、论坛或外部资料。构包用 `node ops/tools/dispatch_prepare.mjs --seed-template` 取骨架；本 route 只定义本能力的任务对象、seed 差异、拒收条件和回执接收。

### 固定包头

```yaml task_package_agent
agent:
  role: research-agent
  runtime_role: research-agent
  capability:
    name: external-research
    file: ops/agent-prompts/research-agent/external-research.md
  required_files:
    - ops/agent-prompts/_common.md
    - ops/agent-prompts/research-agent/external-research.md
```

将以上固定值逐字写入 `task_package.agent`，保持字段名和路径一致。

### 差异卡（最小种子真源）

本块是机器可读差异卡：`node ops/tools/dispatch_prepare.mjs --seed-template` 的骨架、最小种子展开默认值和 `--list` 目录均由本块生成。日常派发只需按骨架填必填字段；本文件其余正文是维护期参考。

```json route_card
{
  "dispatch_phase": {"kind": "direct", "step": null},
  "applies_to": "官方文档、版本、API、SDK、changelog、issue、论坛、外部资料",
  "model_tier": "",
  "report_dir": "notes/research",
  "slot": "research",
  "goal_from": "contract.research_questions",
  "omit_delegation_intent": true,
  "required": [
    {"path": "contract.research_questions", "hint": "主代理只写要查清的问题；research-agent 自行拆查询、选来源、搜索并抓原文", "example": ["ripgrep 当前稳定版是否支持多行匹配，如何启用，有哪些版本边界和已知缺陷"]}
  ],
  "optional": [],
  "contract_defaults": {
    "research_topic": "$goal",
    "sources_preferred": "mixed",
    "recency_required": ""
  },
  "seed_defaults": {
    "runtime_context": {"network_needed": "yes"},
    "tool_contract": {"network_allowed": true, "install_allowed": false},
    "scope": {"out_of_scope": []},
    "expected_output": {"required_sections": ["结论前置", "详细发现", "已尝试但证据不足", "引用清单"]},
    "handoff_contract": {"accept_verdicts": ["done", "partial", "needs_owner", "failed"]}
  }
}
```

### 构包要点

- 主代理只提交 `research_questions`；`goal`、主题、来源策略、报告路径、handoff 与空本地读面由构包器补齐。来源发现、搜索词、URL 选择和原文抓取由 research-agent 按能力提示词完成。
- 联网授权：默认使用已启用的工作工具；先用 `web_search` 检索来源，再用 `fetch_content` 抓取原文，长内容按 `get_search_content` 定位。`bash` 继续承载任务材料授权的 HTTP、仓库或检索客户端。

## 回执接收

verdict 词表：`done`（每个问题已有结论或证据不足状态且报告落盘）、`partial`（检索 / 抓取超时、输出截断、命中明确深度预算或仍有明确问题未执行）、`needs_owner`（缺 research_questions 或联网能力）、`failed`（检索或写入失败）；先核对 `FINAL_HANDOFF` 结构、报告路径和机械自检，再看能力特有核对：

- 核对回执中的真实 URL、置信度分布和残余不确定；缺 URL 的陈述留在“已尝试但证据不足”，字段不一致时返回该 lane 修正后重试。
