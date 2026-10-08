# Antigravity 的 Pi 原生接线

Pi 的有效系统内容通过专属 `agent.md` 加载；MCP 请求转成 Pi 工具调用，由 Pi 宿主执行。认证继续使用 Antigravity CLI 的原登录路径。

## 环境与目录

- 基底：`@tian.zuo/pi-antigravity` 0.10.3，保留 Windows 无闪窗与取消清理。
- Pi：0.99.1；Antigravity CLI：1.2.17；本地原生包：0.1.0。
- 原生包的 Pi peer 引用现役宿主 SDK；普通依赖复用 Pi 用户 npm 目录。构建不升级全局 SDK、不迁移认证。
- 管理入口：`tools/pi-antigravity/manage-pi-antigravity.mjs`。
- 自维护差异：`tools/pi-antigravity/pi-antigravity-0.10.3-native.patch`。
- 生成包：`.runtime/pi-antigravity-native/`。上游整包及依赖链接留在生成目录，不提交第三方源码副本。
- 用户配置变更清单：`runs/native-pi-runtime-20260813/pi-antigravity-native-20261006.json`。

## 构建与安装

```bash
node tools/pi-antigravity/manage-pi-antigravity.mjs native-build --json
node tools/pi-antigravity/manage-pi-antigravity.mjs native-install --json
node tools/pi-antigravity/manage-pi-antigravity.mjs native-status --json
```

`native-build` 从当前受管 0.10.3 基底应用固定差异，生成文件哈希清单。安装仅替换 `settings.json` 的 Antigravity package source，保留其他包、过滤项、认证和权限设置。修改后的生成包须重新构建，不能直接安装与清单不一致的文件。

源码修改在本地开发副本 `packages/pi-antigravity-native/`（不提交）进行，改完先重新生成固定差异，再从上游基底构建：

```bash
node tools/pi-antigravity/manage-pi-antigravity.mjs native-patch --json
node tools/pi-antigravity/manage-pi-antigravity.mjs native-build --json
```

`native-patch` 以上游 0.10.3 加 Windows 补丁为基底，对比开发副本写出 `pi-antigravity-0.10.3-native.patch`；`--source` 与 `--patch` 可改来源与输出。`tests/pi/antigravity_native_install.test.mjs` 核对固定差异能重建出 `.runtime/pi-antigravity-native`，开发副本的改动没进补丁就直接构建时该测试失败。

原有 `status/apply/rollback` 继续管理上游 Windows 补丁；原生接线使用 `native-*` 命令。安装后重启活动 Pi 宿主，磁盘配置变更不会替换旧进程里的扩展实例。

## 内容与调用

- 全局追加、项目上下文、技能目录及扩展追加由 Pi 正常加载；使用 `getCurrentSystemPrompt(normalizeContext(context).messages)` 合并系统消息的 `content` 与 `sections`。技能正文按需读取。
- 用户消息承载任务、数据与必要恢复历史，不重复整份系统内容。
- 使用实际启用的 Pi 工具目录，排除 Antigravity 自身递归执行入口。文件、Shell 与扩展工具走 Pi 宿主钩子、执行及结果处理。
- 工具路径与权限遵循 Pi 本身，不额外套试验夹具的工作区限制。Shell 的操作系统权限与 Pi 相同；系统提示不构成操作系统沙箱。
- 工作区只登记进程／会话专属的 MCP 项与代理文件；结束后移除自有项，保留项目原有配置。工具使用 Pi 原名，隔离由专属服务器名承担；CLI 合成的 `mcp_<server>_<tool>` 须在 64 字符内。
- CLI 续接旧 conversation 会保留原始 system。规则更新不能只覆盖文件后继续旧 conversation；更新机制及历史恢复由运行时处理，普通轮次复用会话。

## 受影响功能检查

```bash
node --test tests/pi/antigravity_native_install.test.mjs tests/pi/pi_antigravity_native*.test.mjs
node tools/pi-antigravity/run-native-smoke.mjs --load-only
node tools/pi-antigravity/run-native-smoke.mjs
```

单元测试加载 `.runtime/pi-antigravity-native`，环境变量 `PI_TEST_ANTIGRAVITY_NATIVE_ROOT` 可指向其他构建目录。加载检查不调用远端模型。真实探针只读临时夹具，检查内置工具、普通扩展、MCP 网关与宿主结果钩子；`--model <id>` 选 Antigravity 型号（默认 `gemini-3.6-flash`），`--evidence <目录>` 选记录目录，`--probe-image <png>` 换探针图片。`--system-switch` 追加两轮：扩展改写系统内容后须新开 CLI 对话、模型看到新内容并记得上一轮读到的文件；系统内容不变的下一轮须续接同一对话。运行记录位于 `test-results/pi-antigravity-native-20261006/` 与 `test-results/pi-antigravity-native-20261007/`。

## 回退

```bash
node tools/pi-antigravity/manage-pi-antigravity.mjs native-rollback --json
```

回退恢复原 Antigravity package entry，保留安装后其他配置变化；随后重启宿主。上游 npm 包不被本地生成包覆盖。
