import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildProjectFiles,
  buildScenarioEnv,
  DEFAULT_EDITOR_MCP_TOOLS,
  DEFAULT_SELFTEST_PROFILE,
  runScenario,
  runSelftest,
  SELFTEST_SCENARIOS,
  selectSelftestScenarios,
} from '../../../src/selftest/scenarios.js';
import { createFakeOpenCode } from './fake-opencode.mjs';

const CODE_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'todowrite', 'task'];
const expectations = { codeTools: CODE_TOOLS };

/**
 * @param {import('node:test').TestContext} t
 */
async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocu-scenarios-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {string} id
 * @param {{ faults?: Record<string, string>, attempts?: number, timeoutMs?: number }} [options]
 */
async function runById(t, id, { faults = {}, attempts, timeoutMs } = {}) {
  const scenario = SELFTEST_SCENARIOS.find((candidate) => candidate.id === id);
  assert.ok(scenario, `unknown scenario ${id}`);
  return runScenario(scenario, {
    launch: createFakeOpenCode({ codeTools: CODE_TOOLS, faults }),
    expectations,
    tempRoot: await tempRoot(t),
    attempts,
    timeoutMs,
  });
}

/**
 * @param {{ checks: import('../../../src/selftest/capture-checks.js').CheckResult[] }} scenarioResult
 */
function failedIds(scenarioResult) {
  return scenarioResult.checks.filter((check) => !check.ok).map((check) => check.id);
}

test('scenarios: the set covers the contracts the self-test must run (spec 20.4)', () => {
  assert.deepEqual([...new Set(SELFTEST_SCENARIOS.map((scenario) => scenario.contract))], ['C1', 'C5', 'C7', 'C8', 'C11', 'C12']);
  assert.deepEqual(selectSelftestScenarios().map((scenario) => scenario.id), [
    'C1', 'C5', 'C7-plugin-deleted', 'C7-plugin-broken', 'C7-pure', 'C8-overflow', 'C8-loop-breaker', 'C12-offline',
  ]);
  assert.ok(selectSelftestScenarios({ includeEditor: true }).some((scenario) => scenario.id === 'C11-editor'));
  assert.deepEqual(selectSelftestScenarios({ ids: ['C1'] }).map((scenario) => scenario.id), ['C1']);
  assert.deepEqual(DEFAULT_EDITOR_MCP_TOOLS, ['unityMCP_read_console', 'unityMCP_find_gameobjects', 'unityMCP_get_test_job', 'unityMCP_refresh_unity', 'unityMCP_run_tests']);
});

test('scenarios: C1 passes for a well-formed request and names each broken rule', async (t) => {
  const passed = await runById(t, 'C1');
  assert.deepEqual(failedIds(passed), []);
  assert.equal(passed.ok, true);
  assert.equal(passed.attempts, 1);
  assert.deepEqual(passed.exitCodes, [0]);
  assert.deepEqual(passed.checks.map((check) => check.id), [
    'no-native-load-calls', 'no-canaries', 'request-recorded', 'runs-succeeded',
    'single-system-message', 'system-contains-marker', 'sampling', 'tool-names', 'include-usage',
  ]);

  assert.deepEqual(failedIds(await runById(t, 'C1', { faults: { C1: 'second-system-message' } })), ['single-system-message']);
  assert.deepEqual(failedIds(await runById(t, 'C1', { faults: { C1: 'missing-facts' } })), ['system-contains-marker']);
  assert.deepEqual(failedIds(await runById(t, 'C1', { faults: { C1: 'wrong-sampling' } })), ['sampling']);
  assert.deepEqual(failedIds(await runById(t, 'C1', { faults: { C1: 'canary-leak' } })), ['no-canaries']);
});

test('scenarios: C5 proves the cold guard block, and fails when a request escapes', async (t) => {
  const blocked = await runById(t, 'C5');

  assert.deepEqual(failedIds(blocked), []);
  assert.deepEqual(blocked.exitCodes, [2]);
  const noRetry = blocked.checks.find((check) => check.id === 'no-retry');
  assert.match(noRetry.message, /^1 nvidia-smi calls/);

  const leaked = await runById(t, 'C5', { faults: { C5: 'guard-sends-request' } });
  assert.deepEqual(failedIds(leaked), ['no-model-load-requests']);
});

test('scenarios: each C7 variant proves that nothing is sent when the plugin is missing', async (t) => {
  for (const id of ['C7-plugin-deleted', 'C7-plugin-broken', 'C7-pure']) {
    const scenarioResult = await runById(t, id);
    assert.deepEqual(failedIds(scenarioResult), [], id);
    assert.deepEqual(scenarioResult.exitCodes, [1], id);
  }
});

test('scenarios: C8 sends no over-budget request, compacts once, and halts on the second overflow', async (t) => {
  const overflow = await runById(t, 'C8-overflow');
  assert.deepEqual(failedIds(overflow), []);
  const budget = overflow.checks.find((check) => check.id === 'prompts-within-budget');
  assert.match(budget.message, new RegExp(`budget ${DEFAULT_SELFTEST_PROFILE.promptBudget}$`));
  assert.match(overflow.checks.find((check) => check.id === 'compaction-requested').message, /^1 compaction requests/);

  const loopBreaker = await runById(t, 'C8-loop-breaker');
  assert.deepEqual(failedIds(loopBreaker), []);
  assert.deepEqual(loopBreaker.exitCodes, [1]);
});

test('scenarios: C11 checks the editor allow-list, the argument policy and the code session', async (t) => {
  const editor = await runById(t, 'C11-editor');

  assert.deepEqual(failedIds(editor), []);
  assert.deepEqual(editor.checks.map((check) => check.id), [
    'no-native-load-calls', 'no-canaries', 'editor-request-recorded', 'editor-mcp-tools', 'system-contains-marker',
    'code-session-clean', 'read-console-clear-rejected', 'play-mode-rejected', 'instance-argument-stripped', 'no-denied-tool-calls',
  ]);
  assert.match(editor.checks.find((check) => check.id === 'instance-argument-stripped').message, /no calls carrying unity_instance/);
});

test('scenarios: C12 proves an offline start reaches the provider', async (t) => {
  const offline = await runById(t, 'C12-offline');

  assert.deepEqual(failedIds(offline), []);
  assert.match(offline.checks.find((check) => check.id === 'provider-resolved').message, /^1 agent requests/);
});

test('scenarios: a hang is retried once and reported when it repeats', async (t) => {
  const recovered = await runById(t, 'C1', { faults: { C1: 'hang-once' }, timeoutMs: 200 });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.hangs, 1);

  const stuck = await runById(t, 'C1', { faults: { C1: 'hang' }, timeoutMs: 150 });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.hangs, 1);
  assert.equal(stuck.checks[0].id, 'no-hang');
  assert.deepEqual(stuck.exitCodes, [null]);
});

test('scenarios: the runner removes its temp directory and needs the expected tool names', async (t) => {
  const root = await tempRoot(t);

  await runScenario(SELFTEST_SCENARIOS[0], { launch: createFakeOpenCode({ codeTools: CODE_TOOLS }), expectations, tempRoot: root });

  assert.deepEqual(await fs.readdir(root), [], 'no scenario directory is left behind');
  await assert.rejects(
    () => runScenario(SELFTEST_SCENARIOS[0], { launch: createFakeOpenCode({ codeTools: CODE_TOOLS }), expectations: { codeTools: [] }, tempRoot: root }),
    /expectations.codeTools is required/,
  );
});

test('scenarios: runSelftest returns the record stored per OpenCode version', async (t) => {
  const started = [];
  const record = await runSelftest({
    launch: createFakeOpenCode({ codeTools: CODE_TOOLS }),
    opencodeVersion: '1.18.31',
    cliVersion: '0.1.0',
    expectations,
    ids: ['C1', 'C5'],
    tempRoot: await tempRoot(t),
    onScenarioStart: (scenario) => started.push(scenario.id),
  });

  assert.equal(record.schemaVersion, 1);
  assert.equal(record.opencodeVersion, '1.18.31');
  assert.equal(record.cliVersion, '0.1.0');
  assert.equal(record.editorAgent, false);
  assert.equal(record.ok, true);
  assert.deepEqual(record.scenarios.map((scenario) => scenario.id), ['C1', 'C5']);
  assert.deepEqual(started, ['C1', 'C5']);
  assert.ok(record.durationMs >= 0);
  assert.match(record.startedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('scenarios: the project files are fictional, and the large file is sized from the budget', () => {
  const plain = buildProjectFiles(SELFTEST_SCENARIOS[0], DEFAULT_SELFTEST_PROFILE);
  assert.deepEqual(Object.keys(plain), ['ProjectSettings/ProjectVersion.txt', 'Packages/manifest.json', 'Assets/Scripts/SelftestPlayer.cs']);
  assert.match(plain['ProjectSettings/ProjectVersion.txt'], /m_EditorVersion: 6000\./);

  const large = buildProjectFiles({ ...SELFTEST_SCENARIOS[0], large: true, editor: true }, DEFAULT_SELFTEST_PROFILE);
  const content = large['Assets/Scripts/SelftestLargeData.cs'];
  const budgetChars = DEFAULT_SELFTEST_PROFILE.promptBudget * DEFAULT_SELFTEST_PROFILE.charsPerToken;
  assert.ok(content.length > budgetChars * 0.5 && content.length < budgetChars, 'over one step, under a compaction request');
  assert.ok(content.split('\n').length <= 200, 'the read clamp keeps 200 lines');
  assert.match(large['Packages/manifest.json'], /com\.coplaydev\.unity-mcp/);
});

test('scenarios: the sandbox environment points every home and the backend at the temp dirs', () => {
  const env = buildScenarioEnv({ home: path.join('C:', 'temp', 'home'), tmpDir: path.join('C:', 'temp', 'tmp'), backendUrl: 'http://127.0.0.1:5123' });

  assert.equal(env.HOME, env.USERPROFILE);
  assert.equal(env.XDG_CONFIG_HOME, path.join('C:', 'temp', 'home', '.config'));
  assert.equal(env.OLLAMA_HOST, 'http://127.0.0.1:5123');
  assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, '1');
  assert.equal(env.TEMP, path.join('C:', 'temp', 'tmp'));
  assert.ok(!Object.values(env).some((value) => value.includes(':11434') || value.includes(':8081')), 'no real service address');
});
