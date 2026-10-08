// Exercise the installed Pi SDK/provider and actual extension lifecycle without network or real auth.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
const root = path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
const verifyWire = process.argv.includes('--wire');
const agentDir = path.resolve(`test-results/cache-replay-20260927/native-seen${verifyWire ? '-wire' : ''}-agent`);
const extensionPath = path.resolve(process.argv[2] ?? 'tmp/context-prune-pause-fix/dist/policy-lab.js');
const legacy = process.argv[3] === 'legacy';
fs.mkdirSync(path.join(agentDir, 'context-prune'), { recursive: true });
fs.writeFileSync(path.join(agentDir, 'context-prune/policy-lab.json'), JSON.stringify({ mode: 'cold-mask', triggerTokens: 100, keepRecentToolTurns: 2, stageSummary: false }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sdk = await import(pathToFileURL(path.join(root, 'dist/index.js')));
const { AuthStorage } = await import(pathToFileURL(path.join(root, 'dist/core/auth-storage.js')));
const { ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime } = sdk;
const jwt = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-seen-test' } })).toString('base64url')}.signature`;
const credentials = AuthStorage.inMemory({ 'openai-codex': { type: 'oauth', access: jwt, refresh: 'unused', expires: Date.now() + 3600000 } });
const realFetch = globalThis.fetch;
const requests = [];
const extensionErrors = [];
globalThis.fetch = async (url, init) => {
  assert(String(url).includes('/codex/responses'), 'Only the mocked provider endpoint is permitted');
  const headers = new Headers(init.headers);
  const bytes = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body) : init.body;
  const payload = JSON.parse(Buffer.from(bytes).toString('utf8'));
  const results = payload.input.filter(i => i.type === 'function_call_output');
  requests.push(results.map(i => ({ id: i.call_id, output: i.output })));
  const events = [
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg_mock', role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', delta: 'OK' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK' }] } },
    { type: 'response.completed', response: { id: `resp_mock_${requests.length}`, status: 'completed', usage: { input_tokens: 1000, output_tokens: 1, total_tokens: 1001, input_tokens_details: { cached_tokens: 0 } } } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
let runtime, models;
try {
  models = await ModelRuntime.create({ credentials, allowModelNetwork: false, refreshOnCreate: false });
  const model = models.getModel('openai-codex', 'gpt-6-sol');
  assert(model);
  const manager = SessionManager.inMemory(agentDir);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  manager.appendMessage({ role: 'user', content: 'Synthetic history', timestamp: 1 });
  for (let i = 0; i < 3; i++) {
    manager.appendMessage({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'toolUse', usage,
      content: [{ type: 'toolCall', id: `call_${i}|fc_${i}`, name: 'read', arguments: { path: `archive${i}` } }] });
    manager.appendMessage({ role: 'toolResult', toolCallId: `call_${i}|fc_${i}`, toolName: 'read', isError: false, timestamp: 1,
      content: [{ type: 'text', text: `archive${i}:${'x'.repeat(800)}` }] });
  }
  const create = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.inMemory({ packages: [], transport: 'sse', compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false });
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: models, settingsManager,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [extensionPath, ...(verifyWire ? [path.resolve('tools/context-prune-bench/payload-cache-diag.ts')] : [])], agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => 'Reply OK.' } });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: 'off', tools: [] })), services, diagnostics: services.diagnostics };
  };
  runtime = await createAgentSessionRuntime(create, { cwd: agentDir, agentDir, sessionManager: manager });
  await runtime.session.bindExtensions({ mode: 'rpc', onError: error => extensionErrors.push(error) });
  assert.equal(manager.getBranch().findLast(e => e.customType === 'context-prune-lab-event')?.data.config.triggerTokens, 100);
  await runtime.session.prompt('Reply OK.');
  assert.equal(requests.length, 1);
  assert.equal(manager.getBranch().filter(e => e.customType === 'context-prune-seen-results').length, legacy ? 0 : 1);
  await runtime.session.reload();
  await runtime.session.prompt('Reply OK again.');
  assert.equal(requests.length, 2);
  assert(!JSON.stringify(requests[0]).includes('[pruned:'));
  assert.equal(JSON.stringify(requests[1][0].output).includes('[pruned:'), !legacy);
  assert(!JSON.stringify(requests[1].slice(1)).includes('[pruned:'));
  assert.equal(extensionErrors.length, 0);
  const record = { pass: true, mockedProviderRequests: requests.length, networkRequests: 0, realCredentialsUsed: false,
    firstRawResults: requests[0].length, afterReloadPruned: legacy ? 0 : 1, recentRawResults: 2,
    toolOutputChars: requests.map(items => items.reduce((n, i) => n + JSON.stringify(i.output).length, 0)),
    acknowledgedIds: manager.getBranch().filter(e => e.customType === 'context-prune-seen-results').flatMap(e => e.data.toolCallIds),
    extensionPath };
  if (verifyWire) {
    const all = fs.readFileSync(path.join(agentDir, 'logs/payload-cache-wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const run = all.findLast(r => r.kind === 'observer_start').run;
    const rows = all.filter(r => r.run === run);
    const prepared = rows.filter(r => r.kind === 'prepared');
    const wire = rows.filter(r => r.kind === 'wire_request');
    const usage = rows.filter(r => r.kind === 'request_usage');
    assert.equal(rows.filter(r => r.kind === 'observer_start').length, 1);
    assert.equal(prepared.length, 2);
    assert.equal(wire.length, 2);
    assert.equal(usage.length, 2);
    assert(wire.every((r, i) => r.requestId === prepared[i].requestId && r.hookInputMatches));
    assert(usage.every((r, i) => r.observedAttempts === 1 && r.lastAttempt === wire[i].attemptId));
    assert.equal(prepared[1].prune.count, 1);
    assert.equal(prepared[1].prune.positions.length, 1);
    record.wire = { requests: wire.length, usages: usage.length, wrapperStarts: 1, linkedPrunePositions: prepared[1].prune.positions };
  }
  fs.writeFileSync(path.join(agentDir, `../${verifyWire ? 'native-wire-verification' : `native-seen-${legacy ? 'legacy' : 'verification'}`}.json`), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
} finally {
  await runtime?.dispose();
  await models?.dispose?.();
  globalThis.fetch = realFetch;
}
