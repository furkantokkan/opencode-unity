import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEnvelope } from '../../../src/cli/envelope.js';
import { createOutput, createPainter, shouldUseColor } from '../../../src/cli/output.js';

function createStream(isTTY = false) {
  const chunks = /** @type {string[]} */ ([]);
  return { isTTY, write: (/** @type {string} */ text) => chunks.push(text), text: () => chunks.join('') };
}

describe('createOutput', () => {
  it('writes human text to stdout in text mode', () => {
    const stdout = createStream();
    const stderr = createStream();
    const output = createOutput({ stdout, stderr });
    output.text('hello');
    output.text();
    output.warn('careful');
    output.error('failed');
    output.hint('try again');
    output.debug('hidden');
    assert.equal(stdout.text(), 'hello\n\n');
    assert.equal(stderr.text(), 'warning: careful\nerror: failed\nhint: try again\n');
  });

  it('keeps stdout for the envelope only under --json', () => {
    const stdout = createStream();
    const stderr = createStream();
    const output = createOutput({ stdout, stderr, json: true, verbose: true });
    output.text('progress');
    output.debug('details');
    output.envelope(createEnvelope({ command: 'guard', message: 'pass' }));
    assert.equal(stderr.text(), 'progress\ndetails\n');
    const lines = stdout.text().trimEnd().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).message, 'pass');
  });

  it('colors prefixes only when enabled', () => {
    const stderr = createStream();
    createOutput({ stdout: createStream(), stderr, color: true }).error('x');
    assert.equal(stderr.text(), '[31merror:[39m x\n');
  });
});

describe('color decisions', () => {
  it('needs a terminal and respects --no-color, NO_COLOR and TERM=dumb', () => {
    const tty = createStream(true);
    assert.equal(shouldUseColor({ stream: tty, env: {} }), true);
    assert.equal(shouldUseColor({ stream: createStream(false), env: {} }), false);
    assert.equal(shouldUseColor({ stream: undefined, env: {} }), false);
    assert.equal(shouldUseColor({ stream: tty, env: {}, noColor: true }), false);
    assert.equal(shouldUseColor({ stream: tty, env: { NO_COLOR: '1' } }), false);
    assert.equal(shouldUseColor({ stream: tty, env: { NO_COLOR: '' } }), true);
    assert.equal(shouldUseColor({ stream: tty, env: { TERM: 'dumb' } }), false);
  });

  it('paints with ANSI codes or passes text through', () => {
    assert.equal(createPainter(true).bold('b'), '[1mb[22m');
    assert.equal(createPainter(false).yellow('y'), 'y');
  });
});
