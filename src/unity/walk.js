// Bounded, sorted walk of `Assets/` and `Packages/` (spec 9.1). One walk feeds every detector.
import { compareOrdinal, joinProjectPath } from './fs-view.js';

export const MAX_WALK_ENTRIES = 50_000;

/**
 * Folder names no walk enters (spec 9.1). Only `Assets/` and `Packages/` are walked here, so the
 * root-level output folders (`Library`, `Temp`, `Logs`, `UserSettings`, `Build*`) are out of reach
 * anyway; a folder such as `Assets/Buildings` is source. Component discovery walks a whole workspace
 * and extends this list rather than restating it, so a name added here is skipped by both walks.
 * @type {readonly string[]}
 */
export const SKIPPED_DIRS = Object.freeze(['obj', '.git', '.plastic', '.svn', '.hg', 'node_modules', '.opencode']);

const SKIPPED_DIR_SET = new Set(SKIPPED_DIRS);

export const WALKED_ROOTS = Object.freeze(['Assets', 'Packages']);

/**
 * @typedef {object} ProjectIndex
 * @property {string[]} files      Relative posix paths, sorted.
 * @property {string[]} dirs       Relative posix paths, sorted.
 * @property {boolean} truncated   The entry cap was reached.
 * @property {number} entryCount
 */

/**
 * Unity ignores hidden entries, names ending in `~` and `cvs` folders when importing (so `Samples~`
 * in a package is never compiled).
 * @param {string} name
 * @returns {boolean}
 */
export function isUnityHidden(name) {
  return name.startsWith('.') || name.endsWith('~') || name.toLowerCase() === 'cvs';
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root  Absolute project root.
 * @param {{ maxEntries?: number }} [options]
 * @returns {ProjectIndex}
 */
export function walkProject(view, root, { maxEntries = MAX_WALK_ENTRIES } = {}) {
  /** @type {ProjectIndex} */
  const index = { files: [], dirs: [], truncated: false, entryCount: 0 };
  for (const top of WALKED_ROOTS) {
    const stat = view.stat(joinProjectPath(root, top));
    if (!stat?.isDirectory) continue;
    if (!countEntry(index, maxEntries)) break;
    index.dirs.push(top);
    walkDirectory(view, root, top, index, maxEntries);
    if (index.truncated) break;
  }
  index.files.sort(compareOrdinal);
  index.dirs.sort(compareOrdinal);
  return index;
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @param {string} relativeDir
 * @param {ProjectIndex} index
 * @param {number} maxEntries
 */
function walkDirectory(view, root, relativeDir, index, maxEntries) {
  for (const entry of view.readDir(joinProjectPath(root, relativeDir))) {
    if (index.truncated) return;
    if (isUnityHidden(entry.name) || SKIPPED_DIR_SET.has(entry.name.toLowerCase())) continue;
    if (!countEntry(index, maxEntries)) return;
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory) {
      index.dirs.push(relativePath);
      walkDirectory(view, root, relativePath, index, maxEntries);
    } else if (entry.isFile) {
      index.files.push(relativePath);
    }
  }
}

/**
 * @param {ProjectIndex} index
 * @param {number} maxEntries
 * @returns {boolean} False when the cap is reached.
 */
function countEntry(index, maxEntries) {
  if (index.entryCount >= maxEntries) {
    index.truncated = true;
    return false;
  }
  index.entryCount += 1;
  return true;
}

/**
 * @param {string} relativePath
 * @returns {string} Lower-case extension including the dot, or ''.
 */
export function extensionOf(relativePath) {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * @param {string} relativePath
 * @returns {string} Parent folder ('' for a top-level name).
 */
export function parentOf(relativePath) {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1 ? '' : relativePath.slice(0, slash);
}

/**
 * @param {string} relativePath
 * @returns {string}
 */
export function baseNameOf(relativePath) {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1);
}
