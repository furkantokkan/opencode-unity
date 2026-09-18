// Sensitive-file detection for the delegate lane (spec 12.3): files whose contents must not reach the
// prompt unless the caller passes --allow-sensitive.
//
// Amendment 38.9 makes this detector shared with the network lane: S32 owns `src/network/sensitive.js`
// and both lanes import it, so the two can never diverge. S32 does not exist yet, so this module
// defines the narrow interface the delegate needs and holds the patterns. When S32 lands, keep the
// interface below and replace the pattern list and `matchPattern` with imports from it.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Default patterns (spec 12.3: the PROTECTED_READ secret globs of 8.5.2, plus SSH keys, `.npmrc`,
 * `.netrc` and `.git-credentials`). A pattern without `/` matches any path segment, like `.gitignore`;
 * a pattern with `/` matches the whole relative or absolute path.
 * @type {readonly string[]}
 */
export const DEFAULT_SENSITIVE_PATTERNS = Object.freeze([
  '.env',
  '.env.*',
  '*.env',
  '*.pem',
  '*.key',
  '*.p12',
  '*.p8',
  '*.pfx',
  '*.keystore',
  '*.jks',
  '*.mobileprovision',
  '*.ppk',
  '*credentials*',
  '*secret*',
  'google-services*.json',
  'GoogleService-Info*.plist',
  '*service-account*.json',
  '*service_account*.json',
  '*serviceaccount*.json',
  '*firebase-adminsdk*.json',
  '*.runtimeconfig.json',
  '.dev.vars',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  '.npmrc',
  '.netrc',
  '.git-credentials',
]);

/**
 * The narrow interface the delegate lane needs from the shared detector.
 * @typedef {object} SensitiveMatcher
 * @property {readonly string[]} patterns
 * @property {(absolutePath: string, baseDir: string) => string | null} find
 *   The pattern that matched, or null. `baseDir` makes patterns with `/` relative-path patterns too.
 */

/**
 * @param {object} [options]
 * @param {readonly string[]} [options.extraPatterns]  From `config.delegate.extraSensitivePatterns`.
 * @param {NodeJS.Platform} [options.platform]
 * @param {(target: string) => string | null} [options.realPath]  Injected for tests.
 * @returns {SensitiveMatcher}
 */
export function createSensitiveMatcher({ extraPatterns = [], platform = process.platform, realPath = tryRealPath } = {}) {
  const patterns = Object.freeze([...DEFAULT_SENSITIVE_PATTERNS, ...extraPatterns]);
  return {
    patterns,
    find(absolutePath, baseDir) {
      // The path as given and its real path: a junction or symlink must not hide a secret file.
      /** @type {Array<[string, string]>} */
      const pairs = [[absolutePath, baseDir]];
      const resolved = realPath(absolutePath);
      if (resolved && resolved !== absolutePath) pairs.push([resolved, realPath(baseDir) ?? baseDir]);
      for (const [candidate, base] of pairs) {
        const matched = matchPattern(normalizeForMatching(candidate, platform), normalizeForMatching(base, platform), patterns, platform);
        if (matched) return matched;
      }
      return null;
    },
  };
}

/**
 * Turns a glob into an anchored regular expression. `**` spans directories only as a whole segment.
 * @param {string} pattern
 * @param {{ ignoreCase?: boolean }} [options]
 * @returns {RegExp}
 */
export function globToRegExp(pattern, { ignoreCase = false } = {}) {
  const source = toPosix(pattern);
  let expression = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '*' && source[index + 1] === '*') {
      const startsSegment = index === 0 || source[index - 1] === '/';
      if (startsSegment && source[index + 2] === '/') {
        expression += '(?:[^/]*/)*';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (char === '*') {
      expression += '[^/]*';
    } else if (char === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegExp(char);
    }
  }
  return new RegExp(`^${expression}$`, ignoreCase ? 'i' : '');
}

/**
 * @param {string} value
 * @returns {string}
 */
export function toPosix(value) {
  return value.replace(/\\/g, '/');
}

/**
 * `\\?\C:\x`, `\\.\C:\x` and the local admin share `\\host\C$\x` all name the files of `C:\x`, and
 * `\\?\UNC\server\share` is `\\server\share`. Returns forward slashes when it rewrites the path.
 * @param {string} value
 * @param {{ platform?: NodeJS.Platform, hostnames?: readonly string[] }} [options]
 * @returns {string}
 */
export function normalizeWindowsPath(value, { platform = process.platform, hostnames = [] } = {}) {
  const posix = toPosix(value);
  if (/^\/\/[?.]\/UNC\//i.test(posix)) return normalizeWindowsPath(`//${posix.slice(8)}`, { platform, hostnames });
  if (/^\/\/[?.]\/[a-zA-Z]:/.test(posix)) return posix.slice(4);
  const share = /^\/\/([^/]+)\/([a-zA-Z])\$(\/.*)?$/.exec(posix);
  if (platform === 'win32' && share && isLocalHostName(share[1], hostnames)) return `${share[2].toUpperCase()}:${share[3] ?? '/'}`;
  return value;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isUncPath(value) {
  return /^[\\/]{2}[^\\/?.]/.test(value);
}

/**
 * @param {string} name
 * @param {readonly string[]} hostnames
 * @returns {boolean}
 */
function isLocalHostName(name, hostnames) {
  const lower = name.toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]', ...hostnames.map((entry) => entry.toLowerCase())].includes(lower);
}

/**
 * @param {string} target
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function normalizeForMatching(target, platform) {
  let posix = toPosix(normalizeWindowsPath(target, { platform }));
  // `name:stream` and `name::$DATA` (NTFS alternate data streams) open the file named before the colon.
  if (platform === 'win32') posix = posix.replace(/(^[a-zA-Z]:)?([^:]*)(:.*)?$/, (_, drive = '', rest) => `${drive}${rest}`);
  return posix;
}

/**
 * @param {string} absolutePosix
 * @param {string} basePosix
 * @param {readonly string[]} patterns
 * @param {NodeJS.Platform} platform
 * @returns {string | null}
 */
function matchPattern(absolutePosix, basePosix, patterns, platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const relative = toPosix(api.relative(basePosix, absolutePosix));
  const relativeUsable = relative !== '' && !api.isAbsolute(relative) && !relative.startsWith('../');
  const segments = (relativeUsable ? relative : absolutePosix.replace(/^[a-zA-Z]:/, ''))
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  for (const pattern of patterns) {
    const normalized = toPosix(pattern);
    // Secret files are matched case-insensitively everywhere: `.ENV` holds the same secrets as `.env`.
    const matcher = globToRegExp(normalized, { ignoreCase: true });
    const matched = normalized.includes('/')
      ? matcher.test(absolutePosix) || (relativeUsable && matcher.test(relative))
      : segments.some((segment) => matcher.test(segment));
    if (matched) return pattern;
  }
  return null;
}

/**
 * @param {string} target
 * @returns {string | null}
 */
function tryRealPath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
