// config.json: load, migrate, apply defaults, validate (spec 6.2). The file holds only user choices; keys
// that are left out take the defaults below, and any unknown key is a usage error (exit 1).
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compileSchema, formatSchemaErrors } from '../../plugin/opencode-unity-lib/json-schema.js';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { JsonParseError, parseJsonc, stringifyJson } from './jsonc.js';
import { CURRENT_CONFIG_SCHEMA_VERSION, migrateDocument } from './migrations.js';

export const CONFIG_SCHEMA_URL = new URL('../../schema/config.schema.json', import.meta.url);
export const DEFAULT_PRESET_ID = 'nvidia-24gb-qwen3-coder-30b-16k';

/**
 * @typedef {object} GuardSettings
 * @property {number} minFreeVramAfterLoadMiB
 * @property {boolean} allowOffload
 * @property {number} maxGpuUtilPercent
 * @property {number} gpuUtilSampleIntervalMs
 * @property {number} assetImportCpuPercent
 * @property {number} assetImportSampleMs
 * @property {string[]} assetImportProcessPatterns
 * @property {number} editorImportCpuPercent
 * @property {number} maxUnityEditors
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
 * @typedef {{ 'unity-code': number, 'unity-editor': number }} AgentTokens
 */

/**
 * @typedef {object} ProjectSettings
 * @property {{ enabled: boolean, trust: boolean, allowPlayMode: boolean }} editor
 * @property {'allowlist' | 'ask' | null} bashMode
 */

/**
 * @typedef {object} Config
 * @property {number} schemaVersion
 * @property {string} preset
 * @property {Record<string, Record<string, unknown>>} overrides
 * @property {{ baseUrl: string, startAppIfDown: 'ask' | 'always' | 'never', appPath: string | null, serverLogPath: string | null }} ollama
 * @property {GuardSettings} guard
 * @property {{ reserveTokens: number, charsPerToken: number, safetyMargin: number, calibrationClamp: number[], prefixTargetTokens: AgentTokens, prefixFailTokens: AgentTokens }} budget
 * @property {{ bashMode: 'allowlist' | 'ask', readLimitLines: number, extraProtectedEditGlobs: string[], extraProtectedReadGlobs: string[] }} safety
 * @property {{ warm: boolean, pane: 'auto' | 'never', agent: 'unity-code' | 'unity-editor', projectConfig: 'load' | 'disable' }} start
 * @property {{ temperature: number, maxOutputTokens: number, lockTimeoutSec: number, requestTimeoutSec: number, checkTimeoutSec: number, checkCommandPrefixes: string[], extraSensitivePatterns: string[] }} delegate
 * @property {Record<string, ProjectSettings>} projects
 * @property {{ platforms: boolean, presets: boolean, untestedVersions: boolean }} experimental
 */

/** @type {Readonly<Config>} */
export const DEFAULT_CONFIG = deepFreeze({
  schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
  preset: DEFAULT_PRESET_ID,
  overrides: {},
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    startAppIfDown: 'ask',
    appPath: null,
    serverLogPath: null,
  },
  guard: {
    minFreeVramAfterLoadMiB: 1500,
    allowOffload: false,
    maxGpuUtilPercent: 60,
    gpuUtilSampleIntervalMs: 1000,
    assetImportCpuPercent: 20,
    assetImportSampleMs: 1500,
    assetImportProcessPatterns: ['AssetImportWorker', '-importWorker'],
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
  },
  budget: {
    reserveTokens: 512,
    charsPerToken: 3.5,
    safetyMargin: 0.1,
    calibrationClamp: [0.7, 1.4],
    prefixTargetTokens: { 'unity-code': 5000, 'unity-editor': 7000 },
    prefixFailTokens: { 'unity-code': 6000, 'unity-editor': 8000 },
  },
  safety: {
    bashMode: 'allowlist',
    readLimitLines: 200,
    extraProtectedEditGlobs: [],
    extraProtectedReadGlobs: [],
  },
  start: {
    warm: false,
    pane: 'auto',
    agent: 'unity-code',
    projectConfig: 'load',
  },
  delegate: {
    temperature: 0.2,
    maxOutputTokens: 2048,
    lockTimeoutSec: 900,
    requestTimeoutSec: 600,
    checkTimeoutSec: 1800,
    checkCommandPrefixes: ['dotnet build ', 'dotnet test '],
    extraSensitivePatterns: [],
  },
  projects: {},
  experimental: {
    platforms: false,
    presets: false,
    untestedVersions: false,
  },
});

/** @type {Readonly<ProjectSettings>} */
export const DEFAULT_PROJECT_SETTINGS = deepFreeze({
  editor: { enabled: false, trust: false, allowPlayMode: false },
  bashMode: null,
});

/** @type {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaValidator | undefined} */
let configValidator;

/**
 * @typedef {object} LoadedConfig
 * @property {Config} config            Defaults applied; frozen.
 * @property {Record<string, any>} user  What the file sets, after migration (no defaults).
 * @property {string} path
 * @property {boolean} exists
 * @property {number | null} fileVersion  schemaVersion found in the file, before migration.
 * @property {string[]} migrations       Summaries of migrations applied in memory.
 * @property {string[]} warnings
 */

/**
 * Reads config.json. A missing file is not an error: every value is the default.
 * @param {string} configPath
 * @param {{ readFile?: (path: string) => Promise<string> }} [options]
 * @returns {Promise<LoadedConfig>}
 */
export async function loadConfig(configPath, { readFile = (target) => fs.readFile(target, 'utf8') } = {}) {
  let text;
  try {
    text = await readFile(configPath);
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') {
      const config = resolveConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION }, configPath);
      return { config, user: {}, path: configPath, exists: false, fileVersion: null, migrations: [], warnings: getConfigWarnings(config) };
    }
    throw new CliError(`Cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`, {
      exitCode: EXIT.USAGE,
      code: 'config_unreadable',
      cause: error,
    });
  }
  return parseConfigText(text, configPath);
}

/**
 * @param {string} text
 * @param {string} [source]
 * @returns {LoadedConfig}
 */
export function parseConfigText(text, source = 'config.json') {
  let parsed;
  try {
    parsed = parseJsonc(text, source);
  } catch (error) {
    if (!(error instanceof JsonParseError)) throw error;
    throw new CliError(error.message, { exitCode: EXIT.USAGE, code: 'config_invalid', cause: error });
  }
  const label = path.basename(source);
  const migrated = migrateDocument(parsed, { label });
  const config = resolveConfig(migrated.document, source);
  return {
    config,
    user: migrated.document,
    path: source,
    exists: true,
    fileVersion: migrated.fromVersion,
    migrations: migrated.applied,
    warnings: getConfigWarnings(config),
  };
}

/**
 * Applies defaults to a migrated document and validates the result.
 * @param {Record<string, unknown>} user
 * @param {string} [source]
 * @returns {Config}
 */
export function resolveConfig(user, source = 'config.json') {
  const merged = applyConfigDefaults(user);
  const problems = validateConfig(merged);
  if (problems.length > 0) {
    throw new CliError(`Invalid ${source}: ${formatSchemaErrors(problems)}`, {
      exitCode: EXIT.USAGE,
      code: 'config_invalid',
      data: { problems },
      hint: 'Fix or remove the listed keys; docs/configuration.md lists every key.',
    });
  }
  return deepFreeze(/** @type {Config} */ (merged));
}

/**
 * Deep-merges the user document over DEFAULT_CONFIG. Objects merge, arrays and scalars replace, and every
 * project entry gets the project defaults. Unknown keys are kept so validation can name them.
 * @param {Record<string, unknown>} user
 * @returns {Record<string, unknown>}
 */
export function applyConfigDefaults(user) {
  const merged = /** @type {Record<string, any>} */ (mergeDeep(DEFAULT_CONFIG, user));
  if (isPlainObject(merged.projects)) {
    for (const [id, settings] of Object.entries(merged.projects)) {
      merged.projects[id] = isPlainObject(settings) ? mergeDeep(DEFAULT_PROJECT_SETTINGS, settings) : settings;
    }
  }
  return merged;
}

/**
 * Schema problems plus rules a JSON schema cannot express.
 * @param {unknown} value
 * @returns {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaError[]}
 */
export function validateConfig(value) {
  configValidator ??= compileSchema(readConfigSchema());
  const problems = configValidator(value);
  if (problems.length > 0) return problems;
  const config = /** @type {Config} */ (value);
  const [low, high] = config.budget.calibrationClamp;
  if (low > high) problems.push({ path: 'budget.calibrationClamp', message: 'must be [low, high] with low <= high' });
  for (const agent of /** @type {const} */ (['unity-code', 'unity-editor'])) {
    if (config.budget.prefixTargetTokens[agent] > config.budget.prefixFailTokens[agent]) {
      problems.push({ path: `budget.prefixTargetTokens.${agent}`, message: `must not exceed budget.prefixFailTokens.${agent}` });
    }
  }
  return problems;
}

/**
 * Settings that are valid but weaken a safety default; commands print these.
 * @param {Config} config
 * @returns {string[]}
 */
export function getConfigWarnings(config) {
  /** @type {string[]} */
  const warnings = [];
  if (config.guard.nvidiaSmiCommand !== DEFAULT_CONFIG.guard.nvidiaSmiCommand) {
    warnings.push(`guard.nvidiaSmiCommand is '${config.guard.nvidiaSmiCommand}'; this setting is meant for tests`);
  }
  if (config.guard.remote === 'unguarded') warnings.push('guard.remote is unguarded: a non-loopback Ollama server loads models without the GPU guard');
  if (config.guard.adapter === 'none') warnings.push('guard.adapter is none: GPU memory and utilization are not checked');
  if (config.guard.importWhileLoaded === 'allow') warnings.push('guard.importWhileLoaded is allow: Unity imports are not checked while the model is loaded');
  if (config.guard.allowOffload) warnings.push('guard.allowOffload is on: a model that does not fit in video memory runs partly from system RAM, and replies are slower');
  if (config.safety.bashMode === 'ask') warnings.push('safety.bashMode is ask: shell commands outside the allow-list prompt instead of being refused');
  if (config.guard.maxUnityEditors === 0) warnings.push('guard.maxUnityEditors is 0: the Unity editor count is not checked');
  if (config.guard.editorImportCpuPercent === 0) warnings.push('guard.editorImportCpuPercent is 0: an importing or compiling Unity editor is not checked');
  return warnings;
}

/**
 * The file `setup` writes when none exists: only the version and the preset, so preset guard values and
 * future defaults are not frozen into the user's file.
 * @param {string} [presetId]
 * @returns {string}
 */
export function renderInitialConfig(presetId = DEFAULT_PRESET_ID) {
  return stringifyJson({ schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION, preset: presetId });
}

/**
 * Writes through a temp file and a rename, so a crash never leaves half a config.json.
 * @param {string} configPath
 * @param {Record<string, unknown>} document
 * @returns {Promise<void>}
 */
export async function writeConfigFile(configPath, document) {
  resolveConfig(document, configPath);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, stringifyJson(document), 'utf8');
  try {
    await fs.rename(temporaryPath, configPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * @returns {Record<string, any>}
 */
export function readConfigSchema() {
  // The schema ships inside the package; a sync read keeps validation usable from sync code.
  return JSON.parse(fsSync.readFileSync(CONFIG_SCHEMA_URL, 'utf8'));
}

/**
 * @param {unknown} base
 * @param {unknown} overlay
 * @returns {unknown}
 */
export function mergeDeep(base, overlay) {
  if (overlay === undefined) return structuredClone(base);
  if (!isPlainObject(base) || !isPlainObject(overlay)) return structuredClone(overlay);
  /** @type {Record<string, unknown>} */
  const result = structuredClone(/** @type {Record<string, unknown>} */ (base));
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (overlay))) {
    result[key] = Object.hasOwn(result, key) ? mergeDeep(result[key], value) : structuredClone(value);
  }
  return result;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
