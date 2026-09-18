// Reading the Ollama server log, whatever shape it has on this platform (amendment 33.8, R22).
//
// The log is a source, not a path: a rotating file on Windows and macOS, the systemd journal on Linux,
// and nothing at all when the user started `ollama serve` by hand. Truncation history is the single
// most valuable finding on Windows, so a source that cannot be read is reported as `not checked` and
// never as a pass.
import { runProcess } from '../core/exec.js';
import { JOURNAL_OUTPUT_CAT } from '../core/paths.js';
import { parseServerLog, readLogTail, summarizeServerLog } from '../ollama/server-log.js';

/** The journal grows without bound; this is enough lines to cover recent loads without a long read. */
export const JOURNAL_LINES = 4000;
export const JOURNAL_TIMEOUT_MS = 10_000;

/** How far back `logs.truncation` still calls a truncation recent (spec 5.4). */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @typedef {object} LogReading
 * @property {import('../core/paths.js').LogSource} source
 * @property {boolean} read                    False means "not checked", which is never a pass.
 * @property {string | null} unreadableReason
 * @property {string} fix                      The platform's way to make the log readable.
 * @property {import('../ollama/server-log.js').ServerLogSummary | null} summary
 * @property {import('../ollama/server-log.js').ServerLogSummary | null} recent  The last RECENT_WINDOW_MS only.
 * @property {import('../ollama/server-log.js').ServerLog | null} log
 */

/**
 * @param {object} input
 * @param {import('../core/paths.js').LogSource} input.source
 * @param {number} [input.numCtx]
 * @param {AbortSignal} [input.signal]
 * @param {Record<string, string | undefined>} [input.env]
 * @param {NodeJS.Platform} [input.platform]
 * @param {(filePath: string) => Promise<string | null>} [input.readFile]  Null means the file is absent.
 * @param {typeof runProcess} [input.run]
 * @param {number} [input.nowMs]
 * @returns {Promise<LogReading>}
 */
export async function readLogSource({ source, numCtx, signal, env, platform, readFile = (target) => readLogTail(target), run = runProcess, nowMs = Date.now() }) {
  const summarizeAt = (/** @type {string} */ text) => summarize(source, text, numCtx, nowMs);
  if (source.kind === 'none') {
    return unreadable(source, 'no Ollama server log was found on this machine', logFix(source));
  }
  if (source.kind === 'file') {
    try {
      const text = await readFile(source.path);
      return text === null ? unreadable(source, `${source.path} does not exist`, logFix(source)) : summarizeAt(text);
    } catch (cause) {
      return unreadable(source, cause instanceof Error ? cause.message : String(cause), logFix(source));
    }
  }
  const [file, ...args] = source.command.length > 0 ? source.command : ['journalctl'];
  // Message text only, whatever command the source carries: the default `short` prefix would take the
  // timestamp and every sampler line away from the parser, and a Linux doctor would pass `logs.*` falsely.
  const output = args.some((arg) => arg === '-o' || arg.startsWith('--output') || /^-o./.test(arg)) ? [] : [JOURNAL_OUTPUT_CAT];
  const result = await run(file, [...args, ...output, '-n', String(JOURNAL_LINES)], { timeoutMs: JOURNAL_TIMEOUT_MS, signal, env, platform });
  if (result.error !== null) return unreadable(source, result.error.message, logFix(source));
  if (result.timedOut) return unreadable(source, `'${file}' timed out`, logFix(source));
  if (result.exitCode !== 0) return unreadable(source, `'${file}' exited ${result.exitCode}: ${firstLine(result.stderr)}`, logFix(source));
  return summarizeAt(result.stdout);
}

/**
 * @param {import('../core/paths.js').LogSource} source
 * @returns {string}
 */
export function logFix(source) {
  if (source.kind === 'journal') {
    return 'add your user to the systemd-journal group, or pass --logs <path> if Ollama writes to a file here';
  }
  return 'start Ollama so it writes its server log, or pass --logs <path>';
}

/**
 * @param {import('../core/paths.js').LogSource} source
 * @param {string} text
 * @param {number | undefined} numCtx
 * @param {number} nowMs
 * @returns {LogReading}
 */
function summarize(source, text, numCtx, nowMs) {
  const log = parseServerLog(text);
  return {
    source,
    read: true,
    unreadableReason: null,
    fix: logFix(source),
    summary: summarizeServerLog(log, { numCtx }),
    recent: summarizeServerLog(log, { numCtx, sinceMs: nowMs - RECENT_WINDOW_MS }),
    log,
  };
}

/**
 * @param {import('../core/paths.js').LogSource} source
 * @param {string} reason
 * @param {string} fix
 * @returns {LogReading}
 */
function unreadable(source, reason, fix) {
  return { source, read: false, unreadableReason: reason, fix, summary: null, recent: null, log: null };
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

/**
 * @param {import('../core/paths.js').LogSource} source
 * @returns {string}
 */
export function describeLogSource(source) {
  if (source.kind === 'file') return source.path;
  if (source.kind === 'journal') return `the systemd journal (unit ${source.unit})`;
  return 'none';
}
