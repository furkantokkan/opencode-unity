// Retry-pattern safety (spec 7.6, D9). A plain `Error` thrown from a plugin hook becomes an
// `UnknownError` whose *message text* decides whether OpenCode retries the request. So the wording of
// every message this product can emit into that path is a behavioural contract, not prose:
//
// - a stop message that accidentally contains "503" or "unavailable" is retried five times, and the
//   user waits a minute for the same refusal;
// - a retry message that does not match anything is shown once and the session goes idle.
//
// This module is the one checker. It reads the vendored copy of OpenCode 1.18.31's rules, which the
// drift job refreshes, so a rule change is caught by a failing test instead of by a user.
import fs from 'node:fs';

export const RETRY_PATTERNS_URL = new URL('./retry-patterns-1.18.31.json', import.meta.url);

/**
 * @typedef {object} RetryRules
 * @property {string} opencodeVersion
 * @property {Array<{ line: number, source: string, flags: string }>} retryableMessagePatterns
 * @property {Array<{ line: number, value: string, shownAs: string }>} retryableLowercaseSubstrings
 * @property {Record<string, number>} retryPolicy
 */

/** @type {{ rules: RetryRules, patterns: RegExp[], substrings: string[] } | undefined} */
let cached;

/**
 * @returns {RetryRules}
 */
export function loadRetryRules() {
  return loadCompiled().rules;
}

/**
 * The rules that would make OpenCode retry this message, named so a failing test says which word did
 * it. An empty array means the message is treated as final.
 * @param {string} message
 * @returns {string[]}
 */
export function findRetryTriggers(message) {
  const { patterns, substrings } = loadCompiled();
  const lower = message.toLowerCase();
  return [
    ...substrings.filter((value) => lower.includes(value)).map((value) => `substring "${value}"`),
    ...patterns.filter((pattern) => pattern.test(message)).map((pattern) => `pattern /${pattern.source}/`),
  ];
}

/**
 * @param {string} message
 * @returns {boolean}
 */
export function looksRetryable(message) {
  return findRetryTriggers(message).length > 0;
}

/**
 * @param {string} message
 * @param {string} [label]  What the message is, for the failure text.
 * @throws {Error} When OpenCode would retry a message that is meant to stop the session.
 */
export function assertStopSafe(message, label = 'message') {
  const triggers = findRetryTriggers(message);
  if (triggers.length > 0) {
    throw new Error(`The ${label} would be retried by OpenCode ${loadRetryRules().opencodeVersion} (${triggers.join(', ')}): ${message}`);
  }
}

/**
 * @param {string} message
 * @param {string} [label]
 * @throws {Error} When a message meant to be retried matches nothing.
 */
export function assertRetrySafe(message, label = 'message') {
  if (findRetryTriggers(message).length === 0) {
    throw new Error(`The ${label} matches no retry rule of OpenCode ${loadRetryRules().opencodeVersion}, so it would stop the session: ${message}`);
  }
}

/**
 * @returns {{ rules: RetryRules, patterns: RegExp[], substrings: string[] }}
 */
function loadCompiled() {
  if (!cached) {
    /** @type {RetryRules} */
    const rules = JSON.parse(fs.readFileSync(RETRY_PATTERNS_URL, 'utf8'));
    cached = {
      rules,
      patterns: rules.retryableMessagePatterns.map((entry) => new RegExp(entry.source, entry.flags)),
      substrings: rules.retryableLowercaseSubstrings.map((entry) => entry.value),
    };
  }
  return cached;
}
