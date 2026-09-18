// Builders for the session-command suite: a sandbox home with a rendered profile, a mock Ollama on
// loopback, guard probes that pass, a real Unity fixture on disk, and a CLI context - so a test drives
// `init`, `start`, `status`, `guard`, `warm` or `stop` in process, with no GPU and no OpenCode.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createConsent } from '../../../src/cli/consent.js';
import { createOutput } from '../../../src/cli/output.js';
import { createInterruptController } from '../../../src/cli/signals.js';
import { CLI_VERSION } from '../../../src/cli/version.js';
import { DEFAULT_CONFIG, DEFAULT_PRESET_ID } from '../../../src/core/config.js';
import { getHomePaths } from '../../../src/core/paths.js';
import { loadPreset } from '../../../src/core/presets.js';
import { buildRuntimeProfile, renderRuntimeProfile } from '../../../src/core/profile.js';
import { startMockOllama } from '../../../src/selftest/mock-ollama.js';
import { useSandbox } from '../../helpers/sandbox.mjs';
import { materializeFixtureProject } from '../unity/fixture-projects.mjs';

export const MODEL_TAG = 'ocu-qwen3-coder-30b-16k';
export const NUM_CTX = 16384;
export const NOW_MS = Date.parse('2026-09-18T09:30:00.000Z');
export const DEFAULT_FIXTURE = 'u6-urp-ugui-git';

/**
 * @typedef {object} CommandHarness
 * @property {import('../../helpers/sandbox.mjs').Sandbox} sandbox
 * @property {string} home
 * @property {ReturnType<typeof getHomePaths>} paths
 * @property {string} projectRoot
 * @property {string} ollamaUrl
 * @property {ReturnType<typeof import('../../../src/selftest/mock-ollama.js').createMockOllama>} ollama
 * @property {(command: string, input?: RunInput) => Promise<RunResult>} run
 * @property {(lines: string[]) => string[]} lines
 * @property {string[]} written
 */

/**
 * @typedef {object} RunInput
 * @property {Record<string, unknown>} [options]
 * @property {Record<string, string>} [args]
 * @property {Partial<import('../../../src/cli/args.js').GlobalOptions>} [global]
 * @property {Record<string, unknown>} [deps]
 * @property {boolean} [guardBlocked]
 * @property {Partial<import('../../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes>} [probes]
 * @property {string} [cwd]
 * @property {boolean} [json]
 * @property {AbortSignal} [signal]
 * @property {Record<string, string | undefined>} [env]   Applied on top of the sandbox environment.
 */

/**
 * @typedef {object} RunResult
 * @property {number} exitCode
 * @property {string | undefined} code
 * @property {string} message
 * @property {Record<string, any>} data
 * @property {string[]} warnings
 * @property {string[]} output    Human lines written by the command.
 * @property {Error & { exitCode?: number, code?: string, data?: any }} [error]
 */

/**
 * @param {import('node:test').TestContext} t
 * @param {{ config?: Record<string, unknown>, renderProfile?: boolean, loaded?: boolean, fixture?: string | null, ollama?: boolean }} [options]
 * @returns {Promise<CommandHarness>}
 */
export async function createCommandHarness(t, { config = {}, renderProfile = true, loaded = true, fixture = DEFAULT_FIXTURE, ollama = true } = {}) {
  const sandbox = await useSandbox(t, 'commands');
  /** @type {{ url: string, mock: any, close: () => Promise<void> } | null} */
  let server = null;
  if (ollama) {
    server = await startMockOllama({
      models: [{ name: `${MODEL_TAG}:latest`, parameters: { num_ctx: NUM_CTX } }],
      running: loaded ? [{ name: `${MODEL_TAG}:latest`, contextLength: NUM_CTX, keepAliveSec: 900 }] : [],
    });
    t.after(() => /** @type {any} */ (server).close());
  }
  // Nothing listens on the discard port, so a command that expects Ollama to be down really finds it down.
  const baseUrl = server?.url ?? 'http://127.0.0.1:9';

  const home = sandbox.productHome;
  const paths = getHomePaths(home);
  const userConfig = { schemaVersion: DEFAULT_CONFIG.schemaVersion, ollama: { baseUrl }, ...config };
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(paths.config, `${JSON.stringify(userConfig, null, 2)}\n`, 'utf8');
  if (renderProfile) {
    const built = buildRuntimeProfile({
      config: /** @type {any} */ ({ ...DEFAULT_CONFIG, ...userConfig, ollama: { ...DEFAULT_CONFIG.ollama, baseUrl } }),
      preset: loadPreset(DEFAULT_PRESET_ID),
      cliVersion: CLI_VERSION,
      home,
    });
    const profilePaths = paths.profile(CLI_VERSION);
    await fs.mkdir(profilePaths.dir, { recursive: true });
    await fs.writeFile(profilePaths.runtimeProfile, renderRuntimeProfile(built.profile), 'utf8');
    await fs.writeFile(profilePaths.opencodeConfig, '{}\n', 'utf8');
  }

  const projectRoot = fixture === null ? path.join(sandbox.root, 'plain') : materializeFixtureProject(fixture, path.join(sandbox.root, 'project'));
  await fs.mkdir(projectRoot, { recursive: true });

  return {
    sandbox,
    home,
    paths,
    projectRoot,
    ollamaUrl: baseUrl,
    ollama: server?.mock,
    written: [],
    lines: (values) => values,
    run: async (command, input = {}) => {
      const module = await import(`../../../src/commands/${command}.js`);
      /** @type {string[]} */
      const output = [];
      const cliContext = createCliContext({
        sandbox,
        cwd: input.cwd ?? projectRoot,
        command,
        options: input.options,
        args: input.args,
        global: input.global,
        json: input.json ?? false,
        sink: output,
        signal: input.signal,
        env: { ...sandbox.env, ...input.env },
      });
      const deps = { probes: createProbes({ blocked: input.guardBlocked, ...input.probes }), ...input.deps };
      try {
        const result = await module.run(cliContext, deps);
        return {
          exitCode: result?.exitCode ?? 0,
          code: result?.code,
          message: result?.message ?? '',
          data: result?.data ?? {},
          warnings: result?.warnings ?? [],
          output,
        };
      } catch (error) {
        const failure = /** @type {any} */ (error);
        return { exitCode: failure.exitCode ?? 7, code: failure.code, message: failure.message, data: failure.data ?? {}, warnings: [], output, error: failure };
      }
    },
  };
}

/**
 * @param {{ sandbox: import('../../helpers/sandbox.mjs').Sandbox, cwd: string, command: string, options?: Record<string, unknown>, args?: Record<string, string>, global?: Partial<import('../../../src/cli/args.js').GlobalOptions>, json?: boolean, sink?: string[], signal?: AbortSignal, env?: Record<string, string | undefined> }} input
 * @returns {import('../../../src/cli/main.js').CommandContext}
 */
export function createCliContext({ sandbox, cwd, command, options = {}, args = {}, global = {}, json = false, sink = [], signal = new AbortController().signal, env = sandbox.env }) {
  const stream = {
    write: (/** @type {string} */ text) => {
      for (const line of text.split('\n')) if (line !== '') sink.push(line);
      return true;
    },
  };
  /** @type {import('../../../src/cli/args.js').GlobalOptions} */
  const globalOptions = { json, yes: true, dryRun: false, project: undefined, experimental: false, verbose: false, noColor: true, ...global };
  return {
    command,
    subcommand: undefined,
    args,
    options: /** @type {any} */ (options),
    global: globalOptions,
    output: createOutput({ stdout: stream, stderr: stream, json }),
    consent: createConsent({ interactive: false, yes: globalOptions.yes, getInput: () => /** @type {any} */ ({}), prompts: stream }),
    interrupts: createInterruptController({ exit: () => {}, stderr: stream }),
    signal,
    env,
    cwd,
    platform: process.platform,
    version: CLI_VERSION,
  };
}

/**
 * Probes that pass with the model loaded at the preset context, so a test that is not about the guard
 * never needs a GPU. `blocked` returns the low-VRAM cold path instead.
 * @param {{ blocked?: boolean } & Partial<import('../../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes>} [overrides]
 * @returns {import('../../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes}
 */
export function createProbes({ blocked = false, ...overrides } = {}) {
  return {
    readOllamaPs: async () => ({
      ok: true,
      models: blocked
        ? []
        : [{ name: `${MODEL_TAG}:latest`, model: `${MODEL_TAG}:latest`, contextLength: NUM_CTX, expiresAt: new Date(NOW_MS + 900_000).toISOString(), sizeVramBytes: 18_500 * 1_048_576 }],
    }),
    readNvidiaSmi: async () => ({
      ok: true,
      gpuCount: 1,
      memory: { ok: true, totalMiB: 24_576, freeMiB: blocked ? 1000 : 22_000 },
      utilization: { ok: true, percent: 2 },
    }),
    processes: {
      platform: 'test',
      detect: async () => ({ ok: true, running: false, count: 0 }),
      sample: async () => ({ ok: true, processes: [], elapsedMs: 1500 }),
    },
    sleep: async () => {},
    now: () => NOW_MS,
    ...overrides,
  };
}

/**
 * A `runProcess` double: answers by the whole argument line, then by the first argument, and records
 * every call with the environment it was given.
 * @param {Record<string, Partial<import('../../../src/core/exec.js').RunResult> | (() => Partial<import('../../../src/core/exec.js').RunResult>)>} answers
 * @returns {{ run: import('../../../src/core/exec.js').runProcess, calls: Array<{ file: string, args: string[], env: Record<string, string | undefined> | undefined }> }}
 */
export function createRunner(answers) {
  /** @type {Array<{ file: string, args: string[], env: Record<string, string | undefined> | undefined }>} */
  const calls = [];
  const run = async (/** @type {string} */ file, /** @type {readonly string[]} */ args, /** @type {any} */ options) => {
    calls.push({ file, args: [...args], env: options?.env });
    const entry = answers[args.join(' ')] ?? answers[args[0] ?? ''] ?? answers['*'] ?? {};
    const answer = typeof entry === 'function' ? entry() : entry;
    return {
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      truncated: false,
      error: null,
      durationMs: 1,
      ...answer,
    };
  };
  return { run: /** @type {any} */ (run), calls };
}
