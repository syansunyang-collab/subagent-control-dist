# Pi OpenAI Codex WebSocket recovery 管理器

0.99.1 支持独立 WS 与 attribution + prompt-stability 组合状态。隔离构建、操作与验收见 [0.99.1 宿主操作说明](../pi-codex-attribution/README-0.99.1.md)；旧版清单和载荷保持独立。

## 目的

`manage-pi-ws-recovery.mjs` 是本机 WS recovery 补丁的唯一运维入口。支持 0.84.x、0.85.1、0.86.0、0.87.1 与 0.99.1 部署并存，默认覆盖以下入口；同一物理依赖目录只处理一次：

1. 全局终端 Pi 的官方 bundled runtime。
2. 全局终端 Pi 实际解析到的 modular `pi-ai`。
3. Pi Web root 与内嵌 SDK 实际解析到的 `pi-ai`。
4. Pi Web Pi 包的 bundled `rpc-entry` runtime。
5. 已部署 worker root 与内嵌 SDK 实际解析到的 `pi-ai`。
6. worker 的 bundled runtime（存在该入口时纳入）。

依赖查找兼容 npm 嵌套与提升布局。版本是否受支持由固定版本/哈希画像判定，未支持版本仍拒绝；不以某个入口的旧版本号阻断同批滚动切换。

bundle 与 modular 是不同代码副本。管理器分别验证和写入，不再用“modular 文件 patched”替代终端活动 bundle 的状态。

## 补丁行为

- 普通 WS 失败后使用 SSE 兜底，恢复探针按 30、60、120、240、300 秒退避。
- 每个 session 同时只允许一个恢复探针。
- `1009 message too big` 记录完整序列化请求字节；请求体缩小至少 20% 后才恢复探测。
- 探针成功清除 fallback；abort 释放探针占位；provider/protocol 错误不误判为 transport failure。
- cached WS idle TTL 从 5 分钟提高到 15 分钟，55 分钟最大寿命不变。
- 重复模块实例通过 `globalThis` 共享诊断和 fallback 状态。

## 使用

```powershell
node E:\Pi_Coding_Agent\tools\pi-ws-recovery\manage-pi-ws-recovery.mjs status
node E:\Pi_Coding_Agent\tools\pi-ws-recovery\manage-pi-ws-recovery.mjs apply
node E:\Pi_Coding_Agent\tools\pi-ws-recovery\manage-pi-ws-recovery.mjs rollback
```

`status` 仅当全部目标均为 patched 时返回 0。`apply` 和 `rollback` 幂等。自定义 modular 目标使用 `--target label=pi-ai-directory`；自定义 bundle 目标使用 `--bundle-target label=pi-coding-agent-directory`。

## 安全边界

- modular 补丁接受 `pi-ai@0.84.1`、`0.84.3`、`0.84.4`、`0.85.1`、`0.86.0`、`0.87.1`、`0.99.1` 的固定哈希。
- bundle 补丁接受 `pi-coding-agent@0.84.3`、`0.84.4`、`0.85.1`、`0.86.0`、`0.87.1`、`0.99.1` 的固定哈希。0.99.1 使用独立 manifest/payload 更新 chunk 和 CLI/RPC 导入图。
- baseline 与 patched 文件均有固定 SHA-256；未知哈希拒绝写入。
- 0.84.x/0.85.1 modular patch SHA-256 为 `75d9ebc4234afbfc6d5e2f766ec3f8450a11e2a1db7782db1514b838d85cf1d1`；0.86.0 modular patch SHA-256 为 `eb210996965466f52e4143edd3d9981109476e6a89e33dad4c50b714a485b968`；0.87.1 modular patch SHA-256 为 `eb210996965466f52e4143edd3d9981109476e6a89e33dad4c50b714a485b968`（与 0.86.0 数值相同——0.87.1 的 `openai-codex-responses.js`/`.d.ts` 源码与 0.86.0 逐字节相同，已核实，故补丁内容、baseline/patched 哈希与 bundle chunk 哈希均沿用不变）。bundle 使用 `bundle-transform.mjs` 的精确唯一片段变换并验证目标哈希，同一变换对 0.87.1 的 chunk 原样适用，未做改动。
- 旧版写入前备份到 `.runtime/pi-ws-recovery-backups/<入口>/<版本>/<状态>/`；0.99.1 备份到 `.runtime/pi-codex-attribution/0.99.1/ws-backups/`，按安装路径分开；不同版本不复用旧备份。
- 修改的是磁盘安装副本；已经运行的 Pi/Next/worker 进程不会热更新。
- 不读取、复制或输出 `auth.json` 凭据正文。
- 0.87.1 起的 CLI 使用 `createRequire(...)("./cli-runtime.js")` 间接加载 chunk。`inspectBundleEntrypoints` 同时识别该入口和旧版直接 chunk 导入；SDK 与 CLI/RPC 的补丁状态仍分别按固定文件哈希判定。

## 升级与部署

`npm install -g`、`npm ci`、Pi Web 升级或 subagent-control 重新部署会覆盖对应补丁。变更后运行 `status`：

1. 上游已实现等价恢复时，删除本地补丁并更新本说明。
2. 上游未修且版本/哈希未知时，管理器拒绝写入；必须在对应版本重新移植并更新回归。
3. subagent-control 重新部署后立即运行 `apply`，不要等到下一次 Pi Web 登录启动。
4. 禁止为“先启动”放宽未知哈希校验。

Pi Web 自动启动器会在每次启动前执行幂等 `apply`，并连带修复已部署 subagent worker。若补丁未知，启动器默认记录 failure 但仍启动；需要 fail-closed 时显式传 `-RequirePatch`。

## 验证

```powershell
$env:PI_0991_TEST_ROOT = 'E:/Pi_Coding_Agent/tmp/pi-0991-upgrade/runtime/node_modules/@earendil-works/pi-coding-agent'
$env:PI_WS_TEST_PI_AI_ROOT = "$env:PI_0991_TEST_ROOT/node_modules/@earendil-works/pi-ai"
node --test tests/pi/pi_ws_recovery_state.test.mjs tests/pi/pi_0991_ws_runtime.test.mjs
$env:PI_0991_WS_BUNDLE = '1'
node --test tests/pi/pi_0991_ws_runtime.test.mjs
Remove-Item Env:PI_0991_WS_BUNDLE, Env:PI_WS_TEST_PI_AI_ROOT, Env:PI_0991_TEST_ROOT
```

上述命令要求候选已应用 0.99.1 补丁。runtime 测试通过离线 WS/SSE 替身验证 SDK 与官方 bundle 的失败降级、冷却后恢复和 1009 请求缩小门槛；不设置 `PI_0991_TEST_ROOT` 会跳过安装测试。管理器的幂等 apply/rollback、逆序叠加回滚与未知哈希拒绝由 `tests/test_pi_codex_attribution.py` 覆盖，完整候选往返使用 [0.99.1 宿主操作说明](../pi-codex-attribution/README-0.99.1.md) 中的 runner，不在生产安装上运行往返。

`tests/pi/pi_ws_recovery_state.test.mjs` 从实际 patched provider 读取状态机函数，覆盖冷却、单探针、abort 释放、超大请求缩小阈值和独立模块共享状态。
