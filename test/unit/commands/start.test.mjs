import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ATTENTION_PAUSE_MS, buildOpencodeArgs, OLLAMA_START_TIMEOUT_MS, spawnOpencode, startDetached } from '../../../src/commands/start.js';
import { createInterruptController } from '../../../src/cli/signals.js';
import { CLI_VERSION } from '../../../src/cli/version.js';
import { diffSnapshots, snapshotTree } from '../../helpers/fixture-fs.mjs';
import { useSandbox } from '../../helpers/sandbox.mjs';
import { loadCompat } from '../../../src/core/profile.js';
import { BINARY_ENV_NAME } from '../../../src/opencode/locate.js';
import { buildUnityCodePermission } from '../../../src/opencode/render.js';
import { createCommandHarness, createRunner, MODEL_TAG, NOW_MS } from './helpers.mjs';

const TESTED_OPENCODE = loadCompat().opencode.tested;
/** The hub MCP for Unity's configurator records; it is only read, never contacted. */
const HUB_URL = 'http://127.0.0.1:8090/mcp';

/** @type {Array<[string, import('./helpers.mjs').RunInput]>} The two flags that promise to write nothing. */
const WRITE_FREE_RUNS = [
  ['--print-env', { options: { printEnv: true } }],
  ['--dry-run', { global: { dryRun: true } }],
];

/**
 * Content and modification time of every entry below `root`: a rewrite with the same bytes, or a file
 * created and removed again, changes a time even when it leaves the content as it was.
 * @param {string} root
 * @returns {Promise<{ tree: Awaited<ReturnType<typeof snapshotTree>>, times: Record<string, number> }>}
 */
async function snapshotWithTimes(root) {
  const tree = await snapshotTree(root);
  /** @type {Record<string, number>} */
  const times = { '.': (await fs.stat(root)).mtimeMs };
  for (const key of Object.keys(tree)) times[key] = (await fs.stat(path.join(root, ...key.split('/')))).mtimeMs;
  return { tree, times };
}

/**
 * The product home, the project, and the whole sandbox around them (user home, XDG directories, temp).
 * @param {import('./helpers.mjs').CommandHarness} harness
 */
async function snapshotEverything(harness) {
  return {
    'product home': await snapshotWithTimes(harness.home),
    project: await snapshotWithTimes(harness.projectRoot),
    sandbox: await snapshotWithTimes(harness.sandbox.root),
  };
}

/**
 * Every difference between two snapshots, one line per path, so a failure names what was written.
 * @param {Awaited<ReturnType<typeof snapshotEverything>>} before
 * @param {Awaited<ReturnType<typeof snapshotEverything>>} after
 * @returns {string[]}
 */
function listChanges(before, after) {
  /** @type {string[]} */
  const changes = [];
  for (const [area, then] of Object.entries(before)) {
    const now = after[/** @type {keyof typeof after} */ (area)];
    const { added, removed, changed } = diffSnapshots(then.tree, now.tree);
    for (const key of added) changes.push(`${area}: added ${key}`);
    for (const key of removed) changes.push(`${area}: removed ${key}`);
    for (const key of changed) changes.push(`${area}: changed ${key}`);
    for (const [key, time] of Object.entries(then.times)) {
      if (key in now.times && now.times[key] !== time) changes.push(`${area}: touched ${key}`);
    }
  }
  return changes;
}

/**
 * Enables the editor agent against a recorded hub, then changes a setting `local.json` mirrors, so a
 * real start would write both launch.json and a refreshed local.json.
 * @param {Awaited<ReturnType<typeof prepareStart>>} ready
 * @returns {Promise<void>}
 */
async function enableEditorWithPendingRefresh(ready) {
  const configDir = path.join(ready.harness.sandbox.env.XDG_CONFIG_HOME, 'opencode');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ mcp: { unityMCP: { type: 'remote', url: HUB_URL } } }), 'utf8');
  const enabled = await ready.harness.run('init', { options: { editor: true, refresh: true }, deps: { run: createRunner({}).run } });
  assert.equal(enabled.data.editorAgent, true, enabled.message);
  const userConfig = JSON.parse(await fs.readFile(ready.harness.paths.config, 'utf8'));
  userConfig.projects[ready.projectId].editor.allowPlayMode = true;
  await fs.writeFile(ready.harness.paths.config, JSON.stringify(userConfig), 'utf8');
}

/**
 * Verification answers for a project whose editor agent points at `HUB_URL`.
 * @param {Awaited<ReturnType<typeof prepareStart>>} ready
 */
function createEditorRunner(ready) {
  const config = {
    model: `opencode-unity/${MODEL_TAG}`,
    enabled_providers: ['opencode-unity'],
    share: 'disabled',
    autoupdate: false,
    instructions: [ready.projectPaths.facts],
    plugin_origins: {},
    mcp: { unityMCP: { type: 'remote', url: HUB_URL } },
  };
  return createRunner({
    '--version': { stdout: `${TESTED_OPENCODE}\n` },
    'debug agent unity-code': { stdout: JSON.stringify({ permission: buildUnityCodePermission({}) }) },
    'debug config': { stdout: JSON.stringify(config) },
  });
}

/**
 * Initializes the fixture project and lays out everything `start` touches, with doubles for every
 * process it would spawn. Nothing here runs OpenCode or loads a model.
 * @param {import('node:test').TestContext} t
 * @param {Parameters<typeof createCommandHarness>[1] & { version?: string, agentJson?: Record<string, unknown>, configJson?: Record<string, unknown>, agentExitCode?: number, initialize?: boolean }} [options]
 */
async function prepareStart(t, { version = TESTED_OPENCODE, agentJson, configJson, agentExitCode = 0, initialize = true, ...harnessOptions } = {}) {
  const harness = await createCommandHarness(t, harnessOptions);
  // `--print` computes the id without writing anything, so a test can also start from a bare project.
  const init = await harness.run('init', { options: { print: !initialize }, deps: { run: createRunner({ '--list-sdks': { stdout: '8.0.404 [sdk]\n' } }).run } });
  assert.equal(init.exitCode, 0, init.message);
  const projectId = init.data.projectId;
  const projectPaths = harness.paths.project(projectId);
  const profileDir = harness.paths.profile(CLI_VERSION).dir;

  const binary = path.join(harness.sandbox.dirs.bin, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  await fs.writeFile(binary, 'not a real binary', 'utf8');

  const agent = agentJson ?? { name: 'unity-code', model: `opencode-unity/${MODEL_TAG}`, permission: buildUnityCodePermission({}), tools: {} };
  const config = configJson ?? {
    model: `opencode-unity/${MODEL_TAG}`,
    small_model: `opencode-unity/${MODEL_TAG}`,
    enabled_providers: ['opencode-unity'],
    share: 'disabled',
    autoupdate: false,
    default_agent: 'unity-code',
    instructions: [projectPaths.facts.replace(/\\/g, '/')],
    plugin_origins: { 'opencode-unity': [path.join(profileDir, 'plugins', 'opencode-unity.js')] },
    mcp: {},
  };
  const runner = createRunner({
    '--version': { stdout: `${version}\n` },
    'debug agent unity-code': { stdout: JSON.stringify(agent), exitCode: agentExitCode },
    'debug config': { stdout: `some banner line\n${JSON.stringify(config)}` },
  });
  /** @type {Array<import('../../../src/commands/start.js').SpawnOptions>} */
  const spawned = [];
  let childExitCode = 0;
  /** @type {number[]} */
  const sleeps = [];
  const deps = {
    run: runner.run,
    spawnChild: async (/** @type {any} */ options) => {
      spawned.push(options);
      return { exitCode: childExitCode, signal: null };
    },
    sleep: async (/** @type {number} */ ms) => {
      sleeps.push(ms);
    },
    now: () => NOW_MS,
  };
  return {
    harness,
    projectId,
    projectPaths,
    runner,
    spawned,
    sleeps,
    setChildExitCode: (/** @type {number} */ code) => {
      childExitCode = code;
    },
    start: (/** @type {import('./helpers.mjs').RunInput} */ input = {}) =>
      harness.run('start', { ...input, env: { [BINARY_ENV_NAME]: binary, ...input.env }, deps: { ...deps, ...input.deps } }),
  };
}

describe('commands/start: preconditions', () => {
  it('exits 1 with the init command when the project has no facts and the scan is declined', async (t) => {
    const harness = await createCommandHarness(t);
    const result = await harness.run('start', { global: { yes: false } });
    assert.equal(result.exitCode, 1, 'an unanswerable offer is a "no", never exit 9');
    assert.equal(result.code, 'project_not_initialized');
    assert.match(result.error?.hint ?? '', /opencode-unity init/);
  });

  it('offers init for a project without facts and continues once it has run', async (t) => {
    const ready = await prepareStart(t, { initialize: false });
    const result = await ready.start();
    assert.equal(result.exitCode, 0, result.message);
    assert.match(result.output.join('\n'), /scanned/);
    await fs.access(ready.projectPaths.facts);
    assert.equal(ready.spawned.length, 1);
  });

  it('exits 1 when OpenCode is not installed', async (t) => {
    const ready = await prepareStart(t);
    // Windows spells the variable `Path` or `PATH` depending on who started the process; every spelling
    // is emptied so the real PATH of the machine running the tests can never be searched.
    /** @type {Record<string, string | undefined>} */
    const env = { [BINARY_ENV_NAME]: undefined };
    for (const name of Object.keys(ready.harness.sandbox.env)) if (name.toUpperCase() === 'PATH') env[name] = undefined;
    env.PATH = ready.harness.sandbox.dirs.tmp;
    const result = await ready.harness.run('start', { env, deps: { run: ready.runner.run } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.code, 'opencode_missing');
  });

  it('refuses an untested OpenCode with exit 8', async (t) => {
    const ready = await prepareStart(t, { version: '9.9.9' });
    const result = await ready.start();
    assert.equal(result.exitCode, 8);
    assert.equal(result.code, 'opencode_version_untested');
    assert.equal(result.data.found, '9.9.9');
    assert.equal(result.data.selftestRecorded, false);
    assert.equal(ready.spawned.length, 0);
  });

  it('accepts an untested OpenCode only with --experimental and a recorded self-test', async (t) => {
    const ready = await prepareStart(t, { version: '9.9.9' });
    const withoutRecord = await ready.start({ global: { experimental: true } });
    assert.equal(withoutRecord.exitCode, 8);

    await fs.mkdir(ready.harness.paths.selftestDir, { recursive: true });
    await fs.writeFile(path.join(ready.harness.paths.selftestDir, '9.9.9.json'), '{}', 'utf8');
    const withoutFlag = await ready.start();
    assert.equal(withoutFlag.exitCode, 8);
    assert.match(withoutFlag.error?.hint ?? '', /--experimental/);

    const accepted = await ready.start({ global: { experimental: true } });
    assert.equal(accepted.exitCode, 0, accepted.message);
    assert.equal(accepted.warnings.some((warning) => warning.includes('not the tested version')), true);
  });

  it('exits 7 when the version cannot be read at all', async (t) => {
    const ready = await prepareStart(t);
    const runner = createRunner({ '--version': { error: new Error('spawn failed'), exitCode: null } });
    const result = await ready.start({ deps: { run: runner.run } });
    assert.equal(result.exitCode, 7);
    assert.equal(result.code, 'opencode_version_unreadable');
  });

  it('exits 2 when Ollama is down and may not be started', async (t) => {
    const ready = await prepareStart(t, { ollama: false, config: { ollama: { baseUrl: 'http://127.0.0.1:9', startAppIfDown: 'never' } } });
    const result = await ready.start();
    assert.equal(result.exitCode, 2);
    assert.equal(result.code, 'ollama_unreachable');
  });

  it('starts the Ollama app after consent and waits for it to answer', async (t) => {
    const appPath = path.join('apps', 'ollama-app');
    const ready = await prepareStart(t, { ollama: false, config: { ollama: { baseUrl: 'http://127.0.0.1:9', startAppIfDown: 'ask', appPath } } });
    /** @type {string[]} */
    const startedApps = [];
    let clock = NOW_MS;
    const fetchImpl = /** @type {typeof fetch} */ (async (/** @type {any} */ url) => {
      if (startedApps.length === 0 || !String(url).endsWith('/api/version')) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ version: '0.34.1' }), { status: 200 });
    });
    const result = await ready.start({
      deps: { fetchImpl, now: () => (clock += 1000), startApp: async (/** @type {string} */ app) => { startedApps.push(app); } },
    });
    assert.equal(result.exitCode, 0, result.message);
    assert.deepEqual(startedApps, [appPath]);
    assert.equal(ready.spawned.length, 1);
    assert.equal(result.warnings.some((warning) => warning.includes('was started')), true);
  });

  it('gives up after the start timeout when the app never answers', async (t) => {
    const ready = await prepareStart(t, { ollama: false, config: { ollama: { baseUrl: 'http://127.0.0.1:9', startAppIfDown: 'always', appPath: 'ollama-app' } } });
    let clock = NOW_MS;
    let polls = 0;
    const result = await ready.start({
      deps: {
        now: () => (clock += OLLAMA_START_TIMEOUT_MS / 4),
        fetchImpl: /** @type {any} */ (async () => {
          polls += 1;
          throw new TypeError('fetch failed');
        }),
        startApp: async () => {},
      },
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.code, 'ollama_unreachable');
    assert.equal(polls > 1, true, 'it polled while waiting');
  });

  it('reports an app that cannot be started as Ollama being down', async (t) => {
    const ready = await prepareStart(t, { ollama: false, config: { ollama: { baseUrl: 'http://127.0.0.1:9', startAppIfDown: 'always', appPath: 'missing-app' } } });
    const result = await ready.start({
      deps: {
        startApp: async () => {
          throw Object.assign(new Error('spawn missing-app ENOENT'), { code: 'ENOENT' });
        },
      },
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.error?.hint ?? '', /missing-app/);
  });

  it('asks before starting the app and stops when that is declined', async (t) => {
    const ready = await prepareStart(t, { ollama: false, config: { ollama: { baseUrl: 'http://127.0.0.1:9', startAppIfDown: 'ask', appPath: 'ollama-app' } } });
    /** @type {string[]} */
    const startedApps = [];
    const result = await ready.start({ global: { yes: false }, deps: { startApp: async (/** @type {string} */ app) => { startedApps.push(app); } } });
    assert.equal(result.exitCode, 2, 'start documents exit 2 for Ollama down; an unanswerable offer is a "no"');
    assert.equal(result.code, 'ollama_unreachable');
    assert.deepEqual(startedApps, []);
  });

  it('offers the platform default app when config.json leaves appPath empty', async (t) => {
    const ready = await prepareStart(t, { ollama: false, config: { ollama: { baseUrl: 'http://127.0.0.1:9', startAppIfDown: 'always' } } });
    /** @type {string[]} */
    const startedApps = [];
    let clock = NOW_MS;
    const result = await ready.start({
      deps: {
        now: () => (clock += OLLAMA_START_TIMEOUT_MS),
        fetchImpl: /** @type {any} */ (async () => {
          throw new TypeError('fetch failed');
        }),
        startApp: async (/** @type {string} */ app) => { startedApps.push(app); },
      },
    });
    assert.equal(result.exitCode, 2);
    // Only Windows has a default install location; elsewhere nothing is started and the hint says so.
    if (process.platform === 'win32') assert.match(startedApps[0] ?? '', /ollama app\.exe$/);
    else assert.deepEqual(startedApps, []);
  });

  it('starts a detached process and rejects one that cannot spawn', async () => {
    await assert.rejects(() => startDetached(path.join('no-such-dir', 'no-such-app'), { env: {} }));
  });
});

describe('commands/start: the OpenCode child', () => {
  // A Node child stands in for OpenCode: it is the one executable every CI runner is sure to have.
  const childScript = 'setTimeout(() => process.exit(3), 400)';

  it('leaves Ctrl+C to the TUI while the child runs, and resumes afterwards', async (t) => {
    const sandbox = await useSandbox(t, 'spawn-child');
    /** @type {number[]} */
    const exits = [];
    const interrupts = createInterruptController({ exit: (code) => exits.push(code), stderr: { write: () => true } });
    const running = spawnOpencode({ file: process.execPath, args: ['-e', childScript], cwd: sandbox.root, env: sandbox.env, interrupts });

    interrupts.handleSignal('SIGINT');
    assert.deepEqual(exits, [], 'an interactive interrupt belongs to the TUI while it runs');
    assert.equal(interrupts.signal.aborted, false);

    const result = await running;
    assert.equal(result.exitCode, 3);
    interrupts.handleSignal('SIGINT');
    assert.deepEqual(exits, [130], 'after the child is gone, Ctrl+C is ours again');
  });

  it('still stops the child tree on a termination signal', async (t) => {
    const sandbox = await useSandbox(t, 'spawn-term');
    /** @type {number[]} */
    const killed = [];
    const interrupts = createInterruptController({
      exit: () => {},
      stderr: { write: () => true },
      killTree: (pid) => {
        killed.push(pid);
        process.kill(pid);
      },
    });
    const running = spawnOpencode({ file: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], cwd: sandbox.root, env: sandbox.env, interrupts });
    await new Promise((resolve) => setTimeout(resolve, 100));
    interrupts.handleSignal('SIGTERM');
    const result = await running;
    assert.equal(killed.length, 1);
    assert.notEqual(result.exitCode, 0);
  });

  it('rejects when the executable cannot be started', async (t) => {
    const sandbox = await useSandbox(t, 'spawn-missing');
    const interrupts = createInterruptController({ exit: () => {}, stderr: { write: () => true } });
    await assert.rejects(() => spawnOpencode({ file: path.join(sandbox.root, 'no-such-opencode'), args: [], cwd: sandbox.root, env: sandbox.env, interrupts }));
    interrupts.handleSignal('SIGINT');
    assert.equal(interrupts.signal.aborted, true, 'a failed spawn does not leave interrupts suspended');
  });

  it('refuses the editor agent until init --editor enabled it, before anything is spawned', async (t) => {
    const ready = await prepareStart(t);
    const result = await ready.start({ options: { agent: 'unity-editor' } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.code, 'editor_disabled');
    assert.equal(ready.spawned.length, 0);
  });

  it('refuses the editor agent while the hub URL is unconfirmed, and keeps the MCP server out of an ordinary launch', async (t) => {
    const ready = await prepareStart(t, { fixture: 'mcp-for-unity-installed' });
    const enabled = await ready.harness.run('init', { options: { editor: true, refresh: true }, deps: { run: createRunner({}).run } });
    assert.equal(enabled.data.editorReason, 'hub_unconfirmed');

    const refused = await ready.start({ options: { agent: 'unity-editor' } });
    assert.equal(refused.exitCode, 1);
    assert.equal(refused.code, 'editor_hub_unconfirmed');
    assert.equal(ready.spawned.length, 0);

    const printed = await ready.start({ options: { printEnv: true } });
    assert.equal(printed.exitCode, 0, printed.message);
    assert.equal(printed.data.content.agent['unity-editor'].disable, true);
    assert.equal(printed.data.content.mcp, undefined);
    assert.ok(printed.warnings.some((warning) => /not confirmed/.test(warning)), printed.warnings.join('|'));
  });
});

describe('commands/start: --print-env', () => {
  it('prints the clean-room environment and the content, and writes, verifies and starts nothing', async (t) => {
    const ready = await prepareStart(t);
    const result = await ready.start({ options: { printEnv: true }, env: { OPENAI_API_KEY: 'sk-planted-secret', OPENCODE_PERMISSION: '{"bash":"allow"}' } });
    assert.equal(result.exitCode, 0, result.message);
    assert.match(result.message, /nothing was written or started/);
    assert.equal(ready.spawned.length, 0);
    assert.equal(ready.runner.calls.some((call) => call.args[0] === 'debug'), false, 'no verification probe runs for --print-env');

    const printed = result.output.join('\n');
    assert.match(printed, /OPENCODE_CONFIG_DIR=/);
    assert.match(printed, /OPENCODE_UNITY_PROJECT=/);
    assert.match(printed, /OPENAI_API_KEY/);
    assert.match(printed, /OPENCODE_PERMISSION/);
    assert.equal(printed.includes('sk-planted-secret'), false, 'a removed value is never printed');
    const contentStart = result.output.indexOf('content (OPENCODE_CONFIG_CONTENT)');
    assert.notEqual(contentStart, -1);
    assert.deepEqual(JSON.parse(result.output.slice(contentStart + 1).join('\n')), result.data.content, 'the printed content is the content a real start uses');

    assert.equal(result.data.content.agent['unity-editor'].disable, true);
    assert.equal(result.data.launchJson, ready.projectPaths.launchJson, 'names where a real start records the content');
    assert.equal(await fs.access(ready.projectPaths.launchJson).then(() => true, () => false), false, 'launch.json is written only by a real start');
    assert.equal(result.warnings.some((warning) => warning.includes('OPENCODE_PERMISSION')), true);
  });

  it('sets OPENCODE_DISABLE_PROJECT_CONFIG for --no-project-config', async (t) => {
    const ready = await prepareStart(t);
    const result = await ready.start({ options: { printEnv: true, noProjectConfig: true } });
    const names = result.data.env.set.map((/** @type {[string, string]} */ entry) => entry[0]);
    assert.equal(names.includes('OPENCODE_DISABLE_PROJECT_CONFIG'), true);
  });
});

describe('commands/start: --dry-run (spec 5.1)', () => {
  it('plans the launch and writes nothing, verifies nothing and starts nothing', async (t) => {
    const ready = await prepareStart(t);
    const indexBefore = await fs.readFile(ready.harness.paths.projectsIndex, 'utf8');
    const result = await ready.start({ global: { dryRun: true } });
    assert.equal(result.exitCode, 0, result.message);
    assert.equal(result.data.dryRun, true);
    assert.equal(ready.spawned.length, 0, 'OpenCode is never started');
    assert.equal(ready.runner.calls.some((call) => call.args[0] === 'debug'), false, 'no verification probe runs');
    for (const file of [ready.projectPaths.launchJson, ready.projectPaths.verifyCache]) {
      assert.equal(await fs.access(file).then(() => true, () => false), false, `${path.basename(file)} was written`);
    }
    assert.equal(await fs.readFile(ready.harness.paths.projectsIndex, 'utf8'), indexBefore, 'lastStart is not recorded');
    assert.deepEqual(result.data.wouldWrite, [ready.projectPaths.launchJson, ready.projectPaths.verifyCache]);
    assert.deepEqual(result.data.command.slice(1), ['--agent', 'unity-code']);
    assert.match(result.output.join('\n'), /nothing is written and OpenCode is not started/);
  });

});

describe('commands/start: --print-env and --dry-run write nothing (spec 5.1, 5.4)', () => {
  for (const [flag, input] of WRITE_FREE_RUNS) {
    it(`${flag} leaves the product home, the project and the sandbox unchanged where a real start writes launch.json and local.json`, async (t) => {
      const ready = await prepareStart(t, { fixture: 'mcp-for-unity-installed' });
      await enableEditorWithPendingRefresh(ready);
      const localBefore = await fs.readFile(ready.projectPaths.localJson, 'utf8');
      const before = await snapshotEverything(ready.harness);

      const result = await ready.start({ ...input, options: { ...input.options, agent: 'unity-editor' } });
      assert.equal(result.exitCode, 0, result.message);
      assert.deepEqual(listChanges(before, await snapshotEverything(ready.harness)), []);
      assert.equal(ready.spawned.length, 0);
      assert.equal(ready.runner.calls.some((call) => call.args[0] === 'debug'), false, 'no verification probe runs');

      // The control: a real start from the same state writes both files the flag held back.
      const real = await ready.start({ options: { agent: 'unity-editor' }, deps: { run: createEditorRunner(ready).run } });
      assert.equal(real.exitCode, 0, real.message);
      await fs.access(ready.projectPaths.launchJson);
      assert.notEqual(await fs.readFile(ready.projectPaths.localJson, 'utf8'), localBefore, 'a real start refreshes local.json');
    });

    it(`${flag} does not scan a project that has no facts yet, because init writes`, async (t) => {
      const ready = await prepareStart(t, { initialize: false });
      const before = await snapshotEverything(ready.harness);
      const result = await ready.start(input);
      assert.equal(result.exitCode, 1);
      assert.equal(result.code, 'project_not_initialized');
      assert.match(result.error?.hint ?? '', /opencode-unity init/);
      assert.deepEqual(listChanges(before, await snapshotEverything(ready.harness)), []);
    });

    it(`${flag} does not start the Ollama application; it says a real start would`, async (t) => {
      const ready = await prepareStart(t, { ollama: false, config: { ollama: { baseUrl: 'http://127.0.0.1:9', startAppIfDown: 'always', appPath: path.join('apps', 'ollama-app') } } });
      /** @type {string[]} */
      const startedApps = [];
      const before = await snapshotEverything(ready.harness);
      // Throwing ends a regression at once as "Ollama down" instead of polling a clock that never moves.
      const startApp = async (/** @type {string} */ app) => {
        startedApps.push(app);
        throw new Error('a write-free run started the Ollama application');
      };
      const result = await ready.start({ ...input, deps: { startApp } });
      assert.equal(result.exitCode, 0, result.message);
      assert.deepEqual(startedApps, []);
      assert.equal(result.warnings.some((warning) => /Ollama is not running; a real start starts the application/.test(warning)), true);
      assert.deepEqual(listChanges(before, await snapshotEverything(ready.harness)), []);
    });
  }
});

describe('commands/start: launch', () => {
  it('verifies, prints the banner, spawns OpenCode and prints the summary', async (t) => {
    const ready = await prepareStart(t);
    const result = await ready.start();
    assert.equal(result.exitCode, 0, result.message);

    assert.equal(ready.spawned.length, 1);
    const child = ready.spawned[0];
    assert.deepEqual(child.args, ['--agent', 'unity-code']);
    assert.equal(child.cwd, ready.harness.projectRoot);
    assert.equal(typeof child.env.OPENCODE_CONFIG_CONTENT, 'string');
    assert.equal(child.env.OPENCODE_UNITY_PROJECT, ready.projectId);

    const printed = result.output.join('\n');
    assert.match(printed, /^opencode-unity /m);
    assert.match(printed, /^guard {4}pass/m);
    assert.match(printed, /^config {3}effective rules verified {2}/m);
    assert.match(printed, /opencode-unity stop/);

    const index = JSON.parse(await fs.readFile(ready.harness.paths.projectsIndex, 'utf8'));
    assert.equal(index.projects[0].lastStart, new Date(NOW_MS).toISOString());
    const cache = JSON.parse(await fs.readFile(ready.projectPaths.verifyCache, 'utf8'));
    assert.equal(cache.ok, true);
  });

  it('reports V-c as not run while the expected-tools fixture is absent, never as a pass', async (t) => {
    const ready = await prepareStart(t);
    const fixture = new URL('../../../src/opencode/expected-tools-1.18.31.json', import.meta.url);
    const present = await fs.access(fixture).then(() => true, () => false);
    const result = await ready.start();
    assert.equal(result.exitCode, 0);
    assert.equal(result.warnings.some((warning) => warning.startsWith('V-c (visible tools) was not run')), !present);
  });

  it('launches the editor agent with the hub the project recorded', async (t) => {
    const ready = await prepareStart(t, { fixture: 'mcp-for-unity-installed' });
    // The entry MCP for Unity's configurator writes; the URL is only read, never contacted.
    const configDir = path.join(ready.harness.sandbox.env.XDG_CONFIG_HOME, 'opencode');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ mcp: { unityMCP: { type: 'remote', url: HUB_URL } } }), 'utf8');
    const enabled = await ready.harness.run('init', { options: { editor: true, refresh: true }, deps: { run: createRunner({}).run } });
    assert.equal(enabled.exitCode, 0, enabled.message);
    assert.equal(enabled.data.editorAgent, true);
    const hubUrl = JSON.parse(await fs.readFile(ready.projectPaths.localJson, 'utf8')).hubUrl;
    assert.equal(hubUrl, HUB_URL);

    const result = await ready.start({ options: { agent: 'unity-editor' }, deps: { run: createEditorRunner(ready).run } });
    assert.equal(result.exitCode, 0, result.message);
    assert.deepEqual(ready.spawned[0].args, ['--agent', 'unity-editor']);
    const content = JSON.parse(ready.spawned[0].env.OPENCODE_CONFIG_CONTENT);
    assert.equal(content.mcp.unityMCP.url, hubUrl);
    assert.equal(typeof content.agent['unity-editor'].permission, 'object');
    assert.match(result.output.join('\n'), /editor agent: on/);

    // The plugin reads the PlayMode choice from local.json, so a config change reaches it at the next launch.
    const userConfig = JSON.parse(await fs.readFile(ready.harness.paths.config, 'utf8'));
    userConfig.projects[ready.projectId].editor.allowPlayMode = true;
    await fs.writeFile(ready.harness.paths.config, JSON.stringify(userConfig), 'utf8');
    const printed = await ready.start({ options: { agent: 'unity-editor', printEnv: true } });
    assert.equal(printed.exitCode, 0, printed.message);
    assert.equal(JSON.parse(await fs.readFile(ready.projectPaths.localJson, 'utf8')).editor.allowPlayMode, false, '--print-env leaves local.json alone');
    const again = await ready.start({ options: { agent: 'unity-editor' }, deps: { run: createEditorRunner(ready).run } });
    assert.equal(again.exitCode, 0, again.message);
    const local = JSON.parse(await fs.readFile(ready.projectPaths.localJson, 'utf8'));
    assert.equal(local.editor.allowPlayMode, true);
    assert.equal(local.editor.hubUrlConfirmed, true);
  });

  it('reuses a cached verification and says so', async (t) => {
    const ready = await prepareStart(t);
    await ready.start();
    const probesBefore = ready.runner.calls.filter((call) => call.args[0] === 'debug').length;

    const second = await ready.start();
    assert.equal(second.exitCode, 0);
    assert.equal(ready.runner.calls.filter((call) => call.args[0] === 'debug').length, probesBefore);
    assert.match(second.output.join('\n'), /effective rules verified \(cached\)/);
  });

  it('exits 4 naming the rule when a merged config re-allows a denied action', async (t) => {
    const hostile = JSON.parse(await fs.readFile(new URL('../../fixtures/opencode/debug-agent-hostile.json', import.meta.url), 'utf8'));
    const ready = await prepareStart(t, { agentJson: hostile });
    const result = await ready.start();
    assert.equal(result.exitCode, 4);
    assert.equal(result.code, 'effective_config_rejected');
    assert.match(result.message, /V-b/);
    assert.equal(ready.spawned.length, 0);
  });

  it('exits 4 when the plugin never loaded, after one retry', async (t) => {
    const ready = await prepareStart(t, { agentExitCode: 1 });
    const result = await ready.start();
    assert.equal(result.exitCode, 4);
    assert.match(result.message, /V-a/);
    assert.equal(ready.runner.calls.filter((call) => call.args.join(' ') === 'debug agent unity-code').length, 2);
  });

  it('exits 4 when an MCP server other than the editor hub is configured', async (t) => {
    const ready = await prepareStart(t);
    const config = {
      model: `opencode-unity/${MODEL_TAG}`,
      enabled_providers: ['opencode-unity'],
      share: 'disabled',
      autoupdate: false,
      instructions: [ready.projectPaths.facts],
      plugin_origins: {},
      mcp: { stranger: {} },
    };
    const runner = createRunner({
      '--version': { stdout: `${TESTED_OPENCODE}\n` },
      'debug agent unity-code': { stdout: JSON.stringify({ permission: buildUnityCodePermission({}) }) },
      'debug config': { stdout: JSON.stringify(config) },
    });
    const result = await ready.start({ deps: { run: runner.run } });
    assert.equal(result.exitCode, 4);
    assert.match(result.message, /no MCP server other than none/);
  });

  it('never trusts a probe that printed no JSON', async (t) => {
    const ready = await prepareStart(t);
    const runner = createRunner({ '--version': { stdout: `${TESTED_OPENCODE}\n` }, 'debug agent unity-code': { stdout: 'garbage' }, 'debug config': { stdout: '{ not json' } });
    const result = await ready.start({ deps: { run: runner.run } });
    assert.equal(result.exitCode, 4);
  });

  it('exits 7 when the OpenCode child exits non-zero, after printing the summary', async (t) => {
    const ready = await prepareStart(t);
    ready.setChildExitCode(3);
    const result = await ready.start();
    assert.equal(result.exitCode, 7);
    assert.equal(result.code, 'opencode_failed');
    assert.equal(result.data.childExitCode, 3);
    assert.match(result.output.join('\n'), /opencode-unity stop/);
  });

  it('exits 7 and names the signal when OpenCode is ended by one, instead of calling it a normal end (spec 5.2)', async (t) => {
    const ready = await prepareStart(t);
    const result = await ready.start({ deps: { spawnChild: async () => ({ exitCode: null, signal: 'SIGSEGV' }) } });
    assert.equal(result.exitCode, 7);
    assert.equal(result.code, 'opencode_failed');
    assert.equal(result.data.childExitCode, null);
    assert.equal(result.data.childSignal, 'SIGSEGV');
    assert.match(result.message, /SIGSEGV/);
    assert.match(result.output.join('\n'), /opencode-unity stop/, 'the summary is still printed');
  });

  it('keeps a clean exit a normal end, with no signal', async (t) => {
    const ready = await prepareStart(t);
    const result = await ready.start();
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.childSignal, null);
  });

  it('forwards --continue, --session and --prompt and nothing else', async (t) => {
    const ready = await prepareStart(t);
    await ready.start({ options: { continue: true, session: 'ses_1', prompt: 'fix the build', warm: false, noPane: true } });
    assert.deepEqual(ready.spawned[0].args, ['--agent', 'unity-code', '--continue', '--session', 'ses_1', '--prompt', 'fix the build']);
    assert.deepEqual(buildOpencodeArgs(/** @type {any} */ ({ options: {} }), 'unity-code'), ['--agent', 'unity-code']);
  });

  it('warms the model through the guard with --warm, and not when the guard blocks', async (t) => {
    const ready = await prepareStart(t, { loaded: false });
    const warmed = await ready.start({ options: { warm: true } });
    assert.equal(warmed.exitCode, 0, warmed.message);
    const loads = ready.harness.ollama.requests.filter((request) => request.path === '/api/chat');
    assert.equal(loads.length, 1);
    assert.deepEqual(loads[0].body.messages, []);

    const blocked = await ready.start({ options: { warm: true }, guardBlocked: true });
    assert.equal(blocked.exitCode, 0, 'the guard is advisory at launch; the plugin enforces it later');
    assert.equal(ready.harness.ollama.requests.filter((request) => request.path === '/api/chat').length, 1);
    assert.equal(blocked.warnings.some((warning) => warning.includes('guard blocked the warm-up')), true);
    assert.match(blocked.output.join('\n'), /^guard {4}blocked/m);
  });

  it('pauses before the TUI when the banner carries something yellow', async (t) => {
    const ready = await prepareStart(t);
    await ready.start();
    assert.deepEqual(ready.sleeps, []);

    await fs.writeFile(path.join(ready.harness.projectRoot, 'Assets', 'Late.asmdef'), '{"name":"Late"}', 'utf8');
    const stale = await ready.start();
    assert.deepEqual(ready.sleeps, [ATTENTION_PAUSE_MS]);
    assert.equal(stale.warnings.some((warning) => warning.includes('init --refresh')), true);
    assert.match(stale.output.join('\n'), /facts stale/);
  });

  it('summarizes only the plugin records written during this session', async (t) => {
    const ready = await prepareStart(t);
    await fs.mkdir(ready.harness.paths.sessionsDir, { recursive: true });
    const day = new Date(NOW_MS).toISOString().slice(0, 10);
    const lines = [
      { at: new Date(NOW_MS - 60_000).toISOString(), event: 'request', estimate: 1 },
      { at: new Date(NOW_MS).toISOString(), event: 'request', estimate: 2 },
      { at: new Date(NOW_MS).toISOString(), event: 'textToolCall', code: 'xml' },
    ].map((record) => JSON.stringify(record)).join('\n');
    await fs.writeFile(path.join(ready.harness.paths.sessionsDir, `${day}.jsonl`), `${lines}\n`, 'utf8');

    const result = await ready.start();
    assert.equal(result.data.summary.requests, 1);
    assert.equal(result.data.summary.textToolCalls, 1);
    assert.match(result.output.join('\n'), /text-form tool calls 1/);
  });
});
