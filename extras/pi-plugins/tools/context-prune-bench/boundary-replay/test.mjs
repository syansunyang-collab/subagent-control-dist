import test from 'node:test';
import assert from 'node:assert/strict';
import { EffectiveChain } from './effective.mjs';
import { choose, productionChoice } from './candidate.mjs';
const full = input => ({ type: 'response.create', model: 'gpt-6-sol', input });
const completed = (id, output = []) => ({ type: 'response.completed', response: { id, status: 'completed', output } });
test('adjacent effective WS input tracks response output, not the last full frame; reset and failures', () => {
  const chain = new EffectiveChain();
  const a = [{ role: 'user', content: 'a' }], output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'b' }] }];
  chain.request(full(a)); chain.response(completed('one', output));
  const delta = { ...full([{ role: 'user', content: 'c' }]), previous_response_id: 'one' };
  const before = JSON.stringify(delta);
  assert.deepEqual(chain.request(delta), { status: 'delta', inputCount: 3, inputBytes: Buffer.byteLength(JSON.stringify([...a, ...output, ...delta.input])),
    firstDiff: 1, previousItems: 1, frameHash: chain.pending.row.frameHash,
    effectiveHash: chain.pending.row.effectiveHash, prefixBytes: Buffer.byteLength(JSON.stringify(a[0])) });
  assert.equal(JSON.stringify(delta), before);
  chain.response(completed('two', []));
  const changed = [a[0], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'changed' }] }, delta.input[0]];
  assert.equal(chain.request(full(changed)).firstDiff, 1); // adjacent effective input, not old full frame
  chain.response(completed('three'));
  assert.equal(chain.request({ ...full([]), previous_response_id: 'missing' }).status, 'missing-parent');
  chain.response(completed('four'));
  chain.request(full(a)); chain.response({ type: 'response.failed', response: { id: 'bad', status: 'failed' } });
  assert.equal(chain.request({ ...full([]), previous_response_id: 'bad' }).status, 'failed-parent');
});
test('boundary cannot use future or changed prefix and retains newest two turns', () => {
  const branch = Array.from({ length: 5 }, (_, i) => [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name: 'fixed_observation', arguments: {} }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: `c${i}`, content: [{ type: 'text', text: 'x'.repeat(12000) }] } }]).flat();
  const input = { settings: { model: 'gpt-6-sol' }, input: [{ role: 'user', content: 'stable' }, ...Array.from({ length: 5 }, (_, i) => ({ type: 'function_call_output', call_id: `c${i}`, output: 'x'.repeat(12000) }))] };
  const args = { input, branch, seenIds: new Set(['c0', 'c1', 'c2', 'c3', 'c4']), visibleIds: new Set(['c0', 'c1', 'c2', 'c3', 'c4']), releasedIds: new Set(), triggerTokens: 100 };
  assert.deepEqual(productionChoice(args), ['c0']);
  assert.equal(choose({ ...args, successfulInputs: [] }).reason, 'no-matching-successful-prefix');
  assert.equal(choose({ ...args, successfulInputs: [{ ...input, input: [{ role: 'user', content: 'different' }] }] }).reason, 'no-matching-successful-prefix');
  const selected = choose({ ...args, successfulInputs: [{ ...input, input: input.input.slice(0, 1) }] });
  assert.equal(selected.reason, 'selected'); assert.deepEqual(selected.selected, ['c0']);
});
