# 验收叶子公共层

> 职责：规定携带 `acceptance_context` 的审查叶子如何逐项执行验收并输出机器结果。
> 真源：验收叶子的逐项取证与 `acceptance_results` 合同
> 读取：不作为入口

## §1. 执行

按 `acceptance_context.items[]` 点名的验收项工作；同一 route 的验收项放在一个叶子中。服务、浏览器和规格只准备一次，再逐项按各自 `oracle`、`technique` 与 `cases` 取证。

`review_round >= 2` 时执行携带验收项的 cases 与各项 `regression_scope`；oracle 明确要求全套执行时执行全套。按 `technique` 组织刺激和证据；改用能证明同一 oracle 的方法时，在 `Scope` 点名替代方法和原因。叶子只判断本次验收项，不给整个 phase 下总判决。

## §2. 输出

每条 finding 同时写 `acceptance_refs` 与 `requirement_refs`。在 `Verdict` 按 `acceptance_id` 分节写 `pass | fail | needs_owner` 与证据引用，并输出：

```json acceptance_results
{"acceptance_results":[{"acceptance_id":"AC-01","gate":"pass | fail | needs_owner","evidence_refs":[]}]}
```

保留每项已经取得的结论；未取证项写 `needs_owner`，在 `evidence_gaps` 点名 acceptance_id、缺口与接手者。用 `type=unverified` 标记未运行或未完成取证，`type=environment` 标记环境故障，`type=evidence` 标记真实证据冲突，`type=owner_decision` 标记授权或取舍。复用同一次运行中能证明各项 oracle 的证据。

整叶 gate 只汇总已完成的检查：有产品失败为 `fail`，其余已完成项为 `pass`；整叶无法执行才为 `needs_owner`。单项未验证保留在逐项结果中，由消费方按 blocking / non_blocking 判定整体完成情况。
