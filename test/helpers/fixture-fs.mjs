// File-tree helpers for fixtures: write a tree from an object, copy a committed fixture, and snapshot
// a tree to prove what changed (for example the uninstall residue check).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

/**
 * A tree maps relative paths (with `/`) to file content, `null` for an empty directory, or a nested tree.
 * @typedef {{ [relativePath: string]: string | Buffer | null | Tree }} Tree
 */

/**
 * @typedef {{ type: 'file', size: number, sha256: string } | { type: 'dir' }} SnapshotEntry
 * @typedef {Record<string, SnapshotEntry>} Snapshot  Keys are relative paths with `/`.
 */

/**
 * @param {string} root
 * @param {Tree} tree
 * @returns {Promise<void>}
 */
export async function writeTree(root, tree) {
  for (const [relativePath, value] of Object.entries(tree)) {
    const target = resolveInside(root, relativePath);
    if (value === null) {
      await fs.mkdir(target, { recursive: true });
    } else if (typeof value === 'string' || Buffer.isBuffer(value)) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, value);
    } else {
      await fs.mkdir(target, { recursive: true });
      await writeTree(target, value);
    }
  }
}

/**
 * Copies `test/fixtures/<relativePath>` to `destination`.
 * @param {string} relativePath
 * @param {string} destination
 * @returns {Promise<string>} The destination.
 */
export async function copyFixture(relativePath, destination) {
  await fs.cp(resolveInside(FIXTURES_DIR, relativePath), destination, { recursive: true });
  return destination;
}

/**
 * @param {string} root
 * @param {{ ignore?: readonly string[] }} [options]  Relative paths (with `/`) skipped with everything below them.
 * @returns {Promise<Snapshot>}
 */
export async function snapshotTree(root, { ignore = [] } = {}) {
  /** @type {Snapshot} */
  const snapshot = {};
  await addToSnapshot(root, '', snapshot, ignore);
  return snapshot;
}

/**
 * @param {Snapshot} before
 * @param {Snapshot} after
 * @returns {{ added: string[], removed: string[], changed: string[] }}
 */
export function diffSnapshots(before, after) {
  const added = Object.keys(after).filter((key) => !(key in before)).sort();
  const removed = Object.keys(before).filter((key) => !(key in after)).sort();
  const changed = Object.keys(after)
    .filter((key) => key in before && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
  return { added, removed, changed };
}

/**
 * @param {string} filePath
 * @returns {string}
 */
export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

/**
 * Resolves a relative path and refuses anything that would leave `root`.
 * @param {string} root
 * @param {string} relativePath
 * @returns {string}
 */
export function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, target);
  const escapes = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (path.isAbsolute(relativePath) || escapes) {
    throw new Error(`Path '${relativePath}' is outside '${root}'`);
  }
  return target;
}

/**
 * @param {string} root
 * @param {string} relativeDir
 * @param {Snapshot} snapshot
 * @param {readonly string[]} ignore
 */
async function addToSnapshot(root, relativeDir, snapshot, ignore) {
  const entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (ignore.includes(relativePath)) continue;
    const fullPath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      snapshot[relativePath] = { type: 'dir' };
      await addToSnapshot(root, relativePath, snapshot, ignore);
    } else {
      const content = await fs.readFile(fullPath);
      snapshot[relativePath] = { type: 'file', size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
    }
  }
}
