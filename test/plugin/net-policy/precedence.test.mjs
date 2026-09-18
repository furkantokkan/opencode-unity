// `DN25` and `D-M24`: every matching entry applies and the narrowest wins.
//
// This is the regression suite for the failure the reviewers found. In the first revision
// `loopback-dev` carried `POST`, `PUT` and `PATCH`, an unbounded path and a 32 KiB body, and it
// matched every non-reserved loopback port — while step 6 said only "match an entry" and defined no
// tie-break. Under any first-match reading that blanket entry was the one picked for every loopback
// request, so every narrower loopback rule in the design was unreachable: the Firebase `demo-` gate,
// the per-emulator method table, the read-only generated entries and `--allow-local-writes` alike.
// `POST http://127.0.0.1:5001/<live-project-id>/us-central1/<fn>` reached an emulator that may be
// running with production credentials.
//
// Two properties have to hold, and both are tested here. A permissive entry can never *widen* what a
// narrower matching entry allows, and a gate any matching entry declares always runs. The render's
// job is the third: entries must be disjoint, so that a derived write entry is reachable at all.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluatePolicy, findEntryOverlaps, intersectEntries, resolveReservedPorts } from '../../../plugin/opencode-unity-lib/net/policy.js';
import { FUNCTIONS_ENTRY, LOOPBACK_DEV_ENTRY, buildPolicy } from './shipped-policy.mjs';

/** The shipped `standard` policy plus a derived Cloud Functions entry, on the same port as the blanket. */
const OVERLAPPING = buildPolicy({ derived: [FUNCTIONS_ENTRY], disjoint: false });

/** The same policy after the render carved the derived port out of the blanket entry. */
const DISJOINT = buildPolicy({ derived: [FUNCTIONS_ENTRY], disjoint: true });

/**
 * @param {string} method
 * @param {string} url
 * @param {{ policy?: object, body?: string }} [options]
 */
function evaluate(method, url, { policy = DISJOINT, body } = {}) {
  return evaluatePolicy({ policy, method, url, body });
}

describe('loopback is read-only by default (D-M24)', () => {
  it('reads a dev server on any loopback port', () => {
    const result = evaluate('GET', 'http://127.0.0.1:3000/api/health');
    assert.equal(result.ok, true);
    assert.deepEqual(result.entryIds, ['loopback-dev']);
  });

  it('refuses every write method the blanket entry used to carry', () => {
    for (const method of ['POST', 'PUT', 'PATCH']) {
      const result = evaluate(method, 'http://127.0.0.1:3000/x', { body: '{}' });
      assert.equal(result.ok, false, method);
      assert.equal(result.code, 'net_method_not_allowed', method);
    }
  });

  it('carries a zero request body, so no request body reaches a port nobody derived', () => {
    const readOnly = buildPolicy({ entries: [LOOPBACK_DEV_ENTRY] });
    const entry = readOnly.entries[0];
    assert.equal(entry.budget.maxRequestBodyBytes, 0);
    assert.equal(entry.budget.maxPathChars, 2048);
    assert.equal(entry.budget.maxQueryChars, 1024);
  });

  it('spends the outbound budget on loopback too (DN26)', () => {
    const result = evaluate('GET', `http://127.0.0.1:3000/${'a'.repeat(3000)}`);
    assert.equal(result.code, 'net_budget_exceeded');
    assert.equal(result.detail?.field, 'path');
  });
});

describe('a permissive entry cannot swallow a narrower one', () => {
  it('runs the demo gate although the blanket entry also matched', () => {
    // The whole failure, in one call: under first match this reached the emulator.
    const result = evaluatePolicy({ policy: OVERLAPPING, method: 'GET', url: 'http://127.0.0.1:5001/live-app/us-central1/sendMail' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'net_firebase_project_not_demo');
  });

  it('refuses the write the narrow entry carries while a read-only entry also matches', () => {
    const result = evaluatePolicy({ policy: OVERLAPPING, method: 'POST', url: 'http://127.0.0.1:5001/demo-app/us-central1/fn', body: '{}' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'net_method_not_allowed');
    assert.deepEqual(result.detail?.allowed, ['GET'], 'the intersection, not the more generous member');
  });

  it('takes the smallest budget of every matching entry', () => {
    const result = evaluatePolicy({ policy: OVERLAPPING, method: 'GET', url: 'http://127.0.0.1:5001/demo-app/us-central1/fn' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.entryIds, ['loopback-dev', 'firebase-functions']);
    assert.equal(result.budget.maxRequestBodyBytes, 0, 'the read-only member wins the body cap');
  });

  it('does not widen a narrow entry when a fully permissive one is added', () => {
    const wide = {
      id: 'user-wide', host: '127.0.0.1', hostKind: 'loopback', ports: '*', scheme: '*',
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], pathPrefix: ['/'], loopback: true,
      destructive: true, budget: { maxPathChars: 65536, maxQueryChars: 65536, maxRequestBodyBytes: 65536 },
    };
    const policy = buildPolicy({ entries: [FUNCTIONS_ENTRY, wide] });

    const write = evaluatePolicy({ policy, method: 'POST', url: 'http://127.0.0.1:5001/demo-app/us-central1/fn', body: '{}' });
    assert.equal(write.ok, true, 'the narrow entry still allows its own method');
    assert.equal(write.budget.maxRequestBodyBytes, 8192, 'and not the permissive 64 KiB');

    const gated = evaluatePolicy({ policy, method: 'POST', url: 'http://127.0.0.1:5001/live-app/us-central1/fn', body: '{}' });
    assert.equal(gated.code, 'net_firebase_project_not_demo', 'the gate survives the company it keeps');

    const removed = evaluatePolicy({ policy, method: 'DELETE', url: 'http://127.0.0.1:5001/demo-app/data' });
    assert.equal(removed.code, 'net_delete_not_allowed', 'destructive has to hold on every member');

    const elsewhere = evaluatePolicy({ policy, method: 'PUT', url: 'http://127.0.0.1:9999/x', body: '{}' });
    assert.equal(elsewhere.ok, true, 'on a port the narrow entry does not claim, the wide entry stands alone');
  });

  it('still refuses a reserved port on a policy whose entries match every port', () => {
    for (const port of [11434, 4400, 2375, 2376]) {
      const result = evaluate('GET', `http://127.0.0.1:${port}/x`, { policy: OVERLAPPING });
      assert.equal(result.code, 'net_reserved_port', String(port));
    }
  });

  it('is indifferent to the order the entries were written in', () => {
    const forward = buildPolicy({ entries: [LOOPBACK_DEV_ENTRY, FUNCTIONS_ENTRY] });
    const reversed = buildPolicy({ entries: [FUNCTIONS_ENTRY, LOOPBACK_DEV_ENTRY] });
    for (const policy of [forward, reversed]) {
      assert.equal(evaluatePolicy({ policy, method: 'POST', url: 'http://127.0.0.1:5001/demo-app/fn', body: '{}' }).code, 'net_method_not_allowed');
      assert.equal(evaluatePolicy({ policy, method: 'GET', url: 'http://127.0.0.1:5001/live-app/fn' }).code, 'net_firebase_project_not_demo');
    }
  });
});

describe('disjoint entries are what make a derived write reachable', () => {
  it('reports the overlap so the render can refuse it', () => {
    assert.deepEqual(findEntryOverlaps(OVERLAPPING.entries), [{ a: 'loopback-dev', b: 'firebase-functions' }]);
    assert.deepEqual(findEntryOverlaps(DISJOINT.entries), [], 'the derived port is carved out of the blanket');
  });

  it('does not call two entries on different hosts, ports, schemes or paths an overlap', () => {
    const base = { id: 'a', host: 'docs.unity3d.com', hostKind: 'exact', ports: [443], scheme: 'https', methods: ['GET'], pathPrefix: ['/'], loopback: false, shipped: true };
    const variants = [
      { ...base, id: 'b', host: 'api.nuget.org' },
      { ...base, id: 'b', ports: [8443] },
      { ...base, id: 'b', scheme: 'http' },
      { ...base, id: 'b', pathPrefix: ['/Manual/'], host: 'api.nuget.org' },
    ];
    for (const other of variants) assert.deepEqual(findEntryOverlaps([base, other]), [], JSON.stringify(other));
    assert.deepEqual(findEntryOverlaps([base, { ...base, id: 'b', pathPrefix: ['/Manual/'] }]), [{ a: 'a', b: 'b' }], 'one prefix inside the other');
    const narrow = { ...base, id: 'a', pathPrefix: ['/v3/'] };
    assert.deepEqual(findEntryOverlaps([narrow, { ...narrow, id: 'b', pathPrefix: ['/v3/index/'] }]), [{ a: 'a', b: 'b' }], 'neither prefix is the root');
    assert.deepEqual(findEntryOverlaps([narrow, { ...narrow, id: 'b', pathPrefix: ['/v3x/'] }]), [], 'a prefix is not a substring');
  });

  it('treats two blanket loopback entries as overlapping, whatever they exclude', () => {
    const wide = { ...LOOPBACK_DEV_ENTRY, id: 'user-loopback', shipped: false, excludePorts: [5001] };
    assert.deepEqual(findEntryOverlaps([LOOPBACK_DEV_ENTRY, wide]), [{ a: 'loopback-dev', b: 'user-loopback' }]);
  });

  it('calls a suffix entry and the host it covers an overlap', () => {
    const suffix = { id: 'suffix', host: '*.example.com', hostKind: 'suffix', ports: [443], scheme: 'https', methods: ['GET'], pathPrefix: ['/'], loopback: false, shipped: true, consentId: 'c-1' };
    const exact = { ...suffix, id: 'exact', host: 'a.example.com', hostKind: 'exact' };
    const outside = { ...suffix, id: 'outside', host: 'example.com', hostKind: 'exact' };
    assert.deepEqual(findEntryOverlaps([suffix, exact]), [{ a: 'suffix', b: 'exact' }]);
    assert.deepEqual(findEntryOverlaps([suffix, outside]), []);
  });

  it('lets the Cloud Functions emulator answer a demo project, exactly once (C48)', () => {
    const result = evaluate('POST', 'http://127.0.0.1:5001/demo-app/us-central1/sendMail', { body: '{"data":{}}' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.entryIds, ['firebase-functions'], 'the blanket entry no longer matches this port');
    assert.equal(result.budget.maxRequestBodyBytes, 8192);
  });

  it('refuses the same call against a project id that is not a demo project (C48)', () => {
    for (const id of ['live-app', 'demo', 'Demo-App', 'demo_app', '']) {
      const result = evaluate('POST', `http://127.0.0.1:5001/${id}/us-central1/sendMail`, { body: '{}' });
      assert.equal(result.ok, false, id);
      assert.equal(result.code, 'net_firebase_project_not_demo', id);
    }
  });

  it('refuses a write on a loopback port nobody derived (C48)', () => {
    assert.equal(evaluate('PUT', 'http://127.0.0.1:3000/x', { body: '{}' }).code, 'net_method_not_allowed');
  });

  it('refuses a live alias segment on any loopback entry, demo-shaped or not (S-BM-9)', () => {
    const policy = buildPolicy({ derived: [FUNCTIONS_ENTRY], disjoint: true, deniedProjectSegments: ['demo-old', 'live-app'] });
    const throughBlanket = evaluatePolicy({ policy, method: 'GET', url: 'http://127.0.0.1:3000/live-app/status' });
    assert.equal(throughBlanket.code, 'net_firebase_project_is_live');
    const throughDerived = evaluatePolicy({ policy, method: 'POST', url: 'http://127.0.0.1:5001/demo-old/us-central1/fn', body: '{}' });
    assert.equal(throughDerived.code, 'net_firebase_project_is_live', 'the demo prefix is not a pass for a live alias key');
  });
});

describe('the intersection, on its own', () => {
  it('is empty-handed about an empty set rather than permissive', () => {
    const result = intersectEntries([]);
    assert.deepEqual(result.methods, []);
    assert.equal(result.destructive, false);
    assert.equal(result.loopback, false);
    assert.equal(result.gates.firebaseFunctions, false);
    assert.deepEqual(intersectEntries(/** @type {any} */ (null)).ids, []);
  });

  it('keeps a gate that only one member declares, and drops a method one member lacks', () => {
    const resolved = buildPolicy({ entries: [LOOPBACK_DEV_ENTRY, FUNCTIONS_ENTRY] }).entries;
    const result = intersectEntries(resolved);
    assert.deepEqual(result.methods, ['GET']);
    assert.equal(result.gates.firebaseFunctions, true);
    assert.equal(result.loopback, true);
    assert.deepEqual(result.ids, ['loopback-dev', 'firebase-functions']);
  });

  it('does not treat a resolved reserved table as part of the entry set', () => {
    // The reserved rows are checked separately for exactly this reason: an entry cannot opt out of
    // them by being narrow, and a narrow entry cannot be made unreachable by one.
    const rows = resolveReservedPorts({ ollamaPort: 11434, unityMcpHubPort: 8080 });
    assert.equal(rows.some((row) => row.port === 8080 && row.conditional), true);
    assert.equal(evaluate('GET', 'http://127.0.0.1:8080/x').ok, true, 'and it is an ordinary port when no hub is configured');
  });
});
