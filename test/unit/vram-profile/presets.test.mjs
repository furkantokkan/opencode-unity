import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../../../src/cli/exit-codes.js';
import {
  PRESETS_DIR_URL,
  assertPresetAllowed,
  listPresetIds,
  loadAllPresets,
  loadPreset,
  recommendPreset,
  validatePreset,
} from '../../../src/core/presets.js';
import { catchError } from '../../helpers/catch-error.mjs';

const P1 = 'nvidia-24gb-qwen3-coder-30b-16k';
const P2 = 'nvidia-24gb-qwen3-coder-30b-32k';
const REFERENCE_HARDWARE = { platform: /** @type {NodeJS.Platform} */ ('win32'), gpuVendor: 'nvidia', totalVramMiB: 24_564 };

describe('shipped presets (spec 10.2)', () => {
  it('ships exactly P1, P2 and custom', () => {
    assert.deepEqual(listPresetIds(), ['custom', P1, P2]);
  });

  it('validates every shipped file against schema/preset.schema.json', () => {
    for (const preset of loadAllPresets()) assert.deepEqual(validatePreset(preset), [], preset.id);
  });

  it('labels P1 verified with evidence, and P2 and custom experimental with a warning', () => {
    const p1 = loadPreset(P1);
    assert.equal(p1.status, 'verified');
    assert.match(/** @type {string} */ (p1.evidence), /^docs\/evidence\/v0\.1\//);
    assert.deepEqual(p1.reliability.toolCalls, {
      passed: 3,
      runs: 10,
      evidence: 'docs/evidence/v0.1/reference-rtx3090-16k.md',
    }, 'tool-call reliability at 16K is the measured preview series (spec 3.3)');
    assert.deepEqual(p1.reliability.edits, {
      passed: 6,
      runs: 6,
      evidence: 'docs/evidence/v0.1/reference-rtx3090-16k.md',
    });

    const p2 = loadPreset(P2);
    assert.equal(p2.status, 'experimental');
    assert.match(/** @type {string} */ (p2.warning), /driver hang/i);
    assert.equal(p2.model.numCtx, 32_768);
    assert.equal(p2.guard.minFreeVramAfterLoadMiB, 2500);
    assert.equal(p2.guard.maxUnityEditors, 1);

    const custom = loadPreset('custom');
    assert.equal(custom.status, 'experimental');
    assert.equal(custom.model.base, null);
    assert.equal(custom.evidence, null);
  });

  it('keeps the reference preset at the measured 16K configuration', () => {
    const p1 = loadPreset(P1);
    assert.equal(p1.model.numCtx, 16_384);
    assert.equal(p1.model.numKeep, 4);
    assert.deepEqual(p1.opencode.limit, { context: 16_384, output: 4096 });
    assert.deepEqual(p1.model.sampling, { temperature: 0.7, topP: 0.8, topK: 20, repeatPenalty: 1.05 });
    assert.deepEqual(p1.model.vram, { weightsMiB: 17_524, computeMiB: 100, kvMiBPerTokenF16: 0.09375, marginMiB: 500 });
    assert.deepEqual(p1.ollamaServerEnv, {
      OLLAMA_FLASH_ATTENTION: '1',
      OLLAMA_KV_CACHE_TYPE: 'q8_0',
      OLLAMA_NUM_PARALLEL: '1',
      OLLAMA_MAX_LOADED_MODELS: '1',
      OLLAMA_KEEP_ALIVE: '15m',
    });
  });

  it('holds no personal or project content', async () => {
    const dir = fileURLToPath(PRESETS_DIR_URL);
    for (const name of await fs.readdir(dir)) {
      const text = await fs.readFile(`${dir}${name}`, 'utf8');
      assert.equal(/[A-Za-z]:[\\/]Users[\\/]/i.test(text), false, name);
      assert.equal(/@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text), false, name);
    }
  });
});

describe('loadPreset', () => {
  it('rejects an unknown id with exit 1 and lists the known ones', () => {
    const error = catchError(() => loadPreset('nvidia-8gb-mystery'));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.equal(error.code, 'preset_unknown');
    assert.match(error.hint, new RegExp(P1));
  });

  it('rejects a path or a strange id without reading the disk', () => {
    assert.throws(() => loadPreset('../package'), /Unknown preset/);
    assert.throws(() => loadPreset('NVIDIA-24GB'), /Unknown preset/);
  });

  it('reports a preset file whose id does not match its name as a packaging bug', async (t) => {
    const dir = new URL('./broken-presets/', import.meta.url);
    await fs.mkdir(dir, { recursive: true });
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const preset = { ...loadPreset(P1), id: 'other-id' };
    await fs.writeFile(new URL('claims-other-id.json', dir), JSON.stringify(preset));
    const error = catchError(() => loadPreset('claims-other-id', { dir }));
    assert.equal(error.exitCode, EXIT.RUNTIME);
    assert.equal(error.code, 'preset_invalid');
  });
});

describe('assertPresetAllowed (spec 3.1)', () => {
  it('lets verified and reference-tested presets run', () => {
    assertPresetAllowed({ id: P1, status: 'reference-tested' });
    assertPresetAllowed({ id: P1, status: 'verified' });
  });

  it('needs --experimental for an experimental preset and passes its warning on', () => {
    const error = catchError(() => assertPresetAllowed({ id: P2, status: 'experimental', warning: 'the recorded driver hang' }));
    assert.equal(error.exitCode, EXIT.UNSUPPORTED);
    assert.equal(error.code, 'preset_experimental');
    assert.match(error.hint, /driver hang/);
    assertPresetAllowed({ id: P2, status: 'experimental' }, { experimental: true });
  });

  it('refuses planned and unsupported presets even with --experimental', () => {
    for (const status of /** @type {const} */ (['planned', 'unsupported'])) {
      const error = catchError(() => assertPresetAllowed({ id: 'nvidia-12gb-candidate', status }, { experimental: true }));
      assert.equal(error.exitCode, EXIT.UNSUPPORTED);
      assert.equal(error.code, 'preset_unsupported');
    }
  });
});

describe('recommendPreset (spec 14.1 step 3)', () => {
  it('recommends P1 on the reference hardware and never an experimental preset', () => {
    const presets = loadAllPresets();
    assert.equal(recommendPreset(presets, REFERENCE_HARDWARE)?.id, P1);
    assert.equal(
      presets.filter((preset) => preset.status === 'experimental').some((preset) => preset.id === recommendPreset(presets, REFERENCE_HARDWARE)?.id),
      false,
    );
  });

  it('recommends nothing when the hardware does not match', () => {
    const presets = loadAllPresets();
    assert.equal(recommendPreset(presets, { ...REFERENCE_HARDWARE, totalVramMiB: 8192 }), null);
    assert.equal(recommendPreset(presets, { ...REFERENCE_HARDWARE, platform: 'darwin' }), null);
    assert.equal(recommendPreset(presets, { ...REFERENCE_HARDWARE, gpuVendor: 'amd' }), null);
    assert.equal(recommendPreset(presets, { ...REFERENCE_HARDWARE, totalVramMiB: null }), null);
  });

  it('prefers a verified row over a reference-tested one at the same requirement', () => {
    const presets = loadAllPresets();
    const promoted = { ...loadPreset(P1), id: 'nvidia-24gb-promoted', status: /** @type {const} */ ('verified') };
    assert.equal(recommendPreset([...presets, promoted], REFERENCE_HARDWARE)?.id, 'nvidia-24gb-promoted');
  });
});
