// Reusing a pass, never reusing a block, and one evaluation for requests that arrive together (7.5).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGuardCache } from '../../../plugin/opencode-unity-lib/guard/cache.js';

/**
 * @param {{ pass?: boolean, cacheSec?: number }} [options]
 * @returns {import('../../../plugin/opencode-unity-lib/guard/decide.js').GuardVerdict}
 */
function verdict({ pass = true, cacheSec = 3 } = {}) {
  return /** @type {import('../../../plugin/opencode-unity-lib/guard/decide.js').GuardVerdict} */ ({
    verdict: pass ? 'pass' : 'blocked',
    pass,
    path: 'cold',
    mode: pass ? null : 'stop',
    reasons: [],
    notes: [],
    cacheSec: pass ? cacheSec : 0,
    checkedAt: '2026-09-17T12:00:00.000Z',
    target: { modelTag: 'ocu-model-16k', numCtx: 16384 },
    model: { loaded: false, state: 'not-listed', contextLength: null, expiresInSec: null, sizeVramMiB: 0, reclaimableMiB: 0, otherModels: [] },
    measurements: { gpu: null, unity: null, loadedModels: [] },
  });
}

function createClock(startMs = 1000) {
  let ms = startMs;
  return { now: () => ms, advance: (by) => (ms += by) };
}

describe('guard pass cache', () => {
  it('reuses a pass inside its cache time and measures again after it', async () => {
    const clock = createClock();
    let calls = 0;
    const cache = createGuardCache({
      now: clock.now,
      evaluate: async () => {
        calls += 1;
        return verdict({ cacheSec: 3 });
      },
    });
    assert.equal((await cache.check('key')).source, 'evaluated');
    clock.advance(2999);
    assert.equal((await cache.check('key')).source, 'cache');
    assert.equal(calls, 1);
    clock.advance(1);
    assert.equal((await cache.check('key')).source, 'evaluated');
    assert.equal(calls, 2);
  });

  it('counts the cache time from when the evaluation finished', async () => {
    const clock = createClock();
    const cache = createGuardCache({
      now: clock.now,
      evaluate: async () => {
        clock.advance(2500);
        return verdict({ cacheSec: 3 });
      },
    });
    await cache.check();
    clock.advance(2000);
    assert.equal((await cache.check()).source, 'cache');
  });

  it('never reuses a block and drops the stored pass', async () => {
    const clock = createClock();
    const answers = [verdict(), verdict({ pass: false }), verdict({ pass: false })];
    let index = 0;
    const cache = createGuardCache({ now: clock.now, evaluate: async () => answers[Math.min(index++, answers.length - 1)] });
    await cache.check('key');
    assert.equal((await cache.check('key')).source, 'cache');
    clock.advance(4000);
    assert.equal((await cache.check('key')).verdict.pass, false);
    assert.equal(cache.peek('key'), null);
    assert.equal((await cache.check('key')).source, 'evaluated');
  });

  it('never reuses a pass whose cache time is zero', async () => {
    let calls = 0;
    const cache = createGuardCache({
      now: () => 1000,
      evaluate: async () => {
        calls += 1;
        return verdict({ cacheSec: 0 });
      },
    });
    await cache.check();
    await cache.check();
    assert.equal(calls, 2);
  });

  it('shares one evaluation between requests that arrive together', async () => {
    let calls = 0;
    /** @type {(value: import('../../../plugin/opencode-unity-lib/guard/decide.js').GuardVerdict) => void} */
    let release = () => {};
    const cache = createGuardCache({
      now: () => 1000,
      evaluate: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const first = cache.check('key');
    const second = cache.check('key');
    release(verdict());
    assert.equal((await first).source, 'evaluated');
    assert.equal((await second).source, 'shared');
    assert.equal(calls, 1);
  });

  it('does not reuse a pass for other settings', async () => {
    let calls = 0;
    const cache = createGuardCache({
      now: () => 1000,
      evaluate: async () => {
        calls += 1;
        return verdict();
      },
    });
    await cache.check('left');
    await cache.check('right');
    assert.equal(calls, 2);
    assert.equal(cache.peek('left'), null);
    assert.ok(cache.peek('right'));
  });

  it('forgets everything when it is cleared', async () => {
    const cache = createGuardCache({ now: () => 1000, evaluate: async () => verdict() });
    await cache.check();
    assert.ok(cache.peek());
    cache.clear();
    assert.equal(cache.peek(), null);
  });

  it('lets an evaluation error reach the caller and keeps working afterwards', async () => {
    let fail = true;
    const cache = createGuardCache({
      now: () => 1000,
      evaluate: async () => {
        if (fail) throw new Error('probe exploded');
        return verdict();
      },
    });
    await assert.rejects(() => cache.check('key'), /probe exploded/);
    fail = false;
    assert.equal((await cache.check('key')).verdict.pass, true);
  });
});
