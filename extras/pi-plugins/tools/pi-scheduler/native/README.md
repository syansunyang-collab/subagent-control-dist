# Pi Scheduler Native

独立定时插件。27项包测试及7项 Pi 0.99.1 集成测试已通过，旧任务默认不自动导入。

## 接口

- `wake_agent`：通过 `after` 和简短 `reason` 创建一次唤醒；重复唤醒需明确有限次数。
- `schedule_command`：创建定时命令，按配置解析 shell。
- `manage_wake_tasks`：列出、取消、更新及清理任务。

忙碌期间每个任务只保留一个待投递事件，空闲后通过带来源的扩展消息唤醒。`delivered` 表示对应消息已写入会话，不表示业务完成。取消可清除插件内待投递事件，不能撤回已进入宿主的消息。重复唤醒在上一事件投递后重新计时。定时命令在执行结束时计算下一次，不等待投递。

任务默认保存在 `~/.pi/agent/state/pi-scheduler-native/tasks.json`。隔离运行可通过 `PI_SCHEDULER_NATIVE_STATE_FILE` 指定其他文件。定时器依赖 Pi 进程存活，关机期间不执行。

## 验证

```sh
npm install --omit=peer --no-audit --no-fund
npm test
npm run migrate
```

已通过27项包测试，覆盖忙时合并、取消、更新原子性、取消后完成不复活、运行中仅改名不重跑、运行中非改名拒绝、超时不被记成退出码0、命令循环与投递分开、待投递结果的store往返及下一轮claim、旧通知耗尽时保留运行中结果与已排下一轮、waiting耗尽按执行结果及剩余预算推进、死持有者接管、投递写入会话后才推进、循环预算校验、真实双进程竞争与持有者退出释放，以及shell配置和保活注册。

Windows / Node 24.12.0 / Pi 0.99.1 实测：插件仓 `node --test tools/pi-scheduler/native/test/*.test.mjs` 为 27/27（与 `npm test` 和 `npm run test:fast` 使用同一测试集合），`node --test tests/pi/pi_scheduler_native.test.mjs` 为 7/7，包含空闲SDK会话中循环命令的三次执行与三次投递。本轮没有重跑 Pi Web 隔离会话，不把上述结果说成 Pi Web 验收。

文件锁采用fs-native-extensions的操作系统锁。锁文件保持原inode，不替换或删除；进程退出由系统释放锁。切换锁实现前须停止所有旧版参与者，不能与旧的JSON覆盖锁混用。未验证其他平台或远程文件系统。

迁移默认只预览；`--apply` 写入新状态，导入任务保持暂停，不修改旧状态。可用 `--legacy <path>` 和 `--state <path>` 指定文件。迁移前应停止旧插件，迁移后逐项审阅再启用。旧队列不能通过迁移撤回。

## 未覆盖范围与安装

尚未覆盖会话切换、命令超时后的进程树退出、启用实际空闲回收后的长时保活、旧任务迁移样本及cron实际触发。croner依赖已安装，但不以依赖存在代替cron行为验收。

安装时将本目录作为本地Pi包接入，并核对实际工具列表和旧调度器退出情况。迁移旧任务或使用尚未覆盖的能力前，补对应验证；不同时启用两个调度器，不修改第三方`node_modules`。
