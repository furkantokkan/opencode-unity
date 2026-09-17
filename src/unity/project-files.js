// Generated project files (spec 9.2): root .csproj/.sln/.slnx, their Compile items and how stale they are.
import { compareOrdinal, joinProjectPath, toPosix } from './fs-view.js';
import { findIdePackage } from './packages.js';

const CSPROJ_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_STALE_EXAMPLES = 5;

/**
 * @typedef {object} CsprojFile
 * @property {string} name      File name, for example `Assembly-CSharp.csproj`.
 * @property {number} mtimeMs
 * @property {number} compileCount
 * @property {boolean} readable
 */

/**
 * @typedef {object} ProjectFilesFact
 * @property {CsprojFile[]} csproj
 * @property {string[]} solutions
 * @property {string | null} idePackage
 * @property {boolean} generated            At least one readable .csproj exists.
 * @property {Set<string>} compileItems     Lower-case relative posix paths from every .csproj.
 * @property {string[]} warnings
 */

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @param {{ packages?: import('./packages.js').PackageInfo[] }} [options]
 * @returns {ProjectFilesFact}
 */
export function detectProjectFiles(view, root, { packages = [] } = {}) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {CsprojFile[]} */
  const csproj = [];
  /** @type {string[]} */
  const solutions = [];
  /** @type {Set<string>} */
  const compileItems = new Set();

  for (const entry of view.readDir(root)) {
    if (!entry.isFile) continue;
    const lower = entry.name.toLowerCase();
    if (lower.endsWith('.sln') || lower.endsWith('.slnx')) {
      solutions.push(entry.name);
      continue;
    }
    if (!lower.endsWith('.csproj')) continue;
    const filePath = joinProjectPath(root, entry.name);
    const read = view.readText(filePath, { maxBytes: CSPROJ_MAX_BYTES });
    if (!read || read.truncated) {
      warnings.push(`${entry.name} could not be read`);
      csproj.push({ name: entry.name, mtimeMs: view.stat(filePath)?.mtimeMs ?? 0, compileCount: 0, readable: false });
      continue;
    }
    const items = parseCompileItems(read.text);
    for (const item of items) compileItems.add(item.toLowerCase());
    csproj.push({ name: entry.name, mtimeMs: view.stat(filePath)?.mtimeMs ?? 0, compileCount: items.length, readable: true });
  }

  csproj.sort((a, b) => compareOrdinal(a.name, b.name));
  solutions.sort(compareOrdinal);
  return {
    csproj,
    solutions,
    idePackage: findIdePackage(packages),
    generated: csproj.some((file) => file.readable),
    compileItems,
    warnings,
  };
}

/**
 * Unity writes `<Compile Include="Assets\Game\Player.cs" />` with Windows separators and MSBuild escapes.
 * @param {string} text
 * @returns {string[]} Relative posix paths, in file order.
 */
export function parseCompileItems(text) {
  /** @type {string[]} */
  const items = [];
  const pattern = /<Compile\s+[^>]*?Include\s*=\s*"([^"]*)"/gi;
  for (const match of text.matchAll(pattern)) {
    const value = normalizeItemPath(match[1]);
    if (value) items.push(value);
  }
  return items;
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeItemPath(value) {
  const decoded = decodeXml(value).replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  return toPosix(decoded).replace(/^\.\//, '').trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * @typedef {object} StalenessFact
 * @property {boolean} stale
 * @property {number} count               Scripts missing from every .csproj, plus assemblies with no .csproj.
 * @property {string[]} examples          At most 5 paths, assemblies first.
 * @property {number} missingScripts
 * @property {number} missingAssemblies
 */

/**
 * Staleness (spec 9.2): scripts under a mapped folder that no .csproj includes, and assemblies with no .csproj.
 * @param {object} input
 * @param {ProjectFilesFact} input.projectFiles
 * @param {import('../facts/compile-map.js').CompileRow[]} input.compileMap
 * @param {import('./assemblies.js').AsmdefRecord[]} input.definitions
 * @param {string[]} input.sourceFiles  Relative posix paths of every `.cs` file found.
 * @returns {StalenessFact}
 */
export function findStaleness({ projectFiles, compileMap, definitions, sourceFiles }) {
  if (!projectFiles.generated) return { stale: false, count: 0, examples: [], missingScripts: 0, missingAssemblies: 0 };

  const generatedCsprojs = new Set(projectFiles.csproj.map((file) => file.name.toLowerCase()));
  const missingAssemblies = definitions
    .filter((definition) => !generatedCsprojs.has(definition.csproj.toLowerCase()))
    .map((definition) => definition.file)
    .sort(compareOrdinal);
  const missingAssemblyFolders = [
    ...new Set(
      definitions
        .filter((definition) => !generatedCsprojs.has(definition.csproj.toLowerCase()))
        .map((definition) => `${definition.folder.toLowerCase()}/`),
    ),
  ];

  /** @type {string[]} */
  const missingScripts = [];
  for (const file of sourceFiles) {
    const lower = file.toLowerCase();
    if (!lower.endsWith('.cs')) continue;
    if (!findRow(compileMap, lower)) continue;
    // An assembly with no .csproj is reported once, not once per script.
    if (missingAssemblyFolders.some((folder) => lower.startsWith(folder))) continue;
    if (!projectFiles.compileItems.has(lower)) missingScripts.push(file);
  }

  const count = missingScripts.length + missingAssemblies.length;
  return {
    stale: count > 0,
    count,
    examples: [...missingAssemblies, ...missingScripts].slice(0, MAX_STALE_EXAMPLES),
    missingScripts: missingScripts.length,
    missingAssemblies: missingAssemblies.length,
  };
}

/**
 * @param {import('../facts/compile-map.js').CompileRow[]} rows
 * @param {string} lowerPath
 * @returns {boolean}
 */
function findRow(rows, lowerPath) {
  return rows.some((row) => lowerPath.startsWith(row.prefix.toLowerCase()));
}

/**
 * @typedef {object} DotnetFact
 * @property {boolean} checked
 * @property {boolean} present
 * @property {string[]} sdks   Version strings, newest last.
 */

/**
 * @param {string} stdout  Output of `dotnet --list-sdks`.
 * @returns {string[]}
 */
export function parseDotnetSdks(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => /^(\d+\.\d+\.\d+[\w.-]*)\s+\[/.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => match[1]);
}
