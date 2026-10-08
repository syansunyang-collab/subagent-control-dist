# Pi 停止链路

Pi 的停止由两步组成：置位本轮的 AbortSignal，然后等待会话空闲。链路上任何一个不响应该信号的长等待，都会把停止拖到它自己结束为止。

## 链路

| 环节 | 位置 | 行为 |
|---|---|---|
| Pi Web 前端 | `E:\ControlPlane\web\app\hooks\useAgentSession.ts` `handleAbort` | 发 `POST abort`，请求在 agent 空闲后才返回 |
| Pi Web 服务端 | `lib/rpc-manager.ts` `case "abort"` | `await inner.abort()` |
| Pi | `dist/core/agent-session.js` `abort()` | `agent.abort()` 置位信号，随后 `await waitForIdle()`；空闲要等本轮 run 结束 |
| 工具 | `execute(toolCallId, params, signal, onUpdate, ctx)` | 第三个参数即本轮信号，工具自行决定是否响应 |
| 扩展钩子 | `message_end`、`turn_end`、`tool_execution_end` 等 | Pi 逐个 await；钩子执行期间本轮信号可通过 `ctx.signal` 取得 |

规则：工具内的长等待接 `signal`；钩子内的长调用接 `ctx.signal`，并设截止时间。

## 2026-09-17 事故与修复

Pi Web 中连续点击停止 6 分钟无反馈。`subagent_wait`（`timeout_ms: 360000`）丢弃了信号，跑满 360 000 ms 后返回，停止在其返回 6 ms 后才生效；同一时段裁剪扩展没有摘要在执行。

| 组件 | 问题 | 修复 | 状态 |
|---|---|---|---|
| 控制仓 Pi 适配器 `E:\ControlPlane\control_0827\adapters\pi\src\` | `wait`、`subagent_wait`、`fleet_wait` 的 `execute` 不接收 signal | `abortable-wait.mjs` 的 `waitUnlessAborted`：信号触发即返回 `event: "aborted"`；Core 的等待是带截止时间的无副作用轮询，任其到期，任务不受影响 | 已用 `ops/tools/deploy_pi_control.py --apply` 部署并 `--verify`，`installed_at` 2026-09-17T05:19:14Z |
| 裁剪扩展 | `message_end` 钩子内 await 摘要且不传 signal，每次最终回复后约 10–50 s 停止无效；摘要流挂住时无上限 | 1.5.1：钩子触发的摘要绑定 `ctx.signal` 与 180 s 截止 | 生产 `npm:@syansunyang/pi-context-prune@1.5.1` |
| Pi Web 前端 | 无进行中状态，每次点击各发一条请求 | `lib/single-flight.ts`：一次停止只发一条请求，后续点击与 Esc 并入；按钮禁用并显示「正在停止…」 | 提交 82302e3，BUILD_ID `3goH7mOKR56478h8b-pq7`，2026-09-17 13:37 上线 |

未改动：停止生效后到达的子代理终态通知仍会触发新一轮。

## 验证

- 控制仓：`node --test tests/pi/abortable-wait.test.mjs` 6 项通过；`async-tools`、`extension`、`fleet-completion-watcher` 三个套件 29 项通过。用户在 Pi Web 真实会话中复测停止，反馈成功。
- 裁剪扩展：`tmp/context-prune-bench/smoke-stub/abort_latency.py`，摘要开始 1 s 后发 `abort`。1.5.0：3.86 s 后空闲，摘要照常写入。1.5.1（npm 安装件）：0.0 s，当场无摘要写入，下一条最终回复补摘 1 条。
- Pi Web：`lib/single-flight.test.mjs` 3 项；`npx tsc --noEmit`、eslint 退出 0；`npm test` 1036 通过、2 跳过。浏览器内把 `abort` 请求人为延迟 6 s，运行中连点 3 次：发出 1 条请求，按钮为「正在停止…」、`disabled`、`aria-busy=true`，请求返回后按钮消失。

## Pi Web 小改动的上线流程

线上 `next start` 直接读取 `E:\ControlPlane\web\app\.next`，原地构建会破坏运行中的服务；重启会中断活动会话。

1. 在 `E:\ControlPlane\web\app` 提交改动，工作区无已跟踪的未提交修改。
2. `git worktree add --detach E:\ControlPlane\web\.deploy\<名称> HEAD`；用 `mklink /J` 把候选目录的 `node_modules` 指向生产目录（依赖无变化时）。
3. 在候选目录 `npm run build`，确认 `.next\BUILD_ID` 生成。
4. `GET http://127.0.0.1:30141/api/agent/running` 的 `runningSessionIds` 为空时执行切换。脚本 `tools/pi-web/switch-next-build.ps1 -Candidate <候选目录> -Backup <回退目录> -Receipt <回执路径>` 的步骤：核对候选与生产同一提交 → 停 `PiWeb` 计划任务并结束 30141 监听进程 → 生产 `.next` 移入 `.deploy\rollback-<名称>`，候选 `.next` 移入生产 → 启动 `PiWeb` 任务 → 120 s 内健康检查；失败自动换回并重启。
5. 清理候选目录：先 `rmdir` 删除 `node_modules` junction，再 `git worktree remove`。顺序颠倒会删到生产的 `node_modules`。
6. 已打开的页面刷新后加载新前端。

依赖有变化的升级沿用 `notes/verify/piweb-091-release-20260916.md` 的完整候选流程（候选目录自带 `node_modules` 并一并交换）。

## 记录

- `notes/verify/pi-stop-blocked-20260917.md`
- 回执：`tmp/piweb-stop-ui-deployed.json`；旧构建：`E:\ControlPlane\web\.deploy\rollback-stop-ui-20260917\.next`
