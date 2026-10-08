# pi-ask 网页桥接补丁

## 当前状态：停用

`@eko24ive/pi-ask` 已卸载，补丁不再应用。现役提问包是 `@juicesharp/rpiv-ask-user-question@2.4.0`。本目录的补丁文件只保留历史 diff，没有安装或重贴入口。

现役提问引导由 `C:/Users/67570/.config/rpiv-ask-user-question/config.json` 的 `guidance.promptSnippet` 与 `guidance.promptGuidelines` 维护。安装包注册工具时用这两个字段覆盖内置文案；合法非空的 `guidance.promptGuidelines` 会替换内置引导，不与内置引导并存。本文件不复制现行引导句子。插件源码未修改，不新增网页面板。

`@eko24ive` 空目录与 `~/.pi/agent/extensions/eko24ive-pi-ask.json` 是否删除由归属人决定。Pi 只把 `.ts` / `.js` 和带清单的包当作扩展，该 json 不会被加载。

## 历史补丁

适用记录：`@eko24ive/pi-ask` 1.2.0、Pi 0.85.1、Pi Web 0.9.0-local.2。

`pi-ask-1.2.0-web-custom.patch` 曾修改四个插件源文件；`pi-ask-1.2.0-web-custom.sha256.json` 保存当时的原始与补丁后哈希。补丁不修改 Pi Web、原生 SDK、用户配置或运行模式。这两份文件只供对照，不作为重贴入口。

TUI 保留原 custom 界面。非 TUI 宿主通过实际 custom 工厂调用判断能否展示；未调用工厂且返回 undefined 时保留文字回退。AbortError 转为取消，其他异常继续抛出。内部返回类型的消费者同步调整。

## 生效与回滚（2026-09 历史）

本节只记录 2026-09 的做法。当时的安装路径 `C:/Users/67570/.pi/agent/npm/node_modules/@eko24ive/pi-ask/` 在 2026-10-03 已不存在。当前没有可执行的重载、回滚或重贴步骤。

## 验证与范围（2026-09 历史）

2026-09 隔离探针记录：18 组 TUI 组件用例、36 项真实 Web 桥接断言、35 项普通 RPC 及无界面回退断言通过。当时安装文件与受测文件逐字节匹配。验证未调用真实模型，未操作真实用户会话。2026-09 网页验收确认终端面板不满足点击操作要求。

组件和桥接测试不代表真实终端或浏览器端到端验收。该轮接通 ask_user；斜杠命令及启动恢复的原 TUI 模式限制当时保留。
