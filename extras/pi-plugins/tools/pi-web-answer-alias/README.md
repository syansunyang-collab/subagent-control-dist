# 本机网页问答模型别名接线

适用于当前用户安装布局中的pi-web-access 0.21.0及Codex显示别名扩展。网页问答通过独立completeSimple调用，显式传入reasoning和onPayload改写；普通会话和网页问答共用 `openai-codex-sol-context-alias.ts` 导出的rewriteCodexPayload。别名扩展归控制仓 `E:/ControlPlane/control_0827`（源码 `adapters/pi/user-addons/agent/extensions/`，由其 bootstrap 安装）；本工具只接线网页问答，要求别名扩展已安装。

显示模型、上下文配置与允许模型检查保持原样；仅openai-codex请求中的已知别名转换为上游ID。

## 应用与验证

```bash
node tools/pi-web-answer-alias/apply.mjs
node --test tests/pi/web_answer_alias.test.mjs
```

目标是Pi agent目录（`PI_CODING_AGENT_DIR`，未设置时`~/.pi/agent`）下npm/node_modules/pi-web-access中的page-query.ts、feature-config.ts和index.ts；别名扩展缺失时直接报错。脚本原地改写，写入前不备份，没有回滚命令；恢复原版需重装该包（如`pi remove npm:pi-web-access@0.21.0`后再`pi install npm:pi-web-access@0.21.0`，该流程未验证）。重装或升级pi-web-access后补丁丢失，重新运行apply.mjs。应用前识别页面问答接线片段；重复应用不写已一致的文件。未知源先核对差异。网页包通过当前安装布局的相对路径导入别名扩展，因此该补丁不作为可直接发布到npm的独立上游改动。

测试依赖本机Pi SDK和已安装的网页包源码，使用临时目录副本与模型回执替身。覆盖普通轮次/辅助调用一致性、Astra/Sol两种别名、其他provider不改写、模型对象不变、实际answerFromPage的onPayload、显式模型选择及允许模型限制。维护对象为上述两条请求路径；接口变化时维护对应测试，未发生变化的其他provider不扩大验证。

## 默认模型与推理配置

配置文件由网页插件getWebSearchConfigPath决定：优先PI_CODING_AGENT_DIR/web-search.json，其次XDG_CONFIG_HOME/pi/web-search.json，最后为用户目录下.pi/web-search.json。配置示例：

```json
{
  "pageAnswer": {
    "model": "openai-codex/gpt-5.6-luna",
    "reasoning": "low"
  }
}
```

无配置时同样使用Luna/low。单次answerModel覆盖模型；reasoning统一取pageAnswer.reasoning，可选off、minimal、low、medium、high、xhigh，由SDK按模型能力映射。使用completeSimple传递通用推理档位，避免把reasoning误传给底层complete而不生效。配置每次问答读取，不跟随主会话模型或推理档位。

只影响fetch_content的answer模式，普通网页读取、搜索摘要、主会话模型保持不变。工具参数说明使用配置字段名，不再宣称默认跟随主模型。

真实请求验证另行记录。安装文件更新后，新实例加载新实现；旧会话需要重载，不以文件哈希代替活动函数已更新的证据。
