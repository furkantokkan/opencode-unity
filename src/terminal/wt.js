// The optional Windows Terminal status pane (spec 13.1 step 8).
//
// `start` opens a quarter-height pane above the session running `status --watch`, then moves focus
// back, so guard, VRAM and truncation state stay visible while the TUI owns the rest of the screen.
// It is a convenience: every failure here is a note, never an error, because a missing pane has no
// effect on the session.
//
// Off Windows there is no terminal integration at all (amendment 38.10, CP-D17): `start.pane`
// resolves to `never`, `--no-pane` becomes a no-op, and nothing is spawned.
//
// `wt` re-parses the command line it is handed, and `;` is its own statement separator, so a `;` in a
// forwarded path is escaped. Everything else is passed as a separate argument, which Node quotes.
import { findExecutable, runProcess } from '../core/exec.js';

export const WT_COMMAND = 'wt';
export const WT_SESSION_ENV = 'WT_SESSION';
/** A quarter of the height: enough for the status line and a few truncation notices. */
export const PANE_SIZE = 0.25;
export const PANE_SPAWN_TIMEOUT_MS = 10_000;

export const CONHOST_WARNING =
  'This is not Windows Terminal. On the reference machine the OpenCode TUI rendered blank in the classic console host; Windows Terminal or another modern terminal is recommended.';

/**
 * @typedef {object} PaneDecision
 * @property {boolean} open
 * @property {'ok' | 'not-windows' | 'disabled-by-flag' | 'disabled-by-config' | 'not-windows-terminal'} reason
 * @property {string | null} warning
 */

/**
 * @param {object} options
 * @param {NodeJS.Platform} options.platform
 * @param {Record<string, string | undefined>} options.env
 * @param {boolean} [options.noPane]                      The `--no-pane` flag.
 * @param {'auto' | 'never'} [options.configPane]         `start.pane` from config.json.
 * @returns {PaneDecision}
 */
export function decidePane({ platform, env, noPane = false, configPane = 'auto' }) {
  // Off Windows the flag is a no-op and there is nothing to warn about: no terminal integration ships.
  if (platform !== 'win32') return { open: false, reason: 'not-windows', warning: null };
  if (noPane) return { open: false, reason: 'disabled-by-flag', warning: null };
  if (configPane === 'never') return { open: false, reason: 'disabled-by-config', warning: null };
  if (!isWindowsTerminal(env)) return { open: false, reason: 'not-windows-terminal', warning: CONHOST_WARNING };
  return { open: true, reason: 'ok', warning: null };
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function isWindowsTerminal(env) {
  const value = env[WT_SESSION_ENV];
  return typeof value === 'string' && value !== '';
}

/**
 * The two `wt` invocations of 13.1: split the window, then put the focus back on the session.
 * @param {object} options
 * @param {string} options.nodePath      The Node executable running this CLI.
 * @param {string} options.cliPath       `bin/opencode-unity.mjs`.
 * @param {string} options.project       Project directory or id for `status --project`.
 * @param {number} [options.intervalSec]
 * @returns {Array<{ args: string[] }>}
 */
export function buildPaneCommands({ nodePath, cliPath, project, intervalSec }) {
  const watch = ['status', '--watch', '--project', project];
  if (intervalSec !== undefined) watch.push('--interval', String(intervalSec));
  return [
    { args: ['-w', '0', 'split-pane', '--horizontal', '--size', String(PANE_SIZE), '--', nodePath, cliPath, ...watch].map(escapeSemicolons) },
    { args: ['-w', '0', 'move-focus', 'up'] },
  ];
}

/**
 * Opens the pane. Returns notes rather than throwing: the session starts either way.
 * @param {object} options
 * @param {string} options.nodePath
 * @param {string} options.cliPath
 * @param {string} options.project
 * @param {number} [options.intervalSec]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {typeof runProcess} [options.run]
 * @param {(name: string, options: { env?: Record<string, string | undefined>, platform?: NodeJS.Platform }) => string | null} [options.locate]
 * @returns {Promise<{ opened: boolean, notes: string[] }>}
 */
export async function openStatusPane({ nodePath, cliPath, project, intervalSec, env = process.env, platform = process.platform, run = runProcess, locate = findExecutable }) {
  const wt = locate(WT_COMMAND, { env, platform });
  if (wt === null) return { opened: false, notes: ['The status pane needs the Windows Terminal command (wt) on PATH; the session runs without it.'] };
  for (const command of buildPaneCommands({ nodePath, cliPath, project, intervalSec })) {
    const result = await run(wt, command.args, { env, timeoutMs: PANE_SPAWN_TIMEOUT_MS, platform });
    if (result.error || result.timedOut || result.exitCode !== 0) {
      return { opened: false, notes: [`The status pane could not be opened (${describeFailure(result)}); the session runs without it.`] };
    }
  }
  return { opened: true, notes: [] };
}

/**
 * @param {import('../core/exec.js').RunResult} result
 * @returns {string}
 */
function describeFailure(result) {
  if (result.error) return result.error.message;
  if (result.timedOut) return 'wt did not answer';
  return `wt exited ${result.exitCode}`;
}

/**
 * @param {string} argument
 * @returns {string}
 */
function escapeSemicolons(argument) {
  return argument.includes(';') ? argument.replace(/;/g, '\\;') : argument;
}
