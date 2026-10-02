# Pi worker adapter

Subagent Control 提供 Pi 原生分身 `delegate_work({goal})`、叶子任务入口 `dispatch_prepare` 与 Fleet 工具；源码和测试留在控制仓，用户级安装是发布投影，不保存项目任务状态。

`dispatch_prepare` 的 `list | template | preview | submit` 使用双根合同：编译器来自 `runtimeRoot`，执行 cwd 和任务状态来自会话的 `projectRoot`。consumer 模式只解析运行包 manifest 声明的入口；markerless 开发模式才使用运行根内的约定源码入口。项目内同名 `ops/tools` 不覆盖 consumer 的编译器。`submit` 先生成并校验 Prepared Envelope，再交给当前 extension 持有的 `AsyncTaskService`。根解析真源为 `adapters/pi/src/consumer-root.mjs`，部署与激活步骤见 `docs/operations/pi-control-plane.md`。

`subagent_wait`、`subagent_get`、`subagent_result`、`subagent_server_info`、`subagent_cancel`、`subagent_pause` 与 `subagent_resume` 注册即常驻，会话中途不增删活动工具（增删会改变工具定义与系统提示词工具清单，使服务端提示缓存整段失效）。原生 submit 取得任务回执后调用运行包的面板入口（开发模式为 `ops/tools/agent_panel_launcher.mjs`），执行 cwd 仍为项目目录，结果写入 `agent_panel_launch`；面板失败只作诊断，不改变提交成功。`fleet_start/status/wait/review` 保持独立工具面。`list` 默认返回 `dispatch_prepare --list --format text` 的逐行目录，传 `format=json` 取同一目录的全部字段（模型只列推荐行与模型笔记涉及的型号）；候选顺序只用于展示，主代理自行判断模型。

Completion watcher 默认开启且按 logical session 隔离，只跟踪本会话提交或显式续跑的 task id。默认直派终态先缓冲，空闲时过滤已读取的 revision 并合并未读通知；后台 `peekResult` 不记录已读，公开 `subagent_result` 保持已读行为。新会话清空内存缓冲并恢复自身跟踪与读取记录，旧会话在途回调受 generation 隔离。投递保持 `followUp + triggerTurn`；Fleet 只发送 run 级通知，按 `run_id + revision + driver_status` 持久登记 pending，收到 `message_end` 或对应已落盘 `custom_message` 后确认。发送接受不销账，未确认项在重载后重放；`needs_parent_review` 确认后仍保留跟踪，复核或取消重新武装。通知读取、恢复与业务裁决的边界见 `ops/policies/runtime-tools.md` §6。自定义 `onCompletionNotice` 回调继续由调用方负责投递，不经过默认缓冲。`subagent_wait / fleet_wait` 保留给显式同步等待与通知排障。

会话存在在途 task、在途 Fleet run 或未投递终态通知时，extension 按 `@agegr/pi-web/session-liveness/v1` 契约向宿主登记会话存活租约，阻止宿主在这些工作完成前按空闲回收会话；三者皆空时租约放行回收。宿主不提供该注册表（TUI、RPC）或登记失败时退化为无操作，会话启动不受影响。租约在会话切换与 `session_shutdown` 释放，只影响自动空闲回收，显式 shutdown 与 Stop 兜底清理仍优先。

## 安装与验证

从控制仓根安装或升级本机 Pi 轨，先检查源码工作区，再预览；确认后由维护者执行写入：

```text
git status --short
python -B ops/tools/bootstrap.py --format json
python -B ops/tools/bootstrap.py --apply --format json
python -B ops/tools/deploy_pi_control.py --verify --format json
```

`bootstrap.py` 统一准备依赖、注册宿主和发布运行包，adapter 依赖安装使用固定 lockfile 与 `--ignore-scripts`。bootstrap 的发布范围默认 `project-scope=all`；显式 `listed` 范围与 consumer marker 的区别见运维文档。运行副本不包含项目 `.runtime`、session 或凭据。

已有依赖的源码验证从控制仓根执行，不安装、不派真实任务：

```text
node --test tests/pi/*.test.mjs
```

## delegate_work（Pi 原生分身）

- 仅 `goal` 必填，立即返回 `work_id/revision/state`。后台在来源的 cwd、权限和上下文中运行，不修改用户模型设置。
- 选型：默认 pick `luna_xhigh`；可选 `luna_max`、`sol_high`。三行的模型与档位定义在 `ops/agents/delegate-work.toml` 的 `[[picks]]`，经 `ops/dist/delegate_work_selection.bundle.mjs` 解析。也可同时给出 `model` 与 `effort` 显式选型：不限推荐行与档位范围，只校验 `effort` 在该模型可选档位内（`ops/model-notes.toml` 的 `efforts`），并要求来源运行时能解析该模型。选型在受理前确认，续跑沿用已保存选型。
- 来源会话只收到交接结果（completed / needs_decision / failed，按 version）与 failed / interrupted 状态（按 revision），各至多一次；分支派出的叶子与 Fleet 通知留在分支。
- 原生 CLI 从实际 `argv[1]` 的 `dist/cli.js` 定位同目录 SDK，不回落到 adapter 的旧版 SDK。SDK 嵌入使用 `installDelegateWork(pi, {sdk, sourceSession})`，或组合 `createDelegateWorkCore`、`createNativeBranchFactory`、`nativeWorkSource`。
- 源码在 `adapters/pi/src/delegate-work-core.mjs`、`adapters/pi/src/delegate-work-extension.mjs`。不依赖 Pi Web；`WORK_TEXT` 是高层工具及工作提示词的文案源。
- 分支仅复制最后一个工具调用全部配对的历史边界，来源不切换。重建资源加载器及扩展工厂；独立 ModelRuntime 沿用来源配置与凭据。自定义 ResourceLoader 必须注入 `rebuildResourceLoader`；需会话重绑定的 SDK customTools 注入 `rebuildCustomTools`。不复制已绑定的扩展工具闭包。
- 分支自行派发和消费叶子结果。空闲等待叶子通知不是失败，也不代表完成。只有 `submit_work_result({status,summary,evidence,residuals,next_step?})` 明确提交并确认执行结束才生成业务结果版本。`needs_decision` 和 `failed` 必须给具体下一步。
- 使用原 `subagent_get/pause/resume/cancel`，参数仍是 `task_id=work_id`；控制动作仍要求 `expected_revision`。普通 task_id 继续原服务，未新增控制工具。
- 暂停先停止分支扩展监听与 SDK 执行，再协作暂停本 work 新派出的 task/Fleet；未确认的仍为 `pausing`。Fleet 使用内部 `pause({run_id,reason})/resume({run_id})`。仅自动恢复此次暂停的活动，不触碰继承或已独立暂停的任务。`cancel` 不回滚文件。
- 待决时在原来源会话写明决定，再调用原 `subagent_resume`；自动抽取上次结果回送后的用户/助手文字，不转发未完成 toolCall。保持同 work 和分支文件，下一次结果使用新版本。
- 记录保存在 `<cwd>/.runtime/delegate-work/<source-session-id>/`。结果只向固定来源的空闲会话自动投递，按来源 transcript 中的任务 ID 与结果版本回执去重；忙、切换和重载期间保留待投递结果。SDK 嵌入应在来源 `message_end` 调用核心 `acknowledge(message, sourceSessionId)`，在空闲时调用 `flush()`，切换时使用 `detachSource/attachSource`，退出时 `close()`。会话绑定装配的统一启动入口同时启动分身生命周期，不依赖再次调用工具。恢复在 SDK 的 `resources_discover`（完整 `session_start` 分发之后）解锁投递，空闲定时重试接续忙碌或失败的发送。原生扩展已接好这些动作。
- 只统计分支新增 entry ID 上的 assistant、嵌套工具、compaction、usage 消耗；继承历史不重复计费，新增请求的上下文输入正常计入。
- 原进程退出不承诺继续计算；已存分支可续跑。跨进程同时操纵同一 work 不支持，本版 CAS 是单进程串行控制。未确认暂停由后台继续确认；服务错误保留原因，排除后可用当前 revision 显式重试。真实 DS 派叶子、消费结果与来源回送已验证；真实 DS 管理活体 Fleet 的组合暂停/恢复及现网启用仍未验收。

验证（无安装、无真实派发）：

```text
node --test tests/pi/delegate-work.test.mjs
```

从仓库根运行。

## Project package and commands

The adapter package and lockfile in `adapters/pi` define dependency versions.
The source package is tested locally; the bootstrap/release pipeline owns user-level
runtime deployment. Project prompts live under `.pi/prompts/`:

- `/control-status` renders the current project-local state.
- `/control-review` shows review-required results without changing their state.
- `/control-cancel` requires explicit confirmation and delegates cancellation to the
  existing controller.

`src/control-ui.mjs` is a dependency-free presentation adapter. It converts a
status snapshot to a JSON-serializable model or stable plain text. It does not own
task truth, a registry, lifecycle, filesystem writes, credentials, or global
configuration.

Focused package/UI checks run with:

```text
npm test
node --test ../../tests/pi/dispatch-prepare-tool.test.mjs ../../tests/pi/extension.test.mjs
node ../../ops/tools/dispatch_prepare.mjs --self-test
```
