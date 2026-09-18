// The reviewed diff. It is what a human or a paid orchestrator reads before anything is written, so it
// has to be correct without git and identical on every platform.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countDiffLines, createChangesDiff, createUnifiedDiff } from '../../src/delegate/diff.js';

/**
 * @param {string} relativePath
 * @param {string} before
 * @param {string} after
 */
function change(relativePath, before, after) {
  return { relativePath, decoded: { text: before }, newText: after };
}

describe('createUnifiedDiff', () => {
  it('writes headers, a hunk range and the changed lines', () => {
    const diff = createUnifiedDiff('a/a.cs', 'b/a.cs', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    assert.equal(diff, '--- a/a.cs\n+++ b/a.cs\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n');
  });

  it('is empty when nothing changed', () => {
    assert.equal(createUnifiedDiff('a', 'b', 'same\n', 'same\n'), '');
  });

  it('shows an inserted and a deleted line', () => {
    assert.match(createUnifiedDiff('a', 'b', 'one\n', 'one\ntwo\n'), /\+two/);
    assert.match(createUnifiedDiff('a', 'b', 'one\ntwo\n', 'one\n'), /-two/);
  });

  it('keeps the requested context around a change', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 10', 'line TEN');
    const lines = createUnifiedDiff('a', 'b', before, after, 2).split('\n');
    assert.equal(lines.filter((line) => line.startsWith(' ')).length, 4);
    assert.ok(lines.some((line) => line.startsWith('@@ -9,5 +9,5 @@')));
  });

  it('groups two nearby changes into one hunk and two distant ones into two', () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const near = before.replace('line 10', 'X').replace('line 12', 'Y');
    const far = before.replace('line 2', 'X').replace('line 35', 'Y');
    assert.equal((createUnifiedDiff('a', 'b', before, near).match(/^@@/gm) ?? []).length, 1);
    assert.equal((createUnifiedDiff('a', 'b', before, far).match(/^@@/gm) ?? []).length, 2);
  });

  it('reads CRLF text the same as LF text', () => {
    assert.equal(
      createUnifiedDiff('a', 'b', 'one\r\ntwo\r\n', 'one\r\nTWO\r\n'),
      createUnifiedDiff('a', 'b', 'one\ntwo\n', 'one\nTWO\n'),
    );
  });

  it('handles an empty side', () => {
    assert.match(createUnifiedDiff('a', 'b', '', 'new\n'), /@@ -0,0 \+1,1 @@\n\+new/);
    assert.match(createUnifiedDiff('a', 'b', 'old\n', ''), /@@ -1,1 \+0,0 @@\n-old/);
  });
});

describe('createChangesDiff', () => {
  it('joins one diff per file', () => {
    const diff = createChangesDiff([change('a.cs', 'x\n', 'y\n'), change('b.cs', 'p\n', 'q\n')]);
    assert.equal((diff.match(/^--- /gm) ?? []).length, 2);
    assert.match(diff, /--- a\/a\.cs/);
    assert.match(diff, /--- a\/b\.cs/);
  });

  it('counts added and removed lines per file for the applied summary', () => {
    assert.deepEqual(countDiffLines([change('a.cs', 'one\ntwo\n', 'one\nTWO\nthree\n')]), ['a.cs +2 -1']);
  });
});
