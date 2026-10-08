# Pi 压缩写手运维手册

结论：现行维护入口是本地包目录 `pi-compaction-model-recovery`（`package.json` 的 `name` 为 `pi-compaction-model`，版本 `0.1.0-local.1`）。用户级 `compactionModel.model` 为 `openai-codex/gpt-6-luna-fast-700k`，`thinkingLevel` 为 `xhigh`；`reserveTokens=65536`。字段全文见第 1 节。源码在控制仓 `E:/ControlPlane/control_0827/adapters/pi/user-addons/agent/local-packages/pi-compaction-model-recovery/`。要求 Pi 0.86.0 或更新版本。已有会话需 `/reload` 才加载新代码。2026-09-11 的 DeepSeek 选型记在第 3 节，作为历史回放保留。

## 1. 机制要点与现行配置

机制行号摘自 pi-coding-agent 0.85.1。本机宿主为 Pi 0.99.1，行号未在 0.99.1 复核。

- 摘要请求输出上限 `maxTokens = min(floor(0.8 × reserveTokens), model.maxTokens)`；split-turn 前缀摘要为 `floor(0.5 × reserveTokens)`（`dist/core/compaction/compaction.js:489/651`）。
- 上游返回 `stopReason=length` 时整条摘要作废、不写入 compaction 条目（同文件 `getSummarizationFailure`）。因此 `reserveTokens` 过小会使大体量压缩直接失败而非得到截短摘要。
- 序列化时 tool result 截 2000 字符（`utils.js` `TOOL_RESULT_MAX_CHARS`）；历史摘要用六段提示词（Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context），split-turn 前缀摘要用三栏提示词（Original Request / Early Progress / Context for Suffix）。
- 成文后由 `computeFileLists` 机械附加 `<read-files>/<modified-files>` 清单；比较写手成文量时应扣除该清单。
- 原生触发（`compaction.enabled=true` 时）：`contextTokens > contextWindow - reserveTokens`。本机 `enabled=false`，实际触发由 `pi-midrun-compact` 在 `thresholdPercent=90` 处发起，记为 reason `manual`，仍走 `compactionModel` 专用写手。

现行部署配置（2026-10-03 读取 `C:/Users/67570/.pi/agent/settings.json`）：

```json
"compaction": { "enabled": false, "reserveTokens": 65536 },
"compactionModel": {
  "model": "openai-codex/gpt-6-luna-fast-700k",
  "thinkingLevel": "xhigh",
  "reasons": ["manual", "threshold", "overflow"]
}
```

未配置 `fallbackModel`。配置在长驻 Pi host 启动或 `/reload` 时加载。`packages` 中的写手条目为 `C:/Users/67570/.pi/agent/local-packages/pi-compaction-model-recovery`。

`reserveTokens=65536` 在 2026-09-11 回放中对应摘要 `max_tokens=52428`；当时 max 档最大输出为 27272 tokens（case1 J 臂）。该观测属于第 3 节历史回放。

## 2. 本地插件、恢复与日志

维护入口只保留本地包 `pi-compaction-model-recovery`。源码与安装路径、现行 `compactionModel` 见第 1 节。不在 npm 包 `pi-compaction-model` 上打补丁，也不把 npm 更新后的文件重贴进该目录。

- 主写手与副写手的摘要调用均传入 `{enabled:true,maxRetries:2,baseDelayMs:2000,maxAgentDelayMs:10000}`。瞬时断流、限流和服务端错误按 Pi 既有分类重试；配额耗尽、鉴权失败、输出截断进入下一级。split-turn 的正文与前缀摘要各自使用该重试预算。
- 用户中止不换路、不写成功摘要。最终主模型沿用 Pi 原生鉴权、请求变换与重试策略。
- 模型 provider 为 `opencode-go` 时，请求写入当前 Pi 会话 ID 作为 `x-opencode-session`，附带 `x-opencode-client: pi`。sessionId 传给原生 `compact()`。现行型号的 provider 是 `openai-codex`。
- 日志为 `~/.pi/agent/logs/compaction/<sessionId>.jsonl`，每轮有独立 runId。记录开始、写手开始、重试调度、重试结果、写手成功或失败、主模型兜底和最终结果，包含模型、触发原因、耗时与可用的 usage。不记录提示词、摘要正文和密钥。最终主模型的内部重试仍由宿主处理，本日志记录该级的开始与最终结果。
- 成功的插件摘要在 `details.compactionRoute` 留下 runId、stage、model；原有 readFiles/modifiedFiles 保持传递。日志写入故障不阻断压缩。
- 模型目录须能解析 `openai-codex/gpt-6-luna-fast-700k`。2026-09-11 回放使用的 `opencode-go/deepseek-v4.1-flash` 与 `opencode-go/glm-5.3-flash` 属于第 3 节历史选型。

## 3. 写手与档位对比结论（2026-09-11 历史）

三案冻结切点（真实会话：迭代更新 298k tokens / 纯 split-turn 261k / 模板漂移 252k），统一 `reserveTokens=131072`（`max_tokens=104857`，对全部臂不咬），每案 4 臂并行。证据全文：`notes/verify/compaction-v4f-v41f-high-max-20260911.md`；数据：`test-results/compaction-quality-20260911-4arm/`。

- 机械项无区分度：三案模板齐全度一致（split-turn 案 0/6 为三栏提示词的预期形态）、均无回灌原文、关键 hash 召回相同（case1 62/63、case3 7/7）。
- high vs max：max 耗时 2–4 倍（case3 的 V4F-max 单次 255.5s）、费用高 15–30%，质量无稳定优势。max 档独有收益是保留开放异常（V4.1F-max 保留了「README 四路由 vs 实际五条」「五工具文档沿革」两处待办），但伴随 V4F-max 的语言漂移（中文会话产出英文摘要）与单次 `reasoning=0` 异常。
- V4F vs V4.1F：同档基本持平；max 档 V4.1F 更稳（无语言漂移、耗时更短）；high 档 V4.1F 在迭代案的 Next Steps 粒度更全。
- V4F 经 opencode-go 的路由存在不稳定：case3 同臂四次运行中两次（2026-09-11 18:24 与 22:23 UTC+8）`reasoning=0` 且 input 计数偏移 +132（131433 vs 131301），与两次正常路由完美相关；异常路由更慢（125–256s vs 81–95s）。V4.1F 七次调用（case1–case4 + 两次探针）无一次异常，reasoning 全部生效并上报。两种路由下摘要文本均六段合规（异常路由的一份已全本阅读，质量合格），但 max 档的思考溢价在异常路由上未生效。复议写手时将此计入（DEBT-0018）。
- 2026-09-11 22:48 UTC+8 的选型决定：当时活体写手切换为 `opencode-go/deepseek-v4.1-flash` + `thinkingLevel=max`。该选型是历史记录。现行型号以第 1 节 `settings.json` 为准。剔除异常路由后两臂直比（V4F max 5 次 / V4.1F max 6 次）：平均耗时 76.8s vs 69.4s、平均费用 $0.0251 vs $0.0264、摘要质量同档（case2/case3 全本验证）；决定性差异为路由稳定性（V4F 当日 2/4 异常且 reasoning 丢失，V4.1F 0/7 全正常）与配额（V4.1F 为 V4F 两倍）。
- 同臂同案重复运行存在显著方差（V4F-max 的 split-turn 案两次成文 7830 vs 12004 字符）；单次运行的字符数与耗时只作量级参考。

## 4. 复现与维护

回放工具：`tools/compaction-replay.mjs`，子命令 `prepare | run | score`，不改写 settings.json、源会话或活体 Pi 状态；输出到 `--out` 指定目录（须为忽略目录）。臂定义含 `provider/modelId/thinkingLevel/reserveTokens`；`reserveTokens` 臂级覆盖经 `compact()` 的 `preparation.settings` 生效。

```bash
# 构造样本并核对切点（firstKeptMatch 须为 true）
node tools/compaction-replay.mjs prepare --cases 1,2,3 --out test-results/<dir>
# 跑臂（案内并行；opencode-go 臂自动注入 x-opencode-session 头）
node tools/compaction-replay.mjs run --cases 1,2,3 --arms I,J,K,L --out test-results/<dir>
# 机械项记分
node tools/compaction-replay.mjs score --cases 1,2,3 --out test-results/<dir>
```

样本切点定义在脚本 `CASES` 常量：case1 `2026-08-07T21-19-16…66c0.jsonl` @ 2026-08-12 01:53:59 UTC+8、case2 `2026-08-12T15-30-07…16ce.jsonl` @ 2026-08-12 23:41:31 UTC+8、case3 `pi-web-sessions/2026-08-15T18-32-33…d4.jsonl` @ 2026-08-16 02:02:01 UTC+8。

恢复链回归在控制仓：`node --test tests/pi/compaction_recovery.test.mjs`。覆盖主写手成功、瞬时失败恢复、重试耗尽转副手、副手自身重试、鉴权/额度/输出截断换路、模型缺失、主模型兜底及最终失败、用户中止、日志脱敏和文件清单继承。测试使用合成会话与模拟网络，不改生产设置，不产生模型费用。依赖本机 Pi 运行时及其自带的 jiti；`PI_TEST_ROOT` 可指定 Pi 内核目录。故障回归和真实副手换路的合成样本证据位于 `notes/verify/compaction-recovery-evidence/`。

升级 Pi 后先跑上述回归，再做合成摘要冒烟。真实长上下文回放继续使用本节的 prepare/run/score；HTTP 400 `MissingSessionID` 表示会话请求头接线异常。

## 5. 边界与未覆盖

- 对比基于三个历史切点 + 一个活体会话快照（195k tokens，2026-09-11 19:58 UTC+8 冻结），每格一次运行；活体快照案显示四臂均可能把切点附近的状态推进回退为旧状态（被摘要区域尾部的最新进展未入摘要），续跑时应以保留尾部消息为准调和。
- 未覆盖真实 midrun 压缩（由活体 host 触发并写回会话）本身、连续多轮摘要链式更新、OpenCode 侧 generation 日志与上游 `finish_reason` 原文。
- 配额与用量已于 2026-09-11 20:15 UTC+8 以 OpenCode Go 用量页实测（证据 `test-results/compaction-quality-20260911-live/opencode-go-quota-20260911.png`）：**引导文件转述的限额（V4.1F $15 / V4F $30 每月）与实际相反且偏低**——实测 V4F 配额 $6 / $15 / $30（5 小时 / 周 / 月），V4.1F 为 $12 / $30 / $60，全面为 V4F 的两倍；当日用量 V4F $0.5148、V4.1F $0.3262（含本批实验），月用量占比 1.7% / 0.6%。配额为订阅时点数据，可能随套餐调整。峰值时段目录价（输入 0.30 / 输出 1.20 每百万 token）仍未独立核实。
- 活体快照案另揭示：摘要会原样继承上下文中的错误表述（GIGO），写手质量无法弥补上游事实错误。
- 写手恢复实现的版本真源为控制仓 `E:/ControlPlane/control_0827`；本机发布副本不得替代仓内源码。副手的接口冒烟不等于 500k 长上下文质量验收。
