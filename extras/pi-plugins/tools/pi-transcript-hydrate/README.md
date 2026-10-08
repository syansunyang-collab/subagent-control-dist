# 自定义 provider transcript hydrate

维护活跃 Antigravity 消费者的 `hydrateContext()` 适配器；默认命令只处理活跃目标。Pi 0.86.0 引入 transcript 接口，本目录现行验收宿主为 Pi 0.99.1。

## 消费者

- `transcript-compat.ts`：Antigravity 使用官方 API 恢复系统提示和工具，保留 transcript 消息。
- `claude-transcript-compat.ts`：legacy Claude 适配器，通过 `normalizeContext` 统一输入、恢复系统提示和工具，并移除适配副本中的 system 消息。原始会话不变，重复转换保留字段及 `onPayload` 修改。`pi-claude-code-provider@0.4.0` 起已在 `provider.ts` 内联恢复，不再消费此文件；旧适配只通过明确指定 target id 启用。

Cursor host 的同名实现由 `tools/pi-cursor-host/src/transcript-compat.ts` 维护，本工具不覆盖 Cursor host，也不为新版 Claude 安装旧 helper。

## 运维入口（Pi 0.99.1）

仓库根目录执行；先检查目标，再更新和核验：

```powershell
node tools/pi-transcript-hydrate/apply.mjs status
node tools/pi-transcript-hydrate/apply.mjs apply
node tools/pi-transcript-hydrate/apply.mjs verify
```

定向维护活跃 Antigravity（与默认集合一致）：

```powershell
node tools/pi-transcript-hydrate/apply.mjs status --target @tian.zuo/pi-antigravity
node tools/pi-transcript-hydrate/apply.mjs apply --target @tian.zuo/pi-antigravity
node tools/pi-transcript-hydrate/apply.mjs verify --target @tian.zuo/pi-antigravity
```

仅旧版 Claude 且仍有 helper 调用点时使用显式 legacy 目标：

```powershell
node tools/pi-transcript-hydrate/apply.mjs status --target pi-claude-code-provider
node tools/pi-transcript-hydrate/apply.mjs apply --target pi-claude-code-provider
node tools/pi-transcript-hydrate/apply.mjs verify --target pi-claude-code-provider
```

`--target <id>` 可重复指定。默认目标目录是用户级 Pi npm 目录。`apply` 仅在目标已有 `hydrateContext` 引用时覆盖 `src/transcript-compat.ts`（Claude 检查 provider 与 serializer，Antigravity 检查 provider）。缺包或缺 hook 都非零退出，不跳过损坏的活跃目标；新版 Claude 缺 hook 时，显式 legacy apply 同样拒绝。覆盖前备份至 `.runtime/pi-transcript-hydrate-backups/`。

Pi 0.99.1 的 `pi update` 可能覆盖未钉版本的 npm 包源码。升级后先 `status`：仍有 hook 则 `apply`；调用点发生变化时先移植适配；上游已原生恢复时从活跃目标中退役该消费者，不写入旧 helper。

## 验证

```powershell
node --test tests/pi/transcript_hydrate.test.mjs tests/pi/claude_transcript_compat.test.mjs
node tools/pi-transcript-hydrate/apply.mjs verify
```

集成测试使用本机 Pi 0.99.1 SDK、jiti 和 Claude provider 源码；可用 `PI_TEST_SDK_ROOT`、`PI_TEST_CLAUDE_PROVIDER_ROOT` 指定位置。测试复制 provider 到临时目录，核对低层 serializer 的输入契约及原生恢复、会话 cwd、`onPayload`，在 Claude 进程启动前截停，不调用订阅模型。夹具与请求目录在结束时清理。

这些测试不替代真实 Claude Code / Antigravity 请求。安装副本更新后需 `/reload` 或重新启动实例。
