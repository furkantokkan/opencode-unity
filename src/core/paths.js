// Home layout (spec 6.1) and other well-known locations. Every function takes the platform and environment
// as inputs, so Windows paths can be tested on any OS and tests never read the real profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foldIdentityPath, toAbsoluteProjectPath } from './case-sensitivity.js';
import { sha8 } from './hash.js';

export const HOME_ENV_NAME = 'OPENCODE_UNITY_HOME';
const PRODUCT_DIR_NAME = 'opencode-unity';

/** The Ollama configuration directory, under the user's home on Windows and macOS (claims 91, 92). */
const OLLAMA_DIR_NAME = '.ollama';

/** The Linux package installs Ollama as a service user whose home is this directory (claim 95). */
const LINUX_OLLAMA_HOME = '/usr/share/ollama';

/** The systemd unit Ollama installs on Linux; its output goes to the journal, not to a file (claim 117). */
const LINUX_OLLAMA_UNIT = 'ollama';

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
 * The name amendment 33.8 uses for the rule above: `<home>` stays XDG off Windows on macOS too, so one
 * directory tree does not mix two conventions and `uninstall` has one path to remove.
 * @param {PlatformContext} [context]
 * @returns {string} An absolute path.
 */
export function resolveHome(context) {
  return getHomeDir(context);
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
 * The normalized absolute project path that project ids hash: resolved, no trailing separator, and
 * case-folded when the volume is case-insensitive.
 *
 * `caseInsensitive` defaults to the platform rule, which keeps this function pure and free of
 * `node:fs`. A caller that has measured the volume instead - `probeCaseInsensitive` in
 * `./case-sensitivity.js`, once per invocation where the command first resolves a project root -
 * passes the measurement, so a Windows directory with the per-directory case-sensitivity flag and a
 * case-insensitive Linux mount both get the identity they actually have (amendment CP-D13).
 * @param {string} projectPath
 * @param {{ platform?: NodeJS.Platform, cwd?: string, caseInsensitive?: boolean }} [options]
 * @returns {string}
 */
export function normalizeProjectPath(projectPath, { platform = process.platform, cwd = process.cwd(), caseInsensitive = platform === 'win32' } = {}) {
  return foldIdentityPath(toAbsoluteProjectPath(projectPath, { platform, cwd }), caseInsensitive);
}

/**
 * `<name>-<sha8>`: the folder name made file-name safe, plus the first 8 hex characters of SHA-256 over the
 * normalized absolute path (spec 6.1).
 * @param {string} projectPath
 * @param {{ platform?: NodeJS.Platform, cwd?: string, caseInsensitive?: boolean }} [options]
 * @returns {string}
 */
export function getProjectId(projectPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const api = getPathApi(platform);
  const normalized = normalizeProjectPath(projectPath, options);
  const originalName = api.basename(api.resolve(options.cwd ?? process.cwd(), projectPath));
  const name = originalName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48) || 'project';
  return `${name}-${sha8(normalized)}`;
}

/**
 * @typedef {object} OllamaPaths
 * @property {string} configDir        Holds the key pair and settings (claims 91, 92, 95).
 * @property {string} modelsDir        `OLLAMA_MODELS` overrides it on every platform (claim 95).
 * @property {string | null} appPath    The desktop app, where one exists; null on Linux, which runs a service.
 * @property {string | null} logsDir    The directory the server log rotates in; null when the logs go to the journal.
 * @property {string | null} serverLogPath  Null on Linux (claim 117).
 */

/**
 * Where Ollama keeps its models, configuration, application and log on each platform (amendment 33.8).
 * These are defaults: `config.json` may override the app and log entries, and doctor prints what it used.
 * @param {PlatformContext} [context]
 * @returns {OllamaPaths}
 */
export function resolveOllamaPaths({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const api = getPathApi(platform);
  const modelsOverride = nonEmpty(env.OLLAMA_MODELS);
  const withModels = (/** @type {OllamaPaths} */ paths) =>
    modelsOverride === undefined ? paths : { ...paths, modelsDir: api.resolve(modelsOverride) };

  if (platform === 'win32') {
    const localAppData = nonEmpty(env.LOCALAPPDATA) ?? api.join(homedir, 'AppData', 'Local');
    const logsDir = api.join(localAppData, 'Ollama');
    const configDir = api.join(homedir, OLLAMA_DIR_NAME);
    return withModels({
      configDir,
      modelsDir: api.join(configDir, 'models'),
      appPath: api.join(localAppData, 'Programs', 'Ollama', 'ollama app.exe'),
      logsDir,
      serverLogPath: api.join(logsDir, 'server.log'),
    });
  }
  if (platform === 'darwin') {
    const configDir = api.join(homedir, OLLAMA_DIR_NAME);
    const logsDir = api.join(configDir, 'logs');
    return withModels({
      configDir,
      modelsDir: api.join(configDir, 'models'),
      appPath: '/Applications/Ollama.app',
      logsDir,
      serverLogPath: api.join(logsDir, 'server.log'),
    });
  }
  const configDir = api.join(LINUX_OLLAMA_HOME, OLLAMA_DIR_NAME);
  return withModels({ configDir, modelsDir: api.join(configDir, 'models'), appPath: null, logsDir: null, serverLogPath: null });
}

/**
 * Default Ollama locations used when config.json leaves them null. Only Windows has a known app and log
 * path; elsewhere the values are null and doctor asks for `--logs`.
 * @param {PlatformContext} [context]
 * @returns {{ appPath: string | null, serverLogPath: string | null }}
 */
export function getOllamaDefaultPaths(context = {}) {
  const platform = context.platform ?? process.platform;
  if (platform !== 'win32') return { appPath: null, serverLogPath: null };
  const { appPath, serverLogPath } = resolveOllamaPaths(context);
  return { appPath, serverLogPath };
}

/**
 * @typedef {{ kind: 'file', path: string, rotation: string }
 *         | { kind: 'journal', unit: string, command: string[] }
 *         | { kind: 'none' }} LogSource
 */

/**
 * The Ollama server log is a source, not a path (amendment 33.8): a rotating file on Windows and macOS,
 * the systemd journal on Linux, and nothing at all when the user started `ollama serve` by hand, which
 * is why `doctor` reports truncation history as `not checked` there instead of as a pass.
 * @param {PlatformContext & { configuredPath?: string | null, lines?: number, exists?: (candidate: string) => boolean }} [context]
 * @returns {LogSource}
 */
export function resolveLogSource({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  configuredPath = null,
  lines,
  exists = isExistingPath,
} = {}) {
  const api = getPathApi(platform);
  const configured = nonEmpty(configuredPath ?? undefined);
  // A configured path is the user's statement about their own install, so it is not existence-checked here.
  if (configured !== undefined) return { kind: 'file', path: api.resolve(configured), rotation: 'server-*.log' };
  if (platform === 'linux') {
    const command = ['journalctl', '-u', LINUX_OLLAMA_UNIT, '--no-pager'];
    if (lines !== undefined) command.push('-n', String(lines));
    return { kind: 'journal', unit: LINUX_OLLAMA_UNIT, command };
  }
  const { serverLogPath } = resolveOllamaPaths({ env, platform, homedir });
  if (serverLogPath === null || !exists(serverLogPath)) return { kind: 'none' };
  return { kind: 'file', path: serverLogPath, rotation: 'server-*.log' };
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
 * @param {string} candidate
 * @returns {boolean}
 */
function isExistingPath(candidate) {
  try {
    fs.accessSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
