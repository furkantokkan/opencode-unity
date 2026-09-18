// Finding the OpenCode binary and asking it for its version.
//
// `opencode --version` is the one process default `doctor` starts (spec D20): every other OpenCode
// start writes `.gitignore` files and background-installs a package into its configuration
// directories, which a read-only diagnosis must not do to a user's project.
import fs from 'node:fs';
import path from 'node:path';
import { findExecutable, getFirstOutputLine, runProcess } from '../core/exec.js';
import { BINARY_ENV_NAME, OPENCODE_COMMAND, isShim, parseVersion, resolvePackageExecutable } from '../opencode/locate.js';

// One lookup rule for the whole product: the override variable, the shim test and the package's own
// `bin` field all come from `src/opencode/locate.js`, which `start` uses, so doctor can never report a
// different executable than the one a launch would spawn.
export { BINARY_ENV_NAME, parseVersion };

export const OPENCODE_BINARY_NAME = OPENCODE_COMMAND;

/** `--version` prints one short line; anything slower than this is a broken install, not a slow one. */
export const VERSION_TIMEOUT_MS = 15_000;

/**
 * @typedef {object} OpencodeBinary
 * @property {string | null} path
 * @property {string | null} version
 * @property {string | null} error      Why the version is unknown, when it is.
 */

/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {(name: string, options: { env: Record<string, string | undefined>, platform: NodeJS.Platform }) => string | null} [options.locate]
 * @param {(target: string) => boolean} [options.isFile]
 * @param {(target: string) => string | null} [options.readText]
 * @returns {string | null}
 */
export function locateOpencode({ env = process.env, platform = process.platform, locate = findExecutable, isFile = isExistingFile, readText = readTextFile } = {}) {
  const override = env[BINARY_ENV_NAME]?.trim();
  if (override) return override;
  const found = locate(OPENCODE_BINARY_NAME, { env, platform });
  return found === null ? null : resolveShimTarget(found, { env, platform, isFile, readText });
}

/**
 * On Windows, npm installs a `.cmd` shim on PATH, and a batch file cannot be started without cmd.exe
 * re-parsing its arguments. The executable it wraps is resolved by `locate.js` from the package beside
 * it (spec 13.1 step 9). A shim with nothing resolvable behind it is returned unchanged, and the process
 * runner explains why it will not start it.
 * @param {string} found
 * @param {{ env: Record<string, string | undefined>, platform: NodeJS.Platform, isFile: (target: string) => boolean, readText: (target: string) => string | null }} options
 * @returns {string}
 */
export function resolveShimTarget(found, { env, platform, isFile, readText }) {
  if (platform !== 'win32' || !isShim(found)) return found;
  return resolvePackageExecutable(path.win32.dirname(found), { env, platform, isFile, readText }) ?? found;
}

/**
 * @param {string} target
 * @returns {boolean}
 */
function isExistingFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} target
 * @returns {string | null}
 */
function readTextFile(target) {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {AbortSignal} [options.signal]
 * @param {typeof runProcess} [options.run]
 * @param {(options: { env: Record<string, string | undefined>, platform: NodeJS.Platform }) => string | null} [options.locate]
 * @returns {Promise<OpencodeBinary>}
 */
export async function readOpencodeVersion({ env = process.env, platform = process.platform, signal, run = runProcess, locate = locateOpencode } = {}) {
  const binary = locate({ env, platform });
  if (binary === null) return { path: null, version: null, error: `'${OPENCODE_BINARY_NAME}' is not on PATH` };
  const result = await run(binary, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS, signal, env, platform });
  if (result.error !== null) return { path: binary, version: null, error: result.error.message };
  if (result.timedOut) return { path: binary, version: null, error: `'${OPENCODE_BINARY_NAME} --version' timed out` };
  if (result.exitCode !== 0) return { path: binary, version: null, error: `'${OPENCODE_BINARY_NAME} --version' exited ${result.exitCode}` };
  const version = parseVersion(getFirstOutputLine(result) ?? '');
  return version === null
    ? { path: binary, version: null, error: `'${OPENCODE_BINARY_NAME} --version' printed no version` }
    : { path: binary, version, error: null };
}
