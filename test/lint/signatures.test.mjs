// Only verified names ship (D-B17). A detector table is exactly the place where a plausible-sounding
// library name slips in, so every row has to cite a claim, an evidence file, a version and a retrieval
// date - and the products the design could not verify have to stay out by name.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSignatures, SIGNATURES_DIR_URL } from '../../src/project/signatures.js';

const PROJECT_DIR = fileURLToPath(new URL('../../src/project/', import.meta.url));

/** The backend claims table of the amendment runs B1-B35; S49 resolves these against the document. */
const CLAIM_PATTERN = /^B([1-9]|[12][0-9]|3[0-5])$/;

const EVIDENCE_EXTENSIONS = ['.html', '.json', '.txt', '.md'];

/**
 * Products the design deliberately does not claim anything about, with the reason. A signature that
 * names one of these is a signature written from memory rather than from a fetched source.
 */
const UNVERIFIABLE_PRODUCTS = [
  { pattern: /\bphoton\b/i, label: 'Photon', reason: 'the vendor documentation served a bot-check page to every fetch, and no Unity SDK manifest is published (B33)' },
  { pattern: /\bpun ?2\b/i, label: 'PUN 2', reason: 'part of the same unverified vendor (B33)' },
  { pattern: /\bmultiplay\b/i, label: 'Multiplay', reason: 'the Game Server Hosting documentation chain ends in a redirect to a non-Unity domain, so nothing first-party was retrievable (B34)' },
  { pattern: /\bgame server hosting\b/i, label: 'Game Server Hosting', reason: 'same as Multiplay (B34)' },
];

/**
 * Quoted strings only. A comment explaining why a product is absent is the opposite of a violation;
 * a string literal naming it is the violation.
 * @param {string} text
 * @returns {string[]}
 */
function stringLiterals(text) {
  return [...text.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)].map((match) => match[1] ?? match[2] ?? '');
}

/**
 * @returns {string[]} Every JavaScript module under src/project/.
 */
function projectModules() {
  /** @type {string[]} */
  const found = [];
  /** @param {string} directory */
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) found.push(full);
    }
  };
  walk(PROJECT_DIR);
  return found.sort();
}

describe('every signature row is backed by evidence', () => {
  const table = loadSignatures();

  it('cites a claim from the backend claims table', () => {
    for (const row of table.rows.values()) {
      assert.match(row.claim, CLAIM_PATTERN, `${row.id} cites '${row.claim}'`);
    }
  });

  it('names an evidence file that looks like a fetched document', () => {
    for (const row of table.rows.values()) {
      assert.ok(EVIDENCE_EXTENSIONS.some((extension) => row.evidence.endsWith(extension)), `${row.id} cites '${row.evidence}'`);
      assert.equal(row.evidence.includes('/'), false, `${row.id} evidence must be a file name, not a path`);
    }
  });

  it('records the version and a retrieval date that is a real past date', () => {
    for (const row of table.rows.values()) {
      assert.ok(row.version.trim().length > 0, row.id);
      const retrieved = new Date(`${row.retrieved}T00:00:00Z`);
      assert.equal(Number.isNaN(retrieved.getTime()), false, `${row.id} retrieved '${row.retrieved}'`);
      assert.ok(retrieved.getTime() > Date.UTC(2020, 0, 1), `${row.id} retrieved '${row.retrieved}'`);
    }
  });

  it('uses one retrieval date per file, so a partial refresh is visible as a diff', () => {
    for (const file of table.files) {
      const dates = new Set(file.rows.map((row) => row.retrieved));
      assert.equal(dates.size, 1, `${file.id} mixes retrieval dates: ${[...dates].join(', ')}`);
    }
  });
});

describe('the signature files name no product the design could not verify', () => {
  it('keeps the unverifiable vendors out of every signature file', () => {
    for (const name of fs.readdirSync(SIGNATURES_DIR_URL)) {
      const text = fs.readFileSync(new URL(name, SIGNATURES_DIR_URL), 'utf8');
      for (const product of UNVERIFIABLE_PRODUCTS) {
        assert.equal(product.pattern.test(text), false, `${name} names ${product.label}: ${product.reason}`);
      }
    }
  });

  it('keeps them out of the detector modules, in code rather than in comments', () => {
    for (const module of projectModules()) {
      for (const literal of stringLiterals(fs.readFileSync(module, 'utf8'))) {
        for (const product of UNVERIFIABLE_PRODUCTS) {
          assert.equal(product.pattern.test(literal), false, `${path.relative(PROJECT_DIR, module)} names ${product.label} in a string: ${product.reason}`);
        }
      }
    }
  });

  it('does not accidentally exempt a real package whose name only contains a denied word', () => {
    assert.equal(UNVERIFIABLE_PRODUCTS.some((product) => product.pattern.test('com.unity.multiplayer.playmode')), false);
    assert.equal(UNVERIFIABLE_PRODUCTS.some((product) => product.pattern.test('com.unity.services.multiplayer')), false);
    assert.ok(UNVERIFIABLE_PRODUCTS.some((product) => product.pattern.test('com.exitgames.photon')));
  });
});

describe('every signature id a module quotes resolves', () => {
  it('finds a row for each literal passed to evidenceRow or signatureRow', () => {
    const quoted = new Set();
    for (const module of projectModules()) {
      const text = fs.readFileSync(module, 'utf8');
      for (const match of text.matchAll(/(?:evidenceRow\((?:'[^']*',\s*)|signatureRow\()'([^']+)'/g)) quoted.add(match[1]);
      for (const match of text.matchAll(/signature:\s*'([^']+)'/g)) quoted.add(match[1]);
    }

    assert.ok(quoted.size > 0, 'no signature id was quoted anywhere, so this test proves nothing');
    for (const id of quoted) {
      if (id.startsWith('spec:')) continue;
      assert.ok(table().rows.has(id), `no signature row '${id}'`);
    }
  });

  /** @returns {import('../../src/project/signatures.js').SignatureTable} */
  function table() {
    return loadSignatures();
  }
});
