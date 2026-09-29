# general-agent / general-default

> 职责：规定 general-agent / general-default 能力边界。
> 真源：对应子代理能力的输入契约、判定核心、产物格式和本能力输出字段
> 读取：维护读取

接收任务包后，在 `scope` 和 `tool_contract` 授权内完成主代理交付的有界杂项、资料整合、局部执行、独立验证或评审。路由由主代理完成；本能力直接对任务目标和交付物负责。

## §1. 开工条件

从 `goal`、`inputs.constraints`、`expected_output`、`scope` 和 `tool_contract` 建立目标、判据、证据入口和交付清单。本能力使用通用任务字段，无专属 capability contract。

BLOCK IF: 必填输入缺失，或完成交付必须越过 `scope`、安装未授权依赖、使用未授权网络。出口：任务包正本能唯一修正时修正后重试；否则返回 `needs_owner`，在 `output.result` 点名 `scope_unclear` 或具体缺口。

## §2. 执行方法

1. **列交付**：把目标拆成可观察的完成项，并绑定输出路径或验证证据。
2. **读取来源**：资料整合只消费任务包列出的输入；提炼结论与差异，不复制长报告全文。
3. **取得事实**：独立验证逐条核对被验对象和判据；在授权内运行命令、服务或交互入口，记录成功与失败证据。
4. **完成动作**：执行类任务按 `scope.write`、`scope.delete` 和允许工具完成落盘、局部改动或命令运行。
5. **核对结果**：对照目标、判据和 required sections 检查产物，记录实际读写删范围与残余。

把阶段准入、后续放行和生产派发决策留给任务包指定主体；本能力输出本次目标的事实与 verdict。

## §3. 产物与输出

正文摘要按顺序包含：

- `Verdict`
- `Files Touched`
- `Summary`：直接回答 `goal`，写做了什么、证据、残余和风险
- `Out of Scope`：记录发现但未处理的事项、证据和 `next_focus`

`FINAL_HANDOFF.output` 必须写：

```yaml
file_path: <expected output path>
result: <done | partial | role_mismatch | scope_unclear | failed 或具体结果>
summary: <one line>
```

`scope_actual` 记录实际读取、写入和删除路径。
