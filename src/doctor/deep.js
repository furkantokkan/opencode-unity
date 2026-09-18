// `doctor --deep` (spec 5.4, D20): the merged configuration and the resolved agent, from OpenCode
// itself rather than from the files doctor can read.
//
// This is the only mode in which default `doctor` starts more than `opencode --version`, and it costs
// something: every OpenCode start writes `.gitignore` files and background-installs `@opencode-ai/plugin`
// into its configuration directories, including a project's `.opencode` folder. The command prints that
// sentence and asks before calling in here.
import { runProcess } from '../core/exec.js';

/** `debug agent` resolves the default model, which can wait on a provider lookup (spec 8.2 V-a). */
export const DEEP_TIMEOUT_MS = 60_000;

export const DEEP_AGENTS = Object.freeze(['unity-code']);

/**
 * @typedef {object} DeepProbe
 * @property {string} label
 * @property {readonly string[]} args
 * @property {number | null} exitCode
 * @property {Record<string, any> | null} value
 * @property {string | null} error
 */

/**
 * @typedef {object} DeepResult
 * @property {DeepProbe} config
 * @property {DeepProbe[]} agents
 * @property {boolean} ok            Every probe returned a parsed object.
 */

/**
 * @param {object} input
 * @param {import('./opencode-binary.js').OpencodeBinary} input.binary
 * @param {Record<string, string | undefined>} input.env
 * @param {NodeJS.Platform} input.platform
 * @param {string} [input.cwd]
 * @param {readonly string[]} [input.agents]
 * @param {AbortSignal} [input.signal]
 * @param {typeof runProcess} [input.run]
 * @returns {Promise<DeepResult>}
 */
export async function runDeepProbes({ binary, env, platform, cwd, agents = DEEP_AGENTS, signal, run = runProcess }) {
  if (binary.path === null) {
    const missing = failed('debug config', ['debug', 'config'], 'the opencode binary was not found');
    return { config: missing, agents: agents.map((agent) => failed(`debug agent ${agent}`, ['debug', 'agent', agent], 'the opencode binary was not found')), ok: false };
  }
  const config = await probe({ binary: binary.path, label: 'debug config', args: ['debug', 'config'], env, platform, cwd, signal, run });
  /** @type {DeepProbe[]} */
  const agentProbes = [];
  for (const agent of agents) {
    agentProbes.push(await probe({ binary: binary.path, label: `debug agent ${agent}`, args: ['debug', 'agent', agent], env, platform, cwd, signal, run }));
  }
  return { config, agents: agentProbes, ok: config.value !== null && agentProbes.every((entry) => entry.value !== null) };
}

/**
 * @param {object} input
 * @param {string} input.binary
 * @param {string} input.label
 * @param {readonly string[]} input.args
 * @param {Record<string, string | undefined>} input.env
 * @param {NodeJS.Platform} input.platform
 * @param {string} [input.cwd]
 * @param {AbortSignal} [input.signal]
 * @param {typeof runProcess} input.run
 * @returns {Promise<DeepProbe>}
 */
async function probe({ binary, label, args, env, platform, cwd, signal, run }) {
  const result = await run(binary, [...args], { timeoutMs: DEEP_TIMEOUT_MS, env, platform, cwd, signal });
  if (result.error !== null) return failed(label, args, result.error.message);
  if (result.timedOut) return { ...failed(label, args, `'${label}' timed out`), exitCode: null };
  if (result.exitCode !== 0) return { ...failed(label, args, firstLine(result.stderr) || `exited ${result.exitCode}`), exitCode: result.exitCode };
  const value = parseJsonObject(result.stdout);
  if (value === null) return { ...failed(label, args, 'the output was not a JSON object'), exitCode: result.exitCode };
  return { label, args: [...args], exitCode: result.exitCode, value, error: null };
}

/**
 * OpenCode prints the JSON document on stdout; a wrapper line before it is tolerated by starting at the
 * first brace, because a version that adds a banner should not turn into "unparseable".
 * @param {string} text
 * @returns {Record<string, any> | null}
 */
export function parseJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  try {
    const value = JSON.parse(text.slice(start));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} label
 * @param {readonly string[]} args
 * @param {string} error
 * @returns {DeepProbe}
 */
function failed(label, args, error) {
  return { label, args: [...args], exitCode: null, value: null, error };
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? '';
}
