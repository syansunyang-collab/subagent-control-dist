# 运行合同

## 进程关系

桌面模式的所有权关系如下：

```text
dotnet shell
  └─ panel-owned Node service
       └─ 127.0.0.1:<derived-port>
```

桌面壳只加载 `http://127.0.0.1:<derived-port>/`，对应入口为 `src/web/index.html`。壳退出时回收面板拥有的 Node 服务；控制仓任务由控制仓自身管理，不随面板退出而停止。

浏览器开发模式由 `npm run start:browser` 启动同一个服务入口，并请求浏览器打开根路由。两种模式不允许各自实现一套端口和路径解析。

## 参数解析

服务和壳都接受 `--control-repo <path>`。Node 服务另接受 `--control-root` 别名。命令行参数优先于环境变量。

浏览器服务入口使用 `AGENT_PANEL_CONTROL_REPO_PATH`、`CONTROL_REPO_PATH`；桌面壳入口使用 `AGENT_PANEL_CONTROL_REPO`。源码开发入口的默认监控根为模块（`<仓根>/src/agent-panel`）上两级目录。生产 launcher 使用 `SUBAGENT_PROJECT_ROOT` 或调用工作目录，并显式传入监控根；`SUBAGENT_RUNTIME_ROOT` 指向全局发布资产。

解析后必须得到绝对路径。路径不存在、不可读或控制仓运行态根目录不满足读取合同时，服务返回明确的全局错误；禁止回退到当前目录、旧缓存或其他仓。

## 端口算法

端口输入是面板资产路径，生产环境使用全局发布根下的 `src/agent-panel`。Windows 规范化规则为：绝对路径、去掉末尾分隔符（根路径除外）、统一使用 `/` 分隔符并转小写。计算过程：

```text
digest = SHA256(normalized_repository_path UTF-8 bytes)
value  = digest[0..1] as unsigned big-endian integer
port   = 43000 + (value mod 1000)
host   = 127.0.0.1
url    = http://127.0.0.1:<port>/
```

端口范围是 `43000–43999`。端口占用属于启动错误，不能通过随机端口或静默端口回退绕过；调用方必须看到错误并修复占用者。

桌面壳向 Node 服务传递 `--control-root`、`--host`、`--port` 和 `--parent-pid`。附着与健康检查校验 `ok`、`panel_root`、`contract_version` 和 `resolved_loopback_url`；`control_repo_path` 仅表示可变的监控项目。身份不匹配立即拒绝，健康连接的瞬态宽限不适用于错误身份。浏览器开发模式使用同一算法和同一服务入口。

## 访问和写入边界

- HTTP 服务仅绑定 loopback，Web 静态资源不请求外部资源；
- 配置页读取模型目录时只启动 Pi RPC 的目录查询，不发送模型推理请求；已安装 provider extension 自身的目录发现行为沿用 Pi 运行时；
- 控制仓 `.runtime` 默认只读；
- 单任务取消只通过公共 `AsyncTaskService.cancel` 的 `expected_revision` CAS；
- Fleet 运行级结束只通过既有 `fleet_cancel`：`run_id` 必须匹配既有任务标识格式，且该 run 的 `state_root` 必须是当前监控项目的 fleet 目录；不接受调用方路径或命令，不删除 state、失败记录或任务报告；
- 配置真源是控制仓（生产取 `deployment.json` 的 `source.source_root`，浏览器开发模式取启动控制仓），监控工程不改变真源。写入闭集为角色 TOML 的 `[[picks]]` 与资源白名单四键（含 `[capabilities.<id>]` 收窄）、模型笔记的 `efforts`、`ops/templates/worker-resources.json` 各条目的 `access` / `label` / `group`；
- `GET /api/projects` 列出 `allowed_projects`；`PUT /api/monitor-root` 在列表内切换监控仓的 `.runtime/cockpit`。目标缺少运行态则失败，不猜其他目录。切仓不改变配置资产路径；
- 不在面板模块内保存任务业务数据；
- 面板日志写用户级 `.subagent-control/agent-panel/logs`，隔离测试可通过 `AGENT_PANEL_STATE_ROOT` 指定状态目录；`server.jsonl` 每个请求完成后异步写一行，必含 ISO 8601 `timestamp`、整数 `durationMs`、HTTP `status` 与 `path`，可选字段为 `task_id`、`run_id`。`durationMs` 从 HTTP handler 开始计时，排队延迟由客户端端到端计时覆盖；
- 任何日志不得包含任务正文、提示词、token、cookie、API key 或密码。

## 变更护栏

所有变更请求（任务取消、Fleet 结束与配置写入）必须同时通过：

1. `Host` 头等于 `127.0.0.1:<actual-port>`；
2. `Origin` 头缺省，或等于服务自身的 loopback URL；
3. `X-Panel-Token` 头等于本进程令牌。令牌每次启动随机生成，通过 `index.html` 的 `<meta name="panel-token">` 注入前端。写请求发出前通过同源 `GET /api/session` 更新令牌；该接口检查 Host、Origin 和跨站请求标志，响应为 `no-store`。令牌不落日志、不进 URL，刷新令牌不重放写请求。

任一条不满足返回 403，错误码为 `MUTATION_HOST_REJECTED` / `MUTATION_ORIGIN_REJECTED` / `MUTATION_TOKEN_REJECTED`。

## 配置域

- `GET /api/selection`：推荐行与模型档位的投影（`projectCatalog`）、可编辑数据（各角色推荐行、各模型 `efforts`）、各受管 TOML 的 revision、档位闭集与 `ops/panel-labels.toml` 显示名；Pi 模型清单未取得时模型的 `in_pi` 为 null。
- `PUT /api/selection`：请求体 `{ draft: { roles?, efforts? }, expected_revision }`。推荐行含可编辑字段以外的键时返回 `PICK_FIELD_UNKNOWN` 并拒写。只对有变化的文件做 CAS；候选文件与其余受管文件整体经 `loadSelectionConfig` 与 Python `tomllib` 复验后多文件原子换入，任一文件失败即恢复。去掉仍被推荐行引用的档位时列出全部受影响的行并拒写。校验错误统一为 `{ code, file, field, role?, pick_id?, message }`。
- `GET /api/config`：各角色资源白名单与 revision（`delegate-work` 不参与）、导入范围文件 revision 与运行槽同步状态；不等待资源注册探测。
- `GET /api/config/resources`：按需读取资源候选（`resolveWorkerResourceCatalog`，读控制仓导入范围文件，项目技能按监控工程解析）；目录发现可启动 Pi RPC 子进程探测已安装扩展注册的工具。资源页与导入范围页先显示加载状态，失败时给出重试入口；基础配置读取不依赖此调用。
- `GET /api/config/catalogs`：异步读取正常 Pi RPC 模型目录；成功结果缓存 60 秒，并发请求共享一次查询。`?refresh=1` 跳过成功缓存，仍共享在途查询。失败保留上次成功目录，返回 `error` / `error_code` / `stale`；失败后可立即重试。`checked_at` 为上次成功查询时间，`loading` 为查询在途状态。
- `PUT /api/config/roles/<role>`：请求体 `{ updates, expected_revision }`。`updates` 为 `tools` / `extensions` / `skills` / `project_skills` 与 `capabilities.<id>` 同名键；任务类型值只能收窄角色值，放宽返回 `CONFIG_CAPABILITY_WIDENS` 与字段位置；未开放或未安装的名字照常保存，并返回 `{ code, field, message }` 形式的警告。
- `PUT /api/config/imports`：请求体 `{ updates: { tools | extensions | skills: { <键>: { access?, label?, group? } } }, expected_revision }`。插件与技能的键可含 `*`，工具键不可；未记录的资源按本次提交的字段建条目（须带合法 `access`）；空显示名删除该键；`required_tools` 中的工具只改 `label`。候选文件经 `loadWorkerResourcesConfig` 整份校验后才换入与同步，不通过返回 `{ code, file, field, message }`。资源目录读取失败时 `resource_catalog.error` 为固定提示文字，原始异常只写服务 stderr。
- revision 为目标文件内容 SHA-256 前 12 位；不匹配返回 409 且不落盘。
- Pi 模型选择来源：正常 Pi RPC `get_available_models` 返回 Model 数组，再由同一 SDK 的 SettingsManager 读取有效 enabledModels，交 resolveModelScopeWithDiagnostics 解析白名单；不复制白名单或自行实现模式匹配。空白名单或零命中时返回空目录；读取失败显示目录错误并可重试。清单只决定推荐行的模型下拉与「不在 Pi 清单」提示；不在清单中的模型只记警告，保存不依赖目录。此界面过滤不改变派发工具权限。
- 配置操作在独立 worker 执行，同步文件操作与 Python 子进程不占 HTTP 主线程。模型目录与资源目录独立异步加载；模型查询超时为 30 秒，收到对应 RPC 响应或失败后回收；本地配置可在目录查询期间读取。资源目录请求按目录等待预算处理，不延长普通配置读取的 8 秒上限。
- TOML 读取与候选校验经 Python `tomllib` 一次性子进程（解释器解析顺序：`AGENT_PANEL_PYTHON` → 控制仓 `.venv` → PATH 中的 `python`）；写入经 `@decimalturn/toml-patch` 保留注释与未编辑的键，备份后临时文件原子换入，回读复验失败即回滚，结果状态闭集为 `saved` / `revision_conflict` / `validation_error` / `save_error_restored` / `save_error_restore_failed`。
- 保存成功后把写入的文件同步到运行槽：`~/.subagent-control/releases/subagent` 下含 `ops/model-notes.toml` 的正式目录、Pi 扩展槽与 `consumer/current.json` 的 `runtime_root`。受管文件为 `ops/agents/*.toml`、`ops/model-notes.toml` 与 `ops/templates/worker-resources.json`；`ops/panel-labels.toml` 不同步。

## 兼容门

服务从全局发布根加载 `async-core` 并校验 `CONTRACT_VERSION`。监控项目仅提供 `.runtime/cockpit` 数据，切仓不加载目标项目代码；默认 registry 为该项目的 `.runtime/cockpit/async-registry`。版本不匹配必须 fail closed，并显示明确版本错误；不得猜测字段、静默降级或导入 runtime 内部函数。

## 健康与故障状态

`GET /api/health` 是进程级 liveness/readiness 快路径：初始化结论在启动或恢复时缓存；请求处理不读取文件、不扫描任务目录，也不等待聚合投影。`/api/snapshot`、`/api/history`、`/api/review-queue` 等聚合读取与配置处理分别在隔离 worker 中执行；模型目录查询不阻塞它们或 HTTP 主线程。慢目录查询持续 20 秒时，health 仍须在桌面壳 750ms 截止线内响应。readiness 阶段的 health 失败仍为失败，不得由壳侧宽限改写。

坏 JSON 或单任务异常属于局部故障：异常卡片进入错误态，其他区域保持可用。桌面壳只在文档首次加载前显示启动阻断；文档已加载后的连接状态由网页展示。网页保留上次成功数据、当前页签和未保存编辑，显示上次同步时间；未同步时拒绝变更请求。服务恢复或重启不重新导航，前端轮询恢复任务数据。

模型和资源目录分别加载和重试，不表示模型推理连通性。普通读取超时为 8 秒，目录和写入等待预算为 40 秒。配置页打开期间按任务轮询刷新同步横幅，不覆盖未保存草稿；保存成功反馈与全局运行槽差异分别呈现。写请求响应丢失时标记结果待确认，回读配置并保留草稿，不自动重放。现有 CAS 和原子保存继续保护外部编辑。
