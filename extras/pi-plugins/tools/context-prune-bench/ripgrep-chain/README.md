# ripgrep 连续链评测

在 Windows 本机让一个 Pi 会话在同一工作区按官方顺序连续完成 SWE-Milestone ripgrep 14.1.1→15.0.0 的 13 个里程碑，每步结束后隔离判分，用来比较裁剪配置在长会话里的质量与费用。三组：N 不裁剪，R 生产配置，L 只开价格线（触发线设为 1e9）。

## 入口

```
python fetch_testbeds.py                          # 一次性：下载各里程碑 /testbed 镜像层到缓存
python score.py gold MILESTONE [...]              # 一次性：参考解过评测，生成 Windows 有效测试清单 valid/
python chain.py prepare   --profile luna|sol      # 批次目录、隔离 home、预热工作区（不调模型）
python chain.py preflight --profile luna|sol      # 各组加载、模型身份、工具、裁剪配置、bash 与 cargo 检查（不调模型）
python chain.py supervise --profile luna|sol      # 三组并行跑完 13 步；后台启动
python watch.py BATCH-NAME                        # 跟踪每步判分与状态
python analyze.py BATCH-DIR                       # 汇总分数、配对检验、按 API 标价的费用、上下文与裁剪次数，写 BATCH-DIR/analysis.json
```

`calibrate.py` 在起止标签上跑官方测试命令，核对官方分类在 Windows 上的表现（不调模型）。同目录上一级的 `reread.py`（按行范围统计重读）与 `price_line_audit.py`（价格档与价格线审计）可直接用于任意 Pi 会话文件。

## 依赖

| 依赖 | 位置 |
| --- | --- |
| SWE-Milestone 官方仓（评测模块、提示词模板、镜像摘要） | `E:/tmp/pi-github-repos/DeepCommit-ai/SWE-Milestone` |
| SWE-Milestone 数据（配置、SRS 题面、官方测试结果） | `tmp/cf-ripgrep-work/data` |
| 缓存：镜像层 `blobs/`、测试床 `testbeds/`、`valid/`、`gold/`、`calibration/`、cargo target | `tmp/ripgrep-chain/`（不入 git） |
| 被测裁剪包 | `chain.py` 的 `BUILD`，当前指向冻结的 1.6.0-local.3 包；测新版本时改这一处 |
| Rust 工具链（离线）、Git、Pi（批次运行时本机为 0.86.0）、PyYAML | 本机环境 |

`scenario.json` 是 13 步的顺序、是否计分与题面哈希。起点必须是 base-offline 测试床的 `d4b620e`（官方 agent 镜像：14.1.1 加 Rust 2024 兼容补丁）。git 一律 `core.autocrlf=false`；解包后重设 mtime，否则 cargo 按旧时间戳误判新鲜度。

## 输出与清理

批次写到 `test-results/context-prune-bench/<batch>/`，工作区与隔离 home 在 `C:/pib/<batch>/`。`prepare` 与 `supervise` 拒绝覆盖已有批次；新批次在 `chain.py` 的 `PROFILES` 里换 `batch` 名。删除批次时两处一起删；`tmp/ripgrep-chain/` 的缓存可保留复用，删掉后需重新 `fetch_testbeds.py` 与 `score.py gold`。

## 口径

- 判分复刻官方 evaluate-in-isolation 与 PR-F1；测试集限定为参考解在 Windows 上能通过的测试。
- 第 6 步因官方顺序忽略弱依赖，必然 E0761（不计分）；第 12、13 步在并行 DAG 分支上，其终态缺 `max_matches` 迁移，测的是旧 API。
- `analyze.py` 的 `reread` 字段按路径粗算；重读率以 `reread.py` 为准。

结果与方法记录：`notes/verify/prune-replay-and-chain-20260923.md`。
