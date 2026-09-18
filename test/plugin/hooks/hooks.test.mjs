// The plugin entry and its hook map (spec 8.7). The hooks are driven here the way OpenCode drives
// them, over a fake file system, a fake client and a fake guard, so the whole request path is
// exercised without OpenCode, Ollama, a GPU or Unity. The contract tests do the same with the real
// binary; these assert the behaviour a contract test cannot see from outside.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import plugin, { PLUGIN_ID, createHooks, createPluginRuntime, readProjectContext, startPlugin } from '../../../plugin/opencode-unity.js';
import { OVERFLOW_ERROR_CODE } from '../../../plugin/opencode-unity-lib/budget.js';
import { renderRuntimeProfile } from '../../../src/core/profile.js';
import { catchError } from '../../helpers/catch-error.mjs';
import { TEST_HOME, buildTestProfile } from '../helpers/profile.mjs';

const PROFILE_PATH = '/opt/profile/opencode-unity.runtime.json';
const PROJECT_ID = 'sample-1a2b3c4d';
const STRICTEST_CONTEXT = Object.freeze({ vcsKind: null, hubUrl: null, editor: { allowPlayMode: false } });

/**
 * A file system with a fixed set of files; everything else is ENOENT. Appends are recorded.
 * @param {Record<string, string>} files
 */
function createFakeFs(files) {
  /** @type {string[]} */
  const appended = [];
  return {
    appended,
    fs: /** @type {any} */ ({
      readFile: async (file) => {
        const value = files[path.normalize(String(file)).split(path.sep).join('/')];
        if (value === undefined) {
          const error = /** @type {any} */ (new Error('not found'));
          error.code = 'ENOENT';
          throw error;
        }
        return value;
      },
      mkdir: async () => {},
      appendFile: async (_file, line) => appended.push(String(line)),
      readdir: async () => [],
      rm: async () => {},
    }),
  };
}

function createFakeClient() {
  /** @type {any[]} */
  const toasts = [];
  return { toasts, client: { tui: { showToast: async (input) => { toasts.push(input.body); return true; } } } };
}

/**
 * @param {{ pass?: boolean, mode?: 'stop' | 'retry' }} [options]
 */
function verdict({ pass = true, mode = 'stop' } = {}) {
  return /** @type {any} */ ({
    verdict: pass ? 'pass' : 'blocked',
    pass,
    path: 'cold',
    mode: pass ? null : mode,
    reasons: pass ? [] : [{ id: 'vram_low', mode, detail: 'low', data: { freeMiB: 100, reclaimableMiB: 0, availableMiB: 100, modelVramMiB: 20000, freeAfterLoadMiB: -19900, minFreeVramAfterLoadMiB: 1500 } }],
    notes: [],
    cacheSec: pass ? 15 : 0,
    checkedAt: '2026-09-18T00:00:00.000Z',
    target: { modelTag: 'ocu-model-16k', numCtx: 16384 },
    model: { loaded: false, state: 'not-listed', contextLength: null, expiresInSec: null, sizeVramMiB: 0, reclaimableMiB: 0, otherModels: [] },
    measurements: { gpu: null, unity: null, loadedModels: [] },
  });
}

/**
 * @param {{ files?: Record<string, string>, guard?: () => any, env?: Record<string, string> }} [options]
 */
async function createRuntime({ files, guard = () => verdict(), env = {} } = {}) {
  const profileText = renderRuntimeProfile(buildTestProfile());
  const fake = createFakeFs(files ?? { [PROFILE_PATH]: profileText });
  const fakeClient = createFakeClient();
  let guardCalls = 0;
  const runtime = await createPluginRuntime({
    client: fakeClient.client,
    env: { OPENCODE_UNITY_HOME: TEST_HOME, ...env },
    platform: 'linux',
    profilePath: PROFILE_PATH,
    fsImpl: fake.fs,
    evaluate: async () => {
      guardCalls += 1;
      return guard();
    },
  });
  return { runtime, hooks: createHooks(runtime, { env: {}, userHome: '/opt/home' }), toasts: fakeClient.toasts, appended: fake.appended, guardCalls: () => guardCalls };
}

/** @param {string[]} lines */
function events(lines) {
  return lines.map((line) => JSON.parse(line).event);
}

describe('plugin runtime', () => {
  it('exposes the module shape the OpenCode loader expects', () => {
    assert.equal(plugin.id, PLUGIN_ID);
    assert.equal(typeof plugin.server, 'function');
  });

  it('greets the human once with the model and the context, and returns the hook map', async () => {
    const fake = createFakeFs({ [PROFILE_PATH]: renderRuntimeProfile(buildTestProfile()) });
    const fakeClient = createFakeClient();
    const hooks = await startPlugin({ client: fakeClient.client }, {
      env: { OPENCODE_UNITY_HOME: TEST_HOME },
      platform: 'linux',
      profilePath: PROFILE_PATH,
      fsImpl: fake.fs,
      evaluate: async () => verdict(),
    });
    assert.equal(typeof hooks['chat.params'], 'function');
    assert.equal(fakeClient.toasts.length, 1);
    assert.match(fakeClient.toasts[0].message, /at 16K context/);
  });

  it('says nothing when there is no profile to announce', async () => {
    const fake = createFakeFs({});
    const fakeClient = createFakeClient();
    await startPlugin({ client: fakeClient.client }, { env: {}, platform: 'linux', profilePath: PROFILE_PATH, fsImpl: fake.fs, evaluate: async () => verdict() });
    assert.deepEqual(fakeClient.toasts, []);
  });

  it('injects the provider from the runtime profile and logs that it did', async () => {
    const { runtime, hooks, appended } = await createRuntime();
    const config = /** @type {any} */ ({});
    await hooks.config(config);
    await runtime.log.flush();
    assert.deepEqual(config.enabled_providers, ['opencode-unity']);
    assert.ok(config.provider['opencode-unity'].models[runtime.profile.provider.modelTag]);
    assert.ok(events(appended).includes('providerInjected'));
  });

  it('injects nothing when the runtime profile is missing, so the model never resolves', async () => {
    const { runtime, hooks, appended } = await createRuntime({ files: {} });
    const config = /** @type {any} */ ({});
    await hooks.config(config);
    await runtime.log.flush();
    assert.equal(runtime.profile, null);
    assert.match(String(runtime.skipReason), /file not found/);
    assert.deepEqual(config, {});
    assert.ok(events(appended).includes('providerSkipped'));
  });

  it('injects nothing when the runtime profile is not valid', async () => {
    const { runtime } = await createRuntime({ files: { [PROFILE_PATH]: '{"schemaVersion":99}' } });
    assert.equal(runtime.profile, null);
    assert.match(String(runtime.skipReason), /schemaVersion/);
  });

  it('prepares no request at all without a profile', async () => {
    const { hooks } = await createRuntime({ files: {} });
    const error = await hooks['experimental.chat.system.transform']({ sessionID: 's' }, { system: ['x'] }).catch((value) => value);
    assert.ok(error instanceof Error);
    assert.match(error.message, /runtime profile is missing/);
  });
});

describe('guard hooks', () => {
  it('runs the guard once per request and reuses the verdict in chat.params', async () => {
    const run = await createRuntime();
    await run.hooks['experimental.chat.system.transform']({ sessionID: 's1' }, { system: ['system text'] });
    await run.hooks['chat.params']({ sessionID: 's1', agent: 'unity-code' }, {});
    assert.equal(run.guardCalls(), 1);
  });

  it('throws the guard message from system.transform, and no request is prepared', async () => {
    const run = await createRuntime({ guard: () => verdict({ pass: false }) });
    const error = await run.hooks['experimental.chat.system.transform']({ sessionID: 's1' }, { system: ['x'] }).catch((value) => value);
    assert.ok(error instanceof Error);
    assert.match(error.message, /^opencode-unity GPU guard:/);
    await run.runtime.log.flush();
    assert.ok(events(run.appended).includes('guardBlock'));
  });

  it('throws from chat.params too, because a session can reach it without the system hook', async () => {
    const run = await createRuntime({ guard: () => verdict({ pass: false, mode: 'retry' }) });
    const error = await run.hooks['chat.params']({ sessionID: 's1', agent: 'unity-code' }, {}).catch((value) => value);
    assert.ok(error instanceof Error);
    assert.match(error.message, /temporarily at capacity/);
  });

  it('measures the system prompt without changing it', async () => {
    const run = await createRuntime();
    const output = { system: ['abc', 'de'] };
    await run.hooks['experimental.chat.system.transform']({ sessionID: 's1' }, output);
    assert.deepEqual(output.system, ['abc', 'de']);
    assert.equal(run.runtime.budget.get('s1').systemChars, 5);
  });

  it('measures the history without changing it', async () => {
    const run = await createRuntime();
    const output = { messages: [{ info: { sessionID: 's1' }, parts: [] }] };
    await run.hooks['experimental.chat.messages.transform']({}, output);
    assert.equal(run.runtime.budget.get('s1').historyChars, JSON.stringify(output.messages).length);
    assert.equal(output.messages.length, 1);
  });
});

describe('chat.params', () => {
  it('fills sampling, caps the output and logs the request', async () => {
    const run = await createRuntime();
    const output = /** @type {any} */ ({ maxOutputTokens: 999999 });
    await run.hooks['chat.params']({ sessionID: 's1', agent: 'unity-code' }, output);
    await run.runtime.log.flush();
    assert.equal(output.temperature, run.runtime.profile.provider.sampling.temperature);
    assert.equal(output.maxOutputTokens, run.runtime.profile.provider.limit.output);
    assert.ok(events(run.appended).includes('request'));
  });

  it('throws the overflow shape when the prompt is over budget', async () => {
    const run = await createRuntime();
    run.runtime.budget.recordHistoryChars('s1', 5000000);
    const thrown = await run.hooks['chat.params']({ sessionID: 's1', agent: 'unity-code' }, {}).catch((value) => value);
    assert.ok(!(thrown instanceof Error));
    assert.equal(thrown.error.code, OVERFLOW_ERROR_CODE);
    await run.runtime.log.flush();
    assert.ok(events(run.appended).includes('overflow'));
  });

  it('halts the session when compacting cannot help', async () => {
    const run = await createRuntime();
    run.runtime.budget.recordHistoryChars('s1', 5000000);
    const thrown = await run.hooks['chat.params']({ sessionID: 's1', agent: 'compaction' }, {}).catch((value) => value);
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /start a new session/);
  });
});

describe('tool hooks', () => {
  it('clamps a read to the profile limit and logs it', async () => {
    const run = await createRuntime();
    const output = { args: { filePath: 'Assets/Player.cs', limit: 5000 } };
    await run.hooks['tool.execute.before']({ tool: 'read' }, output);
    await run.runtime.log.flush();
    assert.equal(output.args.limit, run.runtime.profile.safety.readLimitLines);
    assert.ok(events(run.appended).includes('readClamped'));
  });

  it('lets an allowed shell command through and blocks a denied one without logging the command', async () => {
    const run = await createRuntime({
      files: {
        [PROFILE_PATH]: renderRuntimeProfile(buildTestProfile()),
        [`${TEST_HOME}/projects/${PROJECT_ID}/project.json`]: JSON.stringify({ vcs: { kind: 'git' } }),
      },
      env: { OPENCODE_UNITY_PROJECT: PROJECT_ID },
    });
    await run.hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'git status' } });

    const error = await run.hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'rm -rf Assets/Secret' } }).catch((value) => value);
    assert.ok(error instanceof Error);
    assert.match(error.message, /^opencode-unity shell guard:/);
    await run.runtime.log.flush();
    const record = run.appended.map((line) => JSON.parse(line)).find((entry) => entry.event === 'shellBlocked');
    assert.ok(record);
    assert.equal(record.family, 'posix');
    assert.equal(record.code, 'shell_recursive_delete');
    assert.ok(!JSON.stringify(record).includes('Secret'));
  });

  it('logs a refused version control call by its code, never by the argument the model wrote (P5)', async () => {
    const run = await createRuntime({
      files: {
        [PROFILE_PATH]: renderRuntimeProfile(buildTestProfile()),
        [`${TEST_HOME}/projects/${PROJECT_ID}/project.json`]: JSON.stringify({ vcs: { kind: 'git' } }),
      },
      env: { OPENCODE_UNITY_PROJECT: PROJECT_ID },
    });
    const commands = ['git Work/ClientGame/Assets/secret-roadmap.txt', 'git https://token@example.invalid/repo'];
    for (const command of commands) {
      const error = await run.hooks['tool.execute.before']({ tool: 'bash' }, { args: { command } }).catch((value) => value);
      assert.ok(error instanceof Error, command);
      assert.match(error.message, /can change version control/, 'the model still reads the full reason');
    }
    await run.runtime.log.flush();
    const records = run.appended.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'shellBlocked');
    assert.equal(records.length, commands.length);
    for (const record of records) {
      assert.equal(record.code, 'shell_vcs_write');
      assert.equal(record.reason, undefined);
      const text = JSON.stringify(record).toLowerCase();
      for (const fragment of ['clientgame', 'roadmap', 'token', 'example.invalid']) assert.ok(!text.includes(fragment), fragment);
    }
  });

  it('leaves every other tool alone', async () => {
    const run = await createRuntime();
    const output = { args: { limit: 5000 } };
    await run.hooks['tool.execute.before']({ tool: 'grep' }, output);
    assert.equal(output.args.limit, 5000);
  });

  it('reads a command with the grammar of the shell OpenCode will run, not only the platform default', async () => {
    const profileText = renderRuntimeProfile(buildTestProfile());
    const fake = createFakeFs({ [PROFILE_PATH]: profileText });
    const build = (/** @type {Record<string, string>} */ env) => createPluginRuntime({ env, platform: 'win32', profilePath: PROFILE_PATH, fsImpl: fake.fs, evaluate: async () => verdict() });
    assert.equal((await build({})).shell.family, 'powershell');
    assert.equal((await build({ SHELL: '/usr/bin/bash' })).shell.family, 'posix');
    const degraded = await createPluginRuntime({ env: { SHELL: '/usr/bin/bash' }, platform: 'win32', profilePath: PROFILE_PATH, fsImpl: createFakeFs({}).fs });
    assert.equal(degraded.shell.family, 'posix');
  });
});

describe('editor policy hook (spec 11.3)', () => {
  it('strips a model-supplied instance and fills in the read-only console action, and logs the argument names only', async () => {
    const run = await createRuntime();
    const output = { args: { unity_instance: 'Other@abc', types: ['error'] } };
    await run.hooks['tool.execute.before']({ tool: 'unityMCP_read_console' }, output);
    assert.deepEqual(output.args, { types: ['error'], action: 'get' });
    await run.runtime.log.flush();
    const record = run.appended.map((line) => JSON.parse(line)).find((entry) => entry.event === 'mcpArgs');
    assert.equal(record?.changes, 'unity_instance,action');
    assert.ok(!JSON.stringify(record).includes('Other@abc'));
  });

  it('refuses a tool outside the allow-list and a clearing console call, and logs the refusal', async () => {
    const run = await createRuntime();
    const denied = await run.hooks['tool.execute.before']({ tool: 'unityMCP_manage_scene' }, { args: {} }).catch((value) => value);
    assert.equal(denied?.code, 'mcp_tool_denied');
    const clearing = await run.hooks['tool.execute.before']({ tool: 'UNITYMCP_read_console' }, { args: { action: 'clear' } }).catch((value) => value);
    assert.equal(clearing?.code, 'mcp_console_action');
    await run.runtime.log.flush();
    const blocked = run.appended.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'mcpBlocked');
    assert.deepEqual(blocked.map((entry) => entry.code), ['mcp_tool_denied', 'mcp_console_action']);
    assert.ok(blocked.every((entry) => entry.reason === undefined), 'the code is logged, the message is not');
  });

  it('holds the policy even when the runtime profile is missing, because no provider is not the same as no hub', async () => {
    const run = await createRuntime({ files: {} });
    assert.equal(run.runtime.profile, null);
    const error = await run.hooks['tool.execute.before']({ tool: 'unityMCP_run_tests' }, { args: { mode: 'EditMode' } }).catch((value) => value);
    assert.equal(error?.code, 'mcp_test_filter');
  });

  it('allows PlayMode only for a project whose local.json turned it on', async () => {
    const args = () => ({ mode: 'PlayMode', test_names: ['Game.Tests.Smoke'] });
    const strict = await createRuntime();
    const refused = await strict.hooks['tool.execute.before']({ tool: 'unityMCP_run_tests' }, { args: args() }).catch((value) => value);
    assert.equal(refused?.code, 'mcp_test_mode');

    const trusted = await createRuntime({
      files: {
        [PROFILE_PATH]: renderRuntimeProfile(buildTestProfile()),
        [`${TEST_HOME}/projects/${PROJECT_ID}/local.json`]: JSON.stringify({ editor: { allowPlayMode: true } }),
      },
      env: { OPENCODE_UNITY_PROJECT: PROJECT_ID },
    });
    const output = { args: args() };
    await trusted.hooks['tool.execute.before']({ tool: 'unityMCP_run_tests' }, output);
    assert.equal(output.args.mode, 'PlayMode');
  });

  it('gives a runtime that carries no policy the strictest one', async () => {
    const run = await createRuntime();
    const { mcpArgs: _dropped, ...bare } = run.runtime;
    const hooks = createHooks(/** @type {any} */ (bare), { env: {}, userHome: '/opt/home' });
    const error = await hooks['tool.execute.before']({ tool: 'unityMCP_execute_code' }, { args: {} }).catch((value) => value);
    assert.equal(error?.code, 'mcp_tool_denied');
  });
});

describe('shell environment hook', () => {
  it('restores the shell environment for agent commands', async () => {
    const { runtime } = await createRuntime();
    const hooks = createHooks(runtime, { env: { OPENCODE_UNITY_ORIGINAL_XDG_CONFIG_HOME: '/opt/config' }, userHome: '/opt/home' });
    const output = { env: /** @type {Record<string, string>} */ ({ PATH: '/usr/bin' }) };
    await hooks['shell.env']({ cwd: '/opt/project' }, output);
    assert.equal(output.env.XDG_CONFIG_HOME, '/opt/config');
    assert.equal(output.env.DOTNET_CLI_TELEMETRY_OPTOUT, '1');
  });
});

describe('detection hooks', () => {
  it('calibrates from real usage and warns once the prompt was cut', async () => {
    const run = await createRuntime();
    run.runtime.budget.recordSystemChars('s1', 7000);
    run.runtime.budget.preflight({ sessionId: 's1', agent: 'unity-code' });
    await run.hooks.event({ event: { type: 'message.updated', properties: { info: { role: 'assistant', sessionID: 's1', agent: 'unity-code', tokens: { input: 8194 } } } } });
    await run.runtime.log.flush();
    assert.ok(run.runtime.budget.get('s1').calibration !== 1);
    assert.ok(events(run.appended).includes('truncation'));
    assert.match(run.toasts.at(-1).message, /was cut to fit/);
  });

  it('says nothing about an ordinary response', async () => {
    const run = await createRuntime();
    await run.hooks.event({ event: { type: 'message.updated', properties: { info: { role: 'assistant', sessionID: 's1', tokens: { input: 4000 } } } } });
    await run.runtime.log.flush();
    assert.ok(!events(run.appended).includes('truncation'));
    assert.equal(run.toasts.length, 0);
  });

  it('warns when the model wrote a tool call as text', async () => {
    const run = await createRuntime();
    await run.hooks['experimental.text.complete']({}, { text: 'I will <function=read>...' });
    await run.hooks['experimental.text.complete']({}, { text: 'Here is the patch.' });
    await run.runtime.log.flush();
    assert.deepEqual(events(run.appended).filter((event) => event === 'textToolCall'), ['textToolCall']);
    assert.match(run.toasts[0].message, /wrote a tool call as text/);
  });

  it('never lets a broken event fail the session', async () => {
    const run = await createRuntime();
    await assert.doesNotReject(run.hooks.event({ event: { type: 'message.updated', properties: null } }));
    await assert.doesNotReject(run.hooks['experimental.text.complete']({}, {}));
    await assert.doesNotReject(run.hooks['experimental.chat.messages.transform']({}, {}));
  });
});

describe('project context', () => {
  it('reads the version control kind and the hub URL the project recorded', async () => {
    const files = {
      [`${TEST_HOME}/projects/${PROJECT_ID}/project.json`]: JSON.stringify({ vcs: { kind: 'plastic' } }),
      [`${TEST_HOME}/projects/${PROJECT_ID}/local.json`]: JSON.stringify({ mcpForUnity: { hubUrl: 'http://127.0.0.1:8080/mcp' } }),
    };
    const { fs } = createFakeFs(files);
    const context = await readProjectContext({ home: TEST_HOME, projectId: PROJECT_ID, fsImpl: fs });
    assert.deepEqual(context, { vcsKind: 'plastic', hubUrl: 'http://127.0.0.1:8080/mcp', editor: { allowPlayMode: false } });
  });

  it('accepts the flat hub spelling and a byte order mark', async () => {
    const files = { [`${TEST_HOME}/projects/${PROJECT_ID}/local.json`]: `﻿${JSON.stringify({ hubUrl: 'http://127.0.0.1:8080/mcp' })}` };
    const { fs } = createFakeFs(files);
    const context = await readProjectContext({ home: TEST_HOME, projectId: PROJECT_ID, fsImpl: fs });
    assert.equal(context.hubUrl, 'http://127.0.0.1:8080/mcp');
  });

  it('stays in its strictest state when the files are missing, broken or nameless', async () => {
    const broken = createFakeFs({ [`${TEST_HOME}/projects/${PROJECT_ID}/project.json`]: '{ not json' });
    assert.deepEqual(await readProjectContext({ home: TEST_HOME, projectId: PROJECT_ID, fsImpl: broken.fs }), STRICTEST_CONTEXT);

    const none = createFakeFs({ [`${TEST_HOME}/projects/${PROJECT_ID}/project.json`]: JSON.stringify({ vcs: { kind: 'none' } }) });
    assert.deepEqual(await readProjectContext({ home: TEST_HOME, projectId: PROJECT_ID, fsImpl: none.fs }), STRICTEST_CONTEXT);

    assert.deepEqual(await readProjectContext({ home: null, projectId: PROJECT_ID, fsImpl: none.fs }), STRICTEST_CONTEXT);
    assert.deepEqual(await readProjectContext({ home: TEST_HOME, projectId: null, fsImpl: none.fs }), STRICTEST_CONTEXT);
  });

  it('writes no log at all when there is no home to write into', async () => {
    const profileText = renderRuntimeProfile(buildTestProfile());
    const fake = createFakeFs({ [PROFILE_PATH]: profileText });
    const runtime = await createPluginRuntime({ env: {}, platform: 'linux', profilePath: PROFILE_PATH, fsImpl: fake.fs, evaluate: async () => verdict() });
    runtime.log.append({ event: 'request' });
    await runtime.log.flush();
    assert.deepEqual(fake.appended, []);
  });
});

describe('the shell guard a blocked command reports', () => {
  it('names no version control client when the project has none', async () => {
    const run = await createRuntime();
    const error = catchError(() => run.runtime.shell.check({ command: 'git status' }));
    assert.match(error.message, /no git working copy was detected/);
  });
});
