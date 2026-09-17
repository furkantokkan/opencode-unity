// Packages (spec 9.2): Packages/manifest.json, Packages/packages-lock.json and embedded packages, plus the
// render pipeline, the packages of note and the libraries the code already uses.
import { compareOrdinal, joinProjectPath, readJson } from './fs-view.js';

export const MANIFEST_FILE = 'Packages/manifest.json';
export const LOCK_FILE = 'Packages/packages-lock.json';
export const MAX_NOTABLE_PACKAGES = 8;

const JSON_MAX_BYTES = 4 * 1024 * 1024;

/** @type {ReadonlyArray<{ id: string, pipeline: string }>} */
const RENDER_PIPELINES = Object.freeze([
  { id: 'com.unity.render-pipelines.universal', pipeline: 'URP' },
  { id: 'com.unity.render-pipelines.high-definition', pipeline: 'HDRP' },
]);

export const BUILT_IN_PIPELINE = 'Built-in';

/** Allow-list in output order. */
export const NOTABLE_PACKAGES = Object.freeze([
  { id: 'com.unity.inputsystem', name: 'Input System' },
  { id: 'com.unity.ugui', name: 'uGUI' },
  { id: 'com.unity.textmeshpro', name: 'TextMeshPro' },
  { id: 'com.unity.test-framework', name: 'Test Framework' },
  { id: 'com.unity.addressables', name: 'Addressables' },
  { id: 'com.unity.cinemachine', name: 'Cinemachine' },
  { id: 'com.unity.netcode.gameobjects', name: 'Netcode for GameObjects' },
  { id: 'com.unity.netcode', name: 'Netcode for Entities' },
  { id: 'com.unity.entities', name: 'Entities' },
  { id: 'com.unity.localization', name: 'Localization' },
  { id: 'com.unity.ide.visualstudio', name: 'Visual Studio Editor' },
  { id: 'com.unity.ide.rider', name: 'JetBrains Rider Editor' },
  { id: 'com.unity.ide.vscode', name: 'Visual Studio Code Editor' },
  { id: 'com.coplaydev.unity-mcp', name: 'MCP for Unity' },
]);

/** Packages that can regenerate the root .csproj and .sln files. */
export const IDE_PACKAGE_IDS = Object.freeze(['com.unity.ide.visualstudio', 'com.unity.ide.rider', 'com.unity.ide.vscode']);

/**
 * Libraries detected by a direct manifest dependency or by source usage in first-party code.
 * @type {ReadonlyArray<{ name: string, packageIds: readonly string[], usage: RegExp }>}
 */
export const LIBRARIES = Object.freeze([
  { name: 'UniTask', packageIds: ['com.cysharp.unitask'], usage: /^[ \t]*using[ \t]+Cysharp\.Threading\.Tasks[\w.]*[ \t]*;/m },
  { name: 'Awaitable', packageIds: [], usage: /\bAwaitable\b/ },
  { name: 'VContainer', packageIds: ['jp.hadashikick.vcontainer'], usage: /^[ \t]*using[ \t]+VContainer[\w.]*[ \t]*;/m },
  { name: 'Zenject', packageIds: ['com.svermeulen.extenject', 'com.mathijsbakker.extenject'], usage: /^[ \t]*using[ \t]+Zenject[\w.]*[ \t]*;/m },
  { name: 'R3', packageIds: ['com.cysharp.r3'], usage: /^[ \t]*using[ \t]+R3[\w.]*[ \t]*;/m },
  { name: 'UniRx', packageIds: ['com.neuecc.unirx'], usage: /^[ \t]*using[ \t]+UniRx[\w.]*[ \t]*;/m },
  { name: 'Newtonsoft JSON', packageIds: ['com.unity.nuget.newtonsoft-json'], usage: /^[ \t]*using[ \t]+Newtonsoft\.Json[\w.]*[ \t]*;/m },
]);

/**
 * @typedef {object} PackageInfo
 * @property {string} id
 * @property {string | null} version    A semantic version when one is known.
 * @property {string | null} reference  The raw manifest or lock value (registry version, git URL, file: path).
 * @property {boolean} direct           Listed in manifest.json or embedded.
 * @property {boolean} embedded
 * @property {string | null} folder     Embedded package folder, relative with `/`.
 */

/**
 * @typedef {object} PackagesFact
 * @property {boolean} manifestFound
 * @property {boolean} lockFound
 * @property {PackageInfo[]} packages   Sorted by id.
 * @property {string} pipeline          `URP`, `HDRP` or `Built-in`.
 * @property {Array<{ id: string, name: string, version: string | null }>} notable
 * @property {string[]} warnings
 */

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @param {import('./walk.js').ProjectIndex} index
 * @returns {PackagesFact}
 */
export function detectPackages(view, root, index) {
  /** @type {string[]} */
  const warnings = [];
  const manifest = readJson(view, joinProjectPath(root, MANIFEST_FILE), { maxBytes: JSON_MAX_BYTES });
  const lock = readJson(view, joinProjectPath(root, LOCK_FILE), { maxBytes: JSON_MAX_BYTES });
  if (!manifest.found) warnings.push('Packages/manifest.json not found');
  if (manifest.error) warnings.push(`Packages/manifest.json is not valid JSON: ${manifest.error}`);
  if (lock.error) warnings.push(`Packages/packages-lock.json is not valid JSON: ${lock.error}`);

  const direct = readDependencyMap(manifest.value);
  const locked = readDependencyMap(lock.value);
  const embedded = readEmbeddedPackages(view, root, index, warnings);
  const packages = mergePackages(direct, locked, embedded);

  return {
    manifestFound: manifest.found && !manifest.error,
    lockFound: lock.found && !lock.error,
    packages,
    pipeline: getRenderPipeline(packages),
    notable: getNotablePackages(packages),
    warnings,
  };
}

/**
 * @param {PackageInfo[]} packages
 * @param {string} id
 * @returns {PackageInfo | null}
 */
export function findPackage(packages, id) {
  return packages.find((item) => item.id === id) ?? null;
}

/**
 * The pipeline comes from direct dependencies only; a transitive lock entry does not switch the project.
 * @param {PackageInfo[]} packages
 * @returns {string}
 */
export function getRenderPipeline(packages) {
  for (const { id, pipeline } of RENDER_PIPELINES) {
    if (findPackage(packages, id)?.direct) return pipeline;
  }
  return BUILT_IN_PIPELINE;
}

/**
 * @param {PackageInfo[]} packages
 * @returns {Array<{ id: string, name: string, version: string | null }>}
 */
export function getNotablePackages(packages) {
  return NOTABLE_PACKAGES.flatMap(({ id, name }) => {
    const found = findPackage(packages, id);
    return found ? [{ id, name, version: found.version }] : [];
  }).slice(0, MAX_NOTABLE_PACKAGES);
}

/**
 * @param {PackageInfo[]} packages
 * @returns {string | null} The first IDE package present, in allow-list order.
 */
export function findIdePackage(packages) {
  return IDE_PACKAGE_IDS.find((id) => findPackage(packages, id)) ?? null;
}

/**
 * Counts first-party source files that use each library.
 * @returns {{ add: (text: string) => void, result: (packages: PackageInfo[]) => Array<{ name: string, package: boolean, files: number }> }}
 */
export function createLibraryUsageCollector() {
  const counts = new Map(LIBRARIES.map((library) => [library.name, 0]));
  return {
    add(text) {
      for (const library of LIBRARIES) {
        if (library.usage.test(text)) counts.set(library.name, (counts.get(library.name) ?? 0) + 1);
      }
    },
    result(packages) {
      return LIBRARIES.flatMap((library) => {
        const files = counts.get(library.name) ?? 0;
        const hasPackage = library.packageIds.some((id) => findPackage(packages, id)?.direct);
        return hasPackage || files > 0 ? [{ name: library.name, package: hasPackage, files }] : [];
      });
    },
  };
}

/**
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function extractSemver(value) {
  if (typeof value !== 'string') return null;
  const plain = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(value.trim());
  if (plain) return plain[1];
  const tag = /#v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(value.trim());
  return tag ? tag[1] : null;
}

/**
 * @param {unknown} document
 * @returns {Map<string, string>} Package id -> manifest value, or lock `version`.
 */
function readDependencyMap(document) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const dependencies = isRecord(document) ? document.dependencies : undefined;
  if (!isRecord(dependencies)) return map;
  for (const [id, value] of Object.entries(dependencies)) {
    if (typeof value === 'string') map.set(id, value);
    else if (isRecord(value) && typeof value.version === 'string') map.set(id, value.version);
  }
  return map;
}

/**
 * Embedded packages are folders directly under `Packages/` with a `package.json`.
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @param {import('./walk.js').ProjectIndex} index
 * @param {string[]} warnings
 * @returns {Map<string, { version: string | null, folder: string }>}
 */
function readEmbeddedPackages(view, root, index, warnings) {
  /** @type {Map<string, { version: string | null, folder: string }>} */
  const embedded = new Map();
  for (const file of index.files) {
    const match = /^Packages\/([^/]+)\/package\.json$/.exec(file);
    if (!match) continue;
    const document = readJson(view, joinProjectPath(root, file), { maxBytes: JSON_MAX_BYTES });
    const name = isRecord(document.value) && typeof document.value.name === 'string' ? document.value.name : null;
    if (!name) {
      warnings.push(`${file} has no package name`);
      continue;
    }
    const version = isRecord(document.value) && typeof document.value.version === 'string' ? document.value.version : null;
    embedded.set(name, { version, folder: `Packages/${match[1]}` });
  }
  return embedded;
}

/**
 * @param {Map<string, string>} direct
 * @param {Map<string, string>} locked
 * @param {Map<string, { version: string | null, folder: string }>} embedded
 * @returns {PackageInfo[]}
 */
function mergePackages(direct, locked, embedded) {
  const ids = new Set([...direct.keys(), ...locked.keys(), ...embedded.keys()]);
  return [...ids].sort(compareOrdinal).map((id) => {
    const embeddedPackage = embedded.get(id);
    const reference = direct.get(id) ?? locked.get(id) ?? null;
    const version = extractSemver(embeddedPackage?.version) ?? extractSemver(locked.get(id)) ?? extractSemver(direct.get(id));
    return {
      id,
      version,
      reference,
      direct: direct.has(id) || Boolean(embeddedPackage),
      embedded: Boolean(embeddedPackage),
      folder: embeddedPackage?.folder ?? null,
    };
  });
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
