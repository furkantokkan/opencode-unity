// `opencode-unity start [path]` (spec 5.4, section 13): open a guarded OpenCode session on a Unity
// project.
//
// The sequence is 13.1, and its order is the product:
//
//   1. project, facts and local state          - a session without facts is a generic coding session
//   2. platform and versions                   - an untested OpenCode is refused, not warned about
//   3. Ollama reachable                        - offered, never started behind the user's back
//   4. per-launch content and clean-room env   - what the session may do, written once, here
//   5. effective verification (V-a..V-e)       - because a project file can re-allow what we denied
//   6. guard verdict, and `--warm` if it passed
//   7. banner, with a pause when something is yellow
//   8. Windows Terminal status pane
//   9. the OpenCode child, with inherited stdio
//  10. session summary and the hint that frees video memory
//
// `--print-env` stops after step 4 and prints what would have been used, which is the honest way to
// answer "what does this run with?" without running it.
//
// Extension seams, in landing order: S38 inserts the tier line and its acknowledgement (33.4, 36.5),
// S39 the network line and `--offline`, S41 the shaping step and `--prompt` forwarding, S58 the
// component line. Each is marked below with the step it belongs to.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTextTokens } from '../../plugin/opencode-unity-lib/tokens.js';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { isAccepted } from '../cli/consent.js';
import { runProcess } from '../core/exec.js';
import { sha256Hex } from '../core/hash.js';
import { getOllamaDefaultPaths } from '../core/paths.js';
import { compareVersions, createOllamaClient } from '../ollama/client.js';
import { guardedWarm } from '../ollama/guarded-chat.js';
import {
  buildVerifyCacheKey,
  createVerificationError,
  VERIFY_CACHE_VERSION,
  verifyConfigShape,
  verifyInstructionFiles,
  verifyNonNegotiableRules,
  verifyPluginLoaded,
  verifyVisibleTools,
} from '../opencode/effective-config.js';
import { buildLaunchContent, renderLaunchContentEnv, renderLaunchContentFile } from '../opencode/content.js';
import { buildEditorLaunchInput, buildEditorLocalRecord, requireEditorAgent, resolveRecordedEditorAgent } from '../opencode/editor.js';
import { buildLaunchEnv, describeLaunchEnv } from '../opencode/launch-env.js';
import { requireOpencode, readOpencodeVersion } from '../opencode/locate.js';
import { DEFAULT_AGENT, EDITOR_AGENT, buildUnityCodePermission } from '../opencode/render.js';
import { recordProject, writeLocalState } from '../project/local.js';
import { checkProjectFreshness, loadSession, requireInitializedProject, resolveProject } from '../project/session.js';
import { buildBanner, hasAttention, renderBanner, summarizeGuardForBanner } from '../terminal/banner.js';
import { readSessionRecords, renderSummary, STOP_HINT, summarizeSession } from '../terminal/summary.js';
import { decidePane, openStatusPane } from '../terminal/wt.js';
import { evaluateGuardFor } from './guard.js';
import { run as runInit } from './init.js';

/** Spec 13.1 step 7: long enough to read a yellow line before the TUI covers it. */
export const ATTENTION_PAUSE_MS = 3000;
/** Spec 13.1 step 3: how long the Ollama tray app gets to start listening. */
export const OLLAMA_START_TIMEOUT_MS = 60_000;
export const OLLAMA_POLL_MS = 1000;
export const DEBUG_PROBE_TIMEOUT_MS = 60_000;
export const START_OLLAMA_CONSENT_ID = 'start-ollama-app';
export const RUN_INIT_CONSENT_ID = 'run-init';

/** Fixture of the tools OpenCode 1.18.31 shows; V-c only runs when it is present (see below). */
const EXPECTED_TOOLS_URL = new URL('../opencode/expected-tools-1.18.31.json', import.meta.url);

/**
 * @typedef {object} StartDependencies
 * @property {typeof fetch} [fetchImpl]
 * @property {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes} [probes]
 * @property {typeof runProcess} [run]
 * @property {(options: SpawnOptions) => Promise<{ exitCode: number | null, signal: NodeJS.Signals | null }>} [spawnChild]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 * @property {import('../unity/fs-view.js').FsView} [view]
 * @property {(appPath: string, options: { env: Record<string, string | undefined> }) => Promise<void>} [startApp]
 */

/**
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {StartDependencies} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(cliContext, dependencies = {}) {
  const session = await loadSession(cliContext);
  const warnings = [...session.warnings];

  // Step 1: the project, its facts and the machine-local state `init` wrote. A project without them is
  // offered `init` first; declining is exit 1 (spec 5.4).
  const project = await requireProjectFacts({ session, cliContext, dependencies });
  const freshness = checkProjectFreshness(project, { env: session.env, ...(dependencies.view ? { view: dependencies.view } : {}) });
  if (freshness.stale) warnings.push(`The facts for ${project.name} are older than the project (${freshness.reason}). Run 'opencode-unity init --refresh' for an accurate session.`);

  // Step 2: versions. The platform itself was decided by the support matrix before this module loaded
  // (amendment 33.4); S38 adds the acknowledgement and the tier banner line here.
  const binary = requireOpencode({ env: session.env, platform: session.platform });
  warnings.push(...binary.notes);
  const versions = await checkVersions({ session, cliContext, binary, dependencies });
  warnings.push(...versions.warnings);

  // Step 3: Ollama has to be listening. Starting it loads no model.
  const ollama = await requireOllama({ session, cliContext, dependencies });
  warnings.push(...ollama.warnings);

  // Step 4: what this session may do, and the environment it runs in. The editor agent is decided once,
  // by the same module `init` asked, so an unconfirmed hub never reaches the launch content (spec 11.1).
  const editor = resolveProjectEditor(project);
  const agent = resolveAgent(cliContext, session, editor);
  if (agent === EDITOR_AGENT || project.settings.editor.enabled) warnings.push(...editor.warnings);
  const launch = buildLaunch({ session, project, agent, cliContext, editor });
  warnings.push(...launch.env.warnings);
  // `--dry-run` (spec 5.1): the launch as it would happen, with nothing written and nothing started.
  if (cliContext.global.dryRun === true) return describeStartPlan({ cliContext, project, agent, launch, binary, warnings });
  await fs.writeFile(project.paths.launchJson, renderLaunchContentFile(launch.content), 'utf8');
  await refreshEditorRecord(project, editor);

  if (cliContext.options.printEnv === true) {
    for (const line of renderPrintEnv(launch)) cliContext.output.text(line);
    return {
      message: `${project.name} would start with agent ${agent} and ${Object.keys(launch.env.env).length} environment variables`,
      data: { agent, projectId: project.id, launchJson: project.paths.launchJson, env: describeLaunchEnv(launch.env), content: launch.content },
      warnings,
    };
  }

  // Step 5: what the merged configuration actually allows, not what we rendered.
  const verification = await verifyLaunch({ session, project, agent, launch, binary, versions, cliContext, dependencies });
  warnings.push(...verification.warnings);

  // Step 6: the guard is advisory here - the plugin enforces it at the first request (7.5).
  const verdict = await evaluateGuardFor(session, { cold: true, ...(dependencies.probes ? { probes: dependencies.probes } : {}) });
  const warm = cliContext.options.warm === true || session.config.start.warm;
  if (warm && verdict.pass) {
    const loaded = await guardedWarm({
      profile: session.profile,
      command: 'start --warm',
      lockPath: session.paths.gpuLock,
      platform: session.platform,
      addCleanup: (cleanup) => cliContext.interrupts.addCleanup(cleanup),
      signal: cliContext.signal,
      ...(dependencies.fetchImpl ? { fetch: dependencies.fetchImpl } : {}),
      ...(dependencies.probes ? { probes: dependencies.probes } : {}),
    });
    warnings.push(...loaded.warnings);
  } else if (warm) {
    warnings.push('The guard blocked the warm-up, so the model was not loaded; the first prompt tries again.');
  }

  // Step 7: the banner, and a pause when it carries something the user should read.
  const banner = buildBanner(buildBannerInput({ session, project, agent, verdict, versions, verification, freshness, editorAgent: launch.editorAgent }));
  cliContext.output.text(renderBanner(banner, { paint: cliContext.output.paint }));
  if (hasAttention(banner)) await (dependencies.sleep ?? sleep)(ATTENTION_PAUSE_MS);

  // Step 8: the status pane, which is a convenience and never fails the launch.
  const pane = decidePane({ platform: session.platform, env: session.env, noPane: cliContext.options.noPane === true, configPane: session.config.start.pane });
  if (pane.warning) warnings.push(pane.warning);
  if (pane.open) {
    const opened = await openStatusPane({
      nodePath: process.execPath,
      cliPath: resolveCliPath(),
      project: project.root,
      env: session.env,
      platform: session.platform,
      ...(dependencies.run ? { run: dependencies.run } : {}),
    });
    warnings.push(...opened.notes);
  }

  // Step 9: the child. Its stdio is inherited, so the TUI owns the terminal from here.
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  await recordProject(session.paths.projectsIndex, { id: project.id, name: project.name, path: project.root, lastStart: new Date(startedAt).toISOString() });
  const spawnChild = dependencies.spawnChild ?? spawnOpencode;
  const child = await spawnChild({
    file: binary.file,
    args: buildOpencodeArgs(cliContext, agent),
    cwd: project.root,
    env: launch.env.env,
    interrupts: cliContext.interrupts,
  });

  // Step 10: what happened, and the one command that gives the video memory back.
  const records = await readSessionRecords({ sessionsDir: session.paths.sessionsDir, sinceMs: startedAt, untilMs: now() });
  const summary = summarizeSession(records);
  for (const line of renderSummary(summary, { paint: cliContext.output.paint, durationMs: now() - startedAt })) cliContext.output.text(line);
  cliContext.output.text(cliContext.output.paint.dim(STOP_HINT));

  const childSignal = child.signal ?? null;
  const data = { agent, projectId: project.id, root: project.root, summary, guard: verdict.verdict, childExitCode: child.exitCode, childSignal };
  // A child ended by a signal has no exit code. This CLI's own interrupt handling exits 130 before it
  // gets here, so a signal seen here is a crash or an outside kill, and it is not a normal end.
  if (child.exitCode === null && childSignal !== null) {
    throw new CliError(`OpenCode was ended by ${childSignal}`, { exitCode: EXIT.RUNTIME, code: 'opencode_failed', data });
  }
  if (child.exitCode === 0 || child.exitCode === null) return { message: `The session for ${project.name} ended`, data, warnings };
  throw new CliError(`OpenCode exited with code ${child.exitCode}`, { exitCode: EXIT.RUNTIME, code: 'opencode_failed', data });
}

/**
 * What `start --dry-run` prints: the launch as it would happen - agent, command, working directory and
 * the files a real start writes - after every read-only check has run. Nothing is written, OpenCode is
 * not started and no model is loaded.
 * @param {{ cliContext: import('../cli/main.js').CommandContext, project: import('../project/session.js').ProjectContext, agent: string, launch: ReturnType<typeof buildLaunch>, binary: import('../opencode/locate.js').OpencodeLocation, warnings: string[] }} input
 * @returns {import('../cli/main.js').CommandResult}
 */
function describeStartPlan({ cliContext, project, agent, launch, binary, warnings }) {
  const args = buildOpencodeArgs(cliContext, agent);
  const wouldWrite = [project.paths.launchJson, project.paths.verifyCache];
  const lines = [
    `Dry run for ${project.name}: nothing is written and OpenCode is not started. A real start:`,
    `  writes ${project.paths.launchJson}`,
    `  verifies the merged configuration and caches the result in ${project.paths.verifyCache}`,
    `  runs ${binary.file} ${args.join(' ')} in ${project.root} with ${Object.keys(launch.env.env).length} environment variables`,
  ];
  for (const line of lines) cliContext.output.text(line);
  return {
    message: `${project.name} would start with agent ${agent}; dry run, nothing was written or started`,
    data: { dryRun: true, agent, projectId: project.id, root: project.root, wouldWrite, command: [binary.file, ...args], env: describeLaunchEnv(launch.env) },
    warnings,
  };
}

/**
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @returns {string | undefined}
 */
export function readRequestedPath(cliContext) {
  const positional = typeof cliContext.args.path === 'string' && cliContext.args.path !== '' ? cliContext.args.path : undefined;
  return positional ?? cliContext.global.project ?? undefined;
}

/**
 * Spec 13.1 step 2. An untested OpenCode is exit 8 rather than a warning, because every rule this
 * product renders was verified against one version; `--experimental` accepts another only when a
 * self-test for exactly that version has been recorded.
 * @param {{ session: import('../project/session.js').Session, cliContext: import('../cli/main.js').CommandContext, binary: import('../opencode/locate.js').OpencodeLocation, dependencies: StartDependencies }} input
 * @returns {Promise<{ opencode: string, ollama: string | null, warnings: string[] }>}
 */
export async function checkVersions({ session, cliContext, binary, dependencies }) {
  /** @type {string[]} */
  const warnings = [];
  const probe = await readOpencodeVersion(binary.file, {
    env: session.env,
    cwd: cliContext.cwd,
    signal: cliContext.signal,
    ...(dependencies.run ? { run: dependencies.run } : {}),
  });
  if (probe.version === null) {
    throw new CliError(`Could not read the OpenCode version from ${binary.file}: ${probe.error}`, {
      exitCode: EXIT.RUNTIME,
      code: 'opencode_version_unreadable',
      hint: "Run 'opencode --version' yourself, then 'opencode-unity doctor'.",
    });
  }
  const tested = session.profile.compat.opencode;
  if (probe.version !== tested) {
    const record = session.paths.selftestDir;
    const recorded = fsSync.existsSync(path.join(record, `${probe.version}.json`));
    if (!(cliContext.global.experimental && recorded)) {
      throw new CliError(`OpenCode ${probe.version} is installed; this version of opencode-unity was built and verified against ${tested}`, {
        exitCode: EXIT.UNSUPPORTED,
        code: 'opencode_version_untested',
        data: { found: probe.version, tested, selftestRecorded: recorded },
        hint: recorded
          ? `Add --experimental to run against ${probe.version} using the recorded self-test.`
          : `Install the tested version (npm i -g opencode-ai@${tested}), or run 'opencode-unity doctor --selftest' and then start with --experimental.`,
      });
    }
    warnings.push(`OpenCode ${probe.version} is not the tested version ${tested}; running on the recorded self-test because --experimental was given.`);
  }

  const client = createOllamaClient({
    baseUrl: session.profile.ollama.baseUrl,
    ...(dependencies.fetchImpl ? { fetch: dependencies.fetchImpl } : {}),
  });
  /** @type {string | null} */
  let ollamaVersion = null;
  try {
    ollamaVersion = await client.getVersion({ signal: cliContext.signal });
  } catch {
    // Reachability is step 3's question, with its own offer to start the app; not knowing the version
    // here only means the banner says so.
    return { opencode: probe.version, ollama: null, warnings };
  }
  const minimum = loadMinimumOllama(session);
  if (minimum !== null && compareVersions(ollamaVersion, minimum) < 0) {
    warnings.push(`Ollama ${ollamaVersion} is older than the minimum this product was verified with (${minimum}); update it if requests behave oddly.`);
  }
  return { opencode: probe.version, ollama: ollamaVersion, warnings };
}

/**
 * Spec 13.1 step 3. `ollama.startAppIfDown` decides whether the tray app may be started: `never` says
 * no, `always` says yes, `ask` asks. Starting the server loads no model.
 * @param {{ session: import('../project/session.js').Session, cliContext: import('../cli/main.js').CommandContext, dependencies: StartDependencies }} input
 * @returns {Promise<{ reachable: boolean, warnings: string[] }>}
 */
export async function requireOllama({ session, cliContext, dependencies }) {
  const client = createOllamaClient({
    baseUrl: session.profile.ollama.baseUrl,
    ...(dependencies.fetchImpl ? { fetch: dependencies.fetchImpl } : {}),
  });
  if (await isReachable(client, cliContext.signal)) return { reachable: true, warnings: [] };

  const policy = session.config.ollama.startAppIfDown;
  // `null` means "the platform default" (spec 6.2); only Windows has one, so elsewhere nothing is offered.
  const appPath = session.config.ollama.appPath ?? getOllamaDefaultPaths({ env: session.env, platform: session.platform }).appPath;
  if (policy === 'never' || appPath === null) throw ollamaDownError(session, appPath);
  // Starting the application is a side effect; a dry run says it would happen and goes on planning.
  if (cliContext.global.dryRun === true) {
    return { reachable: false, warnings: [`Ollama is not running; a real start ${policy === 'ask' ? 'offers to start' : 'starts'} the application at ${appPath}.`] };
  }
  if (policy === 'ask') {
    const accepted = await askOrDecline(cliContext, {
      id: START_OLLAMA_CONSENT_ID,
      title: `Start the Ollama application at ${appPath}`,
      detail: 'It starts the local server. No model is loaded by starting it.',
      recommended: true,
    });
    if (!accepted) throw ollamaDownError(session, appPath);
  }

  const startApp = dependencies.startApp ?? startDetached;
  try {
    await startApp(appPath, { env: session.env });
  } catch {
    throw ollamaDownError(session, appPath);
  }
  const deadline = (dependencies.now ?? Date.now)() + OLLAMA_START_TIMEOUT_MS;
  const wait = dependencies.sleep ?? sleep;
  while ((dependencies.now ?? Date.now)() < deadline) {
    await wait(OLLAMA_POLL_MS);
    if (await isReachable(client, cliContext.signal)) return { reachable: true, warnings: [`Ollama was not running; the application at ${appPath} was started.`] };
  }
  throw ollamaDownError(session, appPath);
}

/**
 * @param {import('../project/session.js').ProjectContext} project
 * @returns {import('../opencode/editor.js').EditorAgentState}
 */
export function resolveProjectEditor(project) {
  return resolveRecordedEditorAgent({ mcp: project.projectJson?.mcpForUnity ?? null, local: project.local, settings: project.settings.editor });
}

/**
 * The plugin reads the PlayMode choice from `local.json`, the only per-project file it opens, so a
 * change in `config.json` reaches it at the next launch rather than at the next scan. A disabled agent
 * leaves the record alone: nothing is configured to use it, and an earlier confirmation stays valid.
 * @param {import('../project/session.js').ProjectContext} project
 * @param {import('../opencode/editor.js').EditorAgentState} editor
 * @returns {Promise<void>}
 */
async function refreshEditorRecord(project, editor) {
  if (!project.local || !editor.enabled) return;
  const record = buildEditorLocalRecord(editor);
  if (JSON.stringify(project.local.editor) === JSON.stringify(record)) return;
  await writeLocalState(project.paths.localJson, { ...project.local, editor: record });
}

/**
 * Spec 13.1 step 4: the per-launch content (8.4) and the clean-room environment (8.1).
 * @param {{ session: import('../project/session.js').Session, project: import('../project/session.js').ProjectContext, agent: string, cliContext: import('../cli/main.js').CommandContext, editor: import('../opencode/editor.js').EditorAgentState }} input
 * @returns {{ content: Record<string, unknown>, env: import('../opencode/launch-env.js').LaunchEnvResult, editorAgent: boolean, permission: Record<string, unknown> }}
 */
export function buildLaunch({ session, project, agent, cliContext, editor }) {
  const editorInput = buildEditorLaunchInput(editor);
  const permission = buildUnityCodePermission({
    vcsKind: project.projectJson?.vcs?.kind ?? null,
    bashMode: project.settings.bashMode ?? session.config.safety.bashMode,
    csprojNames: listCsprojNames(project),
    safety: session.config.safety,
  });
  const content = buildLaunchContent({
    factsPath: project.paths.facts,
    unityCodePermission: permission,
    ...editorInput,
  });
  const env = buildLaunchEnv({
    env: session.env,
    home: session.home,
    profileDir: session.paths.profile(session.version).dir,
    xdgConfigDir: session.paths.xdgConfig,
    projectId: project.id,
    configContent: renderLaunchContentEnv(content),
    disableProjectConfig: cliContext.options.noProjectConfig === true || session.config.start.projectConfig === 'disable',
  });
  return { content, env, editorAgent: editorInput.editorAgent, permission };
}

/**
 * Spec 13.1 step 5 and 8.2. The result is cached per project; the key covers everything that could
 * change the effective configuration without changing our render.
 * @param {{ session: import('../project/session.js').Session, project: import('../project/session.js').ProjectContext, agent: string, launch: ReturnType<typeof buildLaunch>, binary: import('../opencode/locate.js').OpencodeLocation, versions: { opencode: string }, cliContext: import('../cli/main.js').CommandContext, dependencies: StartDependencies }} input
 * @returns {Promise<{ verified: boolean, cached: boolean, warnings: string[] }>}
 */
export async function verifyLaunch({ session, project, agent, launch, binary, versions, cliContext, dependencies }) {
  const key = buildVerifyCacheKey({
    opencodeVersion: versions.opencode,
    profileHash: hashProfile(session),
    contentHash: sha256Hex(JSON.stringify(launch.content)),
    projectConfigFiles: listProjectConfigFiles(project),
    directoryListings: listConfigDirectories(session, project),
    authMtimeMs: readAuthMtime(session),
  });
  const cached = await readVerifyCache(project.paths.verifyCache);
  if (cached?.key === key && cached.ok === true) return { verified: true, cached: true, warnings: [] };

  const run = dependencies.run ?? runProcess;
  const options = { env: launch.env.env, cwd: project.root, timeoutMs: DEBUG_PROBE_TIMEOUT_MS, signal: cliContext.signal, platform: session.platform };
  // V-a and V-b always ask about `unity-code`, whichever agent opens first: it is the one with `edit` and
  // `bash`, and Tab reaches it from any session (spec 8.2).
  const probeArgs = ['debug', 'agent', DEFAULT_AGENT];
  let agentProbe = await run(binary.file, probeArgs, options);
  // Spec 8.2 V-a: one retry, because a cold first run installs the plugin's dependencies.
  if (agentProbe.exitCode !== 0 || agentProbe.timedOut) agentProbe = await run(binary.file, probeArgs, options);
  const configProbe = await run(binary.file, ['debug', 'config'], options);

  const agentJson = readJsonOutput(agentProbe.stdout);
  const configJson = readJsonOutput(configProbe.stdout);
  const caseInsensitive = session.platform === 'win32';
  /** @type {string[]} */
  const warnings = [];

  const checks = [
    verifyPluginLoaded({ exitCode: agentProbe.exitCode ?? 1, timedOut: agentProbe.timedOut, stderr: agentProbe.stderr }),
    verifyNonNegotiableRules({ permission: agentJson?.permission ?? [], caseInsensitive }),
    verifyConfigShape({
      config: configJson ?? {},
      expected: {
        modelTag: session.profile.provider.modelTag,
        factsPath: project.paths.facts,
        profileDir: session.paths.profile(session.version).dir,
        editorAgent: launch.editorAgent,
        caseInsensitivePaths: caseInsensitive,
      },
    }),
    verifyInstructionFiles({
      files: listInstructionFiles(project),
      prefixTokens: estimateFixedPrompt(session, project, agent),
      failTokens: readAgentTokens(session.profile.budget.prefixFailTokens, agent),
    }),
  ];

  // V-c needs the recorded tool set of the tested OpenCode version. The fixture is S09's deliverable
  // and is not in the tree yet; until it lands the check is reported as not run, never as a pass.
  const expectedTools = readExpectedTools();
  if (expectedTools === null) warnings.push('V-c (visible tools) was not run: src/opencode/expected-tools-1.18.31.json is missing from this build.');
  else checks.push(verifyVisibleTools({ tools: agentJson?.tools ?? {}, expected: expectedTools, editorTools: [] }));

  const failures = checks.flatMap((check) => check.failures);
  if (failures.length > 0) throw createVerificationError({ ok: false, checks, failures }, { agent: DEFAULT_AGENT });
  await writeVerifyCache(project.paths.verifyCache, { version: VERIFY_CACHE_VERSION, key, ok: true, checkedAt: new Date((dependencies.now ?? Date.now)()).toISOString() });
  return { verified: true, cached: false, warnings };
}

/**
 * @param {{ session: import('../project/session.js').Session, project: import('../project/session.js').ProjectContext, agent: string, verdict: import('../../plugin/opencode-unity-lib/guard/decide.js').GuardVerdict, versions: { opencode: string, ollama: string | null }, verification: { verified: boolean, cached: boolean }, freshness: { stale: boolean }, editorAgent: boolean }} input
 * @returns {import('../terminal/banner.js').BannerInput}
 */
export function buildBannerInput({ session, project, agent, verdict, versions, verification, freshness, editorAgent }) {
  const profile = session.profile;
  return {
    version: session.version,
    project: {
      name: project.name,
      unityVersion: project.projectJson?.unity?.version ?? null,
      vcsKind: project.projectJson?.vcs?.kind === 'none' ? null : project.projectJson?.vcs?.kind ?? null,
      factsFresh: !freshness.stale,
      factsTokens: estimateFactsTokens(project, session),
    },
    preset: { id: profile.presetId, status: profile.presetStatus, opencodeVersion: versions.opencode, ollamaVersion: versions.ollama },
    model: {
      tag: profile.provider.modelTag,
      loaded: verdict.model.loaded,
      contextLength: verdict.model.contextLength,
      expiresInSec: verdict.model.expiresInSec,
      coldLoadSeconds: 15,
    },
    guard: summarizeGuardForBanner(verdict, profile.guard),
    budget: {
      fixedPromptTokens: estimateFixedPrompt(session, project, agent),
      promptBudget: profile.budget.promptBudget,
      numCtx: profile.provider.numCtx,
      prefixFailTokens: readAgentTokens(profile.budget.prefixFailTokens, agent),
      bashMode: project.settings.bashMode ?? session.config.safety.bashMode,
    },
    config: { verified: verification.verified, cached: verification.cached, editorAgent },
  };
}

/**
 * Spec 5.4: only `--continue`, `--session` and `--prompt` are forwarded. `--prompt` is forwarded
 * verbatim here; S41 puts the shaping step and its forward check in front of it.
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {string} agent
 * @returns {string[]}
 */
export function buildOpencodeArgs(cliContext, agent) {
  const args = ['--agent', agent];
  if (cliContext.options.continue === true) args.push('--continue');
  if (typeof cliContext.options.session === 'string') args.push('--session', cliContext.options.session);
  if (typeof cliContext.options.prompt === 'string') args.push('--prompt', cliContext.options.prompt);
  return args;
}

/**
 * The editor agent is refused before OpenCode is spawned when it has nowhere to send a tool call; the
 * envelope code names the reason (`editor_disabled`, `editor_hub_unconfirmed`, ...).
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {import('../project/session.js').Session} session
 * @param {import('../opencode/editor.js').EditorAgentState} editor
 * @returns {string}
 */
export function resolveAgent(cliContext, session, editor) {
  const requested = typeof cliContext.options.agent === 'string' ? cliContext.options.agent : session.config.start.agent;
  if (requested !== EDITOR_AGENT) return requested;
  requireEditorAgent(editor);
  return EDITOR_AGENT;
}

/**
 * @typedef {object} SpawnOptions
 * @property {string} file
 * @property {readonly string[]} args
 * @property {string} cwd
 * @property {Record<string, string>} env
 * @property {import('../cli/signals.js').InterruptController} interrupts
 */

/**
 * The OpenCode child. Its stdio is inherited, so the TUI draws straight to the terminal. Never a `.cmd`
 * shim: `locate.js` resolved the real executable, so nothing re-parses the arguments.
 *
 * Ctrl+C reaches every process on the console, and inside the TUI it means "stop this answer", not
 * "quit". So this process ignores interactive interrupts while the child runs and lets OpenCode decide;
 * closing the window or a SIGTERM still stops the whole child tree.
 * @param {SpawnOptions} options
 * @returns {Promise<{ exitCode: number | null, signal: NodeJS.Signals | null }>}
 */
export function spawnOpencode({ file, args, cwd, env, interrupts }) {
  return new Promise((resolve, reject) => {
    const resume = interrupts.suspendInterrupts();
    const child = spawn(file, [...args], { cwd, env, stdio: 'inherit', shell: false, windowsHide: false });
    const untrack = interrupts.trackChild(child);
    const finish = () => {
      untrack?.();
      resume();
    };
    child.on('error', (error) => {
      finish();
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      finish();
      resolve({ exitCode, signal });
    });
  });
}

/**
 * @param {ReturnType<typeof buildLaunch>} launch
 * @returns {string[]}
 */
export function renderPrintEnv(launch) {
  const described = describeLaunchEnv(launch.env);
  const lines = ['environment'];
  for (const [name, value] of described.set) lines.push(`  ${name}=${value}`);
  lines.push('removed (values are never printed)');
  for (const name of [...described.removedOpencode, ...described.removedCredentials]) lines.push(`  ${name}`);
  lines.push('content (OPENCODE_CONFIG_CONTENT)');
  lines.push(renderLaunchContentFile(launch.content).trimEnd());
  return lines;
}

/**
 * Spec 13.1 step 1: resolve the project and, when `init` never ran for it, offer to run it now. The scan
 * is read-only on the project, so accepting changes nothing but the product's own home.
 * @param {{ session: import('../project/session.js').Session, cliContext: import('../cli/main.js').CommandContext, dependencies: StartDependencies }} input
 * @returns {Promise<import('../project/session.js').ProjectContext>}
 */
export async function requireProjectFacts({ session, cliContext, dependencies }) {
  const project = await resolveProject(session, { path: readRequestedPath(cliContext) });
  if (project.initialized) return project;
  // A dry run does not scan: `init` writes, so the plan stops at the same exit 1 a declined scan gives.
  if (cliContext.global.dryRun === true) return requireInitializedProject(project);
  const accepted = await askOrDecline(cliContext, {
    id: RUN_INIT_CONSENT_ID,
    title: `Scan ${project.root} now (opencode-unity init)`,
    detail: 'Read-only on the project; the facts are written under the opencode-unity home.',
    recommended: true,
  });
  if (!accepted) return requireInitializedProject(project);
  const scanned = await runInit({ ...cliContext, command: 'init', args: { path: project.root }, options: {} }, dependencies.run ? { run: dependencies.run } : {});
  if (scanned.message) cliContext.output.text(scanned.message);
  return requireInitializedProject(await resolveProject(session, { path: project.root }));
}

/**
 * A consent answer that cannot be given - a non-interactive run without `--yes` - is a "no" here, so
 * `start` keeps the exit codes it documents (1 for refused facts, 2 for Ollama) instead of exit 9.
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {import('../cli/consent.js').ConsentItem} item
 * @returns {Promise<boolean>}
 */
async function askOrDecline(cliContext, item) {
  try {
    return isAccepted(await cliContext.consent.request([item]), item.id);
  } catch (error) {
    if (error instanceof CliError && error.exitCode === EXIT.CONSENT_REQUIRED) return false;
    throw error;
  }
}

/**
 * Starts the Ollama application and lets it go. It is a long-running tray app, so it is detached and
 * unreferenced rather than awaited: `runProcess` would kill its whole process tree at the timeout.
 * Resolves once the process has spawned; rejects when it could not be started at all.
 * @param {string} appPath
 * @param {{ env: Record<string, string | undefined> }} options
 * @returns {Promise<void>}
 */
export function startDetached(appPath, { env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(appPath, [], { env, detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * @param {import('../ollama/client.js').OllamaClient} client
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
async function isReachable(client, signal) {
  try {
    await client.getVersion({ signal });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import('../project/session.js').Session} session
 * @param {string | null} appPath
 * @returns {CliError}
 */
function ollamaDownError(session, appPath) {
  return new CliError(`Ollama is not answering at ${session.profile.ollama.baseUrl}`, {
    exitCode: EXIT.BLOCKED,
    code: 'ollama_unreachable',
    data: { baseUrl: session.profile.ollama.baseUrl, appPath },
    hint: appPath === null ? 'Start Ollama, then run start again.' : `Start ${appPath}, then run start again.`,
  });
}

/**
 * @param {import('../project/session.js').Session} session
 * @returns {string | null}
 */
function loadMinimumOllama(session) {
  const value = session.profile.compat.ollama;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * @param {import('../project/session.js').ProjectContext} project
 * @returns {string[]}
 */
function listCsprojNames(project) {
  const rows = Array.isArray(project.projectJson?.compileMap) ? project.projectJson.compileMap : [];
  return [...new Set(rows.map((/** @type {{ csproj?: unknown }} */ row) => row.csproj).filter((name) => typeof name === 'string'))];
}

/**
 * @param {import('../project/session.js').ProjectContext} project
 * @returns {Array<{ path: string, tokens: number }>}
 */
function listInstructionFiles(project) {
  const files = Array.isArray(project.projectJson?.instructionFiles) ? project.projectJson.instructionFiles : [];
  return files
    .filter((/** @type {{ attached?: boolean }} */ file) => file && typeof file === 'object')
    .map((/** @type {{ path?: unknown, tokens?: unknown }} */ file) => ({ path: String(file.path ?? ''), tokens: typeof file.tokens === 'number' ? file.tokens : 0 }));
}

/**
 * The fixed part of every prompt: the agent's own text, the project facts and the tool schemas.
 * @param {import('../project/session.js').Session} session
 * @param {import('../project/session.js').ProjectContext} project
 * @param {string} agent
 * @returns {number}
 */
function estimateFixedPrompt(session, project, agent) {
  return estimateFactsTokens(project, session) + readAgentTokens(session.profile.budget.toolsTokens, agent);
}

/**
 * @param {import('../project/session.js').ProjectContext} project
 * @param {import('../project/session.js').Session} session
 * @returns {number}
 */
function estimateFactsTokens(project, session) {
  let text = '';
  try {
    text = fsSync.readFileSync(project.paths.facts, 'utf8');
  } catch {
    return 0;
  }
  return estimateTextTokens(text, { charsPerToken: session.profile.budget.charsPerToken });
}

/**
 * @param {{ 'unity-code': number, 'unity-editor': number }} tokens
 * @param {string} agent
 * @returns {number}
 */
function readAgentTokens(tokens, agent) {
  return agent === EDITOR_AGENT ? tokens[EDITOR_AGENT] : tokens[DEFAULT_AGENT];
}

/**
 * @param {import('../project/session.js').Session} session
 * @returns {string}
 */
function hashProfile(session) {
  const profilePaths = session.paths.profile(session.version);
  const parts = [profilePaths.opencodeConfig, profilePaths.runtimeProfile].map((file) => {
    try {
      return fsSync.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  });
  return sha256Hex(parts.join('\u0000'));
}

/**
 * Project `opencode.json(c)` files, from the project root up to the version-control root (OC
 * `config/config.ts` L420-424). The recorded VCS depth bounds the walk; without one only the project
 * root is looked at.
 * @param {import('../project/session.js').ProjectContext} project
 * @returns {Array<{ path: string, hash: string, mtimeMs: number }>}
 */
function listProjectConfigFiles(project) {
  const depth = typeof project.projectJson?.vcs?.depth === 'number' ? project.projectJson.vcs.depth : 0;
  /** @type {Array<{ path: string, hash: string, mtimeMs: number }>} */
  const files = [];
  let directory = project.root;
  for (let level = 0; level <= Math.max(0, depth); level += 1) {
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      const file = path.join(directory, name);
      try {
        const text = fsSync.readFileSync(file, 'utf8');
        files.push({ path: file, hash: sha256Hex(text), mtimeMs: fsSync.statSync(file).mtimeMs });
      } catch {
        continue;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return files;
}

/**
 * @param {import('../project/session.js').Session} session
 * @param {import('../project/session.js').ProjectContext} project
 * @returns {Record<string, string[]>}
 */
function listConfigDirectories(session, project) {
  const userHome = session.env.USERPROFILE ?? session.env.HOME ?? '';
  /** @type {Record<string, string[]>} */
  const listings = {};
  for (const directory of [path.join(project.root, '.opencode'), userHome === '' ? null : path.join(userHome, '.opencode')]) {
    if (directory === null) continue;
    try {
      listings[directory] = fsSync.readdirSync(directory).sort();
    } catch {
      listings[directory] = [];
    }
  }
  return listings;
}

/**
 * @param {import('../project/session.js').Session} session
 * @returns {number}
 */
function readAuthMtime(session) {
  const userHome = session.env.USERPROFILE ?? session.env.HOME ?? '';
  const candidates = [
    session.env.XDG_DATA_HOME ? path.join(session.env.XDG_DATA_HOME, 'opencode', 'auth.json') : null,
    userHome === '' ? null : path.join(userHome, '.local', 'share', 'opencode', 'auth.json'),
    session.env.LOCALAPPDATA ? path.join(session.env.LOCALAPPDATA, 'opencode', 'auth.json') : null,
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    try {
      return fsSync.statSync(candidate).mtimeMs;
    } catch {
      continue;
    }
  }
  return 0;
}

/**
 * @returns {readonly string[] | null}
 */
function readExpectedTools() {
  try {
    const value = JSON.parse(fsSync.readFileSync(EXPECTED_TOOLS_URL, 'utf8'));
    return Array.isArray(value) ? value : Array.isArray(value?.tools) ? value.tools : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {Promise<{ key?: string, ok?: boolean } | null>}
 */
async function readVerifyCache(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @param {Record<string, unknown>} record
 * @returns {Promise<void>}
 */
async function writeVerifyCache(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * `opencode debug ...` prints JSON; anything that is not JSON leaves the check to fail on its own
 * terms rather than on a parse error.
 * @param {string} text
 * @returns {Record<string, any> | null}
 */
function readJsonOutput(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

/**
 * @returns {string}
 */
function resolveCliPath() {
  return fileURLToPath(new URL('../../bin/opencode-unity.mjs', import.meta.url));
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
