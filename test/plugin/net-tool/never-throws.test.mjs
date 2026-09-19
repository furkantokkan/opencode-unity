// `DN18`: the tool never throws. Spike N measured what a throw costs on OpenCode 1.18.31: the session
// survives, but the model reads OpenCode's raw error text instead of a stable code, and an uncaught
// denial from `ctx.ask` hands it the permission ruleset as JSON. So every dependency that can fail is
// made to fail here, and every call must still resolve to one ordinary result line.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPolicy, call, createContext, createTool, refusalCode } from './helpers.mjs';

const DOC = call('GET', 'https://docs.unity3d.com/Manual/index.html');

/**
 * @param {unknown} value
 */
function assertResult(value) {
  assert.equal(typeof value, 'string');
  assert.match(/** @type {string} */ (value), /^unitynet /);
}

describe('every dependency failing, one at a time', () => {
  const failures = [
    { name: 'a resolver that throws synchronously', options: { lookup: () => { throw new Error('sync'); } }, code: 'net_dns_failed' },
    { name: 'a resolver that rejects with a non-Error', options: { lookup: () => Promise.reject('nope') }, code: 'net_dns_failed' },
    { name: 'a resolver that answers with garbage', options: { lookup: async () => /** @type {any} */ ('127.0.0.1') }, code: 'net_dns_failed' },
    { name: 'a transport that throws', options: { send: () => { throw new Error('socket'); } }, code: 'net_tool_error' },
    { name: 'a transport that rejects', options: { send: () => Promise.reject(new Error('socket')) }, code: 'net_tool_error' },
    { name: 'a transport that answers with nothing', options: { send: async () => /** @type {any} */ (null) }, code: 'net_tool_error' },
    { name: 'a log that throws', options: { log: { append: () => { throw new Error('disk full'); } } }, code: null },
    { name: 'a clock that throws after the first reading', options: (() => { let reads = 0; return { now: () => { reads += 1; if (reads > 1) throw new Error('clock'); return 0; } }; })(), code: 'net_tool_error' },
  ];
  for (const { name, options, code } of failures) {
    it(`resolves with a result line for ${name}`, async () => {
      const { tool } = createTool(/** @type {any} */ (options));
      let text;
      await assert.doesNotReject(async () => {
        text = await tool.execute(DOC, createContext().ctx);
      });
      assertResult(text);
      assert.equal(refusalCode(/** @type {any} */ (text)), code);
    });
  }

  it('resolves when reading the trust anchor fails', async () => {
    const entry = { id: 'local-api', host: 'localhost', hostKind: 'exact', ports: [7001], scheme: 'https', methods: ['GET'], pathPrefix: ['/'], loopback: true, caFile: '/opt/dev-certs/root.pem' };
    const { tool } = createTool({ network: buildPolicy({ entries: [entry] }), readCaFile: async () => { throw new Error('EACCES'); } });
    assert.equal(refusalCode(await tool.execute(call('GET', 'https://localhost:7001/health'), createContext().ctx)), 'net_tls_untrusted');
  });

  it('resolves when the network block is a hostile object whose getters throw', async () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('trap'); }, has: () => { throw new Error('trap'); } });
    const { tool } = createTool({ network: hostile });
    assert.equal(refusalCode(await tool.execute(DOC, createContext().ctx)), 'net_disabled');
  });
});

describe('every context and argument shape', () => {
  it('works with no context, a null context and a context with no session', async () => {
    const { tool } = createTool();
    for (const ctx of [undefined, null, {}]) {
      const text = await tool.execute(DOC, /** @type {any} */ (ctx));
      assert.equal(refusalCode(text), 'net_permission_denied');
    }
  });

  it('refuses arguments whose getters throw', async () => {
    const { tool } = createTool();
    const args = Object.defineProperty({ method: 'GET', body: '' }, 'url', { enumerable: true, get: () => { throw new Error('getter'); } });
    const text = await tool.execute(args, createContext().ctx);
    assertResult(text);
    assert.equal(refusalCode(text), 'net_tool_error');
  });

  it('resolves for a deterministic spread of hostile argument shapes', async () => {
    const { tool, sent } = createTool();
    let seed = 20260918;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const values = [undefined, null, 0, -1, 1e308, Number.NaN, true, '', 'GET', 'get', 'DELETE', 'https://docs.unity3d.com/', 'http://127.0.0.1:11434/api/pull', 'file:///etc/passwd', 'javascript:alert(1)', '%', '\\', [], {}, ['GET'], { toString: () => 'GET' }, 'x'.repeat(5000)];
    for (let round = 0; round < 300; round += 1) {
      /** @type {Record<string, unknown>} */
      const args = {};
      for (const key of ['method', 'url', 'body', 'headers', '__proto__', 'file']) {
        if (next() % 3 === 0) continue;
        args[key] = values[next() % values.length];
      }
      const text = await tool.execute(next() % 7 === 0 ? values[next() % values.length] : args, createContext().ctx);
      assertResult(text);
    }
    for (const request of sent) assert.equal(request.host, 'docs.unity3d.com');
  });
});
