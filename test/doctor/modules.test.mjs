// The small I/O modules behind the doctor context, each with injected runners and file readers so no
// test starts a real process or depends on the host's installation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { listCloudCredentialNames, listCloudCredentialValues } from '../../src/doctor/cloud-keys.js';
import { DEEP_TIMEOUT_MS, parseJsonObject, runDeepProbes } from '../../src/doctor/deep.js';
import { buildQuery, parseCount, readDriverResets } from '../../src/doctor/driver-resets.js';
import { effectiveLayers, hasMergedConfig, layerLabel } from '../../src/doctor/layers.js';
import { LOG_CHECKS } from '../../src/doctor/checks/logs.js';
import { JOURNAL_LINES, RECENT_WINDOW_MS, describeLogSource, logFix, readLogSource } from '../../src/doctor/logs.js';
import { resolveGlobalPrefix } from '../../src/doctor/node-install.js';
import { BINARY_ENV_NAME, locateOpencode, parseVersion, readOpencodeVersion, resolveShimTarget } from '../../src/doctor/opencode-binary.js';
import {
  collectConfigLayers,
  createReadIo,
  listHomeConfigPaths,
  listMcpEntries,
  listModelEntries,
  listPermissionBlocks,
  listProjectConfigPaths,
  listUserConfigPaths,
} from '../../src/doctor/opencode-config.js';
import { useSandbox } from '../helpers/sandbox.mjs';
import { makeContext } from './helpers.mjs';

/**
 * @param {Partial<import('../../src/core/exec.js').RunResult>} result
 * @returns {import('../../src/core/exec.js').RunResult}
 */
function runResult(result) {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, error: null, durationMs: 1, ...result };
}

/**
 * A runner that records calls and answers from a table keyed by the first argument.
 * @param {Record<string, Partial<import('../../src/core/exec.js').RunResult>>} answers
 */
function fakeRun(answers) {
  /** @type {Array<{ file: string, args: string[], options: any }>} */
  const calls = [];
  const run = async (/** @type {string} */ file, /** @type {string[]} */ args, /** @type {any} */ options) => {
    calls.push({ file, args: [...args], options });
    return runResult(answers[args.join(' ')] ?? answers['*'] ?? {});
  };
  return { run: /** @type {any} */ (run), calls };
}

describe('opencode binary', () => {
  it('parses a version from the first line OpenCode prints', () => {
    assert.equal(parseVersion('opencode 1.18.31'), '1.18.31');
    assert.equal(parseVersion('1.19.0-beta.2'), '1.19.0-beta.2');
    assert.equal(parseVersion('no version here'), null);
  });

  it('prefers the test override, then PATH', () => {
    assert.equal(locateOpencode({ env: { [BINARY_ENV_NAME]: ' /opt/oc ' }, locate: () => 'never' }), '/opt/oc');
    assert.equal(locateOpencode({ env: {}, platform: 'linux', locate: () => '/usr/bin/opencode' }), '/usr/bin/opencode');
    assert.equal(locateOpencode({ env: {}, locate: () => null }), null);
  });

  it('replaces the npm .cmd shim with the executable its package declares on Windows (spec 13.1)', () => {
    const prefix = path.win32.join('Z:', 'npm');
    const shim = path.win32.join(prefix, 'opencode.cmd');
    const packageDir = path.win32.join(prefix, 'node_modules', 'opencode-ai');
    const declared = path.win32.join(packageDir, 'bin', 'opencode-binary');
    const manifest = JSON.stringify({ bin: { opencode: './bin/opencode-binary' } });
    const readText = (/** @type {string} */ target) => (target === path.win32.join(packageDir, 'package.json') ? manifest : null);
    const env = { PATHEXT: '.COM;.CMD' };
    assert.equal(resolveShimTarget(shim, { env, platform: 'win32', isFile: (candidate) => candidate === declared, readText }), declared);
    assert.equal(resolveShimTarget(shim, { env, platform: 'win32', isFile: () => false, readText }), shim);
  });

  it('falls back to bin/opencode through PATHEXT when the manifest cannot be read, and never returns a shim', () => {
    const packageDir = path.win32.join('Z:', 'npm', 'node_modules', 'opencode-ai');
    const viaPathext = path.win32.join(packageDir, 'bin', 'opencode.COM');
    const shim = path.win32.join('Z:', 'npm', 'opencode.cmd');
    const env = { PATHEXT: '.COM;.CMD' };
    assert.equal(resolveShimTarget(shim, { env, platform: 'win32', isFile: (candidate) => candidate === viaPathext, readText: () => '{ broken' }), viaPathext);
    const onlyShim = path.win32.join(packageDir, 'bin', 'opencode.CMD');
    assert.equal(resolveShimTarget(shim, { env, platform: 'win32', isFile: (candidate) => candidate === onlyShim, readText: () => null }), shim);
    assert.equal(resolveShimTarget(shim, { env, platform: 'win32', isFile: () => false, readText: () => JSON.stringify({ bin: 'bin/x' }) }), shim);
  });

  it('leaves anything that is not a Windows shim alone', () => {
    const probes = { env: {}, isFile: () => true, readText: () => null };
    assert.equal(resolveShimTarget('/usr/bin/opencode.cmd', { ...probes, platform: 'linux' }), '/usr/bin/opencode.cmd');
    const direct = path.win32.join('Z:', 'bin', 'opencode');
    assert.equal(resolveShimTarget(direct, { ...probes, platform: 'win32' }), direct);
  });

  it('reads the version, and says why when it cannot', async () => {
    const locate = () => '/bin/opencode';
    const ok = fakeRun({ '--version': { stdout: 'opencode 1.18.31\n' } });
    assert.deepEqual(await readOpencodeVersion({ env: {}, platform: 'linux', run: ok.run, locate }), { path: '/bin/opencode', version: '1.18.31', error: null });
    assert.match((await readOpencodeVersion({ env: {}, run: ok.run, locate: () => null })).error ?? '', /not on PATH/);
    const spawnError = fakeRun({ '*': { error: new Error('spawn EACCES'), exitCode: null } });
    assert.equal((await readOpencodeVersion({ env: {}, run: spawnError.run, locate })).error, 'spawn EACCES');
    const slow = fakeRun({ '*': { timedOut: true, exitCode: null } });
    assert.match((await readOpencodeVersion({ env: {}, run: slow.run, locate })).error ?? '', /timed out/);
    const failed = fakeRun({ '*': { exitCode: 3 } });
    assert.match((await readOpencodeVersion({ env: {}, run: failed.run, locate })).error ?? '', /exited 3/);
    const silent = fakeRun({ '*': { stdout: 'hello\n' } });
    assert.match((await readOpencodeVersion({ env: {}, run: silent.run, locate })).error ?? '', /printed no version/);
  });
});

describe('--deep probes', () => {
  it('runs debug config and debug agent and parses both', async () => {
    const { run, calls } = fakeRun({
      'debug config': { stdout: '{"model":"x"}' },
      'debug agent unity-code': { stdout: 'banner line\n{"permission":[]}' },
    });
    const result = await runDeepProbes({ binary: { path: '/bin/opencode', version: '1.18.31', error: null }, env: {}, platform: 'linux', cwd: '/p', run });
    assert.equal(result.ok, true);
    assert.deepEqual(result.config.value, { model: 'x' });
    assert.deepEqual(result.agents[0].value, { permission: [] });
    assert.equal(calls[0].options.timeoutMs, DEEP_TIMEOUT_MS);
    assert.equal(calls[0].options.cwd, '/p');
  });

  it('reports each failure instead of throwing', async () => {
    const { run } = fakeRun({
      'debug config': { exitCode: 1, stderr: 'Model not found\nmore' },
      'debug agent unity-code': { timedOut: true, exitCode: null },
    });
    const result = await runDeepProbes({ binary: { path: '/bin/opencode', version: null, error: null }, env: {}, platform: 'linux', run });
    assert.equal(result.ok, false);
    assert.equal(result.config.error, 'Model not found');
    assert.match(result.agents[0].error ?? '', /timed out/);
    const spawn = fakeRun({ '*': { error: new Error('spawn ENOENT'), exitCode: null } });
    assert.equal((await runDeepProbes({ binary: { path: 'x', version: null, error: null }, env: {}, platform: 'linux', run: spawn.run })).config.error, 'spawn ENOENT');
    const garbage = fakeRun({ '*': { stdout: 'not json' } });
    assert.match((await runDeepProbes({ binary: { path: 'x', version: null, error: null }, env: {}, platform: 'linux', run: garbage.run })).config.error ?? '', /not a JSON object/);
  });

  it('does not start anything without a binary', async () => {
    const { run, calls } = fakeRun({});
    const result = await runDeepProbes({ binary: { path: null, version: null, error: 'x' }, env: {}, platform: 'linux', run });
    assert.equal(calls.length, 0);
    assert.equal(result.ok, false);
    assert.equal(result.agents.length, 1);
  });

  it('parses only JSON objects', () => {
    assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
    assert.equal(parseJsonObject('[1]'), null);
    assert.equal(parseJsonObject('{broken'), null);
    assert.equal(parseJsonObject('nothing'), null);
  });

  it('feeds the merged config to the checks as the last layer', () => {
    const deep = { config: { label: 'debug config', args: [], exitCode: 0, value: { a: 1 }, error: null }, agents: [], ok: true };
    const context = makeContext({ opencode: { deep } });
    const layers = effectiveLayers(context);
    assert.equal(layers.at(-1)?.origin, 'deep');
    assert.equal(hasMergedConfig(context), true);
    assert.equal(layerLabel(/** @type {any} */ (layers.at(-1))), 'opencode debug config');
    assert.equal(hasMergedConfig(makeContext()), false);
  });
});

describe('server log source', () => {
  const file = { kind: /** @type {const} */ ('file'), path: '/logs/server.log', rotation: 'server-*.log' };
  const journal = { kind: /** @type {const} */ ('journal'), unit: 'ollama', command: ['journalctl', '-u', 'ollama', '--no-pager'] };
  const now = Date.parse('2026-09-18T10:00:00.000Z');
  const oldLine = 'time=2026-08-01T09:00:00.000Z level=WARN source=runner.go:1 msg="truncating input prompt" limit=16384 prompt=20000 keep=4 new=8194\n';
  const newLine = 'time=2026-09-17T09:00:00.000Z level=WARN source=runner.go:1 msg="truncating input prompt" limit=16384 prompt=18000 keep=4 new=8194\n';

  it('never reports "none" as read', async () => {
    const reading = await readLogSource({ source: { kind: 'none' } });
    assert.equal(reading.read, false);
    assert.equal(reading.summary, null);
  });

  it('treats a missing file as not checked and a read error as not checked', async () => {
    assert.match((await readLogSource({ source: file, readFile: async () => null })).unreadableReason ?? '', /does not exist/);
    assert.equal((await readLogSource({ source: file, readFile: async () => { throw new Error('EACCES'); } })).unreadableReason, 'EACCES');
  });

  it('summarizes the whole log and the recent window separately', async () => {
    const reading = await readLogSource({ source: file, readFile: async () => oldLine + newLine, nowMs: now });
    assert.equal(reading.read, true);
    assert.equal(reading.summary?.truncations, 2);
    assert.equal(reading.recent?.truncations, 1);
    assert.ok(RECENT_WINDOW_MS > 0);
  });

  it('reads the journal with a line limit, and explains a refusal', async () => {
    const ok = fakeRun({ '*': { stdout: newLine } });
    const reading = await readLogSource({ source: journal, run: ok.run, nowMs: now });
    assert.equal(reading.read, true);
    assert.deepEqual(ok.calls[0].args.slice(-2), ['-n', String(JOURNAL_LINES)]);
    assert.equal(ok.calls[0].file, 'journalctl');

    const denied = fakeRun({ '*': { exitCode: 1, stderr: 'No journal files were opened due to insufficient permissions.' } });
    assert.match((await readLogSource({ source: journal, run: denied.run })).unreadableReason ?? '', /insufficient permissions/);
    const slow = fakeRun({ '*': { timedOut: true, exitCode: null } });
    assert.match((await readLogSource({ source: journal, run: slow.run })).unreadableReason ?? '', /timed out/);
    const missing = fakeRun({ '*': { error: new Error('spawn journalctl ENOENT'), exitCode: null } });
    assert.match((await readLogSource({ source: journal, run: missing.run })).unreadableReason ?? '', /ENOENT/);
  });

  it('reads the journal as bare messages, so Linux judges the log exactly as a file (33.8)', async () => {
    const text = await fs.readFile(new URL('../fixtures/ollama/server-log-truncation.txt', import.meta.url), 'utf8');
    // journalctl's default `short` mode puts a date, the host and the unit in front of every line.
    const short = text.split('\n').map((line) => (line === '' ? line : `Sep 17 11:00:00 host ollama[1234]: ${line}`)).join('\n');
    /** @type {string[][]} */
    const calls = [];
    const run = /** @type {any} */ (async (/** @type {string} */ _file, /** @type {string[]} */ args) => {
      calls.push(args);
      const cat = args.includes('--output=cat') || args.join(' ').includes('-o cat');
      return runResult({ stdout: cat ? text : short });
    });
    const nowMs = Date.parse('2026-10-30T00:00:00Z');
    const fromFile = await readLogSource({ source: file, readFile: async () => text, nowMs });
    assert.equal(LOG_CHECKS.find((check) => check.id === 'logs.sampling-default')?.run(/** @type {any} */ ({ logs: fromFile })).severity, 'warn', 'the fixture has requests at the sampler defaults');
    for (const source of [journal, { ...journal, command: ['journalctl', '-u', 'ollama', '--no-pager', '-o', 'cat'] }]) {
      const fromJournal = await readLogSource({ source, run, nowMs });
      for (const check of LOG_CHECKS) {
        const expected = check.run(/** @type {any} */ ({ logs: fromFile }));
        const actual = check.run(/** @type {any} */ ({ logs: fromJournal }));
        assert.equal(actual.severity, expected.severity, check.id);
        assert.equal(actual.message, expected.message, check.id);
      }
    }
    assert.ok(calls.every((args) => args.filter((arg) => arg === '--output=cat' || arg === '-o').length === 1), 'the output mode is asked for once');
  });

  it('names the source and the platform fix', () => {
    assert.equal(describeLogSource(file), '/logs/server.log');
    assert.match(describeLogSource(journal), /systemd journal/);
    assert.equal(describeLogSource({ kind: 'none' }), 'none');
    assert.match(logFix(journal), /systemd-journal group/);
    assert.match(logFix(file), /--logs/);
  });
});

describe('global npm prefix', () => {
  it('derives the prefix from the Node installation on each platform', () => {
    const posix = resolveGlobalPrefix({ env: {}, platform: 'linux', execPath: '/usr/local/bin/node', exists: () => true, isWritable: () => false });
    assert.equal(posix.prefix, '/usr/local');
    assert.equal(posix.modulesDir, '/usr/local/lib/node_modules');
    assert.equal(posix.writable, false);
    const windows = resolveGlobalPrefix({ env: {}, platform: 'win32', execPath: 'C:\\node\\node.exe', exists: () => true, isWritable: () => true });
    assert.equal(windows.modulesDir, 'C:\\node\\node_modules');
  });

  it('honours an explicit prefix and judges a missing directory by its nearest existing parent', () => {
    const result = resolveGlobalPrefix({
      env: { npm_config_prefix: '/opt/tools/.npm-global' },
      platform: 'linux',
      execPath: '/usr/bin/node',
      exists: (target) => target === '/opt/tools',
      isWritable: (target) => target === '/opt/tools',
    });
    assert.equal(result.prefix, '/opt/tools/.npm-global');
    assert.equal(result.checkedPath, '/opt/tools');
    assert.equal(result.writable, true);
    assert.match(result.source, /npm_config_prefix/);
  });

  it('stops at the filesystem root', () => {
    const result = resolveGlobalPrefix({ env: { PREFIX: '/nowhere/deep' }, platform: 'linux', exists: () => false, isWritable: () => false });
    assert.equal(result.checkedPath, '/');
  });

  it('checks a real directory with the default file system probes', async (t) => {
    const sandbox = await useSandbox(t, 'doctor-prefix');
    const prefix = sandbox.path('prefix');
    await fs.mkdir(prefix, { recursive: true });
    const result = resolveGlobalPrefix({ env: { npm_config_prefix: prefix }, platform: process.platform });
    assert.equal(result.checkedPath, prefix);
    assert.equal(result.writable, true);
  });
});

describe('opencode binary on disk', () => {
  it('finds the executable behind a real npm shim', { skip: process.platform !== 'win32' }, async (t) => {
    const sandbox = await useSandbox(t, 'doctor-shim');
    const shim = sandbox.path('npm', 'opencode.cmd');
    const packageDir = sandbox.path('npm', 'node_modules', 'opencode-ai');
    const target = path.join(packageDir, 'bin', 'opencode-binary');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(shim, '@echo off\n');
    await fs.writeFile(target, '');
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ bin: { opencode: './bin/opencode-binary' } }));
    assert.equal(locateOpencode({ env: {}, platform: 'win32', locate: () => shim }), target);
  });
});

describe('driver resets', () => {
  it('is not checked off Windows and starts nothing', async () => {
    const { run, calls } = fakeRun({});
    assert.deepEqual(await readDriverResets({ platform: 'linux', env: {}, nowMs: 0, run }), { checked: false, events: 0, since: null, error: null });
    assert.equal(calls.length, 0);
  });

  const locate = () => 'resolved-powershell';

  it('counts events from the read-only query on Windows', async () => {
    const { run, calls } = fakeRun({ '*': { stdout: '3\r\n' } });
    const reading = await readDriverResets({ platform: 'win32', env: {}, nowMs: Date.parse('2026-09-18T00:00:00.000Z'), run, locate });
    assert.deepEqual(reading, { checked: true, events: 3, since: '2026-09-11T00:00:00.000Z', error: null });
    assert.equal(calls[0].file, 'resolved-powershell');
    assert.ok(calls[0].args.includes('-NoProfile'));
  });

  it('reports every failure as not checked', async () => {
    for (const answer of [{ error: new Error('spawn ENOENT'), exitCode: null }, { timedOut: true, exitCode: null }, { exitCode: 1 }, { stdout: 'nothing' }]) {
      const { run } = fakeRun({ '*': answer });
      const reading = await readDriverResets({ platform: 'win32', env: {}, nowMs: 0, run, locate });
      assert.equal(reading.checked, false);
      assert.ok(reading.error);
    }
    const missing = await readDriverResets({ platform: 'win32', env: {}, nowMs: 0, run: fakeRun({}).run, locate: () => null });
    assert.match(missing.error ?? '', /not on PATH/);
  });

  it('builds a query for one provider over seven days and parses its count', () => {
    assert.match(buildQuery(), /ProviderName='nvlddmkm'/);
    assert.match(buildQuery(), /AddDays\(-7\)/);
    assert.equal(parseCount(' 12 '), 12);
    assert.equal(parseCount('-1'), null);
    assert.equal(parseCount(''), null);
  });
});

describe('cloud credentials', () => {
  it('matches the spec 8.1 names and never an empty value', () => {
    const env = { OPENAI_API_KEY: 'a', GH_TOKEN: 'b', AZURE_OPENAI_ENDPOINT: 'c', MY_ACCESS_TOKEN: 'd', AWS_PROFILE: 'e', UNRELATED: 'f', EMPTY_API_KEY: '', HF_TOKEN: 'g' };
    assert.deepEqual(listCloudCredentialNames(env), ['AWS_PROFILE', 'AZURE_OPENAI_ENDPOINT', 'GH_TOKEN', 'HF_TOKEN', 'MY_ACCESS_TOKEN', 'OPENAI_API_KEY']);
    assert.deepEqual(listCloudCredentialValues({ OPENAI_API_KEY: 'secret', UNRELATED: 'x' }), ['secret']);
  });
});

describe('OpenCode configuration layers', () => {
  it('lists the user, home and project candidates in merge order', () => {
    const env = { XDG_CONFIG_HOME: path.join(path.sep, 'xdg'), HOME: path.join(path.sep, 'h') };
    assert.deepEqual(listUserConfigPaths(env), [path.join(path.sep, 'xdg', 'opencode', 'opencode.jsonc'), path.join(path.sep, 'xdg', 'opencode', 'opencode.json')]);
    assert.deepEqual(listUserConfigPaths({ OPENCODE_CONFIG: 'custom.json' }), [path.resolve('custom.json')]);
    assert.deepEqual(listUserConfigPaths({}), []);
    assert.equal(listHomeConfigPaths({ USERPROFILE: path.join(path.sep, 'u') })[0], path.join(path.sep, 'u', '.opencode', 'opencode.jsonc'));
    assert.deepEqual(listHomeConfigPaths({}), []);
  });

  it('walks project files from the worktree root inward and stops there', () => {
    const project = path.resolve(path.sep, 'repo', 'client');
    const paths = listProjectConfigPaths(project, path.resolve(path.sep, 'repo'));
    assert.equal(paths[0], path.resolve(path.sep, 'repo', 'opencode.jsonc'));
    assert.equal(paths.at(-1), path.join(project, '.opencode', 'opencode.json'));
    assert.equal(paths.length, 8);
    assert.ok(listProjectConfigPaths(project).length >= 8);
  });

  it('reads real files, records a broken one, and reads only the profile with --profile', async (t) => {
    const sandbox = await useSandbox(t, 'doctor-layers');
    const project = sandbox.path('repo', 'client');
    await fs.mkdir(path.join(project, '.opencode'), { recursive: true });
    await fs.mkdir(path.join(sandbox.dirs.xdgConfig, 'opencode'), { recursive: true });
    await fs.writeFile(path.join(sandbox.dirs.xdgConfig, 'opencode', 'opencode.jsonc'), '// user\n{ "provider": { "p": { "models": { "m": { "limit": { "context": 1, "output": 0 } } } } } }');
    await fs.writeFile(path.join(project, 'opencode.json'), '{ "mcp": { "hub": { "url": "http://127.0.0.1:8080/mcp" } }, "agent": { "build": { "permission": { "bash": "allow" } } } }');
    await fs.writeFile(path.join(project, '.opencode', 'opencode.json'), '{ broken');
    await fs.writeFile(sandbox.path('array.json'), '[1, 2]');
    const io = createReadIo();
    const layers = collectConfigLayers({ env: sandbox.env, projectPath: project, profileConfigPath: null, worktreeRoot: sandbox.path('repo'), io });
    assert.deepEqual(layers.layers.map((layer) => layer.origin), ['user', 'project', 'project-dir']);
    assert.match(layers.layers[2].error ?? '', /./);
    assert.equal(listModelEntries(layers.layers)[0].modelId, 'm');
    assert.equal(listMcpEntries(layers.layers)[0].key, 'hub');
    assert.equal(listPermissionBlocks(layers.layers)[0].agent, 'build');

    const profile = collectConfigLayers({ env: sandbox.env, projectPath: project, profileConfigPath: sandbox.path('array.json'), io });
    assert.equal(profile.target, 'profile');
    assert.equal(profile.layers[0].error, 'the file is not a JSON object');
    const missing = collectConfigLayers({ env: sandbox.env, projectPath: null, profileConfigPath: sandbox.path('absent.jsonc'), io });
    assert.deepEqual(missing.layers, []);
    assert.match(missing.warnings[0], /opencode-unity setup/);
  });

  it('ignores values that are not objects in the provider, mcp and agent maps', () => {
    const layers = [{ path: 'x', origin: /** @type {const} */ ('user'), value: { provider: { p: 'text', q: { models: [1] } }, mcp: null, agent: { a: 3 }, permission: 'deny' }, error: null }];
    assert.deepEqual(listModelEntries(layers), []);
    assert.deepEqual(listMcpEntries(layers), []);
    assert.deepEqual(listPermissionBlocks(layers).map((block) => block.permission), [{}]);
  });
});
