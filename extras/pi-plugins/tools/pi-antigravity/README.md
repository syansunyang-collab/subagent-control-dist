# Pi Antigravity Windows 隐藏窗口补丁

本文件只管上游包的 Windows 补丁（`status/apply/rollback`）。Pi 原生接线（`native-*` 命令、`pi-antigravity-0.10.3-native.patch`、冒烟）见 [`docs/operations/pi-antigravity-native.md`](../../docs/operations/pi-antigravity-native.md)。

## 目的

`@tian.zuo/pi-antigravity@0.9.0`、`0.10.1` 和 `0.10.3` 在 Windows 上以 `detached: true` 启动 `agy`。持续会话中的 `run_command` 因而脱离宿主进程的窗口上下文，每次启动 PowerShell 都可能创建可见窗口。补丁修复 Windows 进程创建方式，保留原有 headless/stream-json 协议。

本地补丁把 5 处 `agy` spawn 统一为：

- Windows 使用 `detached: false` 的等价条件 `process.platform !== "win32"`，并设置 `windowsHide: true`。
- POSIX 保留 detached process group，继续支持 negative-PID tree kill。
- Windows 继续由既有 `taskkill /T` 清理整个进程树。

## 使用

在仓库根目录执行：

```powershell
node tools/pi-antigravity/manage-pi-antigravity.mjs status
node tools/pi-antigravity/manage-pi-antigravity.mjs apply
node tools/pi-antigravity/manage-pi-antigravity.mjs rollback
```

管理器只接受 `@tian.zuo/pi-antigravity@0.9.0`、`0.10.1`、`0.10.3` 五个受管文件的已知 baseline 或 patched SHA-256。`0.9.0/0.10.1` 的五份原始文件逐字节一致；`0.10.3` 的 client、driver 使用独立哈希，其余三份复用旧基线。三个版本使用同一补丁，输入和输出均按目标版本校验。包名、版本、文件哈希或补丁哈希不匹配时拒绝写入；`apply` 和 `rollback` 幂等，写入前按版本和原状态备份到 `.runtime/pi-antigravity-backups/`。

`apply` 后对已运行的 Pi host 执行 `/reload`，使其重新加载 TypeScript extension。新启动的 Pi 进程无需额外操作。

## 运行边界

- 补丁只调整 `agy` 子进程的 Windows 创建方式，不改变模型、权限、工具或会话协议。
- `lib/agy-client.ts`、`lib/agy-diagnostics.ts`、`lib/agy-driver.ts` 和 `lib/usage.ts` 的 spawn 均受保护；`lib/agy-children.ts` 仅同步进程树清理说明。
- npm 更新会覆盖本地补丁。更新后先运行 `status`；若版本和哈希仍受支持，可重新执行 `apply`。未知版本必须重新移植并运行回归，不得强行覆盖。

## 验证

```powershell
node --test tests/pi/pi_antigravity_manager.test.mjs
```

回归覆盖补丁 apply/重复 apply/rollback、五个受管文件的哈希状态、所有 `agy` spawn 的 Windows 参数，以及错误包名、未知版本、版本与源码错配、部分打补丁或陌生源码拒写。设置 `PI_ANTIGRAVITY_TEST_PACKAGE` 可对影子安装运行同一套测试。最终窗口验收需在 `/reload` 后让 Antigravity 连续执行多个 `run_command`，由桌面侧确认无 PowerShell 窗口闪现。
