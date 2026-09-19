// `opencode-unity doctor [path]` (spec 5.4).
//
// Read-only by default: it reads configuration files, project files, the Ollama read-only endpoints,
// the server log and the local probes, and it never loads a model. `--deep` is the one mode that
// starts OpenCode for more than its version, and it says what that costs before it does.
import path from 'node:path';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { createRedactor } from '../core/redact.js';
import { buildRedactionTargets, collectDoctorContext } from '../doctor/context.js';
import { CHECKS, findCheck, listCheckIds } from '../doctor/checks/index.js';
import { listCloudCredentialValues } from '../doctor/cloud-keys.js';
import { hasFailingFindings, runChecks, summarize } from '../doctor/engine.js';
import { renderExplanation, renderTextReport } from '../doctor/report-text.js';
import { buildJsonReport } from '../doctor/report-json.js';
import { renderMarkdownReport } from '../doctor/report-markdown.js';
import { DIAGNOSTIC_NOTICE, runDiagnostics, renderDiagnosticText } from '../selftest/diagnostics.js';

/** @typedef {import('../cli/main.js').CommandContext} CommandContext */
/** @typedef {import('../cli/main.js').CommandResult} CommandResult */

/** Spec D20: what a deep run does to the machine, in one sentence, before it happens. */
export const DEEP_NOTICE =
  'A deep run starts OpenCode twice. Every OpenCode start writes .gitignore files and installs its plugin package into its configuration directories, including a project .opencode folder.';

/**
 * @param {CommandContext} context
 * @param {{ deps?: import('../doctor/context.js').ContextDependencies, checks?: readonly import('../doctor/engine.js').CheckSpec[], diagnostics?: typeof runDiagnostics }} [dependencies]
 * @returns {Promise<CommandResult>}
 */
export async function run(context, dependencies = {}) {
  const checks = dependencies.checks ?? CHECKS;
  const explain = asString(context.options.explain);
  if (explain !== null) return explainCheck(context, explain, checks);
  if (context.options.capture === true || context.options.selftest === true) {
    if (context.global.dryRun === true) {
      const message = `Would run ${context.options.selftest ? 'selftest' : 'capture'} with installed OpenCode and temporary mock endpoints; no process was started.`;
      if (!context.output.json) context.output.text(message);
      return { message, data: { dryRun: true, realModelLoaded: false } };
    }
    context.output.warn(DIAGNOSTIC_NOTICE);
    const data = await (dependencies.diagnostics ?? runDiagnostics)({
      cliVersion: context.version, env: context.env, platform: context.platform, signal: context.signal,
      capture: context.options.capture === true, selftest: context.options.selftest === true,
      experimental: context.global.experimental === true,
      onScenarioStart: (scenario) => context.output.warn(`Checking ${scenario.id}: ${scenario.title}`),
    });
    const text = renderDiagnosticText(data);
    if (!context.output.json) context.output.text(text);
    return { exitCode: data.ok ? EXIT.OK : EXIT.CHECK_FAILED, code: data.ok ? undefined : 'check_failed', message: `OpenCode ${data.mode}: ${data.ok ? 'passed' : 'failed'}`, data };
  }

  // Spec 5.4: --deep prints the notice and proceeds. Passing the flag is the decision; the notice is
  // there so the side effect is never a surprise, not to ask a second time.
  if (context.options.deep === true) context.output.warn(DEEP_NOTICE);

  const doctorContext = await collectDoctorContext({
    cliVersion: context.version,
    env: context.env,
    platform: context.platform,
    options: readOptions(context),
    signal: context.signal,
    deps: dependencies.deps,
  });
  const report = runChecks(doctorContext, { checks, strict: context.options.strict === true });

  const markdown = context.options.markdown === true;
  const redact = markdown || context.options.redact === true;
  const redactor = redact ? createRedactor({ ...buildRedactionTargets(doctorContext), secrets: listCloudCredentialValues(context.env) }) : null;
  const apply = (/** @type {string} */ text) => (redactor === null ? text : redactor.redactText(text));

  const data = redactor === null ? buildJsonReport(doctorContext, report) : redactor.redactValue(buildJsonReport(doctorContext, report));
  if (!context.output.json) {
    context.output.text(apply(markdown ? renderMarkdownReport(doctorContext, report) : renderTextReport(doctorContext, report, { verbose: context.output.verbose })));
  } else if (markdown) {
    data.markdown = apply(renderMarkdownReport(doctorContext, report));
  }

  const failed = hasFailingFindings(report);
  return {
    exitCode: failed ? EXIT.CHECK_FAILED : EXIT.OK,
    code: failed ? 'check_failed' : undefined,
    message: summarize(report),
    data,
    warnings: doctorContext.warnings.map(apply),
  };
}

/**
 * @param {CommandContext} context
 * @returns {import('../doctor/context.js').DoctorOptions}
 */
function readOptions(context) {
  const given = asString(context.args.path) ?? asString(context.global.project);
  return {
    projectPath: path.resolve(context.cwd, given ?? '.'),
    profile: context.options.profile === true ? true : null,
    deep: context.options.deep === true,
    strict: context.options.strict === true,
    redact: context.options.redact === true || context.options.markdown === true,
    logsOverride: asString(context.options.logs),
  };
}

/**
 * @param {CommandContext} context
 * @param {string} id
 * @param {readonly import('../doctor/engine.js').CheckSpec[]} checks
 * @returns {CommandResult}
 */
function explainCheck(context, id, checks) {
  const check = findCheck(id, checks);
  if (check === undefined) {
    throw new CliError(`there is no check called '${id}'`, {
      exitCode: EXIT.USAGE,
      code: 'unknown_check',
      data: { id, known: listCheckIds(checks) },
      hint: 'Run opencode-unity doctor --json to see every check id.',
    });
  }
  if (!context.output.json) context.output.text(renderExplanation(check));
  return {
    message: `${check.id}: ${check.why}`,
    data: {
      id: check.id,
      group: check.group,
      title: check.title,
      severities: [...check.severities],
      why: check.why,
      fix: check.fix,
      source: check.source,
      alwaysSevere: check.alwaysSevere === true,
    },
  };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
