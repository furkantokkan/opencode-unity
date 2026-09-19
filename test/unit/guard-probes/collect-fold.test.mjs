// How collect.js folds the platform reads back into the probe shape the guard decides on: an ok read
// becomes the measured figures, an error or unavailable read becomes an error with the read's detail,
// so a capability nobody measures blocks (amendment 33.6; the degraded verdict for an unavailable
// advisory capability is not part of this fold).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDefaultProbes } from '../../../plugin/opencode-unity-lib/guard/collect.js';
import { evaluateGuard } from '../../../plugin/opencode-unity-lib/guard/evaluate.js';

const NOW_MS = Date.parse('2026-09-18T10:00:00.000Z');
const TARGET = Object.freeze({ baseUrl: 'http://127.0.0.1:11434', modelTag: 'ocu-model-16k', numCtx: 16384 });

/**
 * @param {Partial<import('../../../plugin/opencode-unity-lib/guard/probes/run-command.js').CommandResult>} answer
 */
function answeringRun(answer) {
  /** @type {Array<{ file: string, options: import('../../../plugin/opencode-unity-lib/guard/probes/run-command.js').RunOptions }>} */
  const calls = [];
  /** @type {import('../../../plugin/opencode-unity-lib/guard/probes/run-command.js').RunCommand} */
  const run = async (file, _args, options) => {
    calls.push({ file, options });
    return { ok: true, exitCode: 0, stdout: '', stderr: '', error: null, timedOut: false, ...answer };
  };
  return { calls, run };
}

/** @type {typeof fetch} */
const noModelsLoaded = async () => new Response(JSON.stringify({ models: [] }), { status: 200 });

describe('the accelerator fold', () => {
  it('gives the measured figures in the nvidia-smi reading shape', async () => {
    const fake = answeringRun({ stdout: '0, 24576, 22000, 3\r\n' });
    const probes = createDefaultProbes({ platform: 'win32', env: {}, run: fake.run });
    const signal = new AbortController().signal;
    const reading = await probes.readNvidiaSmi({ command: 'nvidia-smi', timeoutMs: 4321, signal });
    assert.deepEqual(reading, { ok: true, gpuCount: 1, memory: { ok: true, totalMiB: 24576, freeMiB: 22000 }, utilization: { ok: true, percent: 3 } });
    assert.equal(fake.calls[0].options.timeoutMs, 4321);
    assert.equal(fake.calls[0].options.signal, signal);
  });

  it('gives a failed query as zero devices with both figures failed, in the nvidia-smi error text', async () => {
    const fake = answeringRun({ ok: false, exitCode: 9, error: 'exited with code 9', stderr: 'NVIDIA-SMI has failed' });
    const reading = await createDefaultProbes({ platform: 'win32', env: {}, run: fake.run }).readNvidiaSmi({ command: 'nvidia-smi', timeoutMs: 1000 });
    const error = 'nvidia-smi exited with code 9: NVIDIA-SMI has failed';
    assert.deepEqual(reading, { ok: true, gpuCount: 0, memory: { ok: false, error }, utilization: { ok: false, error } });
  });
});

describe('a platform without a probe family', () => {
  it('keeps its name on the process probe and answers every read with an error naming the capability', async () => {
    const fake = answeringRun({});
    const probes = createDefaultProbes({ platform: 'aix', env: {}, run: fake.run });
    assert.equal(probes.processes.platform, 'aix');
    assert.deepEqual(await probes.processes.detect({ timeoutMs: 5000 }), { ok: false, error: 'no probe for process.enumerate ships for aix in this version' });
    assert.deepEqual(await probes.processes.sample({ patterns: [], sampleMs: 1500, sampleCpu: true, timeoutMs: 5000 }), { ok: false, error: 'no probe for process.enumerate ships for aix in this version' });
    assert.deepEqual(await probes.readNvidiaSmi({ command: 'nvidia-smi', timeoutMs: 1000 }), {
      ok: true,
      gpuCount: 0,
      memory: { ok: false, error: 'no probe for accelerator.memory ships for aix in this version' },
      utilization: { ok: false, error: 'no probe for accelerator.utilization ships for aix in this version' },
    });
    assert.equal(fake.calls.length, 0);
  });

  it('blocks a cold load instead of guessing, and says what was not measured', async () => {
    const probes = { ...createDefaultProbes({ platform: 'aix', env: {}, fetchImpl: noModelsLoaded }), now: () => NOW_MS };
    const verdict = await evaluateGuard({ target: TARGET, config: { modelVramMiB: 19000 }, probes });
    assert.equal(verdict.verdict, 'blocked');
    assert.ok(verdict.reasons.length > 0);
    assert.ok(verdict.reasons.every((reason) => reason.id === 'probe_failed'), JSON.stringify(verdict.reasons));
    const details = verdict.reasons.map((reason) => reason.detail).join('\n');
    assert.match(details, /accelerator\.memory ships for aix/);
    assert.match(details, /process\.enumerate ships for aix/);
  });
});
