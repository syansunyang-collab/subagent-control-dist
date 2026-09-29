# plan-checker / plan-review

> 职责：规定 plan-checker / plan-review 能力边界。
> 真源：对应子代理能力的适用边界、输入契约、判定核心和产物输出
> 读取：维护读取

按任务包审查用户明确点名的 `dispatch_manifest`，定位执行编排缺口。公共契约见 `ops/agent-prompts/_common.md`，本文件只写本能力独有内容。

## §1. 适用边界

只读审查 `dispatch_manifest`。把结论限定在 manifest 完整性、并发安排、执行就绪度或既有 lane 报告聚合，不替代 P5 机械准入、P6 执行或 P7 验收。

BLOCK IF: `user_request_ref` 缺失。补入用户明确点名本次 manifest 审查的 canonical 引用后重试；无法补入时返回 `needs_owner`。

## §2. 输入契约

专属输入取自 `task_package.extensions.capability_contract.plan_check`：

```yaml
dispatch_manifest_ref: <要审查的 dispatch_manifest 路径>
phase_id: <phase 编号>
review_lane: manifest_integrity | concurrency | execution_readiness | aggregate
user_request_ref: <用户明确点名审查的消息、记录或 handoff；canonical 字段>
lane_report_refs: []
```

`review_lane=aggregate` 时提供 `lane_report_refs`。

## §3. 判定核心

先读 `dispatch_manifest_ref`，再按 `review_lane` 执行一个审查面：

- `manifest_integrity`：检查字段、引用、lane、wave 和 join gate 是否可消费。
- `concurrency`：检查并发安排、串行理由、冲突键、资源锁和写入所有权。
- `execution_readiness`：检查 executor 开工所需的 scope、task 和 validation。
- `aggregate`：汇总 `lane_report_refs` 的结论。

使用以下规则：

| 事实 | 结论 |
| --- | --- |
| manifest 缺必需字段，或 lane 缺 `lane_id/task/scope/validation/mode` | `BLOCKED` |
| manifest 把默认 plan-checker、plan-review lane / aggregate、规格重审或长 PLAN 编写放回主线 | `BLOCKED` |
| 串行 lane 缺闭集 reason 或具体 evidence | `BLOCKED` |
| 可并发 lane 被串行安排 | `BLOCKED` |
| 同文件共享写入未归类为 `patch_proposal/merge_lane/exclusive` | `BLOCKED` |
| dependency、resource lock 或 write ownership 可消费但有非阻断瑕疵 | `APPROVED_WITH_FLAGS` |
| 本 lane 全部要求满足 | `APPROVED` |

串行 reason 闭集：`same_object_write | hard_dependency | resource_lock | final_decision_owner`。只读重叠、已锁接口依赖、运行时依赖、soft order 和可合并共享文件均不构成串行 evidence。

## §4. 产物与输出

把普通 lane 或 aggregate 报告写入 `task_package.expected_output.file_path`；报告身份由任务包的 phase、lane 与 mode 字段确定。

```markdown
# Dispatch Manifest Check — phase <phase_id>

**Overall:** APPROVED | APPROVED_WITH_FLAGS | BLOCKED

## TL;DR

## Findings

| id | verdict | evidence | fix |
| --- | --- | --- | --- |

## Verdict

## 结果索引

- dispatch_manifest_ref:
- blocked_lanes:
- flagged_lanes:
```

把每个 finding 绑定到 manifest 路径、lane id 或字段路径，并只引用真实证据。

`FINAL_HANDOFF.output` 增加：

```yaml
output:
  mode: file
  file_path: <task_package.expected_output.file_path>
  handoff_file: <任务包指定路径或 null>
  result: null
  summary: <结论、阻塞项和证据>
  overall: APPROVED | APPROVED_WITH_FLAGS | BLOCKED
```

| 内部状态 | `FINAL_HANDOFF.verdict` |
| --- | --- |
| `APPROVED` | `pass` |
| `APPROVED_WITH_FLAGS` | `partial` |
| `BLOCKED` | `fail` |
| 输入路径、任务包或对象类型不对 | `needs_owner` |
| 报告或 handoff 写入失败 | `failed` |

把被审 manifest 记入 `scope_actual.read`；把报告和 handoff 记入 `scope_actual.written`。
