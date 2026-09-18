// Signature loader and the evidence-row model (amendment 37.3, D-B16, D-B17).
//
// Component detection is data. Each kind ships a schema-validated JSON signature file, so adding a
// framework is a data change with a fixture rather than a new module - which keeps the churn out of
// the safety-enforcing code and lets `doctor --explain` name the row that fired.
//
// Only verified names ship: every row cites a claim, an evidence file, a version and a retrieval date,
// and `test/lint/signatures.test.mjs` fails the build on a row that does not. That is also what keeps
// the Photon gap honest rather than embarrassing: no row, no claim, no detection.
import fs from 'node:fs';
import { compileSchema, formatSchemaErrors } from '../../plugin/opencode-unity-lib/json-schema.js';
import { compareOrdinal } from '../unity/fs-view.js';

export const SIGNATURES_DIR_URL = new URL('./signatures/', import.meta.url);
export const SIGNATURE_SCHEMA_URL = new URL('../../schema/signature.schema.json', import.meta.url);

/** A signature id may instead cite a section of this product's own specification. */
const SPEC_SIGNATURE = /^spec:\d+(?:\.\d+)*$/;

/**
 * @typedef {object} SignatureMatch
 * @property {string} [fileName]
 * @property {string[]} [fileNames]
 * @property {string} [extension]
 * @property {string} [dirName]
 * @property {string} [relativePath]
 * @property {string} [inDirNamed]
 * @property {string[]} [contains]
 * @property {string} [dependency]
 * @property {string} [unityPackage]
 * @property {string} [assembly]
 * @property {string} [jsonKey]
 */

/**
 * @typedef {object} SignatureRow
 * @property {string} id
 * @property {'anchor' | 'overlay' | 'workspace-marker' | 'package-manager' | 'test-runner' | 'framework' | 'runtime' | 'migrations' | 'signal' | 'port' | 'never-opened'} fact
 * @property {string} [value]
 * @property {SignatureMatch} match
 * @property {string} [note]
 * @property {string} claim
 * @property {string} evidence
 * @property {string} version
 * @property {string} retrieved
 */

/**
 * @typedef {object} SignatureFile
 * @property {number} schemaVersion
 * @property {string} id
 * @property {string} title
 * @property {SignatureRow[]} rows
 */

/**
 * @typedef {object} SignatureTable
 * @property {SignatureFile[]} files          Sorted by file id.
 * @property {Map<string, SignatureRow>} rows Row id -> row.
 */

/** @type {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaValidator | undefined} */
let signatureValidator;

/** @type {SignatureTable | undefined} */
let cachedTable;

/**
 * @returns {Record<string, any>}
 */
export function readSignatureSchema() {
  return JSON.parse(fs.readFileSync(SIGNATURE_SCHEMA_URL, 'utf8'));
}

/**
 * @param {unknown} value
 * @returns {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaError[]}
 */
export function validateSignatureFile(value) {
  signatureValidator ??= compileSchema(readSignatureSchema());
  return signatureValidator(value);
}

/**
 * The suffix is `.signature.json` rather than `<id>.json` so that this product's own tree never looks
 * like a repository it detects: a file called `firebase.json` under `src/` would declare a Firebase
 * overlay on opencode-unity itself.
 */
export const SIGNATURE_FILE_SUFFIX = '.signature.json';

/**
 * @param {{ dir?: URL }} [options]
 * @returns {string[]} File names, sorted.
 */
export function listSignatureFileNames({ dir = SIGNATURES_DIR_URL } = {}) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(SIGNATURE_FILE_SUFFIX))
    .sort(compareOrdinal);
}

/**
 * Reads and validates every signature file. Cached, because the table is immutable shipped data and
 * discovery asks for rows once per component.
 * @param {{ dir?: URL, cache?: boolean }} [options]
 * @returns {SignatureTable}
 */
export function loadSignatures({ dir = SIGNATURES_DIR_URL, cache = true } = {}) {
  if (cache && cachedTable && dir.href === SIGNATURES_DIR_URL.href) return cachedTable;

  /** @type {SignatureFile[]} */
  const files = [];
  /** @type {Map<string, SignatureRow>} */
  const rows = new Map();

  for (const name of listSignatureFileNames({ dir })) {
    const fileUrl = new URL(name, dir);
    /** @type {SignatureFile} */
    const file = JSON.parse(fs.readFileSync(fileUrl, 'utf8'));
    const errors = validateSignatureFile(file);
    if (errors.length > 0) throw new TypeError(`Signature file ${name} is invalid: ${formatSchemaErrors(errors)}`);
    if (`${file.id}${SIGNATURE_FILE_SUFFIX}` !== name) throw new TypeError(`Signature file ${name} declares id '${file.id}'; the file must be named after its id`);

    for (const row of file.rows) {
      if (!row.id.startsWith(`${file.id}/`)) throw new TypeError(`Signature row '${row.id}' does not belong to file '${file.id}'`);
      if (rows.has(row.id)) throw new TypeError(`Duplicate signature row id '${row.id}'`);
      rows.set(row.id, row);
    }
    files.push(file);
  }

  const table = { files, rows };
  if (cache && dir.href === SIGNATURES_DIR_URL.href) cachedTable = table;
  return table;
}

/**
 * @param {string} id
 * @param {{ table?: SignatureTable }} [options]
 * @returns {SignatureRow}
 * @throws {TypeError} An unknown id is a programming error, never a silently missing detection.
 */
export function signatureRow(id, { table = loadSignatures() } = {}) {
  const row = table.rows.get(id);
  if (!row) throw new TypeError(`Unknown signature row: '${id}'`);
  return row;
}

/**
 * @param {string} fact
 * @param {{ table?: SignatureTable }} [options]
 * @returns {SignatureRow[]}
 */
export function signatureRowsFor(fact, { table = loadSignatures() } = {}) {
  return [...table.rows.values()].filter((row) => row.fact === fact);
}

/**
 * @typedef {object} EvidenceEntry
 * @property {string} fact       What this line of the facts asserts.
 * @property {string} signature  A signature row id, or `spec:<section>` for a rule this product owns.
 * @property {string} file       The file that produced it, relative to the workspace root.
 */

/**
 * One evidence row: what `doctor --explain` prints and what the fixture tests assert against. Every
 * fact a component states names the signature row and the file that produced it, so a wrong fact can
 * always be traced to a row and a path rather than to "the scanner decided".
 * @param {string} fact
 * @param {string} signature
 * @param {string} file
 * @param {{ table?: SignatureTable }} [options]
 * @returns {EvidenceEntry}
 */
export function evidenceRow(fact, signature, file, { table = loadSignatures() } = {}) {
  if (!SPEC_SIGNATURE.test(signature)) signatureRow(signature, { table });
  return { fact, signature, file };
}
