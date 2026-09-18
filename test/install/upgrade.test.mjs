// The upgrade rules of spec 14.3, one function at a time: which profile file is replaced and which is
// carried over, when an external file is re-rendered, the pointer, rollback, and the model-tag rule.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { sha256Hex } from '../../src/core/hash.js';
import { createManifest, upsertEntry } from '../../src/install/manifest.js';
import {
  describeCompatibility,
  listStaleProjects,
  modelNeedsNewTag,
  parsePointer,
  planExternalFiles,
  planProfileMigration,
  planRollback,
  renderPointer,
} from '../../src/install/upgrade.js';
import { useSandbox } from '../helpers/sandbox.mjs';

const BY = 'setup@0.0.9';

/**
 * @param {import('node:test').TestContext} t
 */
async function createProfiles(t) {
  const sandbox = await useSandbox(t, 'upgrade');
  const previousDir = sandbox.path('profile', '0.0.9');
  const newDir = sandbox.path('profile', '0.1.0');
  await fs.mkdir(path.join(previousDir, 'agents'), { recursive: true });
  return { sandbox, previousDir, newDir };
}

describe('profile migration', () => {
  it('replaces a file that is still ours, carries over one that was edited, and adds a new one', async (t) => {
    const { previousDir, newDir } = await createProfiles(t);
    const ours = path.join(previousDir, 'opencode.jsonc');
    const edited = path.join(previousDir, 'agents', 'unity-code.md');
    await fs.writeFile(ours, 'v1 config', 'utf8');
    await fs.writeFile(edited, 'v1 agent plus my rule', 'utf8');
    let manifest = createManifest('0.0.9');
    manifest = upsertEntry(manifest, { kind: 'file', path: ours, sha256: sha256Hex('v1 config'), createdBy: BY });
    manifest = upsertEntry(manifest, { kind: 'file', path: edited, sha256: sha256Hex('v1 agent'), createdBy: BY });

    const migration = await planProfileMigration({
      previousDir,
      newDir,
      manifest,
      cliVersion: '0.1.0',
      platform: process.platform,
      assets: { 'opencode.jsonc': 'v2 config', 'agents/unity-code.md': 'v2 agent', 'commands/compile.md': 'v2 compile' },
    });

    assert.deepEqual(migration.decisions, [
      { relative: 'opencode.jsonc', action: 'replace' },
      { relative: 'agents/unity-code.md', action: 'carry-over' },
      { relative: 'commands/compile.md', action: 'new' },
    ]);
    const writes = migration.operations.filter((operation) => operation.op === 'writeFile');
    const byPath = Object.fromEntries(writes.map((operation) => [operation.path, Buffer.from(/** @type {any} */ (operation.content)).toString('utf8')]));
    assert.equal(byPath[path.join(newDir, 'opencode.jsonc')], 'v2 config');
    assert.equal(byPath[path.join(newDir, 'agents', 'unity-code.md')], 'v1 agent plus my rule');
    assert.equal(byPath[path.join(newDir, 'agents', 'unity-code.md.ocu-new')], 'v2 agent');
    assert.match(migration.notices[0], /agents\/unity-code\.md was edited/);
  });

  it('carries over a file the manifest never recorded', async (t) => {
    const { previousDir, newDir } = await createProfiles(t);
    await fs.writeFile(path.join(previousDir, 'opencode.jsonc'), 'unknown origin', 'utf8');

    const migration = await planProfileMigration({ previousDir, newDir, manifest: createManifest('0.0.9'), cliVersion: '0.1.0', assets: { 'opencode.jsonc': 'v2' } });

    assert.equal(migration.decisions[0].action, 'carry-over');
  });

  it('records every write as an upgrade entry', async (t) => {
    const { previousDir, newDir } = await createProfiles(t);
    const migration = await planProfileMigration({ previousDir, newDir, manifest: createManifest('0.0.9'), cliVersion: '0.1.0', assets: { 'a.md': 'x' } });
    assert.ok(migration.operations.every((operation) => /** @type {any} */ (operation).entry?.createdBy === 'upgrade@0.1.0'));
    assert.deepEqual(migration.operations[0], { op: 'makeDir', path: newDir, entry: { kind: 'dir', path: newDir, createdBy: 'upgrade@0.1.0' } });
  });
});

describe('external files', () => {
  it('re-renders an unchanged fragment, and leaves an edited one with .ocu-new beside it', async (t) => {
    const sandbox = await useSandbox(t, 'upgrade');
    const unchanged = sandbox.path('a', 'profiles.json');
    const edited = sandbox.path('b', 'profiles.json');
    await fs.mkdir(path.dirname(unchanged), { recursive: true });
    await fs.mkdir(path.dirname(edited), { recursive: true });
    await fs.writeFile(unchanged, 'old', 'utf8');
    await fs.writeFile(edited, 'old plus mine', 'utf8');
    let manifest = createManifest('0.0.9');
    manifest = upsertEntry(manifest, { kind: 'wtFragment', path: unchanged, sha256: sha256Hex('old'), createdBy: BY });
    manifest = upsertEntry(manifest, { kind: 'wtFragment', path: edited, sha256: sha256Hex('old'), createdBy: BY });

    const { operations, notices } = await planExternalFiles({ manifest, rendered: { [unchanged]: 'new', [edited]: 'new' }, cliVersion: '0.1.0' });

    assert.deepEqual(operations.map((operation) => /** @type {any} */ (operation).path), [unchanged, `${edited}.ocu-new`]);
    assert.match(notices[0], /was edited/);
  });

  it('writes a fragment again when it was deleted', async (t) => {
    const sandbox = await useSandbox(t, 'upgrade');
    const target = sandbox.path('gone', 'profiles.json');
    const manifest = upsertEntry(createManifest('0.0.9'), { kind: 'wtFragment', path: target, sha256: sha256Hex('old'), createdBy: BY });

    const { operations } = await planExternalFiles({ manifest, rendered: { [target]: 'new' }, cliVersion: '0.1.0' });

    assert.equal(/** @type {any} */ (operations[0]).path, target);
  });

  it('points a skill copy at the host lane instead of guessing its content', async () => {
    const manifest = upsertEntry(createManifest('0.0.9'), { kind: 'skillCopy', target: 'claude', path: '/h/.claude/skills/x/SKILL.md', sha256: sha256Hex('x'), createdBy: BY });

    const { operations, notices } = await planExternalFiles({ manifest, rendered: {}, cliVersion: '0.1.0' });

    assert.deepEqual(operations, []);
    assert.match(notices[0], /host update/);
  });
});

describe('pointer', () => {
  it('round-trips and survives a damaged file', () => {
    assert.deepEqual(parsePointer(renderPointer('0.1.0', '0.0.9')), { version: '0.1.0', previous: '0.0.9' });
    assert.deepEqual(parsePointer('not json'), { version: null, previous: null });
    assert.deepEqual(parsePointer('null'), { version: null, previous: null });
    assert.deepEqual(parsePointer('{"version":1}'), { version: null, previous: null });
  });
});

describe('rollback', () => {
  it('goes back when the previous profile is still there', async (t) => {
    const { previousDir } = await createProfiles(t);
    const plan = await planRollback({ pointer: { version: '0.1.0', previous: '0.0.9' }, profileDir: () => previousDir });
    assert.deepEqual(plan, { ok: true, version: '0.0.9', message: 'The pointer now names 0.0.9. Install that package version to use it.', command: 'npm i -g opencode-unity@0.0.9' });
  });

  it('says there is nothing to go back to, or that it is gone', async () => {
    assert.equal((await planRollback({ pointer: { version: '0.1.0', previous: null }, profileDir: () => '/x' })).ok, false);
    const gone = await planRollback({ pointer: { version: '0.1.0', previous: '0.0.9' }, profileDir: () => path.join(process.cwd(), 'no-such-profile-dir') });
    assert.equal(gone.ok, false);
    assert.equal(gone.command, 'npm i -g opencode-unity@0.0.9');
  });
});

describe('model tags and compatibility', () => {
  it('asks for a new tag when context length or sampling changed', () => {
    const base = { numCtx: 16384, sampling: { temperature: 0.7, topP: 0.8 } };
    assert.equal(modelNeedsNewTag(base, structuredClone(base)), false);
    assert.equal(modelNeedsNewTag(base, { ...base, numCtx: 32768 }), true);
    assert.equal(modelNeedsNewTag(base, { ...base, sampling: { temperature: 0.6, topP: 0.8 } }), true);
    assert.equal(modelNeedsNewTag(base, { ...base, sampling: { temperature: 0.7, topP: 0.8, topK: 20 } }), true);
    assert.equal(modelNeedsNewTag({}, {}), false);
  });

  it('lists what is outside the tested set', () => {
    const compat = { opencode: { tested: '1.18.31' }, ollama: { tested: '0.34.1', min: '0.34.1' } };
    assert.deepEqual(describeCompatibility({ compat, installedOpencode: '1.18.31', installedOllama: '0.34.1' }), ['tested with OpenCode 1.18.31 and Ollama 0.34.1']);
    const lines = describeCompatibility({ compat, installedOpencode: '1.19.0', installedOllama: '0.33.0' });
    assert.equal(lines.length, 3);
    assert.match(lines[1], /1\.19\.0/);
    assert.match(lines[2], /minimum 0\.34\.1/);
  });

  it('lists projects whose facts an older generator wrote', () => {
    assert.deepEqual(listStaleProjects([{ id: 'a', factsVersion: 1 }, { id: 'b', factsVersion: 0 }, { id: 'c' }], 1), ['b', 'c']);
  });
});
