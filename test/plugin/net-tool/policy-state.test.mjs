// Steps 2 and 3 of 12.8.2. A runtime profile with no usable `network` block is an empty policy that
// refuses every call (35.7, fail closed); a block whose recorded `policyHash` no longer matches its own
// content is drift, and refuses every call too, because it is not the policy `start` checked the
// rendered permissions against. The rate limits count requests that actually went out.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveReservedPorts } from '../../../plugin/opencode-unity-lib/net/policy.js';
import { buildPolicy, call, createContext, createTool, refusalCode, rehash } from './helpers.mjs';

const DOC_URL = 'https://docs.unity3d.com/Manual/index.html';

describe('step 2: a policy that is present and unchanged', () => {
  const disabled = [
    { name: 'no network block at all', network: null },
    { name: 'a block that is not an object', network: 'standard' },
    { name: 'enabled: false (profile none, --offline)', network: { ...buildPolicy(), enabled: false } },
    { name: 'no entries', network: rehash({ ...buildPolicy(), entries: [] }) },
    { name: 'an entry that does not normalise', network: { ...buildPolicy(), entries: [{ id: 'Bad Id', host: 'docs.unity3d.com' }] } },
    { name: 'no reservedPorts array (35.7: a missing one closes the whole policy)', network: (() => { const policy = buildPolicy(); delete policy.reservedPorts; return policy; })() },
    { name: 'a reservedPorts row that cannot be read', network: { ...buildPolicy(), reservedPorts: [{ port: 'eleven thousand' }] } },
  ];
  for (const { name, network } of disabled) {
    it(`refuses every call with net_disabled for ${name}`, async () => {
      const { tool, asked, sent } = createTool({ network });
      const { ctx, asks } = createContext();
      const text = await tool.execute(call('GET', DOC_URL), ctx);
      assert.equal(refusalCode(text), 'net_disabled');
      assert.match(text, /Ask the user to run: opencode-unity init --network standard$/);
      assert.equal(asks.length + asked.length + sent.length, 0);
    });
  }

  it('refuses every call with net_policy_drift when the recorded hash does not match the block', async () => {
    const policy = buildPolicy();
    policy.entries[0].methods.push('POST');
    const { tool, sent } = createTool({ network: policy });
    const text = await tool.execute(call('GET', DOC_URL), createContext().ctx);
    assert.equal(refusalCode(text), 'net_policy_drift');
    assert.match(text, /Ask the user to run: opencode-unity start$/);
    assert.equal(sent.length, 0);
  });

  it('treats a block with no recorded hash as drift, never as a pass', async () => {
    const policy = buildPolicy();
    policy.policyHash = null;
    const { tool } = createTool({ network: policy });
    assert.equal(refusalCode(await tool.execute(call('GET', DOC_URL), createContext().ctx)), 'net_policy_drift');
  });

  it('accepts the rendered shape: every row object, the hash over the normalised policy', async () => {
    const { tool, sent } = createTool({ network: buildPolicy({ reservedPorts: resolveReservedPorts({ ollamaPort: 11500 }) }) });
    const text = await tool.execute(call('GET', DOC_URL), createContext().ctx);
    assert.equal(refusalCode(text), null, text);
    assert.equal(sent.length, 1);
  });
});

describe('step 3: rate limits', () => {
  /**
   * @param {Record<string, number>} limits
   */
  function limited(limits) {
    let clock = 1_000_000;
    const tool = createTool({
      network: buildPolicy({ limits: { maxResponseBytes: 65536, maxOutputChars: 8192, maxUrlChars: 2048, ...limits } }),
      now: () => clock,
    });
    return { ...tool, advance: (/** @type {number} */ ms) => { clock += ms; } };
  }

  it('stops a session at maxRequestsPerSession and says so', async () => {
    const { tool, sent } = limited({ maxRequestsPerSession: 2, maxRequestsPerMinute: 100 });
    const { ctx } = createContext();
    for (let index = 0; index < 2; index += 1) assert.equal(refusalCode(await tool.execute(call('GET', DOC_URL), ctx)), null);
    const text = await tool.execute(call('GET', DOC_URL), ctx);
    assert.equal(refusalCode(text), 'net_rate_limited');
    assert.match(text, /this session has used all 2 of its requests/);
    assert.equal(sent.length, 2);
  });

  it('keeps the session cap per session', async () => {
    const { tool, sent } = limited({ maxRequestsPerSession: 1, maxRequestsPerMinute: 100 });
    assert.equal(refusalCode(await tool.execute(call('GET', DOC_URL), createContext({ sessionID: 'a' }).ctx)), null);
    assert.equal(refusalCode(await tool.execute(call('GET', DOC_URL), createContext({ sessionID: 'a' }).ctx)), 'net_rate_limited');
    assert.equal(refusalCode(await tool.execute(call('GET', DOC_URL), createContext({ sessionID: 'b' }).ctx)), null);
    assert.equal(sent.length, 2);
  });

  it('holds the minute window across sessions, so child sessions cannot multiply it, and releases it after a minute', async () => {
    const { tool, advance } = limited({ maxRequestsPerSession: 100, maxRequestsPerMinute: 2 });
    assert.equal(refusalCode(await tool.execute(call('GET', DOC_URL), createContext({ sessionID: 'a' }).ctx)), null);
    assert.equal(refusalCode(await tool.execute(call('GET', DOC_URL), createContext({ sessionID: 'b' }).ctx)), null);
    const text = await tool.execute(call('GET', DOC_URL), createContext({ sessionID: 'c' }).ctx);
    assert.equal(refusalCode(text), 'net_rate_limited');
    assert.match(text, /more than 2 requests in one minute/);
    advance(60_000);
    assert.equal(refusalCode(await tool.execute(call('GET', DOC_URL), createContext({ sessionID: 'c' }).ctx)), null);
  });

  it('does not count a refused call: only requests that went out spend the budget', async () => {
    const { tool } = limited({ maxRequestsPerSession: 1, maxRequestsPerMinute: 100 });
    const { ctx } = createContext();
    for (let index = 0; index < 5; index += 1) assert.equal(refusalCode(await tool.execute(call('GET', 'https://evil.test/'), ctx)), 'net_host_not_allowed');
    assert.equal(refusalCode(await tool.execute(call('GET', DOC_URL), ctx)), null);
  });

  it('re-checks the cap as it records, so parallel calls waiting on permission cannot overrun it', async () => {
    /** @type {Array<() => void>} */
    const releases = [];
    const { tool, sent } = limited({ maxRequestsPerSession: 1, maxRequestsPerMinute: 100 });
    const { ctx } = createContext({ answer: () => new Promise((resolve) => releases.push(() => resolve(undefined))) });
    const first = tool.execute(call('GET', DOC_URL), ctx);
    const second = tool.execute(call('GET', DOC_URL), ctx);
    await new Promise((resolve) => setImmediate(resolve));
    for (const release of releases) release();
    const codes = (await Promise.all([first, second])).map(refusalCode).sort();
    assert.deepEqual(codes, [null, 'net_rate_limited'].sort());
    assert.equal(sent.length, 1);
  });

  it('counts outbound bytes per entry for status and the session summary (DN26)', async () => {
    const { tool } = limited({ maxRequestsPerSession: 10, maxRequestsPerMinute: 100 });
    const { ctx } = createContext({ sessionID: 'bytes' });
    await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/a.html?x=1'), ctx);
    await tool.execute(call('GET', 'https://api.nuget.org/v3/index.json'), ctx);
    const snapshot = tool.snapshot('bytes');
    assert.equal(snapshot.requests, 2);
    assert.deepEqual(snapshot.entries.map((row) => row.id), ['nuget-api', 'unity-docs']);
    assert.equal(snapshot.entries.find((row) => row.id === 'unity-docs')?.bytes, '/Manual/a.html'.length + 'x=1'.length);
    assert.deepEqual(tool.snapshot('nobody'), { requests: 0, bytes: 0, entries: [] });
  });
});
