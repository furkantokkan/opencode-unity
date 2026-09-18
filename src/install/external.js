// The two things setup runs that are not ours: `ollama pull` / `ollama create` (spec 14.1 items 4 and 5)
// and `npm i -g opencode-ai@<tested>` (item 1). Both are behind small interfaces, because a test may
// never reach a real Ollama server or a real registry, and because `uninstall` and the rollback need the
// matching remove command in the same place as the install command.
//
// Neither call loads a model: `pull` downloads weights, `create` writes a tag from a Modelfile, and both
// return without the model being resident. The only path that loads one is `warm`, behind the guard.
import fsSync from 'node:fs';
import path from 'node:path';
import { findExecutable, runProcess } from '../core/exec.js';

export const DEFAULT_PULL_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_CREATE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_REMOVE_TIMEOUT_MS = 60 * 1000;
export const DEFAULT_NPM_TIMEOUT_MS = 15 * 60 * 1000;

/** The relative places npm's own CLI script sits next to the shim, on Windows and on POSIX prefixes. */
const NPM_CLI_RELATIVE_PATHS = Object.freeze([
  ['node_modules', 'npm', 'bin', 'npm-cli.js'],
  ['..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'],
]);

/**
 * @typedef {object} ModelInstaller
 * @property {(model: string) => Promise<void>} pull
 * @property {(tag: string, modelfilePath: string) => Promise<void>} create
 * @property {(name: string) => Promise<void>} remove
 */

/**
 * @typedef {object} NpmInstaller
 * @property {(name: string, version: string) => Promise<void>} installGlobal
 */

/**
 * @typedef {object} ExternalOptions
 * @property {Record<string, string | undefined>} [env]
 * @property {NodeJS.Platform} [platform]
 * @property {typeof runProcess} [run]
 * @property {AbortSignal} [signal]
 * @property {(line: string) => void} [onProgress]
 * @property {{ pull?: number, create?: number, remove?: number }} [timeouts]
 */

/**
 * @param {ExternalOptions} [options]
 * @returns {ModelInstaller}
 */
export function createModelInstaller({ env = process.env, platform = process.platform, run = runProcess, signal, timeouts = {} } = {}) {
  const locate = () => {
    const found = findExecutable('ollama', { env, platform });
    if (!found) throw new Error("The 'ollama' command was not found on PATH; install Ollama, then run setup again");
    return found;
  };
  /**
   * @param {string[]} args
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  const invoke = async (args, timeoutMs) => {
    const result = await run(locate(), args, { timeoutMs, env, signal, platform });
    if (result.error) throw new Error(`ollama ${args[0]} could not be started (${result.error.message})`);
    if (result.aborted) throw new Error(`ollama ${args[0]} was interrupted`);
    if (result.timedOut) throw new Error(`ollama ${args[0]} did not finish within ${Math.round(timeoutMs / 60000)} minutes`);
    if (result.exitCode !== 0) throw new Error(`ollama ${args.join(' ')} exited ${result.exitCode}: ${lastMeaningfulLine(result.stderr) || lastMeaningfulLine(result.stdout)}`);
  };
  // Async, so a refused name rejects like every other failure instead of throwing past an await.
  return {
    pull: async (model) => invoke(['pull', assertModelName(model)], timeouts.pull ?? DEFAULT_PULL_TIMEOUT_MS),
    create: async (tag, modelfilePath) => invoke(['create', assertModelName(tag), '-f', modelfilePath], timeouts.create ?? DEFAULT_CREATE_TIMEOUT_MS),
    remove: async (name) => invoke(['rm', assertModelName(name)], timeouts.remove ?? DEFAULT_REMOVE_TIMEOUT_MS),
  };
}

/**
 * @param {ExternalOptions & { timeoutMs?: number }} [options]
 * @returns {NpmInstaller}
 */
export function createNpmInstaller({ env = process.env, platform = process.platform, run = runProcess, signal, timeoutMs = DEFAULT_NPM_TIMEOUT_MS } = {}) {
  return {
    async installGlobal(name, version) {
      const command = resolveNpmCommand({ env, platform });
      if (!command) throw new Error(`npm was not found on PATH; run 'npm i -g ${name}@${version}' yourself and then run setup again`);
      const args = [...command.leadingArgs, 'install', '--global', `${assertPackageName(name)}@${assertVersion(version)}`];
      const result = await run(command.file, args, { timeoutMs, env, signal, platform });
      if (result.error) throw new Error(`npm could not be started (${result.error.message})`);
      if (result.aborted) throw new Error('npm install was interrupted');
      if (result.timedOut) throw new Error(`npm install did not finish within ${Math.round(timeoutMs / 60000)} minutes`);
      if (result.exitCode !== 0) throw new Error(`npm install -g ${name}@${version} exited ${result.exitCode}: ${lastMeaningfulLine(result.stderr) || lastMeaningfulLine(result.stdout)}`);
    },
  };
}

/**
 * Windows ships npm as `npm.cmd`, and a batch file needs a shell that re-parses its arguments, so the
 * runner refuses it. npm's own CLI script sits beside the shim, and Node can run that directly.
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, execPath?: string, isFile?: (candidate: string) => boolean }} [options]
 * @returns {{ file: string, leadingArgs: string[] } | null}
 */
export function resolveNpmCommand({ env = process.env, platform = process.platform, execPath = process.execPath, isFile = isRegularFile } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const shim = findExecutable('npm', { env, platform, isFile });
  if (shim === null) return null;
  const directory = api.dirname(shim);
  for (const relative of NPM_CLI_RELATIVE_PATHS) {
    const candidate = api.resolve(directory, ...relative);
    if (isFile(candidate)) return { file: execPath, leadingArgs: [candidate] };
  }
  // A POSIX `npm` is a symbolic link to that same script and can be started directly; a Windows shim
  // cannot, so the caller prints the command instead of running it.
  return platform === 'win32' ? null : { file: shim, leadingArgs: [] };
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isRegularFile(candidate) {
  try {
    return fsSync.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Model names reach a command line, so only the characters Ollama itself uses are accepted. Everything
 * else is a name we would rather refuse than quote.
 * @param {string} name
 * @returns {string}
 */
export function assertModelName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(:[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/.test(name)) {
    throw new TypeError(`'${name}' is not a usable Ollama model name`);
  }
  return name;
}

/**
 * @param {string} name
 * @returns {string}
 */
export function assertPackageName(name) {
  if (!/^(@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new TypeError(`'${name}' is not a usable npm package name`);
  return name;
}

/**
 * @param {string} version
 * @returns {string}
 */
export function assertVersion(version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new TypeError(`'${version}' is not a usable version`);
  return version;
}

/**
 * @param {string} text
 * @returns {string}
 */
function lastMeaningfulLine(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  return lines.at(-1) ?? '';
}
