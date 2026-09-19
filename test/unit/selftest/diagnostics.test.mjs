import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliError } from '../../../src/cli/exit-codes.js';
import { DEFAULT_SELFTEST_PROFILE, runScenario, runSelftest, SELFTEST_SCENARIOS } from '../../../src/selftest/scenarios.js';
import { createSelftestLauncher } from '../../../src/selftest/launch.js';
import { EXPECTED_CODE_TOOLS, runDiagnostics, renderDiagnosticText } from '../../../src/selftest/diagnostics.js';
import { createFakeOpenCode } from './fake-opencode.mjs';

const options = { cliVersion: '0.1.0-test', env: {}, platform: process.platform };
const deps = {
  locate: () => ({ file: 'fixture-opencode', shim: null, source: 'path', notes: [] }),
  readVersion: async () => ({ version: '1.18.31', error: null }),
  launcher: () => createFakeOpenCode({ codeTools: EXPECTED_CODE_TOOLS }),
};

test('diagnostics capture the synthetic request and label token estimates honestly', async () => {
  const report = await runDiagnostics({ ...options, capture: true }, deps);
  assert.equal(report.ok, true);
  assert.equal(report.mode, 'capture');
  assert.equal(report.realModelLoaded, false);
  assert.equal(report.scenarios.length, 1);
  assert.ok(report.capture.estimatedToolTokens > 0);
  assert.match(report.capture.estimateMethod, /not model tokenizer usage/);
  assert.match(renderDiagnosticText(report), /PASS.*mock endpoint/);
  const text = JSON.stringify(report);
  assert.ok(!text.includes(os.homedir()));
  assert.ok(!text.includes('ocu-selftest-c1-'));
});

test('diagnostics reject unreadable and unmeasured OpenCode versions before a launch', async () => {
  await assert.rejects(runDiagnostics(options, { ...deps, readVersion: async () => ({ version: null, error: 'broken' }) }), /broken/);
  await assert.rejects(runDiagnostics(options, { ...deps, readVersion: async () => ({ version: '99.0.0', error: null }) }), (error) => error.code === 'opencode_version_unsupported');
  const report = await runDiagnostics({ ...options, experimental: true }, { ...deps, readVersion: async () => ({ version: '99.0.0', error: null }) });
  assert.equal(report.versionMeasured, false);
});

test('diagnostics run selected selftest scenarios and report failures', async () => {
  const report = await runDiagnostics({ ...options, selftest: true, ids: ['C1'] }, { ...deps, launcher: () => createFakeOpenCode({ codeTools: EXPECTED_CODE_TOOLS, faults: { C1: 'missing-facts' } }) });
  assert.equal(report.ok, false);
  assert.match(renderDiagnosticText(report), /FAIL C1/);
  assert.match(renderDiagnosticText(report), /system-contains-marker/);
  assert.deepEqual(report.scenarios[0].errors, []);
});

test('scenario selection cannot silently pass an empty or unknown set', async () => {
  for (const ids of [[], ['not-a-scenario'], ['C1', 'not-a-scenario']]) {
    await assert.rejects(runSelftest({ launch: deps.launcher(), cliVersion: 'test', opencodeVersion: 'test', expectations: { codeTools: EXPECTED_CODE_TOOLS }, ids }), /known, enabled scenario/);
  }
});

test('launcher copies a temporary profile, strips credentials and honors plugin failure variants', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ocu-launcher-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  for (const id of ['C1', 'C7-plugin-deleted', 'C7-plugin-broken', 'C7-pure']) {
    let called = false;
    const launch = createSelftestLauncher({ binary: 'fixture.exe', cliVersion: '0.1.0-test', env: { ...process.env, OPENAI_API_KEY: 'never-forward-me', OPENCODE_PERMISSION: 'allow' }, run: async (file, args, input) => {
      called = true;
      assert.equal(file, 'fixture.exe');
      assert.ok(args.includes('--print-logs'));
      assert.equal(input.env.OPENAI_API_KEY, undefined);
      assert.equal(input.env.OPENCODE_PERMISSION, undefined);
      assert.equal(input.env.npm_config_registry, 'http://127.0.0.1:9');
      assert.ok(input.env.HOME.startsWith(tempRoot));
      assert.ok(input.cwd.startsWith(tempRoot));
      const dir = input.env.OPENCODE_CONFIG_DIR;
      const runtime = JSON.parse(await fs.readFile(path.join(dir, 'opencode-unity.runtime.json'), 'utf8'));
      assert.match(runtime.ollama.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.ok(runtime.guard.nvidiaSmiCommand.startsWith(tempRoot));
      assert.equal(runtime.provider.numCtx, DEFAULT_SELFTEST_PROFILE.numCtx);
      if (id === 'C7-plugin-deleted') await assert.rejects(fs.access(path.join(dir, 'plugins', 'opencode-unity.js')));
      if (id === 'C7-plugin-broken') assert.match(await fs.readFile(path.join(dir, 'plugins', 'opencode-unity-lib', 'provider.js'), 'utf8'), /deliberately invalid/);
      if (id === 'C7-pure') assert.equal(input.env.OPENCODE_PURE, '1');
      return { exitCode: 1, stdout: '', stderr: 'Model not found', error: null, timedOut: false };
    } });
    await runScenario(SELFTEST_SCENARIOS.find((scenario) => scenario.id === id), { launch, expectations: { codeTools: EXPECTED_CODE_TOOLS }, tempRoot, attempts: 1 });
    assert.equal(called, true);
    assert.deepEqual(await fs.readdir(tempRoot), []);
  }
});

test('aborting before a diagnostic scenario does not start a child', async () => {
  const controller = new AbortController();
  controller.abort(new CliError('cancelled'));
  await assert.rejects(runDiagnostics({ ...options, signal: controller.signal }, deps), /cancelled/);
});
