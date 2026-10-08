import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { auditFrames, context, opening, makeHistory, prune, user } from './replay.mjs';
const root = 'C:/Users/67570/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/';
const { streamSimple } = await import(pathToFileURL(root + 'api/openai-codex-responses.js'));
const { cleanupSessionResources } = await import(pathToFileURL(root + 'session-resources.js'));
const { normalizeContext } = await import(pathToFileURL(root + 'utils/transcript.js'));
const model = { id: 'gpt-6-sol', name: 'Codex', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 128000 };
const identity = { sessionId: 'offline-wire', threadId: 'offline-wire', turnId: 'offline-turn', requestKind: 'turn', startedAt: 123456789, installationId: 'offline', windowId: 'offline' };
const frames = [];
const jwt = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-account' } })).toString('base64')}.signature`;
const original = globalThis.WebSocket;
class MockSocket {
  readyState = 1;
  listeners = new Map();
  constructor() { queueMicrotask(() => this.emit('open', {})); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  send(data) {
    const frame = JSON.parse(data);
    frames.push(frame);
    const call = frames.length === 1;
    const item = call ? { type: 'function_call', id: 'call_item', call_id: 'call_offline', name: 'fixed_observation', arguments: '{}', status: 'completed' }
      : { type: 'message', id: `msg_${frames.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK' }] };
    const events = [{ type: 'response.output_item.added', item }, { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: `response_${frames.length}`, status: 'completed', usage: { input_tokens: 13000, output_tokens: 3, total_tokens: 13003, input_tokens_details: { cached_tokens: 0 } } } }];
    queueMicrotask(() => { for (const event of events) this.emit('message', { data: JSON.stringify(event) }); });
  }
  close() { this.readyState = 3; this.emit('close', { code: 1000 }); }
}
const groups = ['warm-tool-call', 'retained-long-tool-result', 'same-turn-unpruned', 'same-turn-pruned', 'same-turn-pruned-continuation', 'new-turn-unpruned'];
async function run(messages, requestIdentity = identity) {
  const result = await streamSimple(model, normalizeContext(context(messages)), { apiKey: jwt, transport: 'websocket', sessionId: identity.sessionId, requestIdentity, maxRetries: 0 }).result();
  assert.notEqual(result.stopReason, 'error', result.errorMessage);
  return result;
}
try {
  globalThis.WebSocket = MockSocket;
  const call = await run(opening);
  const history = makeHistory(call);
  assert(history, 'offline mocked tool call must be real provider-parsed toolCall');
  const retained = await run(history);
  const basis = [...history, retained];
  await run([...basis, user('Continue briefly.', 4)]);
  const pruned = prune(basis);
  const prunedResponse = await run([...pruned, user('Continue briefly.', 4)]);
  await run([...pruned, user('Continue briefly.', 4), prunedResponse, user('Continue further.', 5)]);
  await run([...basis, user('Continue briefly.', 4)], { ...identity, turnId: 'offline-next', startedAt: 123456790 });
  assert.equal(frames.length, 6);
  const audit = auditFrames(frames, groups);
  assert.deepEqual(audit.errors, []);
  assert.equal(frames[0].tools?.[0]?.name, 'fixed_observation');
  assert.deepEqual(frames[2].input.slice(0, 2), frames[3].input.slice(0, 2), 'pre-toolResult input bytes unchanged');
  assert.deepEqual(frames[2].input.slice(3), frames[3].input.slice(3), 'only toolResult changed');
  assert.notDeepEqual(frames[2].input[2], frames[3].input[2]);
  assert.equal(JSON.stringify(frames[2].input[2]).length > 48000, true, 'large independent toolResult');
  assert.equal(audit.rows[3].firstInputDifference, 2, 'first prune difference must be toolResult after opening user and real toolCall');
  assert.equal(audit.rows[3].cacheKeyHash, audit.rows[2].cacheKeyHash);
  assert.equal(audit.rows[3].turnIdHash, audit.rows[2].turnIdHash);
  assert.equal(audit.rows[3].turnStateHash, audit.rows[2].turnStateHash);
  assert.notEqual(audit.rows[5].turnIdHash, audit.rows[3].turnIdHash);
  console.log(JSON.stringify({ outcome: 'PASS', prefixBytes: audit.prefixBytes, prefixHash: audit.prefixHash,
    toolsHash: audit.toolsHash, groups: audit.rows.map(({ group, inputCount, firstInputDifference }) => ({ group, inputCount, firstInputDifference })) }));
} finally { cleanupSessionResources(); globalThis.WebSocket = original; }
