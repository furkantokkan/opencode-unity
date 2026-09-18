import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT } from '../../../src/cli/exit-codes.js';
import { assertPresetAllowed, loadAllPresets, loadPreset, recommendPreset } from '../../../src/core/presets.js';
import { catchError } from '../../helpers/catch-error.mjs';

const P1 = 'nvidia-24gb-qwen3-coder-30b-16k';
const P2 = 'nvidia-24gb-qwen3-coder-30b-32k';
const REFERENCE_HARDWARE = { platform: /** @type {NodeJS.Platform} */ ('win32'), arch: 'x64', gpuVendor: 'nvidia', totalVramMiB: 24_564 };

describe('assertPresetAllowed per operating system (amendment 33.4)', () => {
  it('lets the reference preset run on Windows without --experimental', () => {
    assertPresetAllowed(loadPreset(P1), { platform: 'win32', arch: 'x64' });
  });

  it('needs --experimental for the reference preset on Linux, where it is only experimental', () => {
    const error = catchError(() => assertPresetAllowed(loadPreset(P1), { platform: 'linux', arch: 'x64' }));
    assert.equal(error.exitCode, EXIT.UNSUPPORTED);
    assert.equal(error.code, 'preset_experimental');
    assertPresetAllowed(loadPreset(P1), { platform: 'linux', arch: 'x64', experimental: true });
  });

  it('needs --experimental for the 32K preset on Windows too, and passes its warning on', () => {
    const error = catchError(() => assertPresetAllowed(loadPreset(P2), { platform: 'win32', arch: 'x64' }));
    assert.equal(error.code, 'preset_experimental');
    assert.match(error.hint, /driver hang/i);
  });

  it('refuses a preset the platform does not list at all, and points at the custom preset', () => {
    for (const id of [P1, P2]) {
      const error = catchError(() => assertPresetAllowed(loadPreset(id), { platform: 'darwin', arch: 'arm64', experimental: true }));
      assert.equal(error.exitCode, EXIT.UNSUPPORTED);
      assert.equal(error.code, 'preset_platform_unsupported');
      assert.deepEqual(error.data, { preset: id, platform: 'darwin' });
      assert.match(error.hint, /--experimental --preset custom/);
    }
  });

  it('leaves macOS with exactly --experimental --preset custom', () => {
    const custom = loadPreset('custom');
    const error = catchError(() => assertPresetAllowed(custom, { platform: 'darwin', arch: 'arm64' }));
    assert.equal(error.code, 'preset_experimental');
    assertPresetAllowed(custom, { platform: 'darwin', arch: 'arm64', experimental: true });

    const allowedOnDarwin = loadAllPresets().filter((preset) => {
      try {
        assertPresetAllowed(preset, { platform: 'darwin', arch: 'arm64', experimental: true });
        return true;
      } catch {
        return false;
      }
    });
    assert.deepEqual(
      allowedOnDarwin.map((preset) => preset.id),
      ['custom'],
    );
  });

  it('refuses an architecture the preset was never measured on', () => {
    const error = catchError(() => assertPresetAllowed(loadPreset(P1), { platform: 'linux', arch: 'arm64', experimental: true }));
    assert.equal(error.exitCode, EXIT.UNSUPPORTED);
    assert.equal(error.code, 'preset_arch_unsupported');
    assert.deepEqual(error.data, { preset: P1, arch: 'arm64' });
  });

  it('gates on the overall label when the caller names no platform, as before', () => {
    assertPresetAllowed({ id: P1, status: 'reference-tested' });
    assert.equal(catchError(() => assertPresetAllowed({ id: P2, status: 'experimental' })).code, 'preset_experimental');
    assert.equal(catchError(() => assertPresetAllowed({ id: 'later', status: 'planned' }, { experimental: true })).code, 'preset_unsupported');
  });

  it('refuses a planned or unsupported platform label even with --experimental', () => {
    const preset = { id: 'later', status: /** @type {const} */ ('experimental'), hardware: /** @type {any} */ ({ os: { linux: 'planned' }, arch: ['x64'], gpuVendor: 'amd', minTotalVramMiB: 0 }) };
    const error = catchError(() => assertPresetAllowed(preset, { platform: 'linux', arch: 'x64', experimental: true }));
    assert.equal(error.code, 'preset_unsupported');
    assert.deepEqual(error.data, { preset: 'later', status: 'planned' });
  });

  it('is a programming error to gate on a platform without the hardware block', () => {
    assert.throws(() => assertPresetAllowed({ id: P1, status: 'reference-tested' }, { platform: 'win32' }), TypeError);
  });
});

describe('recommendPreset per operating system', () => {
  it('recommends the reference preset on the reference hardware', () => {
    assert.equal(recommendPreset(loadAllPresets(), REFERENCE_HARDWARE)?.id, P1);
  });

  it('recommends nothing on Linux, where no shipped preset is better than experimental', () => {
    assert.equal(recommendPreset(loadAllPresets(), { ...REFERENCE_HARDWARE, platform: 'linux' }), null);
  });

  it('recommends nothing on macOS, because no preset ships for Apple silicon in v0.1', () => {
    assert.equal(recommendPreset(loadAllPresets(), { ...REFERENCE_HARDWARE, platform: 'darwin', arch: 'arm64', gpuVendor: 'apple' }), null);
  });

  it('recommends nothing on an architecture the presets were not measured on', () => {
    assert.equal(recommendPreset(loadAllPresets(), { ...REFERENCE_HARDWARE, arch: 'arm64' }), null);
  });

  it('assumes x64 when the caller does not know the architecture', () => {
    const { arch, ...withoutArch } = REFERENCE_HARDWARE;
    assert.equal(recommendPreset(loadAllPresets(), withoutArch)?.id, P1);
  });

  it('prefers a preset that is verified on this platform over one that is only reference-tested', () => {
    const p1 = loadPreset(P1);
    const promoted = {
      ...structuredClone(p1),
      id: 'nvidia-24gb-promoted',
      status: /** @type {const} */ ('verified'),
      hardware: { ...structuredClone(p1.hardware), os: { win32: /** @type {const} */ ('verified') } },
    };
    assert.equal(recommendPreset([...loadAllPresets(), promoted], REFERENCE_HARDWARE)?.id, 'nvidia-24gb-promoted');
  });
});
