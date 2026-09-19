// An explicit opt-in visible CMD window, shared by jobs using the same product home.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findExecutable } from '../core/exec.js';
import { acquireGpuLock, readGpuLock } from '../core/lock.js';
import { monitorPaths, monitorSleep } from '../delegate/monitor.js';

/**
 * Paths travel as environment values, not interpolated shell source. Delayed expansion is off.
 * No task text, project path or model output is ever included in the CMD program.
 * @param {string} nodePath
 * @param {string} cliPath
 */
export function buildMonitorLaunch(nodePath, cliPath) {
  return {
    args: ['/d', '/v:off', '/s', '/c', '""%OCU_MONITOR_NODE%" "%OCU_MONITOR_CLI%" delegate monitor"'],
    env: { OCU_MONITOR_NODE: nodePath, OCU_MONITOR_CLI: cliPath },
  };
}

/**
 * @param {{ paths: import('../core/paths.js').HomePaths, env: Record<string, string | undefined>, platform: NodeJS.Platform }} input
 * @param {{ spawnImpl?: typeof spawn, locate?: typeof findExecutable, waitMs?: number }} [dependencies]
 */
export async function openDelegateWindow({ paths, env, platform }, { spawnImpl = spawn, locate = findExecutable, waitMs = 3000 } = {}) {
  if (platform !== 'win32') return { opened: false, message: 'The separate CMD window is Windows-only. Run delegate monitor in a terminal.' };
  const locations = monitorPaths(paths.delegateLedger);
  if (readGpuLock(locations.lock).state === 'held') return { opened: false, message: 'The delegate monitor is already open.' };
  let launchLock;
  try {
    launchLock = await acquireGpuLock({ lockPath: locations.launchLock, command: 'delegate monitor launch', timeoutSec: 10, waitSec: 0 });
  } catch (error) {
    if (error.code === 'lock_timeout') return { opened: false, message: 'Another job is opening the delegate monitor.' };
    throw error;
  }
  try {
    if (readGpuLock(locations.lock).state === 'held') return { opened: false, message: 'The delegate monitor is already open.' };
    const cmd = locate('cmd', { env, platform });
    if (!cmd) return { opened: false, message: 'CMD was not found; run delegate monitor in a terminal.' };
    const launch = buildMonitorLaunch(process.execPath, fileURLToPath(new URL('../../bin/opencode-unity.mjs', import.meta.url)));
    await new Promise((resolve, reject) => {
      const child = spawnImpl(cmd, launch.args, {
        detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true,
        cwd: paths.home, env: { ...env, ...launch.env, OPENCODE_UNITY_HOME: paths.home },
      });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(undefined); });
    });
    const deadline = Date.now() + waitMs;
    do {
      if (readGpuLock(locations.lock).state === 'held') return { opened: true, message: 'Opened the delegate monitor in a CMD window.' };
      await monitorSleep(50);
    } while (Date.now() < deadline);
    return { opened: false, message: 'CMD started but the monitor did not become ready; run delegate monitor in a terminal.' };
  } finally {
    launchLock.release();
  }
}
