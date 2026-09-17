// One read-only pass over a Unity project (spec 9). Every source file is read once and fed to the detectors,
// so a scan is deterministic and bounded.
import { buildCompileMap } from '../facts/compile-map.js';
import { compareOrdinal, joinProjectPath } from './fs-view.js';
import { detectAssemblies, findOwningAssembly } from './assemblies.js';
import { countInputActionAssets, createInputUsageCollector, readActiveInputHandler, summarizeInput } from './input.js';
import { detectInstructionFiles, hasOpencodeDir } from './instructions.js';
import { detectHubUrl, detectMcpForUnity, getExpectedInstanceId, MCP_TESTED_VERSION } from './mcp.js';
import {
  createNamingCollector,
  isGeneratedSource,
  MAX_NAMING_FILE_BYTES,
  parseEditorconfigNaming,
  selectNamingSample,
} from './naming.js';
import { createLibraryUsageCollector, detectPackages } from './packages.js';
import { detectProjectFiles, findStaleness } from './project-files.js';
import { getProjectName, requireUnityProjectRoot } from './root.js';
import { summarizeTests } from './tests.js';
import { countUiDocuments, createUiCollector, summarizeUi } from './ui.js';
import { detectVcs } from './vcs.js';
import { detectUnityVersion } from './version.js';
import { extensionOf, parentOf, walkProject } from './walk.js';

export const LARGE_FILE_LINES = 1500;
export const MAX_LARGE_FILES = 5;
export const EDITORCONFIG_FILE = '.editorconfig';

const CODE_MAX_BYTES = 1024 * 1024;

// Folders whose code is not written by the team, so they must not set the project's conventions.
const THIRD_PARTY_SEGMENTS = new Set(['plugins', 'thirdparty', 'third party', 'textmesh pro', 'samples']);

/**
 * @typedef {object} ScanOptions
 * @property {Record<string, string | undefined>} [env]   Used for the VCS and hub-URL lookups.
 * @property {string[] | null} [dotnetSdks]               Result of `dotnet --list-sdks`, when the caller ran it.
 * @property {number} [maxWalkEntries]
 */

/**
 * @typedef {object} ScanResult
 * @property {string} root         Absolute; machine data that never reaches project.json.
 * @property {string} projectName
 * @property {import('./version.js').UnityVersionFact} unity
 * @property {{ entryCount: number, truncated: boolean }} walk
 * @property {import('./packages.js').PackagesFact} packages
 * @property {Array<{ name: string, package: boolean, files: number }>} librariesInUse
 * @property {import('./assemblies.js').AssembliesFact} assemblies
 * @property {import('./tests.js').TestsFact} tests
 * @property {import('../facts/compile-map.js').CompileRow[]} compileMap
 * @property {import('./project-files.js').ProjectFilesFact} projectFiles
 * @property {import('./project-files.js').StalenessFact} staleness
 * @property {{ checked: boolean, present: boolean, sdks: string[] }} dotnet
 * @property {import('./ui.js').UiFact} ui
 * @property {import('./input.js').InputFact} input
 * @property {import('./vcs.js').VcsFact} vcs
 * @property {import('./mcp.js').McpFact} mcp
 * @property {import('./naming.js').NamingFact} naming
 * @property {Array<{ path: string, lines: number, truncated: boolean }>} largeFiles
 * @property {import('./instructions.js').InstructionFile[]} instructionFiles
 * @property {boolean} opencodeDir
 * @property {{ files: number, firstParty: number, namingSample: number }} sources
 * @property {ScanLocalFacts} local
 * @property {string[]} warnings
 */

/**
 * @typedef {object} ScanLocalFacts
 * @property {string} projectPath
 * @property {string} expectedInstanceId
 * @property {string} dataPath
 * @property {string} hubUrl
 * @property {'opencode-config' | 'package-default'} hubUrlSource
 * @property {string | null} hubConfigPath
 * @property {boolean} hubLoopback
 * @property {string} editorWindowTitlePrefix
 */

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} startPath  Any path inside the project.
 * @param {ScanOptions} [options]
 * @returns {ScanResult}
 */
export function scanUnityProject(view, startPath, { env = {}, dotnetSdks = null, maxWalkEntries } = {}) {
  const root = requireUnityProjectRoot(view, startPath);
  const index = walkProject(view, root, maxWalkEntries === undefined ? {} : { maxEntries: maxWalkEntries });
  /** @type {string[]} */
  const warnings = [];
  if (index.truncated) warnings.push(`the project has more than ${index.entryCount} files; the scan stopped early`);

  const unity = detectUnityVersion(view, root);
  warnings.push(...unity.warnings);

  const packages = detectPackages(view, root, index);
  warnings.push(...packages.warnings);

  const assemblies = detectAssemblies(view, root, index);
  warnings.push(...assemblies.warnings);

  const projectFiles = detectProjectFiles(view, root, { packages: packages.packages });
  warnings.push(...projectFiles.warnings);

  const sourceFiles = index.files.filter((file) => extensionOf(file) === '.cs');
  const compileMap = buildCompileMap({
    definitions: assemblies.definitions,
    references: assemblies.references,
    sourceFiles,
    csprojNames: projectFiles.csproj.map((file) => file.name),
  });
  warnings.push(...compileMap.warnings);

  const survey = surveySources(view, root, index, sourceFiles, assemblies.definitions);
  const naming = survey.naming.result({ editorconfig: readEditorconfigNaming(view, root) });

  const vcs = detectVcs(view, root, { env });
  const activeInputHandler = readActiveInputHandler(view, root);
  const instance = getExpectedInstanceId(root);
  const hub = detectHubUrl(view, { env });
  const projectName = getProjectName(root);
  const mcp = detectMcpForUnity(packages.packages);
  const opencodeDir = hasOpencodeDir(view, root);
  if (opencodeDir) {
    warnings.push('the project has an .opencode folder; OpenCode writes a .gitignore and installs node_modules there at every start');
  }
  if (mcp.present && !mcp.testedVersion) {
    warnings.push(`MCP for Unity ${mcp.version ?? 'of an unknown version'} is installed; only ${MCP_TESTED_VERSION} was tested`);
  }

  return {
    root,
    projectName,
    unity,
    walk: { entryCount: index.entryCount, truncated: index.truncated },
    packages,
    librariesInUse: survey.libraries.result(packages.packages),
    assemblies,
    tests: summarizeTests(assemblies.definitions, packages.packages),
    compileMap: compileMap.rows,
    projectFiles,
    staleness: findStaleness({ projectFiles, compileMap: compileMap.rows, definitions: assemblies.definitions, sourceFiles }),
    dotnet: { checked: dotnetSdks !== null, present: (dotnetSdks ?? []).length > 0, sdks: dotnetSdks ?? [] },
    ui: summarizeUi({ ...survey.ui.counts(), ...countUiDocuments(index.files) }),
    input: summarizeInput({
      activeInputHandler: activeInputHandler.value,
      packages: packages.packages,
      inputActions: countInputActionAssets(index.files),
      ...survey.inputUsage.counts(),
    }),
    vcs,
    mcp,
    naming,
    largeFiles: survey.largeFiles,
    instructionFiles: detectInstructionFiles(view, root, index, { maxDepth: vcs.kind === 'git' ? vcs.depth : null }),
    opencodeDir,
    sources: { files: sourceFiles.length, firstParty: survey.firstPartyCount, namingSample: naming.files },
    local: {
      projectPath: root,
      expectedInstanceId: instance.id,
      dataPath: instance.dataPath,
      hubUrl: hub.url,
      hubUrlSource: hub.source,
      hubConfigPath: hub.configPath,
      hubLoopback: hub.loopback,
      // The Unity Editor window title starts with the project name, which the guard uses to tell editors apart.
      editorWindowTitlePrefix: `${projectName} - `,
    },
    warnings,
  };
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @returns {import('./naming.js').EditorconfigNaming | null}
 */
export function readEditorconfigNaming(view, root) {
  const read = view.readText(joinProjectPath(root, EDITORCONFIG_FILE), { maxBytes: 256 * 1024 });
  if (!read) return null;
  const naming = parseEditorconfigNaming(read.text);
  return Object.keys(naming).length > 0 ? naming : null;
}

/**
 * Scripts written by the team: under `Assets/`, outside third-party folders and outside embedded packages.
 * @param {string} relativePath
 * @param {string[]} packageFolders  Lower-case folder prefixes that contain a `package.json`.
 * @returns {boolean}
 */
export function isFirstPartySource(relativePath, packageFolders) {
  if (!relativePath.startsWith('Assets/')) return false;
  const folders = relativePath.split('/').slice(0, -1);
  if (folders.some((segment) => THIRD_PARTY_SEGMENTS.has(segment.toLowerCase()))) return false;
  const lower = relativePath.toLowerCase();
  return !packageFolders.some((prefix) => lower.startsWith(prefix));
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @param {import('./walk.js').ProjectIndex} index
 * @param {string[]} sourceFiles
 * @param {import('./assemblies.js').AsmdefRecord[]} definitions
 */
function surveySources(view, root, index, sourceFiles, definitions) {
  const packageFolders = index.files
    .filter((file) => file.endsWith('/package.json'))
    .map((file) => `${parentOf(file).toLowerCase()}/`);
  const firstParty = sourceFiles.filter((file) => isFirstPartySource(file, packageFolders));
  const namingCandidates = firstParty.filter((file) => {
    const owner = findOwningAssembly(definitions, file);
    return !owner?.name.startsWith('Unity.');
  });
  const namingSample = new Set(selectNamingSample(namingCandidates));

  const ui = createUiCollector();
  const inputUsage = createInputUsageCollector();
  const libraries = createLibraryUsageCollector();
  const naming = createNamingCollector();
  /** @type {Array<{ path: string, lines: number, truncated: boolean }>} */
  const largeFiles = [];

  for (const file of firstParty) {
    const read = view.readText(joinProjectPath(root, file), { maxBytes: CODE_MAX_BYTES });
    if (!read) continue;
    ui.add(file, read.text);
    inputUsage.add(read.text);
    libraries.add(read.text);
    const lines = countLines(read.text);
    if (lines > LARGE_FILE_LINES || read.truncated) largeFiles.push({ path: file, lines, truncated: read.truncated });
    if (namingSample.has(file) && !read.truncated && read.size <= MAX_NAMING_FILE_BYTES && !isGeneratedSource(read.text)) {
      naming.add(file, read.text);
    }
  }

  largeFiles.sort((a, b) => b.lines - a.lines || compareOrdinal(a.path, b.path));
  return { ui, inputUsage, libraries, naming, largeFiles: largeFiles.slice(0, MAX_LARGE_FILES), firstPartyCount: firstParty.length };
}

/**
 * @param {string} text
 * @returns {number}
 */
function countLines(text) {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') lines += 1;
  }
  return text.endsWith('\n') ? lines - 1 : lines;
}
