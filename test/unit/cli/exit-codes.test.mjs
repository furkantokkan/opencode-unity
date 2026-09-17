import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CliError, EXIT, EXIT_CODES, getExitCodeInfo, isExitCode, toCliError, usageError } from '../../../src/cli/exit-codes.js';

describe('exit codes', () => {
  it('keeps the documented numbers (spec 5.2)', () => {
    assert.deepEqual({ ...EXIT }, {
      OK: 0,
      USAGE: 1,
      BLOCKED: 2,
      BUDGET: 3,
      VALIDATION: 4,
      CHECK_FAILED: 5,
      LOCK_TIMEOUT: 6,
      RUNTIME: 7,
      UNSUPPORTED: 8,
      CONSENT_REQUIRED: 9,
      INTERRUPTED: 130,
    });
    assert.ok(Object.isFrozen(EXIT));
  });

  it('describes every exit code exactly once with unique names and codes', () => {
    assert.deepEqual(EXIT_CODES.map((info) => info.exitCode), Object.values(EXIT));
    assert.equal(new Set(EXIT_CODES.map((info) => info.code)).size, EXIT_CODES.length);
    for (const info of EXIT_CODES) {
      assert.equal(EXIT[/** @type {keyof typeof EXIT} */ (info.name)], info.exitCode);
      assert.match(info.code, /^[a-z][a-z0-9_]*$/);
      assert.ok(info.summary.length > 0);
    }
  });

  it('looks up known codes and rejects others', () => {
    assert.equal(getExitCodeInfo(9)?.name, 'CONSENT_REQUIRED');
    assert.equal(getExitCodeInfo(10), undefined);
    assert.equal(isExitCode(130), true);
    assert.equal(isExitCode(10), false);
    assert.equal(isExitCode('2'), false);
  });
});

describe('CliError', () => {
  it('defaults to RUNTIME with the default code', () => {
    const error = new CliError('boom');
    assert.equal(error.exitCode, EXIT.RUNTIME);
    assert.equal(error.code, 'runtime_error');
    assert.deepEqual(error.data, {});
    assert.equal(error.name, 'CliError');
    assert.ok(error instanceof Error);
  });

  it('keeps an explicit code, data, hint and cause', () => {
    const cause = new Error('inner');
    const error = new CliError('blocked', { exitCode: EXIT.BLOCKED, code: 'gpu_guard_blocked', data: { verdict: 'blocked' }, hint: 'wait', cause });
    assert.equal(error.exitCode, 2);
    assert.equal(error.code, 'gpu_guard_blocked');
    assert.deepEqual(error.data, { verdict: 'blocked' });
    assert.equal(error.hint, 'wait');
    assert.equal(error.cause, cause);
  });

  it('refuses success, unknown exit codes and non snake_case codes', () => {
    assert.throws(() => new CliError('x', { exitCode: EXIT.OK }), TypeError);
    assert.throws(() => new CliError('x', { exitCode: 42 }), TypeError);
    assert.throws(() => new CliError('x', { code: 'Not-Snake' }), TypeError);
  });

  it('builds usage errors with exit 1', () => {
    const error = usageError('bad flag', { code: 'unknown_option' });
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.equal(error.code, 'unknown_option');
    assert.equal(usageError('bad').code, 'usage_error');
  });

  it('wraps unknown thrown values as RUNTIME and passes CliError through', () => {
    const original = usageError('bad');
    assert.equal(toCliError(original), original);
    const wrapped = toCliError(new TypeError('oops'));
    assert.equal(wrapped.exitCode, EXIT.RUNTIME);
    assert.equal(wrapped.message, 'oops');
    assert.ok(wrapped.cause instanceof TypeError);
    assert.equal(toCliError('text').message, 'text');
    assert.equal(toCliError(new Error('')).message, 'Unexpected error');
  });
});
