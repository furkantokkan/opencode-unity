// config.json: load, migrate, apply defaults, validate (spec 6.2, amendment 38.4). The file holds only user
// choices; keys that are left out take the defaults below, a few of which differ per platform, and any
// unknown key is a usage error (exit 1). An older file is migrated in memory on every read and written in
// its migrated form only by an explicit write.
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compileSchema, formatSchemaErrors } from '../../plugin/opencode-unity-lib/json-schema.js';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { JsonParseError, parseJsonc, stringifyJson } from './jsonc.js';
import { CONFIG_V2_BLOCKS, CURRENT_CONFIG_SCHEMA_VERSION, deepFreeze, isPlainObject, migrateDocument } from './migrations.js';

export { deepFreeze, isPlainObject };

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
 * @typedef {object} NetworkLimits
 * @property {number} maxResponseBytes
 * @property {number} maxOutputChars
 * @property {number} maxRequestBodyBytes
 * @property {number} maxUrlChars
 * @property {number} connectTimeoutMs
 * @property {number} firstByteTimeoutMs
 * @property {number} totalTimeoutMs
 * @property {number} maxRequestsPerSession
 * @property {number} maxRequestsPerMinute
 */

/**
 * One user allow-list entry as written in config.json (amendment 35.7). The render-time rules decide
 * whether it is usable; the schema only fixes its shape.
 * @typedef {object} NetworkEntry
 * @property {string} id
 * @property {string} host
 * @property {number[] | '*'} ports
 * @property {'http' | 'https'} scheme
 * @property {string[]} methods
 * @property {string[]} pathPrefix
 * @property {boolean} [stripLocaleSegment]
 * @property {boolean} [loopback]
 * @property {boolean} [destructive]
 * @property {false | string} [firebaseEmulator]
 * @property {Record<string, string>} [headers]
 * @property {string} [caFile]
 * @property {{ maxPathChars?: number, maxQueryChars?: number, maxRequestBodyBytes?: number }} [budget]
 * @property {string} [consentId]
 * @property {string} [note]
 */

/**
 * @typedef {object} NetworkSettings
 * @property {boolean} enabled
 * @property {'none' | 'standard' | 'custom'} profile
 * @property {NetworkEntry[]} allow
 * @property {NetworkLimits} limits
 * @property {'deny' | 'ask'} bash
 * @property {string[]} extraDeniedQueryKeys
 * @property {string[]} extraDeniedHosts
 * @property {number[]} extraReservedPorts
 */

/**
 * A project's narrowing of the global network block; every key is optional.
 * @typedef {Partial<Omit<NetworkSettings, 'bash' | 'limits'>> & { limits?: Partial<NetworkLimits> }} ProjectNetworkSettings
 */

/**
 * @typedef {object} ShapeSettings
 * @property {'auto' | 'off' | 'always'} mode
 * @property {number} maxInputChars
 * @property {number} maxOutputTokens
 * @property {number} timeoutSec
 * @property {number} anchorCandidates
 * @property {number} grepTimeoutMs
 */

/**
 * The `project` block: workspace component discovery and the facts budget (amendment 37.10).
 * @typedef {object} WorkspaceSettings
 * @property {'auto' | 'unity-only' | string[]} components
 * @property {number} maxComponents
 * @property {number} factsBudgetChars
 * @property {number} unityBlockChars
 * @property {number} componentBlockChars
 * @property {number} maxRenderedBlocks
 * @property {number} walkEntryCap
 * @property {number} readBudgetBytes
 * @property {{ enabled: boolean, scriptOrder: string[], timeoutSec: number, blockScriptBodies: boolean }} verify
 * @property {{ readEnvExampleKeys: boolean, maxEnvExampleKeys: number }} database
 * @property {{ ruleBlock: 'auto' | 'always' | 'never' }} multiplayer
 */

/**
 * @typedef {object} ProjectSettings
 * @property {{ enabled: boolean, trust: boolean, allowPlayMode: boolean }} editor
 * @property {'allowlist' | 'ask' | null} bashMode
 * @property {ProjectNetworkSettings} [network]   Absent means the global block applies unchanged.
 */

/**
 * @typedef {object} SafetySettings
 * @property {'allowlist' | 'ask'} bashMode
 * @property {number} readLimitLines
 * @property {string[]} extraProtectedEditGlobs
 * @property {string[]} extraProtectedReadGlobs
 * @property {string[]} multiplayerProtectedGlobs
 */

/**
 * @typedef {object} Config
 * @property {number} schemaVersion
 * @property {string} preset
 * @property {Record<string, Record<string, unknown>>} overrides
 * @property {{ baseUrl: string, startAppIfDown: 'ask' | 'always' | 'never', appPath: string | null, serverLogPath: string | null }} ollama
 * @property {GuardSettings} guard
 * @property {{ reserveTokens: number, charsPerToken: number, safetyMargin: number, calibrationClamp: number[], prefixTargetTokens: AgentTokens, prefixFailTokens: AgentTokens }} budget
 * @property {SafetySettings} safety
 * @property {{ warm: boolean, pane: 'auto' | 'never', agent: 'unity-code' | 'unity-editor', projectConfig: 'load' | 'disable' }} start
 * @property {{ enabled: boolean, monitorWindow: boolean, temperature: number, maxOutputTokens: number, lockTimeoutSec: number, requestTimeoutSec: number, checkTimeoutSec: number, checkCommandPrefixes: string[], extraSensitivePatterns: string[] }} delegate
 * @property {NetworkSettings} network
 * @property {ShapeSettings} shape
 * @property {WorkspaceSettings} project
 * @property {Record<string, ProjectSettings>} projects
 * @property {{ platforms: boolean, presets: boolean, untestedVersions: boolean }} experimental
 */

/**
 * The defaults, with the Windows column of amendment 33.5; `getDefaultConfig` gives another platform's.
 * @type {Readonly<Config>}
 */
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
    multiplayerProtectedGlobs: CONFIG_V2_BLOCKS.safety.multiplayerProtectedGlobs,
  },
  start: {
    warm: false,
    pane: 'auto',
    agent: 'unity-code',
    projectConfig: 'load',
  },
  delegate: {
    enabled: true,
    monitorWindow: false,
    temperature: 0.2,
    maxOutputTokens: 2048,
    lockTimeoutSec: 900,
    requestTimeoutSec: 600,
    checkTimeoutSec: 1800,
    checkCommandPrefixes: ['dotnet build ', 'dotnet test '],
    extraSensitivePatterns: [],
  },
  network: CONFIG_V2_BLOCKS.network,
  shape: CONFIG_V2_BLOCKS.shape,
  project: CONFIG_V2_BLOCKS.project,
  projects: {},
  experimental: {
    platforms: false,
    presets: false,
    untestedVersions: false,
  },
});

/**
 * The keys whose default differs per platform (amendment 33.5), applied over DEFAULT_CONFIG and under the
 * user's file. Every other platform takes the Linux column: there is no Ollama app to start and no
 * Windows Terminal to split, and those platforms are refused for model commands anyway (33.4).
 */
const PLATFORM_DEFAULTS = deepFreeze({
  win32: {},
  darwin: { guard: { minFreeVramAfterLoadMiB: 4096 }, start: { pane: 'never' } },
  linux: { ollama: { startAppIfDown: 'never' }, start: { pane: 'never' } },
});

/** @type {Map<string, Readonly<Config>>} */
const defaultsByColumn = new Map();

/** @type {Readonly<ProjectSettings>} */
export const DEFAULT_PROJECT_SETTINGS = deepFreeze({
  editor: { enabled: false, trust: false, allowPlayMode: false },
  bashMode: null,
});

/** @type {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaValidator | undefined} */
let configValidator;

/**
 * @typedef {object} ConfigOptions
 * @property {NodeJS.Platform} [platform]  Picks the platform defaults; the running platform when left out.
 */

/**
 * @typedef {object} LoadedConfig
 * @property {Config} config            Defaults applied; frozen.
 * @property {Record<string, any>} user  What the file sets, after migration: no defaults, except the
 *   blocks the migration inserted into an older file.
 * @property {string} path
 * @property {boolean} exists
 * @property {number | null} fileVersion  schemaVersion found in the file, before migration.
 * @property {string[]} migrations       Summaries of migrations applied in memory.
 * @property {string[]} warnings
 */

/**
 * The defaults for one platform: DEFAULT_CONFIG with that platform's column of amendment 33.5.
 * @param {NodeJS.Platform | string} [platform]
 * @returns {Readonly<Config>}
 */
export function getDefaultConfig(platform = process.platform) {
  const column = Object.hasOwn(PLATFORM_DEFAULTS, platform) ? platform : 'linux';
  let defaults = defaultsByColumn.get(column);
  if (!defaults) {
    const overlay = PLATFORM_DEFAULTS[/** @type {keyof typeof PLATFORM_DEFAULTS} */ (column)];
    defaults = deepFreeze(/** @type {Config} */ (mergeDeep(DEFAULT_CONFIG, overlay)));
    defaultsByColumn.set(column, defaults);
  }
  return defaults;
}

/**
 * Reads config.json. A missing file is not an error: every value is the default. Reading never writes:
 * an older file is migrated in memory only.
 * @param {string} configPath
 * @param {{ readFile?: (path: string) => Promise<string> } & ConfigOptions} [options]
 * @returns {Promise<LoadedConfig>}
 */
export async function loadConfig(configPath, { readFile = (target) => fs.readFile(target, 'utf8'), platform } = {}) {
  let text;
  try {
    text = await readFile(configPath);
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') {
      const config = resolveConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION }, configPath, { platform });
      return { config, user: {}, path: configPath, exists: false, fileVersion: null, migrations: [], warnings: getConfigWarnings(config) };
    }
    throw new CliError(`Cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`, {
      exitCode: EXIT.USAGE,
      code: 'config_unreadable',
      cause: error,
    });
  }
  return parseConfigText(text, configPath, { platform });
}

/**
 * @param {string} text
 * @param {string} [source]
 * @param {ConfigOptions} [options]
 * @returns {LoadedConfig}
 */
export function parseConfigText(text, source = 'config.json', { platform } = {}) {
  let parsed;
  try {
    parsed = parseJsonc(text, source);
  } catch (error) {
    if (!(error instanceof JsonParseError)) throw error;
    throw new CliError(error.message, { exitCode: EXIT.USAGE, code: 'config_invalid', cause: error });
  }
  const label = path.basename(source);
  const migrated = migrateDocument(parsed, { label });
  const config = resolveConfig(migrated.document, source, { platform });
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
 * Migrates a document in memory, applies the defaults and validates the result. The document itself is
 * never changed.
 * @param {Record<string, unknown>} user
 * @param {string} [source]
 * @param {ConfigOptions} [options]
 * @returns {Config}
 */
export function resolveConfig(user, source = 'config.json', { platform } = {}) {
  const { document } = migrateDocument(user, { label: path.basename(source) });
  const merged = applyConfigDefaults(document, { platform });
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
 * Deep-merges the user document over the platform's defaults. Objects merge, arrays and scalars replace,
 * and every project entry gets the project defaults. Unknown keys are kept so validation can name them.
 * @param {Record<string, unknown>} user
 * @param {ConfigOptions} [options]
 * @returns {Record<string, unknown>}
 */
export function applyConfigDefaults(user, { platform } = {}) {
  const merged = /** @type {Record<string, any>} */ (mergeDeep(getDefaultConfig(platform), user));
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
  const { limits } = config.network;
  for (const key of /** @type {const} */ (['connectTimeoutMs', 'firstByteTimeoutMs'])) {
    if (limits[key] > limits.totalTimeoutMs) problems.push({ path: `network.limits.${key}`, message: 'must not exceed network.limits.totalTimeoutMs' });
  }
  for (const key of /** @type {const} */ (['unityBlockChars', 'componentBlockChars'])) {
    if (config.project[key] > config.project.factsBudgetChars) problems.push({ path: `project.${key}`, message: 'must not exceed project.factsBudgetChars' });
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
  if (config.network.bash === 'ask') warnings.push('network.bash is ask: network commands in the agent shell prompt instead of being refused');
  if (!config.project.verify.blockScriptBodies) warnings.push('project.verify.blockScriptBodies is false: a verify script may run more than a build, test or type check');
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
 * Writes through a temp file and a rename, so a crash never leaves half a config.json. An older document
 * is written in its migrated form: an explicit write is the one place a file moves forward.
 * @param {string} configPath
 * @param {Record<string, unknown>} document
 * @returns {Promise<void>}
 */
export async function writeConfigFile(configPath, document) {
  const { document: current } = migrateDocument(document, { label: path.basename(configPath) });
  resolveConfig(current, configPath);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, stringifyJson(current), 'utf8');
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
