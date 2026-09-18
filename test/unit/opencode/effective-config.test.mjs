// Spec 8.2: what `start` checks before it launches anything. The point of these tests is the hostile
// case: six config sources still merge after the clean-room environment of 8.1, rules are evaluated
// last-match, so a project file can re-allow anything we denied. V-a to V-e are the product's answer,
// and a failure must name the rule, the effective action and where it probably came from.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { EXIT } from '../../../src/cli/exit-codes.js';
import {
  AGENT_PROBE_TIMEOUT_MS,
  NON_NEGOTIABLE_TUPLES,
  buildNonNegotiableTuples,
  buildVerifyCacheKey,
  createVerificationError,
  formatTokens,
  formatVerificationFailure,
  listVisibleToolNames,
  toRuleset,
  verifyConfigShape,
  verifyEffectiveConfig,
  verifyInstructionFiles,
  verifyNonNegotiableRules,
  verifyPluginLoaded,
  verifyVisibleTools,
} from '../../../src/opencode/effective-config.js';
import { buildUnityCodePermission } from '../../../src/opencode/render.js';
import { looksRetryable } from '../../../src/opencode/retry-safety.js';

const MODEL_TAG = 'ocu-qwen3-coder-30b-16k';
const PROFILE_DIR = '/profile/current';
const FACTS_PATH = '/profile/projects/sample-1a2b3c4d/facts.md';
const EXPECTED_TOOLS = ['read', 'edit', 'write', 'bash', 'glob', 'grep', 'list', 'patch'];

/**
 * @param {string} name
 * @returns {Record<string, any>}
 */
function fixture(name) {
  return JSON.parse(fs.readFileSync(new URL(`../../fixtures/opencode/${name}.json`, import.meta.url), 'utf8'));
}

/** The permission a clean launch produces, which is what the good case must satisfy. */
function goodPermission() {
  return buildUnityCodePermission({ vcsKind: 'git', csprojNames: ['Assembly-CSharp.csproj'] });
}

/** @returns {Record<string, boolean>} */
function goodTools() {
  return Object.fromEntries(EXPECTED_TOOLS.map((name) => [name, true]));
}

describe('effective-config V-a plugin loaded', () => {
  it('passes on a clean exit', () => {
    assert.equal(verifyPluginLoaded({ exitCode: 0 }).ok, true);
    assert.equal(AGENT_PROBE_TIMEOUT_MS, 60000);
  });

  it('fails when the probe did not finish', () => {
    const check = verifyPluginLoaded({ exitCode: 0, timedOut: true });
    assert.equal(check.ok, false);
    assert.equal(check.failures[0].check, 'V-a');
    assert.match(check.failures[0].effective ?? '', /did not finish/);
  });

  it('says the provider was not injected when the model did not resolve', () => {
    const check = verifyPluginLoaded({ exitCode: 1, stderr: 'Error: Model not found: opencode-unity/x' });
    assert.equal(check.ok, false);
    assert.match(check.failures[0].effective ?? '', /injected no provider/);
    assert.match(check.failures[0].source ?? '', /plugins\/opencode-unity\.js/);
  });

  it('reports any other failing status', () => {
    assert.match(verifyPluginLoaded({ exitCode: 7 }).failures[0].effective ?? '', /status 7/);
  });
});

describe('effective-config V-b non-negotiable rules', () => {
  it('has the tuples of spec 8.5.4, grouped', () => {
    assert.equal(NON_NEGOTIABLE_TUPLES.length, 23);
    const groups = new Set(NON_NEGOTIABLE_TUPLES.map((tuple) => tuple.group));
    assert.deepEqual([...groups], ['edit', 'read', 'bash', 'other']);
  });

  it('passes for the permission this product renders', () => {
    const check = verifyNonNegotiableRules({ permission: goodPermission() });
    assert.deepEqual(check.failures, []);
  });

  it('still passes when the file system ignores case', () => {
    assert.equal(verifyNonNegotiableRules({ permission: goodPermission(), caseInsensitive: true }).ok, true);
  });

  it('catches the hostile project that re-allowed a version-control write', () => {
    const check = verifyNonNegotiableRules({ permission: fixture('debug-agent-hostile').permission });
    assert.equal(check.ok, false);
    const push = check.failures.find((failure) => failure.rule.includes('git push origin main'));
    assert.ok(push, 'the re-allowed push must be reported');
    assert.equal(push?.effective, 'allow');
    assert.match(push?.source ?? '', /bash -> git push \*/);
  });

  it('catches an ask that should have been a deny', () => {
    const check = verifyNonNegotiableRules({ permission: fixture('debug-agent-hostile').permission });
    const fetch = check.failures.find((failure) => failure.rule.startsWith('webfetch'));
    assert.equal(fetch?.effective, 'ask', 'an ask is not a deny: the user can be talked into clicking');
  });

  it('reports a tuple that no rule matched at all', () => {
    const check = verifyNonNegotiableRules({ permission: {} });
    assert.equal(check.failures.length, NON_NEGOTIABLE_TUPLES.length);
    assert.match(check.failures[0].source ?? '', /no rule matched/);
  });

  it('takes the extra tuples S37 adds for the network surface', () => {
    const extra = [{ group: 'network', tool: 'unitynet', argument: 'GET http://127.0.0.1:11434/api/tags' }];
    const tuples = buildNonNegotiableTuples(extra);
    assert.equal(tuples.length, NON_NEGOTIABLE_TUPLES.length + 1);
    const check = verifyNonNegotiableRules({ permission: goodPermission(), tuples });
    assert.equal(check.failures.length, 1, 'the network tuple fails until S37 renders the rules');
    assert.equal(check.failures[0].rule.startsWith('unitynet'), true);
  });

  it('reads both the resolved rule array and a permission block', () => {
    assert.ok(toRuleset(fixture('debug-agent-hostile').permission, 'effective').length > 0);
    assert.ok(toRuleset(goodPermission(), 'effective').length > 0);
    assert.deepEqual(toRuleset(null, 'effective'), []);
    assert.deepEqual(toRuleset(['not a rule', { pattern: '*' }], 'effective'), []);
  });
});

describe('effective-config V-c visible tools', () => {
  it('passes when the visible set equals the expected set', () => {
    assert.equal(verifyVisibleTools({ tools: goodTools(), expected: EXPECTED_TOOLS }).ok, true);
  });

  it('reports a tool a merged config made visible', () => {
    const check = verifyVisibleTools({ tools: fixture('debug-agent-hostile').tools, expected: EXPECTED_TOOLS });
    assert.equal(check.ok, false);
    assert.equal(check.failures[0].rule, 'the tool webfetch is not visible');
    assert.equal(check.failures[0].effective, 'visible');
  });

  it('reports a tool that went missing', () => {
    const tools = goodTools();
    delete tools.edit;
    const check = verifyVisibleTools({ tools, expected: EXPECTED_TOOLS });
    assert.equal(check.failures[0].rule, 'the tool edit is visible');
    assert.equal(check.failures[0].effective, 'hidden');
  });

  it('accepts the editor allow-list on top of the expected set', () => {
    const tools = { ...goodTools(), unityMCP_read_console: true };
    assert.equal(verifyVisibleTools({ tools, expected: EXPECTED_TOOLS }).ok, false);
    assert.equal(verifyVisibleTools({ tools, expected: EXPECTED_TOOLS, editorTools: ['unityMCP_read_console'] }).ok, true);
  });

  it('reads a map or a list of names, and treats false as hidden', () => {
    assert.deepEqual(listVisibleToolNames({ read: true, webfetch: false }), ['read']);
    assert.deepEqual(listVisibleToolNames(['read', 'edit']), ['read', 'edit']);
    assert.deepEqual(listVisibleToolNames(null), []);
  });
});

describe('effective-config V-d config shape', () => {
  const expected = { modelTag: MODEL_TAG, factsPath: FACTS_PATH, profileDir: PROFILE_DIR };

  it('passes for a clean config', () => {
    assert.deepEqual(verifyConfigShape({ config: fixture('debug-config-good'), expected }).failures, []);
  });

  it('reports every way the hostile project changed the shape', () => {
    const check = verifyConfigShape({ config: fixture('debug-config-hostile'), expected });
    const rules = check.failures.map((failure) => failure.rule);
    assert.ok(rules.includes('model is what this product set'));
    assert.ok(rules.includes('share is what this product set'));
    assert.ok(rules.includes('autoupdate is what this product set'));
    assert.ok(rules.includes('enabled_providers is what this product set'));
    assert.ok(rules.includes('every plugin comes from the profile directory'));
    assert.ok(rules.includes('instructions include the project facts'));
    assert.ok(rules.some((rule) => rule.startsWith('no MCP server')));
  });

  it('names the plugin file that came from outside the profile directory', () => {
    const check = verifyConfigShape({ config: fixture('debug-config-hostile'), expected });
    const plugin = check.failures.find((failure) => failure.rule.startsWith('every plugin'));
    assert.equal(plugin?.effective, '/project/.opencode/plugins/helper.js');
  });

  it('allows the unityMCP server only when the editor agent is on', () => {
    const config = { ...fixture('debug-config-good'), mcp: { unityMCP: { type: 'remote' } } };
    assert.equal(verifyConfigShape({ config, expected }).ok, false);
    assert.equal(verifyConfigShape({ config, expected: { ...expected, editorAgent: true } }).ok, true);
  });

  it('compares paths with either separator, and folds case only where the file system does', () => {
    const config = { ...fixture('debug-config-good'), instructions: ['\\profile\\projects\\sample-1a2b3c4d\\FACTS.md'] };
    assert.equal(verifyConfigShape({ config, expected }).ok, false, 'case matters where the file system cares');
    assert.equal(verifyConfigShape({ config, expected: { ...expected, caseInsensitivePaths: true } }).ok, true);
  });

  it('checks the network permission and the two hashes only when they are expected', () => {
    const base = fixture('debug-config-good');
    assert.equal(verifyConfigShape({ config: base, expected }).ok, true);

    const missingNetwork = verifyConfigShape({ config: base, expected: { ...expected, expectUnitynet: true } });
    assert.equal(missingNetwork.failures[0].rule, 'the network permission exists');

    const wrongOrder = { ...base, permission: { unitynet: { 'GET https://docs.unity3d.com/*': 'allow', '*': 'deny' } } };
    const order = verifyConfigShape({ config: wrongOrder, expected: { ...expected, expectUnitynet: true } });
    assert.equal(order.failures[0].rule, 'the network permission denies everything first');
    assert.equal(order.failures[0].effective, 'GET https://docs.unity3d.com/* -> allow');

    const rightOrder = { ...base, permission: { unitynet: { '*': 'deny', 'GET https://docs.unity3d.com/*': 'allow' } } };
    assert.equal(verifyConfigShape({ config: rightOrder, expected: { ...expected, expectUnitynet: true } }).ok, true);

    assert.equal(verifyConfigShape({ config: base, expected: { ...expected, policyHash: 'abc' } }).failures[0].rule, 'policyHash matches the rendered policy');
    assert.equal(verifyConfigShape({ config: { ...base, componentsHash: 'def' }, expected: { ...expected, componentsHash: 'def' } }).ok, true);
  });
});

describe('effective-config V-e instruction files', () => {
  it('passes when the project files fit beside the fixed prefix', () => {
    const check = verifyInstructionFiles({ files: [{ path: 'AGENTS.md', tokens: 400 }], prefixTokens: 5000, failTokens: 6000 });
    assert.equal(check.ok, true);
  });

  it('fails over budget and names the biggest file', () => {
    const check = verifyInstructionFiles({
      files: [{ path: 'AGENTS.md', tokens: 400 }, { path: 'Assets/CONTEXT.md', tokens: 2100 }],
      prefixTokens: 5000,
      failTokens: 6000,
    });
    assert.equal(check.ok, false);
    assert.equal(check.failures[0].source, 'Assets/CONTEXT.md');
    assert.equal(check.failures[0].effective, 'about 2.5k tokens');
    assert.equal(check.failures[0].expected, 'at most 1.0k tokens');
  });

  it('prints counts in thousands, so no three-digit run can look like an HTTP status', () => {
    for (const tokens of [0, 429, 500, 502, 503, 504, 524, 8502, 65536]) {
      assert.ok(!looksRetryable(`about ${formatTokens(tokens)} tokens`), `${tokens} produced a retryable string`);
    }
  });
});

describe('effective-config verification run', () => {
  /**
   * @param {object} [overrides]
   */
  function run(overrides = {}) {
    return verifyEffectiveConfig({
      probe: { exitCode: 0 },
      permission: goodPermission(),
      tools: goodTools(),
      expectedTools: EXPECTED_TOOLS,
      config: fixture('debug-config-good'),
      expected: { modelTag: MODEL_TAG, factsPath: FACTS_PATH, profileDir: PROFILE_DIR },
      ...overrides,
    });
  }

  it('passes a clean launch and runs the five checks in order', () => {
    const result = run({ instructionFiles: [{ path: 'AGENTS.md', tokens: 100 }], prefixTokens: 5000, failTokens: 6000 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.checks.map((check) => check.id), ['V-a', 'V-b', 'V-c', 'V-d', 'V-e']);
  });

  it('runs V-e only when the caller measured the prefix', () => {
    assert.deepEqual(run().checks.map((check) => check.id), ['V-a', 'V-b', 'V-c', 'V-d']);
  });

  it('collects every failure instead of stopping at the first', () => {
    const result = run({
      probe: { exitCode: 1 },
      permission: fixture('debug-agent-hostile').permission,
      tools: fixture('debug-agent-hostile').tools,
      config: fixture('debug-config-hostile'),
    });
    assert.equal(result.ok, false);
    const checks = new Set(result.failures.map((failure) => failure.check));
    assert.deepEqual([...checks], ['V-a', 'V-b', 'V-c', 'V-d']);
  });

  it('exits 4 with the failing rule, the effective action and the likely source', () => {
    const result = run({ permission: fixture('debug-agent-hostile').permission });
    const error = createVerificationError(result);
    assert.equal(error.exitCode, EXIT.VALIDATION);
    assert.equal(error.code, 'effective_config_rejected');
    assert.match(error.message, /V-b bash git push origin main is denied; effective: allow/);
    assert.match(error.message, /likely source: the rule bash -> git push \*/);
    assert.match(error.hint ?? '', /--no-project-config/);
    assert.equal(/** @type {any[]} */ (error.data.failures).length, result.failures.length);
  });

  it('emits no failure line OpenCode would read as a retryable failure', () => {
    const result = run({
      probe: { exitCode: 1, timedOut: true },
      permission: fixture('debug-agent-hostile').permission,
      tools: fixture('debug-agent-hostile').tools,
      config: fixture('debug-config-hostile'),
      instructionFiles: [{ path: 'AGENTS.md', tokens: 9503 }],
      prefixTokens: 5000,
      failTokens: 6000,
    });
    for (const failure of result.failures) assert.ok(!looksRetryable(formatVerificationFailure(failure)), formatVerificationFailure(failure));
    const error = createVerificationError(result);
    assert.ok(!looksRetryable(error.message));
    assert.ok(!looksRetryable(error.hint ?? ''));
  });
});

describe('effective-config verify cache key', () => {
  const base = {
    opencodeVersion: '1.18.31',
    profileHash: 'a'.repeat(64),
    contentHash: 'b'.repeat(64),
    projectConfigFiles: [
      { path: 'opencode.json', hash: 'c'.repeat(64), mtimeMs: 1 },
      { path: '.opencode/opencode.json', hash: 'd'.repeat(64), mtimeMs: 2 },
    ],
    directoryListings: { '.opencode': ['agents', 'plugins'], '~/.opencode': [] },
    authMtimeMs: 3,
  };

  it('is stable whatever order the inputs arrive in', () => {
    const shuffled = {
      ...base,
      projectConfigFiles: [...base.projectConfigFiles].reverse(),
      directoryListings: { '~/.opencode': [], '.opencode': ['plugins', 'agents'] },
    };
    assert.equal(buildVerifyCacheKey(base), buildVerifyCacheKey(shuffled));
    assert.match(buildVerifyCacheKey(base), /^[0-9a-f]{64}$/);
  });

  it('changes when anything that could change the effective config changes', () => {
    const key = buildVerifyCacheKey(base);
    assert.notEqual(key, buildVerifyCacheKey({ ...base, opencodeVersion: '1.18.32' }));
    assert.notEqual(key, buildVerifyCacheKey({ ...base, profileHash: 'e'.repeat(64) }));
    assert.notEqual(key, buildVerifyCacheKey({ ...base, contentHash: 'e'.repeat(64) }));
    assert.notEqual(key, buildVerifyCacheKey({ ...base, authMtimeMs: 4 }));
    assert.notEqual(key, buildVerifyCacheKey({ ...base, projectConfigFiles: [{ path: 'opencode.json', hash: 'c'.repeat(64), mtimeMs: 9 }] }));
    assert.notEqual(key, buildVerifyCacheKey({ ...base, directoryListings: { ...base.directoryListings, '.opencode': ['agents'] } }));
  });
});
