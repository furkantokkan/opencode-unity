import { CliError, EXIT, usageError } from '../cli/exit-codes.js';
import { loadConfig } from '../core/config.js';
import { getHomeDir, getHomePaths } from '../core/paths.js';
import { loadPreset } from '../core/presets.js';
import { assertProfileAllowed, buildRuntimeProfile } from '../core/profile.js';
import { runEditBenchmark } from '../bench/edits.js';
import { DIAGNOSTIC_NOTICE, runDiagnostics } from '../selftest/diagnostics.js';

const MOCK_SUITES = Object.freeze({
  guard: ['C5', 'C7-plugin-deleted', 'C7-plugin-broken', 'C7-pure'],
  budget: ['C8-overflow', 'C8-loop-breaker'],
  all: ['C1', 'C5', 'C7-plugin-deleted', 'C7-plugin-broken', 'C7-pure', 'C8-overflow', 'C8-loop-breaker', 'C12-offline'],
});

/**
 * @param {import('../cli/main.js').CommandContext} context
 * @param {{ edits?: typeof runEditBenchmark, diagnostics?: typeof runDiagnostics }} [deps]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(context, deps = {}) {
  const suite = context.args.suite;
  const mock = context.options.mock === true;
  const runs = typeof context.options.runs === 'number' ? context.options.runs : mock ? 1 : 20;
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 1000) throw usageError('--runs must be between 1 and 1000');
  if (mock ? !(suite in MOCK_SUITES) : suite !== 'edits') throw unsupported(suite, mock);
  if (context.global.dryRun === true) {
    const message = mock ? `Would run ${suite} mock protocol scenarios ${runs} time(s).` : `Would make ${runs * 3} guarded native chat requests and compare exact replacements; no files would be changed.`;
    if (!context.output.json) context.output.text(message);
    return { message, data: { dryRun: true, suite, runs, mock } };
  }
  if (mock) {
    const ids = MOCK_SUITES[/** @type {keyof typeof MOCK_SUITES} */ (suite)];
    if (context.options.temperature !== undefined) throw usageError('--temperature is only meaningful for the live edits benchmark');
    context.output.warn(DIAGNOSTIC_NOTICE);
    const records = [];
    for (let iteration = 1; iteration <= runs; iteration += 1) {
      context.signal?.throwIfAborted();
      const report = await (deps.diagnostics ?? runDiagnostics)({
        cliVersion: context.version, env: context.env, platform: context.platform,
        selftest: true, ids, experimental: context.global.experimental === true, signal: context.signal,
        onScenarioStart: (scenario) => context.output.warn(`Run ${iteration}/${runs}: ${scenario.id}`),
      });
      records.push(report);
    }
    const ok = records.every((record) => record.ok);
    const data = { schemaVersion: 1, suite, mode: 'mock-opencode-protocol', realModelLoaded: false, modelReliabilityMeasured: false, runs, ok, records };
    const message = `${suite} mock protocol benchmark: ${ok ? 'passed' : 'failed'} (${runs} runs; no model reliability measurement)`;
    if (!context.output.json) context.output.text(message);
    return { exitCode: ok ? EXIT.OK : EXIT.CHECK_FAILED, code: ok ? undefined : 'check_failed', message, data };
  }
  const home = getHomeDir({ env: context.env, platform: context.platform });
  const paths = getHomePaths(home, { platform: context.platform });
  const { config, user } = await loadConfig(paths.config);
  const { profile, warnings } = buildRuntimeProfile({ config, userConfig: user, preset: loadPreset(config.preset), cliVersion: context.version, home });
  assertProfileAllowed(profile, { experimental: context.global.experimental === true || config.experimental.presets });
  context.output.warn(`Runs ${runs * 3} guarded local-model requests; checks exact replacements without changing files.`);
  const data = await (deps.edits ?? runEditBenchmark)({
    profile, runs, platform: context.platform, signal: context.signal,
    temperature: typeof context.options.temperature === 'number' ? context.options.temperature : undefined,
    addCleanup: (cleanup) => context.interrupts.addCleanup(cleanup),
  });
  const message = `Exact replacement benchmark: ${data.passed}/${data.total} passed`;
  if (!context.output.json) context.output.text(message);
  return { exitCode: data.ok ? EXIT.OK : EXIT.CHECK_FAILED, code: data.ok ? undefined : 'check_failed', message, data, warnings };
}

/** @param {string} suite @param {boolean} mock */
function unsupported(suite, mock) {
  return new CliError(`${suite} ${mock ? 'mock' : 'live'} benchmark has no verified runner in this release`, {
    exitCode: EXIT.UNSUPPORTED, code: 'prerequisite_missing',
    hint: 'Use bench edits for guarded native text replacements, or bench guard|budget|all --mock for OpenCode protocol checks.',
  });
}
