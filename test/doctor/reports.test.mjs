// The three renderers over a synthetic context. The platform block comes first in every mode
// (amendment 33.9), and nothing a check did not find appears as if it had.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findCheck } from '../../src/doctor/checks/index.js';
import { runChecks } from '../../src/doctor/engine.js';
import { error, info, pass, skip, warn } from '../../src/doctor/finding.js';
import { buildJsonReport } from '../../src/doctor/report-json.js';
import { renderMarkdownReport } from '../../src/doctor/report-markdown.js';
import { renderExplanation, renderPlatformBlock, renderTextReport } from '../../src/doctor/report-text.js';
import { MAC_FACTS, makeContext } from './helpers.mjs';

/** @type {readonly import('../../src/doctor/engine.js').CheckSpec[]} */
const CHECKS = Object.freeze([
  { id: 'ollama.a', group: 'ollama', title: 'A', severities: ['error'], why: 'why a', fix: 'fix a', source: 'src a', run: () => error('broken | piped', { details: ['detail line'], data: { n: 1 } }) },
  { id: 'unity.b', group: 'unity', title: 'B', severities: ['warn'], why: 'why b', fix: 'fix b', source: 'src b', run: () => warn('odd') },
  { id: 'gpu.c', group: 'gpu', title: 'C', severities: ['info'], why: 'why c', fix: 'fix c', source: 'src c', run: () => info('noted') },
  { id: 'setup.d', group: 'setup', title: 'D', severities: ['warn'], why: 'why d', fix: 'fix d', source: 'src d', run: () => pass('fine') },
  { id: 'setup.e', group: 'setup', title: 'E', severities: ['warn'], why: 'why e', fix: 'fix e', source: 'src e', run: () => skip('not here') },
]);

describe('text report', () => {
  it('starts with the platform block and ends with the summary', () => {
    const context = makeContext({ facts: MAC_FACTS });
    const text = renderTextReport(context, runChecks(context, { checks: CHECKS }));
    const lines = text.split('\n');
    assert.equal(lines[0], 'Platform support');
    assert.match(lines[1], /machine +darwin\/arm64/);
    assert.match(text, /doctor tier +degraded \(macOS 14\+, Apple silicon\)/);
    assert.match(text, /not measured +accelerator\.memory/);
    assert.equal(lines.at(-1), '1 error, 1 warning, 1 note (1 check clean, 1 not applicable)');
  });

  it('prints problems with their fix, hides clean and skipped checks unless verbose', () => {
    const context = makeContext();
    const report = runChecks(context, { checks: CHECKS });
    const text = renderTextReport(context, report);
    assert.match(text, /ERROR +ollama\.a {2}broken \| piped\n {12}detail line\n {12}fix: fix a/);
    assert.match(text, /INFO +gpu\.c {2}noted\n/);
    assert.doesNotMatch(text, /setup\.d/);
    assert.match(text, /Next steps\n {2}- fix a\n {2}- fix b/);
    const verbose = renderTextReport(context, report, { verbose: true });
    assert.match(verbose, /ok +setup\.d {2}fine/);
    assert.match(verbose, /skipped +setup\.e {2}not here/);
  });

  it('says why a finding was lowered', () => {
    const context = makeContext({ home: { installed: false } });
    const text = renderTextReport(context, runChecks(context, { checks: CHECKS }));
    assert.match(text, /WARN +ollama\.a/);
    assert.match(text, /reported as warn because opencode-unity is not set up/);
  });

  it('says so when nothing needs attention', () => {
    const context = makeContext();
    const text = renderTextReport(context, runChecks(context, { checks: [CHECKS[3]] }));
    assert.match(text, /Findings\n {2}nothing to report/);
    assert.doesNotMatch(text, /Next steps/);
  });

  it('names a WSL host and a missing project in the platform block', () => {
    const context = makeContext({ facts: { ...MAC_FACTS, virtualization: 'container' }, project: { root: null }, opencode: { binary: { path: null, version: null, error: 'x' } }, ollama: { version: null } });
    const block = renderPlatformBlock(context).join('\n');
    assert.match(block, /inside container/);
    assert.match(block, /\(no Unity project\)/);
    assert.match(block, /not found on PATH/);
    assert.match(block, /\(no answer\)/);
  });

  it('explains one check', () => {
    const check = findCheck('platform.virtualized-host');
    assert.ok(check);
    const text = renderExplanation(check);
    assert.match(text, /^platform\.virtualized-host {2}Virtualized host/);
    assert.match(text, /keeps its severity even before/);
    assert.doesNotMatch(renderExplanation(/** @type {any} */ (findCheck('gpu.guard'))), /keeps its severity/);
  });
});

describe('markdown report', () => {
  it('has a platform table, a findings table with escaped cells, details and the skipped list', () => {
    const context = makeContext({ facts: MAC_FACTS });
    const markdown = renderMarkdownReport(context, runChecks(context, { checks: CHECKS }));
    assert.match(markdown, /^# opencode-unity doctor 0\.1\.0\n/);
    assert.match(markdown, /\| Doctor tier \| degraded \(macOS 14\+, Apple silicon\) \|/);
    assert.match(markdown, /\| ERROR \| `ollama\.a` \| broken \\\| piped \|/);
    assert.match(markdown, /<details><summary><code>ollama\.a<\/code>/);
    assert.match(markdown, /"n": 1/);
    assert.match(markdown, /- `setup\.e`: not here/);
    assert.doesNotMatch(markdown, /setup\.d/);
  });

  it('records the declared severity of a lowered finding', () => {
    const context = makeContext({ home: { installed: false } });
    const markdown = renderMarkdownReport(context, runChecks(context, { checks: CHECKS }));
    assert.match(markdown, /severity: WARN \(declared ERROR, lowered: not-installed\)/);
  });

  it('handles an empty report', () => {
    const context = makeContext();
    const markdown = renderMarkdownReport(context, runChecks(context, { checks: [] }));
    assert.match(markdown, /Nothing to report\./);
    assert.match(markdown, /Every check applied\./);
  });
});

describe('json report', () => {
  it('puts the platform first and carries every finding, including clean and skipped ones', () => {
    const context = makeContext({ facts: MAC_FACTS });
    const data = buildJsonReport(context, runChecks(context, { checks: CHECKS }));
    assert.equal(Object.keys(data)[0], 'platform');
    const platform = /** @type {any} */ (data.platform);
    assert.equal(platform.tier, 'degraded');
    assert.equal(platform.backend, 'darwin-unified');
    assert.ok(platform.capabilities.every((/** @type {any} */ capability) => typeof capability.applicable === 'boolean'));
    const checks = /** @type {any[]} */ (data.checks);
    assert.deepEqual(checks.map((check) => check.severity).sort(), ['error', 'info', 'pass', 'skip', 'warn']);
    assert.equal(data.scope, 'installed');
    assert.deepEqual(data.counts, { error: 1, warn: 1, info: 1, pass: 1, skip: 1 });
  });

  it('reports the deep result only when a deep run happened', () => {
    const deep = { config: { label: 'debug config', args: [], exitCode: 0, value: {}, error: null }, agents: [], ok: true };
    const withDeep = buildJsonReport(makeContext({ opencode: { deep } }), runChecks(makeContext(), { checks: [] }));
    assert.deepEqual(/** @type {any} */ (withDeep.opencode).deep, { ok: true });
    const without = buildJsonReport(makeContext(), runChecks(makeContext(), { checks: [] }));
    assert.equal(/** @type {any} */ (without.opencode).deep, null);
  });
});
