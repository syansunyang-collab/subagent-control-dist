# 切片模板目录

> 职责：给六类高频舰队任务的标准切片模板——适用判据、切片清单和 reducer 配置，让主代理照模板落 FLEET_PLAN 而不每次从零推。
> 真源：本文件承载模板；切片编译决策树、四元组填法、拒绝条件见 `ops/skills/subagent-fleet-discipline/references/parallel-slicing.md`；归并波规格见 `ops/skills/subagent-fleet-discipline/references/reducer-wave.md`。
> 读取：命中读取

## 目录

- 模板 1：workflow seam scan（8 路）
- 模板 2：control-plane rule audit
- 模板 3：runtime/tooling failure review
- 模板 5：large docs cleanup
- 模板 6：implementation + verify wave

模板是起点不是终点：路数按目标仓实际接缝面增减，每片仍过 parallel-slicing 的拒绝条件自查。

## 模板 1：workflow seam scan（8 路）

**适用判据**：找一个工作流仓的流程接缝与编排接缝——状态面、发布面、工具面、环境面、视觉门、退场、自检、成本八个面都要各查一遍。判断维度轴，只读，各写各报告。

**切片清单**（8 路，路名即维度；跨仓时全部 `target_isolation=read_only`，`write_scope=notes/explorer/** + notes/handoffs/**`）：

| 路名 | 单问题 | route | read_scope_layers（层→内容） |
| --- | --- | --- | --- |
| 状态面一致性 | `STATUS` 声明与 `runs/` `outputs/` 落盘是否一致？ | `explorer-agent__codebase-scan` | entry=状态文件；index=运行态/产物目录；deep=产物目录（when：声明 cleared 但 index 非空）；deferred=依赖目录 |
| 发布面合同 | 发布 manifest / README 字段是否符合 publish 合同、有无旧字段残留？ | `semantic-review-agent__contract-drift-inspection` | entry=发布脚本+manifest+README；index=产物目录；deferred=产物 zip |
| 工具面接口 | 工具 CLI 接口 / 参数与调用方声明是否一致？ | `semantic-review-agent__contract-drift-inspection` | entry=工具入口脚本；index=工具目录；deep=工具子目录（when：接口声明引用到该子模块） |
| 环境面缓存 | 环境缓存机制声明与实际探测是否一致？ | `explorer-agent__runtime-env-scan` | entry=环境缓存 workflow doc+探测脚本；deferred=缓存产物目录 |
| 视觉 gate | 正式视觉 gate 与追溯材料的边界表述是否唯一不混？ | `verify-agent__ui-interaction-inspection`（纯文字门定义一致性降 `semantic-review-agent__rule-quality-inspection`） | entry=入口规则+视觉审核 workflow+图形标准；deep=渲染样例（when：需比对实际渲染像素） |
| 旧机制退场 | 退场词是否真正退场、有无残留？ | `semantic-review-agent__contract-drift-inspection` | entry=退场规格 doc；index=全仓文本；deep=命中退场词的文件（when：grep 命中退场词） |
| 自检覆盖 | 自检脚本覆盖面是否含状态面一致性与发布合同？ | `verify-agent__code-verification` | entry=自检脚本；index=被自检覆盖的规格 doc |
| 成本热点 | 哪些扫描面是成本热点（大目录、高文件数），下一波如何收窄读取范围？ | `explorer-agent__codebase-scan` | index=仓根（列目录+文件数，不读内容）；deferred=全部大目录 |

状态面一致性片的 read_scope_layers 完整示例（其余路照此结构填，`<target-repo>` 为控制仓外目标仓）：

```json
{
  "entry": ["<target-repo>/STATUS.md"],
  "index": ["<target-repo>/runs/", "<target-repo>/outputs/"],
  "deep": [{"path": "<target-repo>/outputs/", "when": "STATUS 声明 cleared 但 index 显示非空，深入确认残留包类型"}],
  "deferred": ["<target-repo>/.venv/", "<target-repo>/.runtime/"]
}
```

**reducer 配置**：8 路 ≥3 → 必配。`reduce-<run>-seams`，`general-agent__general-default`，`depends_on`=全部 8 路，输入=8 份 report/handoff 路径，输出=接缝合并表+冲突标注+未覆盖面声明。

使用 `semantic-review-agent__contract-drift-inspection` 的切片，`target_files` 完整列出同一问题的主审对象，另把消费侧取证根目录授权进 `scope.read` 与 `index/deep`。只有 target files、没有 evidence root 时，不执行全仓 grep；先补构包或把问题缩窄为 target files 之间的互证。

## 模板 2：control-plane rule audit

**适用判据**：审 `AGENTS.md` 与 `ops/**` 一套控制面规则的质量与跨文件契约（判据即 `ops/skills/rule-authoring/SKILL.md` §1/§2）。判断维度轴，只读。

**切片清单**：按独立审查问题分片；规则质量按 policy / protocol / workflow / route 等问题域组织，contract-drift 负责跨文件字段、值域和机制声明与消费一致性。材料容量按 `ops/protocols/subagent-information-injection.md` §3 处理。read_scope_layers：entry=该域规则文件；index=相邻域（只列不读）。

**reducer 配置**：域片 ≥3 → 必配，输出按 R1–R12 归类的 finding 合并表。

## 模板 3：runtime/tooling failure review

**适用判据**：一次 runtime 或工具故障后复盘，找根因与修复归属（如 fleet 演练报告本身）。判断维度轴按故障面分：合同面、运输面、隔离面、summary 面。

**切片清单**：现场片 `explorer-agent__runtime-env-scan`（读故障 runtime 产物与现场）；合同片 `semantic-review-agent__contract-drift-inspection`（终态词表 / salvage / 字段合同）；复现片 `verify-agent__code-verification`（可控夹具复现故障）。read_scope_layers：entry=相关工具源+故障产物；deferred=大 runtime 目录（`runs/`、`.runtime/`）。

**reducer 配置**：≥3 片 → 必配，输出根因表+修复归属+复现证据路径。

## 模板 5：large docs cleanup

**适用判据**：成套代理规则 / 提示词语料去过度防御清洗。完整病灶清单与验收读 `ops/skills/rule-corpus-cleanup/SKILL.md`，本模板只给切片形态。

**切片清单**：文件簇轴——一簇文件一片 `batch-agent__mechanical-batch` 按写作宪法整修（写集不相交）；落盘后加审计波（漏网 / 误删 / 言行对账，`semantic-review-agent__rule-quality-inspection`，晚一波）。

**reducer 配置**：审计波 ≥3 视角 → 配归并；整修波各簇独立，主代理逐簇 git diff 亲核。

## 模板 6：implementation + verify wave

**适用判据**：有界实施 + 落盘后验证的两波任务。波次轴。

**切片清单**：第一波实施片 `executor-agent__scoped-execution`（文件簇轴，写集不相交，一片一个有界目标）；第二波验证片 `verify-agent__code-verification` 或 `verify-agent__functional-inspection`，`depends_on` 对应实施片。验证片 read_scope_layers 的 entry=实施片写过的文件（上波产物路径）。

**reducer 配置**：验证片各自出证据，不需 reducer；实施片 ≥3 且需跨片一致性归并时配。
