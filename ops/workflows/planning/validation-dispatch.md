# planning 验收编译与闭环

> 职责：规定 P7 Acceptance Contract 编译、Fleet 验收、Reducer 裁决和定向返工复验。
> 真源：P7 validation_selection、acceptance disposition 与收敛预算闭环的唯一动作表
> 读取：命中读取

## 1. P7 输入

P7 只消费以下已冻结输入：

- `acceptance_contract_ref` 与 P1J pass 结果。
- `dispatch_manifest_ref`，其中每个 lane 的 `validation.requirement_refs` 已通过 dispatch join。
- 当前执行 wave 的 SUMMARY、实际触碰文件和正式产物。lane 的 `validation.implementation_refs` 可列明实际实现文件与正式产物；存在该列表时编译器使用它，否则从写入范围展开。该列表覆盖本 lane 实际改动及待验正式产物，第三方依赖与临时备份通过相关验证证据引用，不把整棵操作写域当作待审源码。验收项、oracle 与覆盖要求保持不变。
- `planning_state.execute_gate.change_base`：变更基线。每轮编译（含返工与全量复验）都以同一个 `--change-base` 传入，代码核验叶据此覆盖基线之后已提交与未提交的全部修改。
- 验收环境就绪：合同 `entry_conditions` 里的 `verify_env`（运行时、驱动、fixture）已按 `provision` 装到 `verify_env.location`（默认目录名为 `.venv`，位于项目的测试结果目录）——`main_agent` 由主代理在编译前直接安装，`executor_lane` 由最后一条实现 lane 顺带安装；叶子任务包的 `driver_command` 指向它，叶子不再自己找驱动。

主代理不根据 diff、文件类型或旧 route 表重新选择 verifier。Acceptance Contract item 的 `route_id` 是主要验证能力，`route_contract` 是其构包输入；任务实际表面与合同不符时回 P1V/P4，不现场换 route。

## 2. 编译与启动验收 DAG

先验证合同到 dispatch 的 traceability，再编译 Fleet manifest：

```powershell
python -B ops/tools/acceptance_contract_check.py `
  --contract notes/manifests/<phase>-acceptance-contract.yaml `
  --dispatch notes/manifests/<phase>-dispatch-manifest.yaml `
  --format json

python -B ops/tools/acceptance_contract_check.py `
  --contract notes/manifests/<phase>-acceptance-contract.yaml `
  --dispatch notes/manifests/<phase>-dispatch-manifest.yaml `
  --compile-fleet notes/manifests/<phase>-acceptance-r1-fleet.json `
  --change-base <execute_gate.change_base> `
  --format json

node ops/tools/fleet_manifest_check.mjs `
  --manifest notes/manifests/<phase>-acceptance-r1-fleet.json `
  --format json
```

checker 负责把实现路径、规格来源、验收项和 route 专属输入合成最小 seed。同一 route 的验收项并入一个叶子（`verify-<route>`），叶子内逐条按各自 oracle 取证并在报告 ```json acceptance_results 块逐条给结论；起服务、开浏览器、读规格只做一次。不同 route 的只读重叠不构成冲突。Fleet 的并发、driver 和恢复按 `subagent-fleet-discipline` playbook 执行。

单 item 合同编译产物只含一个叶子、不挂 reducer：唯一叶子报告即本轮终态，消费按 §3 的 `--leaf-decision-report` 机械转换，归并层对单叶没有增量语义。多 item 合同的最后一个节点固定使用 `verify-agent / acceptance-synthesis`：

- `dependency_policy=all_settled`。
- 先读 scheduler 生成的 dependency result index，再读取存在的正式报告。
- failed、partial、missing 和 uncertainty 都进入归并，不要求主代理在 reducer 前逐叶 accept。
- 输出 `disposition=pass | rework | needs_owner`、失败验收项、确认范围、回归范围和覆盖分区。

## 3. Loop 机械消费

Reducer 完成后，loop 不重读全部叶子报告，只把 reducer report 交给合同工具：

```powershell
python -B ops/tools/acceptance_contract_check.py `
  --contract notes/manifests/<phase>-acceptance-contract.yaml `
  --dispatch notes/manifests/<phase>-dispatch-manifest.yaml `
  --decision-report <reducer-report> `
  --round <当前轮次> `
  --format json
```

单 item 合同（无 reducer）把唯一叶子报告经 `--leaf-decision-report <leaf-report>` 传入，工具机械转换为 reducer 同构 decision 后走同一张消费表；`--compile-followup` 组合同样可用。

**报告来源纪律**：decision / leaf 报告一律从 Fleet run state 中该节点当前绑定 `task_id` 的任务产物获取；节点执行过 `requeued` 时，旧 task 的报告与收据即作废，不得因文件仍存在而消费。同一 slice 出现多份终态收据时以 run state 当前绑定为唯一权威。叶子报告消费默认要求 `--fleet-state <state.json> --leaf-node <node-id>`：工具从 state 当前绑定 `task_id` 反查该 task 运行产物声明的权威报告路径，与被消费报告做规范化精确比较，不符即拒绝（路径包含、调用者断言都不构成来源证据；`--source-task` 仅作交叉断言）。非 Fleet 直跑的叶子报告必须显式传 `--standalone-leaf` 声明，省略绑定参数不构成默认旁路。reducer 的 `--decision-report` 复用同一组来源参数；`--leaf-node` 此时填写 reducer 节点 id。旧 reducer 调用未传绑定参数时仍可消费，但返回 `report_origin.binding=unbound`，不作为 Fleet 来源证明。

只需查看后续动作时，可运行不写 manifest 的预览；实际编译复用同一判断，不要求先单独预览：

```powershell
python -B ops/tools/acceptance_contract_check.py --contract <acceptance-contract> `
  --decision-report <reducer-report> --fleet-state <state.json> --leaf-node <reducer-node> `
  --round <当前轮> --check-convergence --format text
```

按需附 `--previous-decision-report <上一轮报告>` 查看前后未决集。`action` 区分 close、dispatch_rework、repair_reports、escalate 与 reject_invalid_decision；`reason` 点名预算或裁决状态。按业务出口处理后续动作；预览始终不产生 manifest。

Fleet 节点处于 `needs_parent_review` 时，按 `ops/policies/runtime-tools.md` §6 和 Fleet 技能的父级裁决入口处理，使用 `fleet_review` 的 accept/requeue/block 及证据引用。节点重排额度由 scheduler 管理，与下表的业务验收轮次分别计数；不通过修改验收 round 解除节点熔断。

`rework` / `dispatch_rework` 沿用后续工作协议名：仅 failed 项生成产品修复 lane，未取证只补证据。`pass` 需要 blocking 项全部通过且已有通过证据，non_blocking 残余保留在报告；没有 fail 本身不构成通过。

消费规则：

| disposition | loop 动作 | 主代理语义工作 |
| --- | --- | --- |
| `pass` | 写入验收引用并进入 P8 | 无；只核对工具与 Fleet 终态证据存在 |
| `rework` 且未到轮次预算（默认 5 轮） | 用同一工具 `--compile-followup` 生成定向返工、确认验收和 reducer 的下一轮 Fleet DAG，再启动；可附 `--previous-decision-report <上一轮 reducer report>`，输出前后未决集（failed ∪ uncertain ∪ missing）供主代理决定重试策略，未提供历史报告时仍可续跑；只有环境故障或未取证项、没有产品失败时 DAG 不含返工 lane，只对未决项补证据并重新合成 | 按未决集与现场故障决定后续动作，沿用 reducer 的 finding 和原 lane 授权 |
| `needs_owner` 且 coverage.missing 非空 | `action=repair_reports`，由 producer 补齐或修复逐项回执，再重新合成；复用有效证据 | 主代理定位缺失报告或 producer，保持其他项结论 |
| 其余 `needs_owner` | 停止自动推进，将冲突或授权缺口交能处理的一层 | 主代理处理输入、范围与资源问题；只有真实用户取舍才询问用户 |
| 到达轮次预算仍为 `rework` | 工具拒绝生成下一轮，转 `needs_owner` | 决定改规格、扩大 scope、接受风险或停止 |

默认定向复验未决与受影响项，沿用此前未受影响的通过证据。在 oracle 或修改影响确实要求全量复验时，携带上一轮 reducer report 完整编译下一轮；已有通过项也重新取证，输出 `reverified_passed_acceptance_ids` 列明这些项，仍计入轮次预算。存在 `needs_owner` 时先取得所需裁决，把裁决内容落进合同或范围后再编译；`--owner-resolution-ref` 只指向裁决记录、让 `needs_owner` 按定向返工续跑，不代替裁决内容本身：

```powershell
python -B ops/tools/acceptance_contract_check.py `
  --contract notes/manifests/<phase>-acceptance-contract.yaml `
  --dispatch notes/manifests/<phase>-dispatch-manifest.yaml `
  --round 2 `
  --prior-decision-report <reducer-r1-report> `
  --compile-fleet notes/manifests/<phase>-acceptance-r2-fleet.json `
  --change-base <execute_gate.change_base> `
  --format json
```

若例外处理改变 Acceptance Contract、locked decision 或 dispatch scope，回 P1V、P4 或 `ops/workflows/alignment/exit.md` §2 的 S2 / S3 修订，不沿用该入口。

第 1 轮返工编译命令：

```powershell
python -B ops/tools/acceptance_contract_check.py `
  --contract notes/manifests/<phase>-acceptance-contract.yaml `
  --dispatch notes/manifests/<phase>-dispatch-manifest.yaml `
  --decision-report <reducer-r1-report> `
  --fleet-state <state.json> --leaf-node <reducer-node> `
  --round 1 `
  --compile-followup notes/manifests/<phase>-acceptance-r2-fleet.json `
  --change-base <execute_gate.change_base> `
  --format json
```

follow-up DAG 只包含：失败验收项映射到的原 lane 返工、Reducer 点名的确认项（含环境故障与未取证项）、本次修改对应的回归项和下一轮 reducer；复验叶子按 route 和一致的标量合同参数分组，`exclusive_measurement` 项单独成叶并在其他叶终态后独占运行。未受影响的实现 lane 与验收项不重跑，已通过项 carried。复验叶只执行本次修改对应的 cases，复用已有有效证据；同轮叶子复用 `verify_env` 已装好的环境。

## 4. 状态与失败分流

`planning_state.validation_selection` 记录合同、编译 manifest、Fleet run、reducer report、round 和 disposition，不保存叶子报告全文或主代理重算结论。

失败按归属回流：

| 缺口 | 回流 |
| --- | --- |
| 合同漏 requirement、oracle 或 route 输入 | P1V；锁定规格本身缺失时回 S2 / S3 修订 |
| dispatch lane 漏 `requirement_refs` 或无法映射 | P4 修订受影响 fragment/manifest |
| 叶子未运行或未完成取证 | 保持 uncertain，主代理在原授权内定向补证据，保留其他项结果 |
| 逐项结果缺失或格式损坏 | 记录 coverage.missing，producer 补回执后重新合成，复用已有证据 |
| 产品 fail 可在原 lane 写域内修复 | 合同工具生成含修复 lane 的 follow-up DAG |
| 修复需要扩大 scope、改变 validation object 或改 locked decision | `needs_owner`，分别回 P4、P1V 或 S2 / S3 修订 |
| 轮次预算用尽 | `needs_owner`，主代理按现有资源授权处理；新增用户取舍再询问用户 |

运行证据默认留在本轮报告、handoff、Fleet state 和测试结果目录。只有可复用测试、脚本或工具被明确提升为长期资产时，才按 `ops/policies/test-tooling-governance.md` 另行治理。
