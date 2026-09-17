import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT } from '../../../src/cli/exit-codes.js';
import { CONFIG_MIGRATIONS, CURRENT_CONFIG_SCHEMA_VERSION, migrateDocument } from '../../../src/core/migrations.js';
import { catchError } from '../../helpers/catch-error.mjs';

// Two made-up steps, so the walk itself is tested without waiting for a real format change.
/** @type {import('../../../src/core/migrations.js').Migration[]} */
const TEST_MIGRATIONS = [
  {
    from: 1,
    summary: 'moved guard.minFreeVramMB to guard.minFreeVramAfterLoadMiB',
    migrate: (document) => {
      const guard = /** @type {any} */ (document.guard ?? {});
      const { minFreeVramMB, ...rest } = guard;
      return { ...document, schemaVersion: 2, guard: { ...rest, minFreeVramAfterLoadMiB: minFreeVramMB ?? 1500 } };
    },
  },
  {
    from: 2,
    summary: 'renamed bashMode allow to allowlist',
    migrate: (document) => {
      const safety = /** @type {any} */ (document.safety ?? {});
      return { ...document, schemaVersion: 3, safety: { ...safety, bashMode: safety.bashMode === 'allow' ? 'allowlist' : safety.bashMode } };
    },
  },
];

describe('migrateDocument (spec 6.2, 22)', () => {
  it('leaves a current document alone but returns a copy', () => {
    const document = { schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION, preset: 'nvidia-24gb-qwen3-coder-30b-16k' };
    const result = migrateDocument(document);
    assert.deepEqual(result.document, document);
    assert.notEqual(result.document, document);
    assert.equal(result.fromVersion, CURRENT_CONFIG_SCHEMA_VERSION);
    assert.deepEqual(result.applied, []);
  });

  it('ships no migration yet, because version 1 is the first released format', () => {
    assert.deepEqual(CONFIG_MIGRATIONS, []);
  });

  it('walks every step in order and reports what it applied', () => {
    const result = migrateDocument({ schemaVersion: 1, guard: { minFreeVramMB: 2000 }, safety: { bashMode: 'allow' } }, { migrations: TEST_MIGRATIONS, currentVersion: 3 });
    assert.equal(result.document.schemaVersion, 3);
    assert.deepEqual(result.document.guard, { minFreeVramAfterLoadMiB: 2000 });
    assert.deepEqual(result.document.safety, { bashMode: 'allowlist' });
    assert.deepEqual(result.applied, [TEST_MIGRATIONS[0].summary, TEST_MIGRATIONS[1].summary]);
    assert.equal(result.fromVersion, 1);
    assert.equal(result.toVersion, 3);
  });

  it('never changes the document it was given', () => {
    const document = { schemaVersion: 1, guard: { minFreeVramMB: 2000 } };
    migrateDocument(document, { migrations: TEST_MIGRATIONS, currentVersion: 3 });
    assert.deepEqual(document, { schemaVersion: 1, guard: { minFreeVramMB: 2000 } });
  });

  it('refuses a document from a newer version instead of guessing', () => {
    const error = catchError(() => migrateDocument({ schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION + 1 }));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.equal(error.code, 'config_too_new');
    assert.match(error.hint, /Update opencode-unity/);
  });

  it('refuses a document without a usable schemaVersion', () => {
    for (const [document, pattern] of [
      [{}, /has no schemaVersion/],
      [{ schemaVersion: 0 }, /positive integer/],
      [{ schemaVersion: '1' }, /positive integer/],
      [[], /must contain a JSON object/],
      [null, /must contain a JSON object/],
    ]) {
      const error = catchError(() => migrateDocument(document));
      assert.equal(error.exitCode, EXIT.USAGE);
      assert.match(error.message, /** @type {RegExp} */ (pattern));
    }
  });

  it('uses the label in its messages', () => {
    assert.match(catchError(() => migrateDocument({}, { label: 'project.json' })).message, /project\.json has no schemaVersion/);
  });

  it('reports a gap in the migration chain as a bug, not as a user error', () => {
    assert.throws(() => migrateDocument({ schemaVersion: 1 }, { migrations: [TEST_MIGRATIONS[1]], currentVersion: 3 }), /No config\.json migration from schemaVersion 1/);
  });

  it('reports a migration that returns the wrong version', () => {
    const broken = [{ from: 1, summary: 'broken', migrate: (/** @type {Record<string, unknown>} */ document) => ({ ...document, schemaVersion: 5 }) }];
    assert.throws(() => migrateDocument({ schemaVersion: 1 }, { migrations: broken, currentVersion: 2 }), /must return schemaVersion 2/);
  });
});
