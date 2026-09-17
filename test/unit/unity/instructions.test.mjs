import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createMemoryFsView } from '../../../src/unity/fs-view.js';
import { detectInstructionFiles, estimateInstructionTokens, hasOpencodeDir } from '../../../src/unity/instructions.js';
import { walkProject } from '../../../src/unity/walk.js';

const PARENT = process.platform === 'win32' ? 'C:\\instruction-tests' : '/instruction-tests';
const ROOT = path.join(PARENT, 'SampleGame');

/**
 * @param {Record<string, string | null>} tree  Paths relative to the parent of the project.
 * @param {{ maxDepth?: number | null }} [options]
 */
function detect(tree, options = {}) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(PARENT, file), value])));
  return { view, files: detectInstructionFiles(view, ROOT, walkProject(view, ROOT), options) };
}

test('AGENTS.md wins over CONTEXT.md, and CLAUDE.md is never picked up above the project', () => {
  const { files } = detect({
    'SampleGame/AGENTS.md': '# Rules\n',
    'SampleGame/CONTEXT.md': '# Old\n',
    'SampleGame/CLAUDE.md': '# Other assistant\n',
    'SampleGame/Assets/Keep.cs': '',
  });
  assert.deepEqual(files, [{ path: 'AGENTS.md', scope: 'upward', chars: 8, tokens: 3 }]);
});

test('CONTEXT.md is used when there is no AGENTS.md anywhere above', () => {
  const { files } = detect({ 'SampleGame/CONTEXT.md': '# Old\n', 'SampleGame/Assets/Keep.cs': '' });
  assert.deepEqual(files.map((file) => file.path), ['CONTEXT.md']);
});

test('the upward search collects every level of the winning name', () => {
  const { files } = detect({ 'AGENTS.md': '# Above\n', 'SampleGame/AGENTS.md': '# Project\n', 'SampleGame/Assets/Keep.cs': '' });
  assert.deepEqual(files.map((file) => file.path), ['AGENTS.md', '../AGENTS.md']);
});

test('a depth limit stops the upward search at the worktree root', () => {
  const tree = { 'AGENTS.md': '# Above\n', 'SampleGame/Assets/Keep.cs': '' };
  assert.deepEqual(detect(tree, { maxDepth: 0 }).files, []);
  assert.deepEqual(
    detect(tree, { maxDepth: 1 }).files.map((file) => file.path),
    ['../AGENTS.md'],
  );
});

test('nested AGENTS.md and CLAUDE.md files under Assets and Packages are listed', () => {
  const { files } = detect({
    'SampleGame/Assets/Game/AGENTS.md': '# Gameplay\n',
    'SampleGame/Assets/Game/Combat/CLAUDE.md': '# Combat\n',
    'SampleGame/Packages/com.example.tools/AGENTS.md': '# Package\n',
    'SampleGame/Assets/Game/notes.md': '# Not an instruction file\n',
    'SampleGame/Assets/Keep.cs': '',
  });
  assert.deepEqual(files.map((file) => `${file.scope}:${file.path}`), [
    'nested:Assets/Game/AGENTS.md',
    'nested:Assets/Game/Combat/CLAUDE.md',
    'nested:Packages/com.example.tools/AGENTS.md',
  ]);
});

test('token estimates and the .opencode check', () => {
  assert.equal(estimateInstructionTokens(0), 0);
  assert.equal(estimateInstructionTokens(350), 100);
  assert.equal(estimateInstructionTokens(1), 1);
  const { view } = detect({ 'SampleGame/.opencode/agent/review.md': 'x', 'SampleGame/Assets/Keep.cs': '' });
  assert.equal(hasOpencodeDir(view, ROOT), true);
  assert.equal(hasOpencodeDir(createMemoryFsView({}), ROOT), false);
});
