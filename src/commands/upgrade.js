// `opencode-unity upgrade` (spec 14.3). npm replaces the package; this command migrates what the package
// left behind, and it does so under the same rule as setup: what is still ours is replaced, what the user
// edited is carried over with the new version beside it as `<file>.ocu-new`.
import fs from 'node:fs/promises';
import { CliError, EXIT, usageError } from '../cli/exit-codes.js';
import { CLI_NAME } from '../cli/version.js';
import { loadConfig } from '../core/config.js';
import { stringifyJson } from '../core/jsonc.js';
import { getHomeDir, getHomePaths } from '../core/paths.js';
import { detectPlatform } from '../core/platform.js';
import { getPresetPlatformStatus, loadPreset } from '../core/presets.js';
import { buildRuntimeProfile, loadCompat } from '../core/profile.js';
import { createOllamaClient } from '../ollama/client.js';
import { renderModelfile } from '../ollama/modelfile.js';
import { applyPlan } from '../install/apply.js';
import { pathExists } from '../install/backup.js';
import { createModelInstaller } from '../install/external.js';
import { compareVersions, createdBy, entriesOfKind, entryIdentity, loadManifest, removeEntries, saveManifest } from '../install/manifest.js';
import { FACTS_GENERATOR_VERSION } from '../facts/stale.js';
import { readProjectsIndex } from '../project/local.js';
import { runPreflight } from '../install/preflight.js';
import { MODELFILE_FILE, renderProfileFiles } from '../install/profile.js';
import { DERIVED_TAG_PREFIX } from '../install/uninstall.js';
import { createUserEnvAdapter } from '../install/user-env.js';
import { describeCompatibility, listStaleProjects, modelNeedsNewTag, parsePointer, planExternalFiles, planProfileMigration, planRollback, renderPointer } from '../install/upgrade.js';
import { renderFragment, resolveFragmentPath, resolveLauncherPath, usableProjects } from '../install/wt-fragment.js';

/** A 64-character placeholder; apply replaces it with the digest of what it actually wrote. */
const PLACEHOLDER_SHA = '0'.repeat(64);

/**
 * @typedef {object} UpgradeDependencies
 * @property {import('../ollama/client.js').OllamaClient} [ollamaClient]
 * @property {import('../install/preflight.js').PreflightFacts} [preflight]  Skips every probe.
 * @property {import('../install/user-env.js').UserEnvAdapter} [userEnv]
 * @property {import('../install/external.js').ModelInstaller} [models]
 * @property {import('../core/platform.js').PlatformFacts} [platformFacts]
 * @property {Record<string, Uint8Array>} [pluginFiles]
 * @property {import('../install/apply.js').ApplyIo['onOperation']} [onOperation]
 * @property {() => Date} [now]
 */

/**
 * @param {import('../cli/main.js').CommandContext} context
 * @param {UpgradeDependencies} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(context, dependencies = {}) {
  const { output, env, platform, version: cliVersion } = context;
  const home = getHomeDir({ env, platform });
  const paths = getHomePaths(home, { platform });
  const { manifest } = await loadManifest(paths.installManifest);
  if (manifest === null) {
    throw usageError(`No install manifest in ${paths.installManifest}`, { hint: `Run '${CLI_NAME} setup' first; there is nothing to upgrade.` });
  }
  const pointer = await readPointer(paths.profileCurrent);
  if (context.options.rollback === true) return rollback({ context, paths, pointer, manifest, dependencies });

  const previousVersion = pointer.version ?? manifest.cliVersion;
  const order = compareVersions(previousVersion, cliVersion);
  if (order > 0) {
    throw new CliError(`This installation was written by ${previousVersion}, which is newer than ${cliVersion}`, {
      exitCode: EXIT.VALIDATION,
      code: 'installation_newer',
      data: { installed: previousVersion, running: cliVersion },
      hint: `Install ${CLI_NAME}@${previousVersion} again, or run uninstall and set it up fresh.`,
    });
  }

  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const notices = [];
  const loaded = await loadConfig(paths.config);
  const compat = loadCompat();
  const ollamaClient = dependencies.ollamaClient ?? createOllamaClient({ baseUrl: loaded.config.ollama.baseUrl });
  const preflight = dependencies.preflight ?? (await runPreflight({ platform, env, nodeVersion: process.versions.node, compat, ollama: ollamaClient, signal: context.signal }));
  for (const line of describeCompatibility({ compat, installedOpencode: preflight.opencode.version, installedOllama: preflight.ollama.version })) output.text(line);

  const facts = dependencies.platformFacts ?? detectPlatform({ platform, env });
  const preset = loadPreset(typeof loaded.user.preset === 'string' ? loaded.user.preset : loaded.config.preset);
  const built = buildRuntimeProfile({ config: loaded.config, userConfig: loaded.user, preset, cliVersion, home });
  warnings.push(...built.warnings, ...loaded.warnings);
  // The preset table judges the machine the support matrix judges, as in setup.
  if (getPresetPlatformStatus(preset, facts.os) === 'experimental' && !context.global.experimental) {
    warnings.push(`Preset '${preset.id}' is experimental on ${facts.os}; start needs --experimental for it.`);
  }

  const previousDir = paths.profile(previousVersion).dir;
  const newDir = paths.profile(cliVersion).dir;
  const assets = { ...(await renderProfileFiles({ profile: built.profile, config: loaded.config, cliVersion, pluginFiles: dependencies.pluginFiles })), [MODELFILE_FILE]: renderModelfile(built.resolved.preset.model) };
  const migration = previousVersion === cliVersion && (await pathExists(newDir))
    ? { operations: [], decisions: [], notices: ['The profile is already at this version.'] }
    : await planProfileMigration({ previousDir, newDir, assets, manifest, cliVersion, platform });
  notices.push(...migration.notices);

  const external = await planExternalFiles({ manifest, rendered: await renderExternalFiles({ env, platform, paths, manifest }), cliVersion });
  notices.push(...external.notices);

  const by = createdBy('upgrade', cliVersion);
  /** @type {import('../install/apply.js').ApplyStep[]} */
  const steps = [];
  const configStep = buildConfigStep({ loaded, paths, by });
  if (configStep) steps.push(configStep);
  steps.push({ id: 'profile-render', title: `Render the profile for ${cliVersion}`, accepted: false, operations: migration.operations });
  if (external.operations.length > 0) steps.push({ id: 'external-files', title: 'Re-render the files in other directories', accepted: false, operations: external.operations });
  steps.push({
    id: 'pointer',
    title: `Point at profile ${cliVersion}`,
    accepted: false,
    operations: [
      {
        op: 'writeFile',
        path: paths.profileCurrent,
        content: renderPointer(cliVersion, previousVersion === cliVersion ? pointer.previous : previousVersion),
        onConflict: 'backup',
        entry: { kind: 'file', path: paths.profileCurrent, sha256: PLACEHOLDER_SHA, createdBy: by },
      },
    ],
  });

  if (modelNeedsNewTag(readModel(manifest, preset), { numCtx: preset.model.numCtx, sampling: /** @type {any} */ (preset.model.sampling) })) {
    notices.push(`The preset's context length or sampling changed. Run '${CLI_NAME} setup' to create a new model tag; the old one keeps working until you remove it.`);
  }
  const stale = await listStaleFacts(paths.projectsIndex);
  if (stale.length > 0) notices.push(`Re-scan these projects with 'init --refresh': ${stale.join(', ')}`);

  for (const notice of notices) output.text(notice);
  const pruneTags = context.options.pruneModels === true ? listPrunableTags(manifest, /** @type {string} */ (preset.model.tag)) : [];
  if (pruneTags.length > 0) output.text(`Model tags to remove: ${pruneTags.join(', ')}`);

  if (context.global.dryRun) {
    return { message: 'Nothing was changed (--dry-run).', warnings, data: { dryRun: true, from: previousVersion, to: cliVersion, steps: steps.map((step) => step.id), notices, pruneTags } };
  }

  const items = [
    ...steps.map((step) => ({ id: step.id, title: step.title, recommended: true })),
    ...(pruneTags.length > 0 ? [{ id: 'prune-models', title: `Remove ${pruneTags.length} old model tag${pruneTags.length === 1 ? '' : 's'}`, detail: pruneTags.join(', '), recommended: false, preselected: true, defaultAnswer: false }] : []),
  ];
  const decisions = await context.consent.request(items);
  const accepted = new Set(decisions.filter((decision) => decision.accepted).map((decision) => decision.id));

  const result = await applyPlan(
    steps.map((step) => ({ ...step, accepted: accepted.has(step.id) })),
    {
      cliVersion,
      manifestPath: paths.installManifest,
      manifest: { ...manifest, cliVersion },
      stagingRoot: paths.state,
      userEnv: dependencies.userEnv ?? createUserEnvAdapter({ platform, env, signal: context.signal }),
      onOperation: dependencies.onOperation,
      now: dependencies.now,
      signal: context.signal,
      addCleanup: context.interrupts?.addCleanup,
    },
  );
  for (const note of result.notes) output.text(note);

  const removedTags = accepted.has('prune-models') ? await pruneModels(pruneTags, dependencies.models ?? createModelInstaller({ env, platform, signal: context.signal }), warnings) : [];
  if (removedTags.length > 0) {
    const gone = entriesOfKind(result.manifest, 'ollamaModel')
      .filter((entry) => removedTags.includes(/** @type {string} */ (entry.name)))
      .map((entry) => entryIdentity(entry));
    await saveManifest(paths.installManifest, removeEntries(result.manifest, gone), { now: dependencies.now });
  }

  return {
    message: `Upgraded from ${previousVersion} to ${cliVersion}.`,
    warnings,
    data: {
      from: previousVersion,
      to: cliVersion,
      steps: result.steps,
      newTemplates: result.newTemplates,
      backups: result.backups.map((backup) => backup.path),
      carriedOver: migration.decisions.filter((decision) => decision.action === 'carry-over').map((decision) => decision.relative),
      removedTags,
      platform: facts.os,
    },
  };
}

/**
 * Item 9. The pointer is written through the same apply as everything else, so the manifest keeps the
 * hash of what is on disk and a later uninstall still recognises the file as ours.
 * @param {object} input
 * @param {import('../cli/main.js').CommandContext} input.context
 * @param {import('../core/paths.js').HomePaths} input.paths
 * @param {{ version: string | null, previous: string | null }} input.pointer
 * @param {import('../install/manifest.js').Manifest} input.manifest
 * @param {UpgradeDependencies} input.dependencies
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
async function rollback({ context, paths, pointer, manifest, dependencies }) {
  const plan = await planRollback({ pointer, profileDir: (version) => paths.profile(version).dir });
  if (!plan.ok) {
    return { exitCode: EXIT.VALIDATION, code: 'rollback_unavailable', message: plan.message, data: { command: plan.command, previous: plan.version } };
  }
  const version = /** @type {string} */ (plan.version);
  if (context.global.dryRun) return { message: `Would point at ${version} (--dry-run).`, data: { dryRun: true, previous: version, command: plan.command } };
  const title = `Point back at profile ${version}`;
  // `--rollback` is the explicit request; this is its answer, so --yes may give it.
  const [decision] = await context.consent.request([{ id: 'rollback', title, recommended: false, preselected: true, defaultAnswer: false }]);
  if (!decision.accepted) return { message: 'Nothing was changed.', data: { previous: version, command: plan.command } };
  await applyPlan(
    [
      {
        id: 'rollback',
        title,
        accepted: true,
        operations: [
          {
            op: 'writeFile',
            path: paths.profileCurrent,
            content: renderPointer(version, null),
            onConflict: 'backup',
            entry: { kind: 'file', path: paths.profileCurrent, sha256: PLACEHOLDER_SHA, createdBy: createdBy('upgrade', context.version) },
          },
        ],
      },
    ],
    {
      cliVersion: context.version,
      manifestPath: paths.installManifest,
      manifest,
      stagingRoot: paths.state,
      now: dependencies.now,
      signal: context.signal,
      addCleanup: context.interrupts?.addCleanup,
    },
  );
  context.output.text(/** @type {string} */ (plan.command));
  return { message: plan.message, data: { previous: version, command: plan.command } };
}

/**
 * @param {object} input
 * @param {import('../core/config.js').LoadedConfig} input.loaded
 * @param {import('../core/paths.js').HomePaths} input.paths
 * @param {string} input.by
 * @returns {import('../install/apply.js').ApplyStep | null}
 */
function buildConfigStep({ loaded, paths, by }) {
  if (!loaded.exists || loaded.migrations.length === 0) return null;
  return {
    id: 'config-migrate',
    title: `Migrate config.json (${loaded.migrations.join('; ')})`,
    accepted: false,
    operations: [
      {
        op: 'writeFile',
        path: paths.config,
        content: stringifyJson(loaded.user),
        onConflict: 'backup',
        entry: { kind: 'file', path: paths.config, sha256: PLACEHOLDER_SHA, createdBy: by },
      },
    ],
  };
}

/**
 * Only the fragment can be re-rendered here; a host file needs the host lane's renderer, and
 * `planExternalFiles` says so rather than guessing at its content.
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {NodeJS.Platform} input.platform
 * @param {import('../core/paths.js').HomePaths} input.paths
 * @param {import('../install/manifest.js').Manifest} input.manifest
 * @returns {Promise<Record<string, string>>}
 */
async function renderExternalFiles({ env, platform, paths, manifest }) {
  const fragments = entriesOfKind(manifest, 'wtFragment');
  if (fragments.length === 0 || platform !== 'win32') return {};
  const launcherPath = resolveLauncherPath({ env, platform });
  const fragmentPath = resolveFragmentPath({ env, platform });
  if (launcherPath === null || fragmentPath === null) return {};
  const { projects } = await readProjectsIndex(paths.projectsIndex);
  const text = renderFragment(usableProjects(projects), { launcherPath });
  return Object.fromEntries(fragments.map((entry) => [/** @type {string} */ (entry.path), text]));
}

/**
 * @param {string} pointerPath
 * @returns {Promise<{ version: string | null, previous: string | null }>}
 */
async function readPointer(pointerPath) {
  try {
    return parsePointer(await fs.readFile(pointerPath, 'utf8'));
  } catch {
    return { version: null, previous: null };
  }
}

/**
 * The model the manifest recorded, described the way the preset describes its own, so the two can be
 * compared without the manifest having to store a copy of the preset.
 * @param {import('../install/manifest.js').Manifest} manifest
 * @param {import('../core/presets.js').Preset} preset
 * @returns {{ numCtx?: number, sampling?: Record<string, number> }}
 */
function readModel(manifest, preset) {
  const derived = entriesOfKind(manifest, 'ollamaModel').find((entry) => entry.derived === true || /** @type {string} */ (entry.name).startsWith(DERIVED_TAG_PREFIX));
  // A tag carries its context length in its name (spec 22), so a tag equal to the preset's means the
  // model did not change; a different one means it did.
  if (!derived) return { numCtx: preset.model.numCtx, sampling: /** @type {any} */ (preset.model.sampling) };
  return derived.name === preset.model.tag ? { numCtx: preset.model.numCtx, sampling: /** @type {any} */ (preset.model.sampling) } : {};
}

/**
 * @param {import('../install/manifest.js').Manifest} manifest
 * @param {string} currentTag
 * @returns {string[]}
 */
function listPrunableTags(manifest, currentTag) {
  return entriesOfKind(manifest, 'ollamaModel')
    .filter((entry) => (entry.derived === true || /** @type {string} */ (entry.name).startsWith(DERIVED_TAG_PREFIX)) && entry.name !== currentTag)
    .map((entry) => /** @type {string} */ (entry.name));
}

/**
 * @param {readonly string[]} tags
 * @param {import('../install/external.js').ModelInstaller} models
 * @param {string[]} warnings
 * @returns {Promise<string[]>}
 */
async function pruneModels(tags, models, warnings) {
  /** @type {string[]} */
  const removed = [];
  for (const tag of tags) {
    try {
      await models.remove(tag);
      removed.push(tag);
    } catch (error) {
      warnings.push(`${tag} could not be removed: ${/** @type {Error} */ (error).message}`);
    }
  }
  return removed;
}

/**
 * @param {string} indexPath
 * @returns {Promise<string[]>}
 */
async function listStaleFacts(indexPath) {
  const { projects } = await readProjectsIndex(indexPath);
  return listStaleProjects(projects, FACTS_GENERATOR_VERSION);
}
