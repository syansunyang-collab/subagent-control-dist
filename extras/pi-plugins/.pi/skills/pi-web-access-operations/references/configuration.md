# 配置字段与优先级

## 发现位置

运行本技能检查脚本取得configPath和包路径。网页配置目录优先PI_CODING_AGENT_DIR，其次XDG_CONFIG_HOME下的pi目录，再使用运行用户的.pi目录；文件名web-search.json。Pi的agent设置目录与网页配置默认目录不是同一个概念，不根据包安装位置猜配置路径。

只改命中的字段，保留凭据及其他选项。区分磁盘配置、模块缓存、注册时读取与当前实例已生效状态。

## 检索与模型

| 字段/参数 | 作用 |
| --- | --- |
| provider / searchProvider | 默认搜索供应商，可为单个名称或命名数组；auto调用会使用此配置 |
| searchRouting.providers / fallbackOn | 配置不存在provider/searchProvider键时使用的顺序路由与允许后备错误类别 |
| 单次provider | 显式供应商/数组控制本次检索；auto不是忽略配置的“智能任选” |
| query / queries | 单查询/多角度批次；不同时制造近重复问题 |
| numResults / recencyFilter / domainFilter | 数量、时效、包含/排除域名；各供应商支持程度不同 |
| includeContent | 可触发额外抓取或供应商深度检索；不是纯展示开关 |
| openaiSearchModel / xaiSearchModel | 对应托管搜索的模型ID，不控制页面问答；OpenAI字段原样传递模型名，不把:medium等后缀解析成推理参数 |
| searchModel | Gemini API搜索模型，不是整个插件默认模型 |
| summaryModel | curator与auto-summary结果汇总模型 |
| summaryGenerationDeadlineMs | 单次摘要生成总时限，含候选解析/后备，默认30000、上限600000；不是总搜索超时 |
| pageAnswer.model / reasoning | 本仓补丁的页面问答默认模型及独立推理档位 |
| answerModel | 单次页面问答模型覆盖；不覆盖reasoning |
| youtube/video.preferredModel与单次model | 媒体理解模型；不是answerModel |

本仓pageAnswer无配置时默认Luna/low；以 `tools/pi-web-answer-alias/README.md` 与管理器源码为准。补丁丢失时原包可回到当前主模型，先检查已安装feature-config.ts和page-query.ts，不只看JSON值。

## 交互与注册

| 字段 | 调节与生效 |
| --- | --- |
| workflow | summary-review、auto-summary、none；单次workflow优先 |
| curatorTimeoutSeconds | 本地默认20秒，远程默认60秒，上限600；UI可调计时 |
| autoOpenBrowser | false仅取消自动打开，仍可有curator服务和等待；不等于workflow=none |
| curatorRemote | false/未配置为本地；true用主机名及全接口绑定；对象可设host/bind |
| shortcuts.curate / activity | curator/监视器快捷键，加载时注册 |
| webSearch.enabled | 旧总开关，默认影响搜索和source_check，不关闭fetch工具 |
| tools.webSearch/sourceCheck/fetchContent/getSearchContent.enabled | 逐工具开关，优先于旧总开关 |
| toolNames.webSearch/sourceCheck/fetchContent/getSearchContent | 替换公开工具名，不改变后台行为 |
| commands.websearch/curator/search/google-account.enabled | 逐命令注册 |
| image.enabled | 直接图片、帧和缩略图；不关闭PDF模型转换 |

注册、名称与快捷键改动后重载并核对实际清单。index.ts每次读取provider选择，但gemini-search.ts缓存默认选择、searchRouting与searchModel；路由切换或删除覆盖键后需核对缓存，必要时重载。配置路径在模块导入时固定。pageAnswer每次读取；媒体/克隆模块存在缓存，按源码确认刷新方式。不要把“某字段可热读”推广到全配置。

## 提取与网络

| 字段 | 作用 |
| --- | --- |
| fetchRouting.providers | HTTP及提取后备的集合与顺序 |
| fetchRouting.allowRemoteHostedProviders | 是否允许第三方托管抓取目标URL |
| fetchContent.domainPolicy.allow / deny | 主机及子域匹配，deny优先 |
| ssrf.allowRanges | 允许的窄CIDR，例如已确认的fake-IP池；不是关闭全部保护 |
| ssrf.trustEnvProxy | 代理适用主机的DNS预检调整，不配置代理传输 |
| firecrawlBaseUrl/ApiVersion/FreshScrape | 配置提取服务、版本及cache-only以外的新抓取许可 |
| searxngBaseUrl / searxngHeaders | 自建搜索端点与额外头；头值可能是凭据 |
| githubClone.enabled/maxRepoSizeMB/cloneTimeoutSeconds/clonePath | 专用GitHub处理与克隆位置/限额 |
| pdf.enabled/maxSizeMB/provider/datalabMode/datalabTimeoutMs | PDF链与资源限制 |
| youtube.enabled/preferredModel | YouTube内容理解 |
| video.enabled/preferredModel/maxSizeMB | 本地视频分析 |
| allowBrowserCookies / chromeProfile | Gemini Web浏览器cookie开关与账户选择 |

openaiResponsesUrl是搜索专用Responses端点，不自动继承Pi模型baseUrl。geminiBaseUrl与GOOGLE_GEMINI_BASE_URL影响Gemini生成接口；本地视频上传仍可能需要Google Files API。主模型代理配置不能自动代替这几条独立通道。

## 凭据与环境变量

每个provider的ApiKey字段可为字面值、$NAME/${NAME}环境引用或!command受信命令来源。$$和$!转义字面开头。不要将此语法套到所有普通配置字段。

显式环境/命令来源优先且失败会在该供应商报错；普通字面配置通常由对应环境变量覆盖。命令来源在请求时执行，每次有5秒时限与16KiB输出界限，不在注册时运行；只读检查不执行它。

OpenAI/xAI还可复用Pi认证，配置中没有API key不代表供应商不可用。Gemini Web cookie和Gemini API key独立。不同服务需要的附加字段也不同，例如Bright Data的serp/unblocker zone不可互换。

检查时仅报告凭据来源类型和存在性，不打印密钥、命令文本、Authorization值、curator会话token。需要调整端点时核对实际值，但不要把含凭据的整份JSON贴入会话或提交仓库。
