// Runs the real CLI binary as a child process inside a sandbox.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvelope } from '../../src/cli/envelope.js';
import { killProcessTree } from '../../src/cli/signals.js';
import { assertSafeEnv, createSandbox } from './sandbox.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CLI_PATH = path.join(REPO_ROOT, 'bin', 'opencode-unity.mjs');

/**
 * @typedef {object} ProcessResult
 * @property {number | null} code
 * @property {NodeJS.Signals | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} durationMs
 */

/**
 * @typedef {object} RunCliOptions
 * @property {import('./sandbox.mjs').Sandbox} [sandbox]  Default: a fresh sandbox removed afterwards.
 * @property {Record<string, string | undefined>} [env]   Applied on top of the sandbox environment.
 * @property {string} [cwd]                               Default: the sandbox root.
 * @property {string} [input]                             Written to stdin, then stdin is closed.
 * @property {number} [timeoutMs]
 */

/**
 * @param {readonly string[]} args
 * @param {RunCliOptions} [options]
 * @returns {Promise<ProcessResult>}
 */
export async function runCli(args, { sandbox, env = {}, cwd, input, timeoutMs } = {}) {
  const ownSandbox = sandbox ? undefined : await createSandbox('run-cli');
  const activeSandbox = sandbox ?? /** @type {import('./sandbox.mjs').Sandbox} */ (ownSandbox);
  try {
    return await runProcess(process.execPath, [CLI_PATH, ...args], {
      cwd: cwd ?? activeSandbox.root,
      env: { ...activeSandbox.env, ...env },
      input,
      timeoutMs,
    });
  } finally {
    await ownSandbox?.cleanup();
  }
}

/**
 * Spawns without a shell and with exactly the given environment (not merged with process.env).
 * @param {string} file
 * @param {readonly string[]} args
 * @param {{ cwd?: string, env: Record<string, string | undefined>, input?: string, timeoutMs?: number }} options
 * @returns {Promise<ProcessResult>}
 */
export function runProcess(file, args, { cwd, env, input, timeoutMs = 60_000 }) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    // Inside the executor, so an unsafe environment rejects instead of throwing synchronously.
    assertSafeEnv(env);
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    /** @type {Buffer[]} */
    const stdout = [];
    /** @type {Buffer[]} */
    const stderr = [];
    const timer = setTimeout(() => {
      if (child.pid !== undefined) killProcessTree(child.pid);
      const output = `\nstdout:\n${Buffer.concat(stdout)}\nstderr:\n${Buffer.concat(stderr)}`;
      reject(new Error(`Process timed out after ${timeoutMs} ms: ${file} ${args.join(' ')}${output}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - startedAt,
      });
    });
    // A child that exits before reading stdin makes the write fail with EPIPE; that is not a test error.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/**
 * Parses the JSON envelope from the last non-empty stdout line of a `--json` run.
 * @param {ProcessResult} result
 * @returns {import('../../src/cli/envelope.js').Envelope}
 */
export function readEnvelope(result) {
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) throw new Error(`No envelope on stdout. stderr:\n${result.stderr}`);
  return parseEnvelope(lines[lines.length - 1]);
}
