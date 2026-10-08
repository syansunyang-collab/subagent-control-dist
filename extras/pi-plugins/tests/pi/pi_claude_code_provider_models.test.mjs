import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { defaultTarget, patchState, servedModels, status } from '../../tools/pi-claude-code-provider/manage.mjs';

// Runs against a temporary copy of the installed package; no Claude process or paid request.
const installed = process.env.PI_TEST_CLAUDE_PROVIDER_ROOT ?? defaultTarget();
const manage = join(import.meta.dirname, '../../tools/pi-claude-code-provider/manage.mjs');
const run = (...args) => spawnSync(process.execPath, [manage, ...args], { encoding: 'utf8' });
const usable = existsSync(installed) && status(installed, {}).version === '0.6.0' && patchState(installed) !== 'unknown';

test('local patch applies: full ids, plugin-authoring off, inline images; and reverts', { skip: !usable && `no patchable 0.6.0 install at ${installed}` }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-claude-models-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'pi-claude-code-provider');
  cpSync(installed, target, { recursive: true });
  if (patchState(target) === 'patched') assert.equal(run('rollback', '--target', target).status, 0);
  assert.equal(status(target, {}).patch, 'baseline');

  const applied = run('apply', '--target', target);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).changed, true);
  assert.equal(JSON.parse(run('apply', '--target', target).stdout).changed, false);

  const { providerModels } = await import(pathToFileURL(join(target, 'src/catalog.ts')));
  assert.deepEqual(providerModels().map((m) => [m.id, m.name, m.contextWindow, m.maxTokens, m.reasoning]), [
    ['claude-sonnet-5-5', 'Sonnet 5.5', 1_000_000, 128_000, true],
    ['claude-fable-5-1', 'Fable 5.1', 1_000_000, 64_000, true],
    ['claude-opus-5-5', 'Opus 5.5', 1_000_000, 128_000, true],
    ['claude-haiku-4-5', 'Haiku 4.5', 200_000, 32_000, false],
  ]);

  const { formatDoctorSummary } = await import(pathToFileURL(join(target, 'src/doctor.ts')));
  const verified = (component) => ({ component, current: 'x', verified: 'x', isVerified: true });
  const summary = formatDoctorSummary({
    platformStatus: verified('Platform'), piStatus: verified('Pi'), claudeStatus: verified('Claude Code'),
    installation: { executable: 'claude.exe', version: 'x', subscriptionType: 'max' },
    modelIds: providerModels().map((m) => m.id),
    modelVersions: { sonnet: 'claude-sonnet-5-5', fable: 'claude-fable-5-1', opus: 'claude-opus-6', haiku: 'claude-haiku-4-5' },
    runtimeCleanup: { removed: 0, failures: 0 },
  });
  assert.match(summary, /Served models \(Claude Code install\): sonnet claude-sonnet-5-5, fable claude-fable-5-1, opus claude-opus-6 \(picker still offers claude-opus-5-5\), haiku claude-haiku-4-5/);

  // Claude Code 2.1.292 loads this built-in plugin in print mode unless settings disable it.
  const { baseClaudeArgs } = await import(pathToFileURL(join(target, 'src/claude-args.ts')));
  const args = baseClaudeArgs();
  assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).enabledPlugins['plugin-authoring@builtin'], false);

  // Images travel inline after the record that names them; nothing is written for them.
  const { prepareRequest } = await import(pathToFileURL(join(target, 'src/context-serializer.ts')));
  const { providerArgs } = await import(pathToFileURL(join(target, 'src/claude-args.ts')));
  const png = (text) => ({ type: 'image', mimeType: 'image/png', data: Buffer.from(text).toString('base64') });
  const prepared = await prepareRequest({ messages: [
    { role: 'user', timestamp: 1, content: [{ type: 'text', text: 'look' }, png('first')] },
    { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: 'seen' }], api: 'x', provider: 'x', model: 'x', stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: 'user', timestamp: 3, content: [png('second'), png('first')] },
  ] });
  try {
    assert.deepEqual(readdirSync(prepared.directory).filter((name) => name.startsWith('image-')), []);
    const { prompt } = providerArgs(prepared, 'claude-sonnet-5-5', 'low');
    const decoded = (block) => Buffer.from(block.source.data, 'base64').toString();
    assert.deepEqual(prompt.map((block) => (block.type === 'image' ? `img:${decoded(block)}` : JSON.parse(block.text).role ?? 'header')),
      ['header', 'user', 'img:first', 'assistant', 'user', 'img:second', 'img:first']);
    // The breakpoint sits on the last record, not on a trailing image Claude Code re-encodes.
    const marked = prompt.filter((block) => block.cache_control);
    assert.equal(marked.length, 1);
    assert.equal(JSON.parse(marked[0].text).role, 'user');
    assert.equal(marked[0].cache_control.ttl, '1h');
    assert.equal(prompt.at(-1).cache_control, undefined);
    assert.equal(prepared.imageCount, 3);
    // Every inlined occurrence counts toward the size limit.
    assert.equal(prepared.imageBytes, 2 * Buffer.byteLength('first') + Buffer.byteLength('second'));
  } finally {
    rmSync(prepared.directory, { recursive: true, force: true });
  }

  assert.equal(run('rollback', '--target', target).status, 0);
  assert.deepEqual(status(target, {}).offered, ['sonnet', 'fable', 'opus', 'haiku']);
});

test('alias scan and stale-id report read the executable alias table', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-claude-aliases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'claude.bin');
  // provider_alias_targets tables name other ids and must not be read.
  writeFileSync(executable, Buffer.from(
    '\0provider_alias_targets:{opus:{default:"claude-opus-5"}}\0'
    + 'aliases:{opus:{default:"claude-opus-6",per_provider:{bedrock:"x"}},sonnet:{default:"claude-sonnet-5-5"},haiku:{default:"claude-haiku-4-5"},fable:{default:"claude-fable-5-1"}}\0',
    'latin1',
  ));
  assert.deepEqual(servedModels(executable), {
    opus: 'claude-opus-6', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5', fable: 'claude-fable-5-1',
  });
  const target = join(root, 'pi-claude-code-provider');
  mkdirSync(join(target, 'src'), { recursive: true });
  writeFileSync(join(target, 'package.json'), '{"version":"0.6.0"}');
  writeFileSync(join(target, 'src/catalog.ts'), 'providerModel("claude-sonnet-5-5", "Sonnet 5.5");\nproviderModel("claude-opus-5-5", "Opus 5.5");\n');
  assert.deepEqual(status(target, { PI_CLAUDE_CODE_PROVIDER_PATH: executable }).stale, [
    { alias: 'opus', offered: 'claude-opus-5-5', served: 'claude-opus-6' },
  ]);
});
