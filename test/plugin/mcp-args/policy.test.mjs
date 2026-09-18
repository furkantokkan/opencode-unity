// The MCP for Unity argument policy (spec 11.2, 11.3). Every case here is an argument object a model
// can produce, including the ones that would widen what the Editor does: a console clear, a PlayMode
// run, an unfiltered suite, a routing argument aimed at another Editor, and tool ids spelled to slip
// past a case-sensitive check.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONSOLE_READ_ACTION,
  EDITOR_TOOLS,
  EDIT_MODE,
  INSTANCE_ARGUMENT,
  MCP_ARGS_PREFIX,
  MCP_TOOL_PREFIX,
  PLAY_MODE,
  READ_ONLY_TOOLS,
  TEST_FILTER_ARGUMENTS,
  TRUSTED_TOOLS,
  applyMcpArgsPolicy,
  createMcpArgsPolicy,
  getMcpToolName,
  isMcpTool,
  readEditorPolicyOptions,
} from '../../../plugin/opencode-unity-lib/mcp-args.js';

const READ_CONSOLE = `${MCP_TOOL_PREFIX}read_console`;
const RUN_TESTS = `${MCP_TOOL_PREFIX}run_tests`;
const FIND_GAMEOBJECTS = `${MCP_TOOL_PREFIX}find_gameobjects`;

/**
 * @param {string} toolId
 * @param {Record<string, unknown>} args
 * @param {object} [options]
 * @returns {{ error: Error & { code?: string }, args: Record<string, unknown> }}
 */
function denied(toolId, args, options) {
  /** @type {any} */
  let error = null;
  try {
    applyMcpArgsPolicy(toolId, args, options);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof Error, `${toolId} was allowed through`);
  assert.ok(error.message.startsWith(MCP_ARGS_PREFIX), error.message);
  return { error, args };
}

describe('mcp argument policy: tool ids', () => {
  it('applies to this server only', () => {
    assert.ok(isMcpTool(READ_CONSOLE));
    assert.equal(getMcpToolName(READ_CONSOLE), 'read_console');
    for (const other of ['read', 'bash', 'grep', 'unityMCP_', 'otherServer_read_console', '', 'unityMC']) {
      assert.equal(isMcpTool(other), false, other);
      assert.equal(getMcpToolName(other), '');
      assert.equal(applyMcpArgsPolicy(other, { [INSTANCE_ARGUMENT]: 'Other@0123456789abcdef' }), null, other);
    }
  });

  it('still applies when the server key differs only in case', () => {
    const args = { mode: PLAY_MODE, test_names: ['Suite.Case'] };
    const { error } = denied('unitymcp_run_tests', args);
    assert.equal(error.code, 'mcp_test_mode');
  });

  it('refuses a tool name this policy does not know, whatever its case', () => {
    for (const name of ['execute_code', 'manage_gameobject', 'set_active_instance', 'batch_execute', 'create_script', 'Read_Console', 'READ_CONSOLE']) {
      const { error } = denied(`${MCP_TOOL_PREFIX}${name}`, {});
      assert.equal(error.code, 'mcp_tool_denied', name);
    }
  });

  it('covers the five tools of spec 11.2 and nothing else', () => {
    assert.deepEqual([...EDITOR_TOOLS], [...READ_ONLY_TOOLS, ...TRUSTED_TOOLS]);
    assert.deepEqual([...READ_ONLY_TOOLS], ['read_console', 'find_gameobjects', 'get_test_job']);
    assert.deepEqual([...TRUSTED_TOOLS], ['refresh_unity', 'run_tests']);
  });
});

describe('mcp argument policy: instance routing', () => {
  it('removes a model-supplied unity_instance from every allowed tool', () => {
    for (const name of EDITOR_TOOLS) {
      const args = /** @type {Record<string, unknown>} */ ({ [INSTANCE_ARGUMENT]: 'OtherProject@fedcba9876543210' });
      if (name === 'run_tests') args.test_names = ['Suite.Case'];
      if (name === 'find_gameobjects') args.search_term = 'Main Camera';
      if (name === 'get_test_job') args.job_id = 'job-1';
      const result = applyMcpArgsPolicy(`${MCP_TOOL_PREFIX}${name}`, args);
      assert.equal(Object.hasOwn(args, INSTANCE_ARGUMENT), false, name);
      assert.ok(result?.changes.includes(INSTANCE_ARGUMENT), name);
    }
  });

  it('removes the argument whatever its value, and reports nothing when it was absent', () => {
    for (const value of [null, undefined, '', 0, false, { name: 'Other' }, ['Other@0123456789abcdef']]) {
      const args = { search_term: 'Player', [INSTANCE_ARGUMENT]: value };
      applyMcpArgsPolicy(FIND_GAMEOBJECTS, args);
      assert.equal(Object.hasOwn(args, INSTANCE_ARGUMENT), false, String(value));
    }
    const clean = { search_term: 'Player' };
    assert.deepEqual(applyMcpArgsPolicy(FIND_GAMEOBJECTS, clean)?.changes, []);
    assert.deepEqual(clean, { search_term: 'Player' });
  });
});

describe('mcp argument policy: read_console', () => {
  it('fills in the read action when the model left it out', () => {
    for (const args of [{}, { action: null }, { types: ['error'] }]) {
      const result = applyMcpArgsPolicy(READ_CONSOLE, args);
      assert.equal(/** @type {Record<string, unknown>} */ (args).action, CONSOLE_READ_ACTION);
      assert.ok(result?.changes.includes('action'));
    }
  });

  it('leaves an explicit read action alone', () => {
    const args = { action: CONSOLE_READ_ACTION, count: 20 };
    assert.deepEqual(applyMcpArgsPolicy(READ_CONSOLE, args)?.changes, []);
    assert.deepEqual(args, { action: CONSOLE_READ_ACTION, count: 20 });
  });

  it('refuses every action that is not a read', () => {
    for (const action of ['clear', 'CLEAR', 'Clear', ' clear ', 'get ', 'Get', 1, true, ['clear'], { action: 'clear' }]) {
      const { error, args } = denied(READ_CONSOLE, { action });
      assert.equal(error.code, 'mcp_console_action', String(action));
      assert.equal(args.action, action, 'a refused call is not rewritten');
    }
  });
});

describe('mcp argument policy: run_tests', () => {
  it('runs EditMode with a filter', () => {
    for (const filter of TEST_FILTER_ARGUMENTS) {
      const args = { [filter]: ['SampleSuite.Case'] };
      const result = applyMcpArgsPolicy(RUN_TESTS, args);
      assert.equal(args.mode, EDIT_MODE, filter);
      assert.ok(result?.changes.includes('mode'), filter);
    }
  });

  it('accepts the upstream string form of a filter and rejects the empty forms', () => {
    assert.ok(applyMcpArgsPolicy(RUN_TESTS, { group_names: 'SampleSuite' }));
    for (const value of [[], [''], ['  '], [null], '', '   ', null, undefined, 0, false, {}]) {
      const { error } = denied(RUN_TESTS, { mode: EDIT_MODE, test_names: value });
      assert.equal(error.code, 'mcp_test_filter', JSON.stringify(value ?? null));
    }
  });

  it('refuses a whole-suite run', () => {
    assert.equal(denied(RUN_TESTS, {}).error.code, 'mcp_test_filter');
    assert.equal(denied(RUN_TESTS, { mode: EDIT_MODE }).error.code, 'mcp_test_filter');
    assert.equal(denied(RUN_TESTS, { include_details: true }).error.code, 'mcp_test_filter');
  });

  it('refuses PlayMode unless the project allows it', () => {
    for (const mode of [PLAY_MODE, 'playmode', 'PLAYMODE', ' PlayMode ']) {
      const { error, args } = denied(RUN_TESTS, { mode, test_names: ['Suite.Case'] });
      assert.equal(error.code, 'mcp_test_mode', String(mode));
      assert.equal(args.mode, mode, 'a refused call is not rewritten');
    }
  });

  it('runs PlayMode with the canonical spelling once the project allows it', () => {
    for (const mode of [PLAY_MODE, 'playmode', ' PlayMode ']) {
      const args = { mode, test_names: ['Suite.Case'] };
      applyMcpArgsPolicy(RUN_TESTS, args, { allowPlayMode: true });
      assert.equal(args.mode, PLAY_MODE, String(mode));
    }
  });

  it('refuses a mode that is not a Unity test mode', () => {
    for (const mode of ['', ' ', 'Edit', 'editmode ; PlayMode', 7, true, ['EditMode'], { mode: EDIT_MODE }]) {
      const { error } = denied(RUN_TESTS, { mode, test_names: ['Suite.Case'] }, { allowPlayMode: true });
      assert.equal(error.code, 'mcp_test_mode', String(mode));
    }
  });

  it('accepts the lower-case spelling of EditMode', () => {
    const args = { mode: 'editmode', assembly_names: 'SampleSuite' };
    applyMcpArgsPolicy(RUN_TESTS, args);
    assert.equal(args.mode, EDIT_MODE);
  });
});

describe('mcp argument policy: calls without arguments', () => {
  it('lets an argument-free tool through', () => {
    for (const args of [null, undefined, 'text', 7, ['unity_instance']]) {
      assert.deepEqual(applyMcpArgsPolicy(`${MCP_TOOL_PREFIX}refresh_unity`, args)?.changes, [], String(args));
      assert.deepEqual(applyMcpArgsPolicy(READ_CONSOLE, args)?.changes, [], String(args));
    }
  });

  it('still refuses an unfiltered test run', () => {
    for (const args of [null, undefined, 'text', []]) {
      assert.equal(denied(RUN_TESTS, /** @type {any} */ (args)).error.code, 'mcp_test_filter', String(args));
    }
  });
});

describe('mcp argument policy: project options', () => {
  it('defaults to the strictest state', () => {
    const policy = createMcpArgsPolicy();
    assert.deepEqual([...policy.allowedTools], [...EDITOR_TOOLS]);
    assert.equal(policy.allowPlayMode, false);
    assert.equal(policy.check('read', {}), null);
    assert.equal(policy.check(READ_CONSOLE, {})?.tool, 'read_console');
  });

  it('reads allowPlayMode from local.json and trusts nothing else', () => {
    assert.deepEqual(readEditorPolicyOptions({ editor: { allowPlayMode: true } }), { allowPlayMode: true });
    for (const local of [null, undefined, {}, { editor: null }, { editor: {} }, { editor: { allowPlayMode: 'true' } }, { editor: { allowPlayMode: 1 } }, 'text']) {
      assert.deepEqual(readEditorPolicyOptions(local), { allowPlayMode: false }, JSON.stringify(local ?? null));
    }
  });

  it('never widens the allow-list from a file', () => {
    const policy = createMcpArgsPolicy(readEditorPolicyOptions({ editor: { allowPlayMode: true, tools: ['execute_code'] } }));
    assert.deepEqual([...policy.allowedTools], [...EDITOR_TOOLS]);
    assert.throws(() => policy.check(`${MCP_TOOL_PREFIX}execute_code`, {}), /not one of the editor checks/);
  });
});
