// The readiness check of prompt shaping (amendment 36.3), minus the part that needs the project.
//
// Pure: text and settings in, a verdict out, no I/O. The gates run in the spec's order and the first
// one that fires decides: G-a (too short, a usage error), G-b (too long), G-c (a denied intent), G-d
// (shaping switched off). After them, R1 asks for an action verb here, and R2 - an anchor that resolves
// against the project - is answered by anchors.js, because it is the one check that needs the files.
// index.js joins the two.
//
// Only two hard signals decide readiness on purpose (D-SH1): everything else ("is the outcome
// observable?") is a judgement, and gating on a judgement would call the model on nearly every request.
import { CliError, EXIT } from '../cli/exit-codes.js';
import { findDeniedIntent } from './intent-deny.js';

/**
 * @typedef {'auto' | 'off' | 'always'} ShapeMode
 */

/**
 * @typedef {object} ShapeSettings
 * @property {ShapeMode} mode
 * @property {number} maxInputChars
 * @property {number} maxOutputTokens
 * @property {number} timeoutSec
 * @property {number} anchorCandidates
 * @property {number} grepTimeoutMs
 */

/**
 * The `shape` block of amendment 36.8. `config.json` gains it with the schemaVersion 2 migration; until a
 * config carries it these are the values, and afterwards the config's own values win key by key.
 * `temperature` is deliberately absent: a shaping call that is not deterministic is not worth having.
 * @type {Readonly<ShapeSettings>}
 */
export const SHAPE_DEFAULTS = Object.freeze({
  mode: 'auto',
  maxInputChars: 2000,
  maxOutputTokens: 256,
  timeoutSec: 60,
  anchorCandidates: 5,
  grepTimeoutMs: 2000,
});

export const SHAPE_MODES = Object.freeze(/** @type {const} */ (['auto', 'off', 'always']));

/** G-a: a request shorter than this, once trimmed, is nothing to shape. */
export const MIN_REQUEST_CHARS = 3;

/** R5: more asks than this in one request earn a note - never a split, never a plan. */
export const MAX_OUTCOMES_WITHOUT_NOTE = 3;

/**
 * R1. English on purpose: a request in another language never matches, is always shaped, and the rewrite
 * returns English - every artefact this product writes is English. Base forms only, plus the three
 * question words that ask for an explanation, which is an operation too.
 * @type {ReadonlySet<string>}
 */
export const ACTION_VERBS = new Set([
  'add', 'adjust', 'align', 'allow', 'animate', 'assert', 'avoid', 'bind', 'block', 'build', 'bump', 'cache',
  'calculate', 'call', 'catch', 'change', 'check', 'clamp', 'clean', 'clear', 'compute', 'convert', 'copy',
  'correct', 'count', 'cover', 'create', 'debug', 'decouple', 'decrease', 'delete', 'deserialize', 'destroy',
  'detect', 'disable', 'document', 'draw', 'drop', 'emit', 'enable', 'ensure', 'expand', 'explain', 'expose',
  'extend', 'extract', 'find', 'fix', 'format', 'generate', 'guard', 'handle', 'hide', 'implement', 'improve',
  'increase', 'initialize', 'inject', 'inline', 'inspect', 'investigate', 'keep', 'limit', 'list', 'load',
  'localize', 'lock', 'log', 'look', 'make', 'map', 'measure', 'migrate', 'mock', 'move', 'normalize',
  'optimise', 'optimize', 'parse', 'pass', 'pause', 'pool', 'port', 'prevent', 'print', 'profile', 'raise',
  'read', 'rebuild', 'reduce', 'refactor', 'register', 'reject', 'remove', 'rename', 'render', 'reorder',
  'replace', 'report', 'reset', 'resolve', 'restore', 'resume', 'retry', 'return', 'reuse', 'review',
  'rework', 'rewrite', 'rotate', 'save', 'scale', 'serialize', 'set', 'show', 'simplify', 'skip', 'sort',
  'speed', 'split', 'spawn', 'stop', 'store', 'stub', 'subscribe', 'support', 'swap', 'test', 'throttle',
  'throw', 'toggle', 'trace', 'track', 'translate', 'trim', 'tweak', 'unify', 'unregister', 'unsubscribe',
  'update', 'use', 'validate', 'verify', 'wire', 'wrap', 'write',
  'why', 'how', 'where',
]);

/**
 * Words that carry no content: skipped as anchor tokens, and not counted by the word-overlap check of
 * validate.js (V-SH9).
 * @type {ReadonlySet<string>}
 */
export const STOP_WORDS = new Set([
  'a', 'about', 'after', 'again', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'because',
  'been', 'before', 'being', 'both', 'but', 'by', 'can', 'could', 'did', 'does', 'doing', 'done', 'each',
  'every', 'for', 'from', 'get', 'got', 'had', 'has', 'have', 'here', 'into', 'is', 'it', 'its', 'just',
  'like', 'more', 'most', 'much', 'must', 'my', 'need', 'needs', 'new', 'no', 'not', 'now', 'of', 'off',
  'on', 'once', 'one', 'only', 'onto', 'or', 'our', 'out', 'over', 'per', 'please', 'same', 'should', 'so',
  'some', 'still', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'to', 'too', 'under', 'up', 'us', 'very', 'via', 'was', 'we', 'were', 'what',
  'when', 'which', 'while', 'who', 'will', 'with', 'within', 'without', 'would', 'you', 'your',
]);

/**
 * @typedef {object} GateResult
 * @property {'usage' | 'passthrough' | 'open'} outcome
 * @property {'too_long' | 'denied_intent' | 'disabled' | null} reason
 * @property {import('./intent-deny.js').DeniedIntent | null} denied
 */

/**
 * @typedef {object} RequestToken
 * @property {string} text      As written, without surrounding punctuation.
 * @property {boolean} quoted   Written inside quotes or backticks.
 */

/**
 * @typedef {object} Readiness
 * @property {boolean} hasVerb     R1.
 * @property {RequestToken[]} tokens  Candidate anchors, in request order, without duplicates.
 * @property {number} outcomes     R5: how many separate asks the request lists.
 */

/**
 * Settings from the loaded config. Unknown or mistyped values never reach here once the config schema
 * carries the block; until then only the keys this module knows are taken.
 * @param {{ shape?: unknown } | null | undefined} config
 * @returns {ShapeSettings}
 */
export function resolveShapeSettings(config) {
  const block = config?.shape;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return { ...SHAPE_DEFAULTS };
  const source = /** @type {Record<string, unknown>} */ (block);
  const mode = SHAPE_MODES.includes(/** @type {ShapeMode} */ (source.mode)) ? /** @type {ShapeMode} */ (source.mode) : SHAPE_DEFAULTS.mode;
  return {
    mode,
    maxInputChars: readPositiveInteger(source.maxInputChars, SHAPE_DEFAULTS.maxInputChars),
    maxOutputTokens: readPositiveInteger(source.maxOutputTokens, SHAPE_DEFAULTS.maxOutputTokens),
    timeoutSec: readPositiveInteger(source.timeoutSec, SHAPE_DEFAULTS.timeoutSec),
    anchorCandidates: readPositiveInteger(source.anchorCandidates, SHAPE_DEFAULTS.anchorCandidates),
    grepTimeoutMs: readPositiveInteger(source.grepTimeoutMs, SHAPE_DEFAULTS.grepTimeoutMs),
  };
}

/**
 * G-a as an error: exit 1, the one hard stop besides Ctrl+C.
 * @param {unknown} text
 * @returns {asserts text is string}
 */
export function assertShapeableText(text) {
  if (typeof text === 'string' && text.trim().length >= MIN_REQUEST_CHARS) return;
  throw new CliError(`Nothing to shape: a request needs at least ${MIN_REQUEST_CHARS} characters`, {
    exitCode: EXIT.USAGE,
    code: 'usage_error',
    hint: 'Pass the request as text, as @file, or as - to read it from standard input.',
  });
}

/**
 * G-a to G-d, in order. `open` means every gate passed and readiness decides.
 * @param {string} text
 * @param {ShapeSettings} settings
 * @returns {GateResult}
 */
export function checkGates(text, settings) {
  if (typeof text !== 'string' || text.trim().length < MIN_REQUEST_CHARS) return { outcome: 'usage', reason: null, denied: null };
  if (text.length > settings.maxInputChars) return { outcome: 'passthrough', reason: 'too_long', denied: null };
  const denied = findDeniedIntent(text);
  if (denied) return { outcome: 'passthrough', reason: 'denied_intent', denied };
  if (settings.mode === 'off') return { outcome: 'passthrough', reason: 'disabled', denied: null };
  return { outcome: 'open', reason: null, denied: null };
}

/**
 * R1 and R5, and the tokens R2 will try.
 * @param {string} text
 * @returns {Readiness}
 */
export function evaluateReadiness(text) {
  return { hasVerb: hasActionVerb(text), tokens: extractTokens(text), outcomes: countOutcomes(text) };
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function hasActionVerb(text) {
  return splitWords(text).some((word) => ACTION_VERBS.has(word.toLowerCase()));
}

/**
 * R5, counted locally: the list items of a numbered or bulleted request. A request without a list is one
 * outcome, however long it is.
 * @param {string} text
 * @returns {number}
 */
export function countOutcomes(text) {
  let items = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:\d{1,2}[.)]|[-*\u{2022}])\s+\S/u.test(line)) items += 1;
  }
  return Math.max(1, items);
}

/**
 * The words of a text, letters and digits only, in order.
 * @param {string} text
 * @returns {string[]}
 */
export function splitWords(text) {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * The content words of a text, lower-cased: at least four characters, no stop word, and identifiers split
 * at their humps, so `InventoryView` shares `inventory` with "the inventory is broken".
 * @param {string} text
 * @returns {Set<string>}
 */
export function contentWords(text) {
  /** @type {Set<string>} */
  const words = new Set();
  const humped = text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
  for (const word of splitWords(humped)) {
    const lower = word.toLowerCase();
    if (lower.length >= 4 && !STOP_WORDS.has(lower)) words.add(lower);
  }
  return words;
}

// A quoted literal: double quotes and backticks anywhere, single quotes only when they are not an
// apostrophe inside a word ("don't", "player's").
const QUOTED_PATTERN = /"([^"\r\n]{2,120})"|`([^`\r\n]{2,120})`|(?<![\p{L}\p{N}])'([^'\s][^'\r\n]{0,118}[^'\s])'(?![\p{L}\p{N}])/gu;
const EDGE_PUNCTUATION = /^[\s"'`([{<@#]+|[\s"'`)\]}>,;:!?.]+$/g;
const MIN_TOKEN_CHARS = 3;

/**
 * Tokens that may name a place in the project, in request order and without duplicates. Stop words and
 * action verbs are skipped unless the token is shaped like an identifier or a path, because "fix" is
 * never a file but `Cache.cs` might be.
 * @param {string} text
 * @returns {RequestToken[]}
 */
export function extractTokens(text) {
  /** @type {RequestToken[]} */
  const tokens = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} raw @param {boolean} quoted */
  const add = (raw, quoted) => {
    // A quoted literal is kept as written: `Refresh()` is worth searching for with its parentheses.
    const value = quoted ? raw.trim() : raw.replace(EDGE_PUNCTUATION, '');
    if (value.length < MIN_TOKEN_CHARS || seen.has(value)) return;
    const lower = value.toLowerCase();
    if (!quoted && !isIdentifierShaped(value) && (STOP_WORDS.has(lower) || ACTION_VERBS.has(lower))) return;
    seen.add(value);
    tokens.push({ text: value, quoted });
  };
  const unquoted = text.replace(QUOTED_PATTERN, (_match, double, backtick, single) => {
    add(double ?? backtick ?? single ?? '', true);
    return ' ';
  });
  for (const raw of unquoted.split(/\s+/)) add(raw, false);
  return tokens;
}

/**
 * Shaped like a path, a file name, a dotted name or an identifier with more than one hump: a token worth
 * naming as unresolved when it does not resolve, unlike a plain word.
 * @param {string} token
 * @returns {boolean}
 */
export function isIdentifierShaped(token) {
  return hasSeparator(token) || /\.[A-Za-z][A-Za-z0-9]{1,15}$/.test(token) || isMultiHump(token) || isSnakeCase(token);
}

/**
 * @param {string} token
 * @returns {boolean}
 */
export function hasSeparator(token) {
  return token.includes('/') || token.includes('\\');
}

/**
 * `RefreshSlots`, `refreshSlots`, `HTTPClient`: an identifier with at least two humps.
 * @param {string} token
 * @returns {boolean}
 */
export function isMultiHump(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && /[a-z0-9][A-Z]|[A-Z]{2}[a-z]/.test(token);
}

/**
 * @param {string} token
 * @returns {boolean}
 */
export function isSnakeCase(token) {
  return /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(token);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function readPositiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
