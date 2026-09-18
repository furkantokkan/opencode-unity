// The install manifest (spec 14.2): the only record of what setup and upgrade changed outside this
// package, and therefore the only thing uninstall is allowed to act on. Everything here is data plus
// pure functions; the writing happens in apply.js, so a plan can be built and printed without a manifest
// file existing at all.
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compileSchema } from '../../plugin/opencode-unity-lib/json-schema.js';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { stableStringify } from '../core/hash.js';

export const MANIFEST_SCHEMA_URL = new URL('../../schema/install-manifest.schema.json', import.meta.url);
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * @typedef {'file'|'dir'|'userEnv'|'launchctlEnv'|'ollamaModel'|'wtFragment'|'skillCopy'|'npmGlobal'|'projectDir'} ManifestKind
 */

/**
 * @typedef {object} ManifestEntry
 * @property {ManifestKind} kind
 * @property {string} createdBy
 * @property {string} [path]
 * @property {string} [name]
 * @property {string} [value]
 * @property {string | null} [previous]
 * @property {string} [sha256]
 * @property {string} [sha256Tree]
 * @property {string} [target]
 * @property {string} [version]
 * @property {string} [baseModel]
 * @property {boolean} [pulledBySetup]
 * @property {boolean} [derived]
 * @property {string} [createdRoot]
 */

/**
 * Enough of an entry to name it: the kind and whichever identity fields that kind uses.
 * @typedef {Pick<ManifestEntry, 'kind'> & Partial<ManifestEntry>} EntryKey
 */

/**
 * @typedef {object} Manifest
 * @property {number} schemaVersion
 * @property {string} cliVersion
 * @property {string} [installedAt]
 * @property {string} [updatedAt]
 * @property {ManifestEntry[]} entries
 */

/**
 * What every kind has in common, so apply, upgrade and uninstall can treat entries generically instead
 * of switching on `kind` in three places.
 * @typedef {object} KindSpec
 * @property {ManifestKind} kind
 * @property {readonly string[]} identity  Fields that make two entries the same change.
 * @property {'file'|'tree'|null} verify   What uninstall compares before removing: a file hash, a tree hash, or nothing.
 * @property {(entry: ManifestEntry) => string} describe
 */

/** @type {readonly KindSpec[]} */
export const MANIFEST_KIND_SPECS = Object.freeze([
  { kind: 'file', identity: ['path'], verify: 'file', describe: (entry) => `file ${entry.path}` },
  { kind: 'dir', identity: ['path'], verify: null, describe: (entry) => `directory ${entry.path} (with everything in it)` },
  { kind: 'userEnv', identity: ['name'], verify: null, describe: (entry) => `user environment variable ${entry.name}` },
  { kind: 'launchctlEnv', identity: ['name'], verify: null, describe: (entry) => `launchctl environment variable ${entry.name}` },
  { kind: 'ollamaModel', identity: ['name'], verify: null, describe: (entry) => `Ollama model ${entry.name}` },
  { kind: 'wtFragment', identity: ['path'], verify: 'file', describe: (entry) => `Windows Terminal fragment ${entry.path}` },
  { kind: 'skillCopy', identity: ['target', 'path'], verify: 'file', describe: (entry) => `${entry.target} skill ${entry.path}` },
  { kind: 'npmGlobal', identity: ['name'], verify: null, describe: (entry) => `global npm package ${entry.name}@${entry.version}` },
  { kind: 'projectDir', identity: ['path'], verify: 'tree', describe: (entry) => `in-project folder ${entry.path}` },
]);

const KIND_SPECS_BY_KIND = new Map(MANIFEST_KIND_SPECS.map((spec) => [spec.kind, spec]));

/** @type {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaValidator | undefined} */
let validator;

/**
 * @returns {Record<string, any>}
 */
export function readManifestSchema() {
  return JSON.parse(fsSync.readFileSync(MANIFEST_SCHEMA_URL, 'utf8'));
}

/**
 * @param {unknown} value
 * @returns {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaError[]}
 */
export function validateManifest(value) {
  validator ??= compileSchema(readManifestSchema());
  return validator(value);
}

/**
 * @param {ManifestKind} kind
 * @returns {KindSpec}
 */
export function getKindSpec(kind) {
  const spec = KIND_SPECS_BY_KIND.get(kind);
  if (!spec) throw new TypeError(`Unknown manifest kind '${kind}'`);
  return spec;
}

/**
 * Two entries describe the same change when their kind and identity fields match, which is what makes a
 * second `setup` update an entry instead of appending a duplicate.
 * @param {EntryKey} entry
 * @returns {string}
 */
export function entryIdentity(entry) {
  const spec = getKindSpec(entry.kind);
  return stableStringify([entry.kind, ...spec.identity.map((field) => /** @type {Record<string, unknown>} */ (entry)[field] ?? null)]);
}

/**
 * @param {ManifestEntry} entry
 * @returns {string}
 */
export function describeEntry(entry) {
  return getKindSpec(entry.kind).describe(entry);
}

/**
 * @param {string} command   'setup', 'upgrade', 'host'.
 * @param {string} cliVersion
 * @returns {string}
 */
export function createdBy(command, cliVersion) {
  return `${command}@${cliVersion}`;
}

/**
 * @param {string} cliVersion
 * @param {{ now?: () => Date }} [options]
 * @returns {Manifest}
 */
export function createManifest(cliVersion, { now = () => new Date() } = {}) {
  const timestamp = toTimestamp(now());
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, cliVersion, installedAt: timestamp, updatedAt: timestamp, entries: [] };
}

/**
 * @param {Date} date
 * @returns {string}
 */
export function toTimestamp(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Adds or replaces one entry. Pure: the caller keeps the previous manifest, which is what lets a failed
 * apply put the old one back.
 * @param {Manifest} manifest
 * @param {ManifestEntry} entry
 * @returns {Manifest}
 */
export function upsertEntry(manifest, entry) {
  const identity = entryIdentity(entry);
  const entries = manifest.entries.filter((existing) => entryIdentity(existing) !== identity);
  entries.push(entry);
  return { ...manifest, entries };
}

/**
 * @param {Manifest} manifest
 * @param {readonly string[]} identities
 * @returns {Manifest}
 */
export function removeEntries(manifest, identities) {
  const removed = new Set(identities);
  return { ...manifest, entries: manifest.entries.filter((entry) => !removed.has(entryIdentity(entry))) };
}

/**
 * @param {Manifest} manifest
 * @param {ManifestKind} kind
 * @returns {ManifestEntry[]}
 */
export function entriesOfKind(manifest, kind) {
  return manifest.entries.filter((entry) => entry.kind === kind);
}

/**
 * @param {Manifest} manifest
 * @param {EntryKey} entry  Only the kind and its identity fields are read.
 * @returns {ManifestEntry | undefined}
 */
export function findEntry(manifest, entry) {
  const identity = entryIdentity(entry);
  return manifest.entries.find((existing) => entryIdentity(existing) === identity);
}

/**
 * Reads the manifest, or reports that there is none. A file that exists but does not parse or does not
 * validate is exit 4: continuing would mean acting on a record we cannot trust.
 * @param {string} manifestPath
 * @param {{ readFile?: (target: string) => Promise<string> }} [options]
 * @returns {Promise<{ manifest: Manifest | null, path: string }>}
 */
export async function loadManifest(manifestPath, { readFile = (target) => fs.readFile(target, 'utf8') } = {}) {
  /** @type {string} */
  let text;
  try {
    text = await readFile(manifestPath);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return { manifest: null, path: manifestPath };
    throw new CliError(`The install manifest could not be read: ${/** @type {Error} */ (error).message}`, {
      exitCode: EXIT.RUNTIME,
      code: 'manifest_unreadable',
      data: { path: manifestPath },
      cause: error,
    });
  }
  return { manifest: parseManifest(text, manifestPath), path: manifestPath };
}

/**
 * @param {string} text
 * @param {string} source
 * @returns {Manifest}
 */
export function parseManifest(text, source = 'install-manifest.json') {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw manifestInvalid(source, [`is not valid JSON (${/** @type {Error} */ (error).message})`]);
  }
  const errors = validateManifest(value);
  if (errors.length > 0) throw manifestInvalid(source, errors.map((error) => `${error.path || 'the manifest'} ${error.message}`));
  return /** @type {Manifest} */ (value);
}

/**
 * @param {string} manifestPath
 * @param {Manifest} manifest
 * @param {{ now?: () => Date }} [options]
 * @returns {Promise<void>}
 */
export async function saveManifest(manifestPath, manifest, { now = () => new Date() } = {}) {
  const document = { ...manifest, updatedAt: toTimestamp(now()) };
  const errors = validateManifest(document);
  if (errors.length > 0) {
    throw new CliError(`Refusing to write an invalid install manifest: ${errors.slice(0, 5).map((error) => `${error.path || 'root'} ${error.message}`).join('; ')}`, {
      exitCode: EXIT.RUNTIME,
      code: 'manifest_invalid',
      data: { problems: errors.map((error) => `${error.path || 'root'} ${error.message}`) },
    });
  }
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(temporaryPath, manifestPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Semantic comparison used by the upgrade notice of spec 14.3. Pre-release tags are compared as plain
 * text after the numbers, which is enough for our own `0.1.0-rc.1` style and never claims more.
 * @param {string} left
 * @param {string} right
 * @returns {number} -1, 0 or 1.
 */
export function compareVersions(left, right) {
  const parse = (/** @type {string} */ value) => {
    const [core, pre = ''] = value.split('-', 2);
    return { numbers: core.split('.').map((part) => Number.parseInt(part, 10)), pre };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  if (a.pre === b.pre) return 0;
  // A release outranks any pre-release of the same numbers.
  if (a.pre === '') return 1;
  if (b.pre === '') return -1;
  return a.pre > b.pre ? 1 : -1;
}

/**
 * @param {Manifest | null} manifest
 * @param {string} packageVersion
 * @returns {boolean}
 */
export function needsUpgrade(manifest, packageVersion) {
  return manifest !== null && compareVersions(manifest.cliVersion, packageVersion) < 0;
}

/**
 * @param {string} source
 * @param {string[]} problems
 * @returns {CliError}
 */
function manifestInvalid(source, problems) {
  return new CliError(`The install manifest is not usable: ${problems.slice(0, 5).join('; ')}`, {
    exitCode: EXIT.VALIDATION,
    code: 'manifest_invalid',
    data: { path: source, problems },
    hint: 'Move the file aside and run setup again to rebuild it; nothing is removed while it cannot be read.',
  });
}
