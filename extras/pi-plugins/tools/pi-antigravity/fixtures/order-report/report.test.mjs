import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { toCents } from './src/money.mjs';
import { summarize } from './src/report.mjs';

const orders = JSON.parse(fs.readFileSync(new URL('./样例订单 10月.json', import.meta.url), 'utf8'));
const paid = {
  orderCount: 3, itemCount: 6, totalCents: 2500,
  byCustomer: {
    '张三': { orders: 2, items: 5, totalCents: 2500 },
    '王五': { orders: 1, items: 1, totalCents: 0 },
  },
};

test('decimal price becomes integer cents', () => {
  assert.equal(toCents('12.35'), 1235);
  assert.equal(toCents('0.10'), 10);
  assert.equal(toCents(0), 0);
});
test('paid report counts quantities and free orders', () => assert.deepEqual(summarize(orders), paid));
test('status filter selects pending orders', () => assert.deepEqual(summarize(orders, 'pending'), {
  orderCount: 1, itemCount: 2, totalCents: 5000,
  byCustomer: { '王五': { orders: 1, items: 2, totalCents: 5000 } },
}));
test('empty input has zero totals', () => assert.deepEqual(summarize([]), {
  orderCount: 0, itemCount: 0, totalCents: 0, byCustomer: {},
}));
test('CLI accepts a Chinese filename containing spaces', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', '样例订单 10月.json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), paid);
});
test('CLI passes status and writes a UTF-8 output file', () => {
  const target = '待付款 报告.json';
  try {
    const result = spawnSync(process.execPath, ['cli.mjs', '样例订单 10月.json', '--status', 'pending', '--out', target], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), summarize(orders, 'pending'));
  } finally {
    fs.rmSync(path.resolve(target), { force: true });
  }
});
