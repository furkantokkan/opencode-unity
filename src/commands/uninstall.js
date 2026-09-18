// `opencode-unity uninstall` (spec 14.4). It prints what it would remove, asks, and then removes only
// what is still byte-for-byte what setup wrote. Anything else is kept and listed by name, including the
// backups of files we once replaced: their content is the user's.
//
// The network consent ledger is its own question, because it is the only record of which hosts were ever
// granted and it is the one file here a user may want to keep after everything else is gone.
import { EXIT } from '../cli/exit-codes.js';
import { CLI_NAME } from '../cli/version.js';
import { getHomeDir, getHomePaths } from '../core/paths.js';
import { loadManifest } from '../install/manifest.js';
import { createModelInstaller } from '../install/external.js';
import { buildUninstallPlan, renderUninstallPlan, runUninstall } from '../install/uninstall.js';
import { createUserEnvAdapter } from '../install/user-env.js';

/**
 * @typedef {object} UninstallDependencies
 * @property {import('../install/user-env.js').UserEnvAdapter} [userEnv]
 * @property {import('../install/external.js').ModelInstaller} [models]
 */

/**
 * @param {import('../cli/main.js').CommandContext} context
 * @param {UninstallDependencies} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(context, dependencies = {}) {
  const { output, env, platform } = context;
  const home = getHomeDir({ env, platform });
  const paths = getHomePaths(home, { platform });
  const { manifest } = await loadManifest(paths.installManifest);
  if (manifest === null) {
    return { message: `No install manifest in ${paths.installManifest}; there is nothing recorded to remove.`, data: { home, removed: [], kept: [] } };
  }

  const userEnv = dependencies.userEnv ?? createUserEnvAdapter({ platform, env, signal: context.signal });
  const flags = {
    keepData: context.options.keepData === true,
    removeModels: context.options.removeModels === true,
    removeBaseModel: context.options.removeBaseModel === true,
    projects: context.options.projects === true,
  };
  const plan = await buildUninstallPlan({ manifest, paths, userEnv, flags });
  for (const line of renderUninstallPlan(plan)) output.text(line);
  output.text();

  if (context.global.dryRun) {
    return {
      message: 'Nothing was removed (--dry-run).',
      data: { home, dryRun: true, removals: plan.removals.map((removal) => removal.describe), kept: plan.kept, commands: plan.commands },
    };
  }
  if (plan.consents.length === 0) {
    return { message: 'Nothing recorded is still on this machine.', data: { home, removed: [], kept: plan.kept.map((item) => item.describe), commands: plan.commands } };
  }

  const decisions = await context.consent.request(plan.consents);
  const result = await runUninstall(plan, decisions, {
    manifestPath: paths.installManifest,
    paths,
    manifest,
    userEnv,
    models: dependencies.models ?? createModelInstaller({ env, platform, signal: context.signal }),
    signal: context.signal,
  });

  for (const line of result.kept) output.text(`kept: ${line}`);
  for (const command of plan.commands) output.text(`run yourself: ${command}`);
  if (result.homeRemoved) output.text(`${home} is gone.`);

  if (result.problems.length > 0) {
    return {
      exitCode: EXIT.RUNTIME,
      code: 'uninstall_incomplete',
      message: `Removed ${result.removed.length} item${result.removed.length === 1 ? '' : 's'}; ${result.problems.length} could not be removed.`,
      warnings: result.problems,
      data: { home, removed: result.removed, kept: result.kept, problems: result.problems, commands: plan.commands, hint: `Remove the listed paths by hand, then run '${CLI_NAME} doctor' to confirm.` },
    };
  }
  return {
    message: result.removed.length === 0 ? 'Nothing was removed.' : `Removed ${result.removed.length} item${result.removed.length === 1 ? '' : 's'}.`,
    data: { home, removed: result.removed, kept: result.kept, commands: plan.commands, homeRemoved: result.homeRemoved },
  };
}
