---
name: rule-corpus-cleanup
layer: orchestration
domain: rule-corpus-governance
capability_group: rule-corpus-cleanup
portability: repo-bound
description: 对任意代理规则语料（`AGENTS.md`、`CLAUDE.md`、系统提示词库、workflow/policy/治理文档）做"去过度防御"清洗：识别禁令堆、许愿谓词、双真源、受众错配等病灶，立写作宪法，子代理批量整修，多视角审计，按内置验收清单判定完成并收尾。当用户提到清洗、瘦身、去防御、精简规则、提示词臃肿、AGENTS 或 CLAUDE 太长太乱、规则互相矛盾、代理被规则卡死变怂变慢，或要求审计、重写、治理任何成套的代理规则与提示词时，使用本技能——即使用户没说"清洗"二字。
---

# 规则语料去防御清洗

> 职责：规定代理规则语料去防御清洗流程。
> 真源：规则语料清洗步骤、资源路由和收口纪律
> 读取：命中读取

## 这个技能治什么病

代理规则语料的常见演化路径是"出了问题就加一条规则防着"。积累的结果：禁令堆、自查仪式、同一事实多处维护、互相矛盾的门禁。跑在上面的代理症状一致——怂、慢、死锁，上下文烧在读规则走流程上，而不是产出。

清洗的方向只有一个判准：**这条规则在帮干活，还是在防干活。** 防的删，帮的立，缺的补。体积下降只是症状指标，不是目标——塑形密度高的语料自然短。

## 不适用

- 单个文件的小修小补：直接改，不走流程。
- 业务代码重构：本技能只管"给模型读的规则文字"。

## 流程

### 第 0 步：侦察

1. 摸清语料地形：文件清单、各自职责、互相引用关系。优先用目录与文件头判断，不逐篇精读正文。
2. 盘点既有机械验证：lint、自测、构包检查、schema 校验。有就记下命令，它们是后续每一步的安全网；没有就以"全文引用可解析、无悬空指针"为底线人工抽查。
3. 用 `ops/skills/rule-corpus-cleanup/references/fingerprints.md` 的病灶指纹表对语料做一轮 grep 级扫描，产出病灶分布图：哪类病、多少处、集中在哪些文件。
4. 发现文件职责、引用关系、机器契约或用户目标无法只靠目录与文件头判断时，升级读取相关正文；只读回答当前判断所需的最小范围。
5. 把分布图和清洗方案给用户拍板再动手。删除类动作（整删文件、整删机制）逐项列明删除理由与残值安置。

### 第 1 步：立宪

清洗判据必须先于清洗存在，否则每个整修者各凭感觉。

1. 目标语料已有写作标准的：通读它，缺口处用 `ops/skills/rule-corpus-cleanup/references/constitution-template.md` 补齐。「已有」的判定：目标仓治理目录下存在职责声明为写作原则、不合格判据或变更流程的文件即算，不论文件名（本仓即 `ops/skills/rule-authoring/SKILL.md`）。
2. 没有的：把 `ops/skills/rule-corpus-cleanup/references/constitution-template.md` 整篇拷入目标语料，作为它自己的写作宪法，路径按目标仓惯例放。
3. 宪法自身先过自己的判据（标题不带括号注音、有正反对照样例）——治病的人先治自己。

### 第 2 步：批量整修

按 `ops/skills/rule-corpus-cleanup/references/tasking-templates.md` 的整修任务书模板派子代理分批执行。要点：

- 分组按文件不相交切分；被多文件共享的公共层单独一批或由你亲手改。
- 出现两个以上并发批次时，先读 `ops/skills/subagent-fleet-discipline/SKILL.md`，形成舰队计划后再构包。
- 任务书必含四件套：先读文件清单、必修与必留清单、验收命令、回报格式。
- **只改表达形态，不改规则语义**；语义级发现记入回报，由你裁决，子代理不动手。
- 核对本次修改涉及的字段、枚举、锚点和机器读取块，只验证被修改的内容。
- 子代理的回执不是落盘证据。每批收工后用 `git diff` 亲自核对磁盘，声称与磁盘不符按虚报处理、重做。

### 第 3 步：检查修改结果

对照本次修改与已有证据检查结果。仍有具体问题需要独立判断时，选用对应视角：

- **漏网视角**：本次已明确要改的内容是否遗漏。
- **误删视角**：本次删除或改写是否偏离任务目标，相关消费面是否同步。
- **言行对账**：提交信息逐条声称对 diff，虚报与漏报都列出。

audit 任务书模板同在 `ops/skills/rule-corpus-cleanup/references/tasking-templates.md`。findings 逐条裁决：采纳的修复，搁置的说明理由。只核验修复内容，复用其他有效结果。

### 第 4 步：验收与收尾

按 `ops/skills/rule-corpus-cleanup/references/acceptance.md` 确认本次修改达到目标后收口。说明实际修改、验证结果与尚未解决的内容；复用已有有效证据。

## 关键纪律（贯穿全程）

| 纪律 | 一句话 |
| --- | --- |
| 残值安置 | 删任何机制前先回答：它防的事现在由谁防。答不出就不删。 |
| 坏例三不 | 对照样例中的坏例不指名被废除的旧机制、不复述坏动作的可执行细节、不引入好例之外的新概念。 |
| 验证点即提交点 | 机械验证能跑绿的点就是提交点；每批一个提交，混批是事故温床。 |
| 无关脏文件 | 不修改、不暂存；交付时点名保留项。 |
| 体积不是 KPI | 报告里体积只作症状指标；真正的验收是病灶清零与行为改善。 |

## 何时读哪个参考文件

| 时机 | 读 |
| --- | --- |
| 第 0 步扫描前 | `ops/skills/rule-corpus-cleanup/references/fingerprints.md` |
| 第 1 步立宪时 | `ops/skills/rule-corpus-cleanup/references/constitution-template.md` |
| 第 2、3 步写任务书时 | `ops/skills/rule-corpus-cleanup/references/tasking-templates.md` |
| 第 4 步收尾时 | `ops/skills/rule-corpus-cleanup/references/acceptance.md` |
