import assert from 'node:assert/strict';
import test from 'node:test';
import { loadUnityMcpToolFixture } from '../../../src/selftest/mock-mcp-hub.js';
import { EDITOR_HUB_TOOLS } from '../../../src/selftest/scenarios.js';

const fixture = loadUnityMcpToolFixture();
const byName = new Map(fixture.tools.map((tool) => [tool.name, tool]));

test('unity-mcp fixture: 48 tools of about 93 KB, as measured in spec 18.3 E6', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.serverVersion, '10.1.0');
  assert.equal(fixture.toolCount, 48);
  assert.equal(fixture.tools.length, 48);
  assert.equal(fixture.totalBytes, Buffer.byteLength(JSON.stringify(fixture.tools)));
  assert.ok(Math.abs(fixture.totalBytes - 93_000) <= 1000, `expected about 93 KB, got ${fixture.totalBytes}`);
  assert.equal(new Set(fixture.tools.map((tool) => tool.name)).size, 48, 'tool names are unique');
});

test('unity-mcp fixture: every tool has a group, a placeholder description and an object schema', () => {
  const groups = new Set(Object.values(fixture.groups));
  assert.deepEqual([...groups].sort(), ['animation', 'asset_gen', 'core', 'docs', 'probuilder', 'profiling', 'scripting_ext', 'testing', 'ui', 'vfx']);
  for (const tool of fixture.tools) {
    assert.equal(typeof fixture.groups[tool.name], 'string', `${tool.name} has no group`);
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} is not a tool name`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} has no object schema`);
    assert.match(tool.description, /^Placeholder description for /, `${tool.name} must not carry upstream text`);
  }
  for (const text of JSON.stringify(fixture.tools).match(/"description":"[^"]*"/g) ?? []) {
    assert.match(text, /"description":"Placeholder /, 'parameter descriptions are placeholders too');
  }
});

test('unity-mcp fixture: the tools the editor agent may call carry their upstream parameter shape', () => {
  for (const name of EDITOR_HUB_TOOLS) {
    assert.ok(fixture.exactShapeTools.includes(name), `${name} must have an exact shape`);
  }

  // UM read_console.py L29-46: action is the get/clear enum the argument policy rewrites (spec 11.3).
  const action = byName.get('read_console').inputSchema.properties.action;
  assert.deepEqual(action.anyOf, [{ enum: ['get', 'clear'], type: 'string' }, { type: 'null' }]);

  // UM run_tests.py L154-170: mode plus the four filter lists the argument policy requires.
  const runTests = byName.get('run_tests').inputSchema.properties;
  assert.deepEqual(runTests.mode, { default: 'EditMode', description: runTests.mode.description, enum: ['EditMode', 'PlayMode'], type: 'string' });
  for (const filter of ['test_names', 'group_names', 'category_names', 'assembly_names']) {
    assert.deepEqual(runTests[filter].anyOf, [{ items: { type: 'string' }, type: 'array' }, { type: 'string' }, { type: 'null' }]);
  }

  // UM run_tests.py L231-240 and find_gameobjects.py L26-60: required arguments stay required.
  assert.deepEqual(byName.get('get_test_job').inputSchema.required, ['job_id']);
  assert.deepEqual(byName.get('find_gameobjects').inputSchema.required, ['search_term']);
  assert.deepEqual(byName.get('refresh_unity').inputSchema.properties.compile.enum, ['none', 'request']);

  // No tool declares unity_instance: the middleware reads it per call (UM middleware L324-354).
  for (const tool of fixture.tools) {
    assert.ok(!('unity_instance' in (tool.inputSchema.properties ?? {})), `${tool.name} must not declare unity_instance`);
  }
});

test('unity-mcp fixture: annotation hints match the rules in spec 11.2', () => {
  assert.equal(byName.get('refresh_unity').annotations.destructiveHint, true);
  assert.equal(byName.get('run_tests').annotations.destructiveHint, true);
  assert.equal(byName.get('get_test_job').annotations.readOnlyHint, true);
  assert.equal(byName.get('apply_text_edits').annotations.destructiveHint, true);
  assert.equal(byName.get('read_console').annotations.destructiveHint, undefined, 'read_console carries only a title upstream');
});

test('unity-mcp fixture: the tools a session must never see are present, so the deny rule can be proven', () => {
  for (const name of ['manage_script', 'script_apply_edits', 'execute_code', 'execute_menu_item', 'batch_execute', 'set_active_instance', 'manage_gameobject']) {
    assert.ok(byName.has(name), `${name} is missing from the fixture`);
  }
});
