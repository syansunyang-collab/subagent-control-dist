# incident-containment 止血道

> 职责：规定生产事故与阻塞性故障的受控止血通道：准入、止血循环和转正式跟进。
> 真源：止血道入口谓词、CONTAINMENT_CARD 结构、回滚先行纪律和收口出口
> 读取：命中读取

止血道服务一类任务：已发生的生产事故或阻塞性故障，止损时效优先于完整规格。它用一张 `CONTAINMENT_CARD` 替代规格书；影响面、写域和回滚命令先行登记，止血完成后必须转正式流程回补验证。

## §1. 准入

WHEN: 用户声明生产事故或阻塞性故障（服务不可用、数据持续损坏、构建或交付链路阻塞且影响他人），且明确止损优先于完整流程
ACTOR: 主代理
MUST:

1. 弹窗确认进入止血道，回显四要素：影响面声明（受影响的系统、文件或用户）、最小写域（逐条列出写入对象）、每步动作的回滚手段、止血完成信号（哪个可观察指标恢复算止住）。用户未确认前不得写入；四要素缺任一时补齐后重新弹窗。
2. 影响面说不清、写域列不出，或修复需要在多个实现方案间做设计判断时不入此道：回 `ops/workflows/alignment/WORKFLOW.md` §1 入口判定，或 `pause`。
3. 用户确认后建 `CONTAINMENT_CARD`，建卡后开始止血循环。

OUTPUT: `CONTAINMENT_CARD`
STATE UPDATE: `notes/context/<task>-containment.md`（建卡）

## §2. CONTAINMENT_CARD

卡写入 `notes/context/<task>-containment.md`，是止血道唯一约束物和记录载体：

```yaml
CONTAINMENT_CARD:
  task_slug: <kebab-slug>
  incident: <故障现象与影响面声明>
  success_signal: <哪个可观察指标恢复算止住>
  write_scope:
    - <逐条列出写入对象；仓外对象同列>
  actions: []      # 每轮追加：回滚 → 动作 → 验证 → 结果
  followups: []    # 止血中发现但不属最小止损的问题
  followup_ref: <收口时指向正式跟进登记；未收口为 null>
  status: containing | contained | aborted
```

## §3. 止血循环

每轮 = 登记回滚命令 → 一个最小写动作 → 立即验证 → 记录追加进卡：

```text
- 回滚: <可直接执行的回滚命令> → 动作: <做了什么> → 验证: <观察到的指标变化> → 结果: <止住 / 无效 / 恶化>
```

1. 回滚先行：写动作执行前，该动作的回滚命令必须已登记在卡内且可直接执行；写不出回滚命令的动作不执行，改走 §1 MUST 2 出口。
2. 每步实时验证：动作后立即观察 `success_signal` 相关指标；指标恶化或影响面扩大时，先执行已登记回滚，再决定下一步。
3. scope 纪律：写域外发现的问题（顺手修复、重构、改进）只登记进 `followups`，不动手；动作需要写入 `write_scope` 外对象时，回 §1 重新弹窗确认写域。破坏性动作、外发、系统级依赖照常弹窗，不因止血道豁免。

## §4. 收口

`success_signal` 达成，或影响面扩大、回滚后指标仍恶化、用户叫停时弹窗，两出口：

| 出口 | 动作 |
| --- | --- |
| 转正式跟进 | 指标恢复：本会话内登记正式跟进——回 `ops/workflows/alignment/WORKFLOW.md` §1 按入口判定进入标准规格或任务卡，或经用户确认将跟进目标与待办写入已有任务记录（归属见 `ops/policies/state.md` §0.2）；把该记录的具体路径与条目位置写入 `followup_ref` 后卡 `status: contained`。根因修复、回补测试和止血改动的正式验证在跟进任务中完成。`followup_ref` 为空不得写 `contained`；用户明确拒绝跟进登记时，`followup_ref` 写 `waived: <用户拒绝原话引用>` 后方可 `contained`，卡不得停留在 `containing`。 |
| 止血失败 | 影响面扩大、回滚后指标仍恶化或用户叫停：执行全部已登记回滚，卡 `status: aborted`，收口 `needs_owner` 或交用户裁决。 |

红线：不得以止血名义交付新功能或扩 scope；`followups` 不得在本道内顺手执行；卡不是验收证据，跟进任务照常走正式验证，不得引用卡替代。
