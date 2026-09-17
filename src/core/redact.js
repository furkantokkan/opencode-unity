// Redaction for reports people paste into issues (`doctor --redact`, `--markdown`; spec 5.4, P5): user
// names, machine names, home paths, project names and paths, emails and credential values are replaced
// with placeholders such as <home> and <redacted>. Known values are replaced first, then patterns catch
// what the known values missed (another user's home path, a key in a config file).
import os from 'node:os';

export const PLACEHOLDERS = Object.freeze({
  home: '<home>',
  user: '<user>',
  machine: '<machine>',
  project: '<project>',
  projectPath: '<project-path>',
  email: '<email>',
  secret: '<redacted>',
});

// Short or generic values would erase ordinary words.
const MIN_WORD_LENGTH = 3;
const GENERIC_NAMES = new Set(['user', 'users', 'admin', 'administrator', 'root', 'runner', 'runneradmin', 'public', 'default', 'shared', 'localhost', 'project', 'game', 'unity']);

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const TOKEN_PATTERNS = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
// `Bearer <value>` and `name: value` / `name=value` / `"name": "value"` for credential-like names.
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// The name must end in a credential word, so counters such as "maxOutputTokens" or "toolsTokensSource" stay.
const SECRET_ASSIGNMENT =
  /(["']?\b[A-Za-z0-9_.-]*?(?:api[_-]?key|secret|token|password|passwd|credentials?|authorization|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;"'}\]]+))/gi;
const WINDOWS_HOME = /\b([A-Za-z]:(?:\\\\|\\|\/)(?:Users|Documents and Settings)(?:\\\\|\\|\/))([^\\/\s"'<>|:*?]+)/gi;
const POSIX_HOME = /(^|[\s"'=(:])(\/(?:home|Users)\/)([^/\s"'<>]+)/gm;

/**
 * @typedef {object} RedactionTargets
 * @property {string[]} [homeDirs]      Absolute paths replaced by <home>.
 * @property {string[]} [userNames]
 * @property {string[]} [machineNames]
 * @property {string[]} [projectNames]
 * @property {string[]} [projectPaths]  Absolute project paths replaced by <project-path>.
 * @property {string[]} [secrets]       Literal values replaced by <redacted>, for example key values read from the env.
 */

/**
 * @typedef {object} Redactor
 * @property {(text: string) => string} redactText
 * @property {<T>(value: T) => T} redactValue   Deep copy with every string (and object key) redacted.
 */

/**
 * @param {RedactionTargets} [targets]
 * @returns {Redactor}
 */
export function createRedactor({ homeDirs = [], userNames = [], machineNames = [], projectNames = [], projectPaths = [], secrets = [] } = {}) {
  /** @type {Array<[RegExp, string]>} */
  const literalRules = [
    ...buildPathRules(projectPaths, PLACEHOLDERS.projectPath),
    ...buildPathRules(homeDirs, PLACEHOLDERS.home),
    ...buildLiteralRules(secrets.filter((value) => value.length >= 6), PLACEHOLDERS.secret),
  ];
  /** @type {Array<[RegExp, string]>} */
  const wordRules = [
    ...buildWordRules(projectNames, PLACEHOLDERS.project),
    ...buildWordRules(userNames, PLACEHOLDERS.user),
    ...buildWordRules(machineNames, PLACEHOLDERS.machine),
  ];

  /** @param {string} text */
  const redactText = (text) => {
    let result = String(text);
    for (const [pattern, replacement] of literalRules) result = result.replace(pattern, replacement);
    for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, PLACEHOLDERS.secret);
    result = result.replace(BEARER, (_match, scheme) => `${scheme} ${PLACEHOLDERS.secret}`);
    result = result.replace(SECRET_ASSIGNMENT, (match, prefix, doubleQuoted, singleQuoted, bare) => {
      if (bare !== undefined && (bare === PLACEHOLDERS.secret || /^(true|false|null|-?\d+(\.\d+)?)$/i.test(bare))) return match;
      if (doubleQuoted !== undefined) return doubleQuoted === '' ? match : `${prefix}"${PLACEHOLDERS.secret}"`;
      if (singleQuoted !== undefined) return singleQuoted === '' ? match : `${prefix}'${PLACEHOLDERS.secret}'`;
      return `${prefix}${PLACEHOLDERS.secret}`;
    });
    result = result.replace(EMAIL, PLACEHOLDERS.email);
    result = result.replace(WINDOWS_HOME, (match, prefix, name) => (isPlaceholderOrGeneric(name) ? match : `${prefix}${PLACEHOLDERS.user}`));
    result = result.replace(POSIX_HOME, (match, lead, prefix, name) => (isPlaceholderOrGeneric(name) ? match : `${lead}${prefix}${PLACEHOLDERS.user}`));
    for (const [pattern, replacement] of wordRules) result = result.replace(pattern, replacement);
    return result;
  };

  /**
   * @param {unknown} value
   * @returns {unknown}
   */
  const redactAny = (value) => {
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map(redactAny);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [redactText(key), redactAny(child)]));
    }
    return value;
  };

  return { redactText, redactValue: (value) => /** @type {any} */ (redactAny(value)) };
}

/**
 * Targets for this machine: the OS user, host name, home directory and the product's own paths.
 * @param {{ env?: Record<string, string | undefined>, homedir?: string, hostname?: string, username?: string, projectPaths?: string[], projectNames?: string[] }} [options]
 * @returns {RedactionTargets}
 */
export function getLocalRedactionTargets({ env = process.env, homedir = os.homedir(), hostname = os.hostname(), username = safeUsername(), projectPaths = [], projectNames = [] } = {}) {
  const homeDirs = [homedir, env.USERPROFILE, env.HOME].filter(isNonEmpty);
  const userNames = [username, env.USERNAME, env.USER].filter(isNonEmpty);
  const machineNames = [hostname, env.COMPUTERNAME, env.HOSTNAME].filter(isNonEmpty);
  const secrets = Object.entries(env)
    .filter(([name, value]) => isNonEmpty(value) && /(_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_SECRET|_PASSWORD)$|^(HF_TOKEN|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN)$/i.test(name))
    .map(([, value]) => /** @type {string} */ (value));
  return { homeDirs: unique(homeDirs), userNames: unique(userNames), machineNames: unique(machineNames), projectPaths, projectNames, secrets: unique(secrets) };
}

/**
 * @param {string[]} paths
 * @param {string} placeholder
 * @returns {Array<[RegExp, string]>}
 */
function buildPathRules(paths, placeholder) {
  /** @type {Set<string>} */
  const variants = new Set();
  for (const raw of paths.filter(isNonEmpty)) {
    const trimmed = raw.replace(/[\\/]+$/, '');
    if (trimmed.length < MIN_WORD_LENGTH) continue;
    const forward = trimmed.replace(/\\/g, '/');
    const backward = forward.replace(/\//g, '\\');
    for (const variant of [forward, backward, backward.replace(/\\/g, '\\\\')]) variants.add(variant);
  }
  // Longest first, so a project inside the home becomes <project-path>, not <home>/...
  return [...variants]
    .sort((a, b) => b.length - a.length)
    .map((variant) => [new RegExp(`${escapeRegExp(variant)}(?![A-Za-z0-9_.-])`, 'gi'), placeholder]);
}

/**
 * @param {string[]} values
 * @param {string} placeholder
 * @returns {Array<[RegExp, string]>}
 */
function buildLiteralRules(values, placeholder) {
  return unique(values)
    .sort((a, b) => b.length - a.length)
    .map((value) => [new RegExp(escapeRegExp(value), 'g'), placeholder]);
}

/**
 * @param {string[]} words
 * @param {string} placeholder
 * @returns {Array<[RegExp, string]>}
 */
function buildWordRules(words, placeholder) {
  return unique(words.filter((word) => isNonEmpty(word) && word.length >= MIN_WORD_LENGTH && !GENERIC_NAMES.has(word.toLowerCase())))
    .sort((a, b) => b.length - a.length)
    .map((word) => [new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(word)}(?![A-Za-z0-9])`, 'gi'), placeholder]);
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isPlaceholderOrGeneric(name) {
  return name.startsWith('<') || name.startsWith('%') || name.startsWith('$') || name === '*' || GENERIC_NAMES.has(name.toLowerCase());
}

/**
 * @returns {string}
 */
function safeUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

/**
 * @param {string | undefined} value
 * @returns {value is string}
 */
function isNonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values)];
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
