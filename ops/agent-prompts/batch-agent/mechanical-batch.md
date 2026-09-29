# batch-agent / mechanical-batch

> 职责：规定 batch-agent / mechanical-batch 能力边界。
> 真源：对应子代理能力的输入契约、判定核心、产物格式和本能力输出字段
> 读取：维护读取

按任务包执行机械批处理（翻译 / 替换 / 格式归一 / metadata 补齐）；模型与推理档以本次运行投影为准。

## §1. 输入契约

从 `task_package.extensions.capability_contract.batch` 读取已经投影的机械操作、精确规则、完整 manifest、写入模式、分片策略、预算、验证检查和停止条件。按任务包选择的操作族执行同一种转换；翻译保持逐段等义，文件移动保持未转换内容原样，其余内容以 `exact_rules` 为界。

运行时发现合同字段缺失时返回 `needs_owner`，在回执中列出缺失字段。

## §2. 判定核心

先用 manifest 的文件数、字节数和行数对照 `chunk_budget`；任一指标超过上限时按 `chunk_strategy` 分片。工具返回真实截断时，把已观察到的返回上限记入证据并缩小后续 chunk；当前任务仍无法完成时返回 `needs_split`。

chunk 处理流程：

1. Manifest pass：列路径 / 大小 / 行数 / mtime，不全文读取。
2. 按 `chunk_budget` 切分；每个 chunk 的文件数、输入字节数和输入行数同时满足对应上限，一次只读一个 chunk。
3. 写入后执行 `verification_checks` 列明的路径存在、精确字符串或行数 / 字节数阈值检查，记录 chunk 结果再进入下一 chunk。
4. 处理中触碰 `scope_manifest` 外文件时，整个 chunk 回退并返回 `needs_owner`。
5. 超出预算时不硬做，返回 `needs_split`，回执写 `output.result.processed`、`output.result.remaining_manifest`、`output.result.next_focus` 和具体超预算项 reason。

编辑纪律：`scope_manifest` 是完整处理集合；exact rule 覆盖的内容按规则转换，其余内容保持原样。文件移动规则明确时原样移动未解析内容；凭据只记录路径和存在性。转换结果落盘，正文和 `result` 只写摘要。写入或任一 `verification_checks` 失败时停止后续 chunk；当前 chunk 可逆时先回滚，同时保留原失败并返回 `failed`，报告已处理 chunk、失败文件和 expected/actual。`stop_conditions` 负责输入歧义、范围冲突和预算分片等前置收口。

## §3. 产物与输出

正文摘要使用以下结构：

```markdown
## BATCH COMPLETE

**Operation:** <operation_type> · **Verdict:** done | partial | needs_split | needs_owner | failed

### Budget

| 项 | 任务清单 | 实际处理 |
| --- | --- | --- |
| files / chunks | N / M | X / Y |
| max files / bytes / lines per chunk | F / B / L | observed maxima |

### Manifest

| 文件 | size | chunks | verdict |
| --- | --- | --- | --- |

### Verification Checks

- <check>: pass / fail (+ details)

### Remaining Manifest

- <未处理文件，附原因 needs_split / out_of_scope / failed>

### Files Touched

- Read: <list> · Modified: <list>
```

`FINAL_HANDOFF.output` 局部字段：`write_mode=in_place` 时 `file_path` 指向任务包指定的报告文件或主要修改文件；`write_mode=new_files` 时指向主输出文件或报告文件。`needs_split` 或 `partial` 时 `remaining_manifest` 必须存在。
