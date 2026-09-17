// Locates and runs the real OpenCode binary for M0 spikes. Every run gets a sandboxed environment
// (see sandbox.mjs), a hard timeout that kills the whole process tree, and one retry when OpenCode
// hangs during startup (spec 20.3: an intermittent `opencode run` startup hang).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { assertSafeEnv } from '../../test/helpers/sandbox.mjs';

export const TESTED_OPENCODE_VERSION = '1.18.31';

/**
 * Finds opencode: OPENCODE_UNITY_SPIKE_OPENCODE, then the global npm install of opencode-ai, then PATH.
 * @returns {string}
 */
export function locateOpencode() {
  const fromEnv = process.env.OPENCODE_UNITY_SPIKE_OPENCODE;
  if (fromEnv) return fromEnv;
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', exe));
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('opencode binary not found; set OPENCODE_UNITY_SPIKE_OPENCODE');
  return found;
}

/**
 * @param {number} pid
 */
function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * @typedef {object} RunResult
 * @property {number | null} exitCode
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} durationMs
 * @property {boolean} timedOut
 * @property {number} attempts
 */

/**
 * @param {object} options
 * @param {string[]} options.args
 * @param {Record<string, string>} options.env
 * @param {string} options.cwd
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.retryOnTimeout]  Retry once after a timeout (startup hang).
 * @param {(line: string) => boolean} [options.stopWhen]  Kill the process once a stdout/stderr chunk matches.
 * @returns {Promise<RunResult>}
 */
export async function runOpencode({ args, env, cwd, timeoutMs = 120_000, retryOnTimeout = true, stopWhen }) {
  assertSafeEnv(env);
  const first = await runOnce({ args, env, cwd, timeoutMs, stopWhen });
  if (!first.timedOut || !retryOnTimeout) return { ...first, attempts: 1 };
  const second = await runOnce({ args, env, cwd, timeoutMs, stopWhen });
  return { ...second, attempts: 2 };
}

/**
 * @param {{ args: string[], env: Record<string, string>, cwd: string, timeoutMs: number, stopWhen?: (text: string) => boolean }} options
 * @returns {Promise<Omit<RunResult, 'attempts'>>}
 */
function runOnce({ args, env, cwd, timeoutMs, stopWhen }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(locateOpencode(), args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stopped = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    const check = () => {
      if (!stopWhen || stopped || !child.pid) return;
      if (stopWhen(stdout + stderr)) {
        stopped = true;
        killTree(child.pid);
      }
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      check();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      check();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: stopped ? null : code, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\nspawn error: ${error.message}`, durationMs: Date.now() - started, timedOut });
    });
  });
}

/**
 * Parses `opencode run --format json` output (one JSON event per line).
 * @param {string} stdout
 * @returns {any[]}
 */
export function parseJsonEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Not an event line.
    }
  }
  return events;
}

/**
 * Extracts the first JSON object printed to stdout (for `debug agent` and `debug config`).
 * @param {string} stdout
 * @returns {any}
 */
export function parseFirstJson(stdout) {
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}
