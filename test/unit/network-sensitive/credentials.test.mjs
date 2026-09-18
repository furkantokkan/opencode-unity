// The credential-shape half of the shared detector (expansion 12.12.3). Every pattern has positive and
// negative fixtures, because a detector nobody can switch off has to be a detector nobody wants to.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { CREDENTIAL_PATTERN_IDS, EMULATOR_BEARER_VALUE, findCredential } from '../../../src/network/sensitive.js';
import { FIXTURES_DIR } from '../../helpers/fixture-fs.mjs';

const SENSITIVE_FIXTURES = path.join(FIXTURES_DIR, 'network', 'sensitive');

/**
 * @param {string} name
 * @returns {any}
 */
function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(SENSITIVE_FIXTURES, name), 'utf8'));
}

/**
 * @param {string} name
 * @returns {string}
 */
function loadText(name) {
  return fs.readFileSync(path.join(SENSITIVE_FIXTURES, name), 'utf8');
}

/** @type {Array<{ id: string, patternId: string, sample: string, note: string }>} */
const POSITIVE = loadJson('credential-positive.json');
/** @type {Array<{ id: string, sample: string, note: string }>} */
const NEGATIVE = loadJson('credential-negative.json');

describe('credential shapes', () => {
  for (const row of POSITIVE) {
    it(`refuses ${row.id}: ${row.note}`, () => {
      const hit = findCredential(row.sample);
      assert.ok(hit, `${row.id} should be a hit`);
      assert.equal(hit.patternId, row.patternId);
    });
  }

  it('covers every declared pattern with at least one positive fixture', () => {
    const covered = new Set(POSITIVE.map((row) => row.patternId));
    assert.deepEqual([...covered].sort(), [...CREDENTIAL_PATTERN_IDS].sort());
  });

  it('gives every fixture a unique id, so a failure names one row', () => {
    const ids = [...POSITIVE, ...NEGATIVE].map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('ordinary Unity and documentation text', () => {
  for (const row of NEGATIVE) {
    it(`lets ${row.id} through: ${row.note}`, () => {
      assert.equal(findCredential(row.sample), null);
    });
  }

  it('lets a .meta body through, guids and all', () => {
    assert.equal(findCredential(loadText('body-unity-meta.txt')), null);
  });

  it('lets a C# body through although it names a key and a secret', () => {
    assert.equal(findCredential(loadText('body-csharp.txt')), null);
  });

  it('lets the one literal Authorization value a loopback emulator entry may carry through', () => {
    assert.equal(findCredential(`Authorization: Bearer ${EMULATOR_BEARER_VALUE}`), null);
  });
});

describe('what a hit carries', () => {
  it('reports the pattern id and an offset, never the matched text', () => {
    for (const row of POSITIVE) {
      const hit = findCredential(row.sample);
      assert.ok(hit);
      assert.deepEqual(Object.keys(hit).sort(), ['index', 'patternId']);
      assert.ok(Number.isInteger(hit.index) && hit.index >= 0);
      assert.ok(!JSON.stringify(hit).includes(row.sample.slice(hit.index, hit.index + 8)));
    }
  });

  it('reports the most specific pattern when several would match', () => {
    // A JWT is also a high-entropy token and sits in a sensitive assignment; the vendor shape wins,
    // because "high entropy" tells a reader nothing about what to remove.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.QUJDREVGR0hJSktMTU5PUFFS';
    assert.equal(findCredential(jwt)?.patternId, 'cred.jwt');
    assert.equal(findCredential(`{"access_token": "${jwt}"}`)?.patternId, 'cred.jwt');
  });

  it('finds a PEM block inside a body the model assembled', () => {
    const hit = findCredential(loadText('body-pem.txt'));
    assert.equal(hit?.patternId, 'cred.pem-block');
  });
});

describe('inputs that are not text', () => {
  it('treats an empty string, a missing value and a non-string as no hit', () => {
    assert.equal(findCredential(''), null);
    assert.equal(findCredential(/** @type {any} */ (undefined)), null);
    assert.equal(findCredential(/** @type {any} */ (null)), null);
    assert.equal(findCredential(/** @type {any} */ (12345)), null);
  });

  it('survives control characters, a lone surrogate and bidi marks', () => {
    // Built by code point: a raw control byte in a source file takes it out of the personal-data scan.
    const hostile = [0x00, 0x1b, 0xd800, 0x202e, 0xfeff].map((code) => String.fromCharCode(code)).join('x');
    assert.equal(findCredential(hostile), null);
    assert.equal(findCredential(`${hostile}AKIAIOSFODNN7EXAMPLE${hostile}`)?.patternId, 'cred.aws-access-key');
  });

  it('scans a body at the loopback cap without backtracking away', () => {
    const body = `${'name=value&'.repeat(3100)}password=notARealPasswordValue`;
    assert.ok(body.length > 32 * 1024);
    assert.equal(findCredential(body)?.patternId, 'cred.assignment');
    assert.equal(findCredential('a'.repeat(40 * 1024)), null);
  });
});
