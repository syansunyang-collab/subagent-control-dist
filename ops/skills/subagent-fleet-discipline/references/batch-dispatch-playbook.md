# 批量派发剧本

> 职责：规定舰队作业从侦察到收割的端到端操作序列与命令形态。
> 真源：本文件只承载舰队操作序列；构包字段与 route 契约的真源是 `node ops/tools/dispatch_prepare.mjs --seed-template <route_id>` 与对应 route 卡
> 读取：命中读取

## 全程七步

侦察 → 切片 → 批量构包 → 一次派发 → 并行推进 → 收割验收 → 合并收口。每步的产物是下一步的输入。

## 1. 侦察

列出全部候选工作面、每个工作面的可写文件集合、共享文件（契约层、状态层、地图层）。侦察本身可以先派扫描档切片完成——舰队作业经常是两波：第一波只读侦察，第二波按侦察结果切片实施。

## 2. 切片

按 `ops/skills/subagent-fleet-discipline/references/parallel-slicing.md` 切片并形成 `FLEET_PLAN`。每个切片确定：route（角色即档位）、goal（单一有界目标）、读集、写集、验收命令。

## 3. 批量构包与派发

本节只处理经 `ops/skills/subagent-fleet-discipline/references/fleet-dag-import-test-playbook.md`「入场边界」判定为直接批次的节点；命中 Fleet DAG 时离开本剧本。

每个切片使用 `--seed-template <route_id>` 取得 seed 骨架；同波切片组成一个 JSON 数组。数组可以混用 route，`dispatch_prepare.mjs` 在写任务材料前检查全部写域冲突。

```powershell
@'
[
  {"route_id":"explorer-agent__codebase-scan","goal":"扫描入口","scope":{"read":["AGENTS.md"]},"contract":{"scan_mode":"slice_scan","focus":"structure","question":"入口如何路由"},"slug":"entry-scan"},
  {"route_id":"explorer-agent__codebase-scan","goal":"扫描工具","scope":{"read":["ops/tools/"]},"contract":{"scan_mode":"slice_scan","focus":"structure","question":"工具如何派发"},"slug":"tool-scan"}
]
'@ | node ops/tools/dispatch_prepare.mjs --seed-stdin
```

默认文本回显每任务一段（状态行 + `ASYNC_CODEX_TASK_ID` + 等待 / 回执指引）；`--format json` 只给脚本消费。批量返回的 `batch_id` 是 UI 分组键；`committed_task_ids` 是已提交任务账本；`failed_seed_indexes` 只标出失败切片。结果为 `partial` 时只修复并重发失败 seed，不重发已提交任务。本剧本不承载跨波依赖；需要下游自动消费上游产物时在派发前改用 Fleet DAG。

## 4. 批次观察

成功派发会自动启动或复用本仓 Agent Panel。需要手动恢复界面时运行：

```powershell
node ops/tools/agent_panel_launcher.mjs
```

Agent Panel 投影 AsyncTaskService 与 Fleet 状态；它不提交、重派、裁决审查或直接修改任务状态。单任务停止继续使用 `task_id + expected_revision` CAS，模型配置写入使用自身白名单和文件 revision CAS。

## 5. 并行推进

批量派发后按优先级做：主代理自留的串行批（共享文件、契约层）；下游 seed 的准备；验收入口的整理。手上若有会污染在飞切片验收面的落盘动作，暂停到该切片收割完成。

派发后转身干上面的活。正常完成由 completion notice 驱动；通知到达后按 task_id 消费一次 `subagent_result`。没有完成通知时保持任务在飞，继续非冲突工作。

用户查询状态或出现通知、运行异常时，读取相关任务状态。没有可推进工作时等待完成通知。

## 6. 收割验收

任务进入终态（done / failed / cancelled）即可收，先完成先收，不攒批：

1. MCP `subagent_result` 收一次终态摘要与 durable artifact pointer；摘要足够时不打开报告，摘要不足时只读点名产物。
2. 复用工具返回的机械检查结果和 canonical handoff；运输副本用于定位，不替代正式产物。
3. 结合实际修改与已有证据判断结果，只补查具体缺口。核验判据与事故对照见 `ops/skills/subagent-fleet-discipline/references/harvest-and-audit.md`。

主代理按通知给出的可用入口取得结果或 diagnostic，结合任务目标、实际进展和已有产物决定下一步。恢复合同以 `ops/policies/runtime-tools.md` §6 为准：取消使用最近 revision 和真实的非空原因，用户停止意图以 user_requested 保留；请求已接受不代表执行已停止。确认旧执行停止后，读取实际 resumable 与会话入口，决定显式续跑或补做剩余工作。续跑前核对磁盘改动，复用已经完成的成果；静默通知只触发重新观察。

## 7. 合并收口

全部切片收割后，主代理结合各片结果确认本次修改达到目标并按批提交。复用有效证据，测试验证范围限于本次修改；具体疑点按 `ops/skills/subagent-fleet-discipline/references/harvest-and-audit.md` 处理。
