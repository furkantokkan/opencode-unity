// The tool as the plugin registers it (build step S35's edit to `plugin/opencode-unity.js`): one entry in
// the hook map's `tool` object under its literal id, with the JSON-Schema args, registered whether or
// not the runtime profile carries a policy, and fed the OpenCode server port from the plugin input on
// every request - `serverUrl` is a getter in OpenCode, so reading it once at load would freeze a port
// the server can still move off.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import plugin, { createHooks, startPlugin } from '../../../plugin/opencode-unity.js';
import { TOOL_DESCRIPTION, readServerPort } from '../../../plugin/opencode-unity-lib/net/tool.js';
import { buildPolicy, call, createContext, createRecordingSend, refusalCode } from './helpers.mjs';

/** A file system with nothing in it: no runtime profile, no project files. */
const EMPTY_FS = /** @type {any} */ ({
  readFile: async () => {
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  },
  mkdir: async () => {},
  appendFile: async () => {},
  readdir: async () => [],
  rm: async () => {},
});

/**
 * @param {{ serverUrl?: unknown }} input
 * @param {Record<string, unknown>} [netOptions]
 */
async function startWith(input, netOptions = {}) {
  return startPlugin(/** @type {any} */ (input), { env: {}, platform: 'linux', profilePath: '/opt/profile/opencode-unity.runtime.json', fsImpl: EMPTY_FS, netOptions });
}

describe('registration', () => {
  it('exposes the tool under its literal id with the declared description and args', async () => {
    const hooks = await startWith({});
    const tool = hooks.tool?.unitynet;
    assert.ok(tool, 'the tool map carries unitynet');
    assert.deepEqual(Object.keys(hooks.tool), ['unitynet']);
    assert.equal(tool.description, TOOL_DESCRIPTION);
    assert.deepEqual(Object.keys(tool.args).sort(), ['body', 'method', 'url']);
    assert.equal(typeof tool.execute, 'function');
  });

  it('refuses every call when the runtime profile is missing, so the tool fails closed', async () => {
    const hooks = await startWith({});
    const text = await hooks.tool.unitynet.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), createContext().ctx);
    assert.equal(refusalCode(text), 'net_disabled');
  });

  it('gives a fake runtime with no tool the fail-closed one', async () => {
    const hooks = createHooks(/** @type {any} */ ({ log: { append: () => {} }, toaster: {}, shell: {} }), { env: {}, userHome: null });
    const text = await hooks.tool.unitynet.execute(call('GET', 'https://docs.unity3d.com/'), createContext().ctx);
    assert.equal(refusalCode(text), 'net_disabled');
  });

  it('keeps the module shape OpenCode loads', () => {
    assert.equal(typeof plugin.server, 'function');
  });
});

describe('the OpenCode server port, read per request', () => {
  it('reserves the port the plugin input reports, and follows it when it changes', async () => {
    let current = new URL('http://127.0.0.1:4096');
    const input = { get serverUrl() { return current; } };
    const recording = createRecordingSend();
    const hooks = await startWith(input, { network: buildPolicy(), send: recording.send });
    const { ctx } = createContext();
    assert.equal(refusalCode(await hooks.tool.unitynet.execute(call('GET', 'http://127.0.0.1:4096/session'), ctx)), 'net_reserved_port');
    assert.equal(refusalCode(await hooks.tool.unitynet.execute(call('GET', 'http://127.0.0.1:5173/'), ctx)), null);
    current = new URL('http://127.0.0.1:5173');
    const moved = await hooks.tool.unitynet.execute(call('GET', 'http://127.0.0.1:5173/'), ctx);
    assert.equal(refusalCode(moved), 'net_reserved_port');
    assert.match(moved, /OpenCode server/);
    assert.equal(recording.sent.length, 1);
  });

  it('fails closed on loopback when the getter throws', async () => {
    const input = { get serverUrl() { throw new Error('no server'); } };
    const hooks = await startWith(input, { network: buildPolicy(), send: createRecordingSend().send });
    assert.equal(refusalCode(await hooks.tool.unitynet.execute(call('GET', 'http://127.0.0.1:5173/'), createContext().ctx)), 'net_reserved_port');
  });
});

describe('readServerPort', () => {
  const cases = [
    { name: 'a URL with a port', input: { serverUrl: new URL('http://127.0.0.1:4096') }, expected: { known: true, port: 4096 } },
    { name: 'a string with a port', input: { serverUrl: 'http://localhost:51234/' }, expected: { known: true, port: 51234 } },
    { name: 'http with the default port', input: { serverUrl: 'http://localhost/' }, expected: { known: true, port: 80 } },
    { name: 'https with the default port', input: { serverUrl: 'https://localhost/' }, expected: { known: true, port: 443 } },
    { name: 'a scheme with no default port', input: { serverUrl: 'ws://localhost/' }, expected: { known: false, port: null } },
    { name: 'something that is not a URL', input: { serverUrl: 'not a url' }, expected: { known: false, port: null } },
    { name: 'no serverUrl at all', input: {}, expected: { known: false, port: null } },
    { name: 'a null input', input: null, expected: { known: false, port: null } },
  ];
  for (const { name, input, expected } of cases) {
    it(`reads ${name}`, () => {
      assert.deepEqual(readServerPort(/** @type {any} */ (input)), expected);
    });
  }

  it('reads a getter that throws as unknown', () => {
    assert.deepEqual(readServerPort(/** @type {any} */ ({ get serverUrl() { throw new Error('x'); } })), { known: false, port: null });
  });
});
