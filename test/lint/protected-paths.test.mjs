// Spec 8.5.2's protected-path tables have exactly one home, `plugin/opencode-unity-lib/protected-paths.js`.
// Three boundaries read them - the rendered permission rules, the plugin's shell guard and the workspace
// scanner's read budget - and during milestone 2 two of them had been written out by hand instead, which
// is a security table that can drift without a single test failing. This lint fails the build when a
// glob from either table is spelled anywhere else under src/ or plugin/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PROTECTED_EDIT_GLOBS,
  PROTECTED_READ_ALLOW_GLOB,
  PROTECTED_READ_GLOBS,
} from '../../plugin/opencode-unity-lib/protected-paths.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TABLE_FILE = 'plugin/opencode-unity-lib/protected-paths.js';
const SCANNED_ROOTS = ['src', 'plugin'];
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/**
 * One distinctive glob per table. A whole-list comparison would flag a module that legitimately names
 * `*.unity` for another reason, and these three appear nowhere else in the product.
 * @type {ReadonlyArray<{ table: string, glob: string }>}
 */
const MARKERS = [
  { table: 'PROTECTED_EDIT_GLOBS', glob: '*.spriteatlasv2' },
  { table: 'PROTECTED_READ_GLOBS', glob: '*.git-credentials' },
  { table: 'PROTECTED_READ_ALLOW_GLOB', glob: '*.env.example' },
];

/**
 * @param {string} root  Absolute.
 * @returns {string[]} Repository-relative paths with forward slashes, sorted.
 */
function listFiles(root) {
  /** @type {string[]} */
  const found = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) found.push(path.relative(REPO_ROOT, absolute).split(path.sep).join('/'));
    }
  };
  walk(root);
  return found;
}

const scanned = SCANNED_ROOTS.flatMap((root) => listFiles(path.join(REPO_ROOT, root)));

describe('the protected-path tables have one home', () => {
  it('scans both shipped roots', () => {
    assert.ok(scanned.includes(TABLE_FILE), 'the table module itself must be in the scan');
    assert.ok(scanned.length > 20, `expected the shipped roots to hold more files than ${scanned.length}`);
  });

  it('is the only file that spells a protected glob', () => {
    /** @type {string[]} */
    const findings = [];
    for (const { table, glob } of MARKERS) {
      for (const relativePath of scanned) {
        if (relativePath === TABLE_FILE) continue;
        const text = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
        if (text.includes(`'${glob}'`) || text.includes(`"${glob}"`)) {
          findings.push(`${relativePath} spells ${glob}; import ${table} from ${TABLE_FILE} instead`);
        }
      }
    }
    assert.deepEqual(findings, []);
  });

  it('keeps the markers in the tables they claim to mark', () => {
    assert.ok(PROTECTED_EDIT_GLOBS.includes('*.spriteatlasv2'));
    assert.ok(PROTECTED_READ_GLOBS.includes('*.git-credentials'));
    assert.equal(PROTECTED_READ_ALLOW_GLOB, '*.env.example');
  });

  it('never allows a read the deny list covers, except the one template', () => {
    // `*.env.*` denies the template too, so the allow has to be a real exception rather than a gap.
    assert.ok(PROTECTED_READ_GLOBS.includes('*.env.*'));
    assert.equal(PROTECTED_READ_GLOBS.includes(PROTECTED_READ_ALLOW_GLOB), false);
  });
});
