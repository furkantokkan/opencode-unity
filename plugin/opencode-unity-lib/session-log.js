// The plugin's session log (spec 6.1, 13.4, P5). One JSON object per line under
// `<home>/state/sessions/YYYY-MM-DD.jsonl`, kept 14 days. `status --watch` and the session summary
// read it; nothing else does.
//
// It holds metadata only: timestamps, counts, token numbers, verdict ids and durations. No prompt
// text, no file content, no paths. `sanitizeRecord` enforces that shape instead of trusting callers,
// because a log that can hold a string can hold a secret.
//
// Every write is best-effort: the log is a diagnostic, and a full disk or a read-only home must never
// fail a session request.
import fsPromises from 'node:fs/promises';
import path from 'node:path';

export const SESSION_LOG_RETENTION_DAYS = 14;
export const SESSION_LOG_MAX_STRING = 120;

/** Field names whose value may be a free string; everything else must be a number or a boolean. */
const TEXT_FIELDS = Object.freeze(['event', 'sessionId', 'agent', 'reason', 'code', 'verdict', 'mode', 'family', 'source', 'model', 'at', 'tool']);

/**
 * @typedef {object} SessionLog
 * @property {(record: Record<string, unknown>) => void} append   Fire and forget; never throws.
 * @property {() => Promise<void>} flush                          Resolves when queued writes finished.
 * @property {string} directory
 */

/**
 * @param {string} home
 * @returns {string}
 */
export function getSessionLogDirectory(home) {
  return path.join(home, 'state', 'sessions');
}

/**
 * @param {string} home
 * @param {Date} date
 * @returns {string}
 */
export function getSessionLogPath(home, date) {
  return path.join(getSessionLogDirectory(home), `${formatDay(date)}.jsonl`);
}

/**
 * Keeps the log free of anything that could carry prompt or file content: unknown keys are dropped,
 * strings outside the known text fields are dropped, and a known string is cut to a readable length.
 * @param {Record<string, unknown>} record
 * @returns {Record<string, string | number | boolean>}
 */
export function sanitizeRecord(record) {
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && TEXT_FIELDS.includes(key)) out[key] = value.slice(0, SESSION_LOG_MAX_STRING);
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} options.home
 * @param {() => Date} [options.now]
 * @param {Pick<typeof fsPromises, 'mkdir' | 'appendFile' | 'readdir' | 'rm'>} [options.fs]
 * @param {(error: unknown) => void} [options.onError]
 * @returns {SessionLog}
 */
export function createSessionLog({ home, now = () => new Date(), fs = fsPromises, onError = () => {} }) {
  const directory = getSessionLogDirectory(home);
  let queue = Promise.resolve();
  let prepared = false;

  /**
   * @param {() => Promise<void>} work
   */
  const enqueue = (work) => {
    queue = queue.then(work).catch(onError);
  };

  return {
    directory,
    append(record) {
      const date = now();
      const line = `${JSON.stringify({ at: date.toISOString(), ...sanitizeRecord(record) })}\n`;
      enqueue(async () => {
        if (!prepared) {
          await fs.mkdir(directory, { recursive: true });
          prepared = true;
          await pruneOldLogs(fs, directory, date).catch(onError);
        }
        await fs.appendFile(path.join(directory, `${formatDay(date)}.jsonl`), line, 'utf8');
      });
    },
    async flush() {
      await queue;
    },
  };
}

/**
 * @param {Pick<typeof fsPromises, 'readdir' | 'rm'>} fs
 * @param {string} directory
 * @param {Date} today
 * @returns {Promise<string[]>} The files that were removed.
 */
export async function pruneOldLogs(fs, directory, today) {
  const cutoff = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - SESSION_LOG_RETENTION_DAYS * 86400000;
  /** @type {string[]} */
  const removed = [];
  const entries = await fs.readdir(directory).catch(() => /** @type {string[]} */ ([]));
  for (const entry of entries) {
    const match = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(entry);
    if (!match) continue;
    const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (day >= cutoff) continue;
    await fs.rm(path.join(directory, entry), { force: true });
    removed.push(entry);
  }
  return removed;
}

/**
 * @param {Date} date
 * @returns {string}
 */
function formatDay(date) {
  return date.toISOString().slice(0, 10);
}
