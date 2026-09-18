// `opencode-unity delegate <health|ask|map|edit|apply|restore|ledger>` (spec section 12).
//
// The delegation add-on lets a paid orchestrator hand token-heavy, low-ambiguity work to the same local
// model the product already guards. It is a plain CLI invocation: no daemon, no port, no tools for the
// model, and therefore no network (amendment D-M11). Every answer comes back as the SPEC 5.3 envelope,
// with the SPEC 12.4 fields under `data` (amendment D-M7).
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, EXIT, toCliError, usageError } from '../cli/exit-codes.js';
import { loadConfig } from '../core/config.js';
import { getHomeDir, getHomePaths, getProjectId } from '../core/paths.js';
import { loadPreset } from '../core/presets.js';
import { buildRuntimeProfile } from '../core/profile.js';
import { createNodeFsView } from '../unity/fs-view.js';
import { findUnityProjectRoot } from '../unity/root.js';
import { parseRuntimeProfile } from '../../plugin/opencode-unity-lib/runtime-profile.js';
import { runAsk } from '../delegate/ask.js';
import { recoverUnfinishedApplies } from '../delegate/apply.js';
import { runEdit, runApply } from '../delegate/edit.js';
import { runHealth } from '../delegate/health.js';
import { appendLedger, readLedger, renderLedgerText, summarizeLedger } from '../delegate/ledger.js';
import { runMap } from '../delegate/map.js';
import { createModelTarget } from '../delegate/model.js';
import { attachOrchestratorAction, buildJobResult, createJob, renderJobMeta, writeJobFile } from '../delegate/results.js';
import { runRestore } from '../delegate/restore.js';
import { createSensitiveMatcher } from '../delegate/sensitive.js';

/**
 * Everything a delegate subcommand needs. It is built once per invocation, and tests build it directly
 * to drive one lane without a child process.
 * @typedef {object} DelegateContext
 * @property {string} subcommand
 * @property {string} cwd                    Working directory for file arguments.
 * @property {Record<string, string>} args   Positionals (`reviewId`, `jobId`).
 * @property {Record<string, import('../cli/args.js').OptionValue>} options
 * @property {import('../cli/args.js').GlobalOptions} global
 * @property {import('../core/config.js').Config} config
 * @property {import('../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile} profile
 * @property {import('../delegate/model.js').ModelTarget} target
 * @property {import('../delegate/prompts.js').BudgetSettings} budget
 * @property {{ requestMs: number, checkMs: number }} timeouts
 * @property {{ lockPath: string, command: string, timeoutSec: number, waitSec: number }} lock
 * @property {(cleanup: () => string | void) => () => void} addCleanup
 * @property {string} resultsDir
 * @property {string} ledgerPath
 * @property {import('../delegate/sensitive.js').SensitiveMatcher} matcher
 * @property {NodeJS.Platform} platform
 * @property {Record<string, string | undefined>} env
 * @property {AbortSignal} [signal]
 * @property {typeof fetch} [fetchImpl]
 * @property {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes} [probes]
 * @property {(cleanup: () => void) => (() => void) | void} [trackCleanup]
 * @property {import('../core/exec.js').RunOptions['onSpawn']} [trackChild]
 * @property {() => number} now
 * @property {string[]} warnings             Notes collected before the subcommand ran.
 * @property {() => { root: string, compileMap: import('../facts/compile-map.js').CompileRow[] }} requireProject
 */

/**
 * @typedef {object} DelegateDependencies
 * @property {typeof fetch} [fetchImpl]
 * @property {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes} [probes]
 * @property {() => number} [now]
 * @property {() => string} [randomHex]
 */

const JOB_HANDLERS = Object.freeze({ ask: runAsk, map: runMap, edit: runEdit, apply: runApply });

// These two read what earlier jobs left behind and never touch the model, so a note about the profile
// would only be noise in their output.
const SUBCOMMANDS_WITHOUT_A_MODEL = Object.freeze(['ledger', 'restore']);

/**
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {DelegateDependencies} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(cliContext, dependencies = {}) {
  const subcommand = cliContext.subcommand;
  if (!subcommand) throw usageError("delegate needs a subcommand; run 'opencode-unity help delegate'");
  const context = await createDelegateContext(cliContext, dependencies);
  if (subcommand === 'health') return withWarnings(context, await runHealth(context));
  if (subcommand === 'ledger') return withWarnings(context, await runLedger(context));
  if (subcommand === 'restore') return withWarnings(context, runRestore(context));
  return runJob(context, dependencies);
}

/**
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {DelegateDependencies} dependencies
 * @returns {Promise<DelegateContext>}
 */
export async function createDelegateContext(cliContext, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const platform = cliContext.platform;
  const home = getHomeDir({ env: cliContext.env, platform });
  const paths = getHomePaths(home, { platform });
  const { config, warnings } = await loadConfig(paths.config);
  assertDelegationEnabled(config);
  const { profile, warnings: profileWarnings } = await loadDelegateProfile({ paths, config, cliVersion: cliContext.version, home, platform });
  const delegate = config.delegate;
  const requestedOutput = readPositiveInteger(cliContext.options.maxOutput) ?? delegate.maxOutputTokens;
  // The guarded path caps the answer at the profile's output limit, so a larger request is clamped here
  // instead of silently producing a smaller answer than the caller planned for.
  const maxOutputTokens = Math.min(requestedOutput, profile.provider.limit.output);
  if (maxOutputTokens < requestedOutput) {
    profileWarnings.push(`--max-output ${requestedOutput} is above the profile limit ${profile.provider.limit.output}; ${maxOutputTokens} is used.`);
  }
  const cwd = resolveWorkingDirectory(cliContext);
  const subcommand = /** @type {string} */ (cliContext.subcommand);

  /** @type {DelegateContext} */
  const context = {
    subcommand,
    cwd,
    args: cliContext.args,
    options: cliContext.options,
    global: cliContext.global,
    config,
    profile,
    target: createModelTarget(profile, delegate.temperature),
    budget: {
      numCtx: profile.provider.numCtx,
      maxOutputTokens,
      reserveTokens: profile.budget.reserveTokens,
      charsPerToken: profile.budget.charsPerToken,
      safetyMargin: profile.budget.safetyMargin,
    },
    timeouts: { requestMs: delegate.requestTimeoutSec * 1000, checkMs: delegate.checkTimeoutSec * 1000 },
    lock: {
      lockPath: paths.gpuLock,
      command: `delegate ${subcommand}`,
      // The holder promises to finish one request within its own timeout; the stale rule adds its own
      // margin on top (spec 7.8).
      timeoutSec: delegate.requestTimeoutSec,
      waitSec: delegate.lockTimeoutSec,
    },
    addCleanup: (cleanup) => cliContext.interrupts.addCleanup(cleanup),
    resultsDir: paths.delegateResults,
    ledgerPath: paths.delegateLedger,
    matcher: createSensitiveMatcher({ extraPatterns: delegate.extraSensitivePatterns, platform }),
    platform,
    env: cliContext.env,
    signal: cliContext.signal,
    fetchImpl: dependencies.fetchImpl,
    probes: dependencies.probes,
    trackCleanup: (cleanup) => cliContext.interrupts.addCleanup(() => {
      cleanup();
      return 'restored the files of the interrupted apply';
    }),
    trackChild: (child) => cliContext.interrupts.trackChild(child),
    now,
    warnings: SUBCOMMANDS_WITHOUT_A_MODEL.includes(subcommand) ? [...warnings] : [...warnings, ...profileWarnings],
    requireProject: () => loadProjectFacts({ paths, cwd, platform }),
  };
  // A forced kill leaves an apply journal behind; every later delegate run puts those files back.
  context.warnings.push(...recoverUnfinishedApplies({ resultsDir: context.resultsDir, now: now() }));
  return context;
}

/**
 * Runs one model job: create the folder, run the handler, and record the outcome in `meta.json` and the
 * ledger whether it succeeded or was refused.
 * @param {DelegateContext} context
 * @param {DelegateDependencies} dependencies
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
async function runJob(context, dependencies) {
  const handler = JOB_HANDLERS[/** @type {'ask'} */ (context.subcommand)];
  if (!handler) throw usageError(`Unknown delegate subcommand '${context.subcommand}'`);
  const job = await createJob({
    resultsDir: context.resultsDir,
    command: context.subcommand,
    cwd: context.cwd,
    now: context.now,
    randomHex: dependencies.randomHex,
  });
  job.warnings.push(...context.warnings);
  /** @type {import('../delegate/results.js').JobOutcome} */
  let outcome;
  try {
    outcome = await handler(context, job);
  } catch (error) {
    const cliError = toCliError(error);
    attachOrchestratorAction(cliError);
    outcome = {
      status: cliError.code,
      exitCode: cliError.exitCode,
      code: cliError.code,
      message: cliError.hint ? `${cliError.message}. ${cliError.hint}` : cliError.message,
    };
    // An unexpected failure is a defect, not a refusal: record it, then let it surface with its stack.
    if (!(error instanceof CliError)) {
      await recordJob(context, job, outcome);
      throw error;
    }
  }
  return recordJob(context, job, outcome);
}

/**
 * @param {DelegateContext} context
 * @param {import('../delegate/results.js').Job} job
 * @param {import('../delegate/results.js').JobOutcome} outcome
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
async function recordJob(context, job, outcome) {
  const result = buildJobResult({ job, outcome, target: { model: context.target.modelTag, numCtx: context.target.numCtx }, now: context.now });
  await writeJobFile(job, 'meta.json', renderJobMeta(job, result));
  await appendLedger(context.ledgerPath, {
    jobId: job.id,
    command: job.command,
    cwd: job.cwd,
    fileCount: job.fileCount,
    localInputChars: job.localInputChars,
    summaryChars: result.summary.length,
    promptTokens: job.promptTokensActual,
    outputTokens: job.outputTokens,
    seconds: Math.round(/** @type {number} */ (result.data.durationMs) / 100) / 10,
    status: outcome.status,
    exitCode: result.exitCode,
    timestamp: new Date(context.now()).toISOString(),
  });
  return { exitCode: result.exitCode, code: result.code, message: result.message, data: result.data, warnings: result.warnings };
}

/**
 * @param {DelegateContext} context
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
async function runLedger(context) {
  const entries = await readLedger(context.ledgerPath);
  const summary = summarizeLedger(entries, { since: /** @type {string | undefined} */ (context.options.since), now: context.now });
  return { data: { ledgerPath: context.ledgerPath, ...summary }, message: renderLedgerText(summary, context.ledgerPath) };
}

/**
 * Spec 12.3 and amendment 36.6: delegation that is switched off refuses with exit 8, so an orchestrator
 * reads one clear "do it yourself" instead of a stack of failed requests.
 * @param {import('../core/config.js').Config} config
 */
export function assertDelegationEnabled(config) {
  if (/** @type {{ enabled?: boolean }} */ (config.delegate).enabled === false) {
    throw new CliError('Delegation to the local model is turned off in config.json (delegate.enabled is false)', {
      exitCode: EXIT.UNSUPPORTED,
      code: 'delegate_unsupported',
      data: { orchestratorAction: 'do_it_yourself' },
      hint: 'Do this task yourself. Only the person who owns this machine turns delegation back on.',
    });
  }
}

/**
 * The rendered runtime profile is the one source the plugin, the CLI and this lane share (spec 4.3). It
 * exists once `setup` has run for this version; before that, the same values are computed in memory from
 * `config.json` and the preset, so `delegate health` can still explain the setup.
 * @param {{ paths: ReturnType<typeof getHomePaths>, config: import('../core/config.js').Config, cliVersion: string, home: string, platform: NodeJS.Platform }} input
 * @returns {Promise<{ profile: import('../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile, warnings: string[] }>}
 */
async function loadDelegateProfile({ paths, config, cliVersion, home }) {
  const profilePath = paths.profile(cliVersion).runtimeProfile;
  /** @type {string | undefined} */
  let text;
  try {
    text = await fs.readFile(profilePath, 'utf8');
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code !== 'ENOENT') throw error;
  }
  if (text !== undefined) {
    const parsed = parseRuntimeProfile(text);
    if (parsed.ok) return { profile: parsed.profile, warnings: [] };
    throw new CliError(`The runtime profile at ${profilePath} is not usable: ${parsed.reason}`, {
      exitCode: EXIT.USAGE,
      code: 'profile_invalid',
      hint: "Run 'opencode-unity setup' to write it again, or 'opencode-unity doctor --profile'.",
    });
  }
  const built = buildRuntimeProfile({ config, preset: loadPreset(config.preset), cliVersion, home });
  return {
    profile: built.profile,
    warnings: [`There is no rendered profile at ${profilePath}; the values come from config.json and preset '${config.preset}'. Run 'opencode-unity setup'.`, ...built.warnings],
  };
}

/**
 * The project facts `--check auto` needs: the compile map `init` wrote for this project (spec 9.3).
 * @param {{ paths: ReturnType<typeof getHomePaths>, cwd: string, platform: NodeJS.Platform }} input
 * @returns {{ root: string, compileMap: import('../facts/compile-map.js').CompileRow[] }}
 */
function loadProjectFacts({ paths, cwd, platform }) {
  const root = findUnityProjectRoot(createNodeFsView(), cwd) ?? cwd;
  const projectId = getProjectId(root, { platform });
  const projectJson = paths.project(projectId).projectJson;
  /** @type {any} */
  let facts;
  try {
    facts = JSON.parse(fsSync.readFileSync(projectJson, 'utf8'));
  } catch {
    throw usageError(`--check auto needs the project facts at ${projectJson}; run 'opencode-unity init' in ${root} first`);
  }
  return { root, compileMap: Array.isArray(facts.compileMap) ? facts.compileMap : [] };
}

/**
 * `--project` names the directory the files belong to; without it the caller's own directory is used.
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @returns {string}
 */
function resolveWorkingDirectory(cliContext) {
  return path.resolve(cliContext.cwd, cliContext.global.project ?? '.');
}

/**
 * @param {import('../cli/args.js').OptionValue} value
 * @returns {number | undefined}
 */
function readPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * @param {DelegateContext} context
 * @param {import('../cli/main.js').CommandResult} result
 * @returns {import('../cli/main.js').CommandResult}
 */
function withWarnings(context, result) {
  return context.warnings.length === 0 ? result : { ...result, warnings: [...context.warnings, ...(result.warnings ?? [])] };
}
