import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DEFAULT_CONFIG } from '../../../src/core/config.js';
import { buildNetworkPolicy, SHIPPED_HOST_ENTRIES } from '../../../src/network/render.js';
import { normalizeNetworkPolicy, policyHashMatches } from '../../../plugin/opencode-unity-lib/net/policy.js';
import { createTool, createContext, createRecordingSend, refusalCode } from '../../plugin/net-tool/helpers.mjs';
import { verifyNetworkPermission } from '../../../src/opencode/effective-config.js';
import { SHIPPED_HOST_ENTRIES as FIXTURE_HOSTS } from '../../plugin/net-policy/shipped-policy.mjs';

const settings = { editor: { enabled: false, trust: false, allowPlayMode: false }, bashMode: null };
const config = () => structuredClone(DEFAULT_CONFIG);
it('ships the reviewed host list and a self-consistent hash', () => {
  assert.deepEqual(SHIPPED_HOST_ENTRIES, FIXTURE_HOSTS.map(({ loopback, ...entry }) => entry));
  const built = buildNetworkPolicy({ config: config(), settings });
  const loaded = normalizeNetworkPolicy(built.policy);
  assert.equal(loaded.ok, true);
  assert.equal(policyHashMatches(loaded.policy, loaded.policy.policyHash), true);
  assert.equal(built.permission['*'], 'deny');
});
it('keeps disabled and empty policies hidden, and cannot reenable a global denial', () => {
  for (const input of [{ enabled: false }, { profile: 'none' }, { profile: 'custom', allow: [] }]) {
    const c = config(); Object.assign(c.network, input);
    const result = buildNetworkPolicy({ config: c, settings: { ...settings, network: { enabled: true } } });
    assert.equal(result.policy, null);
    assert.deepEqual(result.permission, { '*': 'deny' });
  }
});
it('rejects reserved ports, duplicate or overlapping entries and unapproved public writes', () => {
  const entry = { id: 'custom', host: 'localhost', ports: [11434], scheme: 'http', methods: ['GET'], pathPrefix: ['/'] };
  const c = config(); c.network.allow = [entry];
  assert.throws(() => buildNetworkPolicy({ config: c, settings }), /reserved|port/i);
  c.network.allow = [{ ...entry, host: 'example.test', ports: [443], scheme: 'https', methods: ['POST'], consentId: 'label' }];
  assert.throws(() => buildNetworkPolicy({ config: c, settings }), /POST/);
  c.network.allow = [{ ...entry, ports: [5055] }, { ...entry, ports: [5055] }];
  assert.throws(() => buildNetworkPolicy({ config: c, settings }), /Duplicate/);
});
it('project settings narrow limits, hosts, methods and budgets without mutating global defaults', () => {
  const c = config();
  const entry = { id: 'manual', host: 'docs.unity3d.com', ports: [443], scheme: 'https', methods: ['GET'], pathPrefix: ['/Manual/'], consentId: 'review', budget: { maxRequestBodyBytes: 10000 } };
  const narrowed = buildNetworkPolicy({ config: c, settings: { ...settings, network: { allow: [entry], limits: { maxOutputChars: 100 } } } });
  assert.equal(narrowed.policy.entries[0].budget.maxRequestBodyBytes, 0);
  assert.equal(narrowed.policy.limits.maxOutputChars, 100);
  assert.equal(narrowed.permission['GET https://docs.unity3d.com/*'], 'ask');
  assert.throws(() => buildNetworkPolicy({ config: c, settings: { ...settings, network: { allow: [{ ...entry, host: 'other.test' }] } } }), /widens/);
  assert.equal(buildNetworkPolicy({ config: c, settings }).policy.limits.maxOutputChars, DEFAULT_CONFIG.network.limits.maxOutputChars);
});
it('enforces the launched policy at the transport boundary and asks for custom hosts', async () => {
  const c = config(); c.network.profile = 'custom';
  c.network.allow = [{ id: 'custom', host: 'docs.unity3d.com', ports: [443], scheme: 'https', methods: ['GET'], pathPrefix: ['/Manual/'], consentId: 'review' }];
  const built = buildNetworkPolicy({ config: c, settings });
  const send = createRecordingSend(); const context = createContext();
  const tool = createTool({ network: built.policy, send: send.send });
  const allowed = await tool.tool.execute({ method: 'GET', url: 'https://docs.unity3d.com/Manual/index.html', body: '' }, context.ctx);
  assert.equal(refusalCode(allowed), null, allowed);
  assert.equal(send.sent.length, 1); assert.equal(context.asks.length, 1);
  const denied = await tool.tool.execute({ method: 'GET', url: 'https://docs.unity3d.com/ScriptReference/index.html', body: '' }, context.ctx);
  assert.ok(refusalCode(denied)); assert.equal(send.sent.length, 1);
});
it('rejects missing, widened and wildcard-overridden OpenCode network permissions', () => {
  const expected = { '*': 'deny', 'GET https://docs.unity3d.com/*': 'allow' };
  assert.equal(verifyNetworkPermission({ unitynet: expected }, expected).ok, true);
  assert.equal(verifyNetworkPermission({}, expected).ok, false);
  assert.equal(verifyNetworkPermission({ unitynet: { ...expected, '*': 'allow' } }, expected).ok, false);
  assert.equal(verifyNetworkPermission({ unitynet: expected, '*': 'allow' }, expected).ok, false);
  assert.equal(verifyNetworkPermission({ unitynet: expected, UNITYNET: 'allow' }, expected, true).ok, false);
});

it('project narrowing preserves emulator and locale restrictions', () => {
  const c = config(); c.network.profile = 'custom';
  const base = { id: 'functions', host: 'localhost', ports: [5001], scheme: 'http', methods: ['POST'], pathPrefix: ['/'], firebaseEmulator: 'functions' };
  c.network.allow = [base];
  const { firebaseEmulator, ...local } = base;
  const result = buildNetworkPolicy({ config: c, settings: { ...settings, network: { allow: [local] } } });
  assert.equal(result.policy.entries[0].firebaseEmulator, 'functions');
  assert.throws(() => buildNetworkPolicy({ config: c, settings: { ...settings, network: { allow: [{ ...local, stripLocaleSegment: true }] } } }), /widens/);
});
it('hashes literal headers as part of the launch policy', () => {
  const c = config(); c.network.profile = 'custom';
  c.network.allow = [{ id: 'local', host: 'localhost', ports: [5055], scheme: 'http', methods: ['GET'], pathPrefix: ['/'], headers: { 'X-Mode': 'original' } }];
  const built = buildNetworkPolicy({ config: c, settings });
  built.policy.entries[0].headers['X-Mode'] = 'changed';
  const changed = normalizeNetworkPolicy(built.policy);
  assert.equal(policyHashMatches(changed.policy, built.policy.policyHash), false);
});
