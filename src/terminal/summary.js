// The session summary of spec 13.4, printed when the OpenCode child exits.
//
// Everything it reports comes from the plugin's own session log (`<home>/state/sessions/<day>.jsonl`),
// which holds metadata only: counts, token numbers, verdict ids and durations, never prompt text or a
// path (P5, P16). So the summary can be pasted into an issue as it is printed.
//
// A missing, empty or damaged log is not an error. The summary is a courtesy at the end of a session
// that has already happened; refusing to print it would help nobody.
//
// Extension seam: S41 adds one shaping line here, from records the shaping lane appends.
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { formatTokens } from '../opencode/effective-config.js';
import { formatDuration, joinFields, padLabel, paintTone } from './format.js';

/** @typedef {import('./format.js').Tone} Tone */
/** @typedef {import('../cli/output.js').Painter} Painter */
/** @typedef {Record<string, string | number | boolean>} SessionRecord */

/** Printed after the summary: the one action that gives the video memory back (spec 13.1 step 10). */
export const STOP_HINT = 'Run `opencode-unity stop` to free VRAM before heavy Unity work.';

/**
 * @typedef {object} SessionSummary
 * @property {number} requests
 * @property {number | null} maxEstimatedPromptTokens
 * @property {number | null} maxActualPromptTokens
 * @property {number} overflows
 * @property {Array<{ reason: string, count: number }>} guardBlocks   Most frequent first.
 * @property {number} truncations
 * @property {number} textToolCalls
 * @property {number | null} firstLoadSeconds
 * @property {number} records                                        Records inside the window.
 */

/**
 * @param {Iterable<SessionRecord>} records
 * @returns {SessionSummary}
 */
export function summarizeSession(records) {
  /** @type {Map<string, number>} */
  const blocks = new Map();
  const summary = {
    requests: 0,
    maxEstimatedPromptTokens: /** @type {number | null} */ (null),
    maxActualPromptTokens: /** @type {number | null} */ (null),
    overflows: 0,
    guardBlocks: /** @type {Array<{ reason: string, count: number }>} */ ([]),
    truncations: 0,
    textToolCalls: 0,
    firstLoadSeconds: /** @type {number | null} */ (null),
    records: 0,
  };

  for (const record of records) {
    summary.records += 1;
    summary.maxEstimatedPromptTokens = keepMax(summary.maxEstimatedPromptTokens, record.estimate);
    summary.maxActualPromptTokens = keepMax(summary.maxActualPromptTokens, record.inputTokens);
    switch (record.event) {
      case 'request':
        summary.requests += 1;
        break;
      case 'overflow':
        summary.overflows += 1;
        break;
      case 'truncation':
        summary.truncations += 1;
        break;
      case 'textToolCall':
        summary.textToolCalls += 1;
        break;
      case 'guardBlock':
        blocks.set(readReason(record), (blocks.get(readReason(record)) ?? 0) + 1);
        break;
      // S08 does not record a load duration yet; the field is filled the moment it does.
      case 'firstLoad':
        summary.firstLoadSeconds = typeof record.seconds === 'number' ? record.seconds : summary.firstLoadSeconds;
        break;
      default:
        break;
    }
  }
  summary.guardBlocks = [...blocks.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
  return summary;
}

/**
 * @param {SessionSummary} summary
 * @param {{ paint: Painter, durationMs?: number }} options
 * @returns {string[]}
 */
export function renderSummary(summary, { paint, durationMs }) {
  if (summary.records === 0) return [paintTone(paint, 'dim', `${padLabel('session')}no plugin records for this session window`)];
  /** @type {Array<{ label: string, text: string, tone: Tone }>} */
  const rows = [
    {
      label: 'session',
      text: joinFields([
        `${summary.requests} request${summary.requests === 1 ? '' : 's'}`,
        durationMs === undefined ? null : `in ${formatDuration(durationMs / 1000)}`,
        summary.firstLoadSeconds === null ? null : `first load ${formatDuration(summary.firstLoadSeconds)}`,
      ]),
      tone: 'plain',
    },
    {
      label: 'prompt',
      text: joinFields([
        `max estimated ${summary.maxEstimatedPromptTokens === null ? 'not recorded' : formatTokens(summary.maxEstimatedPromptTokens)}`,
        `actual ${summary.maxActualPromptTokens === null ? 'not recorded' : formatTokens(summary.maxActualPromptTokens)}`,
        `compaction overflows ${summary.overflows}`,
      ]),
      tone: summary.overflows > 0 ? 'warn' : 'plain',
    },
    {
      label: 'guard',
      text: summary.guardBlocks.length === 0
        ? 'no blocks'
        : summary.guardBlocks.map((block) => `${block.reason} x${block.count}`).join(', '),
      tone: summary.guardBlocks.length === 0 ? 'plain' : 'warn',
    },
    {
      label: 'signals',
      text: joinFields([`truncated prompts ${summary.truncations}`, `text-form tool calls ${summary.textToolCalls}`]),
      tone: summary.truncations > 0 || summary.textToolCalls > 0 ? 'warn' : 'plain',
    },
  ];
  return rows.map((row) => paintTone(paint, row.tone, `${padLabel(row.label)}${row.text}`));
}

/**
 * Reads the session log files a window can touch. A window never spans more than two days in practice,
 * but the reader takes every file in range so a session started before midnight is complete.
 * @param {object} options
 * @param {string} options.sessionsDir
 * @param {number} options.sinceMs            Only records at or after this instant.
 * @param {number} [options.untilMs]
 * @param {Pick<typeof fsPromises, 'readdir' | 'readFile'>} [options.fs]
 * @returns {Promise<SessionRecord[]>}
 */
export async function readSessionRecords({ sessionsDir, sinceMs, untilMs = Number.POSITIVE_INFINITY, fs = fsPromises }) {
  /** @type {string[]} */
  let names;
  try {
    names = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }
  const days = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  /** @type {SessionRecord[]} */
  const records = [];
  for (const name of days) {
    if (!isDayInRange(name, sinceMs, untilMs)) continue;
    let text;
    try {
      text = await fs.readFile(path.join(sessionsDir, name), 'utf8');
    } catch {
      continue;
    }
    for (const record of parseSessionLines(String(text))) {
      const at = typeof record.at === 'string' ? Date.parse(record.at) : Number.NaN;
      if (Number.isNaN(at) || (at >= sinceMs && at <= untilMs)) records.push(record);
    }
  }
  return records;
}

/**
 * One object per line; a line that is not an object is skipped, because a partially written last line
 * is normal while a session is running.
 * @param {string} text
 * @returns {SessionRecord[]}
 */
export function parseSessionLines(text) {
  /** @type {SessionRecord[]} */
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const value = JSON.parse(trimmed);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) records.push(value);
    } catch {
      continue;
    }
  }
  return records;
}

/**
 * A day file is in range when any instant of that UTC day is, which is what its name encodes.
 * @param {string} name
 * @param {number} sinceMs
 * @param {number} untilMs
 * @returns {boolean}
 */
function isDayInRange(name, sinceMs, untilMs) {
  const start = Date.parse(`${name.slice(0, 10)}T00:00:00.000Z`);
  return start + 86400000 > sinceMs && start <= untilMs;
}

/**
 * @param {number | null} current
 * @param {unknown} value
 * @returns {number | null}
 */
function keepMax(current, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return current;
  return current === null ? value : Math.max(current, value);
}

/**
 * @param {SessionRecord} record
 * @returns {string}
 */
function readReason(record) {
  return typeof record.reason === 'string' && record.reason !== '' ? record.reason : 'unknown';
}
