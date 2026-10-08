# Pi 0.87.1 Codex 请求身份补丁

0.99.1 隔离版本的构建、载荷与操作步骤见 [README-0.99.1.md](README-0.99.1.md)。管理器按安装版本选择清单；本页保留 0.87.1 生产合同。

全局 Pi 的模块化 SDK 和 CLI/RPC bundle 已安装请求身份、窗口标记及服务端 turn-state 补丁；包含原有 WS 恢复功能。Pi Web 共享该安装，2026-09-27 已在空闲状态重启。子代理独立的 Pi 0.85.1 未迁移此补丁。

上游来源：[PR 9488](https://github.com/earendil-works/pi/pull/9488)，提交 `08fcee62635f3b6179bf131dd8f0d489d04adc64`。该 PR 未合并；本补丁移植到官方 0.87.1 提交 `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`。

## 行为

- 同一用户轮内的工具循环和重试共享请求身份；后续用户轮生成新的 turn ID。
- 压缩成功写入分支后推进窗口编号；失败或取消不推进。
- 保存并回传服务端返回的 `x-codex-turn-state`，处理连接复用及账户、端点变化。
- 比较 WS 增量请求时忽略身份元数据变化；实际提示词、工具或历史内容变化仍按原规则处理。
- 保留 WS 冷却重试、1009 大包恢复门槛和共享诊断计数。模型目录、价格、用户设置和凭据保持原安装值。

协议一致性测试通过不等于缓存命中率提高，也不能证明订阅额度下降由旧协议导致。收益需要补丁后的真实会话比较。

## 维护

```powershell
python tools/pi-codex-attribution/manage.py status
python tools/pi-codex-attribution/manage.py apply
python tools/pi-codex-attribution/manage.py rollback
node tools/pi-codex-attribution/verify-installed.mjs
```

安装包位于 `.runtime/pi-codex-attribution/payload.json.gz`，SHA-256 和 71 个输出文件的前后哈希位于 `manifest.json`。备份位于 `.runtime/pi-codex-attribution/backups/`。管理器拒绝未知安装状态，回滚恢复安装前文件并删除本补丁新增文件。全局 npm 重装后需要重新检查。

既有 WS 管理器可识别组合补丁，`apply` 幂等返回；组合补丁回滚统一使用上述 Python 入口。回滚后需重启 Pi Web 或相关 Pi 进程，`/reload` 不能保证重新加载 SDK 核心模块。

源码补丁为 `pi-0.87.1-attribution.patch`；编译后的 WS 接缝补丁为 `ws-recovery-after-attribution.patch`。候选源码保存在 `tmp/pi-codex-attribution-0871/`。重建顺序：固定源码版本、应用源码补丁、安装锁定依赖、使用对应版本模型数据、编译、向 `packages/ai` 的编译输出应用 WS 接缝补丁、重建 coding-agent bundle。新输出必须重新生成并验证哈希清单，不能沿用旧清单。

## 验证

- 完整 `npm run check` 通过，包括 TypeScript、依赖检查及浏览器导入冒烟。
- 源码协议测试 43 项、代理身份测试 3 项、压缩窗口测试 5 项通过。
- 合并 WS 恢复后的实际编译输出协议测试 40 项通过；恢复状态测试 3 项通过。
- 原 WS 管理器回归 10 项通过（安装前基线）。
- 新管理器隔离验证：安装、重复安装、回滚、重复回滚、未知源码拒写通过。
- 已安装模块本地模拟：三次请求、一次工具调用；同轮身份稳定、下一轮更新，无网络请求。
- Pi Web 重启后健康端点正常，SDK/build 均为 0.87.1，共享全局安装；监听进程由 36292 更换为 9036。

验证日志在 `test-results/pi-codex-attribution-20260927/`。未为本次验证发送真实模型请求，尚无部署后缓存或订阅费用收益结论。
