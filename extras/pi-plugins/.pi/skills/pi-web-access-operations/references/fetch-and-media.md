# 抓取、多媒体与网络调节

## 选择入口

| 目标 | 操作 | 结果边界 |
| --- | --- | --- |
| 普通网页正文 | fetch_content默认readable | Readability/RSC或后备提取结果 |
| 原始文本响应、排查HTTP状态 | mode=raw | 不跑正文提取或托管后备；非2xx也可返回文本与状态 |
| 网页局部问题 | mode=answer加prompt | 先提取，再调用pageAnswer模型；受输入截断影响 |
| GitHub仓库/文件 | 仓库、tree、blob URL | 克隆或GitHub API视图；issues/PR等走普通网页 |
| PDF | 正常抓取后read返回的Markdown路径 | 工具回执不是PDF全文，不用answer直接追问未读正文 |
| 远程图片 | 直接图片URL | 返回缩放图片；image.enabled控制 |
| 本地图片 | 使用read | fetch_content的本地文件专用分支是视频，不是通用文件读取 |
| 视频内容理解 | YouTube URL或本地视频，按需prompt/model | Gemini等媒体支线，不受pageAnswer控制 |
| 视频画面定位 | timestamp/frames | ffmpeg抽帧，YouTube还需yt-dlp；不是文字问答 |

有效非空urls优先于url，重复URL会去重。raw、answer与视频帧/视频model参数的组合按index.ts校验，避免向同次调用混入不同模式参数。

## HTTP提取路由

extract.ts的顺序为输入校验、raw快捷分支、帧/本地视频、GitHub、YouTube、HTTP及后备。公开HTTP(S)目标先做域名策略和SSRF验证；跟随重定向时继续检查。

默认抓取顺序：http→firecrawl→jina→tinyfish→search1api→querit→kagi→ollama→parallel→brightdata→gemini。用fetchRouting.providers调整有效顺序与集合。普通远程URL即使将后备放首位，也可能先运行HTTP安全/提取检查；该字段不是完全跳过HTTP的开关。

fetchRouting.allowRemoteHostedProviders默认false，第三方托管后备需显式开启。Firecrawl作为已配置提取服务单独处理，默认lockdown/cache-only；firecrawlFreshScrape才允许服务主动抓新页面。远程服务自己的DNS与重定向不能由本地校验完整控制。

HTTP一般30秒超时、5MB响应界限，fetchAllContent默认并发3；后备各有自己的超时。没有公开的任意timeout/concurrency工具参数，不随意添加配置字段。根据失败层和现有参数调整，而不是把所有超时都归为30秒。

## PDF

pdf.enabled、pdf.maxSizeMB、pdf.provider、pdf.datalabMode、pdf.datalabTimeoutMs是主要开关。maxSizeMB默认20、上限50；源码提取默认最多100页，不把pdf.maxPages当作已支持配置。

- auto：有凭据时Datalab→Gemini→本地unpdf。
- datalab或gemini：选择该远端层，普通错误后可退本地unpdf；认证/配置错误和取消不作普通后备。
- unpdf：本地文字提取，无OCR，扫描件可能为空。

PDF文字层、扫描件和表格布局分别验证。Gemini/Datalab会发送PDF内容到远端；具体费用查对应服务当前规则，不沿用README中的固定价格。安装README的“PDF仅文字、无OCR”旧限制不能用于概括整个auto链。

## GitHub

githubClone.enabled控制专用克隆/API分支，false不关闭通用HTTP抓取。maxRepoSizeMB默认350，超限转API视图；forceClone可显式越过大小选择。cloneTimeoutSeconds默认30，clonePath指定临时克隆位置。

克隆按会话复用、切换/关闭会话会清理缓存。需要长期保存时放到明确业务目录，不把插件临时路径写成长期真源。私有仓库路径需要可用gh认证；只读问题不替用户改登录。

## YouTube、视频与图片

- youtube.enabled / preferredModel：YouTube专用提取；默认模型在youtube-extract.ts确认。
- video.enabled / preferredModel / maxSizeMB：本地视频分析，大小默认50MB；上传分析与本地抽帧是不同路径。
- 单次model覆盖媒体模型，不改变搜索、PDF或页面问答模型。
- YouTube按可用性走Gemini Web→Gemini API→Perplexity文本后备；本地视频优先Gemini Files API，再走已开启的Gemini Web。
- timestamp支持时刻或区间；frames公开上限12，区间未指定数量时默认6，单时刻加数量按5秒间隔。frames=1单独传入会在参数归一化时被忽略；需要单帧时明确timestamp，避免意外进入视频理解分支。
- image.enabled=false也关闭帧/缩略图，但不等于关闭PDF远端转换。

媒体配置存在模块缓存。改后按安装源码确认缓存清理入口，必要时重载；只改变文件不宣称旧实例已切换。

## 网络与隐私

fetchContent.domainPolicy的allow/deny按主机及子域匹配，deny优先；这是额外限制，不替代SSRF。ssrf.allowRanges只放开确有需要的CIDR，不提供代理传输。fake-IP环境先确认DNS实际返回范围，再使用对应窄范围。

ssrf.trustEnvProxy只跳过适用代理主机的本地DNS预检；不会设置HTTP_PROXY/HTTPS_PROXY/ALL_PROXY，也不会放开localhost、字面私网IP或NO_PROXY目标。

浏览器cookie由allowBrowserCookies或PI_ALLOW_BROWSER_COOKIES显式开启。开启前明确所需账户与读取范围；Gemini Web和Gemini API是不同认证通道。0.21安装版chrome-cookies.ts只实现macOS/Linux的自动提取；Windows的unsupported不是账号未登录，不反复要求登录或假定开启开关即可使用。按实际支持选择API或独立浏览器工具，不擅自导出cookie。离线/本地提取目标不通过开启全部托管后备解决。
