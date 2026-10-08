// One isolated Sol batch; --offline never contacts the provider. No prewarm calls.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { installCodexWebSocketProbe, classifyError } from '../wire-diag/probe.mjs';
import { EffectiveChain } from './effective.mjs';
import { choose, productionChoice } from './candidate.mjs';
const sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const dir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const offline = process.argv.includes('--offline');
const labelIndex = process.argv.indexOf('--label');
const label = labelIndex >= 0 ? process.argv[labelIndex + 1] : null;
assert(offline || /^[a-zA-Z0-9_-]+$/.test(label ?? ''), 'Unique --label required');
const output = label ? path.join(dir, `${label}.jsonl`) : null;
if (!offline) assert(!fs.existsSync(output), 'Refusing to overwrite a batch');
const log = row => { if (output) fs.appendFileSync(output, JSON.stringify(row) + '\n'); };
const root = path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
const ai = path.join(root, 'node_modules/@earendil-works/pi-ai/dist');
const { configureHttpDispatcher } = await import(pathToFileURL(path.join(root, 'dist/core/http-dispatcher.js')));
const { ModelRuntime } = await import(pathToFileURL(path.join(root, 'dist/core/model-runtime.js')));
const { ReadOnlyAuthStorage } = await import(pathToFileURL(path.join(root, 'dist/core/auth-storage.js')));
const { streamSimple } = await import(pathToFileURL(path.join(ai, 'api/openai-codex-responses.js')));
const { normalizeContext } = await import(pathToFileURL(path.join(ai, 'utils/transcript.js')));
const { convertResponsesMessages } = await import(pathToFileURL(path.join(ai, 'api/openai-responses-shared.js')));
const { cleanupSessionResources } = await import(pathToFileURL(path.join(ai, 'session-resources.js')));
const modelId = 'gpt-6-sol';
const tool = { name: 'fixed_observation', description: 'Historical deterministic tool result, no execution.', parameters: { type: 'object', properties: {} } };
const words = 'amber birch cedar delta elm field glass hill iris jade lake maple north oak pine quartz river stone'.split(' ');
function material(i) { return Array.from({ length: 1100 }, (_, j) => `record ${i}-${j}: ${words[(i * 7 + j) % words.length]} ${words[(j * 11 + i) % words.length]} status verified`).join('\n'); }
const values = Array.from({ length: 7 }, (_, i) => 4200 + 137 * i);
const results = values.map((v, i) => `ledger-${i} checksum=${v}\n${material(i)}`);
const question = i => i === 0 ? 'How many ledger entries have been observed so far? Reply with 0 alone.' :
  i < 7 ? `What is the checksum of ledger-${i - 1}? Reply with the decimal number alone.` :
  'What is the checksum of ledger-0? Reply with the decimal number alone.';
const answer = i => i === 0 ? '0' : String(values[i < 7 ? i - 1 : 0]);
function round(i) {
  const id = `call_replay_${i}`;
  return [
    { role: 'assistant', api: 'openai-codex-responses', provider: 'openai-codex', model: modelId,
      content: [{ type: 'toolCall', id, name: tool.name, arguments: {} }], stopReason: 'toolUse', timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } },
    { role: 'toolResult', toolCallId: id, toolName: tool.name, content: [{ type: 'text', text: results[i] }], isError: false, timestamp: 1 },
  ];
}
function prune(messages, ids) { return messages.map(m => m.role === 'toolResult' && ids.has(m.toolCallId) ?
  { ...m, content: [{ type: 'text', text: `[pruned:${m.toolCallId}]` }] } : m); }
const initial = Array.from({ length: 1600 }, (_, i) => `stable rule ${i}: observe ${words[i % words.length]} and preserve ledger evidence`).join('\n');
const arms = ['none', 'production', 'boundary'];
function plan(messages, arm, successfulInputs, seenIds, releasedIds, model) {
  const branch = messages.flatMap((message, i) => message.role === 'assistant' || message.role === 'toolResult' ?
    [{ type: 'message', message, timestamp: i + 1 }] : []);
  const visibleIds = new Set(messages.filter(m => m.role === 'toolResult').map(m => m.toolCallId));
  const context = { systemPrompt: initial, tools: [tool], messages };
  const input = convertResponsesMessages(model, normalizeContext(context), new Set(['openai-codex']), { includeSystemPrompt: false });
  const settings = { model: modelId, system: sha(initial), tools: sha([tool]), reasoning: 'none' };
  const args = { input: { input, settings }, successfulInputs, branch, seenIds, visibleIds, releasedIds };
  const decision = arm === 'none' ? { reason: 'disabled', selected: [] } : arm === 'production' ?
    { reason: 'production', selected: productionChoice(args) } : choose(args);
  const ids = new Set(decision.selected);
  const edited = prune(messages, ids);
  return { decision, ids, edited, settings, input };
}
// Offline contract check precedes any auth or network request.
const mockModel = { id: modelId, api: 'openai-codex-responses', provider: 'openai-codex', input: ['text'], reasoning: false };
for (const arm of arms) {
  let messages = [{ role: 'user', content: 'Ledger begins.', timestamp: 1 }], seen = new Set(), released = new Set();
  const successes = [];
  let cuts = 0;
  for (let i = 0; i < 8; i++) {
    if (i) { messages.push(...round(i - 1)); seen.add(`call_replay_${i - 1}`); }
    messages.push({ role: 'user', content: question(i), timestamp: i + 2 });
    const p = plan(messages, arm, successes, seen, released, mockModel);
    if (p.ids.size) cuts++;
    for (const id of p.ids) released.add(id);
    messages = p.edited;
    const sent = convertResponsesMessages(mockModel, normalizeContext({ systemPrompt: initial, tools: [tool], messages: p.edited }),
      new Set(['openai-codex']), { includeSystemPrompt: false });
    successes.push({ input: sent, settings: p.settings });
    messages.push({ role: 'assistant', api: 'openai-codex-responses', provider: 'openai-codex', model: modelId,
      content: [{ type: 'text', text: answer(i) }], stopReason: 'stop', timestamp: i + 2 });
  }
  assert(arm === 'none' || cuts > 0, `No offline release in ${arm}`);
  console.log(JSON.stringify({ mode: 'offline', arm, cuts, requests: 8 }));
}
if (offline) process.exit(0);
configureHttpDispatcher();
const runtime = await ModelRuntime.create({ credentials: new ReadOnlyAuthStorage(), refreshOnCreate: false, allowModelNetwork: false });
const model = runtime.getModel('openai-codex', modelId);
assert(model?.id === modelId, 'Model mismatch');
let stop = () => {};
let count = 0;
log({ kind: 'manifest', model: `openai-codex/${modelId}`, arms, order: arms, maxRequests: 24,
  initialCache: 'per-arm first response measured, no artificial cold reruns', noPrewarm: true,
  providerSha: sha(fs.readFileSync(path.join(ai, 'api/openai-codex-responses.js'))) });
try {
  for (const arm of arms) {
    const nonce = randomUUID();
    const identity = { sessionId: nonce, threadId: nonce, turnId: `${nonce}-turn`, requestKind: 'turn',
      startedAt: Date.now(), installationId: 'boundary-replay', windowId: 'boundary-replay' };
    const prepared = await runtime.prepareRequest(model, { sessionId: nonce, requestIdentity: identity,
      transport: 'auto', reasoning: 'none', maxRetries: 0 });
    const chain = new EffectiveChain();
    let lastFrame, lastResponse;
    stop = installCodexWebSocketProbe({ logFile: output, onFrame: ({ payload, raw, connectionId }) => {
      lastFrame = { connectionId, wireHash: sha(raw), ...chain.request(payload) };
    }, onEvent: ({ payload }) => {
      const row = chain.response(payload);
      if (row) lastResponse = row;
    } });
    let messages = [{ role: 'user', content: 'Ledger begins.', timestamp: 1 }];
    const seen = new Set(), released = new Set(), successfulInputs = [];
    let stopped = false;
    try {
      for (let i = 0; i < 8; i++) {
        if (i) { messages.push(...round(i - 1)); seen.add(`call_replay_${i - 1}`); }
        messages.push({ role: 'user', content: question(i), timestamp: i + 2 });
        const p = plan(messages, arm, successfulInputs, seen, released, prepared.model);
        const draft = p.edited;
        const started = Date.now();
        lastFrame = lastResponse = null;
        let logical;
        count++;
        assert(count <= 24);
        const result = await streamSimple(prepared.model, normalizeContext({ systemPrompt: initial, tools: [tool], messages: draft }), {
          ...prepared.options, signal: AbortSignal.timeout(120000), onPayload(body) {
            body.tool_choice = 'none'; logical = structuredClone(body); return body;
          },
        }).result();
        const content = result.content.filter(x => x.type === 'text').map(x => x.text).join('').trim();
        const reconstructed = lastFrame?.effectiveHash === sha(logical?.input);
        const success = result.stopReason === 'stop' && !!lastResponse?.success && reconstructed;
        const row = { kind: 'trial', arm, step: i, globalOrder: count, success,
          correct: content === answer(i), expectedHash: sha(answer(i)), answerHash: sha(content),
          releaseCount: p.ids.size, releaseReason: p.decision.reason, boundary: p.decision.boundary ?? null,
          reconstructed, logicalInputHash: sha(logical?.input),
          retainedInputItems: p.input.length - p.ids.size, releasedInputItems: p.ids.size,
          elapsedMs: Date.now() - started, usage: result.usage, frame: lastFrame, response: lastResponse,
          diagnostic: success ? null : classifyError(result.errorMessage) };
        log(row); console.log(JSON.stringify({ arm, step: i, success, correct: row.correct, released: row.releaseCount,
          cacheRead: result.usage?.cacheRead, input: result.usage?.input, ms: row.elapsedMs }));
        if (!success) { stopped = true; break; }
        if (i === 0 && result.usage?.cacheRead !== 0) log({ kind: 'warm-start', arm, cacheRead: result.usage?.cacheRead });
        if (p.ids.size && (result.usage?.input ?? 0) + (result.usage?.cacheRead ?? 0) < 8000) {
          log({ kind: 'insufficient-post-prune-input', arm, step: i }); stopped = true; break;
        }
        for (const id of p.ids) released.add(id);
        messages = draft;
        successfulInputs.push({ input: logical.input, settings: p.settings });
        // Raw response.output and Pi's converted assistant output are separately fingerprinted.
        const converted = convertResponsesMessages(prepared.model, normalizeContext({ messages: [result] }),
          new Set(['openai-codex']), { includeSystemPrompt: false });
        chain.setConvertedOutput(result.responseId, converted);
        messages.push(result);
      }
    } finally { stop(); stop = () => {}; }
    if (stopped) { log({ kind: 'batch-stop', arm, calls: count }); break; }
  }
} catch (error) {
  log({ kind: 'batch-error', calls: count, diagnostic: classifyError(error) });
  throw error;
} finally { stop(); cleanupSessionResources(); await runtime.dispose?.(); }
