// The Windows Terminal fragment of spec 13.5: one profile per initialized project, in a file of our own
// under Microsoft's fragment directory. `settings.json` is never opened, let alone written - a fragment
// is the documented way to add profiles without touching the user's settings, and it is the reason this
// step can be reverted by deleting a single file.
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { findExecutable } from '../core/exec.js';
import { sha256File, sha256Hex } from '../core/hash.js';
import { getPathApi } from '../core/paths.js';
import { readProjectsIndex } from '../project/local.js';
import { entriesOfKind, loadManifest, saveManifest, upsertEntry } from './manifest.js';

export const FRAGMENT_TEMPLATE_URL = new URL('../../templates/terminal/fragment.json.tpl', import.meta.url);

/** Fixed namespace for the v5 profile GUIDs, so the same project always gets the same profile. */
export const PROFILE_NAMESPACE = 'f65ddb7e-706b-4499-8a50-40313caf510a';

export const FRAGMENT_APP_NAME = 'opencode-unity';
export const FRAGMENT_FILE_NAME = 'profiles.json';
export const PROFILE_NAME_PREFIX = 'Unity local LLM';

/**
 * @typedef {object} ProjectRegistryEntry
 * @property {string} id
 * @property {string} name
 * @property {string} path
 */

/**
 * `%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\opencode-unity\profiles.json`.
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, homedir?: string }} [context]
 * @returns {string | null} Null off Windows, where there is no fragment directory.
 */
export function resolveFragmentPath({ env = process.env, platform = process.platform, homedir = '' } = {}) {
  if (platform !== 'win32') return null;
  const api = getPathApi(platform);
  const localAppData = nonEmpty(env.LOCALAPPDATA) ?? (homedir ? api.join(homedir, 'AppData', 'Local') : null);
  if (!localAppData) return null;
  return api.join(localAppData, 'Microsoft', 'Windows Terminal', 'Fragments', FRAGMENT_APP_NAME, FRAGMENT_FILE_NAME);
}

/**
 * The launcher a profile starts. Windows Terminal runs `commandline` through the normal command-line
 * parser, so the shim is the right target here even though our own process runner refuses batch files.
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, cliName?: string }} [context]
 * @returns {string | null}
 */
export function resolveLauncherPath({ env = process.env, platform = process.platform, cliName = 'opencode-unity' } = {}) {
  return findExecutable(cliName, { env, platform });
}

/**
 * RFC 4122 version 5 (SHA-1) UUID. Same namespace plus same name means the same GUID on every machine,
 * which is what keeps a re-run from adding a second profile for one project.
 * @param {string} namespace  Canonical UUID text.
 * @param {string} name
 * @returns {string}
 */
export function uuidV5(namespace, name) {
  const hex = namespace.replaceAll('-', '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new TypeError(`'${namespace}' is not a UUID`);
  const digest = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(hex, 'hex'), Buffer.from(name, 'utf8')])).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const text = bytes.toString('hex');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/**
 * @param {ProjectRegistryEntry} project
 * @param {{ launcherPath: string }} options
 * @returns {{ guid: string, name: string, commandline: string, startingDirectory: string }}
 */
export function buildProfile(project, { launcherPath }) {
  return {
    guid: `{${uuidV5(PROFILE_NAMESPACE, `${FRAGMENT_APP_NAME}:${project.id}`)}}`,
    name: `${PROFILE_NAME_PREFIX} - ${project.name}`,
    commandline: `"${launcherPath}" start --project "${project.path}"`,
    startingDirectory: project.path,
  };
}

/**
 * @param {readonly ProjectRegistryEntry[]} projects
 * @param {{ launcherPath: string, template?: string }} options
 * @returns {string} UTF-8 text with no byte-order mark, which Windows Terminal requires.
 */
export function renderFragment(projects, { launcherPath, template = readFragmentTemplate() }) {
  const profiles = projects.map((project) => buildProfile(project, { launcherPath }));
  const body = JSON.stringify(profiles, null, 2).split('\n').join('\n  ');
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    if (key !== 'profiles') throw new TypeError(`The fragment template uses {{${key}}}, which the renderer does not supply`);
    return body;
  });
  const text = rendered.endsWith('\n') ? rendered : `${rendered}\n`;
  if (text.charCodeAt(0) === 0xfeff) throw new TypeError('The rendered fragment must not start with a byte-order mark');
  return text;
}

/**
 * Keeps the fragment at one profile per initialized project (spec 13.5) once `init` has changed the
 * project list: setup writes the fragment before the documented `cd <project>`, `init`, `start`, so
 * without this it would stay empty. It follows the rule `upgrade` follows (14.3 step 5): only a fragment
 * the manifest records, and only while the file is still exactly what was recorded. An edited fragment
 * is left alone and named, with the command that refreshes it.
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {NodeJS.Platform} input.platform
 * @param {{ installManifest: string, projectsIndex: string }} input.paths
 * @param {{ readDigest?: (file: string) => Promise<string | null>, writeText?: (file: string, text: string) => Promise<void>, locateLauncher?: typeof resolveLauncherPath }} [input.io]
 * @returns {Promise<{ updated: string[], warnings: string[] }>}
 */
export async function refreshFragment({ env, platform, paths, io = {} }) {
  const { readDigest = readFileDigest, writeText = (file, text) => fs.writeFile(file, text, 'utf8'), locateLauncher = resolveLauncherPath } = io;
  /** @type {{ updated: string[], warnings: string[] }} */
  const result = { updated: [], warnings: [] };
  if (platform !== 'win32') return result;
  /** @type {import('./manifest.js').Manifest | null} */
  let manifest;
  try {
    ({ manifest } = await loadManifest(paths.installManifest));
  } catch {
    // An unreadable manifest is doctor's and uninstall's to report; the fragment is not worth failing init.
    return result;
  }
  const fragments = manifest === null ? [] : entriesOfKind(manifest, 'wtFragment');
  if (manifest === null || fragments.length === 0) return result;

  const refreshHint = "run 'opencode-unity setup' to refresh it";
  const launcherPath = locateLauncher({ env, platform });
  if (launcherPath === null) {
    result.warnings.push(`The Windows Terminal profiles were not refreshed because opencode-unity is not on PATH; ${refreshHint}.`);
    return result;
  }
  const { projects } = await readProjectsIndex(paths.projectsIndex);
  const text = renderFragment(usableProjects(projects), { launcherPath });
  const digest = sha256Hex(text);
  let next = manifest;
  for (const entry of fragments) {
    const target = /** @type {string} */ (entry.path);
    const current = await readDigest(target);
    if (current === digest) continue;
    if (current !== entry.sha256) {
      result.warnings.push(`${target} changed since setup wrote it, so its profile list was left as it is; ${refreshHint}.`);
      continue;
    }
    await writeText(target, text);
    next = upsertEntry(next, { ...entry, sha256: digest });
    result.updated.push(target);
  }
  if (result.updated.length > 0) await saveManifest(paths.installManifest, next);
  return result;
}

/**
 * @param {string} file
 * @returns {Promise<string | null>} Null when the file is gone.
 */
async function readFileDigest(file) {
  try {
    return await sha256File(file);
  } catch {
    return null;
  }
}

/**
 * @returns {string}
 */
export function readFragmentTemplate() {
  return fsSync.readFileSync(FRAGMENT_TEMPLATE_URL, 'utf8');
}

/**
 * A registry entry with an empty path cannot start anything, so it gets no profile. `init` owns the
 * registry; this is the only thing the fragment needs from it.
 * @param {readonly ProjectRegistryEntry[]} projects
 * @returns {ProjectRegistryEntry[]}
 */
export function usableProjects(projects) {
  return projects.filter((project) => project.id !== '' && project.name !== '' && project.path !== '');
}

/**
 * @param {string | undefined} value
 * @returns {string | null}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
