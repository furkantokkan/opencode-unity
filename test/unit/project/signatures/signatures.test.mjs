import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { evidenceRow, listSignatureFileNames, loadSignatures, SIGNATURE_FILE_SUFFIX, signatureRow, signatureRowsFor, validateSignatureFile } from '../../../../src/project/signatures.js';

/**
 * Writes one signature file into a temporary directory and loads it uncached.
 * @param {string} name
 * @param {unknown} content
 */
function loadOne(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocu-signatures-'));
  fs.writeFileSync(path.join(dir, name), JSON.stringify(content), 'utf8');
  try {
    return loadSignatures({ dir: pathToFileURL(`${dir}${path.sep}`), cache: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the shipped signature table', () => {
  const table = loadSignatures();

  it('loads every shipped file and validates it against the schema', () => {
    assert.deepEqual(
      table.files.map((file) => file.id),
      ['db', 'dotnet', 'firebase', 'game-server', 'node'],
    );
    for (const file of table.files) assert.deepEqual(validateSignatureFile(file), [], file.id);
  });

  it('names every file after its id, so the product own tree is never mistaken for a repository it scans', () => {
    assert.deepEqual(listSignatureFileNames(), table.files.map((file) => `${file.id}${SIGNATURE_FILE_SUFFIX}`));
    assert.equal(listSignatureFileNames().includes('firebase.json'), false);
  });

  it('gives every row a unique id inside its own namespace', () => {
    const seen = new Set();
    for (const [id, row] of table.rows) {
      assert.equal(seen.has(id), false, id);
      seen.add(id);
      assert.equal(id, row.id);
      assert.ok(table.files.some((file) => id.startsWith(`${file.id}/`)), id);
    }
    assert.ok(table.rows.size >= 40, `only ${table.rows.size} rows`);
  });

  it('carries the rows discovery asks for by name', () => {
    for (const id of ['node/anchor.package-json', 'dotnet/anchor.web-sdk', 'firebase/overlay.firebase-json', 'db/overlay.prisma-config', 'db/overlay.drizzle-config', 'db/overlay.supabase-config']) {
      assert.equal(signatureRow(id).id, id);
    }
  });

  it('groups rows by the fact they establish', () => {
    const managers = signatureRowsFor('package-manager').map((row) => row.value);
    assert.deepEqual([...new Set(managers)].sort(), ['bun', 'declared', 'npm', 'pnpm', 'yarn']);
    assert.ok(signatureRowsFor('anchor').length >= 2);
  });

  it('refuses an unknown row id instead of silently detecting nothing', () => {
    assert.throws(() => signatureRow('node/anchor.does-not-exist'), /Unknown signature row/);
  });
});

describe('the evidence-row model', () => {
  it('names the signature row and the file behind every fact', () => {
    assert.deepEqual(evidenceRow('anchor', 'node/anchor.package-json', 'functions/package.json'), { fact: 'anchor', signature: 'node/anchor.package-json', file: 'functions/package.json' });
  });

  it('accepts a specification section for a rule this product owns', () => {
    assert.deepEqual(evidenceRow('anchor', 'spec:9.1', 'ProjectSettings/ProjectVersion.txt'), { fact: 'anchor', signature: 'spec:9.1', file: 'ProjectSettings/ProjectVersion.txt' });
  });

  it('refuses a signature id that exists nowhere', () => {
    assert.throws(() => evidenceRow('anchor', 'node/made.up', 'x'), /Unknown signature row/);
    assert.throws(() => evidenceRow('anchor', 'spec-9.1', 'x'), /Unknown signature row/);
  });
});

describe('the loader refuses a malformed file rather than loading part of it', () => {
  const row = { id: 'sample/anchor.one', fact: 'anchor', match: { fileName: 'sample.json' }, claim: 'B1', evidence: 'npm-package-json.html', version: 'npm CLI v11 docs', retrieved: '2026-09-17' };

  it('accepts a well-formed file', () => {
    const table = loadOne(`sample${SIGNATURE_FILE_SUFFIX}`, { schemaVersion: 1, id: 'sample', title: 'Sample', rows: [row] });
    assert.equal(table.rows.size, 1);
  });

  it('refuses a file whose name does not match its id', () => {
    assert.throws(() => loadOne(`other${SIGNATURE_FILE_SUFFIX}`, { schemaVersion: 1, id: 'sample', title: 'Sample', rows: [row] }), /must be named after its id/);
  });

  it('refuses a row from another namespace', () => {
    assert.throws(() => loadOne(`sample${SIGNATURE_FILE_SUFFIX}`, { schemaVersion: 1, id: 'sample', title: 'Sample', rows: [{ ...row, id: 'node/anchor.one' }] }), /does not belong to file/);
  });

  it('refuses a duplicate row id', () => {
    assert.throws(() => loadOne(`sample${SIGNATURE_FILE_SUFFIX}`, { schemaVersion: 1, id: 'sample', title: 'Sample', rows: [row, row] }), /Duplicate signature row/);
  });

  it('refuses a row with no evidence, no version or no retrieval date', () => {
    for (const missing of ['claim', 'evidence', 'version', 'retrieved']) {
      const incomplete = { ...row };
      delete incomplete[missing];
      assert.throws(() => loadOne(`sample${SIGNATURE_FILE_SUFFIX}`, { schemaVersion: 1, id: 'sample', title: 'Sample', rows: [incomplete] }), /is invalid/, missing);
    }
  });

  it('refuses a match key it does not understand, so a schema never looks stricter than it is', () => {
    assert.throws(() => loadOne(`sample${SIGNATURE_FILE_SUFFIX}`, { schemaVersion: 1, id: 'sample', title: 'Sample', rows: [{ ...row, match: { regex: '.*' } }] }), /is invalid/);
  });
});
