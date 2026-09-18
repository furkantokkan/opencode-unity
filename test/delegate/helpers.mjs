// Builders for the delegate suite: a sandbox home with a rendered profile, a mock Ollama on loopback,
// guard probes that pass, and a CLI context, so a test drives one lane in process without a child.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createConsent } from '../../src/cli/consent.js';
import { createOutput } from '../../src/cli/output.js';
import { createInterruptController } from '../../src/cli/signals.js';
import { CLI_VERSION } from '../../src/cli/version.js';
import { DEFAULT_CONFIG, DEFAULT_PRESET_ID } from '../../src/core/config.js';
import { getHomePaths } from '../../src/core/paths.js';
import { loadPreset } from '../../src/core/presets.js';
import { buildRuntimeProfile, renderRuntimeProfile } from '../../src/core/profile.js';
import { startMockOllama } from '../../src/selftest/mock-ollama.js';
import { useSandbox } from '../helpers/sandbox.mjs';

export const MODEL_TAG = 'ocu-qwen3-coder-30b-16k';
export const NUM_CTX = 16384;
export const NOW_MS = Date.parse('2026-09-18T09:30:00.000Z');

/**
 * @typedef {object} DelegateHarness
 * @property {import('../helpers/sandbox.mjs').Sandbox} sandbox
 * @property {string} home
 * @property {ReturnType<typeof getHomePaths>} paths
 * @property {string} cwd                       Working directory the files live in.
 * @property {ReturnType<typeof import('../../src/selftest/mock-ollama.js').createMockOllama>} ollama
 * @property {string} ollamaUrl
 * @property {(subcommand: string, input?: RunInput) => Promise<RunResult>} run
 * @property {(relativePath: string, content: string) => Promise<string>} writeFile
 * @property {(relativePath: string) => Promise<string>} readFile
 */

/**
 * @typedef {object} RunInput
 * @property {Record<string, unknown>} [options]
 * @property {Record<string, string>} [args]
 * @property {boolean} [guardBlocked]
 * @property {Partial<import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes>} [probes]
 * @property {() => number} [now]
 */

/**
 * @typedef {object} RunResult
 * @property {number} exitCode
 * @property {string | undefined} code
 * @property {string} message
 * @property {Record<string, any>} data
 * @property {string[]} warnings
 * @property {Error & { exitCode?: number, code?: string, data?: any }} [error]
 */

/**
 * @param {import('node:test').TestContext} t
 * @param {{ config?: Record<string, unknown>, renderProfile?: boolean, models?: Array<string | object>, loaded?: boolean }} [options]
 * @returns {Promise<DelegateHarness>}
 */
export async function createHarness(t, { config = {}, renderProfile = true, models, loaded = true } = {}) {
  const sandbox = await useSandbox(t, 'delegate');
  const server = await startMockOllama({
    models: models ?? [{ name: `${MODEL_TAG}:latest`, parameters: { num_ctx: NUM_CTX, temperature: 0.7, top_p: 0.8, top_k: 20, repeat_penalty: 1.05 } }],
    running: loaded ? [{ name: `${MODEL_TAG}:latest`, contextLength: NUM_CTX, keepAliveSec: 900 }] : [],
  });
  t.after(() => server.close());

  const home = sandbox.productHome;
  const paths = getHomePaths(home);
  const userConfig = { schemaVersion: DEFAULT_CONFIG.schemaVersion, ollama: { baseUrl: server.url }, ...config };
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(paths.config, `${JSON.stringify(userConfig, null, 2)}\n`, 'utf8');
  if (renderProfile) {
    const built = buildRuntimeProfile({
      config: /** @type {any} */ ({ ...DEFAULT_CONFIG, ...userConfig, ollama: { ...DEFAULT_CONFIG.ollama, baseUrl: server.url } }),
      preset: loadPreset(DEFAULT_PRESET_ID),
      cliVersion: CLI_VERSION,
      home,
    });
    const profilePaths = paths.profile(CLI_VERSION);
    await fs.mkdir(profilePaths.dir, { recursive: true });
    await fs.writeFile(profilePaths.runtimeProfile, renderRuntimeProfile(built.profile), 'utf8');
  }

  const cwd = path.join(sandbox.root, 'work');
  await fs.mkdir(cwd, { recursive: true });

  let jobCounter = 0;
  return {
    sandbox,
    home,
    paths,
    cwd,
    ollama: server.mock,
    ollamaUrl: server.url,
    writeFile: async (relativePath, content) => {
      const target = path.join(cwd, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      return target;
    },
    readFile: (relativePath) => fs.readFile(path.join(cwd, relativePath), 'utf8'),
    run: async (subcommand, input = {}) => {
      const { run } = await import('../../src/commands/delegate.js');
      const cliContext = createCliContext({ sandbox, cwd, subcommand, options: input.options, args: input.args });
      jobCounter += 1;
      const counter = jobCounter;
      try {
        const result = await run(cliContext, {
          probes: createProbes({ blocked: input.guardBlocked, ...input.probes }),
          now: input.now ?? (() => NOW_MS),
          randomHex: () => String(counter).padStart(6, '0'),
        });
        return {
          exitCode: result?.exitCode ?? 0,
          code: result?.code,
          message: result?.message ?? '',
          data: result?.data ?? {},
          warnings: result?.warnings ?? [],
        };
      } catch (error) {
        const failure = /** @type {any} */ (error);
        return { exitCode: failure.exitCode ?? 7, code: failure.code, message: failure.message, data: failure.data ?? {}, warnings: [], error: failure };
      }
    },
  };
}

/**
 * @param {{ sandbox: import('../helpers/sandbox.mjs').Sandbox, cwd: string, subcommand: string, options?: Record<string, unknown>, args?: Record<string, string> }} input
 * @returns {import('../../src/cli/main.js').CommandContext}
 */
export function createCliContext({ sandbox, cwd, subcommand, options = {}, args = {} }) {
  const sink = { write: () => true };
  return {
    command: `delegate ${subcommand}`,
    subcommand,
    args,
    options: /** @type {any} */ (options),
    global: { json: true, yes: true, dryRun: false, project: undefined, experimental: false, verbose: false, noColor: true },
    output: createOutput({ stdout: sink, stderr: sink, json: true }),
    consent: createConsent({ interactive: false, yes: true, getInput: () => /** @type {any} */ ({}), prompts: sink }),
    interrupts: createInterruptController({ exit: () => {}, stderr: sink }),
    signal: new AbortController().signal,
    env: sandbox.env,
    cwd,
    platform: process.platform,
    version: CLI_VERSION,
  };
}

/**
 * Probes that pass with the model loaded at the preset context, so a test that is not about the guard
 * never needs a GPU. `blocked` returns the low-VRAM cold path instead.
 * @param {{ blocked?: boolean } & Partial<import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes>} [overrides]
 * @returns {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes}
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
 * The answer text of a mock reply, in the shape `enqueueChat` takes.
 * @param {string} content
 * @param {{ promptTokens?: number, outputTokens?: number, doneReason?: string }} [usage]
 * @returns {import('../../src/selftest/mock-ollama.js').ChatReply}
 */
export function reply(content, usage = {}) {
  return { content, promptTokens: usage.promptTokens ?? 120, outputTokens: usage.outputTokens ?? 40, doneReason: usage.doneReason ?? 'stop' };
}

/**
 * @param {string} file
 * @param {string} search
 * @param {string} replace
 * @returns {string}
 */
export function editBlock(file, search, replace) {
  return `FILE: ${file}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
}
