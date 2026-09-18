import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { EXIT } from '../../../src/cli/exit-codes.js';
import {
  CURRENT_PRESET_SCHEMA_VERSION,
  DEFAULT_ARCH,
  PRESET_PLATFORMS,
  getPresetPlatformStatus,
  loadAllPresets,
  loadPreset,
  supportsArch,
} from '../../../src/core/presets.js';
import { catchError } from '../../helpers/catch-error.mjs';

const P1 = 'nvidia-24gb-qwen3-coder-30b-16k';
const P2 = 'nvidia-24gb-qwen3-coder-30b-32k';

/**
 * Writes preset files into a fresh temp directory and returns the URL loadPreset wants.
 * @param {import('node:test').TestContext} t
 * @param {Record<string, unknown>} files  Preset id to document.
 * @returns {Promise<URL>}
 */
async function presetDir(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocu-presets-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [id, document] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(document, null, 2));
  }
  return pathToFileURL(`${dir}${path.sep}`);
}

describe('shipped presets at schema version 2', () => {
  it('declares a per-OS support map and an arch on every file', () => {
    for (const preset of loadAllPresets()) {
      assert.equal(preset.schemaVersion, CURRENT_PRESET_SCHEMA_VERSION, preset.id);
      assert.ok(Object.keys(preset.hardware.os).length > 0, preset.id);
      assert.ok(
        Object.keys(preset.hardware.os).every((platform) => PRESET_PLATFORMS.includes(platform)),
        preset.id,
      );
      assert.ok(preset.hardware.arch.length > 0, preset.id);
    }
  });

  it('keeps the reference preset verified on Windows and experimental on Linux', () => {
    assert.deepEqual(loadPreset(P1).hardware.os, { win32: 'verified', linux: 'experimental' });
    assert.deepEqual(loadPreset(P1).hardware.arch, ['x64']);
  });

  it('keeps the 32K preset experimental on every platform it lists', () => {
    assert.deepEqual(loadPreset(P2).hardware.os, { win32: 'experimental', linux: 'experimental' });
  });

  it('ships no preset for macOS but custom, which the user supplies the hardware for', () => {
    const onDarwin = loadAllPresets().filter((preset) => preset.hardware.os.darwin !== undefined);
    assert.deepEqual(
      onDarwin.map((preset) => preset.id),
      ['custom'],
    );
    const custom = loadPreset('custom');
    assert.deepEqual(custom.hardware.os, { win32: 'experimental', linux: 'experimental', darwin: 'experimental' });
    assert.deepEqual(custom.hardware.arch, ['x64', 'arm64']);
    assert.equal(custom.hardware.gpuVendor, null, 'the user supplies the accelerator for the custom preset');
  });

  it('is the only preset family that reaches arm64', () => {
    const onArm = loadAllPresets().filter((preset) => supportsArch(preset, 'arm64'));
    assert.deepEqual(
      onArm.map((preset) => preset.id),
      ['custom'],
    );
  });
});

describe('getPresetPlatformStatus', () => {
  const hardware = { os: { win32: 'verified', linux: 'experimental' }, arch: ['x64'], gpuVendor: 'nvidia', minTotalVramMiB: 0 };

  it('returns the label the preset carries for that platform', () => {
    assert.equal(getPresetPlatformStatus(/** @type {any} */ ({ status: 'verified', hardware }), 'win32'), 'verified');
    assert.equal(getPresetPlatformStatus(/** @type {any} */ ({ status: 'verified', hardware }), 'linux'), 'experimental');
  });

  it('returns null for a platform the preset does not list', () => {
    assert.equal(getPresetPlatformStatus(/** @type {any} */ ({ status: 'verified', hardware }), 'darwin'), null);
    for (const preset of [loadPreset(P1), loadPreset(P2)]) assert.equal(getPresetPlatformStatus(preset, 'darwin'), null);
  });

  it('never reports a platform as better supported than the preset as a whole', () => {
    assert.equal(getPresetPlatformStatus(/** @type {any} */ ({ status: 'experimental', hardware }), 'win32'), 'experimental');
    assert.equal(getPresetPlatformStatus(/** @type {any} */ ({ status: 'planned', hardware }), 'linux'), 'planned');
  });
});

describe('supportsArch', () => {
  it('assumes x64 when the caller does not name an architecture, as the migration does', () => {
    assert.equal(DEFAULT_ARCH, 'x64');
    assert.equal(supportsArch(loadPreset(P1)), true);
    assert.equal(supportsArch(loadPreset(P1), 'arm64'), false);
    assert.equal(supportsArch(loadPreset('custom'), 'arm64'), true);
  });
});

describe('loadPreset with a version 1 file on disk', () => {
  it('migrates it in memory and leaves the file alone', async (t) => {
    const clone = structuredClone(loadPreset(P1));
    const { arch, ...hardware } = clone.hardware;
    const v1 = { ...clone, schemaVersion: 1, hardware: { ...hardware, os: ['win32'] } };
    const dir = await presetDir(t, { [P1]: v1 });

    const loaded = loadPreset(P1, { dir });
    assert.equal(loaded.schemaVersion, 2);
    assert.deepEqual(loaded.hardware.os, { win32: 'verified' });
    assert.deepEqual(loaded.hardware.arch, ['x64']);

    const onDisk = JSON.parse(await fs.readFile(new URL(`${P1}.json`, dir), 'utf8'));
    assert.equal(onDisk.schemaVersion, 1, 'presets ship read-only; loading never rewrites one');
  });

  it('reports a file that lists no operating system as a packaging bug', async (t) => {
    const broken = { ...structuredClone(loadPreset(P1)), hardware: { ...loadPreset(P1).hardware, os: {} } };
    const dir = await presetDir(t, { [P1]: broken });
    const error = catchError(() => loadPreset(P1, { dir }));
    assert.equal(error.exitCode, EXIT.RUNTIME);
    assert.equal(error.code, 'preset_invalid');
    assert.match(error.message, /operating system/);
  });

  it('reports a file from a newer schema version as a packaging bug, not a user mistake', async (t) => {
    const future = { ...structuredClone(loadPreset(P1)), schemaVersion: CURRENT_PRESET_SCHEMA_VERSION + 1 };
    const dir = await presetDir(t, { [P1]: future });
    const error = catchError(() => loadPreset(P1, { dir }));
    assert.equal(error.exitCode, EXIT.RUNTIME);
    assert.equal(error.code, 'preset_invalid');
  });

  it('reports an unknown platform key through the schema', async (t) => {
    const broken = { ...structuredClone(loadPreset(P1)), hardware: { ...loadPreset(P1).hardware, os: { freebsd: 'experimental' } } };
    const dir = await presetDir(t, { [P1]: broken });
    const error = catchError(() => loadPreset(P1, { dir }));
    assert.equal(error.exitCode, EXIT.RUNTIME);
    assert.match(error.message, /freebsd/);
  });
});
