// The clean-room launch environment of spec 8.1, built by `start`, `bench` and `doctor --deep --profile`.
//
// Two things happen here, and both are subtractive before they are additive:
//
//   1. Every inherited `OPENCODE_*` variable is dropped, except four that only change how the TUI
//      looks. A user who exported `OPENCODE_PERMISSION` or `OPENCODE_CONFIG_CONTENT` for their own
//      setup would otherwise silently re-allow actions this product denies, so those four names are
//      not just dropped but reported.
//   2. Credentials, backend redirects and proxies are dropped: spec 8.1's cloud keys plus the
//      never-forwarded list of amendment 12.12.4 (`FIREBASE_TOKEN`, emulator hosts, `*_SECRET`, the
//      proxy variables, ...). The session runs against a local model; a key in the environment could
//      only ever reach somewhere else (P1). The list is the shared detector's, so the launch, the
//      doctor and the network lane cannot disagree about it.
//
// Then the isolation variables are set. The result is a complete environment for the child process,
// not a patch, so nothing can be inherited by accident.
//
// Nothing here touches `process.env`: the caller passes the parent environment in and hands the
// returned object to `spawn`. `--print-env` prints the same object, which is why the removed names
// are returned beside it and no value of a removed variable is ever kept.
import { isNeverForwardedEnvName } from '../../plugin/opencode-unity-lib/net/sensitive.js';
import { ORIGINAL_XDG_ENV, UNSET_MARKER } from '../../plugin/opencode-unity-lib/shell-env.js';

/** Inherited `OPENCODE_*` variables that only affect the terminal UI, so they are kept (spec 8.1). */
export const KEPT_OPENCODE_VARIABLES = Object.freeze([
  'OPENCODE_DISABLE_MOUSE',
  'OPENCODE_DISABLE_TERMINAL_TITLE',
  'OPENCODE_GIT_BASH_PATH',
  'OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT',
]);

/** Removed `OPENCODE_*` variables that would have changed the rules, not the looks. */
export const REPORTED_OPENCODE_VARIABLES = Object.freeze([
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_PERMISSION',
  'OPENCODE_PURE',
  'OPENCODE_DISABLE_AUTOCOMPACT',
]);

/** Large `dotnet build` runs need more than OpenCode's default bash timeout (OC runtime-flags.ts L53). */
export const BASH_TIMEOUT_MS = 300000;

/**
 * @typedef {object} LaunchEnvInput
 * @property {Record<string, string | undefined>} env    The parent environment.
 * @property {string} home                               `<home>` (spec 6.1).
 * @property {string} profileDir                         `<home>/profile/<cliVersion>`.
 * @property {string} xdgConfigDir                       `<home>/xdg-config`.
 * @property {string} projectId
 * @property {string} [configContent]                    The per-launch `OPENCODE_CONFIG_CONTENT` (8.4).
 * @property {boolean} [disableProjectConfig]            `--no-project-config`.
 */

/**
 * @typedef {object} LaunchEnvResult
 * @property {Record<string, string>} env                Complete environment for the child.
 * @property {string[]} removedOpencode                  Inherited `OPENCODE_*` names that were dropped.
 * @property {string[]} removedCredentials               Credential, backend and proxy names that were dropped.
 * @property {string[]} warnings
 */

/**
 * @param {LaunchEnvInput} input
 * @returns {LaunchEnvResult}
 */
export function buildLaunchEnv({ env, home, profileDir, xdgConfigDir, projectId, configContent, disableProjectConfig = false }) {
  for (const [name, value] of Object.entries({ home, profileDir, xdgConfigDir, projectId })) {
    if (typeof value !== 'string' || value === '') throw new TypeError(`buildLaunchEnv needs ${name}`);
  }

  /** @type {Record<string, string>} */
  const child = {};
  /** @type {string[]} */
  const removedOpencode = [];
  /** @type {string[]} */
  const removedCredentials = [];

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (isCredentialName(name)) {
      removedCredentials.push(name);
      continue;
    }
    if (upper.startsWith('OPENCODE_') && !KEPT_OPENCODE_VARIABLES.includes(upper)) {
      removedOpencode.push(name);
      continue;
    }
    child[name] = value;
  }

  const originalXdg = readValue(env, 'XDG_CONFIG_HOME');
  Object.assign(child, {
    XDG_CONFIG_HOME: xdgConfigDir,
    OPENCODE_CONFIG_DIR: profileDir,
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: String(BASH_TIMEOUT_MS),
    OPENCODE_UNITY_HOME: home,
    OPENCODE_UNITY_PROJECT: projectId,
    [ORIGINAL_XDG_ENV]: originalXdg ?? UNSET_MARKER,
  });
  if (configContent !== undefined) child.OPENCODE_CONFIG_CONTENT = configContent;
  if (disableProjectConfig) child.OPENCODE_DISABLE_PROJECT_CONFIG = '1';

  return {
    env: child,
    removedOpencode: removedOpencode.sort(compareNames),
    removedCredentials: removedCredentials.sort(compareNames),
    warnings: buildWarnings(removedOpencode, removedCredentials),
  };
}

/**
 * What `--print-env` shows: the variables the product sets, plus the names it removed. A removed
 * variable's value is never printed, because it is exactly the kind of value that should not be.
 * @param {LaunchEnvResult} result
 * @returns {{ set: Array<[string, string]>, removedOpencode: string[], removedCredentials: string[] }}
 */
export function describeLaunchEnv(result) {
  const names = new Set([
    'XDG_CONFIG_HOME',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_DISABLE_CLAUDE_CODE',
    'OPENCODE_DISABLE_EXTERNAL_SKILLS',
    'OPENCODE_DISABLE_AUTOUPDATE',
    'OPENCODE_DISABLE_MODELS_FETCH',
    'OPENCODE_DISABLE_LSP_DOWNLOAD',
    'OPENCODE_DISABLE_PROJECT_CONFIG',
    'OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS',
    'OPENCODE_UNITY_HOME',
    'OPENCODE_UNITY_PROJECT',
    ORIGINAL_XDG_ENV,
    ...KEPT_OPENCODE_VARIABLES,
  ]);
  /** @type {Array<[string, string]>} */
  const set = [];
  for (const name of names) {
    const value = result.env[name];
    if (value !== undefined) set.push([name, value]);
  }
  return { set, removedOpencode: result.removedOpencode, removedCredentials: result.removedCredentials };
}

/**
 * Whether a variable never reaches the session (spec 8.1, amendment 12.12.4). Case is folded, so the
 * POSIX lower-case proxy spellings are covered too.
 * @param {string} name
 * @returns {boolean}
 */
export function isCredentialName(name) {
  return isNeverForwardedEnvName(name) !== null;
}

/**
 * @param {string[]} removedOpencode
 * @param {string[]} removedCredentials
 * @returns {string[]}
 */
function buildWarnings(removedOpencode, removedCredentials) {
  /** @type {string[]} */
  const warnings = [];
  const reported = removedOpencode.filter((name) => REPORTED_OPENCODE_VARIABLES.includes(name.toUpperCase()));
  for (const name of reported) {
    warnings.push(`${name} was set in this terminal and is not passed to the session; it would have changed the rules the session runs under`);
  }
  if (removedCredentials.length > 0) {
    warnings.push(`${removedCredentials.length} credential, backend or proxy variable(s) are not passed to the session: ${removedCredentials.join(', ')}`);
  }
  return warnings;
}

/**
 * Windows environment names are case-insensitive, so the lookup is too.
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {string | undefined}
 */
function readValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
