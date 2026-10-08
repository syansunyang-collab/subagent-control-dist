// Codex prompt-cache lab: an isolated Pi RPC session whose before_provider_request hook can stub one earlier
// tool output (counted in rounds back from the latest one) and merge extra fields into one request.
// Every request and response is logged to <out>/lab.jsonl: item count, eligible message endings, the edited
// item, extra fields sent, usage, stop reason and error text.
//
// Usage: node cache_lab.mjs --out <dir> --provider openai-codex --model gpt-6-luna --thinking low
//          [--transport auto] [--schedule '[[12,3],[16,6]]'] [--persist '[[20,4]]'] [--once '[[24,18]]']
// Between requests the driver may write <out>/next.json ({"back": k} and/or {"extra": {...}}); it is applied to
// the next request and removed. Auth and models come from the real profile; settings are in memory.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const value = key => { const i = argv.indexOf(key); return i < 0 ? undefined : argv[i + 1]; };
const out = value('--out');
const schedule = new Map(JSON.parse(value('--schedule') || '[]'));
// --persist '[[fromRequest, outputIndex]]': from that request on, always stub the output with that absolute index.
// --once '[[request, outputIndex]]': stub that absolute output only in that request.
const persist = JSON.parse(value('--persist') || '[]');
const once = new Map(JSON.parse(value('--once') || '[]'));
const realAgent = path.join(path.dirname(path.dirname(process.env.APPDATA)), '.pi/agent');
const core = path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
const sdk = await import(pathToFileURL(path.join(core, 'dist/index.js')).href);
const { runRpcMode } = await import(pathToFileURL(path.join(core, 'dist/modes/rpc/rpc-mode.js')).href);
const { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, ModelRuntime } = sdk;
const modelRuntime = await ModelRuntime.create({ authPath: path.join(realAgent, 'auth.json'), modelsPath: path.join(realAgent, 'models.json'), modelsStorePath: path.join(realAgent, 'models-store.json'), allowModelNetwork: false });
const model = modelRuntime.getModel(value('--provider'), value('--model'));
if (!model || model.id !== value('--model')) throw new Error('Model identity mismatch');
fs.mkdirSync(out, { recursive: true });
const log = o => fs.appendFileSync(path.join(out, 'lab.jsonl'), JSON.stringify({ time: Date.now(), ...o }) + '\n');

/** Indexes of items that end an eligible message: user/developer messages and the last output of a tool group. */
const eligibleEndings = input => input.flatMap((item, i) => {
  if (item.type === 'function_call_output') return input[i + 1]?.type === 'function_call_output' ? [] : [i];
  if ((item.type === 'message' || item.type === undefined) && (item.role === 'user' || item.role === 'developer')) return [i];
  return [];
});

let requests = 0;
const lab = {
  name: 'cache-lab',
  factory(pi) {
    pi.on('before_provider_request', event => {
      requests++;
      const payload = structuredClone(event.payload);
      const input = payload.input ?? [];
      let next = {};
      const nextPath = path.join(out, 'next.json');
      if (fs.existsSync(nextPath)) { next = JSON.parse(fs.readFileSync(nextPath, 'utf8')); fs.rmSync(nextPath); }
      const back = next.back ?? schedule.get(requests);
      let edited = null;
      if (back !== undefined) {
        const outputs = input.flatMap((item, i) => item.type === 'function_call_output' ? [i] : []);
        const index = outputs[outputs.length - 1 - back];
        if (index !== undefined) { input[index] = { ...input[index], output: '[stubbed by cache lab]' }; edited = index; }
      }
      const outputsAbs = input.flatMap((item, i) => item.type === 'function_call_output' ? [i] : []);
      const stubAbs = index => { const at = outputsAbs[index]; if (at !== undefined) input[at] = { ...input[at], output: '[stubbed by cache lab]' }; return at; };
      const persisted = persist.filter(([from]) => requests >= from).map(([, index]) => stubAbs(index));
      if (once.has(requests)) edited = stubAbs(once.get(requests));
      if (next.extra) Object.assign(payload, next.extra);
      if (next.breakpointOnFirstUser) {
        const user = input.find(item => item.role === 'user' && Array.isArray(item.content));
        if (user) user.content[user.content.length - 1].prompt_cache_breakpoint = { mode: 'explicit' };
      }
      const endings = eligibleEndings(input);
      log({ kind: 'request', request: requests, items: input.length, endings: endings.length, back: back ?? null, edited, persisted,
        endingsAfterEdit: edited === null ? null : endings.filter(i => i >= edited).length,
        extra: next.extra ?? null, breakpointOnFirstUser: !!next.breakpointOnFirstUser });
      return payload;
    });
    pi.on('message_end', event => {
      const m = event.message;
      if (m.role === 'assistant') log({ kind: 'usage', request: requests, stopReason: m.stopReason, error: m.errorMessage ?? null,
        input: m.usage?.input, cacheRead: m.usage?.cacheRead, cacheWrite: m.usage?.cacheWrite, output: m.usage?.output });
    });
  },
};
const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const shellPath = JSON.parse(fs.readFileSync(path.join(realAgent, 'settings.json'), 'utf8')).shellPath;
  const settingsManager = SettingsManager.inMemory({ ...(shellPath ? { shellPath } : {}), packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', transport: value('--transport') || 'auto', enableInstallTelemetry: false });
  const services = await createAgentSessionServices({ cwd, agentDir: out, settingsManager, modelRuntime, resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [lab], agentsFilesOverride: () => ({ agentsFiles: [] }) } });
  return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: value('--thinking'), tools: ['bash'] })), services, diagnostics: services.diagnostics };
};
const runtime = await createAgentSessionRuntime(createRuntime, { cwd: process.cwd(), agentDir: out, sessionManager: SessionManager.create(process.cwd(), path.join(out, 'sessions')) });
await runRpcMode(runtime);
