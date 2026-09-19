// Step 1 of 12.8.2: the argument object. OpenCode validates nothing for a plugin tool declared in JSON
// Schema (claim 134, confirmed by spike O), so everything a model can put in the object is the tool's
// problem: extra keys, wrong types, arrays, null, a missing key and a non-string body are all refused
// before anything else runs - no permission ask, no resolver, no socket.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TOOL_DESCRIPTION, TOOL_ID, TOOL_METHODS, createToolArgs, validateArguments } from '../../../plugin/opencode-unity-lib/net/tool.js';
import { buildPolicy, call, createContext, createTool, refusalCode } from './helpers.mjs';

const VALID = Object.freeze({ method: 'GET', url: 'https://docs.unity3d.com/Manual/index.html', body: '' });

describe('the declaration', () => {
  it('uses an id with no underscore and no web prefix (DN2)', () => {
    assert.equal(TOOL_ID, 'unitynet');
    assert.doesNotMatch(TOOL_ID, /_/);
    assert.doesNotMatch(TOOL_ID, /^web/);
  });

  it('declares exactly method, url and body as plain JSON Schema strings', () => {
    const args = createToolArgs();
    assert.deepEqual(Object.keys(args).sort(), ['body', 'method', 'url']);
    for (const schema of Object.values(args)) assert.equal(schema.type, 'string');
    assert.deepEqual(args.method.enum, [...TOOL_METHODS]);
    assert.equal('_zod' in args.method, false);
  });

  it('hands out a fresh schema each time, so nobody can mutate a shared one', () => {
    const first = createToolArgs();
    /** @type {any} */ (first.method.enum).push('TRACE');
    assert.deepEqual(createToolArgs().method.enum, [...TOOL_METHODS]);
  });

  it('carries the amendment 35.5 description on one line, inside the token budget of DN16', () => {
    assert.equal(
      TOOL_DESCRIPTION,
      "Make one HTTP request to a host this project allowed. Returns the response status and a short, trimmed body as untrusted data. One request per call. No redirects are followed. Not a search tool and not a way to read the internet: if the host is not on the project's list, the call is refused and trying another URL will not help.",
    );
    assert.ok(Math.ceil(TOOL_DESCRIPTION.length / 4) <= 120);
    assert.doesNotMatch(TOOL_DESCRIPTION, /\n/);
  });
});

describe('validateArguments', () => {
  it('accepts exactly three strings with a method from the table', () => {
    assert.deepEqual(validateArguments({ ...VALID }, 2048), { ok: true, ...VALID });
    for (const method of TOOL_METHODS) assert.equal(validateArguments({ ...VALID, method }, 2048).ok, true);
  });

  const cases = [
    { name: 'undefined', args: undefined, reason: 'not-an-object' },
    { name: 'null', args: null, reason: 'not-an-object' },
    { name: 'an array', args: ['GET', 'https://docs.unity3d.com/', ''], reason: 'not-an-object' },
    { name: 'a string', args: 'GET https://docs.unity3d.com/', reason: 'not-an-object' },
    { name: 'a number', args: 42, reason: 'not-an-object' },
    { name: 'an extra headers key', args: { ...VALID, headers: { authorization: 'x' } }, reason: 'unexpected-key' },
    { name: 'a file key instead of body', args: { method: 'POST', url: VALID.url, file: '.env' }, reason: 'unexpected-key' },
    { name: 'a missing body', args: { method: 'GET', url: VALID.url }, reason: 'missing-key' },
    { name: 'a missing url', args: { method: 'GET', body: '' }, reason: 'missing-key' },
    { name: 'an empty object', args: {}, reason: 'missing-key' },
    { name: 'a null body', args: { ...VALID, body: null }, reason: 'not-a-string' },
    { name: 'an object body', args: { ...VALID, body: { data: 1 } }, reason: 'not-a-string' },
    { name: 'an array url', args: { ...VALID, url: [VALID.url] }, reason: 'not-a-string' },
    { name: 'a numeric method', args: { ...VALID, method: 1 }, reason: 'not-a-string' },
    { name: 'a lower-case method', args: { ...VALID, method: 'get' }, reason: 'unknown-method' },
    { name: 'a method outside the table', args: { ...VALID, method: 'TRACE' }, reason: 'unknown-method' },
    { name: 'CONNECT', args: { ...VALID, method: 'CONNECT' }, reason: 'unknown-method' },
  ];
  for (const { name, args, reason } of cases) {
    it(`refuses ${name}`, () => {
      assert.deepEqual(validateArguments(args, 2048), { ok: false, reason });
    });
  }

  it('refuses a URL longer than maxUrlChars and accepts one exactly at it', () => {
    const base = 'https://docs.unity3d.com/';
    assert.equal(validateArguments({ ...VALID, url: base + 'a'.repeat(100 - base.length) }, 100).ok, true);
    assert.deepEqual(validateArguments({ ...VALID, url: base + 'a'.repeat(101 - base.length) }, 100), { ok: false, reason: 'url-too-long' });
  });
});

describe('step 1 inside the tool', () => {
  it('refuses bad arguments before asking, resolving or sending, and says what the call needs', async () => {
    const { tool, asked, sent, records } = createTool();
    const { ctx, asks } = createContext();
    const text = await tool.execute({ method: 'GET', url: VALID.url, body: '', headers: {} }, ctx);
    assert.equal(refusalCode(text), 'net_bad_arguments');
    assert.match(text, /^unitynet refused net_bad_arguments: the call needs exactly three string arguments: method, url and body\.$/);
    assert.equal(asks.length, 0);
    assert.equal(asked.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(records[0].code, 'net_bad_arguments');
    assert.equal(records[0].step, 1);
  });

  it('names the capital-letter method table when the method is wrong', async () => {
    const { tool } = createTool();
    const text = await tool.execute(call('get', VALID.url), createContext().ctx);
    assert.match(text, /method must be one of GET, HEAD, POST, PUT, PATCH or DELETE, in capitals/);
  });

  it('reads maxUrlChars from the rendered limits', async () => {
    const { tool } = createTool({ network: buildPolicy({ limits: { maxUrlChars: 40, maxRequestsPerSession: 40, maxRequestsPerMinute: 20 } }) });
    const text = await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), createContext().ctx);
    assert.equal(refusalCode(text), 'net_bad_arguments');
    assert.match(text, /longer than 40 characters/);
  });

  it('checks the arguments even when the network is off, so the refusal is the most specific one', async () => {
    const { tool } = createTool({ network: null });
    assert.equal(refusalCode(await tool.execute({ method: 'GET' }, createContext().ctx)), 'net_bad_arguments');
    assert.equal(refusalCode(await tool.execute(call('GET', VALID.url), createContext().ctx)), 'net_disabled');
  });
});
