# Acceptance Authoring Route 行为验收上下文

> 职责：为 acceptance-authoring route 提供最小、稳定、可复跑的 planner 准入 fixture。
> 真源：仅作为 route 行为验收输入；业务要求以点名的 change rationale 为准。
> 读取：维护读取

该 fixture 用于验证 `planner-agent__acceptance-authoring` 能根据已锁定的 AR-01 至 AR-07 生成 Acceptance Contract。样例规格真源即本文件内嵌的 AR-01 至 AR-07;真实任务中以点名的 change rationale 为准。

## Alignment State

```yaml
alignment_state:
  locks:
    requirements_locked: true
    planner_allowed: true
  lock_sources:
    requirements:
      decision_source:
        type: user_explicit
        confirmation_ref: sample-acceptance-phase-confirmation
  decisions: []
  review_refs:
    surface_slice: []
    cross_surface: {report_ref: null, business_verdict: null}
  next_action:
    type: enter_planner
    dispatch_seed:
      route: planner-agent
      capability: plan-authoring
```

## 样例 Acceptance Requirements

| id | 要求 |
| --- | --- |
| AR-01 | 合同覆盖样例阶段的全部验收项，每项只绑定一个可机械判定的 oracle |
| AR-02 | 每个验收项声明 route_id 与 route_contract 构包输入 |
| AR-03 | 验收项与 dispatch lane 的 `requirement_refs` 可 traceability 对账 |
| AR-04 | 失败验收项能映射回原实现 lane 生成定向返工 |
| AR-05 | 归并层输出 disposition 闭集 pass / rework / needs_owner |
| AR-06 | 验收轮次上限两轮，第二轮仍 rework 转 needs_owner |
| AR-07 | 合同引用的规格来源限于 source_refs 白名单 |
