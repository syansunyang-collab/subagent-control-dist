// run-pi-task.selftest.mjs — run-pi-task.mjs 的伴生自测:fake pi stub 真源与端到端场景断言。
//
// 入口是 `run-pi-task.mjs --self-test` 的惰性 import 委托。说明符必须保持字面量:esbuild 只内联
// 字面量动态 import,本模块要随 run-pi-task.mjs 一起进 ops/dist/run-pi-task.bundle.mjs,
// bundle 侧的 --self-test 冒烟(ops/tools/deploy_subagent_bundle.py 的 RUNNER_SELF_TEST_MARKERS、
// tests/control_plane/test_subagent_build_cli.py)才有实现可跑。
//
// 本模块不 import run-pi-task.mjs:反向静态 import 会与 runner 的 top-level await 互等成
// unsettled TLA;期望值一律独立硬编码,自测才能判定 runner 侧的漂移。
//
// renderPiStubSource 是本仓 fake pi stub 的唯一真源,runner 自测与
// tests/control_plane/run_pi_task_security.test.mjs 共用同一份协议帧,各自只传场景参数。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeStdoutSync } from "./_child-task-contract.mjs";
import { ensureDir } from "./_stdio-jsonrpc.mjs";

const BACKEND = "pi-rpc";
const RUNNER_NAME = "run-pi-task";

// 六段标题合同的最小合格正文;stub 的默认回执,保证 ok 链路可判定为 completed。
export const PI_STUB_DEFAULT_FINAL_TEXT = [
  "## 结论",
  "任务状态:completed",
  "## 事实与证据",
  "- stub 回执 PI_STUB_OK",
  "## 已检查内容",
  "- self-test 链路",
  "## 失败检查",
  "无",
  "## 不确定项",
  "无",
  "## 边界",
  "- stub 不执行真实任务",
].join("\n");

// stub 以 node 子进程身份被 runner spawn(经 env PI_CONTROL_PI 注入),复刻 pi 0.84.2 的命令/事件帧。
// 场景由 env PI_STUB_MODE 选择,'-' 与 '_' 等价;可选 env:
//   PI_STUB_ARGV_OUT      收到的 argv 落盘,供 spawn 规格断言
//   PI_STUB_COMMANDS_OUT  逐条 RPC 命令名追加落盘,供命令序列断言
//   PI_STUB_WORKER_ENV_OUT  仅记录 worker 清单路径与继承标志,供环境透传断言
//   PI_STUB_SCRATCH_OUT   记录本任务临时目录、启动时是否已存在与写域规格,并往临时目录写一个文件模拟命令用过它
//   PI_STUB_SETTINGS_PATH set_auto_compaction / set_auto_retry 的持久化落点,供设置污染断言
//   PI_STUB_SUBMIT_VERDICT  交卷记录的 verdict,缺省 done
//   PI_STUB_FAILED_TOOL   为 1 时 submitted_failure_words 追加一次失败的 read 调用
// 场景:ok / catalog_miss / catalog_miss_mismatch / fast_model_missing / identity_mismatch / thinking_clamp / bash_error / dirty_ok /
//       dirty_provider_error / turn_timeout(别名 no_settle)/ crash / boot_crash /
//       compaction_midrun(abort → 压缩 → 插件续跑)/ compaction_no_resume(压完无人续)/
//       error_then_idle(error 回执后 idle,正文为空只记事实)/ brief_final(正文仅两节)/
//       write_domain_blocked(write 越界被扩展拒绝并留审计)/
//       tool_loop(20 次只换数字参数的 bash 调用后正常收尾)/tool_loop_repeat(20 次同参数轮询后正常收尾)/
//       tool_loop_noop(8 次内容各异的 echo 空转命令后收尾)/tool_loop_noop_short(7 次空转后接真实命令)/
//       tool_loop_noop_exit(8 次 PowerShell exit 0)/tool_loop_ps_read(8 次 Write-Output (Get-Content …) 后正常收尾)/
//       draft_then_loop(写好交卷文件后空转)/draft_written(写好交卷文件后正常收尾)/
//       draft_invalid_then_fix(交卷文件首轮 verdict 越界，修正轮改对)/submitted_then_loop(交卷成功后空转)/
//       review_submitted_brief(submit_review_result 落结果，最终回复一句话)/
//       submitted_failure_words(交卷成功，最终回复含失败叙述)/
//       tool_loop_alternate(bash 与 read 交替 20 次后正常收尾)/
//       tool_loop_reset(19 次相同后接 2 个不同签名,再正常收尾)/
//       tool_loop_read_pages(同一文件 20 次不同 offset 的 read 后正常收尾)/
//       tool_loop_numbered_files(cat file1.txt…cat file20.txt 后正常收尾)。
export function renderPiStubSource({ finalText = PI_STUB_DEFAULT_FINAL_TEXT } = {}) {
  return [
    "import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    `const finalText = ${JSON.stringify(finalText)};`,
    "const argv = process.argv.slice(2);",
    "const mode = (process.env.PI_STUB_MODE || 'ok').split('-').join('_');",
    "function flagValue(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }",
    "const provider = flagValue('--provider') || 'stub-provider';",
    "const modelId = flagValue('--model') || 'stub-model';",
    "const thinking = flagValue('--thinking') || 'medium';",
    "const sessionDir = flagValue('--session-dir');",
    "const sessionFile = flagValue('--session') || (sessionDir ? path.join(sessionDir, 'stub-session.jsonl') : undefined);",
    "if (process.env.PI_STUB_ARGV_OUT) { writeFileSync(process.env.PI_STUB_ARGV_OUT, JSON.stringify(argv, null, 2), 'utf8'); writeFileSync(process.env.PI_STUB_ARGV_OUT + '.recovery.json', JSON.stringify({ stallTimeoutMs: process.env.PI_RETRY_STALL_TIMEOUT_MS })); }",
    "if (process.env.PI_STUB_WORKER_ENV_OUT) writeFileSync(process.env.PI_STUB_WORKER_ENV_OUT, JSON.stringify({ path: process.env.PI_WORKER_TOOLS_PATH, inherit: process.env.PI_WORKER_INHERIT_TOOLS, identity: process.env.PI_WORKER_TASK_PACKAGE_PATH }));",
    "if (process.env.PI_STUB_SCRATCH_OUT) { const scratch = process.env.PI_CONTROL_BASH_SCRATCH || null; writeFileSync(process.env.PI_STUB_SCRATCH_OUT, JSON.stringify({ scratch, existedAtStart: Boolean(scratch) && existsSync(scratch), writeDomain: process.env.PI_WRITE_DOMAIN ? JSON.parse(process.env.PI_WRITE_DOMAIN) : null })); if (scratch) { mkdirSync(scratch, { recursive: true }); writeFileSync(path.join(scratch, 'probe.txt'), 'temp'); } }",
    "if (sessionDir) { mkdirSync(sessionDir, { recursive: true }); appendFileSync(sessionFile, JSON.stringify({ role: 'stub', at: Date.now() }) + '\\n', 'utf8'); }",
    "if (process.env.PI_WRITE_DOMAIN) { const spec = JSON.parse(process.env.PI_WRITE_DOMAIN); mkdirSync(path.dirname(spec.log), { recursive: true }); appendFileSync(spec.log, JSON.stringify({ schema_version: 1, kind: 'guard_ready', profile: 'pi-child-write-domain/v1', at: new Date().toISOString(), task_id: spec.taskId || null }) + '\\n', 'utf8'); }",
    // boot_crash:收到第一条命令就退出,runner 的握手 get_state 永远等不到响应。
    "if (mode === 'boot_crash') {",
    "  process.stdin.on('data', () => process.exit(9));",
    "  process.stdin.resume();",
    "  setInterval(() => {}, 1 << 30);",
    "} else {",
    "const mismatch = mode === 'identity_mismatch' || mode === 'catalog_miss_mismatch';",
    "const thinkingClamp = mode === 'thinking_clamp';",
    "const dirty = mode === 'dirty_ok' || mode === 'dirty_provider_error';",
    // turn_timeout 与 no_settle 是同一行为的两个调用方命名:停在 agent_settled 之前。
    "const noSettle = ['turn_timeout', 'no_settle', 'cancel_bash', 'cancel_ignore_eof'].includes(mode);",
    "const stopReason = mode === 'dirty_provider_error' ? 'error' : mode === 'aborted' ? 'aborted' : 'stop';",
    "const compactionMode = mode === 'compaction_midrun' || mode === 'compaction_no_resume';",
    "let streaming = false;",
    "let compacting = false;",
    "let promptCount = 0;",
    "let lastPrompt = '';",
    "let stateProbes = 0;",
    "let currentModel = mismatch ? { id: 'other-model', provider: 'other-provider' } : { id: modelId, provider };",
    "let currentThinking = mismatch ? 'off' : thinkingClamp ? 'high' : thinking;",
    "function modelEntry(p, id) { return { id, provider: p, name: id, api: 'stub-api', reasoning: true, contextWindow: 200000, maxTokens: 64000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }; }",
    "const catalog = mode === 'fast_model_missing' ? [modelEntry(provider, 'grok-4.7')] : mode.startsWith('catalog_miss') ? [modelEntry('other-provider', 'other-model')] : mode === 'pi_level_unsupported' ? [{ ...modelEntry(provider, modelId), thinkingLevelMap: { low: null } }] : [modelEntry(provider, modelId), modelEntry('other-provider', 'other-model')];",
    "const usage = { input: 123, output: 45, cacheRead: 6, cacheWrite: 7, reasoning: 3, totalTokens: 181, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };",
    "function out(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }",
    "function raw(line) { process.stdout.write(line + '\\n'); }",
    "function ok(id, command, data) { const msg = { id, type: 'response', command, success: true }; if (data !== undefined) { msg.data = data; } out(msg); }",
    "function state() { return { model: currentModel, thinkingLevel: currentThinking, isStreaming: streaming, isCompacting: compacting, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', sessionId: 'stub-session-id', sessionFile, autoCompactionEnabled: true, autoRetryEnabled: true, messageCount: 0, pendingMessageCount: 0 }; }",
    "function persistSetting(section, enabled) {",
    "  if (!process.env.PI_STUB_SETTINGS_PATH) { return; }",
    "  const settings = JSON.parse(readFileSync(process.env.PI_STUB_SETTINGS_PATH, 'utf8'));",
    "  settings[section] = { ...(settings[section] || {}), enabled };",
    "  writeFileSync(process.env.PI_STUB_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\\n', 'utf8');",
    "}",
    "function assistantMessage() { const text = mode === 'assistant_text_rpc_fail' ? '' : mode === 'brief_final' ? '## 结论\\n任务状态：completed\\n\\n## 事实与证据\\n已通过 submit_task_result 提交。' : mode === 'submitted_brief' ? '已通过 submit_task_result 交付，报告见 notes/general/report.md。' : mode === 'submitted_failure_words' ? '命令执行失败，已通过 submit_task_result 交卷。' : mode === 'review_submitted_brief' ? '审查交付完成：gate pass，未发现问题。' : finalText; return { role: 'assistant', content: text ? [{ type: 'text', text }] : [], api: 'stub-api', provider: currentModel.provider, model: currentModel.id, responseModel: currentModel.id + '-2026-08', usage, stopReason, timestamp: Date.now() }; }",
    // 压缩插件 ctx.compact() 先 abort 当前回合:pi 以 stopReason=error + 'This operation was aborted' 收束该回合。
    "function abortedMessage(errorMessage) { return { role: 'assistant', content: [], api: 'stub-api', provider: currentModel.provider, model: currentModel.id, responseModel: currentModel.id + '-2026-08', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: 'error', errorMessage, timestamp: Date.now() }; }",
    "function emitSettled() { streaming = false; out({ type: 'agent_settled' }); }",
    "function emitCompactionCycle(resume) {",
    "  setTimeout(() => { compacting = true; out({ type: 'compaction_start', reason: 'manual' }); }, 40);",
    "  setTimeout(() => { compacting = false; out({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'stub summary', tokensBefore: 180000, estimatedTokensAfter: 2000 } }); }, 90);",
    "  if (resume) { setTimeout(() => { out({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '[pi-midrun-compact/v1] Auto-compaction completed. Continue the interrupted task.' }], timestamp: Date.now() } }); emitRun('normal'); }, 130); }",
    "}",
    // 握手前先吐两条非 JSON 行:真实 pi 在扩展/主题加载期会往 stdout 漏 banner。
    "if (dirty) { raw('pi banner: loading extensions'); raw('{\"unterminated\": '); }",
    "function emitRun(kind) {",
    "  streaming = true;",
    "  out({ type: 'agent_start' });",
    "  out({ type: 'turn_start' });",
    "  if (dirty) { raw('<<< stray pi notice >>>'); }",
    "  out({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'stub prompt' }], timestamp: Date.now() } });",
    "  out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'stub prompt' }], timestamp: Date.now() } });",
    "  if (mode === 'cancel_bash') out({ type: 'tool_execution_start', toolCallId: 'tc-cancel', toolName: 'bash', args: { command: 'long-running stub' } });",
    "  const toolCall = (id, toolName, args) => { out({ type: 'tool_execution_start', toolCallId: id, toolName, args }); out({ type: 'tool_execution_end', toolCallId: id, toolName, result: { output: 'ok' }, isError: false }); };",
    "  const echoCalls = (from, count) => { for (let i = from; i < from + count; i += 1) toolCall('tc-echo-' + i, 'bash', { command: 'sleep ' + i }); };",
    "  const sameCalls = (count) => { for (let i = 1; i <= count; i += 1) toolCall('tc-same-' + i, 'bash', { command: 'sleep 5' }); };",
    "  const writeSubmission = () => writeFileSync(process.env.PI_TASK_RESULT_PAYLOAD_PATH, JSON.stringify({ submitted_at: new Date().toISOString(), handoff_check: { checked: false, status: 'not_configured', issues: [] }, scope_validation: { compliant: true, violation_count: 0 }, result: { verdict: process.env.PI_STUB_SUBMIT_VERDICT || 'done' } }), 'utf8');",
    // submitted_brief:像 submit_task_result 扩展一样落交卷记录,最终回复只有一句话。
    "  if (mode === 'submitted_brief' && process.env.PI_TASK_RESULT_PAYLOAD_PATH) { toolCall('tc-submit', 'submit_task_result', { payload_path: 'artifacts/result.json' }); writeSubmission(); }",
    "  if (mode === 'submitted_failure_words' && process.env.PI_TASK_RESULT_PAYLOAD_PATH) { toolCall('tc-submit', 'submit_task_result', { payload_path: 'artifacts/result.json' }); writeSubmission(); if (process.env.PI_STUB_FAILED_TOOL === '1') { out({ type: 'tool_execution_start', toolCallId: 'tc-failed-read', toolName: 'read', args: { path: 'missing.txt' } }); out({ type: 'tool_execution_end', toolCallId: 'tc-failed-read', toolName: 'read', result: { output: 'ENOENT' }, isError: true }); } }",
    // submitted_then_loop:交卷已成功落记录，之后连串空转命令直到熔断。
    "  if (mode === 'submitted_then_loop' && process.env.PI_TASK_RESULT_PAYLOAD_PATH) { toolCall('tc-submit', 'submit_task_result', { payload_path: 'artifacts/result.json' }); writeSubmission(); for (let i = 0; i < 8; i += 1) toolCall('tc-post-submit-' + i, 'bash', { command: 'echo ending-' + i }); return; }",
    // draft_*：从 prompt 里取约定交卷文件路径，像模型用 write 工具那样写交卷文件。
    "  const draftPath = (lastPrompt.match(/`([^`]*task-result-payload\\.json)`/) || [])[1];",
    "  const writeDraft = (verdict) => { mkdirSync(path.dirname(draftPath), { recursive: true }); writeFileSync(draftPath, JSON.stringify({ verdict, summary: 'stub draft', sections: { Evidence: 'stub evidence' }, scope_actual: { read: [], written: [] }, evidence_refs: [] }), 'utf8'); };",
    // draft_then_loop:交卷文件写好后发不出交卷调用，连串空转命令直到熔断。
    "  if (mode === 'draft_then_loop' && draftPath) { writeDraft('done'); for (const word of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) toolCall('tc-draft-noop-' + word, 'bash', { command: 'echo ' + word }); return; }",
    // draft_invalid_then_fix:首轮 verdict 写成聊天词表后正常结束，修正轮改成闭集取值。
    "  if (mode === 'draft_invalid_then_fix' && draftPath) writeDraft(promptCount === 1 ? 'completed' : 'done');",
    "  if (mode === 'draft_written' && draftPath) writeDraft('done');",
    // review_submitted_brief:像 submit_review_result 扩展一样落审查结果,最终回复只有一句话。
    "  if (mode === 'review_submitted_brief' && process.env.PI_REVIEW_RESULT_PATH) { toolCall('tc-review', 'submit_review_result', {}); writeFileSync(process.env.PI_REVIEW_RESULT_PATH, JSON.stringify({ schema_version: 1, gate: 'pass', summary: 'stub review', findings: [], evidence_gaps: [], scope: { reviewed: ['target.py'], not_reviewed: [], actual_reads: ['target.py'] }, output: {} }), 'utf8'); }",
    "  if (mode === 'tool_loop') echoCalls(1, 20);",
    "  if (mode === 'tool_loop_repeat') { for (let i = 1; i <= 20; i += 1) toolCall('tc-poll-' + i, 'read', { path: 'status.json' }); }",
    "  if (mode === 'tool_loop_alternate') { for (let i = 1; i <= 10; i += 1) { toolCall('tc-a-' + i, 'bash', { command: 'git status' }); toolCall('tc-b-' + i, 'read', { path: 'stub.txt' }); } }",
    "  if (mode === 'tool_loop_reset') { sameCalls(19); toolCall('tc-break-1', 'read', { path: 'stub.txt' }); toolCall('tc-break-2', 'read', { path: 'other.txt' }); }",
    // 不在调用后停住：熔断照样由 runner 判定；未熔断的变体（如求值表达式）能正常收尾。
    "  if (mode === 'tool_loop_noop') { for (const word of ['stop', 'final-submit', 'please', 'x1', 'x2', 'x3', 'x4', 'x5']) toolCall('tc-noop-' + word, 'bash', { command: 'echo ' + word }); }",
    "  if (mode === 'tool_loop_ps_read') { for (let i = 1; i <= 8; i += 1) toolCall('tc-ps-' + i, 'powershell', { command: 'Write-Output (Get-Content page-' + i + '.txt)' }); }",
    "  if (mode === 'tool_loop_noop_exit') { for (let i = 0; i < 8; i += 1) toolCall('tc-exit-' + i, 'powershell', { command: 'exit 0' }); return; }",
    "  if (mode === 'tool_loop_noop_short') { for (const word of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) toolCall('tc-noop-' + word, 'bash', { command: 'echo ' + word }); toolCall('tc-real', 'bash', { command: 'git status' }); }",
    "  if (mode === 'tool_loop_numbered_files') { for (let i = 1; i <= 20; i += 1) toolCall('tc-cat-' + i, 'bash', { command: 'cat file' + i + '.txt' }); }",
    "  if (mode === 'tool_loop_read_pages') { for (let i = 0; i < 20; i += 1) toolCall('tc-page-' + i, 'read', { path: 'big.txt', offset: i * 200 + 1, limit: 200 }); }",
    "  if (noSettle) { return; }",
    "  if (mode === 'bash_error') {",
    "    out({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'stub failure' } });",
    "    out({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', result: { output: 'stub bash failed' }, isError: true });",
    "  } else if (mode === 'bash_exit_nonzero') {",
    "    out({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'grep -r nomatch .' } });",
    "    out({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', result: { content: [{ type: 'text', text: '(no output)\\n\\nCommand exited with code 1' }], details: {} }, isError: true });",
    "  } else if (mode === 'write_domain_blocked') {",
    "    const spec = JSON.parse(process.env.PI_WRITE_DOMAIN || '{}');",
    "    const record = { schema_version: 1, kind: 'tool_call', profile: 'pi-child-write-domain/v1', at: new Date().toISOString(), task_id: spec.taskId || null, tool_call_id: 'tc-write', tool: 'write', raw_path: 'README.md', resolved_path: path.join(process.cwd(), 'README.md'), allowed: false, matched: null };",
    "    appendFileSync(spec.log, JSON.stringify(record) + '\\n', 'utf8');",
    "    out({ type: 'tool_execution_start', toolCallId: 'tc-write', toolName: 'write', args: { path: 'README.md', content: 'blocked' } });",
    "    out({ type: 'tool_execution_end', toolCallId: 'tc-write', toolName: 'write', result: { output: 'write domain violation' }, isError: true });",
    "  } else {",
    "    out({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'read', args: { path: 'stub.txt' } });",
    "    out({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'read', result: { output: 'stub' }, isError: false });",
    "  }",
    "  if (kind === 'abort_error' || kind === 'error_empty') {",
    "    const message = abortedMessage(kind === 'abort_error' ? 'This operation was aborted' : 'stub provider error');",
    "    out({ type: 'message_start', message: { role: 'assistant', content: [], api: 'stub-api', provider: currentModel.provider, model: currentModel.id, usage, stopReason: 'pending', timestamp: Date.now() } });",
    "    out({ type: 'message_end', message });",
    "    out({ type: 'turn_end', message, toolResults: [] });",
    "    out({ type: 'agent_end', messages: [message], willRetry: false });",
    "    emitSettled();",
    "    if (kind === 'abort_error') { emitCompactionCycle(mode === 'compaction_midrun'); }",
    "    return;",
    "  }",
    "  out({ type: 'message_start', message: { role: 'assistant', content: [], api: 'stub-api', provider: currentModel.provider, model: currentModel.id, usage, stopReason: 'pending', timestamp: Date.now() } });",
    "  out({ type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'text_delta', delta: 'stub' }, usage });",
    "  out({ type: 'message_end', message: assistantMessage() });",
    "  out({ type: 'turn_end', message: assistantMessage(), toolResults: [] });",
    "  out({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });",
    "  emitSettled();",
    "}",
    "function handle(cmd) {",
    "  const id = cmd.id;",
    "  if (process.env.PI_STUB_COMMANDS_OUT) { appendFileSync(process.env.PI_STUB_COMMANDS_OUT, cmd.type + '\\n', 'utf8'); }",
    "  switch (cmd.type) {",
    "    case 'get_state': {",
    "      if (promptCount === 0) return ok(id, 'get_state', state());",
    "      stateProbes += 1;",
    // 回合后的 get_state 探测:三个竞态/失败场景(sol 审查 F2/F3/F4 的回归)。
    "      if (mode === 'state_probe_fail') return out({ id, type: 'response', command: 'get_state', success: false, error: 'post-settle state failed' });",
    // 将新活动放在探测回复前；反序会把回复后的活动误当作窗口内活动，结果依赖 stdout 分块。
    "      if (mode === 'idle_then_restart' && stateProbes === 1) { emitRun('normal'); return ok(id, 'get_state', state()); }",
    "      if (mode === 'compacting_state_then_end' && stateProbes === 1) { ok(id, 'get_state', { ...state(), isCompacting: true }); out({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'stub', tokensBefore: 10, estimatedTokensAfter: 1 } }); return undefined; }",
    "      return ok(id, 'get_state', state());",
    "    }",
    "    case 'get_available_models': return ok(id, 'get_available_models', { models: catalog });",
    "    case 'get_available_thinking_levels': return ok(id, 'get_available_thinking_levels', { levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] });",
    "    case 'set_auto_compaction': persistSetting('compaction', cmd.enabled); return ok(id, 'set_auto_compaction');",
    "    case 'set_auto_retry': persistSetting('retry', cmd.enabled); return ok(id, 'set_auto_retry');",
    "    case 'set_model': {",
    "      const found = catalog.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);",
    "      if (!found) { return out({ id, type: 'response', command: 'set_model', success: false, error: 'Model not found: ' + cmd.provider + '/' + cmd.modelId }); }",
    // identity_mismatch:set_model 报 success 但状态纹丝不动,回读仍是 other-provider/other-model。
    "      if (!mismatch) { currentModel = { id: found.id, provider: found.provider }; }",
    "      return ok(id, 'set_model', found);",
    "    }",
    // thinking_clamp:set_thinking_level 报 success 但被 pi 按模型能力夹回 high。
    "    case 'set_thinking_level': { if (!mismatch && !thinkingClamp) { currentThinking = cmd.level; } return ok(id, 'set_thinking_level'); }",
    "    case 'prompt': {",
    "      ok(id, 'prompt');",
    "      if (mode === 'crash') { setTimeout(() => process.exit(7), 30); return undefined; }",
    "      promptCount += 1;",
    "      lastPrompt = String(cmd.message || '');",
    "      const kind = compactionMode && promptCount === 1 ? 'abort_error' : mode === 'error_then_idle' && promptCount === 1 ? 'error_empty' : 'normal';",
    "      setTimeout(() => emitRun(kind), 20);",
    "      return undefined;",
    "    }",
    // 首活动超时后才发活动；不提供 usage，验证不能依赖 token 阻止重放。
    "    case 'abort': { if (mode.startsWith('fallback_')) { if (mode === 'fallback_abort_assistant') { out({ type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'text_delta', delta: 'late-before-abort-ack' } }); setTimeout(() => { ok(id, 'abort'); setTimeout(emitSettled, 10); }, 20); return undefined; } ok(id, 'abort'); setTimeout(() => { if (mode === 'fallback_assistant') out({ type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'text_delta', delta: 'late' } }); if (mode === 'fallback_tool') out({ type: 'tool_execution_start', toolCallId: 'late-tool', toolName: 'read', args: { path: 'stub.txt' } }); emitSettled(); }, 10); return undefined; } ok(id, 'abort'); if (streaming) setTimeout(() => { if (mode === 'cancel_bash') { if (process.env.PI_STUB_BASH_CLEANUP_PATH) appendFileSync(process.env.PI_STUB_BASH_CLEANUP_PATH, JSON.stringify({ tool_call_id: 'tc-cancel', confirmed: true, observed: true, tracked_pids: [] }) + '\\n', 'utf8'); out({ type: 'tool_execution_end', toolCallId: 'tc-cancel', toolName: 'bash', result: { output: 'aborted' }, isError: true }); } const message = abortedMessage('This operation was aborted'); out({ type: 'message_end', message }); out({ type: 'turn_end', message, toolResults: [] }); out({ type: 'agent_end', messages: [message], willRetry: false }); emitSettled(); }, 10); return undefined; }",
    "    case 'switch_session': return ok(id, 'switch_session', { cancelled: false });",
    "    case 'get_last_assistant_text': {",
    "      if (mode === 'assistant_text_rpc_fail') return out({ id, type: 'response', command: 'get_last_assistant_text', success: false, error: 'stub rpc fail' });",
    "      if ((mode === 'error_then_idle' || mode === 'compaction_no_resume') && promptCount === 1) return ok(id, 'get_last_assistant_text', { text: '' });",
    "      return ok(id, 'get_last_assistant_text', { text: finalText });",
    "    }",
    "    case 'get_session_stats': { const send = () => ok(id, 'get_session_stats', { sessionId: 'stub-session-id', userMessages: 1, assistantMessages: 1, toolCalls: 1, toolResults: 1, totalMessages: 2, tokens: { input: 123, output: 45, cacheRead: 6, cacheWrite: 7, total: 181 }, cost: 0.3, contextUsage: { tokens: 181, contextWindow: 200000, percent: 0.09 } }); if (mode === 'late_cancel') setTimeout(send, Number(process.env.PI_STUB_STATS_DELAY_MS || 250)); else send(); return undefined; }",
    "    default: return out({ id, type: 'response', command: cmd.type, success: false, error: 'unsupported stub command' });",
    "  }",
    "}",
    "let buf = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  buf += chunk;",
    "  let i;",
    "  while ((i = buf.indexOf('\\n')) >= 0) {",
    "    const line = buf.slice(0, i).replace(/\\r$/, '');",
    "    buf = buf.slice(i + 1);",
    "    if (!line.trim()) { continue; }",
    "    try { handle(JSON.parse(line)); } catch (e) { out({ type: 'response', command: 'parse', success: false, error: String(e && e.message ? e.message : e) }); }",
    "  }",
    "});",
    "process.stdin.on('end', () => { if (mode === 'fallback_shutdown' || mode === 'fallback_shutdown_tool') { out({ type: 'agent_start' }); if (mode === 'fallback_shutdown') out({ type: 'message_end', message: assistantMessage() }); else out({ type: 'tool_execution_start', toolCallId: 'late-tool', toolName: 'read', args: { path: 'stub.txt' } }); setTimeout(() => process.exit(0), 20); return; } if (mode !== 'cancel_ignore_eof') process.exit(0); });",
    "setInterval(() => {}, 1 << 30);",
    "}",
  ].join("\n");
}

function selfTestCheck(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runRunnerForSelfTest(scriptPathForSelf, runnerArgs, env) {
  const childEnv = { ...process.env, ...env };
  // 夹具不得复用外层worker的审计落点；本场景的写域仍由--writeDomainSpec下发。
  delete childEnv.PI_WRITE_DOMAIN;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPathForSelf, ...runnerArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: childEnv,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export async function runSelfTest(scriptPathForSelf) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-runner-selftest-"));
  try {
    const stubPath = path.join(root, "pi-stub.mjs");
    writeFileSync(stubPath, renderPiStubSource(), "utf8");
    const targetCwd = path.join(root, "target");
    ensureDir(targetCwd);
    const taskPath = path.join(root, "task.md");
    ensureDir(path.join(targetCwd, "ops", "agents"));
    writeFileSync(path.join(targetCwd, "ops", "agents", "fixture-agent.toml"), [
      'name = "fixture-agent"',
      "[[picks]]",
      'id = "stub"',
      'model = "stub-provider/stub-model"',
      'effort = "low"',
      'effort_min = "low"',
      'effort_max = "medium"',
      "default = true",
      "",
    ].join("\n"), "utf8");
    writeFileSync(path.join(targetCwd, "ops", "model-notes.toml"), 'version = 1\n[notes."stub-provider/stub-model"]\nefforts = ["low", "medium"]\n', "utf8");
    ensureDir(path.join(targetCwd, "ops", "templates"));
    writeFileSync(path.join(targetCwd, "ops", "templates", "worker-system-prompt.md"), "Self-test protocol fixture; no production task execution.\n", "utf8");
    writeFileSync(path.join(targetCwd, "ops", "templates", "handoff-prompt-template.md"), "Protocol fixture prompt. {{RESULT_SUBMISSION}}\n", "utf8");
    writeFileSync(path.join(targetCwd, "ops", "templates", "worker-resources.json"), JSON.stringify({
      version: 2,
      tools: { read: { access: "optional" }, bash: { access: "optional" }, grep: { access: "default_on" }, command_job: { access: "default_on" },
        dispatch_prepare: { access: "off" } },
      extensions: {},
      skills: {},
      required_tools: ["submit_task_result", "submit_review_result"],
    }), "utf8");
    const fixtureTask = { task_package: { package_id: "fixture-selftest", agent: { role: "fixture-agent", capability: { name: "fixture" } }, expected_output: { mode: "none" } } };
    writeFileSync(taskPath, "输出 PI_STUB_OK 并按标题合同写结论。", "utf8");
    const taskPackagePath = path.join(root, "task-package.json");
    writeFileSync(taskPackagePath, JSON.stringify(fixtureTask), "utf8");

    const scenario = async (name, {
      mode,
      extraArgs = [],
      turnTimeoutMs = null,
      commandsOut = null,
      cancelRequest = null,
      statsDelayMs = 250,
    }) => {
      const outDir = path.join(root, `out-${name}`);
      const argvOut = path.join(root, `argv-${name}.json`);
      const runnerArgs = [
        "--contextMode", "isolated",
        "--targetCwd", targetCwd,
        // Role/model-note fixtures belong to this run, not the production asset root.
        "--runtimeRoot", targetCwd,
        "--childCwd", path.join(root, `child-${name}`),
        "--taskFile", taskPath,
        "--taskPackageFile", taskPackagePath,
        "--model", "stub-provider/stub-model",
        "--effort", "low",
        "--outDir", outDir,
        "--artifactsDir", path.join(outDir, "artifacts"),
        "--controlHome", path.join(root, "control-home"),
        ...(turnTimeoutMs ? ["--turnTimeoutMs", String(turnTimeoutMs)] : []),
        ...extraArgs,
      ];
      let cancelTimer = null;
      let cancelEligibleAt = null;
      if (cancelRequest) {
        cancelTimer = setInterval(() => {
          const eventsPath = path.join(outDir, "child-task-events.jsonl");
          if (cancelRequest.whenCommand) {
            if (!commandsOut || !existsSync(commandsOut) || !readFileSync(commandsOut, "utf8").includes(cancelRequest.whenCommand)) return;
          } else if (!existsSync(eventsPath) || !readFileSync(eventsPath, "utf8").includes('"turn_start"')) return;
          if (cancelEligibleAt === null) cancelEligibleAt = Date.now() + Math.max(0, Number(cancelRequest.delayMs) || 0);
          if (Date.now() < cancelEligibleAt) return;
          writeFileSync(cancelRequest.path, `${JSON.stringify({
            type: "abort",
            attempt_id: cancelRequest.attemptId,
            reason: cancelRequest.reason,
            requested_at: new Date().toISOString(),
          })}\n`, "utf8");
          clearInterval(cancelTimer);
        }, 25);
        cancelTimer.unref();
      }
      const run = await runRunnerForSelfTest(scriptPathForSelf, runnerArgs, {
        PI_CONTROL_PI: stubPath,
        SUBAGENT_CONTROL_REPO_ROOT: targetCwd,
        PI_STUB_MODE: mode,
        PI_STUB_STATS_DELAY_MS: String(statsDelayMs),
        PI_STUB_ARGV_OUT: argvOut,
        // 临时目录建在本次自测根下，不碰真实 scratch。
        PI_CONTROL_BASH_SCRATCH: path.join(root, "bash-scratch"),
        PI_STUB_SCRATCH_OUT: path.join(root, `scratch-${name}.json`),
        ...(cancelRequest ? { PI_STUB_BASH_CLEANUP_PATH: path.join(outDir, `bash-tree-cleanup.${cancelRequest.attemptId}.jsonl`) } : {}),
        ...(commandsOut ? { PI_STUB_COMMANDS_OUT: commandsOut } : {}),
      });
      if (cancelTimer !== null) clearInterval(cancelTimer);
      const resultPath = path.join(outDir, "child-task-result.json");
      selfTestCheck(existsSync(resultPath), `${name}: child-task-result.json 未产出 (stderr: ${run.stderr.slice(0, 400)})`);
      const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
      return { name, run, outDir, argvOut, result: parsed };
    };

    // 1. 正常链路
    const okCase = await scenario("ok", { mode: "ok" });
    const okResult = okCase.result;
    selfTestCheck(okCase.run.code === 0, `ok: runner 退出码应为 0,实得 ${okCase.run.code}; failure_type=${okResult.failure_type}; error=${okResult.error || ""}; stderr=${okCase.run.stderr.slice(0, 400)}`);
    selfTestCheck(okResult.ok === true, `ok: result.ok 应为 true,实得 ${okResult.ok}`);
    selfTestCheck(okResult.session?.resumable === false, "ok: 成功任务不应 resumable");
    selfTestCheck(okResult.status === "completed", `ok: status 应为 completed,实得 ${okResult.status}`);
    selfTestCheck(okResult.failure_type === "none", `ok: failure_type 应为 none,实得 ${okResult.failure_type}`);
    selfTestCheck(okResult.backend === BACKEND && okResult.runner === RUNNER_NAME, "ok: backend/runner 标识错误");
    selfTestCheck(okResult.orchestration.ok === true && okResult.orchestration.status === "completed", "ok: orchestration 段错误");
    selfTestCheck(okResult.task.ok === true, "ok: task 段错误");
    selfTestCheck(okResult.required_headings.ok === true, "ok: 六段标题判定错误");
    selfTestCheck(okResult.selection.appliedModel === "stub-model", `ok: appliedModel 错误 ${okResult.selection.appliedModel}`);
    selfTestCheck(okResult.selection.appliedProvider === "stub-provider", `ok: appliedProvider 错误 ${okResult.selection.appliedProvider}`);
    selfTestCheck(okResult.selection.appliedEffort === "low", `ok: appliedEffort 错误 ${okResult.selection.appliedEffort}`);
    selfTestCheck(okResult.selection.validated === true, "ok: selection.validated 应为 true");
    selfTestCheck(okResult.identity.verified === true, "ok: identity.verified 应为 true");
    selfTestCheck(okResult.identity.applied?.model === "stub-model", "ok: identity 快照模型错误");
    selfTestCheck(Array.isArray(okResult.turns) && okResult.turns.length >= 1, "ok: turns[] 缺失");
    selfTestCheck(okResult.turns[0].model === "stub-model", `ok: turns[0].model 错误 ${okResult.turns[0].model}`);
    selfTestCheck(okResult.turns[0].provider === "stub-provider", "ok: turns[0].provider 错误");
    selfTestCheck(okResult.permission.tool_allowlist === null, "ok: 缺省任务不应裁剪工具");
    selfTestCheck(okResult.runtime?.exitCode === 0, `ok: pi 退出码应为 0,实得 ${okResult.runtime?.exitCode}`);
    const finalDoc = readFileSync(path.join(okCase.outDir, "child-final.md"), "utf8");
    selfTestCheck(finalDoc.includes("## 结论") && finalDoc.includes("## 边界"), "ok: child-final.md 六段缺失");
    const liveSnapshot = JSON.parse(readFileSync(path.join(okCase.outDir, "child-task-live.json"), "utf8"));
    selfTestCheck(liveSnapshot.phase === "finished" && liveSnapshot.status === "completed", "ok: live 终态错误");
    selfTestCheck(liveSnapshot.backend === BACKEND, "ok: live.backend 错误");
    selfTestCheck(
      existsSync(path.join(okCase.outDir, "pi-session", "stub-session.jsonl")),
      "ok: --session-dir 未生效,pi-session 下没有会话 jsonl",
    );
    selfTestCheck(existsSync(path.join(okCase.outDir, "child-handoff.md")), "ok: child-handoff.md 未产出");
    const identityDoc = JSON.parse(readFileSync(path.join(okCase.outDir, "child-task-identity.json"), "utf8"));
    selfTestCheck(identityDoc.turn_receipts.length >= 1, "ok: 身份快照缺少逐轮回执");
    selfTestCheck(identityDoc.available_models.matched === true, "ok: 身份快照模型目录命中标记错误");
    const stubArgv = JSON.parse(readFileSync(okCase.argvOut, "utf8"));
    const workerPromptFlagIndex = stubArgv.indexOf("--append-system-prompt");
    const workerPromptPath = stubArgv[workerPromptFlagIndex + 1];
    const workerPromptBase = readFileSync(path.join(targetCwd, "ops", "templates", "worker-system-prompt.md"), "utf8").trimEnd();
    selfTestCheck(
      workerPromptFlagIndex >= 0
        && path.resolve(workerPromptPath) === path.resolve(okCase.outDir, "worker-system.md")
        && readFileSync(workerPromptPath, "utf8").startsWith(workerPromptBase),
      `ok: worker system 追加层应为任务目录的 worker-system.md 且以通用规则开头 ${workerPromptPath}`,
    );
    selfTestCheck(okResult.context?.globalAppendSystemSuppressed === true, "ok: child 未回显全局 APPEND 抑制状态");
    selfTestCheck(!stubArgv.includes("-t") && !stubArgv.includes("--no-tools"), "ok: 缺省任务不应传工具白名单");
    selfTestCheck(okResult.selection?.effort_check?.source === "model_notes", "ok: 无冻结选型时按模型档位校验 effort");

    // 快速模式只按任务包启用，不向 pi 传扩展自定义布尔 flag。
    selfTestCheck(okResult.selection.fast === undefined, "ok: 默认任务不应启用 fast");
    selfTestCheck(!stubArgv.some(value => /pi_fast_mode(?:\.bundle)?\.mjs$/.test(value)), "ok: 默认任务不加载 fast 扩展");
    const fastPackagePath = path.join(root, "task-package-fast.json");
    writeFileSync(fastPackagePath, JSON.stringify({ task_package: {
      ...fixtureTask.task_package, runtime_context: { fast: true },
    } }), "utf8");
    const fastCase = await scenario("fast", { mode: "ok", extraArgs: ["--taskPackageFile", fastPackagePath] });
    selfTestCheck(fastCase.run.code === 0 && fastCase.result.selection.fast === true, "fast: 快速任务应完成且记入 selection");
    const fastExtension = fastCase.result.selection.extensions.find(value => /pi_fast_mode(?:\.bundle)?\.mjs$/.test(value));
    const fastArgv = JSON.parse(readFileSync(fastCase.argvOut, "utf8"));
    selfTestCheck(Boolean(fastExtension) && existsSync(fastExtension) && fastArgv.includes(fastExtension), "fast: 同目录扩展应进 pi -e");
    selfTestCheck(!fastArgv.includes("--fast"), "fast: 不传扩展布尔 flag");

    // 档位：不在模型可选档位内直接拒发；冻结选型越出行范围且没有 effort_range 授权时拒发，有授权时放行。
    const outsideModel = await scenario("effort-outside-model", { mode: "ok", extraArgs: ["--effort", "high"] });
    selfTestCheck(outsideModel.result.failure_type === "invalid_model_effort", `effort_outside_model: 实得 ${outsideModel.result.failure_type}`);
    // 笔记允许 low、Pi 目录不支持 low：握手取目录后按交集拒发，不发送任务。
    const piUnsupportedCommands = path.join(root, "pi-level-unsupported.commands");
    const piUnsupported = await scenario("pi-level-unsupported", { mode: "pi_level_unsupported", commandsOut: piUnsupportedCommands });
    selfTestCheck(piUnsupported.result.failure_type === "invalid_model_effort" && /Pi 会改按 medium 运行/.test(piUnsupported.result.error || ""),
      `pi_level_unsupported: 实得 ${piUnsupported.result.failure_type} ${piUnsupported.result.error}`);
    selfTestCheck(!readFileSync(piUnsupportedCommands, "utf8").split("\n").includes("prompt"), "pi_level_unsupported: 不得发送 prompt");
    const frozen = (applied) => {
      const file = path.join(root, `selection-${applied.length}.json`);
      writeFileSync(file, JSON.stringify({
        requested: { pick: "stub", model: null, effort: "low" }, role: "fixture-agent", capability: "fixture", pick: "stub",
        config_source: {}, resolved_model: "stub-provider/stub-model", resolved_effort: "low", effort_source: "explicit",
        efforts: ["low", "medium"], effort_range: ["medium", "medium"],
        authorization: applied.length ? { quote: "自测", requested_overrides: applied, applied_overrides: applied.map((kind) => ({ kind, previous_value: ["medium", "medium"] })) } : null,
      }), "utf8");
      return file;
    };
    const frozenDenied = await scenario("frozen-range-denied", { mode: "ok", extraArgs: ["--selectionFile", frozen([])] });
    selfTestCheck(frozenDenied.result.failure_type === "invalid_model_effort", `frozen_range_denied: 实得 ${frozenDenied.result.failure_type}`);
    const frozenGranted = await scenario("frozen-range-granted", { mode: "ok", extraArgs: ["--selectionFile", frozen(["effort_range"])] });
    selfTestCheck(frozenGranted.result.ok === true && frozenGranted.result.selection?.effort_check?.source === "frozen_selection",
      `frozen_range_granted: 实得 ${frozenGranted.result.failure_type}`);

    // 工具面：任务包里的清单就是最终工具面（default_on 由编译器并入角色选择），off 进 -xt，不开放或未记录的项只告警。
    const toolTask = (allowed) => {
      const file = path.join(root, `task-package-tools-${allowed.length}.json`);
      writeFileSync(file, JSON.stringify({ task_package: { ...fixtureTask.task_package, tool_contract: { allowed } } }), "utf8");
      return file;
    };
    const surfaced = await scenario("tool-surface", { mode: "ok", extraArgs: ["--taskPackageFile", toolTask(["read", "bash", "dispatch_prepare", "web_search"])] });
    const surfacedArgv = JSON.parse(readFileSync(surfaced.argvOut, "utf8"));
    selfTestCheck(surfacedArgv[surfacedArgv.indexOf("-t") + 1] === "read,bash", `tool_surface: -t 实得 ${surfacedArgv[surfacedArgv.indexOf("-t") + 1]}`);
    selfTestCheck(surfacedArgv[surfacedArgv.indexOf("-xt") + 1] === "dispatch_prepare", "tool_surface: off 工具应进 -xt");
    selfTestCheck(["dispatch_prepare", "web_search"].every((name) => surfaced.result.warnings.some((item) => String(item).includes(`任务工具 ${name}`))),
      "tool_surface: 不开放或未记录的白名单工具应告警");
    const closed = await scenario("tool-surface-closed", { mode: "ok", extraArgs: ["--taskPackageFile", toolTask([])] });
    const closedArgv = JSON.parse(readFileSync(closed.argvOut, "utf8"));
    selfTestCheck(closedArgv.includes("--no-tools") && !closedArgv.includes("-t"), "tool_surface_closed: 空工具面保持封闭");

    // 已经通过 submit_task_result 交付的任务可以只回简短正文：六节缺失只作观测，
    // 不追加第二轮 prompt、不产生 schema_missing，也不把已完成 session 标成 resumable。
    const briefCommands = path.join(root, "commands-brief-final.txt");
    const briefFinal = await scenario("brief-final", { mode: "brief_final", commandsOut: briefCommands });
    selfTestCheck(briefFinal.run.code === 0 && briefFinal.result.ok === true, `brief_final: 应按完成退出,实得 code=${briefFinal.run.code} ok=${briefFinal.result.ok}`);
    selfTestCheck(briefFinal.result.status === "completed" && briefFinal.result.failure_type === "none", `brief_final: 顶层终态错误 ${briefFinal.result.status}/${briefFinal.result.failure_type}`);
    selfTestCheck(briefFinal.result.orchestration?.ok === true && briefFinal.result.task?.ok === true, "brief_final: 运输与业务投影都应完成");
    selfTestCheck(briefFinal.result.session?.resumable === false, "brief_final: 已完成任务不应显示 resumable");

    // Core 下发的 task-local 写域规格会启用 write/edit 守门；无写调用时审计应完整且合规。
    const writeDomainSpec = path.join(root, "write-domain.json");
    writeFileSync(writeDomainSpec, `${JSON.stringify({
      contract_version: "pi-child-write-domain/v1",
      task_id: "runner-self-test",
      paths: [path.join(targetCwd, "allowed.txt")],
      delete_paths: [],
      case_insensitive: process.platform === "win32",
    })}\n`, "utf8");
    const guarded = await scenario("write-domain", {
      mode: "ok",
      extraArgs: ["--writeDomainSpec", writeDomainSpec],
    });
    selfTestCheck(guarded.result.ok === true, `write_domain: 应完成,实得 ${guarded.result.failure_type}`);
    selfTestCheck(guarded.result.write_domain?.enabled === true, "write_domain: write/edit 工具存在时应启用守门");
    selfTestCheck(guarded.result.write_domain?.audit_complete === true && guarded.result.write_domain?.scope_compliant === true, "write_domain: 零写调用审计应完整合规");
    const loadedWriteDomainExtension = guarded.result.selection?.extensions?.find((item) => /pi_write_domain_extension(?:\.bundle)?\.mjs$/.test(item));
    selfTestCheck(Boolean(loadedWriteDomainExtension) && existsSync(loadedWriteDomainExtension), "write_domain: 同目录独立扩展缺失");
    const guardedArgv = JSON.parse(readFileSync(guarded.argvOut, "utf8"));
    selfTestCheck(guardedArgv.includes(loadedWriteDomainExtension), "write_domain: 独立扩展未传给 pi -e");
    if (process.platform === "win32") {
      // 每个任务独享临时目录：首次用到才建、写域可写可删、基底是临时区、收尾连同内容一起清空。
      const fold = (value) => String(value || "").toLowerCase();
      const scratchBase = path.join(root, "bash-scratch");
      const scratchSeen = JSON.parse(readFileSync(path.join(root, "scratch-write-domain.json"), "utf8"));
      selfTestCheck(fold(path.dirname(scratchSeen.scratch)) === fold(scratchBase), `write_domain: 临时目录应建在 scratch 基底下,实得 ${scratchSeen.scratch}`);
      selfTestCheck(scratchSeen.existedAtStart === false, "write_domain: runner 不应预建临时目录，提前退出的任务才不留空目录");
      selfTestCheck((scratchSeen.writeDomain?.roots || []).map(fold).includes(fold(scratchSeen.scratch)), "write_domain: 临时目录应在写域可写根内");
      selfTestCheck((scratchSeen.writeDomain?.transientRoots || []).map(fold).includes(fold(scratchBase)), "write_domain: scratch 基底应是临时区");
      selfTestCheck(fold(scratchSeen.writeDomain?.gitRoot) === fold(targetCwd), "write_domain: gitRoot 应为目标仓");
      selfTestCheck(!existsSync(scratchSeen.scratch), "write_domain: 收尾应清空临时目录");
    }

    const blockedWrite = await scenario("write-domain-blocked", {
      mode: "write_domain_blocked",
      extraArgs: ["--writeDomainSpec", writeDomainSpec],
    });
    selfTestCheck(blockedWrite.result.ok === true && blockedWrite.run.code === 0, "write_domain_blocked: 路径拒绝是审计事实,不应伪装成运输失败");
    selfTestCheck(blockedWrite.result.write_domain?.scope_compliant === false, "write_domain_blocked: scope_compliant 应为 false");
    selfTestCheck(blockedWrite.result.write_domain?.violations?.[0]?.raw_path === "README.md", "write_domain_blocked: 回执应点名越界路径");

    const invalidWriteDomain = await scenario("invalid-write-domain", {
      mode: "ok",
      extraArgs: ["--writeDomainSpec", path.join(root, "missing-write-domain.json")],
    });
    selfTestCheck(invalidWriteDomain.result.ok === false && invalidWriteDomain.result.failure_type === "invalid_write_domain", `invalid_write_domain: 实得 ${invalidWriteDomain.result.failure_type}`);
    const wrongWriteDomainSpec = path.join(root, "wrong-write-domain.json");
    writeFileSync(wrongWriteDomainSpec, `${JSON.stringify({
      contract_version: "async-write-claim/v1",
      task_id: "runner-self-test",
      paths: [path.join(targetCwd, "allowed.txt")],
      delete_paths: [],
      case_insensitive: process.platform === "win32",
    })}\n`, "utf8");
    const wrongWriteDomain = await scenario("wrong-write-domain-contract", {
      mode: "ok",
      extraArgs: ["--writeDomainSpec", wrongWriteDomainSpec],
    });
    selfTestCheck(wrongWriteDomain.result.failure_type === "invalid_write_domain" && wrongWriteDomain.result.error.includes("contract_version"), "invalid_write_domain: 旧 claim 版本不得冒充 direct write domain 版本");

    // 2. 目录 miss 只留诊断，以实际身份决定是否执行。
    const catalogMiss = await scenario("catalog-miss", { mode: "catalog_miss" });
    selfTestCheck(catalogMiss.result.ok === true && catalogMiss.run.code === 0, "catalog_miss: 身份通过后应继续");
    selfTestCheck(catalogMiss.result.identity.verified === true && catalogMiss.result.selection.validated === false, "catalog_miss: 不得把目录 miss 标为命中");
    selfTestCheck(catalogMiss.result.warnings.length > 0, "catalog_miss: 应记录诊断");
    const catalogMismatch = await scenario("catalog-miss-mismatch", { mode: "catalog_miss_mismatch" });
    selfTestCheck(catalogMismatch.result.failure_type === "identity_mismatch" && catalogMismatch.run.code === 1, "catalog_miss: 身份不符仍拒绝");

    // 3. identity_mismatch
    const mismatch = await scenario("identity-mismatch", { mode: "identity_mismatch" });
    selfTestCheck(mismatch.result.failure_type === "identity_mismatch", `identity_mismatch: failure_type 实得 ${mismatch.result.failure_type}`);
    selfTestCheck(mismatch.result.identity?.verified === false, "identity_mismatch: identity.verified 应为 false");
    selfTestCheck(mismatch.result.session?.resumable === false, "identity_mismatch: 不应 resumable");
    selfTestCheck(existsSync(path.join(mismatch.outDir, "child-final.md")), "identity_mismatch: 兜底 child-final.md 缺失");

    // 4. turn 超时(stub 不发 agent_settled)
    const timeout = await scenario("turn-timeout", { mode: "turn_timeout", turnTimeoutMs: 1500 });
    selfTestCheck(timeout.result.failure_type === "turn_timeout", `turn_timeout: failure_type 实得 ${timeout.result.failure_type}`);
    selfTestCheck(timeout.result.turn?.startAck === true, "turn_timeout: prompt ack 应已记录");
    selfTestCheck(existsSync(path.join(timeout.outDir, "child-final.md")), "turn_timeout: 兜底 child-final.md 缺失");

    // 5. 当前 attempt 的外部取消经 RPC abort 正常 settled/idle 后保留真实 session 可续跑。
    const cancelFile = path.join(root, "cancel-request.json");
    const cancelled = await scenario("external-cancel", {
      mode: "turn_timeout",
      extraArgs: ["--controlFile", cancelFile, "--attemptId", "attempt-1"],
      cancelRequest: { path: cancelFile, attemptId: "attempt-1", reason: "operator observed a stalled tool", delayMs: 300 },
    });
    selfTestCheck(cancelled.run.code === 1 && cancelled.result.status === "cancelled", `external_cancel: 顶层应为 cancelled,实得 code=${cancelled.run.code} status=${cancelled.result.status}`);
    selfTestCheck(cancelled.result.cancellation?.graceful === true && cancelled.result.cancellation?.attempt_id === "attempt-1", "external_cancel: 应证明当前 attempt 已优雅收尾");
    selfTestCheck(cancelled.result.session?.resumable === true && existsSync(cancelled.result.session.file), "external_cancel: settled/idle 且存档存在时应可续跑");

    const cancelledBash = await scenario("external-cancel-bash", {
      mode: "cancel_bash",
      extraArgs: ["--controlFile", path.join(root, "cancel-bash.json"), "--attemptId", "attempt-bash"],
      cancelRequest: { path: path.join(root, "cancel-bash.json"), attemptId: "attempt-bash", reason: "stop running command", delayMs: 100 },
    });
    selfTestCheck(cancelledBash.result.cancellation?.graceful === true && cancelledBash.result.session?.resumable === true, "cancel_bash: Bash 中止错误不应在正常 EOF 收尾前强杀 Pi");
    selfTestCheck(cancelledBash.result.cleanup?.steps?.includes("stdin_eof"), "cancel_bash: 应走 EOF 收尾");

    const forcedShutdown = await scenario("external-cancel-ignore-eof", {
      mode: "cancel_ignore_eof",
      extraArgs: ["--controlFile", path.join(root, "cancel-ignore-eof.json"), "--attemptId", "attempt-eof"],
      cancelRequest: { path: path.join(root, "cancel-ignore-eof.json"), attemptId: "attempt-eof", reason: "stop ignored EOF" },
    });
    selfTestCheck(forcedShutdown.result.cancellation?.graceful === false && forcedShutdown.result.session?.resumable === false, "cancel_ignore_eof: 已 settled 但关停升级到 SIGTERM 时不可冒报可续跑");

    const lateCancelPath = path.join(root, "late-cancel.json");
    const lateCancel = await scenario("late-cancel", {
      mode: "late_cancel",
      statsDelayMs: 33000,
      commandsOut: path.join(root, "late-cancel.commands"),
      extraArgs: ["--controlFile", lateCancelPath, "--attemptId", "attempt-late"],
      cancelRequest: { path: lateCancelPath, attemptId: "attempt-late", reason: "late request during stats", whenCommand: "get_session_stats" },
    });
    const lateLive = JSON.parse(readFileSync(path.join(lateCancel.outDir, "child-task-live.json"), "utf8"));
    selfTestCheck(lateLive.attempt_id === "attempt-late" && lateLive.turn_completed === true, "late_cancel: 完成边界未绑定当前 attempt");
    selfTestCheck(existsSync(lateCancelPath), "late_cancel: 未注入统计窗口取消请求");
    selfTestCheck(lateCancel.result.ok === true && lateCancel.result.cancellation?.requested !== true, "late_cancel: 已完成回合不能被收割阶段迟到取消覆盖");

    // 6. 意外退出
    const crash = await scenario("crash", { mode: "crash" });
    selfTestCheck(crash.result.failure_type === "transport_failed", `crash: failure_type 实得 ${crash.result.failure_type}`);
    selfTestCheck(existsSync(path.join(crash.outDir, "child-final.md")), "crash: 兜底 child-final.md 缺失");

    // 7. Bash 工具失败后，Windows 收口必须在 Pi 父进程仍存活时同步整树回收。
    const bashError = await scenario("bash-error", { mode: "bash_error" });
    selfTestCheck(bashError.result.mechanical_signals?.failedBashToolCalls === 1, "bash_error: 未记录失败 Bash 工具");
    if (process.platform === "win32") {
      selfTestCheck(
        bashError.result.cleanup?.steps?.includes("kill"),
        `bash_error: Windows 未走同步整树回收 ${JSON.stringify(bashError.result.cleanup)}`,
      );
    }
    // 命令跑完只是退出码非零（grep 无匹配、测试报红）：进程已正常结束，照常计失败工具，但不整树强杀。
    const bashExit = await scenario("bash-exit-nonzero", { mode: "bash_exit_nonzero" });
    selfTestCheck(bashExit.result.mechanical_signals?.failedBashToolCalls === 1, "bash_exit_nonzero: 失败 Bash 工具计数应保留");
    selfTestCheck(
      !bashExit.result.cleanup?.steps?.includes("kill") && bashExit.result.cleanup?.tree_confirmed === true,
      `bash_exit_nonzero: 正常结束的非零退出不应整树强杀 ${JSON.stringify(bashExit.result.cleanup)}`,
    );

    // stopReason=aborted 只是回执事实:回合按 pi 状态自然结束,正文齐全就照常收割,不判死。
    const aborted = await scenario("aborted", { mode: "aborted" });
    selfTestCheck(aborted.result.ok === true, `aborted: 回执 aborted 不得判死,实得 ok=${aborted.result.ok} failure_type=${aborted.result.failure_type}`);
    selfTestCheck(aborted.result.turns?.[0]?.stopReason === "aborted", "aborted: 回执 stopReason 应原样留在 turns[]");
    selfTestCheck(aborted.result.diagnostics?.stop_reason === "aborted", "aborted: diagnostics.stop_reason 应为 aborted");
    selfTestCheck(Boolean(aborted.result.session?.file) && existsSync(aborted.result.session.file), "aborted: 应留下 session 文件");

    // 压缩插件中途 abort:runner 等 compaction_start/end,插件续跑后再收割;两次 agent_settled 才算回合结束。
    const midrun = await scenario("compaction-midrun", { mode: "compaction_midrun" });
    selfTestCheck(midrun.result.ok === true, `compaction_midrun: 应完成,实得 ok=${midrun.result.ok} failure_type=${midrun.result.failure_type} error=${midrun.result.error}`);
    selfTestCheck(midrun.result.failure_type === "none", `compaction_midrun: failure_type 实得 ${midrun.result.failure_type}`);
    selfTestCheck(midrun.result.turn?.compactions?.length === 1 && midrun.result.turn.compactions[0].ended_at, "compaction_midrun: 应记录一次完整压缩");
    selfTestCheck(midrun.result.turns?.[0]?.stopReason === "error" && /aborted/.test(midrun.result.turns[0].errorMessage || ""), "compaction_midrun: 首条回执应保留 abort 事实");
    selfTestCheck(midrun.result.turns?.[1]?.stopReason === "stop", "compaction_midrun: 续跑回执应为 stop");
    selfTestCheck(midrun.result.turn?.finalTextSource === "message_end", `compaction_midrun: 正文应来自续跑 message_end,实得 ${midrun.result.turn?.finalTextSource}`);

    // 压完无人续:静默窗结束、pi idle,回合结束;正文为空只记事实(无收口轮),运输仍算完成。
    const noResumeCommands = path.join(root, "commands-no-resume.txt");
    const noResume = await scenario("compaction-no-resume", { mode: "compaction_no_resume", commandsOut: noResumeCommands });
    selfTestCheck(noResume.result.orchestration?.ok === true && noResume.result.turn?.completed === true, `compaction_no_resume: 运输应完成,实得 orchestration.ok=${noResume.result.orchestration?.ok}`);
    selfTestCheck(noResume.result.failure_type === "task_status_missing" && noResume.result.ok === false, `compaction_no_resume: 空正文只在业务层记 task_status_missing,实得 ok=${noResume.result.ok} failure_type=${noResume.result.failure_type}`);
    selfTestCheck(noResume.result.turn?.settleCycles === 1, `compaction_no_resume: settleCycles 应为 1,实得 ${noResume.result.turn?.settleCycles}`);
    selfTestCheck(noResume.result.turn?.compactions?.length === 1, "compaction_no_resume: 应记录一次压缩");
    selfTestCheck(noResume.result.turn?.finalTextSource === "empty", `compaction_no_resume: 正文来源应为 empty,实得 ${noResume.result.turn?.finalTextSource}`);
    selfTestCheck(readFileSync(noResumeCommands, "utf8").split(/\r?\n/).filter((line) => line === "prompt").length === 1, "compaction_no_resume: 无正文不得追加收口轮 prompt");
    selfTestCheck(noResume.result.turn?.finalization === undefined, "compaction_no_resume: result.turn 不再有 finalization 段");
    selfTestCheck(noResume.result.warnings.some((line) => line.includes("仅记录观测")), "compaction_no_resume: 缺节应以 warning 记事实");
    selfTestCheck(noResume.result.session?.resumable === true, "compaction_no_resume: 未 ok 收尾且身份核过应可续跑");

    // error 回执后 idle:不判死、不追加收口轮;stopReason 留在回执与 diagnostics,空正文记业务层。
    const errorIdleCommands = path.join(root, "commands-error-idle.txt");
    const errorIdle = await scenario("error-then-idle", { mode: "error_then_idle", commandsOut: errorIdleCommands });
    selfTestCheck(errorIdle.result.orchestration?.ok === true && errorIdle.result.orchestration?.failure_type === "none", `error_then_idle: 运输不得判死,实得 orchestration=${JSON.stringify(errorIdle.result.orchestration)}`);
    selfTestCheck(errorIdle.result.failure_type !== "schema_missing" && errorIdle.result.failure_type !== "provider_error", `error_then_idle: failure_type 实得 ${errorIdle.result.failure_type}`);
    selfTestCheck(errorIdle.result.turns?.[0]?.stopReason === "error", "error_then_idle: 首条回执应保留 error");
    selfTestCheck(errorIdle.result.mechanical_signals?.errorTurns === 1, "error_then_idle: errorTurns 机械信号应为 1");
    selfTestCheck(readFileSync(errorIdleCommands, "utf8").split(/\r?\n/).filter((line) => line === "prompt").length === 1, "error_then_idle: 不得追加收口轮 prompt");

    // sol 审查回归:回合后 get_state 失败不得洗成 idle;静默窗后的新活动不得漏等;
    // pi 自报压缩中而 compaction_end 早于等待注册不得死等;静默窗与探测受预算约束。
    const probeFail = await scenario("state-probe-fail", { mode: "state_probe_fail" });
    selfTestCheck(probeFail.result.ok === false && probeFail.result.failure_type === "transport_failed", `state_probe_fail: get_state 失败应按运输失败上抛,实得 ok=${probeFail.result.ok} failure_type=${probeFail.result.failure_type}`);
    selfTestCheck(/get_state/.test(String(probeFail.result.error || "")), "state_probe_fail: error 应指向 get_state");
    const idleRestart = await scenario("idle-then-restart", { mode: "idle_then_restart" });
    selfTestCheck(idleRestart.result.ok === true && idleRestart.result.turn?.settleCycles === 2, `idle_then_restart: 探测窗口内的新活动应被等到,实得 ok=${idleRestart.result.ok} settleCycles=${idleRestart.result.turn?.settleCycles}`);
    const compactingEnd = await scenario("compacting-state-then-end", { mode: "compacting_state_then_end" });
    selfTestCheck(compactingEnd.result.ok === true && compactingEnd.result.failure_type === "none", `compacting_state_then_end: 已到达的 compaction_end 不得死等,实得 ok=${compactingEnd.result.ok} failure_type=${compactingEnd.result.failure_type}`);
    selfTestCheck(compactingEnd.result.turn?.compactions?.length === 0, "compacting_state_then_end: 无 compaction_start 时不记录压缩条目");
    // 同参数轮询及 A/B 交替仅告警，继续正常交付。
    const toolLoop = await scenario("tool-loop", { mode: "tool_loop_repeat" });
    selfTestCheck(toolLoop.result.ok === true && !toolLoop.result.tool_loop, "tool_loop: 同参数轮询不得强杀");
    selfTestCheck(toolLoop.result.tool_progress_warning?.signatures?.[0]?.count === 20, "tool_loop: 回执应记录告警");
    const toolLoopLive = JSON.parse(readFileSync(path.join(toolLoop.outDir, "child-task-live.json"), "utf8"));
    selfTestCheck(toolLoopLive.tool_progress_warning?.signatures?.[0]?.count === 20, "tool_loop: live 应记录告警");
    const toolLoopEvents = readFileSync(path.join(toolLoop.outDir, "child-task-events.jsonl"), "utf8");
    selfTestCheck(toolLoopEvents.includes('"tool_progress_warning"'), "tool_loop: 事件应记录告警");
    const toolLoopAlternate = await scenario("tool-loop-alternate", { mode: "tool_loop_alternate" });
    selfTestCheck(toolLoopAlternate.result.ok === true && !toolLoopAlternate.result.tool_loop
      && toolLoopAlternate.result.tool_progress_warning?.signatures?.length === 2, "tool_loop_alternate: A/B 交替应继续");
    const toolLoopNoop = await scenario("tool-loop-noop", { mode: "tool_loop_noop" });
    selfTestCheck(toolLoopNoop.result.failure_type === "tool_loop" && toolLoopNoop.result.tool_loop?.kind === "noop_commands"
      && toolLoopNoop.result.tool_loop?.noop_streak === 8 && /连续 8 次空转命令/.test(String(toolLoopNoop.result.error || "")), `tool_loop_noop: 连续 8 次内容各异的空转命令应触发,实得 ${toolLoopNoop.result.failure_type} ${JSON.stringify(toolLoopNoop.result.tool_loop)}`);
    const toolLoopNoopExit = await scenario("tool-loop-noop-exit", { mode: "tool_loop_noop_exit" });
    selfTestCheck(toolLoopNoopExit.result.failure_type === "tool_loop" && toolLoopNoopExit.result.tool_loop?.kind === "noop_commands", `tool_loop_noop_exit: 连续 8 次 PowerShell exit 0 应触发,实得 ${toolLoopNoopExit.result.failure_type}`);
    const toolLoopNoopShort = await scenario("tool-loop-noop-short", { mode: "tool_loop_noop_short" });
    selfTestCheck(toolLoopNoopShort.result.ok === true && toolLoopNoopShort.result.failure_type === "none" && !toolLoopNoopShort.result.tool_loop, `tool_loop_noop_short: 7 次空转后接真实命令不应触发,实得 ${toolLoopNoopShort.result.failure_type}`);
    const toolLoopReset = await scenario("tool-loop-reset", { mode: "tool_loop_reset" });
    selfTestCheck(toolLoopReset.result.ok === true && toolLoopReset.result.failure_type === "none" && !toolLoopReset.result.tool_loop, `tool_loop_reset: 19 次相同后接 2 个不同签名不应触发,实得 ${toolLoopReset.result.failure_type}`);
    const toolLoopPages = await scenario("tool-loop-read-pages", { mode: "tool_loop_read_pages" });
    const toolLoopFiles = await scenario("tool-loop-numbered-files", { mode: "tool_loop_numbered_files" });
    selfTestCheck(toolLoopFiles.result.ok === true && toolLoopFiles.result.failure_type === "none" && !toolLoopFiles.result.tool_loop, `tool_loop_numbered_files: 路径里的数字应保留,实得 ${toolLoopFiles.result.failure_type}`);
    selfTestCheck(toolLoopPages.result.ok === true && toolLoopPages.result.failure_type === "none" && !toolLoopPages.result.tool_loop, `tool_loop_read_pages: 同一文件不同 offset 的分页读不应触发,实得 ${toolLoopPages.result.failure_type}`);
    // 命令里的数字参数是数据选择（--offset 1…20 读不同页），不折成同一签名。
    const toolLoopNumeric = await scenario("tool-loop-numeric-args", { mode: "tool_loop" });
    selfTestCheck(toolLoopNumeric.result.ok === true && toolLoopNumeric.result.failure_type === "none" && !toolLoopNumeric.result.tool_loop, `tool_loop_numeric_args: 只换数字参数的 20 次命令不应触发,实得 ${toolLoopNumeric.result.failure_type} ${JSON.stringify(toolLoopNumeric.result.tool_loop)}`);
    // Write-Output (Get-Content x) 先求值括号里的读取命令，不是空转。
    const toolLoopPsRead = await scenario("tool-loop-ps-read", { mode: "tool_loop_ps_read" });
    selfTestCheck(toolLoopPsRead.result.ok === true && toolLoopPsRead.result.failure_type === "none" && !toolLoopPsRead.result.tool_loop, `tool_loop_ps_read: 8 次子表达式读取不应判空转,实得 ${toolLoopPsRead.result.failure_type} ${JSON.stringify(toolLoopPsRead.result.tool_loop)}`);

    const budget = await scenario("budget-during-grace", { mode: "ok", turnTimeoutMs: 1200 });
    selfTestCheck(budget.result.failure_type === "turn_timeout", `budget_during_grace: 静默窗越过 turn 预算应判 turn_timeout,实得 ${budget.result.failure_type}`);

    const commandsOut = path.join(root, "commands-resume.txt");
    const resumed = await scenario("resume", {
      mode: "ok",
      extraArgs: ["--resumeSession", aborted.result.session.file],
      commandsOut,
    });
    selfTestCheck(resumed.result.ok === true, `resume: result.ok 应为 true,实得 ${resumed.result.ok}`);
    const resumeArgv = JSON.parse(readFileSync(resumed.argvOut, "utf8"));
    selfTestCheck(resumeArgv[resumeArgv.indexOf("--session") + 1] === aborted.result.session.file, "resume: CLI 未直接打开原会话");
    selfTestCheck(resumed.result.session.file === aborted.result.session.file, "resume: 会话文件不一致");
    selfTestCheck(!readFileSync(commandsOut, "utf8").includes("switch_session"), "resume: 不应先创建临时会话再重载扩展");

    const textFail = await scenario("assistant-text-rpc-fail", { mode: "assistant_text_rpc_fail" });
    selfTestCheck(textFail.result.ok === false, "assistant_text_rpc_fail: 不应把 RPC 失败洗成成功空文本");
    selfTestCheck(textFail.result.failure_type !== "none", `assistant_text_rpc_fail: failure_type 实得 ${textFail.result.failure_type}`);

    // 同步写：调用侧随后 process.exit(0)，POSIX 管道下异步 stdout 会被截断。
    writeStdoutSync("PI_RUNNER_SELF_TEST_OK\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === "run-pi-task.selftest.mjs"
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSelfTest(fileURLToPath(new URL("./run-pi-task.mjs", import.meta.url)));
}
