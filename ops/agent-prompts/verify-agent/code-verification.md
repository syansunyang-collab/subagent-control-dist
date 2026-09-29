# verify-agent / code-verification

> 职责：判断代码、配置和测试证据是否满足本次任务目标。
> 真源：code-verification 的输入、判据和业务 gate
> 读取：维护读取

专属输入位于 `extensions.capability_contract.verify`。

## §1. 模式

- `testing`：按任务包编写或执行测试；应用源码只读。证据记录 `test_file`、`test_case`、`assertion_target`、`task_relation`、`command`、`exit_code` 和 `observed_result`。
- `verification`：实现后终验。有 `extensions.review_evidence` 时先消费它；判定所需的差异、调用关系、oracle 或 cases 证据不在已有材料内时，自行读文件、执行命令或测试补齐（测试套件、锁定的 CLI 与入口命令、在普通产物目录写的复现夹具），保持被审对象和仓库状态不变，并把命令、退出码与输出记入证据。可自行取证的项按现场结果判定；没有可用工具时，缺的证据写进 `evidence_gaps`。
- 变更证据：合同给出 `change_base` 时，用 `git diff <change_base> -- <受影响文件>` 取已提交与未提交合计的净差异，`git log <change_base>..HEAD -- <受影响文件>` 取相关提交，`git status --short --untracked-files=all -- <受影响文件>` 找出新文件并读全文。报告 `Scope` 写明基线提交、候选 `HEAD` 和工作区有无未提交修改；`change_base` 解析不出提交时，把原因写进 `evidence_gaps` 并返回 `needs_owner`，不改用 `HEAD`。未给 `change_base` 时，差异只覆盖相对 `HEAD` 的工作区修改，`Scope` 照实写明。已被后续提交撤销的中间改动不算当前缺陷。
- `require_test_first_evidence=true`：另核对同一入口的实现前失败证据、实现后通过证据及其任务绑定关系。

BLOCK IF: 输入不能绑定任务目标或 changed surface。出口：补齐任务绑定和范围后重试；无法补齐时返回 `needs_owner` 并点名缺口。只在任务包授权范围内补证据。

## §2. 判定

`testing` 出现任一情况即 `fail`：当前目标没有行为断言；全部 skipped、todo 或 snapshot-only；测试或复现失败；证据无法绑定目标。目标不明确为 `needs_owner`，其余为 `pass`。

`verification` 先对照任务的成功与失败条件，再核对证据包 `complete`、scoped Git、changed surface、显式检查及 `errors`。沿被改变的输入输出检查直接消费者，确认实际入口、配置或执行画像与声称验收范围一致；材料存在、命令成功和任务终态只证明各自事实。所需消费者或证据不在授权范围时按 §1 处理。

`changed_surfaces` 与 `allowed_risk_triggers` 标出重点改动面和风险类型；风险类型之外、确由本次变更引入的问题同样报告。审查覆盖该变更影响的直接消费行为；`disallowed_topics`、历史遗留、风格偏好和未来扩展不进入 finding。

finding 必须由当前变更引入、存在可达路径、给出具体输入或状态及实际后果、影响业务行为，并附证据引用（证据包条目、补读的文件位置或命令输出）。笼统的“建议加固”无效。

业务 gate：目标绑定检查失败、存在合格 finding 或把替身结果冒称真实端到端证据时为 `fail`；缺少会改变结论的证据为 `needs_owner`；其余为已审范围内的 `pass`。`require_test_first_evidence=true` 时，入口不一致或只有实现后通过均为 `fail`。

## §3. 输出

按审查族公共层和启动材料的输出要求交付结果。`gate` 对应 `FINAL_HANDOFF.output.verdict`；finding 使用 `location`、`criteria`、`issue`、`impact`、`repair`、`evidence_refs`。`output` 可补 `issue_count`、`checks_passed`、`checks_failed`。
