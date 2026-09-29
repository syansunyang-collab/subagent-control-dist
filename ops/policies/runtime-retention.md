# 历史运行态清理策略

> 职责：规定本仓运行态、异步任务和任务定位索引的清理边界。
> 真源：历史运行态清理拒删条件
> 读取：命中读取

`runtime_retention.mjs` 只处理声明的四个清理根；默认 dry-run，`--apply` 才删除候选。

## 1. 状态目录

`.runtime/cockpit/state/` 是瞬时运行热区，只提交 `.gitkeep`。其中的 SQLite、JSONL、日志和临时摘要不是长期真源。

## 2. 删除边界

默认可清理：

| 类别 | 路径模式 | 说明 |
| --- | --- | --- |
| 瞬时状态 | `.runtime/cockpit/state/*` | 除 `.gitkeep` 外均为可重建运行态 |
| 终态 async 任务目录 | `.runtime/cockpit/async_tasks/<task_id>/` | `status.json` 的 `state` 为 `done`/`failed`/`cancelled` 且目录 mtime 超 7 天，整目录可删；非终态（`submitted`/`queued`/`running`/`cancel_requested`）一律不清理 |
| 任务定位索引 | `~/.subagent-control/async_task_registry/<task_id>.json` | 只删除指向本仓 task root 且对应任务目录已删除或进入本次清理的记录；其他仓记录不读取为候选 |
| dispatch_prepare 旧任务包 | `tmp/dispatch_prepare/*` | mtime 超 7 天的任务包文件可删；窗口内文件不清理 |

保护项：

- `.runtime/cockpit/state/.gitkeep`
- 所有非终态 async 任务目录
- 不属于本仓 task root 的用户级任务定位索引

指向本仓现存任务目录的 registry 记录若不可读或与 task 实体绑定不一致，precheck 返回失败且本轮不删除任何候选；无法确认归属的其他仓损坏记录保持不动。

## 3. 清理命令

预览：

```powershell
node ops/tools/runtime_retention.mjs --format text
```

执行：

```powershell
node ops/tools/runtime_retention.mjs --apply --format text
```

隔离回归：

```powershell
node ops/tools/runtime_retention.mjs --self-test --format text
```

## 4. 拒收

BLOCK IF:

- 把清理运行态文件写成任务完成证明。出口：改写为清理事实，任务完成仍看交付物、报告和主代理判断。
