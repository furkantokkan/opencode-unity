// Whether a volume folds case, probed once per project root, and the identity path a project id hashes
// (CP-D13). The base spec folded case "on Windows", but APFS is case-insensitive by default: without a
// probe, one macOS directory reached by two spellings gets two project ids, two facts files and two
// local.json files, and `init --refresh` silently updates the wrong one. Case-sensitive APFS volumes and
// case-insensitive Linux mounts both exist, so the answer is measured rather than read off the platform.
import nodeFs from 'node:fs';
import nodePath from 'node:path';

/**
 * `paths.js` exports the same selector, but it now builds project ids on this module, so importing it
 * back would make the two core path modules a cycle. This is the lower of the two: it stays here.
 * @param {NodeJS.Platform} platform
 * @returns {import('node:path').PlatformPath}
 */
function getPathApi(platform) {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

/**
 * @typedef {'same-inode' | 'distinct-inode' | 'flipped-absent' | 'no-cased-segment' | 'stat-failed' | 'given'} CaseProbeReason
 *   `same-inode` and `distinct-inode`: both spellings resolved and were compared.
 *   `flipped-absent`: the flipped spelling does not exist, which only a case-sensitive volume allows.
 *   `no-cased-segment` and `stat-failed`: the probe could not decide, and folds.
 *   `given`: the caller supplied the answer and no probe ran.
 */

/**
 * @typedef {object} CaseSensitivity
 * @property {boolean} caseInsensitive  True when two spellings reach the same directory, so ids fold.
 * @property {CaseProbeReason} reason
 * @property {string | null} probedPath  The case-flipped path that was stat-ed, when one could be built.
 */

/**
 * @typedef {object} ProjectIdentity
 * @property {string} absolutePath  Resolved, no trailing separator, original case.
 * @property {string} identityPath  What the project id hashes: `absolutePath`, folded when the volume folds.
 * @property {boolean} caseInsensitive
 * @property {CaseProbeReason} reason
 * @property {string | null} probedPath
 */

/**
 * @typedef {object} ProbeOptions
 * @property {Pick<typeof nodeFs, 'statSync'>} [fs]
 * @property {NodeJS.Platform} [platform]
 * @property {Map<string, CaseSensitivity>} [cache]  Defaults to a process-wide cache, so a root is probed once.
 */

// An absent flipped spelling is the positive signal of a case-sensitive volume: it is the one stat failure
// that decides. Every other error (EACCES, EPERM, EIO, ELOOP, ...) means the probe could not see the
// volume at all, and an undecided probe folds - one id is recoverable, two are not.
const ABSENT_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR']);

/** @type {Map<string, CaseSensitivity>} */
const processCache = new Map();

/**
 * @returns {Map<string, CaseSensitivity>} An isolated cache, so a test never inherits another test's probe.
 */
export function createCaseSensitivityCache() {
  return new Map();
}

/**
 * Drops the process-wide probe cache. Only tests need this.
 * @returns {void}
 */
export function clearCaseSensitivityCache() {
  processCache.clear();
}

/**
 * The absolute project path before any case folding: resolved against `cwd`, with trailing separators
 * removed. `normalizeProjectPath` is this plus `foldIdentityPath`.
 * @param {string} projectPath
 * @param {{ platform?: NodeJS.Platform, cwd?: string }} [options]
 * @returns {string}
 */
export function toAbsoluteProjectPath(projectPath, { platform = process.platform, cwd = process.cwd() } = {}) {
  const api = getPathApi(platform);
  let resolved = api.resolve(cwd, projectPath);
  const root = api.parse(resolved).root;
  // Only the platform's own separators, because a backslash is a legal character in a POSIX file name.
  const trailing = platform === 'win32' ? /[\\/]$/ : /\/$/;
  while (resolved.length > root.length && trailing.test(resolved)) resolved = resolved.slice(0, -1);
  return resolved;
}

/**
 * @param {string} absolutePath  From `toAbsoluteProjectPath`.
 * @param {boolean} caseInsensitive
 * @returns {string} The path a project id hashes.
 */
export function foldIdentityPath(absolutePath, caseInsensitive) {
  // `toLowerCase` is locale-independent, unlike `toLocaleLowerCase`, so the same path folds the same way
  // under a Turkish locale as under any other.
  return caseInsensitive ? absolutePath.toLowerCase() : absolutePath;
}

/**
 * Flips every ASCII letter. Only ASCII, because case mapping outside it can change a string's length
 * (German sharp s uppercases to two characters) and the probe path must differ only in case.
 * @param {string} text
 * @returns {string}
 */
export function flipAsciiCase(text) {
  let flipped = '';
  for (const character of text) {
    if (character >= 'a' && character <= 'z') flipped += character.toUpperCase();
    else if (character >= 'A' && character <= 'Z') flipped += character.toLowerCase();
    else flipped += character;
  }
  return flipped;
}

/**
 * The pair of paths the probe compares: the deepest ancestor-or-self whose own segment contains an ASCII
 * letter, and that same path with the segment's case flipped.
 * @param {string} absolutePath
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {{ subject: string, flipped: string } | null} Null when no segment can be flipped.
 */
export function buildCaseProbePaths(absolutePath, { platform = process.platform } = {}) {
  const api = getPathApi(platform);
  const root = api.parse(absolutePath).root;
  const separators = platform === 'win32' ? /[\\/]+/ : /\/+/;
  const segments = absolutePath.slice(root.length).split(separators).filter((segment) => segment !== '');
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (!/[A-Za-z]/.test(segments[index])) continue;
    const kept = segments.slice(0, index);
    return {
      subject: api.join(root, ...kept, segments[index]),
      flipped: api.join(root, ...kept, flipAsciiCase(segments[index])),
    };
  }
  return null;
}

/**
 * Stats the path and its case-flipped spelling and compares `ino` and `dev` (CP-D13). Cached per root,
 * because the answer is a property of the volume and cannot change while a command runs.
 * @param {string} absolutePath  From `toAbsoluteProjectPath`.
 * @param {ProbeOptions} [options]
 * @returns {CaseSensitivity}
 */
export function probeCaseInsensitive(absolutePath, { fs = nodeFs, platform = process.platform, cache = processCache } = {}) {
  const cached = cache.get(absolutePath);
  if (cached) return cached;
  const result = runProbe(absolutePath, fs, platform);
  cache.set(absolutePath, result);
  return result;
}

/**
 * @param {string} absolutePath
 * @param {Pick<typeof nodeFs, 'statSync'>} fs
 * @param {NodeJS.Platform} platform
 * @returns {CaseSensitivity}
 */
function runProbe(absolutePath, fs, platform) {
  const paths = buildCaseProbePaths(absolutePath, { platform });
  if (!paths) return { caseInsensitive: true, reason: 'no-cased-segment', probedPath: null };

  let subject;
  try {
    subject = fs.statSync(paths.subject);
  } catch {
    // The project directory itself is unreadable or absent, so nothing has been measured.
    return { caseInsensitive: true, reason: 'stat-failed', probedPath: paths.flipped };
  }

  let flipped;
  try {
    flipped = fs.statSync(paths.flipped);
  } catch (error) {
    const absent = ABSENT_ERROR_CODES.has(/** @type {NodeJS.ErrnoException} */ (error)?.code ?? '');
    return { caseInsensitive: !absent, reason: absent ? 'flipped-absent' : 'stat-failed', probedPath: paths.flipped };
  }

  const same = sameEntry(subject, flipped);
  return { caseInsensitive: same, reason: same ? 'same-inode' : 'distinct-inode', probedPath: paths.flipped };
}

/**
 * @param {{ ino?: number | bigint, dev?: number | bigint }} a
 * @param {{ ino?: number | bigint, dev?: number | bigint }} b
 * @returns {boolean}
 */
function sameEntry(a, b) {
  // Compared as text because a `bigint: true` stat and a plain one must agree, and because an inode above
  // 2^53 would otherwise compare equal to its neighbour - which would fold, the recoverable direction.
  return String(a?.ino) === String(b?.ino) && String(a?.dev) === String(b?.dev);
}

/**
 * The absolute path, the folded identity path a project id hashes, and how that was decided.
 * Pass `caseInsensitive` to skip the probe entirely, which keeps callers pure.
 * @param {string} projectPath
 * @param {ProbeOptions & { cwd?: string, caseInsensitive?: boolean }} [options]
 * @returns {ProjectIdentity}
 */
export function resolveProjectIdentity(projectPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const absolutePath = toAbsoluteProjectPath(projectPath, { platform, cwd: options.cwd });
  /** @type {CaseSensitivity} */
  const sensitivity =
    options.caseInsensitive === undefined
      ? probeCaseInsensitive(absolutePath, { fs: options.fs, platform, cache: options.cache })
      : { caseInsensitive: options.caseInsensitive, reason: 'given', probedPath: null };
  return {
    absolutePath,
    identityPath: foldIdentityPath(absolutePath, sensitivity.caseInsensitive),
    caseInsensitive: sensitivity.caseInsensitive,
    reason: sensitivity.reason,
    probedPath: sensitivity.probedPath,
  };
}
