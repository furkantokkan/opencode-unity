// Backups for anything the installer overwrites. Two shapes, both from spec 14:
//
//   `<file>.bak-<cliVersion>`  the file that was there before we replaced it (14.3 item 3). It is never
//                              deleted by us, so a user who edited a generated file can always get their
//                              version back, and uninstall lists the backups it leaves behind.
//   `<file>.ocu-new`           the new template written *beside* a file the user edited, instead of over
//                              it (14.3 items 4 and 5). `doctor` warns until it is resolved.
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const BACKUP_SUFFIX = '.bak-';
export const NEW_TEMPLATE_SUFFIX = '.ocu-new';
const MAX_BACKUP_ATTEMPTS = 100;

/**
 * @typedef {object} Backup
 * @property {string} source  The file that was moved away.
 * @property {string} path    Where it now is.
 */

/**
 * @param {string} target
 * @returns {string}
 */
export function newTemplatePath(target) {
  return `${target}${NEW_TEMPLATE_SUFFIX}`;
}

/**
 * The first free `<target>.bak-<cliVersion>`, then `-2`, `-3` and so on. Two upgrades to the same version
 * on the same day must not silently overwrite each other's backup.
 * @param {string} target
 * @param {string} cliVersion
 * @param {(candidate: string) => Promise<boolean>} exists
 * @returns {Promise<string>}
 */
export async function chooseBackupPath(target, cliVersion, exists) {
  const base = `${target}${BACKUP_SUFFIX}${cliVersion}`;
  if (!(await exists(base))) return base;
  for (let counter = 2; counter <= MAX_BACKUP_ATTEMPTS; counter += 1) {
    const candidate = `${base}-${counter}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Too many backups of ${target}; remove some ${BACKUP_SUFFIX}${cliVersion}* files first`);
}

/**
 * Moves the target aside. Returns null when there was nothing to back up, so a caller can treat "no file"
 * and "backed up" the same way.
 * @param {string} target
 * @param {{ cliVersion: string }} options
 * @returns {Promise<Backup | null>}
 */
export async function createBackup(target, { cliVersion }) {
  if (!(await pathExists(target))) return null;
  const backupPath = await chooseBackupPath(target, cliVersion, pathExists);
  await fs.rename(target, backupPath);
  return { source: target, path: backupPath };
}

/**
 * Puts a backup back where it came from. Used by the rollback of a failed apply, which must leave the
 * machine exactly as it found it.
 * @param {Backup} backup
 * @returns {Promise<void>}
 */
export async function restoreBackup({ source, path: backupPath }) {
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.rm(source, { force: true });
  await fs.rename(backupPath, source);
}

/**
 * The same, for the Ctrl+C path, which runs synchronously before the process exits.
 * @param {Backup} backup
 */
export function restoreBackupSync({ source, path: backupPath }) {
  fsSync.mkdirSync(path.dirname(source), { recursive: true });
  fsSync.rmSync(source, { force: true });
  fsSync.renameSync(backupPath, source);
}

/**
 * @param {string} candidate
 * @returns {Promise<boolean>}
 */
export async function pathExists(candidate) {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Backups and `.ocu-new` files sitting next to a path the installer owns. `uninstall` lists them as kept,
 * because their content is the user's, not ours.
 * @param {string} target
 * @param {{ readdir?: (dir: string) => Promise<string[]> }} [options]
 * @returns {Promise<string[]>}
 */
export async function listSideFiles(target, { readdir = (dir) => fs.readdir(dir) } = {}) {
  const directory = path.dirname(target);
  const base = path.basename(target);
  /** @type {string[]} */
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(`${base}${BACKUP_SUFFIX}`) || name === `${base}${NEW_TEMPLATE_SUFFIX}`)
    .sort()
    .map((name) => path.join(directory, name));
}
