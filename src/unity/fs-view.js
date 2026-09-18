// Read-only filesystem interface for the Unity scanner (spec 9.1). Detectors only see this view, so
// tests can drive them with fixture trees and nothing in the scanner can write to a project.
import nodeFs from 'node:fs';
import path from 'node:path';
import { parseJsonc, stripBom } from '../core/jsonc.js';

/**
 * @typedef {object} DirEntry
 * @property {string} name
 * @property {boolean} isDirectory
 * @property {boolean} isFile
 */

/**
 * @typedef {object} FileStat
 * @property {boolean} isDirectory
 * @property {boolean} isFile
 * @property {number} size
 * @property {number} mtimeMs
 */

/**
 * @typedef {object} TextRead
 * @property {string} text
 * @property {boolean} truncated  True when the file was larger than `maxBytes`.
 * @property {number} size        Full file size in bytes.
 */

/**
 * @typedef {object} FsView
 * @property {(filePath: string) => FileStat | null} stat
 * @property {(dirPath: string) => DirEntry[]} readDir  Sorted by name (ordinal); empty when unreadable.
 * @property {(filePath: string, options?: { maxBytes?: number }) => TextRead | null} readText
 */

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * @param {{ fs?: typeof nodeFs }} [options]
 * @returns {FsView}
 */
export function createNodeFsView({ fs = nodeFs } = {}) {
  return {
    stat(filePath) {
      try {
        const stats = fs.statSync(filePath);
        return { isDirectory: stats.isDirectory(), isFile: stats.isFile(), size: stats.size, mtimeMs: stats.mtimeMs };
      } catch {
        return null;
      }
    },
    readDir(dirPath) {
      try {
        return fs
          .readdirSync(dirPath, { withFileTypes: true })
          .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }))
          .sort((a, b) => compareOrdinal(a.name, b.name));
      } catch {
        return [];
      }
    },
    readText(filePath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
      let handle;
      try {
        handle = fs.openSync(filePath, 'r');
        const size = fs.fstatSync(handle).size;
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          const read = fs.readSync(handle, buffer, offset, length - offset, offset);
          if (read === 0) break;
          offset += read;
        }
        return { text: stripBom(buffer.subarray(0, offset).toString('utf8')), truncated: size > maxBytes, size };
      } catch {
        return null;
      } finally {
        if (handle !== undefined) fs.closeSync(handle);
      }
    },
  };
}

/**
 * @typedef {string | null | { text: string, mtimeMs?: number }} MemoryEntry
 *   A string or `{ text }` is a file; `null` is an empty directory. Parent directories are implied.
 */

/**
 * In-memory view for tests and the self-test. Keys are absolute paths in either separator style.
 * @param {Record<string, MemoryEntry>} entries
 * @returns {FsView}
 */
export function createMemoryFsView(entries) {
  /** @type {Map<string, { text: string, mtimeMs: number }>} */
  const files = new Map();
  /** @type {Map<string, Map<string, boolean>>} directory key -> child name -> isDirectory */
  const dirs = new Map();

  /** @param {string} key */
  const addDirectory = (key) => {
    if (dirs.has(key)) return;
    dirs.set(key, new Map());
    const parent = parentKey(key);
    if (parent === null) return;
    addDirectory(parent);
    dirs.get(parent)?.set(nameOfKey(key), true);
  };

  for (const [rawPath, value] of Object.entries(entries)) {
    const key = memoryKey(rawPath);
    if (value === null) {
      addDirectory(key);
      continue;
    }
    files.set(key, typeof value === 'string' ? { text: value, mtimeMs: 0 } : { text: value.text, mtimeMs: value.mtimeMs ?? 0 });
    const parent = parentKey(key);
    if (parent !== null) {
      addDirectory(parent);
      dirs.get(parent)?.set(nameOfKey(key), false);
    }
  }

  return {
    stat(filePath) {
      const key = memoryKey(filePath);
      const file = files.get(key);
      if (file) return { isDirectory: false, isFile: true, size: Buffer.byteLength(file.text), mtimeMs: file.mtimeMs };
      return dirs.has(key) ? { isDirectory: true, isFile: false, size: 0, mtimeMs: 0 } : null;
    },
    readDir(dirPath) {
      const children = dirs.get(memoryKey(dirPath));
      if (!children) return [];
      return [...children]
        .map(([name, directory]) => ({ name, isDirectory: directory, isFile: !directory }))
        .sort((a, b) => compareOrdinal(a.name, b.name));
    },
    readText(filePath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
      const file = files.get(memoryKey(filePath));
      if (!file) return null;
      const bytes = Buffer.from(file.text, 'utf8');
      const truncated = bytes.length > maxBytes;
      const text = truncated ? bytes.subarray(0, maxBytes).toString('utf8') : file.text;
      return { text: stripBom(text), truncated, size: bytes.length };
    },
  };
}

/**
 * @param {string} filePath
 * @returns {string} Absolute path with `/` and no trailing separator (except at a root).
 */
function memoryKey(filePath) {
  const posix = toPosix(path.resolve(filePath));
  const isRoot = posix === '/' || /^[A-Za-z]:\/$/.test(posix);
  return !isRoot && posix.endsWith('/') ? posix.slice(0, -1) : posix;
}

/**
 * @param {string} key
 * @returns {string | null} Null at a filesystem root.
 */
function parentKey(key) {
  const parent = memoryKey(path.dirname(key));
  return parent === key ? null : parent;
}

/**
 * @param {string} key
 * @returns {string}
 */
function nameOfKey(key) {
  return key.slice(key.lastIndexOf('/') + 1);
}

/**
 * @param {FsView} view
 * @param {string} filePath
 * @returns {boolean}
 */
export function isDirectory(view, filePath) {
  return view.stat(filePath)?.isDirectory === true;
}

/**
 * @param {FsView} view
 * @param {string} filePath
 * @returns {boolean}
 */
export function isFile(view, filePath) {
  return view.stat(filePath)?.isFile === true;
}

/**
 * Reads a JSON file. Comments and trailing commas are tolerated because hand-edited OpenCode configs
 * often contain them.
 * @param {FsView} view
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ found: boolean, value: unknown, error: string | null, text: string | null }}
 */
export function readJson(view, filePath, options = {}) {
  const read = view.readText(filePath, options);
  if (!read) return { found: false, value: undefined, error: null, text: null };
  if (read.truncated) return { found: true, value: undefined, error: 'file too large', text: null };
  try {
    return { found: true, value: parseJsonc(read.text, path.basename(filePath)), error: null, text: read.text };
  } catch (error) {
    return { found: true, value: undefined, error: error.message, text: read.text };
  }
}

/**
 * Ordinal comparison, so walks and outputs are stable across locales.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareOrdinal(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Joins a project root and a relative posix path.
 * @param {string} root
 * @param {string} relativePath  Uses `/`.
 * @returns {string}
 */
export function joinProjectPath(root, relativePath) {
  return relativePath ? path.join(root, ...relativePath.split('/')) : root;
}

/**
 * Turns every backslash into `/`, whatever the platform. Used for values that are already known to be
 * backslash-separated - an absolute path used as a memory-view key, a `.meta` or `.csproj` path read out
 * of a file. `toProjectPath` is the one to use for a value that is about to be committed: it applies the
 * same rewrite but also rejects an absolute path and a path that leaves the project root.
 * @param {string} filePath
 * @returns {string}
 */
export function toPosix(filePath) {
  return filePath.replace(/\\/g, '/');
}

// A leading `/`, a drive letter or a UNC prefix: the three spellings of an absolute path. Rejected on
// every platform, because a Windows-written `project.json` is read on macOS and Linux (P6, CP-D14).
const ABSOLUTE_PATH_PATTERN = /^(?:[/\\]|[A-Za-z]:[/\\])/;

/**
 * The form every path takes inside `project.json`, `facts.md` and `launch.json`: relative to the project
 * root, POSIX-separated on every platform, with no `.` or `..` segment (CP-D14). Those files are
 * committed, so a Windows-written `Assets\Scripts\Foo` would not resolve for the teammate on macOS, and
 * `unity.facts-stale` hashes these paths - a separator flip would invalidate every `inputsHash` on the
 * first cross-platform checkout. `local.json` is machine-local and keeps native separators
 * (`toNativePath`).
 *
 * A backslash becomes `/` on every platform, not only on Windows. This is a serialization format whose
 * one separator is `/`, so a backslash has no other meaning it could carry across a checkout; the price
 * is that a POSIX file genuinely named `a\b` is recorded as `a/b`, and Unity cannot import such a name.
 * @param {string} relativePath  Native or POSIX separators.
 * @returns {string}
 * @throws {TypeError} When the path is absolute or leaves the project root.
 */
export function toProjectPath(relativePath) {
  const slashed = toPosix(relativePath);
  if (ABSOLUTE_PATH_PATTERN.test(slashed)) throw new TypeError(`Project paths must be relative: '${relativePath}'`);
  /** @type {string[]} */
  const segments = [];
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new TypeError(`Project path leaves the project root: '${relativePath}'`);
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * The project path of an absolute path inside a project root.
 * @param {string} root  Absolute.
 * @param {string} absolutePath  Absolute, inside `root`.
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {string}
 * @throws {TypeError} When `absolutePath` is outside `root`.
 */
export function toRelativeProjectPath(root, absolutePath, { platform = process.platform } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  return toProjectPath(api.relative(root, absolutePath));
}

/**
 * The native spelling of a project path, for `local.json` and for anything handed to the filesystem.
 * @param {string} projectPath  From `toProjectPath`.
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {string}
 */
export function toNativePath(projectPath, { platform = process.platform } = {}) {
  return projectPath.split('/').join(platform === 'win32' ? path.win32.sep : path.posix.sep);
}

/**
 * Whether a value may be written into a committed project file as it stands. Checked rather than assumed,
 * because a relative path that reached a writer through `path.relative` carries the local separator.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isProjectPath(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (ABSOLUTE_PATH_PATTERN.test(value) || value.includes('\\')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
