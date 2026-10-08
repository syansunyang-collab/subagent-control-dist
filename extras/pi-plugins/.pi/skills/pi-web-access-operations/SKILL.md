---
name: pi-web-access-operations
layer: business
domain: pi-extensions
capability_group: web-access
portability: repo-bound
description: "维护pi-web-access（web_search/source_check/fetch_content/get_search_content）的工作原理、参数配置与调用故障：搜索供应商路由、curator、各用途模型与费用、页面问答推理、网页/PDF/视频提取、缓存和升级接线。适用于弄清整个插件、调整默认模型、查配置为何未生效。不用于普通资料检索、浏览器点击自动化、多搜索工具去重（audit-and-dedupe-pi-search-tools）、裁剪（pi-context-prune-local-trial）、通用SDK/RPC或Pi Web重启。"
---

# 网页插件机制与调节

> 职责：沿实际工具调用链解释、调整和验证pi-web-access，分清模型、网络、配置与宿主层。
> 真源：实际安装包源码与配置；本仓tools/pi-web-answer-alias；本技能references中的对应操作资源。
> 读取：命中加载

## 首动作

确认任务属于机制说明、配置调节、故障定位或升级接线。以下命令在本仓根目录执行；需要当前现场时运行只读检查：

```bash
python -B ops/skills/pi-web-access-operations/scripts/inspect_web_access.py
```

读取版本、路径、脱敏字段和本仓补丁线索。该结果仅为磁盘快照；需要判断活动实例时，再核对实际工具清单、请求或日志。只解释源码时按已知版本入口阅读，不为讲解启动网络测试。

## 按问题读取资源

| 情况 | 读取 | 产出 |
| --- | --- | --- |
| 整体原理、混淆工具或模型、证据/缓存语义 | references/mechanisms.md | 实际调用图、模型支线和数据边界 |
| 供应商选择、后备、curator、搜索摘要与开销 | references/search-and-models.md | 路由/模型归属及命中字段 |
| 网页、PDF、GitHub、图片、视频、SSRF/代理故障 | references/fetch-and-media.md | 提取链、能力限制和可行入口 |
| 字段含义、文件位置、优先级、热读/缓存/注册差别 | references/configuration.md | 最小配置差异及生效方式 |
| 执行调节、排障、升级或验收 | references/operations.md | 对应层修复、验证与生效范围 |
| 修改技能触发或检查相邻技能重叠 | references/trigger-cases.md | 正反判例与行为路径核对 |

资源路径相对本技能目录；每项均可从入口直接到达。

## 工作流

1. **确定支线。** 将搜索、结果汇总、查询改写、页面问答和媒体理解分开，定位实际供应商/模型。区分请求参数、配置、环境来源与默认值。
2. **选择调节点。** 普通业务调用用现有参数；持久调整用对应配置字段；代码缺口再处理接线。先确认提取内容，再调整模型推理。
3. **执行局部修改。** 保持主模型、其他支线及凭据不变，除非它们也属于当前目标。修改注册或模块缓存后在新实例核对，热读字段按下一请求验证。
4. **消费证据。** 工具可见、凭据来源存在、提取成功、模型真正执行分别取证。source_check状态是规则提示，业务结论由片段与原文支持。
5. **交付。** 说明实际改变的字段与路径、已验证结果、当前实例是否生效及尚未覆盖部分。

## 边界与恢复

插件调用错误先定位到注册/缓存、路由/认证、网络提取、模型请求或结果存储层。源码可定位时自行推进，不把普通工程选择交回用户。

配置调整保持目标字段范围；涉及新增外网监听、远程发送本地内容或浏览器凭据访问时，核对任务已授予的范围。日志和证据保留来源与状态，不包含密钥、凭据命令输出或curator会话token。

升级后先对齐安装版本；已验证路径复用证据，只补受影响消费面。本仓页面问答补丁按其维护入口恢复；其他provider、裁剪和Pi Web进程问题交对应工作流。

## 脚本维护

inspect_web_access.py只读安装元数据和非敏感配置，不解析凭据命令、不发网络请求、不写配置。用--agent-dir、--config、--package-dir指定测试夹具或非默认安装位置。

修改脚本后运行：

```bash
python -B ops/skills/pi-web-access-operations/scripts/test_inspect.py
```

测试检查敏感值不输出、凭据命令不执行、错误不回显配置和输入文件不变。该脚本检查不替代插件实际调用验证。
