// Home layout (spec 6.1) and other well-known locations. Every function takes the platform and environment
// as inputs, so Windows paths can be tested on any OS and tests never read the real profile.
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from './hash.js';

export const HOME_ENV_NAME = 'OPENCODE_UNITY_HOME';
const PRODUCT_DIR_NAME = 'opencode-unity';

/**
 * @typedef {object} PlatformContext
 * @property {Record<string, string | undefined>} [env]
 * @property {NodeJS.Platform} [platform]
 * @property {string} [homedir]  The OS user home; defaults to os.homedir().
 */

/**
 * @param {NodeJS.Platform} platform
 * @returns {path.PlatformPath}
 */
export function getPathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * `OPENCODE_UNITY_HOME`, else `%LOCALAPPDATA%\opencode-unity` on Windows, else
 * `${XDG_DATA_HOME:-~/.local/share}/opencode-unity`.
 * @param {PlatformContext} [context]
 * @returns {string} An absolute path.
 */
export function getHomeDir({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const api = getPathApi(platform);
  const override = nonEmpty(env[HOME_ENV_NAME]);
  if (override) return api.resolve(override);
  if (platform === 'win32') {
    const localAppData = nonEmpty(env.LOCALAPPDATA) ?? api.join(homedir, 'AppData', 'Local');
    return api.resolve(localAppData, PRODUCT_DIR_NAME);
  }
  const dataHome = nonEmpty(env.XDG_DATA_HOME);
  // The XDG spec says a relative XDG_DATA_HOME is invalid and must be ignored.
  const base = dataHome && api.isAbsolute(dataHome) ? dataHome : api.join(homedir, '.local', 'share');
  return api.resolve(base, PRODUCT_DIR_NAME);
}

/**
 * @typedef {object} HomePaths
 * @property {string} home
 * @property {string} config
 * @property {string} profileRoot
 * @property {string} profileCurrent
 * @property {(cliVersion: string) => ProfilePaths} profile
 * @property {string} xdgConfig
 * @property {string} projectsRoot
 * @property {string} projectsIndex
 * @property {(projectId: string) => ProjectPaths} project
 * @property {string} state
 * @property {string} installManifest
 * @property {string} sessionsDir
 * @property {string} gpuLock
 * @property {string} selftestDir
 * @property {string} benchDir
 * @property {string} capturesDir
 * @property {(cliVersion: string) => string} prefixCapture
 * @property {string} delegateLedger
 * @property {string} delegateResults
 * @property {string} logsDir
 */

/**
 * @typedef {object} ProfilePaths
 * @property {string} dir
 * @property {string} opencodeConfig
 * @property {string} modelfile
 * @property {string} runtimeProfile
 * @property {string} agentsDir
 * @property {string} commandsDir
 * @property {string} pluginsDir
 */

/**
 * @typedef {object} ProjectPaths
 * @property {string} dir
 * @property {string} facts
 * @property {string} projectJson
 * @property {string} localJson
 * @property {string} launchJson
 * @property {string} verifyCache
 */

/**
 * @param {string} home
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {HomePaths}
 */
export function getHomePaths(home, { platform = process.platform } = {}) {
  const api = getPathApi(platform);
  const join = (/** @type {string[]} */ ...segments) => api.join(home, ...segments);
  const state = join('state');
  return {
    home,
    config: join('config.json'),
    profileRoot: join('profile'),
    profileCurrent: join('profile', 'current.json'),
    profile: (cliVersion) => {
      const dir = join('profile', assertVersionSegment(cliVersion));
      return {
        dir,
        opencodeConfig: api.join(dir, 'opencode.jsonc'),
        modelfile: api.join(dir, 'Modelfile'),
        runtimeProfile: api.join(dir, 'opencode-unity.runtime.json'),
        agentsDir: api.join(dir, 'agents'),
        commandsDir: api.join(dir, 'commands'),
        pluginsDir: api.join(dir, 'plugins'),
      };
    },
    xdgConfig: join('xdg-config'),
    projectsRoot: join('projects'),
    projectsIndex: join('projects', 'index.json'),
    project: (projectId) => {
      const dir = join('projects', assertProjectId(projectId));
      return {
        dir,
        facts: api.join(dir, 'facts.md'),
        projectJson: api.join(dir, 'project.json'),
        localJson: api.join(dir, 'local.json'),
        launchJson: api.join(dir, 'launch.json'),
        verifyCache: api.join(dir, 'verify-cache.json'),
      };
    },
    state,
    installManifest: api.join(state, 'install-manifest.json'),
    sessionsDir: api.join(state, 'sessions'),
    gpuLock: api.join(state, 'gpu.lock'),
    selftestDir: api.join(state, 'selftest'),
    benchDir: api.join(state, 'bench'),
    capturesDir: api.join(state, 'captures'),
    prefixCapture: (cliVersion) => api.join(state, `prefix-${assertVersionSegment(cliVersion)}.json`),
    delegateLedger: api.join(state, 'delegate', 'ledger.jsonl'),
    delegateResults: api.join(state, 'delegate', 'results'),
    logsDir: api.join(state, 'logs'),
  };
}

/**
 * The normalized absolute project path that project ids hash: resolved, no trailing separator, and on
 * Windows with backslashes and lowercased (paths there are case-insensitive).
 * @param {string} projectPath
 * @param {{ platform?: NodeJS.Platform, cwd?: string }} [options]
 * @returns {string}
 */
export function normalizeProjectPath(projectPath, { platform = process.platform, cwd = process.cwd() } = {}) {
  const api = getPathApi(platform);
  let resolved = api.resolve(cwd, projectPath);
  const root = api.parse(resolved).root;
  while (resolved.length > root.length && /[\\/]$/.test(resolved)) resolved = resolved.slice(0, -1);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * `<name>-<sha8>`: the folder name made file-name safe, plus the first 8 hex characters of SHA-256 over the
 * normalized absolute path (spec 6.1).
 * @param {string} projectPath
 * @param {{ platform?: NodeJS.Platform, cwd?: string }} [options]
 * @returns {string}
 */
export function getProjectId(projectPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const api = getPathApi(platform);
  const normalized = normalizeProjectPath(projectPath, options);
  const originalName = api.basename(api.resolve(options.cwd ?? process.cwd(), projectPath));
  const name = originalName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48) || 'project';
  return `${name}-${sha256Hex(normalized).slice(0, 8)}`;
}

/**
 * Default Ollama locations used when config.json leaves them null. Only Windows has a known app and log
 * path; elsewhere the values are null and doctor asks for `--logs`.
 * @param {PlatformContext} [context]
 * @returns {{ appPath: string | null, serverLogPath: string | null }}
 */
export function getOllamaDefaultPaths({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (platform !== 'win32') return { appPath: null, serverLogPath: null };
  const api = path.win32;
  const localAppData = nonEmpty(env.LOCALAPPDATA) ?? api.join(homedir, 'AppData', 'Local');
  return {
    appPath: api.join(localAppData, 'Programs', 'Ollama', 'ollama app.exe'),
    serverLogPath: api.join(localAppData, 'Ollama', 'server.log'),
  };
}

/**
 * @param {string} version
 * @returns {string}
 */
function assertVersionSegment(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new TypeError(`Invalid CLI version for a path: '${version}'`);
  return version;
}

/**
 * @param {string} projectId
 * @returns {string}
 */
function assertProjectId(projectId) {
  if (!/^[A-Za-z0-9._-]{1,64}-[0-9a-f]{8}$/.test(projectId) || projectId.startsWith('.')) {
    throw new TypeError(`Invalid project id: '${projectId}'`);
  }
  return projectId;
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
