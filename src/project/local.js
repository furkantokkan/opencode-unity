// The two machine-local files `init` writes beside the shareable project facts (spec 6.1, 6.4):
//
//   <home>/projects/<id>/local.json   this machine's absolute path, hub URL, editor title prefix and the
//                                     editor agent's record (confirmed hub, PlayMode choice)
//   <home>/projects/index.json        the registry of initialized projects
//
// `project.json` and `facts.md` are shareable: relative paths only, no user name, no machine name
// (P19, P21). Everything that identifies this computer lives here instead, which is why these two
// files are never copied into a repository.
//
// The hub URL is spelled `hubUrl` at the top level. The plugin accepts the nested `mcpForUnity.hubUrl`
// spelling as well, but the product writes the flat one, matching spec 6.4's flat four-item list.
//
// Paths in `local.json` keep the platform's own separators (amendment 38.7, CP-D14): the file never
// leaves this machine, and every consumer hands its values straight to the filesystem.
import fs from 'node:fs/promises';
import path from 'node:path';
import { JsonParseError, parseJsonc, stringifyJson } from '../core/jsonc.js';

export const LOCAL_STATE_VERSION = 1;
export const PROJECTS_INDEX_VERSION = 1;

/**
 * @typedef {object} LocalState
 * @property {number} schemaVersion
 * @property {string} projectPath            Absolute, native separators.
 * @property {string} expectedInstanceId     MCP for Unity instance id derived from that path.
 * @property {string} dataPath               Where MCP for Unity keeps that instance's data.
 * @property {string} hubUrl
 * @property {'opencode-config' | 'package-default'} hubUrlSource
 * @property {string | null} hubConfigPath   Absolute path the URL was read from, when it was read.
 * @property {boolean} hubLoopback
 * @property {string} editorWindowTitlePrefix
 * @property {Record<string, unknown> | null} editor  The editor agent's record (`buildEditorLocalRecord` in
 *   `src/opencode/editor.js`): the confirmed hub and the PlayMode choice the plugin's policy reads.
 */

/**
 * @typedef {object} ProjectIndexEntry
 * @property {string} id
 * @property {string} name
 * @property {string} path
 * @property {string | null} lastStart   ISO timestamp of the last `start`, or null.
 * @property {number} factsVersion
 */

/**
 * @typedef {object} ProjectsIndex
 * @property {number} schemaVersion
 * @property {ProjectIndexEntry[]} projects   Sorted by id, so two equal states produce one file.
 */

/**
 * @param {import('../unity/scan.js').ScanResult} scan
 * @param {{ editor?: Record<string, unknown> | null }} [options]
 * @returns {LocalState}
 */
export function buildLocalState(scan, { editor = null } = {}) {
  const local = scan.local;
  return {
    schemaVersion: LOCAL_STATE_VERSION,
    projectPath: local.projectPath,
    expectedInstanceId: local.expectedInstanceId,
    dataPath: local.dataPath,
    hubUrl: local.hubUrl,
    hubUrlSource: local.hubUrlSource,
    hubConfigPath: local.hubConfigPath,
    hubLoopback: local.hubLoopback,
    editorWindowTitlePrefix: local.editorWindowTitlePrefix,
    editor,
  };
}

/**
 * Reads `local.json`. A missing file is not an error; a damaged one is, because silently starting a
 * session against a guessed hub URL is worse than stopping.
 * @param {string} localJsonPath
 * @param {{ readFile?: (file: string) => Promise<string> }} [options]
 * @returns {Promise<LocalState | null>}
 */
export async function readLocalState(localJsonPath, { readFile = readTextFile } = {}) {
  const text = await readOptionalText(localJsonPath, readFile);
  if (text === null) return null;
  const value = parseJsonc(text, localJsonPath);
  if (!isRecord(value)) throw new JsonParseError(`${localJsonPath} does not hold a JSON object`);
  return normalizeLocalState(value);
}

/**
 * @param {string} localJsonPath
 * @param {LocalState} state
 * @param {{ writeFile?: (file: string, text: string) => Promise<void> }} [options]
 * @returns {Promise<void>}
 */
export async function writeLocalState(localJsonPath, state, { writeFile = writeTextFile } = {}) {
  await fs.mkdir(path.dirname(localJsonPath), { recursive: true });
  await writeFile(localJsonPath, stringifyJson(state));
}

/**
 * Reads `projects/index.json`. A missing or damaged registry reads as empty: it is a convenience list,
 * and losing it must never stop a session.
 * @param {string} indexPath
 * @param {{ readFile?: (file: string) => Promise<string> }} [options]
 * @returns {Promise<ProjectsIndex>}
 */
export async function readProjectsIndex(indexPath, { readFile = readTextFile } = {}) {
  const empty = { schemaVersion: PROJECTS_INDEX_VERSION, projects: [] };
  const text = await readOptionalText(indexPath, readFile);
  if (text === null) return empty;
  let value;
  try {
    value = parseJsonc(text, indexPath);
  } catch {
    return empty;
  }
  if (!isRecord(value) || !Array.isArray(value.projects)) return empty;
  return {
    schemaVersion: PROJECTS_INDEX_VERSION,
    projects: sortEntries(value.projects.filter(isRecord).map(normalizeEntry).filter((entry) => entry !== null)),
  };
}

/**
 * Adds or replaces one project. Fields the caller leaves out keep the recorded value, so `start` can
 * set `lastStart` without knowing the facts version.
 * @param {ProjectsIndex} index
 * @param {{ id: string } & Partial<Omit<ProjectIndexEntry, 'id'>>} entry
 * @returns {ProjectsIndex}
 */
export function upsertProjectEntry(index, entry) {
  if (!entry?.id) throw new TypeError('A registry entry needs a project id');
  const previous = index.projects.find((candidate) => candidate.id === entry.id);
  /** @type {ProjectIndexEntry} */
  const merged = {
    id: entry.id,
    name: entry.name ?? previous?.name ?? entry.id,
    path: entry.path ?? previous?.path ?? '',
    lastStart: entry.lastStart === undefined ? previous?.lastStart ?? null : entry.lastStart,
    factsVersion: entry.factsVersion ?? previous?.factsVersion ?? 0,
  };
  return {
    schemaVersion: PROJECTS_INDEX_VERSION,
    projects: sortEntries([...index.projects.filter((candidate) => candidate.id !== entry.id), merged]),
  };
}

/**
 * @param {string} indexPath
 * @param {ProjectsIndex} index
 * @param {{ writeFile?: (file: string, text: string) => Promise<void> }} [options]
 * @returns {Promise<void>}
 */
export async function writeProjectsIndex(indexPath, index, { writeFile = writeTextFile } = {}) {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, stringifyJson(index));
}

/**
 * Records one project in the registry in a single read-modify-write.
 * @param {string} indexPath
 * @param {{ id: string } & Partial<Omit<ProjectIndexEntry, 'id'>>} entry
 * @param {{ readFile?: (file: string) => Promise<string>, writeFile?: (file: string, text: string) => Promise<void> }} [options]
 * @returns {Promise<ProjectsIndex>}
 */
export async function recordProject(indexPath, entry, options = {}) {
  const index = upsertProjectEntry(await readProjectsIndex(indexPath, options), entry);
  await writeProjectsIndex(indexPath, index, options);
  return index;
}

/**
 * @param {Record<string, unknown>} value
 * @returns {LocalState}
 */
function normalizeLocalState(value) {
  return {
    schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : LOCAL_STATE_VERSION,
    projectPath: readString(value.projectPath),
    expectedInstanceId: readString(value.expectedInstanceId),
    dataPath: readString(value.dataPath),
    hubUrl: readHubUrl(value),
    hubUrlSource: value.hubUrlSource === 'opencode-config' ? 'opencode-config' : 'package-default',
    hubConfigPath: typeof value.hubConfigPath === 'string' ? value.hubConfigPath : null,
    hubLoopback: value.hubLoopback !== false,
    editorWindowTitlePrefix: readString(value.editorWindowTitlePrefix),
    // Passed through as written: `src/opencode/editor.js` and the plugin each read the fields they need
    // and treat anything missing as the strictest answer.
    editor: isRecord(value.editor) ? value.editor : null,
  };
}

/**
 * The flat spelling is what this product writes; the nested one is read so a file written by an
 * earlier build still resolves (the plugin accepts both for the same reason).
 * @param {Record<string, unknown>} value
 * @returns {string}
 */
function readHubUrl(value) {
  if (typeof value.hubUrl === 'string' && value.hubUrl !== '') return value.hubUrl;
  const nested = isRecord(value.mcpForUnity) ? value.mcpForUnity.hubUrl : undefined;
  return typeof nested === 'string' ? nested : '';
}

/**
 * @param {Record<string, unknown>} value
 * @returns {ProjectIndexEntry | null}
 */
function normalizeEntry(value) {
  if (typeof value.id !== 'string' || value.id === '') return null;
  return {
    id: value.id,
    name: readString(value.name) || value.id,
    path: readString(value.path),
    lastStart: typeof value.lastStart === 'string' ? value.lastStart : null,
    factsVersion: typeof value.factsVersion === 'number' ? value.factsVersion : 0,
  };
}

/**
 * @param {ProjectIndexEntry[]} entries
 * @returns {ProjectIndexEntry[]}
 */
function sortEntries(entries) {
  return [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {string} file
 * @param {(file: string) => Promise<string>} readFile
 * @returns {Promise<string | null>}
 */
async function readOptionalText(file, readFile) {
  try {
    return await readFile(file);
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {string} file
 * @returns {Promise<string>}
 */
function readTextFile(file) {
  return fs.readFile(file, 'utf8');
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
function writeTextFile(file, text) {
  return fs.writeFile(file, text, 'utf8');
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
