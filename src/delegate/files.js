// Input files for the delegate lane: resolve the `--files` arguments (paths and globs), refuse what
// must not reach a prompt (sensitive files, UNC paths, binaries, oversized files) and decode the rest
// as text (spec 12.3).
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, EXIT, usageError } from '../cli/exit-codes.js';
import { globToRegExp, isUncPath, normalizeWindowsPath, toPosix } from './sensitive.js';

// A quarter of a mebibyte: larger text never fits a 16K context anyway, and reading it only makes the
// budget refusal slower.
export const DEFAULT_MAX_FILE_BYTES = 262_144;

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * @typedef {object} SourceFile
 * @property {string} absolutePath
 * @property {string} relativePath  Posix separators, relative to the working directory.
 * @property {Buffer} bytes
 * @property {string} text          Decoded, BOM removed; line endings as written.
 */

/**
 * @param {string} value
 * @returns {boolean}
 */
export function hasGlobChars(value) {
  return GLOB_CHARS.test(value);
}

/**
 * Case-insensitive on Windows, where two spellings of one path are one file.
 * @param {string} relativePath
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function pathKey(relativePath, platform = process.platform) {
  return platform === 'win32' ? relativePath.toLowerCase() : relativePath;
}

/**
 * @param {string} absolutePath
 * @param {string} cwd
 * @returns {string}
 */
export function displayPath(absolutePath, cwd) {
  const relative = path.relative(cwd, absolutePath);
  if (relative === '' || path.isAbsolute(relative)) return toPosix(absolutePath);
  return toPosix(relative);
}

/**
 * @param {string} absolutePath
 * @param {string} directory
 * @returns {boolean}
 */
export function isInsideDirectory(absolutePath, directory) {
  const relative = path.relative(directory, absolutePath);
  if (relative === '' || path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * A path as an orchestrator's shell may hand it over. The Git Bash shim disables MSYS argument
 * conversion, so `/c/Users/...` arrives unconverted; Windows device and admin-share spellings are
 * rewritten to the drive path they name.
 * @param {string} value
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined> }} [options]
 * @returns {string}
 */
export function normalizeInputPath(value, { platform = process.platform, env = process.env } = {}) {
  let text = value.trim();
  if (platform === 'win32' && env.MSYSTEM && text.startsWith('/') && !text.startsWith('//')) {
    const drive = /^\/([a-zA-Z])(\/.*)?$/.exec(text);
    if (drive) text = `${drive[1].toUpperCase()}:${drive[2] ?? '/'}`;
  }
  return normalizeWindowsPath(text, { platform });
}

/**
 * @param {string} pattern
 * @param {string} cwd
 * @param {{ platform?: NodeJS.Platform }} [options]  Case folding follows the platform the caller
 *   names, as `pathKey` and the UNC refusal in this module already do; reading the ambient platform
 *   here would make the same arguments answer differently on each CI leg.
 * @returns {Promise<string[]>} Absolute paths, sorted.
 */
export async function expandGlob(pattern, cwd, { platform = process.platform } = {}) {
  const segments = toPosix(pattern).split('/');
  const firstGlob = segments.findIndex((segment) => hasGlobChars(segment));
  const baseDir = path.resolve(cwd, segments.slice(0, firstGlob).join('/') || '.');
  const rest = segments.slice(firstGlob);
  const matcher = globToRegExp(rest.join('/'), { ignoreCase: platform === 'win32' });
  const maxDepth = rest.some((segment) => segment.includes('**')) ? Number.POSITIVE_INFINITY : rest.length;
  /** @type {string[]} */
  const matches = [];
  await walkDirectory(baseDir, '', 1, maxDepth, matcher, matches);
  return matches.sort((a, b) => (toPosix(a) < toPosix(b) ? -1 : toPosix(a) > toPosix(b) ? 1 : 0));
}

/**
 * @param {readonly string[]} fileArgs
 * @param {string} cwd
 * @param {{ allowGlobs?: boolean, platform?: NodeJS.Platform, env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<string[]>} Absolute paths, without duplicates, in the order the caller asked for.
 */
export async function resolveFileArgs(fileArgs, cwd, { allowGlobs = true, platform = process.platform, env = process.env } = {}) {
  /** @type {Map<string, string>} */
  const selected = new Map();
  const add = (/** @type {string} */ absolutePath) => {
    const key = pathKey(absolutePath, platform);
    if (!selected.has(key)) selected.set(key, absolutePath);
  };
  for (const rawArg of fileArgs) {
    const arg = toPosix(normalizeInputPath(rawArg, { platform, env }));
    if (arg === '') continue;
    if (platform === 'win32' && isUncPath(arg)) {
      throw usageError(`'${rawArg}' is a network (UNC) path; map the share to a drive letter and pass that path instead`);
    }
    const absolutePath = path.resolve(cwd, arg);
    const stat = await statOrNull(absolutePath);
    if (stat?.isFile()) {
      add(absolutePath);
      continue;
    }
    if (stat?.isDirectory()) {
      throw usageError(`'${rawArg}' is a directory; pass files or a glob such as '${arg.replace(/\/+$/, '')}/**/*.cs'`);
    }
    if (!hasGlobChars(arg)) throw usageError(`File not found: ${rawArg} (resolved against ${cwd})`);
    if (!allowGlobs) throw usageError(`Globs are not allowed here; list the files instead of '${rawArg}'`);
    const matches = await expandGlob(arg, cwd, { platform });
    if (matches.length === 0) throw usageError(`The glob matched no files: ${rawArg} (resolved against ${cwd})`);
    for (const match of matches) add(match);
  }
  return [...selected.values()];
}

/**
 * @typedef {object} LoadFilesOptions
 * @property {import('./sensitive.js').SensitiveMatcher} matcher
 * @property {boolean} [allowSensitive]
 * @property {number} [maxFileBytes]
 * @property {boolean} [strict]   Edit inputs: a file that cannot be used is an error, not a warning.
 */

/**
 * @param {readonly string[]} absolutePaths
 * @param {string} cwd
 * @param {LoadFilesOptions} options
 * @returns {Promise<{ files: SourceFile[], warnings: string[] }>}
 */
export async function loadSourceFiles(absolutePaths, cwd, { matcher, allowSensitive = false, maxFileBytes = DEFAULT_MAX_FILE_BYTES, strict = false }) {
  /** @type {string[]} */
  const refused = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {SourceFile[]} */
  const files = [];
  for (const absolutePath of absolutePaths) {
    const relativePath = displayPath(absolutePath, cwd);
    const pattern = matcher.find(absolutePath, cwd);
    if (pattern && !allowSensitive) {
      refused.push(`${relativePath} (matches '${pattern}')`);
      continue;
    }
    const size = (await fs.stat(absolutePath)).size;
    if (size > maxFileBytes) {
      problems.push(`skipped ${relativePath}: ${size} bytes is above the ${maxFileBytes}-byte limit for one file`);
      continue;
    }
    const bytes = await fs.readFile(absolutePath);
    const utf16 = getUtf16Encoding(bytes);
    if (utf16 && strict) {
      problems.push(`skipped ${relativePath}: UTF-16 text; convert it to UTF-8 first`);
      continue;
    }
    if (!utf16 && bytes.includes(0)) {
      problems.push(`skipped ${relativePath}: binary file (NUL byte)`);
      continue;
    }
    const text = utf16 ? new TextDecoder(utf16).decode(bytes) : decodeUtf8(bytes, strict, relativePath);
    files.push({ absolutePath, relativePath, bytes, text: stripBom(text) });
  }
  if (refused.length > 0) {
    throw new CliError(`Refusing files that look sensitive: ${refused.join(', ')}.`, {
      exitCode: EXIT.USAGE,
      code: 'sensitive_file_refused',
      data: { refused },
      hint: 'Pass --allow-sensitive only when you know these files hold no secrets.',
    });
  }
  if (strict && problems.length > 0) throw usageError(`These files cannot be used: ${problems.join('; ')}`);
  return { files, warnings: problems };
}

/**
 * Reads `--task`/`--reduce`: plain text, or `@file` read with the same rules as `--files`, because its
 * content goes into the prompt just the same.
 * @param {string | undefined} value
 * @param {object} context
 * @param {string} context.cwd
 * @param {import('./sensitive.js').SensitiveMatcher} context.matcher
 * @param {boolean} [context.allowSensitive]
 * @param {number} [context.maxFileBytes]
 * @param {string} [context.optionName]
 * @returns {Promise<string>}
 */
export async function readTaskText(value, { cwd, matcher, allowSensitive = false, maxFileBytes = DEFAULT_MAX_FILE_BYTES, optionName = 'task' }) {
  if (value === undefined || value.trim() === '') throw usageError(`--${optionName} needs text or @file`);
  if (!value.startsWith('@')) return value;
  const target = normalizeInputPath(value.slice(1));
  const candidate = path.resolve(cwd, target);
  const stat = await statOrNull(candidate);
  if (!stat?.isFile()) throw usageError(`--${optionName} file not found: ${target} (resolved against ${cwd})`);
  const pattern = matcher.find(candidate, cwd);
  if (pattern && !allowSensitive) {
    throw new CliError(`Refusing a --${optionName} file that looks sensitive: ${target} (matches '${pattern}').`, {
      exitCode: EXIT.USAGE,
      code: 'sensitive_file_refused',
      data: { refused: [target] },
      hint: 'Pass --allow-sensitive only when you know this file holds no secrets.',
    });
  }
  if (stat.size > maxFileBytes) throw usageError(`--${optionName} file ${target} is ${stat.size} bytes, above the ${maxFileBytes}-byte limit`);
  const text = decodeTaskFile(await fs.readFile(candidate), `--${optionName} file ${target}`);
  if (text.trim() === '') throw usageError(`--${optionName} file is empty: ${target}`);
  return text;
}

/**
 * Task files come from any editor or shell: UTF-8 with or without a BOM, or UTF-16 with a BOM.
 * @param {Buffer} bytes
 * @param {string} label
 * @returns {string}
 */
export function decodeTaskFile(bytes, label) {
  const utf16 = getUtf16Encoding(bytes);
  if (!utf16 && bytes.includes(0)) throw usageError(`${label} is binary (NUL byte); save the task as UTF-8 text`);
  try {
    return stripBom(new TextDecoder(utf16 ?? 'utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw usageError(`${label} is not UTF-8 or UTF-16 text; save it as UTF-8`);
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * @param {string} target
 * @returns {Promise<import('node:fs').Stats | null>}
 */
export async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

/**
 * Windows PowerShell 5.1 redirection (`command > file.log`) writes UTF-16LE with a BOM.
 * @param {Buffer} bytes
 * @returns {'utf-16le' | 'utf-16be' | null}
 */
function getUtf16Encoding(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

/**
 * @param {Buffer} bytes
 * @param {boolean} strict
 * @param {string} relativePath
 * @returns {string}
 */
function decodeUtf8(bytes, strict, relativePath) {
  try {
    return new TextDecoder('utf-8', { fatal: strict, ignoreBOM: true }).decode(bytes);
  } catch {
    throw usageError(`${relativePath} is not valid UTF-8`);
  }
}

/**
 * @param {string} directory
 * @param {string} relativePrefix
 * @param {number} depth
 * @param {number} maxDepth
 * @param {RegExp} matcher
 * @param {string[]} matches
 */
async function walkDirectory(directory, relativePrefix, depth, maxDepth, matcher, matches) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = relativePrefix === '' ? entry.name : `${relativePrefix}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isFile() && matcher.test(relative)) matches.push(absolute);
    // Symlinked directories are not followed: a link could walk out of the working directory.
    if (entry.isDirectory() && !entry.isSymbolicLink() && depth < maxDepth) {
      await walkDirectory(absolute, relative, depth + 1, maxDepth, matcher, matches);
    }
  }
}

/**
 * Synchronous real path, used where a link must not point a write outside the working directory.
 * @param {string} target
 * @returns {string}
 */
export function realPathOrSelf(target) {
  try {
    return fsSync.realpathSync.native(target);
  } catch {
    return target;
  }
}
