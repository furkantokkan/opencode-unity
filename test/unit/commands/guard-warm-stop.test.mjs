import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describe, it } from 'node:test';
import { catchError } from '../../helpers/catch-error.mjs';
import { createCommandHarness, MODEL_TAG, NUM_CTX } from './helpers.mjs';
import { readKeepAlive } from '../../../src/commands/warm.js';
import { renderVerdict } from '../../../src/commands/guard.js';

describe('commands/guard', () => {
  it('passes with the verdict, the target and the banner shape', async (t) => {
    const harness = await createCommandHarness(t);
    const result = await harness.run('guard');
    assert.equal(result.exitCode, 0);
    assert.match(result.message, /guard pass/);
    assert.equal(result.data.target.modelTag, MODEL_TAG);
    assert.equal(result.data.target.numCtx, NUM_CTX);
    assert.equal(result.data.banner.modelVramMiB > 0, true);
    assert.match(result.output.join('\n'), /^verdict {2}pass/);
  });

  it('exits 2 with the reason when the guard blocks', async (t) => {
    const harness = await createCommandHarness(t);
    const result = await harness.run('guard', { guardBlocked: true });
    assert.equal(result.exitCode, 2);
    assert.equal(result.code, 'gpu_guard_blocked');
    assert.equal(result.data.guardReason, 'vram_low');
    assert.match(result.error?.hint ?? '', /opencode-unity status/);
  });

  it('puts the verdict, its reasons and notes at the top of data, as the 5.3 envelope shows', async (t) => {
    const harness = await createCommandHarness(t);
    const blocked = await harness.run('guard', { guardBlocked: true });
    assert.equal(blocked.data.verdict, 'blocked');
    assert.deepEqual(blocked.data.reasons.map((/** @type {{ id: string }} */ reason) => reason.id), ['vram_low']);
    assert.ok(Array.isArray(blocked.data.notes));
    assert.ok(Array.isArray(blocked.data.notMeasured));
    assert.deepEqual(blocked.data.reasons, blocked.data.guard.reasons, 'the shared summary is kept beside it');
    const passed = await harness.run('guard');
    assert.equal(passed.data.verdict, 'pass');
    assert.deepEqual(passed.data.reasons, []);
  });

  it('gives an unreachable Ollama its own code', async (t) => {
    const harness = await createCommandHarness(t, { ollama: false });
    const result = await harness.run('guard', {
      probes: { readOllamaPs: async () => ({ ok: false, error: 'connection refused' }) },
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.code, 'ollama_unreachable');
  });

  it('judges a cold load with --cold even while the model is loaded', async (t) => {
    const harness = await createCommandHarness(t);
    const loaded = await harness.run('guard');
    assert.equal(loaded.data.guard.path, 'loaded');
    const cold = await harness.run('guard', { options: { cold: true } });
    assert.equal(cold.data.guard.path, 'cold');
  });

  it('renders every reason and note it found', () => {
    const lines = renderVerdict(/** @type {any} */ ({
      verdict: 'blocked',
      path: 'cold',
      checkedAt: '2026-09-18T09:30:00.000Z',
      target: { modelTag: 'ocu', numCtx: 16_384 },
      model: { state: 'not-listed' },
      reasons: [{ id: 'vram_low', detail: 'only 1.0 GiB free' }],
      notes: ['a note'],
    }));
    assert.equal(lines.length, 4);
    assert.match(lines[2], /^reason {3}vram_low: only 1\.0 GiB free$/);
    assert.match(lines[3], /^note {5}a note$/);
  });
});

describe('commands/warm', () => {
  it('loads the model through the guarded path and reports the duration', async (t) => {
    const harness = await createCommandHarness(t, { loaded: false });
    const result = await harness.run('warm');
    assert.equal(result.exitCode, 0);
    assert.match(result.message, new RegExp(`${MODEL_TAG} is loaded at ${NUM_CTX} context`));
    assert.equal(result.data.keepAlive, '15m');
    assert.equal(typeof result.data.durationMs, 'number');

    const requests = harness.ollama.requests.filter((request) => request.path === '/api/chat');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.messages, []);
    assert.equal(requests[0].body.options.num_ctx, NUM_CTX);
  });

  it('forwards a valid --keep-alive and refuses a value Ollama would not understand', async (t) => {
    const harness = await createCommandHarness(t, { loaded: false });
    const result = await harness.run('warm', { options: { keepAlive: '1h30m' } });
    assert.equal(result.data.keepAlive, '1h30m');
    assert.equal(harness.ollama.requests.filter((request) => request.path === '/api/chat')[0].body.keep_alive, '1h30m');

    for (const value of ['soon', '15 m', '', 'm15']) {
      const error = catchError(() => readKeepAlive(value));
      assert.equal(error.code, 'invalid_keep_alive');
      assert.equal(error.exitCode, 1);
    }
    assert.equal(readKeepAlive(undefined), undefined);
    assert.equal(readKeepAlive('0'), '0');
    assert.equal(readKeepAlive('-1'), '-1');
  });

  it('never reaches the model when the guard blocks', async (t) => {
    const harness = await createCommandHarness(t, { loaded: false });
    const result = await harness.run('warm', { guardBlocked: true });
    assert.equal(result.exitCode, 2);
    assert.equal(result.code, 'gpu_guard_blocked');
    assert.equal(harness.ollama.requests.filter((request) => request.path === '/api/chat').length, 0);
  });

  it('releases the GPU lock when it is done', async (t) => {
    const harness = await createCommandHarness(t, { loaded: false });
    await harness.run('warm');
    await assert.rejects(() => fs.access(harness.paths.gpuLock));
  });

  it('--dry-run sends Ollama nothing and loads nothing (spec 5.1)', async (t) => {
    const harness = await createCommandHarness(t, { loaded: false });
    const result = await harness.run('warm', { global: { dryRun: true }, options: { keepAlive: '5m' } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.dryRun, true);
    assert.equal(result.data.keepAlive, '5m');
    assert.match(result.message, /nothing was loaded/);
    assert.deepEqual(harness.ollama.requests.map((/** @type {{ path: string }} */ request) => request.path), [], 'not even the guard probes reach the server');
    await assert.rejects(() => fs.access(harness.paths.gpuLock));
  });
});

describe('commands/stop', () => {
  it('unloads a loaded model and reports the memory it frees', async (t) => {
    const harness = await createCommandHarness(t, { loaded: true });
    const result = await harness.run('stop');
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.wasLoaded, true);
    assert.equal(result.data.unloaded, true);
    assert.match(result.message, /is unloaded/);

    const chat = harness.ollama.requests.filter((request) => request.path === '/api/chat');
    assert.equal(chat.length, 1);
    assert.deepEqual(chat[0].body, { model: MODEL_TAG, messages: [], keep_alive: 0 });
  });

  it('says so and sends nothing when the model is not loaded', async (t) => {
    const harness = await createCommandHarness(t, { loaded: false });
    const result = await harness.run('stop');
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.wasLoaded, false);
    assert.match(result.message, /is not loaded/);
    assert.equal(harness.ollama.requests.filter((request) => request.path === '/api/chat').length, 0);
  });

  it('exits 2 when Ollama cannot be reached', async (t) => {
    const harness = await createCommandHarness(t, { ollama: false });
    const result = await harness.run('stop');
    assert.equal(result.exitCode, 2);
    assert.equal(result.code, 'ollama_unreachable');
  });

  it('--dry-run reads what is loaded and unloads nothing (spec 5.1)', async (t) => {
    const harness = await createCommandHarness(t, { loaded: true });
    const result = await harness.run('stop', { global: { dryRun: true } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.dryRun, true);
    assert.equal(result.data.wasLoaded, true);
    assert.equal(result.data.unloaded, false);
    assert.match(result.message, /would be unloaded/);
    assert.equal(harness.ollama.requests.filter((/** @type {{ path: string }} */ request) => request.path === '/api/chat').length, 0);
  });
});
