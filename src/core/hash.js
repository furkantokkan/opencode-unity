// SHA-256 helpers for the install manifest, profile and verify-cache keys, and project ids.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {string | Uint8Array} data  Strings are hashed as UTF-8.
 * @returns {string} Lowercase hex digest.
 */
export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * The `sha8` of spec 6.1: the short digest in a `<name>-<sha8>` project id. It is hashed over the
 * *identity* path - the normalized absolute path, folded when the volume is case-insensitive
 * (`resolveProjectIdentity` in `./case-sensitivity.js`) - so two spellings of one directory on an APFS
 * or NTFS volume cannot produce two project folders.
 * @param {string | Uint8Array} data  Strings are hashed as UTF-8.
 * @returns {string} 8 lowercase hex characters.
 */
export function sha8(data) {
  return sha256Hex(data).slice(0, 8);
}

/**
 * JSON with object keys sorted at every level, so equal values always hash equally.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function hashJson(value) {
  return sha256Hex(stableStringify(value));
}

/**
 * Hash of a directory tree: every file's POSIX relative path and content hash, in code point order.
 * Symbolic links contribute their target text and are not followed. Empty directories do not count.
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function sha256Tree(root) {
  /** @type {string[]} */
  const lines = [];
  for (const entry of await listTreeEntries(root)) {
    const absolute = path.join(root, ...entry.relativePath.split('/'));
    const digest = entry.isLink ? `link:${await fsp.readlink(absolute)}` : await sha256File(absolute);
    lines.push(`${entry.relativePath}\0${digest}\n`);
  }
  return sha256Hex(lines.join(''));
}

/**
 * @param {string} root
 * @returns {Promise<Array<{ relativePath: string, isLink: boolean }>>}
 */
async function listTreeEntries(root) {
  /** @type {Array<{ relativePath: string, isLink: boolean }>} */
  const entries = [];
  /** @param {string} directory @param {string} prefix */
  async function walk(directory, prefix) {
    for (const dirent of await fsp.readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isSymbolicLink()) entries.push({ relativePath, isLink: true });
      else if (dirent.isDirectory()) await walk(path.join(directory, dirent.name), relativePath);
      else if (dirent.isFile()) entries.push({ relativePath, isLink: false });
    }
  }
  await walk(root, '');
  return entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(/** @type {Record<string, unknown>} */ (value)[key]);
  return sorted;
}
