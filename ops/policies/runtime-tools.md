# 运行工具策略

> 职责：规定运行工具使用、权限与异常恢复边界。
> 真源：运行工具使用边界与异常恢复策略
> 读取：命中读取

控制面提供工作资源、运行事实和操作入口；主代理根据任务目标与证据决定推进、停止或恢复。测试资产准入见 `ops/policies/test-tooling-governance.md`。

## 1. 使用位置

按任务选择工具；工具用途与参数使用当前工具说明或 CLI 帮助。需要查找仓库工具归属时使用 `ops/map/cockpit-overview.md`，不把工具清单当作必跑步骤。

## 2. 写入边界

派发时把任务要留下的业务产物列入任务写域。子代理自有的产物目录、证据目录和本任务临时目录（Windows 上 bash 与后台命令的 TEMP/TMP 指向它，任务结束清空）无需声明，可写可删；回执申报的写删落在系统临时目录或目标仓 gitignore 范围内时按临时副作用处理，不计越界。运行态工具按其显式输出路径写入；检查、预览和 dry-run 的结果只证明对应检查或预览完成。

`state_checkpoint.py` 的状态写入顺序由 `ops/policies/state.md` 规定。历史运行态删除使用 `runtime_retention.mjs` 的 dry-run 核对范围后再 apply。

结构化审查通过 `submit_review_result` 提交，runner 校验并独占 canonical report / handoff 的写入。普通任务通过 `submit_task_result` 提交，由工具生成报告、handoff 并执行交付校验。提交工具缺席时，审查任务使用内联结构化结果，普通任务按任务包写交付文件并执行 handoff 自检；校验失败只修具体缺口。

### 普通任务收口

`git_checkpoint.py` 默认只读工作区。收口模式从终态任务目录提取实际改动、交接与证据，生成待主代理核对的清单；授权写域不作为文件归属证明。

```bash
python -B ops/tools/git_checkpoint.py --closeout-task <任务目录> --save-plan tmp/closeout.json --format text
python -B ops/tools/git_checkpoint.py --apply-plan tmp/closeout.json --decision accept --format text
```

`--closeout-task` 可重复；`--include-file` 补入主代理自己的文件。核对候选归属、证据和缺口后，accept 才应用归档与精确暂存；rework/needs_owner 只返回后续提示。被引用的 artifacts 文件及授权域内、受 Git 忽略的临时证据可归档，目录和命令引用不递归复制或执行。工具不改变原任务审计、业务裁决、Fleet gate 或工程状态，也不执行 commit。阶段状态仍经 state_checkpoint 处理。

## 3. 工具输出纪律

测试和构建需要留存证据时，将完整日志写入任务证据目录，向会话返回摘要、退出码和日志路径。通过管道或重定向收集输出时保留原命令退出码。

人工读取收口结果使用 `--format text`，机器消费使用 `--format json`；完整计划由 `--save-plan` 保留。JSON 模式的输入和文件错误返回短错误对象，调用方仍先检查退出码，不把空输出直接交给 JSON 解析器。

搜索先限定路径、模式和输出范围。输出被截断时读取已有完整日志或缩小查询范围；证据确实缺失且影响当前结论时才补取，不因显示截断重跑测试。

## 4. 子代理使用

任务包只声明当前工作需要的范围与特有限制。派审前查明本次变更的直接生产者、消费者和实际入口，将判断所需路径与已有证据纳入只读范围；写域不随之扩大。

启动材料、结构化结果与 handoff 校验由 `ops/protocols/subagent-information-injection.md` 规定。消费工具已返回的检查结果；工具成功完成的同一份交付校验不再手工重复。工具缺席时使用该协议的回退入口。

## 5. 验收

### 控制仓维护面一键验收

局部修改直接运行覆盖该改动的现有测试文件、用例或工具自测；复用未受影响的有效结果。修复失败项后只复验该项及受修复影响的路径。

明确需要整条工具链回归时，可运行：

```powershell
python -B ops/tools/toolchain_check.py
```

该入口执行脚本内的完整清单，适用于控制仓维护；不作为每次工具修改的默认步骤。新增自测不自动要求加入完整清单。测试工具通过与业务目标完成分别判断。

### 消费者健康检查（生产入口）

消费者安装或资源加载出现问题时，按缺口选择对应入口：

```powershell
python -B ops/tools/cockpit_map.py --lint
python -B ops/tools/reference_resolution_check.py --source AGENTS.md --format text
node ops/tools/dispatch_prepare.mjs --sample-route general-agent__general-default --action preview --format json
```

消费者使用运行包提供的生产入口，无需控制仓测试源码。真实派发与结果回收由对应发布或业务任务验收，健康检查不代替真实结果。

## 6. 异步终态与恢复

正常运行等待完成通知。通知缺失、现场异常或用户查询时，使用 `subagent_get(detail=diagnostic)` 查看当前阶段、最近调用和日志；没有新线索时不反复查询。同步等待使用 `subagent_wait` / `fleet_wait` 工具声明的调用条件。

静默、调用数和运行时长是遥测，既不自动证明失败，也不证明有效进展。stall 通知只提示查看现场。以新增事实、已关闭缺口或已产出的结果判断进展；重复同一检查且没有新增证据时，读取已有日志定位原因，再决定调整任务、取消接管或只补剩余缺口。

收到终态后，读取可用的 `subagent_result`，同一 revision 已消费则复用。运输失败、合同失败和业务失败分别判断；有可用产物时先判断其能否满足目标，避免整包重跑。失败详情使用 diagnostic 与任务日志，不根据错误文案猜测用户意图或自动替换模型。

取消使用 `subagent_cancel` 或 `fleet_cancel`，原因如实填写；`user_requested` 只用于用户明确停止。取消请求被接受不等于执行已结束，确认终态与清理结果后释放写域。用户停止后需要新的用户指令才能续跑或重派；其他可恢复终态按结果中的 resumable 信息，经 `subagent_resume` 续接已有会话。

普通任务的父级复核完成后，可通过既有 CLI 显式销账：

```bash
node ops/tools/subagent_service.mjs internal ack-review --task-id <task_id> --task-root .runtime/cockpit/async_tasks --expected-revision <已复核revision> --note "<决定及证据引用>"
```

该命令复用运行时 `ackReview`，保留原业务判定与审计字段；读取结果或暂存文件不自动销账。Fleet 节点继续使用 `fleet_review`，普通任务销账不释放 Fleet gate。

同一故障局部处理后仍无新进展时，复用已排除的原因和有效结果，改变验证路线或只派剩余缺口。副作用不明时先核对落盘结果；旧执行未结束或清理未确认时保留其写域，避免竞争写入。后台命令与临时服务的期限、结果和清理由任务运行器管理，不按历史 PID 重放控制动作。

Fleet 由调度器消费内部节点，主代理处理 run 级结果。all-settled 节点等待直接上游终态后消费结果索引；未被此类节点消费的待裁决结果使用 `fleet_review`。Acceptance Contract 的裁决流程见 `ops/workflows/planning/validation-dispatch.md`。

## 7. async 派发权限与注册真源

任务读写范围以任务包 scope 为准。工具、扩展与 skills 按角色卡及能力段的白名单编译进任务包（`tool_contract.allowed`、`worker_resources`），在面板「角色资源」页调节；主代理不填写，种子里的 `tool_contract.allowed` 只能再收窄。

Pi 主代理使用 `dispatch_prepare`；MCP 宿主使用 `ops/tools/subagent_service.mjs` 的公开工具。Pi 提交使用当前会话已连接的服务；CLI 检查准备器与服务合同是否兼容，报不兼容时修复部署，不绕过检查提交。

角色运行配置由运行包 `ops/agents/*.toml` 提供；项目覆盖须经 `.pi/control-plane-model-config.json` 声明。模型选择直接使用当前项目 list/template 的推荐行、有效默认、模型可选档位和配置来源。所选模型不在 Pi 模型清单时编译器直接拒发并点名模型与清单，不换模；由主代理决定替代或收口。

导入范围 `ops/templates/worker-resources.json` 给每个工具、扩展与 skill 标开放方式：`off`、`optional` 或 `default_on`，未记录的按 `off`。Worker 加载运行器固定件、全部 `default_on` 扩展与 skill、白名单里 `optional` 的项；白名单里 `off`、未记录或未安装的项记警告、不加载、不拒发。编译器把角色白名单与 `default_on` 工具并成角色选择，种子 `tool_contract.allowed` 在其内收窄，结果即最终工具面；runner 只追加本次交卷通道的提交工具（`required_tools` 中的一个），空面保持封闭，`command_job` 只在最终工具面含 `bash` 时出现。`off` 工具经 `-xt` 从最终注册表剔除。资源发现不安装或执行扩展。Child 继承已配置的 compaction / retry 设置，保持任务上下文隔离；运行时实际工具和初始状态由 runner 记录，不另行推导一份设置。

本次变更涉及共享设置或压缩扩展时，使用 `ops/tools/pi_child_publish_gate.mjs --preflight` 核对该工具声明的静态前提。preflight/postflight读取相同的设置与扩展，均不读取child结果；不为获得postflight标签重复同一检查。真实运行按实际child回执和本次业务断言验收。正常模型偏好变化不算部署失败；静态检查失败时处理点名缺口，需要改用户配置时取得授权。

### 沙箱与权限边界

Pi child 没有 OS 级沙箱。工具可见性不能隔离进程、网络或文件系统；`write` / `edit` 写域检查不覆盖 Bash、PowerShell、ACL、reparse point 或 TOCTOU。

消费有命令写入的任务结果时，结合 `write_domain` 审计与 scoped Git diff 核对实际写入；工作区外副作用按任务目标核对相关结果，不无条件快照整个环境。存在未解释的越权写入或影响交付的证据缺口时，补齐事实或交用户裁决，不宣称已验收。

## 8. dispatch_prepare 入口

已知 route 时读取该 route 的模板；需要选择能力或模型时再查询列表。按模板填写目标、已有读取材料、任务写域和能力合同。

- CLI：`node ops/tools/dispatch_prepare.mjs --seed-template <route_id>` 获取模板；`--seed <file> --action preview` 只预览；`--action prepare` 只构包；省略 action 准备并提交。
- Pi 工具：使用 `template` 获取种子，`preview` 查看展开结果，`submit` 提交。预览用于排查或核对展开结果，不是每次提交的前置步骤。
- 跨仓：CLI 使用 `--async-target-cwd`，Pi 使用 `target_cwd`；scope 中任务路径相对目标仓。结果模式由任务的 `extensions.cross_repo_acceptance` 声明。

构包字段与值域使用当前模板和工具 schema；需要底层字段说明时查看 `ops/protocols/task-package-reference/field-dictionary.md`。
