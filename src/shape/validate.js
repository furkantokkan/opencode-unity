// The validator of the shaping rewrite (amendment 36.4, V-SH1..V-SH9).
//
// "Never invent a file path" and "grant nothing" are enforced here, after the model has answered, rather
// than trusted to the prompt. A rejection is not an error: index.js turns it into a passthrough and the
// developer's original request goes on unchanged. Rules that can repair the answer (an unknown path, an
// over-long question, a shell block) repair it; rules that would have to change its meaning (an
// over-long goal, a goal about something else, a denied intent) reject it.
import fs from 'node:fs';
import { compileSchema, formatSchemaErrors } from '../../plugin/opencode-unity-lib/json-schema.js';
import { findDeniedIntent } from './intent-deny.js';
import { contentWords } from './verdict.js';

export const SHAPE_OUTPUT_SCHEMA_URL = new URL('../../schema/shape-output.schema.json', import.meta.url);

export const FIELD_LIMITS = Object.freeze({ goalChars: 160, doneChars: 160, openChars: 120, maxFiles: 5, maxOpen: 3 });

/** V-SH2's fixed question, appended when a named path was removed. */
export const MISSING_PATH_QUESTION = 'which file should change? (a path was named that does not exist in this project)';

// Line breaks and other control characters would let one field forge a line of the fixed form (a second
// `Keep:`, say); invisible format characters would hide text from the developer who reads the rewrite.
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
const INVISIBLE = /\p{Cf}/gu;
// The two prompt constructs OpenCode resolves outside the permission rules (claim 160): a shell block
// runs a command, and an `@name` attaches a file or redirects the turn to an agent.
const SHELL_BLOCK = /!`[^`]*`?/g;

/**
 * @typedef {object} ShapedFields
 * @property {string} goal
 * @property {string[]} files
 * @property {string | null} search
 * @property {string} done
 * @property {string[]} open
 */

/**
 * @typedef {object} ValidationContext
 * @property {string} request                            The developer's original text.
 * @property {(path: string) => boolean} isIndexMember   V-SH2.
 * @property {(literal: string) => boolean} findLiteral  V-SH3: the bounded grep found it at least once.
 * @property {(path: string) => string | null} findProtectedGlob  V-SH7: the `PROTECTED_EDIT` glob a path matches.
 */

/**
 * @typedef {{ ok: true, fields: ShapedFields, removedPaths: string[], removedProtected: string[], neutralized: boolean }
 *   | { ok: false, reason: 'invalid_output' | 'denied_intent', check: string, detail: string, denied: import('./intent-deny.js').DeniedIntent | null }} ValidationResult
 */

/** @type {import('../../plugin/opencode-unity-lib/json-schema.js').SchemaValidator | undefined} */
let schemaValidator;

/**
 * @returns {Record<string, any>}
 */
export function readShapeOutputSchema() {
  return JSON.parse(fs.readFileSync(SHAPE_OUTPUT_SCHEMA_URL, 'utf8'));
}

/**
 * V-SH1 to V-SH9, in order, over the model's raw answer.
 * @param {string} content
 * @param {ValidationContext} context
 * @returns {ValidationResult}
 */
export function validateShapedOutput(content, context) {
  // V-SH1: JSON that matches the schema, parsed with JSON.parse and never with a pattern over prose.
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return reject('V-SH1', 'the answer is not JSON');
  }
  schemaValidator ??= compileSchema(readShapeOutputSchema());
  const problems = schemaValidator(parsed);
  if (problems.length > 0) return reject('V-SH1', `the answer does not match the schema: ${formatSchemaErrors(problems)}`);
  const raw = /** @type {{ goal: string, files?: string[], search?: string, done: string, open: string[] }} */ (parsed);
  const goal = cleanText(raw.goal);
  const done = cleanText(raw.done);
  if (goal === '' || done === '') return reject('V-SH1', 'goal and done must not be empty');

  // V-SH2: only exact index members; anything else is removed and never corrected.
  /** @type {string[]} */
  const removedPaths = [];
  /** @type {string[]} */
  let files = [];
  for (const entry of raw.files ?? []) {
    const path = cleanText(entry).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    if (path === '' || files.includes(path)) continue;
    if (context.isIndexMember(path)) files.push(path);
    else removedPaths.push(path);
  }

  // V-SH3: a search literal the project does not contain would send the agent looking for nothing.
  let search = unquote(cleanText(raw.search ?? ''));
  if (search !== '' && !context.findLiteral(search)) search = '';

  // V-SH4: cutting a goal or a finish line would change what it says, so those reject; a question that
  // is too long is only dropped.
  if (goal.length > FIELD_LIMITS.goalChars) return reject('V-SH4', `goal is longer than ${FIELD_LIMITS.goalChars} characters`);
  if (done.length > FIELD_LIMITS.doneChars) return reject('V-SH4', `done is longer than ${FIELD_LIMITS.doneChars} characters`);
  let open = raw.open.map(cleanText).filter((line) => line !== '' && line.length <= FIELD_LIMITS.openChars);

  // V-SH5: the list caps, trimmed from the end. The fixed V-SH2 question keeps its place at the end.
  files = files.slice(0, FIELD_LIMITS.maxFiles);
  open = removedPaths.length > 0 ? [...open.slice(0, FIELD_LIMITS.maxOpen - 1), MISSING_PATH_QUESTION] : open.slice(0, FIELD_LIMITS.maxOpen);

  // V-SH6: no shell block and no `@name` survives. A path that carries either is dropped, because
  // rewriting it would make it a path that does not exist.
  const neutralizedGoal = neutralize(goal);
  const neutralizedDone = neutralize(done);
  const neutralizedSearch = neutralize(search);
  const neutralizedOpen = open.map(neutralize).filter((line) => line !== '');
  const cleanFiles = files.filter((path) => neutralize(path) === path);
  const neutralized =
    neutralizedGoal !== goal || neutralizedDone !== done || neutralizedSearch !== search || neutralizedOpen.join('\n') !== open.join('\n') || cleanFiles.length !== files.length;

  // V-SH7: a protected file is never named, whatever the index holds; `Keep:` already says so.
  /** @type {string[]} */
  const removedProtected = [];
  const editable = cleanFiles.filter((path) => {
    if (context.findProtectedGlob(path) === null) return true;
    removedProtected.push(path);
    return false;
  });

  // V-SH8: the denied-intent classifier over everything the model wrote, before and after V-SH6, so a
  // stripped `git push` block still rejects the answer it came in.
  const written = [raw.goal, ...(raw.files ?? []), raw.search ?? '', raw.done, ...raw.open].join('\n');
  const cleaned = [neutralizedGoal, ...editable, neutralizedSearch, neutralizedDone, ...neutralizedOpen].join('\n');
  const denied = findDeniedIntent(written) ?? findDeniedIntent(cleaned);
  if (denied) return { ok: false, reason: 'denied_intent', check: 'V-SH8', detail: `the rewrite asks for ${denied.label}`, denied };

  // V-SH9: the cheap anti-drift check. A rewrite about something else is worse than no rewrite.
  const requestWords = contentWords(context.request);
  if (![...contentWords(neutralizedGoal)].some((word) => requestWords.has(word))) {
    return reject('V-SH9', 'the goal shares no word with the request');
  }

  return {
    ok: true,
    fields: { goal: neutralizedGoal, files: editable, search: neutralizedSearch === '' ? null : neutralizedSearch, done: neutralizedDone, open: neutralizedOpen },
    removedPaths,
    removedProtected,
    neutralized,
  };
}

/**
 * One line of plain text: every run of line breaks or control characters becomes one space, invisible
 * format characters go, and the ends are trimmed.
 * @param {string} value
 * @returns {string}
 */
export function cleanText(value) {
  return value.replace(INVISIBLE, '').replace(LINE_BREAKING, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * V-SH6: shell blocks are removed whole, and every `@` is dropped so `@name` becomes the plain word.
 * @param {string} value
 * @returns {string}
 */
export function neutralize(value) {
  return value.replace(SHELL_BLOCK, '').replaceAll('@', '').replace(/ {2,}/g, ' ').trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const match = /^(["'`])(.*)\1$/.exec(value);
  return match ? match[2].trim() : value;
}

/**
 * @param {string} check
 * @param {string} detail
 * @returns {ValidationResult}
 */
function reject(check, detail) {
  return { ok: false, reason: 'invalid_output', check, detail, denied: null };
}
