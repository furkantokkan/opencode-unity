// The issue-ready report (spec 5.4: `--markdown` implies `--redact`).
//
// Shaped for a bug report: the platform block, then one table of what needs attention, then the detail
// under a collapsed section so a long report stays readable in an issue. The redactor runs over the
// finished text in the command, so nothing here has to remember to apply it.
import { summarize } from './engine.js';
import { SEVERITY_LABELS } from './finding.js';
import { describeLogSource } from './logs.js';

/** @typedef {import('./context.js').DoctorContext} DoctorContext */
/** @typedef {import('./engine.js').DoctorReport} DoctorReport */
/** @typedef {import('./finding.js').Finding} Finding */

const REPORTED = Object.freeze(['error', 'warn', 'info']);

/**
 * @param {DoctorContext} context
 * @param {DoctorReport} report
 * @returns {string}
 */
export function renderMarkdownReport(context, report) {
  const shown = report.findings.filter((finding) => REPORTED.includes(finding.severity));
  return [
    `# opencode-unity doctor ${context.cliVersion}`,
    '',
    summarize(report),
    '',
    '## Platform',
    '',
    ...renderPlatformTable(context),
    '',
    '## Findings',
    '',
    ...(shown.length === 0 ? ['Nothing to report.'] : renderFindingsTable(shown)),
    '',
    '## Detail',
    '',
    ...shown.flatMap((finding) => renderDetail(finding)),
    '## Checks that did not apply',
    '',
    ...renderSkipped(report),
    '',
  ].join('\n');
}

/**
 * @param {DoctorContext} context
 * @returns {string[]}
 */
function renderPlatformTable(context) {
  const { facts, doctorTier, capabilities, refusedCommands } = context.platformInfo;
  const unmeasured = capabilities.filter((capability) => capability.applicable && !capability.measured).map((capability) => capability.id);
  /** @type {Array<[string, string]>} */
  const rows = [
    ['Machine', `${facts.os}/${facts.arch}${facts.virtualization === null ? '' : ` inside ${facts.virtualization}`}`],
    ['Accelerator backend', facts.backend],
    ['Doctor tier', `${doctorTier.tier} (${doctorTier.rowLabel})`],
    ['Not measured', unmeasured.length === 0 ? 'nothing' : unmeasured.join(', ')],
    ['Refused here', refusedCommands.length === 0 ? 'nothing' : refusedCommands.join(', ')],
    ['Installed', context.home.installed ? 'yes' : 'no'],
    ['Ollama', `${context.ollama.version ?? 'no answer'} at ${context.ollama.baseUrl}`],
    ['OpenCode', context.opencode.binary.version ?? 'not found on PATH'],
    ['Server log', `${describeLogSource(context.logs.source)} (${context.logs.read ? 'read' : 'not checked'})`],
    ['Config read', context.opencode.config.target === 'profile' ? 'the opencode-unity profile' : "the user's own OpenCode setup"],
  ];
  return ['| Item | Value |', '|---|---|', ...rows.map(([label, value]) => `| ${label} | ${escapeCell(value)} |`)];
}

/**
 * @param {readonly Finding[]} findings
 * @returns {string[]}
 */
function renderFindingsTable(findings) {
  return [
    '| Severity | Check | Finding |',
    '|---|---|---|',
    ...findings.map((finding) => `| ${SEVERITY_LABELS[finding.severity]} | \`${finding.id}\` | ${escapeCell(finding.message)} |`),
  ];
}

/**
 * @param {Finding} finding
 * @returns {string[]}
 */
function renderDetail(finding) {
  return [
    `<details><summary><code>${finding.id}</code> — ${escapeCell(finding.message)}</summary>`,
    '',
    `- severity: ${SEVERITY_LABELS[finding.severity]}${finding.loweredBy === null ? '' : ` (declared ${SEVERITY_LABELS[finding.declaredSeverity]}, lowered: ${finding.loweredBy})`}`,
    `- why: ${finding.why}`,
    `- fix: ${finding.fix}`,
    `- source: ${finding.source}`,
    ...(finding.details.length === 0 ? [] : ['', ...finding.details.map((detail) => `  - ${detail}`)]),
    '',
    '```json',
    JSON.stringify(finding.data, null, 2),
    '```',
    '',
    '</details>',
    '',
  ];
}

/**
 * @param {DoctorReport} report
 * @returns {string[]}
 */
function renderSkipped(report) {
  const skipped = report.findings.filter((finding) => finding.severity === 'skip');
  if (skipped.length === 0) return ['Every check applied.'];
  return skipped.map((finding) => `- \`${finding.id}\`: ${finding.message}`);
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeCell(value) {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
