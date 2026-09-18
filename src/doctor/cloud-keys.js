// Cloud credentials in the environment (spec 8.1, 5.4 `privacy.cloud-keys`).
//
// The launcher removes these before starting OpenCode. Doctor only reports that they are present,
// because a machine that has them and a session that can use them are different things, and the user
// is the one who knows which providers they meant to enable.
//
// Only names are ever reported. A value is added to the redaction list, never printed.

/** Suffixes and prefixes that name a credential, whatever the vendor calls it. */
const PATTERNS = Object.freeze([
  /_API_KEY$/,
  /_AUTH_TOKEN$/,
  /_ACCESS_TOKEN$/,
  /^AWS_/,
  /^AZURE_OPENAI_/,
]);

/** Exact names with no shared shape. */
const EXACT = Object.freeze(['GOOGLE_APPLICATION_CREDENTIALS', 'HF_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'OPENCODE_CONSOLE_TOKEN']);

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]} Names only, sorted.
 */
export function listCloudCredentialNames(env) {
  return Object.keys(env)
    .filter((name) => (env[name] ?? '') !== '')
    .filter((name) => EXACT.includes(name) || PATTERNS.some((pattern) => pattern.test(name)))
    .sort();
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]} The values, for the redactor's literal list.
 */
export function listCloudCredentialValues(env) {
  return listCloudCredentialNames(env).map((name) => env[name] ?? '').filter((value) => value !== '');
}
