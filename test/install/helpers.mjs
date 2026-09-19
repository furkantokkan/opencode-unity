// Harness for the installer suites. Every run goes through the real CLI entry - args, consent, envelope,
// exit codes - with the outside world replaced: an in-memory Ollama, an in-memory environment adapter, a
// model installer that records commands instead of running them, and a two-file plugin so a profile
// render stays fast.
//
// Nothing here reaches a real Ollama server, a real registry, the Windows registry or launchd.
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { parseEnvelope } from '../../src/cli/envelope.js';
import { main } from '../../src/cli/main.js';
import { loadCommandModule } from '../../src/cli/registry.js';
import { CLI_VERSION } from '../../src/cli/version.js';
import { getHomePaths } from '../../src/core/paths.js';
import { mergeEnv, useSandbox } from '../helpers/sandbox.mjs';

export const PRESET_ID = 'nvidia-24gb-qwen3-coder-30b-16k';
export const BASE_MODEL = 'qwen3-coder:30b';
export const MODEL_TAG = 'ocu-qwen3-coder-30b-16k';

/** A two-file stand-in for plugin/, so a profile render writes four files rather than twenty. */
export const PLUGIN_FILES = Object.freeze({
  'opencode-unity.js': Buffer.from('export default { id: "test" };\n', 'utf8'),
  'opencode-unity-lib/toast.js': Buffer.from('export const toast = 1;\n', 'utf8'),
});

/**
 * The platform row a test is about. It defaults to the full-tier reference row (win32, NVIDIA) rather
 * than the host, so a suite that means the full row asserts the same outcome on every CI leg; a test
 * about another row names it with `{ os }`. The filesystem the harness writes to is still the host's.
 * @param {{ os?: NodeJS.Platform, backend?: import('../../src/core/platform.js').AcceleratorBackend, virtualization?: import('../../src/core/platform.js').Virtualization, arch?: string }} [overrides]
 * @returns {import('../../src/core/platform.js').PlatformFacts}
 */
export function platformFacts(overrides = {}) {
  const os = overrides.os ?? 'win32';
  return {
    os,
    arch: overrides.arch ?? 'x64',
    release: '0.0.0',
    osVersionSupported: true,
    virtualization: overrides.virtualization ?? null,
    virtualizationSignals: [],
    shellFamily: os === 'win32' ? 'powershell' : 'posix',
    backend: overrides.backend ?? 'nvidia-smi',
  };
}

/**
 * @param {{ models?: string[], opencode?: 'missing'|'tested'|'other'|'unreadable', ollama?: 'down'|'tested'|'older'|'newer', totalVramMiB?: number | null, windowsTerminal?: boolean }} [overrides]
 * @returns {import('../../src/install/preflight.js').PreflightFacts}
 */
export function preflightFacts(overrides = {}) {
  const models = overrides.models ?? [BASE_MODEL];
  return {
    node: '22.11.0',
    opencode: { state: overrides.opencode ?? 'tested', version: overrides.opencode === 'missing' || overrides.opencode === 'unreadable' ? null : overrides.opencode === 'other' ? '1.17.0' : '1.18.31', tested: '1.18.31' },
    ollama: { state: overrides.ollama ?? 'tested', version: overrides.ollama === 'down' ? null : '0.34.1', tested: '0.34.1' },
    gpu: { name: 'Test GPU', totalVramMiB: overrides.totalVramMiB === undefined ? 24576 : overrides.totalVramMiB },
    models,
    windowsTerminal: overrides.windowsTerminal ?? false,
    powershell7: true,
    dotnetSdk: true,
  };
}

/**
 * @param {{ version?: string, models?: string[] }} [options]
 */
export function createFakeOllama({ version = '0.34.1', models = [BASE_MODEL] } = {}) {
  /** @type {string[]} */
  const calls = [];
  const installed = new Set(models);
  return {
    baseUrl: 'http://127.0.0.1:11434',
    calls,
    installed,
    async getVersion() {
      calls.push('/api/version');
      return version;
    },
    async listModels() {
      calls.push('/api/tags');
      return [...installed].map((name) => ({ name, model: name, sizeBytes: null, digest: null, modifiedAt: null, details: {} }));
    },
    async showModel() {
      calls.push('/api/show');
      return null;
    },
    async listRunning() {
      calls.push('/api/ps');
      return [];
    },
    async unload() {
      throw new Error('a test must never unload a model');
    },
  };
}

/**
 * @param {Record<string, string>} [initial]
 * @returns {import('../../src/install/user-env.js').UserEnvAdapter & { values: Map<string, string>, writes: string[] }}
 */
export function createFakeUserEnv(initial = {}) {
  const values = new Map(Object.entries(initial));
  /** @type {string[]} */
  const writes = [];
  return {
    kind: 'userEnv',
    scope: 'a test environment',
    values,
    writes,
    async read(name) {
      return values.has(name) ? /** @type {string} */ (values.get(name)) : null;
    },
    async write(name, value) {
      writes.push(`set ${name}=${value}`);
      values.set(name, value);
    },
    async restore(name, previous) {
      writes.push(`restore ${name}=${previous ?? '<removed>'}`);
      if (previous === null) values.delete(name);
      else values.set(name, previous);
    },
  };
}

/**
 * @param {{ installed?: Set<string>, failOn?: string }} [options]
 */
export function createFakeModels({ installed = new Set(), failOn } = {}) {
  /** @type {string[]} */
  const commands = [];
  return {
    commands,
    installed,
    async pull(model) {
      commands.push(`pull ${model}`);
      if (failOn === `pull ${model}`) throw new Error('pull failed');
      installed.add(model);
    },
    async create(tag, modelfilePath) {
      commands.push(`create ${tag}`);
      if (failOn === `create ${tag}`) throw new Error('create failed');
      await fs.access(modelfilePath);
      installed.add(tag);
    },
    async remove(name) {
      commands.push(`rm ${name}`);
      if (failOn === `rm ${name}`) throw new Error('remove failed');
      installed.delete(name);
    },
  };
}

/**
 * @param {{ fail?: boolean }} [options]
 */
export function createFakeNpm({ fail = false } = {}) {
  /** @type {string[]} */
  const commands = [];
  return {
    commands,
    async installGlobal(name, version) {
      commands.push(`install -g ${name}@${version}`);
      if (fail) throw new Error('npm failed');
    },
  };
}

/**
 * @typedef {object} HarnessOptions
 * @property {import('../../src/core/platform.js').PlatformFacts} [facts]
 * @property {import('../../src/install/preflight.js').PreflightFacts} [preflight]
 * @property {Record<string, Uint8Array>} [pluginFiles]
 * @property {ReturnType<typeof createFakeUserEnv>} [userEnv]
 * @property {ReturnType<typeof createFakeModels>} [models]
 * @property {ReturnType<typeof createFakeNpm>} [npm]
 * @property {ReturnType<typeof createFakeOllama>} [ollamaClient]
 * @property {import('../../src/install/apply.js').ApplyIo['onOperation']} [onOperation]
 * @property {string} [label]
 */

/**
 * @param {import('node:test').TestContext} t
 * @param {HarnessOptions} [options]
 */
export async function createHarness(t, options = {}) {
  const sandbox = await useSandbox(t, options.label ?? 'install');
  const home = sandbox.productHome;
  const paths = getHomePaths(home, { platform: process.platform });
  const ollamaClient = options.ollamaClient ?? createFakeOllama();
  const models = options.models ?? createFakeModels({ installed: ollamaClient.installed });
  const state = {
    sandbox,
    home,
    paths,
    ollamaClient,
    models,
    npm: options.npm ?? createFakeNpm(),
    userEnv: options.userEnv ?? createFakeUserEnv(),
    facts: options.facts ?? platformFacts(),
    /** @type {import('../../src/install/preflight.js').PreflightFacts | undefined} Fixed facts; otherwise read per run. */
    preflight: options.preflight,
    pluginFiles: options.pluginFiles ?? PLUGIN_FILES,
    onOperation: options.onOperation,
    version: CLI_VERSION,
    /**
     * @param {readonly string[]} argv
     * @param {{ input?: string, interactive?: boolean, dependencies?: Record<string, unknown>, env?: Record<string, string> }} [runOptions]
     */
    async run(argv, runOptions = {}) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const outChunks = [];
      const errChunks = [];
      stdout.on('data', (chunk) => outChunks.push(chunk));
      stderr.on('data', (chunk) => errChunks.push(chunk));
      const stdin = new PassThrough();
      if (runOptions.input !== undefined) stdin.end(runOptions.input);
      else stdin.end('');
      const dependencies = {
        homedir: sandbox.dirs.home,
        ollamaClient,
        // Read per run, so a model created by the previous run is seen by the next one.
        preflight: state.preflight ?? preflightFacts({ models: [...ollamaClient.installed] }),
        userEnv: state.userEnv,
        models: state.models,
        npm: state.npm,
        platformFacts: state.facts,
        pluginFiles: state.pluginFiles,
        onOperation: state.onOperation,
        ...runOptions.dependencies,
      };
      const exitCode = await main(['--json', ...argv], {
        stdout,
        stderr,
        stdin,
        interactive: runOptions.interactive ?? false,
        env: /** @type {Record<string, string>} */ (mergeEnv({ ...sandbox.env, OPENCODE_UNITY_HOME: home }, runOptions.env)),
        cwd: sandbox.root,
        platform: process.platform,
        platformFacts: state.facts,
        loadCommand: async (command) => {
          const module = await loadCommandModule(command);
          return { run: (context) => module.run(context, dependencies) };
        },
      });
      const out = Buffer.concat(outChunks).toString('utf8');
      return { exitCode, envelope: parseEnvelope(out.split('\n').filter(Boolean).at(-1) ?? '{}'), stdout: out, stderr: Buffer.concat(errChunks).toString('utf8') };
    },
  };
  return state;
}

/**
 * @param {string} root
 * @returns {Promise<string[]>} POSIX-separated relative paths, sorted.
 */
export async function listTree(root) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} directory */
  async function walk(directory) {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        found.push(`${relative}/`);
        await walk(absolute);
      } else {
        found.push(relative);
      }
    }
  }
  await walk(root);
  return found.sort();
}

/**
 * @param {string} manifestPath
 * @returns {Promise<import('../../src/install/manifest.js').Manifest>}
 */
export async function readManifestFile(manifestPath) {
  return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
}
