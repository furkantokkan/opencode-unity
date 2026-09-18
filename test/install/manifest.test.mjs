// The install manifest (spec 14.2): its schema, identity rules, and the read/write path.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import {
  MANIFEST_KIND_SPECS,
  compareVersions,
  createManifest,
  createdBy,
  describeEntry,
  entriesOfKind,
  entryIdentity,
  findEntry,
  getKindSpec,
  loadManifest,
  needsUpgrade,
  parseManifest,
  readManifestSchema,
  removeEntries,
  saveManifest,
  toTimestamp,
  upsertEntry,
  validateManifest,
} from '../../src/install/manifest.js';
import { catchAsync, catchError } from '../helpers/catch-error.mjs';
import { useSandbox } from '../helpers/sandbox.mjs';

const SHA = 'a'.repeat(64);
const BY = 'setup@0.1.0';
const FIXED_NOW = () => new Date('2026-09-18T10:00:00.123Z');

/** One valid entry of every kind the schema knows. */
const ENTRIES = Object.freeze([
  { kind: 'file', path: '/home/user/.local/share/opencode-unity/config.json', sha256: SHA, createdBy: BY },
  { kind: 'dir', path: '/home/user/.local/share/opencode-unity/xdg-config', createdBy: BY },
  { kind: 'userEnv', name: 'OLLAMA_KV_CACHE_TYPE', value: 'q8_0', previous: null, createdBy: BY },
  { kind: 'launchctlEnv', name: 'OLLAMA_FLASH_ATTENTION', value: '1', previous: '0', createdBy: BY },
  { kind: 'ollamaModel', name: 'ocu-qwen3-coder-30b-16k', pulledBySetup: false, derived: true, baseModel: 'qwen3-coder:30b', createdBy: BY },
  { kind: 'wtFragment', path: 'C:\\Users\\user\\AppData\\Local\\Microsoft\\Windows Terminal\\Fragments\\opencode-unity\\profiles.json', sha256: SHA, createdBy: BY },
  { kind: 'skillCopy', target: 'claude', path: '/home/user/.claude/skills/opencode-unity-delegate/SKILL.md', sha256: SHA, createdBy: BY },
  { kind: 'npmGlobal', name: 'opencode-ai', version: '1.18.31', createdBy: BY },
  { kind: 'projectDir', path: '/work/Game/.opencode-unity', sha256Tree: SHA, createdBy: 'init@0.1.0' },
]);

describe('manifest schema', () => {
  it('accepts one entry of every kind', () => {
    const manifest = { schemaVersion: 1, cliVersion: '0.1.0', installedAt: '2026-09-18T10:00:00Z', entries: [...ENTRIES] };
    assert.deepEqual(validateManifest(manifest), []);
  });

  it('knows exactly the kinds the kind table knows', () => {
    const schemaKinds = readManifestSchema().$defs.entry.properties.kind.enum;
    assert.deepEqual([...schemaKinds].sort(), MANIFEST_KIND_SPECS.map((spec) => spec.kind).sort());
  });

  it('rejects an unknown kind instead of ignoring it', () => {
    const errors = validateManifest({ schemaVersion: 1, cliVersion: '0.1.0', entries: [{ kind: 'registryKey', path: 'HKCU', createdBy: BY }] });
    assert.ok(errors.some((error) => error.path === 'entries[0].kind'), JSON.stringify(errors));
  });

  it('rejects an entry without the hash uninstall needs', () => {
    const errors = validateManifest({ schemaVersion: 1, cliVersion: '0.1.0', entries: [{ kind: 'file', path: '/x/y', createdBy: BY }] });
    assert.ok(errors.length > 0);
  });

  it('rejects a key the kind does not have', () => {
    const errors = validateManifest({ schemaVersion: 1, cliVersion: '0.1.0', entries: [{ kind: 'dir', path: '/x/y', sha256: SHA, createdBy: BY }] });
    assert.ok(errors.length > 0);
  });

  it('rejects an unknown top-level key and a wrong schema version', () => {
    assert.ok(validateManifest({ schemaVersion: 2, cliVersion: '0.1.0', entries: [] }).length > 0);
    assert.ok(validateManifest({ schemaVersion: 1, cliVersion: '0.1.0', entries: [], extra: true }).length > 0);
  });

  it('requires createdBy to name the command and the version', () => {
    const entry = { kind: 'dir', path: '/x/y', createdBy: 'someone' };
    assert.ok(validateManifest({ schemaVersion: 1, cliVersion: '0.1.0', entries: [entry] }).length > 0);
  });
});

describe('manifest identity', () => {
  it('treats two entries for the same path as the same change', () => {
    const first = { kind: 'file', path: '/a', sha256: SHA, createdBy: BY };
    const second = { kind: 'file', path: '/a', sha256: 'b'.repeat(64), createdBy: 'upgrade@0.2.0' };
    assert.equal(entryIdentity(/** @type {any} */ (first)), entryIdentity(/** @type {any} */ (second)));
  });

  it('keeps kinds apart even when the path is equal', () => {
    assert.notEqual(entryIdentity({ kind: 'file', path: '/a' }), entryIdentity({ kind: 'dir', path: '/a' }));
  });

  it('separates skill copies by target', () => {
    assert.notEqual(entryIdentity({ kind: 'skillCopy', target: 'claude', path: '/a' }), entryIdentity({ kind: 'skillCopy', target: 'codex', path: '/a' }));
  });

  it('upserts instead of appending a duplicate', () => {
    let manifest = createManifest('0.1.0', { now: FIXED_NOW });
    manifest = upsertEntry(manifest, /** @type {any} */ ({ kind: 'file', path: '/a', sha256: SHA, createdBy: BY }));
    manifest = upsertEntry(manifest, /** @type {any} */ ({ kind: 'file', path: '/a', sha256: 'b'.repeat(64), createdBy: BY }));
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].sha256, 'b'.repeat(64));
  });

  it('does not mutate the manifest it was given', () => {
    const manifest = createManifest('0.1.0', { now: FIXED_NOW });
    upsertEntry(manifest, /** @type {any} */ ({ kind: 'dir', path: '/a', createdBy: BY }));
    assert.deepEqual(manifest.entries, []);
  });

  it('finds and removes by identity', () => {
    let manifest = createManifest('0.1.0', { now: FIXED_NOW });
    for (const entry of ENTRIES) manifest = upsertEntry(manifest, /** @type {any} */ (entry));
    assert.equal(findEntry(manifest, { kind: 'npmGlobal', name: 'opencode-ai' })?.version, '1.18.31');
    const trimmed = removeEntries(manifest, [entryIdentity({ kind: 'npmGlobal', name: 'opencode-ai' })]);
    assert.equal(trimmed.entries.length, ENTRIES.length - 1);
    assert.deepEqual(entriesOfKind(trimmed, 'npmGlobal'), []);
  });

  it('describes every kind in one line', () => {
    for (const entry of ENTRIES) assert.doesNotMatch(describeEntry(/** @type {any} */ (entry)), /\n|undefined/);
  });

  it('refuses an unknown kind loudly', () => {
    assert.throws(() => getKindSpec(/** @type {any} */ ('registryKey')), /Unknown manifest kind/);
  });

  it('names the command and version in createdBy', () => {
    assert.equal(createdBy('upgrade', '0.2.0'), 'upgrade@0.2.0');
  });
});

describe('manifest file', () => {
  it('reports a missing file as no manifest', async (t) => {
    const sandbox = await useSandbox(t, 'manifest');
    const { manifest } = await loadManifest(sandbox.path('state', 'install-manifest.json'));
    assert.equal(manifest, null);
  });

  it('writes, then reads back, the same manifest', async (t) => {
    const sandbox = await useSandbox(t, 'manifest');
    const target = sandbox.path('state', 'install-manifest.json');
    let manifest = createManifest('0.1.0', { now: FIXED_NOW });
    for (const entry of ENTRIES) manifest = upsertEntry(manifest, /** @type {any} */ (entry));

    await saveManifest(target, manifest, { now: FIXED_NOW });
    const loaded = await loadManifest(target);

    assert.deepEqual(loaded.manifest, { ...manifest, updatedAt: '2026-09-18T10:00:00Z' });
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['install-manifest.json']);
  });

  it('refuses to write an invalid manifest', async (t) => {
    const sandbox = await useSandbox(t, 'manifest');
    const target = sandbox.path('state', 'install-manifest.json');
    const error = await catchAsync(() => saveManifest(target, /** @type {any} */ ({ schemaVersion: 1, cliVersion: '0.1.0', entries: [{ kind: 'file' }] })));
    assert.equal(error.code, 'manifest_invalid');
    await assert.rejects(fs.access(target));
  });

  it('exits 4 on a manifest that does not parse, and says nothing was removed', () => {
    const error = catchError(() => parseManifest('{ not json'));
    assert.equal(error.exitCode, EXIT.VALIDATION);
    assert.equal(error.code, 'manifest_invalid');
    assert.match(error.hint, /nothing is removed/);
  });

  it('exits 4 on a manifest that does not validate', () => {
    const error = catchError(() => parseManifest(JSON.stringify({ schemaVersion: 1, cliVersion: '0.1.0', entries: [{ kind: 'nope' }] })));
    assert.equal(error.exitCode, EXIT.VALIDATION);
  });

  it('reports an unreadable manifest as a runtime error', async () => {
    const error = await catchAsync(() =>
      loadManifest('/x', {
        readFile: async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      }),
    );
    assert.equal(error.exitCode, EXIT.RUNTIME);
    assert.equal(error.code, 'manifest_unreadable');
  });

  it('writes timestamps to the second, in UTC', () => {
    assert.equal(toTimestamp(new Date('2026-01-02T03:04:05.999Z')), '2026-01-02T03:04:05Z');
  });
});

describe('manifest versions', () => {
  it('orders versions numerically, not as text', () => {
    assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
    assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
    assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  });

  it('ranks a release above its own pre-releases', () => {
    assert.equal(compareVersions('0.1.0', '0.1.0-rc.1'), 1);
    assert.equal(compareVersions('0.1.0-rc.1', '0.1.0'), -1);
    assert.equal(compareVersions('0.1.0-rc.2', '0.1.0-rc.1'), 1);
  });

  it('asks for an upgrade only when the manifest is older than the package', () => {
    assert.equal(needsUpgrade(null, '0.1.0'), false);
    assert.equal(needsUpgrade(createManifest('0.1.0'), '0.1.0'), false);
    assert.equal(needsUpgrade(createManifest('0.0.9'), '0.1.0'), true);
    assert.equal(needsUpgrade(createManifest('0.2.0'), '0.1.0'), false);
  });
});
