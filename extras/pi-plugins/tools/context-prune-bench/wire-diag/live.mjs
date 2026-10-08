// Isolated SDK replay: real tool call, synthetic tool output and history replacement.
// No credential, raw request/response body, header or prompt is persisted.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { installCodexWebSocketProbe, wrapCodexFetch, recordUsage, classifyError } from './probe.mjs';
import { auditFrames, context, opening, makeHistory, prune, observation, prefix, user } from './replay.mjs';

const root = 'C:/Users/67570/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/';
const { configureHttpDispatcher } = await import(pathToFileURL(root + 'core/http-dispatcher.js'));
const { ModelRuntime } = await import(pathToFileURL(root + 'core/model-runtime.js'));
const { ReadOnlyAuthStorage } = await import(pathToFileURL(root + 'core/auth-storage.js'));
const { cleanupSessionResources } = await import(pathToFileURL(root + '../node_modules/@earendil-works/pi-ai/dist/session-resources.js'));
configureHttpDispatcher();
// The optional single-model run requires its own evidence path; the default batch is unchanged.
const single = process.env.WIRE_MODEL;
const file = single ? process.env.WIRE_LOG_FILE : new URL('./live-long-prefix-redacted.jsonl', import.meta.url);
if (single && (!file || single !== 'gpt-6-astra')) throw new Error('Single-model run requires WIRE_MODEL=gpt-6-astra and WIRE_LOG_FILE');
const limit = single ? Math.min(6, Number(process.env.WIRE_MAX_CALLS ?? 6)) : 14;
if (!Number.isInteger(limit) || limit < 1) throw new Error('WIRE_MAX_CALLS must be a positive integer');
const log = row => appendFileSync(file, JSON.stringify(row) + '\n');
const runtime = await ModelRuntime.create({ credentials: new ReadOnlyAuthStorage(), refreshOnCreate: false, allowModelNetwork: false });
const models = (single ? [single] : ['gpt-6-sol', 'gpt-6-luna']).map(id => runtime.getModel('openai-codex', id));
if (models.some(model => !model)) throw new Error('Requested Codex models absent from installed catalog');
let calls = 0;
let current;
let frames = [];
const groups = [];
const stop = installCodexWebSocketProbe({ logFile: file,
  onFrame: ({ sequence, connectionId, payload }) => {
    frames.push(payload);
    if (current) { current.frameSequence = sequence; current.connectionId = connectionId; }
  } });
const run = async (model, group, messages, identity) => {
  if (calls >= limit) return null;
  const request = ++calls;
  groups.push(group);
  current = { frameSequence: null, connectionId: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const result = await runtime.streamSimple(model, context(messages), { sessionId: identity.sessionId,
      requestIdentity: identity, transport: 'websocket', reasoning: single ? 'off' : undefined,
      signal: controller.signal, maxRetries: 0,
      fetch: wrapCodexFetch(globalThis.fetch, { logFile: file }) }).result();
    const success = result.stopReason !== 'error' && result.stopReason !== 'aborted';
    const usage = success ? result.usage ?? null : null;
    log({ kind: 'trial', request, model: model.id, group, protocol: current.frameSequence ? 'websocket' : 'unobserved',
      frameSequence: current.frameSequence, connectionId: current.connectionId, stopReason: result.stopReason,
      diagnostic: success ? null : classifyError(result.errorMessage), usage,
      cacheHitRate: usage && usage.input + usage.cacheRead > 0 ? usage.cacheRead / (usage.input + usage.cacheRead) : null,
      usageProvenance: success ? 'provider_completed' : 'failure_default_ignored' });
    if (success) recordUsage(file, result);
    return success ? result : null;
  } catch (error) {
    log({ kind: 'trial', request, model: model.id, group, protocol: current.frameSequence ? 'websocket' : 'unobserved',
      frameSequence: current.frameSequence, connectionId: current.connectionId,
      diagnostic: classifyError(error), usage: null, cacheHitRate: null, usageProvenance: 'exception_no_usage' });
    return null;
  } finally { clearTimeout(timer); current = null; }
};
try {
  for (const model of models) {
    const identity = { sessionId: `wire-long-${model.id}`, threadId: `wire-long-${model.id}`,
      turnId: `wire-long-${model.id}-turn1`, requestKind: 'turn', startedAt: Date.now(),
      installationId: 'wire-replay', windowId: 'wire-replay' };
    frames = [];
    groups.length = 0;
    log({ kind: 'model_start', model: model.id, api: model.api, prefixChars: prefix.length,
      observationChars: observation.length, synthetic: true, transportSelection: 'websocket_full_context',
      reasoning: single ? 'off' : 'provider_default' });
    // This long fixed-prefix tool-call request is both cache warmup and connectivity check.
    const call = await run(model, 'warm-tool-call', opening, identity);
    if (!call) { log({ kind: 'model_stopped', model: model.id, reason: 'first_entry_failed' }); cleanupSessionResources(); if (single) { process.exitCode = 1; break; } continue; }
    const history = makeHistory(call);
    if (!history) { log({ kind: 'model_stopped', model: model.id, reason: 'no_real_tool_call' }); cleanupSessionResources(); if (single) { process.exitCode = 1; break; } continue; }
    const retained = await run(model, 'retained-long-tool-result', history, identity);
    if (!retained) { log({ kind: 'model_stopped', model: model.id, reason: 'long_result_failed' }); cleanupSessionResources(); if (single) { process.exitCode = 1; break; } continue; }
    const basis = [...history, retained];
    const unpruned = await run(model, 'same-turn-unpruned', [...basis, user('Continue briefly.', 4)], identity);
    if (!unpruned) { log({ kind: 'model_stopped', model: model.id, reason: 'unpruned_failed' }); cleanupSessionResources(); if (single) { process.exitCode = 1; break; } continue; }
    const pruned = prune(basis);
    const prunedResponse = await run(model, 'same-turn-pruned', [...pruned, user('Continue briefly.', 4)], identity);
    if (!prunedResponse) { log({ kind: 'model_stopped', model: model.id, reason: 'pruned_failed' }); cleanupSessionResources(); if (single) { process.exitCode = 1; break; } continue; }
    const continued = await run(model, 'same-turn-pruned-continuation',
      [...pruned, user('Continue briefly.', 4), prunedResponse, user('Continue further.', 5)], identity);
    if (!continued) { log({ kind: 'model_stopped', model: model.id, reason: 'pruned_continuation_failed' }); cleanupSessionResources(); if (single) { process.exitCode = 1; break; } continue; }
    const newTurn = { ...identity, turnId: `${identity.turnId}-next`, startedAt: Date.now() };
    const final = await run(model, 'new-turn-unpruned', [...basis, user('Continue briefly.', 4)], newTurn);
    if (!final && single) { log({ kind: 'model_stopped', model: model.id, reason: 'new_turn_failed' }); process.exitCode = 1; }
    if (frames.length === groups.length) {
      const audit = auditFrames(frames, groups);
      log({ kind: 'prefix_audit', model: model.id, ...audit });
      if (single && audit.errors.length) process.exitCode = 1;
    } else {
      log({ kind: 'prefix_audit_unavailable', model: model.id, frames: frames.length, requests: groups.length });
      if (single) process.exitCode = 1;
    }
    cleanupSessionResources();
  }
} finally { cleanupSessionResources(); stop(); }
console.log(JSON.stringify({ requestsAttempted: calls, models: models.map(m => m.id), evidence: file.pathname,
  history: 'real tool call; synthetic tool output and synthetic prune; not natural plugin execution' }));
