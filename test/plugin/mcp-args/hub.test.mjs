// The allow-list, proved against the mock MCP for Unity hub (spec 11.2, 20.3). The policy runs where
// the plugin runs it — before the call leaves OpenCode — so a refused call must leave no trace on the
// hub at all, and an allowed call must arrive with the arguments the policy rewrote, not the ones the
// model wrote. No Unity, no real hub and no model: the hub is the local mock, and the fixture it serves
// is the recorded 10.1.0 tool list.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  EDITOR_TOOLS,
  INSTANCE_ARGUMENT,
  MCP_TOOL_PREFIX,
  PLAY_MODE,
  applyMcpArgsPolicy,
} from '../../../plugin/opencode-unity-lib/mcp-args.js';
import { INSTANCES_RESOURCE_URI, loadUnityMcpToolFixture, startMockMcpHub } from '../../../src/selftest/mock-mcp-hub.js';

/** Tool calls a model might make; the ones the permission rules remove are here on purpose. */
const HOSTILE_CALLS = [
  { tool: 'read_console', args: { action: 'clear' } },
  { tool: 'run_tests', args: { mode: PLAY_MODE, test_names: ['SampleSuite.Case'] } },
  { tool: 'run_tests', args: { mode: 'EditMode' } },
  { tool: 'execute_code', args: { params: { code: 'UnityEditor.EditorApplication.Exit(0);' } } },
  { tool: 'execute_menu_item', args: { params: { menu_path: 'File/Save Project' } } },
  { tool: 'manage_gameobject', args: { params: { action: 'delete', target: 'Main Camera' } } },
  { tool: 'manage_scene', args: { params: { action: 'save' } } },
  { tool: 'create_script', args: { path: 'Assets/Injected.cs', contents: 'class Injected {}' } },
  { tool: 'delete_script', args: { uri: 'unity://path/Assets/Player.cs' } },
  { tool: 'batch_execute', args: { params: { calls: [{ tool: 'execute_code' }] } } },
  { tool: 'set_active_instance', args: { params: { instance: 'OtherProject@fedcba9876543210' } } },
  { tool: 'manage_packages', args: { params: { action: 'add', package: 'com.example.thing' } } },
];

describe('editor allow-list against the mock hub', () => {
  /** @type {Awaited<ReturnType<typeof startMockMcpHub>>} */
  let mock;

  before(async () => {
    // The hub answers only the five tools of spec 11.2; anything else is recorded as a violation.
    mock = await startMockMcpHub({ endpoints: { '/mcp': { allowedToolCalls: [...EDITOR_TOOLS] } } });
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-args-test', version: '0' } });
  });

  after(async () => {
    await mock?.close();
  });

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  async function call(method, params = {}) {
    const response = await fetch(mock.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: mock.hub.messages.length + 1, method, params }),
    });
    assert.equal(response.status, 200, method);
    return response.json();
  }

  /**
   * Runs one call the way a session does: the policy first, the hub only if the policy allowed it.
   * @param {string} tool
   * @param {Record<string, unknown>} args
   * @returns {Promise<{ sent: boolean, error: Error | null }>}
   */
  async function attempt(tool, args) {
    try {
      applyMcpArgsPolicy(`${MCP_TOOL_PREFIX}${tool}`, args);
    } catch (error) {
      return { sent: false, error: /** @type {Error} */ (error) };
    }
    await call('tools/call', { name: tool, arguments: args });
    return { sent: true, error: null };
  }

  it('serves the recorded 10.1.0 tool list, of which the agent may call five', async () => {
    const listed = await call('tools/list');
    /** @type {string[]} */
    const names = listed.result.tools.map((/** @type {{ name: string }} */ tool) => tool.name);
    assert.equal(names.length, loadUnityMcpToolFixture().toolCount);
    for (const tool of EDITOR_TOOLS) assert.ok(names.includes(tool), tool);
    const denied = names.filter((name) => !EDITOR_TOOLS.includes(name));
    assert.ok(denied.length > 40, `${denied.length} tools stay denied`);
    for (const { tool } of HOSTILE_CALLS) {
      if (!EDITOR_TOOLS.includes(tool)) assert.ok(names.includes(tool), `${tool} exists upstream, so denying it is a real restriction`);
    }
  });

  it('reads the instances resource, which is how the agent checks the Editor first', async () => {
    const read = await call('resources/read', { uri: INSTANCES_RESOURCE_URI });
    const payload = JSON.parse(read.result.contents[0].text);
    assert.equal(payload.instance_count, 1);
    assert.match(payload.instances[0].id, /^[^@]+@[0-9a-f]{16}$/);
  });

  it('lets the three read-only tools through with the routing argument removed', async () => {
    const before = mock.hub.toolCalls.length;
    await attempt('read_console', { [INSTANCE_ARGUMENT]: 'OtherProject@fedcba9876543210', types: ['error'] });
    await attempt('find_gameobjects', { search_term: 'Main Camera', [INSTANCE_ARGUMENT]: 'OtherProject@fedcba9876543210' });
    await attempt('get_test_job', { job_id: 'job-1' });
    const sent = mock.hub.toolCalls.slice(before);
    assert.deepEqual(sent.map((entry) => entry.name), ['read_console', 'find_gameobjects', 'get_test_job']);
    for (const entry of sent) assert.equal(Object.hasOwn(entry.arguments, INSTANCE_ARGUMENT), false, entry.name);
    assert.equal(sent[0].arguments.action, 'get');
  });

  it('sends an EditMode run with the filter the model chose', async () => {
    const before = mock.hub.toolCalls.length;
    await attempt('run_tests', { assembly_names: ['SampleSuite'] });
    await attempt('refresh_unity', {});
    const sent = mock.hub.toolCalls.slice(before);
    assert.deepEqual(sent.map((entry) => entry.name), ['run_tests', 'refresh_unity']);
    assert.equal(sent[0].arguments.mode, 'EditMode');
    assert.deepEqual(sent[0].arguments.assembly_names, ['SampleSuite']);
  });

  it('leaves no trace on the hub for any refused call', async () => {
    const before = mock.hub.toolCalls.length;
    const requests = mock.hub.requests.length;
    for (const { tool, args } of HOSTILE_CALLS) {
      const outcome = await attempt(tool, { ...args });
      assert.equal(outcome.sent, false, `${tool} reached the hub`);
      assert.match(String(outcome.error?.message), /^opencode-unity editor policy:/);
    }
    assert.equal(mock.hub.toolCalls.length, before, 'a refused call was recorded by the hub');
    assert.equal(mock.hub.requests.length, requests, 'a refused call produced an HTTP request');
  });

  it('records no violation across the whole session', () => {
    assert.deepEqual(mock.hub.violations, []);
    const names = new Set(mock.hub.toolCalls.map((entry) => entry.name));
    assert.deepEqual([...names].sort(), [...EDITOR_TOOLS].sort());
  });
});
