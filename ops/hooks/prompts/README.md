# Hook Prompts

> 职责：存放 hook 返回给主代理或子代理的可编辑提示文案。
> 真源：hook 注入和拦截文案正文
> 读取：维护读取

本目录只存放 hook 直接输出的短文案。修改文案时改对应 Markdown；修改触发条件时改 `ops/hooks/agent_monitor_lib/predicates/`；修改开关、阈值或文案路径时改 `ops/hooks/injection_config.json`。

子代理完整任务材料不在本目录维护；公共提示词、能力提示词、任务包和输出模板仍由 `ops/agent-prompts/`、任务包和 `ops/tools/dispatch-core/subagent_preload.mjs` 生成。
