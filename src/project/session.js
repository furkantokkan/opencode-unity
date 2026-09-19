// What every session command - `init`, `start`, `status`, `guard`, `warm`, `stop` - resolves before it
// does anything: the product home, `config.json`, the runtime profile, and (where a project is
// involved) the project root, its id and the files `init` wrote for it.
//
// It lives in one module because these six commands must agree. A `status` that reads a different
// profile than `start` launched with, or a `warm` that hashes a project id differently from `init`,
// would be worse than either being wrong on its own.
//
// Project identity folds case only when the volume is measured case-insensitive (CP-D13), and the
// measurement happens once per command, here.
import fs from 'node:fs/promises';
import { CliError, EXIT, usageError } from '../cli/exit-codes.js';
import { resolveProjectIdentity } from '../core/case-sensitivity.js';
import { DEFAULT_PROJECT_SETTINGS, loadConfig } from '../core/config.js';
import { getHomeDir, getHomePaths, getProjectId } from '../core/paths.js';
import { loadPreset } from '../core/presets.js';
import { buildRuntimeProfile } from '../core/profile.js';
import { checkFactsFreshness, getInputsHash } from '../facts/stale.js';
import { createNodeFsView } from '../unity/fs-view.js';
import { resolveWorkspaceProjectRoot, getWorkspaceInputsHash } from './workspace.js';
import { parseRuntimeProfile } from '../../plugin/opencode-unity-lib/runtime-profile.js';
import { readLocalState } from './local.js';

/**
 * @typedef {object} Session
 * @property {string} home
 * @property {ReturnType<typeof getHomePaths>} paths
 * @property {import('../core/config.js').Config} config
 * @property {Record<string, any>} configUser   What `config.json` itself sets, without defaults. A
 *   command that changes one setting writes this document back, so the file keeps holding only the
 *   user's own choices (spec 6.2).
 * @property {import('../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile} profile
 * @property {boolean} profileRendered          False when the values were computed in memory.
 * @property {string[]} warnings
 * @property {NodeJS.Platform} platform
 * @property {Record<string, string | undefined>} env
 * @property {string} cwd
 * @property {string} version
 */

/**
 * @typedef {object} ProjectContext
 * @property {string} root                      Absolute, native separators.
 * @property {string} id
 * @property {string} name
 * @property {boolean} caseInsensitive
 * @property {import('../core/paths.js').ProjectPaths} paths
 * @property {Record<string, any> | null} projectJson
 * @property {import('./local.js').LocalState | null} local
 * @property {import('../core/config.js').ProjectSettings} settings
 * @property {boolean} initialized              Both `project.json` and `facts.md` exist.
 * @property {{ stale: boolean, reason: string | null }} freshness
 */

/**
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @returns {Promise<Session>}
 */
export async function loadSession(cliContext) {
  const platform = cliContext.platform;
  const home = getHomeDir({ env: cliContext.env, platform });
  const paths = getHomePaths(home, { platform });
  const { config, user, warnings } = await loadConfig(paths.config, { platform });
  const loaded = await loadProfile({ paths, config, cliVersion: cliContext.version, home });
  return {
    home,
    paths,
    config,
    configUser: user,
    profile: loaded.profile,
    profileRendered: loaded.rendered,
    warnings: [...warnings, ...loaded.warnings],
    platform,
    env: cliContext.env,
    cwd: cliContext.cwd,
    version: cliContext.version,
  };
}

/**
 * The rendered runtime profile is the one source the plugin, the CLI and the delegate lane share (spec
 * 4.3). Before `setup` has run for this version it does not exist yet, so the same values are computed
 * from `config.json` and the preset and the caller is told which it got.
 * @param {{ paths: ReturnType<typeof getHomePaths>, config: import('../core/config.js').Config, cliVersion: string, home: string, readFile?: (file: string) => Promise<string> }} input
 * @returns {Promise<{ profile: import('../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile, rendered: boolean, warnings: string[] }>}
 */
export async function loadProfile({ paths, config, cliVersion, home, readFile = (file) => fs.readFile(file, 'utf8') }) {
  const profilePath = paths.profile(cliVersion).runtimeProfile;
  /** @type {string | undefined} */
  let text;
  try {
    text = await readFile(profilePath);
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code !== 'ENOENT') throw error;
  }
  if (text !== undefined) {
    const parsed = parseRuntimeProfile(text);
    if (parsed.ok) return { profile: parsed.profile, rendered: true, warnings: [] };
    throw new CliError(`The runtime profile at ${profilePath} is not usable: ${parsed.reason}`, {
      exitCode: EXIT.USAGE,
      code: 'profile_invalid',
      hint: "Run 'opencode-unity setup' to write it again, or 'opencode-unity doctor --profile'.",
    });
  }
  const built = buildRuntimeProfile({ config, preset: loadPreset(config.preset), cliVersion, home });
  return {
    profile: built.profile,
    rendered: false,
    warnings: [`There is no rendered profile at ${profilePath}; the values come from config.json and preset '${config.preset}'. Run 'opencode-unity setup'.`, ...built.warnings],
  };
}

/**
 * Resolves the project a command acts on: `--project`, then the positional path, then the working
 * directory. The Unity root above that path wins, so running the CLI from `Assets/Scripts` works.
 * @param {Session} session
 * @param {{ path?: string, view?: import('../unity/fs-view.js').FsView }} [options]
 * @returns {Promise<ProjectContext>}
 */
export async function resolveProject(session, { path: requested, view = createNodeFsView() } = {}) {
  const start = requested ?? session.cwd;
  const identity = resolveProjectIdentity(start, { platform: session.platform, cwd: session.cwd });
  const root = resolveWorkspaceProjectRoot(view, identity.absolutePath, { env: session.env, explicit: requested !== undefined });
  const rootIdentity = resolveProjectIdentity(root, { platform: session.platform, cwd: session.cwd });
  const id = getProjectId(root, { platform: session.platform, cwd: session.cwd, caseInsensitive: rootIdentity.caseInsensitive });
  const paths = session.paths.project(id);
  const projectJson = await readJsonFile(paths.projectJson);
  const local = await readLocalState(paths.localJson).catch(() => null);
  const factsExists = await exists(paths.facts);
  return {
    root,
    id,
    name: readProjectName(root, session.platform),
    caseInsensitive: rootIdentity.caseInsensitive,
    paths,
    projectJson,
    local,
    settings: readProjectSettings(session.config, id),
    initialized: projectJson !== null && factsExists,
    freshness: { stale: projectJson === null, reason: projectJson === null ? 'missing' : null },
  };
}

/**
 * Recomputes the staleness hash of spec 9.8 and answers whether the facts still describe the project.
 * Separate from `resolveProject` because it walks the project, which `guard` and `stop` never need.
 * @param {ProjectContext} project
 * @param {{ env?: Record<string, string | undefined>, view?: import('../unity/fs-view.js').FsView }} [options]
 * @returns {{ stale: boolean, reason: string | null, inputsHash: string }}
 */
export function checkProjectFreshness(project, { env = {}, view = createNodeFsView() } = {}) {
  const inputsHash = project.projectJson?.schemaVersion === 2 && project.projectJson.workspace
    ? getWorkspaceInputsHash(view, project.root, project.projectJson, { env })
    : getInputsHash(view, project.root, { env });
  return { ...checkFactsFreshness(project.projectJson, inputsHash), inputsHash };
}

/**
 * Exit 1 with the one command that fixes it (spec 5.4 `start`).
 * @param {ProjectContext} project
 * @returns {ProjectContext}
 */
export function requireInitializedProject(project) {
  if (project.initialized) return project;
  throw usageError(`${project.root} has no facts yet`, {
    code: 'project_not_initialized',
    hint: `Run: opencode-unity init "${project.root}"`,
    data: { root: project.root, projectId: project.id },
  });
}

/**
 * @param {import('../core/config.js').Config} config
 * @param {string} projectId
 * @returns {import('../core/config.js').ProjectSettings}
 */
export function readProjectSettings(config, projectId) {
  const stored = config.projects?.[projectId];
  if (!stored) return DEFAULT_PROJECT_SETTINGS;
  return {
    editor: { ...DEFAULT_PROJECT_SETTINGS.editor, ...stored.editor },
    bashMode: stored.bashMode ?? DEFAULT_PROJECT_SETTINGS.bashMode,
  };
}

/**
 * @param {string} root
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function readProjectName(root, platform) {
  const separator = platform === 'win32' ? /[\\/]/ : /\//;
  const segments = root.split(separator).filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? root;
}

/**
 * @param {string} file
 * @returns {Promise<Record<string, any> | null>}
 */
async function readJsonFile(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
