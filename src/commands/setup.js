// `opencode-unity setup` (spec 14.1). It asks before every persistent change, records each one in the
// install manifest, and rolls the whole thing back if any part fails.
//
// The order the user sees is deliberate: the platform block first, so nobody agrees to a 19 GiB download
// before they know their machine is on an experimental row, then one question per change, then the work.
import fs from 'node:fs/promises';
import os from 'node:os';
import { buildHostInstallStep } from '../hosts/install.js';
import { CliError, EXIT, usageError } from '../cli/exit-codes.js';
import { CLI_NAME } from '../cli/version.js';
import { loadConfig, renderInitialConfig } from '../core/config.js';
import { sha256File, sha256Hex } from '../core/hash.js';
import { getHomeDir, getHomePaths, getPathApi } from '../core/paths.js';
import { detectPlatform, describePlatform, resolveTier } from '../core/platform.js';
import { assertPresetAllowed, getPresetPlatformStatus, loadAllPresets, loadPreset, recommendPreset } from '../core/presets.js';
import { assertProfileAllowed, buildRuntimeProfile, loadCompat } from '../core/profile.js';
import { createOllamaClient } from '../ollama/client.js';
import { renderModelfile } from '../ollama/modelfile.js';
import { applyPlan } from '../install/apply.js';
import { pathExists } from '../install/backup.js';
import { createModelInstaller, createNpmInstaller } from '../install/external.js';
import { createManifest, loadManifest } from '../install/manifest.js';
import { buildPlatformData, renderPlatformBlock } from '../install/platform-block.js';
import { applyDecisions, buildSetupPlan, markSettledSteps, renderPlanText, toConsentItems } from '../install/plan.js';
import { hasModel, runPreflight, withModelState } from '../install/preflight.js';
import { MODELFILE_FILE, renderProfileFiles } from '../install/profile.js';
import { describeDeprecatedDelegateFlag } from '../install/skills.js';
import { createUserEnvAdapter } from '../install/user-env.js';
import { parsePointer, renderPointer } from '../install/upgrade.js';
import { renderFragment, resolveFragmentPath, resolveLauncherPath, usableProjects } from '../install/wt-fragment.js';
import { readProjectsIndex } from '../project/local.js';
import { run as runUpgrade } from './upgrade.js';

/**
 * Injection points for tests. Nothing here reaches a real Ollama server, a real registry, the real
 * registry hive or the real launchd domain unless the CLI is actually run by a person.
 * @typedef {object} SetupDependencies
 * @property {import('../ollama/client.js').OllamaClient} [ollamaClient]
 * @property {import('../install/preflight.js').PreflightFacts} [preflight]  Skips every probe.
 * @property {import('../install/user-env.js').UserEnvAdapter} [userEnv]
 * @property {import('../install/external.js').ModelInstaller} [models]
 * @property {import('../install/external.js').NpmInstaller} [npm]
 * @property {import('../core/platform.js').PlatformFacts} [platformFacts]
 * @property {Record<string, Uint8Array>} [pluginFiles]
 * @property {import('../install/apply.js').ApplyIo['onOperation']} [onOperation]
 * @property {() => Date} [now]
 * @property {string} [homedir]
 */

/**
 * @param {import('../cli/main.js').CommandContext} context
 * @param {SetupDependencies} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(context, dependencies = {}) {
  const { output, env, platform, version: cliVersion } = context;
  const flags = readFlags(context);
  // `--migrate` is the migration half of setup (spec 5.4); it is the same code path as `upgrade`, so the
  // two can never disagree about what an installation left by an older version becomes.
  if (flags.migrate) return runUpgrade(context, dependencies);
  const home = getHomeDir({ env, platform });
  const paths = getHomePaths(home, { platform });
  // `facts.os` is the machine the support matrix and the preset table judge; `platform` is what the
  // filesystem and the process runner have to obey. In production they are the same value.
  const facts = dependencies.platformFacts ?? detectPlatform({ platform, env });
  const tier = resolveTier('setup', facts);
  if (flags.terminal && facts.os !== 'win32') {
    throw usageError(`--terminal adds a Windows Terminal profile, and this is ${facts.os}`);
  }
  const platformBlock = renderPlatformBlock(facts);
  for (const line of platformBlock) output.text(line);
  output.text();

  /** @type {string[]} */
  const warnings = [];
  if (flags.delegate.length > 0) warnings.push(describeDeprecatedDelegateFlag(flags.delegate));

  const loaded = await loadConfig(paths.config, { platform });
  const compat = loadCompat();
  const ollamaClient = dependencies.ollamaClient ?? createOllamaClient({ baseUrl: loaded.config.ollama.baseUrl });
  const facts0 = dependencies.preflight ?? (await runPreflight({ platform, env, nodeVersion: process.versions.node, compat, ollama: ollamaClient, signal: context.signal }));
  if (facts0.ollama.state === 'down' && !flags.noModel) {
    throw new CliError(`Ollama did not answer at ${loaded.config.ollama.baseUrl}`, {
      exitCode: EXIT.BLOCKED,
      code: 'ollama_unreachable',
      data: { baseUrl: loaded.config.ollama.baseUrl },
      hint: `Start Ollama and run '${CLI_NAME} setup' again, or use --no-model to write the profile only.`,
    });
  }

  const preset = selectPreset({ flags, loaded, facts, warnings, totalVramMiB: facts0.gpu.totalVramMiB });
  const preflight = withModelState(facts0, { base: /** @type {string} */ (preset.model.base), tag: /** @type {string} */ (preset.model.tag) });
  const built = buildRuntimeProfile({ config: loaded.config, userConfig: loaded.user, preset, cliVersion, home });
  assertProfileAllowed(built.profile, { experimental: flags.experimental });
  warnings.push(...built.warnings, ...loaded.warnings);

  const profilePaths = paths.profile(cliVersion);
  const api = getPathApi(platform);
  const files = {
    profileDir: profilePaths.dir,
    modelfilePath: api.join(profilePaths.dir, MODELFILE_FILE),
    modelfile: renderModelfile(built.resolved.preset.model),
    profileAssets: await renderProfileFiles({ profile: built.profile, config: loaded.config, cliVersion, pluginFiles: dependencies.pluginFiles }),
    configText: loaded.exists ? null : renderInitialConfig(preset.id),
    pointerText: renderPointer(cliVersion, await readPreviousVersion(paths.profileCurrent, cliVersion)),
    fragmentText: /** @type {string | null} */ (null),
  };

  const userEnv = dependencies.userEnv ?? createUserEnvAdapter({ platform, env, signal: context.signal });
  const fragment = await resolveFragment({ env, platform, paths, preflight, warnings });
  if (fragment) files.fragmentText = fragment.text;

  const { manifest: loadedManifest } = await loadManifest(paths.installManifest);
  const manifest = loadedManifest ?? createManifest(cliVersion, { now: dependencies.now });

  let plan = buildSetupPlan({
    cliVersion,
    platform,
    platformBlock,
    tier,
    tierAcknowledged: flags.experimental,
    paths,
    preset,
    // Never null here: selectPreset already refused a preset that does not apply to this platform.
    presetStatus: getPresetPlatformStatus(preset, facts.os) ?? preset.status,
    files,
    preflight,
    flags,
    userEnv,
    fragment: fragment ? { path: fragment.path } : null,
    hostTargets: flags.host,
  });
  warnings.push(...plan.warnings);
  const managedHosts = flags.host.filter((target) => target !== 'antigravity');
  const hostInput = { targets: managedHosts, homedir: dependencies.homedir ?? os.homedir(), platform, cliVersion, manifest };
  if (managedHosts.length > 0) {
    const hostPlan = await buildHostInstallStep(hostInput);
    plan.steps = plan.steps.map((step) => step.id === 'host-install' ? hostPlan.step : step);
    warnings.push(...hostPlan.warnings);
  }
  if (flags.host.includes('antigravity')) warnings.push('Antigravity integration remains a manual copy from hosts/antigravity; managed installation supports Claude and Codex.');
  plan = await markSettledSteps(plan, createProbe({ userEnv, installed: new Set(preflight.models), warnings }));

  for (const line of renderPlanText({ ...plan, platformBlock: [] })) output.text(line);
  output.text();

  if (context.global.dryRun) {
    return { message: 'Nothing was changed (--dry-run).', warnings, data: { platform: buildPlatformData(facts, { command: 'setup' }), preset: preset.id, plan: describePlan(plan), dryRun: true } };
  }

  const decisions = await context.consent.request(toConsentItems(plan));
  plan = applyDecisions(plan, decisions);
  if (managedHosts.length > 0 && plan.steps.some((step) => step.id === 'host-install' && step.accepted)) {
    const refreshed = await buildHostInstallStep(hostInput);
    plan.steps = plan.steps.map((step) => step.id === 'host-install' ? { ...refreshed.step, accepted: true } : step);
    warnings.push(...refreshed.warnings);
  }
  assertPlatformAcknowledged(plan, { facts, tier });

  const createdState = !(await pathExists(paths.state));
  await fs.mkdir(paths.state, { recursive: true });
  /** @type {import('../install/apply.js').ApplyResult} */
  let result;
  try {
    result = await applyPlan(plan.steps, {
      cliVersion,
      manifestPath: paths.installManifest,
      manifest,
      stagingRoot: paths.state,
      userEnv,
      models: dependencies.models ?? createModelInstaller({ env, platform, signal: context.signal }),
      npm: dependencies.npm ?? createNpmInstaller({ env, platform, signal: context.signal }),
      onOperation: dependencies.onOperation,
      now: dependencies.now,
      signal: context.signal,
      addCleanup: context.interrupts?.addCleanup,
    });
  } catch (error) {
    if (createdState) await removeIfEmpty(paths.state, paths.home);
    throw error;
  }

  for (const note of result.notes) output.text(note);
  for (const step of plan.steps) for (const line of step.lines) output.text(`${step.title}: ${line}`);
  if (result.backups.length > 0) output.text(`Backups: ${result.backups.map((backup) => backup.path).join(', ')}`);

  const applied = result.steps.filter((step) => step.status === 'applied').map((step) => step.id);
  return {
    message: applied.length === 0 ? 'Everything was already in place; nothing changed.' : `Done: ${applied.join(', ')}.`,
    warnings,
    data: {
      platform: buildPlatformData(facts, { command: 'setup' }),
      preset: preset.id,
      home,
      manifestPath: paths.installManifest,
      steps: result.steps,
      backups: result.backups.map((backup) => backup.path),
      newTemplates: result.newTemplates,
    },
  };
}

/**
 * @param {import('../cli/main.js').CommandContext} context
 * @returns {import('../install/plan.js').SetupFlags & { preset: string | null, delegate: string[], migrate: boolean }}
 */
function readFlags(context) {
  const delegate = toList(context.options.delegate);
  const host = toList(context.options.host);
  return {
    preset: typeof context.options.preset === 'string' ? context.options.preset : null,
    noModel: context.options.noModel === true,
    ollamaEnv: context.options.ollamaEnv === true,
    terminal: context.options.terminal === true,
    experimental: context.global.experimental === true,
    // --delegate is the deprecated spelling of --host (amendment D-H1); both select the same targets.
    host: host.length > 0 ? host : delegate,
    delegate,
    migrate: context.options.migrate === true,
  };
}

/**
 * @param {object} input
 * @param {{ preset: string | null, experimental: boolean }} input.flags
 * @param {import('../core/config.js').LoadedConfig} input.loaded
 * @param {import('../core/platform.js').PlatformFacts} input.facts
 * @param {string[]} input.warnings
 * @param {number | null} input.totalVramMiB
 * @returns {import('../core/presets.js').Preset}
 */
function selectPreset({ flags, loaded, facts, warnings, totalVramMiB }) {
  const platform = facts.os;
  const explicit = flags.preset ?? (typeof loaded.user.preset === 'string' ? loaded.user.preset : null);
  if (explicit !== null) {
    const preset = loadPreset(explicit);
    assertPresetAllowed(preset, { experimental: flags.experimental, platform, arch: facts.arch });
    return preset;
  }
  const recommended = recommendPreset(loadAllPresets(), { platform, arch: facts.arch, gpuVendor: vendorFor(facts.backend), totalVramMiB });
  if (recommended) return recommended;
  const fallback = loadPreset(loaded.config.preset);
  warnings.push(`No preset is recommended for this machine, so the configured '${fallback.id}' is used; pass --preset to choose another.`);
  assertPresetAllowed(fallback, { experimental: flags.experimental, platform, arch: facts.arch });
  return fallback;
}

/**
 * @param {import('../core/platform.js').AcceleratorBackend} backend
 * @returns {string | null}
 */
function vendorFor(backend) {
  if (backend === 'nvidia-smi') return 'nvidia';
  if (backend === 'amdgpu-sysfs') return 'amd';
  if (backend === 'darwin-unified') return 'apple';
  return null;
}

/**
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {NodeJS.Platform} input.platform
 * @param {import('../core/paths.js').HomePaths} input.paths
 * @param {{ windowsTerminal: boolean }} input.preflight
 * @param {string[]} input.warnings
 * @returns {Promise<{ path: string, text: string } | null>}
 */
async function resolveFragment({ env, platform, paths, preflight, warnings }) {
  if (platform !== 'win32' || !preflight.windowsTerminal) return null;
  const fragmentPath = resolveFragmentPath({ env, platform });
  if (fragmentPath === null) return null;
  const launcherPath = resolveLauncherPath({ env, platform });
  if (launcherPath === null) {
    warnings.push(`${CLI_NAME} is not on PATH yet, so no Windows Terminal profile is written; run setup again after the global install.`);
    return null;
  }
  const { projects } = await readProjectsIndex(paths.projectsIndex);
  return { path: fragmentPath, text: renderFragment(usableProjects(projects), { launcherPath }) };
}

/**
 * @param {string} pointerPath
 * @param {string} cliVersion
 * @returns {Promise<string | null>}
 */
async function readPreviousVersion(pointerPath, cliVersion) {
  try {
    const { version } = parsePointer(await fs.readFile(pointerPath, 'utf8'));
    return version === null || version === cliVersion ? null : version;
  } catch {
    return null;
  }
}

/**
 * @param {{ userEnv: import('../install/user-env.js').UserEnvAdapter, installed: Set<string>, warnings: string[] }} options
 * @returns {Parameters<typeof markSettledSteps>[1]}
 */
function createProbe({ userEnv, installed, warnings }) {
  return {
    fileDigest: async (target) => ((await pathExists(target)) ? sha256File(target) : null),
    hasModel: async (name) => hasModel(installed, name),
    // A probe that cannot read the user environment (a slow PowerShell start, a sandboxed shell) must
    // not abort setup: the variables are treated as unset, and a real write would surface its own error.
    readEnv: async (name) => {
      try {
        return await userEnv.read(name);
      } catch (error) {
        warnings.push(`Could not read the user environment variable ${name} (${error instanceof Error ? error.message : String(error)}); treating it as unset.`);
        return null;
      }
    },
    digest: (content) => sha256Hex(typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)),
  };
}

/**
 * An experimental row is usable, but only after somebody says so. `--experimental` is the same
 * acknowledgement in flag form; `--yes` deliberately is not (amendment 38.3).
 * @param {import('../install/plan.js').SetupPlan} plan
 * @param {{ facts: import('../core/platform.js').PlatformFacts, tier: import('../core/platform.js').TierResult }} context
 */
function assertPlatformAcknowledged(plan, { facts, tier }) {
  const step = plan.steps.find((candidate) => candidate.id === 'platform-acknowledge');
  if (!step || step.accepted) return;
  throw new CliError(tier.message ?? `${tier.rowLabel} is an experimental platform row`, {
    exitCode: EXIT.UNSUPPORTED,
    code: 'platform_not_acknowledged',
    data: { platform: describePlatform(facts, tier) },
    hint: 'Run setup again with --experimental, or answer yes to the first question.',
  });
}

/**
 * @param {import('../install/plan.js').SetupPlan} plan
 * @returns {Array<{ id: string, title: string, nature: string, operations: string[] }>}
 */
function describePlan(plan) {
  return plan.steps.map((step) => ({ id: step.id, title: step.title, nature: step.nature, operations: step.operations.map((operation) => operation.op) }));
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function toList(value) {
  // The registry has already checked each value against the option's choices.
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry !== '') : [];
}

/**
 * @param {string} directory
 * @param {string} home
 * @returns {Promise<void>}
 */
async function removeIfEmpty(directory, home) {
  for (const candidate of [directory, home]) {
    try {
      if ((await fs.readdir(candidate)).length === 0) await fs.rmdir(candidate);
    } catch {
      return;
    }
  }
}
