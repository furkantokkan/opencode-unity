import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createCommandHarness, MODEL_TAG, NOW_MS, NUM_CTX } from './helpers.mjs';
import { DEFAULT_INTERVAL_SEC, findSessionStart, readInterval } from '../../../src/commands/status.js';
import { MOCK_OLLAMA_VERSION } from '../../../src/selftest/mock-ollama.js';

const AT = new Date(NOW_MS);

/**
 * Writes session-log records for the day `status` looks at.
 * @param {import('./helpers.mjs').CommandHarness} harness
 * @param {Array<Record<string, unknown>>} records
 */
async function writeSessionLog(harness, records) {
  const day = AT.toISOString().slice(0, 10);
  await fs.mkdir(harness.paths.sessionsDir, { recursive: true });
  const lines = records.map((record) => JSON.stringify({ at: AT.toISOString(), ...record })).join('\n');
  await fs.writeFile(path.join(harness.paths.sessionsDir, `${day}.jsonl`), `${lines}\n`, 'utf8');
}

/**
 * A watcher double, so no test depends on a real Ollama log file. The priming poll finds nothing, the
 * next one finds `notices`, and every later one finds nothing new again - the way a log follower does.
 */
function watcherWith(notices = []) {
  let polls = 0;
  return {
    polls: () => polls,
    watcher: {
      poll: async () => {
        polls += 1;
        return polls === 2 ? notices : [];
      },
      render: (/** @type {any[]} */ items) => items.map((item) => item.text),
    },
  };
}

describe('commands/status', () => {
  it('reports every source of spec 5.5 in one poll', async (t) => {
    const harness = await createCommandHarness(t);
    await writeSessionLog(harness, [
      { event: 'request', estimate: 5200 },
      { event: 'overflow', estimate: 12_000 },
      { event: 'truncation', inputTokens: 16_380 },
      { event: 'guardBlock', reason: 'vram_low' },
    ]);
    const { watcher } = watcherWith();

    const result = await harness.run('status', { deps: { now: () => AT, watcher } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.ollamaVersion, MOCK_OLLAMA_VERSION);
    assert.equal(result.data.running[0].name, `${MODEL_TAG}:latest`);
    assert.equal(result.data.guard.verdict, 'pass');
    assert.equal(result.data.gpu.freeMiB, 22_000);
    assert.equal(result.data.gpu.totalMiB, 24_576);
    assert.equal(result.data.unity.editors, 0);
    assert.equal(result.data.unity.imports, 'idle');
    assert.equal(result.data.lock, 'free');
    assert.equal(result.data.session.requests, 1);
    assert.equal(result.data.session.overflows, 1);
    assert.equal(result.data.session.truncations, 1);
    assert.deepEqual(result.data.session.guardBlocks, [{ reason: 'vram_low', count: 1 }]);
    assert.equal(result.data.line, undefined, 'the envelope carries the report, not the watch line');
  });

  it('prints the labelled report a person reads', async (t) => {
    const harness = await createCommandHarness(t);
    const { watcher } = watcherWith();
    const result = await harness.run('status', { deps: { now: () => AT, watcher } });
    const printed = result.output.join('\n');
    assert.match(printed, new RegExp(`ollama {3}version ${MOCK_OLLAMA_VERSION}`));
    assert.match(printed, new RegExp(`model {4}${MODEL_TAG}:latest at ${NUM_CTX} context`));
    assert.match(printed, /gpu {6}free 21\.5 GiB of 24\.0 GiB, utilization 2%/);
    assert.match(printed, /lock {5}free/);
  });

  it('names the blocking reason instead of only the verdict', async (t) => {
    const harness = await createCommandHarness(t);
    const { watcher } = watcherWith();
    const result = await harness.run('status', { guardBlocked: true, deps: { now: () => AT, watcher } });
    assert.equal(result.exitCode, 0, 'a blocked guard is a report, not a failure');
    assert.equal(result.data.guard.verdict, 'blocked');
    assert.match(result.output.join('\n'), /guard {4}blocked: .*video memory/i);
  });

  it('exits 2 when Ollama cannot be reached', async (t) => {
    const harness = await createCommandHarness(t, { ollama: false });
    const { watcher } = watcherWith();
    const result = await harness.run('status', { deps: { now: () => AT, watcher } });
    assert.equal(result.exitCode, 2);
    assert.equal(result.code, 'ollama_unreachable');
  });

  it('shows the lock holder while another command holds it', async (t) => {
    const harness = await createCommandHarness(t);
    await fs.mkdir(path.dirname(harness.paths.gpuLock), { recursive: true });
    await fs.writeFile(harness.paths.gpuLock, JSON.stringify({
      pid: process.pid,
      command: 'delegate ask',
      startedAt: '2026-09-18T09:00:00.000Z',
      heartbeatAt: new Date().toISOString(),
      timeoutSec: 600,
      token: 'test-token',
    }), 'utf8');

    const { watcher } = watcherWith();
    const result = await harness.run('status', { deps: { now: () => AT, watcher } });
    assert.match(result.data.lock, /held by delegate ask/);
  });

  it('prints one dense line per poll in --watch and stops when asked', async (t) => {
    const harness = await createCommandHarness(t);
    await writeSessionLog(harness, [{ event: 'request', estimate: 100 }]);
    const { watcher, polls } = watcherWith([{ text: 'Ollama cut a prompt' }]);
    /** @type {number[]} */
    const waits = [];

    const result = await harness.run('status', {
      options: { watch: true, interval: 3 },
      deps: { now: () => AT, watcher, maxPolls: 2, sleep: async (/** @type {number} */ ms) => { waits.push(ms); } },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(waits, [3000], 'it waits between polls, not after the last one');
    // The clock prefix is local time, so the lines are found by content and never by the hour.
    assert.equal(result.output.filter((line) => /^\d{2}:\d{2}:\d{2} guard pass/.test(line) && line.includes('| req 1 |')).length, 2);
    assert.equal(result.output.filter((line) => line.includes('cut a prompt')).length, 1, 'the first poll only marks the log position');
    assert.equal(polls() >= 3, true);
  });

  it('stops a watch as soon as the run is interrupted', async (t) => {
    const harness = await createCommandHarness(t);
    const { watcher } = watcherWith();
    const controller = new AbortController();
    let sleeps = 0;
    const result = await harness.run('status', {
      options: { watch: true },
      signal: controller.signal,
      deps: {
        now: () => AT,
        watcher,
        maxPolls: 5,
        sleep: async () => {
          sleeps += 1;
          controller.abort();
        },
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(sleeps, 1);
    assert.equal(result.output.filter((line) => line.includes('| req ')).length, 1);
    assert.equal(result.data.guard.verdict, 'pass', 'the last snapshot is still returned');
  });

  it('returns only the warnings when interrupted before the first poll', async (t) => {
    const harness = await createCommandHarness(t);
    const controller = new AbortController();
    controller.abort();
    const result = await harness.run('status', { options: { watch: true }, signal: controller.signal, deps: { now: () => AT, watcher: watcherWith().watcher } });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.data, {});
  });

  it('resolves --project as a path and as a recorded id', async (t) => {
    const harness = await createCommandHarness(t);
    const { watcher } = watcherWith();
    const init = await harness.run('init', { deps: { run: async () => /** @type {any} */ ({ exitCode: 1, stdout: '', stderr: '', error: null, timedOut: false, signal: null, aborted: false, truncated: false, durationMs: 1 }) } });

    const byPath = await harness.run('status', { global: { project: harness.projectRoot }, deps: { now: () => AT, watcher: watcherWith().watcher } });
    assert.equal(byPath.data.project.id, init.data.projectId);
    assert.equal(byPath.data.project.root, harness.projectRoot);

    const byId = await harness.run('status', { global: { project: init.data.projectId }, deps: { now: () => AT, watcher } });
    assert.equal(byId.data.project.id, init.data.projectId);
    assert.equal(byId.data.project.root, harness.projectRoot);
  });

  it('reports no project when none was asked for', async (t) => {
    const harness = await createCommandHarness(t);
    const { watcher } = watcherWith();
    const result = await harness.run('status', { deps: { now: () => AT, watcher } });
    assert.equal(result.data.project, null);
    assert.equal(result.output.some((line) => line.startsWith('project')), false);
  });

  it('defaults the interval and clamps nonsense to it', () => {
    assert.equal(readInterval(undefined), DEFAULT_INTERVAL_SEC);
    assert.equal(readInterval(0), DEFAULT_INTERVAL_SEC);
    assert.equal(readInterval(Number.NaN), DEFAULT_INTERVAL_SEC);
    assert.equal(readInterval(/** @type {any} */ ('5')), DEFAULT_INTERVAL_SEC);
    assert.equal(readInterval(5), 5);
  });

  it('counts the session from the start of the current UTC day', () => {
    assert.equal(findSessionStart(new Date('2026-09-18T23:59:59.000Z')), Date.parse('2026-09-18T00:00:00.000Z'));
  });
});
