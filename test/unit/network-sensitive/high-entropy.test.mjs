// `cred.high-entropy` and the exclusions that keep it usable (expansion 12.12.3). Every excluded
// fixture is above the threshold: the exclusions are what the rule rests on, not decoration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  HIGH_ENTROPY_EXCLUSIONS,
  HIGH_ENTROPY_MIN_BITS,
  findCredential,
  shannonEntropy,
} from '../../../src/network/sensitive.js';
import { FIXTURES_DIR } from '../../helpers/fixture-fs.mjs';

/** @type {Array<{ id: string, token: string, excludedBy: string | null, note: string }>} */
const TOKENS = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, 'network', 'sensitive', 'high-entropy-tokens.json'), 'utf8'),
);

/**
 * @param {string} token
 * @returns {string | null}
 */
function excludedBy(token) {
  return HIGH_ENTROPY_EXCLUSIONS.find((exclusion) => exclusion.excludes(token))?.id ?? null;
}

describe('shannonEntropy', () => {
  it('is zero for an empty string and for one repeated character', () => {
    assert.equal(shannonEntropy(''), 0);
    assert.equal(shannonEntropy('aaaaaaaa'), 0);
  });

  it('is one bit per character for two equally frequent characters', () => {
    assert.equal(shannonEntropy('abababab'), 1);
  });

  it('is the alphabet size in bits when every character is distinct', () => {
    assert.equal(shannonEntropy('abcd'), 2);
  });
});

describe('high-entropy exclusions', () => {
  for (const row of TOKENS) {
    it(`${row.id} is ${row.excludedBy ?? 'not excluded'}: ${row.note}`, () => {
      assert.equal(excludedBy(row.token), row.excludedBy);
    });
  }

  it('every exclusion is load-bearing: each excluded fixture is above the threshold', () => {
    for (const row of TOKENS.filter((entry) => entry.excludedBy !== null)) {
      assert.ok(
        shannonEntropy(row.token) > HIGH_ENTROPY_MIN_BITS,
        `${row.id} would not need an exclusion if it were below ${HIGH_ENTROPY_MIN_BITS} bits`,
      );
    }
  });

  it('every exclusion has a fixture that names it', () => {
    const named = new Set(TOKENS.map((row) => row.excludedBy).filter((id) => id !== null));
    assert.deepEqual([...named].sort(), HIGH_ENTROPY_EXCLUSIONS.map((exclusion) => exclusion.id).sort());
  });

  it('states a reason for each exclusion, because each one is a hole someone has to be able to check', () => {
    for (const exclusion of HIGH_ENTROPY_EXCLUSIONS) {
      assert.ok(exclusion.reason.length > 20, `${exclusion.id} needs a reason`);
    }
  });
});

describe('cred.high-entropy', () => {
  for (const row of TOKENS) {
    const expected = row.excludedBy === null ? 'cred.high-entropy' : null;
    it(`${row.id} ${expected ? 'is' : 'is not'} a credential`, () => {
      assert.equal(findCredential(row.token)?.patternId ?? null, expected);
    });
  }

  it('needs 32 characters: a shorter generated token is left to the shaped patterns', () => {
    assert.equal(findCredential('hT3kQ9zR1mWpX7vL2bN8cF4jY6sD0gA'), null);
    assert.equal(findCredential('hT3kQ9zR1mWpX7vL2bN8cF4jY6sD0gA5')?.patternId, 'cred.high-entropy');
  });

  it('finds a token embedded in a sentence and reports where it starts', () => {
    const hit = findCredential('the value is hT3kQ9zR1mWpX7vL2bN8cF4jY6sD0gA5 and nothing else');
    assert.equal(hit?.patternId, 'cred.high-entropy');
    assert.equal(hit?.index, 13);
  });
});
