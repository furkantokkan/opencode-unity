// Runs the shipped profile and plugin inside the real OpenCode binary. All homes and projects are
// temporary; Ollama is a loopback mock and the interactive TUI is intercepted after verification.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CLI_VERSION } from '../../src/cli/version.js';
import { loadConfig } from '../../src/core/config.js';
import { runProcess } from '../../src/core/exec.js';
import { loadPreset } from '../../src/core/presets.js';
import { buildRuntimeProfile, loadCompat } from '../../src/core/profile.js';
import { renderProfileFiles } from '../../src/install/profile.js';
import { BINARY_ENV_NAME } from '../../src/opencode/locate.js';
import { assertSafeEnv, CLOSED_PORT_URL, mergeEnv } from '../helpers/sandbox.mjs';
import { createCommandHarness, createRunner } from '../unit/commands/helpers.mjs';

const BINARY = process.env.OPENCODE_UNITY_TEST_OPENCODE;
const EXPECTED_VERSION = process.env.OPENCODE_UNITY_TEST_VERSION ?? loadCompat().opencode.tested;

async function prepare(t) {
  assert.ok(BINARY, 'Set OPENCODE_UNITY_TEST_OPENCODE to the real OpenCode executable; contract tests must not silently skip.');
  await fs.access(BINARY);
  const harness = await createCommandHarness(t);
  const { config, user } = await loadConfig(harness.paths.config);
  const { profile } = buildRuntimeProfile({ config, userConfig: user, preset: loadPreset(config.preset), cliVersion: CLI_VERSION, home: harness.home });
  const profileDir = harness.paths.profile(CLI_VERSION).dir;
  const assets = await renderProfileFiles({ profile, config, cliVersion: CLI_VERSION });
  for (const [relative, content] of Object.entries(assets)) {
    const target = path.join(profileDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  const init = await harness.run('init', { deps: { run: createRunner({}).run } });
  assert.equal(init.exitCode, 0, init.message);
  const calls = [];
  const launched = [];
  const run = async (file, args, options) => {
    assert.equal(file, BINARY, 'verification must use the real OpenCode executable');
    const env = mergeEnv(options.env, {
      npm_config_fetch_retries: '0',
      HTTP_PROXY: CLOSED_PORT_URL,
      HTTPS_PROXY: CLOSED_PORT_URL,
      NO_PROXY: '127.0.0.1,localhost',
      OPENCODE_MODELS_URL: CLOSED_PORT_URL,
    });
    assertSafeEnv(env);
    const result = await runProcess(file, args, { ...options, env });
    calls.push({ args, result });
    const artifactDir = process.env.OPENCODE_UNITY_TEST_ARTIFACTS;
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      const name = `${t.name.replace(/[^a-z0-9]+/gi, '-')}-${calls.length}.json`;
      await fs.writeFile(path.join(artifactDir, name), JSON.stringify({ args, ...result }, null, 2));
    }
    if (args[0] === '--version') assert.equal(result.stdout.trim(), EXPECTED_VERSION, result.stderr);
    return result;
  };
  return {
    harness, profileDir, calls, launched,
    start: () => harness.run('start', {
      options: { noPane: true },
      global: { experimental: EXPECTED_VERSION !== loadCompat().opencode.tested },
      env: { [BINARY_ENV_NAME]: BINARY },
      deps: { run, sleep: async () => {}, spawnChild: async (options) => { launched.push(options); return { exitCode: 0, signal: null }; } },
    }),
  };
}

describe('real OpenCode contract', { timeout: 180_000 }, () => {
  it('enforces shell network asks and refuses a project override to allow', async (t) => {
    const ready = await prepare(t);
    const config = JSON.parse(await fs.readFile(ready.harness.paths.config, 'utf8'));
    config.network = { bash: 'ask' };
    await fs.writeFile(ready.harness.paths.config, JSON.stringify(config));
    const valid = await ready.start();
    assert.equal(valid.exitCode, 0, valid.message);
    await fs.writeFile(path.join(ready.harness.projectRoot, 'opencode.json'), JSON.stringify({ agent: { 'unity-code': { permission: { bash: { 'curl example.test': 'allow' } } } } }));
    const invalid = await ready.start();
    assert.equal(invalid.exitCode, 4, invalid.message);
    assert.match(invalid.message, /bash permissions/);
    assert.equal(ready.launched.length, 1);
  });
  it('refuses network tool permissions widened by a project', async (t) => {
    const ready = await prepare(t);
    await fs.writeFile(path.join(ready.harness.projectRoot, 'opencode.json'), JSON.stringify({ agent: { 'unity-code': { permission: { unitynet: { 'GET https://unlisted.example/*': 'allow' } } } } }));
    const result = await ready.start();
    assert.equal(result.exitCode, 4, result.message);
    assert.equal(ready.launched.length, 0);
  });
  it('resolves the shipped provider, agent and permissions before allowing a session', async (t) => {
    const ready = await prepare(t);
    const result = await ready.start();
    assert.equal(result.exitCode, 0, JSON.stringify({ message: result.message, data: result.data, calls: ready.calls }));
    assert.equal(ready.launched.length, 1);
    assert.ok(ready.calls.some(({ args }) => args.join(' ') === 'debug agent unity-code'));
    assert.ok(ready.calls.some(({ args }) => args.join(' ') === 'debug config'));
    assert.deepEqual(ready.harness.ollama.loadRequests, [], 'verification must never load a model');
  });

  it('keeps sharing disabled when a project requests automatic sharing', async (t) => {
    const ready = await prepare(t);
    await fs.writeFile(path.join(ready.harness.projectRoot, 'opencode.json'), JSON.stringify({ share: 'auto' }));
    const result = await ready.start();
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(ready.launched.length, 1);
    const probe = ready.calls.find(({ args }) => args.join(' ') === 'debug config');
    assert.equal(JSON.parse(probe.result.stdout).share, 'disabled');
    assert.deepEqual(ready.harness.ollama.loadRequests, []);
  });

  it('refuses a missing plugin instead of starting with an unguarded provider', async (t) => {
    const ready = await prepare(t);
    await fs.rm(path.join(ready.profileDir, 'plugins', 'opencode-unity.js'));
    const result = await ready.start();
    assert.equal(result.code, 'effective_config_rejected', JSON.stringify(result));
    assert.equal(result.exitCode, 4);
    assert.equal(ready.launched.length, 0);
    assert.deepEqual(ready.harness.ollama.loadRequests, []);
  });

  it('refuses a project plugin outside the managed profile', async (t) => {
    const ready = await prepare(t);
    const pluginDir = path.join(ready.harness.projectRoot, '.opencode', 'plugins');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'foreign.js'), 'export const ForeignPlugin = async () => ({});\n');
    const result = await ready.start();
    assert.equal(result.code, 'effective_config_rejected', JSON.stringify(result));
    assert.equal(result.exitCode, 4);
    assert.equal(ready.launched.length, 0);
    assert.match(JSON.stringify(result.data), /foreign\.js/);
    assert.deepEqual(ready.harness.ollama.loadRequests, []);
  });
});
