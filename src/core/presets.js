// Model presets shipped in presets/ (spec 10). Loading migrates the file forward to the current preset
// schema version and validates it against schema/preset.schema.json; status gating and recommendations
// follow the labels in spec 3.1, per operating system since schema version 2 (amendment 33.4, 38.8).
import fs from 'node:fs';
import { compileSchema, formatSchemaErrors } from '../../plugin/opencode-unity-lib/json-schema.js';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { isPlainObject } from './config.js';
import { parseJsonc } from './jsonc.js';
import { migrateDocument } from './migrations.js';

export const PRESETS_DIR_URL = new URL('../../presets/', import.meta.url);
export const PRESET_SCHEMA_URL = new URL('../../schema/preset.schema.json', import.meta.url);
export const CURRENT_PRESET_SCHEMA_VERSION = 2;

/** Platforms a preset may declare support for. */
export const PRESET_PLATFORMS = Object.freeze(['win32', 'linux', 'darwin']);

// Architecture assumed when a caller does not name one. Schema version 1 had no arch field and every
// preset it described was measured on x64, so the migration and the readers agree on one default.
export const DEFAULT_ARCH = 'x64';

// Weakest-wins ordering of the support labels (spec 3.1): a preset is never better supported on one
// platform than it is overall, so the two labels combine by keeping the higher rank.
const STATUS_RANK = Object.freeze({ verified: 0, 'reference-tested': 1, experimental: 2, planned: 3, unsupported: 4 });

/** @typedef {'verified' | 'reference-tested' | 'experimental' | 'planned' | 'unsupported'} SupportStatus */

/**
 * @typedef {object} PresetHardware
 * @property {Partial<Record<'win32' | 'linux' | 'darwin', SupportStatus>>} os  Support label per platform; an absent platform is one the preset does not apply to at all.
 * @property {Array<'x64' | 'arm64'>} arch
 * @property {'nvidia' | 'amd' | 'intel' | 'apple' | null} gpuVendor
 * @property {number} minTotalVramMiB
 */

/**
 * @typedef {object} Preset
 * @property {number} schemaVersion
 * @property {string} id
 * @property {SupportStatus} status
 * @property {string | null} evidence
 * @property {string} [warning]
 * @property {PresetHardware} hardware
 * @property {PresetModel} model
 * @property {Record<string, string>} ollamaServerEnv
 * @property {{ limit: { context: number, output: number } }} opencode
 * @property {Partial<import('./config.js').GuardSettings>} guard
 * @property {{ toolCalls: unknown, edits: unknown, note: string }} reliability
 */

/**
 * @typedef {object} PresetModel
 * @property {string} base
 * @property {number} downloadGiB
 * @property {string} tag
 * @property {string} renderer
 * @property {string} parser
 * @property {number} numCtx
 * @property {number} numKeep
 * @property {number} numBatch
 * @property {{ temperature: number, topP: number, topK: number, repeatPenalty: number }} sampling
 * @property {{ weightsMiB: number, computeMiB: number, kvMiBPerTokenF16: number, marginMiB: number }} vram
 */

/** @type {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaValidator | undefined} */
let presetValidator;

/**
 * @returns {Record<string, any>}
 */
export function readPresetSchema() {
  return JSON.parse(fs.readFileSync(PRESET_SCHEMA_URL, 'utf8'));
}

/**
 * @param {unknown} value
 * @returns {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaError[]}
 */
export function validatePreset(value) {
  presetValidator ??= compileSchema(readPresetSchema());
  return presetValidator(value);
}

/**
 * @param {{ dir?: URL }} [options]
 * @returns {string[]} Preset ids, sorted.
 */
export function listPresetIds({ dir = PRESETS_DIR_URL } = {}) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

/**
 * Preset migrations in order (D-M6). Version 2 turned `hardware.os` from a list of platforms into a map
 * from platform to the support label there, and added `hardware.arch`.
 * @type {readonly import('./migrations.js').Migration[]}
 */
export const PRESET_MIGRATIONS = Object.freeze([
  Object.freeze({
    from: 1,
    summary: 'hardware.os became a per-OS support map and hardware.arch was added',
    migrate: migratePresetToV2,
  }),
]);

/**
 * A version 1 preset said "this preset, at its one support label, applies to these platforms", so each
 * listed platform carries the preset's own label. Writing a constant here instead would have promoted
 * the experimental 32K preset to reference-tested on Windows.
 * @param {Record<string, unknown>} document
 * @returns {Record<string, unknown>}
 */
function migratePresetToV2(document) {
  const hardware = isPlainObject(document.hardware) ? /** @type {Record<string, unknown>} */ (document.hardware) : {};
  const platforms = hardware.os;
  // Anything but an array is not a version 1 `os`; leave it for the schema to reject rather than guess.
  const os = Array.isArray(platforms) ? Object.fromEntries(platforms.map((platform) => [platform, document.status])) : platforms;
  return { ...document, schemaVersion: 2, hardware: { ...hardware, os, arch: hardware.arch ?? [DEFAULT_ARCH] } };
}

/**
 * Migrates one preset document forward to the current schema version. Pure: the input is not changed.
 * @param {unknown} document
 * @param {{ label?: string }} [options]
 * @returns {import('./migrations.js').MigrationResult}
 */
export function migratePreset(document, { label = 'preset' } = {}) {
  return migrateDocument(document, { migrations: PRESET_MIGRATIONS, currentVersion: CURRENT_PRESET_SCHEMA_VERSION, label });
}

/**
 * @param {string} id
 * @param {{ dir?: URL }} [options]
 * @returns {Preset}
 */
export function loadPreset(id, { dir = PRESETS_DIR_URL } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !listPresetIds({ dir }).includes(id)) {
    const known = listPresetIds({ dir }).join(', ');
    throw new CliError(`Unknown preset '${id}'`, { exitCode: EXIT.USAGE, code: 'preset_unknown', data: { preset: id }, hint: `Known presets: ${known}.` });
  }
  const label = `presets/${id}.json`;
  const parsed = parseJsonc(fs.readFileSync(new URL(`${id}.json`, dir), 'utf8'), label);
  // A shipped preset that cannot be migrated or fails its schema is a packaging bug, not a user mistake.
  let migrated;
  try {
    migrated = migratePreset(parsed, { label }).document;
  } catch (error) {
    throw packagingError(`Preset file ${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const problems = validatePreset(migrated);
  if (problems.length > 0) throw packagingError(`Preset file ${label} is invalid: ${formatSchemaErrors(problems)}`);
  const preset = /** @type {Preset} */ (migrated);
  if (preset.id !== id) throw packagingError(`Preset file ${label} declares id '${preset.id}'`);
  if (Object.keys(preset.hardware.os).length === 0) throw packagingError(`Preset file ${label} lists no operating system`);
  return preset;
}

/**
 * @param {string} message
 * @returns {CliError}
 */
function packagingError(message) {
  return new CliError(message, { exitCode: EXIT.RUNTIME, code: 'preset_invalid' });
}

/**
 * @param {{ dir?: URL }} [options]
 * @returns {Preset[]}
 */
export function loadAllPresets(options = {}) {
  return listPresetIds(options).map((id) => loadPreset(id, options));
}

/**
 * The support label of a preset on one platform: the weaker of its overall label and its label for that
 * platform. Null when the preset does not apply to the platform at all, which is the case for every
 * shipped preset but `custom` on macOS (amendment 33.4).
 * @param {{ status: SupportStatus, hardware: PresetHardware }} preset
 * @param {string} platform  A `process.platform` value.
 * @returns {SupportStatus | null}
 */
export function getPresetPlatformStatus(preset, platform) {
  const onPlatform = /** @type {Record<string, SupportStatus | undefined>} */ (preset.hardware.os)[platform];
  if (onPlatform === undefined) return null;
  return STATUS_RANK[onPlatform] >= STATUS_RANK[preset.status] ? onPlatform : preset.status;
}

/**
 * @param {{ hardware: PresetHardware }} preset
 * @param {string} [arch]  A `process.arch` value; x64 when the caller does not name one.
 * @returns {boolean}
 */
export function supportsArch(preset, arch = DEFAULT_ARCH) {
  return /** @type {readonly string[]} */ (preset.hardware.arch).includes(arch);
}

/**
 * Refuses planned and unsupported presets always, and experimental ones without --experimental (exit 8).
 * Naming a platform gates on the per-OS label instead of the overall one and refuses a preset that does
 * not apply to that platform or architecture at all, which is what leaves macOS with only `custom`.
 * @param {{ id: string, status: SupportStatus, warning?: string, hardware?: PresetHardware }} preset
 * @param {{ experimental?: boolean, platform?: string, arch?: string }} [options]
 */
export function assertPresetAllowed(preset, { experimental = false, platform, arch } = {}) {
  let status = preset.status;
  if (platform !== undefined) {
    if (!preset.hardware) throw new TypeError('assertPresetAllowed needs preset.hardware to gate on a platform');
    const onPlatform = getPresetPlatformStatus({ status: preset.status, hardware: preset.hardware }, platform);
    if (onPlatform === null) {
      throw new CliError(`Preset '${preset.id}' does not support ${platform}`, {
        exitCode: EXIT.UNSUPPORTED,
        code: 'preset_platform_unsupported',
        data: { preset: preset.id, platform },
        hint: 'Re-run with --experimental --preset custom, and supply the model and video-memory numbers for this machine.',
      });
    }
    if (!supportsArch({ hardware: preset.hardware }, arch)) {
      throw new CliError(`Preset '${preset.id}' does not support ${arch ?? DEFAULT_ARCH}`, {
        exitCode: EXIT.UNSUPPORTED,
        code: 'preset_arch_unsupported',
        data: { preset: preset.id, arch: arch ?? DEFAULT_ARCH },
        hint: 'Re-run with --experimental --preset custom, and supply the model and video-memory numbers for this machine.',
      });
    }
    status = onPlatform;
  }
  if (status === 'planned' || status === 'unsupported') {
    throw new CliError(`Preset '${preset.id}' is ${status} and cannot be used`, {
      exitCode: EXIT.UNSUPPORTED,
      code: 'preset_unsupported',
      data: { preset: preset.id, status },
    });
  }
  if (status === 'experimental' && !experimental) {
    throw new CliError(`Preset '${preset.id}' is experimental and needs --experimental`, {
      exitCode: EXIT.UNSUPPORTED,
      code: 'preset_experimental',
      data: { preset: preset.id, status },
      hint: preset.warning,
    });
  }
}

/**
 * @typedef {object} HardwareInfo
 * @property {NodeJS.Platform} platform
 * @property {string} [arch]  A `process.arch` value; x64 when the caller does not name one.
 * @property {string | null} gpuVendor
 * @property {number | null} totalVramMiB
 */

/**
 * The preset setup offers by default. Only presets that are verified or reference-tested *on this
 * platform* are ever recommended, so experimental presets (the 32K one included) are never the default
 * and a preset that is merely experimental on Linux is not offered there. Among matches, the one that
 * needs the most VRAM wins, because it uses the card best. Null when nothing fits.
 * @param {readonly Preset[]} presets
 * @param {HardwareInfo} hardware
 * @returns {Preset | null}
 */
export function recommendPreset(presets, hardware) {
  const candidates = presets.filter((preset) => {
    const status = getPresetPlatformStatus(preset, hardware.platform);
    return (
      (status === 'verified' || status === 'reference-tested') &&
      supportsArch(preset, hardware.arch) &&
      preset.hardware.gpuVendor === hardware.gpuVendor &&
      hardware.totalVramMiB !== null &&
      preset.hardware.minTotalVramMiB <= hardware.totalVramMiB
    );
  });
  candidates.sort((a, b) => b.hardware.minTotalVramMiB - a.hardware.minTotalVramMiB || STATUS_RANK[a.status] - STATUS_RANK[b.status] || compareText(a.id, b.id));
  return candidates[0] ?? null;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
