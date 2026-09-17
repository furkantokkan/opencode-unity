// Runs one probe command without a shell and collects its output (spec section 7.2). A command that
// cannot start, exits non-zero, times out, prints too much or is aborted gives an error result, and
// the guard fails closed on it. Runs in Node (CLI) and in Bun (inside OpenCode).
import { spawn } from 'node:child_process';

const k_maxOutputBytes = 4 * 1024 * 1024;

/**
 * @typedef {object} CommandResult
 * @property {boolean} ok              True when the command exited 0 within the timeout.
 * @property {number | null} exitCode
 * @property {string} stdout           UTF-8 without a byte order mark.
 * @property {string} stderr
 * @property {string | null} error     Why the run failed; null when ok.
 * @property {boolean} timedOut
 */

/**
 * @typedef {object} RunOptions
 * @property {number} timeoutMs
 * @property {string} [input]          Written to stdin, which is then closed.
 * @property {Record<string, string | undefined>} [env]
 * @property {boolean} [windowsVerbatimArguments]
 * @property {AbortSignal} [signal]
 * @property {string} [platform]       Defaults to process.platform; decides how a timed-out tree is killed.
 */

/**
 * @callback RunCommand
 * @param {string} file
 * @param {readonly string[]} args
 * @param {RunOptions} options
 * @returns {Promise<CommandResult>}
 */

/** @type {RunCommand} */
export function runCommand(file, args, options) {
  const { timeoutMs, input, env, windowsVerbatimArguments = false, signal, platform = process.platform } = options;
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let outputBytes = 0;
    let settled = false;
    /** @type {import('node:child_process').ChildProcess | undefined} */
    let child;

    /**
     * @param {Partial<CommandResult>} result
     */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        ok: false,
        exitCode: null,
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
        error: null,
        timedOut: false,
        ...result,
      });
    };
    const stop = (/** @type {Partial<CommandResult>} */ result) => {
      killTree(child, platform);
      finish(result);
    };
    const onAbort = () => stop({ error: 'was aborted' });

    const timer = setTimeout(() => stop({ error: `did not answer within ${formatSeconds(timeoutMs)}`, timedOut: true }), timeoutMs);
    if (signal?.aborted) {
      finish({ error: 'was aborted' });
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      child = spawn(file, [...args], {
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ error: `could not start (${describeError(error)})` });
      return;
    }

    const collect = (/** @type {Buffer[]} */ target) => (/** @type {Buffer} */ chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > k_maxOutputBytes) {
        stop({ error: 'printed more output than a probe ever needs' });
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on('data', collect(stdoutChunks));
    child.stderr?.on('data', collect(stderrChunks));
    child.on('error', (error) => finish({ error: `could not start (${describeError(error)})` }));
    child.on('close', (code, signalName) => {
      if (code === 0) {
        finish({ ok: true, exitCode: 0 });
        return;
      }
      const reason = code === null ? `was stopped by ${signalName ?? 'a signal'}` : `exited with code ${code}`;
      finish({ exitCode: code, error: reason });
    });
    if (input !== undefined && child.stdin) {
      // A command that exits before reading stdin closes the pipe; its exit code tells what happened.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/**
 * Builds how to start a configurable command such as `nvidiaSmiCommand`: an executable name or path,
 * a `.js`/`.mjs`/`.cjs` script (run with Node, used by tests), or on Windows a `.cmd`/`.bat` file
 * (run through cmd.exe, which Node cannot start without a shell).
 * @param {string} command
 * @param {readonly string[]} args  Fixed probe arguments; they must not need cmd.exe quoting.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, nodePath?: string }} [options]
 * @returns {{ file: string, args: string[], windowsVerbatimArguments: boolean }}
 */
export function resolveInvocation(command, args, { platform = process.platform, env = process.env, nodePath = defaultNodePath() } = {}) {
  if (/\.(c|m)?js$/i.test(command)) {
    return { file: nodePath, args: [command, ...args], windowsVerbatimArguments: false };
  }
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    if (/["%^&|<>]/.test(command) || args.some((arg) => /["%^&|<>\s]/.test(arg))) {
      throw new Error('a .cmd or .bat probe command must not contain cmd.exe special characters');
    }
    const shell = readEnv(env, 'ComSpec') ?? 'cmd.exe';
    const line = [`"${command}"`, ...args].join(' ');
    return { file: shell, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
  }
  return { file: command, args: [...args], windowsVerbatimArguments: false };
}

/**
 * Reads an environment variable case-insensitively, as Windows does.
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {string | undefined}
 */
export function readEnv(env, name) {
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

/**
 * Shortens command output for a detail line: whitespace collapsed, at most `maxLength` characters.
 * @param {string} text
 * @param {number} [maxLength]
 * @returns {string}
 */
export function summarizeOutput(text, maxLength = 120) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 3)}...` : collapsed;
}

// Inside OpenCode the plugin runs in Bun, whose execPath is the OpenCode binary, not a Node runtime.
function defaultNodePath() {
  return process.versions.bun === undefined ? process.execPath : 'node';
}

/**
 * @param {import('node:child_process').ChildProcess | undefined} child
 * @param {string} platform
 */
function killTree(child, platform) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (platform === 'win32') {
    try {
      // cmd.exe launchers start grandchildren that a plain kill would leave running.
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  child.kill('SIGKILL');
}

/**
 * @param {Buffer[]} chunks
 * @returns {string}
 */
function decode(chunks) {
  const text = Buffer.concat(chunks).toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatSeconds(ms) {
  return `${Math.round(ms / 100) / 10} s`;
}
