// Query keys and values (execution step 9) and allow-list header values (expansion 12.7.2).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  SENSITIVE_KEYS,
  findCredentialInHeaders,
  isSensitiveQueryKey,
  scanQuery,
} from '../../../src/network/sensitive.js';
import { FIXTURES_DIR } from '../../helpers/fixture-fs.mjs';

/**
 * @type {{
 *   refused: Array<{ id: string, url: string, reason: string, key: string, patternId?: string, note: string }>,
 *   allowed: Array<{ id: string, url: string, note: string }>,
 * }}
 */
const URLS = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'network', 'sensitive', 'urls.json'), 'utf8'));

describe('sensitive query keys', () => {
  it('matches the spelling the rendered deniedQueryKeys array carries', () => {
    for (const key of SENSITIVE_KEYS) {
      assert.equal(key, key.toLowerCase(), 'the rendered list compares lower case');
      assert.ok(isSensitiveQueryKey(key));
    }
  });

  it('folds case, and only case, for a query key', () => {
    assert.ok(isSensitiveQueryKey('API_KEY'));
    assert.ok(isSensitiveQueryKey('apiKey'));
    assert.ok(!isSensitiveQueryKey('view'));
    assert.ok(!isSensitiveQueryKey('semVerLevel'));
  });
});

describe('scanQuery', () => {
  for (const row of URLS.refused) {
    it(`refuses ${row.id}: ${row.note}`, () => {
      const finding = scanQuery(new URL(row.url).searchParams);
      assert.ok(finding, `${row.id} should be refused`);
      assert.equal(finding.reason, row.reason);
      assert.equal(finding.key, row.key);
      if (row.patternId) assert.equal(/** @type {any} */ (finding).patternId, row.patternId);
    });
  }

  for (const row of URLS.allowed) {
    it(`allows ${row.id}: ${row.note}`, () => {
      assert.equal(scanQuery(new URL(row.url).searchParams), null);
    });
  }

  it('reports the key name and never the value', () => {
    const finding = scanQuery(new URL('https://h.example.test/x?q=AIzaSyExampleNotARealKey00000000000000A').searchParams);
    assert.deepEqual(finding, { reason: 'credential-value', key: 'q', patternId: 'cred.google-api-key' });
  });

  it('takes plain pairs as well as URLSearchParams, because the URL is parsed by the policy', () => {
    assert.equal(scanQuery([['view', 'net-8.0']]), null);
    assert.deepEqual(scanQuery([['cookie', 'x']]), { reason: 'denied-key', key: 'cookie' });
  });

  it('stops at the first finding so the order of refusal is stable', () => {
    const finding = scanQuery([
      ['token', 'short'],
      ['q', 'AKIAIOSFODNN7EXAMPLE'],
    ]);
    assert.deepEqual(finding, { reason: 'denied-key', key: 'token' });
  });
});

describe('findCredentialInHeaders', () => {
  it('passes the emulator owner value a loopback entry needs', () => {
    assert.equal(findCredentialInHeaders({ Authorization: 'Bearer owner' }), null);
  });

  it('refuses a real token in an entry header and names the header, not the value', () => {
    const finding = findCredentialInHeaders({
      'X-Client': 'opencode-unity',
      Authorization: 'Bearer EXAMPLEbearerVALUEnotREALat0all',
    });
    assert.deepEqual(finding, { name: 'Authorization', patternId: 'cred.bearer' });
  });

  it('refuses a credential under an innocent header name', () => {
    const finding = findCredentialInHeaders({ 'X-Trace': 'ghp_EXAMPLEnotAREALtokenVALUE00000000000' });
    assert.deepEqual(finding, { name: 'X-Trace', patternId: 'cred.github-token' });
  });

  it('is null for an empty map', () => {
    assert.equal(findCredentialInHeaders({}), null);
  });
});
