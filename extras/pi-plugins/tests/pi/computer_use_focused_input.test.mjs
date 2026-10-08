import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const packageRoot = resolve(process.env.CU_CANDIDATE_DIR ?? resolve(homedir(), '.pi/agent/npm/node_modules/@injaneity/pi-computer-use'));
// 安装目录在 node_modules 下，Node 不剥离那里的 TypeScript；用 Pi 自带的 jiti 加载。
const piRoot = resolve(process.env.APPDATA ?? resolve(homedir(), 'AppData/Roaming'), 'npm/node_modules/@earendil-works/pi-coding-agent');
const { createJiti } = createRequire(resolve(piRoot, 'package.json'))('jiti');
const { prepareAction } = await createJiti(import.meta.url).import(resolve(packageRoot, 'src/actions.ts'));
const source = readFileSync(resolve(packageRoot, 'src/bridge.ts'), 'utf8');
const start = source.indexOf('async function dispatchUiAction(');
const end = source.indexOf('\nfunction aggregateExecutions(', start);
assert(start >= 0 && end > start);
const transactionSource = source.slice(start, end);

function transaction(code) {
  const delivered = [];
  const env = {
    headless: false,
    image: { width: 800, height: 600 },
    node: () => ({ wireRef: 'native-editor', isTextInput: true, actions: [], rect: { x: 5, y: 5, width: 50, height: 20 } }),
    center: () => ({ x: 30, y: 15 }),
    validatePoint: () => {},
  };
  const context = {
    currentPlatformBackend: {},
    prepareUiAction: (action, state, _look, headless) => prepareAction(action, state, { ...env, headless }),
    helperAct: async (_target, action) => {
      delivered.push(action);
      return { outcome: 'worked', policy: 'foreground' };
    },
    aggregateExecutions: (steps) => ({ outcome: 'worked', steps }),
  };
  vm.createContext(context);
  vm.runInContext(`${stripTypeScriptTypes(code)}\nthis.run = dispatchUiTransaction;`, context);
  return { run: (actions, headless = false) => context.run(actions, {}, { image: env.image }, headless), delivered };
}

test('baseline rejects focused input in a new act_ui transaction', async () => {
  const old = transaction(transactionSource.replace('currentFocus: !headless', 'currentFocus: false'));
  await old.run([{ action: 'click', x: 50, y: 50 }]);
  await assert.rejects(old.run([{ action: 'typeText', text: 'APT140' }]), /requires either ref or both x and y/);
});

test('desktop preserves actual focus across separate click, type and Enter transactions', async () => {
  const fixed = transaction(transactionSource);
  await fixed.run([{ action: 'click', x: 50, y: 50 }]);
  await fixed.run([{ action: 'typeText', text: 'APT140' }]);
  await fixed.run([{ action: 'keypress', keys: ['ENTER'] }]);
  assert.equal(fixed.delivered.length, 3);
  for (const action of fixed.delivered.slice(1)) {
    assert.equal(action.usesCurrentFocus, true);
    assert.deepEqual(JSON.parse(JSON.stringify(action.target)), { focus: { x: 400, y: 300 } });
  }
});

test('headless input still requires an explicit target', async () => {
  const fixed = transaction(transactionSource);
  await assert.rejects(fixed.run([{ action: 'keypress', keys: ['ENTER'] }], true), /requires either ref or both x and y/);
  assert.equal(fixed.delivered.length, 0);
});

test('explicit editor targets retain grounding and a later Enter uses current focus', async () => {
  const fixed = transaction(transactionSource);
  await fixed.run([{ action: 'typeText', ref: '@e2', text: 'APT140' }]);
  assert.equal(fixed.delivered[0].usesCurrentFocus, false);
  assert.deepEqual(JSON.parse(JSON.stringify(fixed.delivered[0].target)), { ref: 'native-editor' });
  await fixed.run([{ action: 'keypress', keys: ['ENTER'] }]);
  assert.equal(fixed.delivered[1].usesCurrentFocus, true);
});
