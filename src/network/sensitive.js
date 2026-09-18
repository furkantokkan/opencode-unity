// The CLI half of the shared sensitive and credential detector (amendment S32).
//
// There is no second implementation here on purpose. The detector itself lives in
// `plugin/opencode-unity-lib/net/sensitive.js`, because only `plugin/` is copied into the rendered
// profile and the plugin may never import the CLI; the delegate lane, the `net` command group, the
// allow-list render and the doctor checks reach it through this module, so "one detector" is a fact
// about the file tree rather than a convention someone has to keep.
export {
  CREDENTIAL_PATTERN_IDS,
  DEFAULT_SENSITIVE_PATTERNS,
  EMULATOR_BEARER_VALUE,
  HIGH_ENTROPY_EXCLUSIONS,
  HIGH_ENTROPY_MIN_BITS,
  NEVER_FORWARDED_ENV_PATTERNS,
  SENSITIVE_KEYS,
  createSensitiveMatcher,
  findCredential,
  findCredentialInHeaders,
  findNeverForwardedEnvNames,
  globToRegExp,
  isNeverForwardedEnvName,
  isSensitiveQueryKey,
  isUncPath,
  normalizeWindowsPath,
  scanQuery,
  shannonEntropy,
  toPosix,
} from '../../plugin/opencode-unity-lib/net/sensitive.js';

/** @typedef {import('../../plugin/opencode-unity-lib/net/sensitive.js').SensitiveMatcher} SensitiveMatcher */
/** @typedef {import('../../plugin/opencode-unity-lib/net/sensitive.js').CredentialPatternId} CredentialPatternId */
/** @typedef {import('../../plugin/opencode-unity-lib/net/sensitive.js').CredentialHit} CredentialHit */
/** @typedef {import('../../plugin/opencode-unity-lib/net/sensitive.js').QueryFinding} QueryFinding */
