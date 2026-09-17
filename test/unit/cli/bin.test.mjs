// End-to-end checks of the real binary in a sandbox. Only behavior that stays true after the command
// modules exist is asserted here; module loading is covered in main.test.mjs with fakes.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { formatVersionLine } from '../../../src/cli/version.js';
import { readEnvelope, runCli } from '../../helpers/run-cli.mjs';
import { createSandbox } from '../../helpers/sandbox.mjs';

describe('opencode-unity binary', () => {
  /** @type {import('../../helpers/sandbox.mjs').Sandbox} */
  let sandbox;

  before(async () => {
    sandbox = await createSandbox('bin');
  });

  after(async () => {
    await sandbox.cleanup();
  });

  it('prints the version with the unofficial disclaimer', async () => {
    const result = await runCli(['--version'], { sandbox });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${formatVersionLine()}\n`);
    assert.equal(result.stderr, '');
  });

  it('prints grouped help', async () => {
    const result = await runCli(['--help'], { sandbox });
    assert.equal(result.code, 0);
    const everyday = result.stdout.indexOf('\nEveryday\n');
    const advanced = result.stdout.indexOf('\nAdvanced\n');
    assert.ok(everyday > 0 && advanced > everyday);
  });

  it('refuses auto-approval flags on start with exit 1 and a JSON envelope', async () => {
    const result = await runCli(['start', '--yolo', '--json'], { sandbox });
    assert.equal(result.code, 1);
    const envelope = readEnvelope(result);
    assert.equal(envelope.command, 'start');
    assert.equal(envelope.code, 'refused_option');
    assert.deepEqual(envelope.data, { option: 'yolo' });
  });

  it('keeps stdout to one envelope line under --json for usage errors', async () => {
    const result = await runCli(['doctr', '--json'], { sandbox });
    assert.equal(result.code, 1);
    assert.equal(result.stdout.trimEnd().split('\n').length, 1);
    assert.equal(readEnvelope(result).code, 'unknown_command');
  });
});
