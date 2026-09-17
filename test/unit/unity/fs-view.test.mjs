import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareOrdinal,
  createMemoryFsView,
  createNodeFsView,
  isDirectory,
  isFile,
  joinProjectPath,
  readJson,
  toPosix,
} from '../../../src/unity/fs-view.js';

const ROOT = process.platform === 'win32' ? 'C:\\fs-view-tests' : '/fs-view-tests';

test('memory view reports files, directories and sorted children', () => {
  const view = createMemoryFsView({
    [path.join(ROOT, 'Assets/B.cs')]: 'b',
    [path.join(ROOT, 'Assets/a.cs')]: 'aa',
    [path.join(ROOT, 'Assets/Empty')]: null,
  });
  assert.equal(isDirectory(view, path.join(ROOT, 'Assets')), true);
  assert.equal(isFile(view, path.join(ROOT, 'Assets/a.cs')), true);
  assert.equal(isFile(view, path.join(ROOT, 'Assets')), false);
  assert.equal(view.stat(path.join(ROOT, 'missing')), null);
  assert.equal(view.stat(path.join(ROOT, 'Assets/a.cs'))?.size, 2);
  assert.deepEqual(
    view.readDir(path.join(ROOT, 'Assets')).map((entry) => `${entry.name}:${entry.isDirectory}`),
    ['B.cs:false', 'Empty:true', 'a.cs:false'],
  );
  assert.deepEqual(view.readDir(path.join(ROOT, 'missing')), []);
});

test('memory view accepts a modification time and separators in either style', () => {
  const view = createMemoryFsView({ [`${toPosix(ROOT)}/Library/state.txt`]: { text: 'x', mtimeMs: 1234 } });
  assert.equal(view.stat(path.join(ROOT, 'Library', 'state.txt'))?.mtimeMs, 1234);
});

test('readText truncates at maxBytes, strips a BOM and reports the full size', () => {
  const view = createMemoryFsView({ [path.join(ROOT, 'big.txt')]: `\ufeff${'x'.repeat(100)}` });
  const read = view.readText(path.join(ROOT, 'big.txt'), { maxBytes: 10 });
  assert.equal(read?.truncated, true);
  // 10 bytes were read: the three-byte BOM, which is stripped, and seven characters.
  assert.equal(read?.text.length, 7);
  assert.equal(read?.size, 103);
  const whole = view.readText(path.join(ROOT, 'big.txt'));
  assert.equal(whole?.truncated, false);
  assert.equal(whole?.text.startsWith('x'), true);
});

test('readJson tolerates comments and reports parse errors without throwing', () => {
  const view = createMemoryFsView({
    [path.join(ROOT, 'good.json')]: '{\n  // comment\n  "a": 1,\n}\n',
    [path.join(ROOT, 'bad.json')]: '{ "a": ',
    [path.join(ROOT, 'huge.json')]: '{ "a": 1 }',
  });
  assert.deepEqual(readJson(view, path.join(ROOT, 'good.json')).value, { a: 1 });
  assert.equal(readJson(view, path.join(ROOT, 'missing.json')).found, false);
  const bad = readJson(view, path.join(ROOT, 'bad.json'));
  assert.equal(bad.found, true);
  assert.equal(bad.value, undefined);
  assert.match(String(bad.error), /invalid JSON/);
  assert.equal(readJson(view, path.join(ROOT, 'huge.json'), { maxBytes: 2 }).error, 'file too large');
});

test('node view reads a real directory and never throws on missing paths', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-unity-fsview-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'Assets'));
  fs.writeFileSync(path.join(directory, 'Assets', 'Player.cs'), 'class Player {}\n');
  const view = createNodeFsView();
  assert.equal(view.stat(path.join(directory, 'Assets'))?.isDirectory, true);
  assert.deepEqual(
    view.readDir(path.join(directory, 'Assets')).map((entry) => entry.name),
    ['Player.cs'],
  );
  assert.equal(view.readText(path.join(directory, 'Assets', 'Player.cs'))?.text, 'class Player {}\n');
  assert.equal(view.readText(path.join(directory, 'Assets', 'Player.cs'), { maxBytes: 5 })?.truncated, true);
  assert.equal(view.readText(path.join(directory, 'nope.cs')), null);
  assert.deepEqual(view.readDir(path.join(directory, 'nope')), []);
  assert.equal(view.stat(path.join(directory, 'nope')), null);
});

test('path helpers are ordinal and posix', () => {
  assert.equal(joinProjectPath('/root', 'Assets/Game/Player.cs'), path.join('/root', 'Assets', 'Game', 'Player.cs'));
  assert.equal(joinProjectPath('/root', ''), '/root');
  assert.equal(toPosix('a\\b\\c'), 'a/b/c');
  assert.equal(compareOrdinal('a', 'a'), 0);
  assert.equal(compareOrdinal('B', 'a'), -1);
  assert.equal(compareOrdinal('a', 'B'), 1);
});
