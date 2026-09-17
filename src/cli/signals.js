// Interrupt handling (spec section 5.1): Ctrl+C releases the GPU lock, rolls back a staged install,
// kills child process trees and exits 130. Owners of those resources register synchronous cleanups;
// they run newest first, because later resources usually depend on earlier ones.
import { spawnSync } from 'node:child_process';
import { EXIT } from './exit-codes.js';
import { CLI_NAME } from './version.js';

/**
 * A cleanup must be synchronous: the process exits right after the cleanups run. It may return a short
 * note, for example "released the GPU lock", which is printed with the interrupt message.
 * @typedef {() => string | void} Cleanup
 */

/**
 * @typedef {object} InterruptController
 * @property {AbortSignal} signal                        Aborted when an interrupt arrives.
 * @property {(cleanup: Cleanup) => () => void} addCleanup  Returns a function that removes the cleanup.
 * @property {(child: import('node:child_process').ChildProcess) => () => void} trackChild
 *   Kills the child's process tree on interrupt, until the child exits.
 * @property {() => () => void} suspendInterrupts
 *   While suspended, SIGINT and SIGBREAK are ignored (a foreground child such as the OpenCode TUI owns
 *   Ctrl+C). SIGTERM and SIGHUP still clean up. Returns the function that ends the suspension.
 * @property {(signalName: string) => void} handleSignal
 * @property {() => string[]} runCleanups                Runs and clears all cleanups; returns their notes.
 * @property {(target?: NodeJS.Process) => () => void} install  Registers the process handlers; returns uninstall.
 */

/**
 * @typedef {object} InterruptOptions
 * @property {NodeJS.Platform} [platform]
 * @property {(code: number) => void} [exit]
 * @property {import('./output.js').TextStream} [stderr]
 * @property {(pid: number) => boolean} [killTree]
 * @property {(signalName: string, notes: string[]) => void} [onInterrupt]  Called before exit, for example
 *   to print the interrupted envelope under --json.
 */

/**
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
export function getInterruptSignals(platform) {
  // Closing a console window arrives as SIGHUP on Windows too; Ctrl+Break arrives as SIGBREAK.
  return platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
}

/**
 * @param {InterruptOptions} [options]
 * @returns {InterruptController}
 */
export function createInterruptController({
  platform = process.platform,
  exit = (code) => process.exit(code),
  stderr = process.stderr,
  killTree = (pid) => killProcessTree(pid, { platform }),
  onInterrupt,
} = {}) {
  const abortController = new AbortController();
  /** @type {Set<Cleanup>} */
  const cleanups = new Set();
  let suspendCount = 0;

  /** @type {InterruptController['addCleanup']} */
  function addCleanup(cleanup) {
    // A wrapper keeps registrations distinct when the same function is added twice.
    const entry = () => cleanup();
    cleanups.add(entry);
    return () => {
      cleanups.delete(entry);
    };
  }

  /** @type {InterruptController['runCleanups']} */
  function runCleanups() {
    const notes = [];
    for (const cleanup of [...cleanups].reverse()) {
      try {
        const note = cleanup();
        if (note) notes.push(note);
      } catch (error) {
        notes.push(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    cleanups.clear();
    return notes;
  }

  /** @type {InterruptController['handleSignal']} */
  function handleSignal(signalName) {
    const interactiveSignal = signalName === 'SIGINT' || signalName === 'SIGBREAK';
    if (interactiveSignal && suspendCount > 0) return;
    abortController.abort(new Error(`interrupted by ${signalName}`));
    const notes = runCleanups();
    const suffix = notes.length ? `; ${notes.join('; ')}` : '';
    stderr.write(`${CLI_NAME}: interrupted by ${signalName}${suffix}\n`);
    onInterrupt?.(signalName, notes);
    exit(EXIT.INTERRUPTED);
  }

  return {
    signal: abortController.signal,
    addCleanup,
    trackChild(child) {
      const remove = addCleanup(() => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
        killTree(child.pid);
        return `stopped process ${child.pid}`;
      });
      child.once('exit', remove);
      return remove;
    },
    suspendInterrupts() {
      suspendCount += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        suspendCount -= 1;
      };
    },
    handleSignal,
    runCleanups,
    install(target = process) {
      const signals = getInterruptSignals(platform);
      /** @type {Array<[string, () => void]>} */
      const listeners = signals.map((signalName) => [signalName, () => handleSignal(signalName)]);
      for (const [signalName, listener] of listeners) target.on(signalName, listener);
      return () => {
        for (const [signalName, listener] of listeners) target.off(signalName, listener);
      };
    },
  };
}

/**
 * Kills a process and its descendants. On Windows `taskkill /T /F` walks the tree. On other platforms
 * the process group is killed when the child was spawned with `detached: true`; otherwise only the
 * process itself.
 * @param {number} pid
 * @param {{ platform?: NodeJS.Platform, runSync?: typeof spawnSync }} [options]
 * @returns {boolean} True when the kill was delivered.
 */
export function killProcessTree(pid, { platform = process.platform, runSync = spawnSync } = {}) {
  if (platform === 'win32') {
    const result = runSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return result.status === 0;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
      return true;
    } catch {
      // Not a group leader, or already gone: try the next form.
    }
  }
  return false;
}
