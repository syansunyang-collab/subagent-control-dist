// Production observer: retain fingerprints only; forward the original transport arguments unchanged.
import { createHash, randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

const hash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 20);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const fingerprint = value => ({ hash: hash(value), bytes: Buffer.byteLength(JSON.stringify(value ?? null)) });
const callId = id => id.split('|')[0].replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64).replace(/_+$/, '');
const endpoint = url => {
  try {
    const parsed = new URL(String(url));
    if (/\/codex\/responses\/?$/.test(parsed.pathname)) return 'codex';
    if (parsed.hostname === 'api.x.ai' && /^\/v1\/responses\/?$/.test(parsed.pathname)) return 'xai';
  } catch {}
  return null;
};
const safeType = item => ['message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(item.type) ? item.type : 'other';

function inputState(input = []) {
  return input.map(item => ({ ...fingerprint(item), type: safeType(item), callId: item.call_id ? hash(item.call_id) : null }));
}

function difference(previous, current) {
  if (!previous) return { firstDiff: null, unchangedBytes: null, patchStart: 0, patch: current };
  let first = 0;
  while (first < Math.min(previous.length, current.length) && previous[first].hash === current[first].hash) first++;
  return { firstDiff: first, unchangedBytes: current.slice(0, first).reduce((sum, item) => sum + item.bytes, 0), patchStart: first, patch: current.slice(first) };
}

function fields(payload) {
  return {
    model: hash(payload.model), modelId: /^(?:gpt-|grok-)[a-zA-Z0-9_.-]+$/.test(payload.model) ? payload.model : null,
    reasoning: hash(payload.reasoning), effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(payload.reasoning?.effort) ? payload.reasoning.effort : null,
    instructions: fingerprint(payload.instructions), tools: fingerprint(payload.tools),
    cacheKey: hash(payload.prompt_cache_key), metadata: hash(payload.client_metadata),
    turnId: hash(payload.client_metadata?.turn_id),
    maxOutputTokens: number(payload.max_output_tokens), cacheRetention: hash(payload.prompt_cache_retention),
    cacheOptions: hash(payload.prompt_cache_options), include: hash(payload.include),
    encryptedReasoningRequested: Array.isArray(payload.include) && payload.include.includes('reasoning.encrypted_content'),
  };
}

export function latestPrune(branch, input) {
  const entry = branch.findLast(e => e.customType === 'context-prune-lab-event' && e.data?.event === 'apply');
  if (!entry) return null;
  const data = entry.data;
  const ids = new Set((data.candidateToolCallIds ?? []).map(callId));
  return { id: hash(entry.id), timestamp: number(data.timestamp), count: ids.size,
    netTokenEstimate: number(data.netTokens), rawTokenEstimate: number(data.rawTokens),
    positions: input.flatMap((item, index) => ids.has(item.call_id) && ['function_call_output', 'custom_tool_call_output'].includes(item.type) ? [index] : []) };
}

export function createWireObserver(write, host = globalThis) {
  const run = randomUUID();
  const active = new Map();
  const hookHistory = new Map();
  const wireHistory = new Map();
  const sessions = new Map();
  let sequence = 0;
  let connections = 0;
  // Diagnostics must never prevent sending, even when the log disk is unavailable.
  const emit = row => { try { write({ schema: 1, run, at: Date.now(), ...row }); } catch {} };
  const safe = fn => { try { return fn(); } catch { emit({ kind: 'observer_error' }); } };
  const keyOf = payload => typeof payload?.prompt_cache_key === 'string' ? hash(payload.prompt_cache_key) : null;

  function outgoing(payload, route, transport, wireBytes, connectionId, headers) {
    const key = keyOf(payload);
    const request = key && active.get(key);
    if (!request || request.route !== route || payload.model !== request.model) return null;
    const input = inputState(payload.input);
    const delta = Boolean(payload.previous_response_id);
    // A delta frame is not comparable with a previous full input; keep that distinction explicit.
    const previous = !delta ? wireHistory.get(key) : null;
    const attempt = { requestId: request.id, attemptId: `${request.id}:${++request.attempts}`, connectionId, key };
    request.lastAttempt = attempt.attemptId;
    emit({ kind: 'wire_request', ...attempt, route, transport, wireBytes, ...fields(payload),
      affinityHeaders: route === 'xai' ? {
        sessionId: hash(headers?.get('session_id')), clientRequestId: hash(headers?.get('x-client-request-id')),
        bodyKeyMatchesSession: headers?.get('session_id') === payload.prompt_cache_key,
      } : null,
      frame: fingerprint(payload), inputCount: input.length, inputBytes: input.reduce((n, item) => n + item.bytes, 0),
      inputMode: delta ? 'delta' : 'full', previousResponseId: hash(payload.previous_response_id),
      turnState: hash(headers?.get('x-codex-turn-state') ?? payload.client_metadata?.['x-codex-turn-state']),
      hookInputMatches: delta ? null : hash(input) === request.inputHash,
      comparisonAttempt: previous?.attemptId ?? null, ...difference(previous?.input, input) });
    if (!delta) wireHistory.set(key, { input, attemptId: attempt.attemptId });
    return attempt;
  }

  function serverEvent(attempt, event) {
    if (!attempt) return;
    const response = event.response;
    if (!['response.created', 'response.completed', 'response.done', 'response.incomplete', 'response.failed', 'error'].includes(event.type)) return;
    const usage = response?.usage;
    emit({ kind: 'wire_response', ...attempt, event: event.type, responseId: hash(response?.id),
      usage: usage ? { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens),
        totalTokens: number(usage.total_tokens), cachedTokens: number(usage.input_tokens_details?.cached_tokens),
        reasoningTokens: number(usage.output_tokens_details?.reasoning_tokens) } : null });
  }

  const originalFetch = host.fetch;
  if (typeof originalFetch === 'function') host.fetch = async function (...args) {
    let attempt;
    const route = endpoint(args[0]);
    if (active.size && route && args[1]?.body) safe(() => {
      const headers = new Headers(args[1].headers);
      const wire = Buffer.from(args[1].body);
      const body = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(wire) : wire;
      attempt = outgoing(JSON.parse(body.toString('utf8')), route, 'sse', wire.length, null, headers);
    });
    try {
      const response = await Reflect.apply(originalFetch, this, args);
      if (attempt) safe(() => emit({ kind: 'wire_http_response', ...attempt, status: response.status,
        responseRequestId: hash(response.headers.get('x-request-id')),
        turnState: hash(response.headers.get('x-codex-turn-state')) }));
      // Do not clone or consume the SSE stream: Pi's message_end supplies its parsed usage.
      return response;
    } catch (error) {
      if (attempt) emit({ kind: 'wire_transport_error', ...attempt, transport: 'sse' });
      throw error;
    }
  };

  const Original = host.WebSocket;
  if (typeof Original === 'function') {
    const Wrapped = new Proxy(Original, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
        if (endpoint(args[0]) !== 'codex') return socket;
        safe(() => {
        const connectionId = ++connections;
        let attempt;
        const send = socket.send;
        socket.send = function (...sendArgs) {
          attempt = null;
          if (active.size) safe(() => {
            const raw = sendArgs[0];
            attempt = outgoing(JSON.parse(Buffer.from(raw).toString('utf8')), 'codex', 'websocket', Buffer.byteLength(raw), connectionId);
          });
          try { return Reflect.apply(send, this, sendArgs); }
          catch (error) { if (attempt) emit({ kind: 'wire_transport_error', ...attempt, transport: 'websocket' }); throw error; }
        };
        socket.addEventListener('message', event => {
          if (attempt) safe(() => serverEvent(attempt, JSON.parse(Buffer.from(event.data).toString('utf8'))));
        });
        socket.addEventListener('close', event => { if (attempt) emit({ kind: 'wire_close', ...attempt, code: number(event.code) }); });
        socket.addEventListener('error', () => { if (attempt) emit({ kind: 'wire_transport_error', ...attempt, transport: 'websocket' }); });
        });
        return socket;
      },
    });
    host.WebSocket = Wrapped;
  }

  emit({ kind: 'observer_start' });
  return {
    prepare(session, payload, prune, route = 'codex') {
      safe(() => {
        const key = keyOf(payload);
        if (!key || !Array.isArray(payload.input)) return;
        const prior = hookHistory.get(session);
        const input = inputState(payload.input);
        const id = `${run}:${++sequence}`;
        if (active.has(key)) emit({ kind: 'request_superseded', requestId: active.get(key).id });
        const oldKey = sessions.get(session);
        if (oldKey && oldKey !== key) { active.delete(oldKey); wireHistory.delete(oldKey); }
        active.set(key, { id, route, model: payload.model, attempts: 0, lastAttempt: null, inputHash: hash(input) });
        sessions.set(session, key);
        hookHistory.set(session, { input, pruneId: prune?.id });
        emit({ kind: 'prepared', requestId: id, route, session: hash(session), ...fields(payload),
          inputCount: input.length, ...difference(prior?.input, input), prune,
          newPrune: prior ? Boolean(prune && prune.id !== prior.pruneId) : null });
      });
    },
    finish(session, message) {
      safe(() => {
        const key = sessions.get(session);
        const request = active.get(key);
        if (!request) return;
        const usage = message.usage ?? {};
        emit({ kind: 'request_usage', requestId: request.id, route: request.route, lastAttempt: request.lastAttempt,
          observedAttempts: request.attempts, responseId: hash(message.responseId),
          stopReason: ['stop', 'toolUse', 'length', 'error', 'aborted'].includes(message.stopReason) ? message.stopReason : 'other',
          usageSource: 'pi-message-end', input: number(usage.input), output: number(usage.output),
          cacheRead: number(usage.cacheRead), cacheWrite: number(usage.cacheWrite),
          piCost: number(usage.cost?.total) });
        active.delete(key);
      });
    },
    release(session) {
      const key = sessions.get(session);
      active.delete(key); wireHistory.delete(key); hookHistory.delete(session); sessions.delete(session);
    },
  };
}

// Pi reloads extensions while sockets can survive; one process-wide observer prevents wrapper stacking.
export function getWireObserver(write) {
  const key = Symbol.for('pi.payload-cache-wire-observer.v1');
  return globalThis[key] ??= createWireObserver(write);
}
