import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHECK_GROUPS, countSeverities, hasFailingFindings, runChecks, summarize } from '../../src/doctor/engine.js';
import { error, info, isAtLeast, pass, quantity, skip, warn, worstSeverity } from '../../src/doctor/finding.js';
import { makeContext } from './helpers.mjs';

/**
 * @param {string} id
 * @param {(context: any) => any} run
 * @param {Partial<import('../../src/doctor/engine.js').CheckSpec>} [rest]
 * @returns {import('../../src/doctor/engine.js').CheckSpec}
 */
function check(id, run, rest = {}) {
  return { id, group: 'setup', title: id, severities: ['error'], why: 'why', fix: 'fix', source: 'test', run, ...rest };
}

describe('doctor engine', () => {
  it('keeps the declared severity on an installed machine', () => {
    const report = runChecks(makeContext(), { checks: [check('t.error', () => error('broken'))] });
    assert.equal(report.findings[0].severity, 'error');
    assert.equal(report.findings[0].loweredBy, null);
    assert.equal(hasFailingFindings(report), true);
  });

  it('lowers an ERROR to WARN before setup has run, and records why', () => {
    const context = makeContext({ home: { installed: false } });
    const report = runChecks(context, { checks: [check('t.error', () => error('broken'))] });
    assert.equal(report.findings[0].severity, 'warn');
    assert.equal(report.findings[0].declaredSeverity, 'error');
    assert.equal(report.findings[0].loweredBy, 'not-installed');
    assert.equal(hasFailingFindings(report), false);
  });

  it('never lowers a check marked alwaysSevere', () => {
    const context = makeContext({ home: { installed: false } });
    const report = runChecks(context, { checks: [check('t.severe', () => error('wrong machine'), { alwaysSevere: true })] });
    assert.equal(report.findings[0].severity, 'error');
    assert.equal(hasFailingFindings(report), true);
  });

  it('never lowers a WARN any further, so --strict still fails before setup', () => {
    const context = makeContext({ home: { installed: false } });
    const report = runChecks(context, { checks: [check('t.warn', () => warn('odd'))], strict: true });
    assert.equal(report.findings[0].severity, 'warn');
    assert.equal(hasFailingFindings(report), true);
  });

  it('fails on WARN only under --strict', () => {
    const checks = [check('t.warn', () => warn('odd'))];
    assert.equal(hasFailingFindings(runChecks(makeContext(), { checks })), false);
    assert.equal(hasFailingFindings(runChecks(makeContext(), { checks, strict: true })), true);
  });

  it('reports a check that throws as an ERROR naming itself instead of ending the run', () => {
    const report = runChecks(makeContext(), {
      checks: [check('t.throws', () => { throw new Error('boom'); }), check('t.after', () => pass('fine'))],
    });
    assert.equal(report.findings.length, 2);
    assert.equal(report.findings[0].severity, 'error');
    assert.match(report.findings[0].message, /t\.throws.*boom/);
    assert.equal(report.findings[1].severity, 'pass');
  });

  it('turns null and an empty list into a skipped finding', () => {
    const report = runChecks(makeContext(), { checks: [check('t.null', () => null), check('t.empty', () => [])] });
    assert.deepEqual(report.findings.map((finding) => finding.severity), ['skip', 'skip']);
    assert.equal(report.checksRun, 0);
  });

  it('expands a list of outcomes into one finding each', () => {
    const report = runChecks(makeContext(), { checks: [check('t.many', () => [info('a'), warn('b')], { severities: ['warn', 'info'] })] });
    assert.deepEqual(report.findings.map((finding) => finding.message), ['a', 'b']);
  });

  it('orders findings by report group, not by registration order', () => {
    const report = runChecks(makeContext(), {
      checks: [check('u.late', () => info('unity'), { group: 'unity' }), check('p.early', () => info('platform'), { group: 'platform' })],
    });
    assert.deepEqual(report.findings.map((finding) => finding.id), ['p.early', 'u.late']);
  });

  it('uses the outcome fix when a check gives one, else the documented fix', () => {
    const report = runChecks(makeContext(), {
      checks: [check('t.own', () => warn('x', { fix: 'specific' })), check('t.doc', () => warn('y'))],
    });
    assert.deepEqual(report.findings.map((finding) => finding.fix), ['specific', 'fix']);
  });

  it('counts and summarizes every severity', () => {
    const report = runChecks(makeContext(), {
      checks: [check('a.a', () => error('e')), check('a.b', () => warn('w')), check('a.c', () => info('i')), check('a.d', () => pass('p')), check('a.e', () => skip('s'))],
    });
    assert.deepEqual(report.counts, { error: 1, warn: 1, info: 1, pass: 1, skip: 1 });
    assert.equal(report.worst, 'error');
    assert.equal(summarize(report), '1 error, 1 warning, 1 note (1 check clean, 1 not applicable)');
    assert.deepEqual(countSeverities([]), { error: 0, warn: 0, info: 0, pass: 0, skip: 0 });
  });

  it('pluralizes the summary', () => {
    const report = runChecks(makeContext(), { checks: [check('a.a', () => warn('1')), check('a.b', () => warn('2'))] });
    assert.equal(summarize(report), '0 errors, 2 warnings, 0 notes (0 checks clean, 0 not applicable)');
  });

  it('reports skip as the worst severity when nothing ran', () => {
    assert.equal(runChecks(makeContext(), { checks: [] }).worst, 'skip');
  });

  it('declares every group once', () => {
    const ids = CHECK_GROUPS.map((group) => group.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('severity helpers', () => {
  it('writes counts that need no verb agreement', () => {
    assert.equal(quantity(1, 'file'), '1 file');
    assert.equal(quantity(0, 'file'), '0 files');
    assert.equal(quantity(2, 'entry', 'entries'), '2 entries');
  });

  it('orders severities worst first', () => {
    assert.equal(worstSeverity('warn', 'error'), 'error');
    assert.equal(worstSeverity('error', 'info'), 'error');
    assert.equal(worstSeverity('skip', 'pass'), 'pass');
    assert.equal(isAtLeast('error', 'warn'), true);
    assert.equal(isAtLeast('info', 'warn'), false);
  });
});
