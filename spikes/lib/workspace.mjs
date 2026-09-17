// Builds one spike workspace: a sandboxed home (test/helpers/sandbox.mjs), a git-initialised fictional
// Unity project, a rendered profile directory with the instrumented plugin, and the clean-room launch
// environment from spec 8.1. External HTTP is pointed at a closed loopback port as a second fence.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLOSED_PORT_URL, createSandbox } from '../../test/helpers/sandbox.mjs';

const SPIKES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_FIXTURE_DIR = path.join(SPIKES_DIR, 'fixtures', 'spike-plugin');

export const MODEL_TAG = 'ocu-spike-model-16k';
export const PROVIDER_ID = 'opencode-unity';

/**
 * Minimal agent file for the code agent (no permission block; permissions come from config).
 */
export const UNITY_CODE_AGENT = `---
description: Unity C# coding with a local model (spike)
mode: primary
temperature: 0.7
top_p: 0.8
steps: 30
---
You are the spike code agent. Use exact tool names.
`;

/**
 * @param {object} options
 * @param {string} options.label
 * @param {Record<string, unknown>} [options.opencodeConfig]  Profile opencode.jsonc content.
 * @param {Record<string, string>} [options.agents]            File name (without .md) -> content.
 * @param {boolean} [options.withPlugin]
 * @param {Record<string, unknown>} [options.pluginConfig]
 */
export async function createWorkspace({ label, opencodeConfig = {}, agents = { 'unity-code': UNITY_CODE_AGENT }, withPlugin = true, pluginConfig = {} }) {
  const sandbox = await createSandbox(`spike-${label}`);
  const project = sandbox.path('project');
  const profile = sandbox.path('profile');
  const isolatedXdg = sandbox.path('ocu-home', 'xdg-config');
  const hookLog = sandbox.path('hooks.jsonl');
  const pluginConfigPath = sandbox.path('spike-plugin-config.json');
  await fs.mkdir(path.join(project, 'Assets', 'Scripts'), { recursive: true });
  await fs.mkdir(isolatedXdg, { recursive: true });
  await fs.writeFile(path.join(project, 'Assets', 'Scripts', 'Player.cs'), 'namespace Sample.Game\n{\n    public class Player { }\n}\n');
  // A git root with a commit gives OpenCode a real worktree, which stops its upward config search
  // inside the sandbox (without a commit the project id is "global").
  const gitIdentity = ['-c', 'user.name=spike', '-c', 'user.email=spike@example.invalid', '-c', 'commit.gpgsign=false'];
  for (const args of [['init', '-q'], ['add', '-A'], [...gitIdentity, 'commit', '-q', '-m', 'fixture']]) {
    const git = spawnSync('git', args, { cwd: project, env: sandbox.env, windowsHide: true, encoding: 'utf8' });
    if (git.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${git.stderr}`);
  }

  await fs.mkdir(path.join(profile, 'agents'), { recursive: true });
  await fs.writeFile(path.join(profile, 'opencode.jsonc'), JSON.stringify(opencodeConfig, null, 2));
  for (const [name, content] of Object.entries(agents)) {
    await fs.writeFile(path.join(profile, 'agents', `${name}.md`), content);
  }
  if (withPlugin) {
    await fs.cp(PLUGIN_FIXTURE_DIR, path.join(profile, 'plugins'), { recursive: true });
  }
  await fs.writeFile(pluginConfigPath, JSON.stringify(pluginConfig, null, 2));

  /**
   * Clean-room environment (spec 8.1) on top of the sandbox environment.
   * @param {Record<string, string | null>} [overrides]  null removes a variable.
   */
  const env = (overrides = {}) => {
    /** @type {Record<string, string>} */
    const result = {
      ...sandbox.env,
      XDG_CONFIG_HOME: isolatedXdg,
      OPENCODE_CONFIG_DIR: profile,
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_UNITY_ORIGINAL_XDG_CONFIG_HOME: sandbox.dirs.xdgConfig,
      OCU_SPIKE_CONFIG: pluginConfigPath,
      OCU_SPIKE_LOG: hookLog,
      // Second fence: any HTTP(S) request that is not loopback goes to a closed port.
      HTTP_PROXY: CLOSED_PORT_URL,
      HTTPS_PROXY: CLOSED_PORT_URL,
      http_proxy: CLOSED_PORT_URL,
      https_proxy: CLOSED_PORT_URL,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      OPENCODE_MODELS_URL: CLOSED_PORT_URL,
      // OpenCode background-installs @opencode-ai/plugin into every config dir and waits for it before
      // loading plugins. Against the closed registry port, npm's default retries take about 70 s
      // (spike H measures that); zero retries fail in well under a second.
      npm_config_fetch_retries: '0',
    };
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) delete result[name];
      else result[name] = value;
    }
    return result;
  };

  return {
    sandbox,
    project,
    profile,
    isolatedXdg,
    hookLog,
    pluginConfigPath,
    env,
    /** @param {Record<string, unknown>} next */
    setPluginConfig: (next) => fs.writeFile(pluginConfigPath, JSON.stringify(next, null, 2)),
    readHooks: () => readJsonl(hookLog),
    clearHooks: () => fs.rm(hookLog, { force: true }),
    /** @param {string} relative @param {string} content */
    writeProfileFile: async (relative, content) => {
      const target = path.join(profile, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    },
    cleanup: () => sandbox.cleanup(),
  };
}

/**
 * @param {string} file
 * @returns {any[]}
 */
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Plugin configuration that injects the provider pointing at a mock endpoint.
 * @param {string} baseURL
 * @param {Record<string, unknown>} [extra]
 */
export function providerPluginConfig(baseURL, extra = {}) {
  return {
    provider: { inject: true, id: PROVIDER_ID, baseURL, modelTag: MODEL_TAG, context: 16384, output: 4096 },
    ...extra,
  };
}

/**
 * Profile opencode.jsonc from spec 8.3, without a provider block (the plugin injects it).
 * @param {Record<string, unknown>} [extra]
 */
export function profileConfig(extra = {}) {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    lsp: false,
    enabled_providers: [PROVIDER_ID],
    model: `${PROVIDER_ID}/${MODEL_TAG}`,
    small_model: `${PROVIDER_ID}/${MODEL_TAG}`,
    default_agent: 'unity-code',
    compaction: { auto: true, prune: true },
    agent: { build: { disable: true }, plan: { disable: true }, title: { disable: true } },
    ...extra,
  };
}

/**
 * Mock Ollama with /api/ps, /api/version and /api/show for the guard probe path.
 * @param {object} [options]
 * @param {any[]} [options.models]
 */
export async function startMockOllama({ models = [] } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models }));
    if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.34.1' }));
    if (req.url === '/api/show') return res.end(JSON.stringify({ parameters: 'num_ctx 16384' }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    }),
  };
}
