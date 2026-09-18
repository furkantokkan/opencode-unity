// The policy core: normalisation and fail-closed reading, the reserved-port table, the execution
// order of amendment 35.5 steps 4 to 11, the render-time entry rules, the redirect decision and the
// policy hash. The precedence rules of `DN25` have their own suite next door.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_DENIED_QUERY_KEYS,
  DEFAULT_OLLAMA_PORT,
  UNCONDITIONAL_RESERVED_PORTS,
  evaluatePolicy,
  evaluateRedirectTarget,
  findReservedPort,
  hashPolicy,
  normalizeNetworkPolicy,
  policyHashMatches,
  resolveReservedPorts,
  validateEntry,
} from '../../../plugin/opencode-unity-lib/net/policy.js';
import { SENSITIVE_KEYS } from '../../../plugin/opencode-unity-lib/net/sensitive.js';
import { FUNCTIONS_ENTRY, LOOPBACK_DEV_ENTRY, SHIPPED_HOST_ENTRIES, buildPolicy } from './shipped-policy.mjs';

const STANDARD = buildPolicy();

/**
 * @param {string} method
 * @param {string} url
 * @param {{ policy?: object, body?: string, reservedPorts?: object[], credentialDetector?: (value: string) => boolean }} [options]
 */
function evaluate(method, url, { policy = STANDARD, body, reservedPorts, credentialDetector } = {}) {
  return evaluatePolicy({ policy, method, url, body, reservedPorts, credentialDetector });
}

describe('net/policy: reading the rendered block', () => {
  it('reads a valid block', () => {
    const result = normalizeNetworkPolicy(STANDARD);
    assert.equal(result.ok, true);
    assert.equal(result.policy.entries.length, SHIPPED_HOST_ENTRIES.length + 1);
    assert.equal(result.policy.entries[0].hostKind, 'exact');
  });

  it('fails closed on a block it cannot use, and says which', () => {
    const cases = [
      [undefined, 'network block missing'],
      [{}, 'network disabled'],
      [{ enabled: false, entries: [LOOPBACK_DEV_ENTRY] }, 'network disabled'],
      [{ enabled: true, entries: [] }, 'no entries'],
      [{ enabled: true, entries: 'all' }, 'no entries'],
    ];
    for (const [raw, reason] of cases) {
      const result = normalizeNetworkPolicy(raw);
      assert.equal(result.ok, false, JSON.stringify(raw));
      assert.equal(result.reason, reason);
      assert.equal(result.policy.enabled, false);
      assert.deepEqual(result.policy.entries, []);
    }
  });

  it('empties the whole policy when one entry is unusable, rather than dropping the entry', () => {
    const broken = { ...LOOPBACK_DEV_ENTRY, id: 'has_underscore' };
    const result = normalizeNetworkPolicy({ enabled: true, entries: [...SHIPPED_HOST_ENTRIES, broken] });
    assert.equal(result.ok, false);
    assert.match(/** @type {string} */ (result.reason), /invalid entry/);
    assert.equal(result.policy.entries.length, 0, 'a dropped field is a widened surface');
  });

  it('refuses an entry whose method, port, scheme or path prefix is not usable', () => {
    const broken = [
      { ...LOOPBACK_DEV_ENTRY, methods: ['TRACE'] },
      { ...LOOPBACK_DEV_ENTRY, methods: [] },
      { ...LOOPBACK_DEV_ENTRY, ports: [0] },
      { ...LOOPBACK_DEV_ENTRY, ports: [70000] },
      { ...LOOPBACK_DEV_ENTRY, scheme: 'ftp' },
      { ...LOOPBACK_DEV_ENTRY, pathPrefix: ['no-leading-slash'] },
      { ...LOOPBACK_DEV_ENTRY, pathPrefix: [] },
      { ...LOOPBACK_DEV_ENTRY, host: 'evil.test/path' },
      { ...SHIPPED_HOST_ENTRIES[0], hostKind: 'suffix', host: 'example.com' },
    ];
    for (const entry of broken) {
      const result = normalizeNetworkPolicy({ enabled: true, entries: [entry], reservedPorts: [] });
      assert.equal(result.ok, false, JSON.stringify(entry.id));
      assert.match(/** @type {string} */ (result.reason), /invalid entry/);
    }
  });

  it('fails closed on a block whose reserved-port table is missing or unreadable (DN10, 35.7)', () => {
    for (const reservedPorts of [undefined, null, 'garbage', {}, [{ port: '2375' }], [0], [{ reason: 'docker-daemon' }]]) {
      const result = normalizeNetworkPolicy({ enabled: true, entries: [LOOPBACK_DEV_ENTRY], reservedPorts });
      assert.equal(result.ok, false, JSON.stringify(reservedPorts));
      assert.equal(result.reason, 'invalid reservedPorts');
      for (const port of [2375, 4400, DEFAULT_OLLAMA_PORT]) {
        assert.equal(evaluate('GET', `http://127.0.0.1:${port}/x`, { policy: result.policy }).ok, false, `${JSON.stringify(reservedPorts)} ${port}`);
      }
    }
  });

  it('adds the unconditional rows to a rendered table that left them out', () => {
    const result = normalizeNetworkPolicy({ enabled: true, entries: [LOOPBACK_DEV_ENTRY], reservedPorts: [] });
    assert.equal(result.ok, true);
    for (const port of [4400, 2375, 2376]) {
      assert.equal(evaluate('GET', `http://127.0.0.1:${port}/x`, { policy: result.policy }).code, 'net_reserved_port', String(port));
    }
  });

  it('refuses a policy at all when it is empty, before any URL is parsed', () => {
    const result = evaluate('GET', 'https://docs.unity3d.com/Manual/x', { policy: normalizeNetworkPolicy(null).policy });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'net_disabled');
  });
});

describe('net/policy: the reserved-port table', () => {
  it('always carries the three unconditional rows', () => {
    const rows = resolveReservedPorts({ ollamaPort: null });
    assert.deepEqual(rows.map((row) => row.port), UNCONDITIONAL_RESERVED_PORTS.map((row) => row.port));
    assert.equal(rows.every((row) => row.conditional === false), true);
  });

  it('reserves Ollama at its configured port, not at a constant', () => {
    assert.equal(findReservedPort(DEFAULT_OLLAMA_PORT, resolveReservedPorts())?.reason, 'ollama-api');
    const moved = resolveReservedPorts({ ollamaPort: 11500 });
    assert.equal(findReservedPort(11500, moved)?.reason, 'ollama-api');
    assert.equal(findReservedPort(DEFAULT_OLLAMA_PORT, moved), null);
  });

  it('leaves 8080 an ordinary loopback port when no hub is there', () => {
    const rows = resolveReservedPorts({ unityMcpHubPort: null });
    assert.equal(findReservedPort(8080, rows), null, 'an ordinary Firebase project keeps Firestore on 8080');
  });

  it('reserves 8080 when a hub answers there, and says the row was conditional', () => {
    const row = findReservedPort(8080, resolveReservedPorts({ unityMcpHubPort: 8080 }));
    assert.equal(row?.reason, 'unity-mcp-hub');
    assert.equal(row?.conditional, true);
  });

  it('reserves a running OpenCode server port, which only the plugin knows', () => {
    assert.equal(findReservedPort(4096, resolveReservedPorts({ openCodeServerPort: 4096 }))?.reason, 'opencode-server');
    assert.equal(findReservedPort(4096, resolveReservedPorts({}))?.reason, undefined);
  });

  it('adds the config rows and ignores an unusable port', () => {
    const rows = resolveReservedPorts({ extraPorts: [9000, 0, 70000, 'nine'] });
    assert.equal(findReservedPort(9000, rows)?.reason, 'config-extra');
    assert.equal(rows.length, 5, 'three unconditional, Ollama, and the one usable extra');
  });

  it('refuses a reserved port whatever entry matched, under any profile', () => {
    const custom = buildPolicy({ entries: [{ ...LOOPBACK_DEV_ENTRY, id: 'user-loopback', shipped: false }] });
    for (const port of [11434, 4400, 2375, 2376]) {
      const result = evaluate('GET', `http://127.0.0.1:${port}/x`, { policy: custom });
      assert.equal(result.ok, false, String(port));
      assert.equal(result.code, 'net_reserved_port');
    }
  });

  it('adds a table the plugin resolved per request to the rendered one', () => {
    const result = evaluate('GET', 'http://127.0.0.1:4096/x', { reservedPorts: resolveReservedPorts({ openCodeServerPort: 4096 }) });
    assert.equal(result.code, 'net_reserved_port');
    assert.equal(evaluate('GET', 'http://127.0.0.1:4096/x').ok, true, 'ordinary when no server is there');
  });

  it('keeps the rendered hub and a moved Ollama port when a per-request table carries only the server port', () => {
    const policy = buildPolicy({ reservedPorts: resolveReservedPorts({ ollamaPort: 11500, unityMcpHubPort: 8080 }) });
    const perRequest = [{ port: 4096, reason: 'opencode-server', conditional: true }];
    for (const [port, reason] of [[8080, 'unity-mcp-hub'], [11500, 'ollama-api'], [4096, 'opencode-server'], [2375, 'docker-daemon']]) {
      const result = evaluate('GET', `http://127.0.0.1:${port}/x`, { policy, reservedPorts: perRequest });
      assert.equal(result.code, 'net_reserved_port', String(port));
      assert.equal(result.reason, reason);
    }
  });
});

describe('net/policy: matching and the method classes', () => {
  it('allows a shipped documentation read', () => {
    const result = evaluate('GET', 'https://docs.unity3d.com/Manual/Profiler.html');
    assert.equal(result.ok, true);
    assert.deepEqual(result.entryIds, ['unity-docs']);
  });

  it('allows a locale-prefixed path on the entry that asked for stripping', () => {
    assert.equal(evaluate('GET', 'https://learn.microsoft.com/tr-tr/dotnet/api/x').ok, true);
    assert.equal(evaluate('GET', 'https://learn.microsoft.com/dotnet/api/x').ok, true);
    assert.equal(evaluate('GET', 'https://learn.microsoft.com/azure/x').code, 'net_path_not_allowed');
  });

  it('names the most specific reason the entry set is empty', () => {
    assert.equal(evaluate('GET', 'https://evil.test/x').code, 'net_host_not_allowed');
    assert.equal(evaluate('GET', 'https://docs.unity3d.com.evil.test/x').code, 'net_host_not_allowed');
    assert.equal(evaluate('GET', 'https://docs.unity3d.com:8443/Manual/x').code, 'net_port_not_allowed');
    assert.equal(evaluate('GET', 'http://docs.unity3d.com/Manual/x').code, 'net_port_not_allowed', 'http is not the entry scheme');
    assert.equal(evaluate('GET', 'https://api.nuget.org/v2/index.json').code, 'net_path_not_allowed');
  });

  it('refuses a traversal before the prefix is compared', () => {
    const result = evaluate('GET', 'https://api.nuget.org/v3/x%2F..%2F..%2Fsecret');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'net_path_not_allowed');
    assert.equal(result.reason, 'traversal');
  });

  it('refuses a method the entries do not carry, and an unknown verb', () => {
    assert.equal(evaluate('POST', 'https://docs.unity3d.com/Manual/x', { body: '{}' }).code, 'net_method_not_allowed');
    assert.equal(evaluate('TRACE', 'https://docs.unity3d.com/Manual/x').code, 'net_method_not_allowed');
    assert.equal(evaluate('', 'https://docs.unity3d.com/Manual/x').code, 'net_method_not_allowed');
  });

  it('refuses a body on a read method before anything else about the request', () => {
    const result = evaluate('GET', 'https://docs.unity3d.com/Manual/x', { body: 'payload' });
    assert.equal(result.code, 'net_body_on_read');
  });

  it('refuses DELETE off the machine, and on loopback without destructive', () => {
    assert.equal(evaluate('DELETE', 'https://docs.unity3d.com/Manual/x').reason, 'delete-off-machine');
    const loopbackDelete = buildPolicy({ entries: [{ ...LOOPBACK_DEV_ENTRY, methods: ['GET', 'DELETE'] }] });
    const result = evaluate('DELETE', 'http://127.0.0.1:3000/x', { policy: loopbackDelete });
    assert.equal(result.code, 'net_delete_not_allowed');
    assert.equal(result.reason, 'not-destructive');
  });

  it('allows DELETE on loopback when the entry is marked destructive', () => {
    const policy = buildPolicy({ entries: [{ ...LOOPBACK_DEV_ENTRY, methods: ['GET', 'DELETE'], destructive: true }] });
    assert.equal(evaluate('DELETE', 'http://127.0.0.1:3000/x', { policy }).ok, true);
  });

  it('accepts every loopback spelling the entry declares', () => {
    for (const origin of ['http://127.0.0.1:3000', 'http://localhost:3000', 'https://127.0.0.1:3000', 'http://[::1]:3000']) {
      assert.equal(evaluate('GET', `${origin}/health`).ok, true, origin);
    }
  });
});

describe('net/policy: budget, query keys and the project gates', () => {
  it('spends the entry budget and refuses an oversized path', () => {
    const long = `/Manual/${'a'.repeat(600)}`;
    const result = evaluate('GET', `https://docs.unity3d.com${long}`);
    assert.equal(result.code, 'net_budget_exceeded');
    assert.equal(result.detail?.field, 'path');
  });

  it('refuses a denied query key whatever its value looks like', () => {
    for (const key of ['token', 'API_KEY', 'authorization', 'password']) {
      const result = evaluate('GET', `https://docs.unity3d.com/Manual/x?${key}=anything`);
      assert.equal(result.code, 'net_credential_in_url', key);
      assert.equal(result.reason, 'denied-query-key');
    }
  });

  it('refuses a credential-shaped value under an innocent key, using the shared detector', () => {
    const credentialDetector = (value) => value.startsWith('ghp_');
    const result = evaluate('GET', 'https://docs.unity3d.com/Manual/x?q=ghp_0123456789', { credentialDetector });
    assert.equal(result.code, 'net_credential_in_url');
    assert.equal(result.reason, 'credential-shaped-value');
    assert.equal(evaluate('GET', 'https://docs.unity3d.com/Manual/x?q=gc', { credentialDetector }).ok, true);
  });

  it('uses the shared detector when the caller passes none, so a forgotten argument still refuses', () => {
    // Built at run time: a token-shaped literal in a test file is exactly what the hygiene scan hunts.
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    const refused = evaluatePolicy({ policy: STANDARD, method: 'GET', url: `https://docs.unity3d.com/Manual/x?q=${token}` });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.reason, 'credential-shaped-value');
    assert.equal(evaluatePolicy({ policy: STANDARD, method: 'GET', url: 'https://docs.unity3d.com/Manual/x?q=MonoBehaviour' }).ok, true);
  });

  it('reads the denied query keys from the shared detector, not from a second list', () => {
    assert.equal(DEFAULT_DENIED_QUERY_KEYS, SENSITIVE_KEYS);
  });

  it('refuses a live project segment on any loopback request, whatever entry matched', () => {
    const policy = buildPolicy({ deniedProjectSegments: ['live-app'] });
    const result = evaluate('GET', 'http://127.0.0.1:3000/live-app/status', { policy });
    assert.equal(result.code, 'net_firebase_project_is_live');
    assert.equal(evaluate('GET', 'http://127.0.0.1:3000/other/status', { policy }).ok, true);
  });

  it('does not apply the project segment list off the machine', () => {
    const policy = buildPolicy({ deniedProjectSegments: ['manual'] });
    assert.equal(evaluate('GET', 'https://docs.unity3d.com/Manual/x', { policy }).ok, true);
  });
});

describe('net/policy: the redirect decision', () => {
  it('returns the full target when it re-passes the whole policy', () => {
    const result = evaluateRedirectTarget({
      policy: STANDARD,
      location: '/Manual/current/Profiler.html',
      base: 'https://docs.unity3d.com/Manual/old.html',
      method: 'GET',
    });
    assert.deepEqual(result, {
      allowed: true,
      url: 'https://docs.unity3d.com/Manual/current/Profiler.html',
      host: 'docs.unity3d.com',
      port: 443,
      code: null,
      reason: null,
    });
  });

  it('names the host and the failing code, and hands back no path, when it does not', () => {
    const result = evaluateRedirectTarget({
      policy: STANDARD,
      location: 'https://evil.test/collect?data=1',
      base: 'https://docs.unity3d.com/Manual/old.html',
      method: 'GET',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.url, null, 'a denied target hands back no path');
    assert.equal(result.host, 'evil.test');
    assert.equal(result.code, 'net_host_not_allowed');
  });

  it('refuses a Location that does not parse', () => {
    const result = evaluateRedirectTarget({ policy: STANDARD, location: 'http://', base: 'https://docs.unity3d.com/x', method: 'GET' });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'net_url_invalid');
  });
});

describe('net/policy: the render-time entry rules', () => {
  /** @param {object} entry @param {object} [context] */
  const check = (entry, context) => validateEntry(entry, { reservedPorts: resolveReservedPorts(), ...context });

  it('accepts the shipped entries as they stand', () => {
    for (const entry of [...SHIPPED_HOST_ENTRIES, LOOPBACK_DEV_ENTRY, FUNCTIONS_ENTRY]) {
      assert.equal(check(entry).ok, true, entry.id);
    }
  });

  it('refuses a reserved port, an insecure scheme and a wildcard port off the machine', () => {
    assert.equal(check({ ...FUNCTIONS_ENTRY, ports: [4400] }).code, 'network_entry_port_reserved');
    assert.equal(check({ ...SHIPPED_HOST_ENTRIES[0], scheme: 'http' }).code, 'network_entry_insecure_scheme');
    assert.equal(check({ ...SHIPPED_HOST_ENTRIES[0], ports: '*' }).code, 'network_entry_port_reserved');
  });

  it('refuses an off-machine write without a consent id and the experimental flag', () => {
    const entry = { ...SHIPPED_HOST_ENTRIES[0], id: 'api', shipped: false, methods: ['GET', 'POST'] };
    assert.equal(check(entry).code, 'network_entry_write_not_loopback');
    assert.equal(check({ ...entry, consentId: 'c-1' }).code, 'network_entry_write_not_loopback', 'a grant alone is not enough');
    assert.equal(check({ ...entry, consentId: 'c-1' }, { experimental: true, consentIds: ['c-1'] }).ok, true);
  });

  it('refuses DELETE off the machine and without destructive, in every profile', () => {
    assert.equal(check({ ...SHIPPED_HOST_ENTRIES[0], methods: ['DELETE'] }).code, 'network_entry_delete_not_allowed');
    assert.equal(check({ ...FUNCTIONS_ENTRY, methods: ['DELETE'] }).code, 'network_entry_delete_not_allowed');
    assert.equal(check({ ...FUNCTIONS_ENTRY, methods: ['DELETE'], destructive: true }).ok, true);
  });

  it('keeps headers, an emulator and a trust anchor on loopback only', () => {
    assert.equal(check({ ...SHIPPED_HOST_ENTRIES[0], headers: { 'X-Test': 'value' } }).code, 'network_entry_headers_not_loopback');
    assert.equal(check({ ...SHIPPED_HOST_ENTRIES[0], firebaseEmulator: 'functions' }).code, 'network_entry_emulator_not_loopback');
    assert.equal(check({ ...SHIPPED_HOST_ENTRIES[0], caFile: 'certs/local.pem' }).code, 'network_entry_ca_not_loopback');
    assert.equal(check({ ...FUNCTIONS_ENTRY, caFile: 'certs/local.pem' }).ok, true);
  });

  it('refuses a header value the shared detector calls a secret', () => {
    const looksLikeSecret = (value) => value.includes('eyJ');
    const entry = { ...FUNCTIONS_ENTRY, headers: { Authorization: 'Bearer eyJhbGciOi' } };
    assert.equal(check(entry, { looksLikeSecret }).code, 'network_entry_header_looks_like_secret');
    assert.equal(check({ ...FUNCTIONS_ENTRY, headers: { Authorization: 'Bearer owner' } }, { looksLikeSecret }).ok, true);
  });

  it('applies the shared credential detector when the caller passes none (DN12)', () => {
    const token = ['ghp', '0123456789abcdefghijklmnopqrstuvwxyzAB'].join('_');
    const entry = { ...FUNCTIONS_ENTRY, headers: { Authorization: `Bearer ${token}` } };
    assert.equal(validateEntry(entry, {}).code, 'network_entry_header_looks_like_secret');
    assert.equal(validateEntry({ ...FUNCTIONS_ENTRY, headers: { Authorization: 'Bearer owner' } }, {}).ok, true);
  });

  it('refuses an unconditional reserved port when the caller passes no table', () => {
    for (const port of [4400, 2375, 2376]) {
      assert.equal(validateEntry({ ...FUNCTIONS_ENTRY, ports: [port] }).code, 'network_entry_port_reserved', String(port));
    }
  });

  it('derives loopback from the host and refuses an entry that claims otherwise (35.7, DN6)', () => {
    const publicClaimingLoopback = {
      id: 'team-api', host: 'api.example.com', ports: [80], scheme: 'http', methods: ['GET', 'POST', 'DELETE'],
      pathPrefix: ['/'], loopback: true, destructive: true, headers: { 'X-Team': '1' },
    };
    const refused = check(publicClaimingLoopback, { consentIds: [] });
    assert.equal(refused.code, 'network_entry_host_invalid');
    assert.match(/** @type {string} */ (refused.reason), /loopback/);
    assert.equal(check({ ...SHIPPED_HOST_ENTRIES[0], hostKind: 'suffix', host: '*.unity3d.com', loopback: true }).code, 'network_entry_host_invalid');
    assert.equal(check({ ...FUNCTIONS_ENTRY, hostKind: 'exact', loopback: false }).code, 'network_entry_host_invalid');

    const normalized = normalizeNetworkPolicy({ enabled: true, entries: [publicClaimingLoopback], reservedPorts: resolveReservedPorts() });
    assert.equal(normalized.ok, false, 'the runtime policy cannot carry the mismatch either');
    assert.equal(evaluate('DELETE', 'http://api.example.com/users/1', { policy: normalized.policy }).ok, false);

    const { loopback: _flag, ...unflagged } = FUNCTIONS_ENTRY;
    const derived = normalizeNetworkPolicy({ enabled: true, entries: [{ ...unflagged, hostKind: 'exact', host: 'localhost' }], reservedPorts: [] });
    assert.equal(derived.policy.entries[0].loopback, true, 'an exact loopback host is loopback without saying so');
  });

  it('refuses any spelling of turning certificate validation off', () => {
    for (const key of ['rejectUnauthorized', 'insecure', 'strictSSL']) {
      assert.equal(check({ ...FUNCTIONS_ENTRY, [key]: false }).code, 'network_entry_ca_invalid', key);
    }
  });

  it('requires a ledger-backed consent id for a non-loopback entry nobody shipped', () => {
    const entry = { ...SHIPPED_HOST_ENTRIES[0], id: 'granted', shipped: false };
    assert.equal(check(entry).code, 'network_entry_no_consent');
    assert.equal(check({ ...entry, consentId: 'c-1' }, { consentIds: [] }).code, 'network_entry_no_consent');
    assert.equal(check({ ...entry, consentId: 'c-1' }, { consentIds: ['c-1'] }).ok, true);
  });

  it('refuses a host that is not already ASCII', () => {
    const host = `d${String.fromCodePoint(0x043e)}cs.unity3d.com`;
    assert.equal(check({ ...SHIPPED_HOST_ENTRIES[0], host }).code, 'network_entry_host_not_ascii');
  });
});

describe('net/policy: the policy hash', () => {
  it('is stable across key order and array-independent formatting', () => {
    const reordered = { ...STANDARD, entries: STANDARD.entries.map((entry) => ({ ...entry })) };
    assert.equal(hashPolicy(reordered), hashPolicy(STANDARD));
    assert.match(hashPolicy(STANDARD), /^sha256:[0-9a-f]{64}$/);
  });

  it('ignores the recorded hash itself, so a rendered policy verifies against its own value', () => {
    assert.equal(policyHashMatches(STANDARD, STANDARD.policyHash), true);
  });

  it('changes when anything in the policy changes', () => {
    const widened = buildPolicy({ entries: [...SHIPPED_HOST_ENTRIES, { ...LOOPBACK_DEV_ENTRY, methods: ['GET', 'HEAD', 'POST'] }] });
    assert.notEqual(hashPolicy(widened), hashPolicy(STANDARD));
    assert.equal(policyHashMatches(widened, STANDARD.policyHash), false, 'drift is what exit 4 is for');
    assert.equal(policyHashMatches(STANDARD, ''), false);
    assert.equal(policyHashMatches(STANDARD, null), false);
  });
});
