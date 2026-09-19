// Forward-only, pure schemaVersion migrations (spec 6.2, 22). Each step takes a document of version N and
// returns a new document of version N + 1 without changing its input. A document newer than this CLI is
// refused rather than guessed at.
//
// A migration runs in memory every time an older file is read. The file itself changes only on an
// explicit write (`upgrade`, or a command that writes config.json for another reason), which is why a
// step must be idempotent and must keep the user's key order: the same file is migrated on every load.
import { CliError, EXIT } from '../cli/exit-codes.js';

export const CURRENT_CONFIG_SCHEMA_VERSION = 2;

/**
 * @typedef {object} Migration
 * @property {number} from
 * @property {string} summary                                     One line for the upgrade notice.
 * @property {(document: Record<string, unknown>) => Record<string, unknown>} migrate  Returns version from + 1.
 */

/**
 * What the one 1 -> 2 migration inserts (amendment D-M6, D-M21): the `network` (35.7), `shape` (36.8) and
 * `project` (37.10) blocks, `experimental.platforms` (33.9) and `safety.multiplayerProtectedGlobs` (37.7),
 * each with its version-2 default.
 *
 * These are also today's defaults, and `DEFAULT_CONFIG` reads them from here so the two cannot differ.
 * A later release that changes one copies the new value into `DEFAULT_CONFIG` and ships its own
 * migration; this snapshot never changes, because a file migrated last year must migrate the same way
 * today.
 * @type {Readonly<{
 *   network: import('./config.js').NetworkSettings,
 *   shape: import('./config.js').ShapeSettings,
 *   project: import('./config.js').WorkspaceSettings,
 *   safety: { multiplayerProtectedGlobs: string[] },
 *   experimental: { platforms: boolean },
 * }>}
 */
export const CONFIG_V2_BLOCKS = deepFreeze({
  network: {
    enabled: true,
    profile: 'standard',
    allow: [],
    limits: {
      maxResponseBytes: 65536,
      maxOutputChars: 8192,
      maxRequestBodyBytes: 32768,
      maxUrlChars: 2048,
      connectTimeoutMs: 5000,
      firstByteTimeoutMs: 10000,
      totalTimeoutMs: 20000,
      maxRequestsPerSession: 40,
      maxRequestsPerMinute: 20,
    },
    bash: 'deny',
    extraDeniedQueryKeys: [],
    extraDeniedHosts: [],
    extraReservedPorts: [],
  },
  shape: {
    mode: 'auto',
    maxInputChars: 2000,
    maxOutputTokens: 256,
    timeoutSec: 60,
    anchorCandidates: 5,
    grepTimeoutMs: 2000,
  },
  project: {
    components: 'auto',
    maxComponents: 12,
    factsBudgetChars: 2600,
    unityBlockChars: 1100,
    componentBlockChars: 200,
    maxRenderedBlocks: 6,
    walkEntryCap: 50000,
    readBudgetBytes: 6291456,
    verify: { enabled: true, scriptOrder: ['test', 'build', 'typecheck', 'check'], timeoutSec: 900, blockScriptBodies: true },
    database: { readEnvExampleKeys: true, maxEnvExampleKeys: 12 },
    multiplayer: { ruleBlock: 'auto' },
  },
  safety: {
    // Mechanism 3 of 37.7: folders and names where an authority, economy or anti-cheat decision usually
    // lives. A coarse net with known false positives, so it is a list the user can shorten, not a
    // constant. OpenCode wildcard syntax, where `*` also crosses `/`.
    multiplayerProtectedGlobs: [
      '*.rules',
      '*Economy/*',
      '*Purchas*/*',
      '*Entitlement*/*',
      '*Anticheat*/*',
      '*AntiCheat*/*',
      '*ServerAuthority*',
      '*Reconcil*',
      '*Rollback*',
    ],
  },
  experimental: { platforms: false },
});

/**
 * schemaVersion 1 -> 2. Inserts every block of `CONFIG_V2_BLOCKS` that the document does not already
 * have, key by key, and never replaces a value that is there: a user's own `network` or `safety` value
 * survives even when it is invalid, so validation names it instead of the migration hiding it. Existing
 * keys keep their order and new ones are appended, so a written file differs from its v1 form only by
 * what was added.
 * @param {Record<string, unknown>} document
 * @returns {Record<string, unknown>}
 */
export function migrateConfigV1ToV2(document) {
  const source = structuredClone(document);
  /** @type {Record<string, unknown>} */
  const result = { ...source, schemaVersion: 2 };
  for (const [key, block] of Object.entries(CONFIG_V2_BLOCKS)) result[key] = fillMissing(block, source[key]);
  return result;
}

/**
 * Config migrations in order; the step for version N produces version N + 1.
 * @type {readonly Migration[]}
 */
export const CONFIG_MIGRATIONS = Object.freeze([
  Object.freeze({
    from: 1,
    summary:
      'schemaVersion 1 -> 2: adds the network block (standard profile: the shipped read-only documentation hosts and loopback reads), shape, project, experimental.platforms and safety.multiplayerProtectedGlobs',
    migrate: migrateConfigV1ToV2,
  }),
]);

/**
 * @typedef {object} MigrationResult
 * @property {Record<string, unknown>} document
 * @property {number} fromVersion
 * @property {number} toVersion
 * @property {string[]} applied   Summaries of the steps that ran.
 */

/**
 * @param {unknown} document
 * @param {{ migrations?: readonly Migration[], currentVersion?: number, label?: string }} [options]
 * @returns {MigrationResult}
 */
export function migrateDocument(document, { migrations = CONFIG_MIGRATIONS, currentVersion = CURRENT_CONFIG_SCHEMA_VERSION, label = 'config.json' } = {}) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw migrationError(`${label} must contain a JSON object`);
  }
  const record = /** @type {Record<string, unknown>} */ (document);
  const fromVersion = record.schemaVersion;
  if (fromVersion === undefined) {
    throw migrationError(`${label} has no schemaVersion`, `Add "schemaVersion": ${currentVersion} at the top of the file.`);
  }
  if (!Number.isSafeInteger(fromVersion) || /** @type {number} */ (fromVersion) < 1) {
    throw migrationError(`${label} schemaVersion must be a positive integer, got ${JSON.stringify(fromVersion)}`);
  }
  const startVersion = /** @type {number} */ (fromVersion);
  if (startVersion > currentVersion) {
    throw new CliError(`${label} schemaVersion ${startVersion} is newer than this opencode-unity supports (${currentVersion})`, {
      exitCode: EXIT.USAGE,
      code: 'config_too_new',
      hint: 'Update opencode-unity, or restore the backup written by the newer version.',
    });
  }
  let current = record;
  /** @type {string[]} */
  const applied = [];
  for (let version = startVersion; version < currentVersion; version += 1) {
    const step = migrations.find((migration) => migration.from === version);
    if (!step) throw new TypeError(`No ${label} migration from schemaVersion ${version}`);
    const next = step.migrate(structuredClone(current));
    if (next?.schemaVersion !== version + 1) {
      throw new TypeError(`${label} migration from ${version} must return schemaVersion ${version + 1}`);
    }
    applied.push(step.summary);
    current = next;
  }
  return { document: current === record ? structuredClone(record) : current, fromVersion: startVersion, toVersion: currentVersion, applied };
}

/**
 * The default where the value is missing; inside two objects, the same key by key; anything else is the
 * value as it stands.
 * @param {unknown} defaults
 * @param {unknown} value
 * @returns {unknown}
 */
function fillMissing(defaults, value) {
  if (value === undefined) return structuredClone(defaults);
  if (!isPlainObject(defaults) || !isPlainObject(value)) return value;
  /** @type {Record<string, unknown>} */
  const result = { ...value };
  for (const [key, child] of Object.entries(defaults)) result[key] = fillMissing(child, value[key]);
  return result;
}

// The two object helpers live here rather than in config.js, which re-exports them, because config.js
// imports this module and a snapshot frozen at load time cannot wait for a cycle to resolve.

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

/**
 * @param {string} message
 * @param {string} [hint]
 * @returns {CliError}
 */
function migrationError(message, hint) {
  return new CliError(message, { exitCode: EXIT.USAGE, code: 'config_invalid', hint });
}
