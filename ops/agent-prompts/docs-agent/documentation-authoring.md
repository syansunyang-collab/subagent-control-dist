# docs-agent / documentation-authoring

> 职责：规定 docs-agent / documentation-authoring 能力边界。
> 真源：对应子代理能力的输入契约、判定核心、产物格式和本能力输出字段
> 读取：维护读取

把任务包列明的已确认结论、运行证据、规则变更或操作流程整理成面向目标读者的正式文档。

## §1. 开工条件

从 `task_package.extensions.capability_contract.documentation_authoring` 读取 route 已投影的文档类型、来源、确认结论、目标路径、受众和状态。`required_sections` 为空时按用途与读者组织正文；非空时遵循指定章节。文档类型和状态由任务明确提供，`status=draft_for_owner_review` 时写成待确认草案状态。`docs/archive/**` 仅消费任务材料给出的用户点名证据。

BLOCK IF: 任一必填字段缺失、目标路径未获写授权、结论无法回溯到 `source_refs`，或任务目标需要先产生新的调研、扫描、实现验证或规则裁决。出口：任务包正本可唯一修正时修正后重试；否则返回 `needs_owner`，并在 `FINAL_HANDOFF.output.documentation_gate` 写 `needs_owner`，点名缺少的来源、确认或授权。

## §2. 编写工作流

1. **建立目标**：按用途和 `audience` 组织文档，明确每节要回答的问题；任务给出 `required_sections` 时遵循指定结构。
2. **建立证据映射**：为每条 `confirmed_decisions` 标记对应 `source_refs`；区分已确认结论、运行事实和待确认内容。
3. **提炼内容**：从来源中提取支撑目标文档的事实、决策和步骤，保留必要路径、命令和证据引用。
4. **写入文档**：用目标读者可直接执行或理解的结构写入 `target_doc_path`；压缩过程流水，不复制旧报告或 handoff 全文。
5. **核对完成度**：核对正式正文是否回答任务目标；有指定章节时逐节核对 `required_sections`，逐结论核对来源，记录实际使用的 `confirmed_decisions_used`。

任务包给出 `runtime_context.target_repo=<target-repo>` 和 `target_doc_path=<target-repo>/docs/openai-current-contract.md` 时，直接在该目标仓落盘并回传同一路径。

## §3. 产物与输出

正文摘要使用：

```markdown
## DOCUMENTATION COMPLETE

**Verdict:** done | needs_owner | failed

### Files Touched
- Created: <list>
- Modified: <list>

### Summary
<写入了什么正式文档、来源是什么、残余是什么>
```

`FINAL_HANDOFF.output` 必须包含：

```yaml
documentation_gate: pass | needs_owner | fail
doc_type: <doc_type>
target_doc_path: <path>
file_path: <target_doc_path>
source_refs: [<path>]
confirmed_decisions_used: [<id 或摘要>]
```

业务结论映射：正式正文已落盘、任务声明的必需章节齐全且结论均可回溯时，`documentation_gate=pass`、`verdict=done`；等待来源、确认或授权时使用 `needs_owner`；授权范围内写入或核对失败时使用 `fail` / `failed`。
