# pi-context-prune（自维护 fork）

Pi 的上下文裁剪扩展：生产使用 `cold-mask`，由程序把可释放的旧工具输出换为短回执，原文可通过 `context_tree_query` 取回；当前不调用摘要模型。自维护 fork 基于上游 `championswimmer/pi-context-prune` 1.4.0（MIT）。

## 部署

- 全局设置 `~/.pi/agent/settings.json` 的 `packages` 只登记一个裁剪包：`C:/Users/67570/.pi/agent/local-packages/pi-context-prune`。路径固定，发版只替换目录内容。
- 当前版本：`1.6.0-local.12-4e44ab4`，`dist/index.js` SHA-256 `85c86db56d8cd49720bd61df777fa5a2b83009b3f82fee094e15fae256311579`。目录内 `BUILD.json` 记录来源提交、分支、构建入口、哈希与配置。
- 构建入口：`policy-lab.ts`（`dist/policy-lab.js`）。当前 `cold-mask` 在下一请求前选择达到预算的已读旧结果，归档原文并换回执；最近两轮、技能/图片和回查结果保留。local.9 对 Codex 请求在成功响应后保存新增已读 ID，reload 后按当前分支恢复。失败、取消和未发送结果不确认。旧历史没有已读记录时先正常读取一次。local.10 起，Pi 上下文用量（`ctx.getContextUsage()`，与 pi-midrun-compact 同一口径）达到模型窗口的 `compactionHoldRatio` 时不再新增裁剪，已有回执照常。
- 配置：`~/.pi/agent/context-prune/policy-lab.json`。当前 `mode=cold-mask`、`stageSummary=false`、全局 `triggerTokens=15000`（2026-09-28 由 6000 调整，依据 [裁剪策略经济回放](../../notes/verify/prune-econ-replay-20260928.md)，清单 `runs/native-pi-runtime-20260813/prune-default-threshold-20260928.json`）、`keepRecentToolTurns=2`、`compactionHoldRatio` 未写入配置而取默认 0.72（压缩线 90% 的 80%，`0` 关闭；依据见回放笔记 2026-09-28 补充，清单 `runs/native-pi-runtime-20260813/prune-compaction-hold-20260928.json`）；会话内用 `/pruner-threshold` 持久化的阈值优先于全局值。`/pruner-threshold` 可即时选择阈值；`/pruner-pause` 暂停新增裁剪并保留已有回执，`/pruner-resume` 恢复，`/pruner-status` 查看状态。配置中的摘要模型与价格线不会在当前关闭摘要的 cold-mask 分支自动执行。旧 `settings.json` 只供 `index.ts` 入口读取。
- 源码：`forks/pi-context-prune/`，独立 Git 仓保留完整历史与已提交 `dist/`；分支 `codex/restore-pruner-seen-state`，远端 `fork=https://github.com/syansunyang-collab/pi-context-prune.git`。插件主仓忽略 `forks/`，维护时在独立仓提交。发布器默认 source 与生产分支已指向此仓；恢复机器时克隆该 fork 并检出所需提交。本机部署来源为 `4e44ab4`。旧 `tmp/context-prune-bench/pi-context-prune-fork/` 保留作历史实验，不用于默认发布。
- 版本存档：`~/.pi/agent/local-packages/pi-context-prune-releases/<版本>-<提交>/`。旧的按日期命名的包目录已移入 `~/.pi/agent/local-packages/_archive/`；`pi-context-prune-budget-20260922` 保留，供 `tmp/prune-native-pair-20260922/work/` 下的对照工作区使用。
- 项目级设置：凡引用了裁剪包的 `.pi/settings.json`，都登记固定路径并设 `"extensions": []`（禁用），自带构建的项目另外启用自己的包。`E:/Workspace/库存盘点` 按其原有设定禁用裁剪。

当前宿主 Pi 0.99.1；Pi Web 共享全局安装。扩展加载器把 `@earendil-works/pi-*` 与 typebox 映射到 Pi 自带副本，包内不声明 peerDependencies。

## local.11–local.12 变更

- 原始 ID 到 Responses wire ID 的对应使用产生调用的 assistant 的 provider/api/model 与目标模型身份；原生 xAI 复合 ID 取 call 部分，跨模型或 provider 的 ID 按 Pi 0.99.1 转换规则匹配。
- xAI Responses 只确认实际 payload 中出现且成功响应后的工具结果；其它 provider 也等待发送钩子与成功响应。失败、取消或无钩子保持未读；记录随分支持久化。
- 配置缺失、读取失败、JSON 语法错误与非法字段在加载入口分别告警；降级为 `cold-mask / stageSummary=false`，不发摘要请求。合法显式 `budget-summary` 继续支持。
- `context_tree_query` 单次调用所有 ref 的归档正文合计最多 16,000 个 UTF-16 单元。`offset` 为 1-based 行号，`charOffset` 为行内 0-based UTF-16 位置；用每个 ref 的 `nextOffset` / `nextCharOffset` 续读，被延后的 ref 单独查询。页尾保留完整 Unicode 码点，剩余预算不足一个码点时延后该 ref；原文与换行格式保留。
- 诊断安装在写目标前记录原副本与来源哈希；部分复制失败的 planned 记录也可回滚，未知第三方改动仍拒绝覆盖。

## 相对上游 1.4.0 的行为差异

| 版本 | 差异 | 对应的故障 |
|---|---|---|
| 1.5.0 | 被裁剪的 toolResult 留一条 `isError: false` 的桩（指向摘要与 `context_tree_query` 的 id），不再整条删除 | 删除后 tool call 不配对：pi-ai `transformMessages` 会补 `No result provided`（`isError: true`），`pi-claude-code-provider` 则把不配对的调用原样发出；模型据此判定工具失效 |
| 1.5.0 | `stopReason` 为 `error` / `aborted` 的 assistant 消息不算最终回复 | provider 503 的空回复触发裁剪，自动重试时当前任务的工具结果已被裁掉 |
| 1.5.0 | `context` 钩子按需从会话重建索引、统计与 frontier | `/reload` 后另一扩展在 `session_start` 内触发新一轮，首个请求未裁剪（单次 55.6 万 token） |
| 1.5.0 | `summarizerMaxCharsPerResult` 配置键与 `/pruner max-chars`；摘要请求带 OpenCode 会话头 | — |
| 1.5.1 | 钩子触发的摘要绑定本轮停止信号 `ctx.signal`，并叠加 180 s 截止；中止或超时的批次保留，下次触发重试 | 摘要进行中停止无效，见 [pi-stop-chain.md](pi-stop-chain.md) |
| 1.5.1 | `build` 与 `check:package` 脚本可在 Windows 的 cmd.exe 下运行 | `rm -rf` 与 `execFileSync("npm")` 使 `npm publish` 在 Windows 失败 |
| 1.5.3–1.6.0-local.3 | 见 fork 的 `CHANGELOG.md` | — |

## 发版与升级

发布工具：`tools/context-prune-release.py`。

```bash
python -B tools/context-prune-release.py status
python -B tools/context-prune-release.py release
python -B tools/context-prune-release.py release --apply
python -B tools/context-prune-release.py rollback <版本>-<提交> --apply
```

1. 在已部署 `BUILD.json` 对应的源码工作副本修改，运行 `npm test`，更新版本与 `CHANGELOG.md`，连同 `dist/` 一起提交。构建产物与对应源码路径一并核对，不混用旧 fork 的输出。
2. `release` 预演要求 `--source`（默认本仓 `forks/pi-context-prune`）是独立 Git 工作树的根目录且工作区干净；默认生产分支为 `codex/restore-pruner-seen-state`，其它分支需显式 `--allow-branch`。入口重新运行 `npm test` 并检查构建后仍干净，再以 `PI_OFFLINE=1` 的 RPC 宿主加载暂存包；无扩展错误且有启动事件才通过。
3. `release --apply`：同样的检查通过后写入版本存档，先为引用了裁剪包但未登记固定路径的项目设置补上禁用项，再替换固定路径的内容，最后才改全局设置；任一步失败，项目仍隔离、全局设置指向的包仍在原位。替换目录中途失败会把旧包放回固定路径，上次中断遗留的旧包在下次发布开始时先复位。改动前的设置文件备份在 `<agent>/backups/context-prune-release-<时间>/`（`<agent>` 为 `PI_CODING_AGENT_DIR`，未设置时 `~/.pi/agent`）。全局设置里没有任何裁剪包时直接追加固定路径；登记的是别的裁剪包路径时，需加 `--replace-global <旧路径>` 显式切换一次；`<旧路径>` 须与 `packages` 里某一项的 source 完全相同，校验在构建之前完成。
4. 已在运行的会话保留原实例，新会话或 `/reload` 后生效。`rollback` 按同样的加载检查把存档版本放回固定路径。

`tools/context-prune-bench/live_ab.py` 的 `production_pruner()` 从全局设置解析生产包，指向固定路径的 `dist/index.js`，无需随版本修改。

## 效果数据

活体 A/B：`openai-codex/gpt-5.6-luna`，每轮同一会话连续解 17 道 SWE-bench Verified Django 题，单提交无历史工作树置于仓外，禁网，会话事后扫描越界读取为 0。口径为含摘要调用的上下文 token。

| 组 | 轮数 | token 中位数 | 解题均值 /17 | 压缩次数 |
|---|---|---|---|---|
| 不裁剪 | 6 | 26.0M | 12.7 | 6 |
| 裁剪，上限 2000 | 6 | 9.6M（−63%） | 11.3 | 0 |
| 裁剪，上限 8000 | 6 | 9.7M（−63%） | 11.7 | 0 |
| 仅 SoL-Pi | 5 | 23.6M（−9%） | 12.2 | 5 |
| 裁剪 8000 + SoL-Pi | 5 | 12.1M（−54%） | 11.8 | 2 |

压缩由 `pi-midrun-compact` 在窗口 90% 处触发（`compaction.enabled=false` 只关掉了 Pi 内置的阈值触发，压缩操作与写手配置照常生效）；不裁剪组六轮中五轮被压缩，共 6 次。

thinking=medium 时裁剪组平均少解约 1 题，差距集中在 16877、16950、16661 三题；逐会话核对显示关键信息仍在上下文内，裁剪组在首次编辑前的调查步数偏少。thinking=high 一轮为 14 / 14 / 13，三题各组全部解出，token 降幅不变。`edit` 失败率各组一致（12–16%）。

Grok 4.6（生产主力模型，xai 直连）同一套 17 题，A = 不裁剪、P = 生产 1.5.2，每轮两组同时跑，high 4 轮 + xhigh 1 轮（2026-09-19）：

| 组 | 解出（high 4 轮） | 解出（xhigh） | 上下文 token 中位数（high） | 费用合计（5 轮，标价） |
|---|---|---|---|---|
| 不裁剪 | 13 / 13 / 12 / 13 | 12 | 3,652 万 | $170.78 |
| 裁剪 | 14 / 13 / 13 / 13 | 13 | 2,310 万（−37%） | $76.16（−55%） |

两组结果不同的 3 处都是裁剪组解出，按事先写定的口径记为未测到质量损失。费用降幅高于 token 降幅，因为 Grok 4.6 单次请求输入达到 20 万 token 时整单按双倍价计，不裁剪组每轮 85–107 次请求越线，裁剪组 0–24 次。Pi 的模型目录只有一档价格，`usage.cost` 会少算越线请求。详见 `notes/general/context-prune-grok-quality-plan.md`。

Luna 的 `edit` 参数空白死循环共出现 5 次，全部在裁剪组，属模型生成退化；openai-codex provider 不发送输出上限，单次调用会跑到驱动器超时。

## 验证入口

| 入口 | 用途 |
|---|---|
| `tools/context-prune-bench/live_ab.py` | 活体 A/B 驱动器（组别 A / B / B8 / C / D / P，P 为生产构建） |
| `tools/context-prune-bench/chain_bench.py` | 依赖链小题集（组别 A / P）：单会话内 6 次埋值、3 次无关提问、6 次追问；4 条链的答案只存在于最初的工具输出（命令每次输出不同，或文件事后被改），其中 1 条的值位于输出 8000 字符之后；2 条允许重读，只记录取回路径。值按 `--seed` 随机 |
| `tools/context-prune-bench/rounds.py` | 按轮次让多组同时跑 `live_ab.py`，按事先写定的口径停止（`STOP` 文件、首轮天花板、会话异常）；须在 Claude 桌面应用进程树之外启动（如 WMI `Win32_Process.Create`），应用包更新会结束它启动的全部进程 |
| `tools/context-prune-bench/batch_report.py` | 汇总一个批次：逐题解出矩阵、token、按标价（含长上下文档）折算的费用、首次编辑前调用数、`edit` 失败 |
| `tools/context-prune-bench/gold_check.py` | 题库体检：逐题打标准答案走同一评分器，判定题目在本机是否可解；多个 git worktree 并行 |
| `tools/context-prune-bench/scan_escapes.py` | 扫描会话中读取答案目录或越出工作树的工具调用 |
| `tmp/context-prune-bench/smoke-stub/smoke8.py` | 裁剪后追问冒烟：模型用 `context_tree_query` 取回原文并答对，无「工具失败」表述 |
| `tmp/context-prune-bench/smoke-stub/abort_latency.py` | 摘要进行中发 `abort` 的延迟：1.5.0 为 3.86 s 且摘要照常写入，1.5.1 为 0.0 s 且批次随后补摘 |

冒烟环境：`USERPROFILE` / `HOME` 指向 `C:\pib\home`（内含强制开启的扩展配置），`PI_CODING_AGENT_DIR=C:\pib\agent-smoke`（只登记本包，`npm` 链接到生产安装目录）。新的 agent 目录没有 `trust.json`，RPC 模式必须带 `--approve`，否则 Pi 在首个 prompt 后静默等待。

## 记录

实际发送诊断由 `tools/context-prune-bench/manage-cache-diag.mjs` 维护，支持 `status`、`install`、`rollback`。日志为 `~/.pi/agent/logs/payload-cache-wire.jsonl`，按请求编号关联裁剪批次、SSE/WS 实际发送及用量；仅写指纹和数字。首次安装后重新载入扩展，后续观测器实现更新需重启持有进程单例的宿主。安装记录不能代替真实发送和费用验收，详见 `notes/verify/pi-cache-miss-diagnosis-20260925.md`。

- 基准报告：`notes/verify/context-prune-benchmark-20260915.md`
- reload 后未裁剪：`notes/verify/context-prune-reload-blowout-20260916.md`
- 孤儿 toolResult 与包来源切换、发版：`notes/verify/context-prune-orphan-toolresult-20260917.md`
- 停止被拖住：`notes/verify/pi-stop-blocked-20260917.md`
- 技能与图像保护：`notes/verify/prune-skill-image-diagnosis-20260921.md`
- 第十条的费用补测：`notes/verify/prune-progress-benefit-20260921.md`
- Luna 四组真实解题对照：`notes/context/prune-luna-real-tasks-20260921.md`
- 原生 Pi Web 对照（Sol / Grok / Luna）：`notes/verify/prune-native-smoke-20260922.md`
- 摘要把上游代码写成本地事实的复现与修复：`notes/verify/prune-summary-provenance-20260923.md`
- 原始数据：`test-results/context-prune-bench/`（不入库）
