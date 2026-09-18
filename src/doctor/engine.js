// The doctor engine (spec 5.4): run every check that applies, apply the severity policy, decide the
// exit code.
//
// Checks are synchronous and pure. Everything that reads a file, spawns a process or opens a socket
// happens once in `src/doctor/context.js` before any check runs, which is what makes the invariant of
// 5.4 testable: the context is the only layer with I/O, and a unit test can assert that a whole run
// against a mock Ollama produced zero model-load requests.
import { SEVERITY_ORDER, isAtLeast, quantity, worstSeverity } from './finding.js';

/** @typedef {import('./finding.js').Severity} Severity */
/** @typedef {import('./finding.js').Outcome} Outcome */
/** @typedef {import('./finding.js').Finding} Finding */
/** @typedef {import('./context.js').DoctorContext} DoctorContext */

/**
 * Report sections, in print order. A check names one of these, so the report's shape does not depend
 * on the order checks were registered in.
 * @type {ReadonlyArray<{ id: string, label: string }>}
 */
export const CHECK_GROUPS = Object.freeze([
  { id: 'platform', label: 'Platform support' },
  { id: 'setup', label: 'Installation' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'model', label: 'Model' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'instructions', label: 'Instruction files' },
  { id: 'tools', label: 'Tools and MCP' },
  { id: 'budget', label: 'Prompt budget' },
  { id: 'logs', label: 'Ollama server log' },
  { id: 'gpu', label: 'GPU' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'unity', label: 'Unity project' },
  { id: 'delegate', label: 'Delegation add-on' },
]);

/**
 * @typedef {object} CheckSpec
 * @property {string} id                       Stable; scripts and issue templates name it.
 * @property {string} group                    One of CHECK_GROUPS.
 * @property {string} title                    Short label for the docs table.
 * @property {readonly Severity[]} severities  The range the check may report, worst first.
 * @property {string} why                      One line: what this detects and why it matters.
 * @property {string} fix                      One line: the next step, used when an outcome has none.
 * @property {string} source                   Where the behaviour is documented.
 * @property {boolean} [alwaysSevere]          Keep the declared severity even before setup has run.
 * @property {(context: DoctorContext) => Outcome | readonly Outcome[] | null} run
 */

/**
 * Why a finding was lowered. One id per policy, so a report can say which one applied.
 * @type {Readonly<Record<string, string>>}
 */
export const LOWERING_POLICIES = Object.freeze({
  'not-installed': 'opencode-unity is not set up on this machine, so nothing here is misconfigured yet',
});

/**
 * @typedef {object} DoctorReport
 * @property {Finding[]} findings                    Every outcome, in group then registry order.
 * @property {Record<Severity, number>} counts
 * @property {Severity} worst                        The worst effective severity, 'skip' when nothing ran.
 * @property {boolean} strict
 * @property {number} checksRun                      Checks that produced a non-skip outcome.
 */

/**
 * @param {DoctorContext} context
 * @param {{ checks: readonly CheckSpec[], strict?: boolean }} options
 * @returns {DoctorReport}
 */
export function runChecks(context, { checks, strict = false }) {
  const order = new Map(CHECK_GROUPS.map((group, index) => [group.id, index]));
  /** @type {Finding[]} */
  const findings = [];
  for (const check of checks) {
    for (const outcome of toOutcomes(check, context)) {
      findings.push(buildFinding(check, outcome, context));
    }
  }
  findings.sort((first, second) => (order.get(first.group) ?? 0) - (order.get(second.group) ?? 0));
  const counts = countSeverities(findings);
  return {
    findings,
    counts,
    worst: findings.reduce((/** @type {Severity} */ seen, finding) => worstSeverity(seen, finding.severity), 'skip'),
    strict,
    checksRun: findings.filter((finding) => finding.severity !== 'skip').length,
  };
}

/**
 * A check that throws is a defect in the check, not a finding about the machine, so it reports itself
 * as an ERROR naming its own id instead of ending the run.
 * @param {CheckSpec} check
 * @param {DoctorContext} context
 * @returns {Outcome[]}
 */
function toOutcomes(check, context) {
  /** @type {Outcome | readonly Outcome[] | null} */
  let produced;
  try {
    produced = check.run(context);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return [{ severity: 'error', message: `the check '${check.id}' failed to run: ${detail}`, data: { checkError: detail } }];
  }
  if (produced === null || produced === undefined) return [{ severity: 'skip', message: 'does not apply here' }];
  const list = Array.isArray(produced) ? [...produced] : [/** @type {Outcome} */ (produced)];
  return list.length === 0 ? [{ severity: 'skip', message: 'does not apply here' }] : list;
}

/**
 * @param {CheckSpec} check
 * @param {Outcome} outcome
 * @param {DoctorContext} context
 * @returns {Finding}
 */
function buildFinding(check, outcome, context) {
  const lowered = lowerSeverity(check, outcome.severity, context);
  return {
    id: check.id,
    group: check.group,
    title: check.title,
    severity: lowered.severity,
    declaredSeverity: outcome.severity,
    loweredBy: lowered.policy,
    message: outcome.message,
    details: [...(outcome.details ?? [])],
    data: { ...(outcome.data ?? {}) },
    fix: outcome.fix ?? check.fix,
    why: check.why,
    source: check.source,
  };
}

/**
 * The one lowering policy of v0.1: before `setup` has written a config, an ERROR would be claiming a
 * configuration is wrong when there is no configuration. `npx opencode-unity doctor` on a fresh machine
 * is a supported entry point (D14), and it has to describe the machine rather than fail on it. WARN is
 * the floor, so `--strict` still fails and nothing disappears from the report.
 * @param {CheckSpec} check
 * @param {Severity} severity
 * @param {DoctorContext} context
 * @returns {{ severity: Severity, policy: string | null }}
 */
function lowerSeverity(check, severity, context) {
  if (severity !== 'error' || check.alwaysSevere === true || context.home.installed) return { severity, policy: null };
  return { severity: 'warn', policy: 'not-installed' };
}

/**
 * @param {readonly Finding[]} findings
 * @returns {Record<Severity, number>}
 */
export function countSeverities(findings) {
  const counts = /** @type {Record<Severity, number>} */ (Object.fromEntries(SEVERITY_ORDER.map((severity) => [severity, 0])));
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/**
 * Spec 5.2: 0 without ERROR findings, 5 with them, and with WARN findings under `--strict`.
 * @param {DoctorReport} report
 * @returns {boolean}
 */
export function hasFailingFindings(report) {
  const limit = /** @type {Severity} */ (report.strict ? 'warn' : 'error');
  return report.findings.some((finding) => isAtLeast(finding.severity, limit));
}

/**
 * @param {DoctorReport} report
 * @returns {string} One line for the envelope message and the last line of the text report.
 */
export function summarize(report) {
  const { error: errors, warn: warnings, info: notes, pass: passed, skip: skipped } = report.counts;
  const parts = [quantity(errors, 'error'), quantity(warnings, 'warning'), quantity(notes, 'note')];
  return `${parts.join(', ')} (${quantity(passed, 'check')} clean, ${skipped} not applicable)`;
}
