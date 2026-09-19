import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EXIT, usageError } from '../cli/exit-codes.js';
import { getHomeDir, getHomePaths } from '../core/paths.js';
import { applyPlan } from '../install/apply.js';
import { newTemplatePath, pathExists } from '../install/backup.js';
import { createManifest, loadManifest } from '../install/manifest.js';
import { runUninstall } from '../install/uninstall.js';
import { assertHostPath, buildHostInstallStep, buildHostUninstallPlan, verifyHostSkills } from '../hosts/install.js';

/**
 * @typedef {object} HostDependencies
 * @property {string} [homedir]
 * @property {(target: string) => Promise<string>} [readTemplate]
 * @property {import('../install/apply.js').ApplyIo['onOperation']} [onOperation]
 */

/**
 * @param {import('../cli/main.js').CommandContext} context
 * @param {HostDependencies} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(context, dependencies = {}) {
  const action = context.subcommand;
  if (!['install', 'verify', 'update', 'uninstall'].includes(action ?? '')) throw usageError('Use host install, verify, update or uninstall.');
  const home = getHomeDir({ env: context.env, platform: context.platform });
  const paths = getHomePaths(home, { platform: context.platform });
  const homedir = typeof context.options.hostHome === 'string' ? path.resolve(context.cwd, context.options.hostHome) : dependencies.homedir ?? os.homedir();
  const { manifest: loadedManifest } = await loadManifest(paths.installManifest);
  const manifest = loadedManifest ?? createManifest(context.version);
  const input = {
    targets: Array.isArray(context.options.host) ? context.options.host : [],
    homedir, platform: context.platform, cliVersion: context.version, manifest, readTemplate: dependencies.readTemplate,
  };

  if (action === 'verify') {
    const files = await verifyHostSkills(input);
    const valid = files.every((file) => file.status === 'current');
    return {
      exitCode: valid ? EXIT.OK : EXIT.CHECK_FAILED, code: valid ? 'ok' : 'host_verification_failed',
      message: valid ? 'Host skill files match this release. Open a new host session to load them.' : 'Host skill files are missing, outdated, or modified; inspect data.files.',
      data: { files },
    };
  }

  if (action === 'uninstall') {
    let plan = await buildHostUninstallPlan(input);
    for (const item of plan.removals) context.output.text(`remove: ${item.describe}`);
    for (const item of plan.kept) context.output.text(`keep: ${item.describe} (${item.reason})`);
    if (context.global.dryRun) return { message: 'Nothing was removed (--dry-run).', data: { dryRun: true, removals: plan.removals.map((item) => item.describe), kept: plan.kept } };
    if (plan.removals.length === 0) return { message: 'No unchanged, recorded host skill files to remove.', data: { removed: [], kept: plan.kept } };
    const decisions = await context.consent.request(plan.consents);
    plan = await buildHostUninstallPlan(input);
    const result = await runUninstall(plan, decisions, {
      manifestPath: paths.installManifest, manifest, paths, signal: context.signal,
      // The scoped host plan contains only skillCopy entries, so no environment operation is possible.
      userEnv: /** @type {import('../install/user-env.js').UserEnvAdapter} */ ({}),
    });
    return {
      exitCode: result.problems.length > 0 ? EXIT.RUNTIME : EXIT.OK,
      code: result.problems.length > 0 ? 'host_uninstall_incomplete' : 'ok',
      message: `Removed ${result.removed.length} host skill file(s).`, data: { removed: result.removed, kept: result.kept }, warnings: result.problems,
    };
  }

  const planned = await buildHostInstallStep(input);
  for (const line of planned.step.lines) context.output.text(line);
  if (context.global.dryRun) return {
    message: 'Nothing was changed (--dry-run).', warnings: planned.warnings,
    data: { dryRun: true, files: planned.checks, writes: planned.step.operations.map((operation) => {
      const file = /** @type {import('../install/apply.js').WriteFileOperation} */ (operation).path;
      const check = planned.checks.find((item) => item.path === file);
      return check?.status === 'modified' || check?.status === 'unmanaged' ? newTemplatePath(file) : file;
    }) },
  };
  if (planned.step.operations.length === 0) return {
    message: 'No host skill files changed.', warnings: planned.warnings, data: { files: planned.checks },
    ...(planned.checks.some((file) => file.status !== 'current') ? { exitCode: EXIT.CHECK_FAILED, code: 'host_conflict' } : {}),
  };
  const decisions = await context.consent.request([planned.step]);
  if (!decisions.some((decision) => decision.id === planned.step.id && decision.accepted)) return { message: 'Host installation declined; nothing changed.', data: { files: planned.checks } };
  // Re-read after consent, including .ocu-new conflicts, before entering the transactional writer.
  const refreshed = await buildHostInstallStep(input);
  if (refreshed.step.operations.length === 0) return {
    message: 'No host skill files changed after rechecking the installation.', warnings: refreshed.warnings, data: { files: refreshed.checks },
    ...(refreshed.checks.some((file) => file.status !== 'current') ? { exitCode: EXIT.CHECK_FAILED, code: 'host_conflict' } : {}),
  };
  const createdState = !(await pathExists(paths.state));
  await fs.mkdir(paths.state, { recursive: true });
  try {
    const result = await applyPlan([{ ...refreshed.step, accepted: true }], {
      cliVersion: context.version, manifestPath: paths.installManifest, manifest, stagingRoot: paths.state,
      signal: context.signal, addCleanup: context.interrupts?.addCleanup,
      onOperation: async (operation, step) => {
        await dependencies.onOperation?.(operation, step);
        if (operation.op === 'writeFile') {
          await assertHostPath(operation.path, input);
          await assertHostPath(newTemplatePath(operation.path), input);
        }
      },
    });
    const files = await verifyHostSkills({ ...input, manifest: result.manifest });
    const valid = files.every((file) => file.status === 'current');
    return {
      exitCode: valid ? EXIT.OK : EXIT.CHECK_FAILED, code: valid ? 'ok' : 'host_conflict',
      message: valid ? 'Host skills installed. Open a new host session to load them.' : 'Existing host skill edits were kept. Review the .ocu-new candidate before starting a new session.',
      warnings: [...refreshed.warnings, ...result.notes], data: { files, newTemplates: result.newTemplates },
    };
  } catch (error) {
    // Transactional apply removes its files; remove the newly-created empty state parents too.
    if (createdState) {
      await fs.rmdir(paths.state).catch(() => {});
      await fs.rmdir(home).catch(() => {});
    }
    throw error;
  }
}
