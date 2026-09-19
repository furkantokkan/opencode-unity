import assert from 'node:assert/strict';
import test from 'node:test';
import { EDIT_CASES, runEditBenchmark } from '../../src/bench/edits.js';
import { run } from '../../src/commands/bench.js';
import { CliError } from '../../src/cli/exit-codes.js';
import { buildTestProfile } from '../plugin/helpers/profile.mjs';
import { useSandbox } from '../helpers/sandbox.mjs';

const profile = buildTestProfile();
const response = (content, truncated = false) => ({ response: { content, promptTokens: 70, outputTokens: 15 }, truncated, durationMs: 50, guard: { verdict: 'pass' } });

test('live edit benchmark checks exact content and exposes measured token totals', async () => {
  let calls = 0;
  const report = await runEditBenchmark({ profile, runs: 2, temperature: 0.2, chat: async (input) => {
    assert.equal(input.command, 'bench edits');
    assert.equal(input.profile, profile);
    assert.equal(input.sampling.temperature, 0.2);
    assert.equal(input.maxOutputTokens, 256);
    assert.equal(input.timeoutMs, 120000);
    assert.equal(input.format.additionalProperties, false);
    const fixture = EDIT_CASES[calls++ % EDIT_CASES.length];
    return response(JSON.stringify({ replacement: fixture.expected }));
  } });
  assert.equal(report.total, 6);
  assert.equal(report.passed, 6);
  assert.equal(report.inputTokens, 420);
  assert.equal(report.outputTokens, 90);
  assert.equal(report.mode, 'native-ollama-text');
});

test('malformed replies, wrong replacements and truncation each fail', async () => {
  const answers = [response('not json'), response(JSON.stringify({ replacement: 'wrong' })), response(JSON.stringify({ replacement: EDIT_CASES[2].expected }), true)];
  const report = await runEditBenchmark({ profile, runs: 1, chat: async () => answers.shift() });
  assert.equal(report.ok, false);
  assert.equal(report.passed, 0);
  assert.deepEqual(report.trials.map((trial) => trial.reason), ['replacement_mismatch', 'replacement_mismatch', 'context_truncated']);
});

test('guard refusal and cancellation stop without another request', async () => {
  let calls = 0;
  await assert.rejects(runEditBenchmark({ profile, runs: 2, chat: async () => { calls++; throw new CliError('guard blocked', { exitCode: 2 }); } }), /guard blocked/);
  assert.equal(calls, 1);
  const signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(runEditBenchmark({ profile, runs: 1, signal, chat: async () => { calls++; return response(''); } }), /cancelled/);
  assert.equal(calls, 1);
});

function context(suite, options = {}) {
  return { args: { suite }, options, global: {}, version: '0.1.0-test', env: {}, platform: process.platform, output: { json: true, warn() {}, text() {} } };
}

test('unsupported benchmark suites fail before profile or model work', async () => {
  for (const suite of ['toolcalls', 'editor', 'all', 'guard', 'budget']) await assert.rejects(run(context(suite)), (error) => error.exitCode === 8 && error.code === 'prerequisite_missing');
  await assert.rejects(run(context('edits', { mock: true })), /no verified runner/);
  await assert.rejects(run(context('budget', { mock: true, temperature: 1 })), /only meaningful/);
  await assert.rejects(run(context('edits', { runs: 0 })), /between 1 and 1000/);
});

test('mock guard and budget report protocol results without claiming model reliability', async () => {
  const ids = [];
  const result = await run(context('all', { mock: true, runs: 2 }), { diagnostics: async (options) => {
    ids.push(options.ids);
    return { ok: ids.length !== 2, scenarios: [] };
  } });
  assert.equal(result.exitCode, 5);
  assert.equal(ids.length, 2);
  assert.ok(ids[0].includes('C5') && ids[0].includes('C8-overflow'));
  assert.equal(result.data.realModelLoaded, false);
  assert.equal(result.data.modelReliabilityMeasured, false);
});

test('live command resolves the installed profile before handing it to the guarded benchmark', async (t) => {
  const sandbox = await useSandbox(t, 'bench-edits');
  const input = { ...context('edits', { runs: 1 }), env: sandbox.env, interrupts: { addCleanup: () => () => {} } };
  const result = await run(input, { edits: async (options) => {
    assert.equal(options.runs, 1);
    assert.equal(options.profile.provider.numCtx, 16384);
    assert.ok(options.profile.home.startsWith(sandbox.root));
    return { ok: true, passed: 3, total: 3 };
  } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.data.passed, 3);
});

test('dry-run never calls the model or the diagnostic launcher', async () => {
  const fail = async () => { throw new Error('unexpected work'); };
  for (const [suite, options] of [['edits', {}], ['budget', { mock: true }]]) {
    const result = await run({ ...context(suite, options), global: { dryRun: true } }, { edits: fail, diagnostics: fail });
    assert.equal(result.data.dryRun, true);
  }
});
