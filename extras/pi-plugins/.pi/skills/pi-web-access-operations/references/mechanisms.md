# 工具、模型与数据流

## 建立实际能力图

先用检查脚本定位安装版本与补丁，再从包内index.ts、extract.ts、gemini-search.ts、summary-review.ts、page-query.ts和storage.ts核对本次路径。本表对应0.21系列与本仓页面问答补丁；升级后以安装源码和请求证据更新判断。

| 入口 | 内部流程 | 输出与后继 |
| --- | --- | --- |
| web_search | 解析查询/过滤器→选择搜索供应商→可选后台抓取→按workflow汇总或curator | responseId、搜索答案/链接、错误信息；原文用get_search_content取 |
| source_check | 搜索→去重并取最多20个来源→可选抓最多5页→提取片段与hash→规则标签 | 有出处的研究包；主代理根据片段判断命题 |
| fetch_content | 校验输入→按URL/媒体类型分流→提取内容→可选页面问答 | 提取文本、文件路径、图片/帧、问答及responseId |
| get_search_content | 查responseId→选择query或URL→切片或查找 | 已有内容片段，不重新搜索、不自动重新抓取 |

## 区分模型调用

| 支线 | 选择来源 | 是否受pageAnswer控制 |
| --- | --- | --- |
| 搜索供应商内模型 | openaiSearchModel、xaiSearchModel、searchModel或供应商自己的实现 | 否 |
| curator/auto-summary的结果汇总 | summaryModel、可用模型与enabledModels | 否 |
| curator查询改写 | 独立候选列表，按交互触发 | 否 |
| 已抓网页的局部问答 | 本仓pageAnswer.model / reasoning；answerModel单次覆盖模型 | 是 |
| 视频、YouTube、PDF及部分抓取后备 | 各媒体配置、Gemini入口或转换服务 | 否 |

将费用归到实际调用支线。workflow=none只跳过插件的汇总/curator，不保证搜索供应商没有模型费用。readable通常直接提取HTML，但PDF、视频或远程后备仍可能调用模型/付费服务。answer在提取之后再增加一次页面问答。

主会话模型仍处理工具返回的文本；将页面问答改成轻模型，不会降低主模型本身的输入单价。

## 页面问答

本仓补丁通过completeSimple传reasoning，通过onPayload复用Codex请求别名改写。工具只用提取结果回答问题，按模型上下文预算截断页面，并标记truncated；输出预算为2000 token。缓存保存提取结果原文，展示内容可替换为问答结果。批量urls会对每个成功的文本结果分别并发问答，不是把所有页面合成一次请求；同一个prompt逐页使用，跨页比较仍需上层合并。

用pageAnswer配置指定默认模型与推理；不将fetch_content的model参数误用为问答模型，该参数用于视频/YouTube。answerModel只覆盖问答模型。有效性检查仍受Pi enabledModels约束，不会因默认模型不可用而静默选回昂贵主模型。

## source_check的证据边界

读取source-check.ts的assessClaim：状态来自命题词重叠和英文支持/反驳词列表，不是另一个模型作出的可靠事实裁决。confidence是规则评分；SHA256证明所引用片段的内容指纹，不证明命题为真。

用它组织来源和定位段落，再核对原文的时间、条件和命题对应关系。中文或隐含否定等情形可能无法正确分类；unclear也不证明没有相关证据。

## 存储与会话

storage.ts将结果放入会话内存。fetch完整提取内容外存到配置目录的web-search-cache，JSONL保存元数据和缓存引用；search/research保存其结果包。缓存和结果ID有效期为1小时，切会话时按当前分支恢复尚有效记录。

“完整内容”指该提取器返回的content，不等于源站所有资源或原始二进制。PDF通常只在content里返回本地Markdown路径、页数、字符数；正文需用read读取该文件，get_search_content不会自动打开文件。

responseId属于网页结果缓存；裁剪消息中的短ref属于context_tree_query。先恢复被裁剪工具输出可取回responseId，但原工具输出可能仍只是摘要或文件路径；再用get_search_content或read进入对应内容层，不混用两种ID。

URL切片的offset/limit与findText互斥；findText支持exact、case-insensitive、fuzzy。响应上限与存储完整性分开判断。get_search_content在answer模式后取回的是原提取内容，不是生成答案；已有答案从原工具输出恢复。重复answer调用会再次问模型，不把结果缓存理解为问答自动去重。缓存丢失/过期时按业务需要重新抓取，不假定会话JSONL还能还原正文。

## 控制面

/websearch直接开curator；/curator调整workflow；/search浏览当前结果；/google-account检查Gemini Web账户。快捷键只控制curator和活动监视器。

工具与命令注册开关在加载时读取；修改后重载并核对实际工具清单。宿主若重新开放工具，区分包注册与宿主选择，不通过卸载整个模型provider来隐藏一个搜索工具。
