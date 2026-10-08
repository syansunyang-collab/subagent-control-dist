# 子代理选型与配置维护

> 职责：区分日常选型与角色配置维护，说明配置来源异常的处理入口。
> 真源：日常选型使用派发工具返回；角色推荐行由有效角色配置 `[[picks]]` 提供，模型可选档位取有效 `ops/model-notes.toml` 的 `efforts` 与 Pi 模型目录支持档的交集（推导规则见 `docs/operations/model-maintenance.md`）。
> 读取：维护读取

## 日常选型

复用同一发起项目的有效选型卡；缺少材料时获取对应 route 的 template，路由未知时用 list。工具返回本能力适用的推荐行（模型、默认档位与 `[min–max]` 范围）、有效默认、模型可选档位、配置来源及参数填法。按返回信息给 pick 或 model，按需显式给 effort 并派发，无需打开本文件或模型维护文档。

选型指导由 `ops/tools/dispatch-core/model_selection_guidance.mjs` 统一投影到 list/template。场景分工只维护在角色配置的 `[[picks]]`，不另建模型分工表。

## 配置维护

运行包提供全局默认。项目差异通过 `.pi/control-plane-model-config.json` 显式声明；项目遗留的 ops 副本不自动覆盖全局。配置归属发起项目；target_cwd 指定子代理执行目录及写域校验的目标仓，具体写入仍由 scope 授权。完整来源规则见 `docs/operations/global-model-config.md`。

按用户配置指令修改角色推荐行与模型可选档位，日常由 Agent Panel 的「角色与模型」「模型档位」页维护。换模型改对应推荐行的 `model` 与档位，属于配置变更，不写决策记录。字段与校验规则见 `docs/operations/model-maintenance.md`。配置维护不自动扩大模型或计费授权；临时测试授权不等于永久加入推荐行。

## 来源或运行异常

先核对 list 的 config_source 与警告，或 template 中实际角色文件与模型笔记来源。声明损坏、缺少文件或配置校验失败时，按错误点名的文件与字段修复后刷新对应选型卡；无需扫描全部模型信息。范围内无法解决时说明缺口并交用户决定。
