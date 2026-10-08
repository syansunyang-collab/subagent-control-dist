# 长历史裁剪缓存回放

一次性写入长历史后改写中段，可在 Luna、Sol、Astra medium 上复现短前缀回退。预先单独请求保留前缀可改善本材料的裁后命中；历史已经增长后临时补预热，Sol 对照两步费用反而增加 9.8%，不作为生产省钱方案。完整结论、生产关联与修复边界见 [定位记录](../../../notes/verify/pi-cache-miss-diagnosis-20260925.md)。

## 运行条件

- Windows、Node 24、Pi 0.87.1；使用当前用户已授权的 Pi Codex 订阅登录。
- `on` 使用全局模块化 provider；`off` 使用 `wire-diag/prepare-pair.py` 已生成的同版本隔离副本。全局运行时不发生切换。
- 复用 `wire-diag/probe.mjs` 记录最终 WebSocket 帧指纹和连接。请求正文、凭据和响应原文不落盘。
- 工具历史为固定合成材料，工具不会执行；每次只回复 `OK`。主实验约 90.8K 输入，替换 20 个旧工具结果，实际释放 17.6K。
- 每次运行使用独立 nonce 和会话，首请求必须为冷缓存；同组设置保持不变。每个模型请求顺序执行。

## 阶段

`bulk`：整段预热 → 增量追加 → 同内容全量重发 → 中段替换 → 替换后重复 → 增量继续。

`seeded`：先独立请求保留前缀，再执行与 `bulk` 相同的六阶段。种子响应不加入长历史，实际长请求材料结构保持一致；nonce 引起几个 token 的差异。

`late-seeded`：先完成 `bulk` 前三阶段，再独立请求保留前缀，最后执行裁剪和后续两阶段。前缀响应不进入主历史；裁剪的 `firstDiff` 明确以 `full-control` 为比较对象。计费汇总包含额外预热的完整费用。

## 命令

从仓库根目录执行。已有标签拒绝覆盖；重新运行会产生新的模型用量。

```powershell
node tools/context-prune-bench/cache-replay-20260927/production.mjs
node tools/context-prune-bench/cache-replay-20260927/align-prewarm.mjs
node tools/context-prune-bench/cache-replay-20260927/reload-check.mjs --fixed
node tools/context-prune-bench/cache-replay-20260927/verify-seen-native.mjs
python tools/context-prune-bench/cache-replay-20260927/analyze.py

# 以下命令产生模型请求，标签必须唯一。
node tools/context-prune-bench/cache-replay-20260927/run.mjs --model gpt-6-luna --mode bulk --scale 0.25 --label new-luna-smoke
node tools/context-prune-bench/cache-replay-20260927/run.mjs --model gpt-6-sol --mode bulk --label new-sol-bulk
node tools/context-prune-bench/cache-replay-20260927/run.mjs --model gpt-6-sol --mode seeded --label new-sol-seeded
node tools/context-prune-bench/cache-replay-20260927/run.mjs --model gpt-6-sol --mode late-seeded --label new-sol-late-seeded
node tools/context-prune-bench/cache-replay-20260927/run.mjs --model gpt-6-sol --mode bulk --patch off --label new-sol-off
node tools/context-prune-bench/cache-replay-20260927/run.mjs --model gpt-6-astra --effort medium --mode seeded --label new-astra-seeded
```

证据位于 `test-results/cache-replay-20260927/`。`production-audit.json` 是带限制说明的历史结构重建；各运行 JSONL 是真实请求指纹、用量和验证数据；`summary.json` 由分析器计算。

`align-prewarm.mjs` 复用生产 `1.6.0-local.8` 来源目录 `tmp/context-prune-pause-fix/dist/lab-exports.js` 的纯候选规则，核对真实两刀之间能否提前确定相同保留前缀。输出 `production-prewarm-alignment.json`，不产生模型请求，也不测量预热收益。

计费金额使用 Pi 当时模型表；不等于订阅点数。回本次数固定后续材料，采用输入费用，假定没有再次裁剪、回读、背景失配或整体压缩。生产质量和长期收益需另行验证。

第一轮 `luna-smoke-bulk` 已发出 1 个请求，但记录器对空字段求哈希失败，未保存响应用量；保留为不完整运行。修复后 `luna-smoke-bulk-v2` 完成六阶段，该旧缺口未补造数值。

## 订阅能力探针

Luna/Sol 当前订阅入口拒绝 `prompt_cache_options` 与 `prompt_cache_breakpoint`。WebSocket `generate:false` 可返回零输出，但 Sol 22.8K 对照在全量和响应 ID 续接中均未让随后正式请求命中缓存；普通生成正对照命中 22,656。当前候选不部署。

`capabilities.mjs` 使用隔离会话和合成输入，保存出站字段、连接、原始数字 usage、错误类别；不执行工具。以下命令只供复现，运行会产生真实请求：

```powershell
node tools/context-prune-bench/cache-replay-20260927/capabilities.mjs --model gpt-6-luna --cases baseline,prewarm,explicit,marker-only --label new-luna-capabilities
node tools/context-prune-bench/cache-replay-20260927/capabilities.mjs --model gpt-6-sol --cases baseline,ws-warmup,ws-warmup-chain --repeats 3 --lines 1400 --gap-ms 5000 --label new-sol-ws
```

`ws-warmup` 首次发送 `generate:false`，其余重复为完整正常生成；`ws-warmup-chain` 第二次使用首次响应 ID 加空增量，第三次恢复完整正常生成。各组首请求隔离；同组材料不变，正常输出不追加到材料。`analyze.py` 将这些记录单列为 `capability-summary.json`，不会混入 77 个长历史请求。无输出请求的 token 折算不等于确认计费，字段拒绝而未返回 usage 的请求也不按实扣零处理。

`reload-check.mjs` 校验现有测试 bundle 与生产安装包哈希一致后，借助假宿主对照完整插件 reload 前后的裁剪资格。旧版记录为 `reload-check.json`；local.9 使用 `--fixed`，生成 `reload-check-fixed.json`，要求 reload 不再使已确认结果多发一次。不发送模型请求、不修改生产；字符差额不作为 token 或费用。

`verify-seen-native.mjs` 使用全局 Pi 0.87.1 SDK、正式扩展加载器和 Codex provider，以本地 HTTP 模拟及假凭据验证两个请求与中间 reload。默认检查源码构建；可传安装包的 `dist/index.js` 路径复验部署，旧版对照在路径后追加 `legacy`。网络请求数为 0；原始材料仅含合成字符串。
