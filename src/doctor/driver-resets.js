// Windows display-driver resets in the recent System log (spec 5.4 `gpu.driver-resets`).
//
// A TDR ("nvlddmkm") event is the signature of a display driver that was reset under load, which is
// what a 19 GiB model plus a Unity import can provoke. The query is read-only, bounded and win32 only;
// every other platform reports that it was not checked rather than that nothing happened.
import { findExecutable, runProcess } from '../core/exec.js';

/** Windows PowerShell 5.1 ships with every supported Windows release; exec.js adds the extension. */
const POWERSHELL = 'powershell';

/** Spec 5.4: the last seven days. */
export const RESET_WINDOW_DAYS = 7;
export const RESET_QUERY_TIMEOUT_MS = 20_000;

/** The driver that logs the event. Only this provider is queried, so the read stays narrow. */
export const RESET_PROVIDER = 'nvlddmkm';

/**
 * @typedef {object} DriverResetReading
 * @property {boolean} checked
 * @property {number} events
 * @property {string | null} since     ISO timestamp of the window start.
 * @property {string | null} error
 */

/**
 * @param {object} input
 * @param {NodeJS.Platform} input.platform
 * @param {Record<string, string | undefined>} input.env
 * @param {number} input.nowMs
 * @param {typeof runProcess} [input.run]
 * @param {(name: string, options: { env: Record<string, string | undefined>, platform: NodeJS.Platform }) => string | null} [input.locate]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<DriverResetReading>}
 */
export async function readDriverResets({ platform, env, nowMs, run = runProcess, locate = findExecutable, signal }) {
  if (platform !== 'win32') return { checked: false, events: 0, since: null, error: null };
  const since = new Date(nowMs - RESET_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const shell = locate(POWERSHELL, { env, platform });
  if (shell === null) return { checked: false, events: 0, since, error: `'${POWERSHELL}' is not on PATH` };
  const result = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', buildQuery()], {
    timeoutMs: RESET_QUERY_TIMEOUT_MS,
    env,
    platform,
    signal,
  });
  if (result.error !== null) return { checked: false, events: 0, since, error: result.error.message };
  if (result.timedOut) return { checked: false, events: 0, since, error: 'the event log query timed out' };
  if (result.exitCode !== 0) return { checked: false, events: 0, since, error: `the event log query exited ${result.exitCode}` };
  const events = parseCount(result.stdout);
  return events === null
    ? { checked: false, events: 0, since, error: 'the event log query printed no count' }
    : { checked: true, events, since, error: null };
}

/**
 * One line on stdout: the number of matching events. `SilentlyContinue` keeps "no events found" from
 * becoming an error, because an empty log is the healthy answer.
 * @returns {string}
 */
export function buildQuery() {
  const filter = `@{LogName='System';ProviderName='${RESET_PROVIDER}';StartTime=(Get-Date).AddDays(-${RESET_WINDOW_DAYS})}`;
  return `(Get-WinEvent -FilterHashtable ${filter} -ErrorAction SilentlyContinue | Measure-Object).Count`;
}

/**
 * @param {string} text
 * @returns {number | null}
 */
export function parseCount(text) {
  const match = /-?\d+/.exec(text);
  if (match === null) return null;
  const value = Number.parseInt(match[0], 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
