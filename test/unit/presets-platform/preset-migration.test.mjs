import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT } from '../../../src/cli/exit-codes.js';
import { CURRENT_PRESET_SCHEMA_VERSION, PRESET_MIGRATIONS, loadAllPresets, loadPreset, migratePreset, validatePreset } from '../../../src/core/presets.js';
import { catchError } from '../../helpers/catch-error.mjs';

const P1 = 'nvidia-24gb-qwen3-coder-30b-16k';
const P2 = 'nvidia-24gb-qwen3-coder-30b-32k';

/**
 * The schema version 1 form of a preset: one support label for the whole file, a flat platform list and
 * no arch. Every preset the product shipped at version 1 listed win32 and nothing else.
 * @param {any} preset
 * @param {string[]} [os]
 * @returns {Record<string, unknown>}
 */
function toV1(preset, os = ['win32']) {
  const clone = structuredClone(preset);
  const { arch, ...hardware } = clone.hardware;
  return { ...clone, schemaVersion: 1, hardware: { ...hardware, os } };
}

describe('preset schema @1 -> @2 (amendment 33.4, 38.8; D-M6)', () => {
  it('turns the platform list into a support map and defaults arch to x64', () => {
    const { document, fromVersion, toVersion, applied } = migratePreset(toV1(loadPreset(P1)));
    assert.equal(fromVersion, 1);
    assert.equal(toVersion, CURRENT_PRESET_SCHEMA_VERSION);
    assert.equal(applied.length, 1);
    assert.equal(document.schemaVersion, 2);
    assert.deepEqual(document.hardware, {
      os: { win32: 'verified' },
      arch: ['x64'],
      gpuVendor: 'nvidia',
      minTotalVramMiB: 24_000,
    });
  });

  it('gives every listed platform the label the preset already carried, not a constant', () => {
    // A constant "reference-tested" would have promoted the experimental 32K preset on Windows.
    const migrated = migratePreset(toV1(loadPreset(P2), ['win32', 'linux'])).document;
    assert.deepEqual(/** @type {any} */ (migrated).hardware.os, { win32: 'experimental', linux: 'experimental' });
  });

  it('leaves the document it was given untouched', () => {
    const before = toV1(loadPreset(P1));
    const snapshot = structuredClone(before);
    migratePreset(before);
    assert.deepEqual(before, snapshot);
  });

  it('produces a document that validates against schema version 2, for every shipped preset', () => {
    for (const preset of loadAllPresets()) {
      assert.deepEqual(validatePreset(migratePreset(toV1(preset)).document), [], preset.id);
    }
  });

  it('passes a current document through unchanged and applies no step', () => {
    const preset = loadPreset(P1);
    const result = migratePreset(preset);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.document, preset);
  });

  it('refuses a document newer than this CLI understands instead of guessing', () => {
    const error = catchError(() => migratePreset({ ...loadPreset(P1), schemaVersion: CURRENT_PRESET_SCHEMA_VERSION + 1 }));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.equal(error.code, 'config_too_new');
  });

  it('keeps an arch that is already present', () => {
    const v1 = { ...toV1(loadPreset(P1)), hardware: { os: ['darwin'], arch: ['arm64'], gpuVendor: 'apple', minTotalVramMiB: 0 } };
    assert.deepEqual(/** @type {any} */ (migratePreset(v1).document).hardware.arch, ['arm64']);
  });

  it('does not invent a map when hardware.os is not a version 1 list, so the schema rejects it', () => {
    const v1 = { ...toV1(loadPreset(P1)), hardware: { os: 'win32', gpuVendor: 'nvidia', minTotalVramMiB: 0 } };
    const migrated = migratePreset(v1).document;
    assert.equal(/** @type {any} */ (migrated).hardware.os, 'win32');
    assert.ok(validatePreset(migrated).length > 0);
  });

  it('ships exactly one step, from version 1', () => {
    assert.deepEqual(
      PRESET_MIGRATIONS.map((step) => step.from),
      [1],
    );
  });
});
