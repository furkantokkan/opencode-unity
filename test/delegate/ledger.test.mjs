// The delegate ledger (spec 12.2). It has to answer "what did the local model do for me" without ever
// keeping a prompt, a file or an answer, and its savings figure has to stay an estimate.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import { appendLedger, parseLedger, parseSince, readLedger, renderLedgerText, summarizeLedger } from '../../src/delegate/ledger.js';
import { catchError } from '../helpers/catch-error.mjs';
import { useSandbox } from '../helpers/sandbox.mjs';

const NOW = Date.parse('2026-09-18T12:00:00.000Z');

/**
 * @param {Partial<import('../../src/delegate/ledger.js').LedgerEntry>} [overrides]
 * @returns {import('../../src/delegate/ledger.js').LedgerEntry}
 */
function entry(overrides = {}) {
  return {
    jobId: '20260918-093000-ask-abc123',
    command: 'ask',
    cwd: '/work',
    fileCount: 2,
    localInputChars: 4000,
    summaryChars: 800,
    promptTokens: 1200,
    outputTokens: 300,
    seconds: 12.5,
    status: 'ok',
    exitCode: 0,
    timestamp: '2026-09-18T09:30:00.000Z',
    ...overrides,
  };
}

describe('parseSince', () => {
  it('reads a duration relative to now', () => {
    assert.equal(parseSince('7d', { now: () => NOW }), NOW - 7 * 86_400_000);
    assert.equal(parseSince('12h', { now: () => NOW }), NOW - 12 * 3_600_000);
    assert.equal(parseSince('30m', { now: () => NOW }), NOW - 30 * 60_000);
    assert.equal(parseSince('2w', { now: () => NOW }), NOW - 14 * 86_400_000);
  });

  it('reads an ISO date', () => {
    assert.equal(parseSince('2026-09-01'), Date.parse('2026-09-01'));
  });

  it('means everything when it is missing', () => {
    assert.equal(parseSince(undefined), Number.NEGATIVE_INFINITY);
  });

  it('refuses anything else with a usage error', () => {
    const error = catchError(() => parseSince('last tuesday'));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.match(error.message, /duration such as '7d'/);
  });
});

describe('the ledger file', () => {
  it('appends one JSON line per job and reads it back', async (t) => {
    const sandbox = await useSandbox(t, 'ledger');
    const ledgerPath = path.join(sandbox.root, 'state', 'delegate', 'ledger.jsonl');
    await appendLedger(ledgerPath, entry());
    await appendLedger(ledgerPath, entry({ jobId: 'second', command: 'map' }));
    const text = await fs.readFile(ledgerPath, 'utf8');
    assert.equal(text.split('\n').filter(Boolean).length, 2);
    assert.equal((await readLedger(ledgerPath)).length, 2);
  });

  it('is empty when no job has ever run', async (t) => {
    const sandbox = await useSandbox(t, 'ledger-empty');
    assert.deepEqual(await readLedger(path.join(sandbox.root, 'missing.jsonl')), []);
  });

  it('skips a torn line instead of failing the report', () => {
    assert.equal(parseLedger(`${JSON.stringify(entry())}\n{"jobId": "torn`).length, 1);
  });
});

describe('summarizeLedger', () => {
  it('counts jobs per command and per status', () => {
    const summary = summarizeLedger([entry(), entry({ command: 'map', status: 'partial' }), entry({ command: 'map', status: 'ok' })], { now: () => NOW });
    assert.equal(summary.jobs, 3);
    assert.deepEqual(summary.byCommand.map, { jobs: 2, statuses: { partial: 1, ok: 1 } });
    assert.deepEqual(summary.byStatus, { ok: 2, partial: 1 });
  });

  it('adds the tokens, characters and seconds', () => {
    const summary = summarizeLedger([entry(), entry()], { now: () => NOW });
    assert.equal(summary.promptTokens, 2400);
    assert.equal(summary.outputTokens, 600);
    assert.equal(summary.localInputChars, 8000);
    assert.equal(summary.summaryChars, 1600);
    assert.equal(summary.seconds, 25);
  });

  it('counts only usable jobs as paid tokens avoided, and labels the figure an estimate', () => {
    const summary = summarizeLedger([entry(), entry({ status: 'gpu_busy', promptTokens: 0, outputTokens: 0 }), entry({ status: 'edit_invalid' })], { now: () => NOW });
    assert.equal(summary.estimatedPaidTokensAvoided, 1500);
    assert.match(summary.estimateNote, /estimate/);
    assert.doesNotMatch(summary.estimateNote, /\$|USD|cost/);
  });

  it('drops entries older than --since', () => {
    const summary = summarizeLedger([entry({ timestamp: '2026-09-01T00:00:00.000Z' }), entry()], { since: '1d', now: () => NOW });
    assert.equal(summary.jobs, 1);
  });

  it('ignores an entry without a usable timestamp', () => {
    assert.equal(summarizeLedger([entry({ timestamp: 'nonsense' })], { now: () => NOW }).jobs, 0);
  });

  it('treats missing counters as zero rather than NaN', () => {
    const summary = summarizeLedger([/** @type {any} */ ({ command: 'ask', status: 'ok', timestamp: entry().timestamp })], { now: () => NOW });
    assert.equal(summary.promptTokens, 0);
    assert.equal(summary.estimatedPaidTokensAvoided, 0);
  });
});

describe('renderLedgerText', () => {
  it('reads as a report a person can scan, and never as a currency', () => {
    const text = renderLedgerText(summarizeLedger([entry(), entry({ command: 'edit', status: 'dry_run' })], { now: () => NOW }), '<home>/state/delegate/ledger.jsonl');
    assert.match(text, /2 delegate jobs/);
    assert.match(text, /ask: 1 \(ok=1\)/);
    assert.match(text, /edit: 1 \(dry_run=1\)/);
    assert.match(text, /paid tokens avoided \(estimate\)/);
    assert.doesNotMatch(text, /\$/);
  });

  it('names the window when one was asked for', () => {
    assert.match(renderLedgerText(summarizeLedger([entry()], { since: '7d', now: () => NOW }), '/l.jsonl'), /since 7d/);
  });
});
