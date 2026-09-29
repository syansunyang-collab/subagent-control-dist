# 归并波（reducer wave）

> 职责：规定 explorer / 审查类切片 ≥3 时的第二波归并节点——输入各片报告路径，并按是否存在正式验收合同选择证据归并或验收裁决。
> 真源：本文件承载归并波规格；seed 字段、批量冲突检查与提交由 `ops/tools/dispatch_prepare.mjs` 校验。
> 读取：命中读取

## 何时加 reducer

WHEN: 一波 explorer / 审查类切片 ≥3。
MUST: 加一个 reducer 节点作为第二波，把 N 份报告归并成一次可消费的结构化产物；本波全量归并是收口动作，主代理不通读全部原始报告、不进 runtime 目录。
BLOCK IF: explorer / 审查类 ≥3 片却无 reducer。出口：加本节点，或把路数降到 <3。

理由：N 路报告全回主代理自己读，上下文爆掉；有 Acceptance Contract 时 reducer 负责合同内裁决，loop 机械消费；没有正式合同时 reducer 只做证据归并，主代理裁剩余语义。全量归并管覆盖，阶段消费管时效，两者并存不互相替代。

## 节点配置

| 字段 | 确定值 |
| --- | --- |
| `depends_on` | 本波全部 explorer / 审查节点 id（缺一不可） |
| `dependency_artifacts` | Fleet DAG 模式固定为 `["report"]`；scheduler 注入存在的正式 report |
| `dependency_policy` | 使用 checker schema 中的 all-settled 值；等待全部上游终态，不要求业务先通过 |
| `route` | 普通探索归并使用 `general-agent__general-default`；Acceptance Contract 验收固定使用 `verify-agent__acceptance-synthesis` |
| `write_scope` | 普通归并落 `notes/general/`；验收归并落 route 声明的 `notes/verify/` |

### read_scope_layers（只读报告，不重扫源）

```json
{
  "entry": ["<第 1 片 report 路径>", "<第 2 片 report 路径>", "..."],
  "index": [],
  "deep": [],
  "deferred": ["<全部源码与目标仓>"]
}
```

直接批量模式由主代理从上波 `subagent_result` 填入 `entry`。Fleet DAG 模式的 `entry` 可为空；scheduler 放行时先注入依赖结果索引，再追加各上游可用的 durable report。reducer 先读索引，按其中的执行态、业务态、产物态识别缺失输入，再读现有报告。源码与目标仓一律进 `deferred`——reducer 补证靠回指原片证据路径，不自己重扫。

## 普通证据归并输出

reducer 报告落 `notes/general/` 下 `reduce-<run>.md`，四段：

```markdown
# reduce <run>
## 发现合并表        # 维度 | 发现 | 证据路径（回指原片） | 置信
## 冲突标注          # 两片结论矛盾处，各列证据路径，不裁决谁对
## 证据路径清单       # 去重后的关键证据路径，供主代理抽查
## 未覆盖面声明       # goal 的哪些子问题无切片覆盖到，或覆盖不全
```

依赖结果索引中的 `partial / failed / cancelled / missing` 必须进入“发现合并表”或“未覆盖面声明”，不因缺少报告而静默丢片。

普通证据归并不具备已锁 oracle，禁止最终工程裁决、修复动作和重扫源文件；冲突与证据缺口留给主代理定向处理。

## 阶段消费

对已到权威终态的普通探索重点节点，按需取其短摘要、核对关键证据，先交付标注覆盖范围的阶段发现；其余节点继续执行。取回结果的方法见 `ops/skills/subagent-fleet-discipline/references/batch-dispatch-playbook.md` §6 收割验收。

阶段发现只覆盖已核实的局部内容，未终态产物不作完成证据。本波 reducer 仍按 all-settled 依赖全量归并，处理跨片冲突与剩余语义；正式 Acceptance Contract 继续按既有裁决流程处理。阶段消费不要求额外归并任务，也不替代最终收口。

## Acceptance Contract 验收裁决

WHEN: 叶子节点由 `acceptance_contract_check.py --compile-fleet` 生成。
MUST: reducer 使用 `verify-agent__acceptance-synthesis`，逐项覆盖合同 id，输出 checker 声明的 disposition、失败项、确认范围、回归范围和覆盖分区。loop 消费动作只看 `ops/workflows/planning/validation-dispatch.md`。
BLOCK IF: 使用 general-agent 替代验收 reducer、缺结构化 disposition、主代理在 reducer 前后重新归并全部叶子报告，或第 2 轮后自动扩出第 3 轮。

Acceptance reducer 仍禁止：

- 修改被审对象、Acceptance Contract 或 dispatch manifest。
- 新增需求、接受风险、扩大原 lane 写域。
- 绕过 dependency index 重扫源码或历史报告。

## 主代理消费

普通探索按需使用上文「阶段消费」提前交付局部发现。本波 reducer 输出用于全量覆盖与按争议索引抽查，主代理不重复通读全部原始报告。Acceptance reducer 的消费边界与例外出口只看 `ops/workflows/planning/validation-dispatch.md`；全局提交仍由主代理收口（见 `ops/skills/subagent-fleet-discipline/references/harvest-and-audit.md`）。
