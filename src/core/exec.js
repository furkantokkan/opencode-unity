// Child processes for the CLI: `ollama create`, `opencode --version`, `dotnet --list-sdks` and similar.
// Never through a shell, always with a timeout, and a timeout or abort kills the whole process tree.
// The plugin has its own runner (plugin/opencode-unity-lib), because it cannot import src/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killProcessTree } from '../cli/signals.js';

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
// A grandchild that inherited the pipes can keep them open after the child exits.
const PIPE_GRACE_MS = 1500;

/**
 * @typedef {object} RunOptions
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [input]            Written to stdin, then stdin is closed.
 * @property {number} timeoutMs
 * @property {number} [maxOutputBytes]   Per stream; the rest is dropped and `truncated` is set.
 * @property {AbortSignal} [signal]
 * @property {(child: import('node:child_process').ChildProcess) => (() => void) | void} [onSpawn]
 *   For example `context.interrupts.trackChild`; a returned function is called when the child is done.
 * @property {NodeJS.Platform} [platform]
 * @property {(pid: number) => boolean} [killTree]
 */

/**
 * @typedef {object} RunResult
 * @property {number | null} exitCode
 * @property {string | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {boolean} truncated
 * @property {Error | null} error        Spawn failure, for example ENOENT.
 * @property {number} durationMs
 */

/**
 * Runs a program with arguments passed as an array. Resolves in every case; check `error`, `timedOut`,
 * `aborted` and `exitCode`.
 * @param {string} file
 * @param {readonly string[]} args
 * @param {RunOptions} options
 * @returns {Promise<RunResult>}
 */
export function runProcess(file, args, options) {
  const { cwd, env, input, timeoutMs, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, signal, onSpawn, platform = process.platform } = options;
  const killTree = options.killTree ?? ((pid) => killProcessTree(pid, { platform }));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number');
  const refusal = getShellShimRefusal(file, platform);
  if (refusal) return Promise.resolve(createFailedResult(refusal));
  if (signal?.aborted) return Promise.resolve({ ...createFailedResult(null), aborted: true });

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout = createCollector(maxOutputBytes);
    const stderr = createCollector(maxOutputBytes);
    let timedOut = false;
    let aborted = false;
    /** @type {Error | null} */
    let spawnError = null;
    /** @type {number | null} */
    let exitCode = null;
    /** @type {string | null} */
    let exitSignal = null;
    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let graceTimer;

    const child = spawn(file, [...args], { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const untrack = onSpawn?.(child);

    const kill = () => {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) killTree(child.pid);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      if (typeof untrack === 'function') untrack();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        exitCode: spawnError ? null : exitCode,
        signal: exitSignal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        aborted,
        truncated: stdout.truncated || stderr.truncated,
        error: spawnError,
        durationMs: Date.now() - startedAt,
      });
    };
    const finishSoon = () => {
      graceTimer ??= setTimeout(finish, PIPE_GRACE_MS);
    };
    const onAbort = () => {
      aborted = true;
      kill();
      finishSoon();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finishSoon();
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => stdout.add(chunk));
    child.stderr?.on('data', (chunk) => stderr.add(chunk));
    // Without listeners a pipe error (for example EPIPE when the child never reads stdin) would throw.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => {});
    child.on('error', (error) => {
      spawnError = error;
      finish();
    });
    child.on('exit', (code, childSignal) => {
      exitCode = code;
      exitSignal = childSignal;
      finishSoon();
    });
    child.on('close', (code, childSignal) => {
      exitCode ??= code;
      exitSignal ??= childSignal;
      finish();
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/**
 * Finds an executable on PATH the way a shell would, without starting one. On Windows each PATHEXT
 * extension is tried; a name with a directory part is checked as given.
 * @param {string} name
 * @param {{ env?: Record<string, string | undefined>, platform?: NodeJS.Platform, isFile?: (candidate: string) => boolean }} [options]
 * @returns {string | null}
 */
export function findExecutable(name, { env = process.env, platform = process.platform, isFile = isRegularFile } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const extensions = platform === 'win32' ? getPathExtensions(env) : [''];
  const hasExtension = platform === 'win32' && extensions.some((extension) => extension !== '' && name.toLowerCase().endsWith(extension.toLowerCase()));
  const candidatesFor = (/** @type {string} */ base) => (hasExtension || platform !== 'win32' ? [base] : extensions.map((extension) => base + extension));
  if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) {
    return candidatesFor(name).find((candidate) => isFile(candidate)) ?? null;
  }
  const pathValue = getEnvValue(env, 'PATH', platform) ?? '';
  for (const dir of pathValue.split(api.delimiter)) {
    if (dir.trim() === '') continue;
    const found = candidatesFor(api.join(dir.replace(/^"(.*)"$/, '$1'), name)).find((candidate) => isFile(candidate));
    if (found) return found;
  }
  return null;
}

/**
 * The first non-empty line of combined output, trimmed; handy for `--version` style probes.
 * @param {RunResult} result
 * @returns {string}
 */
export function getFirstOutputLine(result) {
  return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/**
 * Windows cannot start `.cmd` and `.bat` files without cmd.exe, which re-parses arguments, so they are
 * refused instead (spec 13.1 resolves the real executable behind npm shims).
 * @param {string} file
 * @param {NodeJS.Platform} platform
 * @returns {Error | null}
 */
function getShellShimRefusal(file, platform) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return null;
  return Object.assign(new Error(`${path.basename(file)} is a batch file and needs a shell; run the executable it wraps instead`), { code: 'ESHELLSHIM' });
}

/**
 * @param {Error | null} error
 * @returns {RunResult}
 */
function createFailedResult(error) {
  return { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, error, durationMs: 0 };
}

/**
 * @param {number} maxBytes
 */
function createCollector(maxBytes) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    get truncated() {
      return truncated;
    },
    /** @param {Buffer} chunk */
    add(chunk) {
      const room = maxBytes - size;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) truncated = true;
      chunks.push(part);
      size += part.length;
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function getPathExtensions(env) {
  const value = getEnvValue(env, 'PATHEXT', 'win32') ?? '.COM;.EXE;.BAT;.CMD';
  return value.split(';').filter((extension) => extension.startsWith('.'));
}

/**
 * Windows environment names are case-insensitive.
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {NodeJS.Platform} platform
 * @returns {string | undefined}
 */
function getEnvValue(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * Whether a PATH candidate is a file a process can be started from. On Windows that includes an App
 * Execution Alias - how the Store and winget put `wt.exe`, `winget.exe` or a Store `pwsh.exe` on PATH:
 * it is a reparse point that `stat` refuses with EACCES, yet CreateProcess starts it like any program.
 * @param {string} candidate
 * @param {{ platform?: NodeJS.Platform, statSync?: (file: string) => { isFile(): boolean }, lstatSync?: (file: string) => { isFile(): boolean, isSymbolicLink(): boolean } }} [options]
 * @returns {boolean}
 */
export function isRegularFile(candidate, { platform = process.platform, statSync = fs.statSync, lstatSync = fs.lstatSync } = {}) {
  try {
    return statSync(candidate).isFile();
  } catch (error) {
    if (platform !== 'win32' || /** @type {{ code?: unknown }} */ (error)?.code !== 'EACCES') return false;
    try {
      const link = lstatSync(candidate);
      return link.isSymbolicLink() || link.isFile();
    } catch {
      return false;
    }
  }
}
