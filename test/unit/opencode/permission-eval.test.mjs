// Spec 8.5.1: the port of OpenCode's permission evaluation. These tests are the parity contract. If
// OpenCode changes `findLast`, its wildcard syntax or the tool-removal rule, C14's fixtures catch the
// drift and these tests say exactly which behaviour moved.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OPENCODE_DEFAULT_PERMISSION,
  appendToolOutputAllow,
  buildRuleset,
  evaluatePermission,
  flattenPermission,
  isExplicitlyDenied,
  isPermissionAction,
  isToolRemoved,
  listVisibleTools,
  matchesName,
  wildcardMatch,
} from '../../../src/opencode/permission-eval.js';
import { buildUnityCodePermission, buildUnityEditorPermission, buildConfigLevelPermission, UNITY_CODE_MCP_TOOLS } from '../../../src/opencode/render.js';

/**
 * The layer order of spec 8.5.1: OpenCode defaults, config level, agent level.
 * @param {Record<string, any>} agent
 * @param {Record<string, any>} [config]
 * @returns {ReturnType<typeof buildRuleset>}
 */
function rulesFor(agent, config = buildConfigLevelPermission()) {
  return buildRuleset([
    { layer: 'opencode defaults', permission: OPENCODE_DEFAULT_PERMISSION },
    { layer: 'config level', permission: config },
    { layer: 'agent level', permission: agent },
  ]);
}

describe('opencode/permission-eval wildcard', () => {
  it('treats * as any run of characters and everything else as literal', () => {
    assert.ok(wildcardMatch('*.unity', 'Assets/Scenes/Main.unity'));
    assert.ok(wildcardMatch('*ProjectSettings/*', 'ProjectSettings/ProjectSettings.asset'));
    assert.ok(!wildcardMatch('*.unity', 'Assets/Scenes/Main.unity.meta'));
    assert.ok(!wildcardMatch('*.prefab', 'Assets/Player.cs'));
  });

  it('escapes regular-expression characters in a pattern', () => {
    assert.ok(wildcardMatch('a+b.c', 'a+b.c'));
    assert.ok(!wildcardMatch('a+b.c', 'aab-c'));
    assert.ok(wildcardMatch('*(x)*', 'build (x) done'));
  });

  it('makes the argument optional after a trailing space-star (OC wildcard.ts)', () => {
    assert.ok(wildcardMatch('git status *', 'git status --short'));
    assert.ok(wildcardMatch('git status *', 'git status'), 'a bare `git status` is still the allowed command');
    assert.ok(!wildcardMatch('git status *', 'git statusx'));
    assert.ok(!wildcardMatch('git status *', 'git push'));
  });

  it('matches across newlines, because a shell argument can contain one', () => {
    assert.ok(wildcardMatch('rm -rf *', 'rm -rf Assets\nrm -rf Packages'));
  });

  it('folds case only when asked, which is what Windows needs', () => {
    assert.ok(!wildcardMatch('*.unity', 'Main.UNITY'));
    assert.ok(wildcardMatch('*.unity', 'Main.UNITY', { caseInsensitive: true }));
  });

  it('matches permission names as wildcards, which is what makes "*_*" cover MCP tool ids', () => {
    assert.ok(matchesName('*_*', 'unityMCP_read_console'));
    assert.ok(matchesName('*_*', 'external_directory'));
    assert.ok(matchesName('*_*', 'doom_loop'));
    assert.ok(!matchesName('*_*', 'bash'));
    assert.ok(matchesName('*', 'anything'));
  });
});

describe('opencode/permission-eval flattening', () => {
  it('turns a string value into the pattern *', () => {
    assert.deepEqual(flattenPermission({ task: 'deny' }, 'agent'), [{ name: 'task', pattern: '*', action: 'deny', layer: 'agent' }]);
  });

  it('keeps the order of a nested block, because the last match wins', () => {
    const rules = flattenPermission({ read: { '*.env': 'deny', '*.env.example': 'allow' } }, 'agent');
    assert.deepEqual(rules.map((rule) => rule.pattern), ['*.env', '*.env.example']);
  });

  it('ignores values that are not actions instead of guessing', () => {
    assert.deepEqual(flattenPermission({ read: { '*': /** @type {any} */ ('maybe') }, edit: /** @type {any} */ (7) }, 'agent'), []);
    assert.deepEqual(flattenPermission(null), []);
    assert.ok(isPermissionAction('deny'));
    assert.ok(!isPermissionAction('maybe'));
  });

  it('numbers the rules across every layer in evaluation order', () => {
    const rules = buildRuleset([
      { layer: 'a', permission: { task: 'deny' } },
      { layer: 'b', permission: { task: 'allow' } },
    ]);
    assert.deepEqual(rules.map((rule) => `${rule.layer}:${rule.index}`), ['a:0', 'b:1']);
  });
});

describe('opencode/permission-eval last match wins', () => {
  it('lets a later layer re-allow what an earlier one denied, which is why start verifies', () => {
    const rules = buildRuleset([
      { layer: 'ours', permission: { bash: { '*': 'deny' } } },
      { layer: 'hostile project', permission: { bash: { 'git push *': 'allow' } } },
    ]);
    const verdict = evaluatePermission(rules, { tool: 'bash', argument: 'git push origin main' });
    assert.equal(verdict.action, 'allow');
    assert.equal(verdict.rule?.layer, 'hostile project');
  });

  it('allows what no rule matched, which is why OpenCode defaults are always the first layer', () => {
    assert.equal(evaluatePermission([], { tool: 'edit', argument: 'x.cs' }).action, 'allow');
    const withDefaults = buildRuleset([{ layer: 'defaults', permission: OPENCODE_DEFAULT_PERMISSION }]);
    assert.equal(evaluatePermission(withDefaults, { tool: 'doom_loop' }).action, 'ask');
  });

  it('evaluates an MCP resource read under `read`', () => {
    const rules = rulesFor(buildUnityEditorPermission());
    assert.equal(evaluatePermission(rules, { tool: 'mcp:unityMCP:instances', argument: 'mcp:unityMCP:instances', resource: true }).name, 'read');
    assert.equal(evaluatePermission(rules, { tool: 'read', argument: 'mcp:unityMCP:instances' }).action, 'allow');
  });
});

describe('opencode/permission-eval tool removal', () => {
  it('removes a tool only when the last matching rule is an outright deny (OC permission/index.ts)', () => {
    const rules = rulesFor(buildUnityCodePermission({ vcsKind: 'git', csprojNames: ['Game.csproj'] }));
    assert.ok(isToolRemoved(rules, 'task'));
    assert.ok(isToolRemoved(rules, 'webfetch'));
    assert.ok(isToolRemoved(rules, 'unityMCP_manage_scene'), 'every MCP tool id falls under "*_*"');
    // `bash` keeps allowed patterns, so the tool itself stays visible.
    assert.ok(!isToolRemoved(rules, 'bash'));
    assert.ok(!isToolRemoved(rules, 'read'));
    assert.ok(!isToolRemoved(rules, 'edit'));
    assert.ok(!isToolRemoved(rules, 'glob'));
  });

  it('keeps the three admitted MCP tools visible while every other one stays hidden', () => {
    const rules = rulesFor(buildUnityCodePermission({ mcpTools: UNITY_CODE_MCP_TOOLS }));
    const visible = listVisibleTools(rules, [...UNITY_CODE_MCP_TOOLS, 'unityMCP_run_tests', 'unityMCP_manage_scene', 'edit']);
    assert.deepEqual(visible, [...UNITY_CODE_MCP_TOOLS, 'edit']);
  });

  it('hides everything but the allow-list for the editor agent', () => {
    const rules = rulesFor(buildUnityEditorPermission());
    const visible = listVisibleTools(rules, ['unityMCP_read_console', 'unityMCP_run_tests', 'unityMCP_manage_scene', 'edit', 'bash']);
    assert.deepEqual(visible, ['unityMCP_read_console', 'unityMCP_run_tests']);
  });
});

describe('opencode/permission-eval tool-output directory', () => {
  it('does not append OpenCode\'s own allow when external_directory is denied outright', () => {
    const denied = rulesFor(buildUnityCodePermission());
    assert.ok(isExplicitlyDenied(denied, 'external_directory'));
    assert.equal(appendToolOutputAllow(denied, '/tmp/opencode').length, denied.length);
    assert.equal(evaluatePermission(appendToolOutputAllow(denied, '/tmp/opencode'), { tool: 'external_directory', argument: '/tmp/opencode/out.txt' }).action, 'deny');
  });

  it('appends it when nothing denied it, which is the OpenCode default behaviour', () => {
    const open = buildRuleset([{ layer: 'defaults', permission: OPENCODE_DEFAULT_PERMISSION }]);
    const appended = appendToolOutputAllow(open, '/tmp/opencode');
    assert.equal(appended.length, open.length + 1);
    assert.equal(evaluatePermission(appended, { tool: 'external_directory', argument: '/tmp/opencode/out.txt' }).action, 'allow');
    assert.equal(appendToolOutputAllow(open, '').length, open.length);
  });
});
