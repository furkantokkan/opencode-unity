// Forward-only, pure schemaVersion migrations (spec 6.2, 22). Each step takes a document of version N and
// returns a new document of version N + 1 without changing its input. A document newer than this CLI is
// refused rather than guessed at.
import { CliError, EXIT } from '../cli/exit-codes.js';

export const CURRENT_CONFIG_SCHEMA_VERSION = 1;

/**
 * @typedef {object} Migration
 * @property {number} from
 * @property {string} summary                                     One line for the upgrade notice.
 * @property {(document: Record<string, unknown>) => Record<string, unknown>} migrate  Returns version from + 1.
 */

/**
 * Config migrations in order. Version 1 is the first released format, so there is nothing to migrate yet;
 * a step for version N is added when version N + 1 ships.
 * @type {readonly Migration[]}
 */
export const CONFIG_MIGRATIONS = Object.freeze([]);

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
 * @param {string} message
 * @param {string} [hint]
 * @returns {CliError}
 */
function migrationError(message, hint) {
  return new CliError(message, { exitCode: EXIT.USAGE, code: 'config_invalid', hint });
}
