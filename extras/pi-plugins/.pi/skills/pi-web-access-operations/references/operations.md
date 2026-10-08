# 调节、排障与验证

## 按目标选择改动

| 目标 | 最小改动 | 检查结果 |
| --- | --- | --- |
| 不弹窗且不增加汇总 | workflow=none | 搜索仍返回结果；供应商自身费用仍可能存在 |
| 不弹窗但需要汇总 | workflow=auto-summary，按需summaryModel | 检查UI能力、meta.model与fallbackReason，不只看是否有文字 |
| 页面问答改轻模型 | pageAnswer.model与reasoning | 观察实际请求的model与reasoning；主模型不变 |
| 固定验证一个搜索端 | 单次provider指定名字 | 结果归属确为该provider，不被auto后备掩盖 |
| 自定义顺序后备 | searchRouting，并移除provider/searchProvider覆盖键 | 核对路由与错误类别；重载搜索配置缓存 |
| PDF保持本地 | pdf.provider=unpdf | 文字层可读、扫描件限制明确，读取保存的Markdown |
| 只定位视频画面 | timestamp与frames | 检查ffmpeg/yt-dlp及图像开关，不先发整段视频分析 |

模型问题、路由问题和抓取问题分别调整。页面正文未取得时，先修提取链；增加reasoning不会补出不存在的输入。

## 默认页面问答

本仓唯一实现入口为 `tools/pi-web-answer-alias/README.md`。配置示例：

```json
{"pageAnswer":{"model":"openai-codex/gpt-5.6-luna","reasoning":"low"}}
```

仅answer模式使用这组配置。搜索汇总模型未暴露同名reasoning字段，不把新增summaryReasoning当作已生效配置。

## 常见故障定位

1. **工具或命令消失**：查tools和commands的注册开关、toolNames和实际get_tools；排除宿主重新选工具的问题，再查provider。
2. **没有使用指定搜索路由**：查单次provider、两个配置覆盖键及cachedSearchConfig；核对重载后实际provider。
3. **有配置但认证失败**：区分来源存在与凭据有效，检查返回错误；不打印密钥或执行只读检查发现的!command。
4. **URL被拒绝**：定位域名策略、DNS/私网、代理适用范围或重定向；授权范围内只改命中字段。
5. **只有PDF路径或空页**：读取生成文件、检查页数与扫描件，确认转换provider；不把路径回执交给模型当正文。
6. **摘要模型没有工作**：检查workflow/UI能力、enabledModels、认证、总deadline和确定性fallback；不把fallback文字算作模型成功。
7. **问答仍调用昂贵模型**：查当前实例是否加载补丁、pageAnswer文件、单次answerModel；真实发送值与显示别名分开看。
8. **get_search_content失败**：核对ID/条目、1小时有效期与外部缓存文件；按需重取来源。
9. **Windows Gemini Web不可用**：先确认cookie自动提取的平台支持，不反复登录或将其归为搜索模型失效。

## 升级与恢复

确认包版本、实际源码和本仓补丁差异，再决定是否重应用。页面问答补丁的命令：

```bash
node tools/pi-web-answer-alias/apply.mjs
node --test tests/pi/web_answer_alias.test.mjs
```

该管理器修改当前本机包布局中的页面问答、功能配置、参数说明及共用Codex映射。未知源先核对差异；保持认证、其他provider和主会话模型不变。相邻模型provider升级不等同于网页插件升级，不以整体重装代替局部修复。

改变运行代码或注册设置后，在新实例核对；旧实例按实际重载状态报告。只读取配置时不重启服务；Pi Web整体重启归专门技能。

## 验证选择

- 解释机制：定向读取源码、版本与实际配置；不启动无关网络调用。
- 配置调节：只改目标字段，查看新的实际路径；复用未变化的测试。
- 模型/推理接线：一次小型真实请求可验证发送字段，记录请求模型、思考档位、返回与未修改配置；不扩成收益实验。
- 安全字段：验证授权目标能用，以及邻近未授权地址/错误模式仍按原边界处理。
- 缓存/回查：原响应ID下查片段，区分显示截断、存储内容与过期。

恢复配置时只还原本次字段差异，保留后续其他工作。

## 交付

给出实际调用链、改动字段、验证入口与结果、生效实例范围及缺口。源文件/缓存中有敏感值时仅保留必要的脱敏证据。没有实际调用证据时写明静态判断，避免把可用性检查当作端到端成功。
