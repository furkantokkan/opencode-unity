// The environment agent shell commands run in (spec 8.7 `shell.env`, 8.1, P7).
//
// `start` points XDG_CONFIG_HOME at the isolated profile so the user's own OpenCode config cannot
// reach the session. That isolation is for OpenCode, not for `dotnet`, `npm` or anything else the
// agent runs, so the original value is restored here from the variable `start` recorded. .NET
// telemetry is opted out of in the same place, because the product never phones home on a user's
// behalf (P1, P7).
export const ORIGINAL_XDG_ENV = 'OPENCODE_UNITY_ORIGINAL_XDG_CONFIG_HOME';

/** What `start` records when XDG_CONFIG_HOME was not set at all. */
export const UNSET_MARKER = '__unset__';

/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]   The plugin process environment.
 * @param {string | null} [options.userHome]                   Home directory, for the XDG default.
 * @returns {Record<string, string>} The values to merge into the shell environment.
 */
export function buildShellEnv({ env = process.env, userHome = null } = {}) {
  /** @type {Record<string, string>} */
  const out = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
  const xdg = resolveXdgConfigHome(env, userHome);
  if (xdg) out.XDG_CONFIG_HOME = xdg;
  return out;
}

/**
 * Merges the shell values into the hook's output object in place.
 * @param {Record<string, string>} target
 * @param {{ env?: Record<string, string | undefined>, userHome?: string | null }} [options]
 * @returns {Record<string, string>} The same object.
 */
export function applyShellEnv(target, options = {}) {
  for (const [name, value] of Object.entries(buildShellEnv(options))) target[name] = value;
  return target;
}

/**
 * The value the shell should see: what the user had, or `<user home>/.config` when they had none.
 * Null means "leave whatever OpenCode set", which is what happens when neither is known.
 * @param {Record<string, string | undefined>} env
 * @param {string | null} userHome
 * @returns {string | null}
 */
export function resolveXdgConfigHome(env, userHome) {
  const recorded = env[ORIGINAL_XDG_ENV];
  if (typeof recorded === 'string' && recorded.length > 0 && recorded !== UNSET_MARKER) return recorded;
  if (recorded === undefined) return null;
  // Recorded as unset: the platform default, spelled with the separator the shell expects.
  const home = userHome ?? env.USERPROFILE ?? env.HOME ?? null;
  if (!home) return null;
  const separator = home.includes('\\') && !home.includes('/') ? '\\' : '/';
  return `${home.replace(/[\\/]+$/, '')}${separator}.config`;
}
