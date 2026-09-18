// Resolving and reading the files a delegated request may see (spec 12.3).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import {
  DEFAULT_MAX_FILE_BYTES,
  decodeTaskFile,
  displayPath,
  expandGlob,
  hasGlobChars,
  isInsideDirectory,
  loadSourceFiles,
  normalizeInputPath,
  pathKey,
  readTaskText,
  resolveFileArgs,
  stripBom,
} from '../../src/delegate/files.js';
import { createSensitiveMatcher } from '../../src/delegate/sensitive.js';
import { catchAsync } from '../helpers/catch-error.mjs';
import { useSandbox } from '../helpers/sandbox.mjs';

const matcher = createSensitiveMatcher();

/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string | Buffer>} files
 */
async function createTree(t, files) {
  const sandbox = await useSandbox(t, 'delegate-files');
  const root = path.join(sandbox.root, 'work');
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  await fs.mkdir(root, { recursive: true });
  return root;
}

describe('resolveFileArgs', () => {
  it('takes explicit files in the order they were given, without duplicates', async (t) => {
    const root = await createTree(t, { 'a.cs': 'a', 'b.cs': 'b' });
    const paths = await resolveFileArgs(['b.cs', 'a.cs', './b.cs'], root);
    assert.deepEqual(paths.map((file) => path.basename(file)), ['b.cs', 'a.cs']);
  });

  it('expands a glob across directories and sorts the matches', async (t) => {
    const root = await createTree(t, { 'src/a.cs': 'a', 'src/deep/b.cs': 'b', 'src/notes.md': 'm' });
    const paths = await expandGlob('src/**/*.cs', root);
    assert.deepEqual(paths.map((file) => path.relative(root, file).split(path.sep).join('/')), ['src/a.cs', 'src/deep/b.cs']);
  });

  // Case folding is a property of the platform the caller names, not of the machine the test runs on:
  // reading the ambient `process.platform` here makes the same call answer differently on each CI leg,
  // which is exactly the shape of the milestone-1 failures.
  it('folds glob case according to the platform it was given, not the host', async (t) => {
    const root = await createTree(t, { 'A.CS': 'a' });
    const onWindows = await expandGlob('*.cs', root, { platform: 'win32' });
    assert.deepEqual(onWindows.map((file) => path.basename(file)), ['A.CS']);
    assert.deepEqual(await expandGlob('*.cs', root, { platform: 'linux' }), []);
    assert.deepEqual(await expandGlob('*.CS', root, { platform: 'linux' }), onWindows);

    const resolved = await resolveFileArgs(['*.cs'], root, { platform: 'win32' });
    assert.deepEqual(resolved.map((file) => path.basename(file)), ['A.CS']);
    const error = await catchAsync(() => resolveFileArgs(['*.cs'], root, { platform: 'linux' }));
    assert.match(error.message, /The glob matched no files/);
  });

  it('refuses a directory and suggests a glob', async (t) => {
    const root = await createTree(t, { 'src/a.cs': 'a' });
    const error = await catchAsync(() => resolveFileArgs(['src'], root));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.match(error.message, /is a directory; pass files or a glob such as 'src\/\*\*\/\*\.cs'/);
  });

  it('refuses a missing file and an empty glob', async (t) => {
    const root = await createTree(t, { 'a.cs': 'a' });
    assert.match((await catchAsync(() => resolveFileArgs(['missing.cs'], root))).message, /File not found/);
    assert.match((await catchAsync(() => resolveFileArgs(['*.ts'], root))).message, /matched no files/);
  });

  it('refuses a glob where the caller asked for exact files', async (t) => {
    const root = await createTree(t, { 'a.cs': 'a' });
    const error = await catchAsync(() => resolveFileArgs(['*.cs'], root, { allowGlobs: false }));
    assert.match(error.message, /Globs are not allowed here/);
  });

  it('refuses a UNC path on Windows', async (t) => {
    const root = await createTree(t, { 'a.cs': 'a' });
    const error = await catchAsync(() => resolveFileArgs(['\\\\server\\share\\a.cs'], root, { platform: 'win32' }));
    assert.match(error.message, /network \(UNC\) path/);
  });
});

describe('loadSourceFiles', () => {
  it('reads text files and reports their path relative to the working directory', async (t) => {
    const root = await createTree(t, { 'src/a.cs': 'public class A {}\n' });
    const { files } = await loadSourceFiles([path.join(root, 'src', 'a.cs')], root, { matcher });
    assert.equal(files[0].relativePath, 'src/a.cs');
    assert.equal(files[0].text, 'public class A {}\n');
  });

  it('refuses a sensitive file with exit 1 and names the pattern', async (t) => {
    const root = await createTree(t, { '.env': 'TOKEN=1' });
    const error = await catchAsync(() => loadSourceFiles([path.join(root, '.env')], root, { matcher }));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.equal(error.code, 'sensitive_file_refused');
    assert.match(error.message, /matches '\.env'/);
    assert.match(error.hint, /--allow-sensitive/);
  });

  it('reads a sensitive file once the caller took responsibility', async (t) => {
    const root = await createTree(t, { '.env': 'TOKEN=1' });
    const { files } = await loadSourceFiles([path.join(root, '.env')], root, { matcher, allowSensitive: true });
    assert.equal(files.length, 1);
  });

  it('skips a binary file and an oversized file with a warning', async (t) => {
    const root = await createTree(t, { 'a.bin': Buffer.from([0x41, 0x00, 0x42]), 'big.cs': 'x'.repeat(100) });
    const { files, warnings } = await loadSourceFiles([path.join(root, 'a.bin'), path.join(root, 'big.cs')], root, { matcher, maxFileBytes: 50 });
    assert.deepEqual(files, []);
    assert.match(warnings[0], /binary file \(NUL byte\)/);
    assert.match(warnings[1], /above the 50-byte limit/);
  });

  it('turns those warnings into an error when the caller needs every file', async (t) => {
    const root = await createTree(t, { 'a.bin': Buffer.from([0x00]) });
    const error = await catchAsync(() => loadSourceFiles([path.join(root, 'a.bin')], root, { matcher, strict: true }));
    assert.match(error.message, /cannot be used/);
  });

  it('decodes UTF-16 with a BOM, which is what PowerShell redirection writes', async (t) => {
    const root = await createTree(t, { 'log.txt': Buffer.from('\ufefferror: failed', 'utf16le') });
    const { files } = await loadSourceFiles([path.join(root, 'log.txt')], root, { matcher });
    assert.equal(files[0].text, 'error: failed');
  });

  it('refuses UTF-16 where exact bytes matter, because an edit has to write them back', async (t) => {
    const root = await createTree(t, { 'a.cs': Buffer.from('\ufeffclass A {}', 'utf16le') });
    const error = await catchAsync(() => loadSourceFiles([path.join(root, 'a.cs')], root, { matcher, strict: true }));
    assert.match(error.message, /convert it to UTF-8/);
  });

  it('has a per-file size limit that keeps an unreadable prompt from being built at all', () => {
    assert.equal(DEFAULT_MAX_FILE_BYTES, 262_144);
  });
});

describe('readTaskText', () => {
  it('returns plain text unchanged', async (t) => {
    const root = await createTree(t, {});
    assert.equal(await readTaskText('list the classes', { cwd: root, matcher }), 'list the classes');
  });

  it('reads @file with the same rules as --files', async (t) => {
    const root = await createTree(t, { 'task.md': 'List every public method.\n' });
    assert.equal(await readTaskText('@task.md', { cwd: root, matcher }), 'List every public method.\n');
  });

  it('refuses a missing, empty or sensitive task file', async (t) => {
    const root = await createTree(t, { 'empty.md': '', '.env': 'TOKEN=1' });
    assert.match((await catchAsync(() => readTaskText('@missing.md', { cwd: root, matcher }))).message, /file not found/);
    assert.match((await catchAsync(() => readTaskText('@empty.md', { cwd: root, matcher }))).message, /is empty/);
    assert.equal((await catchAsync(() => readTaskText('@.env', { cwd: root, matcher }))).code, 'sensitive_file_refused');
  });

  it('refuses an empty --task', async (t) => {
    const root = await createTree(t, {});
    assert.match((await catchAsync(() => readTaskText('   ', { cwd: root, matcher }))).message, /--task needs text or @file/);
    assert.match((await catchAsync(() => readTaskText(undefined, { cwd: root, matcher, optionName: 'reduce' }))).message, /--reduce needs text/);
  });

  it('refuses a task file that is not text', () => {
    assert.match(catchThrow(() => decodeTaskFile(Buffer.from([0x00, 0x01]), 'task')).message, /binary \(NUL byte\)/);
    assert.match(catchThrow(() => decodeTaskFile(Buffer.from([0xff, 0xfe, 0x41]), 'task')).message, /not UTF-8 or UTF-16/);
  });
});

describe('path helpers', () => {
  it('recognises glob characters', () => {
    assert.equal(hasGlobChars('a/*.cs'), true);
    assert.equal(hasGlobChars('a/b.cs'), false);
  });

  it('folds case only where the file system does', () => {
    assert.equal(pathKey('Assets/A.cs', 'win32'), 'assets/a.cs');
    assert.equal(pathKey('Assets/A.cs', 'linux'), 'Assets/A.cs');
  });

  it('shows a path inside the working directory as a relative posix path', () => {
    const root = process.platform === 'win32' ? 'C:\\work' : '/work';
    assert.equal(displayPath(path.join(root, 'src', 'a.cs'), root), 'src/a.cs');
  });

  it('knows what is inside a directory', () => {
    const root = process.platform === 'win32' ? 'C:\\work' : '/work';
    assert.equal(isInsideDirectory(path.join(root, 'a.cs'), root), true);
    assert.equal(isInsideDirectory(root, root), false);
    assert.equal(isInsideDirectory(path.resolve(root, '..', 'other.cs'), root), false);
  });

  it('converts a Git Bash drive path only when MSYS is in play', () => {
    assert.equal(normalizeInputPath('/c/work/a.cs', { platform: 'win32', env: { MSYSTEM: 'MINGW64' } }), 'C:/work/a.cs');
    assert.equal(normalizeInputPath('/c/work/a.cs', { platform: 'win32', env: {} }), '/c/work/a.cs');
    assert.equal(normalizeInputPath('/c/work/a.cs', { platform: 'linux', env: { MSYSTEM: 'MINGW64' } }), '/c/work/a.cs');
  });

  it('removes a BOM', () => {
    assert.equal(stripBom('\ufeffx'), 'x');
    assert.equal(stripBom('x'), 'x');
  });
});

/**
 * @param {() => unknown} action
 * @returns {any}
 */
function catchThrow(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}
