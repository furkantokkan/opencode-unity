// Reading GPU memory and utilization: recorded nvidia-smi outputs, and failures that must fail closed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { NVIDIA_SMI_QUERY_ARGS, parseNvidiaSmiOutput, readNvidiaSmi } from '../../../plugin/opencode-unity-lib/guard/probes/nvidia-smi.js';
import { createSandbox } from '../../helpers/sandbox.mjs';

const FIXTURES = new URL('../../fixtures/nvidia-smi/', import.meta.url);

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
function readFixture(name) {
  return fs.readFile(new URL(name, FIXTURES), 'utf8');
}

/**
 * @param {import('../../../plugin/opencode-unity-lib/guard/probes/run-command.js').CommandResult} answer
 */
function fakeRun(answer, calls = []) {
  return {
    calls,
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      return { ok: true, exitCode: 0, stdout: '', stderr: '', error: null, timedOut: false, ...answer };
    },
  };
}

/** @type {import('../../helpers/sandbox.mjs').Sandbox} */
let sandbox;

before(async () => {
  sandbox = await createSandbox('nvidia-smi');
});

after(() => sandbox.cleanup());

describe('nvidia-smi output', () => {
  it('reads the recorded normal answer', async () => {
    const reading = parseNvidiaSmiOutput(await readFixture('normal.txt'));
    assert.deepEqual(reading, { ok: true, gpuCount: 1, memory: { ok: true, totalMiB: 24576, freeMiB: 22000 }, utilization: { ok: true, percent: 3 } });
  });

  it('reads the recorded low-memory and busy answers', async () => {
    const low = parseNvidiaSmiOutput(await readFixture('low-vram.txt'));
    assert.equal(low.ok && low.memory.ok && low.memory.freeMiB, 19800);
    const busy = parseNvidiaSmiOutput(await readFixture('busy.txt'));
    assert.equal(busy.ok && busy.utilization.ok && busy.utilization.percent, 85);
  });

  it('measures GPU 0 only and counts the other GPUs', async () => {
    const reading = parseNvidiaSmiOutput(await readFixture('multi-gpu.txt'));
    assert.equal(reading.ok, true);
    assert.equal(reading.gpuCount, 2);
    assert.equal(reading.memory.ok && reading.memory.totalMiB, 24576);
  });

  it('fails closed on a driver failure message', async () => {
    const reading = parseNvidiaSmiOutput(await readFixture('garbage.txt'));
    assert.equal(reading.ok, false);
    assert.match(reading.error, /unexpected nvidia-smi output/);
  });

  it('keeps the memory figures when only the utilization is missing', async () => {
    const reading = parseNvidiaSmiOutput(await readFixture('no-utilization.txt'));
    assert.equal(reading.ok, true);
    assert.equal(reading.memory.ok, true);
    assert.equal(reading.utilization.ok, false);
    assert.match(reading.utilization.error, /\[N\/A\]' is not a percent/);
  });

  it('refuses answers that are not exactly what the query asks for', () => {
    assert.match(parseNvidiaSmiOutput('').error, /printed nothing/);
    assert.match(parseNvidiaSmiOutput('24576, 22000\n').error, /unexpected nvidia-smi output/);
    assert.match(parseNvidiaSmiOutput('0, 24576 MiB, 22000 MiB, 3 %\n').memory.error, /not whole MiB/);
    assert.match(parseNvidiaSmiOutput('1, 24576, 22000, 3\n').error, /did not list GPU index 0/);
    assert.match(parseNvidiaSmiOutput('0, 24576, 30000, 3\n').memory.error, /more free memory/);
    assert.match(parseNvidiaSmiOutput('0, 24576, 22000, 120\n').utilization.error, /not a percent/);
  });
});

describe('readNvidiaSmi', () => {
  it('asks for index, memory and utilization in one call, in CSV without units', async () => {
    const fake = fakeRun({ stdout: '0, 24576, 22000, 3\n' });
    const reading = await readNvidiaSmi({ timeoutMs: 10_000, run: fake.run, platform: 'win32', env: {} });
    assert.equal(reading.ok, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].file, 'nvidia-smi');
    assert.deepEqual(fake.calls[0].args, [...NVIDIA_SMI_QUERY_ARGS]);
    assert.equal(fake.calls[0].options.timeoutMs, 10_000);
  });

  it('uses the configured command, which tests point at a fake', async () => {
    const fake = fakeRun({ stdout: '0, 24576, 22000, 3\n' });
    await readNvidiaSmi({ timeoutMs: 10_000, command: 'D:/fakes/nvidia-smi.mjs', run: fake.run, platform: 'win32', env: {} });
    assert.equal(fake.calls[0].file, process.execPath);
    assert.equal(fake.calls[0].args[0], 'D:/fakes/nvidia-smi.mjs');
  });

  it('turns a failed call into an error with the output', async () => {
    const fake = fakeRun({ ok: false, exitCode: 9, stdout: 'NVIDIA-SMI has failed\n', error: 'exited with code 9' });
    const reading = await readNvidiaSmi({ timeoutMs: 10_000, run: fake.run, platform: 'win32', env: {} });
    assert.equal(reading.ok, false);
    assert.match(reading.error, /nvidia-smi exited with code 9: NVIDIA-SMI has failed/);
  });

  it('refuses a command it cannot start safely', async () => {
    const fake = fakeRun({ stdout: '' });
    const reading = await readNvidiaSmi({ timeoutMs: 10_000, command: 'C:/fake/nvidia&smi.cmd', run: fake.run, platform: 'win32', env: {} });
    assert.equal(reading.ok, false);
    assert.match(reading.error, /not usable/);
    assert.equal(fake.calls.length, 0);
  });

  it('reads a real fake process that answers like nvidia-smi', async () => {
    const fake = path.join(sandbox.dirs.bin, 'nvidia-smi.mjs');
    await fs.writeFile(fake, "process.stdout.write(process.argv.slice(2).join(' ').includes('utilization.gpu') ? '0, 24576, 22000, 7\\n' : 'unexpected\\n');");
    const reading = await readNvidiaSmi({ timeoutMs: 20_000, command: fake, env: sandbox.env });
    assert.equal(reading.ok, true);
    assert.equal(reading.memory.ok && reading.memory.freeMiB, 22000);
    assert.equal(reading.utilization.ok && reading.utilization.percent, 7);
  });
});
