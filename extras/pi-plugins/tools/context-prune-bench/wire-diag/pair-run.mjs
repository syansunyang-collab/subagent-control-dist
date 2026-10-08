// Same-version paired provider run. Raw frames, credentials and messages remain in memory.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { installCodexWebSocketProbe, classifyError } from './probe.mjs';
import { auditFrames, context, opening, makeHistory, prune, prefix, observation, user, digest } from './replay.mjs';
const globalRoot = 'C:/Users/67570/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/';
const { configureHttpDispatcher } = await import(pathToFileURL(globalRoot + 'dist/core/http-dispatcher.js'));
const { ModelRuntime } = await import(pathToFileURL(globalRoot + 'dist/core/model-runtime.js'));
const { ReadOnlyAuthStorage } = await import(pathToFileURL(globalRoot + 'dist/core/auth-storage.js'));
const names = ['on', 'off'];
const groups = ['warm-tool-call', 'retained-long-tool-result', 'same-turn-unpruned', 'same-turn-pruned', 'same-turn-pruned-continuation', 'new-turn-unpruned'];
const offline = process.argv.includes('--offline');
const output = new URL(offline ? './pair-offline-redacted.jsonl' : './pair-live-redacted.jsonl', import.meta.url);
const log = row => appendFileSync(output, JSON.stringify(row) + '\n');
const key = value => digest(JSON.stringify(value)).slice(0, 16);
const SHA = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = { on: '7e3d7116e4804f2a71b7bfc50931bc5247cd0567cc136f289a3fe2a96de81ff3', off: 'c885af5b4bf4b83ac12c18f2428be3020563fa9f0a0ec7e898a976e069b480da' };
const modules = {};
for (const arm of names) {
  const root = new URL(`./pair/${arm}/dist/`, import.meta.url);
  const provider = new URL('api/openai-codex-responses.js', root);
  assert.equal(SHA(readFileSync(provider)), expected[arm]);
  modules[arm] = { ...(await import(provider)), cleanup: (await import(new URL('session-resources.js', root))).cleanupSessionResources,
    normalize: (await import(new URL('utils/transcript.js', root))).normalizeContext };
}
const model = { id: 'gpt-6-sol', name: 'Codex', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 128000 };
const fakeJwt = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-account' } })).toString('base64')}.signature`;
const originalSocket = globalThis.WebSocket;
let mockFrames = [];
class MockSocket {
  readyState = 1; listeners = new Map();
  constructor() { queueMicrotask(() => this.emit('open', {})); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, e) { for (const fn of this.listeners.get(type) ?? []) fn(e); }
  send(data) {
    mockFrames.push(JSON.parse(data));
    const n = mockFrames.length;
    const item = n % 6 === 1 ? { type: 'function_call', id: 'item', call_id: 'call', name: 'fixed_observation', arguments: '{}', status: 'completed' }
      : { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK' }] };
    const events = [{ type: 'response.output_item.added', item }, { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: `response_${n}`, status: 'completed', usage: { input_tokens: 13000, output_tokens: 3, total_tokens: 13003, input_tokens_details: { cached_tokens: 10000 } } } }];
    queueMicrotask(() => { for (const event of events) this.emit('message', { data: JSON.stringify(event) }); });
  }
  close() { this.readyState = 3; this.emit('close', { code: 1000 }); }
}
if (!offline) configureHttpDispatcher();
const runtime = offline ? null : await ModelRuntime.create({ credentials: new ReadOnlyAuthStorage(), refreshOnCreate: false, allowModelNetwork: false });
const liveModel = offline ? model : runtime.getModel('openai-codex', 'gpt-6-sol');
assert(liveModel, 'gpt-6-sol must be available');
const paired = {};
try {
  if (offline) globalThis.WebSocket = MockSocket;
  for (const arm of names) {
    mockFrames = [];
    const mod = modules[arm];
    const frames = [];
    const rows = [];
    const stop = installCodexWebSocketProbe({ logFile: output, onFrame: ({ payload }) => frames.push(payload) });
    // Distinct, independently warmed keys; identical content and identity shape in both arms.
    const identity = { sessionId: `wire-pair-${arm}-gpt-6-sol`, threadId: `wire-pair-${arm}-gpt-6-sol`,
      turnId: `wire-pair-${arm}-turn1`, requestKind: 'turn', startedAt: 123456789,
      installationId: 'wire-pair', windowId: 'wire-pair' };
    let prepared;
    let failed = false;
    try {
      const opts = { sessionId: identity.sessionId, requestIdentity: identity, transport: 'websocket', reasoning: 'off', maxRetries: 0 };
      prepared = offline ? { model: liveModel, options: { ...opts, apiKey: fakeJwt } } : await runtime.prepareRequest(liveModel, opts);
      const run = async (group, messages, requestIdentity = identity) => {
        const options = { ...prepared.options, requestIdentity, signal: AbortSignal.timeout(90000) };
        try {
          const result = await mod.streamSimple(prepared.model, mod.normalize(context(messages)), options).result();
          const success = result.stopReason !== 'error' && result.stopReason !== 'aborted';
          const usage = success ? result.usage : null;
          const row = { kind: 'trial', arm, group, success, stopReason: result.stopReason,
            usage: usage ? { input: usage.input, cacheRead: usage.cacheRead, output: usage.output } : null,
            cacheHitRate: usage && usage.input + usage.cacheRead ? usage.cacheRead / (usage.input + usage.cacheRead) : null,
            diagnostic: success ? null : classifyError(result.errorMessage) };
          log(row); rows.push(row);
          if (!success) failed = true;
          return success ? result : null;
        } catch (e) { const row = { kind: 'trial', arm, group, success: false, usage: null, diagnostic: classifyError(e) };
          log(row); rows.push(row); failed = true; return null; }
      };
      log({ kind: 'arm', arm, providerSha256: expected[arm], version: '0.87.1', prefixHash: digest(prefix), prefixBytes: Buffer.byteLength(prefix),
        observationHash: digest(observation), reasoning: 'off', transport: 'websocket_full_context', cacheKeyStrategy: 'per-arm distinct session/thread; first request warms each independently',
        identityInputHash: key({ ...identity, sessionId: 'ARM', threadId: 'ARM', turnId: 'ARM' }) });
      const call = await run(groups[0], opening);
      const history = call && makeHistory(call);
      if (call && !history) { failed = true; log({ kind: 'stop', arm, reason: 'no_real_tool_call' }); }
      const retained = history && await run(groups[1], history);
      const basis = retained && [...history, retained];
      const unpruned = basis && await run(groups[2], [...basis, user('Continue briefly.', 4)]);
      const pruned = unpruned && prune(basis);
      const prunedResponse = pruned && await run(groups[3], [...pruned, user('Continue briefly.', 4)]);
      const continuation = prunedResponse && await run(groups[4], [...pruned, user('Continue briefly.', 4), prunedResponse, user('Continue further.', 5)]);
      if (continuation) await run(groups[5], [...basis, user('Continue briefly.', 4)], { ...identity, turnId: `${identity.turnId}-next`, startedAt: 123456790 });
      if (frames.length === rows.length) {
        const audit = auditFrames(frames, groups.slice(0, frames.length));
        log({ kind: 'audit', arm, ...audit });
        if (audit.errors.length) failed = true;
        paired[arm] = { frames, audit };
      } else { failed = true; log({ kind: 'audit_unavailable', arm, frames: frames.length, trials: rows.length }); }
    } finally { mod.cleanup(); stop(); }
    if (failed) process.exitCode = 1;
  }
  if (paired.on?.frames.length === 6 && paired.off?.frames.length === 6) {
    const [on, off] = [paired.on.frames, paired.off.frames];
    assert.equal(digest(on[0].instructions), digest(off[0].instructions));
    assert.equal(key(on[0].tools), key(off[0].tools));
    const difference = { kind: 'pair', instructionsEqual: true, toolsEqual: true, onCacheKey: key(on[0].prompt_cache_key),
      offCacheKey: key(off[0].prompt_cache_key), onTurnMetadata: key(on[0].client_metadata), offTurnMetadata: key(off[0].client_metadata),
      onFirstFrameHash: key(on[0]), offFirstFrameHash: key(off[0]),
      onHasTurnId: Boolean(on[0].client_metadata?.turn_id), offHasTurnId: Boolean(off[0].client_metadata?.turn_id),
      onHasCacheKey: Boolean(on[0].prompt_cache_key), offHasCacheKey: Boolean(off[0].prompt_cache_key) };
    log(difference);
    assert(difference.onFirstFrameHash !== difference.offFirstFrameHash);
    assert(difference.onHasTurnId && !difference.offHasTurnId);
    console.log(JSON.stringify(difference));
  }
} finally { for (const mod of Object.values(modules)) mod.cleanup(); globalThis.WebSocket = originalSocket; }
