// Resolves config.json, a preset and its overrides into the one runtime profile that drives the plugin,
// the Modelfile, the limits and the VRAM estimate (spec 6.3, 7.4, 8.8, 10). Everything here is pure:
// callers read files and pass values in, so every rule is testable without a disk or a GPU.
import fs from 'node:fs';
import path from 'node:path';
import { formatSchemaErrors } from '../../plugin/opencode-unity-lib/json-schema.js';
import { RUNTIME_PROFILE_SCHEMA_VERSION, validateRuntimeProfile } from '../../plugin/opencode-unity-lib/runtime-profile.js';
import { getPromptBudget } from '../../plugin/opencode-unity-lib/tokens.js';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { deepFreeze, isPlainObject, mergeDeep } from './config.js';
import { stringifyJson } from './jsonc.js';
import { assertPresetAllowed, validatePreset } from './presets.js';
import { estimateModelVram } from './vram.js';

export const COMPAT_URL = new URL('../../compat.json', import.meta.url);
export const PROVIDER_ID = 'opencode-unity';
export const PROVIDER_NPM = '@ai-sdk/openai-compatible';
export const PROVIDER_NAME = 'Local model (opencode-unity)';
export const DEFAULT_KEEP_ALIVE = '15m';
// Conservative allowances until `doctor --capture` measures the real tool JSON (spec 6.3, 8.8).
export const DEFAULT_TOOLS_TOKENS = deepFreeze({ 'unity-code': 3400, 'unity-editor': 3000 });
export const DEFAULT_TOOLS_TOKENS_SOURCE = 'default-allowance';

// Preset fields rendered into the Modelfile. Changing one without a new tag would give two different
// models the same name (spec 22: a Modelfile change appends -r<n>).
const MODELFILE_FIELDS = Object.freeze([
  'model.base',
  'model.renderer',
  'model.parser',
  'model.numCtx',
  'model.numBatch',
  'model.sampling.temperature',
  'model.sampling.topP',
  'model.sampling.topK',
  'model.sampling.repeatPenalty',
]);

// Fields a usable profile needs; the custom preset ships them as null.
const REQUIRED_FIELDS = Object.freeze([
  'model.base',
  'model.tag',
  'model.renderer',
  'model.parser',
  'model.numCtx',
  'model.sampling.temperature',
  'model.sampling.topP',
  'model.sampling.topK',
  'model.sampling.repeatPenalty',
  'model.vram.weightsMiB',
  'model.vram.computeMiB',
  'model.vram.kvMiBPerTokenF16',
  'opencode.limit.context',
  'opencode.limit.output',
]);

/** @typedef {import('./presets.js').Preset} Preset */
/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile} RuntimeProfile */

/**
 * @typedef {object} ResolvedPreset
 * @property {Preset} preset              Overrides applied and complete (no null required fields).
 * @property {boolean} custom             Any override changed a value, or the preset is `custom`.
 * @property {string[]} overriddenPaths   Dotted preset paths that overrides changed, sorted.
 * @property {import('./presets.js').SupportStatus} status  `experimental` whenever custom.
 */

/**
 * Applies `config.overrides` to a preset and checks the result (exit 1 on a problem the user can fix).
 * @param {Preset} preset
 * @param {Record<string, unknown>} [overrides]
 * @returns {ResolvedPreset}
 */
export function resolvePreset(preset, overrides = {}) {
  const merged = /** @type {Preset} */ (mergeDeep(preset, overrides));
  const problems = validatePreset(merged);
  if (problems.length > 0) {
    throw configError(`Preset '${preset.id}' with the overrides in config.json is invalid: ${formatSchemaErrors(problems)}`, 'Check the overrides block against docs/presets.md.');
  }
  const overriddenPaths = listChangedPaths(preset, merged);
  const missing = REQUIRED_FIELDS.filter((field) => getPath(merged, field) === null);
  if (missing.length > 0) {
    throw configError(`Preset '${preset.id}' needs values for: ${missing.map((field) => `overrides.${field}`).join(', ')}`, 'Set them in the overrides block of config.json.');
  }
  const { numCtx } = merged.model;
  const limit = merged.opencode.limit;
  if (/** @type {number} */ (limit.context) > /** @type {number} */ (numCtx)) {
    throw configError(`opencode.limit.context ${limit.context} is larger than model.numCtx ${numCtx}; Ollama would truncate prompts`);
  }
  if (/** @type {number} */ (limit.output) >= /** @type {number} */ (limit.context)) {
    throw configError(`opencode.limit.output ${limit.output} must be smaller than opencode.limit.context ${limit.context}`);
  }
  const changedModelfileFields = MODELFILE_FIELDS.filter((field) => overriddenPaths.includes(field));
  if (changedModelfileFields.length > 0 && !overriddenPaths.includes('model.tag')) {
    throw configError(
      `The overrides change Modelfile values (${changedModelfileFields.join(', ')}) but keep the preset tag '${merged.model.tag}'`,
      `Set overrides.model.tag to a new tag, for example '${merged.model.tag}-r2'.`,
    );
  }
  const custom = overriddenPaths.length > 0 || preset.id === 'custom';
  return { preset: merged, custom, overriddenPaths, status: custom ? 'experimental' : preset.status };
}

/**
 * Preset guard values replace config.json guard values, because a preset such as the 32K one needs a
 * stricter guard. Changing them takes `overrides.guard`, which marks the profile custom. A config value
 * that is replaced produces a warning.
 * @param {Config['guard']} configGuard       With defaults applied.
 * @param {Record<string, unknown>} presetGuard  From the resolved preset.
 * @param {Record<string, unknown>} [userGuard]  The guard block as written in config.json, if any.
 * @returns {{ settings: Config['guard'], warnings: string[] }}
 */
export function resolveGuardSettings(configGuard, presetGuard, userGuard = {}) {
  const settings = /** @type {Config['guard']} */ ({ ...structuredClone(configGuard), ...structuredClone(presetGuard) });
  const warnings = Object.keys(presetGuard)
    .filter((key) => userGuard[key] !== undefined && JSON.stringify(userGuard[key]) !== JSON.stringify(presetGuard[key]))
    .map((key) => `config.json guard.${key} (${JSON.stringify(userGuard[key])}) is replaced by the preset value ${JSON.stringify(presetGuard[key])}; use overrides.guard.${key} to change it`);
  return { settings, warnings };
}

/**
 * @typedef {object} ProfileInput
 * @property {Config} config
 * @property {Record<string, any>} [userConfig]   config.json as written (LoadedConfig.user), for warnings.
 * @property {Preset} preset                      As loaded from presets/, before overrides.
 * @property {string} cliVersion
 * @property {string} home                        Absolute opencode-unity home.
 * @property {{ opencode: { tested: string }, ollama: { tested: string } }} [compat]
 * @property {{ kvType: import('./vram.js').KvCacheType, source: import('./vram.js').KvCacheTypeSource }} [kv]
 *   Unknown KV type means f16, the largest cache (spec 7.4).
 * @property {{ values: { 'unity-code': number, 'unity-editor': number }, source: string }} [toolsTokens]
 */

/**
 * @typedef {object} ProfileResult
 * @property {RuntimeProfile} profile
 * @property {ResolvedPreset} resolved
 * @property {import('./vram.js').VramEstimate} vram
 * @property {string[]} warnings
 */

/**
 * Builds and validates the runtime profile. Throws exit 1 for fixable config problems and exit 8 for a
 * planned or unsupported preset. Experimental gating is separate (assertProfileAllowed), so doctor can
 * still describe an experimental profile.
 * @param {ProfileInput} input
 * @returns {ProfileResult}
 */
export function buildRuntimeProfile({
  config,
  userConfig = {},
  preset,
  cliVersion,
  home,
  compat = loadCompat(),
  kv = { kvType: 'f16', source: 'default' },
  toolsTokens = { values: DEFAULT_TOOLS_TOKENS, source: DEFAULT_TOOLS_TOKENS_SOURCE },
}) {
  if (!path.win32.isAbsolute(home) && !path.posix.isAbsolute(home)) throw new TypeError(`home must be an absolute path, got '${home}'`);
  const resolved = resolvePreset(preset, config.overrides);
  assertPresetAllowed({ id: preset.id, status: resolved.status }, { experimental: true });
  const model = resolved.preset.model;
  const numCtx = /** @type {number} */ (model.numCtx);
  const limit = { context: /** @type {number} */ (resolved.preset.opencode.limit.context), output: /** @type {number} */ (resolved.preset.opencode.limit.output) };
  const guard = resolveGuardSettings(config.guard, resolved.preset.guard, isPlainObject(userConfig.guard) ? userConfig.guard : {});
  const vram = estimateModelVram(/** @type {import('./vram.js').VramInputs} */ (model.vram), numCtx, kv.kvType);
  const promptBudget = getPromptBudget({ context: limit.context, output: limit.output, reserveTokens: config.budget.reserveTokens });
  if (promptBudget < 1) {
    throw configError(`The prompt budget is ${promptBudget}: limit.context ${limit.context} - limit.output ${limit.output} - budget.reserveTokens ${config.budget.reserveTokens} leaves no room`);
  }
  const baseUrl = config.ollama.baseUrl.replace(/\/+$/, '');

  /** @type {RuntimeProfile} */
  const profile = {
    schemaVersion: RUNTIME_PROFILE_SCHEMA_VERSION,
    cliVersion,
    presetId: preset.id,
    presetStatus: /** @type {RuntimeProfile['presetStatus']} */ (resolved.status),
    custom: resolved.custom,
    overriddenPaths: resolved.overriddenPaths,
    provider: {
      id: PROVIDER_ID,
      npm: PROVIDER_NPM,
      name: PROVIDER_NAME,
      baseURL: `${baseUrl}/v1`,
      modelTag: /** @type {string} */ (model.tag),
      numCtx,
      limit,
      sampling: /** @type {RuntimeProfile['provider']['sampling']} */ (structuredClone(model.sampling)),
      numKeep: model.numKeep,
      keepAlive: resolved.preset.ollamaServerEnv.OLLAMA_KEEP_ALIVE ?? DEFAULT_KEEP_ALIVE,
    },
    ollama: { baseUrl },
    guard: { modelVramMiB: vram.modelVramMiB, kvType: vram.kvType, kvTypeSource: kv.source, ...guard.settings },
    budget: {
      promptBudget,
      toolsTokens: { ...toolsTokens.values },
      toolsTokensSource: toolsTokens.source,
      ...structuredClone(config.budget),
    },
    // Config may also carry workspace policy settings. Keep the plugin's versioned
    // profile limited to the settings its validator and consumers support.
    safety: {
      bashMode: config.safety.bashMode,
      readLimitLines: config.safety.readLimitLines,
      extraProtectedEditGlobs: [...config.safety.extraProtectedEditGlobs],
      extraProtectedReadGlobs: [...config.safety.extraProtectedReadGlobs],
    },
    home,
    compat: { opencode: compat.opencode.tested, ollama: compat.ollama.tested },
  };
  const problems = validateRuntimeProfile(profile);
  if (problems.length > 0) {
    throw new CliError(`The runtime profile for preset '${preset.id}' is invalid: ${problems.slice(0, 5).join('; ')}`, { exitCode: EXIT.RUNTIME, code: 'profile_invalid', data: { problems } });
  }
  const warnings = [...guard.warnings];
  if (resolved.custom) warnings.push(`The profile is custom (experimental): ${resolved.overriddenPaths.length > 0 ? `overrides change ${resolved.overriddenPaths.join(', ')}` : 'the custom preset is not measured'}`);
  if (kv.source === 'default') warnings.push('The Ollama KV cache type is unknown, so the VRAM estimate assumes f16 (the largest cache)');
  return { profile: deepFreeze(profile), resolved, vram, warnings };
}

/**
 * Exit 8 for an experimental or custom profile without --experimental (or experimental.presets in
 * config.json), and always for planned and unsupported presets.
 * @param {{ presetId: string, presetStatus: string }} profile
 * @param {{ experimental?: boolean, warning?: string }} [options]
 */
export function assertProfileAllowed(profile, { experimental = false, warning } = {}) {
  assertPresetAllowed({ id: profile.presetId, status: /** @type {any} */ (profile.presetStatus), warning }, { experimental });
}

/**
 * @param {RuntimeProfile} profile
 * @returns {string}
 */
export function renderRuntimeProfile(profile) {
  return stringifyJson(profile);
}

/**
 * @returns {{ opencode: { tested: string, policy: string }, ollama: { tested: string, min: string } }}
 */
export function loadCompat() {
  return JSON.parse(fs.readFileSync(COMPAT_URL, 'utf8'));
}

/**
 * Dotted paths whose values differ between two JSON values, sorted.
 * @param {unknown} before
 * @param {unknown} after
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function listChangedPaths(before, after, prefix = '') {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((key) => listChangedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key)).sort();
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
}

/**
 * @param {unknown} value
 * @param {string} dottedPath
 * @returns {unknown}
 */
function getPath(value, dottedPath) {
  return dottedPath.split('.').reduce((/** @type {any} */ current, key) => (isPlainObject(current) ? current[key] : undefined), value);
}

/**
 * @param {string} message
 * @param {string} [hint]
 * @returns {CliError}
 */
function configError(message, hint) {
  return new CliError(message, { exitCode: EXIT.USAGE, code: 'config_invalid', hint });
}
