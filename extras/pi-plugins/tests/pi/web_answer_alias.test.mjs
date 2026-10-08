import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { patchPage, patchFeatures, patchIndex, apply } from '../../tools/pi-web-answer-alias/apply.mjs';
const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sdk = join(homedir(), 'AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent');
const req = createRequire(join(sdk, 'package.json'));
const { createJiti } = req('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  '@earendil-works/pi-ai/compat': join(sdk, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
  '@earendil-works/pi-coding-agent': join(sdk, 'dist/index.js'),
} });
// 别名扩展归控制仓，测试读取控制仓 bootstrap 装好的副本。
const canonical = join(homedir(), '.pi/agent/extensions/openai-codex-sol-context-alias.ts');
const { rewriteCodexPayload, default: extension } = await jiti.import(canonical);

test('one mapper serves native turns and auxiliary requests without changing model objects', () => {
  const hooks = {};
  extension({ on: (event, handler) => { hooks[event] = handler; } });
  const native = hooks.before_provider_request;
  for (const [id, actual] of [['gpt-6-astra-500k', 'gpt-6-astra'], ['gpt-5.6-sol-500k', 'gpt-5.6-sol'], ['gpt-6.1-sol-500k', 'gpt-6.1-sol']]) {
    const model = { provider: 'openai-codex', id };
    const payload = { model: id, input: ['unchanged'] };
    const expected = { ...payload, model: actual };
    assert.deepEqual(rewriteCodexPayload(payload, model), expected);
    assert.deepEqual(native({ payload }, { model }), expected);
    assert.equal(model.id, id);
    assert.equal(payload.model, id);
  }
  assert.equal(rewriteCodexPayload({ model: 'gpt-6-astra-500k' }, { provider: 'xai' }), undefined);
  assert.equal(rewriteCodexPayload({ model: 'gpt-5.6-luna' }, { provider: 'openai-codex' }), undefined);
});

test('real answerFromPage injects request-only alias and retains selected-model checks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-answer-alias-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agent = join(dir, 'agent');
  const pkg = join(agent, 'npm/node_modules/pi-web-access');
  await mkdir(pkg, { recursive: true });
  await mkdir(join(agent, 'extensions'), { recursive: true });
  await cp(canonical, join(agent, 'extensions/openai-codex-sol-context-alias.ts'));
  const installed = join(homedir(), '.pi/agent/npm/node_modules/pi-web-access');
  const source = await readFile(join(installed, 'page-query.ts'), 'utf8');
  const patched = patchPage(source);
  assert.equal(patchPage(patched), patched);
  assert.throws(() => patchPage('unknown version'), /Unrecognized/);
  await writeFile(join(pkg, 'page-query.ts'), patched);
  await cp(join(installed, 'summary-model-scope.ts'), join(pkg, 'summary-model-scope.ts'));
  await writeFile(join(pkg, 'index.ts'), patchIndex(await readFile(join(installed, 'index.ts'), 'utf8')));
  const configPath = join(dir, 'web-search.json');
  await writeFile(join(pkg, 'feature-config.ts'), patchFeatures(await readFile(join(installed, 'feature-config.ts'), 'utf8')));
  await writeFile(join(pkg, 'utils.ts'), `export function getWebSearchConfigPath() { return ${JSON.stringify(configPath)}; }`);
  assert.equal(apply(agent).changed, false);
  await mkdir(join(dir, '.pi'), { recursive: true });
  await writeFile(join(dir, '.pi/settings.json'), JSON.stringify({ enabledModels: ['*'] }));
  const { answerFromPage } = await jiti.import(join(pkg, 'page-query.ts'));
  const astra = { provider: 'openai-codex', id: 'gpt-6-astra-500k', input: ['text'], contextWindow: 500000 };
  const sol = { ...astra, id: 'gpt-5.6-sol-500k' };
  const luna = { ...astra, id: 'gpt-5.6-luna' };
  const ctx = { model: astra, cwd: dir, isProjectTrusted: () => true, modelRegistry: {
    find: (_p, id) => [luna, sol, astra].find(m => m.id === id),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'local-fixture-only' }),
  } };
  const request = { question: 'What is the value?', pageText: 'value=42', sourceUrl: 'https://example.invalid/fixture' };
  const seen = [];
  const fakeComplete = async (model, context, options) => {
    const payload = { model: model.id };
    seen.push([(options.onPayload(payload) ?? payload).model, options.reasoning]);
    assert.match(context.systemPrompt, /only the supplied page content/);
    return { stopReason: 'stop', content: [{ type: 'text', text: '42' }] };
  };
  const result = await answerFromPage(request, ctx, undefined, fakeComplete);
  await assert.rejects(answerFromPage(request, ctx, undefined, async () => ({
    stopReason: 'length', content: [{ type: 'text', text: 'unfinished answer' }],
  })), /truncated by the output limit/);
  assert.equal(result.model, 'openai-codex/gpt-5.6-luna');
  await answerFromPage({ ...request, model: 'openai-codex/gpt-6-astra-500k' }, ctx, undefined, fakeComplete);
  await answerFromPage({ ...request, model: 'openai-codex/gpt-5.6-sol-500k' }, ctx, undefined, fakeComplete);
  assert.deepEqual(seen, [['gpt-5.6-luna', 'low'], ['gpt-6-astra', 'low'], ['gpt-5.6-sol', 'low']]);
  for (const reasoning of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
    await writeFile(configPath, JSON.stringify({ image: { enabled: false }, pageAnswer: { model: 'openai-codex/gpt-5.6-sol-500k', reasoning } }));
    await answerFromPage(request, ctx, undefined, fakeComplete);
    assert.deepEqual(seen.at(-1), ['gpt-5.6-sol', reasoning]);
  }
  await writeFile(configPath, JSON.stringify({ pageAnswer: { reasoning: 'invalid' } }));
  await assert.rejects(answerFromPage(request, ctx, undefined, fakeComplete), /pageAnswer.reasoning/);
  await writeFile(configPath, '{}');
  await writeFile(join(dir, '.pi/settings.json'), JSON.stringify({ enabledModels: ['openai-codex/gpt-6-astra-500k'] }));
  await assert.rejects(answerFromPage({ ...request, model: 'openai-codex/gpt-5.6-sol-500k' }, ctx, undefined, fakeComplete), /not enabled/);
});

test('patchFeatures injects getPageAnswerDefaults into an unpatched anchor and stays idempotent', () => {
  const fresh = 'type FeatureConfig = { image?: { enabled?: unknown } };\n';
  const once = patchFeatures(fresh);
  assert.match(once, /export function getPageAnswerDefaults/);
  assert.equal(patchFeatures(once), once);
});
