// The environment adapter behind setup item 7 (spec 14.1). It is injectable for one reason: a test must
// never touch the real registry or the real `launchctl` domain, so every test passes a fake adapter and
// only this module knows the platform commands.
//
// Per platform (amendment 38.11 and CP-D15):
//   win32   user-scope registry values through `[Environment]::SetEnvironmentVariable(..., 'User')`
//   darwin  `launchctl setenv`, so the Ollama app inherits the value
//   linux   nothing is written at all; the values are printed for the user's own unit file
import path from 'node:path';
import { findExecutable, runProcess } from '../core/exec.js';

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_ENV_VALUE_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * @typedef {object} UserEnvAdapter
 * @property {'userEnv'|'launchctlEnv'|'print'} kind   The manifest kind this adapter records, or 'print'.
 * @property {string} scope                             One line naming the scope, for the consent detail.
 * @property {(name: string) => Promise<string | null>} read
 * @property {(name: string, value: string) => Promise<void>} write
 * @property {(name: string, previous: string | null) => Promise<void>} restore
 */

/**
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined>, timeoutMs?: number, run?: typeof runProcess, signal?: AbortSignal }} [options]
 * @returns {UserEnvAdapter}
 */
export function createUserEnvAdapter({ platform = process.platform, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, run = runProcess, signal } = {}) {
  if (platform === 'win32') return createWindowsUserEnvAdapter({ env, timeoutMs, run, signal });
  if (platform === 'darwin') return createLaunchctlAdapter({ env, timeoutMs, run, signal });
  return createPrintOnlyAdapter();
}

/**
 * Windows PowerShell 5.1 from its system directory, so a same-named program earlier on PATH cannot
 * answer for it. The executable suffix comes from PATHEXT through `findExecutable`, which is the one
 * place that knows what an executable extension is.
 * @param {{ env: Record<string, string | undefined>, isFile?: (candidate: string) => boolean }} options
 * @returns {string}
 */
export function resolveWindowsPowerShell({ env, isFile }) {
  const lookup = isFile ? { isFile } : {};
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (systemRoot) {
    const directory = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
    const found = findExecutable('powershell', { env: { PATH: directory, PATHEXT: env.PATHEXT }, platform: 'win32', ...lookup });
    if (found) return found;
  }
  return findExecutable('powershell', { env, platform: 'win32', ...lookup }) ?? 'powershell';
}

/**
 * @param {{ env: Record<string, string | undefined>, timeoutMs: number, run: typeof runProcess, signal?: AbortSignal, locate?: () => string }} options
 * @returns {UserEnvAdapter}
 */
export function createWindowsUserEnvAdapter({ env, timeoutMs, run, signal, locate = () => resolveWindowsPowerShell({ env }) }) {
  /**
   * @param {string} script
   * @returns {Promise<string>}
   */
  const invoke = async (script) => {
    const result = await run(locate(), ['-NoProfile', '-NonInteractive', '-Command', '-'], { timeoutMs, env, signal, input: script, platform: 'win32' });
    if (result.error) throw new Error(`Windows PowerShell could not be started (${result.error.message})`);
    if (result.timedOut) throw new Error(`Windows PowerShell did not answer within ${timeoutMs} ms`);
    if (result.exitCode !== 0) throw new Error(`Windows PowerShell exited ${result.exitCode}: ${firstLine(result.stderr) || firstLine(result.stdout)}`);
    return result.stdout;
  };
  return {
    kind: 'userEnv',
    scope: 'Windows user scope (not machine scope); it applies to new processes only',
    async read(name) {
      const output = await invoke(`[Console]::Out.Write((ConvertTo-Json -Compress ([Environment]::GetEnvironmentVariable(${quotePowerShell(assertEnvName(name))}, 'User'))))\n`);
      return parseJsonValue(output.trim(), name);
    },
    async write(name, value) {
      await invoke(`[Environment]::SetEnvironmentVariable(${quotePowerShell(assertEnvName(name))}, ${quotePowerShell(assertEnvValue(value))}, 'User')\n`);
    },
    async restore(name, previous) {
      const literal = previous === null ? '$null' : quotePowerShell(assertEnvValue(previous));
      await invoke(`[Environment]::SetEnvironmentVariable(${quotePowerShell(assertEnvName(name))}, ${literal}, 'User')\n`);
    },
  };
}

/**
 * @param {{ env: Record<string, string | undefined>, timeoutMs: number, run: typeof runProcess, signal?: AbortSignal }} options
 * @returns {UserEnvAdapter}
 */
export function createLaunchctlAdapter({ env, timeoutMs, run, signal }) {
  /**
   * @param {string[]} args
   * @returns {Promise<import('../core/exec.js').RunResult>}
   */
  const invoke = async (args) => {
    const result = await run('/bin/launchctl', args, { timeoutMs, env, signal, platform: 'darwin' });
    if (result.error) throw new Error(`launchctl could not be started (${result.error.message})`);
    if (result.timedOut) throw new Error(`launchctl did not answer within ${timeoutMs} ms`);
    return result;
  };
  return {
    kind: 'launchctlEnv',
    scope: 'the launchd user domain, so applications started after it inherit the value',
    async read(name) {
      const result = await invoke(['getenv', assertEnvName(name)]);
      // An unset variable prints nothing; launchctl does not distinguish it from an empty value, so an
      // empty answer is recorded as "was not set", which is also what restore has to do with it.
      if (result.exitCode !== 0) return null;
      const value = result.stdout.replace(/\n$/, '');
      return value === '' ? null : value;
    },
    async write(name, value) {
      const result = await invoke(['setenv', assertEnvName(name), assertEnvValue(value)]);
      if (result.exitCode !== 0) throw new Error(`launchctl setenv exited ${result.exitCode}: ${firstLine(result.stderr)}`);
    },
    async restore(name, previous) {
      const args = previous === null ? ['unsetenv', assertEnvName(name)] : ['setenv', assertEnvName(name), assertEnvValue(previous)];
      const result = await invoke(args);
      if (result.exitCode !== 0) throw new Error(`launchctl ${args[0]} exited ${result.exitCode}: ${firstLine(result.stderr)}`);
    },
  };
}

/**
 * Linux writes nothing (CP-D15): the Ollama service reads its environment from a unit file the package
 * manager owns, and editing another package's unit is not ours to do.
 * @returns {UserEnvAdapter}
 */
export function createPrintOnlyAdapter() {
  return {
    kind: 'print',
    scope: 'printed only; on Linux the values belong in your own Ollama unit override',
    read: async () => null,
    write: async () => {
      throw new TypeError('This platform never writes environment variables; the values are printed instead');
    },
    restore: async () => {},
  };
}

/**
 * The lines a user pastes into a systemd drop-in, or runs by hand. Printed, never executed.
 * @param {Record<string, string>} values
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
export function renderEnvInstructions(values, platform) {
  const entries = Object.entries(values);
  if (entries.length === 0) return [];
  if (platform === 'linux') {
    return [
      'sudo systemctl edit ollama, then add:',
      '  [Service]',
      ...entries.map(([name, value]) => `  Environment="${name}=${value}"`),
      'then: sudo systemctl daemon-reload && sudo systemctl restart ollama',
    ];
  }
  if (platform === 'darwin') return entries.map(([name, value]) => `launchctl setenv ${name} ${value}`);
  return entries.map(([name, value]) => `[Environment]::SetEnvironmentVariable('${name}', '${value}', 'User')`);
}

/**
 * @param {string} name
 * @returns {string}
 */
export function assertEnvName(name) {
  if (!ENV_NAME_PATTERN.test(name)) throw new TypeError(`'${name}' is not a usable environment variable name`);
  return name;
}

/**
 * Control characters are rejected rather than escaped: none of our values needs one, and a newline in a
 * value is the shape that turns one statement into two.
 * @param {string} value
 * @returns {string}
 */
export function assertEnvValue(value) {
  if (typeof value !== 'string') throw new TypeError('An environment value must be a string');
  if (value.length > MAX_ENV_VALUE_LENGTH) throw new TypeError(`An environment value may be at most ${MAX_ENV_VALUE_LENGTH} characters`);
  if ([...value].some((char) => isControlCharacter(char))) throw new TypeError('An environment value must not contain control characters');
  return value;
}

/**
 * C0 controls and DEL. Compared by number rather than written as an escaped character class, because an
 * escape that an editor or a tool turns into the raw byte silently takes the file out of the text scans.
 * @param {string} char
 * @returns {boolean}
 */
function isControlCharacter(char) {
  const code = /** @type {number} */ (char.codePointAt(0));
  return code < 0x20 || code === 0x7f;
}

/**
 * A PowerShell single-quoted string: the only escape inside one is a doubled quote, and nothing else
 * expands. `$`, backtick and `"` are literal there (amendment 33.7).
 * @param {string} value
 * @returns {string}
 */
export function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * @param {string} text
 * @param {string} name
 * @returns {string | null}
 */
function parseJsonValue(text, name) {
  if (text === '') return null;
  try {
    const value = JSON.parse(text);
    if (value === null) return null;
    if (typeof value === 'string') return value;
  } catch {
    throw new Error(`Reading the current value of ${name} produced output that is not JSON`);
  }
  throw new Error(`Reading the current value of ${name} produced an unexpected shape`);
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? '';
}
