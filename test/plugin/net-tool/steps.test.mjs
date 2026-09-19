// The execution order of 12.8.2, where two steps could both refuse one request, and step 12's wrapper
// around `ctx.ask`. The order is what the model is told, so it is asserted rather than assumed: a
// request that fails step 10 and step 11 is refused by step 10, and nothing after a refusal runs.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyPermissionError } from '../../../plugin/opencode-unity-lib/net/tool.js';
import { FUNCTIONS_ENTRY, buildPolicy, call, createContext, createTool, refusalCode } from './helpers.mjs';

const FAKE_JWT = ['ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiJwbGF5ZXIifQ', '.', 'c2lnbmF0dXJlLXZhbHVl'].join('');

/** The ruleset text a `PermissionDeniedError` carries in 1.18.31 (spike N). */
const RULESET_MESSAGE = 'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [{"permission":"unitynet","pattern":"*","action":"deny"}]';

/**
 * @param {string} tag
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
function permissionError(tag, message, extra = {}) {
  return Object.assign(new Error(message), { name: tag, _tag: tag, ...extra });
}

describe('the order of the steps', () => {
  it('reports the outbound scan (step 10) before the demo- gate (step 11)', async () => {
    const { tool, sent } = createTool({ network: buildPolicy({ derived: [FUNCTIONS_ENTRY], disjoint: true }) });
    const text = await tool.execute(call('POST', 'http://127.0.0.1:5001/my-live-game/us-central1/f', JSON.stringify({ data: { idToken: FAKE_JWT } })), createContext().ctx);
    assert.equal(refusalCode(text), 'net_sensitive_outbound');
    assert.equal(sent.length, 0);
  });

  it('still reports the gate when the outbound scan is clean', async () => {
    const { tool } = createTool({ network: buildPolicy({ derived: [FUNCTIONS_ENTRY], disjoint: true }) });
    assert.equal(refusalCode(await tool.execute(call('POST', 'http://127.0.0.1:5001/my-live-game/us-central1/f', '{"data":{}}'), createContext().ctx)), 'net_firebase_project_not_demo');
  });

  it('reports a denied query key (step 9) before the outbound scan (step 10)', async () => {
    const { tool } = createTool();
    assert.equal(refusalCode(await tool.execute(call('GET', `https://docs.unity3d.com/Manual/${FAKE_JWT}?token=1`), createContext().ctx)), 'net_credential_in_url');
  });

  it('reports a reserved port (step 7) before the budget (step 8)', async () => {
    const { tool } = createTool();
    const overQueryBudget = `?q=${'a'.repeat(1500)}`;
    assert.equal(refusalCode(await tool.execute(call('GET', `http://127.0.0.1:3000/${overQueryBudget}`), createContext().ctx)), 'net_budget_exceeded');
    assert.equal(refusalCode(await tool.execute(call('GET', `http://127.0.0.1:11434/${overQueryBudget}`), createContext().ctx)), 'net_reserved_port');
  });

  it('reports the budget (step 8) with the smallest cap any matching entry declares', async () => {
    const { tool } = createTool();
    const text = await tool.execute(call('GET', `https://docs.unity3d.com/${'a'.repeat(600)}`), createContext().ctx);
    assert.equal(refusalCode(text), 'net_budget_exceeded');
    assert.match(text, /the path is 601 characters and this host allows 512/);
  });

  it('reports a body on a read before the host (step 5 is decided before the entry set)', async () => {
    const { tool } = createTool();
    assert.equal(refusalCode(await tool.execute(call('GET', 'https://attacker.example/', 'x'), createContext().ctx)), 'net_body_on_read');
  });

  it('refuses a path that climbs out of its prefix, with no grant to offer', async () => {
    const { tool } = createTool();
    const text = await tool.execute(call('GET', 'https://learn.microsoft.com/dotnet/%2E%2E%2Fazure/secrets'), createContext().ctx);
    assert.equal(refusalCode(text), 'net_path_not_allowed');
    assert.doesNotMatch(text, /Ask the user/);
  });

  it('offers a path grant for a path outside the prefixes, naming only a plain first segment', async () => {
    const { tool } = createTool();
    const text = await tool.execute(call('GET', 'https://learn.microsoft.com/azure/functions/'), createContext().ctx);
    assert.equal(refusalCode(text), 'net_path_not_allowed');
    assert.match(text, /Ask the user to run: opencode-unity net allow learn\.microsoft\.com --path \/azure\/$/);
  });

  it('offers a port grant for a port no entry carries', async () => {
    const { tool } = createTool();
    const text = await tool.execute(call('GET', 'https://docs.unity3d.com:8443/Manual/'), createContext().ctx);
    assert.equal(refusalCode(text), 'net_port_not_allowed');
    assert.match(text, /opencode-unity net allow docs\.unity3d\.com --port 8443$/);
  });

  it('refuses plain http to a documentation host without offering to allow it', async () => {
    const { tool } = createTool();
    const text = await tool.execute(call('GET', 'http://docs.unity3d.com/Manual/'), createContext().ctx);
    assert.equal(refusalCode(text), 'net_port_not_allowed');
    assert.match(text, /this scheme is not allowed for this host\.$/);
  });

  const urlCases = [
    { url: 'ftp://docs.unity3d.com/x', code: 'net_url_invalid', words: /only absolute http:\/\/ and https:\/\/ URLs are accepted/ },
    { url: 'https://docs.unity3d.com/Manual/#top', code: 'net_url_invalid', words: /remove the #fragment/ },
    { url: 'https://docs.unity3d.com/Man ual/', code: 'net_url_invalid', words: /space or a control character/ },
    { url: 'https://docs.unity3d.com\\@evil.test/', code: 'net_url_invalid', words: /backslash/ },
    { url: '/Manual/index.html', code: 'net_url_invalid', words: /could not be parsed as an absolute URL/ },
    { url: `https://d${String.fromCodePoint(0xf6)}cs.unity3d.com/`, code: 'net_url_idn', words: /ASCII form/ },
  ];
  for (const { url, code, words } of urlCases) {
    it(`refuses ${JSON.stringify(url)} at step 4 with ${code}`, async () => {
      const { tool, sent } = createTool();
      const text = await tool.execute(call('GET', url), createContext().ctx);
      assert.equal(refusalCode(text), code);
      assert.match(text, words);
      assert.equal(sent.length, 0);
    });
  }
});

describe('step 12: the permission ask, wrapped', () => {
  it('asks once, for the pattern of 35.7, only after every policy step passed', async () => {
    const { tool } = createTool();
    const { ctx, asks } = createContext();
    await tool.execute(call('GET', 'https://learn.microsoft.com/en-us/dotnet/api/system.string?view=net-8.0'), ctx);
    await tool.execute(call('GET', 'http://127.0.0.1:3000/v1/scores?page=2'), ctx);
    await tool.execute(call('GET', 'https://docs.unity3d.com:8443/x'), ctx);
    assert.deepEqual(asks.map((request) => request.patterns), [
      ['GET https://learn.microsoft.com/en-us/dotnet/api/system.string'],
      ['GET http://127.0.0.1:3000/v1/scores'],
    ]);
  });

  const outcomes = [
    { name: 'a rule denial', error: permissionError('PermissionDeniedError', RULESET_MESSAGE, { ruleset: [] }), words: /a permission rule refuses this request\.$/ },
    { name: 'a human refusal', error: permissionError('PermissionRejectedError', 'The user rejected permission to use this specific tool call.'), words: /the user declined this request\.$/ },
    { name: 'a refusal with feedback', error: permissionError('PermissionCorrectedError', 'ignored', { feedback: 'Use the staging\nemulator instead.' }), words: /the user declined this request and said: Use the staging emulator instead\.$/ },
    { name: 'an unknown rejection', error: new TypeError('boom'), words: /the permission for this request was denied\.$/ },
    { name: 'a rejection that is not an Error', error: 'nope', words: /the permission for this request was denied\.$/ },
  ];
  for (const { name, error, words } of outcomes) {
    it(`turns ${name} into net_permission_denied, resolves nothing, sends nothing`, async () => {
      const { tool, asked, sent } = createTool();
      const { ctx } = createContext({ answer: () => { throw error; } });
      const text = await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), ctx);
      assert.equal(refusalCode(text), 'net_permission_denied');
      assert.match(text, words);
      assert.equal(text.includes('"permission"'), false, 'the ruleset JSON reached the model');
      assert.equal(asked.length + sent.length, 0);
    });
  }

  it('refuses when the context carries no ask at all', async () => {
    const { tool, sent } = createTool();
    const text = await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), { sessionID: 'ses', agent: 'unity-code' });
    assert.equal(refusalCode(text), 'net_permission_denied');
    assert.equal(sent.length, 0);
  });

  it('does not time a human answering the prompt: the total limit starts after the ask', async () => {
    const { tool, sent } = createTool({ network: buildPolicy({ limits: { totalTimeoutMs: 30, maxRequestsPerSession: 40, maxRequestsPerMinute: 20 } }) });
    const { ctx } = createContext({ answer: () => new Promise((resolve) => setTimeout(resolve, 80)) });
    const text = await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), ctx);
    assert.equal(refusalCode(text), null, text);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].limits.totalTimeoutMs > 0 && sent[0].limits.totalTimeoutMs <= 30);
  });

  it('classifyPermissionError reads the tag first, then the name, and caps the feedback', () => {
    assert.deepEqual(classifyPermissionError({ _tag: 'PermissionDeniedError', name: 'Error' }), { ok: false, reason: 'rule' });
    assert.deepEqual(classifyPermissionError({ name: 'PermissionRejectedError' }), { ok: false, reason: 'rejected' });
    assert.deepEqual(classifyPermissionError({ name: 'PermissionCorrectedError', message: 'no' }), { ok: false, reason: 'corrected', feedback: 'no' });
    assert.deepEqual(classifyPermissionError({ name: 'PermissionCorrectedError' }), { ok: false, reason: 'corrected' });
    assert.equal(classifyPermissionError({ name: 'PermissionCorrectedError', feedback: 'x'.repeat(1000) }).feedback?.length, 300);
    assert.deepEqual(classifyPermissionError(null), { ok: false, reason: 'unknown' });
  });
});
