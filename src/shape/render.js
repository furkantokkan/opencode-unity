// The shaped form (amendment 36.4): fixed labels, fixed order, at most 600 characters, empty lines left
// out. `Goal`, `Files`, `Search`, `Done` and `Open` come from the validated model answer; `Keep` never
// does (D-SH2). It is rendered here from what the product already knows - the protected-edit summary,
// "no new packages", the VCS, and the project's UI and input rules exactly as `init` wrote them into
// facts.md - so it costs no model tokens and cannot invent a constraint.
import { getVcsRules } from '../facts/vcs-rules.js';

export const SHAPED_FORM_MAX_CHARS = 600;

/** The `PROTECTED_EDIT` summary, first in every `Keep:` line. */
export const PROTECTED_EDIT_SUMMARY = 'scenes, prefabs, assets, meta and project files unchanged';
export const NO_NEW_PACKAGES = 'no new packages';

/** The protected-edit summary, no new packages, no VCS writes: never dropped to fit the cap. */
const BASE_KEEP_CLAUSES = 3;

/**
 * @typedef {object} KeepFacts
 * @property {string | null} vcsKind    The detected VCS, or null.
 * @property {string | null} uiRule     The facts.md UI line without its bullet, or null.
 * @property {string | null} inputRule  The facts.md input line without its bullet, or null.
 */

/**
 * @typedef {object} RenderedRequest
 * @property {string} text
 * @property {import('./validate.js').ShapedFields & { keep: string }} fields  What the text shows, after
 *   any drop the length cap forced.
 * @property {string[]} dropped   What the cap removed, in drop order, for the note.
 */

/**
 * The `Keep:` clauses, in the spec's order: the protected-edit summary, no new packages, no VCS writes
 * (naming the VCS when it is not git), then the UI rule and the input rule.
 * @param {KeepFacts} facts
 * @returns {string[]}
 */
export function renderKeepClauses({ vcsKind, uiRule, inputRule }) {
  const vcs = getVcsRules(vcsKind);
  const clauses = [PROTECTED_EDIT_SUMMARY, NO_NEW_PACKAGES, vcs.kind === 'none' || vcs.kind === 'git' ? 'no VCS writes' : `no VCS writes (${vcs.displayName})`];
  if (uiRule) clauses.push(uiRule);
  if (inputRule) clauses.push(inputRule);
  return clauses;
}

/**
 * The UI and input lines of a facts.md, as `init` rendered them: the bullet and the final full stop go,
 * the words stay.
 * @param {string | null} factsText
 * @returns {{ uiRule: string | null, inputRule: string | null }}
 */
export function readFactsRules(factsText) {
  if (typeof factsText !== 'string') return { uiRule: null, inputRule: null };
  /** @param {string} label */
  const find = (label) => {
    const line = factsText.split(/\r?\n/).find((candidate) => candidate.startsWith(`- ${label}:`));
    return line ? line.slice(2).trim().replace(/\.$/, '') : null;
  };
  return { uiRule: find('UI'), inputRule: find('Input') };
}

/**
 * The fixed form. When it is over `maxChars`, parts go in a fixed order until it fits: the project's input
 * and UI rules (last clause first), the search literal, the third and second questions, the files from
 * the last, then the first question and the first file. Goal, Done and the first three `Keep:` clauses
 * always stay, and the validator's caps guarantee they fit.
 * @param {import('./validate.js').ShapedFields} fields
 * @param {readonly string[]} keepClauses
 * @param {{ maxChars?: number }} [options]
 * @returns {RenderedRequest}
 */
export function renderShapedRequest(fields, keepClauses, { maxChars = SHAPED_FORM_MAX_CHARS } = {}) {
  const state = { keep: [...keepClauses], files: [...fields.files], search: fields.search, open: [...fields.open] };
  /** @type {string[]} */
  const dropped = [];
  /**
   * @param {string[]} list
   * @param {number} keep  How many entries this step leaves.
   * @returns {() => boolean}
   */
  const trim = (list, keep) => () => {
    if (list.length <= keep) return false;
    list.pop();
    return true;
  };
  const dropSearch = () => {
    if (state.search === null) return false;
    state.search = null;
    return true;
  };
  /** @type {Array<[string, () => boolean]>} */
  const steps = [
    ['project rule', trim(state.keep, BASE_KEEP_CLAUSES + 1)],
    ['project rule', trim(state.keep, BASE_KEEP_CLAUSES)],
    ['search', dropSearch],
    ['question', trim(state.open, 2)],
    ['question', trim(state.open, 1)],
    ['file', trim(state.files, 4)],
    ['file', trim(state.files, 3)],
    ['file', trim(state.files, 2)],
    ['file', trim(state.files, 1)],
    ['question', trim(state.open, 0)],
    ['file', trim(state.files, 0)],
  ];
  let text = formatLines(fields, state);
  for (const [label, drop] of steps) {
    if (text.length <= maxChars) break;
    if (!drop()) continue;
    dropped.push(label);
    text = formatLines(fields, state);
  }
  return {
    text,
    fields: { goal: fields.goal, files: state.files, search: state.search, done: fields.done, keep: state.keep.join('; '), open: state.open },
    dropped,
  };
}

/**
 * @param {import('./validate.js').ShapedFields} fields
 * @param {{ keep: string[], files: string[], search: string | null, open: string[] }} state
 * @returns {string}
 */
function formatLines(fields, state) {
  const lines = [`Goal: ${fields.goal}`];
  if (state.files.length > 0) lines.push(`Files: ${state.files.join(', ')}`);
  if (state.search) lines.push(`Search: "${state.search}"`);
  lines.push(`Done: ${fields.done}`);
  if (state.keep.length > 0) lines.push(`Keep: ${state.keep.join('; ')}`);
  for (const question of state.open) lines.push(`Open: ${question}`);
  return lines.join('\n');
}
