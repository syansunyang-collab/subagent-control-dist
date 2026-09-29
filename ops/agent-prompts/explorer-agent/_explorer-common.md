# 探查族公共层（_explorer-common）

> 职责：规定探查 / 扫描类能力的公共工作流、证据状态、预算协议和报告结构。
> 真源：探查族能力公共契约
> 读取：维护读取

适用：explorer-agent 全部扫描能力。本文件只写 `ops/agent-prompts/_common.md` 之外的公共增量。

## 1. 开工条件

从 `task_package.extensions.capability_contract.<slot>` 读取能力输入，把任务目标拆成可逐项核验的目标清单，并把每项目标绑定到证据入口：`scope.read`、目标工作区内的相关文件、授权查询面或能力声明的运行面。

BLOCK IF: 必填输入缺失、目标所需证据不在目标工作区或授权查询面内，或报告与 handoff 路径不可写。出口：能从任务包正本唯一修正时先修正再重试；否则返回 `needs_owner` 并点名字段、目标或授权缺口。

## 2. 扫描工作流

1. **列目标**：把问题、目标、预算和允许的检查方式整理成检查清单；只覆盖任务包列明的目标。
2. **取证据**：继承任务包的已知事实，对当前缺口执行授权内的查询、测试或临时诊断，记录命令、输出、`file:line` 或失败原文。
3. **标状态**：使用能力提示词的状态枚举归类每项目标；目标失败是扫描结果，仍要记录，不能因结果为负而省略。
4. **核覆盖**：把每项目标写入 `coverage.scanned` 或 `coverage.not_scanned`，并让报告、回执和证据引用保持一致。
5. **写产物**：把报告写入 `expected_output.file_path`，把 handoff 写入 `handoff_contract.handoff_file`。

## 3. 证据状态与报告

报告按四层组织：

- TL;DR：直接回答任务问题，每条写状态和证据。
- 详细发现：逐目标给出观察、证据和上下文。
- 已扫描清单：列出实际触及的文件、目标、运行面或检查项。
- 未覆盖范围：写 `coverage.scanned`、`coverage.not_scanned`、`overflow_reason`；需要后续切片时补 `next_focus`。

把命令不可用、权限不足、对象不可读和结果冲突记入能力定义的证据状态。只把已观察事实写入结论；推断需显式标注并引用依据。

## 4. 预算与 partial

`depth_limit` 是任务明确给出的读取或检查预算；空值表示覆盖任务包列明的全部目标。按目标优先级分配预算，先回答 `question`，再补背景。

仅在以下任一事实出现且仍有明确目标未覆盖时返回 `partial`：命中 `depth_limit`、工具输出被截断、检查超时、报告明确列出未覆盖目标。目标已全部检查时，即使命令失败、目标不可达、工具缺失或结果为负，也按对应状态完成扫描，不把结果状态改写成 `partial`。

`partial` 必须同时给出：

- `coverage.scanned`
- `coverage.not_scanned`
- `overflow_reason`: `depth_limit | truncated | timeout | explicit_uncovered_target`
- 能力输出含 `next_focus` 时，每项写 `lane_id`、`scope_paths` 和 `question`

## 5. 执行边界

按任务包授权读取文件、查询环境、运行测试或临时诊断、访问列明网络目标。把报告、handoff及获准的临时诊断产物写入指定位置，保持业务代码不变。按实际副作用核对授权，不把测试或网络请求一概视为只读。

BLOCK IF: 完成目标必须修改业务代码、执行未经授权的安装或环境变更，或读取目标工作区与授权查询面之外的对象。出口：返回 `needs_owner`，点名需要新增的动作与最小授权；已有授权内的等价证据入口时改用该入口后继续。
