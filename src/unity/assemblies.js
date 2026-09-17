// Assembly definitions (spec 9.2): every *.asmdef and *.asmref under Assets/ and embedded packages.
import { joinProjectPath, readJson } from './fs-view.js';
import { classifyTestAssembly } from './tests.js';
import { extensionOf, parentOf } from './walk.js';

const ASMDEF_MAX_BYTES = 1024 * 1024;
const META_MAX_BYTES = 64 * 1024;

/**
 * @typedef {object} AsmdefRecord
 * @property {string} name
 * @property {string} file      Relative posix path of the .asmdef.
 * @property {string} folder    Relative posix folder, without a trailing slash.
 * @property {string} csproj    `<name>.csproj`, the file Unity generates for this assembly.
 * @property {string | null} guid
 * @property {string[]} includePlatforms
 * @property {string[]} excludePlatforms
 * @property {string[]} defineConstraints
 * @property {string[]} references            Names, with known GUID references resolved.
 * @property {string[]} optionalUnityReferences
 * @property {boolean} isTest
 * @property {import('./tests.js').TestMode | null} testMode
 */

/**
 * @typedef {object} AsmrefRecord
 * @property {string} file
 * @property {string} folder
 * @property {string} reference          The raw value from the file.
 * @property {string | null} assembly    The resolved assembly name, or null when the GUID is unknown.
 */

/**
 * @typedef {object} AssembliesFact
 * @property {AsmdefRecord[]} definitions  Sorted by file path.
 * @property {AsmrefRecord[]} references   Sorted by file path.
 * @property {string[]} warnings
 */

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @param {import('./walk.js').ProjectIndex} index
 * @returns {AssembliesFact}
 */
export function detectAssemblies(view, root, index) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {AsmdefRecord[]} */
  const definitions = [];
  /** @type {AsmrefRecord[]} */
  const references = [];
  /** @type {Map<string, string>} guid -> assembly name */
  const guids = new Map();

  for (const file of index.files) {
    const extension = extensionOf(file);
    if (extension !== '.asmdef' && extension !== '.asmref') continue;
    const document = readJson(view, joinProjectPath(root, file), { maxBytes: ASMDEF_MAX_BYTES });
    if (!document.found || document.error || !isRecord(document.value)) {
      warnings.push(`${file} is not valid JSON`);
      continue;
    }
    const guid = readGuid(view, root, file);
    if (extension === '.asmdef') {
      const record = toAsmdefRecord(file, document.value, guid);
      if (!record) {
        warnings.push(`${file} has no assembly name`);
        continue;
      }
      if (guid) guids.set(guid, record.name);
      definitions.push(record);
    } else {
      const reference = typeof document.value.reference === 'string' ? document.value.reference : '';
      if (!reference) {
        warnings.push(`${file} has no reference`);
        continue;
      }
      references.push({ file, folder: parentOf(file), reference, assembly: null });
    }
  }

  for (const record of definitions) record.references = record.references.map((item) => resolveReference(item, guids));
  for (const record of definitions) Object.assign(record, classifyTestAssembly(record));
  for (const record of references) {
    record.assembly = resolveAssemblyName(record.reference, guids);
    if (!record.assembly) warnings.push(`${record.file} references an unknown assembly (${record.reference})`);
  }

  const duplicates = findDuplicateNames(definitions);
  for (const name of duplicates) warnings.push(`assembly name ${name} is used by more than one .asmdef`);

  return { definitions, references, warnings };
}

/**
 * @param {AsmdefRecord[]} definitions
 * @param {string} relativePath
 * @returns {AsmdefRecord | null} The definition whose folder is the longest prefix of the path.
 */
export function findOwningAssembly(definitions, relativePath) {
  /** @type {AsmdefRecord | null} */
  let owner = null;
  const lower = relativePath.toLowerCase();
  for (const definition of definitions) {
    const prefix = `${definition.folder.toLowerCase()}/`;
    if (!lower.startsWith(prefix)) continue;
    if (!owner || definition.folder.length > owner.folder.length) owner = definition;
  }
  return owner;
}

/**
 * @param {string} file
 * @param {Record<string, any>} document
 * @param {string | null} guid
 * @returns {AsmdefRecord | null}
 */
function toAsmdefRecord(file, document, guid) {
  const name = typeof document.name === 'string' && document.name.trim() ? document.name.trim() : null;
  if (!name) return null;
  return {
    name,
    file,
    folder: parentOf(file),
    csproj: `${name}.csproj`,
    guid,
    includePlatforms: toStringArray(document.includePlatforms),
    excludePlatforms: toStringArray(document.excludePlatforms),
    defineConstraints: toStringArray(document.defineConstraints),
    references: toStringArray(document.references),
    optionalUnityReferences: toStringArray(document.optionalUnityReferences),
    isTest: false,
    testMode: null,
  };
}

/**
 * Reads the `guid:` line from the asset's `.meta` file, so GUID references resolve to names.
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @param {string} file
 * @returns {string | null}
 */
function readGuid(view, root, file) {
  const read = view.readText(joinProjectPath(root, `${file}.meta`), { maxBytes: META_MAX_BYTES });
  const match = read ? /^guid:\s*([0-9a-fA-F]{32})\s*$/m.exec(read.text) : null;
  return match ? match[1].toLowerCase() : null;
}

/**
 * @param {string} reference
 * @param {Map<string, string>} guids
 * @returns {string} The resolved name, or the original reference.
 */
function resolveReference(reference, guids) {
  return resolveAssemblyName(reference, guids) ?? reference;
}

/**
 * @param {string} reference
 * @param {Map<string, string>} guids
 * @returns {string | null}
 */
function resolveAssemblyName(reference, guids) {
  const guid = /^GUID:([0-9a-fA-F]{32})$/.exec(reference);
  if (!guid) return reference || null;
  return guids.get(guid[1].toLowerCase()) ?? null;
}

/**
 * @param {AsmdefRecord[]} definitions
 * @returns {string[]}
 */
function findDuplicateNames(definitions) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const definition of definitions) counts.set(definition.name, (counts.get(definition.name) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([name]) => name);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function toStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
