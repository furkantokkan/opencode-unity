// Job records, review identity and the envelope payload (spec 12.4, amendment D-M7 and 36.6).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import { createEnvelope } from '../../src/cli/envelope.js';
import {
  SUMMARY_LIMIT,
  USABLE_STATUSES,
  addUsage,
  attachOrchestratorAction,
  buildJobResult,
  createJob,
  createJobId,
  createReviewId,
  createReviewKey,
  createReviewRecord,
  getOrchestratorAction,
  parseReviewId,
  readReview,
  renderJobMeta,
  writeJobFile,
  writeReview,
} from '../../src/delegate/results.js';
import { useSandbox } from '../helpers/sandbox.mjs';

const NOW = Date.parse('2026-09-18T09:30:00.000Z');

/**
 * @param {import('node:test').TestContext} t
 * @param {string} [command]
 */
async function createTestJob(t, command = 'ask') {
  const sandbox = await useSandbox(t, 'delegate-results');
  const resultsDir = path.join(sandbox.root, 'results');
  const job = await createJob({ resultsDir, command, cwd: sandbox.root, now: () => NOW, randomHex: () => 'abc123' });
  return { sandbox, resultsDir, job };
}

/**
 * @param {string} relativePath
 * @param {string} before
 * @param {string} after
 * @returns {any}
 */
function change(relativePath, before, after) {
  return {
    relativePath,
    absolutePath: path.join('/work', relativePath),
    bytes: Buffer.from(before, 'utf8'),
    decoded: { text: before },
    newText: after,
    newBytes: Buffer.from(after, 'utf8'),
  };
}

describe('job folders', () => {
  it('names a job by time, command and a random tail', () => {
    assert.equal(createJobId('edit', { now: () => NOW, randomHex: () => 'ff00aa' }), '20260918-093000-edit-ff00aa');
  });

  it('creates the folder and starts the counters at zero', async (t) => {
    const { job } = await createTestJob(t);
    assert.ok((await fs.stat(job.dir)).isDirectory());
    assert.deepEqual(
      { files: job.fileCount, prompt: job.promptTokensActual, output: job.outputTokens, warnings: job.warnings },
      { files: 0, prompt: 0, output: 0, warnings: [] },
    );
  });

  it('writes a nested job file and creates its folder', async (t) => {
    const { job } = await createTestJob(t);
    const written = await writeJobFile(job, path.join('files', '001-a.md'), 'note');
    assert.equal(await fs.readFile(written, 'utf8'), 'note');
  });
});

describe('addUsage', () => {
  /** @returns {any} */
  const job = () => ({ promptTokensActual: 0, outputTokens: 0, warnings: [] });
  const limits = { numCtx: 16384, maxOutputTokens: 2048 };

  it('adds the counters and reports no overflow for a normal answer', () => {
    const state = job();
    assert.equal(addUsage(state, { promptTokens: 500, outputTokens: 100, doneReason: 'stop' }, limits), false);
    assert.equal(state.promptTokensActual, 500);
    assert.equal(state.outputTokens, 100);
    assert.deepEqual(state.warnings, []);
  });

  it('reports an overflow when the counts reach the context window', () => {
    const state = job();
    assert.equal(addUsage(state, { promptTokens: 16_384, outputTokens: 0, doneReason: 'stop' }, limits), true);
    assert.match(state.warnings[0], /context window is full/);
  });

  it('reports an overflow when prompt and answer together reach it', () => {
    const state = job();
    assert.equal(addUsage(state, { promptTokens: 16_000, outputTokens: 400, doneReason: 'stop' }, limits), true);
  });

  it('warns when the answer stopped at the output limit', () => {
    const state = job();
    addUsage(state, { promptTokens: 100, outputTokens: 2048, doneReason: 'length' }, limits);
    assert.match(state.warnings[0], /stopped at the output limit/);
  });

  it('warns when the prompt left little room for the answer', () => {
    const state = job();
    addUsage(state, { promptTokens: 15_000, outputTokens: 100, doneReason: 'stop' }, limits);
    assert.match(state.warnings[0], /leaving little room for the answer/);
  });
});

describe('review identity', () => {
  it('keys a review by working directory, task text and file list', () => {
    const allowlist = new Map([['b.cs', {}], ['a.cs', {}]]);
    const key = createReviewKey({ cwd: '/work', task: 'fix it', allowlist, platform: 'linux' });
    assert.deepEqual(key.files, ['a.cs', 'b.cs']);
    assert.equal(key.cwd, '/work');
    assert.notEqual(key.taskSha256, createReviewKey({ cwd: '/work', task: 'fix it too', allowlist, platform: 'linux' }).taskSha256);
  });

  it('folds the working directory on Windows, where two spellings are one directory', () => {
    assert.equal(createReviewKey({ cwd: 'C:\\Work', task: 't', allowlist: new Map(), platform: 'win32' }).cwd, 'c:\\work');
  });

  it('pins the exact reviewed content in the review id', () => {
    const key = createReviewKey({ cwd: '/work', task: 't', allowlist: new Map([['a.cs', {}]]), platform: 'linux' });
    const record = createReviewRecord(key, [change('a.cs', 'old\n', 'new\n')]);
    const reviewId = createReviewId('20260918-093000-edit-abc123', record);
    assert.match(reviewId, /^20260918-093000-edit-abc123\.[0-9a-f]{8}$/);
    const other = createReviewRecord(key, [change('a.cs', 'old\n', 'different\n')]);
    assert.notEqual(createReviewId('20260918-093000-edit-abc123', other), reviewId);
  });

  it('parses a review id and refuses a shape that is not one', () => {
    assert.deepEqual(parseReviewId('20260918-093000-edit-abc123.deadbeef'), { jobId: '20260918-093000-edit-abc123', digest: 'deadbeef' });
    for (const bad of ['', 'nonsense', '20260918-093000-edit-abc123', '../../etc/passwd']) assert.equal(parseReviewId(bad), null);
  });

  it('reads back a review it wrote', async (t) => {
    const { job, resultsDir } = await createTestJob(t, 'edit');
    const key = createReviewKey({ cwd: '/work', task: 't', allowlist: new Map([['a.cs', {}]]), platform: 'linux' });
    const { reviewId } = await writeReview(job, key, [change('a.cs', 'old\n', 'new\n')]);
    const review = await readReview(resultsDir, reviewId);
    assert.equal(review?.jobId, job.id);
    assert.equal(review?.record.changes[0].relativePath, 'a.cs');
  });

  it('refuses a review record that changed after it was reviewed', async (t) => {
    const { job, resultsDir } = await createTestJob(t, 'edit');
    const key = createReviewKey({ cwd: '/work', task: 't', allowlist: new Map([['a.cs', {}]]), platform: 'linux' });
    const { reviewId } = await writeReview(job, key, [change('a.cs', 'old\n', 'new\n')]);
    const recordPath = path.join(job.dir, 'review.json');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    record.changes[0].newBytesBase64 = Buffer.from('tampered\n', 'utf8').toString('base64');
    await fs.writeFile(recordPath, JSON.stringify(record), 'utf8');
    assert.equal(await readReview(resultsDir, reviewId), null);
  });

  it('returns nothing for an unknown review id', async (t) => {
    const { resultsDir } = await createTestJob(t, 'edit');
    assert.equal(await readReview(resultsDir, '20260918-093000-edit-abc123.deadbeef'), null);
  });
});

describe('envelope payload', () => {
  /** @returns {any} */
  const job = () => ({
    id: '20260918-093000-ask-abc123',
    dir: '/results/20260918-093000-ask-abc123',
    command: 'ask',
    cwd: '/work',
    startedMs: NOW - 2100,
    fileCount: 2,
    localInputChars: 4000,
    promptTokensEstimate: 5210,
    promptTokensActual: 5024,
    outputTokens: 812,
    warnings: ['a warning'],
  });

  it('carries the spec 12.4 fields under data, as one wire format', () => {
    const result = buildJobResult({
      job: job(),
      outcome: { status: 'ok', exitCode: EXIT.OK, answer: 'the answer', resultPath: '/results/answer.md' },
      target: { model: 'ocu-qwen3-coder-30b-16k', numCtx: 16384 },
      now: () => NOW,
    });
    assert.deepEqual(
      {
        jobId: result.data.jobId,
        status: result.data.status,
        model: result.data.model,
        numCtx: result.data.numCtx,
        promptTokensEstimate: result.data.promptTokensEstimate,
        promptTokensActual: result.data.promptTokensActual,
        outputTokens: result.data.outputTokens,
        durationMs: result.data.durationMs,
        resultPath: result.data.resultPath,
        summary: result.data.summary,
      },
      {
        jobId: '20260918-093000-ask-abc123',
        status: 'ok',
        model: 'ocu-qwen3-coder-30b-16k',
        numCtx: 16384,
        promptTokensEstimate: 5210,
        promptTokensActual: 5024,
        outputTokens: 812,
        durationMs: 2100,
        resultPath: '/results/answer.md',
        summary: 'the answer',
      },
    );
    assert.doesNotThrow(() => createEnvelope({ command: 'delegate ask', ...result }));
  });

  it('caps the summary at 4000 characters and says it did', () => {
    const result = buildJobResult({
      job: job(),
      outcome: { status: 'ok', exitCode: EXIT.OK, answer: 'x'.repeat(SUMMARY_LIMIT + 100) },
      target: { model: 'm', numCtx: 16384 },
      now: () => NOW,
    });
    assert.equal(result.summary.length, SUMMARY_LIMIT);
    assert.equal(result.data.summaryTruncated, true);
    assert.equal(result.data.answerChars, SUMMARY_LIMIT + 100);
  });

  it('keeps the tail when the useful part is at the end, such as a build log', () => {
    const answer = `${'x'.repeat(SUMMARY_LIMIT)}THE ERROR`;
    const result = buildJobResult({
      job: job(),
      outcome: { status: 'check_failed_restored', exitCode: EXIT.CHECK_FAILED, answer, answerFromEnd: true },
      target: { model: 'm', numCtx: 16384 },
      now: () => NOW,
    });
    assert.ok(result.summary.endsWith('THE ERROR'));
  });

  it('adds the orchestrator action of a refusal, and none for success', () => {
    const refused = buildJobResult({
      job: job(),
      outcome: { status: 'context_overflow', exitCode: EXIT.BUDGET, code: 'context_budget_exceeded' },
      target: { model: 'm', numCtx: 16384 },
      now: () => NOW,
    });
    assert.equal(refused.data.orchestratorAction, 'split_with_map');
    const ok = buildJobResult({ job: job(), outcome: { status: 'ok', exitCode: EXIT.OK }, target: { model: 'm', numCtx: 16384 }, now: () => NOW });
    assert.equal(ok.data.orchestratorAction, undefined);
  });

  it('carries the review id when there is one', () => {
    const result = buildJobResult({
      job: job(),
      outcome: { status: 'dry_run', exitCode: EXIT.OK, reviewId: '20260918-093000-edit-abc123.deadbeef' },
      target: { model: 'm', numCtx: 16384 },
      now: () => NOW,
    });
    assert.equal(result.data.reviewId, '20260918-093000-edit-abc123.deadbeef');
  });

  it('writes a meta record without repeating the summary', () => {
    const result = buildJobResult({ job: job(), outcome: { status: 'ok', exitCode: EXIT.OK, answer: 'text' }, target: { model: 'm', numCtx: 16384 }, now: () => NOW });
    const meta = JSON.parse(renderJobMeta(job(), result));
    assert.equal(meta.command, 'ask');
    assert.equal(meta.summary, undefined);
    assert.deepEqual(meta.warnings, ['a warning']);
  });
});

describe('orchestrator actions', () => {
  it('maps every refusal of amendment 36.6 to one of the three values', () => {
    assert.equal(getOrchestratorAction('gpu_busy'), 'do_it_yourself');
    assert.equal(getOrchestratorAction('ollama_unreachable'), 'do_it_yourself');
    assert.equal(getOrchestratorAction('lock_timeout'), 'retry_later');
    assert.equal(getOrchestratorAction('context_budget_exceeded'), 'split_with_map');
    assert.equal(getOrchestratorAction('delegate_unsupported'), 'do_it_yourself');
    assert.equal(getOrchestratorAction('consent_required'), 'do_it_yourself');
    assert.equal(getOrchestratorAction('edit_invalid'), undefined);
  });

  it('adds the action to an error without overwriting one that is already there', () => {
    const error = { code: 'gpu_busy', data: /** @type {Record<string, unknown>} */ ({}) };
    assert.equal(attachOrchestratorAction(error).data.orchestratorAction, 'do_it_yourself');
    const kept = { code: 'gpu_busy', data: { orchestratorAction: 'retry_later' } };
    assert.equal(attachOrchestratorAction(kept).data.orchestratorAction, 'retry_later');
  });

  it('counts only the statuses whose result an orchestrator could use', () => {
    assert.deepEqual([...USABLE_STATUSES], ['ok', 'partial', 'dry_run', 'applied', 'check_failed_kept']);
  });
});
