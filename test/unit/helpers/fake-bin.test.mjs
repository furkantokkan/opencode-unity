import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { createFakeBin, prependPath } from '../../helpers/fake-bin.mjs';
import { runProcess } from '../../helpers/run-cli.mjs';
import { useSandbox } from '../../helpers/sandbox.mjs';

/**
 * @param {import('../../helpers/fake-bin.mjs').FakeBin} fake
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
function invoke(fake, args, env) {
  return runProcess(fake.invocation.file, [...fake.invocation.args, ...args], { env });
}

describe('fake executables', () => {
  it('answers per route with sequences whose last response repeats', async (t) => {
    const sandbox = await useSandbox(t, 'fake-bin');
    const memoryArgs = ['--query-gpu=memory.total,memory.free', '--format=csv,noheader,nounits'];
    const fake = await createFakeBin(sandbox.dirs.bin, 'nvidia-smi', {
      routes: [
        { args: memoryArgs, responses: [{ stdout: '24576, 21000\n' }] },
        { args: null, responses: [{ stdout: '75\n' }, { stdout: '5\n' }] },
      ],
    });
    assert.equal((await invoke(fake, memoryArgs, sandbox.env)).stdout, '24576, 21000\n');
    assert.equal((await invoke(fake, ['--query-gpu=utilization.gpu'], sandbox.env)).stdout, '75\n');
    assert.equal((await invoke(fake, memoryArgs, sandbox.env)).stdout, '24576, 21000\n');
    assert.equal((await invoke(fake, ['--query-gpu=utilization.gpu'], sandbox.env)).stdout, '5\n');
    assert.equal((await invoke(fake, ['--query-gpu=utilization.gpu'], sandbox.env)).stdout, '5\n');
    const calls = await fake.readCalls();
    assert.deepEqual(calls.map((call) => call.routeIndex), [0, 1, 0, 1, 1]);
    assert.deepEqual(calls[0].args, memoryArgs);
  });

  it('supports the single-response shorthand, stderr, exit codes and spec changes', async (t) => {
    const sandbox = await useSandbox(t, 'fake-bin-short');
    const fake = await createFakeBin(sandbox.dirs.bin, 'ollama', { stderr: 'not running\n', exitCode: 3 });
    const failed = await invoke(fake, ['ps'], sandbox.env);
    assert.equal(failed.code, 3);
    assert.equal(failed.stderr, 'not running\n');
    await fake.setSpec({ stdout: 'ok\n', delayMs: 20 });
    const passed = await invoke(fake, ['ps'], sandbox.env);
    assert.equal(passed.code, 0);
    assert.equal(passed.stdout, 'ok\n');
    assert.equal((await fake.readCalls()).length, 1);
  });

  it('uses the fallback for unexpected arguments', async (t) => {
    const sandbox = await useSandbox(t, 'fake-bin-fallback');
    const fake = await createFakeBin(sandbox.dirs.bin, 'tool', { routes: [{ args: ['--version'], responses: [{ stdout: '1.0\n' }] }] });
    const result = await invoke(fake, ['--other'], sandbox.env);
    assert.equal(result.code, 97);
    assert.match(result.stderr, /unexpected arguments \["--other"\]/);
  });

  it('writes a launcher that is found on PATH', async (t) => {
    const sandbox = await useSandbox(t, 'fake-bin-path');
    await createFakeBin(sandbox.dirs.bin, 'fake-tool', { stdout: 'from launcher\n' });
    const env = prependPath(sandbox.env, sandbox.dirs.bin);
    // Windows needs a shell to run a .cmd launcher; the fixed command line has no user input.
    const result = process.platform === 'win32'
      ? spawnSync('fake-tool one', { env, shell: true, encoding: 'utf8', windowsHide: true })
      : spawnSync('fake-tool', ['one'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'from launcher\n');
  });

  it('prepends to the existing PATH variable name', () => {
    const env = prependPath({ Path: 'a' }, 'bin');
    assert.equal(Object.keys(env).length, 1);
    assert.match(env.Path, /^bin[;:]a$/);
    assert.deepEqual(prependPath({}, 'bin'), { PATH: 'bin' });
  });
});
