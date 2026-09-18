// The read clamp (spec 8.7). The hook can only change a tool's arguments by mutating them in place,
// so the test asserts the mutation, not a return value.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_READ_LIMIT_LINES, clampReadArgs, isReadTool } from '../../../plugin/opencode-unity-lib/read-limit.js';

describe('read clamp', () => {
  it('fills in the cap when the model asked for no limit', () => {
    const args = { filePath: 'Assets/Player.cs' };
    assert.deepEqual(clampReadArgs(args, 200), { changed: true, limit: 200 });
    assert.equal(args.limit, 200);
  });

  it('caps a larger request and leaves a smaller one alone', () => {
    const big = { limit: 5000 };
    assert.equal(clampReadArgs(big, 200).limit, 200);
    assert.equal(big.limit, 200);

    const small = { limit: 40 };
    assert.deepEqual(clampReadArgs(small, 200), { changed: false, limit: 40 });
    assert.equal(small.limit, 40);
  });

  it('replaces a limit that is not a usable number instead of trusting it', () => {
    for (const limit of ['all', null, 0, -5, Number.NaN, Infinity, {}]) {
      const args = { limit };
      assert.equal(clampReadArgs(args, 120).limit, 120, String(limit));
      assert.equal(args.limit, 120);
    }
  });

  it('rounds a fractional request down', () => {
    const args = { limit: 12.9 };
    assert.equal(clampReadArgs(args, 200).limit, 12);
  });

  it('falls back to the spec default when the profile value is unusable', () => {
    for (const cap of [undefined, 0, -1, Number.NaN, /** @type {any} */ ('200')]) {
      assert.equal(clampReadArgs({}, cap).limit, DEFAULT_READ_LIMIT_LINES, String(cap));
    }
  });

  it('does nothing when there are no arguments to clamp', () => {
    assert.deepEqual(clampReadArgs(null, 200), { changed: false, limit: 200 });
    assert.deepEqual(clampReadArgs(undefined, 200), { changed: false, limit: 200 });
  });

  it('knows which tool reads files', () => {
    assert.ok(isReadTool('read'));
    assert.ok(!isReadTool('bash'));
    assert.ok(!isReadTool('grep'));
  });
});
