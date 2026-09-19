// Host skills use the same hash ownership and transactional writes as setup. Only the two shipped
// skill paths are writable; host settings, instruction files and permissions remain user-owned.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, EXIT, usageError } from '../cli/exit-codes.js';
import { sha256Hex } from '../core/hash.js';
import { getPathApi } from '../core/paths.js';
import { listSideFiles, newTemplatePath } from '../install/backup.js';
import { createdBy, findEntry } from '../install/manifest.js';
import { resolveSkillPath } from '../install/skills.js';

export const HOST_TARGETS = Object.freeze(['claude', 'codex']);

/**
 * @typedef {object} HostInput
 * @property {readonly string[]} targets
 * @property {string} homedir
 * @property {NodeJS.Platform} platform
 * @property {string} cliVersion
 * @property {import('../install/manifest.js').Manifest} manifest
 * @property {(target: string) => Promise<string>} [readTemplate]
 */

/** @param {string} target @returns {Promise<string>} */
export async function readHostTemplate(target) {
  if (!HOST_TARGETS.includes(target)) throw usageError(`Unsupported host '${target}'. Use claude or codex.`);
  return fs.readFile(new URL(`../../hosts/${target}/skills/opencode-unity-delegate/SKILL.md`, import.meta.url), 'utf8');
}

/**
 * `auto` selects hosts with an existing personal configuration directory. It does not launch them.
 * @param {readonly string[]} requested
 * @param {{ homedir: string, platform: NodeJS.Platform }} options
 * @returns {Promise<Array<'claude'|'codex'>>}
 */
export async function resolveHostTargets(requested, { homedir, platform }) {
  if (requested.length === 0) throw usageError('Choose a host with --host claude,codex or --host auto.');
  const invalid = requested.find((target) => !HOST_TARGETS.includes(target) && target !== 'auto');
  if (invalid) throw usageError(`Unsupported host '${invalid}'. Managed installation supports claude and codex; other hosts use the files in hosts/ manually.`);
  const api = getPathApi(platform);
  const selected = new Set(requested.filter((target) => target !== 'auto'));
  if (requested.includes('auto')) {
    if (await isDirectory(api.join(homedir, '.claude'))) selected.add('claude');
    if ((await isDirectory(api.join(homedir, '.agents'))) || (await isDirectory(api.join(homedir, '.codex')))) selected.add('codex');
  }
  if (selected.size === 0) throw usageError('No host configuration directory was detected. Choose --host claude or --host codex explicitly.');
  return /** @type {Array<'claude'|'codex'>} */ ([...selected].sort());
}

/**
 * @typedef {object} HostCheck
 * @property {'claude'|'codex'} target
 * @property {string} path
 * @property {'missing'|'current'|'outdated'|'modified'|'unmanaged'} status
 * @property {boolean} owned
 * @property {string|null} sha256
 * @property {string} expectedSha256
 */

/** @param {HostInput} input @returns {Promise<HostCheck[]>} */
export async function verifyHostSkills(input) {
  const targets = await resolveHostTargets(input.targets, input);
  /** @type {HostCheck[]} */
  const checks = [];
  for (const target of targets) {
    const file = resolveSkillPath(target, input);
    await assertHostPath(file, input);
    const bytes = await readOptional(file);
    const digest = bytes === null ? null : sha256Hex(bytes);
    const expectedSha256 = sha256Hex(await (input.readTemplate ?? readHostTemplate)(target));
    const entry = findEntry(input.manifest, { kind: 'skillCopy', target, path: file });
    const status = digest === null ? 'missing' : digest === expectedSha256 ? 'current' : !entry ? 'unmanaged' : digest === entry.sha256 ? 'outdated' : 'modified';
    checks.push({ target, path: file, status, owned: entry !== undefined, sha256: digest, expectedSha256 });
  }
  return checks;
}

/**
 * A setup-compatible step. Existing user content is preserved, including an edited .ocu-new file.
 * @param {HostInput} input
 * @returns {Promise<{ step: import('../install/plan.js').PlanStep, checks: HostCheck[], warnings: string[] }>}
 */
export async function buildHostInstallStep(input) {
  const checks = await verifyHostSkills(input);
  /** @type {import('../install/apply.js').Operation[]} */
  const operations = [];
  /** @type {string[]} */
  const warnings = [];
  for (const check of checks) {
    // Identical manually copied files are valid, but installation must not claim ownership of them.
    if (check.status === 'current') continue;
    const content = await (input.readTemplate ?? readHostTemplate)(check.target);
    if (check.status === 'modified' || check.status === 'unmanaged') {
      const candidate = newTemplatePath(check.path);
      await assertHostPath(candidate, input);
      const existing = await readOptional(candidate);
      warnings.push(`${check.path} is user-owned or edited; review ${candidate} and merge it manually.`);
      if (existing !== null && sha256Hex(existing) !== check.expectedSha256) {
        warnings.push(`${candidate} also differs; both files were kept. Move the candidate aside before updating again.`);
        continue;
      }
    }
    operations.push({
      op: 'writeFile', path: check.path, content, onConflict: 'preserve',
      entry: { kind: 'skillCopy', target: check.target, path: check.path, createdBy: createdBy('host', input.cliVersion) },
    });
  }
  return {
    step: {
      id: 'host-install', title: `Install delegation skills for ${checks.map((check) => check.target).join(', ')}`,
      detail: 'Only the listed skill files are written. Existing edits are kept beside a new candidate.',
      nature: operations.length > 0 ? 'consent' : 'note', recommended: false, preselected: true,
      accepted: operations.length === 0, operations,
      lines: checks.map((check) => `${check.target}: ${check.status} - ${check.path}`),
    },
    checks, warnings,
  };
}

/**
 * Only canonical target paths with matching ownership hashes become removal candidates. Rebuild this
 * after consent so a file edited while the question was open is kept.
 * @param {HostInput} input
 * @returns {Promise<import('../install/uninstall.js').UninstallPlan>}
 */
export async function buildHostUninstallPlan(input) {
  const checks = await verifyHostSkills(input);
  /** @type {import('../install/uninstall.js').UninstallPlan} */
  const plan = { removals: [], kept: [], consents: [], commands: [], notes: [] };
  for (const check of checks) {
    const entry = findEntry(input.manifest, { kind: 'skillCopy', target: check.target, path: check.path });
    if (check.sha256 !== null) {
      if (entry && entry.sha256 === check.sha256) {
        const root = getPathApi(input.platform).join(input.homedir, check.target === 'claude' ? '.claude' : '.agents');
        const createdRoot = entry.createdRoot && isWithin(root, entry.createdRoot) && isWithin(entry.createdRoot, check.path) ? entry.createdRoot : undefined;
        plan.removals.push({ group: 'remove', describe: `${check.target} skill ${check.path}`, entry: { ...entry, createdRoot } });
      } else plan.kept.push({ describe: check.path, reason: 'user-owned or edited after installation' });
    }
    for (const side of await listSideFiles(check.path)) plan.kept.push({ describe: side, reason: 'backup or review candidate; kept for manual review' });
  }
  if (plan.removals.length > 0) plan.consents.push({
    id: 'remove', title: `Remove ${plan.removals.length} unchanged host skill file(s)`,
    detail: plan.removals.map((item) => item.describe).join('\n'), recommended: false, preselected: true, defaultAnswer: false,
  });
  return plan;
}

/**
 * Refuse links and non-files rather than following a redirected personal skill directory. This is
 * checked again immediately before apply and after consent, without changing any host configuration.
 * @param {string} target
 * @param {{ homedir: string, platform: NodeJS.Platform }} options
 */
export async function assertHostPath(target, { homedir, platform }) {
  const api = getPathApi(platform);
  const relative = api.relative(homedir, target);
  if (relative.startsWith('..') || api.isAbsolute(relative)) throw usageError('The host skill path must remain inside the selected host home.');
  let current = api.resolve(homedir);
  for (const segment of ['', ...relative.split(api.sep)]) {
    if (segment) current = api.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || (current === target ? !stat.isFile() : !stat.isDirectory())) {
      throw new CliError(`Host installation refuses a symbolic link or unexpected file type: ${current}`, { exitCode: EXIT.VALIDATION, code: 'host_path_unsafe', data: { path: current } });
    }
  }
}

/** @param {string} target @returns {Promise<Buffer|null>} */
async function readOptional(target) {
  try { return await fs.readFile(target); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/** @param {string} directory @returns {Promise<boolean>} */
async function isDirectory(directory) {
  try { return (await fs.stat(directory)).isDirectory(); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false;
    throw error;
  }
}

/** @param {string} root @param {string} target */
function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
