// Finding the OpenCode binary and reading its version (spec 13.1 step 9, 5.4 `doctor`).
//
// On Windows npm installs `opencode.cmd`, a batch shim. Starting a batch file needs cmd.exe, and
// cmd.exe re-parses the arguments it is handed, so a project path with a space, an ampersand or a
// caret would reach OpenCode as something else. `runProcess` refuses `.cmd` and `.bat` for that
// reason, and this module resolves the real `opencode.exe` the shim wraps instead: the shim lives in
// the npm global prefix, and the package beside it names its own executable in `bin.opencode`.
//
// Everything is injectable, so the resolution is tested on all three platforms from one machine.
import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { findExecutable, getFirstOutputLine, runProcess } from '../core/exec.js';

export const OPENCODE_COMMAND = 'opencode';
export const OPENCODE_PACKAGE = 'opencode-ai';
/**
 * An absolute path to use instead of searching PATH. The contract job caches the tested binary outside
 * PATH and passes it this way, and `src/doctor/opencode-binary.js` reads the same name.
 */
export const BINARY_ENV_NAME = 'OPENCODE_UNITY_TEST_OPENCODE';
/** `opencode --version` prints one short line; anything slower than this is a broken install. */
export const VERSION_TIMEOUT_MS = 20_000;

const SHIM_PATTERN = /\.(cmd|bat|ps1)$/i;

/**
 * @typedef {object} LocateOptions
 * @property {Record<string, string | undefined>} [env]
 * @property {NodeJS.Platform} [platform]
 * @property {string} [homedir]
 * @property {(candidate: string) => boolean} [isFile]
 * @property {(file: string) => string | null} [readText]   Null when the file cannot be read.
 */

/**
 * @typedef {object} OpencodeLocation
 * @property {string} file            The executable to spawn; never a batch shim.
 * @property {string | null} shim     The shim found on PATH, when one was resolved away.
 * @property {'path' | 'npm-prefix'} source
 * @property {string[]} notes
 */

/**
 * @param {LocateOptions} [options]
 * @returns {OpencodeLocation | null} Null when OpenCode is not installed for this user.
 */
export function findOpencode(options = {}) {
  const { platform = process.platform, isFile = isRegularFile } = options;
  // The path rules are the target platform's, not the host's: a Windows shim path read with the posix
  // module has no directory at all, and the tests run the win32 resolution on every CI leg.
  const api = platform === 'win32' ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const override = env[BINARY_ENV_NAME];
  if (override && isFile(override)) return { file: override, shim: null, source: 'path', notes: [`${BINARY_ENV_NAME} points at this binary`] };
  const onPath = findExecutable(OPENCODE_COMMAND, { env, platform, isFile });
  if (onPath !== null && !isShim(onPath)) return { file: onPath, shim: null, source: 'path', notes: [] };

  /** @type {string[]} */
  const notes = [];
  const prefixes = onPath === null ? listNpmPrefixes(options) : [api.dirname(onPath)];
  for (const prefix of prefixes) {
    const resolved = resolvePackageExecutable(prefix, { ...options, platform, isFile });
    if (resolved !== null) {
      if (onPath !== null) notes.push(`${api.basename(onPath)} is a batch shim; the real executable is used instead`);
      return { file: resolved, shim: onPath, source: onPath === null ? 'npm-prefix' : 'path', notes };
    }
  }
  if (onPath === null) return null;
  throw new CliError(`Found ${onPath} but not the executable it wraps; the ${OPENCODE_PACKAGE} package under ${api.dirname(onPath)} looks incomplete`, {
    exitCode: EXIT.RUNTIME,
    code: 'opencode_shim_unresolved',
    hint: `Reinstall it with: npm i -g ${OPENCODE_PACKAGE}`,
    data: { shim: onPath },
  });
}

/**
 * @param {LocateOptions} [options]
 * @returns {OpencodeLocation}
 */
export function requireOpencode(options = {}) {
  const found = findOpencode(options);
  if (found !== null) return found;
  throw new CliError('OpenCode is not installed for this user', {
    exitCode: EXIT.USAGE,
    code: 'opencode_missing',
    hint: "Run 'opencode-unity setup', which installs the tested version.",
  });
}

/**
 * `<prefix>/node_modules/opencode-ai/<bin.opencode>`. The package names its own executable, so a
 * future layout change is followed rather than guessed. When the manifest cannot be read, `bin/opencode`
 * is resolved the way a shell would (PATHEXT on Windows), which is `exec.js`'s job, not this module's.
 * @param {string} prefix
 * @param {LocateOptions} options
 * @returns {string | null}
 */
export function resolvePackageExecutable(prefix, { env = process.env, platform = process.platform, isFile = isRegularFile, readText = readTextFile } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const packageDir = api.join(prefix, 'node_modules', OPENCODE_PACKAGE);
  /** @type {Array<string | null>} */
  const candidates = [];
  const manifest = readText(api.join(packageDir, 'package.json'));
  if (manifest !== null) {
    const declared = readDeclaredBin(manifest);
    if (declared !== null) candidates.push(api.resolve(packageDir, declared));
  }
  candidates.push(findExecutable(api.join(packageDir, 'bin', OPENCODE_COMMAND), { env, platform, isFile }));
  return candidates.find((candidate) => candidate !== null && !isShim(candidate) && isFile(candidate)) ?? null;
}

/**
 * The directories an npm global install may have used, most likely first. `npm_config_prefix` is set
 * by npm itself when the CLI runs inside an npm script; the platform defaults cover a plain shell.
 * @param {LocateOptions} [options]
 * @returns {string[]}
 */
export function listNpmPrefixes({ env = process.env, platform = process.platform, homedir = '' } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  /** @type {string[]} */
  const prefixes = [];
  const configured = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  if (configured) prefixes.push(configured);
  if (platform === 'win32') {
    const appData = env.APPDATA ?? (homedir ? api.join(homedir, 'AppData', 'Roaming') : '');
    if (appData) prefixes.push(api.join(appData, 'npm'));
  } else if (homedir) {
    prefixes.push(api.join(homedir, '.npm-global'), '/usr/local', '/usr');
  }
  return [...new Set(prefixes.filter((prefix) => prefix !== ''))];
}

/**
 * Runs `opencode --version`, which starts no session and loads no model.
 * @param {string} file
 * @param {{ env?: Record<string, string | undefined>, cwd?: string, signal?: AbortSignal, timeoutMs?: number, run?: typeof runProcess }} [options]
 * @returns {Promise<{ version: string | null, error: string | null }>}
 */
export async function readOpencodeVersion(file, { env, cwd, signal, timeoutMs = VERSION_TIMEOUT_MS, run = runProcess } = {}) {
  const result = await run(file, ['--version'], { env, cwd, signal, timeoutMs });
  if (result.error) return { version: null, error: result.error.message };
  if (result.timedOut) return { version: null, error: `${OPENCODE_COMMAND} --version did not answer within ${Math.round(timeoutMs / 1000)} s` };
  if (result.exitCode !== 0) return { version: null, error: `${OPENCODE_COMMAND} --version exited ${result.exitCode}` };
  const line = getFirstOutputLine(result);
  const version = parseVersion(line);
  return version === null ? { version: null, error: `Could not read a version from '${line}'` } : { version, error: null };
}

/**
 * @param {string} line
 * @returns {string | null}
 */
export function parseVersion(line) {
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(line);
  return match === null ? null : match[0];
}

/**
 * @param {string} file
 * @returns {boolean}
 */
export function isShim(file) {
  return SHIM_PATTERN.test(file);
}

/**
 * @param {string} manifest
 * @returns {string | null}
 */
function readDeclaredBin(manifest) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(manifest);
  } catch {
    return null;
  }
  const bin = /** @type {{ bin?: unknown }} */ (value)?.bin;
  if (typeof bin === 'string') return bin;
  const named = /** @type {Record<string, unknown>} */ (bin)?.[OPENCODE_COMMAND];
  return typeof named === 'string' ? named : null;
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isRegularFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
