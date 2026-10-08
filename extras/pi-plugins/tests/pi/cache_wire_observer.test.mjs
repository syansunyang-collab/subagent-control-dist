import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import fs, { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWireObserver, latestPrune } from '../../tools/context-prune-bench/cache-wire-observer.mjs';

test('diagnostic manager rolls back planned partial installs and normal installs, refusing third-party changes', () => {
  const script = readFileSync(path.resolve('tools/context-prune-bench/manage-cache-diag.mjs'), 'utf8');
  for (const scenario of ['partial', 'normal', 'third-party', 'new-file']) {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-diag-rollback-'));
    const source = path.join(dir, 'tools/context-prune-bench');
    const target = path.join(dir, 'home/.pi/agent/extensions');
    const names = ['payload-cache-diag.ts', 'cache-wire-observer.mjs'];
    try {
      fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(target, { recursive: true });
      fs.mkdirSync(path.join(dir, 'runs/native-pi-runtime-20260813'), { recursive: true });
      for (const name of names) {
        fs.writeFileSync(path.join(source, name), `new-${name}`);
        if (scenario !== 'new-file') fs.writeFileSync(path.join(target, name), `old-${name}`);
      }
      const fakeFs = { ...fs, copyFileSync(from, to) {
        if ((scenario === 'partial' || scenario === 'new-file') && from === path.join(source, names[1])) {
          throw Object.assign(new Error('injected file lock'), { code: 'EPERM' });
        }
        fs.copyFileSync(from, to);
      } };
      const run = action => runInNewContext(script.replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', 'scriptUrl'), {
        fs: fakeFs, path, homedir: () => path.join(dir, 'home'), createHash,
        fileURLToPath: () => path.join(source, 'manage-cache-diag.mjs'), scriptUrl: 'unused',
        process: { argv: ['node', 'manager', action] }, console: { log() {} },
      });
      if (scenario === 'partial' || scenario === 'new-file') assert.throws(() => run('install'), e => e.code === 'EPERM');
      else run('install');
      const record = JSON.parse(fs.readFileSync(path.join(dir, 'runs/native-pi-runtime-20260813/cache-wire-xai-20260928.json')));
      assert(record.files.every(row => row.source && (scenario === 'new-file' ? row.installed === null : row.installed)));
      if (scenario === 'third-party') {
        fs.writeFileSync(path.join(target, names[1]), 'third-party');
        assert.throws(() => run('rollback'));
        assert.equal(fs.readFileSync(path.join(target, names[0]), 'utf8'), `new-${names[0]}`);
        assert.equal(fs.readFileSync(path.join(target, names[1]), 'utf8'), 'third-party');
      } else {
        run('rollback');
        for (const name of names) {
          if (scenario === 'new-file') assert.equal(fs.existsSync(path.join(target, name)), false);
          else assert.equal(fs.readFileSync(path.join(target, name), 'utf8'), `old-${name}`);
        }
        run('rollback');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

const secret = 'private-content-and-credential';
const payload = (key, text = secret) => ({ model: 'model', prompt_cache_key: key, instructions: secret,
  input: [{ type: 'message', role: 'user', content: text }], tools: [{ name: secret }] });
const message = { responseId: secret, stopReason: 'stop', usage: { input: 10, cacheRead: 90, output: 2, cost: { total: .01 } } };

test('SSE preserves compressed bytes, headers and response; concurrent sessions and retries stay separate', async () => {
  const rows = [], calls = [];
  const response = new Response('unchanged stream', { headers: { 'x-codex-turn-state': secret } });
  const host = { fetch: async (...args) => { calls.push(args); return response; } };
  const observer = createWireObserver(row => rows.push(row), host);
  const a = payload('a'), b = payload('b');
  observer.prepare('session-a', a, null);
  observer.prepare('session-b', b, null);
  const initA = { body: zstdCompressSync(JSON.stringify(a)), headers: { authorization: secret, 'content-encoding': 'zstd' } };
  const initB = { body: JSON.stringify(b) };
  assert.equal(await host.fetch('https://example.test/codex/responses', initB), response);
  assert.equal(await host.fetch('https://example.test/codex/responses', initA), response);
  await host.fetch('https://example.test/codex/responses', initA);
  observer.finish('session-b', message);
  observer.finish('session-a', message);
  assert.equal(calls[1][1], initA);
  assert.equal(calls[2][1].body, initA.body);
  assert.equal(await response.text(), 'unchanged stream');
  const prepared = rows.filter(r => r.kind === 'prepared');
  const usages = rows.filter(r => r.kind === 'request_usage');
  assert.equal(usages[0].requestId, prepared[1].requestId);
  assert.equal(usages[1].requestId, prepared[0].requestId);
  assert.deepEqual(usages.map(r => r.observedAttempts), [1, 2]);
  assert(rows.filter(r => r.kind === 'wire_request').every(r => r.hookInputMatches));
  assert(!JSON.stringify(rows).includes(secret));
});

test('xAI Responses records final request options and HTTP result without changing bytes or leaking content', async () => {
  const rows = [], calls = [];
  const response = new Response('unchanged stream', { status: 200, headers: { 'x-request-id': secret } });
  const host = { fetch: async (...args) => { calls.push(args); return response; } };
  const observer = createWireObserver(row => rows.push(row), host);
  const first = { ...payload('xai-session'), model: 'grok-4.7', include: ['reasoning.encrypted_content'],
    reasoning: { effort: 'high' }, max_output_tokens: 4096 };
  observer.prepare('xai-session', first, null, 'xai');
  const headers = { authorization: secret, session_id: 'xai-session', 'x-client-request-id': 'xai-session' };
  const init = { body: JSON.stringify(first), headers };
  assert.equal(await host.fetch('https://api.x.ai/v1/responses', init), response);
  observer.finish('xai-session', message);
  const second = { ...first, max_output_tokens: 2048, input: [...first.input, { type: 'message', role: 'user', content: 'next' }] };
  observer.prepare('xai-session', second, null, 'xai');
  await host.fetch('https://unrelated.test/v1/responses', { body: JSON.stringify(second), headers });
  await host.fetch('https://api.x.ai/v1/responses', { body: JSON.stringify(second), headers });
  observer.finish('xai-session', message);
  const wire = rows.filter(row => row.kind === 'wire_request');
  assert.equal(wire.length, 2);
  assert.deepEqual(wire.map(row => row.maxOutputTokens), [4096, 2048]);
  assert.equal(wire[1].firstDiff, 1);
  assert(wire.every(row => row.route === 'xai' && row.hookInputMatches && row.affinityHeaders.bodyKeyMatchesSession
    && row.encryptedReasoningRequested));
  assert.deepEqual(rows.filter(row => row.kind === 'wire_http_response').map(row => row.status), [200, 200]);
  assert.deepEqual(rows.filter(row => row.kind === 'request_usage').map(row => row.observedAttempts), [1, 1]);
  assert.equal(calls[0][1], init);
  assert.equal(calls[0][1].body, JSON.stringify(first));
  assert.equal(await response.text(), 'unchanged stream');
  assert(!JSON.stringify(rows).includes(secret));
});

test('WS preserves construction and bytes, distinguishes delta and full frames, links numeric raw usage', () => {
  const rows = [], calls = [], constructions = [];
  class Socket {
    listeners = new Map();
    constructor(...args) { constructions.push(args); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    send(...args) { calls.push(args); return 'sent'; }
    receive(event) { this.listeners.get('message')({ data: JSON.stringify(event) }); }
  }
  const host = { WebSocket: Socket };
  const observer = createWireObserver(row => rows.push(row), host);
  const options = { headers: { authorization: secret } };
  const socket = new host.WebSocket('wss://example.test/codex/responses', options);
  assert.equal(constructions[0][1], options);
  const original = payload('a');
  observer.prepare('a', original, null);
  const frame = JSON.stringify({ type: 'response.create', ...original });
  assert.equal(socket.send(frame), 'sent');
  socket.receive({ type: 'response.completed', response: { id: secret, usage: {
    input_tokens: 100, output_tokens: 2, total_tokens: 102, input_tokens_details: { cached_tokens: 90 } }, output: secret } });
  observer.finish('a', message);
  observer.prepare('a', original, null);
  const delta = JSON.stringify({ type: 'response.create', ...original, input: [], previous_response_id: secret });
  socket.send(delta);
  observer.finish('a', message);
  const changed = payload('a', 'changed');
  observer.prepare('a', changed, { id: 'batch', netTokenEstimate: 20 });
  socket.send(JSON.stringify({ type: 'response.create', ...changed }));
  const wire = rows.filter(r => r.kind === 'wire_request');
  assert.deepEqual(wire.map(r => r.inputMode), ['full', 'delta', 'full']);
  assert.equal(wire[1].firstDiff, null);
  assert.equal(wire[1].hookInputMatches, null);
  assert.equal(wire[2].firstDiff, 0);
  assert.deepEqual(wire.map(r => r.connectionId), [1, 1, 1]);
  assert.deepEqual(calls.slice(0, 2), [[frame], [delta]]);
  const reply = rows.find(r => r.kind === 'wire_response');
  assert.equal(reply.attemptId, wire[0].attemptId);
  assert.equal(reply.usage.cachedTokens, 90);
  assert(!JSON.stringify(rows).includes(secret));
});

test('recording failures, unrelated endpoints, invalid bodies and transport failures preserve behavior', async () => {
  const error = new Error(secret);
  let count = 0;
  const host = { fetch: async () => { count++; throw error; } };
  const observer = createWireObserver(() => { throw new Error('disk unavailable'); }, host);
  observer.prepare('a', payload('a'), null);
  for (const url of ['https://example.test/codex/responses', 'https://example.test/unrelated']) {
    await assert.rejects(host.fetch(url, { body: 'invalid json' }), e => e === error);
  }
  assert.equal(count, 2);
});

test('prune ID normalization, append manifests, reload cleanup, and unobserved requests are explicit', async () => {
  const rows = [];
  const host = { fetch: async () => new Response('ok') };
  const observer = createWireObserver(r => rows.push(r), host);
  const body = payload('a');
  body.input.push({ type: 'function_call_output', call_id: 'call_0', output: '[pruned:t1]' });
  const branch = [{ id: 'entry-a', customType: 'context-prune-lab-event', data: { event: 'apply', timestamp: 12,
    candidateToolCallIds: ['call_0|fc_0'], netTokens: 100, rawTokens: 110 } }];
  const prune = latestPrune(branch, body.input);
  assert.deepEqual(prune.positions, [1]);
  observer.prepare('session', body, prune);
  observer.finish('session', { ...message, stopReason: 'aborted' });
  assert.equal(rows.find(r => r.kind === 'request_usage').observedAttempts, 0);
  body.input.push({ type: 'message', role: 'user', content: 'next' });
  observer.prepare('session', body, prune);
  const second = rows.filter(r => r.kind === 'prepared').at(-1);
  assert.equal(second.patchStart, 2);
  assert.equal(second.patch.length, 1);
  assert.equal(second.newPrune, false);
  observer.release('session');
  await host.fetch('https://example.test/codex/responses', { body: JSON.stringify(body) });
  assert(!rows.some(r => r.kind === 'wire_request'));
  observer.prepare('session', body, prune);
  assert.equal(rows.filter(r => r.kind === 'prepared').at(-1).patchStart, 0);
});

test('installed Codex provider sends identical SSE and WS traffic with observer on/off', async () => {
  const ai = path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist');
  const { streamSimple } = await import(pathToFileURL(path.join(ai, 'api/openai-codex-responses.js')));
  const { cleanupSessionResources } = await import(pathToFileURL(path.join(ai, 'session-resources.js')));
  const model = { id: 'offline-model', api: 'openai-codex-responses', provider: 'openai-codex',
    baseUrl: 'https://example.test/backend-api', reasoning: false, input: ['text'], contextWindow: 100000,
    maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const apiKey = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: secret } })).toString('base64')}.signature`;
  const events = [
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', delta: 'OK' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK' }] } },
    { type: 'response.completed', response: { id: secret, status: 'completed', usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102, input_tokens_details: { cached_tokens: 90 } } } },
  ];
  const identity = { sessionId: 'fixed-session', threadId: 'fixed-thread', turnId: 'fixed-turn', requestKind: 'turn', startedAt: 123, installationId: 'fixed-installation', windowId: 'fixed-window' };
  const originalFetch = globalThis.fetch, Original = globalThis.WebSocket;
  async function run(transport, enabled) {
    const sent = [], rows = [], handshakes = [];
    class Socket {
      readyState = 1;
      listeners = new Map();
      constructor(...args) { handshakes.push(args); queueMicrotask(() => this.emit('open', {})); }
      addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
      removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
      emit(type, data) { for (const fn of this.listeners.get(type) ?? []) fn(data); }
      send(frame) { sent.push(frame); queueMicrotask(() => events.forEach(e => this.emit('message', { data: JSON.stringify(e) }))); }
      close() { this.readyState = 3; this.emit('close', { code: 1000 }); }
    }
    globalThis.WebSocket = Socket;
    globalThis.fetch = async (url, init) => {
      sent.push({ url, headers: [...new Headers(init.headers)], body: Buffer.from(init.body).toString('base64') });
      return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
    const observer = enabled ? createWireObserver(r => rows.push(r)) : null;
    const context = { systemPrompt: secret, messages: [{ role: 'user', content: 'reply', timestamp: 1 }] };
    try {
      for (let i = 0; i < 3; i++) {
        if (i === 2) context.messages[0].content = 'edited';
        const result = await streamSimple(model, context, { apiKey, transport, sessionId: 'fixed-session', requestIdentity: identity,
          maxRetries: 0, onPayload: body => { observer?.prepare('fixed-session', body, null); } }).result();
        assert.equal(result.stopReason, 'stop', result.errorMessage);
        observer?.finish('fixed-session', result);
        if (i === 0) context.messages.push(result, { role: 'user', content: 'again', timestamp: 2 });
      }
      return { sent, handshakes, rows };
    } finally { cleanupSessionResources(); globalThis.fetch = originalFetch; globalThis.WebSocket = Original; }
  }
  for (const transport of ['sse', 'websocket-cached']) {
    const off = await run(transport, false);
    const on = await run(transport, true);
    assert.deepEqual(on.sent, off.sent);
    assert.deepEqual(on.handshakes, off.handshakes);
    assert.equal(on.rows.filter(r => r.kind === 'wire_request').length, 3);
    assert(on.rows.filter(r => r.kind === 'request_usage').every(r => r.observedAttempts === 1 && r.cacheRead === 90));
    if (transport === 'websocket-cached') {
      assert.deepEqual(on.rows.filter(r => r.kind === 'wire_request').map(r => r.inputMode), ['full', 'delta', 'full']);
      assert.equal(on.rows.filter(r => r.kind === 'wire_response' && r.usage?.cachedTokens === 90).length, 3);
    }
    assert(!JSON.stringify(on.rows).includes(secret));
  }
});

test('installed xAI provider sends identical Responses traffic with the observer on and off', async () => {
  const ai = path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist');
  const { streamSimple } = await import(pathToFileURL(path.join(ai, 'api/openai-responses.js')));
  const { XAI_MODELS } = await import(pathToFileURL(path.join(ai, 'providers/xai.models.js')));
  const model = XAI_MODELS['grok-4.7'];
  const events = [
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', delta: 'OK' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK' }] } },
    { type: 'response.completed', response: { id: secret, status: 'completed', usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102, input_tokens_details: { cached_tokens: 90 } } } },
  ];
  const originalFetch = globalThis.fetch;
  async function run(enabled) {
    const sent = [], rows = [];
    globalThis.fetch = async (url, init) => {
      sent.push({ url, headers: [...new Headers(init.headers)], body: Buffer.from(init.body).toString('base64') });
      return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': secret } });
    };
    const observer = enabled ? createWireObserver(row => rows.push(row)) : null;
    try {
      const result = await streamSimple(model, { systemPrompt: secret, messages: [{ role: 'user', content: 'reply', timestamp: 1 }] },
        { apiKey: secret, sessionId: 'xai-session', cacheRetention: 'short', reasoningEffort: 'high', maxRetries: 0,
          onPayload: body => { observer?.prepare('xai-session', body, null, 'xai'); } }).result();
      assert.equal(result.stopReason, 'stop', result.errorMessage);
      observer?.finish('xai-session', result);
      return { sent, rows };
    } finally { globalThis.fetch = originalFetch; }
  }
  const off = await run(false);
  const on = await run(true);
  assert.deepEqual(on.sent, off.sent);
  const wire = on.rows.find(row => row.kind === 'wire_request');
  const usage = on.rows.find(row => row.kind === 'request_usage');
  assert.equal(wire.route, 'xai');
  assert.equal(wire.hookInputMatches, true);
  assert.equal(wire.affinityHeaders.bodyKeyMatchesSession, true);
  assert.equal(wire.encryptedReasoningRequested, true);
  assert.equal(usage.observedAttempts, 1);
  assert.equal(usage.cacheRead, 90);
  assert(!JSON.stringify(on.rows).includes(secret));
});

test('diagnostic extension wires xAI request and usage through Pi events', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-xai-wire-'));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.fetch = async () => new Response('ok');
  try {
    const { default: register } = await import(pathToFileURL(path.resolve('tools/context-prune-bench/payload-cache-diag.ts')));
    const handlers = new Map();
    register({ on: (event, handler) => handlers.set(event, handler) });
    const ctx = { model: { provider: 'xai', api: 'openai-responses' }, sessionManager: {
      getSessionId: () => 'xai-session', getBranch: () => [],
    } };
    const body = { ...payload('xai-session'), model: 'grok-4.7' };
    handlers.get('before_provider_request')({ payload: body }, ctx);
    await globalThis.fetch('https://api.x.ai/v1/responses', {
      body: JSON.stringify(body), headers: { session_id: 'xai-session' },
    });
    handlers.get('message_end')({ message: { ...message, role: 'assistant', api: 'openai-responses', provider: 'xai' } }, ctx);
    const rows = readFileSync(path.join(dir, 'logs/payload-cache-wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.find(row => row.kind === 'wire_request').route, 'xai');
    assert.equal(rows.find(row => row.kind === 'request_usage').observedAttempts, 1);
    assert(!JSON.stringify(rows).includes(secret));
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis[Symbol.for('pi.payload-cache-wire-observer.v1')];
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
