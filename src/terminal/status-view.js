// The `status --watch` line (spec 13.3) and the truncation watcher that runs beside it.
//
// One line per poll, fields separated by ` | `, short enough for a quarter-height Windows Terminal
// pane. It is deliberately dense: the pane sits above a TUI, and a user glances at it rather than
// reading it.
//
// The truncation watcher is the one thing here that is not a snapshot. Ollama cuts a prompt that does
// not fit and says so only in its own server log; the session sees a confident answer written without
// the start of the request (E1). So every poll re-opens the log, reads what is new, closes it, and
// prints any `truncating input prompt` line in yellow. The log is never held open, because Ollama
// rotates it, and rotation is followed through `server-1.log`.
import { createLogFollower, parseServerLog } from '../ollama/server-log.js';
import { formatClock, formatDuration, formatGiBOrUnknown, paintTone } from './format.js';
import { formatTokens } from '../opencode/effective-config.js';

/** @typedef {import('../cli/output.js').Painter} Painter */
/** @typedef {import('./format.js').Tone} Tone */

/**
 * @typedef {object} StatusSnapshot
 * @property {Date} at
 * @property {string} guardVerdict                       `pass`, `blocked`, `pass-degraded`.
 * @property {string | null} guardReason                 First blocking reason id, when blocked.
 * @property {boolean} modelLoaded
 * @property {number | null} modelContextLength
 * @property {number | null} modelExpiresInSec           Infinity when it stays loaded.
 * @property {number | null} freeVramMiB
 * @property {'idle' | 'busy' | 'unknown'} imports
 * @property {number | null} editors
 * @property {string} lock                               `-` when free.
 * @property {number} requests
 * @property {number} overflows
 * @property {number} truncations
 * @property {number} textToolCalls
 */

/**
 * @param {StatusSnapshot} snapshot
 * @param {{ paint: Painter }} options
 * @returns {string}
 */
export function formatStatusLine(snapshot, { paint }) {
  const fields = [
    `guard ${describeGuard(snapshot)}`,
    `VRAM free ${formatGiBOrUnknown(snapshot.freeVramMiB)}`,
    `imports ${snapshot.imports}`,
    `editors ${snapshot.editors === null ? '?' : snapshot.editors}`,
    `lock ${snapshot.lock}`,
    `req ${snapshot.requests}`,
    `overflow ${snapshot.overflows}`,
    `trunc ${snapshot.truncations}`,
    `text-calls ${snapshot.textToolCalls}`,
  ];
  const tone = statusTone(snapshot);
  return `${paintTone(paint, 'dim', formatClock(snapshot.at))} ${paintTone(paint, tone, fields.join(' | '))}`;
}

/**
 * @param {StatusSnapshot} snapshot
 * @returns {Tone}
 */
export function statusTone(snapshot) {
  if (!snapshot.guardVerdict.startsWith('pass')) return 'bad';
  if (snapshot.truncations > 0 || snapshot.overflows > 0 || snapshot.textToolCalls > 0) return 'warn';
  if (snapshot.guardVerdict !== 'pass') return 'warn';
  return 'plain';
}

/**
 * @param {StatusSnapshot} snapshot
 * @returns {string}
 */
function describeGuard(snapshot) {
  if (!snapshot.guardVerdict.startsWith('pass')) return `${snapshot.guardVerdict} (${snapshot.guardReason ?? 'unknown'})`;
  if (!snapshot.modelLoaded) return `${snapshot.guardVerdict} (not loaded)`;
  const context = snapshot.modelContextLength === null ? 'loaded' : `loaded ${formatTokens(snapshot.modelContextLength)}`;
  if (snapshot.modelExpiresInSec === null) return `${snapshot.guardVerdict} (${context})`;
  const left = snapshot.modelExpiresInSec === Infinity ? 'no timeout' : `${formatDuration(snapshot.modelExpiresInSec)} left`;
  return `${snapshot.guardVerdict} (${context}, ${left})`;
}

/**
 * @typedef {object} TruncationNotice
 * @property {string | null} time
 * @property {number} limit
 * @property {number} prompt
 * @property {number} kept
 * @property {string} text      Ready to print.
 */

/**
 * @typedef {object} TruncationWatcher
 * @property {() => Promise<TruncationNotice[]>} poll   Notices since the previous poll.
 * @property {(notices: readonly TruncationNotice[], options: { paint: Painter }) => string[]} render
 */

/**
 * Follows a log source for truncation lines. A source that is not a file - the systemd journal, or a
 * server started by hand - yields nothing rather than pretending it was checked (spec 33.8).
 * @param {object} options
 * @param {import('../core/paths.js').LogSource} options.source
 * @param {(filePath: string) => import('../ollama/server-log.js').LogFollower} [options.createFollower]
 * @returns {TruncationWatcher}
 */
export function createTruncationWatcher({ source, createFollower = (filePath) => createLogFollower(filePath) }) {
  const follower = source.kind === 'file' ? createFollower(source.path) : null;
  return {
    async poll() {
      if (follower === null) return [];
      /** @type {string[]} */
      let lines;
      try {
        lines = await follower.poll();
      } catch {
        // A log that cannot be read right now is a diagnostic gap, never a reason to stop the watch.
        return [];
      }
      return readTruncations(lines.join('\n'));
    },
    render(notices, { paint }) {
      return notices.map((notice) => paintTone(paint, 'warn', notice.text));
    },
  };
}

/**
 * @param {string} text
 * @returns {TruncationNotice[]}
 */
export function readTruncations(text) {
  return parseServerLog(text).truncations.map((entry) => ({
    time: entry.time,
    limit: entry.limit,
    prompt: entry.prompt,
    kept: entry.kept,
    text: `Ollama cut a prompt of ${entry.prompt} tokens to ${entry.kept} (limit ${entry.limit}); that answer was written without the start of the request`,
  }));
}
