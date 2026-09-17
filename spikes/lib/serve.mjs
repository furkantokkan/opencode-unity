// Starts `opencode serve` on a free loopback port for spikes that need the server API. The TUI is a
// client of the same server and session loop, so a session prompted through the API takes the same
// processor path the TUI shows (the visual rendering itself stays a manual check).
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

import { assertSafeEnv } from '../../test/helpers/sandbox.mjs';
import { locateOpencode } from './opencode.mjs';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = /** @type {net.AddressInfo} */ (server.address()).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * @param {{ env: Record<string, string>, cwd: string, timeoutMs?: number }} options
 */
export async function startServe({ env, cwd, timeoutMs = 90_000 }) {
  assertSafeEnv(env);
  const port = await freePort();
  const child = spawn(locateOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const origin = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${origin}/global/health`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (child.exitCode !== null) throw new Error(`opencode serve exited early: ${output.slice(-1000)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const directory = encodeURIComponent(cwd);

  /**
   * @param {string} method
   * @param {string} route
   * @param {unknown} [body]
   */
  const request = async (method, route, body) => {
    const separator = route.includes('?') ? '&' : '?';
    const response = await fetch(`${origin}${route}${separator}directory=${directory}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON.
    }
    return { status: response.status, json, text };
  };

  return {
    origin,
    request,
    output: () => output,
    stop: () => {
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      }
    },
  };
}
