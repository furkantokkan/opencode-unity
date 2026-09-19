import { CliError, EXIT } from '../cli/exit-codes.js';
import { loadCompat } from '../core/profile.js';
import { createRedactor, getLocalRedactionTargets } from '../core/redact.js';
import { requireOpencode, readOpencodeVersion } from '../opencode/locate.js';
import { createSelftestLauncher } from './launch.js';
import { DEFAULT_SELFTEST_PROFILE, runSelftest } from './scenarios.js';

// Captured from the shipped unity-code permissions with OpenCode 1.18.31, not inferred from a
// successful request. Extra or missing tools must fail instead of blessing whatever was captured.
export const EXPECTED_CODE_TOOLS = Object.freeze(['bash', 'edit', 'glob', 'grep', 'read', 'write']);
export const DIAGNOSTIC_NOTICE = 'Starts installed OpenCode in temporary homes against local mock endpoints; no real model is loaded. Temporary files are removed afterward.';

/**
 * @typedef {object} DiagnosticOptions
 * @property {string} cliVersion
 * @property {Record<string, string | undefined>} env
 * @property {NodeJS.Platform} platform
 * @property {boolean} [capture]
 * @property {boolean} [selftest]
 * @property {boolean} [experimental]
 * @property {readonly string[]} [ids] Internal bounded benchmark selection.
 * @property {AbortSignal} [signal]
 * @property {(scenario: import('./scenarios.js').ScenarioDefinition) => void} [onScenarioStart]
 */

/**
 * @param {DiagnosticOptions} options
 * @param {{ locate?: typeof requireOpencode, readVersion?: typeof readOpencodeVersion, launcher?: typeof createSelftestLauncher, selftest?: typeof runSelftest }} [deps]
 */
export async function runDiagnostics(options, deps = {}) {
  const found = (deps.locate ?? requireOpencode)({ env: options.env, platform: options.platform });
  const version = await (deps.readVersion ?? readOpencodeVersion)(found.file, { env: options.env, signal: options.signal });
  if (!version.version) throw new CliError(version.error ?? 'OpenCode version could not be read', { code: 'opencode_version_failed' });
  const expected = loadCompat().opencode.tested;
  if (version.version !== expected && !options.experimental) throw new CliError(`Diagnostics are measured against OpenCode ${expected}; found ${version.version}`, {
    exitCode: EXIT.UNSUPPORTED, code: 'opencode_version_unsupported', hint: 'Install the tested version, or use --experimental to collect an explicitly unverified result.',
  });
  const report = await (deps.selftest ?? runSelftest)({
    cliVersion: options.cliVersion, opencodeVersion: version.version,
    launch: (deps.launcher ?? createSelftestLauncher)({ binary: found.file, cliVersion: options.cliVersion, env: options.env }),
    expectations: { codeTools: EXPECTED_CODE_TOOLS, captureRequests: options.capture === true },
    ids: options.ids ?? (options.selftest ? undefined : ['C1']),
    signal: options.signal, onScenarioStart: options.onScenarioStart,
  });
  const first = report.scenarios[0]?.requests?.find((request) => request.kind === 'chat')?.body;
  const toolJson = first ? JSON.stringify(first.tools ?? []) : null;
  const redactor = createRedactor(getLocalRedactionTargets({ env: options.env }));
  return redactor.redactValue({
    ...report, mode: options.selftest ? 'selftest' : 'capture',
    backend: 'loopback-mock', realModelLoaded: false,
    versionMeasured: version.version === expected,
    ...(toolJson ? { capture: {
      tools: EXPECTED_CODE_TOOLS, toolJsonBytes: Buffer.byteLength(toolJson),
      estimatedToolTokens: Math.ceil(toolJson.length / DEFAULT_SELFTEST_PROFILE.charsPerToken),
      estimateMethod: `redacted tool JSON characters / ${DEFAULT_SELFTEST_PROFILE.charsPerToken}; not model tokenizer usage`,
    } } : {}),
  });
}

/** @param {Awaited<ReturnType<typeof runDiagnostics>>} report */
export function renderDiagnosticText(report) {
  return [
    `OpenCode ${report.opencodeVersion} ${report.mode}: ${report.ok ? 'PASS' : 'FAIL'} (mock endpoint; no real model)`,
    ...report.scenarios.map((scenario) => `${scenario.ok ? 'PASS' : 'FAIL'} ${scenario.id}: ${scenario.title}${scenario.ok ? '' : `\n${scenario.checks.filter((check) => !check.ok).map((check) => `  ${check.id}: ${check.message}`).join('\n')}`}`),
    ...(report.capture ? [`Tool JSON: ${report.capture.toolJsonBytes} bytes; about ${report.capture.estimatedToolTokens} tokens (${report.capture.estimateMethod}).`] : []),
  ].join('\n');
}
