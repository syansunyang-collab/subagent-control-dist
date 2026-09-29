# research-agent / document-scan

> 职责：规定 research-agent / document-scan 能力边界。
> 真源：对应子代理能力的输入契约、判定核心、产物格式和本能力输出字段
> 读取：维护读取

按任务包对本地 PDF、扫描件、图片、图表和 Office 文档做内容提取、读图与表格转录。本能力使用具备视觉的运行模型。

## §1. 输入契约与开工条件

本能力专属输入位于 `task_package.extensions.capability_contract.document`：

```yaml
document_paths:
  - <授权文档路径>
extraction_targets:
  - <要回答或提取的目标>
focus_pages: <可选页码或范围；空表示按目标扫描全文>
```

把每个 `extraction_target` 视为独立目标，先按 `focus_pages`、目录、章节标题和图表索引定位，再读取支撑答案的页面。

BLOCK IF: `document_paths` 或 `extraction_targets` 为空、文档不存在或不可读、文档加密 / 损坏无法呈现，或运行模型不能观察页面与图像。出口：路径或目标可从任务包唯一修正时修正后重试；否则返回 `needs_owner`，列出文件、错误或 `requires_vision` 缺口。

## §2. 提取方法

1. **定位目标**：为每个目标建立页码、章节、图号或表号候选；大文档先读目录和标题，不做无目的逐页平扫。
2. **读取证据**：逐目标读取相关文字、图表和上下文，记录文件与页码位置。
3. **标注证据状态**：`quoted` 表示原文或忠实转述；`inferred` 表示基于列明页面的推断；`unreadable` 表示分辨率、遮挡、扫描质量或语言导致无法确读。
4. **转录结构**：图表记录可见数据点、坐标轴、图例和连线；表格保留表头、行列、合并单元格和截断注释。
5. **核对覆盖**：逐目标登记已回答、证据不足或未覆盖状态，让计数与报告一致。

目标已检查但文档没有答案时，写入“证据不足”并可返回 `done`；这是一项完成的研究结果。仅在输出截断、处理超时、命中任务明确的深度预算，或仍有明确 `extraction_targets` 未检查时返回 `partial`，并把目标列入 `targets_unanswerable` / 未覆盖范围。

## §3. 产物与输出

```markdown
# Document Scan: <slug>

**Documents:** <paths>
**Targets:** <count> 条
**Focus pages:** <range or 全文>

## 结论前置（TL;DR）
- [quoted|inferred] <发现> - 来源: <文件 p.N / 图N / 表N>

## 逐目标发现
### T1: <target>
<回答、证据不足或未覆盖原因；关键事实带状态和页码>

## 无法读取部分
- <文件 p.N>: <原因>

## 页码引用清单
1. <文件> p.<N> - <one-line note>
```

`FINAL_HANDOFF.output` 补充：

```yaml
document_report_ref: <task_package.expected_output.file_path>
targets_answered: 0
targets_unanswerable: []
unreadable_parts: []
pages_cited: 0
```
