// Which probes the guard runs, in which order, and with which timeouts (spec 7.2 and 7.7).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OLLAMA_PS_TIMEOUT_MS, UNITY_DETECT_TIMEOUT_MS, collectGuardFacts, createDefaultProbes } from '../../../plugin/opencode-unity-lib/guard/collect.js';
import { NOW_MS, TARGET, guardConfig, loadedModel } from './guard-facts.mjs';

/**
 * @param {object} [options]
 * @param {import('../../../plugin/opencode-unity-lib/guard/probes/ollama-ps.js').OllamaPsReading} [options.ps]
 * @param {Array<{ memoryFreeMiB?: number, utilization?: number, error?: string, memoryError?: string, utilizationError?: string, takeMs?: number }>} [options.nvidia]
 * @param {import('../../../plugin/opencode-unity-lib/guard/unity-processes.js').UnityPresence} [options.presence]
 * @param {import('../../../plugin/opencode-unity-lib/guard/unity-processes.js').SnapshotReading} [options.snapshot]
 */
function createFakeProbes({ ps = { ok: true, models: [] }, nvidia = [{}], presence = { ok: true, running: false, count: 0 }, snapshot } = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const calls = [];
  let clock = NOW_MS;
  let nvidiaIndex = 0;
  const reading = snapshot ?? { ok: true, snapshot: { probePid: 1000, ancestors: [], sampleMs: 1500, elapsedMs: 1500, processes: [] } };
  return {
    calls,
    names: () => calls.map((call) => call.probe),
    probes: {
      readOllamaPs: async (baseUrl, options) => {
        calls.push({ probe: 'ollama-ps', baseUrl, timeoutMs: options.timeoutMs });
        return ps;
      },
      readNvidiaSmi: async (options) => {
        const answer = nvidia[Math.min(nvidiaIndex, nvidia.length - 1)];
        nvidiaIndex += 1;
        calls.push({ probe: 'nvidia-smi', command: options.command, timeoutMs: options.timeoutMs, at: clock });
        clock += answer.takeMs ?? 0;
        if (answer.error !== undefined) return { ok: false, error: answer.error };
        return {
          ok: true,
          gpuCount: 1,
          memory: answer.memoryError === undefined ? { ok: true, totalMiB: 24576, freeMiB: answer.memoryFreeMiB ?? 22000 } : { ok: false, error: answer.memoryError },
          utilization: answer.utilizationError === undefined ? { ok: true, percent: answer.utilization ?? 3 } : { ok: false, error: answer.utilizationError },
        };
      },
      processes: {
        platform: 'test',
        detect: async (options) => {
          calls.push({ probe: 'detect', timeoutMs: options.timeoutMs });
          return presence;
        },
        sample: async (request) => {
          calls.push({ probe: 'sample', sampleCpu: request.sampleCpu, sampleMs: request.sampleMs, timeoutMs: request.timeoutMs, patterns: request.patterns });
          return reading;
        },
      },
      sleep: async (ms) => {
        calls.push({ probe: 'sleep', ms });
        clock += ms;
      },
      now: () => clock,
    },
  };
}

/**
 * @param {Parameters<typeof createFakeProbes>[0]} [probeOptions]
 * @param {Record<string, unknown>} [configOverrides]
 * @param {{ cold?: boolean, target?: import('../../../plugin/opencode-unity-lib/guard/config.js').GuardTarget }} [options]
 */
async function collect(probeOptions = {}, configOverrides = {}, { cold = false, target = TARGET } = {}) {
  const fake = createFakeProbes(probeOptions);
  const facts = await collectGuardFacts({ target, config: guardConfig(configOverrides), probes: fake.probes, cold });
  return { facts, fake };
}

describe('guard fact collection', () => {
  it('asks Ollama first, with the fixed 3 s timeout', async () => {
    const { facts, fake } = await collect();
    assert.equal(fake.calls[0].probe, 'ollama-ps');
    assert.equal(fake.calls[0].timeoutMs, OLLAMA_PS_TIMEOUT_MS);
    assert.equal(fake.calls[0].baseUrl, TARGET.baseUrl);
    assert.equal(facts.checkedAtMs, NOW_MS);
    assert.deepEqual(facts.endpoint, { host: '127.0.0.1', loopback: true });
  });

  it('runs no probe at all for a remote Ollama', async () => {
    const { facts, fake } = await collect({}, {}, { target: { ...TARGET, baseUrl: 'http://gpu-box.invalid:11434' } });
    assert.deepEqual(fake.names(), []);
    assert.deepEqual(facts.endpoint, { host: 'gpu-box.invalid', loopback: false });
    assert.equal(facts.ollama, null);
    assert.equal(facts.gpu, null);
    assert.equal(facts.unity, null);
  });

  it('skips nvidia-smi while the model is loaded', async () => {
    const { facts, fake } = await collect({ ps: { ok: true, models: [loadedModel()] } });
    assert.deepEqual(fake.names(), ['ollama-ps', 'detect']);
    assert.equal(facts.gpu, null);
  });

  it('samples CPU on the loaded path only while importWhileLoaded is wait', async () => {
    const running = { ok: true, running: true, count: 1 };
    const loaded = { ps: { ok: true, models: [loadedModel()] }, presence: running };
    const waiting = await collect({ ...loaded });
    assert.deepEqual(waiting.fake.names(), ['ollama-ps', 'detect', 'sample']);
    assert.equal(waiting.fake.calls[2].sampleCpu, true);
    assert.equal(waiting.fake.calls[2].sampleMs, 1500);
    assert.equal(waiting.fake.calls[2].timeoutMs, 10_000 + 1500);
    assert.deepEqual(waiting.fake.calls[2].patterns, ['AssetImportWorker', '-importWorker']);

    const allowed = await collect({ ...loaded }, { importWhileLoaded: 'allow' });
    assert.equal(allowed.fake.calls[2].sampleCpu, false);
    assert.equal(allowed.fake.calls[2].timeoutMs, 10_000);

    const nothingToCheck = await collect({ ...loaded }, { importWhileLoaded: 'allow', maxUnityEditors: 0 });
    assert.deepEqual(nothingToCheck.fake.names(), ['ollama-ps', 'detect']);
    assert.equal(nothingToCheck.facts.unity?.ok && nothingToCheck.facts.unity.detailsRead, false);
  });

  it('starts no PowerShell when no Unity process is running', async () => {
    const { facts, fake } = await collect({ presence: { ok: true, running: false, count: 0 } });
    assert.deepEqual(fake.names(), ['ollama-ps', 'nvidia-smi', 'detect']);
    assert.equal(fake.calls[2].timeoutMs, UNITY_DETECT_TIMEOUT_MS);
    assert.equal(facts.unity?.ok && facts.unity.running, false);
  });

  it('runs the GPU and Unity probes together on the cold path', async () => {
    const { facts, fake } = await collect({ presence: { ok: true, running: true, count: 2 } });
    assert.deepEqual(fake.names(), ['ollama-ps', 'nvidia-smi', 'detect', 'sample']);
    assert.equal(fake.calls[1].command, 'nvidia-smi');
    assert.equal(fake.calls[1].timeoutMs, 10_000);
    assert.equal(facts.gpu?.memory.ok, true);
    assert.deepEqual(facts.gpu?.utilization, { ok: true, samples: [3] });
  });

  it('takes a second utilization sample only when the first reaches the limit', async () => {
    const quiet = await collect({ nvidia: [{ utilization: 59 }] });
    assert.deepEqual(quiet.fake.names().filter((name) => name !== 'ollama-ps' && name !== 'detect'), ['nvidia-smi']);
    assert.deepEqual(quiet.facts.gpu?.utilization, { ok: true, samples: [59] });

    const busy = await collect({ nvidia: [{ utilization: 60 }, { utilization: 95 }] });
    assert.deepEqual(busy.fake.names(), ['ollama-ps', 'nvidia-smi', 'detect', 'sleep', 'nvidia-smi']);
    assert.equal(busy.fake.calls[3].ms, 1000);
    assert.deepEqual(busy.facts.gpu?.utilization, { ok: true, samples: [60, 95] });
  });

  it('waits no longer than the sample interval when the first query was slow', async () => {
    const { fake } = await collect({ nvidia: [{ utilization: 80, takeMs: 1200 }, { utilization: 80 }] });
    assert.equal(fake.calls.find((call) => call.probe === 'sleep')?.ms, 0);
  });

  it('skips the utilization query when the memory query failed', async () => {
    const { facts, fake } = await collect({ nvidia: [{ memoryError: 'not whole MiB' }] });
    assert.equal(fake.names().filter((name) => name === 'nvidia-smi').length, 1);
    assert.equal(facts.gpu?.memory.ok, false);
    assert.equal(facts.gpu?.utilization.ok, false);
  });

  it('reports a failed nvidia-smi call as both a memory and a utilization failure', async () => {
    const { facts } = await collect({ nvidia: [{ error: 'nvidia-smi could not start (ENOENT)' }] });
    assert.equal(facts.gpu?.memory.ok, false);
    assert.equal(facts.gpu?.utilization.ok, false);
    assert.equal(facts.gpu?.gpuCount, 0);
  });

  it('keeps the first sample when the second query fails', async () => {
    const { facts } = await collect({ nvidia: [{ utilization: 80 }, { utilizationError: "unexpected nvidia-smi output '[N/A]'" }] });
    assert.deepEqual(facts.gpu?.utilization, { ok: false, samples: [80], error: "unexpected nvidia-smi output '[N/A]'" });
  });

  it('never calls nvidia-smi with guard.adapter none', async () => {
    const { facts, fake } = await collect({}, { adapter: 'none' });
    assert.ok(!fake.names().includes('nvidia-smi'));
    assert.equal(facts.gpu, null);
  });

  it('judges a new load when the caller asks for a cold verdict', async () => {
    const { facts, fake } = await collect({ ps: { ok: true, models: [loadedModel()] } }, {}, { cold: true });
    assert.ok(fake.names().includes('nvidia-smi'));
    assert.equal(facts.cold, true);
  });

  it('treats an unreachable Ollama as a cold check', async () => {
    const { facts, fake } = await collect({ ps: { ok: false, error: 'GET /api/ps failed (ECONNREFUSED)' } });
    assert.ok(fake.names().includes('nvidia-smi'));
    assert.equal(facts.ollama?.ok, false);
  });

  it('builds the platform probes without touching anything', () => {
    const windows = createDefaultProbes({ platform: 'win32', env: {} });
    assert.equal(windows.processes.platform, 'win32');
    const linux = createDefaultProbes({ platform: 'linux', env: {} });
    assert.equal(linux.processes.platform, 'linux');
    assert.equal(typeof windows.readOllamaPs, 'function');
    assert.equal(typeof windows.now(), 'number');
  });

  it('sleeps only when there is time left and stops early on abort', async () => {
    const probes = createDefaultProbes({ platform: 'linux', env: {} });
    const controller = new AbortController();
    const startedAt = Date.now();
    await probes.sleep(0);
    const pending = probes.sleep(5000, controller.signal);
    controller.abort();
    await pending;
    assert.ok(Date.now() - startedAt < 1000);
    await probes.sleep(10, controller.signal);
  });
});
