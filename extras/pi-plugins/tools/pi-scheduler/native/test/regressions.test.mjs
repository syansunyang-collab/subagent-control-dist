import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import core from '../extensions/scheduler/core.cjs';
import shell from '../extensions/scheduler/shell.cjs';
const now = new Date('2026-09-21T00:00:00Z');
const due = new Date(now.getTime() + 1000);
function task(extra = {}) {
  const r = core.createTask({ kind: 'command', command: 'echo test', after: '1s', wakeOn: 'never', sessionFile: 'test', ...extra }, now);
  assert.equal(r.ok, true, r.error);
  return r.task;
}
function fixture(t) {
  const root = resolve('test-results/pi-scheduler-native-fix-20260923/executor');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(join(root, 'fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function worker(t, dir, paused = false) {
  const p = fork(new URL('./lock-worker.cjs', import.meta.url), [join(dir, 'task.lock'), ...(paused ? [join(dir, 'ready'), join(dir, 'resume')] : [])], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(async () => {
    if (p.exitCode !== null || p.signalCode !== null) return;
    const exited = once(p, 'exit');
    p.kill();
    await exited;
  });
  return p;
}
async function send(p, message) {
  const answer = once(p, 'message');
  p.send(message);
  return (await answer)[0];
}
async function waitFor(file) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`test barrier missing: ${file}`);
    await new Promise(r => setTimeout(r, 10));
  }
}
test('F1 running command label edit preserves claim and settles once', async t => {
  const dir = fixture(t);
  const store = core.createStateStore({ stateFile: join(dir, 'tasks.json') });
  const value = task();
  store.updateSync(s => s.tasks.push(value));
  let runs = 0;
  let snapshot;
  const execute = async () => {
    runs++;
    store.updateSync(s => {
      const before = structuredClone(s.tasks[0]);
      const update = core.updateTask(s.tasks[0], { label: 'renamed' }, due);
      snapshot = { before, after: structuredClone(s.tasks[0]), update };
    });
    return { ok: true, code: 0 };
  };
  const result = await core.runDueTaskOnce({ store, taskId: value.id, now: due, execute });
  await core.runDueTaskOnce({ store, taskId: value.id, now: due, execute });
  assert.equal(snapshot.update.ok, true);
  assert.deepEqual(snapshot.after.claim, snapshot.before.claim);
  assert.equal(snapshot.after.revision, snapshot.before.revision);
  assert.equal(snapshot.after.status, 'running');
  assert.equal(result.status, 'executed');
  assert.equal(runs, 1);
  assert.equal(store.loadSync().tasks[0].status, 'done');
  assert.equal(store.loadSync().tasks[0].label, 'renamed');
});
test('F3 once-to-recurring needs valid budget and rejects atomically', () => {
  const value = task();
  const before = structuredClone(value);
  assert.equal(core.updateTask(value, { repeat: '10m', label: 'changed' }, due).ok, false);
  assert.deepEqual(value, before);
  for (const maxRuns of [1, 201, 2.5]) {
    assert.equal(core.updateTask(value, { repeat: '10m', maxRuns }, due).ok, false);
    assert.deepEqual(value, before);
  }
  assert.equal(core.updateTask(value, { repeat: '10m', maxRuns: 2 }, due).ok, true);
  assert.equal(value.maxRuns, 2);
  assert.equal(value.schedule.type, 'interval');
});
test('F2 stale takeover: paused A cannot overwrite live B; death releases ownership', { timeout: 20000 }, async t => {
  const dir = fixture(t);
  fs.writeFileSync(join(dir, 'task.lock'), JSON.stringify({ pid: 2147483647, attemptId: 'dead', heartbeatAtMs: 0 }));
  const a = worker(t, dir, true);
  const b = worker(t, dir);
  const aResult = send(a, 'acquire');
  await waitFor(join(dir, 'ready'));
  const bResult = await send(b, 'acquire');
  assert.equal(bResult.acquired, true);
  fs.writeFileSync(join(dir, 'resume'), 'resume');
  assert.equal((await aResult).acquired, false, 'A must not steal B after a stale snapshot');
  assert.equal((await send(b, 'heartbeat')).heartbeat, true);
  const exited = once(b, 'exit');
  b.kill();
  await exited;
  assert.equal((await send(a, 'acquire')).acquired, true, 'kernel releases lock after owner death');
  assert.deepEqual(await send(a, 'release'), { released: true, heartbeat: false });
  assert.equal((await send(a, 'acquire')).acquired, true, 'explicit release permits reacquisition');
  assert.deepEqual(await send(a, 'release'), { released: true, heartbeat: false });
});
test('label edit preserves a waiting delivery; cancellation still clears it', () => {
  const value = task({ kind: 'wake', reason: 'check' });
  core.applyRunOutcome(value, { ok: true }, due);
  const delivery = structuredClone(value.pendingDelivery);
  const revision = value.revision;
  assert.equal(core.updateTask(value, { label: 'display' }, due).ok, true);
  assert.deepEqual(value.pendingDelivery, delivery);
  assert.equal(value.revision, revision);
  assert.equal(value.status, 'waiting');
  core.cancelTask(value, due);
  assert.equal(value.pendingDelivery, null);
  assert.equal(value.status, 'cancelled');
});
test('state lock releases on sync and async exceptions without unlinking its inode', async t => {
  const dir = fixture(t);
  const lockPath = join(dir, 'state.lock');
  assert.throws(() => core.withFileLockSync(lockPath, () => { throw new Error('sync failure'); }), /sync failure/);
  await assert.rejects(core.withFileLock(lockPath, async () => { throw new Error('async failure'); }), /async failure/);
  assert.equal(core.withFileLockSync(lockPath, () => 42), 42);
  assert.equal(fs.existsSync(lockPath), true);
  const lock = core.acquireTaskLock({ lockPath });
  assert.equal(lock.acquired, true);
  try {
    const contender = core.acquireTaskLock({ lockPath, now: new Date('2099-01-01'), ttlMs: 1, isPidAlive: () => false });
    assert.equal(contender.acquired, false, 'age and PID hints cannot evict a live owner');
    assert.equal(contender.release(), false);
    assert.equal(lock.heartbeat(), true);
  } finally { lock.release(); }
  assert.equal(lock.release(), false);
});
test('running non-label update is rejected and does not clear the claim', () => {
  const value = task();
  value.status = 'running';
  value.claim = { pid: 7, attemptId: 'live', heartbeatAt: due.toISOString() };
  const before = structuredClone(value);
  const rejected = core.updateTask(value, { repeat: '10m', maxRuns: 2 }, due);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /wait for it to finish or cancel/);
  assert.deepEqual(value, before);
  assert.equal(core.updateTask(value, { label: 'display' }, due).ok, true);
  assert.equal(value.status, 'running');
  assert.equal(value.claim.attemptId, 'live');
});
test('running command update does not drop the result or rerun', async t => {
  const dir = fixture(t);
  const store = core.createStateStore({ stateFile: join(dir, 'tasks.json') });
  const value = task({ wakeOn: 'never' });
  store.updateSync(s => s.tasks.push(value));
  let runs = 0;
  const execute = async () => {
    runs += 1;
    store.updateSync(s => {
      const update = core.updateTask(s.tasks[0], { repeat: '10m', maxRuns: 2 }, due);
      assert.equal(update.ok, false);
    });
    return { ok: true, code: 0, stdout: 'FIRST' };
  };
  const result = await core.runDueTaskOnce({ store, taskId: value.id, now: due, execute });
  await core.runDueTaskOnce({ store, taskId: value.id, now: due, execute });
  const saved = store.loadSync().tasks[0];
  assert.equal(result.status, 'executed');
  assert.equal(runs, 1);
  assert.equal(saved.lastRun.stdout, 'FIRST');
  assert.equal(saved.status, 'done');
});
test('killed host exec is a timeout even when the exit code was coerced to 0', async () => {
  const out = await shell.executeShellCommand({
    shellConfig: { ok: true, shell: 'bash', args: ['-lc'], commandTransport: 'argv' },
    command: 'sleep 5',
    cwd: '.',
    timeoutMs: 200,
    exec: async () => ({ code: 0, killed: true, stdout: '', stderr: '' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.killed, true);
  assert.equal(out.timedOut, true);
  assert.match(out.error, /timed out or was killed/);
  const value = task({ wakeOn: 'always' });
  core.applyRunOutcome(value, { kind: 'command', result: out }, due);
  const message = core.buildDeliveryMessage(value, value.pendingDelivery);
  assert.match(message, /timed out or was killed/);
  assert.doesNotMatch(message, /exit code 0/);
  assert.match(value.lastError, /timed out or was killed/);
});
test('pending deliveries count in-scope recurring command notifications', () => {
  const mine = task({ repeat: '10m', maxRuns: 3, wakeOn: 'failure', scope: 'session', sessionFile: 'mine' });
  const other = task({ repeat: '10m', maxRuns: 3, wakeOn: 'failure', scope: 'session', sessionFile: 'other' });
  for (const value of [mine, other]) core.applyRunOutcome(value, { kind: 'command', result: { ok: false, code: 1, error: 'boom' } }, due);
  assert.equal(mine.status, 'pending');
  assert.deepEqual(core.pendingDeliveryTasks([mine, other], { sessionFile: 'mine' }).map((value) => value.id), [mine.id]);
  const plan = core.planDelivery([mine, other], { idle: true, now: due, sessionFile: 'mine' });
  assert.equal(plan.taskId, mine.id);
  assert.equal(plan.details.pendingDeliveries, 1);
});
test('command repeat is armed when the command finishes, wake repeat waits for delivery', () => {
  const command = task({ repeat: '10m', maxRuns: 3, wakeOn: 'failure' });
  core.applyRunOutcome(command, { kind: 'command', result: { ok: false, code: 1, error: 'boom' } }, due);
  assert.equal(command.status, 'pending');
  assert.ok(command.pendingDelivery);
  assert.equal(command.nextRun, new Date(due.getTime() + 10 * 60 * 1000).toISOString());
  assert.equal(core.selectDueTasks([command], new Date(due.getTime() + 2 * 60 * 60 * 1000)).length, 1);
  const nextBeforeDelivery = command.nextRun;
  core.markDelivered(command, command.pendingDelivery.id, new Date(due.getTime() + 60 * 60 * 1000));
  assert.equal(command.nextRun, nextBeforeDelivery);
  assert.equal(command.pendingDelivery, null);
  const wake = task({ kind: 'wake', reason: 'check', repeat: '10m', maxRuns: 3 });
  const wakeNext = wake.nextRun;
  core.applyRunOutcome(wake, { kind: 'wake' }, due);
  assert.equal(wake.status, 'waiting');
  assert.equal(wake.nextRun, wakeNext);
  assert.equal(core.selectDueTasks([wake], new Date(due.getTime() + 2 * 60 * 60 * 1000)).length, 0);
  core.markDelivered(wake, wake.pendingDelivery.id, due);
  assert.equal(wake.status, 'pending');
  assert.equal(wake.nextRun, new Date(due.getTime() + 10 * 60 * 1000).toISOString());
});
test('recurring command delivery survives the production store roundtrip', async t => {
  const dir = fixture(t);
  const store = core.createStateStore({ stateFile: join(dir, 'tasks.json') });
  const value = task({ repeat: '10m', maxRuns: 3, wakeOn: 'failure', scope: 'global' });
  store.updateSync(s => s.tasks.push(value));
  const result = await core.runDueTaskOnce({
    store, taskId: value.id, now: new Date(value.nextRun),
    execute: async () => ({ ok: false, code: 1, stdout: 'FIRST_FAILURE' }),
  });
  assert.equal(result.status, 'executed');
  const raw = JSON.parse(fs.readFileSync(store.stateFile, 'utf8')).tasks[0];
  assert.equal(raw.status, 'pending');
  assert.ok(raw.pendingDelivery);
  const reopened = core.createStateStore({ stateFile: store.stateFile });
  assert.equal(reopened.loadSync().tasks[0].pendingDelivery?.id, raw.pendingDelivery.id);
  reopened.updateSync(s => {
    assert.deepEqual(core.pruneStaleDeliveries(s.tasks, due), []);
    const plan = core.planDelivery(s.tasks, { idle: true, now: due });
    assert.equal(plan.deliveryId, raw.pendingDelivery.id);
    assert.match(plan.message, /FIRST_FAILURE/);
    core.markDelivered(s.tasks[0], plan.deliveryId, new Date(due.getTime() + 3600000));
  });
  const delivered = reopened.loadSync().tasks[0];
  assert.equal(delivered.pendingDelivery, null);
  assert.equal(delivered.nextRun, raw.nextRun);
  assert.equal(delivered.runCount, 1);
});
test('undelivered command result survives the next claim, prune and non-waking completion', async t => {
  const dir = fixture(t);
  const store = core.createStateStore({ stateFile: join(dir, 'tasks.json') });
  const value = task({ repeat: '1s', maxRuns: 2, wakeOn: 'failure', scope: 'global' });
  core.applyRunOutcome(value, { kind: 'command', result: { ok: false, code: 1, stdout: 'FIRST_FAILURE' } }, due);
  const deliveryId = value.pendingDelivery.id;
  store.updateSync(s => s.tasks.push(value));
  const result = await core.runDueTaskOnce({
    store, taskId: value.id, now: new Date(due.getTime() + 1000),
    execute: async (_task, { heartbeat }) => {
      heartbeat();
      store.updateSync(s => {
        const running = s.tasks[0];
        const claim = structuredClone(running.claim);
        assert.equal(running.status, 'running');
        assert.equal(running.pendingDelivery?.id, deliveryId);
        assert.deepEqual(core.pruneStaleDeliveries(s.tasks, due), []);
        assert.equal(core.planDelivery(s.tasks, { idle: true, now: due }).deliveryId, deliveryId);
        assert.deepEqual(running.claim, claim);
        assert.equal(running.status, 'running');
      });
      return { ok: true, code: 0, stdout: 'SECOND_SUCCESS' };
    },
  });
  assert.equal(result.status, 'executed');
  assert.equal(result.outcome.result.stdout, 'SECOND_SUCCESS', result.outcome.result.error);
  store.updateSync(s => {
    const saved = s.tasks[0];
    assert.equal(saved.status, 'waiting');
    assert.equal(saved.runCount, 2);
    assert.equal(saved.lastRun.stdout, 'SECOND_SUCCESS');
    assert.deepEqual(core.pruneStaleDeliveries(s.tasks, due), []);
    const plan = core.planDelivery(s.tasks, { idle: true, now: due });
    assert.equal(plan.deliveryId, deliveryId);
    assert.match(plan.message, /FIRST_FAILURE/);
    assert.doesNotMatch(plan.message, /SECOND_SUCCESS/);
    assert.equal(plan.details.exitCode, 1);
    assert.equal(plan.details.ok, false);
    assert.equal(plan.details.runCount, 1);
    core.markDelivered(saved, deliveryId, due);
  });
  const final = store.loadSync().tasks[0];
  assert.equal(final.status, 'done');
  assert.equal(JSON.parse(fs.readFileSync(store.stateFile, 'utf8')).tasks[0].nextRun, null);
  assert.equal(final.pendingDelivery, null);
  assert.deepEqual(core.selectDueTasks([final], new Date('2099-01-01')), []);
});
test('exhausting an old notification preserves the active command result and remaining repeat', async t => {
  const dir = fixture(t);
  const store = core.createStateStore({ stateFile: join(dir, 'tasks.json') });
  const value = task({ repeat: '1s', maxRuns: 3, wakeOn: 'failure', scope: 'global' });
  core.applyRunOutcome(value, { kind: 'command', result: { ok: false, code: 1, stdout: 'FIRST_FAILURE' } }, due);
  const deliveryId = value.pendingDelivery.id;
  store.saveSync({ version: 1, tasks: [value] });
  let observed;
  const result = await core.runDueTaskOnce({
    store, taskId: value.id, now: new Date(value.nextRun),
    execute: async () => {
      for (let i = 0; i < core.MAX_DELIVERY_ATTEMPTS; i++) {
        store.updateSync(s => {
          const plan = core.planDelivery(s.tasks, { idle: true, now: due });
          assert.equal(plan.deliveryId, deliveryId);
          core.applyDeliveryObservation(s.tasks[0], plan.deliveryId, { startupError: 'host send startup rejected' }, due);
        });
      }
      store.updateSync(s => {
        const before = structuredClone(s.tasks[0]);
        const pruned = core.pruneStaleDeliveries(s.tasks, due);
        observed = { before, pruned, after: structuredClone(s.tasks[0]) };
      });
      return { ok: true, code: 0, stdout: 'SECOND_SUCCESS' };
    },
  });
  assert.equal(result.status, 'executed', result.reason);
  assert.deepEqual(observed.pruned, [{ taskId: value.id, deliveryId, reason: 'attempts-exhausted' }]);
  assert.equal(observed.after.pendingDelivery, null);
  assert.equal(observed.after.status, 'running');
  assert.deepEqual(observed.after.claim, observed.before.claim);
  assert.equal(observed.after.revision, observed.before.revision);
  assert.equal(observed.after.nextRun, observed.before.nextRun);
  assert.deepEqual(observed.after.lastRun, observed.before.lastRun);
  const reopened = core.createStateStore({ stateFile: store.stateFile });
  const saved = reopened.loadSync().tasks[0];
  assert.equal(saved.runCount, 2);
  assert.equal(saved.lastRun.stdout, 'SECOND_SUCCESS');
  assert.equal(saved.status, 'pending');
  assert.equal(saved.claim, null);
  assert.equal(saved.pendingDelivery, null);
  assert.equal(saved.lastError, null);
  const third = await core.runDueTaskOnce({
    store: reopened, taskId: value.id, now: new Date(saved.nextRun),
    execute: async () => ({ ok: true, code: 0, stdout: 'THIRD_SUCCESS' }),
  });
  assert.equal(third.status, 'executed');
  const final = JSON.parse(fs.readFileSync(store.stateFile, 'utf8')).tasks[0];
  assert.equal(final.runCount, 3);
  assert.equal(final.lastRun.stdout, 'THIRD_SUCCESS');
  assert.equal(final.status, 'done');
  assert.equal(final.nextRun, null);
});
test('pending command delivery exhaustion preserves the already armed next run', async t => {
  const dir = fixture(t);
  const store = core.createStateStore({ stateFile: join(dir, 'tasks.json') });
  const value = task({ repeat: '1s', maxRuns: 3, wakeOn: 'failure', scope: 'global' });
  core.applyRunOutcome(value, { kind: 'command', result: { ok: false, code: 1, stdout: 'FIRST_FAILURE' } }, due);
  store.saveSync({ version: 1, tasks: [value] });
  store.updateSync(s => {
    const pending = s.tasks[0];
    const before = structuredClone(pending);
    const deliveryId = pending.pendingDelivery.id;
    for (let i = 0; i < core.MAX_DELIVERY_ATTEMPTS; i++) {
      core.applyDeliveryObservation(pending, deliveryId, { startupError: 'host send startup rejected' }, due);
    }
    const later = new Date(due.getTime() + 3600000);
    assert.deepEqual(core.pruneStaleDeliveries(s.tasks, later), [{ taskId: value.id, deliveryId, reason: 'attempts-exhausted' }]);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.nextRun, before.nextRun);
    assert.equal(pending.revision, before.revision);
    assert.deepEqual(pending.claim, before.claim);
    assert.deepEqual(pending.lastRun, before.lastRun);
    assert.equal(pending.runCount, before.runCount);
    assert.equal(pending.pendingDelivery, null);
    assert.equal(core.planDelivery(s.tasks, { idle: true, now: later }), null);
  });
  const result = await core.runDueTaskOnce({
    store, taskId: value.id, now: new Date(value.nextRun),
    execute: async () => ({ ok: true, code: 0, stdout: 'SECOND_SUCCESS' }),
  });
  assert.equal(result.status, 'executed');
  const saved = store.loadSync().tasks[0];
  assert.equal(saved.runCount, 2);
  assert.equal(saved.lastRun.stdout, 'SECOND_SUCCESS');
  assert.equal(saved.status, 'pending');
});
test('waiting delivery exhaustion settles the execution outcome or schedules the remaining wake', async t => {
  const dir = fixture(t);
  const store = core.createStateStore({ stateFile: join(dir, 'tasks.json') });
  for (const kind of ['command', 'wake']) {
    for (const repeat of [undefined, '1s']) {
      for (const ok of kind === 'command' ? [true, false] : [true]) {
        const value = task({ kind, reason: 'check', repeat, maxRuns: repeat ? 2 : 1, wakeOn: 'always' });
        const outcome = kind === 'wake' ? { kind } : { kind, result: { ok, code: ok ? 0 : 1, stdout: 'FINAL_RESULT' } };
        for (let i = 0; i < value.maxRuns; i++) {
          core.applyRunOutcome(value, outcome, due);
          if (kind === 'wake' && i + 1 < value.maxRuns) core.markDelivered(value, value.pendingDelivery.id, due);
        }
        assert.equal(value.status, 'waiting');
        store.saveSync({ version: 1, tasks: [value] });
        const before = store.loadSync().tasks[0];
        const deliveryId = value.pendingDelivery.id;
        store.updateSync(s => {
          for (let i = 0; i < core.MAX_DELIVERY_ATTEMPTS; i++) {
            core.applyDeliveryObservation(s.tasks[0], deliveryId, { startupError: 'host send startup rejected' }, due);
          }
          assert.deepEqual(core.pruneStaleDeliveries(s.tasks, due), [{ taskId: value.id, deliveryId, reason: 'attempts-exhausted' }]);
        });
        const saved = JSON.parse(fs.readFileSync(store.stateFile, 'utf8')).tasks[0];
        assert.equal(saved.status, ok ? 'done' : 'failed');
        assert.equal(saved.pendingDelivery, null);
        assert.equal(saved.nextRun, null);
        assert.equal(saved.runCount, value.runCount);
        assert.deepEqual(saved.lastRun, value.lastRun);
        assert.equal(saved.deliveredAt, before.deliveredAt);
        assert.deepEqual(saved.lastDelivery, before.lastDelivery);
        assert.deepEqual(core.selectDueTasks([saved], new Date('2099-01-01')), []);
      }
    }
  }
  const wake = task({ kind: 'wake', reason: 'check', repeat: '1s', maxRuns: 2 });
  core.applyRunOutcome(wake, { kind: 'wake' }, due);
  store.saveSync({ version: 1, tasks: [wake] });
  const later = new Date(due.getTime() + 3600000);
  store.updateSync(s => {
    for (let i = 0; i < core.MAX_DELIVERY_ATTEMPTS; i++) {
      core.applyDeliveryObservation(s.tasks[0], wake.pendingDelivery.id, { startupError: 'host send startup rejected' }, due);
    }
    core.pruneStaleDeliveries(s.tasks, later);
  });
  const saved = store.loadSync().tasks[0];
  assert.equal(saved.status, 'pending');
  assert.equal(saved.pendingDelivery, null);
  assert.equal(saved.nextRun, new Date(later.getTime() + 1000).toISOString());
  const result = await core.runDueTaskOnce({ store, taskId: wake.id, now: new Date(saved.nextRun) });
  assert.equal(result.status, 'executed');
  assert.equal(store.loadSync().tasks[0].runCount, 2);
});
test('command delivery acknowledgement and dead-claim recovery do not invalidate execution', async t => {
  const dir = fixture(t);
  const store = core.createStateStore({ stateFile: join(dir, 'tasks.json') });
  const value = task({ repeat: '1s', maxRuns: 3, wakeOn: 'always', scope: 'global' });
  core.applyRunOutcome(value, { kind: 'command', result: { ok: true, code: 0 } }, due);
  value.status = 'running';
  value.claim = { pid: 424242, attemptId: 'dead' };
  const deliveryId = value.pendingDelivery.id;
  store.updateSync(s => s.tasks.push(value));
  store.updateSync(s => {
    assert.deepEqual(core.recoverInterruptedTasks(s.tasks, due, { isPidAlive: () => false }), [value.id]);
    assert.deepEqual(core.pruneStaleDeliveries(s.tasks, due), []);
    assert.equal(s.tasks[0].pendingDelivery.id, deliveryId);
  });
  const result = await core.runDueTaskOnce({
    store, taskId: value.id, now: new Date(due.getTime() + 1000),
    execute: async () => {
      store.updateSync(s => {
        const running = s.tasks[0];
        const before = structuredClone(running);
        assert.equal(core.markDelivered(running, deliveryId, due).ok, true);
        assert.equal(running.status, 'running');
        assert.deepEqual(running.claim, before.claim);
        assert.equal(running.revision, before.revision);
        assert.equal(running.nextRun, before.nextRun);
      });
      return { ok: true, code: 0, stdout: 'SECOND' };
    },
  });
  assert.equal(result.status, 'executed');
  assert.equal(result.outcome.result.stdout, 'SECOND', result.outcome.result.error);
  const saved = store.loadSync().tasks[0];
  assert.equal(saved.runCount, 2);
  assert.equal(saved.status, 'pending');
  assert.equal(saved.lastRun.stdout, 'SECOND');
  assert.ok(saved.pendingDelivery);
  assert.notEqual(saved.pendingDelivery.id, deliveryId);
  assert.deepEqual(core.pruneStaleDeliveries([saved], due), []);
});
test('busy recurring commands coalesce only waking results and invalidate explicit edits', async t => {
  const dir = fixture(t);
  const store = core.createStateStore({ stateFile: join(dir, 'tasks.json') });
  const value = task({ repeat: '1s', maxRuns: 3, wakeOn: 'failure', scope: 'global' });
  store.updateSync(s => s.tasks.push(value));
  let previousId;
  for (const stdout of ['FIRST_FAILURE', 'LATEST_FAILURE', 'FINAL_SUCCESS']) {
    const ok = stdout === 'FINAL_SUCCESS';
    const result = await core.runDueTaskOnce({
      store, taskId: value.id, now: new Date(store.loadSync().tasks[0].nextRun),
      execute: async () => ({ ok, code: ok ? 0 : 1, stdout }),
    });
    assert.equal(result.status, 'executed');
    store.updateSync(s => {
      const saved = s.tasks[0];
      assert.deepEqual(core.pruneStaleDeliveries(s.tasks, due), []);
      assert.equal(core.planDelivery(s.tasks, { idle: false, now: due }), null);
      if (ok) assert.equal(saved.pendingDelivery.id, previousId);
      else assert.notEqual(saved.pendingDelivery.id, previousId);
      previousId = saved.pendingDelivery.id;
    });
  }
  store.updateSync(s => {
    const saved = s.tasks[0];
    const plan = core.planDelivery(s.tasks, { idle: true, now: due });
    assert.match(plan.message, /LATEST_FAILURE/);
    assert.doesNotMatch(plan.message, /FIRST_FAILURE|FINAL_SUCCESS/);
    assert.equal(plan.details.runCount, 2);
    assert.equal(core.updateTask(saved, { label: 'display' }, due).ok, true);
    assert.equal(saved.pendingDelivery.id, previousId);
    assert.equal(core.updateTask(saved, { repeat: '2s', maxRuns: 4 }, due).ok, true);
    assert.equal(saved.pendingDelivery, null);
    assert.equal(core.planDelivery(s.tasks, { idle: true, now: due }), null);
  });
  for (const kind of ['command', 'wake']) {
    for (const status of ['pending', 'running', 'waiting', 'cancelled', 'paused', 'done', 'failed']) {
      const candidate = task({ kind, reason: 'check', repeat: '1s', maxRuns: 3, wakeOn: 'always' });
      core.applyRunOutcome(candidate, kind === 'wake' ? { kind } : { kind, result: { ok: true, code: 0 } }, due);
      candidate.status = status;
      candidate.claim = status === 'running' ? { pid: process.pid, attemptId: 'live' } : null;
      store.saveSync({ version: 1, tasks: [candidate] });
      const saved = store.loadSync().tasks[0];
      const allowed = status === 'waiting' || (kind === 'command' && ['pending', 'running'].includes(status));
      assert.equal(Boolean(saved.pendingDelivery), allowed, `${kind}/${status}`);
    }
  }
});
test('runDueTaskOnce recovers a dead running holder before executing', async t => {
  const dir = fixture(t);
  const store = core.createStateStore({ stateFile: join(dir, 'tasks.json') });
  const value = task({ wakeOn: 'never' });
  value.status = 'running';
  value.claim = { pid: 424242, attemptId: 'dead', startedAt: now.toISOString(), heartbeatAt: now.toISOString() };
  value.nextRun = due.toISOString();
  store.updateSync(s => s.tasks.push(value));
  let runs = 0;
  const skipped = await core.runDueTaskOnce({
    store,
    taskId: value.id,
    now: due,
    isPidAlive: () => true,
    execute: async () => { runs += 1; return { ok: true, code: 0 }; },
  });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'status-running');
  assert.equal(runs, 0);
  const taken = await core.runDueTaskOnce({
    store,
    taskId: value.id,
    now: due,
    isPidAlive: () => false,
    execute: async () => { runs += 1; return { ok: true, code: 0, stdout: 'TAKEN' }; },
  });
  assert.equal(taken.status, 'executed');
  assert.equal(runs, 1);
  assert.equal(store.loadSync().tasks[0].lastRun.stdout, 'TAKEN');
  assert.equal(core.selectDueTasks(store.loadSync().tasks, due).length, 0);
});
test('delivery advances only after the custom message is written; startup failure counts', () => {
  const value = task({ kind: 'wake', reason: 'check' });
  core.applyRunOutcome(value, { kind: 'wake' }, due);
  const deliveryId = value.pendingDelivery.id;
  assert.equal(core.applyDeliveryObservation(value, deliveryId, { written: false }, due).ok, false);
  assert.equal(value.status, 'waiting');
  assert.equal(value.pendingDelivery.attempts, 0);
  assert.equal(core.applyDeliveryObservation(value, deliveryId, { startupError: 'send did not start' }, due).ok, true);
  assert.equal(value.pendingDelivery.attempts, 1);
  assert.equal(value.status, 'waiting');
  const entries = [{ type: 'custom_message', customType: 'pi-scheduler', details: { deliveryId } }];
  assert.equal(core.deliveryWritten(entries, 'pi-scheduler', deliveryId), true);
  assert.equal(core.deliveryWritten([{ type: 'custom_message', customType: 'pi-scheduler', details: { deliveryId: 'other' } }], 'pi-scheduler', deliveryId), false);
  assert.equal(core.applyDeliveryObservation(value, deliveryId, { written: true }, due).ok, true);
  assert.equal(value.pendingDelivery, null);
  assert.equal(value.deliveredAt, due.toISOString());
});
test('interrupted claim recovers only when the owner is dead', () => {
  const value = task();
  value.status = 'running';
  value.claim = { pid: 123, attemptId: 'interrupted' };
  assert.deepEqual(core.recoverInterruptedTasks([value], due, { isPidAlive: () => true }), []);
  assert.deepEqual(core.recoverInterruptedTasks([value], due, { isPidAlive: () => false }), [value.id]);
  assert.equal(value.claim, null);
  assert.equal(value.status, 'pending');
});
