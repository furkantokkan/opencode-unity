// What a doctor check returns, and how severe it is allowed to be (spec 5.4, 5.2).
//
// A check states the severity it wants. The engine may lower it, and never raises it, so a report can
// be read as "this is the worst this machine could be judged at". Every lowering is recorded on the
// finding itself rather than applied silently.

/** @typedef {'error' | 'warn' | 'info' | 'pass' | 'skip'} Severity */

/** Worst first. Reports and the exit code read this order. */
export const SEVERITY_ORDER = Object.freeze(/** @type {readonly Severity[]} */ (['error', 'warn', 'info', 'pass', 'skip']));

/** Severities a check may declare in its documented range. `pass` and `skip` are outcomes, not ranges. */
export const DECLARABLE_SEVERITIES = Object.freeze(/** @type {readonly Severity[]} */ (['error', 'warn', 'info']));

export const SEVERITY_LABELS = Object.freeze({
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
  pass: 'ok',
  skip: 'skipped',
});

/**
 * An outcome as a check writes it.
 * @typedef {object} Outcome
 * @property {Severity} severity
 * @property {string} message                    One line, already free of ANSI and newlines.
 * @property {readonly string[]} [details]        Extra lines printed under the message.
 * @property {Record<string, unknown>} [data]     Machine fields for the JSON report.
 * @property {string} [fix]                       Overrides the check's documented fix for this case.
 */

/**
 * An outcome after the engine has attached the check and applied the severity policy.
 * @typedef {object} Finding
 * @property {string} id
 * @property {string} group
 * @property {string} title
 * @property {Severity} severity                  Effective.
 * @property {Severity} declaredSeverity          What the check asked for.
 * @property {string | null} loweredBy            Policy id that lowered it, or null.
 * @property {string} message
 * @property {string[]} details
 * @property {Record<string, unknown>} data
 * @property {string} fix
 * @property {string} why
 * @property {string} source
 */

/**
 * "1 file", "2 files": messages are written so no verb has to agree with the count.
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string}
 */
export function quantity(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * @param {Severity} first
 * @param {Severity} second
 * @returns {Severity} The worse of the two.
 */
export function worstSeverity(first, second) {
  return SEVERITY_ORDER.indexOf(second) < SEVERITY_ORDER.indexOf(first) ? second : first;
}

/**
 * @param {Severity} severity
 * @param {Severity} limit
 * @returns {boolean} True when `severity` is at least as bad as `limit`.
 */
export function isAtLeast(severity, limit) {
  return SEVERITY_ORDER.indexOf(severity) <= SEVERITY_ORDER.indexOf(limit);
}

/**
 * @param {string} message
 * @param {Omit<Outcome, 'severity' | 'message'>} [rest]
 * @returns {Outcome}
 */
export function error(message, rest = {}) {
  return { severity: 'error', message, ...rest };
}

/**
 * @param {string} message
 * @param {Omit<Outcome, 'severity' | 'message'>} [rest]
 * @returns {Outcome}
 */
export function warn(message, rest = {}) {
  return { severity: 'warn', message, ...rest };
}

/**
 * @param {string} message
 * @param {Omit<Outcome, 'severity' | 'message'>} [rest]
 * @returns {Outcome}
 */
export function info(message, rest = {}) {
  return { severity: 'info', message, ...rest };
}

/**
 * The check ran and found nothing to report. Counted, printed only in verbose text mode.
 * @param {string} message
 * @param {Omit<Outcome, 'severity' | 'message'>} [rest]
 * @returns {Outcome}
 */
export function pass(message, rest = {}) {
  return { severity: 'pass', message, ...rest };
}

/**
 * The check does not apply here. The reason is part of the report, because "no finding" and "never
 * looked" are different answers and only one of them is evidence.
 * @param {string} reason
 * @param {Omit<Outcome, 'severity' | 'message'>} [rest]
 * @returns {Outcome}
 */
export function skip(reason, rest = {}) {
  return { severity: 'skip', message: reason, ...rest };
}
