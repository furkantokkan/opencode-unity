// Guard settings: the defaults of spec section 6.2 and validation of the values a caller passes in.
// Ranges mirror schema/runtime-profile.schema.json. Invalid settings never weaken the guard: the
// caller gets errors, and evaluateGuard blocks on them.
import { parseOllamaBaseUrl } from './probes/ollama-ps.js';

/**
 * @typedef {object} GuardConfig
 * @property {number} modelVramMiB              Preset estimate (section 7.4); required, no default.
 * @property {number} minFreeVramAfterLoadMiB
 * @property {boolean} allowOffload             Let a model that does not fit in video memory run the rest from system RAM.
 * @property {number} maxGpuUtilPercent
 * @property {number} gpuUtilSampleIntervalMs
 * @property {number} assetImportCpuPercent     Summed over import processes; 100 = one logical core.
 * @property {number} assetImportSampleMs
 * @property {string[]} assetImportProcessPatterns
 * @property {number} editorImportCpuPercent    Per Unity editor with a window; 0 turns the check off.
 * @property {number} maxUnityEditors           0 turns the check off.
 * @property {'wait' | 'allow'} importWhileLoaded
 * @property {number} keepAliveMarginSec
 * @property {number} coldPassCacheSec
 * @property {number} loadedPassCacheSec
 * @property {number} probeTimeoutSec
 * @property {'stop' | 'retry'} onColdBlock
 * @property {'retry' | 'stop'} onLoadedBusy
 * @property {'block' | 'unguarded'} remote
 * @property {'auto' | 'none'} adapter
 * @property {string} nvidiaSmiCommand
 */

/**
 * @typedef {object} GuardTarget
 * @property {string} baseUrl    Ollama base URL; a trailing `/v1` is ignored.
 * @property {string} modelTag   The preset tag, for example `ocu-qwen3-coder-30b-16k`.
 * @property {number} numCtx     The preset context; a model loaded at another context counts as cold.
 */

/** @type {Readonly<Omit<GuardConfig, 'modelVramMiB'>>} */
export const GUARD_DEFAULTS = Object.freeze({
  minFreeVramAfterLoadMiB: 1500,
  allowOffload: false,
  maxGpuUtilPercent: 60,
  gpuUtilSampleIntervalMs: 1000,
  assetImportCpuPercent: 20,
  assetImportSampleMs: 1500,
  assetImportProcessPatterns: /** @type {string[]} */ (Object.freeze(['AssetImportWorker', '-importWorker'])),
  // Projects that import in-process (the Unity default) import inside the editor process, where the
  // worker check sees nothing. Compiling and Play Mode count as busy too; an idle editor reads 4-7%.
  editorImportCpuPercent: 60,
  maxUnityEditors: 3,
  importWhileLoaded: 'wait',
  keepAliveMarginSec: 60,
  coldPassCacheSec: 3,
  loadedPassCacheSec: 15,
  probeTimeoutSec: 10,
  onColdBlock: 'stop',
  onLoadedBusy: 'retry',
  remote: 'block',
  adapter: 'auto',
  nvidiaSmiCommand: 'nvidia-smi',
});

/**
 * @typedef {{ kind: 'integer', min: number, max: number }
 *   | { kind: 'choice', values: readonly string[] }
 *   | { kind: 'boolean' }
 *   | { kind: 'patterns' }
 *   | { kind: 'text' }} FieldRule
 */

/** @type {Readonly<Record<keyof GuardConfig, FieldRule>>} */
const k_rules = Object.freeze({
  modelVramMiB: { kind: 'integer', min: 1, max: 1048576 },
  minFreeVramAfterLoadMiB: { kind: 'integer', min: 0, max: 1048576 },
  allowOffload: { kind: 'boolean' },
  maxGpuUtilPercent: { kind: 'integer', min: 1, max: 100 },
  gpuUtilSampleIntervalMs: { kind: 'integer', min: 100, max: 10000 },
  assetImportCpuPercent: { kind: 'integer', min: 1, max: 102400 },
  assetImportSampleMs: { kind: 'integer', min: 100, max: 60000 },
  assetImportProcessPatterns: { kind: 'patterns' },
  editorImportCpuPercent: { kind: 'integer', min: 0, max: 102400 },
  maxUnityEditors: { kind: 'integer', min: 0, max: 64 },
  importWhileLoaded: { kind: 'choice', values: ['wait', 'allow'] },
  keepAliveMarginSec: { kind: 'integer', min: 0, max: 3600 },
  coldPassCacheSec: { kind: 'integer', min: 0, max: 60 },
  loadedPassCacheSec: { kind: 'integer', min: 0, max: 300 },
  probeTimeoutSec: { kind: 'integer', min: 1, max: 120 },
  onColdBlock: { kind: 'choice', values: ['stop', 'retry'] },
  onLoadedBusy: { kind: 'choice', values: ['retry', 'stop'] },
  remote: { kind: 'choice', values: ['block', 'unguarded'] },
  adapter: { kind: 'choice', values: ['auto', 'none'] },
  nvidiaSmiCommand: { kind: 'text' },
});

const k_maxPatterns = 32;
const k_maxPatternLength = 200;

/**
 * Merges the given keys over GUARD_DEFAULTS and validates the result. Keys the guard does not use
 * (such as the runtime profile's `kvType`) are ignored.
 * @param {unknown} input
 * @returns {{ ok: true, config: GuardConfig } | { ok: false, errors: string[] }}
 */
export function resolveGuardConfig(input) {
  if (!isRecord(input)) return { ok: false, errors: ['guard settings are missing'] };
  const merged = /** @type {Record<string, unknown>} */ ({ ...GUARD_DEFAULTS });
  for (const key of Object.keys(k_rules)) {
    if (input[key] !== undefined) merged[key] = input[key];
  }
  const errors = [];
  for (const [key, rule] of Object.entries(k_rules)) {
    const problem = checkField(merged[key], rule);
    if (problem) errors.push(`guard.${key} ${problem}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const config = /** @type {GuardConfig} */ (/** @type {unknown} */ (merged));
  return { ok: true, config: { ...config, assetImportProcessPatterns: [...config.assetImportProcessPatterns] } };
}

/**
 * @param {unknown} target
 * @returns {string[]}  Problems; empty when the target is usable.
 */
export function validateGuardTarget(target) {
  if (!isRecord(target)) return ['the guard target (base URL, model tag, context) is missing'];
  const errors = [];
  if (!parseOllamaBaseUrl(target.baseUrl)) errors.push('the Ollama base URL is not a plain http(s) URL');
  if (typeof target.modelTag !== 'string' || target.modelTag.trim() === '' || hasControlCharacter(target.modelTag)) {
    errors.push('the model tag is empty or not a single line');
  }
  if (!Number.isSafeInteger(target.numCtx) || /** @type {number} */ (target.numCtx) <= 0) errors.push('the context size is not a positive integer');
  return errors;
}

/**
 * @param {unknown} value
 * @param {FieldRule} rule
 * @returns {string | null}
 */
function checkField(value, rule) {
  switch (rule.kind) {
    case 'integer': {
      if (!Number.isSafeInteger(value)) return value === undefined ? 'is required' : 'must be an integer';
      const number = /** @type {number} */ (value);
      return number < rule.min || number > rule.max ? `must be between ${rule.min} and ${rule.max}` : null;
    }
    case 'choice':
      return typeof value === 'string' && rule.values.includes(value) ? null : `must be one of ${rule.values.join(', ')}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'text':
      return typeof value === 'string' && value.trim() !== '' && !hasControlCharacter(value) ? null : 'must be a non-empty single-line string';
    default:
      return checkPatterns(value);
  }
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function checkPatterns(value) {
  if (!Array.isArray(value) || value.length === 0) return 'must be a non-empty list of strings';
  if (value.length > k_maxPatterns) return `must have at most ${k_maxPatterns} entries`;
  for (const pattern of value) {
    if (typeof pattern !== 'string' || pattern.trim() === '' || pattern.length > k_maxPatternLength || hasControlCharacter(pattern)) {
      return `entries must be non-empty single-line strings of at most ${k_maxPatternLength} characters`;
    }
    // A pattern of only wildcards would match every process, so every request would wait on CPU use.
    if (/^[*?\s]+$/.test(pattern)) return 'entries must contain more than wildcards';
  }
  return null;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function hasControlCharacter(text) {
  return [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
