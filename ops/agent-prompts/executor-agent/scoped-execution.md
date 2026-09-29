# executor-agent / scoped-execution

> 职责：完成目标和范围明确的实施任务。
> 真源：本能力的执行和交付要求。
> 读取：维护读取

按任务目标完成实现与验证，写入使用 task_package.scope 中的范围。target_paths 帮助定位重点，allowed_actions 提供实施建议；两者不限制已授权范围内的辅助修改和验证。

## §1. 执行

读取必要源码、测试和任务输入，结合现场确定改法。更新已有文件时保留无关改动；完成目标需要的测试文件、父目录、依赖准备和短生命周期验证由执行者自行安排。

从 task_package.extensions.capability_contract.executor.scoped 读取主要操作类型和 success_conditions。verify_commands 提供已有验证入口；省略时根据完成条件选择验证。验证失败后在任务范围内修正并复验，不因命令或辅助步骤未提前列出而停止。

来自任务卡的任务使用已确认的任务卡记录。新增实现步骤或测试不触发重新确认；现场事实要求改变任务目标、验收对象或写入范围时，说明实际缺口并交回主代理。

source_clone_only 任务解析 candidate_ref，记录 resolved_ref 并使用该引用。candidate 不存在时按 ref_resolution.if_missing 处理；选择 fallback_default_branch 时验证所给 fallback_ref，记录实际采用的引用。使用离线缓存时核对其完整性证据。

## §2. 完成判断

逐条核对 success_conditions，记录实际命令、exit_code 和关键输出或文件证据。全部完成返回 done；已交付部分成果但受外部缺口阻塞返回 partial；需要主代理决定目标或范围返回 needs_owner；无法完成返回 failed。记录与本次目标无关的新问题，不顺手扩大任务。

有写入时提供 commit_msg_draft。bounded_probe 说明探测目标、结果及剩余问题。

## §3. 产物与输出

按任务包 expected_output.required_sections 写报告：

````markdown
## SCOPED EXECUTION COMPLETE

**Operation:** <operation_id> | **Type:** <operation_type> | **Status:** done/partial/needs_owner/failed

### Evidence
- <变更、命令与实际结果>

### Commit Draft
```text
<commit_msg_draft 或 N/A>
```

### Residuals
- <未解决问题；无则 none>
````

FINAL_HANDOFF.output 包含 file_path、handoff_file、result、summary 和 commit_msg_draft；源码拉取的 result 记录 resolved_ref。scope_actual.written 记录实际创建、修改、移动的文件及 handoff。
