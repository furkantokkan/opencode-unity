// Runtime profile loader shared by the plugin (Bun, inside OpenCode) and the CLI. The profile is rendered
// by `setup` next to the plugins directory. Any problem (missing file, bad JSON, other schema version,
// invalid field) is reported as a reason instead of thrown, so the plugin can fail closed: no provider is
// injected and OpenCode never resolves the model (spec D3, 6.3).
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileSchema } from './json-schema.js';

export const RUNTIME_PROFILE_SCHEMA_VERSION = 1;
export const RUNTIME_PROFILE_FILE_NAME = 'opencode-unity.runtime.json';

const NAME_PATTERN = '^[a-z0-9][a-z0-9-]{0,63}$';
const GLOB_LIST = { type: 'array', items: { type: 'string', minLength: 1 } };
const AGENT_TOKENS = {
  type: 'object',
  additionalProperties: false,
  required: ['unity-code', 'unity-editor'],
  properties: {
    'unity-code': { type: 'integer', minimum: 1, maximum: 1048576 },
    'unity-editor': { type: 'integer', minimum: 1, maximum: 1048576 },
  },
};

// schema/runtime-profile.schema.json must stay equal to this object (unit test). Only plugin/ is copied
// into the rendered profile, not schema/, so the plugin's copy of the schema lives here as code.
export const RUNTIME_PROFILE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'opencode-unity runtime profile',
  description: 'Rendered by setup into profile/<cliVersion>/opencode-unity.runtime.json and read by the plugin, which injects no provider when this file is missing or invalid.',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'cliVersion', 'presetId', 'presetStatus', 'custom', 'overriddenPaths', 'provider', 'ollama', 'guard', 'budget', 'safety', 'home', 'compat'],
  properties: {
    schemaVersion: { const: RUNTIME_PROFILE_SCHEMA_VERSION },
    cliVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$' },
    presetId: { type: 'string', pattern: NAME_PATTERN },
    presetStatus: { enum: ['verified', 'reference-tested', 'experimental'] },
    custom: { description: 'True when config overrides changed any preset field.', type: 'boolean' },
    overriddenPaths: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
    provider: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'npm', 'name', 'baseURL', 'modelTag', 'numCtx', 'limit', 'sampling', 'numKeep', 'keepAlive'],
      properties: {
        id: { const: 'opencode-unity' },
        npm: { const: '@ai-sdk/openai-compatible' },
        name: { type: 'string', minLength: 1 },
        baseURL: { type: 'string', pattern: '^https?://[^\\s/?#]+/v1$' },
        modelTag: { type: 'string', pattern: '^ocu-[a-z0-9][a-z0-9._-]{0,79}$' },
        numCtx: { type: 'integer', minimum: 2048, maximum: 1048576 },
        limit: {
          type: 'object',
          additionalProperties: false,
          required: ['context', 'output'],
          properties: {
            context: { type: 'integer', minimum: 2048, maximum: 1048576 },
            output: { type: 'integer', minimum: 256, maximum: 32000 },
          },
        },
        sampling: {
          type: 'object',
          additionalProperties: false,
          required: ['temperature', 'topP', 'topK', 'repeatPenalty'],
          properties: {
            temperature: { type: 'number', minimum: 0, maximum: 2 },
            topP: { type: 'number', minimum: 0, maximum: 1 },
            topK: { type: 'integer', minimum: 0, maximum: 1000 },
            repeatPenalty: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
          },
        },
        numKeep: { type: 'integer', minimum: 0, maximum: 1048576 },
        keepAlive: { type: 'string', pattern: '^(-1|\\d+|(\\d+(\\.\\d+)?(ms|s|m|h))+)$' },
      },
    },
    ollama: {
      type: 'object',
      additionalProperties: false,
      required: ['baseUrl'],
      properties: {
        baseUrl: { type: 'string', pattern: '^https?://[^\\s/?#]+$' },
      },
    },
    guard: {
      type: 'object',
      additionalProperties: false,
      required: [
        'modelVramMiB',
        'kvType',
        'kvTypeSource',
        'minFreeVramAfterLoadMiB',
        'maxGpuUtilPercent',
        'gpuUtilSampleIntervalMs',
        'assetImportCpuPercent',
        'assetImportSampleMs',
        'assetImportProcessPatterns',
        'editorImportCpuPercent',
        'maxUnityEditors',
        'importWhileLoaded',
        'keepAliveMarginSec',
        'coldPassCacheSec',
        'loadedPassCacheSec',
        'probeTimeoutSec',
        'onColdBlock',
        'onLoadedBusy',
        'remote',
        'adapter',
        'nvidiaSmiCommand',
      ],
      properties: {
        modelVramMiB: { description: 'Estimated VRAM the model needs at numCtx (spec 7.4).', type: 'integer', minimum: 1, maximum: 1048576 },
        kvType: { enum: ['f16', 'q8_0', 'q4_0'] },
        kvTypeSource: { enum: ['server-log', 'env', 'default'] },
        minFreeVramAfterLoadMiB: { type: 'integer', minimum: 0, maximum: 1048576 },
        allowOffload: { type: 'boolean' },
        maxGpuUtilPercent: { type: 'integer', minimum: 1, maximum: 100 },
        gpuUtilSampleIntervalMs: { type: 'integer', minimum: 100, maximum: 10000 },
        assetImportCpuPercent: { type: 'integer', minimum: 1, maximum: 102400 },
        assetImportSampleMs: { type: 'integer', minimum: 100, maximum: 60000 },
        assetImportProcessPatterns: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        editorImportCpuPercent: { type: 'integer', minimum: 0, maximum: 102400 },
        maxUnityEditors: { type: 'integer', minimum: 0, maximum: 64 },
        importWhileLoaded: { enum: ['wait', 'allow'] },
        keepAliveMarginSec: { type: 'integer', minimum: 0, maximum: 3600 },
        coldPassCacheSec: { type: 'integer', minimum: 0, maximum: 60 },
        loadedPassCacheSec: { type: 'integer', minimum: 0, maximum: 300 },
        probeTimeoutSec: { type: 'integer', minimum: 1, maximum: 120 },
        onColdBlock: { enum: ['stop', 'retry'] },
        onLoadedBusy: { enum: ['retry', 'stop'] },
        remote: { enum: ['block', 'unguarded'] },
        adapter: { enum: ['auto', 'none'] },
        nvidiaSmiCommand: { type: 'string', minLength: 1 },
      },
    },
    budget: {
      type: 'object',
      additionalProperties: false,
      required: ['promptBudget', 'toolsTokens', 'toolsTokensSource', 'reserveTokens', 'charsPerToken', 'safetyMargin', 'calibrationClamp', 'prefixTargetTokens', 'prefixFailTokens'],
      properties: {
        promptBudget: { description: 'limit.context - limit.output - reserveTokens.', type: 'integer', minimum: 1, maximum: 1048576 },
        toolsTokens: AGENT_TOKENS,
        toolsTokensSource: { type: 'string', pattern: '^(default-allowance|capture:[0-9A-Za-z:._-]+)$' },
        reserveTokens: { type: 'integer', minimum: 0, maximum: 65536 },
        charsPerToken: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
        safetyMargin: { type: 'number', minimum: 0, maximum: 1 },
        calibrationClamp: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', exclusiveMinimum: 0, maximum: 10 } },
        prefixTargetTokens: AGENT_TOKENS,
        prefixFailTokens: AGENT_TOKENS,
      },
    },
    safety: {
      type: 'object',
      additionalProperties: false,
      required: ['bashMode', 'readLimitLines', 'extraProtectedEditGlobs', 'extraProtectedReadGlobs'],
      properties: {
        bashMode: { enum: ['allowlist', 'ask'] },
        readLimitLines: { type: 'integer', minimum: 1, maximum: 2000 },
        extraProtectedEditGlobs: GLOB_LIST,
        extraProtectedReadGlobs: GLOB_LIST,
      },
    },
    home: { description: 'Absolute opencode-unity home directory.', type: 'string', minLength: 1 },
    compat: {
      type: 'object',
      additionalProperties: false,
      required: ['opencode', 'ollama'],
      properties: {
        opencode: { type: 'string', minLength: 1 },
        ollama: { type: 'string', minLength: 1 },
      },
    },
  },
};

const validateSchema = compileSchema(RUNTIME_PROFILE_SCHEMA);

/**
 * @typedef {{ context: number, output: number }} ModelLimit
 * @typedef {{ temperature: number, topP: number, topK: number, repeatPenalty: number }} Sampling
 * @typedef {{ 'unity-code': number, 'unity-editor': number }} AgentTokens
 */

/**
 * @typedef {object} RuntimeProfile
 * @property {number} schemaVersion
 * @property {string} cliVersion
 * @property {string} presetId
 * @property {'verified' | 'reference-tested' | 'experimental'} presetStatus
 * @property {boolean} custom
 * @property {string[]} overriddenPaths
 * @property {{ id: string, npm: string, name: string, baseURL: string, modelTag: string, numCtx: number, limit: ModelLimit, sampling: Sampling, numKeep: number, keepAlive: string }} provider
 * @property {{ baseUrl: string }} ollama
 * @property {Record<string, any> & { modelVramMiB: number, kvType: string, kvTypeSource: string }} guard
 * @property {{ promptBudget: number, toolsTokens: AgentTokens, toolsTokensSource: string, reserveTokens: number, charsPerToken: number, safetyMargin: number, calibrationClamp: number[], prefixTargetTokens: AgentTokens, prefixFailTokens: AgentTokens }} budget
 * @property {{ bashMode: 'allowlist' | 'ask', readLimitLines: number, extraProtectedEditGlobs: string[], extraProtectedReadGlobs: string[] }} safety
 * @property {string} home
 * @property {{ opencode: string, ollama: string }} compat
 */

/**
 * @typedef {{ ok: true, profile: RuntimeProfile } | { ok: false, reason: string }} RuntimeProfileResult
 */

/**
 * The profile file sits two levels above this module: <profile>/plugins/opencode-unity-lib/.
 * @param {string | URL} [moduleUrl]
 * @returns {string}
 */
export function getDefaultRuntimeProfilePath(moduleUrl = import.meta.url) {
  return fileURLToPath(new URL(`../../${RUNTIME_PROFILE_FILE_NAME}`, moduleUrl));
}

/**
 * Structural and cross-field checks. Returns readable problems; an empty list means valid.
 * @param {unknown} value
 * @returns {string[]}
 */
export function validateRuntimeProfile(value) {
  const version = /** @type {{ schemaVersion?: unknown } | null} */ (value)?.schemaVersion;
  if (value !== null && typeof value === 'object' && version !== undefined && version !== RUNTIME_PROFILE_SCHEMA_VERSION) {
    return [`schemaVersion ${JSON.stringify(version)} is not supported (expected ${RUNTIME_PROFILE_SCHEMA_VERSION}); run opencode-unity upgrade`];
  }
  const schemaErrors = validateSchema(value);
  if (schemaErrors.length > 0) return schemaErrors.map((error) => `${error.path || '(root)'} ${error.message}`);
  const profile = /** @type {RuntimeProfile} */ (value);
  /** @type {string[]} */
  const problems = [];
  const { limit, numCtx } = profile.provider;
  if (limit.context > numCtx) problems.push(`provider.limit.context ${limit.context} is larger than provider.numCtx ${numCtx}`);
  if (limit.output >= limit.context) problems.push(`provider.limit.output ${limit.output} must be smaller than provider.limit.context ${limit.context}`);
  const expectedBudget = limit.context - limit.output - profile.budget.reserveTokens;
  if (profile.budget.promptBudget !== expectedBudget) {
    problems.push(`budget.promptBudget ${profile.budget.promptBudget} must equal limit.context - limit.output - reserveTokens (${expectedBudget})`);
  }
  if (`${profile.ollama.baseUrl}/v1` !== profile.provider.baseURL) {
    problems.push(`provider.baseURL ${profile.provider.baseURL} must be ollama.baseUrl + /v1`);
  }
  const [low, high] = profile.budget.calibrationClamp;
  if (low > high) problems.push('budget.calibrationClamp must be [low, high] with low <= high');
  return problems;
}

/**
 * @param {string} text
 * @returns {RuntimeProfileResult}
 */
export function parseRuntimeProfile(text) {
  let value;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const problems = validateRuntimeProfile(value);
  if (problems.length > 0) return { ok: false, reason: problems.slice(0, 5).join('; ') + (problems.length > 5 ? `; and ${problems.length - 5} more` : '') };
  return { ok: true, profile: deepFreeze(/** @type {RuntimeProfile} */ (value)) };
}

/**
 * Never throws.
 * @param {{ path?: string, readFile?: (path: string) => Promise<string> }} [options]
 * @returns {Promise<RuntimeProfileResult>}
 */
export async function loadRuntimeProfile({ path = getDefaultRuntimeProfilePath(), readFile = (target) => fs.readFile(target, 'utf8') } = {}) {
  let text;
  try {
    text = await readFile(path);
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code;
    const reason = code === 'ENOENT' ? 'file not found' : `cannot read: ${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, reason: `${RUNTIME_PROFILE_FILE_NAME}: ${reason}` };
  }
  const result = parseRuntimeProfile(text);
  return result.ok ? result : { ok: false, reason: `${RUNTIME_PROFILE_FILE_NAME}: ${result.reason}` };
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
