# Pi 插件与补丁扩展包

`extras/pi-plugins/` 收录维护者本机 Pi 运行环境中由插件仓管理的插件、第三方包补丁、Pi 本体补丁、运维脚本、研究工具和技能。控制面的 `python -B ops/tools/bootstrap.py --apply` 不读取本目录，也不安装其中任何单元；派发、Fleet、面板、搜索与压缩链不依赖这些单元（分发仓 `HANDOVER.md` 第 4 节）。各单元相互独立，按机器条件与使用需要选装。

目录结构与插件仓一致：`tools/`、`tests/pi/`、`docs/operations/`、`artifacts/templates/`、`.pi/skills/`、`test-baselines/`，另有 `forks/pi-context-prune/`（自维护 fork 在提交 `4e44ab4` 的文件快照，不含 Git 历史）。本文路径均相对 `extras/pi-plugins/`，命令均在 `extras/pi-plugins/` 目录下执行。

## 1. 通用前提与原则

### 1.1 环境

| 项 | 要求 | 核对命令 |
| --- | --- | --- |
| 操作系统 | Windows 10/11。剪贴板、窗口、进程树清理与原生 helper 调用 Windows API；补丁管理器的默认路径按 Windows 全局 npm 布局 | — |
| Pi | 全局 npm 安装的 `@earendil-works/pi-coding-agent@0.99.1` | `pi --version` |
| Node.js | ≥ 22.19；维护者本机 24.12.0 | `node --version` |
| Python | ≥ 3.10；维护者本机 3.12.10 | `python --version` |
| Git | 多个管理器用 `git apply` 写入补丁 | `git --version` |

### 1.2 路径占位

| 占位 | 含义与确定方法 |
| --- | --- |
| `<Pi 用户目录>` | 设置了 `PI_CODING_AGENT_DIR` 时为该值，否则 `%USERPROFILE%\.pi\agent`。本目录的管理器按同一规则取默认目录，仍固定使用 `%USERPROFILE%\.pi\agent` 的逐单元注明。命令示例用 `$agent = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }` 取得 `$agent` |
| `<全局 Pi 目录>` | `npm root -g` 输出目录下的 `@earendil-works\pi-coding-agent`，默认 `%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent`。管理器默认取后者；npm 全局前缀不同（nvm、volta 等）时用 `--root` / `--target` 显式指定 |
| `<Pi npm 目录>` | `<Pi 用户目录>\npm\node_modules`，即 `pi install npm:...` 的安装位置 |
| `<extras 目录>` | `extras/pi-plugins/` 的绝对路径；在该目录下执行 `(Resolve-Path .).Path` 取得 |
| `<Pi 用户目录正斜杠路径>` | `<Pi 用户目录>` 的绝对路径改写为正斜杠，如 `C:/Users/<用户名>/.pi/agent` |
| `<Pi Web 应用目录>` | 维护者 Pi Web 应用的安装目录。Pi Web 未随分发，接收方机器上通常不存在；部分管理器把它写死为默认目标，逐单元注明 |

### 1.3 原则

1. 先 `status`，再 `apply`。`status` 报 `unknown`、版本不受支持或哈希不符时停止，不放宽校验、不手工覆盖。
2. 改 `<Pi 用户目录>\settings.json` 前先复制备份。`packages` 条目可写 `npm:<包>@<版本>`、绝对路径，或相对 settings 文件所在目录的路径（`<全局 Pi 目录>\docs\packages.md`）。`pi list` 列出当前登记的包。
3. 插件与扩展装完后新开 Pi 会话或执行 `/reload`。Pi 本体补丁改的是 SDK 核心模块，必须重启所有持有旧代码的 Pi 进程（终端 Pi、子代理 worker 等），`/reload` 不够。
4. `npm install -g`、`pi update`、重装对应第三方包、重跑控制面 bootstrap 都可能覆盖补丁。每次升级后按第 5 节复查。
5. 生成态写在 `.runtime/`、`runs/`、`test-results/`、`tmp/`。`.runtime/` 下的备份是各管理器回滚的依据，保留不删。以目录联接、本地路径或 `.runtime/pi-antigravity-native/` 方式登记的单元直接从 `<extras 目录>` 加载：安装后不移动、不删除 `extras/pi-plugins/`；分发仓更新会同步改变这些单元的代码，新会话或 `/reload` 后生效。
6. 字节完整性：补丁文件和部分管理器自身带 SHA-256 校验，换行被改写会导致校验失败或 `git apply` 失败。`tools/pi-computer-use-qt-fix/` 下 `focused-input-foreground.patch`、`visual-observation.patch`、`visual-observation-frontend.patch` 为 CRLF，其余补丁为 LF。核对命令：`git ls-files --eol tools`。`tools/pi-ws-recovery/manage-pi-ws-recovery.mjs` 启动时先校验自身补丁与 `bundle-transform.mjs` 的哈希，不符即报错退出。
7. 未随分发：`notes/`、`runs/`、`test-results/`、`docs/decisions/`、`.runtime/` 下的备份与本地构建包（Pi 本体补丁的三份载荷例外，随分发，见 3.9）、`tmp/`、`scripts/`、根目录 `tests/*.py`、Pi Web 管理工具、`tools/context-prune-bench/` 下的 `*.jsonl` 采集数据。README 与 `docs/operations/` 中指向这些位置的链接在本目录无效。
8. 凭据：Cursor、Antigravity、Claude、OpenAI Codex、OpenRouter 等登录态与 API key 由接收方自备；本目录不含凭据。

## 2. 总览

| # | 单元 | 类型 | 作用 | 前提 | 维护成本 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 上下文裁剪 `pi-context-prune` | 独立插件（自维护 fork） | 旧工具输出换成短回执、原文可回查，降低上下文 token | Pi 0.99.1 | 中 | 按需（长会话首选） |
| 2 | 缓存诊断 `payload-cache-diag` + `cache-wire-observer` | 诊断扩展 + 运维脚本 | 记录请求前缀差异与实际发送帧指纹，定位缓存失配 | Pi 0.99.1；发送帧记录限 Codex / xAI Responses | 低 | 按需（排查时装，查完卸） |
| 3 | 裁剪基准 `tools/context-prune-bench/` | 研究工具 | 裁剪与缓存的 A/B、回放、会话统计 | 题库与测试床、provider 凭据；产生模型费用 | 高 | 仅研究 |
| 4 | `pi-cursor-host` | 独立插件（模型 provider） | 经官方 `@cursor/sdk` 使用 Cursor 模型，工具与提示词归 Pi | Cursor User API key | 中 | 按需（有 Cursor 账号） |
| 5 | `pi-read-symbol` | 独立插件（工具） | `read_symbol` 按名字读完整定义或列出文件大纲 | `ast-grep` | 低 | 推荐（已装控制面） |
| 6 | `pi-scheduler-native` | 独立插件 | 定时唤醒 agent、定时执行命令 | npm 依赖（含原生文件锁） | 中 | 按需 |
| 7 | 全局系统尾注 `pi-global-system-tail` | 独立插件 + 提示词模板 | 每轮注入当日日期；`APPEND_SYSTEM.md` 承载全局风格 | 正文为维护者个人风格，需改写 | 低 | 按需（正文改写后） |
| 8 | `pi-paste-image` | 独立扩展 | `/img` 把剪贴板截图存为 PNG 并把路径填入输入框 | 交互式终端 Pi | 低 | 按需 |
| 9 | Pi 本体补丁：`pi-codex-attribution`、`pi-prompt-stability`、`pi-ws-recovery` | Pi 本体补丁 | Codex 请求身份与 turn-state、WS 失败降级与恢复、自定义消息唤醒时提示段稳定、上下文用量估算 | 原版全局 Pi 0.99.1；补丁载荷（见 3.9） | 高 | 按需（openai-codex 重度用户） |
| 10 | `pi-web-answer-alias` | 第三方包补丁 | `fetch_content` 问答模式改用 `pageAnswer` 配置并接通 Codex 型号别名 | `pi-web-access@0.21.0`、控制面别名扩展 | 低 | 推荐（已装控制面且有 openai-codex 登录） |
| 11 | `pi-antigravity` | 第三方包补丁 + 本地生成包 | Windows 不闪窗；原生接线让 Pi 宿主执行 Antigravity 的工具调用 | Antigravity CLI 及登录、`@tian.zuo/pi-antigravity@0.10.3` | 高 | 按需（有 Antigravity 账号） |
| 12 | `pi-transcript-hydrate` | 第三方包补丁 | 为读取旧 Context 字段的 provider 恢复系统提示与工具 | 上游 `@tian.zuo/pi-antigravity` | 低 | 按需（随 #11） |
| 13 | `pi-computer-use-qt-fix` | 第三方包补丁（含原生 helper 重编译） | 修正 Windows UIA 身份与控件类型、视觉观察、保持焦点的输入 | `@injaneity/pi-computer-use@0.5.1`、Rust 工具链 | 高 | 按需（遇到对应故障） |
| 14 | `pi-claude-code-provider` 补丁 | 第三方包补丁 | 图片内联、内置插件隔离、摘要请求不写缓存、模型全名 | `pi-claude-code-provider@0.6.0`、Claude Code 2.1.292、Claude 订阅 | 中 | 按需（用 Claude 订阅） |
| 15 | `pi-ask` | 历史补丁 | 旧提问包的网页桥接 diff，无安装入口 | — | — | 已退役 |
| 16 | `patch_pi_fullscreen_button_motion.py` | Pi 本体补丁脚本 | 全屏 TUI 鼠标跟踪降为按键移动，避免悬停序列漏进输入框 | Pi 0.84.4 / 0.85.1 / 0.86.0 | — | 不适用（0.99.1 拒绝写入） |
| 17 | 压缩与裁剪研究脚本：`compaction-replay.mjs`、`pi_compaction_fallback_smoke.py`、`prune-luna-context-*.mjs` | 研究工具 | 压缩写手回放、压缩兜底冒烟、模型判裁回放 | 自有会话样本、provider 凭据 | 高 | 仅研究 |
| 18 | `codex_quota.py` | 运维脚本 | 查询 Codex 订阅各额度窗口的用量与重置时间 | openai-codex 登录 | 低 | 按需 |
| 19 | 技能：`pi-context-prune-local-trial`、`pi-local-plugin-development`、`pi-web-access-operations` | 技能 | 裁剪接线与试用、本地插件开发、网页插件运维 | 引用本目录相对路径与控制面技能 | 低 | 按需 |

Pi Web：维护者个人部署，未随分发，需要时单独找维护者。

## 3. 单元说明

### 3.1 上下文裁剪 pi-context-prune

**作用**：生产入口 `policy-lab` 以 `cold-mask` 策略运行。可释放的旧工具输出累计达到 `triggerTokens` 后，在下一次请求前换成 `[pruned:tN]` 短回执，原文归档在会话中，模型用 `context_tree_query` 取回；不调用摘要模型。最近 2 轮工具结果、技能与图片结果、回查结果不裁；上下文用量达到模型窗口的 `compactionHoldRatio`（默认 0.72）后不再新增裁剪，已有回执照常。命令：`/pruner-threshold`（6K / 15K / 30K / 60K，按会话分支持久化）、`/pruner-pause`、`/pruner-resume`、`/pruner-status`。

实测（`docs/operations/pi-context-prune.md`）：Luna 连续解 17 道 SWE-bench Verified Django 题，上下文 token 中位数 −63%，thinking=medium 时解题均值少约 1 题（11.3–11.7 对 12.7）；Grok 4.6 同题集 token −37%、标价费用 −55%，未测到质量损失。

**类型**：独立插件，上游 pi-context-prune 1.4.0（MIT）的自维护 fork。

**文件**：`forks/pi-context-prune/`（源码、测试、已提交的 `dist/`，变更见 `CHANGELOG.md`）、`tools/context-prune-release.py`（发布器）、`docs/operations/pi-context-prune.md`（运维手册）、`.pi/skills/pi-context-prune-local-trial/`（见 3.19）。

**前提**：Pi 0.99.1；无账号要求。路线 B 另需 npm 与 fork 的 devDependencies（`@earendil-works/pi-ai`、`pi-coding-agent`、`pi-tui` 均为 `^0.84.1`，`esbuild@^0.27.2`；fork 不带 lockfile）。

**适用版本**：`1.6.0-local.12`。生产构建 `forks/pi-context-prune/dist/policy-lab.js`（LF 换行）SHA-256 为 `85c86db56d8cd49720bd61df777fa5a2b83009b3f82fee094e15fae256311579`，与维护者本机部署的 `dist/index.js` 一致。在开启 `core.autocrlf` 的 Windows 上重新检出或复制后若变成 CRLF，哈希会不同，核对前先确认换行。发布器不校验 Pi 版本，以无模型加载检查代替。

**安装路线 A：部署已提交构建**（产物结构与发布器 `stage()` 相同，不跑测试）

```powershell
$agent = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
$pkg = Join-Path $agent "local-packages\pi-context-prune"
New-Item -ItemType Directory -Force (Join-Path $pkg "dist") | Out-Null
Copy-Item forks/pi-context-prune/dist/policy-lab.js (Join-Path $pkg "dist\index.js")
Copy-Item forks/pi-context-prune/LICENSE $pkg
node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({name:'pi-context-prune-local',version:'1.6.0-local.12',type:'module',license:'MIT',pi:{extensions:['./dist/index.js']}},null,2)+'\n')" (Join-Path $pkg "package.json")
(Get-FileHash (Join-Path $pkg "dist\index.js") -Algorithm SHA256).Hash
```

最后一行应输出 `85C86DB5…6311579`。然后在 `settings.json` 的 `packages` 追加 `<Pi 用户目录正斜杠路径>/local-packages/pi-context-prune`；全局 `packages` 只保留这一个名字含 `pi-context-prune` 的条目。

配置文件 `<Pi 用户目录>\context-prune\policy-lab.json`（查找顺序：`$PI_CODING_AGENT_DIR\context-prune\`、`$HOME\.pi\agent\context-prune\`、Pi 的 agent 目录）。维护者生产值：

```powershell
New-Item -ItemType Directory -Force (Join-Path $agent "context-prune") | Out-Null
node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({mode:'cold-mask',stageSummary:false,triggerTokens:15000,keepRecentToolTurns:2},null,2)+'\n')" (Join-Path $agent "context-prune\policy-lab.json")
```

合法字段：`mode`（`cold-mask` / `budget-summary`）、`stageSummary`（布尔）、`triggerTokens`（≥1）、`keepRecentToolTurns`（≥0）、`compactionHoldRatio`（0–1，`0` 关闭）、`summarizerModel`、`summarizerThinking`、`summarizerMaxCharsPerResult`、`priceLineRatio`、`priceLines`。文件缺失、JSON 语法错误或任一字段非法时，启动输出一次 `policy-lab:` 开头的告警，整体退回 `cold-mask`、不发摘要请求、`triggerTokens=6000`。

**安装路线 B：发布器**（重跑测试与构建一致性检查、无模型加载检查，并写版本存档供回滚）

发布器的硬性条件（`tools/context-prune-release.py` 源码）：

- `--source` 是独立 Git 工作树的根目录、无未提交改动、当前分支为 `codex/restore-pruner-seen-state`（其它分支需 `--allow-branch`）。`--source` 默认为本目录的 `forks/pi-context-prune`，该快照无 Git 历史、位于分发仓工作树内，发布器会停止；需先复制到 `<extras 目录>` 之外初始化。
- `npm test`（含 `build` 与 `build:lab`）全部通过，且重新构建后工作树仍干净，即本机构建出的 `dist/` 与快照逐字节一致。测试结果按 `ℹ pass N` 解析，维护者本机 Node 24.12.0 下通过。esbuild 解析到不同版本导致产物不同时在此停止，改用路线 A。
- 全局 `settings.json` 的 `packages` 中没有裁剪包条目时，发布器在最后一步追加 `<Pi 用户目录正斜杠路径>/local-packages/pi-context-prune`；已有一个裁剪包条目时，它须已是该固定路径，或用 `--replace-global <旧条目原文>` 切换。
- 加载检查调用 `%APPDATA%\npm\pi.cmd`，以 `PI_OFFLINE=1` 的 RPC 模式只加载暂存包。

```powershell
$src = Join-Path $env:USERPROFILE "pi-context-prune-src"
Copy-Item -Recurse forks/pi-context-prune $src
git -C $src init -b codex/restore-pruner-seen-state
git -C $src add -A
git -C $src commit -m "pi-context-prune 1.6.0-local.12"
Push-Location $src; npm install; Pop-Location
python -B tools/context-prune-release.py status
python -B tools/context-prune-release.py release --source $src
python -B tools/context-prune-release.py release --source $src --apply
```

`--apply` 依次：写版本存档 `<Pi 用户目录>\local-packages\pi-context-prune-releases\<版本>-<提交>\`；为引用裁剪包的项目级 `.pi\settings.json` 补禁用项（只扫描 `PROJECT_ROOTS` 中硬编码的三个维护者本机根目录，见 `tools/context-prune-release.py` 第 50 行；不存在的根目录跳过）；替换固定路径内容；最后改全局 settings。改动前的 settings 备份在 `<Pi 用户目录>\backups\context-prune-release-<时间>\`。版本号中的提交为 `$src` 新提交的哈希。

**验证**

- `python -B tools/context-prune-release.py status`：「全局裁剪包」一行只列固定路径。路线 B 部署后「固定路径」行显示版本与「哈希一致」；路线 A 没有 `BUILD.json`，该行显示「尚未发布」，以文件哈希代替。
- 新开 Pi：启动无 `policy-lab:` 告警，`/pruner-status` 有输出，长会话中出现 `[pruned:tN]` 回执。
- fork 回归：在 `$src` 下执行 `npm test`。测试默认加载 `<全局 Pi 目录>` 自带的 pi-ai，`PI_CONTEXT_PRUNE_TEST_AI_DIST` 可改指其它安装的 pi-ai `dist` 目录。
- `node --test tests/pi/cache_wire_observer.test.mjs` 覆盖裁剪事件读取与诊断管理器，不覆盖裁剪策略本身。

**回滚**

- 路线 B：`python -B tools/context-prune-release.py rollback <版本>-<提交>` 预演，确认后加 `--apply`；可选版本见 `status` 的「存档版本」。
- 暂停：`/pruner-pause` 停止新增裁剪，保留已有回执。
- 移除：从 `packages` 删除该条目并重启 Pi。移除后回执替换逻辑一并消失，已裁剪的会话下一次请求恢复发送全部原文，上下文与费用跳升（fork `CHANGELOG.md` 1.6.0-local.6、`README.md`「Why」）。

**风险与维护**：改变模型看到的历史；每次新增裁剪改写历史中段，造成一次前缀缓存失配（诊断用 3.2）。fork 需自行跟随 Pi 扩展接口变化，升级 Pi 后先跑 fork 测试。

**维护者本机特有**：`tools/context-prune-release.py` 第 50 行的 `PROJECT_ROOTS` 为维护者本机目录，接收方含裁剪包条目的项目级 settings 不会被自动隔离，需手工处理或改该常量。`docs/operations/pi-context-prune.md` 与 fork `README.md` 中的部署路径、远端仓库地址属维护者本机配置。

**取舍**：值得装：长会话、频繁读大文件或跑测试、按 token 计费或订阅额度紧张。不必装：短问答为主；需要模型逐字复用早期工具输出且不愿多一次回查；主要使用 `cursor-host` 模型（Cursor 侧常驻 agent 自持原文，Pi 侧裁剪不缩小其上下文，`tools/pi-cursor-host/README.md`「已知限制」）。

### 3.2 缓存诊断 cache-wire-observer / payload-cache-diag

**作用**：`tools/context-prune-bench/payload-cache-diag.ts` 在 `before_provider_request` 记录每次请求相对同会话上一请求的首个差异位置、instructions / tools / 其余字段是否变化、条目数与字符数，并在 `message_end` 记录用量。`tools/context-prune-bench/cache-wire-observer.mjs` 包装进程内的 `fetch` 与 `WebSocket`，对 Codex（`openai-codex-responses`）与 xAI Responses 记录实际发送帧指纹、全量或增量模式、关联的最近一次裁剪批次和服务端用量。只写哈希、计数与位置，不写正文与凭据。日志为 `<Pi 用户目录>\logs\payload-cache-diag.jsonl` 与 `payload-cache-wire.jsonl`（日志位置遵循 `PI_CODING_AGENT_DIR`）。

**类型**：诊断扩展 + 运维脚本（`tools/context-prune-bench/manage-cache-diag.mjs`）。

**前提**：Pi 0.99.1；无账号。装有 3.9 的 WS recovery 时额外记录其共享计数，未装时该字段为 `null`。

**适用版本**：无版本校验；安装按两个文件的哈希记录。

**安装**

```powershell
node tools/context-prune-bench/manage-cache-diag.mjs status
node tools/context-prune-bench/manage-cache-diag.mjs install
```

管理器把安装记录写在 `runs/native-pi-runtime-20260813/cache-wire-xai-20260928.json`（目录不存在时创建；`rollback` 依据该记录）。安装目标为 `<Pi 用户目录>\extensions\`（不存在时创建），原有同名文件备份到 `.runtime/cache-wire-observer/<时间>/`。新会话或 `/reload` 后生效；观察器是进程级单例，更新观察器代码需重启宿主进程。

**验证**：`status` 输出中两个文件的 `source` 与 `installed` 哈希相同，此时退出 0，未安装或不一致时退出 1；新会话发出一次请求后两份日志出现新行；`node --test tests/pi/cache_wire_observer.test.mjs`。日志分析脚本见 3.3 的 `cache-miss/diag_edit_hits.py`。

**回滚**：`node tools/context-prune-bench/manage-cache-diag.mjs rollback`，按记录恢复原文件或删除新增文件；安装后文件被其它来源改过时拒绝。完成后重启宿主进程。

**风险与维护**：包装全局 `fetch` 与 `WebSocket`（只观察并原样转发，记录出错不阻断发送）；日志不轮转，持续增长需手动清理；安装后对所有会话生效。

**维护者本机特有**：无。

**取舍**：缓存命中下降、裁剪后费用异常时装，查完回滚；日常不装。

### 3.3 裁剪基准 context-prune-bench

**作用**：裁剪与缓存行为的实验、回放与会话分析工具集合。不安装任何东西，也不被其它单元依赖。

| 入口 | 用途 |
| --- | --- |
| `live_ab.py`、`rounds.py`、`batch_report.py` | 单个 Pi RPC 会话连续解 SWE-bench Verified Django 题的活体 A/B（组别 A / B / B8 / C / D / P），多组按轮并行与按预设口径停止，批次汇总 |
| `chain_bench.py` | 依赖链小题集：埋值、无关提问、追问，检查裁剪后能否取回原值 |
| `gold_check.py`、`scan_escapes.py` | 题库体检（打标准答案走同一评分器）；扫描越界读取答案的工具调用 |
| `metrics.py`、`rescore.py`、`context_composition.py`、`reread.py`、`prune_refetch.py`、`price_line_audit.py` | 从 Pi 会话 JSONL 统计 token、重读、回查、价格档越线等 |
| `replay.mjs`、`replay_econ.mjs` | 裁剪策略离线回放 |
| `cache-miss/` | Codex 前缀缓存实验（`cache_lab*.py`、`cache_lab.mjs`）、失配分类、裁剪策略经济回放、诊断日志分析 |
| `cache-replay-20260927/` | 长历史裁剪缓存回放与订阅能力探针，见其 `README.md` |
| `boundary-replay/`、`wire-diag/` | 隔离 SDK 的发送帧与裁剪边界回放 |
| `ripgrep-chain/` | SWE-Milestone ripgrep 13 个里程碑连续链评测，见其 `README.md` |
| `patches/` | fork local.9、local.10 的历史补丁（已并入 `forks/pi-context-prune`） |
| `test-baselines/context-prune-bench/` | Django 题池与已验证实例清单 |

**类型**：研究工具。

**前提**：本地 Django 克隆与带 `asgiref`、`sqlparse` 的 venv（`--base-repo`、`--python`）；ripgrep-chain 另需 SWE-Milestone 官方仓与数据、离线 Rust 工具链、PyYAML；对应 provider 凭据。多数驱动器发出真实模型请求，产生费用。`live_ab.py` 的生产组从 `%USERPROFILE%\.pi\agent\settings.json` 解析当前裁剪包（固定路径）。

**适用版本**：各脚本在 Pi 0.86.0–0.99.1 期间编写，未统一复验；`cache-replay-20260927/README.md` 标注运行条件为 Pi 0.87.1。

**安装 / 验证 / 回滚**：无安装与回滚入口。离线自检 `node --test tools/context-prune-bench/ripgrep-chain/harness/no-network.test.mjs` 不依赖本机数据；`boundary-replay/test.mjs` 经 `candidate.mjs` 按 cwd 导入 `tmp/context-prune-pause-fix/dist/lab-exports.js`，该构建不随分发，缺少时报 `ERR_MODULE_NOT_FOUND`，需要时向维护者索取对应版本的 lab-exports 构建。`wire-diag/test.mjs` 按硬编码路径加载全局 Pi，改路径后才能运行。

**风险与维护**：实验类脚本会创建大量临时工作区与会话；`rounds.py` 须在 Claude 桌面应用进程树之外启动（应用更新会结束其子进程）。`*.jsonl` 采集数据不随分发，`boundary-replay/summarize.mjs <jsonl>` 等分析入口需先用 `run.mjs`、`live.mjs`、`pair-run.mjs` 产生自有采集。

**维护者本机特有**（运行前改参数或源码；以下均为维护者本机的工作根、仓库或全局 Pi 路径）：`live_ab.py` 第 60、331、333 行（`WATERMARK`、`--python`、`--work-root` 默认值）；`gold_check.py` 第 54、57 行；`chain_bench.py` 第 180 行；`scan_escapes.py` 第 25 行；`wire-diag/live.mjs` 第 8 行、`offline.mjs` 第 4 行、`pair-run.mjs` 第 8 行、`test.mjs` 第 9 行、`prepare-pair.py` 第 14–17 行；`ripgrep-chain/` 下 `analyze.py`、`calibrate.py`、`chain.py`、`fetch_testbeds.py`、`harness/driver_lib.py`、`monitor.py`、`quota_guard.py`、`score.py`、`smoke_check.py`、`watch.py` 与 `scenario.json` 的路径常量和批次名。`ripgrep-chain/harness/driver_lib.py` 第 45 行的默认裁剪包来源（环境变量 `PRUNE_BENCH_PRUNER_SOURCE`）指向旧版 npm 发布包。

**取舍**：只在复现或扩展裁剪、缓存研究时使用；日常使用不需要。

### 3.4 pi-cursor-host

**作用**：Pi 模型 provider `cursor-host`，通过官方 `@cursor/sdk` 运行 Cursor local agent。工具执行与系统提示词归 Pi，Cursor 自带的文件、终端类工具全部关闭；每个 Pi 会话对应一个常驻 Cursor agent，工具调用交回 Pi 执行后在同一个 run 内续接。模型列表取自 `Cursor.models.list()`，缓存在 `%USERPROFILE%\.pi\agent\pi-cursor-host\catalog\`（固定路径，不读 `PI_CODING_AGENT_DIR`），无缓存时用 `src/models.ts` 的离线目录。命令：`/login cursor-host`、`/cursor-host-status`。

**类型**：独立插件（模型 provider）。

**前提**：Node ≥ 22.19；Cursor 账号的 User API key（用量记在该账号套餐上）；`@cursor/sdk@1.0.31`（`package-lock.json` 锁定）。

**适用版本**：SDK 钉 1.0.31；不校验 Pi 版本。`tools/pi-cursor-host/docs/compaction-plugins.md` 按 Pi 0.99.1 描述压缩与裁剪扩展的加载入口。

**安装**

```powershell
Push-Location tools/pi-cursor-host; npm ci; Pop-Location
$agent = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
New-Item -ItemType Directory -Force (Join-Path $agent "local-packages") | Out-Null
New-Item -ItemType Junction -Path (Join-Path $agent "local-packages\pi-cursor-host") -Target (Resolve-Path tools/pi-cursor-host).Path
```

在 `settings.json` 的 `packages` 追加 `./local-packages/pi-cursor-host`；需要在模型列表长期显示时把 `cursor-host/*` 加入 `enabledModels`。登录用 `/login cursor-host`，或设置环境变量 `CURSOR_API_KEY`。只试一次不登记：`pi -e tools/pi-cursor-host/index.ts`（必须指向入口文件）。

**验证**：`Push-Location tools/pi-cursor-host; npm test; Pop-Location`（离线单元测试）；Pi 内 `/cursor-host-status` 显示已登录；`/model cursor-host/composer-2.5` 后完成一轮带工具调用的对话。`npm run probe*` 系列探针发出真实请求、消耗 Cursor 额度。

**回滚**：从 `packages` 与 `enabledModels` 删除对应条目；`cmd /c rmdir (Join-Path $agent "local-packages\pi-cursor-host")`（`$agent` 见 1.2；只删联接，不动目标目录）。

**风险与维护**：升级 `@cursor/sdk` 后用 `npm run probe:skills`、`npm run probe:rules` 复核；Cursor 新增模型需对照文档页补 `src/models.ts` 的上下文表；Cursor 运行框架每个模型步约占 5k 输入 token 且无法裁剪；断线重连后助手文字可能重复一遍；用量的费用字段为 0。系统槽未放行的账号上，Cursor 会读取工作目录的 `AGENTS.md`、`CLAUDE.md`、`CLAUDE.local.md`、`.cursor/rules`、技能目录名称与描述。调试变量：`PI_CURSOR_HOST_DEBUG=1`、`PI_CURSOR_HOST_IDLE_MS`、`PI_CURSOR_HOST_SYSTEM_PROMPT=0|1`、`PI_CURSOR_HOST_INSTR_DIR`；放行状态记在 `%USERPROFILE%\.pi\agent\cursor-host.json`（固定路径）。目录联接使分发仓更新直接改变运行代码。

**维护者本机特有**：`README.md` 中 `pi -e` 示例使用维护者插件仓绝对路径，按上面的相对路径执行。

**取舍**：有 Cursor 套餐且想在 Pi 中用 Cursor 托管的模型时装；没有 Cursor 账号时不装。

### 3.5 pi-read-symbol

**作用**：工具 `read_symbol`。给 `path` 与 `name`（可写 `Type::method`、`Class.method`）时返回完整定义及起止行号，连同装饰器、Rust 外部属性与 `///` 文档注释；只给文件时列出全部定义的大纲。底层调用 ast-grep，支持 Rust、Python、TypeScript/TSX、JavaScript、Go；最多返回 8 个匹配，单个定义超过 400 行截断并给出续读偏移。

**类型**：独立插件（工具）。

**前提**：`ast-grep` 在 PATH 上（`winget install ast-grep.ast-grep`；维护者本机 0.45.1），或用 `AST_GREP_BIN` 指定可执行文件；无 npm 依赖，Pi 直接加载 `src/index.ts`。

**适用版本**：无版本校验。

**安装**

```powershell
$agent = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
New-Item -ItemType Directory -Force (Join-Path $agent "local-packages") | Out-Null
New-Item -ItemType Junction -Path (Join-Path $agent "local-packages\pi-read-symbol") -Target (Resolve-Path tools/pi-read-symbol).Path
```

在 `packages` 追加 `./local-packages/pi-read-symbol`。

**验证**：`ast-grep --version`；`Push-Location tools/pi-read-symbol; npm test; Pop-Location`；新会话工具列表含 `read_symbol`。

**回滚**：删除 `packages` 条目；`cmd /c rmdir (Join-Path $agent "local-packages\pi-read-symbol")`。

**风险与维护**：低；ast-grep 输出格式变化时测试会报红。

**维护者本机特有**：无。

**取舍**：已装控制面时推荐：控制面角色卡（`ops/agents/*.toml`）的工具白名单含 `read_symbol`，未安装时只记 warning（`HANDOVER.md` 第 4 节）。不用控制面且很少读大型源码文件时可不装。

### 3.6 pi-scheduler-native

**作用**：工具 `wake_agent`（按 `after` 与 `reason` 创建一次或有限次唤醒）、`schedule_command`（定时命令，按 Pi 的 `shellPath` 解析 shell）、`manage_wake_tasks`（列出、取消、更新、清理）。忙碌期间每个任务只保留一个待投递事件，空闲后以带来源的扩展消息唤醒。任务保存在 `<Pi 用户目录>\state\pi-scheduler-native\tasks.json`（遵循 `PI_CODING_AGENT_DIR`，`PI_SCHEDULER_NATIVE_STATE_FILE` 可改）。定时器依赖 Pi 进程存活。

**类型**：独立插件。

**前提**：npm 依赖 `croner@10.0.1`、`fs-native-extensions@1.5.1`（操作系统文件锁）。

**适用版本**：无版本校验；README 记录 Windows / Node 24.12.0 / Pi 0.99.1 下 27 项包测试与 7 项集成测试通过。其它平台与远程文件系统未验证。

**安装**（复制为独立副本，避免分发仓更新改动运行中的调度器）

```powershell
$agent = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
$dst = Join-Path $agent "local-packages\pi-scheduler-native"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item -Recurse -Force tools/pi-scheduler/native/* $dst
Push-Location $dst; npm install --omit=peer --no-audit --no-fund; Pop-Location
```

在 `packages` 追加 `<Pi 用户目录正斜杠路径>/local-packages/pi-scheduler-native`。不与 `@jl1990/pi-scheduler` 同时启用；从旧调度器迁移时先停用旧插件，再在 `$dst` 下执行 `npm run migrate`（只预览），审阅后 `node scripts/migrate-legacy.mjs --apply`（导入任务保持暂停，不改旧状态文件；`--legacy`、`--state` 可指定路径）。

**验证**：在 `$dst` 下 `npm test`；集成测试 `$env:PI_SCHEDULER_TEST_PI_ROOT = "<全局 Pi 目录>"; node --test tests/pi/pi_scheduler_native.test.mjs`（不设该变量时回退到维护者本机路径）；新会话工具列表含三个工具。

**回滚**：删除 `packages` 条目并重启 Pi。任务文件保留在原位。

**风险与维护**：README 列出的未覆盖范围：会话切换、命令超时后的进程树退出、长时保活、旧任务迁移样本、cron 实际触发。切换锁实现前须停止所有旧版参与者。Pi Web 的会话保活接口不存在时自动跳过。

**维护者本机特有**：`extensions/scheduler/liveness.cjs` 的注释引用维护者 Pi Web 源码路径（不影响运行）；`tests/pi/pi_scheduler_native.test.mjs` 第 22 行的回退路径。

**取舍**：需要让 agent 定时回来检查任务、定时跑命令时装；只做交互式短任务时不装。控制面对子代理关闭该插件（`ops/templates/worker-resources.json` 中为 `off`）。

### 3.7 全局系统尾注 pi-global-system-tail

**作用**：两部分。`local-time.ts` 在每轮 `before_agent_start` 写入具名段 `local_time`，内容为 `<time-discipline>今日日期: <日期> (UTC+8)。</time-discipline>`，同一天输出不变；`APPEND_SYSTEM.md` 放在 `<Pi 用户目录>` 根，Pi 把它追加到系统提示词。`APPEND_SYSTEM.md` 由 `global-style.md` 生成，不单独维护。

**类型**：独立插件 + 提示词模板。

**前提**：无账号与依赖。`global-style.md` 是维护者个人的协作风格与偏好（含对维护者本人的描述及维护者本机工具目录路径），需改写后使用；时区写死为 `Asia/Shanghai`。

**适用版本**：无版本校验。项目级 `.pi/APPEND_SYSTEM.md` 优先于 agent 目录同名文件，两者不合并（`<全局 Pi 目录>\docs\configuration.md`）。

**安装**

```powershell
# 先改写 artifacts/templates/pi-global-system-tail/global-style.md；其它时区改 local-time.ts
node tools/render-pi-global-system-tail.mjs --write
$agent = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
$pkg = Join-Path $agent "local-packages\pi-global-system-tail"
New-Item -ItemType Directory -Force $pkg | Out-Null
Copy-Item artifacts/templates/pi-global-system-tail/* $pkg -Force
if (Test-Path (Join-Path $agent "APPEND_SYSTEM.md")) { Copy-Item (Join-Path $agent "APPEND_SYSTEM.md") (Join-Path $agent "APPEND_SYSTEM.md.bak") }
Copy-Item artifacts/templates/pi-global-system-tail/APPEND_SYSTEM.md (Join-Path $agent "APPEND_SYSTEM.md") -Force
```

在 `packages` 追加 `./local-packages/pi-global-system-tail`。只要日期注入时，跳过最后两行，并让 `APPEND_SYSTEM.md` 保持接收方自己的内容（此时 `--check` 会报 agent 根漂移）。

**验证**：`node tools/render-pi-global-system-tail.mjs --check` 输出 `APPEND_SYSTEM_OK` 与 `DEPLOYMENT_OK`（比对模板、包目录 5 个文件与 agent 根的 `APPEND_SYSTEM.md`；`--agent-root` 默认 `%USERPROFILE%\.pi\agent`，不读 `PI_CODING_AGENT_DIR`，其它 agent 目录用它指定）；`node --test tests/pi/global_system_tail.test.mjs`（改过 `local-time.ts` 的时区后，测试中 UTC+8 的断言需同步）。

**回滚**：用 `APPEND_SYSTEM.md.bak` 还原或删除 `<Pi 用户目录>\APPEND_SYSTEM.md`；删除 `packages` 条目。无回滚脚本。

**风险与维护**：`APPEND_SYSTEM.md` 进入每个主会话的系统提示词，正文长度直接计入每次请求。Pi 0.99.1 原版中由自定义消息启动的运行（子代理完成通知、定时唤醒）不经过 `before_agent_start`，那一轮缺少日期段、造成前缀变化；3.9 的 prompt-stability 宿主补丁修复此问题。

**维护者本机特有**：`global-style.md` / `APPEND_SYSTEM.md` 第 187–188 行的本机环境地图与探查脚本路径，以及全文个人偏好；`README.md` 第 31、36 行的部署命令使用维护者插件仓绝对路径。

**取舍**：日期注入通用且成本低；全局风格正文按接收方偏好重写后再部署，原文不直接使用。控制面对子代理关闭该插件。

### 3.8 pi-paste-image

**作用**：注册 `/img`。用 PowerShell 读取 Windows 剪贴板图片，存为 `%TEMP%\pi-clipboard-<uuid>.png`，把路径写入输入框，回车即发送。剪贴板无图片时只提示。

**类型**：独立扩展（Pi 自动加载 `<Pi 用户目录>\extensions\` 下的文件，不经 `packages`）。

**前提**：Windows、`powershell.exe`、交互式界面（无 UI 的 RPC 宿主中命令不生效）。

**适用版本**：无版本校验。

**安装**：按 1.2 取得 `$agent` 后 `Copy-Item tools/pi-paste-image/paste-image.ts (Join-Path $agent "extensions\paste-image.ts")`，已有会话 `/reload`。

**验证**：`node tools/pi-paste-image/status.mjs` 输出 `PASTE_IMAGE_OK` 并退出 0（比对源与 `<Pi 用户目录>\extensions\paste-image.ts` 的哈希）；截图后在 Pi 输入 `/img`。

**回滚**：删除 `<Pi 用户目录>\extensions\paste-image.ts` 后 `/reload`。

**风险与维护**：临时 PNG 不自动清理，留在 `%TEMP%`。

**维护者本机特有**：无。

**取舍**：在终端 Pi 中经常贴截图时装；终端已能直接粘贴图片或不在 Windows 上时不装。控制面对子代理关闭该扩展。

### 3.9 Pi 本体补丁：pi-codex-attribution、pi-prompt-stability、pi-ws-recovery

**作用**

- `pi-codex-attribution`：移植上游 Pi PR 9488（未合并）到 0.99.1。openai-codex 请求在同一用户轮内的工具循环与重试共享请求身份，下一用户轮生成新 turn ID；压缩成功写入分支后推进窗口编号；保存并回传服务端 `x-codex-turn-state`；WS 增量比较忽略身份元数据。载荷已包含 WS recovery。
- `pi-ws-recovery`：openai-codex 的 WebSocket 失败后以 SSE 兜底，恢复探针按 30、60、120、240、300 秒退避，每个会话同时只一个探针；`1009 message too big` 后请求体缩小至少 20% 才恢复探测；缓存 WS 的空闲 TTL 由 5 分钟提高到 15 分钟。
- `pi-prompt-stability`（0.99.1 宿主部分）：由自定义消息（子代理完成通知、定时唤醒）启动的运行先执行 `before_agent_start` 并应用提示增量，`event.trigger` 区分 `prompt` 与 `custom`（上游 issue 5581）；上下文用量保留已测量前缀，只重新估算其后被编辑的消息。

`tools/pi-codex-attribution/README.md` 写明：协议一致性测试通过不等于缓存命中率提高，部署后的缓存与费用收益未测量。

**类型**：Pi 本体补丁，改写 `<全局 Pi 目录>` 下 `dist/` 及嵌套 `node_modules/@earendil-works/pi-ai`、`pi-agent-core` 的构建产物（0.99.1：attribution 72 个文件、prompt-stability 20 个、独立 WS 9 个）。

**前提**

- `<全局 Pi 目录>` 为未改动的 npm 安装，版本 0.99.1 或 0.87.1（WS recovery 另支持 0.84.x–0.86.0）；其它版本见下方「版本不是 0.99.1 时」。
- 补丁载荷五份（0.99.1 三份、0.87.1 两份），放在下列位置时管理器按 Pi 版本自动选用，并按清单校验 SHA-256：

| 载荷 | 路径 | SHA-256 |
| --- | --- | --- |
| attribution（含 WS） | `.runtime/pi-codex-attribution/0.99.1/payload.json.gz` | `8726eac13baf770c77003b3643d2f765f953bf561fb3fb7153b8fbef10c85869` |
| 独立 WS | `.runtime/pi-codex-attribution/0.99.1/ws-payload.json.gz` | `7959ca20c1c470d589b3d4e40aa6e54424be253f516451641f88dd600ae5de06` |
| prompt-stability 宿主 | `.runtime/pi-prompt-stability/0.99.1/host-payload.json.gz` | `cf147bde5ff012cc0611717dfbf0a3b07882c0d064edb7225829c9ef2f4113f5` |
| attribution（0.87.1） | `.runtime/pi-codex-attribution/payload.json.gz` | `83d1e5d11b27cf46e0f0cf5315890cb122c8efbec111722c61db3e4b7f7982dc` |
| prompt-stability 宿主（0.87.1） | `.runtime/pi-prompt-stability/host-payload.json.gz` | `08ec9a9cef6f7e07e9f8723e7b9da43dd4984b4b77df1dd4d623d31a34ff2c93` |

  五份载荷随分发提供，位于上表路径。文件缺失或哈希不符时二选一：向维护者索取后放到上表路径；或按 `tools/pi-codex-attribution/README-0.99.1.md` 重建——需要 Pi 上游 tag `v0.99.1`（提交 `d86654abb8862e201933517d6f1fce9f88dd117f`）的源码放在 `tmp/pi-upstream-review-20260930/pi-0.99.1`、一份全局布局的原版 npm 0.99.1 安装放在 `tmp/pi-0991-upgrade/runtime/node_modules/@earendil-works/pi-coding-agent`（其下须有嵌套的 `node_modules/@earendil-works/pi-ai` 与 `pi-agent-core`），并把文中写死的维护者插件仓绝对路径换成 `<extras 目录>`、`npm-cli.js` 路径换成本机 Node 安装下的对应文件。重建会改写三个 `manifest-0.99.1.json`；产物能否与维护者载荷逐字节一致未验证。

**适用版本**：attribution 与 prompt-stability 有 0.87.1 与 0.99.1 两套清单；WS 管理器接受 pi-ai 0.84.1、0.84.3、0.84.4、0.85.1、0.86.0、0.87.1、0.99.1 与 bundle 0.84.3–0.99.1 的固定哈希。三者都先核对版本与逐文件哈希，版本不符或哈希未知时拒绝写入。

**版本不是 0.99.1 时**

管理器读取 `<全局 Pi 目录>\package.json` 的版本选清单：没有对应清单时报 `Unsupported Pi version`，文件哈希与清单不符时状态为 `unknown`，两种情况都不写入。这道检查按文件哈希防止把补丁写进不匹配的 Pi 程序文件，不要绕过（不改清单里的哈希，不手工拷贝载荷内的文件）。Pi 本身与控制面不依赖这三个补丁，版本不符时按下列顺序选一条，选不了就跳过，不影响其它单元：

1. 换到 0.99.1（推荐）：`npm i -g @earendil-works/pi-coding-agent@0.99.1`，重启所有 Pi 进程后按下文「安装」执行。0.99.1 也是控制面实测的版本（控制面 `adapters/pi` 的 Pi 依赖钉在 0.99.1）。
2. 用 0.87.1：attribution 与 prompt-stability 有 0.87.1 的清单和载荷，管理器按版本自动选用，命令与下文相同。0.87.1 上 prompt-stability 除宿主部分外还管理 `pi-hermes-memory@0.9.8` 与全局系统尾注两个扩展（见 `tools/pi-prompt-stability/README.md`），未装这两个扩展时加 `--host-only`。
3. 只装 WS recovery：0.84.x–0.86.0 上只有 `tools/pi-ws-recovery/manage-pi-ws-recovery.mjs` 可用（接受的固定哈希见上文「适用版本」），attribution 与 prompt-stability 跳过。
4. 跳过三个补丁：其它版本（含高于 0.99.1 的版本）不装。缺少它们时 Pi 照常工作，只是没有 Codex 请求身份与 turn-state 保持、WS 断线降级与恢复、唤醒运行时提示段稳定这几项改进。
5. 移植到新版本：按 `tools/pi-codex-attribution/README-0.99.1.md` 的隔离构建流程，把源码 tag、原版安装与清单换成目标版本，生成新的 `manifest-<版本>.json` 与载荷。工作量大，结果先在隔离副本上通过验收再写入全局 Pi。

Pi 升级时 npm 会整体覆盖这些程序文件，补丁随之消失，Pi 不会损坏；升级后先运行 `status` 确认状态，再按新版本从上面重新选择。

**安装**（attribution 在前、prompt-stability 叠加在后）

```powershell
python -B tools/pi-codex-attribution/manage.py status
python -B tools/pi-codex-attribution/manage.py apply
python -B tools/pi-prompt-stability/manage.py status --host-only
python -B tools/pi-prompt-stability/manage.py apply --host-only
```

attribution 的 `status` 在原版 0.99.1 上应为 `baseline`。prompt-stability 宿主补丁以 attribution 打完后的文件为基线，所以它的 `status --host-only` 要在 attribution `apply` 之后看，此时应为 `baseline`；在原版上直接看会是 `unknown`。`--root` 默认 `%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent`，npm 全局前缀不同时每条命令加 `--root "<全局 Pi 目录>"`。完成后重启所有 Pi 进程。

只要 WS recovery、不要 attribution 时，用独立 WS 载荷，并显式给目标：

```powershell
node tools/pi-ws-recovery/manage-pi-ws-recovery.mjs apply --bundle-target "global=<全局 Pi 目录>" --target "global-ai=<全局 Pi 目录>\node_modules\@earendil-works\pi-ai"
```

独立 WS 不能与 attribution 叠加：attribution 以原版为基线，其载荷已含 WS。先装了独立 WS 又要 attribution 时，先用同样的目标执行 `rollback`。

WS 管理器不给 `--target` / `--bundle-target` 时，默认目标为全局 Pi、`<Pi Web 应用目录>`（环境变量 `PI_WEB_APP_ROOT`，未设置时取 `manage-pi-ws-recovery.mjs` 第 187 行写死的维护者本机路径）与控制面子代理 worker（`PI_SUBAGENT_ADAPTER_ROOT`，默认 `<Pi 用户目录>\extensions\subagent-control\adapters\pi`）。后两者未设置环境变量且默认位置不存在时跳过，用环境变量指定却不存在时报错。给出任一显式目标时只处理给出的目标；本节的独立 WS 命令都显式给出全局 Pi 的两个目标。控制面 worker 目录下若有 `node_modules\@earendil-works\pi-coding-agent`，它是另一份独立安装，需要时对其单独执行 `manage.py ... --root <该目录>`；控制面重新部署会覆盖它。

**验证**

```powershell
python -B tools/pi-codex-attribution/manage.py status
python -B tools/pi-prompt-stability/manage.py status --host-only
node tools/pi-ws-recovery/manage-pi-ws-recovery.mjs status --bundle-target "global=<全局 Pi 目录>" --target "global-ai=<全局 Pi 目录>\node_modules\@earendil-works\pi-ai"
node tools/pi-codex-attribution/verify-installed.mjs
node tools/pi-prompt-stability/verify-installed.mjs
node --test tests/pi/projected_context_usage.test.mjs
```

期望：attribution 为 `patched+prompt-stability`，prompt-stability 的 `host` 为 `patched`，WS 两个目标为 `patched`（全部 patched 时退出 0）。两个 `verify-installed.mjs` 用已安装的 SDK 与内存凭据、进程内 WebSocket 离线运行，检查同轮身份稳定、下一轮更新、提示段稳定与压缩窗口推进（prompt-stability 的临时目录默认 `test-results/pi-0991-upgrade/host/offline-agent`）。`projected_context_usage.test.mjs` 默认读取 `<全局 Pi 目录>`，`PI_TEST_PACKAGE_ROOT` 可改。隔离候选上的完整验收见 `README-0.99.1.md`「Offline acceptance」；其中 `tests/pi/run_0991_host_verification.py` 要求候选位于 `tmp/pi-0991-upgrade/runtime`，它调用的 `tests/pi/test_pi_codex_attribution.py` 等测试均在本目录。

**回滚**（逆序）

```powershell
python -B tools/pi-prompt-stability/manage.py rollback --host-only
python -B tools/pi-codex-attribution/manage.py rollback
```

回滚从 `.runtime/pi-prompt-stability/0.99.1/backups/` 与 `.runtime/pi-codex-attribution/0.99.1/backups/`（按安装路径哈希分目录）读取原文件；独立 WS 的备份在 `.runtime/pi-codex-attribution/0.99.1/ws-backups/`。备份丢失时可重装 `@earendil-works/pi-coding-agent@0.99.1` 恢复原版文件。回滚后重启所有 Pi 进程。

**风险与维护**：直接改全局 Pi 程序文件；任何 npm 重装或升级都会覆盖，升级到新版本后管理器拒绝写入，需在新版本重新移植并重建载荷。磁盘 `patched` 不代表长驻进程已加载。改用新版本 Pi 前先回滚或确认补丁已被上游等价实现。

**维护者本机特有**：`README-0.99.1.md` 第 12、20 行的构建路径；`manage-pi-ws-recovery.mjs` 第 187 行的 Pi Web 默认路径（默认位置不存在时跳过）；`tests/pi/pi_ws_recovery_state.test.mjs` 第 7 行的回退路径（设置 `PI_WS_TEST_PI_AI_ROOT` 覆盖）。

**取舍**：attribution 与 WS 只作用于 `openai-codex` provider（ChatGPT / Codex 订阅登录），只用其它 provider 时对请求没有影响。重度使用 openai-codex、WS 经常断线或出现 1009 时值得装。prompt-stability 与 provider 无关，在装了控制面（子代理完成通知会触发自定义消息运行）且有扩展写入具名提示段（如 3.7 的日期段）时减少前缀失配；它只能叠加在 attribution 之上（`apply` 要求 attribution 处于 `patched`），单独需要它时也要先装 attribution。拿不到载荷又不愿重建时三件都不装。

### 3.10 pi-web-answer-alias

**作用**：修改 `<Pi npm 目录>\pi-web-access` 的 `page-query.ts`、`feature-config.ts`、`index.ts`。`fetch_content` 的 answer 模式改用 `web-search.json` 的 `pageAnswer.model` 与 `pageAnswer.reasoning`（无配置时 `openai-codex/gpt-5.6-luna` / `low`），经 `completeSimple` 传递推理档位；请求经控制面别名扩展的 `rewriteCodexPayload` 把 Codex 显示别名换成上游 ID；输出被截断（`stopReason=length`）时报错。普通网页读取、搜索摘要、主会话模型不变。

**类型**：第三方包补丁。

**前提**：`pi-web-access@0.21.0`（控制面 bootstrap 安装）；`<Pi 用户目录>\extensions\openai-codex-sol-context-alias.ts`（控制面 bootstrap 安装，缺失时脚本直接报错）；`pageAnswer.model` 使用 openai-codex 时需要该 provider 登录。配置文件位置按 `PI_CODING_AGENT_DIR\web-search.json`、`XDG_CONFIG_HOME\pi\web-search.json`、`%USERPROFILE%\.pi\web-search.json` 的顺序查找。

**适用版本**：README 写明适用 0.21.0。脚本不校验版本号，按源码锚点识别；锚点不匹配时报错且不写文件。

**安装**：`node tools/pi-web-answer-alias/apply.mjs`（作用于 `<Pi 用户目录>`；重复执行只写有变化的文件）。新会话或 `/reload` 后生效。

**验证**：再次执行 `apply.mjs` 输出 `"changed": false`；`node --test tests/pi/web_answer_alias.test.mjs`（固定读取 `%USERPROFILE%\.pi\agent` 下已安装的控制面别名扩展与 `pi-web-access`，以及 `%USERPROFILE%\AppData\Roaming\npm` 下的全局 Pi；在临时副本上用模型回执替身，不发网络请求）。

**回滚**：无回滚入口，写入前不备份。恢复原版需重装该包（如先 `pi remove npm:pi-web-access@0.21.0` 再 `pi install npm:pi-web-access@0.21.0`；本目录未验证该流程）。

**风险与维护**：`pi-web-access` 任何重装或升级都会覆盖补丁，重装后重跑 `apply.mjs`。补丁以静态相对路径导入控制面别名扩展，之后删除该扩展会使 `pi-web-access` 加载失败（推断，依据为 `apply.mjs` 写入的 import 语句）。

**维护者本机特有**：`README.md` 第 3 行引用控制仓本机路径。

**取舍**：已装控制面且有 openai-codex 登录时推荐：控制面已写入 `pageAnswer` 配置，原版 0.21.0 不读它，answer 模式按上游行为使用当前会话模型（`HANDOVER.md` 第 4 节）。没有 openai-codex 登录时，先把 `pageAnswer.model` 改为可用的 `provider/model-id` 再打补丁，或者不打。

### 3.11 pi-antigravity

**作用**

- Windows 不闪窗（`status` / `apply` / `rollback`）：`@tian.zuo/pi-antigravity` 在 Windows 上以 `detached: true` 启动 `agy`，持续会话中的 `run_command` 每次都可能弹出 PowerShell 窗口。补丁把 5 处 spawn 改为 `detached: process.platform !== "win32"` 并加 `windowsHide: true`，POSIX 行为不变，Windows 进程树仍由 `taskkill /T` 清理。受管文件：`lib/agy-client.ts`、`lib/agy-diagnostics.ts`、`lib/agy-driver.ts`、`lib/usage.ts`、`lib/agy-children.ts`。
- 原生接线（`native-*`）：以上游 0.10.3 加 Windows 补丁为基底，应用 `pi-antigravity-0.10.3-native.patch` 生成本地包 `@local/pi-antigravity-native@0.1.0`。Pi 的有效系统内容经专属 `agent.md` 交给 Antigravity，MCP 请求转为 Pi 工具调用、由 Pi 宿主执行；认证沿用 Antigravity CLI 的登录。

**类型**：第三方包补丁 + 本地生成包。

**前提**：Antigravity CLI（`agy`）已安装并登录（`docs/operations/pi-antigravity-native.md` 记录验证时为 1.2.17，维护者本机当前 `agy --version` 为 1.3.1）；`pi install npm:@tian.zuo/pi-antigravity@0.10.3`，且 `settings.json` 有该 npm 条目（`native-install` 据此替换）；Git；Pi 0.99.1。

**适用版本**：Windows 补丁只接受 0.9.0、0.10.1、0.10.3 的五个受管文件的已知哈希；原生接线只针对 0.10.3。包名、版本、文件哈希或补丁哈希不符时拒绝写入。

**安装**

```powershell
node tools/pi-antigravity/manage-pi-antigravity.mjs status
node tools/pi-antigravity/manage-pi-antigravity.mjs apply
node tools/pi-transcript-hydrate/apply.mjs status
node tools/pi-transcript-hydrate/apply.mjs apply
node tools/pi-antigravity/manage-pi-antigravity.mjs native-build --json
node tools/pi-antigravity/manage-pi-antigravity.mjs native-install --json
```

- 只用上游包时执行前两行（Windows 补丁）并按 3.12 接上 hydrate，之后对运行中的 Pi `/reload`。默认目标 `<Pi npm 目录>\@tian.zuo\pi-antigravity`，`--target <包目录>` 可改；写入前备份到 `.runtime/pi-antigravity-backups/<版本>/<状态>/`。
- 原生补丁的基底是带 hydrate 接线的上游包：`src/provider.ts` 有两行 `hydrateContext` 钩子，`src/transcript-compat.ts` 等于 `tools/pi-transcript-hydrate/transcript-compat.ts`。npm 发布的 0.10.3 两项都没有，3.12 的 `apply` 也因缺钩子拒绝；先按 3.12 手工补钩子，再执行第 3、4 行，然后 `native-build`。基底不符时 `native-build` 在写生成目录前报错。按此顺序从 npm 原版构建出的生成包与维护者现役生成包的 36 个文件哈希一致。
- `native-build` 把生成包写到 `.runtime/pi-antigravity-native/`，依赖链接到 `<Pi npm 目录>` 与 `%APPDATA%\npm` 下的全局 Pi SDK，并写 `native-manifest.json`。`native-install` 把 `packages` 中的 `npm:@tian.zuo/pi-antigravity[@版本]` 条目替换为该目录的绝对路径，原条目记在 `.runtime/pi-antigravity-native-install.json`；`--settings`、`--runtime`、`--source` 可改默认路径。安装后重启 Pi。

**验证**

```powershell
node tools/pi-antigravity/manage-pi-antigravity.mjs status
node tools/pi-antigravity/manage-pi-antigravity.mjs native-status --json
node --test tests/pi/pi_antigravity_manager.test.mjs
node --test tests/pi/antigravity_native_install.test.mjs tests/pi/pi_antigravity_native.test.mjs
node tools/pi-antigravity/run-native-smoke.mjs --load-only
```

`status` 为 `patched` 时退出 0；`native-status` 仅在 `state: ready`、`configured: true`、`upstreamConfigured: false` 时退出 0。`--load-only` 不调用远端模型；去掉该参数执行真实探针（`--model` 默认 `gemini-3.6-flash`，`--evidence` 指定记录目录，默认写到 `test-results/`）。零闪窗的最终确认需在桌面观察连续多次 `run_command`（`docs/operations/pi-antigravity-windows-no-flash.md`）。`PI_ANTIGRAVITY_TEST_PACKAGE`、`PI_TEST_ANTIGRAVITY_NATIVE_ROOT` 可把测试指向影子副本或其它构建目录。

**回滚**

```powershell
node tools/pi-antigravity/manage-pi-antigravity.mjs native-rollback --json
node tools/pi-antigravity/manage-pi-antigravity.mjs rollback
```

`native-rollback` 把 `packages` 条目恢复为原上游条目并保留安装后的其它设置变化；备份记录须属于同一 settings 与生成目录。随后重启 Pi。

**风险与维护**：npm 更新覆盖 Windows 补丁，更新后先 `status`；原生包固定在 0.10.3 基底，上游升级需重新移植差异并重建；`settings.json` 指向 `<extras 目录>\.runtime\pi-antigravity-native`，该目录不可移动或删除；原生安装后 `settings.json` 不再登记上游 npm 条目，而生成包的依赖链接到上游包所在的 `<Pi npm 目录>`，`pi update` 对账时是否清理上游包未验证。Shell 的操作系统权限与 Pi 相同；CLI 续接旧 conversation 时保留原始 system。源码修改流程（`native-patch`、开发副本 `packages/pi-antigravity-native/`）见 `docs/operations/pi-antigravity-native.md`。

研究脚本：`tools/pi-antigravity/pi-tool-trial.mjs`、`prepare-pi-tool-trial.mjs`、`run-pi-tool-trial.mjs` 与 `fixtures/` 是早期工具试验路线（回归 `tests/pi/pi_antigravity_tool_trial.test.mjs`、`pi_antigravity_trial_cancel.test.mjs`）；`probe-native-system-update.mjs` 依赖未随分发的 `tmp/antigravity-wire-capture-20261006/agy-capture.exe`，在本目录不能运行。

**维护者本机特有**：无硬编码用户路径；生成目录、备份与证据都相对 `<extras 目录>`。

**取舍**：有 Antigravity 账号并装了 `agy` 时按需装；只用上游包时至少装 Windows 补丁。没有 Antigravity 账号时不装。控制面把 `@tian.zuo/pi-antigravity` 与 `@local/pi-antigravity-native` 列为子代理默认加载的模型接入（`ops/templates/worker-resources.json`）。

### 3.12 pi-transcript-hydrate

**作用**：Pi 0.86.0 起 provider 只收到 transcript。`hydrateContext()` 适配器用官方 API 恢复系统提示与工具，供仍读旧 Context 字段的 provider 使用。默认目标为上游 `@tian.zuo/pi-antigravity` 的 `src/transcript-compat.ts`；`pi-claude-code-provider` 是 legacy 目标，0.4.0 起已内联恢复，0.6.0 上 legacy `apply` 会因缺少调用点拒绝。

**类型**：第三方包补丁。

**前提**：目标包已安装且源码中存在 `hydrateContext` 调用点（npm 发布的 Antigravity 0.10.3 没有，需手工补，见安装）；Pi 0.99.1。

**适用版本**：不校验版本号，以调用点存在为条件。`apply` 与 `verify` 在缺包或缺调用点时非零退出；`status` 只输出报告、恒为退出 0，要读其中的 `present`、`missingHooks`、`compatMatches`，作为检查门时用 `verify`。

**安装**：npm 新装的 Antigravity 0.10.3 先在 `src/provider.ts` 两处锚点后各加一行钩子（锚点与新增行见 `tools/pi-transcript-hydrate/README.md`「全新安装的 Antigravity」）。然后 `node tools/pi-transcript-hydrate/apply.mjs status`、`node tools/pi-transcript-hydrate/apply.mjs apply`（`--target <id>` 可重复，`<id>` 为 `@tian.zuo/pi-antigravity` 或 `pi-claude-code-provider`；目标目录为 `<Pi npm 目录>`）。覆盖前备份到 `.runtime/pi-transcript-hydrate-backups/`。之后 `/reload`。

**验证**：`node tools/pi-transcript-hydrate/apply.mjs verify`（全部目标存在、内容一致、调用点完整时退出 0）；`node --test tests/pi/transcript_hydrate.test.mjs tests/pi/claude_transcript_compat.test.mjs`（后者用全局 Pi SDK 与 Claude provider 源码，`PI_TEST_SDK_ROOT`、`PI_TEST_CLAUDE_PROVIDER_ROOT` 可改，不启动 Claude 进程）。

**回滚**：无回滚命令；从 `.runtime/pi-transcript-hydrate-backups/<包名>/src/transcript-compat.ts` 复制回原位，或重装目标包（同时还原手工钩子）。

**风险与维护**：`pi update` 可能覆盖未钉版本的包；升级后先 `status`，调用点变化时先移植适配，上游原生恢复后停止维护该目标。

**维护者本机特有**：无。

**取舍**：使用上游 Antigravity 包（未装原生接线）或准备执行 `native-build` 时装；不用 Antigravity 时不装。

### 3.13 pi-computer-use-qt-fix

**作用**：修正 `@injaneity/pi-computer-use@0.5.1` 的 Windows 原生 helper（`native/windows/bridge-rs`，Rust）与 TypeScript 前端。

| 补丁 | 改动对象 | 内容 |
| --- | --- | --- |
| `native.patch` | `src/capture.rs`、`main.rs`、`refs.rs`、`uia.rs` | 修正手写的 UIA 控件类型编号；空 RuntimeId 不参与身份匹配（Qt 控件），以 `CompareElements` 判定命中；空身份不再被误报为遮挡 |
| `window-root.patch` | `src/main.rs` | 外层窗口节点与其 UIA 根共享观察身份，窗口级输入走同样的前台、可见性与遮挡检查 |
| `visual-observation.patch` | `src/main.rs`、`capture.rs` | 目标在前台时用屏幕区域 BitBlt 截图，后台仍用 PrintWindow；alpha 统一不透明；截图不主动激活窗口 |
| `focused-input-foreground.patch` | `src/main.rs` | 保持焦点的物理输入发送前核验前台窗口，归属不符时拒发 |
| `frontend-focus.patch` | `src/bridge.ts` | 非 headless 事务以操作系统当前焦点为初始焦点，支持跨调用的点击、输入、回车 |
| `visual-observation-frontend.patch` | `src/bridge.ts`、`platform/types.ts`、`platform/windows/backend.ts`、`outline.ts` | 视觉观察与纯图片动作后的刷新不提取控件树，沿用原图尺寸；语义模式保留 UIA |

**类型**：第三方包补丁（原生 helper 需重新编译）。

**前提**：`pi install npm:@injaneity/pi-computer-use@0.5.1`；Rust 工具链（`cargo`，维护者本机 1.98.1）；Python 与 `psutil`；Git。测试脚本另需 PyQt5（`qt-fixture.py`）、pywin32（`test-common-apps.py`）。

**适用版本**：`manage-installed.py` 只接受包版本 0.5.1，并要求已安装源码的哈希等于候选构建记录的基线，否则拒绝写入。

**安装**：完整步骤见 `tools/pi-computer-use-qt-fix/README.md`。原生补丁每次构建一份候选并安装：

```powershell
$agent = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
$cu = Join-Path $agent "npm\node_modules\@injaneity\pi-computer-use"
python -B tools/pi-computer-use-qt-fix/build-candidate.py --source "$cu\native\windows\bridge-rs" --work-dir <新的空目录> --patch tools/pi-computer-use-qt-fix/native.patch
python -B tools/pi-computer-use-qt-fix/manage-installed.py apply --candidate <同一目录> --record <新的记录文件.json>
```

`build-candidate.py` 复制源码到 `--work-dir`（须为新目录，且在 `%USERPROFILE%\.pi\agent` 之外）、以 `git -c core.autocrlf=true apply` 应用补丁、`cargo test`、`cargo build --release`，写 `candidate-build.json`。`manage-installed.py` 默认作用于 `%USERPROFILE%\.pi\agent`（不读 `PI_CODING_AGENT_DIR`，其它目录用 `--agent-home` 指定）；`apply` 备份到 `<agent 目录>\state\deploy\pi-computer-use-qt-<时间>\`，停止正在运行的 `windows-bridge.exe`，替换已安装源码、包内 `prebuilt\windows\windows-bridge.exe` 与 `<agent 目录>\helpers\pi-computer-use\windows-bridge.exe`，不改 `settings.json`；`--record` 必须是新路径。原生补丁按 `native.patch`、`window-root.patch`、`visual-observation.patch`、`focused-input-foreground.patch` 的顺序逐个构建并安装，后一次以已安装（已含前一补丁）的源码为 `--source`。在原版 0.5.1 源码上按此顺序应用，结果与维护者部署的源码逐字节一致；后三份补丁的上下文按 CRLF 生成，所以 `build-candidate.py` 固定 `core.autocrlf=true`，不受本机 Git 配置影响。每一轮的 `build-candidate.py` 与 `manage-installed.py apply` 都传同一个 `--patch tools/pi-computer-use-qt-fix/<本轮补丁>`：管理器默认按 `native.patch` 核对候选记录里的补丁哈希，后续补丁不传 `--patch` 会被拒绝写入。

前端补丁先用 `python -B tools/pi-computer-use-qt-fix/build-frontend-candidate.py --package $cu --work-dir <新的空目录>` 生成候选：复制补丁涉及的四个文件，依次应用 `frontend-focus.patch`、`visual-observation-frontend.patch`，写 `frontend-build.json`（`sourceHashes` 与 `candidateHashes` 两组 SHA-256）。再 `manage-installed.py apply --frontend-candidate <同一目录> --record <新记录>`。从原版 0.5.1 生成的候选与维护者部署的前端文件逐字节一致。

**验证**：`python -B tools/pi-computer-use-qt-fix/manage-installed.py status --record <记录文件>`（全部文件处于期望状态时退出 0）；`node --test tests/pi/computer_use_focused_input.test.mjs tests/pi/computer_use_visual_observation.test.mjs`（`CU_CANDIDATE_DIR` 可指向候选包）；隔离夹具 `test-isolated.py --helper <exe> --fixture-python <带 PyQt5 的 python> --output <目录>`、`test-capture-isolated.py --helper <exe> --output <目录>`。原生 helper 更新后重启宿主，前端更新后新会话生效。

**回滚**：`python -B tools/pi-computer-use-qt-fix/manage-installed.py rollback --record <记录文件>`，按记录逆序逐份回滚；安装文件已有后续变更时拒绝。

**风险与维护**：npm 更新覆盖全部改动且 helper 二进制会被包内 prebuilt 还原；`manage-installed.py` 会结束运行中的 helper 进程。

**维护者本机特有**：`test-common-apps.py` 第 116 行写死维护者本机的 AutoCAD 模板路径，第 113 行使用 `AutoCAD.Application.26` COM 名；该脚本操作 AutoCAD 2027、记事本、资源管理器。

**取舍**：在 Windows 上用 computer-use 操作 Qt 程序、CAD 等出现点错控件、误报遮挡、输入发到别的窗口时装；没有这些故障或不用 computer-use 时不装。

### 3.14 pi-claude-code-provider 补丁

**作用**：`pi-claude-code-provider-0.6.0.patch` 改六个文件：

- 图片内联（`src/context-serializer.ts`、`claude-args.ts`、`types.ts`）：base64 图片块放进 stdin、紧跟引用它的记录，缓存断点放在最后一条记录上。Claude Code 2.1.292 对超过 256 KiB 的 `@` 文件既不附图也不报错，原版会丢图。
- 内置插件隔离（`src/claude-args.ts`）：`--settings` 中加 `"plugin-authoring@builtin": false`，避免初始化报 `unexpected customizations`。
- 摘要请求不写缓存（`src/provider.ts`）：`cacheRetention: "none"` 的一次性请求给子进程加 `DISABLE_PROMPT_CACHING=1`。
- 模型全名（`src/catalog.ts`、`doctor.ts`）：选择器列 `claude-sonnet-5-5`、`claude-fable-5-1`、`claude-opus-5-5`、`claude-haiku-4-5`，按全名传 `claude --model`。

**类型**：第三方包补丁。

**前提**：`pi install npm:pi-claude-code-provider@0.6.0`；Claude Code 2.1.292，在 PATH 上或由 `PI_CLAUDE_CODE_PROVIDER_PATH` 指向其可执行文件；Claude 订阅的第一方登录（provider 不支持 API key、Bedrock、Vertex）。

**适用版本**：只接受 0.6.0，其它版本拒绝；文件既不匹配原版也不匹配补丁（`unknown`）时拒绝，先重装包。模型表绑定 Claude Code 2.1.292 的别名解析。

**安装**

```powershell
node tools/pi-claude-code-provider/manage.mjs status
node tools/pi-claude-code-provider/manage.mjs apply
```

默认目标 `$PI_CODING_AGENT_DIR` 或 `%USERPROFILE%\.pi\agent` 下的 `npm\node_modules\pi-claude-code-provider`，`--target <包目录>` 可改。完成后重启 Pi。

**验证**：`status` 中 `patch` 为 `patched`、`stale` 为空数组（`stale` 非空表示 Claude Code 已把别名移到新型号；未设置 `PI_CLAUDE_CODE_PROVIDER_PATH` 时只报包状态）；`node --test tests/pi/pi_claude_code_provider_models.test.mjs`（在临时副本上应用与回退，无可用 0.6.0 安装时跳过，`PI_TEST_CLAUDE_PROVIDER_ROOT` 可改）；Pi 内 `/pi-claude-code-provider-doctor`。

**回滚**：`node tools/pi-claude-code-provider/manage.mjs rollback`，重启 Pi。

**风险与维护**：上游已停更；`packages` 写成未钉版本的 `npm:pi-claude-code-provider` 时 `pi update` 可能升级并丢失补丁，登记为 `npm:pi-claude-code-provider@0.6.0`。升级 Claude Code 后先 `status`；初始化报 `unexpected customizations` 时按报出的插件名把 `<名称去掉 cc-plugin- 前缀>@builtin: false` 补进 `src/claude-args.ts` 的 `enabledPlugins` 并更新补丁。补丁后旧会话保存的 `opus` 等别名 ID 不再可选，恢复这类会话需重新选模型。

**维护者本机特有**：无。

**取舍**：用 Claude 订阅经 Pi 调用 Claude 模型时装；不用 Claude 时不装。控制面把 `pi-claude-code-provider` 列为子代理默认加载的模型接入，并拒绝名称含 Fable 的子代理模型（`ops/tools/dispatch-core/dispatch-prepare/catalog.mjs`）。

### 3.15 pi-ask（已退役）

`tools/pi-ask/` 只保留 `@eko24ive/pi-ask@1.2.0` 的历史网页桥接补丁 `pi-ask-1.2.0-web-custom.patch` 与当时的哈希 `pi-ask-1.2.0-web-custom.sha256.json`，适用记录为 Pi 0.85.1。该包已卸载，现役提问包是 `@juicesharp/rpiv-ask-user-question@2.4.0`。无安装、重贴或回滚入口。`README.md` 第 7、21 行含维护者本机路径。不安装。

### 3.16 patch_pi_fullscreen_button_motion.py

**作用**：Pi 全屏 TUI 在 tmux / Zellij / screen 之外开启全移动鼠标跟踪（1003），悬停产生的序列跨越 50 ms 缓冲边界时尾部会漏进输入框。脚本把模式固定为按键移动（1002），保留点击、拖选、滚轮与右键粘贴。

**类型**：Pi 本体补丁脚本。

**前提**：Python；全局 Pi bundle 中恰有一个含标记表达式的 chunk。

**适用版本**：`SUPPORTED_VERSIONS` 为 0.84.4、0.85.1、0.86.0。在 Pi 0.99.1 上 `status` 报 `supportedVersion: false`，标记表达式仍存在（`state: unpatched`），`apply` 拒绝写入。

**命令**：`python -B tools/patch_pi_fullscreen_button_motion.py status|verify|apply|self-test [--pi-root <目录>]... [--backup-root <目录>]`；`--pi-root` 可重复，默认 `<全局 Pi 目录>`；备份默认写 `<Pi 用户目录>\backups\pi-fullscreen-button-motion-<时间>-...\`（含 `manifest.json`）。`self-test` 只在临时副本上运行。无回滚命令，按备份目录复制回原 chunk。

**风险与维护**：适配新版本需核对 chunk 布局后扩展 `SUPPORTED_VERSIONS`；npm 重装覆盖。无 README。

**取舍**：Pi 0.99.1 上不可用；只有在 0.99.1 全屏模式确实出现悬停字符漏入、并愿意自行适配时才考虑。

### 3.17 压缩与裁剪研究脚本

| 脚本 | 作用 | 前提与限制 |
| --- | --- | --- |
| `tools/compaction-replay.mjs` | 在冻结的历史切点上回放 Pi 原生 `compact()`，比较压缩写手与档位：`prepare`（构造样本、核对切点）、`run`（调用模型）、`score`（机械记分）；`--out` 指定输出 | 切点样本 `CASES` 写死为维护者私有会话文件，需改成自有会话；`run` 产生模型费用；方法见 `docs/operations/pi-compaction-writer.md` 第 4 节 |
| `tools/pi_compaction_fallback_smoke.py` | 隔离 agent 目录中让 OpenRouter 压缩预设故意失败，要求原生压缩经 OpenAI Codex 兜底成功 | 把 `--agent-dir`（默认 `%USERPROFILE%\.pi\agent`）下的 `auth.json` 与 `models.json` 复制到临时目录；需要 OpenRouter 与 openai-codex 登录；默认主模型 `openai-codex/gpt-5.6-sol-500k` 依赖控制面别名扩展；现行压缩写手恢复由控制面 `pi-compaction-model-recovery` 承担，本脚本为历史验证 |
| `tools/prune-luna-context-replay.mjs`、`tools/prune-luna-context-score.mjs` | 让模型对历史检查点的工具结果做保留 / 替换 / 丢弃判定并计分 | 源会话路径写死为维护者私有会话，分词器从未随分发的 `tmp/context-prune-bench/...` 加载；本目录不能直接运行 |

**类型**：研究工具。无安装与回滚。**取舍**：仅研究；复现前替换样本与路径。

### 3.18 codex_quota.py

**作用**：在内存中读取 `%USERPROFILE%\.pi\agent\auth.json` 的 `openai-codex` 凭据，以 Pi Codex provider 相同的请求头查询 ChatGPT 后端的订阅用量接口，每个额度窗口输出已用 / 剩余百分比与重置时间；`--raw-keys` 另列响应字段名。不打印凭据。

**类型**：运维脚本。**前提**：Pi 已登录 openai-codex。**命令**：`python -B tools/codex_quota.py`。**风险**：依赖非公开接口，字段可能变化；只读，不改配置。**维护者本机特有**：无。**取舍**：用 Codex 订阅且需要查看剩余额度时用；无安装与回滚。

### 3.19 技能

| 技能 | 用途 |
| --- | --- |
| `.pi/skills/pi-context-prune-local-trial/` | 裁剪接线、候选包浅测、本机导入试用与回退 |
| `.pi/skills/pi-local-plugin-development/` | 本地 Pi 插件开发、把 `node_modules` 临时补丁做成自维护包、模型工具设计、Windows 适配与端到端验收 |
| `.pi/skills/pi-web-access-operations/` | `pi-web-access` 的机制、配置与故障定位；附只读检查脚本 `scripts/inspect_web_access.py`（不解析凭据、不联网、不写配置）及其测试 `scripts/test_inspect.py` |

**类型**：技能（`portability: repo-bound`，正文引用 `tools/...` 等相对路径）。

**前提**：正文引用控制面技能 `ops/skills/rule-authoring/SKILL.md`（经控制面全局技能入口可用）。

**安装**：Pi 在工作目录为 `extras/pi-plugins/`（或其子目录）且项目受信任时自动发现 `.pi/skills/`。全局使用时把目录复制或联接到 `<Pi 用户目录>\skills\<名称>\`，或在 `settings.json` 的 `skills` 数组登记目录；Claude Code 侧放到 `%USERPROFILE%\.claude\skills\<名称>`。全局使用时正文中的 `tools/...` 相对路径仍以 `extras/pi-plugins/` 为根。

**验证**：`python -B .pi/skills/pi-web-access-operations/scripts/test_inspect.py`；Pi 内 `/skill:<名称>` 能加载。

**回滚**：删除复制或联接的目录、`skills` 条目。

**取舍**：需要维护上述单元或开发本地 Pi 插件时装；只使用插件时不需要。

## 4. 与控制面的耦合

| 耦合点 | 说明 |
| --- | --- |
| `pageAnswer` 配置 | 控制面 bootstrap 把 `pageAnswer`（`openai-codex/gpt-5.6-luna` / `low`）写进 `web-search.json`（来源 `adapters/pi/user-addons/manifest.json`）。原版 `pi-web-access@0.21.0` 不读该字段；打了 3.10 的补丁才生效 |
| Codex 型号别名扩展 | 控制面安装的 `<Pi 用户目录>\extensions\openai-codex-sol-context-alias.ts` 是 3.10 补丁的硬依赖（静态导入其 `rewriteCodexPayload`）；`tests/pi/web_answer_alias.test.mjs` 也读取该安装副本。`pi_compaction_fallback_smoke.py` 的默认主模型 `-500k` 别名同样依赖它 |
| `pi-web-access` 重装 | 控制面 bootstrap 安装并钉 `pi-web-access@0.21.0`；任何重装都会抹掉 3.10 的补丁，重装后重跑 `apply.mjs` |
| 角色卡工具白名单 | 控制面 `ops/agents/*.toml` 的工具白名单含 `read_symbol`；未装 3.5 时只记 warning |
| 子代理资源表 | 控制面 `ops/templates/worker-resources.json`：`pi-claude-code-provider`、`@tian.zuo/pi-antigravity`、`@local/pi-antigravity-native`、`pi-cursor-host` 为 `default_on`（子代理默认可用这些模型接入）；`payload-cache-diag`、`pi-read-symbol` 及工具 `read_symbol`、`antigravity` 为 `optional`；`pi-context-prune*`、`pi-scheduler-native`、`pi-global-system-tail`、`paste-image` 为 `off` |
| Fable 拒绝 | 控制面派发拒绝名称含 Fable 的子代理模型；`cursor-host` 与 Claude provider 是可能暴露这类模型的通道，拒绝在派发侧生效 |
| 压缩链 | 控制面安装 `pi-midrun-compact`（窗口 90% 处触发）、压缩写手恢复包 `pi-compaction-model-recovery` 与 `compactionModel` 配置。3.1 的 `compactionHoldRatio=0.72` 取压缩线的 80%，两者都按 `ctx.getContextUsage()` 判断；3.9 的 context-usage 宿主补丁改变该用量的估算方式 |
| 自定义消息唤醒 | 控制面的子代理完成通知与 3.6 的定时唤醒以自定义消息启动运行。原版 0.99.1 这类运行不经过 `before_agent_start`，扩展写入的具名提示段（如 3.7 的日期段）在该轮缺失；3.9 的 prompt-stability 宿主补丁修复 |
| 子代理 worker 的 Pi 副本 | 控制面部署在 `<Pi 用户目录>\extensions\subagent-control\adapters\pi\` 的 worker 若带独立的 `pi-coding-agent`，3.9 的补丁需对其单独执行；控制面重新部署会覆盖 |
| WS 共享状态 | 3.2 的诊断读取 3.9 WS recovery 写在 `globalThis` 的共享计数，未装 WS 补丁时相应字段为空 |
| 控制面技能 | 3.19 的技能引用控制面 `rule-authoring` 技能，经控制面全局技能入口解析 |

## 5. 升级后复查

升级全局 Pi、执行 `pi update`、重装第三方包或重跑控制面 bootstrap 后，对已安装的单元逐条执行（未安装的跳过）：

```powershell
python -B tools/pi-codex-attribution/manage.py status
python -B tools/pi-prompt-stability/manage.py status --host-only
node tools/pi-ws-recovery/manage-pi-ws-recovery.mjs status --bundle-target "global=<全局 Pi 目录>" --target "global-ai=<全局 Pi 目录>\node_modules\@earendil-works\pi-ai"
node tools/pi-web-answer-alias/apply.mjs
node tools/pi-antigravity/manage-pi-antigravity.mjs status
node tools/pi-antigravity/manage-pi-antigravity.mjs native-status --json
node tools/pi-transcript-hydrate/apply.mjs verify
node tools/pi-claude-code-provider/manage.mjs status
python -B tools/pi-computer-use-qt-fix/manage-installed.py status --record <记录文件>
python -B tools/context-prune-release.py status
node tools/context-prune-bench/manage-cache-diag.mjs status
node tools/render-pi-global-system-tail.mjs --check
node tools/pi-paste-image/status.mjs
```

状态回到 `baseline` 且版本未变时重新 `apply`；版本变化后管理器拒绝写入的，保持原版运行，等对应补丁移植到新版本。`apply.mjs`（3.10）本身幂等，输出 `"changed": true` 表示刚重新打上补丁。
