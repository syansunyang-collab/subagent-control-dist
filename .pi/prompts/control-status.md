# control-status

读取当前项目级 control-plane 状态，并使用 `adapters/pi/src/control-ui.mjs` 的
`renderControlUi` 输出稳定的纯文本摘要。

只读取当前项目状态，不创建任务、不取消任务，不读取用户级 Pi/Codex 配置。
