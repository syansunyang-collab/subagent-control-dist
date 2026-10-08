# 触发判例

## 正判例

1. 把pi-web-access整个工作原理和所有调节入口弄清楚。
2. 页面问答怎么又调用主模型，改默认模型和推理档位。
3. 搜索为什么打开浏览器，怎样关闭curator但保留检索？
4. fetch_content抓不到页面，是抓取路由还是代理DNS被拦？
5. PDF提取能只用本地吗，视频分析又由哪个模型负责？
6. 修改searchRouting后没有生效，查配置优先级。
7. get_search_content找不到原文，检查responseId、缓存和过期范围。
8. 插件升级后页面问答补丁丢了，恢复并核对请求。
9. source_check的supported标签和confidence到底怎么计算？

## 反判例

1. 浏览器已有登录态，帮我在Edge中点按钮。命中use-personal-edge-devtools-windows。
2. 自动裁剪没有触发，检查工具结果水位。命中pi-context-prune-local-trial。
3. Pi里同时有两个搜索工具，把重复工具隐藏。命中audit-and-dedupe-pi-search-tools。
4. 重启Pi Web并恢复原会话。命中restart-pi-web-windows。
5. 新建一个通用Pi RPC客户端。命中use-pi-rpc-safely。
6. Claude provider拒绝system角色，修模型接入。属于provider适配，不命中本技能。
7. 搜索今天的新闻并给结论。属于普通业务检索；使用工具本身即可，不先加载插件维护规程。
8. 定时任务pending但不执行。属于scheduler维护，不命中本技能。

## 行为判例

### 分离模型用途

任务：只读说明页面问答、搜索提供商与curator摘要分别使用什么模型，列出调节入口；不改配置、不发模型请求。
首动作：运行脱敏检查，确认安装路径、版本与配置来源，再按模型支线路由读资源。
产出：分层调用图、配置优先级、当前值与未验证项，不把主模型或pageAnswer当全插件默认。

### 排查提取失败

任务：一个公开HTTPS URL被SSRF校验拦截，机器采用fake-IP代理；先定位，不全局放开地址段。
首动作：读取抓取/网络资源和脱敏网络配置，区分DNS预检、代理传输、重定向与提供商远程出口。
产出：实际阻断层及最小适配项，验证同一URL；不把allowRanges当成代理配置。

### 控制摘要开销

任务：不需要curator窗口，减少额外摘要调用，但保留搜索结果。
首动作：读取搜索资源，区分provider内模型与插件summaryModel，核对workflow。
产出：明确none、auto-summary、summary-review的差别，调整命中字段并验证；不宣称workflow=none令全部搜索免费。
