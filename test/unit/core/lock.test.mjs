import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describe, it } from 'node:test';

import { EXIT } from '../../../src/cli/exit-codes.js';
import { HEARTBEAT_INTERVAL_MS, STALE_MARGIN_SEC, acquireGpuLock, describeGpuLock, isPidAlive, parseLockRecord, readGpuLock } from '../../../src/core/lock.js';
import { useSandbox } from '../../helpers/sandbox.mjs';

const ALIVE = () => true;
const GONE = () => false;

/**
 * A clock the test moves by hand, so no test waits for a real minute.
 * @param {number} [start]
 */
function createClock(start = Date.parse('2026-09-17T12:00:00.000Z')) {
  let value = start;
  return {
    now: () => value,
    advanceSec: (/** @type {number} */ seconds) => {
      value += seconds * 1000;
    },
  };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {string} label
 */
async function lockPathIn(t, label) {
  const sandbox = await useSandbox(t, label);
  return sandbox.path('state', 'gpu.lock');
}

describe('acquireGpuLock (spec 7.8)', () => {
  it('creates the lock file with the holder, and removes it on release', async (t) => {
    const lockPath = await lockPathIn(t, 'lock-basic');
    const clock = createClock();
    const lock = await acquireGpuLock({ lockPath, command: 'warm', timeoutSec: 600, waitSec: 0, heartbeatMs: 0, now: clock.now });
    assert.equal(lock.record.pid, process.pid);
    assert.equal(lock.record.command, 'warm');
    assert.equal(lock.record.timeoutSec, 600);
    assert.equal(lock.takeover, null);
    const written = parseLockRecord(await fs.readFile(lockPath, 'utf8'));
    assert.deepEqual(written, lock.record);
    lock.release();
    await assert.rejects(fs.access(lockPath));
    lock.release();
  });

  it('refuses a second holder and exits 6 after the wait', async (t) => {
    const lockPath = await lockPathIn(t, 'lock-busy');
    const clock = createClock();
    const first = await acquireGpuLock({ lockPath, command: 'bench', timeoutSec: 600, waitSec: 0, heartbeatMs: 0, now: clock.now });
    const error = await acquireGpuLock({ lockPath, command: 'delegate ask', timeoutSec: 600, waitSec: 0, heartbeatMs: 0, now: clock.now, isProcessAlive: ALIVE }).then(
      () => null,
      (thrown) => thrown,
    );
    assert.equal(error.exitCode, EXIT.LOCK_TIMEOUT);
    assert.equal(error.code, 'lock_timeout');
    assert.match(error.message, /held by bench/);
    assert.equal(error.data.holder.command, 'bench');
    first.release();
  });

  it('waits and takes the lock when the holder releases it', async (t) => {
    const lockPath = await lockPathIn(t, 'lock-wait');
    const first = await acquireGpuLock({ lockPath, command: 'warm', timeoutSec: 600, waitSec: 0, heartbeatMs: 0 });
    const pending = acquireGpuLock({ lockPath, command: 'delegate ask', timeoutSec: 600, waitSec: 5, pollMs: 10, heartbeatMs: 0 });
    setTimeout(() => first.release(), 30);
    const second = await pending;
    assert.equal(second.record.command, 'delegate ask');
    second.release();
  });

  it('takes over a lock whose process is gone, and says so', async (t) => {
    const lockPath = await lockPathIn(t, 'lock-dead-pid');
    await fs.mkdir(`${lockPath}/..`, { recursive: true });
    const clock = createClock();
    const first = await acquireGpuLock({ lockPath, command: 'bench', timeoutSec: 600, waitSec: 0, heartbeatMs: 0, now: clock.now });
    /** @type {Array<{ previous: any, reason: string }>} */
    const takeovers = [];
    const second = await acquireGpuLock({
      lockPath,
      command: 'warm',
      timeoutSec: 600,
      waitSec: 0,
      heartbeatMs: 0,
      now: clock.now,
      isProcessAlive: GONE,
      onTakeover: (previous, reason) => takeovers.push({ previous, reason }),
    });
    assert.equal(second.takeover?.previous?.command, 'bench');
    assert.match(/** @type {string} */ (second.takeover?.reason), /is gone/);
    assert.equal(takeovers.length, 1);
    second.release();
    // The first handle no longer owns the file, so releasing it must not remove someone else's lock.
    first.release();
  });

  it('takes over a lock whose heartbeat stopped for longer than the margin plus the command timeout', async (t) => {
    const lockPath = await lockPathIn(t, 'lock-stale-heartbeat');
    const clock = createClock();
    const first = await acquireGpuLock({ lockPath, command: 'delegate edit', timeoutSec: 600, waitSec: 0, heartbeatMs: 0, now: clock.now });
    clock.advanceSec(STALE_MARGIN_SEC + 600 - 1);
    assert.equal(readGpuLock(lockPath, { now: clock.now, isProcessAlive: ALIVE }).state, 'held');
    clock.advanceSec(2);
    const status = readGpuLock(lockPath, { now: clock.now, isProcessAlive: ALIVE });
    assert.equal(status.state, 'stale');
    const second = await acquireGpuLock({ lockPath, command: 'warm', timeoutSec: 60, waitSec: 0, heartbeatMs: 0, now: clock.now, isProcessAlive: ALIVE });
    assert.match(/** @type {string} */ (second.takeover?.reason), /no heartbeat/);
    second.release();
    first.release();
  });

  it('a heartbeat keeps the lock fresh', async (t) => {
    const lockPath = await lockPathIn(t, 'lock-heartbeat');
    const clock = createClock();
    const lock = await acquireGpuLock({ lockPath, command: 'bench', timeoutSec: 60, waitSec: 0, heartbeatMs: 0, now: clock.now });
    clock.advanceSec(STALE_MARGIN_SEC + 60 + 5);
    assert.equal(readGpuLock(lockPath, { now: clock.now, isProcessAlive: ALIVE }).state, 'stale');
    assert.equal(lock.heartbeat(), true);
    assert.equal(readGpuLock(lockPath, { now: clock.now, isProcessAlive: ALIVE }).state, 'held');
    lock.release();
    assert.equal(lock.heartbeat(), false, 'a released lock never writes again');
    assert.equal(HEARTBEAT_INTERVAL_MS, 10_000);
  });

  it('never removes a lock another command took over', async (t) => {
    const lockPath = await lockPathIn(t, 'lock-takeover-safety');
    const clock = createClock();
    const first = await acquireGpuLock({ lockPath, command: 'warm', timeoutSec: 600, waitSec: 0, heartbeatMs: 0, now: clock.now });
    const second = await acquireGpuLock({ lockPath, command: 'bench', timeoutSec: 600, waitSec: 0, heartbeatMs: 0, now: clock.now, isProcessAlive: GONE });
    first.release();
    const status = readGpuLock(lockPath, { now: clock.now, isProcessAlive: ALIVE });
    assert.equal(status.state, 'held');
    if (status.state === 'held') assert.equal(status.holder.command, 'bench');
    second.release();
  });

  it('stops waiting when the run is interrupted', async (t) => {
    const lockPath = await lockPathIn(t, 'lock-abort');
    const first = await acquireGpuLock({ lockPath, command: 'warm', timeoutSec: 600, waitSec: 0, heartbeatMs: 0 });
    const controller = new AbortController();
    const pending = acquireGpuLock({ lockPath, command: 'bench', timeoutSec: 600, waitSec: 30, pollMs: 10, heartbeatMs: 0, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('interrupted')), 20);
    await assert.rejects(pending, /interrupted/);
    first.release();
  });

  it('checks its arguments', async (t) => {
    const lockPath = await lockPathIn(t, 'lock-arguments');
    await assert.rejects(acquireGpuLock({ lockPath, command: 'warm', timeoutSec: -1, waitSec: 0 }), /timeoutSec/);
    await assert.rejects(acquireGpuLock({ lockPath, command: 'warm', timeoutSec: 60, waitSec: Number.NaN }), /waitSec/);
  });
});

describe('readGpuLock (spec 5.5 status)', () => {
  it('reports a free lock', async (t) => {
    const lockPath = await lockPathIn(t, 'lock-free');
    assert.deepEqual(readGpuLock(lockPath), { state: 'free' });
    assert.equal(describeGpuLock({ state: 'free' }), 'free');
  });

  it('treats a half-written file as being written, then as stale', async (t) => {
    const lockPath = await lockPathIn(t, 'lock-damaged');
    await fs.mkdir(`${lockPath}/..`, { recursive: true });
    await fs.writeFile(lockPath, '{"pid":');
    const clock = createClock();
    const fresh = readGpuLock(lockPath, { now: () => Date.now() });
    assert.equal(fresh.state, 'unreadable');
    const later = readGpuLock(lockPath, { now: () => Date.now() + 20_000 });
    assert.equal(later.state, 'stale');
    const taken = await acquireGpuLock({ lockPath, command: 'warm', timeoutSec: 60, waitSec: 0, heartbeatMs: 0, now: () => Date.now() + 20_000 });
    assert.equal(taken.takeover?.previous, null);
    taken.release();
    assert.equal(clock.now() > 0, true);
  });

  it('describes a holder in one line', async (t) => {
    const lockPath = await lockPathIn(t, 'lock-describe');
    const lock = await acquireGpuLock({ lockPath, command: 'delegate map', timeoutSec: 600, waitSec: 0, heartbeatMs: 0 });
    const status = readGpuLock(lockPath, { isProcessAlive: ALIVE });
    assert.match(describeGpuLock(status), /held by delegate map \(pid \d+\) since/);
    assert.match(describeGpuLock({ state: 'stale', holder: null, reason: 'the lock file is damaged' }), /stale \(the lock file is damaged\)/);
    assert.match(describeGpuLock({ state: 'unreadable', ageMs: 5 }), /being written/);
    lock.release();
  });
});

describe('parseLockRecord and isPidAlive', () => {
  it('accepts only a complete record', () => {
    const record = { pid: 1234, command: 'warm', startedAt: '2026-09-17T12:00:00.000Z', heartbeatAt: '2026-09-17T12:00:10.000Z', timeoutSec: 600, token: 'abc' };
    assert.deepEqual(parseLockRecord(JSON.stringify(record)), record);
    for (const broken of [
      '{',
      'null',
      '[]',
      JSON.stringify({ ...record, pid: 0 }),
      JSON.stringify({ ...record, token: '' }),
      JSON.stringify({ ...record, heartbeatAt: 'soon' }),
      JSON.stringify({ ...record, timeoutSec: 'long' }),
    ]) {
      assert.equal(parseLockRecord(broken), null, broken);
    }
  });

  it('knows this process is alive and that a made-up pid is not', () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-1), false);
    assert.equal(isPidAlive(Number.NaN), false);
  });
});
