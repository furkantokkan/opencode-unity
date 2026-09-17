// Compile map (spec 9.3): which .csproj compiles the scripts in a folder, following Unity's special folders.
import { compareOrdinal } from '../unity/fs-view.js';

export const DEFAULT_ASSEMBLY = 'Assembly-CSharp';
export const EDITOR_ASSEMBLY = 'Assembly-CSharp-Editor';
export const FIRSTPASS_ASSEMBLY = 'Assembly-CSharp-firstpass';
export const EDITOR_FIRSTPASS_ASSEMBLY = 'Assembly-CSharp-Editor-firstpass';

/** Top-level folders whose scripts compile into the first-pass assemblies. */
export const FIRSTPASS_ROOTS = Object.freeze(['Assets/Plugins/', 'Assets/Standard Assets/', 'Assets/Pro Standard Assets/']);

/**
 * @param {string} csproj
 * @returns {string}
 */
export function getCompileCommand(csproj) {
  return `dotnet build ${csproj} -nologo -tl:off -v q "-clp:ErrorsOnly;NoSummary"`;
}

/**
 * @typedef {'asmdef' | 'asmref' | 'special-folder' | 'default'} CompileRowSource
 */

/**
 * @typedef {object} CompileRow
 * @property {string} prefix     Folder prefix with a trailing `/`, for example `Assets/Game/`.
 * @property {string} assembly
 * @property {string} csproj
 * @property {string} command
 * @property {CompileRowSource} source
 * @property {boolean} generated  False when Unity has not generated this .csproj yet.
 */

/**
 * Rows are sorted longest prefix first, because the longest prefix wins; the default row is always last.
 * @param {object} input
 * @param {import('../unity/assemblies.js').AsmdefRecord[]} input.definitions
 * @param {import('../unity/assemblies.js').AsmrefRecord[]} input.references
 * @param {string[]} input.sourceFiles   Relative posix paths of every `.cs` file found.
 * @param {string[]} input.csprojNames   Root `.csproj` file names.
 * @returns {{ rows: CompileRow[], warnings: string[] }}
 */
export function buildCompileMap({ definitions, references, sourceFiles, csprojNames }) {
  const generated = new Set(csprojNames.map((name) => name.toLowerCase()));
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, CompileRow>} */
  const rows = new Map();

  /** @param {string} prefix @param {string} assembly @param {CompileRowSource} source */
  const addRow = (prefix, assembly, source) => {
    const key = prefix.toLowerCase();
    const existing = rows.get(key);
    if (existing) {
      if (existing.assembly !== assembly) warnings.push(`${prefix} maps to both ${existing.assembly} and ${assembly}`);
      return;
    }
    const csproj = `${assembly}.csproj`;
    rows.set(key, { prefix, assembly, csproj, command: getCompileCommand(csproj), source, generated: generated.has(csproj.toLowerCase()) });
  };

  for (const definition of definitions) addRow(`${definition.folder}/`, definition.name, 'asmdef');
  for (const reference of references) {
    if (reference.assembly) addRow(`${reference.folder}/`, reference.assembly, 'asmref');
  }

  const declared = [...rows.values()];
  // Added before the special folders, so `Assets/` is the default row and never a special-folder row.
  addRow('Assets/', DEFAULT_ASSEMBLY, 'default');
  for (const file of sourceFiles) {
    if (!file.toLowerCase().endsWith('.cs')) continue;
    if (findLongestPrefixRow(declared, file)) continue;
    const fallback = getFallbackAssembly(file);
    if (fallback) addRow(fallback.prefix, fallback.assembly, 'special-folder');
  }

  return { rows: sortRows([...rows.values()]), warnings };
}

/**
 * Unity's special folders, for scripts that no .asmdef covers.
 * @param {string} relativePath
 * @returns {{ prefix: string, assembly: string } | null} Null outside `Assets/`, where scripts need an .asmdef.
 */
export function getFallbackAssembly(relativePath) {
  // Windows paths are case-insensitive, so folder names are matched ignoring case.
  const lower = relativePath.toLowerCase();
  if (!lower.startsWith('assets/')) return null;
  const firstpass = FIRSTPASS_ROOTS.find((candidate) => lower.startsWith(candidate.toLowerCase()));
  const editorPrefix = findEditorPrefix(relativePath);
  if (firstpass && editorPrefix) return { prefix: editorPrefix, assembly: EDITOR_FIRSTPASS_ASSEMBLY };
  if (firstpass) return { prefix: relativePath.slice(0, firstpass.length), assembly: FIRSTPASS_ASSEMBLY };
  if (editorPrefix) return { prefix: editorPrefix, assembly: EDITOR_ASSEMBLY };
  return { prefix: 'Assets/', assembly: DEFAULT_ASSEMBLY };
}

/**
 * @param {CompileRow[]} rows
 * @param {string} relativePath
 * @returns {CompileRow | null}
 */
export function lookupCompileRow(rows, relativePath) {
  return findLongestPrefixRow(rows, relativePath);
}

/**
 * @param {CompileRow[]} rows
 * @returns {string[]} Every .csproj in the map, sorted, without duplicates.
 */
export function listCompileCsprojs(rows) {
  return [...new Set(rows.map((row) => row.csproj))].sort(compareOrdinal);
}

/**
 * @param {string} relativePath
 * @returns {string | null} The prefix up to and including the first `Editor` folder.
 */
function findEditorPrefix(relativePath) {
  const segments = relativePath.split('/');
  // The last segment is the file name, so an `Editor` file name is not a folder.
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index].toLowerCase() === 'editor') return `${segments.slice(0, index + 1).join('/')}/`;
  }
  return null;
}

/**
 * @param {CompileRow[]} rows
 * @param {string} relativePath
 * @returns {CompileRow | null}
 */
function findLongestPrefixRow(rows, relativePath) {
  const lower = relativePath.toLowerCase();
  /** @type {CompileRow | null} */
  let best = null;
  for (const row of rows) {
    if (!lower.startsWith(row.prefix.toLowerCase())) continue;
    if (!best || row.prefix.length > best.prefix.length) best = row;
  }
  return best;
}

/**
 * @param {CompileRow[]} rows
 * @returns {CompileRow[]}
 */
function sortRows(rows) {
  return rows.sort((a, b) => {
    const aDefault = a.source === 'default';
    const bDefault = b.source === 'default';
    if (aDefault !== bDefault) return aDefault ? 1 : -1;
    if (a.prefix.length !== b.prefix.length) return b.prefix.length - a.prefix.length;
    return compareOrdinal(a.prefix, b.prefix);
  });
}
