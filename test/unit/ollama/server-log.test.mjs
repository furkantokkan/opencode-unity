import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createLogFollower,
  findKvCacheType,
  listServerLogFiles,
  parseGoDuration,
  parseServerLog,
  readLogTail,
  summarizeServerLog,
} from '../../../src/ollama/server-log.js';
import { useSandbox } from '../../helpers/sandbox.mjs';

const FIXTURES = fileURLToPath(new URL('../../fixtures/ollama/', import.meta.url));

/** @param {string} name */
async function readFixture(name) {
  return fs.readFile(path.join(FIXTURES, name), 'utf8');
}

describe('parseServerLog on the stock 16K log (spec E1, E3)', () => {
  it('reads every truncation line with its sizes', async () => {
    const log = parseServerLog(await readFixture('server-log-truncation.txt'));
    assert.equal(log.truncations.length, 3);
    assert.deepEqual(log.truncations[0], {
      time: '2026-09-17T11:00:00.655+03:00',
      limit: 8194,
      prompt: 45110,
      keep: 4,
      kept: 8194,
    });
    assert.deepEqual(
      log.truncations.map((entry) => entry.prompt),
      [45110, 34598, 17761],
    );
  });

  it('reads sampler blocks across their indented lines', async () => {
    const log = parseServerLog(await readFixture('server-log-truncation.txt'));
    assert.equal(log.samplers.length, 2);
    assert.deepEqual(log.samplers[0], {
      time: '2026-09-17T10:58:53.607+03:00',
      temperature: 1,
      topP: 1,
      topK: 40,
      repeatPenalty: 1,
    });
  });

  it('reads the KV cache line, the runner flags and the load time', async () => {
    const log = parseServerLog(await readFixture('server-log-truncation.txt'));
    assert.deepEqual(log.kvCaches, [{ time: '2026-09-17T10:58:41.007+03:00', sizeMiB: 1536, cells: 16384, keyType: 'f16', valueType: 'f16' }]);
    assert.deepEqual(log.launches, [
      { time: '2026-09-17T10:58:41.007+03:00', numCtx: 16384, cacheTypeK: null, cacheTypeV: null, flashAttention: 'off', keep: 4 },
    ]);
    assert.deepEqual(log.loads, [{ time: '2026-09-17T10:58:53.607+03:00', seconds: 12.6 }]);
  });

  it('never keeps the llama-server command line, which holds local paths', async () => {
    const log = parseServerLog(await readFixture('server-log-truncation.txt'));
    assert.equal(JSON.stringify(log).includes('llama-server.exe'), false);
    assert.equal(JSON.stringify(log).includes('blobs'), false);
  });

  it('reads request lines with method, path, status and duration', async () => {
    const log = parseServerLog(await readFixture('server-log-truncation.txt'));
    const chat = log.requests.filter((entry) => entry.path === '/v1/chat/completions');
    assert.equal(chat.length, 3);
    assert.deepEqual(chat[0], { time: '2026-09-17T11:00:31', status: 200, durationMs: 31_440, method: 'POST', path: '/v1/chat/completions' });
    assert.equal(log.requests[0].durationMs, 0);
    assert.equal(log.requests[1].durationMs, 133.2324);
  });

  it('summarizes the E1 and E3 findings', async () => {
    const summary = summarizeServerLog(parseServerLog(await readFixture('server-log-truncation.txt')), { numCtx: 16384 });
    assert.deepEqual(summary, {
      chatCompletionRequests: 3,
      truncations: 3,
      truncatedPromptTokens: { min: 17761, median: 34598, max: 45110 },
      truncationLimits: [8194],
      samplers: 2,
      defaultSamplers: 2,
      cudaErrors: 0,
      kvCacheType: 'f16',
    });
  });

  it('keeps only entries at or after sinceMs', async () => {
    const log = parseServerLog(await readFixture('server-log-truncation.txt'));
    const summary = summarizeServerLog(log, { sinceMs: Date.parse('2026-09-17T11:02:00+03:00') });
    assert.equal(summary.truncations, 2);
  });
});

describe('parseServerLog on the tuned and 32K logs', () => {
  it('finds the configured sampling and the q8_0 cache at 16K', async () => {
    const log = parseServerLog(await readFixture('server-log-tuned-16k.txt'));
    const summary = summarizeServerLog(log, { numCtx: 16384 });
    assert.equal(summary.truncations, 0);
    assert.equal(summary.defaultSamplers, 0);
    assert.deepEqual(log.samplers[0], { time: '2026-09-17T11:49:14.101+03:00', temperature: 0.7, topP: 0.8, topK: 20, repeatPenalty: 1.05 });
    assert.equal(summary.kvCacheType, 'q8_0');
    assert.deepEqual(log.launches[0].cacheTypeK, 'q8_0');
    assert.equal(log.launches[0].flashAttention, 'on');
    assert.equal(log.kvCaches[0].sizeMiB, 816);
  });

  it('counts CUDA errors and reads the 32K KV cache (spec E8)', async () => {
    const log = parseServerLog(await readFixture('server-log-32k-cuda-error.txt'));
    assert.equal(log.cudaErrors.length, 1);
    assert.deepEqual(log.kvCaches[0], { time: '2026-09-17T12:21:46.886+03:00', sizeMiB: 1632, cells: 32768, keyType: 'q8_0', valueType: 'q8_0' });
    assert.equal(summarizeServerLog(log, { numCtx: 32768 }).kvCacheType, 'q8_0');
  });

  it('prefers the load at the wanted context size', async () => {
    const log = parseServerLog(`${await readFixture('server-log-truncation.txt')}\n${await readFixture('server-log-32k-cuda-error.txt')}`);
    assert.equal(findKvCacheType(log, { numCtx: 16384 }), 'f16');
    assert.equal(findKvCacheType(log, { numCtx: 32768 }), 'q8_0');
    // Without a context size the latest load wins.
    assert.equal(findKvCacheType(log), 'q8_0');
    assert.equal(findKvCacheType(parseServerLog('nothing here')), null);
  });
});

describe('parseGoDuration', () => {
  it('reads the formats the request log uses', () => {
    assert.equal(parseGoDuration('0s'), 0);
    assert.equal(parseGoDuration('133.2324ms'), 133.2324);
    assert.equal(parseGoDuration('31.44s'), 31_440);
    assert.equal(parseGoDuration('1m2.5s'), 62_500);
    assert.equal(parseGoDuration('500µs'), 0.5);
    assert.equal(parseGoDuration('later'), null);
  });
});

describe('listServerLogFiles and readLogTail', () => {
  it('lists the current log before its rotated copies and ignores other files', async (t) => {
    const sandbox = await useSandbox(t, 'server-log-list');
    const dir = sandbox.path('logs');
    await fs.mkdir(dir, { recursive: true });
    for (const name of ['server.log', 'server-1.log', 'server-2.log', 'app.log', 'notes.txt']) {
      await fs.writeFile(path.join(dir, name), '');
    }
    const files = await listServerLogFiles(path.join(dir, 'server.log'));
    assert.deepEqual(
      files.map((file) => path.basename(file)),
      ['server.log', 'server-1.log', 'server-2.log'],
    );
    assert.deepEqual(await listServerLogFiles(path.join(sandbox.path('missing'), 'server.log')), []);
  });

  it('reads the end of a file and drops the partial first line', async (t) => {
    const sandbox = await useSandbox(t, 'server-log-tail');
    const file = sandbox.path('server.log');
    await fs.writeFile(file, 'first line is long\nsecond\nthird\n');
    assert.equal(await readLogTail(file), 'first line is long\nsecond\nthird\n');
    assert.equal(await readLogTail(file, { maxBytes: 13 }), 'third\n');
    assert.equal(await readLogTail(sandbox.path('absent.log')), null);
  });
});

describe('createLogFollower', () => {
  it('returns only new complete lines and keeps a partial line for the next poll', async (t) => {
    const sandbox = await useSandbox(t, 'server-log-follow');
    const file = sandbox.path('server.log');
    await fs.writeFile(file, 'old line\n');
    const follower = createLogFollower(file);
    assert.deepEqual(await follower.poll(), []);
    await fs.appendFile(file, 'new line\npart');
    assert.deepEqual(await follower.poll(), ['new line']);
    await fs.appendFile(file, 'ial line\n');
    assert.deepEqual(await follower.poll(), ['partial line']);
    assert.deepEqual(await follower.poll(), []);
  });

  it('follows a rotation: the rest of the old file, then the new one', async (t) => {
    const sandbox = await useSandbox(t, 'server-log-rotate');
    const file = sandbox.path('server.log');
    const rotated = sandbox.path('server-1.log');
    await fs.writeFile(file, 'before\n');
    const follower = createLogFollower(file);
    await follower.poll();
    await fs.appendFile(file, 'last of the old file\n');
    await fs.rename(file, rotated);
    await fs.writeFile(file, 'first of the new file\n');
    assert.deepEqual(await follower.poll(), ['last of the old file', 'first of the new file']);
  });

  it('starts from the beginning when asked, and survives a truncated file', async (t) => {
    const sandbox = await useSandbox(t, 'server-log-truncate');
    const file = sandbox.path('server.log');
    await fs.writeFile(file, 'one\ntwo\n');
    const follower = createLogFollower(file, { startAtEnd: false });
    assert.deepEqual(await follower.poll(), ['one', 'two']);
    await fs.writeFile(file, 'fresh\n');
    assert.deepEqual(await follower.poll(), ['fresh']);
  });

  it('is quiet while the file does not exist yet', async (t) => {
    const sandbox = await useSandbox(t, 'server-log-missing');
    const file = sandbox.path('server.log');
    const follower = createLogFollower(file);
    assert.deepEqual(await follower.poll(), []);
    await fs.writeFile(file, 'appeared\n');
    assert.deepEqual(await follower.poll(), ['appeared']);
  });
});
