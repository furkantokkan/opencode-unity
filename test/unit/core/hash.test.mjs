import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { describe, it } from 'node:test';

import { hashJson, sha256File, sha256Hex, sha256Tree, stableStringify } from '../../../src/core/hash.js';
import { writeTree } from '../../helpers/fixture-fs.mjs';
import { useSandbox } from '../../helpers/sandbox.mjs';

describe('sha256Hex', () => {
  it('hashes text as UTF-8 and bytes as given', () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex('opencode-unity'), crypto.createHash('sha256').update('opencode-unity').digest('hex'));
    assert.equal(sha256Hex(Buffer.from('opencode-unity', 'utf8')), sha256Hex('opencode-unity'));
    assert.match(sha256Hex('x'), /^[0-9a-f]{64}$/);
  });
});

describe('stableStringify and hashJson (install manifest and verify-cache keys)', () => {
  it('gives equal values equal hashes, whatever the key order', () => {
    assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
    assert.equal(hashJson({ b: 1, a: 2 }), hashJson({ a: 2, b: 1 }));
    assert.notEqual(hashJson({ a: 1 }), hashJson({ a: 2 }));
  });

  it('keeps array order, which carries meaning in permission rules', () => {
    assert.notEqual(hashJson([1, 2]), hashJson([2, 1]));
    assert.equal(stableStringify([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  });
});

describe('sha256File and sha256Tree (spec 14.2, 14.4 residue checks)', () => {
  it('hashes a file like the text hash of its content', async (t) => {
    const sandbox = await useSandbox(t, 'hash-file');
    const file = sandbox.path('file.txt');
    await fs.writeFile(file, 'content');
    assert.equal(await sha256File(file), sha256Hex('content'));
  });

  it('hashes a tree by relative path and content, independent of walk order', async (t) => {
    const sandbox = await useSandbox(t, 'hash-tree');
    const first = sandbox.path('first');
    const second = sandbox.path('second');
    await writeTree(first, { 'a.txt': 'a', 'nested/b.txt': 'b', 'nested/deep/c.txt': 'c' });
    await writeTree(second, { 'nested/deep/c.txt': 'c', 'nested/b.txt': 'b', 'a.txt': 'a' });
    assert.equal(await sha256Tree(first), await sha256Tree(second));
  });

  it('changes when content, a name or the set of files changes', async (t) => {
    const sandbox = await useSandbox(t, 'hash-tree-change');
    const root = sandbox.path('tree');
    await writeTree(root, { 'a.txt': 'a' });
    const before = await sha256Tree(root);
    await fs.writeFile(`${root}/a.txt`, 'b');
    const changed = await sha256Tree(root);
    assert.notEqual(changed, before);
    await fs.rename(`${root}/a.txt`, `${root}/b.txt`);
    assert.notEqual(await sha256Tree(root), changed);
    await fs.writeFile(`${root}/c.txt`, 'c');
    assert.notEqual(await sha256Tree(root), changed);
  });

  it('ignores empty directories, which no manifest entry owns', async (t) => {
    const sandbox = await useSandbox(t, 'hash-tree-empty');
    const root = sandbox.path('tree');
    await writeTree(root, { 'a.txt': 'a' });
    const before = await sha256Tree(root);
    await fs.mkdir(`${root}/empty`, { recursive: true });
    assert.equal(await sha256Tree(root), before);
  });
});
