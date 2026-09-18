// Sandboxed homes for tests (spec section 20.1). Every child process gets temp HOME, USERPROFILE,
// LOCALAPPDATA, APPDATA and XDG_* directories, backend URLs on a closed port, and only an allow-list of
// the parent environment, so no test can read or write the developer's real profile or reach a real
// Ollama, Unity MCP hub or npm registry.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SANDBOX_PARENT = path.join(os.tmpdir(), 'opencode-unity-tests');

// Nothing listens on port 9 (discard), so a request that escapes a mock fails fast.
export const CLOSED_PORT_URL = 'http://127.0.0.1:9';

// Parent variables a child needs to start processes on Windows and POSIX. Everything else, including
// OPENCODE_*, OLLAMA_* and credentials, is dropped.
const PASSTHROUGH_ENV_NAMES = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PROGRAMDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'LC_ALL',
  'TZ',
  // Lets --experimental-test-coverage include child CLI processes.
  'NODE_V8_COVERAGE',
]);

// Setting OPENCODE_UNITY_TEST_KEEP_SANDBOX=1 keeps sandboxes for inspection after a failing run.
const KEEP_SANDBOX_ENV = 'OPENCODE_UNITY_TEST_KEEP_SANDBOX';

/**
 * @typedef {object} SandboxDirs
 * @property {string} home
 * @property {string} localAppData
 * @property {string} appData
 * @property {string} xdgConfig
 * @property {string} xdgData
 * @property {string} xdgCache
 * @property {string} xdgState
 * @property {string} tmp
 * @property {string} npmCache
 * @property {string} bin        For fake executables (see fake-bin.mjs).
 */

/**
 * @typedef {object} Sandbox
 * @property {string} root
 * @property {SandboxDirs} dirs
 * @property {Record<string, string>} env   Complete child environment; spread overrides on top of it.
 * @property {string} productHome           Where opencode-unity keeps its home by default (spec 6.1).
 * @property {(...segments: string[]) => string} path  Path inside the sandbox root.
 * @property {() => Promise<void>} cleanup
 */

/**
 * @param {string} [label]  Short name that appears in the temp directory name.
 * @returns {Promise<Sandbox>}
 */
export async function createSandbox(label = 'sandbox') {
  await fs.mkdir(SANDBOX_PARENT, { recursive: true });
  const root = await fs.mkdtemp(path.join(SANDBOX_PARENT, `${label.replace(/[^a-z0-9-]/gi, '-')}-`));
  const home = path.join(root, 'home');
  /** @type {SandboxDirs} */
  const dirs = {
    home,
    localAppData: path.join(home, 'AppData', 'Local'),
    appData: path.join(home, 'AppData', 'Roaming'),
    xdgConfig: path.join(home, '.config'),
    xdgData: path.join(home, '.local', 'share'),
    xdgCache: path.join(home, '.cache'),
    xdgState: path.join(home, '.local', 'state'),
    tmp: path.join(root, 'tmp'),
    npmCache: path.join(root, 'npm-cache'),
    bin: path.join(root, 'bin'),
  };
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })));
  const productHome = process.platform === 'win32'
    ? path.join(dirs.localAppData, 'opencode-unity')
    : path.join(dirs.xdgData, 'opencode-unity');
  return {
    root,
    dirs,
    env: buildSandboxEnv(dirs, process.env),
    productHome,
    path: (...segments) => path.join(root, ...segments),
    cleanup: () => removeSandbox(root),
  };
}

/**
 * Creates a sandbox that is removed after the test.
 * @param {import('node:test').TestContext} t
 * @param {string} [label]
 * @returns {Promise<Sandbox>}
 */
export async function useSandbox(t, label) {
  const sandbox = await createSandbox(label);
  t.after(() => sandbox.cleanup());
  return sandbox;
}

/**
 * @param {SandboxDirs} dirs
 * @param {Record<string, string | undefined>} parentEnv
 * @returns {Record<string, string>}
 */
export function buildSandboxEnv(dirs, parentEnv) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value !== undefined && PASSTHROUGH_ENV_NAMES.has(name.toUpperCase())) env[name] = value;
  }
  return {
    ...env,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    LOCALAPPDATA: dirs.localAppData,
    APPDATA: dirs.appData,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_DATA_HOME: dirs.xdgData,
    XDG_CACHE_HOME: dirs.xdgCache,
    XDG_STATE_HOME: dirs.xdgState,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    TMPDIR: dirs.tmp,
    // Required for every OpenCode run in tests (no foreign instructions, no updates, no models.dev).
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OLLAMA_HOST: CLOSED_PORT_URL,
    npm_config_registry: CLOSED_PORT_URL,
    npm_config_cache: dirs.npmCache,
    npm_config_update_notifier: 'false',
    NO_COLOR: '1',
  };
}

/**
 * Lays test overrides over an environment the way the target platform would. Windows names are
 * case-insensitive, and a Windows runner hands down `Path` rather than `PATH`: spreading `{ PATH }` over
 * it leaves both names, and a lookup that finds `Path` first never sees the override. So on win32 an
 * override replaces every spelling of its name.
 * @param {Record<string, string | undefined>} base
 * @param {Record<string, string | undefined>} [overrides]
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, string | undefined>}
 */
export function mergeEnv(base, overrides = {}, platform = process.platform) {
  if (platform !== 'win32') return { ...base, ...overrides };
  const replaced = new Set(Object.keys(overrides).map((name) => name.toUpperCase()));
  const kept = Object.fromEntries(Object.entries(base).filter(([name]) => !replaced.has(name.toUpperCase())));
  return { ...kept, ...overrides };
}

/**
 * Throws when an environment could reach the real Ollama server or the real Unity MCP hub.
 * @param {Record<string, string | undefined>} env
 */
export function assertSafeEnv(env) {
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && /:(11434|8081)(?!\d)/.test(value)) {
      throw new Error(`Test environment variable ${name} points at a real service port: ${value}`);
    }
  }
}

/**
 * @param {string} root
 */
async function removeSandbox(root) {
  if (process.env[KEEP_SANDBOX_ENV] === '1') {
    process.stderr.write(`sandbox kept: ${root}\n`);
    return;
  }
  // Windows can hold a handle briefly after a child exits, so removal retries.
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
