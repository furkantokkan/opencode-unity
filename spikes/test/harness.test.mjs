// Tests for the spike harness itself (spec S02). They never start OpenCode: they cover the pieces the
// spikes trust — redaction, the mock endpoints and the run summary.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { redactText, tail } from '../lib/evidence.mjs';
import { scriptedToolCalls, startMockLlm, startRecorder, systemText, toolNames, toolResultAfter } from '../lib/mock-llm.mjs';
import { HUB_INSTRUCTIONS_MARKER, HUB_TOOL_NAMES, INSTANCES_URI, startMockMcpHub } from '../lib/mock-mcp-hub.mjs';
import { parseFirstJson, parseJsonEvents } from '../lib/opencode.mjs';
import { countHooks, summarizeRun } from '../lib/spike.mjs';
import { PROVIDER_ID, profileConfig, providerPluginConfig, startMockOllama } from '../lib/workspace.mjs';

test('redactText removes the machine identity in every path spelling', () => {
  const home = os.homedir();
  const user = os.userInfo().username;
  const text = [
    home,
    home.replace(/\\/g, '/'),
    JSON.stringify(home),
    JSON.stringify(JSON.stringify(home)),
    `user ${user} on ${os.hostname()}`,
  ].join('\n');
  const redacted = redactText(text);
  assert.ok(!redacted.toLowerCase().includes(user.toLowerCase()), redacted);
  assert.ok(!redacted.toLowerCase().includes(os.hostname().toLowerCase()), redacted);
  assert.ok(redacted.includes('<home>'));
  assert.ok(redacted.includes('<user>'));
});

test('redactText applies the caller pairs first and keeps other text', () => {
  const redacted = redactText(`secret at ${path.join(os.tmpdir(), 'x')} and plain words`, [['plain words', '<phrase>']]);
  assert.match(redacted, /<tmp>/);
  assert.match(redacted, /<phrase>/);
});

test('tail keeps the end of long output', () => {
  assert.equal(tail('abc', 10), 'abc');
  assert.equal(tail('abcdef', 3), '...def');
});

test('the mock LLM records requests and replays scripted tool calls', async (t) => {
  const llm = await startMockLlm({ respond: scriptedToolCalls([{ name: 'bash', arguments: { command: 'dotnet --version' } }], 'finished') });
  t.after(() => llm.close());
  const body = {
    model: 'mock-model',
    messages: [{ role: 'system', content: 'SYSTEM MARKER' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'bash' } }, { type: 'function', function: { name: 'read' } }],
  };
  const first = await post(`${llm.baseURL}/chat/completions`, body);
  assert.match(first, /"name":"bash"/);
  assert.match(first, /"finish_reason":"tool_calls"/);
  assert.match(first, /"usage"/);

  const second = await post(`${llm.baseURL}/chat/completions`, {
    ...body,
    messages: [...body.messages, { role: 'tool', tool_call_id: 'call_0', content: '10.0.100' }],
  });
  assert.match(second, /finished/);
  assert.equal(llm.chatRequests.length, 2);
  assert.equal(systemText(llm.chatRequests[0].body), 'SYSTEM MARKER');
  assert.deepEqual(toolNames(llm.chatRequests[0].body), ['bash', 'read']);
  assert.equal(toolResultAfter(llm.chatRequests, 0), '10.0.100');
  assert.equal(toolResultAfter(llm.chatRequests, 1), null);
});

test('the mock LLM answers an error reply with its status and body', async (t) => {
  const llm = await startMockLlm({ respond: () => ({ status: 503, json: { error: { type: 'busy' } }, headers: { 'retry-after': '30' } }) });
  t.after(() => llm.close());
  const response = await fetch(`${llm.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [] }),
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.deepEqual(await response.json(), { error: { type: 'busy' } });
});

test('the recorder answers a fixed body and counts requests', async (t) => {
  const recorder = await startRecorder({ ok: true });
  t.after(() => recorder.close());
  assert.deepEqual(await (await fetch(`${recorder.url}/api.json`)).json(), { ok: true });
  assert.deepEqual(recorder.requests, [{ method: 'GET', url: '/api.json' }]);
});

test('the mock Ollama serves the guard probe endpoints', async (t) => {
  const ollama = await startMockOllama({ models: [{ name: 'tag', context_length: 16384 }] });
  t.after(() => ollama.close());
  assert.deepEqual(await (await fetch(`${ollama.url}/api/ps`)).json(), { models: [{ name: 'tag', context_length: 16384 }] });
  assert.equal((await (await fetch(`${ollama.url}/api/version`)).json()).version, '0.34.1');
  assert.equal(ollama.calls.length, 2);
});

test('the mock MCP hub speaks JSON-RPC over the streamable HTTP transport', async (t) => {
  const hub = await startMockMcpHub();
  t.after(() => hub.close());

  const initialize = await rpc(hub.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(initialize.result.protocolVersion, '2025-03-26');
  assert.ok(String(initialize.result.instructions).includes(HUB_INSTRUCTIONS_MARKER));

  const notified = await fetch(hub.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(notified.status, 202);

  const tools = await rpc(hub.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(tools.result.tools.map((/** @type {any} */ tool) => tool.name), [...HUB_TOOL_NAMES]);

  const call = await rpc(hub.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_console', arguments: { action: 'get' } } });
  assert.match(call.result.content[0].text, /read_console/);
  assert.deepEqual(hub.toolCalls('read_console')[0].params.arguments, { action: 'get' });

  const resource = await rpc(hub.url, { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: INSTANCES_URI } });
  assert.match(resource.result.contents[0].text, /instances/);

  const unknown = await rpc(hub.url, { jsonrpc: '2.0', id: 5, method: 'nope' });
  assert.equal(unknown.error.code, -32601);

  const streamAttempt = await fetch(hub.url, { method: 'GET' });
  assert.equal(streamAttempt.status, 405);
});

test('summarizeRun reports exit code, requests and hook counts', () => {
  const result = { exitCode: 0, durationMs: 12, timedOut: false, attempts: 1, stdout: '{"type":"text"}\n{"type":"step_finish"}\nnoise\n', stderr: '' };
  const hooks = [{ hook: 'chat.params', agent: 'unity-code' }, { hook: 'chat.params', agent: 'compaction' }, { hook: 'event' }];
  const summary = summarizeRun(/** @type {any} */ (result), { chatRequests: [1, 2] }, hooks);
  assert.equal(summary.chatRequests, 2);
  assert.deepEqual(summary.chatParamsAgents, ['unity-code', 'compaction']);
  assert.deepEqual(summary.hookCounts, { 'chat.params': 2, event: 1 });
  assert.deepEqual(summary.stdoutEventTypes, ['text', 'step_finish']);
  assert.equal(countHooks(hooks, 'chat.params', (entry) => entry.agent === 'compaction'), 1);
});

test('the OpenCode output parsers ignore non-JSON lines', () => {
  assert.deepEqual(parseJsonEvents('hello\n{"type":"error"}\n{bad}\n'), [{ type: 'error' }]);
  assert.deepEqual(parseFirstJson('banner\n{"a":1}'), { a: 1 });
  assert.equal(parseFirstJson('no json here'), null);
});

test('the rendered profile config has no provider block and pins our provider', () => {
  const config = profileConfig();
  assert.equal(config.provider, undefined);
  assert.deepEqual(config.enabled_providers, [PROVIDER_ID]);
  assert.equal(config.autoupdate, false);
  assert.equal(config.share, 'disabled');
  const plugin = providerPluginConfig('http://127.0.0.1:1/v1', { guard: { hook: 'system' } });
  assert.equal(plugin.provider.inject, true);
  assert.equal(plugin.provider.baseURL, 'http://127.0.0.1:1/v1');
  assert.deepEqual(plugin.guard, { hook: 'system' });
});

/**
 * @param {string} url
 * @param {unknown} body
 */
async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return response.text();
}

/**
 * @param {string} url
 * @param {unknown} message
 */
async function rpc(url, message) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(message) });
  return response.json();
}
