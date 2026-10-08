# pi-claude-code-provider 本地补丁

适用 `pi-claude-code-provider@0.6.0`（上游已停更）配 Claude Code 2.1.292。补丁 `pi-claude-code-provider-0.6.0.patch` 改六个文件。

## 图片内联（`src/context-serializer.ts`、`src/claude-args.ts`、`src/types.ts`）

上游把图片写成私有文件，在 prompt 末尾用 `@"路径"` 引用。Claude Code 2.1.292 对超过 256 KiB 的 `@` 文件既不附图也不报错，截图类图片基本都被丢掉，模型只看到 `image_attachment` 记录；另外附件叙述插在整段 transcript 之前，每多一张图整段缓存重写一次。

补丁改为把 base64 图片块放在 stdin 里、紧跟引用它的那条记录，缓存断点放在最后一条记录上（Claude Code 重编码图片时会丢弃图片块上的断点）。图片总量限制按每次出现累计，因为每次出现都会内联发送。Claude Code 对内联图片照常缩放压缩：2560×1440 缩到 2000×1125，18 MB 噪点 PNG 转成约 490 KB 的 JPEG；20 张约 3.9 MB 的图（stdin 约 104 MB）发出的请求约 12.6 MB。20 张、单张 20 MB、总计 100 MB 的限制不变。会话图片目录不再写入，其生命周期代码保留未动。

## 内置插件隔离（`src/claude-args.ts`）

Claude Code 2.1.292 新增内置插件 `cc-plugin-plugin-authoring`，print 模式下默认加载。插件的初始化隔离检查遇到它会报 `Claude Code loaded unexpected customizations (plugins: cc-plugin-plugin-authoring)`，所有请求在调用 API 前失败。补丁在传给 Claude Code 的 `--settings` 中加 `"plugin-authoring@builtin": false`，与上游对 `agents-md@builtin`、`telemetry@builtin` 的处理一致（上游 issue #12、#13）。

## 摘要请求不写缓存（`src/provider.ts`）

Pi 对压缩、分支摘要等一次性请求传 `cacheRetention: "none"`。上游只去掉自己的 transcript 断点，Claude Code 仍在 Claude 5 系列的尾部环境消息上、在 Haiku 的最后一个块上放 1h 断点，整段摘要 prompt 照样写入缓存（实测 Sonnet 5.5 写 10467、Haiku 4.5 写 8619 token）。补丁对这类请求给子进程加 `DISABLE_PROMPT_CACHING=1`，写入降为 0，普通请求不受影响。核查记录见 `notes/verify/claude-provider-cache-audit-20261007.md`。

## 模型全名（`src/catalog.ts`、`src/doctor.ts`）

上游选择器只列 `sonnet` / `fable` / `opus` / `haiku` 四个别名，名称为 `Claude Code Opus` 这类泛称。补丁把选择器换成别名在 Claude Code 2.1.292 中实际解析到的型号：

| 模型 id | 名称 | 上下文 | 默认输出上限 |
| --- | --- | --- | --- |
| `claude-sonnet-5-5` | Sonnet 5.5 | 1M | 128K |
| `claude-fable-5-1` | Fable 5.1 | 1M | 64K |
| `claude-opus-5-5` | Opus 5.5 | 1M | 128K |
| `claude-haiku-4-5` | Haiku 4.5 | 200K | 32K |

窗口与输出上限取自 Claude Code 可执行文件内置的模型目录。请求按全名传给 `claude --model`。`/pi-claude-code-provider-doctor` 的 `Served models` 行对比别名表与选择器，别名移到新型号时标出 `picker still offers <旧 id>`。

旧会话中保存的 `opus` 等别名 id 在补丁后不再是可选模型，恢复这类会话需重新选择模型。

## 命令

```bash
node tools/pi-claude-code-provider/manage.mjs status
node tools/pi-claude-code-provider/manage.mjs apply
node tools/pi-claude-code-provider/manage.mjs rollback
```

默认目标为 `$PI_CODING_AGENT_DIR` 或 `~/.pi/agent` 下的 `npm/node_modules/pi-claude-code-provider`，`--target <包目录>` 可改。`status` 输出包版本、补丁状态（`baseline` / `patched` / `unknown`）、`PI_CLAUDE_CODE_PROVIDER_PATH` 所指 Claude Code 的版本与别名表；`stale` 非空表示 Claude Code 已把某个别名移到新型号，需按新型号更新补丁。`unknown` 时 `apply` 拒绝执行，先重装插件包。

重装插件包或升级 Claude Code 后先跑 `status`。升级 Claude Code 还需重新确认内置插件：初始化报 `unexpected customizations` 时，按报出的插件名把 `<名称去掉 cc-plugin- 前缀>@builtin: false` 补进 `src/claude-args.ts` 的 `enabledPlugins`。磁盘上 `patched` 不代表长驻进程已加载：Pi 需 `/reload` 或重启，Pi Web 需重启。
