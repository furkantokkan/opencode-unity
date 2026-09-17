import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MCP_PATH,
  DEFAULT_PROTOCOL_VERSION,
  EDITOR_STATE_RESOURCE_URI,
  INSTANCES_RESOURCE_URI,
  loadUnityMcpToolFixture,
  MOCK_HUB_INSTRUCTIONS,
  MOCK_HUB_INSTRUCTIONS_MARKER,
  startMockMcpHub,
} from '../../../src/selftest/mock-mcp-hub.js';

/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, import('../../../src/selftest/mock-mcp-hub.js').McpEndpointOptions>} [endpoints]
 */
async function serve(t, endpoints) {
  const started = await startMockMcpHub(endpoints ? { endpoints } : undefined);
  t.after(() => started.close());
  return started;
}

let nextId = 1;

/**
 * @param {string} url
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 * @param {{ sessionId?: string, notification?: boolean }} [options]
 */
async function send(url, method, params, { sessionId, notification = false } = {}) {
  const message = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notification ? {} : { id: nextId++ }) };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  return { response, text, body: text ? JSON.parse(text.replace(/^event: message\ndata: /, '')) : null };
}

test('mock hub: initialize answers with capabilities, instructions and a session id', async (t) => {
  const { mcpUrl, hub } = await serve(t);

  const initialized = await send(mcpUrl, 'initialize', { protocolVersion: DEFAULT_PROTOCOL_VERSION, clientInfo: { name: 'test', version: '1' } });

  assert.equal(initialized.body.result.protocolVersion, DEFAULT_PROTOCOL_VERSION);
  assert.equal(initialized.body.result.instructions, MOCK_HUB_INSTRUCTIONS);
  assert.match(MOCK_HUB_INSTRUCTIONS, new RegExp(MOCK_HUB_INSTRUCTIONS_MARKER));
  const sessionId = initialized.response.headers.get('mcp-session-id');
  assert.match(sessionId ?? '', /^[0-9a-f-]{36}$/);

  const notified = await send(mcpUrl, 'notifications/initialized', undefined, { sessionId, notification: true });
  assert.equal(notified.response.status, 202);
  assert.equal(notified.text, '');

  assert.deepEqual(hub.messages.map((message) => message.method), ['initialize', 'notifications/initialized']);
  assert.equal(hub.messages[1].sessionId, sessionId);
  assert.equal(hub.messages[1].id, null);
});

test('mock hub: tools/list serves the 10.1.0 fixture and resources are readable', async (t) => {
  const { mcpUrl } = await serve(t);
  const fixture = loadUnityMcpToolFixture();

  const tools = (await send(mcpUrl, 'tools/list')).body.result.tools;
  assert.equal(tools.length, fixture.toolCount);
  assert.deepEqual(tools.map((tool) => tool.name), fixture.tools.map((tool) => tool.name));

  const resources = (await send(mcpUrl, 'resources/list')).body.result.resources;
  assert.deepEqual(resources.map((resource) => resource.uri), [INSTANCES_RESOURCE_URI, EDITOR_STATE_RESOURCE_URI]);

  const instances = (await send(mcpUrl, 'resources/read', { uri: INSTANCES_RESOURCE_URI })).body.result.contents[0];
  const payload = JSON.parse(instances.text);
  assert.equal(payload.instance_count, 1);
  assert.equal(payload.instances[0].id, 'SampleProject@0123456789abcdef');

  assert.deepEqual((await send(mcpUrl, 'resources/templates/list')).body.result, { resourceTemplates: [] });
  assert.equal((await send(mcpUrl, 'ping')).body.result && Object.keys((await send(mcpUrl, 'ping')).body.result).length, 0);
});

test('mock hub: tools/call records the arguments it received and honours the allow-list', async (t) => {
  const { mcpUrl, hub } = await serve(t, {
    [DEFAULT_MCP_PATH]: {
      allowedToolCalls: ['read_console', 'find_gameobjects'],
      toolResults: { read_console: (args) => ({ content: [{ type: 'text', text: `action=${args.action}` }] }) },
    },
  });

  const allowed = await send(mcpUrl, 'tools/call', { name: 'read_console', arguments: { action: 'get', count: '5' } });
  assert.equal(allowed.body.result.content[0].text, 'action=get');

  const denied = await send(mcpUrl, 'tools/call', { name: 'manage_script', arguments: { action: 'delete' } });
  assert.equal(denied.body.result.isError, true);

  assert.deepEqual(hub.toolCalls.map((call) => [call.name, call.allowed]), [['read_console', true], ['manage_script', false]]);
  assert.deepEqual(hub.toolCalls[0].arguments, { action: 'get', count: '5' });
  assert.deepEqual(hub.violations.map((call) => call.name), ['manage_script']);
  assert.equal(hub.getMessages('tools/call').length, 2);
});

test('mock hub: a second endpoint has its own tools, and unknown methods are JSON-RPC errors', async (t) => {
  const { url, hub } = await serve(t, {
    [DEFAULT_MCP_PATH]: {},
    '/ocu-canary-mcp': { tools: [{ name: 'canary_tool', inputSchema: { type: 'object', properties: {} } }], instructions: 'canary hub' },
  });

  const canaryTools = (await send(`${url}/ocu-canary-mcp`, 'tools/list')).body.result.tools;
  assert.deepEqual(canaryTools.map((tool) => tool.name), ['canary_tool']);
  assert.equal(hub.messages.filter((message) => message.endpoint === '/ocu-canary-mcp').length, 1);

  const unknown = await send(`${url}${DEFAULT_MCP_PATH}`, 'prompts/list');
  assert.equal(unknown.body.error.code, -32601);

  assert.equal((await fetch(`${url}/not-a-hub`)).status, 404);
});

test('mock hub: it can answer as SSE, takes batches, and refuses GET like a POST-only endpoint', async (t) => {
  const { mcpUrl, url } = await serve(t, { [DEFAULT_MCP_PATH]: { responseMode: 'sse' } });

  const sse = await send(mcpUrl, 'tools/list');
  assert.equal(sse.response.headers.get('content-type'), 'text/event-stream');
  assert.equal(sse.body.result.tools.length, loadUnityMcpToolFixture().toolCount);

  const batch = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 90, method: 'ping' }, { jsonrpc: '2.0', id: 91, method: 'ping' }]),
  });
  const batchBody = JSON.parse((await batch.text()).replace(/^event: message\ndata: /, ''));
  assert.deepEqual(batchBody.map((reply) => reply.id), [90, 91]);

  const get = await fetch(mcpUrl);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST, DELETE');
  assert.equal((await fetch(mcpUrl, { method: 'DELETE' })).status, 200);

  const broken = await fetch(`${url}${DEFAULT_MCP_PATH}`, { method: 'POST', body: 'not json' });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).error.code, -32700);
});
