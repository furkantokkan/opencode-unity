// The one sensitive and credential detector (amendment S32, expansion 12.12). Three questions, one
// module, so the delegate lane and the network lane can never answer them differently:
//
//   1. Is this path a secret file?          `createSensitiveMatcher` (spec 12.3)
//   2. Is this text credential-shaped?      `findCredential`, `scanQuery` (12.12.3)
//   3. May this variable reach a child?     `isNeverForwardedEnvName` (spec 8.1, 12.12.4)
//
// Every answer names a **pattern id, never the matched text** (12.12.2): a deny message and a session
// log line both go somewhere a secret must not, so the detector that finds one may not repeat it.
//
// Like `protected-paths.js` this lives under `plugin/` because only `plugin/` is copied into the
// rendered profile: the CLI may import the plugin, and the plugin may never import the CLI.
// `src/network/sensitive.js` re-exports it for the CLI half.
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';

// --------------------------------------------------------------------------------------------------
// 1. Secret paths (spec 12.3)
// --------------------------------------------------------------------------------------------------

/**
 * Default patterns (spec 12.3: the PROTECTED_READ secret globs of 8.5.2, plus SSH keys, `.npmrc`,
 * `.netrc` and `.git-credentials`). A pattern without `/` matches any path segment, like `.gitignore`;
 * a pattern with `/` matches the whole relative or absolute path.
 *
 * The order is the reported order: `find` returns the first pattern that matched, so a new pattern is
 * appended rather than inserted, or an existing caller starts being told about a different rule for a
 * file whose verdict did not change.
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
 * The narrow interface a caller needs from the path half of the detector.
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

// --------------------------------------------------------------------------------------------------
// 2. Sensitive keys (expansion 12.7.4 `deniedQueryKeys`, 12.12.3 assignment keys)
// --------------------------------------------------------------------------------------------------

/**
 * Keys whose value is a credential wherever it appears: a query parameter (execution step 9), a JSON
 * field, an `.env` line. One list, two comparisons - exact lower case for a query key, because that is
 * what the rendered `deniedQueryKeys` array is compared with, and separator-folded for an assignment,
 * so `api-key`, `apiKey` and `API_KEY` are all `apikey`.
 *
 * `key` on its own is deliberately in the list: it is the parameter name a Google API key is passed
 * under. The cost is that a JSON field literally called `key` with a long value is refused as well,
 * which is the direction to be wrong in - the refusal names the key, so it is one edit to fix.
 * @type {readonly string[]}
 */
export const SENSITIVE_KEYS = Object.freeze([
  'key', 'api_key', 'apikey', 'token', 'access_token', 'id_token', 'refresh_token',
  'auth', 'authorization', 'password', 'passwd', 'secret', 'client_secret',
  'signature', 'sig', 'session', 'sessionid', 'cookie',
]);

/** @type {ReadonlySet<string>} */
const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS);

/** @type {ReadonlySet<string>} */
const FOLDED_SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map(foldKey));

/**
 * @param {string} key
 * @returns {string}
 */
function foldKey(key) {
  return key.toLowerCase().replace(/[-_. ]/g, '');
}

/**
 * Execution step 9: a query key is denied by its own name, whatever its value looks like.
 * @param {string} key
 * @returns {boolean}
 */
export function isSensitiveQueryKey(key) {
  return SENSITIVE_KEY_SET.has(key.toLowerCase());
}

// --------------------------------------------------------------------------------------------------
// 3. Credential shapes (expansion 12.12.3)
// --------------------------------------------------------------------------------------------------

/**
 * @typedef {'cred.jwt' | 'cred.google-api-key' | 'cred.google-oauth' | 'cred.firebase-refresh'
 *   | 'cred.pem-block' | 'cred.aws-access-key' | 'cred.github-token' | 'cred.slack-token'
 *   | 'cred.bearer' | 'cred.high-entropy' | 'cred.assignment'} CredentialPatternId
 */

/**
 * A hit carries where, never what. The offset lets a caller say which part of a body was refused
 * without quoting it.
 * @typedef {{ patternId: CredentialPatternId, index: number }} CredentialHit
 */

/**
 * The literal the Firestore, Database and Auth emulators accept as an owner token. It is 5 characters,
 * so `cred.bearer`'s own 24-character floor already lets it through; naming it here is what stops a
 * later widening of that floor from breaking the one `Authorization` value a loopback entry may carry
 * (`DN12`).
 */
export const EMULATOR_BEARER_VALUE = 'owner';

/** Shannon entropy above which a token that survives every exclusion is treated as generated. */
export const HIGH_ENTROPY_MIN_BITS = 3.5;

/** Longest token still allowed to be excused as encoded text; beyond it, an encoded blob is a payload. */
const ENCODED_TEXT_MAX_CHARS = 64;

/**
 * Evaluated in order, so the reported id is the most specific one that matched. `cred.high-entropy`
 * and `cred.assignment` are last because they are the shapeless rules: everything above them names a
 * vendor, and a JWT reported as high entropy would tell a reader nothing about what to fix.
 * @type {ReadonlyArray<{ id: CredentialPatternId, find: (text: string) => number }>}
 */
const CREDENTIAL_PATTERNS = Object.freeze([
  // Three base64url segments, the first starting `eyJ` - the base64 of `{"`. The signature may be
  // empty, because `alg: none` is a token too.
  { id: 'cred.jwt', find: byRegExp(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/) },
  { id: 'cred.google-api-key', find: byRegExp(/(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/) },
  { id: 'cred.google-oauth', find: byRegExp(/(?<![A-Za-z0-9_-])ya29\.[A-Za-z0-9_.-]{20,}/) },
  // A Firebase CLI refresh token. The lookbehind keeps `/v1//x` and `21//x` out of it.
  { id: 'cred.firebase-refresh', find: byRegExp(/(?<![A-Za-z0-9_./-])1\/\/[A-Za-z0-9_-]{20,}/) },
  // The header alone is the hit: the key material below it never has to be looked at.
  { id: 'cred.pem-block', find: byRegExp(/-----BEGIN[A-Z0-9 ]{0,40}PRIVATE KEY-----/) },
  { id: 'cred.aws-access-key', find: byRegExp(/(?<![A-Z0-9])(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}(?![A-Z0-9])/) },
  { id: 'cred.github-token', find: byRegExp(/(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9_]{36,}/) },
  { id: 'cred.slack-token', find: byRegExp(/(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}/) },
  // Case-folded: HTTP treats the scheme name case-insensitively, and a detector that only knows one
  // spelling of `Bearer` is a detector a lower-case `bearer ` walks past.
  { id: 'cred.bearer', find: byRegExp(/(?<![A-Za-z])bearer[ \t]+\S{24,}/i) },
  { id: 'cred.high-entropy', find: findHighEntropyToken },
  { id: 'cred.assignment', find: findSensitiveAssignment },
]);

/** @type {readonly CredentialPatternId[]} */
export const CREDENTIAL_PATTERN_IDS = Object.freeze(CREDENTIAL_PATTERNS.map((pattern) => pattern.id));

/**
 * The outbound scan of execution step 10, the query-value check of step 9, the header check of the
 * allow-list render, and `net allow` validation all come through here.
 * @param {string} text
 * @returns {CredentialHit | null}
 */
export function findCredential(text) {
  if (typeof text !== 'string' || text === '') return null;
  for (const pattern of CREDENTIAL_PATTERNS) {
    const index = pattern.find(text);
    if (index >= 0) return { patternId: pattern.id, index };
  }
  return null;
}

/**
 * @param {RegExp} expression  Without the global flag: one match is a hit.
 * @returns {(text: string) => number}
 */
function byRegExp(expression) {
  return (text) => {
    const match = expression.exec(text);
    return match ? match.index : -1;
  };
}

// --------------------------------------------------------------------------------------------------
// 3a. `cred.high-entropy`
// --------------------------------------------------------------------------------------------------

/**
 * Shapes that reach the entropy threshold and are still not secrets. Without them the rule fires on
 * `a3f5c1d9e7b2486fa0c4d8e21b6f3057` in a `.meta` file and on `some-long-hyphenated-manual-page`
 * in a documentation URL, and a detector that refuses ordinary Unity work gets switched off.
 *
 * Each exclusion has an id so a test can name the reason a fixture is not a hit.
 * @type {ReadonlyArray<{ id: string, excludes: (token: string) => boolean, reason: string }>}
 */
export const HIGH_ENTROPY_EXCLUSIONS = Object.freeze([
  {
    id: 'hexadecimal',
    excludes: (token) => /^[0-9a-f]+$/i.test(token.replace(/[-_]/g, '')),
    reason: 'Unity GUIDs, asset hashes and git SHAs are hexadecimal, and 32 hex characters clear 3.5 bits on their own',
  },
  {
    id: 'encoded-text',
    excludes: decodesToPrintableText,
    reason: 'base64 of printable text is a name or an id; a generated secret decodes to bytes that are not text',
  },
  {
    id: 'no-digit',
    excludes: (token) => !/[0-9]/.test(token),
    reason: 'a token with no digit is a word, a file name or an identifier',
  },
  {
    id: 'word-case',
    excludes: hasWordCasing,
    reason: 'a generated token mixes case at random, an identifier capitalises word starts',
  },
]);

/**
 * @param {string} text
 * @returns {number} Offset of the first high-entropy token, or -1.
 */
function findHighEntropyToken(text) {
  const runs = /[A-Za-z0-9_-]{32,}/g;
  for (let match = runs.exec(text); match; match = runs.exec(text)) {
    const token = match[0];
    if (HIGH_ENTROPY_EXCLUSIONS.some((exclusion) => exclusion.excludes(token))) continue;
    if (shannonEntropy(token) > HIGH_ENTROPY_MIN_BITS) return match.index;
  }
  return -1;
}

/**
 * Bits per character. An empty string is 0.
 * @param {string} text
 * @returns {number}
 */
export function shannonEntropy(text) {
  if (text.length === 0) return 0;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/**
 * True when the token is base64 (or base64url) of text a person could read. A random 24-byte secret
 * fails this with probability about 1 in 10^10, and a sprite name passes it.
 *
 * Bounded by `ENCODED_TEXT_MAX_CHARS`: a name is short, and a long encoded blob of printable bytes is
 * a file, which is exactly what must not leave.
 * @param {string} token
 * @returns {boolean}
 */
function decodesToPrintableText(token) {
  if (token.length > ENCODED_TEXT_MAX_CHARS || token.length % 4 === 1) return false;
  const bytes = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  // Node's decoder drops what it cannot use, so a token that shrank was never base64 to begin with.
  if (bytes.length < 8 || bytes.length < Math.floor((token.length * 3) / 4) - 2) return false;
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e) return false;
  }
  return true;
}

/**
 * Upper-case letters clustered at word starts rather than spread at random. Measured only when there
 * are enough letters for the ratio to mean anything.
 * @param {string} token
 * @returns {boolean}
 */
function hasWordCasing(token) {
  const letters = token.replace(/[^A-Za-z]/g, '');
  if (letters.length < 8) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length / letters.length;
  return upper < 0.2 || upper > 0.8;
}

// --------------------------------------------------------------------------------------------------
// 3b. `cred.assignment`
// --------------------------------------------------------------------------------------------------

/** Shortest assignment value still worth refusing (12.12.3). */
const ASSIGNMENT_MIN_VALUE_CHARS = 12;

/**
 * `"key": "value"` and `key=value`, and only in the two places a value is a value: a JSON field, and a
 * query parameter or environment line. The `=` form is anchored to a line start or to `?`, `&` or `;`
 * so that `var key = GetPlayerKey();` in a body of C# is not a credential - an assignment rule that
 * fires on ordinary code refuses ordinary work.
 * @param {string} text
 * @returns {number}
 */
function findSensitiveAssignment(text) {
  const json = /"([A-Za-z0-9_.-]{1,64})"[ \t]*:[ \t]*"([^"\r\n]+)"/g;
  for (let match = json.exec(text); match; match = json.exec(text)) {
    if (isSensitiveAssignment(match[1], match[2])) return match.index;
  }
  const pairs = /(^|[?&;])[ \t]*([A-Za-z0-9_.-]{1,64})[ \t]*=[ \t]*([^\s&"';]+)/gm;
  for (let match = pairs.exec(text); match; match = pairs.exec(text)) {
    if (isSensitiveAssignment(match[2], match[3])) return match.index + match[1].length;
  }
  return -1;
}

/**
 * @param {string} key
 * @param {string} value
 * @returns {boolean}
 */
function isSensitiveAssignment(key, value) {
  return FOLDED_SENSITIVE_KEY_SET.has(foldKey(key)) && value.length >= ASSIGNMENT_MIN_VALUE_CHARS;
}

// --------------------------------------------------------------------------------------------------
// 3c. Queries and headers
// --------------------------------------------------------------------------------------------------

/**
 * @typedef {{ reason: 'denied-key', key: string } | { reason: 'credential-value', key: string, patternId: CredentialPatternId }} QueryFinding
 */

/**
 * Execution step 9 over already-decoded pairs. The URL is parsed by the network policy, never here:
 * one module decides what a URL is.
 *
 * The key is returned because a key name is not a secret and the model has to be told which parameter
 * to drop; the value never is.
 * @param {Iterable<readonly [string, string]>} pairs
 * @returns {QueryFinding | null}
 */
export function scanQuery(pairs) {
  for (const [key, value] of pairs) {
    if (isSensitiveQueryKey(key)) return { reason: 'denied-key', key };
    const hit = findCredential(value);
    if (hit) return { reason: 'credential-value', key, patternId: hit.patternId };
  }
  return null;
}

/**
 * The allow-list render check of 12.7.2: a literal header map on a loopback entry may carry
 * `Authorization: Bearer owner`, and may not carry a real token.
 * @param {Record<string, string>} headers
 * @returns {{ name: string, patternId: CredentialPatternId } | null}
 */
export function findCredentialInHeaders(headers) {
  for (const [name, value] of Object.entries(headers)) {
    const hit = findCredential(value);
    if (hit) return { name, patternId: hit.patternId };
  }
  return null;
}

// --------------------------------------------------------------------------------------------------
// 4. Environment variables that never reach a child (spec 8.1, expansion 12.12.4)
// --------------------------------------------------------------------------------------------------

/**
 * Removed from the OpenCode child environment and never restored by `shell.env`.
 *
 * Three reasons, all of them listed here rather than in three places:
 *   - a credential the child would inherit and use (`FIREBASE_TOKEN` is picked up by the Firebase CLI
 *     automatically, so any process the agent starts would hold a working production credential);
 *   - a redirect that makes a session behave unlike the user's own terminal and every result
 *     unreproducible (the emulator-host variables, the project ids);
 *   - a proxy variable, because the design has no proxy support and a system proxy would silently
 *     become the real destination, defeating the pinned address (`DN8`).
 *
 * Matching folds case, so the POSIX lower-case proxy spellings and any lower-case local variable are
 * covered by the upper-case entry. Names some globs already subsume are still written out, because
 * `start --print-env` prints this list and a reader checks it against the two specs that name them;
 * `isNeverForwardedEnvName` reports the first pattern in this order, which for those names is the glob.
 * @type {readonly string[]}
 */
export const NEVER_FORWARDED_ENV_PATTERNS = Object.freeze([
  // Spec 8.1: cloud credentials.
  '*_API_KEY', '*_AUTH_TOKEN', '*_ACCESS_TOKEN', '*_TOKEN', '*_SECRET', '*_PASSWORD', '*_CREDENTIALS',
  'AWS_*', 'AZURE_OPENAI_*', 'GOOGLE_APPLICATION_CREDENTIALS', 'HF_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN',
  'OPENCODE_CONSOLE_TOKEN',
  // 12.12.4: Firebase and Google Cloud.
  'FIREBASE_TOKEN', 'FIREBASE_TOKEN_*', 'FIREBASE_SERVICE_ACCOUNT*', 'FIREBASE_CONFIG',
  'GOOGLE_GHA_CREDS_PATH', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CLOUDSDK_*', 'GOOGLE_OAUTH_*',
  // 12.12.4: emulator redirects.
  'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST', 'CLOUD_TASKS_EMULATOR_HOST', 'PUBSUB_EMULATOR_HOST',
  // 12.12.4: other backends and paid search keys.
  'SUPABASE_*', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'PARALLEL_API_KEY', 'EXA_API_KEY',
  // 12.12.4: proxies.
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
]);

/** @type {ReadonlyArray<{ pattern: string, matcher: RegExp }>} */
const NEVER_FORWARDED_ENV_MATCHERS = Object.freeze(
  NEVER_FORWARDED_ENV_PATTERNS.map((pattern) => ({ pattern, matcher: globToRegExp(pattern, { ignoreCase: true }) })),
);

/**
 * @param {string} name
 * @returns {string | null} The pattern that matched, or null.
 */
export function isNeverForwardedEnvName(name) {
  for (const { pattern, matcher } of NEVER_FORWARDED_ENV_MATCHERS) {
    if (matcher.test(name)) return pattern;
  }
  return null;
}

/**
 * What `start --print-env` prints and what the `privacy.backend-credentials` doctor check reports:
 * the names that were present in the parent environment, sorted, **never the values**.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function findNeverForwardedEnvNames(env) {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && isNeverForwardedEnvName(name) !== null)
    .sort();
}
