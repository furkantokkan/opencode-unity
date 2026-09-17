// Ollama server log parser and follower (spec 5.4 doctor logs checks, 7.4 KV type, 13.3 status). It
// keeps metadata only: counts, sizes, sampler values and times. The llama-server command line holds
// local paths, so only its flags are parsed and the line itself is never stored.
import fsp from 'node:fs/promises';
import path from 'node:path';

const SLOG_TIME = /^time=(\S+)/;
const GIN_LINE = /^\[GIN\]\s+(\d{4})\/(\d{2})\/(\d{2})\s+-\s+(\d{2}:\d{2}:\d{2})\s+\|\s+(\d{3})\s+\|\s+(\S+)\s+\|\s+\S*\s+\|\s+([A-Z]+)\s+"([^"]*)"/;
const TRUNCATION = /msg="truncating input prompt"(.*)$/;
const SAMPLER_HEADER = /sampler params:(.*)$/;
const KEY_VALUE = /([a-z_]+)\s*=\s*(-?\d+(?:\.\d+)?)/g;
const KV_CACHE = /^llama_kv_cache\w*:\s+size\s*=\s*([\d.]+)\s*MiB\s*\(\s*(\d+)\s+cells.*?\bK \(([a-z0-9_]+)\).*?\bV \(([a-z0-9_]+)\)/i;
const LAUNCH = /msg="starting llama-server"/;
const LOADED = /msg="llama-server started in ([\d.]+) seconds"/;
const CUDA_ERROR = /\bCUDA error\b/;
const ROTATED_LOG = /^server(?:-(\d+))?\.log$/;

/**
 * @typedef {object} Truncation
 * @property {string | null} time
 * @property {number} limit
 * @property {number} prompt   Tokens before truncation.
 * @property {number} keep
 * @property {number} kept     Tokens after truncation (the log's `new`).
 */

/**
 * @typedef {object} SamplerParams
 * @property {string | null} time
 * @property {number | null} temperature
 * @property {number | null} topP
 * @property {number | null} topK
 * @property {number | null} repeatPenalty
 */

/**
 * @typedef {object} KvCacheLine
 * @property {string | null} time
 * @property {number} sizeMiB
 * @property {number} cells     Equals the context size of the slot.
 * @property {string} keyType   For example `q8_0` or `f16`.
 * @property {string} valueType
 */

/**
 * @typedef {object} RunnerLaunch
 * @property {string | null} time
 * @property {number | null} numCtx
 * @property {string | null} cacheTypeK
 * @property {string | null} cacheTypeV
 * @property {string | null} flashAttention
 * @property {number | null} keep
 */

/**
 * @typedef {object} RequestLine
 * @property {string} time         Local time without a zone, as Ollama writes it.
 * @property {number} status
 * @property {number | null} durationMs
 * @property {string} method
 * @property {string} path
 */

/**
 * @typedef {object} ServerLog
 * @property {Truncation[]} truncations
 * @property {SamplerParams[]} samplers
 * @property {KvCacheLine[]} kvCaches
 * @property {RunnerLaunch[]} launches
 * @property {Array<{ time: string | null, seconds: number }>} loads
 * @property {RequestLine[]} requests
 * @property {Array<{ time: string | null }>} cudaErrors
 */

/**
 * @param {string} text
 * @returns {ServerLog}
 */
export function parseServerLog(text) {
  /** @type {ServerLog} */
  const log = { truncations: [], samplers: [], kvCaches: [], launches: [], loads: [], requests: [], cudaErrors: [] };
  /** @type {string | null} */
  let time = null;
  /** @type {SamplerParams | null} */
  let sampler = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (sampler && /^\s/.test(line) && line.trim() !== '') {
      applySamplerValues(sampler, line);
      continue;
    }
    sampler = null;
    const slogTime = SLOG_TIME.exec(line);
    if (slogTime) time = slogTime[1];
    const gin = GIN_LINE.exec(line);
    if (gin) {
      const [, year, month, day, clock, status, duration, method, route] = gin;
      time = `${year}-${month}-${day}T${clock}`;
      log.requests.push({ time, status: Number(status), durationMs: parseGoDuration(duration), method, path: route });
      continue;
    }
    sampler = parseLine(line, time, log);
  }
  return log;
}

/**
 * @param {string} line
 * @param {string | null} time
 * @param {ServerLog} log
 * @returns {SamplerParams | null} The sampler block this line starts, whose values follow on indented lines.
 */
function parseLine(line, time, log) {
  const truncation = TRUNCATION.exec(line);
  if (truncation) {
    const fields = readNumberFields(truncation[1]);
    if (fields.limit !== undefined && fields.prompt !== undefined) {
      log.truncations.push({ time, limit: fields.limit, prompt: fields.prompt, keep: fields.keep ?? 0, kept: fields.new ?? fields.limit });
    }
    return null;
  }
  const samplerHeader = SAMPLER_HEADER.exec(line);
  if (samplerHeader) {
    /** @type {SamplerParams} */
    const sampler = { time, temperature: null, topP: null, topK: null, repeatPenalty: null };
    applySamplerValues(sampler, samplerHeader[1]);
    log.samplers.push(sampler);
    return sampler;
  }
  const kvCache = KV_CACHE.exec(line);
  if (kvCache) {
    log.kvCaches.push({ time, sizeMiB: Number(kvCache[1]), cells: Number(kvCache[2]), keyType: kvCache[3].toLowerCase(), valueType: kvCache[4].toLowerCase() });
    return null;
  }
  if (LAUNCH.test(line)) {
    log.launches.push({
      time,
      numCtx: readIntegerFlag(line, /\s(?:-c|--ctx-size)\s+(\d+)/),
      cacheTypeK: readWordFlag(line, /\s--cache-type-k\s+([a-z0-9_]+)/i),
      cacheTypeV: readWordFlag(line, /\s--cache-type-v\s+([a-z0-9_]+)/i),
      flashAttention: readWordFlag(line, /\s(?:-fa|--flash-attn)\s+(on|off|auto)\b/i),
      keep: readIntegerFlag(line, /\s--keep\s+(\d+)/),
    });
    return null;
  }
  const loaded = LOADED.exec(line);
  if (loaded) {
    log.loads.push({ time, seconds: Number(loaded[1]) });
    return null;
  }
  if (CUDA_ERROR.test(line)) log.cudaErrors.push({ time });
  return null;
}

/**
 * The KV cache type Ollama last allocated, preferring loads at the given context size. The KV cache line
 * shows what was allocated; the launch flags are the fallback for logs without it.
 * @param {ServerLog} log
 * @param {{ numCtx?: number }} [options]
 * @returns {string | null}
 */
export function findKvCacheType(log, { numCtx } = {}) {
  const byCells = numCtx === undefined ? [] : log.kvCaches.filter((entry) => entry.cells === numCtx);
  const byLaunch = numCtx === undefined ? [] : log.launches.filter((entry) => entry.numCtx === numCtx && entry.cacheTypeK);
  const candidates = [byCells.at(-1)?.keyType, byLaunch.at(-1)?.cacheTypeK, log.kvCaches.at(-1)?.keyType, log.launches.filter((entry) => entry.cacheTypeK).at(-1)?.cacheTypeK];
  return candidates.find((value) => typeof value === 'string' && value !== '') ?? null;
}

/**
 * @typedef {object} ServerLogSummary
 * @property {number} chatCompletionRequests   `/v1/chat/completions` requests.
 * @property {number} truncations
 * @property {{ min: number, median: number, max: number } | null} truncatedPromptTokens
 * @property {number[]} truncationLimits        Distinct limits, ascending.
 * @property {number} samplers
 * @property {number} defaultSamplers           Samplers at temperature 1.0 and top_p 1.0 (spec E3).
 * @property {number} cudaErrors
 * @property {string | null} kvCacheType
 */

/**
 * Counts for doctor's `logs.truncation` and `logs.sampling-default` checks and the status line.
 * @param {ServerLog} log
 * @param {{ numCtx?: number, sinceMs?: number }} [options]  sinceMs keeps entries at or after that time;
 *   entries without a time are kept.
 * @returns {ServerLogSummary}
 */
export function summarizeServerLog(log, { numCtx, sinceMs } = {}) {
  const recent = (/** @type {{ time: string | null }} */ entry) => sinceMs === undefined || entry.time === null || !(Date.parse(entry.time) < sinceMs);
  const truncations = log.truncations.filter(recent);
  const prompts = truncations.map((entry) => entry.prompt).sort((a, b) => a - b);
  const samplers = log.samplers.filter(recent);
  return {
    chatCompletionRequests: log.requests.filter(recent).filter((entry) => entry.path === '/v1/chat/completions').length,
    truncations: truncations.length,
    truncatedPromptTokens: prompts.length === 0 ? null : { min: prompts[0], median: getMedian(prompts), max: /** @type {number} */ (prompts.at(-1)) },
    truncationLimits: [...new Set(truncations.map((entry) => entry.limit))].sort((a, b) => a - b),
    samplers: samplers.length,
    defaultSamplers: samplers.filter((entry) => entry.temperature === 1 && entry.topP === 1).length,
    cudaErrors: log.cudaErrors.filter(recent).length,
    kvCacheType: findKvCacheType(log, { numCtx }),
  };
}

/**
 * The current log and its rotated copies (`server.log`, `server-1.log`, ...), newest first. Missing
 * files are skipped.
 * @param {string} serverLogPath
 * @param {{ readdir?: (dir: string) => Promise<string[]> }} [options]
 * @returns {Promise<string[]>}
 */
export async function listServerLogFiles(serverLogPath, { readdir = (dir) => fsp.readdir(dir) } = {}) {
  const dir = path.dirname(serverLogPath);
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .map((name) => ({ name, match: ROTATED_LOG.exec(name) }))
    .filter((entry) => entry.match)
    .map((entry) => ({ file: path.join(dir, entry.name), order: Number(entry.match?.[1] ?? 0) }))
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.file);
}

/**
 * Reads at most `maxBytes` from the end of a file, dropping a partial first line. Null when missing.
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function readLogTail(filePath, { maxBytes = 8 * 1024 * 1024 } = {}) {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start === 0) return text;
    const newline = text.indexOf('\n');
    return newline === -1 ? '' : text.slice(newline + 1);
  } finally {
    await handle.close();
  }
}

/**
 * @typedef {object} LogFollower
 * @property {() => Promise<string[]>} poll   New complete lines since the last poll.
 */

/**
 * Follows a log without holding it open: every poll opens, reads the new bytes and closes, so Ollama can
 * rotate the file. After a rotation the rest of the old file is read from `server-1.log`, then the new
 * file from its start.
 * @param {string} filePath
 * @param {{ startAtEnd?: boolean, rotatedPath?: string }} [options]
 * @returns {LogFollower}
 */
export function createLogFollower(filePath, { startAtEnd = true, rotatedPath = path.join(path.dirname(filePath), 'server-1.log') } = {}) {
  /** @type {{ identity: string, offset: number } | null} */
  let position = null;
  let pending = '';
  let started = false;

  return {
    async poll() {
      const stat = await statOrNull(filePath);
      if (!started) {
        started = true;
        if (stat && startAtEnd) {
          position = { identity: getIdentity(stat), offset: stat.size };
          return [];
        }
      }
      let text = '';
      if (position && (!stat || getIdentity(stat) !== position.identity)) {
        const rotated = await statOrNull(rotatedPath);
        if (rotated && getIdentity(rotated) === position.identity) text += await readRange(rotatedPath, position.offset, rotated.size);
        if (!stat) {
          position = null;
          return takeLines(text);
        }
        position = null;
      }
      if (!stat) return takeLines(text);
      const identity = getIdentity(stat);
      const offset = position && stat.size >= position.offset ? position.offset : 0;
      text += await readRange(filePath, offset, stat.size);
      position = { identity, offset: stat.size };
      return takeLines(text);
    },
  };

  /**
   * @param {string} text
   * @returns {string[]}
   */
  function takeLines(text) {
    const combined = pending + text;
    const lastNewline = combined.lastIndexOf('\n');
    if (lastNewline === -1) {
      pending = combined;
      return [];
    }
    pending = combined.slice(lastNewline + 1);
    return combined
      .slice(0, lastNewline)
      .split('\n')
      .map((line) => line.replace(/\r$/, ''));
  }
}

/**
 * @param {string} filePath
 * @param {number} start
 * @param {number} end
 * @returns {Promise<string>}
 */
async function readRange(filePath, start, end) {
  if (end <= start) return '';
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return '';
    throw error;
  }
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<import('node:fs').Stats | null>}
 */
async function statOrNull(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * A renamed file keeps its identity; a newly created file at the same path gets a new one.
 * @param {import('node:fs').Stats} stat
 * @returns {string}
 */
function getIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

/**
 * @param {SamplerParams} sampler
 * @param {string} text
 */
function applySamplerValues(sampler, text) {
  for (const [, key, value] of text.matchAll(KEY_VALUE)) {
    const number = Number(value);
    if (key === 'temp') sampler.temperature = number;
    else if (key === 'top_p') sampler.topP = number;
    else if (key === 'top_k') sampler.topK = number;
    else if (key === 'repeat_penalty') sampler.repeatPenalty = number;
  }
}

/**
 * @param {string} text  `key=value` pairs from a slog line.
 * @returns {Record<string, number>}
 */
function readNumberFields(text) {
  /** @type {Record<string, number>} */
  const fields = {};
  for (const [, key, value] of text.matchAll(/\b([a-z_]+)=(\d+)\b/g)) fields[key] = Number(value);
  return fields;
}

/**
 * @param {string} line
 * @param {RegExp} pattern
 * @returns {number | null}
 */
function readIntegerFlag(line, pattern) {
  const match = pattern.exec(line);
  return match ? Number(match[1]) : null;
}

/**
 * @param {string} line
 * @param {RegExp} pattern
 * @returns {string | null}
 */
function readWordFlag(line, pattern) {
  const match = pattern.exec(line);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Go duration text from the request log: `0s`, `133.2324ms`, `1m2.5s`, `500µs`.
 * @param {string} text
 * @returns {number | null}
 */
export function parseGoDuration(text) {
  const units = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, µs: 0.001, us: 0.001, ns: 0.000001 };
  let total = 0;
  let matched = '';
  for (const [part, value, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|µs|us|ns|h|m|s)/g)) {
    total += Number(value) * units[/** @type {keyof typeof units} */ (unit)];
    matched += part;
  }
  return matched === text && text !== '' ? total : null;
}

/**
 * @param {number[]} sorted
 * @returns {number}
 */
function getMedian(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
