// Where a global npm install would land, and whether this user could write there (amendment R21).
//
// The prefix is derived rather than asked for: `npm config get prefix` starts npm, and a read-only
// diagnosis should not pay a package manager's startup cost to answer a question about a directory.
// The derivation follows npm's own default - the Node installation prefix - and an explicit
// `npm_config_prefix` or `PREFIX` wins, as it does for npm.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} GlobalPrefix
 * @property {string} prefix
 * @property {string} modulesDir     Where `npm install -g` unpacks packages.
 * @property {string} source         How the prefix was decided.
 * @property {boolean} writable
 * @property {string} checkedPath    The nearest existing directory the writability test used.
 */

/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.execPath]
 * @param {(target: string) => boolean} [options.exists]
 * @param {(target: string) => boolean} [options.isWritable]
 * @returns {GlobalPrefix}
 */
export function resolveGlobalPrefix({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  exists = defaultExists,
  isWritable = defaultIsWritable,
} = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const override = nonEmpty(env.npm_config_prefix) ?? nonEmpty(env.PREFIX);
  const prefix = override ?? (platform === 'win32' ? api.dirname(execPath) : api.dirname(api.dirname(execPath)));
  const source = override === undefined ? 'derived from the Node installation prefix' : 'npm_config_prefix or PREFIX';
  const modulesDir = platform === 'win32' ? api.join(prefix, 'node_modules') : api.join(prefix, 'lib', 'node_modules');
  const checkedPath = nearestExisting(modulesDir, api, exists);
  return { prefix, modulesDir, source, writable: isWritable(checkedPath), checkedPath };
}

/**
 * A prefix that does not exist yet is judged by the first ancestor that does, because that is the
 * directory npm would have to create the rest inside.
 * @param {string} target
 * @param {path.PlatformPath} api
 * @param {(target: string) => boolean} exists
 * @returns {string}
 */
function nearestExisting(target, api, exists) {
  let current = target;
  for (let depth = 0; depth < 20; depth += 1) {
    if (exists(current)) return current;
    const parent = api.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * @param {string} target
 * @returns {boolean}
 */
function defaultExists(target) {
  return fs.existsSync(target);
}

/**
 * @param {string} target
 * @returns {boolean}
 */
function defaultIsWritable(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
