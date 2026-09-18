// The guard and lock half of the guarded path (spec 7.3, 7.5, 7.8, 12.3): nothing reaches the model
// until the guard passes, the lock is held while it does, and a block leaves the envelope a machine
// code an orchestrator can branch on.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { EXIT } from '../../../src/cli/exit-codes.js';
import { parseLockRecord, acquireGpuLock } from '../../../src/core/lock.js';
import { getHomePaths } from '../../../src/core/paths.js';
import { guardedChat, guardedWarm, isDegradedVerdict, summarizeVerdict, withGpuLock } from '../../../src/ollama/guarded-chat.js';
import { startMockOllama } from '../../../src/selftest/mock-ollama.js';
import { useSandbox } from '../../helpers/sandbox.mjs';
import { MODEL_TAG, NUM_CTX, catchAsync, makeProbes, makeProfile } from './fixtures.mjs';

const MESSAGES = [{ role: 'user', content: 'Name the file that draws the grid.' }];

/**
 * @param {import('node:test').TestContext} t
 * @param {{ mock?: Parameters<typeof startMockOllama>[0], profile?: Partial<Parameters<typeof makeProfile>[0]> }} [options]
 */
async function setup(t, { mock: mockOptions = {}, profile: profileOptions = {} } = {}) {
  const sandbox = await useSandbox(t, 'guarded-lock');
  const started = await startMockOllama({ models: [MODEL_TAG], ...mockOptions });
  t.after(() => started.close());
  const profile = makeProfile({ baseUrl: started.url, home: sandbox.productHome, ...profileOptions });
  return { mock: started.mock, profile, lockPath: getHomePaths(profile.home).gpuLock };
}

describe('guardedChat guard', () => {
  it('reports a busy GPU as exit 2 gpu_guard_blocked, naming gpu_busy as the deciding reason', async (t) => {
    const { mock, profile } = await setup(t);
    const probes = makeProbes({ loaded: false, utilPercent: 95 });

    const error = await catchAsync(() => guardedChat({ profile, command: 'delegate ask', messages: MESSAGES, probes, lockWaitSec: 5 }));

    assert.equal(error.exitCode, EXIT.BLOCKED);
    assert.equal(error.code, 'gpu_guard_blocked');
    assert.equal(error.data.guard.reason, 'gpu_busy');
    assert.match(error.message, /blocked delegate ask/);
    assert.equal(error.data.guard.path, 'cold');
    assert.deepEqual(error.data.guard.reasons.map((/** @type {{ id: string }} */ reason) => reason.id), ['gpu_busy']);
    assert.match(error.data.guard.reasons[0].detail, /utilization/);
    assert.deepEqual(mock.loadRequests, []);
  });

  it('reports low video memory as exit 2 with vram_low as the reason', async (t) => {
    const { mock, profile } = await setup(t);
    const probes = makeProbes({ loaded: false, freeMiB: 3000 });

    const error = await catchAsync(() => guardedChat({ profile, command: 'warm', messages: MESSAGES, probes, lockWaitSec: 5 }));

    assert.equal(error.code, 'gpu_guard_blocked');
    assert.equal(error.data.guard.reason, 'vram_low');
    assert.deepEqual(mock.loadRequests, []);
  });

  it('fails closed when a probe cannot answer', async (t) => {
    const { mock, profile } = await setup(t);
    const probes = makeProbes({
      processes: {
        platform: 'test',
        detect: async () => ({ ok: false, error: 'the process list could not be read' }),
        sample: async () => ({ ok: false, error: 'the process list could not be read' }),
      },
    });

    const error = await catchAsync(() => guardedChat({ profile, command: 'bench', messages: MESSAGES, probes, lockWaitSec: 5 }));

    assert.equal(error.exitCode, EXIT.BLOCKED);
    assert.equal(error.code, 'gpu_guard_blocked');
    assert.equal(error.data.guard.reason, 'probe_failed');
    assert.deepEqual(mock.loadRequests, []);
  });

  it('reports an Ollama the guard cannot read as blocked', async (t) => {
    const { mock, profile } = await setup(t);
    const probes = makeProbes({ readOllamaPs: async () => ({ ok: false, error: 'the connection was refused' }) });

    const error = await catchAsync(() => guardedChat({ profile, command: 'warm', messages: MESSAGES, probes, lockWaitSec: 5 }));

    assert.equal(error.exitCode, EXIT.BLOCKED);
    assert.equal(error.code, 'ollama_unreachable');
    assert.deepEqual(mock.loadRequests, []);
  });

  it('refuses a server on another computer, where nothing can be measured', async (t) => {
    // TEST-NET-1 (RFC 5737): a documentation address, so the guard classifies it without a connection.
    const { mock, profile } = await setup(t, { profile: { baseUrl: 'http://192.0.2.10:11434' } });

    const error = await catchAsync(() => guardedChat({ profile, command: 'delegate ask', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 }));

    assert.equal(error.code, 'gpu_guard_blocked');
    assert.equal(error.data.guard.reason, 'remote_unguarded');
    assert.equal(error.data.guard.path, 'remote');
    assert.deepEqual(mock.loadRequests, []);
  });

  it('keeps machine measurements out of the envelope', async (t) => {
    const { profile } = await setup(t);
    const probes = makeProbes({ loaded: false, utilPercent: 95 });

    const error = await catchAsync(() => guardedChat({ profile, command: 'bench', messages: MESSAGES, probes, lockWaitSec: 5 }));

    assert.deepEqual(Object.keys(error.data.guard).sort(), ['checkedAt', 'degraded', 'mode', 'notMeasured', 'notes', 'path', 'reason', 'reasons', 'verdict']);
    assert.equal(JSON.stringify(error.data).includes('measurements'), false);
  });

  it('hands the passing verdict back with the answer', async (t) => {
    const { profile } = await setup(t);

    const result = await guardedChat({ profile, command: 'warm', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 });

    assert.equal(result.verdict.pass, true);
    assert.equal(result.guard.path, 'loaded');
    assert.equal(result.guard.degraded, false);
    assert.deepEqual(result.guard.reasons, []);
    assert.ok(result.durationMs >= 0);
  });
});

describe('guarded verdict summary', () => {
  /**
   * The guard core gains `pass-degraded` and `notMeasured[]` with the platform work (amendment CP-D3);
   * the reader here is what carries it into the envelope once it does.
   * @param {Record<string, unknown>} overrides
   */
  const verdict = (overrides = {}) =>
    /** @type {any} */ ({
      verdict: 'pass',
      pass: true,
      path: 'cold',
      mode: null,
      reasons: [],
      notes: ['video memory: free 21.5 GiB'],
      cacheSec: 3,
      checkedAt: '2026-09-17T12:00:00.000Z',
      target: { modelTag: MODEL_TAG, numCtx: NUM_CTX },
      model: {},
      measurements: { gpu: { secret: true }, unity: null, loadedModels: [] },
      ...overrides,
    });

  it('reads a plain pass as measured in full', () => {
    assert.equal(isDegradedVerdict(verdict()), false);
    const summary = summarizeVerdict(verdict());
    assert.equal(summary.degraded, false);
    assert.deepEqual(summary.notMeasured, []);
    assert.deepEqual(summary.notes, ['video memory: free 21.5 GiB']);
    assert.equal('measurements' in summary, false);
  });

  it('reads a degraded pass, by verdict name or by what it could not measure', () => {
    assert.equal(isDegradedVerdict(verdict({ verdict: 'pass-degraded' })), true);
    assert.equal(isDegradedVerdict(verdict({ notMeasured: ['GPU utilization'] })), true);
    const summary = summarizeVerdict(verdict({ verdict: 'pass-degraded', notMeasured: ['GPU utilization', 42] }));
    assert.equal(summary.verdict, 'pass-degraded');
    assert.equal(summary.degraded, true);
    assert.deepEqual(summary.notMeasured, ['GPU utilization']);
  });

  it('copies the reasons of a block without their probe data', () => {
    const blocked = verdict({
      verdict: 'blocked',
      pass: false,
      mode: 'stop',
      reasons: [{ id: 'gpu_busy', mode: 'stop', detail: 'GPU utilization stayed high', data: { samples: [95, 96] } }],
    });
    assert.deepEqual(summarizeVerdict(blocked).reasons, [{ id: 'gpu_busy', detail: 'GPU utilization stayed high' }]);
  });
});

describe('guarded GPU lock', () => {
  it('holds the lock for the whole request and releases it afterwards', async (t) => {
    /** @type {string[]} */
    const seen = [];
    const { profile, lockPath } = await setup(t, {
      mock: {
        chatReplies: [
          () => {
            seen.push(fs.readFileSync(lockPath, 'utf8'));
            return { content: 'ok' };
          },
        ],
      },
    });

    await guardedChat({ profile, command: 'delegate ask', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 });

    assert.equal(seen.length, 1);
    const record = parseLockRecord(seen[0]);
    assert.ok(record);
    assert.equal(record.pid, process.pid);
    assert.equal(record.command, 'delegate ask');
    assert.equal(fs.existsSync(lockPath), false, 'the lock is released when the request ends');
  });

  it('gives up with exit 6 when another command holds the lock', async (t) => {
    const { mock, profile, lockPath } = await setup(t);
    fs.mkdirSync(getHomePaths(profile.home).state, { recursive: true });
    const stamp = new Date().toISOString();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, command: 'bench all', startedAt: stamp, heartbeatAt: stamp, timeoutSec: 600, token: 'another-holder' }));

    const error = await catchAsync(() => guardedChat({ profile, command: 'warm', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 0 }));

    assert.equal(error.exitCode, EXIT.LOCK_TIMEOUT);
    assert.equal(error.code, 'lock_timeout');
    assert.equal(error.data.holder.command, 'bench all');
    assert.deepEqual(mock.loadRequests, []);
    assert.equal(parseLockRecord(fs.readFileSync(lockPath, 'utf8'))?.token, 'another-holder', 'a waiter never removes a live lock');
  });

  it('reuses a lock the caller already holds, so one job is one acquisition', async (t) => {
    const { profile, lockPath } = await setup(t, { mock: { chatReplies: [{ content: 'first' }, { content: 'second' }] } });
    const lock = await acquireGpuLock({ lockPath, command: 'delegate map', timeoutSec: 600, waitSec: 5 });
    t.after(() => lock.release());
    const probes = makeProbes();

    // Shaping and the request it shapes run under one acquisition (amendment 38.9, 12.3 semantics).
    await guardedChat({ profile, command: 'shape', messages: MESSAGES, lock, probes });
    await guardedChat({ profile, command: 'delegate map', messages: MESSAGES, lock, probes });

    assert.equal(parseLockRecord(fs.readFileSync(lockPath, 'utf8'))?.token, lock.record.token, 'the caller still holds its own lock');
    lock.release();
    assert.equal(fs.existsSync(lockPath), false);
  });

  it('registers a cleanup that releases the lock on an interrupt', async (t) => {
    const { profile, lockPath } = await setup(t);
    /** @type {Array<() => string | void>} */
    const cleanups = [];
    let removed = 0;
    const addCleanup = (/** @type {() => string | void} */ cleanup) => {
      cleanups.push(cleanup);
      return () => {
        removed += 1;
      };
    };

    const note = await withGpuLock({ profile, command: 'warm', timeoutSec: 60, lockPath, lockWaitSec: 5, addCleanup }, async () => {
      assert.equal(cleanups.length, 1);
      assert.ok(fs.existsSync(lockPath));
      const result = cleanups[0]();
      assert.equal(fs.existsSync(lockPath), false, 'the interrupt cleanup releases the lock');
      return result;
    });

    assert.equal(note, 'released the GPU lock');
    assert.equal(removed, 1, 'the cleanup is removed once the command owns the release again');
  });

  it('releases the lock when the work throws', async (t) => {
    const { profile, lockPath } = await setup(t);

    await assert.rejects(
      () =>
        withGpuLock({ profile, command: 'bench', timeoutSec: 60, lockPath, lockWaitSec: 5 }, async () => {
          throw new Error('the check failed');
        }),
      /the check failed/,
    );

    assert.equal(fs.existsSync(lockPath), false);
  });

  it('takes over an abandoned lock and says so', async (t) => {
    const { profile, lockPath } = await setup(t);
    fs.mkdirSync(getHomePaths(profile.home).state, { recursive: true });
    // A live pid with a heartbeat far past the 60 s margin plus the holder's own timeout: the writer
    // died without cleaning up, or was suspended long enough to count as gone.
    const stale = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, command: 'bench all', startedAt: stale, heartbeatAt: stale, timeoutSec: 1, token: 'abandoned' }));

    const result = await guardedChat({ profile, command: 'delegate ask', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 });

    assert.ok(result.warnings.some((warning) => /Took over a stale GPU lock/.test(warning)), `warnings were ${JSON.stringify(result.warnings)}`);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

describe('guardedWarm', () => {
  it('loads the model with an empty request and no generation', async (t) => {
    const { mock, profile } = await setup(t);

    const result = await guardedWarm({ profile, command: 'warm', probes: makeProbes({ loaded: false }), lockWaitSec: 5 });

    assert.equal(mock.loadRequests.length, 1);
    assert.deepEqual(mock.requests.at(-1)?.body, { model: MODEL_TAG, messages: [], keep_alive: '15m', options: { num_ctx: NUM_CTX } });
    assert.equal(result.response.doneReason, 'load');
    assert.equal(result.response.content, '');
    assert.equal(result.truncated, false);
    assert.equal(result.budget, null);
  });

  it('judges the cold path even when the model is already loaded', async (t) => {
    const { mock, profile } = await setup(t);
    // Loaded, but the video memory a reload would need is not there.
    const probes = makeProbes({ loadedMiB: 100, freeMiB: 500 });

    const passed = await guardedChat({ profile, command: 'delegate ask', messages: MESSAGES, probes, lockWaitSec: 5 });
    assert.equal(passed.guard.path, 'loaded');

    const error = await catchAsync(() => guardedWarm({ profile, command: 'warm', probes, lockWaitSec: 5 }));
    assert.equal(error.code, 'gpu_guard_blocked');
    assert.equal(error.data.guard.reason, 'vram_low');
    assert.equal(error.data.guard.path, 'cold');
    assert.equal(mock.loadRequests.length, 1, 'only the passing chat request reached the server');
  });

  it('refuses an unusable profile', async () => {
    await assert.rejects(() => guardedWarm({ profile: /** @type {any} */ (null), command: 'warm' }), /complete runtime profile/);
  });
});
