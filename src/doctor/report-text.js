// The human report (spec 5.4; amendment 33.9: the platform block is the first section in every mode).
//
// A finding that passed or did not apply is printed only with --verbose. The default report is what
// needs attention plus the one paragraph that says what kind of machine judged it.
import { CHECK_GROUPS, LOWERING_POLICIES, summarize } from './engine.js';
import { SEVERITY_LABELS } from './finding.js';
import { describeLogSource } from './logs.js';

/** @typedef {import('./context.js').DoctorContext} DoctorContext */
/** @typedef {import('./engine.js').DoctorReport} DoctorReport */
/** @typedef {import('./finding.js').Finding} Finding */
/** @typedef {import('./finding.js').Severity} Severity */

/** Severities printed without --verbose. */
const REPORTED = Object.freeze(['error', 'warn', 'info']);

/**
 * @param {DoctorContext} context
 * @param {DoctorReport} report
 * @param {{ verbose?: boolean }} [options]
 * @returns {string}
 */
export function renderTextReport(context, report, { verbose = false } = {}) {
  const lines = [
    ...renderPlatformBlock(context),
    '',
    ...renderFindings(report, { verbose }),
    ...renderNextSteps(report),
    '',
    summarize(report),
  ];
  return lines.join('\n');
}

/**
 * @param {DoctorContext} context
 * @returns {string[]}
 */
export function renderPlatformBlock(context) {
  const { facts, doctorTier, capabilities, refusedCommands } = context.platformInfo;
  const unmeasured = capabilities.filter((capability) => capability.applicable && !capability.measured).map((capability) => capability.id);
  /** @type {Array<[string, string]>} */
  const rows = [
    ['machine', `${facts.os}/${facts.arch}${facts.virtualization === null ? '' : ` inside ${facts.virtualization}`}`],
    ['backend', facts.backend],
    ['doctor tier', `${doctorTier.tier} (${doctorTier.rowLabel})`],
    ...(unmeasured.length > 0 ? [/** @type {[string, string]} */ (['not measured', unmeasured.join(', ')])] : []),
    ...(refusedCommands.length > 0 ? [/** @type {[string, string]} */ (['refused here', refusedCommands.join(', ')])] : []),
    ['home', context.home.dir],
    ['project', context.project.root ?? `${context.project.path} (no Unity project)`],
    ['ollama', `${context.ollama.baseUrl}${context.ollama.version === null ? ' (no answer)' : ` (${context.ollama.version})`}`],
    ['opencode', context.opencode.binary.version ?? 'not found on PATH'],
    ['server log', describeLogSource(context.logs.source)],
    ['config read', context.opencode.config.target === 'profile' ? 'the opencode-unity profile' : 'your own OpenCode setup'],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return ['Platform support', ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)];
}

/**
 * @param {DoctorReport} report
 * @param {{ verbose: boolean }} options
 * @returns {string[]}
 */
function renderFindings(report, { verbose }) {
  const shown = report.findings.filter((finding) => verbose || REPORTED.includes(finding.severity));
  if (shown.length === 0) return ['Findings', '  nothing to report'];
  /** @type {string[]} */
  const lines = ['Findings'];
  for (const group of CHECK_GROUPS) {
    const inGroup = shown.filter((finding) => finding.group === group.id);
    if (inGroup.length === 0) continue;
    lines.push(`  ${group.label}`);
    for (const finding of inGroup) lines.push(...renderFinding(finding, { verbose }));
  }
  return lines;
}

/**
 * @param {Finding} finding
 * @param {{ verbose: boolean }} options
 * @returns {string[]}
 */
function renderFinding(finding, { verbose }) {
  const label = SEVERITY_LABELS[finding.severity].padEnd(7);
  const lines = [`    ${label} ${finding.id}  ${finding.message}`];
  for (const detail of finding.details) lines.push(`            ${detail}`);
  if (finding.loweredBy !== null) {
    lines.push(`            reported as ${SEVERITY_LABELS[finding.severity].toLowerCase()} because ${LOWERING_POLICIES[finding.loweredBy] ?? finding.loweredBy}`);
  }
  if (finding.severity === 'error' || finding.severity === 'warn' || verbose) lines.push(`            fix: ${finding.fix}`);
  return lines;
}

/**
 * @param {DoctorReport} report
 * @returns {string[]}
 */
function renderNextSteps(report) {
  const actionable = report.findings.filter((finding) => finding.severity === 'error' || finding.severity === 'warn');
  if (actionable.length === 0) return [];
  const steps = [...new Set(actionable.map((finding) => finding.fix))];
  return ['', 'Next steps', ...steps.map((step) => `  - ${step}`)];
}

/**
 * `--explain <check-id>`: one check's rationale, range, fix and source.
 * @param {import('./engine.js').CheckSpec} check
 * @returns {string}
 */
export function renderExplanation(check) {
  return [
    `${check.id}  ${check.title}`,
    '',
    `  reports   ${check.severities.map((severity) => SEVERITY_LABELS[severity]).join(' or ')}`,
    `  why       ${check.why}`,
    `  fix       ${check.fix}`,
    `  source    ${check.source}`,
    ...(check.alwaysSevere === true ? ['  note      keeps its severity even before opencode-unity is set up here'] : []),
  ].join('\n');
}
