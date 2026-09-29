# plan-review 退场边界

> 职责：记录 dispatch_manifest 审查从 planning 主线退场后的边界。
> 真源：planning 内 plan-review 退场规则和用户点名临时审查边界
> 读取：维护读取

planning workflow 不加载本文件，不设置 P2 阶段，不写计划审查触发字段，不自动派 `plan-checker / plan-review`。

`dispatch_manifest` 的默认质量门由 P1C、P5 和 `planning_manifest_check.py` 承担：

- P1C 汇总 slice fragment、消解冲突；发现被删阶段（default_plan_check、plan_review_lane、plan_review_aggregate、spec_re_review、long_plan_authoring）被塞回主线时回 P4 修正。
- P5 只做机械一致性、并发合法性和 executor seed 编译。
- P5 缺口回 P4 修订。

用户明确要求审查某个 `dispatch_manifest` 时，主代理可把 `plan-checker / plan-review` 作为独立临时审查使用。该审查只产生 finding；主代理采纳后转成 P4 修订输入，不替代 P5、P6 或 P7。

BLOCK IF: 由 P5、P6、P7、修订循环或默认出站自动触发 plan-checker。出口：回 P4 修订、P3 用户确认或 `needs_owner`。
STATE UPDATE: none；临时审查报告只作为普通 evidence，不进入 planning 状态字段。
