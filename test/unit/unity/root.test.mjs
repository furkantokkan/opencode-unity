import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { EXIT } from '../../../src/cli/exit-codes.js';
import { createMemoryFsView } from '../../../src/unity/fs-view.js';
import { findUnityProjectRoot, getProjectName, isUnityProjectRoot, requireUnityProjectRoot } from '../../../src/unity/root.js';
import { detectUnityVersion, parseProjectVersion } from '../../../src/unity/version.js';

const ROOT = path.join(process.platform === 'win32' ? 'C:\\root-tests' : '/root-tests', 'SampleGame');

const view = createMemoryFsView({
  [path.join(ROOT, 'ProjectSettings/ProjectVersion.txt')]: 'm_EditorVersion: 6000.3.8f1\n',
  [path.join(ROOT, 'Assets/Game/Player.cs')]: 'class Player {}',
});

test('a project root has Assets and ProjectVersion.txt', () => {
  assert.equal(isUnityProjectRoot(view, ROOT), true);
  assert.equal(isUnityProjectRoot(view, path.join(ROOT, 'Assets')), false);
});

test('the root is found from any path inside the project', () => {
  assert.equal(findUnityProjectRoot(view, path.join(ROOT, 'Assets', 'Game')), ROOT);
  assert.equal(requireUnityProjectRoot(view, path.join(ROOT, 'Assets', 'Game', 'Player.cs')), ROOT);
});

test('a path outside a project exits 1 with a hint', () => {
  const outside = path.join(path.dirname(ROOT), 'NotAProject');
  assert.equal(findUnityProjectRoot(view, outside), null);
  assert.throws(
    () => requireUnityProjectRoot(view, outside),
    (error) => {
      assert.equal(error.exitCode, EXIT.USAGE);
      assert.equal(error.code, 'not_unity_project');
      assert.match(error.hint, /Assets/);
      return true;
    },
  );
});

test('the project name is the folder name', () => {
  assert.equal(getProjectName(ROOT), 'SampleGame');
  assert.equal(getProjectName(`${ROOT}${path.sep}`), 'SampleGame');
});

test('the Unity version is read and labelled', () => {
  assert.deepEqual(detectUnityVersion(view, ROOT), {
    editorVersion: '6000.3.8f1',
    stream: '6000.3',
    support: 'reference-tested',
    warnings: [],
  });
  assert.equal(parseProjectVersion('m_EditorVersion: 2022.3.55f1\n').support, 'experimental');
  assert.equal(parseProjectVersion('m_EditorVersion: 2021.3.45f1\n').support, 'experimental');
  const old = parseProjectVersion('m_EditorVersion: 2019.4.40f1\n');
  assert.equal(old.support, 'unsupported');
  assert.match(old.warnings[0], /not supported/);
  assert.deepEqual(parseProjectVersion('nothing here').support, 'unknown');
  assert.equal(parseProjectVersion('m_EditorVersion: garbage').support, 'unknown');
});

test('an unreadable ProjectVersion.txt is reported, not thrown', () => {
  const empty = createMemoryFsView({});
  assert.deepEqual(detectUnityVersion(empty, ROOT), {
    editorVersion: null,
    stream: null,
    support: 'unknown',
    warnings: ['ProjectVersion.txt is unreadable'],
  });
});
