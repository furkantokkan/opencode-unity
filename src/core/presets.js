// Model presets shipped in presets/ (spec 10). Loading validates each file against
// schema/preset.schema.json; status gating and recommendations follow the labels in spec 3.1.
import fs from 'node:fs';
import { compileSchema, formatSchemaErrors } from '../../plugin/opencode-unity-lib/json-schema.js';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { parseJsonc } from './jsonc.js';

export const PRESETS_DIR_URL = new URL('../../presets/', import.meta.url);
export const PRESET_SCHEMA_URL = new URL('../../schema/preset.schema.json', import.meta.url);

/** @typedef {'verified' | 'reference-tested' | 'experimental' | 'planned' | 'unsupported'} SupportStatus */

/**
 * @typedef {object} Preset
 * @property {number} schemaVersion
 * @property {string} id
 * @property {SupportStatus} status
 * @property {string | null} evidence
 * @property {string} [warning]
 * @property {{ os: NodeJS.Platform[], gpuVendor: string, minTotalVramMiB: number }} hardware
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
 * @param {string} id
 * @param {{ dir?: URL }} [options]
 * @returns {Preset}
 */
export function loadPreset(id, { dir = PRESETS_DIR_URL } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !listPresetIds({ dir }).includes(id)) {
    const known = listPresetIds({ dir }).join(', ');
    throw new CliError(`Unknown preset '${id}'`, { exitCode: EXIT.USAGE, code: 'preset_unknown', data: { preset: id }, hint: `Known presets: ${known}.` });
  }
  const fileUrl = new URL(`${id}.json`, dir);
  const preset = parseJsonc(fs.readFileSync(fileUrl, 'utf8'), `presets/${id}.json`);
  const problems = validatePreset(preset);
  if (problems.length > 0) {
    // A shipped preset that fails its schema is a packaging bug, not a user mistake.
    throw new CliError(`Preset file presets/${id}.json is invalid: ${formatSchemaErrors(problems)}`, { exitCode: EXIT.RUNTIME, code: 'preset_invalid' });
  }
  if (/** @type {Preset} */ (preset).id !== id) {
    throw new CliError(`Preset file presets/${id}.json declares id '${/** @type {Preset} */ (preset).id}'`, { exitCode: EXIT.RUNTIME, code: 'preset_invalid' });
  }
  return /** @type {Preset} */ (preset);
}

/**
 * @param {{ dir?: URL }} [options]
 * @returns {Preset[]}
 */
export function loadAllPresets(options = {}) {
  return listPresetIds(options).map((id) => loadPreset(id, options));
}

/**
 * Refuses planned and unsupported presets always, and experimental ones without --experimental (exit 8).
 * @param {{ id: string, status: SupportStatus, warning?: string }} preset
 * @param {{ experimental?: boolean }} [options]
 */
export function assertPresetAllowed(preset, { experimental = false } = {}) {
  if (preset.status === 'planned' || preset.status === 'unsupported') {
    throw new CliError(`Preset '${preset.id}' is ${preset.status} and cannot be used`, {
      exitCode: EXIT.UNSUPPORTED,
      code: 'preset_unsupported',
      data: { preset: preset.id, status: preset.status },
    });
  }
  if (preset.status === 'experimental' && !experimental) {
    throw new CliError(`Preset '${preset.id}' is experimental and needs --experimental`, {
      exitCode: EXIT.UNSUPPORTED,
      code: 'preset_experimental',
      data: { preset: preset.id, status: preset.status },
      hint: preset.warning,
    });
  }
}

/**
 * @typedef {object} HardwareInfo
 * @property {NodeJS.Platform} platform
 * @property {string | null} gpuVendor
 * @property {number | null} totalVramMiB
 */

/**
 * The preset setup offers by default. Only verified and reference-tested presets are ever recommended, so
 * experimental presets (the 32K one included) are never the default. Among matches, the one that needs
 * the most VRAM wins, because it uses the card best. Null when nothing fits.
 * @param {readonly Preset[]} presets
 * @param {HardwareInfo} hardware
 * @returns {Preset | null}
 */
export function recommendPreset(presets, hardware) {
  const candidates = presets.filter(
    (preset) =>
      (preset.status === 'verified' || preset.status === 'reference-tested') &&
      preset.hardware.os.includes(hardware.platform) &&
      preset.hardware.gpuVendor === hardware.gpuVendor &&
      hardware.totalVramMiB !== null &&
      preset.hardware.minTotalVramMiB <= hardware.totalVramMiB,
  );
  candidates.sort((a, b) => b.hardware.minTotalVramMiB - a.hardware.minTotalVramMiB || statusRank(a.status) - statusRank(b.status) || compareText(a.id, b.id));
  return candidates[0] ?? null;
}

/**
 * @param {SupportStatus} status
 * @returns {number}
 */
function statusRank(status) {
  return status === 'verified' ? 0 : 1;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
