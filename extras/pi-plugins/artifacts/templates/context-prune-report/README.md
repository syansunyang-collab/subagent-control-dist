# 上下文裁剪实验报告模板

将现有基准计量填入可独立阅读的 Markdown 报告：先给同题观察，解释各方案，再展示解题效果、上下文负担和费用；运行进度与不同进度的账单单独列示。使用完整方案名称，表格最多四列，指标含义、分母和数量级就近说明。仅处理既有数据，不调用模型，不写实验控制文件。

## 入口与使用

- 渲染器：`scripts/render-context-prune-report.py`。
- 模板：`artifacts/templates/context-prune-report/report.md`。
- 依赖：Python 3.10 以上，标准库，无额外安装。

```bash
python scripts/render-context-prune-report.py --input test-results/context-prune-bench/luna-real-20260921/monitor.json --output test-results/context-prune-bench/luna-real-20260921/reports/current.md --labels artifacts/templates/context-prune-report/luna-strategies.json
```

输入也可使用终态 `comparison.json` 或同结构的详细检查快照。输出为指定 Markdown 及同名 `.snapshot.json`；后者逐字节保存本次输入。使用 `--labels` 时额外保存同名 `.labels.json`，逐字节保留名称、说明与参照配置。输出同名文件会更新，保留历史时使用不同文件名。输入文件不可作为输出路径。

`luna-strategies.json` 对应四臂 Luna 实验；其他实验提供各自的名称说明文件。`strategies` 按条件代码给出 `name`、`description`，`referenceArm` 明确相对变化的参照方案。名称不根据内部编号猜测，未提供说明时明确标注缺失。

生成前核对输入的批次与采集时间；报告不把跨批次、配置不一致的数据自动拼成对照。

## 输入结构

顶层必须有 `runs` 数组，可选 `conditions` 字典列出模型、思考强度和策略参数。`capturedAt` 记录计量采集时间；重排报告不会把整理时间冒充数据时间。名称和参照可直接放在顶层 `strategies`、`referenceArm`，或通过 `--labels` 补充；后者只覆盖显示名称、说明与参照，不覆盖计量数据。

已启动会话使用当前基准字段：

- `run`、`arm`、`repeat`、`status`、`currentTask`、`completed`、`resolved`。
- `main` 和 `summary`：`input`、`output`、`cacheRead`、`cacheWrite`、`cumulativeInput`、`peakInput`、`requests`、`cost`。
- `perTask`：相同题序的 `instance`、`status`、`main`、`totalCost`、`agentSeconds`。`resolved` 与 `unresolved` 均为已评分，`unscored` 和 `not_run` 不进入共同已评分前缀。
- `summaryCalls`、`summaryPending`、`prunedIds`、`totalEquivalentCost`、`providerErrors`、`summaryErrors`、`unknownUsageCalls`、`protectedFailures`。
- 可选 `behavior.compactions`、`behavior.tree_query`、`behavior.recallTextChars` 和 `window`。未提供明细显示“未采集”。

尚未启动会话使用 `run: r<重复号>-<条件代码>` 与 `status: not_started`。本轮条件未全部开始时，不产生不完整条件集合的共同题段比较。模型条件名称来自输入，不根据字母猜测策略含义。

## 计算口径

- 单次与累计输入均包含未缓存输入、缓存读和缓存写。累计输入跨请求相加，不能当作窗口占用。
- 缓存读比例是 token 比例，不是请求命中率；缓存读不会使对应内容退出上下文。
- 输入峰值为实际请求计量峰值。超过本机声明窗口只标注观测，不推断服务端耗尽或发生压缩。
- 主模型与摘要费用分别列出；使用已有 `usage.cost` 的等价估算，保留分档价格效果，不重复乘价，也不再次加收回读成本。
- 裁剪结果数是请求投影里出现收据的不同工具结果数，不是裁剪事件数或净节约 token。
- 共同题段只取同一重复内所有条件都已评分的连续前缀。展示通过数、累计输入、输出、缓存、输入峰值、完整已知费用和交互时间，不用不同进度的全场总量排名。
- 摘要未返回或用量未知时保留提示；没有记录的数据不填成零。

## 验证与维护

```bash
python -m unittest discover -s tests -p test_context_prune_report.py
```

回归覆盖输入/缓存算术、错误解答进入评分、未执行题排除、未启动条件、题序不匹配、未知用量、输入只读、数据与名称快照一致性，以及完整方案名、中文状态、四列以内表格、分母解释和采集时间保真。字段缺失、算术不一致、题序不匹配或输入输出路径冲突返回非零，不静默修正数据。

维护归属为主代理维护的实验报告入口。计量 JSON 接口变化时同步更新模板、渲染器和对应测试。单次报告、数据快照与名称快照保存在 `test-results/`；删除这些输出不影响正在运行的实验或原始计量。
