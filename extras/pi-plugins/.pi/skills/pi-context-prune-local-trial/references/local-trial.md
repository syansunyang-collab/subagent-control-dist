# 裁剪本机试用操作

## 发现当前输入

从当前Pi进程的PI_CODING_AGENT_DIR取得agent目录；未设置时由运行环境的用户目录解析默认agent位置。下面命令只输出裁剪包选择和配置，不打印整个设置文件：

```bash
python -c 'import os,json; from pathlib import Path; a=Path(os.environ.get("PI_CODING_AGENT_DIR",Path.home()/".pi"/"agent")); s=json.loads((a/"settings.json").read_text(encoding="utf-8")); print(json.dumps({"packages":[p for p in s.get("packages",[]) if "context-prune" in str(p)],"prune":json.loads((a/"context-prune/settings.json").read_text(encoding="utf-8"))},ensure_ascii=False,indent=2))'
```

由包选择解析实际源码或本地安装目录，再读取package.json中的版本、构建和测试脚本。全局包版本不替代工作区本地包选择。Node与SDK路径通过当前进程和安装入口发现；按本机依赖解析TypeBox，避免沿用旧包名。

## 候选检查

对候选工作树执行：

```bash
git -C "$CANDIDATE" status --short
git -C "$CANDIDATE" diff --stat "$BASE"
```

CANDIDATE为实际候选目录，BASE为已确认的公共底座提交。核对摘要器提示、经济实验和其他分支代码是否属于本次导入范围。

从package.json选用现有构建、测试及打包检查命令。用npm pack生成产物并核对文件列表与入口哈希；包检查只证明打包完整，不证明实际SDK加载成功。

## 接线检查

- 先核对计量版本与范围：字符粗估、编码器计数和服务端总输入分别记录。水位只统计工具正文时，不以整个上下文的token数判断是否越线。
- 核对替换对象：已摘要调用的参数、存根和历史摘要是否仍常驻。用摘要及占位等完整插入内容对比被移除内容，净回收与缓存变化分别记录。
- 用固定工具轨迹复算首次达到准备线和应用线的位置，并核对合法切点。将冻结候选与应用时的最新合法范围对比，区分尾部保护、并行组、请求间隔和frontier的影响。已有摘要记录不等于中途应用；区分收尾写入与下一请求实际交付。
- 编码计数复用现成库，按普通文本处理日志中的特殊token字样；核对缓存不会把变化后的正文当成旧结果，分别记录冷、热计数开销。
- 分别测准备入口和消费入口；摘要在两回合之间完成时，下一合法请求即可使用。
- 对实际消息内容检查摘要与对应存根，避免在工具schema文本中误命中同名标记。
- 检查原文回查、失败/超时保留、分支/配置失效与关闭功能的兼容性。
- 在宿主可能重新选择工具时，检查任务开始前后的工具列表；工具不可见性与执行行为分别验证。
- 用正常工具链观察主模型是否完成任务；机械测试不替代主模型行为证据。采用较低浅测水位时，另用固定真实轨迹核对部署预算的触达位置；低阈值链路通过不等于部署预算能及时触发。涉及完整工具交互时，用包含长调用参数的任务核对覆盖范围；仅大结果、小参数的样本不覆盖参数常驻风险。

## 设置隔离与导入

同进程探测使用SDK和SettingsManager.inMemory。临时水位配置放到隔离agent目录，模型认证引用已有认证入口，设置文件前后校验哈希。进程级RPC隔离和持久化setter判断由use-pi-rpc-safely负责。

先记录私有备份位置，再从新鲜读取的设置中仅更新裁剪包选择和本次配置。将tarball解包到稳定本地目录，确认解包后的入口与已测入口哈希一致。保持包列表的其他项目和扩展过滤器不变。

若本次包含全局风格修改，从 `artifacts/templates/pi-global-system-tail/global-style.md` 修改唯一源，再执行：

```bash
node tools/render-pi-global-system-tail.mjs --write
node --test tests/pi/global_system_tail.test.mjs
```

按当前部署映射同步生成副本。原生提问guidance属于独立配置；其promptGuidelines为整组覆盖时，检查完整有效文本，不把替换当追加。

## 实际加载与回退

通过本机实际会话入口启动新实例，读取工具来源、系统提示和运行配置，核对包路径、调度指引与活动工具。仅磁盘配置变化时，结论写为“已配置”，取得新实例证据后再写“已加载”。

保留旧包以支持回退。恢复本次改动的包选择、裁剪字段和提示配置，重新核对新实例；其他运行实例保持原状。失败记录区分模型调用、插件执行、宿主选择与传输收集层，已有可用证据由主代理裁决。
