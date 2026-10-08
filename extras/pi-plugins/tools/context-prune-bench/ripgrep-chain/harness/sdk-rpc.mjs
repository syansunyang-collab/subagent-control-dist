import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const value = key => { const i = argv.indexOf(key); return i < 0 ? undefined : argv[i + 1]; };
const extensionPaths = argv.flatMap((arg, i) => arg === '--extension' ? [argv[i + 1]] : []);
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir || !agentDir.includes('ripgrep-chain')) throw new Error('An isolated agent directory is required');
const realProfile = path.dirname(path.dirname(process.env.APPDATA));
const realAgent = path.join(realProfile, '.pi/agent');
const core = path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
const sdk = await import(pathToFileURL(path.join(core, 'dist/index.js')).href);
const { runRpcMode } = await import(pathToFileURL(path.join(core, 'dist/modes/rpc/rpc-mode.js')).href);
// Same module instance the Codex provider loads, so its per-session WebSocket counters are visible here.
const codexApi = await import(pathToFileURL(path.join(core, 'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js')).href);
const prodSettings = argv.includes('--prod-settings');
const { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, ModelRuntime } = sdk;
const modelRuntime = await ModelRuntime.create({ authPath: path.join(realAgent, 'auth.json'), modelsPath: path.join(realAgent, 'models.json'), modelsStorePath: path.join(realAgent, 'models-store.json'), allowModelNetwork: false });
const model = modelRuntime.getModel(value('--provider'), value('--model'));
if (!model || model.id !== value('--model') || model.provider !== value('--provider')) throw new Error('Model identity mismatch');
const out = path.dirname(value('--session-dir'));
fs.mkdirSync(out, { recursive: true });
const traceFile = path.join(out, 'projection.jsonl');
let requests = 0;
let task = 0;
const jsonl = (file, object) => fs.appendFileSync(file, JSON.stringify(object) + '\n');
// The driver writes the milestone number here before each prompt; compaction continuations keep the same step.
const stepFile = path.join(out, 'step.txt');
const currentStep = () => { try { return Number(fs.readFileSync(stepFile, 'utf8')) || null; } catch { return null; } };
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
// Every provider call (main turns, prune summaries, compaction writer); classified afterwards by model and time.
let providerSequence = 0;
let meterDepth = 0;
const meterProvider = (id, provider) => new Proxy(provider, { get(target, key, receiver) {
  if (key !== 'stream' && key !== 'streamSimple') return Reflect.get(target, key, receiver);
  return (...args) => {
    if (meterDepth > 0) return target[key](...args);
    const call = ++providerSequence;
    const started = Date.now();
    const base = { call, step: currentStep(), task, method: key, provider: id, model: args[0]?.id };
    jsonl(path.join(out, 'provider-calls.jsonl'), { phase: 'start', ...base, time: started });
    meterDepth++;
    try {
      const stream = target[key](...args);
      stream.result().then(response => jsonl(path.join(out, 'provider-calls.jsonl'), { phase: 'end', ...base, time: Date.now(), durationMs: Date.now() - started, responseModel: response.responseModel ?? response.model, usage: response.usage, stopReason: response.stopReason, errorMessage: response.errorMessage }),
        error => jsonl(path.join(out, 'provider-calls.jsonl'), { phase: 'error', ...base, time: Date.now(), error: String(error) }));
      return stream;
    } catch (error) {
      jsonl(path.join(out, 'provider-calls.jsonl'), { phase: 'error', ...base, time: Date.now(), error: String(error) });
      throw error;
    } finally {
      meterDepth--;
    }
  };
} });
// Observe direct summarizer calls too; the production extension does not persist API entries.
const providerLookup = modelRuntime.getProvider.bind(modelRuntime);
let summarySequence = 0;
modelRuntime.getProvider = id => {
  const found = providerLookup(id);
  if (!found) return found;
  const provider = prodSettings ? meterProvider(id, found) : found;
  if (id !== 'opencode-go') return provider;
  return new Proxy(provider, { get(target, key, receiver) {
    if (key !== 'stream') return Reflect.get(target, key, receiver);
    return (...args) => {
      const call = ++summarySequence;
      const started = Date.now();
      const sourceTask = task;
      jsonl(path.join(out, 'summary-meter.jsonl'), { phase: 'start', call, task: sourceTask, time: started, model: args[0].id, provider: args[0].provider, costRates: args[0].cost });
      try {
        const stream = target.stream(...args);
        stream.result().then(response => jsonl(path.join(out, 'summary-meter.jsonl'), { phase: 'end', call, task: sourceTask, time: Date.now(), durationMs: Date.now() - started, model: args[0].id, usage: response.usage, stopReason: response.stopReason }), error => jsonl(path.join(out, 'summary-meter.jsonl'), { phase: 'error', call, task: sourceTask, time: Date.now(), error: String(error) }));
        return stream;
      } catch (error) {
        jsonl(path.join(out, 'summary-meter.jsonl'), { phase: 'error', call, task: sourceTask, time: Date.now(), error: String(error) });
        throw error;
      }
    };
  } });
};
// Per provider request: fingerprints of instructions, tools and every input item (content stays in the session
// file), and where the body first differs from the previous request of the same model.
let requestSequence = 0;
let lastRequestTime = null;
const previousItems = new Map();
const recordRequest = payload => {
  const now = Date.now();
  const items = (payload.input ?? []).map(item => { const text = JSON.stringify(item); return [item.type ?? item.role ?? '?', text.length, sha(text).slice(0, 12)]; });
  const prev = previousItems.get(payload.model);
  let firstDiff = null;
  if (prev) {
    firstDiff = Math.min(prev.length, items.length);
    for (let i = 0; i < firstDiff; i++) if (prev[i][2] !== items[i][2]) { firstDiff = i; break; }
  }
  previousItems.set(payload.model, items);
  const instructions = payload.instructions ?? '';
  const tools = JSON.stringify(payload.tools ?? []);
  jsonl(path.join(out, 'requests.jsonl'), { seq: ++requestSequence, step: currentStep(), task, time: now, gapMs: lastRequestTime === null ? null : now - lastRequestTime, model: payload.model,
    promptCacheKey: payload.prompt_cache_key, instructionsChars: instructions.length, instructionsSha: sha(instructions).slice(0, 12), toolsChars: tools.length, toolsSha: sha(tools).slice(0, 12),
    itemCount: items.length, firstDiff, charsBeforeDiff: firstDiff === null ? null : items.slice(0, firstDiff).reduce((sum, item) => sum + item[1], 0),
    appendOnly: prev ? firstDiff === prev.length : null, items });
  lastRequestTime = now;
};
// WebSocket counters of the session, as the change since the previous assistant message.
let lastWebsocket = {};
let connectionOpenedAt = null;
const websocketDelta = sessionId => {
  const stats = codexApi.getOpenAICodexWebSocketDebugStats(sessionId);
  if (!stats) return null;
  const delta = {};
  for (const [key, value] of Object.entries(stats)) if (typeof value === 'number') delta[key] = value - (lastWebsocket[key] ?? 0);
  if (delta.connectionsCreated > 0) connectionOpenedAt = Date.now();
  lastWebsocket = stats;
  return { delta, connectionAgeMs: connectionOpenedAt === null ? null : Date.now() - connectionOpenedAt, lastDeltaInputItems: stats.lastDeltaInputItems ?? null };
};
const observer = {
  name: 'policy-pilot-observer',
  factory(pi) {
    pi.on('session_start', (_event, ctx) => {
      jsonl(traceFile, { kind: 'session_start', sessionId: ctx.sessionManager.getSessionId(), extensions: extensionPaths, activeTools: pi.getActiveTools(), labConfig: ctx.sessionManager.getBranch().filter(e => e.customType === 'context-prune-lab-event' && e.data?.phase === 'session').map(e => e.data.config) });
    });
    pi.on('before_agent_start', (event) => {
      task++;
      jsonl(traceFile, { kind: 'prompt', task, step: currentStep(), continuation: typeof event.prompt === 'string' ? event.prompt.startsWith('[pi-midrun-compact/') : null, time: Date.now(), systemPromptSha256: crypto.createHash('sha256').update(event.systemPrompt).digest('hex'), progressSectionPresent: event.systemPrompt.includes('## 十、进度与收尾'), periodicPruneGuidePresent: event.systemPrompt.includes('8–10') || event.systemPrompt.includes('8-10') });
    });
    pi.on('context', (event, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      const original = new Map(branch.filter(e => e.type === 'message' && e.message?.role === 'toolResult').map(e => [e.message.toolCallId, e.message]));
      const calls = new Map(branch.filter(e => e.type === 'message' && e.message?.role === 'assistant').flatMap(e => (Array.isArray(e.message.content) ? e.message.content : []).filter(b => b.type === 'toolCall').map(b => [b.id, b])));
      const tools = event.messages.filter(m => m.role === 'toolResult');
      const pruned = tools.filter(m => m.content?.some(b => b.type === 'text' && /^(\[pi-context-prune\]|\[pruned:)/.test(b.text ?? '')));
      const checks = [];
      for (const result of tools) {
        const raw = original.get(result.toolCallId);
        const call = calls.get(result.toolCallId);
        const name = String(call?.arguments?.path ?? call?.args?.path ?? '').replaceAll('\\', '/');
        if (raw && (raw.content?.some(b => b.type === 'image') || /(^|\/)(SKILL\.md|skills\/)/i.test(name))) {
          checks.push({ id: result.toolCallId, path: name, image: raw.content.some(b => b.type === 'image'), unchanged: JSON.stringify(raw.content) === JSON.stringify(result.content) });
        }
      }
      if (checks.some(check => !check.unchanged)) {
        fs.writeFileSync(path.join(out, 'CONTROL_STOP'), 'Protected result changed at request boundary');
        throw new Error('Protected result changed at request boundary');
      }
      jsonl(traceFile, { kind: 'context', task, step: currentStep(), time: Date.now(), request: ++requests, messages: event.messages.length, textChars: event.messages.reduce((sum, m) => sum + (Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n').length : typeof m.content === 'string' ? m.content.length : 0), 0), prunedIds: pruned.map(m => m.toolCallId), protectedChecks: checks });
    });
    pi.on('before_provider_request', event => {
      const encoded = JSON.stringify(event.payload);
      jsonl(traceFile, { kind: 'provider_request', task, time: Date.now(), bytes: Buffer.byteLength(encoded), payloadSha256: crypto.createHash('sha256').update(encoded).digest('hex') });
      if (prodSettings) recordRequest(event.payload);
    });
    pi.on('after_provider_response', event => {
      if (!prodSettings) return;
      const limits = Object.fromEntries(Object.entries(event.headers ?? {}).filter(([key]) => /ratelimit|retry-after|x-codex|usage/i.test(key)));
      jsonl(path.join(out, 'responses.jsonl'), { seq: requestSequence, step: currentStep(), time: Date.now(), status: event.status, limits });
    });
    pi.on('message_end', (event, ctx) => {
      const message = event.message;
      if (message.role === 'assistant') {
        jsonl(path.join(out, 'usage.jsonl'), { task, step: currentStep(), request: requests, time: Date.now(), model: message.model, provider: message.provider, responseId: message.responseId, stopReason: message.stopReason, errorMessage: message.errorMessage, usage: message.usage, ...(prodSettings ? { websocket: websocketDelta(ctx.sessionManager.getSessionId()) } : {}) });
      }
    });
  },
};
const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
  // The bash tool needs the shell the real settings name; without it Pi looks only in Program Files and PATH.
  const shellPath = JSON.parse(fs.readFileSync(path.join(realAgent, 'settings.json'), 'utf8')).shellPath;
  const real = JSON.parse(fs.readFileSync(path.join(realAgent, 'settings.json'), 'utf8'));
  // --prod-settings: production reserve and retry policy; compaction itself runs through pi-midrun-compact.
  const compaction = prodSettings ? { enabled: false, reserveTokens: real.compaction.reserveTokens } : { enabled: false };
  const retry = prodSettings ? real.retry : { enabled: false, provider: { maxRetries: 0, timeoutMs: 120000 } };
  const settingsManager = SettingsManager.inMemory({ ...(shellPath ? { shellPath } : {}), packages: [], compaction, retry, cacheWarming: 'off', transport: 'auto', enableInstallTelemetry: false });
  const resourceLoaderOptions = { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: extensionPaths, extensionFactories: [observer], appendSystemPromptOverride: () => [fs.readFileSync(path.join(agentDir, 'APPEND_SYSTEM.md'), 'utf8')], agentsFilesOverride: () => ({ agentsFiles: [] }) };
  const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime, resourceLoaderOptions });
  const resourceLoader = services.resourceLoader;
  const built = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: value('--thinking'), tools: value('--tools').split(',') });
  if (built.extensionsResult.errors.length) throw new Error(JSON.stringify(built.extensionsResult.errors));
  const loadedPaths = built.extensionsResult.extensions.map(e => e.resolvedPath ?? e.path);
  if (loadedPaths.length !== extensionPaths.length + 1 || !extensionPaths.every(expected => loadedPaths.some(actual => path.resolve(actual).toLowerCase() === path.resolve(expected).toLowerCase()))) throw new Error(`Extension loading mismatch: ${JSON.stringify(loadedPaths)}`);
  jsonl(traceFile, { kind: 'runtime', settings: { compaction, retry }, model: { provider: model.provider, id: model.id, contextWindow: model.contextWindow, input: model.input, costRates: model.cost }, thinkingLevel: value('--thinking'), settingsInMemory: true, discoveredContextFiles: resourceLoader.getAgentsFiles().agentsFiles.length, extensionPaths: built.extensionsResult.extensions.map(e => e.path) });
  return { ...built, services, diagnostics: services.diagnostics };
};
const runtime = await createAgentSessionRuntime(createRuntime, { cwd: process.cwd(), agentDir, sessionManager: SessionManager.create(process.cwd(), value('--session-dir')) });
await runRpcMode(runtime);
