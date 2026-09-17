// Token estimation and prompt-budget math (spec 8.8). Shared by the plugin (Bun, inside OpenCode), the
// CLI and the delegate runner, so it imports nothing. The estimator counts the pieces the Qwen BPE
// tokenizer pre-splits text into and is calibrated at 3.5 characters per Qwen token on C#, JavaScript,
// Markdown, logs, CSV and CJK text. It is an estimate: sessions correct it from real usage.

export const CALIBRATED_CHARS_PER_TOKEN = 3.5;
export const DEFAULT_SAFETY_MARGIN = 0.1;
export const DEFAULT_CALIBRATION_CLAMP = Object.freeze([0.7, 1.4]);

// The tokenizer's own pre-split: a letter run with one optional leading symbol, a single digit, a symbol
// run, or a whitespace run. Every piece costs at least one token, so digits, "12:31:05.123"-style
// punctuation and each indentation run are counted one by one.
const PIECE_PATTERN = /[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const WORD_PART_PATTERN = /[A-Z]{2,}(?![a-z])|[A-Z]?[a-z]+|[A-Z]|[^A-Za-z]+/g;
// Words on lines with Latin-extended letters (Turkish, Polish and similar) split into more tokens.
const LATIN_EXTENDED = /[\u{c0}-\u{24f}]/u;
const LETTER = /\p{L}/u;
const WHITESPACE_ONLY = /^\s+$/;
const CJK_START = 0x2e80;

/**
 * Estimated Qwen tokens for a text, before session calibration and safety margin.
 * @param {string} text
 * @param {{ charsPerToken?: number }} [options]  Below 3.5 makes every estimate more conservative.
 * @returns {number}
 */
export function estimateTextTokens(text, { charsPerToken = CALIBRATED_CHARS_PER_TOKEN } = {}) {
  assertPositive(charsPerToken, 'charsPerToken');
  if (typeof text !== 'string' || text.length === 0) return 0;
  let total = 0;
  let lineEnd = -1;
  let foreignLine = false;
  for (const match of text.matchAll(PIECE_PATTERN)) {
    const index = /** @type {number} */ (match.index);
    if (index > lineEnd) {
      const next = text.indexOf('\n', index);
      lineEnd = next < 0 ? text.length : next;
      foreignLine = LATIN_EXTENDED.test(text.slice(index, lineEnd));
    }
    total += estimatePieceTokens(match[0], foreignLine);
  }
  return Math.ceil((total * CALIBRATED_CHARS_PER_TOKEN) / charsPerToken);
}

/**
 * Estimated tokens for text known only by its length, as the plugin records it.
 * @param {number} charCount
 * @param {{ charsPerToken?: number }} [options]
 * @returns {number}
 */
export function estimateCharTokens(charCount, { charsPerToken = CALIBRATED_CHARS_PER_TOKEN } = {}) {
  assertPositive(charsPerToken, 'charsPerToken');
  if (!Number.isFinite(charCount) || charCount <= 0) return 0;
  return Math.ceil(charCount / charsPerToken);
}

/**
 * @typedef {object} PromptEstimateInput
 * @property {number} [systemChars]
 * @property {number} [historyChars]
 * @property {number} [toolsTokens]     Measured by a capture or a default allowance; already in tokens.
 * @property {number} [charsPerToken]
 * @property {number} [calibration]     Session factor from real usage; 1 until the first response.
 * @property {number} [safetyMargin]
 */

/**
 * `estimate = (tokens(system) + tokens(history)) * calibration + toolsTokens`, then the safety margin on
 * top. The calibration factor corrects only the character-based part, because it is learned from how
 * far character estimates were off; tool tokens are counted, not estimated from characters.
 * @param {PromptEstimateInput} input
 * @returns {number}
 */
export function estimatePromptTokens({
  systemChars = 0,
  historyChars = 0,
  toolsTokens = 0,
  charsPerToken = CALIBRATED_CHARS_PER_TOKEN,
  calibration = 1,
  safetyMargin = DEFAULT_SAFETY_MARGIN,
}) {
  assertPositive(calibration, 'calibration');
  assertNonNegative(safetyMargin, 'safetyMargin');
  assertNonNegative(toolsTokens, 'toolsTokens');
  const charTokens = estimateCharTokens(systemChars, { charsPerToken }) + estimateCharTokens(historyChars, { charsPerToken });
  // The epsilon keeps floating-point noise (6400 * 1.1 = 7040.000000000001) from adding a token.
  return Math.ceil((charTokens * calibration + toolsTokens) * (1 + safetyMargin) - 1e-9);
}

/**
 * The preflight prompt budget: what is left of the context after the output limit and a reserve
 * (16,384 - 4,096 - 512 = 11,776 for the 16K preset).
 * @param {{ context: number, output: number, reserveTokens: number }} limits
 * @returns {number}
 */
export function getPromptBudget({ context, output, reserveTokens }) {
  for (const [name, value] of Object.entries({ context, output, reserveTokens })) assertNonNegative(value, name);
  return context - output - reserveTokens;
}

/**
 * @typedef {object} BudgetCheck
 * @property {number} estimate
 * @property {number} promptBudget
 * @property {boolean} overBudget
 * @property {number} overBy        0 when within budget.
 */

/**
 * @param {PromptEstimateInput & { promptBudget: number }} input
 * @returns {BudgetCheck}
 */
export function checkPromptBudget({ promptBudget, ...estimateInput }) {
  const estimate = estimatePromptTokens(estimateInput);
  const overBy = Math.max(0, estimate - promptBudget);
  return { estimate, promptBudget, overBudget: overBy > 0, overBy };
}

/**
 * @param {number} factor
 * @param {readonly number[]} [clamp]
 * @returns {number}
 */
export function clampCalibration(factor, clamp = DEFAULT_CALIBRATION_CLAMP) {
  const [low, high] = clamp;
  if (!(low > 0) || !(high >= low)) throw new RangeError(`calibration clamp must be [low, high] with 0 < low <= high, got [${low}, ${high}]`);
  if (!Number.isFinite(factor)) return 1;
  return Math.min(high, Math.max(low, factor));
}

/**
 * The next session calibration factor: how many real prompt tokens one estimated token turned out to
 * be. Estimates without margin are compared, and nonsense inputs keep the previous factor.
 * @param {{ estimatedTokens: number, actualTokens: number, previous?: number, clamp?: readonly number[] }} input
 * @returns {number}
 */
export function updateCalibration({ estimatedTokens, actualTokens, previous = 1, clamp = DEFAULT_CALIBRATION_CLAMP }) {
  if (!(estimatedTokens > 0) || !(actualTokens > 0) || !Number.isFinite(estimatedTokens) || !Number.isFinite(actualTokens)) {
    return clampCalibration(previous, clamp);
  }
  return clampCalibration(actualTokens / estimatedTokens, clamp);
}

/**
 * The prompt length Ollama cuts an oversized prompt down to when context shift is on: it keeps num_keep
 * tokens plus the tail, limit = numCtx - max((numCtx - numKeep) / 2, 1) (OL llm/llama_server.go
 * L322-331). 8,194 at 16K and 16,386 at 32K with num_keep 4.
 * @param {number} numCtx
 * @param {number} numKeep
 * @returns {number}
 */
export function getTruncationLimit(numCtx, numKeep) {
  if (!Number.isSafeInteger(numCtx) || !Number.isSafeInteger(numKeep)) throw new TypeError('numCtx and numKeep must be integers');
  if (numCtx <= 1) return 0;
  const keep = Math.max(0, Math.min(numKeep, numCtx - 1));
  return numCtx - Math.max(Math.floor((numCtx - keep) / 2), 1);
}

/**
 * True when a response's prompt token count shows the prompt was truncated: exactly the truncation limit,
 * or at least numCtx - 1 (the largest prompt Ollama sends unchanged).
 * @param {{ inputTokens: number, numCtx: number, numKeep: number }} input
 * @returns {boolean}
 */
export function isTruncationSignature({ inputTokens, numCtx, numKeep }) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) return false;
  return inputTokens === getTruncationLimit(numCtx, numKeep) || inputTokens >= numCtx - 1;
}

/**
 * @param {string} piece
 * @param {boolean} foreignLine
 * @returns {number}
 */
function estimatePieceTokens(piece, foreignLine) {
  const first = piece.charCodeAt(0);
  if (piece.length === 1 && first >= 48 && first <= 57) return 1;
  if (WHITESPACE_ONLY.test(piece)) return 1;
  if (LETTER.test(piece)) return estimateWordTokens(piece, foreignLine);
  let ascii = 0;
  let other = 0;
  for (const char of piece.replace(/^ /, '').replace(/[\r\n]+$/, '')) {
    if (/** @type {number} */ (char.codePointAt(0)) < 0x80) ascii += 1;
    else other += 1;
  }
  return other + (ascii === 0 ? 0 : ascii <= 3 ? 1 : ascii * 0.5);
}

/**
 * @param {string} piece
 * @param {boolean} foreignLine
 * @returns {number}
 */
function estimateWordTokens(piece, foreignLine) {
  const lead = piece[0];
  const hasLead = !LETTER.test(lead);
  const body = hasLead ? piece.slice(1) : piece;
  // A leading space merges into the word; path separators rarely do; other symbols sometimes do.
  let tokens = !hasLead || lead === ' ' ? 0 : lead === '\\' ? 1.5 : /[/-]/.test(lead) ? 1 : 0.2;
  if (hasLead && lead.charCodeAt(0) >= 0x80) tokens += 0.8;
  // Hex digests split into short letter runs that barely merge.
  if (lead !== ' ' && /^[a-f]{3,}$/.test(body)) return tokens + Math.max(1, body.length / 2.5);
  for (const part of body.match(WORD_PART_PATTERN) ?? []) {
    if (!/[A-Za-z]/.test(part)) {
      // CJK characters are about one token each; accented and other letters merge a little more.
      for (const char of part) tokens += /** @type {number} */ (char.codePointAt(0)) >= CJK_START ? 1 : 0.8;
    } else if (part.length > 1 && part === part.toUpperCase()) {
      tokens += Math.max(1, part.length / 3);
    } else {
      tokens += foreignLine ? Math.max(1, part.length / 3) : 1 + Math.max(0, part.length - 8) / 6;
    }
  }
  return tokens;
}

/**
 * @param {number} value
 * @param {string} name
 */
function assertPositive(value, name) {
  if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) throw new RangeError(`${name} must be a positive number, got ${value}`);
}

/**
 * @param {number} value
 * @param {string} name
 */
function assertNonNegative(value, name) {
  if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw new RangeError(`${name} must be a non-negative number, got ${value}`);
}
