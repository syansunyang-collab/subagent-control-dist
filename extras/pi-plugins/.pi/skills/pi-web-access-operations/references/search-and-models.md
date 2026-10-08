# 搜索路由、摘要与curator

## 先判定实际供应商

读取gemini-search.ts的search/getSearchConfig/searchWithConfiguredRouting，再查看index.ts的可用性与工具入口。优先级为：

1. 单次显式命名provider或数组；auto/省略会使用配置选择。
2. 配置searchProvider优先于provider；数组和all执行并发聚合，命名单选不自动切其他供应商。
3. 只有配置里完全不存在provider/searchProvider键时，searchRouting才生效。写了provider=auto也会压住这条routing，不仅是非auto值。
4. 没有配置路由时使用内置auto链。

index.ts的resolveRequestedProvider每次读配置，显式命名选择可以立即传给后端；gemini-search.ts另外缓存默认选择和searchRouting/searchModel。修改或移除覆盖键、切换后备路由时核对两层状态，必要时重载，不把某一层的热读外推到另一层。

内置顺序：已配置SearXNG→适用且可用的OpenAI→Exa→Brave→Parallel→TinyFish→Search1API→Searchinfinity→Querit→Tavily→Jina→SERPdive→Kagi→Ollama→Perplexity→Gemini API/Web。

OpenAI的auto门槛为无recencyFilter且numResults=5；需要测试该供应商时显式选择openai，不能用auto成功推断它被调用。

## 三种选择不是一回事

| 选择 | 行为 |
| --- | --- |
| 命名单个provider | 只用该供应商；适合定位认证/响应问题 |
| 命名数组 | 同查询并发调用指定供应商，汇总成功与错误、按URL去重 |
| all | 并发可用的默认集合；不包含DuckDuckGo、AnySearch、xAI、Bright Data、SerpBase |
| auto | 顺序尝试；可因为条件或可用性跳过前面的供应商 |
| searchRouting | 指定顺序及可继续的错误类型，不是并发数组 |

all并不是免费集合，其中仍可能包含收费服务。all中的Gemini只使用API，不使用纯浏览器cookie通道；显式gemini可进入Web路径。不要根据index.ts的all可用性汇总表达式判断Gemini整体被排除，应同时看searchWithProviders/searchWithAllProvider。

searchRouting.fallbackOn只支持transient、quota、network、invalid-response。认证与取消不作为该路由的普通后备条件。auto的catch链与配置路由的错误白名单不同；核对输出中的实际provider与失败记录。

可用性通常只检查凭据来源存在，不能证明key有效。Exa无key仍可走公共MCP入口；这不是无限额度保证。

## 查询、结果与并发

直接工具批量路径逐条处理queries；同一查询的provider数组/all通过Promise.allSettled并发。curator交互可另外发起查询，不从单个for循环外推整个插件无并发。

numResults是请求上限而非保证数量，各API有自己的夹取范围。recencyFilter与domainFilter有的供应商原生支持，有的只改写查询或在返回后过滤；需要严格时效/域限制时核对相应provider源码和返回内容。

includeContent可能增加后台网页抓取、Exa检索深度或内联正文。搜索多个供应商、多个查询及获取全文是不同的成本乘数，先定位需要的支线，再调整，不靠减numResults保证少计费。

## workflow与UI

- none：返回搜索结果，不再跑curator/汇总模型。
- auto-summary：结果完成后生成汇总，不打开curator。
- summary-review：打开带自动摘要草稿的curator，可改查询、选来源、反馈并重新生成。

工具参数workflow优先于配置。resolveWorkflow先识别auto-summary，所以显式auto-summary在无UI时仍保留；无UI下的默认/summary-review降级为none。autoOpenBrowser=false仅不自动弹窗，不能用来关闭curator流程或额外摘要。

本地空闲超时默认20秒，远程默认60秒，上限600；远程模式默认打印链接而非打开本机浏览器。curatorRemote.host只决定链接，bind决定监听范围，两者分别核对。

远程true默认监听所有接口；访问只由URL中的随机session token控制，HTTP无TLS。仅本机使用保持回环地址；跨设备访问按已授权网络范围选择私有接口或隧道，不把会话URL作为普通日志公开。

## 搜索模型的推理字段

OpenAI搜索走自己的HTTP请求，不经过本仓页面问答的别名onPayload。openaiSearchModel在该版只校验非空字符串并原样写入请求model，不解析Pi模型选择器的:medium等后缀；使用该服务实际接受的ID。出现这样的配置时，不能据此宣称已设置推理档位；实际后端是否接受这个模型字符串另看请求证据。没有公开的OpenAI搜索推理字段时，pageAnswer.reasoning也不会代为控制它。

## 汇总模型与预算

summary-review.ts按显式summaryModel、内置偏好模型依次解析候选；0.21偏好为Claude Haiku、Codex Spark。候选需在Pi启用模型范围内且认证可用。显式summaryModel不是禁止后备的锁定开关。

实际汇总调用没有传reasoning或maxTokens，配置中也没有summaryReasoning。pageAnswer.reasoning只控制页面问答，不能据此宣称搜索汇总变成low。

summaryGenerationDeadlineMs控制单次摘要生成的总时限，包括候选解析、认证与候选尝试；默认30秒，上限600秒，不是每个候选重新获得30秒。超时、空响应或所有候选失败时输出确定性结果摘要；这仍可用，但不等于模型汇总成功。查看fallbackReason和meta.model。deadline是等待上限，不是token/费用上限；超时返回fallback也不保证远端请求没有产生费用。

curator的查询改写另有偏好模型链（Haiku、Gemini Flash、GPT mini），不由pageAnswer或summaryModel统一接管；该辅助调用也可能增加模型用量。

调整费用时先区分搜索供应商费用、查询改写、结果汇总、页面问答、抓取后备与主模型处理工具输出。固定价格与配额从服务当前官方说明查询，不把安装README价格表写成长期技能保证。
