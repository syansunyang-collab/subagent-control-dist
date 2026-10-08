# Changelog

## 1.6.0-local.12 - 2026-10-03

- Map original tool-result IDs to Responses wire IDs using the producing assistant's provider/API/model identity. Native xAI composite IDs retain their call part; cross-model/provider IDs follow Pi 0.99.1 conversion. Successful visible reads are confirmed; error, aborted and unsent requests remain unread.
- Keep archived read-back pages on complete Unicode code-point boundaries. Continue at the first unreturned character and defer refs when the remaining body budget cannot fit their next code point. The 16,000 UTF-16-unit body cap and existing cursors are unchanged.
- Run ID and Unicode read-back regressions through the installed host's real Responses converter offline. Tests use the global Windows Pi host by default; PI_CONTEXT_PRUNE_TEST_AI_DIST can select another installed host's pi-ai dist directory.

## 1.6.0-local.11 - 2026-10-03

- Confirm xAI Responses and other providers' pending tool results only after the provider hook and a successful assistant response; errors, aborts and unsent requests remain unread. Responses acknowledgements use adapter-visible IDs and survive reload.
- Report missing, unreadable, malformed and invalid-field policy configuration at startup. These cases use cold-mask without summaries; budget-summary remains an explicit valid configuration.
- Bound archived read-back text to 16,000 characters per call across refs. Return an in-line character cursor alongside the line offset, preserving original text and newline spelling across continuation pages.

## 1.6.0-local.10 - 2026-09-28

- cold-mask 新增 `compactionHoldRatio`（默认 0.72，`0` 关闭）：Pi 上下文用量达到模型窗口的该比例后不再新增裁剪，已有回执照常发送。自动压缩在 90% 处重写历史，临近时裁剪付出的缓存重算会被压缩作废；0.72 即压缩线的 80%。
- 依据：6 个会话的回放中 5 个不变，1 个在四种缓存假设下均更省；手动压缩与会话结束无法预判，不在本项覆盖范围。

## 1.6.0-local.9 - 2026-09-27

- Codex 主请求成功后保存本次 provider payload 中出现的新增工具结果 ID；完整 reload 后按当前分支恢复已读资格，避免尚未归档的已读结果再完整发送一次。
- 失败、取消和未到发送钩子的请求不授予已读资格；未读尾部、最近两轮、保护结果及已有回执沿用原规则。记录不进入模型上下文，不新增模型请求。
- 旧会话没有已读记录的部分不回填推断；新版本成功读取后开始持久化。其他 provider 保持原有内存资格行为。此项不宣称解决所有缓存回退。

## 1.6.0-local.8 - 2026-09-27

- 新增 `/pruner-threshold` 阈值选择，支持 6K、15K、30K、60K，也支持直接带参数。选择从下一次判断生效，无需 reload；当前分支持久化，覆盖配置文件默认值。
- 阈值切换保留既有回执和暂停状态，取消旧阈值下待应用的摘要任务。全局默认及模型自主裁剪模式不变。

## 1.6.0-local.7 - 2026-09-27

- 将 `/pruner pause|resume|status` 替换为三条独立命令 `/pruner-pause`、`/pruner-resume`、`/pruner-status`，可直接从斜杠菜单选择。暂停状态和裁剪行为不变。

## 1.6.0-local.6 - 2026-09-27

- 生产 policy-lab 入口新增 `/pruner pause`、`/pruner resume`、`/pruner status`。暂停状态保存在当前会话分支，重载后恢复。
- 暂停只停止新增裁剪和摘要，保留既有回执、摘要与原文查询工具；待应用的摘要被取消，晚到结果不再应用。
- 该命令需要扩展保持加载。全局禁用或卸载扩展仍会移除回执替换逻辑；本版本不自动修改启用设置。

## 1.6.0-local.5 - 2026-09-26

### Added

- `stageSummary` in `policy-lab.json` (default `true`). With `"mode": "cold-mask", "stageSummary": false` old results are released behind `[pruned:tN]` receipts as soon as the token budget is reached, and no summarizer is ever called: no summary message enters the context, and nothing waits for a summary before a release applies.

### Changed

- The read-back tool text: a `[pruned:tN]` receipt means the output was archived and the call is still in context; a pruned file is read again from disk (the archive may be out of date); outputs a rerun would not reproduce (test and command output of an earlier state, errors, fetched pages, search results) are read back with `context_tree_query`. The old guideline asked for a read-back of every receipt, which the models did not follow.

## 1.6.0-local.4 - 2026-09-25

### Fixed

- A summary is added to a request at its session position (right after the message of the nearest earlier session entry), no longer right after the results it covers. Pi 0.87.1 rebuilds the message list from the session at every turn boundary, so from the request after an apply on the summary appeared at its session position; the apply request had it elsewhere, and the next request rewrote the history a second time. With Astra that meant a second full-history cache miss after every apply (24 of 24 applies in a production session since the Pi 0.87.1 upgrade).

## 1.6.0-local.3 - 2026-09-23

### Fixed

- Price line: a second crossing while the stage summary of an earlier crossing was still being written dropped that summary, and the results it covered kept only their receipts. The pending stage summary now stays; results archived in the meantime get their own stage summary at a later turn end. A result that no stage summary covers (the call failed or was dropped) is tried once more while it is still in the context.
- Price line: the request estimate is anchored on the last usage, which still contained results that a budget summary replaces at the same boundary. The estimate now subtracts what this boundary replaced and adds the summary it inserted, so a budget summary that already brings the request under the line no longer triggers the line.
- Summary provenance: a fetch counted as a copy of a local file whenever the URL path ended with the local path over two segments, or one for a bare file name, so another project's `README.md` or `src/index.ts` was withheld from the summarizer. A copy now needs a shared tail of at least three segments, or a shorter tail plus at least three substantive lines (and a fifth of the smaller side) that the batch also saw locally in read or grep output or in edit/write arguments. On 1,160 recorded batches the withheld set is unchanged (10 fetches).

## 1.6.0-local.2 - 2026-09-23

### Added

- `budget-summary` price line. Before each request the size of the request is estimated the way Pi does (the last usable assistant usage plus an estimate for the messages after it). When it reaches `priceLineRatio` (default 0.85) of the active model's price line, every releasable result except the newest tool turn is archived behind receipts in that request, a pending budget batch is dropped, and a stage summary of the archived results joins the context at a later boundary. Price lines come from `priceLines` in `policy-lab.json` (`"provider/model-id"` patterns with `*`); the defaults are 272,000 input tokens for `openai-codex/gpt-5.6-sol*`, `gpt-6-astra*` and `gpt-5.6-luna*` (OpenAI API pricing, checked 2026-09-23) and 200,000 for `xai/grok-4.6*` (xAI docs, checked 2026-09-19). Models without a line are unaffected; `priceLineRatio: 0` turns it off.

## 1.6.0-local.1 - 2026-09-23

Local release; not published to npm. The production build is `dist/policy-lab.js` in `budget-summary` mode, installed at `~/.pi/agent/local-packages/pi-context-prune` by the release tool in the operator's workspace repository (`tools/context-prune-release.py`).

### Added

- `policy-lab.ts` entry (`dist/policy-lab.js`) with two release policies, configured in `context-prune/policy-lab.json`. `budget-summary` collects the oldest releasable tool results after a tool turn until `triggerTokens` (default 6000) is reached, keeps the most recent `keepRecentToolTurns` (default 2) turns, summarizes the merged batch in the background and applies it at a later context boundary only when it saves tokens. `cold-mask` archives budgeted results verbatim behind short receipts first and adds a stage summary later. The only tool it registers is `context_tree_query`, with line-based pagination.

### Changed

- `agent-message` also triggers on assistant messages that carry text together with tool calls (`index.ts` entry).
- The summarizer prompt asks for one handoff note grouped by goal, with exact values copied verbatim, and names the source of each fact when the same file appears from more than one place. Consecutive summary refs are written as ranges.

### Fixed

- Skill instruction files (`SKILL.md` and files under a skill directory that the session has read) and tool results that contain images are never summarized or replaced.
- Token counting treats reserved token spellings such as `<|endoftext|>` in tool output as ordinary text instead of throwing.
- When a batch reads a file locally and also fetches the same file from a URL, the fetched text is not shown to the summarizer; it gets a stub with the URL and size, and the original stays retrievable by id. The summarizer had filled a partial local read with the fetched upstream text and reported it as local code.
- Summarizer requests map the local 500k-window Codex aliases (`gpt-5.6-sol-500k`, `gpt-6-astra-500k`) to the upstream model ids. This patch was previously applied to deployed bundles only.

## 1.5.4 - 2026-09-19

### Fixed

- Tool results that a native compaction already folded away are no longer summarized. Candidates were taken from the whole session branch, so a result that was still unsummarized when Pi compacted (for example a long run under `agent-message` or `on-demand`) cost a summarizer call for text the model no longer receives, and after a reload its summary sat next to Pi's compaction summary. Results are now looked up in the compaction-aware entries (`sessionManager.buildContextEntries()`); turns are still numbered over the whole branch. Pi versions without that method keep the previous behaviour.

### Changed

- The wiring tests chain session entries by id and rebuild the agent's message list with Pi's own `buildContextEntries` on reload and compaction.

## 1.5.3 - 2026-09-19

Both fixes concern behaviour inherited from upstream 1.4.0.

### Fixed

- Summaries now reach the model within the same session. `agent-message` and `every-turn` flushes store the summary with `sessionManager.appendCustomMessageEntry`, which writes the session file but not the running agent's message list; Pi reads the file back only on reload. Until then every later request carried stubs pointing at a summary the model never received. The `context` hook now adds any summary the list lacks, right after the tool results it covers (where a steer message would land), so it keeps the same position on every request. Summaries already in the list (runtime delivery, or a list rebuilt on reload) are not added again.
- Tool turns of later prompts are no longer dropped. `turn_end` numbered its batch with Pi's `event.turnIndex`, which restarts at 0 on every prompt, while the prune frontier numbers every assistant message on the branch. From the second prompt on, early turns looked already attempted: `every-turn` skipped their prune and `agent-message` stopped queueing them. `turn_end` now uses the branch-wide number.
- The stub now says the summary follows the pruned results instead of preceding them. The stub text changes once, so the first request after upgrading re-reads previously cached context.

### Added

- `npm test`: builds the bundle, then runs wiring tests against it with a fake Pi runtime that keeps the session file and the agent's message list apart and deep-clones the list before the `context` hook, as Pi does.

## 1.5.2 - 2026-09-17

Documentation and packaging only; no behaviour change.

### Changed

- `description` now matches the repository's: what the extension does, and that it is a fork of upstream 1.4.0.
- README: a Chinese translation ([README.zh-CN.md](README.zh-CN.md)) and a language switcher; the fork notice covers the 1.5.1 abort fix.
- Sections written by the upstream project are labelled as such: "Follow-up ideas" is upstream's roadmap, not this fork's plan, and PRUNING.md carries an authorship note.
- The limitation about summarizer latency now states the 1.5.1 abort binding and the 180 s deadline.

### Added

- [`bench/`](bench/README.md): method, per-run metrics for 29 runs at thinking medium plus three at high, the A/B harness and the isolation scanner. The measured quality cost is stated, not just the token saving.

## 1.5.1 — 2026-09-17

### Fixed

- Stop now works while the pruner is summarizing. Pi awaits the `turn_end`, `tool_execution_end` and `message_end` hooks, so a summarizer call made from a hook kept the run active and `abort()` waited for it. Hook-triggered flushes are now bound to the run's abort signal (`ctx.signal`); an aborted flush keeps its batches and the next trigger summarizes them.
- Hook-triggered flushes give up after 180 s, so a stalled summarizer stream can no longer hold the session. The batches are kept and a warning is shown.
- `npm publish` works from Windows (`check-package` and `build` scripts no longer depend on `npm` being spawnable without a shell or on `rm`).

## 1.5.0 — 2026-09-17

First release of the fork (`@syansunyang/pi-context-prune`), based on upstream `pi-context-prune` 1.4.0 (championswimmer/pi-context-prune@626f270).

### Fixed

- Pruned tool results are replaced by a short stub instead of being deleted. Deleting them left the assistant's tool call unpaired: pi-ai's `transformMessages` then inserted a synthetic `No result provided` error result, and providers that bypass that transform sent the call with no result at all. Either way the model saw failed tool calls.
- Assistant turns that ended with `stopReason` `error` or `aborted` are no longer treated as the final reply of the turn, so a provider error followed by a retry no longer prunes the results the retry still needs.
- The prune index, stats and frontier are rebuilt from the session on demand inside the `context` hook. The first request after a reload is pruned even when another extension triggers a turn before this extension's `session_start` runs.
- The summarizer stream call sends the OpenCode session headers.

### Added

- `summarizerMaxCharsPerResult` config key and `/pruner max-chars <n>` command (default 2000, as before).

### Packaging

- `dist/` is tracked in git so `pi install git:…` works without a build step.
- `peerDependencies` removed; the Pi extension loader provides `@earendil-works/pi-*` and typebox.
