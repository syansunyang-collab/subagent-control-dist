# explorer-agent / codebase-scan

> 职责：规定 explorer-agent / codebase-scan 能力边界。
> 真源：对应子代理能力的输入契约、判定核心、产物格式和本能力输出字段
> 读取：维护读取

按任务包执行本地代码扫描、结构映射和依赖追踪；扫描工作流、证据状态与 partial 协议由探查族公共层统一规定。

## §1. 输入契约

本能力专属输入在 `task_package.extensions.capability_contract.explorer`：

```yaml
scan_mode: terrain_map | slice_scan
scope_paths: []
focus: structure | dependencies | conventions | concerns | mixed
question: <本次扫描要回答的一句话问题>
depth_limit: <可选；读取预算，空表示覆盖完整 scope_paths>
```

`terrain_map` 把任务包给出的扫描面整理为目录层级、主要文件类型、疑似入口、测试 / 数据 / 输出 / 配置位置、模块边界和后续切片。`slice_scan` 深读任务包给出的明确切片。把 `scope_paths` 逐项绑定到 `scope.read`。

省略 `focus` 时按 `mixed` 扫描；显式值按给定关注面执行。

BLOCK IF: `scan_mode`、`scope_paths` 或 `question` 缺失。出口：任务包正本可唯一修正时修正后重试；否则返回 `needs_owner` 并点名缺口。

## §2. 扫描方法

1. **量化地形**：先读取目录与文件清单，记录文件数、大小和行数估计，再决定读取批次。
2. **选择信号**：按语言、项目结构和 `focus` 使用真实声明、导入、配置、测试和命名模式定位证据；关键词只作入口，不作结论。
3. **按证据深读**：先定位结构入口和引用，再读取支撑 `question` 的片段；为每条发现保存 `file:line`。
4. **追踪关系**：记录入口、调用方、依赖方向、配置来源和数据流，只陈述可观察的文件事实、引用关系、结构现象和明确缺口。
5. **核覆盖**：逐项登记 `scope_paths` 与目标问题的证据状态。

severity 只取 `critical`（阻塞推进、严重 bug 或安全风险）、`warning`（影响可维护性、潜在风险或反模式）、`info`（中性观察、设计选择或历史痕迹）。

跨仓扫描时按目标仓根解释 `scope.read`；报告同时写目标仓根、目标仓相对路径和绝对解析路径，产物仍写任务包指定的 producer 路径。

## §3. 产物与输出

```markdown
# Explorer Report: <question summary>

**Focus:** <focus> ｜ **Question:** <question> ｜ **Files scanned:** N ｜ **Lines read:** M ｜ **Budget:** <used> / <depth_limit>

## TL;DR
- [severity] <发现> - `path/file.ext:line`

## 详细发现
### <主题> (<severity>)
- 位置: `path/file.ext:line`；现象: <文件事实>；上下文: <入口、引用、调用方或数据流>

## 已扫描清单
| 文件 | 读取范围（full 或 Lx-y） | 目标状态 |

## 未覆盖范围
- coverage.scanned: [] / coverage.not_scanned: []
- overflow_reason: depth_limit | truncated | timeout | explicit_uncovered_target | null
- next_focus: 每项含 lane_id、scope_paths、question
```

`FINAL_HANDOFF.output` 补充：

```yaml
coverage: {scanned: [], not_scanned: []}
overflow_reason: null
next_focus: []
target_repo: null
resolved_file_path: null
resolved_handoff_file: null
```

非跨仓时后三项写 `null`；跨仓时填写真实解析值。
