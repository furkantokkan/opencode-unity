// Consent for persistent changes (spec sections 5.1 and 14.1). Each item is asked separately and shows
// its recommended answer. Items recommended "No" (environment variables, skill copies, deletions) are
// only accepted by an explicit answer or by the flag that preselects them.
import readline from 'node:readline';
import { CliError, EXIT } from './exit-codes.js';
import { CLI_NAME } from './version.js';

/**
 * @typedef {object} ConsentItem
 * @property {string} id              Stable id, for example 'profile-render'.
 * @property {string} title           The change, in one line.
 * @property {string} [detail]        Size, duration, paths or how to undo it.
 * @property {boolean} recommended    The recommended answer from the setup table.
 * @property {boolean} [preselected]  An explicit flag asked for this item (for example --ollama-env).
 */

/**
 * @typedef {'answer'|'default'|'yes_flag'|'not_requested'|'no_input'|'invalid_answer'} ConsentSource
 * - answer:         the user typed yes or no
 * - default:        the user pressed Enter
 * - yes_flag:       --yes accepted a recommended or preselected item
 * - not_requested:  declined without asking (recommended No and not preselected)
 * - no_input:       input ended before an answer
 * - invalid_answer: declined after several answers that were neither yes nor no
 */

/**
 * @typedef {object} ConsentDecision
 * @property {string} id
 * @property {boolean} accepted
 * @property {ConsentSource} source
 */

/**
 * @typedef {object} ConsentOptions
 * @property {boolean} interactive   True when a person can answer (stdin and stderr are terminals).
 * @property {boolean} yes           The --yes flag.
 * @property {() => NodeJS.ReadableStream} [getInput]  Called only when a question is asked.
 * @property {import('./output.js').TextStream} [prompts]  Where questions are written (stderr).
 */

/**
 * @typedef {object} Consent
 * @property {(items: readonly ConsentItem[]) => Promise<ConsentDecision[]>} request
 */

const MAX_ATTEMPTS = 3;

/**
 * @param {ConsentOptions} options
 * @returns {Consent}
 */
export function createConsent({ interactive, yes, getInput, prompts }) {
  return {
    async request(items) {
      validateItems(items);
      if (yes || !interactive) return decideWithoutPrompt(items, { yes });
      if (!getInput || !prompts) throw new TypeError('Interactive consent needs an input and a prompts stream');
      return askEach(items, getInput(), prompts);
    },
  };
}

/**
 * Decisions for a run that does not prompt. Without --yes, any item that would be accepted needs
 * consent, so the run stops with exit 9 and lists those items.
 * @param {readonly ConsentItem[]} items
 * @param {{ yes: boolean }} options
 * @returns {ConsentDecision[]}
 */
export function decideWithoutPrompt(items, { yes }) {
  const needed = items.filter(isAcceptedByDefault);
  if (!yes && needed.length) {
    throw new CliError(`Consent required for: ${needed.map((item) => item.id).join(', ')}`, {
      exitCode: EXIT.CONSENT_REQUIRED,
      code: 'consent_required',
      data: { consents: needed.map(({ id, title, recommended }) => ({ id, title, recommended })) },
      hint: `Re-run interactively, or add --yes to accept the recommended items. Items that default to No also need their own flag (see '${CLI_NAME} help').`,
    });
  }
  return items.map((item) =>
    isAcceptedByDefault(item)
      ? { id: item.id, accepted: true, source: 'yes_flag' }
      : { id: item.id, accepted: false, source: 'not_requested' },
  );
}

/**
 * @param {string} text
 * @param {boolean} defaultAnswer
 * @returns {boolean | undefined} undefined when the text is not an answer.
 */
export function parseAnswer(text, defaultAnswer) {
  const answer = text.trim().toLowerCase();
  if (answer === '') return defaultAnswer;
  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;
  return undefined;
}

/**
 * @param {ConsentItem} item
 * @returns {string}
 */
export function formatQuestion(item) {
  const detail = item.detail ? item.detail.split('\n').map((line) => `  ${line}\n`).join('') : '';
  const choices = isAcceptedByDefault(item) ? '[Y/n]' : '[y/N]';
  return `${item.title}\n${detail}Accept? ${choices} `;
}

/**
 * @param {readonly ConsentDecision[]} decisions
 * @param {string} id
 * @returns {boolean}
 */
export function isAccepted(decisions, id) {
  return decisions.some((decision) => decision.id === id && decision.accepted);
}

/**
 * @param {ConsentItem} item
 * @returns {boolean}
 */
function isAcceptedByDefault(item) {
  return item.recommended || item.preselected === true;
}

/**
 * @param {readonly ConsentItem[]} items
 * @param {NodeJS.ReadableStream} input
 * @param {import('./output.js').TextStream} prompts
 * @returns {Promise<ConsentDecision[]>}
 */
async function askEach(items, input, prompts) {
  // terminal: false keeps the console in cooked mode, so Ctrl+C still reaches the signal handlers.
  const lineReader = readline.createInterface({ input, terminal: false, crlfDelay: Infinity });
  // The async iterator buffers lines that arrive before the next question is written.
  const lines = lineReader[Symbol.asyncIterator]();
  /** @type {ConsentDecision[]} */
  const decisions = [];
  let inputEnded = false;
  try {
    for (const item of items) {
      if (inputEnded) {
        decisions.push({ id: item.id, accepted: false, source: 'no_input' });
        continue;
      }
      const decision = await askOne(item, lines, prompts);
      inputEnded = decision.source === 'no_input';
      decisions.push(decision);
    }
  } finally {
    lineReader.close();
  }
  return decisions;
}

/**
 * @param {ConsentItem} item
 * @param {AsyncIterator<string>} lines
 * @param {import('./output.js').TextStream} prompts
 * @returns {Promise<ConsentDecision>}
 */
async function askOne(item, lines, prompts) {
  const defaultAnswer = isAcceptedByDefault(item);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    prompts.write(attempt === 0 ? formatQuestion(item) : 'Please answer y or n: ');
    const next = await lines.next();
    if (next.done) {
      prompts.write('\n');
      return { id: item.id, accepted: false, source: 'no_input' };
    }
    const accepted = parseAnswer(next.value, defaultAnswer);
    if (accepted !== undefined) return { id: item.id, accepted, source: next.value.trim() === '' ? 'default' : 'answer' };
  }
  return { id: item.id, accepted: false, source: 'invalid_answer' };
}

/**
 * @param {readonly ConsentItem[]} items
 */
function validateItems(items) {
  const seen = new Set();
  for (const item of items) {
    if (!item.id || !item.title) throw new TypeError('Consent items need an id and a title');
    if (seen.has(item.id)) throw new TypeError(`Duplicate consent item '${item.id}'`);
    seen.add(item.id);
  }
}
