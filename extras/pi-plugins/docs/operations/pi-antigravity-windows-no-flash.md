# Pi Antigravity Windows 无闪窗补丁运维文档

> 状态：accepted；机制与多版本证据基准：2026-09-11；升级后恢复复验：2026-09-20（UTC+8）。
> 读者：维护本机 Pi 扩展和补丁的工程师与 agents。

## 结论、适用边界与补丁提交

本补丁修复 `@tian.zuo/pi-antigravity` 在 Windows 上启动 `agy` 时无条件 `detached: true` 导致的 PowerShell 可见窗口闪现。Windows 使用 `detached: false` 与 `windowsHide: true`，POSIX 保留 detached process group；Windows 进程树仍由 `taskkill /T` 清理。

截至上述基准日期，管理器支持 `0.9.0`、`0.10.1`、`0.10.3`；后续支持范围以管理器为准。源码真源位于 `tools/pi-antigravity/`，修复提交为 `7aac874`。管理器按包名、版本、补丁 SHA-256 及五个受管文件的 baseline/patched SHA-256 校验输入和输出，未知版本或陌生源码不得强行覆盖。

本变更只影响 `agy` 子进程的 Windows 创建方式，不改变模型、权限、工具合同、headless/stream-json 协议或配置。README 保留近场用法；本文件是完整的长期运维入口。

## 启动链路及headless误判澄清

Pi 的 Antigravity extension 启动 `agy`，`agy` 再为 `run_command` 创建 PowerShell。原先所有平台均 detached；Windows 因此脱离宿主窗口上下文，孙进程可能创建可见控制台窗口。`windowsHide: true` 不是对子孙进程统一隐藏的保证，不能单独作为修复。

headless 与窗口创建是两个层次：已有 headless/stream-json 参数和协议保持不变；问题在 Windows 的进程创建上下文，不是把 headless 请求误判为交互式请求。`agy-client.ts`、`agy-diagnostics.ts`、`agy-driver.ts`、`usage.ts` 的相关 spawn 采用平台条件；`agy-children.ts` 只同步清理语义说明。

## 补丁包文件职责、默认安装路径和备份边界

- `tools/pi-antigravity/pi-antigravity-0.9.0-windows-no-flash.patch`：五个源码文件的共享补丁，0.9.0、0.10.1、0.10.3 均复用；0.10.3 的 client、driver 使用版本专属哈希。
- `tools/pi-antigravity/manage-pi-antigravity.mjs`：执行 `status`、`apply`、`rollback`，验证包身份、版本、五文件状态及转换后哈希，并保证幂等和失败恢复。
- `tools/pi-antigravity/README.md`：提供包内近场用法；本操作文档承接完整维护流程和证据导航。
- `tests/pi/pi_antigravity_manager.test.mjs`：覆盖管理器往返、参数检查和拒写场景。

默认安装目录为 `%USERPROFILE%\.pi\agent\npm\node_modules\@tian.zuo\pi-antigravity`。依赖为 Windows、Node.js、Git（管理器调用 `git apply`）；真实命令复验还需已认证的 agy CLI 和可用 Pi。使用 `--target <package-directory>` 可对影子副本检查或测试，不会改变默认安装。

管理器写入前将原文件备份到仓库根目录 `.runtime/pi-antigravity-backups/<version>/<source-state>/`，同一备份存在时不覆盖。备份边界仅为五个受管文件；不备份或修改其他 npm 文件、配置、权限和 Pi 状态。

## 检查、应用、回滚与旧host重新加载

在仓库根目录执行：

```powershell
# 只读检查；patched 时退出 0
node tools/pi-antigravity/manage-pi-antigravity.mjs status --json

# 安装为已知 baseline 时应用；随后再次检查
node tools/pi-antigravity/manage-pi-antigravity.mjs apply
node tools/pi-antigravity/manage-pi-antigravity.mjs status

# 仅在决定撤销修复时执行，恢复该版本上游 baseline
# node tools/pi-antigravity/manage-pi-antigravity.mjs rollback
```

`status` 返回逐文件状态和聚合状态；patched 退出 0，baseline、mixed、unknown 退出 1；不支持的包名或版本报错且不写入。`apply` 将五文件全部为 baseline 的安装转换为 patched；`rollback` 将全部为 patched 的安装恢复为 baseline。已经处于目标状态时操作幂等、changed=false；混合状态、陌生源码及身份错配拒写。

`apply` 完成后，已运行的 Pi host 必须执行 `/reload` 或重启以重新加载 TypeScript extension；新启动的 Pi 无需额外操作。本轮有新进程验证，但没有旧 host 已 `/reload` 的证据，因此不要把旧会话视为已更新。

## 可复制的回归与真实三次命令零闪窗复验

在仓库根目录运行以下回归。测试会自动把输入包的 package.json 和五份源码复制到临时目录，在副本上应用与回滚，不修改正式插件安装。

```powershell
node --test tests/pi/pi_antigravity_manager.test.mjs
```

显式检查影子安装时，可复制正式包的六份必要文件；以下 PowerShell 示例会撤销副本补丁并执行同一回归，结束后恢复环境变量并删除副本：

```powershell
$installed = Join-Path $HOME '.pi/agent/npm/node_modules/@tian.zuo/pi-antigravity'
$shadow = Join-Path ([IO.Path]::GetTempPath()) ('agy-shadow-' + [guid]::NewGuid())
$previous = $env:PI_ANTIGRAVITY_TEST_PACKAGE
$files = @('package.json', 'lib/agy-children.ts', 'lib/agy-client.ts',
           'lib/agy-diagnostics.ts', 'lib/agy-driver.ts', 'lib/usage.ts')
try {
    foreach ($file in $files) {
        $destination = Join-Path $shadow $file
        New-Item -ItemType Directory -Force (Split-Path $destination) | Out-Null
        Copy-Item -LiteralPath (Join-Path $installed $file) -Destination $destination -ErrorAction Stop
    }
    node tools/pi-antigravity/manage-pi-antigravity.mjs rollback --target $shadow
    if ($LASTEXITCODE -ne 0) { throw '影子副本无法恢复为已知 baseline' }
    $env:PI_ANTIGRAVITY_TEST_PACKAGE = $shadow
    node --test tests/pi/pi_antigravity_manager.test.mjs
    if ($LASTEXITCODE -ne 0) { throw '影子副本回归失败' }
} finally {
    $env:PI_ANTIGRAVITY_TEST_PACKAGE = $previous
    if (Test-Path -LiteralPath $shadow) { Remove-Item -LiteralPath $shadow -Recurse -Force }
}
```

回归覆盖往返字节还原、版本和源码绑定及拒写。针对其他受支持版本，将相应 npm 发布包解压为输入目录并设置 `PI_ANTIGRAVITY_TEST_PACKAGE` 后运行同一命令；先核对 tarball SHA-512 与 npm registry 的 integrity，记录真实包版本，不能靠修改 package.json 伪造版本。

真实复验时，完成 `/reload` 或启动全新 Pi，选择 Antigravity 模型，将以下提示发送给 Pi：

```text
只使用原生 run_command，依次调用三次，不合并，不调用其他工具：
1. Write-Output AGY_FIXED_1; Start-Sleep -Milliseconds 500
2. Write-Output AGY_FIXED_2; Start-Sleep -Milliseconds 500
3. Write-Output AGY_FIXED_3; Start-Sleep -Milliseconds 500
三次成功后只回复 AGY_FIXED_DONE。
```

完成信号为三张独立工具卡返回对应标记、无工具错误，最终响应 `AGY_FIXED_DONE`，用户在桌面确认没有新增终端窗口；交互式 Pi 无需退出。自动化 print 验收另需进程退出 0。机器计数可使用 Windows `EnumWindows` + `IsWindowVisible` 每 10ms 监测 `ConsoleWindowClass` 与 `CASCADIA_HOSTING_WINDOW_CLASS`，排除开始前已有窗口；这是已有证据采用的观察方法，补丁包没有自带该探针。记录 Pi、插件与 agy 版本，桌面观察与上游测试串行。

## 升级后适配流程及测试窗口干扰排除

npm 升级可能覆盖磁盘补丁。升级后先执行 `status`；若仍为受支持版本且状态为 baseline，再执行 `apply`，随后 reload/restart。若为 unknown 版本或文件哈希不匹配，停止操作：先取得发布包、核对 integrity 和源码差异，经适配后补充版本哈希与回归，不能绕过管理器校验。

正式验证顺序是：发布包 integrity → 各版本影子安装的 manager 回归 → 本仓测试 → 上游测试 → 独立真实 Pi 三次命令及桌面观察。桌面监测必须与上游创建进程树测试串行。`node -e "setInterval(() => {}, 1000)"` 夹具可能触发 `0x800700e8`（管道正在被关闭），该窗口或错误不计入业务闪窗；确认测试完成后无夹具残留再判读结果。

不要通过回滚生产安装来复现故障；诊断实验仅在 `--target` 影子安装执行。已有隔离实跑通过进程环境 `PI_ANTIGRAVITY_PI_TOOL_BRIDGE=0` 关闭 Pi MCP bridge，只验原生 `run_command`；该设置不属于补丁，也不要求永久更改用户配置。

## 已验证证据索引及未验证事项

2026-09-20（UTC+8）升级后恢复复验：本机插件仍为 0.10.3，五份受管文件已恢复 baseline。重新 apply 后，在 Pi 0.86.0、agy 1.2.7 上执行三次原生命令成功，10ms 窗口监测未捕获新增控制台窗口。结构化证据为 `test-results/pi-antigravity-20260920/verification.json`；根因、公开设置核对和旧 Pi Web 宿主待重载边界记录在下列工具故障记录的同日期章节。具体覆盖命令未取证，不能仅凭文件状态断言是哪次升级操作造成。npm 重装仍可覆盖本地补丁，维护时执行本文件的升级后适配流程。

本次 0.10.3 修复的验证日期为 2026-09-11（UTC+8）；来源文件保留更早版本的历史记录。未来运行状态须重新执行 `status`：

- `notes/tooling/20260903-pi-antigravity-powershell-window-flash.md`：根因、最小复现、本仓 31/31 测试、历史 0.9.0 三次零闪窗及 0.10.3 修复前后对照。
- `test-results/pi-antigravity-0103/verification.json`：三版本 registry/tarball integrity、逐文件哈希、各版 6/6 manager 回归、上游 252 通过/2 平台跳过，以及真实 Pi 三次 `AGY_FIXED_1/2/3`、新增可见窗口 0。
- `notes/verify/pi-antigravity-0103-patch-rereview.md`：独立复核结论 pass，无 finding、证据缺口已关闭。
- `tools/pi-antigravity/README.md`、`tools/pi-antigravity/manage-pi-antigravity.mjs`、`tools/pi-antigravity/pi-antigravity-0.9.0-windows-no-flash.patch`、`tests/pi/pi_antigravity_manager.test.mjs`：操作接口、补丁内容、校验和回归定义。

未验证事项：本轮没有旧长驻 host 已 reload 的现场证据；未来 npm 新版本、不同 Pi/agy 版本或并行测试环境的窗口行为不在上述结论内。类型级全量编译也未作验证（本机无可用 `tsc`/默认 Biome LSP）。
