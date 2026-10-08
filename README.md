# Subagent Control Plane

本仓维护共享子代理运行能力及消费者模板。运行包提供规则、编排、route、工具和 skills；模板提供通用入口与空白项目状态，不携带开发仓业务历史或测试源码。

本机首次安装与升级（发布到 Claude Code 与 Pi）见 `SETUP.md`；相对原版 Pi 与 Claude Code 的改动、原因与交接事项见 `HANDOVER.md`；下文是已发布后把运行包接入单个项目的做法。

## 消费者安装与更新

从本仓根目录用单一入口完成安装、更新和 Pi 接入：

```powershell
.\COPY-INSTALL.ps1 -Target "<目标仓绝对路径>"                              # 首次安装
.\COPY-INSTALL.ps1 -Target "<目标仓绝对路径>" -DryRun                      # 只预览动作与冲突
.\COPY-INSTALL.ps1 -Target "<目标仓绝对路径>" -Update                      # 同版本重复安装或升级
.\COPY-INSTALL.ps1 -Target "<目标仓绝对路径>" -RuntimeRoot "<已验证发布包>"  # 指定运行包根
```

安装事务先做 preflight 冲突与依赖检查，再快照 → 暂存同 build 全量物料 → verifier → 切换资源与合法 marker，最后写安装回执；失败恢复旧 marker、链接与配置。`-Force` 不授权整体删除 `ops/` 或覆盖用户内容：项目自有 `README`、`AGENTS`、身份状态、业务技能默认受保护，冲突时列明而不覆盖。安装入口写入的本机 `.pi/control-plane-consumer.json` 标记不入库，只用于校验项目根、运行包身份与归属清单。

目标机需要 Git、PowerShell、Python 3.12+ 与 Node.js。首次安装从用户级发布目录的 current.json 定位已安装运行包；重复安装保持项目已固定的版本，-Update 才选择当前发布。运行包未安装时返回明确缺口，也可用 -RuntimeRoot 指定已验证版本。运行依赖随共享运行包交付，消费者不在项目内安装 Node 依赖。

### 消费者拿到什么

- `AGENTS.md`：通用真源原字节；项目身份与进度使用独立的 `PROJECT.md` / `STATUS.md` / `ROADMAP.md` 空白入口，仅缺失时生成。`PROJECT.md` 来自 `ops/templates/factory-project.md`；`STATUS.md` / `ROADMAP.md` 由 `ops/templates/factory-state-delta.json` 经 `state_checkpoint.py` 渲染；调整出厂状态时改模板或 delta，不复制源仓状态，不手改渲染产物。
- `ops/`：本地目录骨架及指向运行包的选择性资源链接，提供规则、协议、workflow、route、agent prompt、skills 附件和生产工具入口；不复制开发工具树，`ops/map/` 留在项目本地。
- 共享运行包：编译器、Fleet CLI、runner、handoff checker 和依赖从已验证运行包解析；技能由运行包 `package.json` 的 `pi.skills` 显式清单发现并携带附件，项目业务技能独立保留，重名时提示来源而不覆盖。
- `.gitignore`：排除本机链接、接入标记和运行态；已有项目忽略规则受保护。
- `notes/`：初始化缺失的空账本 `notes/ledger/DEBT.toml`，其余任务记录目录按使用创建；不携带开发仓历史。
- `.runtime/cockpit/`：运行时按需创建的项目本地目录，不指向共享包，也不入库。

### 消费者健康检查

在目标仓根目录执行，只用生产入口：

```powershell
python -B ops/tools/cockpit_map.py --lint
python -B ops/tools/reference_resolution_check.py --source AGENTS.md --format text
node ops/tools/dispatch_prepare.mjs --sample-route general-agent__general-default --action preview --format json
git status --short
```

预期结果：

- cockpit_map lint：`issues=0`；缺 `ops/map/` 生成物时先跑一次 `python -B ops/tools/cockpit_map.py`。
- reference check：`reference_resolution_check: pass`。
- 干跑复验：`delivery_readiness.status` 为 `available`；运行包未部署时如实 fail-closed 并给出部署入口。
- `git status --short`：无预期外脏文件。

上述入口来自已安装的运行包投影，不要求本地 `tests/`、`adapters/` 或面板源码；控制面回归测试属维护面，见下节。

## 不包含内容

- `.runtime/`、`tmp/`、`test-results/` 等运行态。
- `ops/map/*.html`、`ops/map/*.md` 等带本机绝对路径的生成地图。
- 源仓 `PROJECT.md` / `STATUS.md` / `ROADMAP.md` 的当前项目状态。
- 源仓 `notes/`、`docs/decisions/`、历史 handoff、旧报告和业务材料。
- 控制面 `tests/`、`adapters/pi`、`src/agent-panel` 源码和发布维护工具。
- 模板母仓自用的 `CLAUDE.md` 仓内工作说明。

## 控制面维护（仅本仓）

以下步骤只在控制仓或承担发布维护的仓执行；消费者不需要。

### 依赖与发布产物

依赖尚未安装或锁文件变化时运行 `npm ci --prefix ops`。

完整发布使用 `python -B ops/tools/release_control_plane.py --apply`；省略 `--apply` 只显示计划。允许项目继承、依赖复用、各步骤回执及部分失败处理统一见 `docs/operations/global-model-config.md` 的“发布与核对”。

Fleet 的 Koffi 原生依赖由 npm 按目标平台安装，不使用 `--omit=optional`。改动 `ops/tools/` 中被打包的源文件后先重建 dist 再部署，使发布产物包含本次修改。MCP 发布事务受用户级部署锁保护，config 切换带 compare-and-swap，release 清理保护 config 指向、非终态任务引用与 24h 宽限期内的版本。同机多项目共享该槽：后部署者的实现版本接管全部项目（任务数据仍按各仓隔离）。

角色、模型笔记与兼容回退使用运行包全局默认；项目仅通过显式声明覆盖，旧 `ops/` 副本不自动生效。配置入口、覆盖粒度与发布核对见 `docs/operations/global-model-config.md`。

同机的 `~/.claude.json` 已有同名 MCP 注册时，部署事务自动同步服务入口并移除非标准cwd字段；该注册缺席时跳过。MCP派发和Fleet调用以project_root明确请求所属项目。部署后重启消费该服务的宿主，使新进程生效。生产者登记唯一位置为 `~/.subagent-control/bridge-producer.json`；存在登记时事务核对 producer_root 并原子更新 expected_build，缺失时返回 missing_not_updated 并提示缺口。

### Agent Panel（全局运行）

Agent Panel 随全局 Pi 发布交付，生产运行不依赖本仓。服务、线程、页面和桌面壳项目位于 `~/.pi/agent/extensions/subagent-control/`，构建、日志和 WebView2 缓存位于 `~/.subagent-control/agent-panel/`。运行需要 Node.js 24+、Python 3.12+、.NET 10 SDK 和 WebView2。全仓启用使用 `--project-scope all`，面板自动发现实际调用过 launcher 的项目；`listed` 范围仍按 `allowed_projects` 切换。任务数据仍在各项目 `.runtime/cockpit/`。

成功派发后非阻塞启动或复用全局面板；启动结果随回执返回，失败不改变任务提交结果。从目标项目目录手动启动或查看状态：

```powershell
$env:SUBAGENT_PROJECT_ROOT = (Get-Location).Path
$launcher = "$HOME/.pi/agent/extensions/subagent-control/ops/dist/agent_panel_launcher.bundle.mjs"
node $launcher
node $launcher --status
```

浏览器开发入口：

```powershell
npm --prefix src/agent-panel run start:browser -- --control-repo (Get-Location).Path
```

配置页直接枚举 `ops/agents/*.toml`，通过正常 Pi RPC `get_available_models` 镜像 Pi 主页面模型目录，并维护角色默认模型、effort、候选池与模型特性笔记。主代理日常只消费 `dispatch_prepare(action=list)` 的候选投影。完整运行与验收命令见 `docs/operations/agent-panel.md`。

### 回归测试（本仓维护面）

```powershell
python -B -m pytest -p no:cacheprovider tests/control_plane -q
node --test tests/control_plane/*.test.mjs
Push-Location src/agent-panel; node --test; Pop-Location
```

这些用例依赖 `tests/`、`adapters/pi` 和面板源码，只在控制仓或携带开发资产的仓运行；工具链一键验收见 `ops/policies/runtime-tools.md` §5。

### 安装纯净度检查

在目标仓根目录执行，须在运行任何工具之前：

```powershell
grep -rl codex-control_07_04 . --exclude-dir=.git --exclude=README.md --exclude=PROJECT.md   # 必须为空
```

`.runtime/` 下除 `cockpit/.gitkeep` 空骨架外必须为空，`tmp/` 必须不存在。（工具自测运行后会在本地新建 `tmp/`，属正常运行态，不算安装泄漏。）

### clone 方式补充

通过 `git clone` 或整仓复制获取本仓时，会带入当前仓运行状态，不视为出厂安装。若确需手动复制，至少按 `COPY-INSTALL.ps1` 的白名单和出厂状态渲染逻辑执行；`ops/map/cockpit-overview.md` 需在目标仓根目录手跑一次：

```powershell
python -B ops/tools/cockpit_map.py
```

clone 方式还会携带母仓 `notes/`、`docs/decisions/` 的历史记录，启用前先清空这些内容（保留目录骨架），再跑上方安装纯净度检查。

首次真实任务进入时，按 `AGENTS.md` 的入口规则走：先判断目标、完成证据、关键未知和切片，再决定自做、子代理、混合或 workflow。
