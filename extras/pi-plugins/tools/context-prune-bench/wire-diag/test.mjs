import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { wrapCodexFetch, recordUsage, firstDifference, installCodexWebSocketProbe, classifyError } from './probe.mjs';

const providerFile = 'C:/Users/67570/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js';
const { streamSimple } = await import(pathToFileURL(providerFile));
const { cleanupSessionResources } = await import(pathToFileURL(providerFile.replace('/api/openai-codex-responses.js', '/session-resources.js')));
const model = { id: 'gpt-5.1-codex', name: 'Codex', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 128000 };
const secret = 'SENSITIVE_BODY_9aD38f_and_AUTH_445';
const state = 'SENSITIVE_STATE_bA6F23';
const jwt = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-secret' } })).toString('base64')}.signature`;
const context = { systemPrompt: secret, messages: [{ role: 'user', content: 'hello', timestamp: 1 }] };
const identity = { sessionId: 'session-private', threadId: 'thread-private', turnId: 'turn-private', requestKind: 'turn', startedAt: 123456789, installationId: 'install-private', windowId: 'window-private' };
const events = [
  { type: 'response.output_item.added', item: { type: 'message', id: 'msg_test', role: 'assistant', status: 'in_progress', content: [] } },
  { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
  { type: 'response.output_text.delta', delta: 'Hello' },
  { type: 'response.output_item.done', item: { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello' }] } },
  { type: 'response.completed', response: { id: 'response-secret', status: 'completed', usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 3 } } } },
];
const sse = events.map(e => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\n';
const dir = mkdtempSync(join(tmpdir(), 'wire-diag-'));
const file = join(dir, 'redacted.jsonl');
const digest = b => createHash('sha256').update(b).digest('hex');
async function run(enabled) {
  const captured = [];
  const upstream = async (url, init) => {
    captured.push({ url: String(url), headers: [...new Headers(init.headers)].sort(), bodyHash: digest(init.body), bodyBytes: Buffer.byteLength(init.body) });
    return new Response(sse, { headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': state } });
  };
  const fetch = wrapCodexFetch(upstream, { enabled, logFile: file });
  const results = [];
  for (let i = 0; i < 2; i++) {
    const result = await streamSimple(model, context, { apiKey: jwt, transport: 'sse', fetch, sessionId: 'session-private', requestIdentity: identity, maxRetries: 0 }).result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    results.push(result);
    if (enabled) recordUsage(file, result);
  }
  return { captured, results };
}
try {
  const off = await run(false);
  cleanupSessionResources();
  const on = await run(true);
  assert.deepEqual(on.captured, off.captured, 'probe must not change actual outbound url, headers or body bytes');
  const lines = readFileSync(file, 'utf8');
  for (const value of [secret, state, jwt, 'response-secret', 'session-private', 'turn-private', 'thread-private', 'account-secret']) {
    assert(!lines.includes(value), 'sensitive raw value persisted');
  }
  const rows = lines.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.kind === 'request').length, 2);
  assert.equal(rows.filter(row => row.kind === 'usage').length, 2);
  assert.equal(rows.filter(row => row.kind === 'response').length, 2);
  assert.equal(rows[3].turnState.hash, digest(state).slice(0, 16));
  assert.equal(rows[5].cacheRead, on.results[1].usage.cacheRead);
  assert.equal(firstDifference({ input: [1, 2] }, { input: [1, 3] }), '$.{c96c6d5be8d08a12}[1]');
  assert.deepEqual(classifyError(new Error('WebSocket closed 1006 https://secret.invalid/?token=secret')),
    { category: 'websocket_abnormal_close', code: null, status: null, closeCode: null });
  assert.deepEqual(classifyError(Object.assign(new Error('connect failed'),
    { cause: Object.assign(new Error('connect ECONNREFUSED at https://secret.invalid'), { code: 'ECONNREFUSED' }) })),
  { category: 'connection_refused', code: 'ECONNREFUSED', status: null, closeCode: null });
  cleanupSessionResources();
  const originalWebSocket = globalThis.WebSocket;
  async function wsRun(enabled) {
    const handshakes = [];
    const frames = [];
    const sockets = [];
    const observed = [];
    class MockSocket {
      readyState = 1;
      listeners = new Map();
      constructor(url, options) {
        handshakes.push({ url, options });
        sockets.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }
      addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
      removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
      emit(type, event) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
      send(data) {
        frames.push({ socket: sockets.indexOf(this), data });
        queueMicrotask(() => { for (const event of events) this.emit('message', { data: JSON.stringify(event) }); });
      }
      close() { this.readyState = 3; this.emit('close', { code: 1000 }); }
    }
    globalThis.WebSocket = MockSocket;
    const stop = installCodexWebSocketProbe({ enabled, logFile: file,
      onEvent: ({ connectionId, payload }) => observed.push({ connectionId, type: payload.type, usage: payload.response?.usage }) });
    const results = [];
    try {
      for (let i = 0; i < 2; i++) {
        const result = await streamSimple(model, context, { apiKey: jwt, transport: 'websocket-cached', sessionId: 'session-ws-private', requestIdentity: identity, maxRetries: 0 }).result();
        assert.equal(result.stopReason, 'stop', result.errorMessage);
        results.push(result);
      }
      return { handshakes, frames, sockets: sockets.length, results, observed };
    } finally { cleanupSessionResources(); stop(); globalThis.WebSocket = originalWebSocket; }
  }
  const wsOff = await wsRun(false);
  const wsOn = await wsRun(true);
  assert.deepEqual(wsOn.handshakes, wsOff.handshakes);
  assert.deepEqual(wsOn.frames, wsOff.frames);
  assert.equal(wsOn.sockets, wsOff.sockets);
  assert.equal(wsOn.sockets, 1, 'both requests must reuse one actual socket');
  assert.equal(wsOff.observed.length, 0);
  const completed = wsOn.observed.filter(e => e.type === 'response.completed');
  assert.equal(completed.length, 2, 'response observer must see both completed responses');
  completed.forEach((e, i) => {
    assert.equal(e.connectionId, 1);
    assert.equal(e.usage.input_tokens, wsOn.results[i].usage.input + wsOn.results[i].usage.cacheRead);
    assert.equal(e.usage.output_tokens, wsOn.results[i].usage.output);
  });
  assert.deepEqual(wsOn.frames.map(f => Boolean(JSON.parse(f.data).previous_response_id)),
    wsOff.frames.map(f => Boolean(JSON.parse(f.data).previous_response_id)), 'continuation semantics unchanged');
  const wsRows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(wsRows.filter(row => row.kind === 'handshake').length, wsOn.sockets);
  assert.equal(wsRows.filter(row => row.kind === 'frame').length, 2);
  for (const value of [secret, state, jwt, 'response-secret', 'session-private', 'turn-private', 'thread-private', 'account-secret']) {
    assert(!readFileSync(file, 'utf8').includes(value), 'WS secret persisted');
  }
  console.log(JSON.stringify({ outcome: 'PASS', sseRequests: 2, wsRequests: 2, equalHandshakeAndFrames: true, equalConnections: true, sensitiveValuesAbsent: true, wsConnections: wsOn.sockets, wsPreviousResponse: wsOn.frames.map(f => Boolean(JSON.parse(f.data).previous_response_id)) }));
} finally { rmSync(dir, { recursive: true, force: true }); }
