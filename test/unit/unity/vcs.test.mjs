import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { VCS_BINARIES, VCS_TABLES, VCS_WRITE_DENY, getReadOnlyAllowPatterns, isVcsKind } from '../../../plugin/opencode-unity-lib/vcs-tables.js';
import { createMemoryFsView } from '../../../src/unity/fs-view.js';
import { detectVcs } from '../../../src/unity/vcs.js';

const PARENT = process.platform === 'win32' ? 'C:\\vcs-tests' : '/vcs-tests';
const ROOT = path.join(PARENT, 'SampleGame');

/**
 * @param {Record<string, string | null>} tree  Paths relative to the parent of the project.
 * @param {Record<string, string | undefined>} [env]
 */
function detect(tree, env = {}) {
  const entries = Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(PARENT, file), value]));
  return detectVcs(createMemoryFsView({ ...entries, [path.join(ROOT, 'Assets/Keep.cs')]: '' }), ROOT, { env });
}

test('each marker maps to its version control system', () => {
  assert.equal(detect({ 'SampleGame/.git': null }).kind, 'git');
  assert.equal(detect({ 'SampleGame/.plastic': null }).kind, 'plastic');
  assert.equal(detect({ 'SampleGame/.p4config': 'P4CLIENT=x' }).kind, 'perforce');
  assert.equal(detect({ 'SampleGame/.svn': null }).kind, 'svn');
  assert.equal(detect({ 'SampleGame/.hg': null }).kind, 'hg');
});

test('a .git file (a worktree or submodule) counts as git', () => {
  const result = detect({ 'SampleGame/.git': 'gitdir: ../.git/worktrees/SampleGame\n' });
  assert.equal(result.kind, 'git');
  assert.equal(result.marker, '.git');
  assert.equal(result.depth, 0);
  assert.equal(result.source, 'marker');
});

test('markers that must be a directory are not matched by a file', () => {
  assert.equal(detect({ 'SampleGame/.plastic': 'not a directory' }).kind, 'none');
  assert.equal(detect({ 'SampleGame/.p4config': null }).kind, 'none');
});

test('the search walks upward and the nearest directory wins', () => {
  const result = detect({ '.git': null, 'SampleGame/.hg': null });
  assert.equal(result.kind, 'hg');
  assert.equal(result.depth, 0);
  const above = detect({ '.git': null });
  assert.equal(above.kind, 'git');
  assert.equal(above.depth, 1);
  assert.equal(above.marker, '../.git');
});

test('several markers in one directory are all reported, git first', () => {
  const result = detect({ 'SampleGame/.git': null, 'SampleGame/.svn': null });
  assert.equal(result.kind, 'git');
  assert.deepEqual(result.found.map((hit) => hit.kind), ['git', 'svn']);
});

test('P4CONFIG names another settings file, and alone still means Perforce', () => {
  assert.equal(detect({ 'SampleGame/.perforce-settings': 'P4CLIENT=x' }, { P4CONFIG: '.perforce-settings' }).kind, 'perforce');
  assert.equal(detect({ 'SampleGame/.perforce-settings': 'P4CLIENT=x' }, { P4CONFIG: 'C:/tools/.perforce-settings' }).kind, 'perforce');
  const fromEnv = detect({}, { P4CONFIG: '.p4config' });
  assert.equal(fromEnv.kind, 'perforce');
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.depth, null);
});

test('no marker and no environment means no version control', () => {
  assert.deepEqual(detect({}), { kind: 'none', source: null, depth: null, marker: null, found: [] });
  assert.deepEqual(detect({}, { P4CONFIG: '  ' }).kind, 'none');
});

test('the shared tables cover every client', () => {
  assert.deepEqual(VCS_BINARIES, ['git', 'cm', 'p4', 'svn', 'hg']);
  assert.deepEqual(Object.keys(VCS_WRITE_DENY), ['git *', 'cm *', 'p4 *', 'svn *', 'hg *']);
  assert.equal(Object.values(VCS_WRITE_DENY).every((action) => action === 'deny'), true);
  assert.deepEqual(getReadOnlyAllowPatterns('git'), ['git status *', 'git diff *', 'git log *', 'git show *', 'git blame *']);
  assert.deepEqual(getReadOnlyAllowPatterns('plastic'), ['cm status *']);
  assert.deepEqual(getReadOnlyAllowPatterns('none'), []);
  assert.equal(isVcsKind('git'), true);
  assert.equal(isVcsKind('none'), false);
  assert.equal(isVcsKind(null), false);
  assert.equal(VCS_TABLES.perforce.status, 'experimental');
  assert.equal(VCS_TABLES.git.status, 'reference-tested');
});
