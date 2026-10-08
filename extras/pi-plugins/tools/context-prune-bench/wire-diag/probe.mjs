// Isolated-process final outbound SSE/WS observers. Never mutate transport selection,
// constructor arguments, outbound bytes, headers, responses or connection cache.
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
const bytes = value => Buffer.byteLength(JSON.stringify(value ?? null));
const fingerprint = value => ({ hash: hash(value), bytes: bytes(value) });
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// Only allowlisted diagnostics cross the disk boundary; never write a raw Error,
// message, URL, cause, response body, or potentially credential-bearing code.
export function classifyError(error) {
  const chain = [];
  for (let next = error, depth = 0; next && depth < 3; next = next.cause, depth++) chain.push(next);
  const text = chain.map(item => typeof item === 'string' ? item : item?.message ?? '').join(' ');
  const categories = [
    ['proxy_tunnel', /proxy.*(?:tunnel|connect)|(?:tunnel|connect).*proxy/i],
    ['tls_certificate', /cert(?:ificate)?|self.signed|tls|ssl/i],
    ['dns', /enotfound|eai_again|dns/i],
    ['connection_refused', /econnrefused|connection refused/i],
    ['connection_reset', /econnreset|connection reset|socket hang up/i],
    ['timeout', /timeout|timed out|etimedout/i],
    ['http_unauthorized', /\b401\b|unauthorized/i],
    ['http_forbidden', /\b403\b|forbidden/i],
    ['http_rate_limited', /\b429\b|rate.limit/i],
    ['http_bad_gateway', /\b(?:502|503|504)\b/i],
    ['websocket_abnormal_close', /websocket closed 1006/i],
    ['websocket_handshake', /websocket|unexpected server response/i],
    ['aborted', /aborted|aborterror/i],
  ];
  const code = chain.map(item => item?.code).find(item => typeof item === 'string' && /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+|ERR_[A-Z_]+)$/.test(item));
  return { category: categories.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other',
    code: code ?? null, status: /\b(?:400|401|403|404|408|409|429|500|502|503|504)\b/.exec(text)?.[0] ?? null,
    closeCode: chain.map(item => item?.code).find(item => typeof item === 'number' && item >= 1000 && item <= 4999) ?? null };
}

// Paths use object-key hashes to avoid persisting user-supplied field names.
export function firstDifference(a, b, path = '$') {
  if (hash(a) === hash(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const diff = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return `${path}[${Math.min(a.length, b.length)}]`;
  }
  if (object(a) && object(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return `${path}.{${hash(key)}}`;
      const diff = firstDifference(a[key], b[key], `${path}.{${hash(key)}}`);
      if (diff) return diff;
    }
  }
  return path;
}

function decode(body, headers) {
  const input = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  const raw = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(input) : input;
  return { payload: JSON.parse(raw.toString('utf8')), wireBytes: input.length };
}

export function summarize(payload, headers, previous, wireBytes, at) {
  const input = Array.isArray(payload.input) ? payload.input : [];
  const prior = previous?.input ?? [];
  let firstItem = null;
  if (previous) {
    firstItem = Math.min(input.length, prior.length);
    for (let i = 0; i < firstItem; i++) if (hash(input[i]) !== hash(prior[i])) { firstItem = i; break; }
  }
  const metadata = object(payload.client_metadata) ? payload.client_metadata : {};
  return {
    kind: 'request', at, intervalMs: previous ? at - previous.at : null,
    transport: 'sse', wireBytes, body: fingerprint(payload),
    inputCount: input.length, inputBytes: bytes(input), firstItem,
    charsBeforeDiff: firstItem === null ? null : input.slice(0, firstItem).reduce((sum, v) => sum + bytes(v), 0),
    firstPath: previous ? firstDifference(previous.payload, payload) : null,
    instructions: fingerprint(payload.instructions), tools: fingerprint(payload.tools),
    promptCacheKey: fingerprint(payload.prompt_cache_key),
    turnId: fingerprint(metadata.turn_id),
    turnMetadata: fingerprint(metadata['x-codex-turn-metadata']),
    turnState: fingerprint(headers.get('x-codex-turn-state') ?? metadata['x-codex-turn-state']),
    previousResponseId: fingerprint(payload.previous_response_id),
    hasPreviousResponseId: Boolean(payload.previous_response_id),
    sessionId: fingerprint(headers.get('session-id')),
    threadId: fingerprint(headers.get('thread-id')),
    // A stable connection identifier is not exposed by fetch; do not infer reuse from requests.
    connection: 'not_exposed_by_fetch',
  };
}

/** Writer accepts already-redacted records only. Original fetch is called once with original arguments. */
export function wrapCodexFetch(fetchImpl, { enabled = true, logFile } = {}) {
  let previous;
  let sequence = 0;
  const write = record => { if (enabled && logFile) appendFileSync(logFile, JSON.stringify(record) + '\n'); };
  return async (url, init) => {
    if (!enabled) return fetchImpl(url, init);
    const { payload, wireBytes } = decode(init.body, new Headers(init.headers));
    const at = Date.now();
    const row = summarize(payload, new Headers(init.headers), previous, wireBytes, at);
    const requestSequence = ++sequence;
    row.sequence = requestSequence;
    previous = { input: payload.input, payload, at };
    write(row);
    const response = await fetchImpl(url, init);
    write({ kind: 'response', sequence: requestSequence, status: response.status,
      turnState: fingerprint(response.headers.get('x-codex-turn-state')) });
    return response;
  };
}

/** Wrap the actual Node WebSocket constructor before the provider's first connection.
 * Constructor arguments and send data go to the original unchanged; raw frames live only in memory.
 * Install in an isolated process, and uninstall after provider session cleanup.
 */
export function installCodexWebSocketProbe({ enabled = true, logFile, onFrame, onEvent } = {}) {
  const Original = globalThis.WebSocket;
  if (typeof Original !== 'function') throw new Error('Node WebSocket constructor unavailable');
  if (!enabled) return () => {};
  let nextConnection = 0;
  let sequence = 0;
  let previous;
  const sockets = new Map();
  const write = row => { if (logFile) appendFileSync(logFile, JSON.stringify(row) + '\n'); };
  const Wrapped = new Proxy(Original, {
    construct(target, args, newTarget) {
      // Do not clone/normalize constructor options: provider owns handshake routing.
      const socket = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
      const connectionId = ++nextConnection;
      const headers = args[1]?.headers ?? {};
      write({ kind: 'handshake', transport: 'websocket', connectionId,
        url: fingerprint(String(args[0])),
        headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [hash(key), fingerprint(value)])) });
      socket.addEventListener('close', event => write({ kind: 'socket_close', connectionId, code: Number(event.code) || null, wasClean: Boolean(event.wasClean) }));
      socket.addEventListener('error', event => write({ kind: 'socket_error', connectionId,
        diagnostic: classifyError(event?.error ?? event) }));
      if (onEvent) socket.addEventListener('message', event => {
        try {
          const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
          onEvent({ connectionId, payload: JSON.parse(raw) });
        } catch (error) {
          write({ kind: 'probe_error', connectionId, reason: error instanceof Error ? error.name : 'unknown' });
        }
      });
      const ownSend = Object.getOwnPropertyDescriptor(socket, 'send');
      const originalSend = socket.send;
      sockets.set(socket, ownSend);
      Object.defineProperty(socket, 'send', { configurable: true, writable: true, value: function (...sendArgs) {
        const raw = sendArgs[0];
        const at = Date.now();
        // Parsing and summarization are observational. No raw data is written to disk.
        try {
          const payload = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
          const row = summarize(payload, new Headers(), previous, Buffer.byteLength(raw), at);
          row.transport = 'websocket';
          row.kind = 'frame';
          row.connectionId = connectionId;
          row.sequence = ++sequence;
          row.frame = fingerprint(raw);
          row.turnState = fingerprint(payload.client_metadata?.['x-codex-turn-state']);
          previous = { input: payload.input, payload, at };
          write(row);
          onFrame?.({ sequence, connectionId, payload, raw });
        } catch (error) {
          // Do not convert an observer failure into a provider send failure.
          write({ kind: 'probe_error', connectionId, reason: error instanceof Error ? error.name : 'unknown' });
        }
        return Reflect.apply(originalSend, this, sendArgs);
      } });
      return socket;
    },
  });
  globalThis.WebSocket = Wrapped;
  return () => {
    globalThis.WebSocket = Original;
    for (const [socket, descriptor] of sockets) {
      if (descriptor) Object.defineProperty(socket, 'send', descriptor);
      else delete socket.send;
    }
    sockets.clear();
  };
}

/** Completed assistant usage is recorded separately; never persist response content or response ID. */
export function recordUsage(logFile, result) {
  const usage = result.usage ?? {};
  appendFileSync(logFile, JSON.stringify({ kind: 'usage', responseId: fingerprint(result.responseId),
    input: usage.input ?? null, output: usage.output ?? null,
    cacheRead: usage.cacheRead ?? null, cacheWrite: usage.cacheWrite ?? null }) + '\n');
}
