# 审查与出站

> 职责：规定 S4 审查、S2 / S3 修订、S5 出站与 planner seed 生成。
> 真源：all_surfaces 审查的派发与登记、两轮封顶与裁决、S2 / S3 修订入口、出站、planner seed 生成
> 读取：命中读取

## 1. S4 一次审查

1. 查询：`python -B ops/tools/alignment_recorder.py --phase review --spec <规格书>`，按 `all_surfaces_action` 处理：
   - `dispatch`：派一次 `plan-checker / requirement-granularity-review`，`review_mode: all_surfaces`，一份报告覆盖三面与跨面；任务包 `contract.surface_rounds` 直接取这次跨面查询输出的 `surface_rounds` 字段；第二轮附第一轮报告，只查修没修。
   - `reuse`：沿用已通过的结论，不派。
   - `owner_decision`：两轮用尽，按 §2 交用户裁决。
   - `not_ready`：`missing_preview_surfaces` 所列面尚无 preview，先补。
2. 登记：`python -B ops/tools/alignment_recorder.py --phase bind-review --spec <规格书> --from-report <报告>`，一次登记三面与跨面；通过或已裁决、无未决问题且未暂停时直接写 `planner_allowed`，不新增确认轮。`status: pass` 只表示登记成功，业务结论看各面 `business_verdict`。
3. 读摘要：recorder 透传报告块的 `summary`、`basis`、`unresolved`、`owner_decisions`，先读这四项。`unresolved` 非空或依据与已知事实矛盾时打开对应证据。

## 2. S2 / S3 修订

审查 finding、执行回执或 planning 回流发现规格缺口时，从这里回到对应步：`requirements`、`product_experience` 的缺口回 S2（`stage: product`），`execution` 的缺口回 S3（`stage: solution`）。

1. 按 finding 改 preview 或决策，用 `open-round` 开新轮，草案写 `stage: product` 或 `stage: solution`：改过的 preview 作为新的 preview 项，改过的决定作为新决策项并带 `supersedes: <旧 id>`。向用户说明改什么、为什么、选后影响；用户接受后重新锁定，旧条目由 recorder 改成 `superseded`。
2. 修订改变执行方向时，在重新接受的 preview 的 `decision_source.review_disposition` 写 `direction_rereview`，下一轮审查覆盖该面；措辞与状态调整不写，不复审。
3. `NEEDS_OWNER`：把报告点名的取舍作为必问项开轮，用户裁决后再修订；裁决前不改写、不重派。
4. 同一对象至多两轮审查。第二轮仍非 PASS 时不派第三轮，把两轮的剩余 finding 交用户三选一：

| 选择 | 登记 |
| --- | --- |
| 按现状锁定 | 面：重新接受 preview 时写 `review_disposition: accept_residual_risk`；跨面：`python -B ops/tools/alignment_recorder.py --phase bind-review --spec <规格书> --review-disposition accept_residual_risk --owner-resolution-ref <讨论日志>#round-N` |
| 再改一次，不复审 | 同上，取值 `revise_without_rereview` |
| 暂停 | 下一步记 `pause`，不写 disposition |

失败的 `business_verdict` 保留，不改写成 PASS。修订后重新经过 S4 与 S5。

## 3. S5 出站

WHEN: 三面与跨面最新一轮通过或已裁决，审查摘要里的未解决问题已处理或已由用户裁决，没有 `open` 轮
ACTOR: 主代理
MUST:

1. 读 recorder 返回的审查决策摘要；有问题时回 §2。尚未披露的默认项与推翻代价在此前拍板材料中呈现，新增取舍按 §2 处理。
2. 审查登记、跨面裁决或修订确认满足出站条件时，recorder 直接写 `planner_allowed`。用户说「先看方案、暂不执行」时，在 `answer` 带 `next_step: pause`；没有待答轮时用 `record` 登记 `next_step: pause`。恢复依据用户授权登记下一步，再复用审查登记完成出站。
3. 运行 `python -B ops/tools/alignment_guard.py --context <规格书> --target planner`。

OUTPUT: guard pass 报告；`current_stage: complete`

guard 的出站门禁核对：`open_questions` 为空；三面锁定；每面与跨面最新一轮 PASS，或有用户裁决；PASS 面声明 `direction_rereview` 且仍有轮次时不放行；存在 `tech_route` 决策时成本挑战已通过；没有 `open` 轮。guard 失败时按报出的码回 §1 或 §2 修正，再重跑。

## 4. planner seed

```powershell
python -B ops/tools/alignment_guard.py --context <规格书> `
  --emit-planner-seed tmp/planner-seed.json `
  --phase-id <phase> --phase-goal <阶段目标> --phase-dir .planning/phases/<phase> `
  --write-path .planning/phases/<phase> --format text
```

- 生成器复用 planner guard，通过后写 seed 与同目录 `.guard.json` 报告；seed 直接交 `dispatch_prepare` 派 `planner-agent / plan-authoring`，不重填规格内容。
- phase 信息优先用显式参数。确认轮流程不在状态里记写域，planner 写域用 `--write-path` 指定，可重复；缺失时报 `planner_input_missing`，不生成部分 seed。
- seed 或引用缺失时重跑本命令；规格内容缺口按 §2 修订。
