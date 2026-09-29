# task-package.md

> 职责：规定任务包协议入口和字段维护归属。
> 真源：任务包协议入口、字段维护索引和运行期构包链路
> 读取：维护读取

本文件是任务包协议入口。任务包字段、route 设计和兼容字段维护只保留在 `ops/protocols/` 体系内。

字段全集由维护期参考提供；本文件面向协议维护者，日常构包使用命中route。

## 运行期规则

运行期按以下路径执行：

1. 主代理判定 role、capability 和 route。
2. 读取命中的 `ops/protocols/task-package-routes/<role>__<capability>.md`。
3. 按该 route 生成完整 `package_seed`。
4. 按宿主调用派发入口：Pi扩展工具 `dispatch_prepare` 或Claude Code用户级 `asyncSubagent` MCP的 `subagent_dispatch`，复用同一编译器与AsyncTaskService。
5. `delivery_mode=async_subagent` 时记录 `task_id`、`status_path`、`handoff_path` 和 `report_path`。
6. 收到回执后，按 route 的接收条件核对能力业务结果，再对照 `task_package.goal` 处理消费和关闭。

完整 `package_seed` 必须在 JSON 根对象提供 `route_id`。`inputs.route_id` 只作为任务输入元数据，不参与 route 选择，不能替代根对象 `route_id`。

route负责提供自足的构包信息；信息不足时用维护期参考修复route，再按修复后的route构包。

## 当前术语

| 名称 | 含义 |
| --- | --- |
| `package_seed` | 主代理按 route 填写的派发种子。 |
| `task_package_envelope` | `dispatch_prepare.mjs` 内部中间产物。 |
| `dispatch_result` | `dispatch_prepare.mjs` 返回的派发结果；MCP async 路线返回 task id 和证据路径。 |
| `spawn_payload` | 旧字段名；MCP async 路线只承载已提交任务的状态/收集提示，不是同步子代理启动材料。 |
| `FINAL_HANDOFF` | 子代理最终结构化回执。 |

## 维护期参考

新增子代理、能力或 route，或者维护任务包字段时，读取以下文件：

- `ops/protocols/task-package-reference/design-guide.md`：如何设计任务包、专用派发规范、回执接收和规则冲突裁决。
- `ops/protocols/task-package-reference/field-dictionary.md`：`task_package` 与 `FINAL_HANDOFF` 全字段含义、值域和兼容字段。
- `ops/protocols/task-package-routes/<role>__<capability>.md`：单个能力的 route 固定包头、seed 合同和接收条件。

这些文件是维护依据。主代理日常构包只读取命中的 route；字段词典和设计指导只在维护字段语义、修 route 或新增能力时读取。

## 退役边界

现行字段及旧别名兼容和拒收规则在 `ops/protocols/task-package-reference/field-dictionary.md`、`ops/tools/dispatch-core/task_package_build.mjs` 和 `ops/tools/dispatch-core/task_package_lint.mjs` 中保留。

## 冲突处理

- `dispatch_prepare.mjs` 失败：按具体错误修 seed、route 或工具合同后重试；无法修复时报告缺口。
