import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { NVIDIA_SMI_QUERY_ARGS, parseNvidiaSmiOutput } from '../../../plugin/opencode-unity-lib/guard/probes/nvidia-smi.js';
import {
  createFakeNvidiaSmi,
  createGpu,
  DRIVER_FAILURE_MESSAGE,
  NVIDIA_SMI_PRESETS,
  respondToNvidiaSmi,
} from '../../../src/selftest/fake-nvidia-smi.js';

const run = promisify(execFile);

/**
 * @param {import('node:test').TestContext} t
 * @param {import('../../../src/selftest/fake-nvidia-smi.js').NvidiaSmiState} [state]
 */
async function createFake(t, state) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocu-fake-smi-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return createFakeNvidiaSmi(dir, state);
}

test('fake nvidia-smi: answers the guard query in the CSV form the probe parses', async () => {
  const answer = respondToNvidiaSmi(NVIDIA_SMI_QUERY_ARGS, NVIDIA_SMI_PRESETS.normal);

  assert.equal(answer.exitCode, 0);
  assert.equal(answer.stdout, '0, 24576, 22000, 3\n');
  assert.deepEqual(parseNvidiaSmiOutput(answer.stdout), {
    ok: true,
    gpuCount: 1,
    memory: { ok: true, totalMiB: 24576, freeMiB: 22000 },
    utilization: { ok: true, percent: 3 },
  });
});

test('fake nvidia-smi: headers and units follow the --format flags', () => {
  const withHeader = respondToNvidiaSmi(['--query-gpu=memory.total,memory.free', '--format=csv'], NVIDIA_SMI_PRESETS.normal);
  assert.equal(withHeader.stdout, 'memory.total [MiB], memory.free [MiB]\n24576 MiB, 22000 MiB\n');

  const separateValue = respondToNvidiaSmi(['--query-gpu', 'memory.used', '--format', 'csv,noheader,nounits'], NVIDIA_SMI_PRESETS.normal);
  assert.equal(separateValue.stdout, '2576\n');
});

test('fake nvidia-smi: presets cover the guard rows of spec 7.3', () => {
  const read = (/** @type {keyof typeof NVIDIA_SMI_PRESETS} */ preset, calls = 0) => respondToNvidiaSmi(NVIDIA_SMI_QUERY_ARGS, NVIDIA_SMI_PRESETS[preset], calls);

  // C2: 19,800 MiB free leaves 800 MiB after a 19,000 MiB load, under the 1,500 MiB minimum.
  assert.equal(read('lowVram').stdout, '0, 24576, 19800, 3\n');
  // C3: utilization stays high in both samples.
  assert.equal(read('gpuBusy').stdout.trim().split(', ').at(-1), '85');
  assert.equal(read('gpuBusy', 1).stdout.trim().split(', ').at(-1), '90');
  // C1: an unreadable driver and unparsable output must both block.
  const failure = read('driverFailure');
  assert.equal(failure.exitCode, 9);
  assert.equal(failure.stdout, DRIVER_FAILURE_MESSAGE);
  assert.equal(parseNvidiaSmiOutput(read('garbage').stdout).ok, false);
  // 7.9: a second GPU is listed, and the probe still reads index 0.
  assert.equal(read('multiGpu').stdout, '0, 24576, 22000, 0\n1, 12288, 11800, 0\n');
  assert.equal(parseNvidiaSmiOutput(read('multiGpu').stdout).gpuCount, 2);
});

test('fake nvidia-smi: unsupported arguments and unknown fields fail like the real tool', () => {
  assert.match(respondToNvidiaSmi([], NVIDIA_SMI_PRESETS.normal).stderr, /only --query-gpu calls are supported/);
  assert.match(respondToNvidiaSmi(['-L'], NVIDIA_SMI_PRESETS.normal).stderr, /Invalid combination of input arguments/);
  assert.match(respondToNvidiaSmi(['--query-gpu=memory.free'], NVIDIA_SMI_PRESETS.normal).stderr, /requires --format=csv/);
  assert.match(respondToNvidiaSmi(['--query-gpu=fan.speed', '--format=csv'], NVIDIA_SMI_PRESETS.normal).stdout, /not a valid field to query/);
  assert.match(respondToNvidiaSmi(['--query-gpu=index', '--format=csv', '-i', '4'], NVIDIA_SMI_PRESETS.normal).stdout, /No devices were found/);
  assert.match(respondToNvidiaSmi(['--verbose'], NVIDIA_SMI_PRESETS.normal).stderr, /Invalid combination of input arguments/);
});

test('fake nvidia-smi: the generated script answers by path, logs calls and follows setState', async (t) => {
  const fake = await createFake(t, NVIDIA_SMI_PRESETS.gpuBusy);

  const first = await run(process.execPath, [fake.scriptPath, ...NVIDIA_SMI_QUERY_ARGS]);
  const second = await run(process.execPath, [fake.scriptPath, ...NVIDIA_SMI_QUERY_ARGS]);

  assert.equal(first.stdout, '0, 24576, 22000, 85\n');
  assert.equal(second.stdout, '0, 24576, 22000, 90\n', 'the utilization samples advance per call');
  const calls = await fake.readCalls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, [...NVIDIA_SMI_QUERY_ARGS]);
  assert.deepEqual(calls.map((call) => call.utilizationIndex), [0, 1]);
  assert.deepEqual(fake.invocation, { file: process.execPath, args: [fake.scriptPath] });

  await fake.setState({ gpus: [createGpu({ memoryFreeMiB: 1000 })] });
  const third = await run(process.execPath, [fake.scriptPath, ...NVIDIA_SMI_QUERY_ARGS]);

  assert.equal(third.stdout, '0, 24576, 1000, 0\n');
  assert.equal((await fake.readCalls()).length, 1, 'setState clears the call log');
});

test('fake nvidia-smi: a driver failure exits non-zero from the generated script', async (t) => {
  const fake = await createFake(t, NVIDIA_SMI_PRESETS.driverFailure);

  await assert.rejects(
    () => run(process.execPath, [fake.scriptPath, ...NVIDIA_SMI_QUERY_ARGS]),
    (error) => {
      assert.equal(error.code, 9);
      assert.equal(error.stdout, DRIVER_FAILURE_MESSAGE);
      return true;
    },
  );
});

test('fake nvidia-smi: a state delay lets probe timeouts be tested', async (t) => {
  const fake = await createFake(t, { gpus: [createGpu()], delayMs: 150 });

  const startedAt = Date.now();
  await run(process.execPath, [fake.scriptPath, ...NVIDIA_SMI_QUERY_ARGS]);

  assert.ok(Date.now() - startedAt >= 140, 'the fake answers late on purpose');
});
