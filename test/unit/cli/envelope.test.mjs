import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ENVELOPE_KEYS,
  createEnvelope,
  createErrorEnvelope,
  formatEnvelope,
  parseEnvelope,
  validateEnvelope,
} from '../../../src/cli/envelope.js';
import { CliError, EXIT, usageError } from '../../../src/cli/exit-codes.js';
import { CLI_VERSION } from '../../../src/cli/version.js';

describe('createEnvelope', () => {
  it('fills defaults in the documented key order (spec 5.3)', () => {
    const envelope = createEnvelope({ command: 'guard' });
    assert.deepEqual(Object.keys(envelope), [...ENVELOPE_KEYS]);
    assert.deepEqual(envelope, {
      ok: true,
      command: 'guard',
      exitCode: 0,
      code: 'ok',
      message: '',
      data: {},
      warnings: [],
      version: CLI_VERSION,
    });
  });

  it('derives ok and the default code from the exit code', () => {
    const envelope = createEnvelope({ command: 'guard', exitCode: EXIT.BLOCKED, code: 'gpu_guard_blocked', message: 'Unity asset import running' });
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'gpu_guard_blocked');
    assert.equal(createEnvelope({ command: 'x', exitCode: EXIT.LOCK_TIMEOUT }).code, 'lock_timeout');
  });

  it('copies warnings so later changes do not leak in', () => {
    const warnings = ['first'];
    const envelope = createEnvelope({ command: 'doctor', warnings });
    warnings.push('second');
    assert.deepEqual(envelope.warnings, ['first']);
  });

  it('throws on invalid input', () => {
    assert.throws(() => createEnvelope({ command: '' }), /command/);
    assert.throws(() => createEnvelope({ command: 'x', exitCode: 12 }), /exitCode/);
    assert.throws(() => createEnvelope({ command: 'x', code: 'Bad Code' }), /code/);
    assert.throws(() => createEnvelope({ command: 'x', data: /** @type {any} */ ([]) }), /data/);
    assert.throws(() => createEnvelope({ command: 'x', warnings: /** @type {any} */ ([1]) }), /warnings/);
  });
});

describe('validateEnvelope', () => {
  const valid = () => createEnvelope({ command: 'status', data: { models: [] } });

  it('accepts a valid envelope', () => {
    assert.deepEqual(validateEnvelope(valid()), []);
  });

  it('reports extra and missing keys', () => {
    const extra = { ...valid(), jobId: 'x' };
    assert.match(validateEnvelope(extra).join(), /unexpected key 'jobId'/);
    const { version, ...missing } = valid();
    assert.match(validateEnvelope(missing).join(), /missing key 'version'/);
  });

  it('requires ok to match the exit code', () => {
    assert.match(validateEnvelope({ ...valid(), ok: false }).join(), /ok must be true exactly when exitCode is 0/);
    assert.match(validateEnvelope({ ...valid(), exitCode: 7 }).join(), /ok must be/);
  });

  it('rejects non-objects', () => {
    assert.deepEqual(validateEnvelope(null), ['envelope must be an object']);
    assert.deepEqual(validateEnvelope([]), ['envelope must be an object']);
  });
});

describe('createErrorEnvelope', () => {
  it('maps a CliError with data and hint', () => {
    const error = new CliError('Unity asset import running', {
      exitCode: EXIT.BLOCKED,
      code: 'gpu_guard_blocked',
      data: { verdict: 'blocked' },
      hint: 'Wait for the import to finish.',
    });
    const envelope = createErrorEnvelope('guard', error);
    assert.equal(envelope.exitCode, 2);
    assert.equal(envelope.code, 'gpu_guard_blocked');
    assert.equal(envelope.message, 'Unity asset import running');
    assert.deepEqual(envelope.data, { verdict: 'blocked', hint: 'Wait for the import to finish.' });
  });

  it('maps unknown errors to RUNTIME and adds the stack only when verbose', () => {
    const plain = createErrorEnvelope('doctor', new Error('disk on fire'));
    assert.equal(plain.exitCode, EXIT.RUNTIME);
    assert.equal(plain.code, 'runtime_error');
    assert.equal('stack' in plain.data, false);
    const verbose = createErrorEnvelope('doctor', new Error('disk on fire'), { verbose: true });
    assert.match(String(verbose.data.stack), /disk on fire/);
  });

  it('does not change the error data object', () => {
    const error = usageError('bad', { data: { option: 'x' }, hint: 'fix it' });
    createErrorEnvelope('start', error);
    assert.deepEqual(error.data, { option: 'x' });
  });
});

describe('formatEnvelope and parseEnvelope', () => {
  it('prints one line and parses it back', () => {
    const envelope = createEnvelope({ command: 'delegate ask', message: 'done', data: { nested: { a: 1 } }, warnings: ['w'] });
    const text = formatEnvelope(envelope);
    assert.equal(text.endsWith('\n'), true);
    assert.equal(text.trimEnd().includes('\n'), false);
    assert.deepEqual(parseEnvelope(text), envelope);
  });

  it('rejects text that is not a valid envelope', () => {
    assert.throws(() => parseEnvelope('{"ok":true}'), /Invalid envelope/);
    assert.throws(() => parseEnvelope('not json'), SyntaxError);
  });
});
