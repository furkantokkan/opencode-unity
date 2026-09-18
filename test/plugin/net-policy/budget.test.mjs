// The outbound budget of amendment 35.6.3 (`DN14`, `DN26`). The point of these tests is the
// arithmetic: the published ceiling has to be what the shipped caps actually produce, and the
// intersection has to pick the smallest cap rather than the first one.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_ENTRY_BUDGET,
  checkOutboundBudget,
  createOutboundLedger,
  intersectBudgets,
  measureBodyBytes,
  normalizeBudget,
  sessionOutboundCeiling,
} from '../../../plugin/opencode-unity-lib/net/budget.js';

const DOC_BUDGET = { maxPathChars: 512, maxQueryChars: 128, maxRequestBodyBytes: 0 };
const LOOPBACK_WRITE_BUDGET = { maxPathChars: 2048, maxQueryChars: 1024, maxRequestBodyBytes: 8192 };

describe('net/budget: reading a declared budget', () => {
  it('falls back to the narrowest row rather than to no cap', () => {
    assert.deepEqual(normalizeBudget(undefined), DEFAULT_ENTRY_BUDGET);
    assert.deepEqual(normalizeBudget({}), DEFAULT_ENTRY_BUDGET);
    assert.deepEqual(normalizeBudget({ maxPathChars: 'lots' }), DEFAULT_ENTRY_BUDGET);
    assert.deepEqual(normalizeBudget({ maxPathChars: -1 }), DEFAULT_ENTRY_BUDGET);
    assert.deepEqual(normalizeBudget({ maxPathChars: 1.5 }), DEFAULT_ENTRY_BUDGET);
  });

  it('keeps a declared cap, including a zero one', () => {
    assert.deepEqual(normalizeBudget(LOOPBACK_WRITE_BUDGET), LOOPBACK_WRITE_BUDGET);
    assert.equal(normalizeBudget({ maxRequestBodyBytes: 0 }).maxRequestBodyBytes, 0);
  });
});

describe('net/budget: the intersection', () => {
  it('takes the smallest cap of every matching entry, cap by cap', () => {
    assert.deepEqual(intersectBudgets([LOOPBACK_WRITE_BUDGET, DOC_BUDGET]), DOC_BUDGET);
    assert.deepEqual(intersectBudgets([
      { maxPathChars: 2048, maxQueryChars: 64, maxRequestBodyBytes: 8192 },
      { maxPathChars: 512, maxQueryChars: 1024, maxRequestBodyBytes: 0 },
    ]), { maxPathChars: 512, maxQueryChars: 64, maxRequestBodyBytes: 0 });
  });

  it('does not widen a cap when a permissive entry joins the set', () => {
    const narrow = { maxPathChars: 64, maxQueryChars: 8, maxRequestBodyBytes: 0 };
    const wide = { maxPathChars: 65536, maxQueryChars: 65536, maxRequestBodyBytes: 65536 };
    assert.deepEqual(intersectBudgets([narrow, wide]), narrow);
    assert.deepEqual(intersectBudgets([wide, narrow]), narrow, 'array order is not a boundary');
  });

  it('returns the default for an empty or unusable set', () => {
    assert.deepEqual(intersectBudgets([]), DEFAULT_ENTRY_BUDGET);
    assert.deepEqual(intersectBudgets(/** @type {any} */ (null)), DEFAULT_ENTRY_BUDGET);
  });
});

describe('net/budget: spending it', () => {
  it('allows a request inside every cap and reports what it spent', () => {
    const result = checkOutboundBudget({ path: '/Manual/Profiler.html', query: 'q=gc' }, DOC_BUDGET);
    assert.equal(result.ok, true);
    assert.deepEqual(result.spent, { path: 21, query: 4, body: 0 });
  });

  it('names the cap that failed, its limit and what was asked for', () => {
    const long = `/${'a'.repeat(600)}`;
    const result = checkOutboundBudget({ path: long, query: '' }, DOC_BUDGET);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'net_budget_exceeded');
    assert.equal(result.field, 'path');
    assert.equal(result.limit, 512);
    assert.equal(result.actual, 601);
  });

  it('refuses any body at all against a zero cap, which is what every read entry has', () => {
    const result = checkOutboundBudget({ path: '/x', body: 'a' }, DOC_BUDGET);
    assert.equal(result.ok, false);
    assert.equal(result.field, 'body');
    assert.equal(result.limit, 0);
  });

  it('measures the body in bytes, not characters', () => {
    const twoBytesPerCharacter = String.fromCodePoint(0x00e9).repeat(10);
    assert.equal(measureBodyBytes(twoBytesPerCharacter), 20);
    assert.equal(measureBodyBytes(''), 0);
    assert.equal(measureBodyBytes(undefined), 0);
    const result = checkOutboundBudget({ path: '/x', body: twoBytesPerCharacter }, { ...DOC_BUDGET, maxRequestBodyBytes: 15 });
    assert.equal(result.ok, false, 'ten characters is twenty bytes');
  });

  it('prefers a byte count the caller already measured', () => {
    assert.equal(checkOutboundBudget({ path: '/x', bodyBytes: 8192 }, LOOPBACK_WRITE_BUDGET).ok, true);
    assert.equal(checkOutboundBudget({ path: '/x', bodyBytes: 8193 }, LOOPBACK_WRITE_BUDGET).ok, false);
  });
});

describe('net/budget: the published ceiling', () => {
  it('is the number 35.6.3 prints for a documentation host', () => {
    assert.equal(sessionOutboundCeiling(DOC_BUDGET, 40), 25600, 'about 25 KiB across a whole session');
  });

  it('is the number 35.6.3 prints for a project that asked for a local write path', () => {
    assert.equal(sessionOutboundCeiling(LOOPBACK_WRITE_BUDGET, 40), 450_560, 'about 440 KiB');
  });

  it('is zero without a request allowance', () => {
    assert.equal(sessionOutboundCeiling(DOC_BUDGET, 0), 0);
    assert.equal(sessionOutboundCeiling(DOC_BUDGET, -1), 0);
  });
});

describe('net/budget: the session ledger', () => {
  it('stops at the session cap', () => {
    const ledger = createOutboundLedger({ maxRequestsPerSession: 2, maxRequestsPerMinute: 99, now: () => 0 });
    assert.equal(ledger.check().ok, true);
    ledger.record({ entryIds: ['unity-docs'], bytes: 100 });
    ledger.record({ entryIds: ['unity-docs'], bytes: 50 });
    const blocked = ledger.check();
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'net_rate_limited');
    assert.equal(blocked.scope, 'session');
    assert.equal(blocked.limit, 2);
  });

  it('stops at the per-minute cap and recovers when the window rolls', () => {
    let clock = 1_000;
    const ledger = createOutboundLedger({ maxRequestsPerSession: 99, maxRequestsPerMinute: 2, now: () => clock });
    ledger.record({});
    ledger.record({});
    assert.equal(ledger.check().scope, 'minute');
    clock += 60_001;
    assert.equal(ledger.check().ok, true, 'the window is a minute, not the session');
  });

  it('counts outbound bytes per entry, which is what status prints', () => {
    const ledger = createOutboundLedger({ now: () => 0 });
    ledger.record({ entryIds: ['loopback-dev', 'firebase-functions'], bytes: 300 });
    ledger.record({ entryIds: ['unity-docs'], bytes: 20 });
    assert.deepEqual(ledger.snapshot(), {
      requests: 2,
      bytes: 320,
      entries: [
        { id: 'firebase-functions', requests: 1, bytes: 300 },
        { id: 'loopback-dev', requests: 1, bytes: 300 },
        { id: 'unity-docs', requests: 1, bytes: 20 },
      ],
    });
  });
});
