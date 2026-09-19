import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { run } from '../../src/commands/delegate.js';
import { parseArgv } from '../../src/cli/args.js';
import { loadConfig } from '../../src/core/config.js';
import { acquireGpuLock, readGpuLock } from '../../src/core/lock.js';
import { markActive, monitorPaths, readDelegateStatus, renderDelegateStatus, watchDelegate } from '../../src/delegate/monitor.js';
import { buildMonitorLaunch, openDelegateWindow } from '../../src/terminal/delegate-window.js';
import { createCliContext, createHarness, createProbes, reply } from './helpers.mjs';

describe('user delegation controls', () => {
  it('parses the public commands and rejects invalid monitor preferences', () => {
    for (const name of ['on', 'off', 'status', 'monitor']) assert.equal(parseArgv(['delegate', name]).subcommand.name, name);
    assert.equal(parseArgv(['delegate', 'monitor', '--auto', 'on']).options.auto, 'on');
    assert.throws(() => parseArgv(['delegate', 'monitor', '--auto', 'maybe']));
  });

  it('persists off, refuses health and jobs before model calls, and still reads status and history', async (t) => {
    const h = await createHarness(t, { config: { guard: { allowOffload: true } }, renderProfile: false });
    const before = JSON.parse(await fs.readFile(h.paths.config, 'utf8'));
    assert.equal((await h.run('off')).exitCode, 0);
    for (const name of ['health', 'ask', 'map', 'edit', 'apply']) {
      const result = await h.run(name, { options: { task: 'do nothing' } });
      assert.equal(result.exitCode, 8);
      assert.equal(result.data.orchestratorAction, 'do_it_yourself');
    }
    assert.equal((await h.run('status')).data.enabled, false);
    assert.equal((await h.run('ledger')).exitCode, 0);
    assert.deepEqual(h.ollama.requests, []);
    const stored = JSON.parse(await fs.readFile(h.paths.config, 'utf8'));
    assert.deepEqual(stored, { ...before, delegate: { enabled: false } });
    assert.equal((await h.run('on')).exitCode, 0);
    h.ollama.enqueueChat(reply('works again'));
    assert.equal((await h.run('ask', { options: { task: 'hello' } })).exitCode, 0);
  });

  it('allows backup restoration while switched off', async (t) => {
    const h = await createHarness(t, { config: { delegate: { enabled: false } } });
    const result = await h.run('restore', { args: { jobId: 'missing' } });
    assert.notEqual(result.code, 'delegate_unsupported');
    assert.deepEqual(h.ollama.requests, []);
  });

  it('changes monitor preference without enabling delegation or contacting Ollama', async (t) => {
    const h = await createHarness(t, { config: { delegate: { enabled: false, temperature: 0.4 } }, renderProfile: false });
    assert.equal((await h.run('monitor', { options: { auto: 'on' } })).exitCode, 0);
    let config = (await loadConfig(h.paths.config)).config;
    assert.equal(config.delegate.monitorWindow, true);
    assert.equal(config.delegate.enabled, false);
    assert.equal(config.delegate.temperature, 0.4);
    await h.run('monitor', { options: { auto: 'off' } });
    config = (await loadConfig(h.paths.config)).config;
    assert.equal(config.delegate.monitorWindow, false);
    assert.deepEqual(h.ollama.requests, []);
    assert.equal((await h.run('monitor', { options: { auto: 'on', window: true } })).exitCode, 1);
  });

  it('honours dry-run without writing config or opening a window', async (t) => {
    const h = await createHarness(t);
    const before = await fs.readFile(h.paths.config, 'utf8');
    for (const [subcommand, options] of [['off', {}], ['monitor', { auto: 'on' }], ['monitor', { window: true }]]) {
      const cli = createCliContext({ sandbox: h.sandbox, cwd: h.cwd, subcommand, options });
      cli.global.dryRun = true;
      await run(cli);
    }
    assert.equal(await fs.readFile(h.paths.config, 'utf8'), before);
  });
});

describe('delegate monitor', () => {
  it('shows live and interrupted metadata, strips control characters, and has no prompts', async (t) => {
    const h = await createHarness(t);
    const job = { id: 'job-1', command: 'ask', cwd: 'work\x1b[2J', startedMs: 1000 };
    const clear = await markActive(h.paths.delegateLedger, job, 'local-model');
    let state = await readDelegateStatus(h.paths, { now: () => 4000, isAlive: () => true });
    assert.equal(state.active[0].state, 'running');
    assert.equal(state.active[0].seconds, 3);
    assert.equal(JSON.stringify(state).includes('prompt'), false);
    assert.equal(renderDelegateStatus(state).includes('\x1b'), false);
    state = await readDelegateStatus(h.paths, { isAlive: () => false });
    assert.equal(state.active[0].state, 'interrupted');
    await clear();
    assert.deepEqual((await readDelegateStatus(h.paths)).active, []);
  });

  it('exposes a job while running, then removes its marker and records the outcome even if window launch fails', async (t) => {
    const h = await createHarness(t, { config: { delegate: { monitorWindow: true } } });
    h.ollama.enqueueChat(reply('done'));
    const cli = createCliContext({ sandbox: h.sandbox, cwd: h.cwd, subcommand: 'ask', options: { task: 'hello' } });
    let opened = 0;
    const result = await run(cli, { probes: createProbes(), openWindow: async () => {
      opened++;
      assert.equal((await readDelegateStatus(h.paths)).active.length, 1);
      throw new Error('window unavailable');
    } });
    assert.equal(opened, 1);
    assert.equal(result.exitCode, 0);
    assert.match(result.warnings.join('\n'), /window unavailable/);
    const state = await readDelegateStatus(h.paths);
    assert.deepEqual(state.active, []);
    assert.equal(state.recent.at(-1).status, 'ok');
  });

  it('does not open a window without opt-in and clears markers on refusal', async (t) => {
    const h = await createHarness(t);
    const cli = createCliContext({ sandbox: h.sandbox, cwd: h.cwd, subcommand: 'ask', options: { task: 'hello' } });
    const result = await run(cli, { probes: createProbes({ blocked: true }), openWindow: async () => { assert.fail('not opted in'); } });
    assert.notEqual(result.exitCode, 0);
    assert.deepEqual((await readDelegateStatus(h.paths)).active, []);
    assert.equal((await readDelegateStatus(h.paths)).recent.length, 1);
  });

  it('watches offline while disabled, holds one monitor lease, then releases it on stop', async (t) => {
    const h = await createHarness(t, { config: { delegate: { enabled: false } } });
    const cli = createCliContext({ sandbox: h.sandbox, cwd: h.cwd, subcommand: 'monitor' });
    const lines = [];
    cli.output.text = (text) => lines.push(text);
    await watchDelegate(cli, h.paths, { maxPolls: 2, sleep: async () => {
      assert.equal(readGpuLock(monitorPaths(h.paths.delegateLedger).lock).state, 'held');
      await assert.rejects(watchDelegate(cli, h.paths, { maxPolls: 1 }), { code: 'lock_timeout' });
    } });
    assert.match(lines[0], /Delegation: OFF/);
    assert.equal(readGpuLock(monitorPaths(h.paths.delegateLedger).lock).state, 'free');
    assert.deepEqual(h.ollama.requests, []);
  });

  it('passes metacharacters as environment data and disables CMD delayed expansion', () => {
    const launch = buildMonitorLaunch('C:\\node & tools\\node.exe', 'C:\\50% !special!\\tool.mjs');
    assert.equal(launch.args.includes('/v:off'), true);
    assert.equal(launch.args.join(' ').includes('special'), false);
    assert.equal(launch.env.OCU_MONITOR_CLI, 'C:\\50% !special!\\tool.mjs');
  });

  it('opens a detached visible window, preserves the selected home, and deduplicates it', async (t) => {
    const h = await createHarness(t);
    let calls = 0;
    let lease;
    t.after(() => lease?.release());
    const dependencies = { locate: () => 'cmd', spawnImpl: (_command, _args, options) => {
      calls++;
      assert.equal(options.windowsHide, false);
      assert.equal(options.detached, true);
      assert.equal(options.env.OPENCODE_UNITY_HOME, h.home);
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(async () => {
        lease = await acquireGpuLock({ lockPath: monitorPaths(h.paths.delegateLedger).lock, command: 'delegate monitor', timeoutSec: 0, waitSec: 0 });
        child.emit('spawn');
      });
      return child;
    } };
    const input = { paths: h.paths, env: h.sandbox.env, platform: 'win32' };
    assert.equal((await openDelegateWindow(input, dependencies)).opened, true);
    assert.equal((await openDelegateWindow(input, dependencies)).opened, false);
    assert.equal(calls, 1);
    assert.equal((await openDelegateWindow({ ...input, platform: 'linux' }, dependencies)).opened, false);
    assert.equal(calls, 1);
  });
});
