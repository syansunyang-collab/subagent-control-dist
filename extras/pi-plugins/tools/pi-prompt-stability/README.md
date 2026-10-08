# Pi 提示段稳定补丁

0.99.1 的宿主隔离移植、版本化载荷与验收步骤见 [0.99.1 宿主操作说明](../pi-codex-attribution/README-0.99.1.md)。`--host-only` 跳过用户扩展的读取和写入。

修复 Pi 在空闲时由自定义消息（子代理完成通知、定时唤醒）启动的运行不经过 `before_agent_start` 的问题，有 0.87.1 与 0.99.1 两套清单。0.87.1 清单另把两个逐轮注入提示内容的扩展改为写入具名 section；0.99.1 清单只含宿主补丁。上游问题：[earendil-works/pi#5581](https://github.com/earendil-works/pi/issues/5581)，截至 2026-09-27 未修复。

## 问题

普通输入会先触发 `before_agent_start`，扩展在此注入记忆策略、日期和计划模式提示。空闲时 `sendCustomMessage(..., { triggerTurn: true })` 直接启动运行，跳过这一步：

- 旧式扩展返回整段 `systemPrompt`，唤醒那一轮的前置 instructions 缺少这些内容，下一次普通输入又加回来。每次唤醒造成两次整段前缀失配，生产日志中表现为 83,712 → 12,160 这类回落。
- 改用 sections 但宿主未修时，唤醒那一轮按基础选项刷新，把扩展段作为「已删除」写入 transcript，下一次普通输入再写回。
- `before_agent_start` 的返回值只识别 `message` 和 `systemPrompt`；返回 `systemPromptOptions` 会被整体忽略，扩展内容从所有请求中消失。

## 组成

| 版本 | 部分 | 内容 |
| --- | --- | --- |
| 0.99.1 | 宿主 | `pi-0.99.1-custom-run-preparation.patch`：自定义消息启动的运行先执行 `before_agent_start` 并应用提示增量；`event.trigger` 区分 `prompt` 与 `custom`；准备期间会话已标记为运行中，同时到达的通知进入该运行的队列；含上游格式回归测试 `5581-custom-message-run-preparation.test.ts`。`pi-0.99.1-context-usage.patch`：上下文用量保留已测量前缀，只重新估算其后被编辑的消息。清单 `manifest-0.99.1.json` 共 20 个文件（替换 17 个，新增 3 个 bundle chunk）。 |
| 0.99.1 | 扩展 | 无。`manifest-0.99.1.json` 的 `extensions` 为空，加不加 `--host-only` 结果相同。日期扩展写具名 section 的版本已是 `artifacts/templates/pi-global-system-tail/local-time.ts` 的源码。 |
| 0.87.1 | 宿主 | `pi-0.87.1-custom-run-preparation.patch`，行为同上（不含上下文用量部分）。清单 `manifest.json` 共 17 个文件（替换 14 个，新增 3 个 bundle chunk）。 |
| 0.87.1 | 扩展 | `extensions/memory-index.ts`（pi-hermes-memory 0.9.8）改为写 `hermes_memory` section；`artifacts/templates/pi-global-system-tail/local-time.ts` 写 `local_time` section。`extensions/original/` 存两者的原始内容，用于回滚。 |

管理器按 `--root` 下 Pi 的版本选择清单。宿主补丁叠加在 `tools/pi-codex-attribution` 之上；两个管理器及 `tools/pi-ws-recovery` 均识别该叠加状态。

## 维护

```powershell
python -B tools/pi-prompt-stability/manage.py status --host-only
python -B tools/pi-prompt-stability/manage.py apply --host-only
python -B tools/pi-prompt-stability/manage.py rollback --host-only
```

`--root` 默认 `%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent`；`--agent-dir` 默认 `PI_CODING_AGENT_DIR`，未设置时 `~/.pi/agent`，只在 0.87.1 管理扩展时使用。`apply` 要求身份补丁处于 `patched`；完成后身份补丁状态为 `patched+prompt-stability`，需先回滚本补丁才能改动身份补丁。管理器拒绝覆盖未知内容。

| 版本 | 宿主载荷 | 宿主备份 |
| --- | --- | --- |
| 0.99.1 | `.runtime/pi-prompt-stability/0.99.1/host-payload.json.gz` | `.runtime/pi-prompt-stability/0.99.1/backups/<安装路径哈希>/` |
| 0.87.1 | `.runtime/pi-prompt-stability/host-payload.json.gz` | `.runtime/pi-prompt-stability/backups/host/` |

0.87.1 的扩展按 LF 文本比较，工作区检出为 CRLF 不影响判定；npm 更新 hermes 后状态变为 `unknown`，需核对新版源码后重新生成补丁。

变更后重启 Pi Web（`PiWeb` 计划任务）或相关 Pi 进程；`/reload` 不能替换已加载的 SDK 核心模块。

## 重建宿主载荷

0.99.1 统一使用 `tools/pi-codex-attribution/package-0991.py` 的分阶段快照与打包入口，构建步骤见 [0.99.1 宿主操作说明](../pi-codex-attribution/README-0.99.1.md)。旧版载荷、清单和回滚备份继续保留；0.87.1 遗留打包入口已删除。

## 验证

```powershell
node --test tools/pi-prompt-stability/test.mjs
$env:PI_0991_TEST_ROOT = (Resolve-Path 'tmp/pi-0991-upgrade/runtime/node_modules/@earendil-works/pi-coding-agent').Path
node --test tests/pi/prompt_stability_custom_run_abort.test.mjs
Remove-Item Env:PI_0991_TEST_ROOT
node tools/pi-prompt-stability/verify-installed.mjs
```

`test.mjs` 检查仓库扩展源码的 handler 行为。`prompt_stability_custom_run_abort.test.mjs` 对已打补丁的隔离候选同时检查 SDK 与 bundle：延迟准备期间取消后不启动 provider 请求，取消与 idle 等待者完成，已排队展示消息落盘，下一次自定义运行正常启动。未设置候选 root 时该安装测试跳过；完整宿主验收入口要求实际执行并通过。`verify-installed.mjs` 接受 `--root`、`--agent-dir`、`--bundle` 与 `--compaction success|failure|cancel`，用已安装的 SDK 或 bundle 创建真实 AgentSession。它使用内存凭据、设置与会话、具名 section 夹具和进程内 WebSocket，执行普通输入（含工具循环）、空闲自定义消息唤醒、普通输入及压缩。验证同轮身份与 turn-state、下一轮身份变化、提示段稳定和压缩成功才推进窗口；不加载用户扩展、不访问实际设置/记忆/凭据。默认临时目录为 `test-results/pi-0991-upgrade/host/offline-agent`。

部署记录：[prompt-stability-20260927.json](../../runs/native-pi-runtime-20260813/prompt-stability-20260927.json)。验证结果见 [pi-cache-miss-diagnosis-20260925.md](../../notes/verify/pi-cache-miss-diagnosis-20260925.md) 的 2026-09-27 22:10 一节。
