import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KV_CACHE_FACTORS, estimateModelVram, formatGiB, normalizeKvCacheType, resolveKvCacheType } from '../../../src/core/vram.js';
import { loadPreset } from '../../../src/core/presets.js';

// Measured on the reference machine (spec 7.4): weights 17,524 MiB, compute 100 MiB at 16K and 116 at 32K.
const QWEN3_CODER_30B = { weightsMiB: 17_524, computeMiB: 100, kvMiBPerTokenF16: 0.09375, marginMiB: 500 };

describe('estimateModelVram (spec 7.4 table)', () => {
  it('reproduces every published row', () => {
    const p1q8 = estimateModelVram(QWEN3_CODER_30B, 16_384, 'q8_0');
    assert.equal(p1q8.kvMiB, 816);
    assert.equal(p1q8.rawMiB, 18_440);
    assert.equal(p1q8.modelVramMiB, 19_000);

    const p1f16 = estimateModelVram(QWEN3_CODER_30B, 16_384, 'f16');
    assert.equal(p1f16.kvMiB, 1536);
    assert.equal(p1f16.rawMiB, 19_160);
    assert.equal(p1f16.modelVramMiB, 20_000);

    const p2 = estimateModelVram({ ...QWEN3_CODER_30B, computeMiB: 116 }, 32_768, 'q8_0');
    assert.equal(p2.kvMiB, 1632);
    assert.equal(p2.rawMiB, 19_272);
    assert.equal(p2.modelVramMiB, 20_000);
  });

  it('matches the measured KV cache of the shipped presets', () => {
    for (const [id, kvMiB] of [
      ['nvidia-24gb-qwen3-coder-30b-16k', 816],
      ['nvidia-24gb-qwen3-coder-30b-32k', 1632],
    ]) {
      const preset = loadPreset(/** @type {string} */ (id));
      const estimate = estimateModelVram(
        /** @type {any} */ (preset.model.vram),
        /** @type {number} */ (preset.model.numCtx),
        'q8_0',
      );
      assert.equal(estimate.kvMiB, kvMiB, id);
    }
  });

  it('rounds up to the next 500 MiB step and then adds the preset margin', () => {
    const estimate = estimateModelVram({ weightsMiB: 1000, computeMiB: 1, kvMiBPerTokenF16: 0.09375, marginMiB: 500 }, 2048, 'f16');
    assert.equal(estimate.rawMiB, 1001 + 192);
    assert.equal(estimate.modelVramMiB, 1500 + 500);
    const noMargin = estimateModelVram({ weightsMiB: 1000, computeMiB: 0, kvMiBPerTokenF16: 0.09375, marginMiB: 0 }, 2048, 'f16');
    assert.equal(noMargin.modelVramMiB, 1500);
  });

  it('refuses an unknown cache type or context size', () => {
    assert.throws(() => estimateModelVram(QWEN3_CODER_30B, 16_384, /** @type {any} */ ('q5_1')), /KV cache type/);
    assert.throws(() => estimateModelVram(QWEN3_CODER_30B, 0, 'f16'), /numCtx/);
  });

  it('uses the documented KV factors', () => {
    assert.equal(KV_CACHE_FACTORS.f16, 1);
    assert.equal(KV_CACHE_FACTORS.q8_0, 34 / 64);
    assert.ok(KV_CACHE_FACTORS.q4_0 < KV_CACHE_FACTORS.q8_0);
  });
});

describe('resolveKvCacheType (spec 7.4)', () => {
  it('prefers what the server log shows over the environment', () => {
    assert.deepEqual(resolveKvCacheType({ serverLogKvType: 'q8_0', env: { OLLAMA_KV_CACHE_TYPE: 'f16' } }), { kvType: 'q8_0', source: 'server-log' });
    assert.deepEqual(resolveKvCacheType({ env: { OLLAMA_KV_CACHE_TYPE: 'q8_0' } }), { kvType: 'q8_0', source: 'env' });
  });

  it('assumes f16, the largest cache, when nothing is known', () => {
    assert.deepEqual(resolveKvCacheType({}), { kvType: 'f16', source: 'default' });
    assert.deepEqual(resolveKvCacheType({ serverLogKvType: 'nonsense', env: { OLLAMA_KV_CACHE_TYPE: '' } }), { kvType: 'f16', source: 'default' });
  });

  it('accepts the spellings logs and environments use', () => {
    assert.equal(normalizeKvCacheType('Q8_0'), 'q8_0');
    assert.equal(normalizeKvCacheType(' fp16 '), 'f16');
    assert.equal(normalizeKvCacheType('bf16'), null);
    assert.equal(normalizeKvCacheType(undefined), null);
  });
});

describe('formatGiB (spec 7.6: no three-digit numbers in guard messages)', () => {
  it('prints GiB with one decimal', () => {
    assert.equal(formatGiB(1500), '1.5 GiB');
    assert.equal(formatGiB(759), '0.7 GiB');
    assert.equal(formatGiB(22_425), '21.9 GiB');
    assert.equal(formatGiB(-10), '0.0 GiB');
    assert.equal(/\b(500|503|429)\b/.test(formatGiB(500)), false);
  });
});
