// Stable exit codes (spec section 5.2). Scripts and the delegation skill depend on these numbers,
// so a released value never changes meaning.

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 1,
  BLOCKED: 2,
  BUDGET: 3,
  VALIDATION: 4,
  CHECK_FAILED: 5,
  LOCK_TIMEOUT: 6,
  RUNTIME: 7,
  UNSUPPORTED: 8,
  CONSENT_REQUIRED: 9,
  INTERRUPTED: 130,
});

/**
 * @typedef {object} ExitCodeInfo
 * @property {number} exitCode
 * @property {string} name     Constant name in EXIT.
 * @property {string} code     Default machine code for the JSON envelope.
 * @property {string} summary  One line for help and docs.
 */

/** @type {readonly ExitCodeInfo[]} */
export const EXIT_CODES = Object.freeze([
  { exitCode: EXIT.OK, name: 'OK', code: 'ok', summary: 'Success' },
  { exitCode: EXIT.USAGE, name: 'USAGE', code: 'usage_error', summary: 'Bad flags or config, not a Unity project, or missing facts' },
  { exitCode: EXIT.BLOCKED, name: 'BLOCKED', code: 'blocked', summary: 'GPU guard blocked, Ollama unreachable, or GPU busy' },
  { exitCode: EXIT.BUDGET, name: 'BUDGET', code: 'budget_exceeded', summary: 'Context budget exceeded' },
  { exitCode: EXIT.VALIDATION, name: 'VALIDATION', code: 'validation_failed', summary: 'Effective-config verification, edit validation or review check failed' },
  { exitCode: EXIT.CHECK_FAILED, name: 'CHECK_FAILED', code: 'check_failed', summary: 'Doctor errors, failed check command, bench below threshold, or failed self-test' },
  { exitCode: EXIT.LOCK_TIMEOUT, name: 'LOCK_TIMEOUT', code: 'lock_timeout', summary: 'GPU lock not acquired in time' },
  { exitCode: EXIT.RUNTIME, name: 'RUNTIME', code: 'runtime_error', summary: 'Unexpected error, or the OpenCode child exited non-zero' },
  { exitCode: EXIT.UNSUPPORTED, name: 'UNSUPPORTED', code: 'unsupported', summary: 'Platform, version, preset or command not supported here' },
  { exitCode: EXIT.CONSENT_REQUIRED, name: 'CONSENT_REQUIRED', code: 'consent_required', summary: 'Non-interactive run needs --yes' },
  { exitCode: EXIT.INTERRUPTED, name: 'INTERRUPTED', code: 'interrupted', summary: 'Interrupted (Ctrl+C)' },
]);

// Envelope codes are snake_case so every consumer can match them without normalizing.
export const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * @param {number} exitCode
 * @returns {ExitCodeInfo | undefined}
 */
export function getExitCodeInfo(exitCode) {
  return EXIT_CODES.find((info) => info.exitCode === exitCode);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isExitCode(value) {
  return EXIT_CODES.some((info) => info.exitCode === value);
}

/**
 * @typedef {object} CliErrorOptions
 * @property {number} [exitCode]  Defaults to EXIT.RUNTIME.
 * @property {string} [code]      Envelope code; defaults to the exit code's default code.
 * @property {Record<string, unknown>} [data]  Merged into the envelope `data`.
 * @property {string} [hint]      Next step for the user, printed after the message.
 * @property {unknown} [cause]
 */

/** An expected failure with a stable exit code. Commands throw it; `main` turns it into the envelope. */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {CliErrorOptions} [options]
   */
  constructor(message, { exitCode = EXIT.RUNTIME, code, data = {}, hint, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    const info = getExitCodeInfo(exitCode);
    if (!info || exitCode === EXIT.OK) throw new TypeError(`CliError needs a failing exit code, got ${exitCode}`);
    const resolvedCode = code ?? info.code;
    if (!CODE_PATTERN.test(resolvedCode)) throw new TypeError(`CliError code must be snake_case, got '${resolvedCode}'`);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = resolvedCode;
    this.data = data;
    this.hint = hint;
  }
}

/**
 * @param {string} message
 * @param {Omit<CliErrorOptions, 'exitCode'>} [options]
 * @returns {CliError}
 */
export function usageError(message, options = {}) {
  return new CliError(message, { code: 'usage_error', ...options, exitCode: EXIT.USAGE });
}

/**
 * Wraps anything thrown into a CliError; unknown failures become RUNTIME.
 * @param {unknown} error
 * @returns {CliError}
 */
export function toCliError(error) {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(message || 'Unexpected error', { exitCode: EXIT.RUNTIME, cause: error });
}
