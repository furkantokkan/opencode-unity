// `uninstall` (spec 14.4): build the removal list from the manifest, print it, and remove only what is
// still exactly what we wrote. Anything changed since is kept and listed, because a file whose content is
// no longer ours is no longer ours to delete.
//
// What is never touched, on any path through this module: the user's own OpenCode configuration, Windows
// Terminal's `settings.json`, Claude and Codex instruction files, Unity projects other than an
// `.opencode-unity` folder recorded as a `projectDir`, and any host file that is not a manifest entry
// (amendment 38.11).
import fs from 'node:fs/promises';
import path from 'node:path';
import { listSideFiles, pathExists } from './backup.js';
import { describeEntry, entryIdentity, removeEntries, saveManifest } from './manifest.js';
import { sha256File, sha256Tree } from '../core/hash.js';

/** A tag `ollama create` built from our Modelfile is recognisable by this prefix (spec 10.3). */
export const DERIVED_TAG_PREFIX = 'ocu-';

/**
 * @typedef {'remove'|'models'|'base-model'|'projects'|'consent-ledger'} UninstallGroup
 */

/**
 * @typedef {object} Removal
 * @property {UninstallGroup} group
 * @property {string} describe
 * @property {import('./manifest.js').ManifestEntry} [entry]
 * @property {string} [path]        Set for a plain path removal that has no manifest entry (state, projects).
 */

/**
 * @typedef {object} UninstallPlan
 * @property {Removal[]} removals
 * @property {Array<{ describe: string, reason: string }>} kept
 * @property {import('../cli/consent.js').ConsentItem[]} consents
 * @property {string[]} commands    Printed for the user to run; uninstall never runs them.
 * @property {string[]} notes
 */

/**
 * @typedef {object} UninstallInput
 * @property {import('./manifest.js').Manifest} manifest
 * @property {import('../core/paths.js').HomePaths} paths
 * @property {import('./user-env.js').UserEnvAdapter} userEnv
 * @property {{ keepData: boolean, removeModels: boolean, removeBaseModel: boolean, projects: boolean }} flags
 */

/**
 * @param {UninstallInput} input
 * @returns {Promise<UninstallPlan>}
 */
export async function buildUninstallPlan({ manifest, paths, userEnv, flags }) {
  /** @type {UninstallPlan} */
  const plan = { removals: [], kept: [], consents: [], commands: [], notes: [] };
  // Profile directories and xdg-config are owned end to end and go whole (spec 14.4 item 2), so a file
  // recorded inside one is not a separate decision. An edited one is still named, because it goes too.
  const ownedDirs = manifest.entries.filter((entry) => entry.kind === 'dir').map((entry) => /** @type {string} */ (entry.path));
  const insideOwnedDir = (/** @type {string} */ target) => ownedDirs.some((directory) => isInside(directory, target));

  for (const entry of manifest.entries) {
    switch (entry.kind) {
      case 'file':
        if (insideOwnedDir(/** @type {string} */ (entry.path))) {
          await noteEditedInsideDir(plan, entry);
          break;
        }
        await addHashedFile(plan, entry);
        break;
      case 'wtFragment':
      case 'skillCopy':
        await addHashedFile(plan, entry);
        break;
      case 'dir':
        if (await pathExists(/** @type {string} */ (entry.path))) plan.removals.push({ group: 'remove', describe: describeEntry(entry), entry });
        break;
      case 'projectDir':
        await addProjectDir(plan, entry, flags);
        break;
      case 'userEnv':
      case 'launchctlEnv':
        await addEnvEntry(plan, entry, userEnv);
        break;
      case 'ollamaModel':
        addModelEntry(plan, entry, flags);
        break;
      case 'npmGlobal':
        plan.commands.push(`npm rm -g ${entry.name}`);
        plan.notes.push(`${entry.name} is left installed: other tools may use it.`);
        break;
      default:
        plan.kept.push({ describe: describeEntry(entry), reason: 'this version does not know how to remove it' });
    }
  }

  const ledgerPath = paths.consentLedger;
  const hasLedger = await pathExists(ledgerPath);
  if (!flags.keepData) {
    for (const dataPath of [paths.state, paths.projectsRoot]) {
      if (await pathExists(dataPath)) plan.removals.push({ group: 'remove', describe: `data in ${dataPath}`, path: dataPath });
    }
    if (hasLedger) plan.removals.push({ group: 'consent-ledger', describe: `network consent ledger ${ledgerPath}`, path: ledgerPath });
  } else if (hasLedger) {
    plan.kept.push({ describe: `network consent ledger ${ledgerPath}`, reason: '--keep-data' });
  }

  plan.consents = buildConsentItems(plan, flags);
  plan.commands.push('npm rm -g opencode-unity');
  return plan;
}

/**
 * @param {UninstallPlan} plan
 * @param {UninstallInput['flags']} flags
 * @returns {import('../cli/consent.js').ConsentItem[]}
 */
function buildConsentItems(plan, flags) {
  /** @type {import('../cli/consent.js').ConsentItem[]} */
  const items = [];
  const counts = countByGroup(plan.removals);
  if (counts.remove > 0) {
    items.push({
      id: 'remove',
      title: `Remove ${counts.remove} recorded item${counts.remove === 1 ? '' : 's'}`,
      detail: 'Everything listed above that is still exactly what setup wrote. Changed files are kept.',
      recommended: false,
      // Running `uninstall` is the explicit request spec 5.1 asks for; this item is the answer to it, so
      // `--yes` may accept it while every additional deletion below still needs its own flag. At the
      // prompt a deletion still defaults to No.
      preselected: true,
      defaultAnswer: false,
    });
  }
  if (counts.models > 0) {
    items.push({
      id: 'models',
      title: `Remove ${counts.models} created model tag${counts.models === 1 ? '' : 's'}`,
      detail: 'ollama rm for each tag setup created. The downloaded base model stays.',
      recommended: false,
      preselected: flags.removeModels,
      defaultAnswer: false,
    });
  }
  if (counts['base-model'] > 0) {
    items.push({
      id: 'base-model',
      title: `Remove ${counts['base-model']} base model${counts['base-model'] === 1 ? '' : 's'} setup downloaded`,
      detail: 'Several gigabytes each; downloading them again takes as long as the first time.',
      recommended: false,
      preselected: flags.removeBaseModel,
      defaultAnswer: false,
    });
  }
  if (counts.projects > 0) {
    items.push({
      id: 'projects',
      title: `Remove ${counts.projects} in-project folder${counts.projects === 1 ? '' : 's'}`,
      detail: 'Only folders that are still unchanged exports; an edited one is kept.',
      recommended: false,
      preselected: flags.projects,
      defaultAnswer: false,
    });
  }
  if (counts['consent-ledger'] > 0) {
    items.push({
      id: 'consent-ledger',
      title: 'Remove the network consent ledger',
      detail: 'It records which hosts were granted and when. It holds no secret and no path, and it is the only record of what was allowed.',
      recommended: false,
    });
  }
  return items;
}

/**
 * @param {UninstallPlan} plan
 * @param {import('./manifest.js').ManifestEntry} entry
 * @returns {Promise<void>}
 */
async function addHashedFile(plan, entry) {
  const target = /** @type {string} */ (entry.path);
  if (!(await pathExists(target))) return;
  const digest = await sha256File(target);
  if (digest !== entry.sha256) {
    plan.kept.push({ describe: describeEntry(entry), reason: 'it was changed after it was written' });
    return;
  }
  plan.removals.push({ group: 'remove', describe: describeEntry(entry), entry });
  for (const side of await listSideFiles(target)) plan.kept.push({ describe: side, reason: 'it holds your version of a file we replaced' });
}

/**
 * @param {UninstallPlan} plan
 * @param {import('./manifest.js').ManifestEntry} entry
 * @returns {Promise<void>}
 */
async function noteEditedInsideDir(plan, entry) {
  const target = /** @type {string} */ (entry.path);
  if (!(await pathExists(target))) return;
  if ((await sha256File(target)) === entry.sha256) return;
  plan.notes.push(`${target} was edited; it is removed with its directory, so copy it out first if you want to keep it.`);
}

/**
 * @param {UninstallPlan} plan
 * @param {import('./manifest.js').ManifestEntry} entry
 * @param {UninstallInput['flags']} flags
 * @returns {Promise<void>}
 */
async function addProjectDir(plan, entry, flags) {
  const target = /** @type {string} */ (entry.path);
  if (!(await pathExists(target))) return;
  // A Unity project is the user's; only `--projects` makes its export folder a candidate at all.
  if (!flags.projects) {
    plan.kept.push({ describe: describeEntry(entry), reason: 'pass --projects to remove in-project folders' });
    return;
  }
  const digest = await sha256Tree(target);
  if (digest !== entry.sha256Tree) {
    plan.kept.push({ describe: describeEntry(entry), reason: 'it was changed after it was written' });
    return;
  }
  plan.removals.push({ group: 'projects', describe: describeEntry(entry), entry });
}

/**
 * @param {UninstallPlan} plan
 * @param {import('./manifest.js').ManifestEntry} entry
 * @param {import('./user-env.js').UserEnvAdapter} userEnv
 * @returns {Promise<void>}
 */
async function addEnvEntry(plan, entry, userEnv) {
  const current = await userEnv.read(/** @type {string} */ (entry.name));
  if (current !== entry.value) {
    plan.kept.push({ describe: describeEntry(entry), reason: `it now holds ${current === null ? 'no value' : 'a different value'}` });
    return;
  }
  const action = entry.previous === null ? 'remove' : `restore it to ${entry.previous}`;
  plan.removals.push({ group: 'remove', describe: `${describeEntry(entry)} (${action})`, entry });
}

/**
 * @param {UninstallPlan} plan
 * @param {import('./manifest.js').ManifestEntry} entry
 * @param {UninstallInput['flags']} flags
 */
function addModelEntry(plan, entry, flags) {
  const derived = entry.derived === true || /** @type {string} */ (entry.name).startsWith(DERIVED_TAG_PREFIX);
  if (derived) {
    if (!flags.removeModels) {
      plan.kept.push({ describe: describeEntry(entry), reason: 'pass --remove-models to remove created tags' });
      return;
    }
    plan.removals.push({ group: 'models', describe: describeEntry(entry), entry });
    return;
  }
  if (!entry.pulledBySetup) {
    plan.kept.push({ describe: describeEntry(entry), reason: 'it was already in your Ollama store before setup ran' });
    return;
  }
  if (!flags.removeBaseModel) {
    plan.kept.push({ describe: describeEntry(entry), reason: 'pass --remove-base-model to remove a base model setup downloaded' });
    return;
  }
  plan.removals.push({ group: 'base-model', describe: describeEntry(entry), entry });
}

/**
 * @typedef {object} UninstallIo
 * @property {string} manifestPath
 * @property {import('../core/paths.js').HomePaths} paths
 * @property {import('./manifest.js').Manifest} manifest
 * @property {import('./user-env.js').UserEnvAdapter} userEnv
 * @property {import('./external.js').ModelInstaller} [models]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} UninstallResult
 * @property {string[]} removed
 * @property {string[]} kept
 * @property {string[]} problems
 * @property {boolean} homeRemoved
 */

/**
 * Removes what the accepted groups cover. Failures are collected rather than thrown: a half-finished
 * uninstall that says exactly what is left is more useful than one that stops at the first locked file.
 * @param {UninstallPlan} plan
 * @param {readonly import('../cli/consent.js').ConsentDecision[]} decisions
 * @param {UninstallIo} io
 * @returns {Promise<UninstallResult>}
 */
export async function runUninstall(plan, decisions, io) {
  const accepted = new Set(decisions.filter((decision) => decision.accepted).map((decision) => decision.id));
  /** @type {UninstallResult} */
  const result = { removed: [], kept: plan.kept.map((item) => `${item.describe} - ${item.reason}`), problems: [], homeRemoved: false };
  /** @type {string[]} */
  const doneIdentities = [];

  // Files and models first, then the directories that contain them, then the data, so a failure in the
  // middle never leaves a directory removed while its manifest entry still claims the files inside it.
  const order = ['file', 'wtFragment', 'skillCopy', 'ollamaModel', 'userEnv', 'launchctlEnv', 'projectDir', 'dir'];
  const ranked = [...plan.removals].sort((left, right) => rank(order, left) - rank(order, right));

  // The ledger lives inside `state/`, so the data removal has to step around it whenever its own question
  // was declined. That is the whole of "asks separately" (amendment 38.11).
  const keepPaths = accepted.has('consent-ledger') ? [] : [io.paths.consentLedger];

  for (const removal of ranked) {
    if (!accepted.has(removal.group)) {
      result.kept.push(`${removal.describe} - declined`);
      continue;
    }
    // Data comes last and holds the manifest. After a failure above it stays, so the record of what is
    // still installed survives for the next attempt.
    if (removal.entry === undefined && result.problems.length > 0) {
      result.kept.push(`${removal.describe} - kept until everything above is removed`);
      continue;
    }
    try {
      await performRemoval(removal, io, keepPaths);
      result.removed.push(removal.describe);
      if (removal.entry) doneIdentities.push(entryIdentity(removal.entry));
      if (removal.entry?.kind === 'dir') {
        // The files recorded inside went with it; their entries must not outlive them.
        const directory = /** @type {string} */ (removal.entry.path);
        for (const entry of io.manifest.entries) {
          if (entry.path !== undefined && isInside(directory, entry.path)) doneIdentities.push(entryIdentity(entry));
        }
      }
    } catch (error) {
      result.problems.push(`${removal.describe}: ${/** @type {Error} */ (error).message}`);
    }
  }

  if (doneIdentities.length > 0 && (await pathExists(io.manifestPath))) {
    // The data removal usually takes the manifest with it; when it did not, the entries that are gone
    // must not stay in the record, and the ones that failed must.
    await saveManifest(io.manifestPath, removeEntries(io.manifest, doneIdentities));
  }
  // `profile/` held both the versioned directory and the pointer; with both gone it is empty, and an
  // empty directory left behind is still residue.
  for (const removal of ranked) {
    const target = removal.entry?.path ?? removal.path;
    if (target !== undefined && accepted.has(removal.group)) await pruneEmptyParents(target, io.paths.home);
  }
  result.homeRemoved = await removeIfEmpty(io.paths.home);
  return result;
}

/**
 * After a fragment or a skill copy is gone, its own folder goes when empty, and so does every directory
 * up to the one setup created for it. Nothing above `createdRoot` is touched - that directory existed
 * before us - and a directory another program has written into since is kept.
 * @param {string} file
 * @param {string | undefined} createdRoot
 * @returns {Promise<void>}
 */
async function removeCreatedDirectories(file, createdRoot) {
  const own = path.dirname(file);
  if (!(await removeIfEmpty(own)) || createdRoot === undefined) return;
  for (let directory = path.dirname(own); isInside(createdRoot, directory) || directory === createdRoot; directory = path.dirname(directory)) {
    if (!(await removeIfEmpty(directory))) return;
    if (directory === createdRoot) return;
  }
}

/**
 * Removes empty directories from `target`'s parent up to, but not including, `stopAt`. It never walks
 * outside `stopAt`, so a fragment's directory under Windows Terminal's tree is handled by its own rule.
 * @param {string} target
 * @param {string} stopAt
 * @returns {Promise<void>}
 */
async function pruneEmptyParents(target, stopAt) {
  for (let directory = path.dirname(target); isInside(stopAt, directory); directory = path.dirname(directory)) {
    if (!(await removeIfEmpty(directory))) return;
  }
}

/**
 * @param {Removal} removal
 * @param {UninstallIo} io
 * @param {readonly string[]} keepPaths  Paths inside a removed directory that must survive it.
 * @returns {Promise<void>}
 */
async function performRemoval(removal, io, keepPaths) {
  if (removal.path !== undefined && removal.entry === undefined) {
    await removeTree(removal.path, keepPaths);
    return;
  }
  const entry = /** @type {import('./manifest.js').ManifestEntry} */ (removal.entry);
  switch (entry.kind) {
    case 'file':
      await fs.rm(/** @type {string} */ (entry.path), { force: true });
      await removeIfEmpty(path.dirname(/** @type {string} */ (entry.path)));
      break;
    case 'wtFragment':
    case 'skillCopy':
      await fs.rm(/** @type {string} */ (entry.path), { force: true });
      await removeCreatedDirectories(/** @type {string} */ (entry.path), entry.createdRoot);
      break;
    case 'dir':
    case 'projectDir':
      await fs.rm(/** @type {string} */ (entry.path), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      break;
    case 'userEnv':
    case 'launchctlEnv':
      await io.userEnv.restore(/** @type {string} */ (entry.name), entry.previous ?? null);
      break;
    case 'ollamaModel':
      if (!io.models) throw new Error('no model installer was provided');
      await io.models.remove(/** @type {string} */ (entry.name));
      break;
    default:
      throw new Error(`this version cannot remove a ${entry.kind} entry`);
  }
}

/**
 * Removes a directory except the listed files directly inside it. A plain recursive remove would take
 * the network consent ledger with `state/`, and that file has its own question.
 * @param {string} target
 * @param {readonly string[]} keepPaths
 * @returns {Promise<void>}
 */
async function removeTree(target, keepPaths) {
  const kept = keepPaths.filter((candidate) => path.dirname(candidate) === target);
  if (kept.length === 0) {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return;
  }
  for (const name of await fs.readdir(target)) {
    const child = path.join(target, name);
    if (!kept.includes(child)) await fs.rm(child, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  // A kept path that did not exist leaves nothing to protect, and the directory goes after all.
  await removeIfEmpty(target);
}

/**
 * @param {string} directory
 * @param {string} candidate
 * @returns {boolean}
 */
function isInside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * @param {string} directory
 * @returns {Promise<boolean>}
 */
async function removeIfEmpty(directory) {
  try {
    const names = await fs.readdir(directory);
    if (names.length > 0) return false;
    await fs.rmdir(directory);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {readonly string[]} order
 * @param {Removal} removal
 * @returns {number}
 */
function rank(order, removal) {
  if (!removal.entry) return order.length;
  const index = order.indexOf(removal.entry.kind);
  return index === -1 ? order.length : index;
}

/**
 * @param {readonly Removal[]} removals
 * @returns {Record<UninstallGroup, number>}
 */
function countByGroup(removals) {
  /** @type {Record<UninstallGroup, number>} */
  const counts = { remove: 0, models: 0, 'base-model': 0, projects: 0, 'consent-ledger': 0 };
  for (const removal of removals) counts[removal.group] += 1;
  return counts;
}

/**
 * The text `uninstall` prints before it asks anything.
 * @param {UninstallPlan} plan
 * @returns {string[]}
 */
export function renderUninstallPlan(plan) {
  /** @type {string[]} */
  const lines = [];
  if (plan.removals.length === 0) lines.push('Nothing recorded is still on this machine.');
  else {
    lines.push('Would remove:');
    for (const removal of plan.removals) lines.push(`  ${removal.describe}${removal.group === 'remove' ? '' : ` [${removal.group}]`}`);
  }
  if (plan.kept.length > 0) {
    lines.push('Kept:');
    for (const item of plan.kept) lines.push(`  ${item.describe} - ${item.reason}`);
  }
  if (plan.commands.length > 0) {
    lines.push('Run yourself if you want to:');
    for (const command of plan.commands) lines.push(`  ${command}`);
  }
  for (const note of plan.notes) lines.push(note);
  return lines;
}
