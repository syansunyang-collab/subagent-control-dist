import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { legacyTargets } from '../../tools/pi-transcript-hydrate/apply.mjs';

// Integration with the installed SDK and real consumer; no Claude process or paid request.
const sdk = process.env.PI_TEST_SDK_ROOT ?? join(homedir(), 'AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent');
const provider = process.env.PI_TEST_CLAUDE_PROVIDER_ROOT ?? legacyTargets[0].root;
const req = createRequire(join(sdk, 'package.json'));
const aiPath = join(sdk, 'node_modules/@earendil-works/pi-ai/dist/index.js');
const ai = await import(pathToFileURL(aiPath));
const { createJiti } = req('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  '@earendil-works/pi-ai': aiPath,
  '@earendil-works/pi-coding-agent': join(sdk, 'dist/index.js'),
} });
const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const canonical = join(repo, 'tools/pi-transcript-hydrate/claude-transcript-compat.ts');
const { hydrateContext } = await jiti.import(canonical);
const tool = name => ({ name, description: 'synthetic fixture', parameters: { type: 'object', properties: {} } });
const legacy = { systemPrompt: 'ORIGINAL', tools: [tool('old_tool')], messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] };
const transcript = ai.normalizeContext(legacy);

// Actual transcript semantics include explicit empty prompt and removal of the final tool.
const updated = { messages: [...transcript.messages,
  { role: 'system', content: '', sections: { task: 'UPDATED' }, toolsAdded: [tool('new_tool')], toolsRemoved: [tool('old_tool')], timestamp: 2 },
] };

test('Claude adapter preserves legacy, latest transcript state, idempotence and source history', () => {
  const original = structuredClone(updated);
  assert.deepEqual(hydrateContext(legacy), legacy);
  const hydrated = hydrateContext(updated);
  assert.equal(hydrated.systemPrompt, 'ORIGINAL\n\nUPDATED');
  assert.deepEqual(hydrated.tools.map(t => t.name), ['new_tool']);
  assert.deepEqual(hydrated.messages, legacy.messages);
  assert.deepEqual(hydrateContext(hydrated), hydrated);
  assert.deepEqual(updated, original);
  const removed = hydrateContext({ messages: [...updated.messages,
    { role: 'system', content: '', sections: { task: null }, toolsRemoved: [tool('new_tool')], timestamp: 3 },
  ] });
  assert.equal(removed.systemPrompt, 'ORIGINAL');
  assert.deepEqual(removed.tools, []);
  const empty = hydrateContext({ messages: [...ai.normalizeContext({ ...legacy, systemPrompt: '' }).messages,
    { role: 'system', content: '', toolsRemoved: [tool('old_tool')], timestamp: 3 },
  ] });
  assert.equal(empty.systemPrompt, '');
  assert.deepEqual(empty.tools, []);
  assert.deepEqual(hydrateContext(empty), empty);
});

test('real Claude consumers: raw transcript is rejected, native hydration reaches the launch boundary', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-transcript-regression-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const providerSrc = join(dir, 'src');
  await cp(join(provider, 'src'), providerSrc, { recursive: true });
  // >=0.4.0 dropped src/transcript-compat.ts: provider.ts recovers systemPrompt/tools from
  // the transcript itself (recoverProviderContext), so there is no separate old/broken vs
  // repaired helper file to swap in here anymore. What this still has to prove is the same
  // contract the tool protects: the low-level serializer rejects a raw, unhydrated transcript,
  // and our canonical hydrateContext still produces a shape the installed serializer accepts.
  const { prepareRequestWithLimits } = await jiti.import(join(providerSrc, 'context-serializer.ts'));
  await assert.rejects(prepareRequestWithLimits(transcript, {}, dir), /Unsupported Pi message role: system/);
  const prepared = await prepareRequestWithLimits(hydrateContext(updated), {}, dir);
  assert.equal(await readFile(prepared.systemPromptPath, 'utf8'), 'ORIGINAL\n\nUPDATED');
  assert.match(await readFile(prepared.catalogPath, 'utf8'), /new_tool/);
  assert.doesNotMatch(await readFile(prepared.catalogPath, 'utf8'), /old_tool/);
  assert.deepEqual(prepared.transcriptBlocks.slice(1).map(s => JSON.parse(s).role), ['user']);
  await rm(prepared.directory, { recursive: true, force: true });

  const { createClaudeStream } = await jiti.import(join(providerSrc, 'provider.ts'));
  const { resolveSession } = await jiti.import(join(providerSrc, 'session-registry.ts'));
  // >=0.4.0 also refuses to claim the launch for a tool-bearing request without a resolved
  // session (working_directory instead of borrowing another session's directory), so a session
  // must be registered the same way the real extension registers one before it will proceed.
  const sessionId = 'fixture-session';
  const sessions = new Map([[sessionId, { cwd: dir, imageStore: undefined, onRateLimitNotice: undefined }]]);
  let claimed = false;
  let preparedPrompt;
  const stream = createClaudeStream({ executable: 'MUST_NOT_LAUNCH', version: 'fixture' }, {
    claimLaunch: async () => { claimed = true; throw new Error('LOCAL_LAUNCH_BOUNDARY'); },
    cleanupDirectory: async directory => {
      preparedPrompt = await readFile(join(directory, 'system-prompt.txt'), 'utf8');
      await rm(directory, { recursive: true, force: true });
    },
    resolveSession: request => resolveSession(sessions, request),
  });
  const model = { id: 'claude-sonnet-4-6', name: 'fixture', api: 'claude-code', provider: 'fixture',
    reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let observed;
  const result = await stream(model, updated, { sessionId, onPayload: payload => {
    observed = structuredClone(payload);
    return { ...payload, systemPrompt: 'HOOK_OVERRIDE' };
  } }).result();
  assert(claimed, 'payload validation and preparation must both finish before launch');
  assert.match(result.errorMessage, /LOCAL_LAUNCH_BOUNDARY/);
  assert.equal(preparedPrompt, 'HOOK_OVERRIDE', 'second hydration preserves onPayload changes');
  assert.equal(observed.systemPrompt, 'ORIGINAL\n\nUPDATED');
  assert.deepEqual(observed.tools.map(t => t.name), ['new_tool']);
  assert.deepEqual(observed.messages.map(m => m.role), ['user']);
});
