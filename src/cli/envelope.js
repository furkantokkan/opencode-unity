// The machine envelope printed on stdout with --json (spec section 5.3).
import { CLI_VERSION } from './version.js';
import { CODE_PATTERN, EXIT, getExitCodeInfo, isExitCode, toCliError } from './exit-codes.js';

/**
 * @typedef {object} Envelope
 * @property {boolean} ok        True exactly when exitCode is 0.
 * @property {string} command    Command label, for example 'guard' or 'delegate ask'.
 * @property {number} exitCode
 * @property {string} code       snake_case machine code.
 * @property {string} message    One human line.
 * @property {Record<string, unknown>} data
 * @property {string[]} warnings
 * @property {string} version    CLI version.
 */

// One wire format for every command, in this order. Spec 12.4 sketches the delegate answer with its
// own fields at the top level; those belong under `data` (jobId, status, model, numCtx, token counts,
// reviewId, resultPath, summary), so an orchestrator parses one shape rather than one per command.
export const ENVELOPE_KEYS = Object.freeze(['ok', 'command', 'exitCode', 'code', 'message', 'data', 'warnings', 'version']);

/**
 * @typedef {object} EnvelopeInput
 * @property {string} command
 * @property {number} [exitCode]
 * @property {string} [code]
 * @property {string} [message]
 * @property {Record<string, unknown>} [data]
 * @property {string[]} [warnings]
 * @property {string} [version]
 */

/**
 * Builds a valid envelope with keys in the documented order. Throws TypeError on invalid input.
 * @param {EnvelopeInput} input
 * @returns {Envelope}
 */
export function createEnvelope({ command, exitCode = EXIT.OK, code, message = '', data = {}, warnings = [], version = CLI_VERSION }) {
  const envelope = {
    ok: exitCode === EXIT.OK,
    command,
    exitCode,
    code: code ?? getExitCodeInfo(exitCode)?.code ?? '',
    message,
    data,
    warnings: Array.isArray(warnings) ? [...warnings] : warnings,
    version,
  };
  const problems = validateEnvelope(envelope);
  if (problems.length) throw new TypeError(`Invalid envelope: ${problems.join('; ')}`);
  return envelope;
}

/**
 * @param {string} command
 * @param {unknown} error
 * @param {{ verbose?: boolean, version?: string }} [options]
 * @returns {Envelope}
 */
export function createErrorEnvelope(command, error, { verbose = false, version = CLI_VERSION } = {}) {
  const cliError = toCliError(error);
  /** @type {Record<string, unknown>} */
  const data = { ...cliError.data };
  if (cliError.hint) data.hint = cliError.hint;
  if (verbose) data.stack = getStack(cliError);
  return createEnvelope({ command, exitCode: cliError.exitCode, code: cliError.code, message: cliError.message, data, version });
}

/**
 * @param {Error} error
 * @returns {string | undefined}
 */
function getStack(error) {
  return error.cause instanceof Error ? error.cause.stack : error.stack;
}

/**
 * One line per envelope: consumers such as a paid orchestrator pay for every whitespace token.
 * @param {Envelope} envelope
 * @returns {string}
 */
export function formatEnvelope(envelope) {
  return `${JSON.stringify(envelope)}\n`;
}

/**
 * Parses and validates an envelope, for example the last stdout line of a CLI run.
 * @param {string} text
 * @returns {Envelope}
 */
export function parseEnvelope(text) {
  const value = JSON.parse(text.trim());
  const problems = validateEnvelope(value);
  if (problems.length) throw new TypeError(`Invalid envelope: ${problems.join('; ')}`);
  return value;
}

/**
 * @param {unknown} value
 * @returns {string[]} Problems; empty when the value is a valid envelope.
 */
export function validateEnvelope(value) {
  if (!isPlainObject(value)) return ['envelope must be an object'];
  const problems = [];
  const keys = Object.keys(value);
  for (const key of keys) if (!ENVELOPE_KEYS.includes(key)) problems.push(`unexpected key '${key}'`);
  for (const key of ENVELOPE_KEYS) if (!keys.includes(key)) problems.push(`missing key '${key}'`);
  if (typeof value.command !== 'string' || value.command === '') problems.push('command must be a non-empty string');
  if (!isExitCode(value.exitCode)) problems.push(`exitCode ${String(value.exitCode)} is not a documented exit code`);
  if (value.ok !== (value.exitCode === EXIT.OK)) problems.push('ok must be true exactly when exitCode is 0');
  if (typeof value.code !== 'string' || !CODE_PATTERN.test(value.code)) problems.push('code must be a snake_case string');
  if (typeof value.message !== 'string') problems.push('message must be a string');
  if (!isPlainObject(value.data)) problems.push('data must be an object');
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string')) {
    problems.push('warnings must be an array of strings');
  }
  if (typeof value.version !== 'string' || value.version === '') problems.push('version must be a non-empty string');
  return problems;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
