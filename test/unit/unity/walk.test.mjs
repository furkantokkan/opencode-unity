import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createMemoryFsView } from '../../../src/unity/fs-view.js';
import { baseNameOf, extensionOf, isUnityHidden, parentOf, walkProject, WALKED_ROOTS } from '../../../src/unity/walk.js';

const ROOT = process.platform === 'win32' ? 'C:\\walk-tests' : '/walk-tests';

/**
 * @param {Record<string, string | null>} tree
 */
function viewOf(tree) {
  return createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
}

test('only Assets and Packages are walked, and output is sorted', () => {
  const index = walkProject(
    viewOf({
      'Assets/b.cs': '',
      'Assets/A.cs': '',
      'Assets/Game/Player.cs': '',
      'Packages/manifest.json': '{}',
      'Library/PackageCache/com.x/Runtime/X.cs': '',
      'Temp/lock': '',
      'Logs/log.txt': '',
      'obj/Debug/x.cs': '',
      'Build/game.exe': '',
      'Assembly-CSharp.csproj': '',
    }),
    ROOT,
  );
  assert.deepEqual(index.files, ['Assets/A.cs', 'Assets/Game/Player.cs', 'Assets/b.cs', 'Packages/manifest.json']);
  assert.deepEqual(index.dirs, ['Assets', 'Assets/Game', 'Packages']);
  assert.equal(index.truncated, false);
  assert.deepEqual([...WALKED_ROOTS], ['Assets', 'Packages']);
});

test('hidden, tilde and tool folders are skipped inside Assets', () => {
  const index = walkProject(
    viewOf({
      'Assets/Game/Player.cs': '',
      'Assets/Samples~/Sample.cs': '',
      'Assets/.hidden/Secret.cs': '',
      'Assets/CVS/Old.cs': '',
      'Assets/Tools/node_modules/pkg/index.js': '',
      'Assets/Tools/obj/Temp.cs': '',
      'Assets/Tools/.opencode/agent.md': '',
      'Assets/Tools/Real.cs': '',
    }),
    ROOT,
  );
  assert.deepEqual(index.files, ['Assets/Game/Player.cs', 'Assets/Tools/Real.cs']);
  assert.equal(isUnityHidden('.git'), true);
  assert.equal(isUnityHidden('Samples~'), true);
  assert.equal(isUnityHidden('cvs'), true);
  assert.equal(isUnityHidden('Assets'), false);
});

test('a project without Assets or Packages walks to nothing', () => {
  const index = walkProject(viewOf({ 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.3.8f1' }), ROOT);
  assert.deepEqual(index.files, []);
  assert.equal(index.entryCount, 0);
});

test('the entry cap stops the walk and is reported', () => {
  const tree = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`Assets/Game/File${index}.cs`, '']));
  const index = walkProject(viewOf(tree), ROOT, { maxEntries: 10 });
  assert.equal(index.truncated, true);
  assert.equal(index.entryCount, 10);
  assert.ok(index.files.length < 40);
});

test('the cap can stop before Packages is entered', () => {
  const index = walkProject(viewOf({ 'Assets/A.cs': '', 'Packages/manifest.json': '{}' }), ROOT, { maxEntries: 1 });
  assert.equal(index.truncated, true);
  assert.deepEqual(index.dirs, ['Assets']);
});

test('path helpers', () => {
  assert.equal(extensionOf('Assets/Game/Player.CS'), '.cs');
  assert.equal(extensionOf('Assets/Game/Makefile'), '');
  assert.equal(extensionOf('Assets/.editorconfig'), '');
  assert.equal(parentOf('Assets/Game/Player.cs'), 'Assets/Game');
  assert.equal(parentOf('Assets'), '');
  assert.equal(baseNameOf('Assets/Game/Player.cs'), 'Player.cs');
});
