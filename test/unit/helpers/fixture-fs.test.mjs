import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { diffSnapshots, resolveInside, snapshotTree, toPosixPath, writeTree } from '../../helpers/fixture-fs.mjs';
import { useSandbox } from '../../helpers/sandbox.mjs';

describe('fixture file trees', () => {
  it('writes files, empty directories and nested trees', async (t) => {
    const sandbox = await useSandbox(t, 'tree');
    const root = sandbox.path('project');
    await writeTree(root, {
      'Assets/Scripts/Player.cs': 'class Player {}\n',
      'Library/': null,
      Packages: { 'manifest.json': '{}' },
      'bin.dat': Buffer.from([0, 1, 2]),
    });
    assert.equal(await fs.readFile(path.join(root, 'Assets', 'Scripts', 'Player.cs'), 'utf8'), 'class Player {}\n');
    assert.ok((await fs.stat(path.join(root, 'Library'))).isDirectory());
    assert.equal(await fs.readFile(path.join(root, 'Packages', 'manifest.json'), 'utf8'), '{}');
    assert.deepEqual([...(await fs.readFile(path.join(root, 'bin.dat')))], [0, 1, 2]);
  });

  it('snapshots a tree and reports added, removed and changed paths', async (t) => {
    const sandbox = await useSandbox(t, 'snapshot');
    const root = sandbox.path('tree');
    await writeTree(root, { 'keep.txt': 'same', 'edit.txt': 'before', 'gone.txt': 'x', 'state/': null });
    const before = await snapshotTree(root, { ignore: ['state'] });
    assert.deepEqual(Object.keys(before).sort(), ['edit.txt', 'gone.txt', 'keep.txt']);
    await fs.writeFile(path.join(root, 'edit.txt'), 'after');
    await fs.rm(path.join(root, 'gone.txt'));
    await writeTree(root, { 'new/file.txt': 'y', 'state/ignored.txt': 'z' });
    const after = await snapshotTree(root, { ignore: ['state'] });
    assert.deepEqual(diffSnapshots(before, after), { added: ['new', 'new/file.txt'], removed: ['gone.txt'], changed: ['edit.txt'] });
    assert.deepEqual(diffSnapshots(after, after), { added: [], removed: [], changed: [] });
  });

  it('refuses paths that leave the root', () => {
    const root = path.resolve('fixture-root');
    assert.throws(() => resolveInside(root, '../outside.txt'), /outside/);
    assert.throws(() => resolveInside(root, path.resolve('elsewhere')), /outside/);
    assert.equal(resolveInside(root, '..hidden/file'), path.join(root, '..hidden', 'file'));
  });

  it('converts platform paths to forward slashes', () => {
    assert.equal(toPosixPath(path.join('a', 'b', 'c.cs')), 'a/b/c.cs');
  });
});
