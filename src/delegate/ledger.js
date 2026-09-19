// The delegate ledger: one JSON line per finished job at `<home>/state/delegate/ledger.jsonl`
// (spec 6.1, 12.2). It answers "what did the local model actually do for me" without keeping any
// prompt, file content or answer: paths and counters only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { usageError } from '../cli/exit-codes.js';
import { USABLE_STATUSES } from './results.js';

/**
 * @typedef {object} LedgerEntry
 * @property {string} jobId
 * @property {string} command
 * @property {string} cwd
 * @property {number} fileCount
 * @property {number} localInputChars   Characters of file text the local model read.
 * @property {number} summaryChars      Characters the orchestrator read back.
 * @property {number} promptTokens
 * @property {number} outputTokens
 * @property {number} seconds
 * @property {string} status
 * @property {number | null} exitCode
 * @property {string} timestamp         ISO time.
 */

const DURATION_PATTERN = /^(\d+)(s|m|h|d|w)$/i;
const DURATION_MS = Object.freeze({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 });

/**
 * `--since` takes a duration such as `7d` or an ISO date such as `2026-09-01`.
 * @param {string | undefined} since
 * @param {{ now?: () => number }} [options]
 * @returns {number} Epoch milliseconds; -Infinity when `since` is missing.
 */
export function parseSince(since, { now = Date.now } = {}) {
  if (since === undefined || since === '') return Number.NEGATIVE_INFINITY;
  const duration = DURATION_PATTERN.exec(since.trim());
  if (duration) return now() - Number(duration[1]) * DURATION_MS[/** @type {'d'} */ (duration[2].toLowerCase())];
  const parsed = Date.parse(since);
  if (Number.isFinite(parsed)) return parsed;
  throw usageError(`--since takes a duration such as '7d' or an ISO date such as '2026-09-01', got '${since}'`);
}

/**
 * @param {string} ledgerPath
 * @param {LedgerEntry} entry
 * @returns {Promise<void>}
 */
export async function appendLedger(ledgerPath, entry) {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * @param {string} text
 * @returns {LedgerEntry[]}
 */
export function parseLedger(text) {
  /** @type {LedgerEntry[]} */
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn last line after a crash, or a hand-edited one: skip it instead of failing the report.
    }
  }
  return entries;
}

/**
 * @param {string} ledgerPath
 * @returns {Promise<LedgerEntry[]>} Empty when the ledger does not exist yet.
 */
export async function readLedger(ledgerPath) {
  try {
    return parseLedger(await fs.readFile(ledgerPath, 'utf8'));
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * @typedef {object} LedgerSummary
 * @property {string | null} since
 * @property {number} jobs
 * @property {Record<string, { jobs: number, statuses: Record<string, number> }>} byCommand
 * @property {Record<string, number>} byStatus
 * @property {number} promptTokens
 * @property {number} outputTokens
 * @property {number} localInputChars
 * @property {number} summaryChars
 * @property {number} seconds
 * @property {number} estimatedPaidTokensAvoided
 * @property {number} estimatedInputTokensAvoided
 * @property {number} usableLocalTokens
 * @property {string} estimateNote
 */

/**
 * Estimate source-text reduction, not cloud billing: subtract the returned summary before dividing
 * by 3.5 characters/token. Handoff, verification, caching and model-specific tokenization are not
 * observable here. Local model tokens remain a separate measured counter. Partial or failed jobs
 * receive no source-reduction credit. The old JSON field stays as an API alias.
 * @param {readonly LedgerEntry[]} entries
 * @param {{ since?: string, now?: () => number }} [options]
 * @returns {LedgerSummary}
 */
export function summarizeLedger(entries, { since, now = Date.now } = {}) {
  const sinceMs = parseSince(since, { now });
  /** @type {LedgerSummary} */
  const summary = {
    since: since ?? null,
    jobs: 0,
    byCommand: {},
    byStatus: {},
    promptTokens: 0,
    outputTokens: 0,
    localInputChars: 0,
    summaryChars: 0,
    seconds: 0,
    estimatedPaidTokensAvoided: 0,
    estimatedInputTokensAvoided: 0,
    usableLocalTokens: 0,
    estimateNote: 'estimate: max(0, source characters - summary characters) / 3.5 for completed usable jobs, before handoff and verification overhead; not measured cloud billing or a currency. estimatedPaidTokensAvoided is a legacy alias.',
  };
  for (const entry of entries) {
    const time = Date.parse(entry.timestamp);
    if (!Number.isFinite(time) || time < sinceMs) continue;
    summary.jobs += 1;
    const command = String(entry.command ?? 'unknown');
    const status = String(entry.status ?? 'unknown');
    summary.byCommand[command] ??= { jobs: 0, statuses: {} };
    summary.byCommand[command].jobs += 1;
    summary.byCommand[command].statuses[status] = (summary.byCommand[command].statuses[status] ?? 0) + 1;
    summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;
    const promptTokens = toCount(entry.promptTokens);
    const outputTokens = toCount(entry.outputTokens);
    summary.promptTokens += promptTokens;
    summary.outputTokens += outputTokens;
    summary.localInputChars += toCount(entry.localInputChars);
    summary.summaryChars += toCount(entry.summaryChars);
    summary.seconds += toCount(entry.seconds);
    if (USABLE_STATUSES.includes(status)) summary.usableLocalTokens += promptTokens + outputTokens;
    if (['ok', 'dry_run', 'applied'].includes(status)) {
      summary.estimatedInputTokensAvoided += Math.floor(Math.max(0, toCount(entry.localInputChars) - toCount(entry.summaryChars)) / 3.5);
    }
  }
  summary.seconds = Math.round(summary.seconds * 10) / 10;
  summary.estimatedPaidTokensAvoided = summary.estimatedInputTokensAvoided;
  return summary;
}

/**
 * @param {LedgerSummary} summary
 * @param {string} ledgerPath
 * @returns {string}
 */
export function renderLedgerText(summary, ledgerPath) {
  const lines = [`${summary.jobs} delegate jobs${summary.since ? ` since ${summary.since}` : ''} (${ledgerPath})`];
  for (const [command, data] of Object.entries(summary.byCommand).sort()) {
    const statuses = Object.entries(data.statuses).map(([status, count]) => `${status}=${count}`).join(' ');
    lines.push(`  ${command}: ${data.jobs} (${statuses})`);
  }
  lines.push(
    `local prompt tokens: ${summary.promptTokens}`,
    `local output tokens: ${summary.outputTokens}`,
    `local input characters: ${summary.localInputChars}`,
    `characters returned to the caller: ${summary.summaryChars}`,
    `local model seconds: ${summary.seconds}`,
    `usable local tokens: ${summary.usableLocalTokens}`,
    `source input tokens avoided (estimate): ~${summary.estimatedInputTokensAvoided} - ${summary.estimateNote}`,
  );
  return lines.join('\n');
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
