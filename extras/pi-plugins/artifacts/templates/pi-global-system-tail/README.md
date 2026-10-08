# Pi 主代理全局风格与时间注入

> 职责：保存主代理全局风格源、生成方式和时间扩展部署方法。
> 真源：global-style 静态源及本包部署方式
> 读取：维护读取

## 内容

- `global-style.md`：跨项目沟通、工作偏好与时间表达规则，唯一静态正文源。
- `APPEND_SYSTEM.md`：生成产物，不独立维护。
- `local-time.ts`：只提供UTC+8当前日期，同一天输出保持稳定。
- `package.json`：只注册时间扩展。

不包含 Ultimate 尾部、response-calibration、child worker system。包名和目录沿用 pi-global-system-tail，避免改变现有安装与 child 排除配置；不再搬运提示词尾部，也不要求包位于最后。

## 生成与验证

```bash
node tools/render-pi-global-system-tail.mjs --write
node tools/render-pi-global-system-tail.mjs --check
node --test tests/pi/global_system_tail.test.mjs
```

`--check` 比对三处 `APPEND_SYSTEM.md` 哈希：模板目录、用户 agent 的 `local-packages/pi-global-system-tail/`、agent 根目录。包目录其余四个文件须与模板逐文件哈希一致。任一不一致时退出码为 1。

## 部署

将本目录五个文件同步到用户 Pi agent 目录的 `local-packages/pi-global-system-tail/`，将生成的 `APPEND_SYSTEM.md` 同步到该 agent 目录根。settings 的 packages 保留 `./local-packages/pi-global-system-tail`，不改顺序。

```powershell
$src = "E:\Pi_Coding_Agent\artifacts\templates\pi-global-system-tail"
$agent = Join-Path $env:USERPROFILE ".pi\agent"
$pkg = Join-Path $agent "local-packages\pi-global-system-tail"
Copy-Item -Path (Join-Path $src "*") -Destination $pkg -Force
Copy-Item -Path (Join-Path $src "APPEND_SYSTEM.md") -Destination (Join-Path $agent "APPEND_SYSTEM.md") -Force
node E:\Pi_Coding_Agent\tools\render-pi-global-system-tail.mjs --check
```

部署前保存旧副本。`--check` 打印 `DEPLOYMENT_OK` 且三处哈希相同，同步才算完成。现有会话执行 `/reload` 或重启后使用新配置；磁盘更新不证明运行中的旧扩展已卸载。

更新旧安装时删除该包内的 `system-tail.ts`、`ultimate-reminders.md` 和 `response-calibration.md`。生成器只读取 global-style。

正式 child 沿用自己的 worker system 与资源排除，不继承本包。不修改 Pi 原生 system；无扩展主会话继续获得静态 global-style。
