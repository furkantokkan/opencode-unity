// One guard evaluation end to end with fake probes: fail closed on bad settings and on surprises.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGuardKey, evaluateGuard } from '../../../plugin/opencode-unity-lib/guard/evaluate.js';
import { NOW_MS, TARGET, loadedModel, reasonIds } from './guard-facts.mjs';

const SETTINGS = { modelVramMiB: 19000 };

/**
 * @param {Partial<import('../../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes>} [overrides]
 * @returns {import('../../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes}
 */
function probes(overrides = {}) {
  return {
    readOllamaPs: async () => ({ ok: true, models: [loadedModel()] }),
    readNvidiaSmi: async () => ({ ok: true, gpuCount: 1, memory: { ok: true, totalMiB: 24576, freeMiB: 22000 }, utilization: { ok: true, percent: 2 } }),
    processes: {
      platform: 'test',
      detect: async () => ({ ok: true, running: false, count: 0 }),
      sample: async () => ({ ok: false, error: 'not expected in this test' }),
    },
    sleep: async () => {},
    now: () => NOW_MS,
    ...overrides,
  };
}

describe('evaluateGuard', () => {
  it('passes with a loaded model and reports the path and cache time', async () => {
    const verdict = await evaluateGuard({ target: TARGET, config: SETTINGS, probes: probes() });
    assert.equal(verdict.pass, true);
    assert.equal(verdict.path, 'loaded');
    assert.equal(verdict.cacheSec, 15);
    assert.equal(verdict.checkedAt, '2026-09-17T12:00:00.000Z');
  });

  it('blocks when the guard settings are not valid', async () => {
    const verdict = await evaluateGuard({ target: TARGET, config: { modelVramMiB: 19000, maxGpuUtilPercent: 0, importWhileLoaded: 'sometimes' }, probes: probes() });
    assert.equal(verdict.pass, false);
    assert.equal(verdict.mode, 'stop');
    assert.deepEqual(reasonIds(verdict), ['probe_failed']);
    assert.equal(verdict.reasons[0].data.probe, 'settings');
    assert.match(verdict.reasons[0].detail, /guard\.maxGpuUtilPercent must be between 1 and 100/);
    assert.match(verdict.reasons[0].detail, /guard\.importWhileLoaded must be one of wait, allow/);
  });

  it('blocks when the settings are missing entirely', async () => {
    const verdict = await evaluateGuard({ target: TARGET, config: undefined, probes: probes() });
    assert.equal(verdict.pass, false);
    assert.match(verdict.reasons[0].detail, /guard settings are missing/);
  });

  it('blocks when the target is not usable', async () => {
    const verdict = await evaluateGuard({ target: { baseUrl: 'ftp://127.0.0.1', modelTag: '', numCtx: 0 }, config: SETTINGS, probes: probes() });
    assert.equal(verdict.pass, false);
    assert.match(verdict.reasons[0].detail, /not a plain http\(s\) URL/);
    assert.match(verdict.reasons[0].detail, /model tag is empty/);
    assert.match(verdict.reasons[0].detail, /context size is not a positive integer/);
  });

  it('blocks when a probe throws instead of answering', async () => {
    const verdict = await evaluateGuard({
      target: TARGET,
      config: SETTINGS,
      probes: probes({
        readOllamaPs: async () => {
          throw new TypeError('fetch is not a function');
        },
      }),
    });
    assert.equal(verdict.pass, false);
    assert.equal(verdict.reasons[0].data.probe, 'guard');
    assert.match(verdict.reasons[0].detail, /TypeError: fetch is not a function/);
  });

  it('blocks when a probe throws something that is not an Error', async () => {
    const verdict = await evaluateGuard({
      target: TARGET,
      config: SETTINGS,
      probes: probes({
        readOllamaPs: async () => {
          throw 'probe exploded';
        },
      }),
    });
    assert.equal(verdict.pass, false);
    assert.equal(verdict.reasons[0].detail, 'probe exploded');
  });

  it('ignores runtime profile keys the guard does not use', async () => {
    const verdict = await evaluateGuard({ target: TARGET, config: { ...SETTINGS, kvType: 'q8_0', kvTypeSource: 'server-log' }, probes: probes() });
    assert.equal(verdict.pass, true);
  });
});

describe('createGuardKey', () => {
  it('is the same for the same settings in another key order', () => {
    const left = createGuardKey(TARGET, { modelVramMiB: 19000, maxUnityEditors: 3 });
    const right = createGuardKey({ numCtx: TARGET.numCtx, modelTag: TARGET.modelTag, baseUrl: TARGET.baseUrl }, { maxUnityEditors: 3, modelVramMiB: 19000 });
    assert.equal(left, right);
  });

  it('changes with the target, the settings and list order', () => {
    const base = createGuardKey(TARGET, SETTINGS);
    assert.notEqual(base, createGuardKey({ ...TARGET, numCtx: 32768 }, SETTINGS));
    assert.notEqual(base, createGuardKey(TARGET, { modelVramMiB: 20000 }));
    assert.notEqual(createGuardKey(TARGET, { patterns: ['a', 'b'] }), createGuardKey(TARGET, { patterns: ['b', 'a'] }));
    assert.equal(createGuardKey(TARGET, { a: undefined, modelVramMiB: 19000 }), createGuardKey(TARGET, SETTINGS));
  });
});
