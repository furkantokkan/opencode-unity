// facts.md and project.json (spec 9.6, 6.4). facts.md is capped at 1,600 characters; when it is too long,
// detail is dropped in a fixed order so the same project always renders the same text.
import fs from 'node:fs';
import { compileSchema } from '../../plugin/opencode-unity-lib/json-schema.js';
import { CLI_VERSION } from '../cli/version.js';
import { BUILT_IN_PIPELINE } from '../unity/packages.js';
import { MIN_NAMING_SAMPLE, STYLE_LABELS } from '../unity/naming.js';
import { getCompileCommand } from './compile-map.js';
import { FACTS_GENERATOR_VERSION } from './stale.js';
import { getVcsRules, renderVcsFactsClause } from './vcs-rules.js';

export const FACTS_CAP = 1600;
export const MAX_COMPILE_ROWS = 8;
export const MAX_TEST_ASSEMBLIES = 4;
export const PROJECT_SCHEMA_VERSION = 1;
export const FACTS_TEMPLATE_URL = new URL('../../templates/facts/facts.md.tpl', import.meta.url);
export const PROJECT_SCHEMA_URL = new URL('../../schema/project.schema.json', import.meta.url);

/** Packages worth naming next to the libraries in use; the others have their own facts line. */
const IN_USE_PACKAGE_IDS = new Set([
  'com.unity.addressables',
  'com.unity.cinemachine',
  'com.unity.netcode.gameobjects',
  'com.unity.netcode',
  'com.unity.entities',
  'com.unity.localization',
]);

const MAX_IN_USE_NAMES = 8;

/** Drop order from spec 9.6. */
const DROP_STEPS = Object.freeze([
  { key: 'largeFiles', label: 'large files' },
  { key: 'libraries', label: 'libraries' },
  { key: 'namingDetails', label: 'naming details' },
  { key: 'uiCounts', label: 'UI counts' },
]);

/**
 * @returns {string}
 */
export function loadFactsTemplate() {
  return fs.readFileSync(FACTS_TEMPLATE_URL, 'utf8');
}

/**
 * @returns {Record<string, any>}
 */
export function readProjectSchema() {
  return JSON.parse(fs.readFileSync(PROJECT_SCHEMA_URL, 'utf8'));
}

/** @type {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaValidator | undefined} */
let projectValidator;

/**
 * @param {unknown} value
 * @returns {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaError[]}
 */
export function validateProjectJson(value) {
  projectValidator ??= compileSchema(readProjectSchema());
  return projectValidator(value);
}

/**
 * @typedef {object} FactsRender
 * @property {string} text
 * @property {number} length
 * @property {string[]} dropped     What was left out to fit the cap.
 * @property {boolean} truncated    True only when even the reduced text had to be cut.
 */

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @param {object} [options]
 * @param {string} [options.version]      Generator version printed in the header.
 * @param {boolean} [options.editorAgent] Add the `/ue` line.
 * @param {string} [options.template]
 * @param {number} [options.cap]
 * @returns {FactsRender}
 */
export function renderFacts(scan, { version = CLI_VERSION, editorAgent = false, template = loadFactsTemplate(), cap = FACTS_CAP } = {}) {
  const detail = { largeFiles: true, libraries: true, namingDetails: true, uiCounts: true, compileRows: MAX_COMPILE_ROWS };
  /** @type {string[]} */
  const dropped = [];
  let step = 0;
  let text = fill(template, version, buildLines(scan, detail, editorAgent));

  while (text.length > cap) {
    if (step < DROP_STEPS.length) {
      const { key, label } = DROP_STEPS[step];
      step += 1;
      Object.assign(detail, { [key]: false });
      dropped.push(label);
    } else if (detail.compileRows > 1) {
      detail.compileRows -= 1;
      if (!dropped.includes('compile map rows')) dropped.push('compile map rows');
    } else {
      break;
    }
    text = fill(template, version, buildLines(scan, detail, editorAgent));
  }

  if (text.length > cap) {
    text = cutToCap(text, cap);
    return { text, length: text.length, dropped, truncated: true };
  }
  return { text, length: text.length, dropped, truncated: false };
}

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @param {object} options
 * @param {string} [options.version]
 * @param {string} [options.inputsHash]
 * @returns {Record<string, any>}
 */
export function buildProjectJson(scan, { version = CLI_VERSION, inputsHash = '' } = {}) {
  const vcs = getVcsRules(scan.vcs.kind);
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    generator: { name: 'opencode-unity', version, factsVersion: FACTS_GENERATOR_VERSION },
    unity: { version: scan.unity.editorVersion, stream: scan.unity.stream, support: scan.unity.support, pipeline: scan.packages.pipeline },
    projectFiles: {
      idePackage: scan.projectFiles.idePackage,
      csprojCount: scan.projectFiles.csproj.length,
      solutionCount: scan.projectFiles.solutions.length,
      stale: scan.staleness.stale,
      staleCount: scan.staleness.count,
      staleExamples: scan.staleness.examples,
    },
    assemblies: scan.assemblies.definitions.map((definition) => ({
      name: definition.name,
      folder: definition.folder,
      csproj: definition.csproj,
      platforms: definition.includePlatforms,
      isTest: definition.isTest,
      testMode: definition.testMode,
    })),
    compileMap: scan.compileMap.map((row) => ({
      prefix: row.prefix,
      assembly: row.assembly,
      csproj: row.csproj,
      command: row.command,
      source: row.source,
      generated: row.generated,
    })),
    tests: {
      assemblies: scan.tests.assemblies,
      testFramework: scan.tests.testFramework,
    },
    ui: scan.ui,
    input: scan.input,
    packagesNotable: scan.packages.notable,
    librariesInUse: scan.librariesInUse,
    vcs: { kind: vcs.kind, readOnlyAllow: vcs.readOnlyAllow, writeDeny: vcs.writeDeny, experimental: vcs.experimental },
    mcpForUnity: {
      present: scan.mcp.present,
      version: scan.mcp.version,
      testedVersion: scan.mcp.testedVersion,
      hubUrlSource: scan.local.hubUrlSource,
    },
    naming: scan.naming,
    largeFiles: scan.largeFiles.map((file) => ({ path: file.path, lines: file.lines })),
    instructionFiles: scan.instructionFiles,
    opencodeDir: scan.opencodeDir,
    sources: scan.sources,
    inputsHash,
  };
}

/**
 * @param {string} template
 * @param {string} version
 * @param {string[]} lines
 * @returns {string}
 */
function fill(template, version, lines) {
  return template.replace('{{version}}', version).replace('{{body}}', lines.join('\n'));
}

/**
 * @param {string} text
 * @param {number} cap
 * @returns {string} The text cut at a line boundary.
 */
function cutToCap(text, cap) {
  const cut = text.slice(0, cap);
  const lastNewline = cut.lastIndexOf('\n');
  return lastNewline > 0 ? `${cut.slice(0, lastNewline)}\n` : cut;
}

/**
 * @typedef {object} FactsDetail
 * @property {boolean} largeFiles
 * @property {boolean} libraries
 * @property {boolean} namingDetails
 * @property {boolean} uiCounts
 * @property {number} compileRows
 */

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @param {FactsDetail} detail
 * @param {boolean} editorAgent
 * @returns {string[]}
 */
function buildLines(scan, detail, editorAgent) {
  /** @type {string[]} */
  const lines = [renderUnityLine(scan), renderTestsLine(scan), ...renderCompileLines(scan, detail.compileRows)];
  if (scan.staleness.stale) lines.push(renderStaleLine(scan));
  lines.push(renderUiLine(scan, detail.uiCounts), renderInputLine(scan));
  const libraries = detail.libraries ? renderLibrariesLine(scan) : null;
  if (libraries) lines.push(libraries);
  lines.push(renderNamingLine(scan, detail.namingDetails));
  const largeFiles = detail.largeFiles ? renderLargeFilesLine(scan) : null;
  if (largeFiles) lines.push(largeFiles);
  if (editorAgent) lines.push('- Editor checks: /ue <goal> (console, refresh, EditMode tests).');
  return lines;
}

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @returns {string}
 */
function renderUnityLine(scan) {
  const version = scan.unity.stream ? `Unity ${scan.unity.stream}` : 'Unity version unknown';
  const support = scan.unity.support === 'experimental' || scan.unity.support === 'unsupported' ? ` (${scan.unity.support})` : '';
  const pipeline = scan.packages.pipeline === BUILT_IN_PIPELINE ? 'built-in render pipeline' : scan.packages.pipeline;
  return `- ${version}${support}, ${pipeline}. VCS: ${renderVcsFactsClause(scan.vcs.kind)}.`;
}

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @returns {string}
 */
function renderTestsLine(scan) {
  const assemblies = scan.tests.assemblies;
  if (assemblies.length === 0) return '- Tests: no test assemblies found; do not invent test projects.';
  const shown = assemblies.slice(0, MAX_TEST_ASSEMBLIES).map((assembly) => `${assembly.mode} ${assembly.name} (${assembly.folder})`);
  const more = assemblies.length > shown.length ? ` (+${assemblies.length - shown.length} more)` : '';
  return `- Tests: ${shown.join('; ')}.${more}`;
}

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @param {number} maxRows
 * @returns {string[]}
 */
function renderCompileLines(scan, maxRows) {
  if (scan.dotnet.checked && !scan.dotnet.present) {
    return ['- Compile check unavailable: no .NET SDK was found (dotnet --list-sdks is empty).'];
  }
  if (!scan.projectFiles.generated) {
    return [
      '- Compile check unavailable: no .csproj files yet. Ask the user to regenerate project files in Unity (Preferences > External Tools).',
    ];
  }
  const rows = scan.compileMap.filter((row) => row.source !== 'default');
  const other = scan.compileMap.find((row) => row.source === 'default');
  const shown = rows.slice(0, maxRows);
  const lines = [`- Compile check by folder (${getCompileCommand('<csproj>')}):`];
  for (const row of shown) lines.push(`  ${row.prefix} -> ${row.csproj}${row.generated ? '' : ' (not generated)'}`);
  if (rows.length > shown.length) lines.push(`  (+${rows.length - shown.length} more folders; ask before compiling outside the ones listed)`);
  if (other) lines.push(`  other -> ${other.csproj}${other.generated ? '' : ' (not generated)'}`);
  lines.push('- New, renamed or deleted .cs files are not in any .csproj until Unity regenerates project files.');
  return lines;
}

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @returns {string}
 */
function renderStaleLine(scan) {
  const example = scan.staleness.examples[0];
  const detail = example ? `, for example ${example}` : '';
  return `- Stale project files: ${scan.staleness.count} scripts or assemblies are in no .csproj${detail}. Say so instead of trusting a build.`;
}

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @param {boolean} withCounts
 * @returns {string}
 */
function renderUiLine(scan, withCounts) {
  const follow = 'Follow the screen you edit; ask before a new screen.';
  if (scan.ui.verdict === 'none') return '- UI: none detected. Ask before adding UI.';
  if (!withCounts) return `- UI: ${scan.ui.verdict}. ${follow}`;
  const parts = [];
  if (scan.ui.uguiScripts > 0) parts.push(`uGUI (${countOf(scan.ui.uguiScripts, 'script')})`);
  if (scan.ui.uxml > 0 || scan.ui.uiToolkitScripts > 0) {
    const detail = scan.ui.uxml > 0 ? `${formatNumber(scan.ui.uxml)} .uxml` : countOf(scan.ui.uiToolkitScripts, 'script');
    parts.push(`UI Toolkit (${detail})`);
  }
  return `- UI: ${parts.join(', ')}. ${follow}`;
}

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @returns {string}
 */
function renderInputLine(scan) {
  const handler = scan.input.activeInputHandler;
  if (handler === 1) return '- Input: Input System only (activeInputHandler 1). Never use UnityEngine.Input.';
  if (handler === 0) return '- Input: legacy Input Manager only (activeInputHandler 0). Do not use the Input System package.';
  if (handler === 2) return '- Input: both systems enabled (activeInputHandler 2). Follow the file you edit.';
  return '- Input: not detected in ProjectSettings. Follow the file you edit.';
}

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @returns {string | null}
 */
function renderLibrariesLine(scan) {
  const names = [
    ...scan.librariesInUse.map((library) => library.name),
    ...scan.packages.notable.filter((item) => IN_USE_PACKAGE_IDS.has(item.id)).map((item) => item.name),
  ].slice(0, MAX_IN_USE_NAMES);
  return names.length > 0 ? `- In use: ${names.join(', ')}. Do not add packages.` : null;
}

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @param {boolean} withDetails
 * @returns {string}
 */
function renderNamingLine(scan, withDetails) {
  const fields = describeCategory(scan.naming.categories.privateInstance, withDetails);
  const constants = describeCategory(scan.naming.categories.constants, withDetails);
  const source = scan.naming.categories.privateInstance.source === 'editorconfig' ? ' (.editorconfig)' : '';
  if (!fields && !constants) return '- Naming: match the file you edit.';
  const parts = [fields ? `private fields ${fields}` : null, constants ? `constants ${constants}` : null].filter(Boolean);
  return `- Naming: match the file. New files${source}: ${parts.join(', ')}.`;
}

/**
 * @param {import('../unity/naming.js').CategorySummary} category
 * @param {boolean} withDetails
 * @returns {string | null}
 */
function describeCategory(category, withDetails) {
  // Below the minimum sample there is no measurement to report, so the line says nothing about the category.
  if (category.dominant === 'mixed') return category.sampleSize >= MIN_NAMING_SAMPLE ? 'mixed' : null;
  const label = STYLE_LABELS[category.dominant] ?? category.dominant;
  if (!withDetails || category.source === 'editorconfig') return label;
  return `${label} (${Math.round(category.share * 100)}% of ${formatNumber(category.sampleSize)})`;
}

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @returns {string | null}
 */
function renderLargeFilesLine(scan) {
  if (scan.largeFiles.length === 0) return null;
  const files = scan.largeFiles.map((file) => `${file.path} (${formatNumber(file.lines)}${file.truncated ? '+' : ''} lines)`);
  return `- Large files (read by range): ${files.join(', ')}.`;
}

/**
 * Thousands separators without a locale, so output is identical on every machine.
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * @param {number} value
 * @param {string} noun
 * @returns {string}
 */
function countOf(value, noun) {
  return `${formatNumber(value)} ${noun}${value === 1 ? '' : 's'}`;
}
