# control-review

读取当前项目级 control-plane 中待复核的任务与结果，优先展示
`needs_parent_review`、失败原因、requested/actual identity 和 contract state。

只读取当前项目状态；不要把待复核状态改写成通过，也不要访问用户级或全局配置。
