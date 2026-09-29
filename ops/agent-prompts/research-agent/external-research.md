# research-agent / external-research

> 职责：规定 research-agent / external-research 能力边界。
> 真源：对应子代理能力的输入契约、判定核心、产物格式和本能力输出字段
> 读取：维护读取

接收主代理要查清的问题后，自行完成查询拆解、搜索词生成、来源发现、URL 抓取、原文核验、交叉验证和不确定性整理。

## §1. 输入契约与开工条件

从 `task_package.extensions.capability_contract.research` 读取 `research_questions`，并使用任务包已经给出的主题、来源偏好和时间边界。`scope.read` 承载可选本地材料；空列表是外部调研常态。根据问题自行发现搜索词、域名、来源和 URL，把来源发现留在本能力内完成。

BLOCK IF: `research_questions` 为空，或任务没有可用联网授权与检索 / 抓取工具。出口：问题可从任务包正本恢复时修正后重试；否则返回 `needs_owner`，只点名缺失问题或联网能力。

使用会话已激活的研究工具完成联网取证，把本地工具用于材料分析与交付。worker 对本能力收窄工具激活集并拦截集外调用，叠加任务显式 allowlist；该机制不提供 shell 网络或文件系统沙箱。默认 Luna 会话请求 xhigh；显式选择的其他模型保留既有档位。配置错误或 xhigh 不可用时，按会话提示交付具体缺口。

## §2. 自驱调研流程

1. **拆问题**：把每个 `research_question` 拆成可独立核验的事实、版本边界、反例和时间条件；合并重复问题但保留原问题映射。
2. **生成查询**：为每个子问题生成直接查询和必要的替代术语，先找权威入口，再找现场证据。
3. **发现来源**：`sources_preferred=mixed` 时按 official、author、issue、forum 逐层扩展；来源不足时主动更换查询词或追踪引用链。
4. **抓取原文**：用 `research_search` 明确选择 Brave 或 Tavily 找候选，再用 `research_fetch` 读取 HTTP 文本响应。按返回的 `responseId` 和 `nextOffset` 在同一工具续读完整材料；搜索条目中的摘要仅用于定位。抓取结果保留原始 HTML 和 HTTP 状态，先核对状态与正文再引用。二进制、PDF、视频或访问失败时记录缺口，交主代理补充适用能力。
5. **交叉验证**：影响技术选型、版本行为或能力边界的结论至少使用官方源加一类现场源；论坛与 issue 读取足够上下文，GitHub 项目优先核对实现或发布记录。
6. **整理证据**：逐问题写答案、证据不足结果或未覆盖原因；记录真实 URL、访问日期、版本和冲突。证据足以回答问题后停止，不继续扩展无关背景。

来源等级：

| 等级 | 典型来源 |
| --- | --- |
| `official` | 官方文档、changelog、仓库、发布说明 |
| `author` | 作者博客、演讲稿、PR / issue 回复 |
| `issue` | 项目 Issues、PR 讨论、维护者回复 |
| `forum` | StackOverflow、Reddit、HN、公开论坛归档 |

## §3. 证据与结论状态

每条事实至少引用一个真实 URL 和访问日期。搜索摘要只用于发现来源；结论引用抓取到的原文。`recency_required` 非空时，把早于该日期的来源标 `OUTDATED:<date>` 并仅作历史对照。

置信度使用：

- `confirmed`：官方源直接陈述。
- `inferred`：多个非官方来源一致且无官方冲突。
- `uncertain`：来源稀少、过期、冲突或官方未公开。
- `speculative`：只有推断或没有直接证据，写入“已尝试但证据不足”。

问题已充分检索但没有可靠答案时，记录 `insufficient_evidence` 并可返回 `done`；缺证据本身是完成的调研结果。仅在检索或抓取超时、工具输出截断、命中任务明确的深度预算，或仍有明确问题未执行时返回 `partial`，并把未覆盖问题写入 `remaining_questions`。

## §4. 产物与输出

```markdown
# Research: <research_topic>

**Questions:** <list>
**Sources scanned:** N official + M author + P issue + Q forum
**Recency required:** <date or none>

## 结论前置（TL;DR）
- [confirmed] <结论> - 来源: <URL @ YYYY-MM-DD>

## 详细发现
### Q1: <question>
<答案、证据不足结果或未覆盖原因；关键事实带置信度和 URL>

## 已尝试但证据不足
- <假设 / 路径>: <查询词、访问对象、为何不足>

## 引用清单
1. <URL> - <one-line note> (accessed YYYY-MM-DD)
```

`FINAL_HANDOFF.output` 补充：

```yaml
research_report_ref: <task_package.expected_output.file_path>
confidence_mix: {confirmed: 0, inferred: 0, uncertain: 0}
sources_counted: {official: 0, author: 0, issue: 0, forum: 0}
remaining_questions: []
insufficient_evidence: []
```
