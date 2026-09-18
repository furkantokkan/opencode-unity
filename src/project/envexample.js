// `.env.example` key names, and never a value (amendment 37.4, 37.9, D-B7, S-BM-1, S-BM-2).
//
// This is the scanner's single credential-adjacent read, so it is a module of its own rather than a
// helper inside a detector: one place to audit, one place the canary test points at. A template file
// is a template by construction - its values are empty or a placeholder - but "usually empty" is not a
// property, so the parser is written so that a value is never sliced out of the line at all. The text
// left of the first `=` is the only substring this module ever takes.
//
// The three spellings are the three the read budget allows past SPEC 8.5.2's `*.env.*` deny, and they
// are allowed there for exactly this function. Every other `.env` spelling is refused before a handle
// is opened, so a detector cannot reach one by mistake.
import { evidenceRow } from './signatures.js';

/** In preference order: the first one present is the one read. */
export const ENV_EXAMPLE_FILES = Object.freeze(['.env.example', '.env.sample', '.env.template']);

/** 37.10's `database.maxEnvExampleKeys`. A key list is a landmark, not an inventory. */
export const MAX_ENV_EXAMPLE_KEYS = 12;

/** A shell-style name. A line whose left side is not one of these is not a key assignment. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `export KEY=` is valid in the same file, so the prefix is dropped before the name is validated. */
const EXPORT_PREFIX = /^export\s+/;

/**
 * @typedef {object} EnvExampleFacts
 * @property {boolean} present
 * @property {string | null} file       POSIX, relative to the workspace root.
 * @property {string[]} keys            Sorted, deduplicated, at most `maxKeys`.
 * @property {number} total             Distinct key names found, before the cap. A count, not a list.
 * @property {boolean} truncated        `total` exceeded `maxKeys`.
 * @property {import('./signatures.js').EvidenceEntry[]} evidence
 */

/**
 * @returns {EnvExampleFacts}
 */
function emptyFacts() {
  return { present: false, file: null, keys: [], total: 0, truncated: false, evidence: [] };
}

/**
 * Reads the key names of the first environment template present in `dir`.
 * The three names are asked for by name rather than looked up in the discovery walk: the walk skips
 * every hidden entry, exactly as SPEC 9.1's does, so a dot-file is never in its list. A name that does
 * not exist costs no budget - the read is refused at the stat.
 * @param {import('./budget.js').ReadBudget} budget
 * @param {{ dir?: string, component?: string, maxKeys?: number }} [options]
 * @returns {EnvExampleFacts}
 */
export function readEnvExampleKeys(budget, { dir = '', component = 'env', maxKeys = MAX_ENV_EXAMPLE_KEYS } = {}) {
  const facts = emptyFacts();
  for (const name of ENV_EXAMPLE_FILES) {
    const relativePath = dir === '' ? name : `${dir}/${name}`;
    const read = budget.readText(relativePath, { component });
    if (read.status !== 'ok') continue;

    const keys = parseKeyNames(read.text ?? '');
    facts.present = true;
    facts.file = relativePath;
    facts.total = keys.length;
    facts.truncated = keys.length > maxKeys;
    facts.keys = keys.slice(0, Math.max(0, maxKeys));
    // The rule that makes this read legal is this product's own, so it is what the evidence names.
    facts.evidence.push(evidenceRow('env-keys', 'spec:37.9', relativePath));
    return facts;
  }
  return facts;
}

/**
 * The whole secrecy property of this module is in this function: `slice(0, separator)` is the only
 * substring taken from a line, so the value side is never bound to anything, not even to a discarded
 * local. A key is kept only when the left side is a shell-style name, which also drops continuation
 * lines of a quoted multi-line value.
 * @param {string} text
 * @returns {string[]} Sorted, deduplicated key names.
 */
export function parseKeyNames(text) {
  /** @type {Set<string>} */
  const keys = new Set();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).replace(EXPORT_PREFIX, '').trim();
    if (KEY_PATTERN.test(name)) keys.add(name);
  }
  return [...keys].sort();
}
