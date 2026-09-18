// Parsing and validating SEARCH/REPLACE blocks (spec 12.2). Every rule here exists because a wrong
// block would either scramble a file or hide a change from the reviewed diff.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DIVIDER_MARKER,
  decodeTextFile,
  encodeTextFile,
  parseEditBlocks,
  validateEditBlocks,
} from '../../src/delegate/edit-blocks.js';
import { pathKey } from '../../src/delegate/files.js';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';

/**
 * @param {Record<string, string | Buffer>} files
 * @returns {Map<string, import('../../src/delegate/edit-blocks.js').AllowedFile>}
 */
function allowlist(files) {
  const map = new Map();
  for (const [relativePath, content] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    map.set(pathKey(relativePath), { relativePath, absolutePath: path.join(CWD, relativePath), bytes, decoded: decodeTextFile(bytes) });
  }
  return map;
}

/**
 * @param {string} file
 * @param {string} search
 * @param {string} replace
 * @returns {string}
 */
function block(file, search, replace) {
  return `FILE: ${file}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
}

/**
 * @param {string} answer
 * @param {Record<string, string | Buffer>} files
 */
function run(answer, files) {
  const parsed = parseEditBlocks(answer);
  const list = allowlist(files);
  return { parsed, list, ...validateEditBlocks(parsed.blocks, list, CWD) };
}

describe('parseEditBlocks', () => {
  it('reads one block', () => {
    const { blocks, errors } = parseEditBlocks(block('a.cs', 'old', 'new'));
    assert.deepEqual(errors, []);
    assert.deepEqual(blocks, [{ file: 'a.cs', search: 'old', replace: 'new', line: 1 }]);
  });

  it('ignores blank lines and markdown fences the model adds anyway', () => {
    const { blocks, errors } = parseEditBlocks(`\`\`\`\n\n${block('a.cs', 'old', 'new')}\n\`\`\`\n`);
    assert.deepEqual(errors, []);
    assert.equal(blocks.length, 1);
  });

  it('keeps blocks in order and applies several to one file', () => {
    const { blocks } = parseEditBlocks(`${block('a.cs', 'one', '1')}\n${block('a.cs', 'two', '2')}`);
    assert.deepEqual(blocks.map((entry) => entry.search), ['one', 'two']);
  });

  it('unquotes a path the model wrapped in quotes or backticks', () => {
    assert.equal(parseEditBlocks(block('`a.cs`', 'old', 'new')).blocks[0].file, 'a.cs');
    assert.equal(parseEditBlocks(block('"a.cs"', 'old', 'new')).blocks[0].file, 'a.cs');
  });

  it('reports stray prose once, not per line', () => {
    const { errors } = parseEditBlocks(`Here is my plan.\nIt has two steps.\n${block('a.cs', 'old', 'new')}`);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /expected "FILE: <path>"/);
  });

  it('names the missing marker instead of guessing', () => {
    assert.match(parseEditBlocks('FILE: a.cs\nold\n=======\nnew\n>>>>>>> REPLACE').errors[0], /the line after FILE must be exactly/);
    assert.match(parseEditBlocks('FILE: a.cs\n<<<<<<< SEARCH\nold\nnew\n>>>>>>> REPLACE').errors[0], /missing "======="/);
    assert.match(parseEditBlocks('FILE: a.cs\n<<<<<<< SEARCH\nold\n=======\nnew').errors[0], /missing ">>>>>>> REPLACE"/);
  });

  it('refuses a second divider instead of guessing where REPLACE starts', () => {
    const answer = `FILE: a.cs\n<<<<<<< SEARCH\nold\n${DIVIDER_MARKER}\nmiddle\n${DIVIDER_MARKER}\nnew\n>>>>>>> REPLACE`;
    const { errors, blocks } = parseEditBlocks(answer);
    assert.deepEqual(blocks, []);
    assert.match(errors[0], /more than one "======="/);
  });

  it('treats a FILE line inside content as content unless a SEARCH marker follows', () => {
    const { blocks, errors } = parseEditBlocks(block('a.cs', 'FILE: docs.md\nnot a block', 'x'));
    assert.deepEqual(errors, []);
    assert.equal(blocks.length, 1);
    assert.match(blocks[0].search, /FILE: docs\.md/);
  });

  it('says so when there is nothing to parse', () => {
    assert.deepEqual(parseEditBlocks('').errors, ['no edit blocks found']);
  });
});

describe('validateEditBlocks', () => {
  it('produces the new bytes for a block that matches once', () => {
    const { changes, errors } = run(block('a.cs', 'int x = 1;', 'int x = 2;'), { 'a.cs': 'class A {\n  int x = 1;\n}\n' });
    assert.deepEqual(errors, []);
    assert.equal(changes[0].newText, 'class A {\n  int x = 2;\n}\n');
  });

  it('applies several blocks to one file in order', () => {
    const answer = `${block('a.cs', 'one', '1')}\n${block('a.cs', 'two', '2')}`;
    const { changes, errors } = run(answer, { 'a.cs': 'one\ntwo\n' });
    assert.deepEqual(errors, []);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].newText, '1\n2\n');
  });

  it('refuses a file that is not in the allow-list, and names the ones that are', () => {
    const { errors } = run(block('other.cs', 'x', 'y'), { 'a.cs': 'x\n' });
    assert.match(errors[0], /is not in the allow-list \(a\.cs\)/);
  });

  // Spec 12.2 and safety rule S4. The check does not consult the allow-list first, so it holds even
  // when a caller assembled the allow-list itself - which is how the lane got here without it.
  it('refuses a protected Unity file, whether or not the allow-list holds it', () => {
    const tuples = [
      'Assets/Scenes/Main.unity',
      'Assets/UI/Menu.prefab',
      'Assets/Data/Config.asset',
      'Assets/Scripts/Player.cs.meta',
      'Assets/Game.asmdef',
      'Assembly-CSharp.csproj',
      'ProjectSettings/ProjectSettings.asset',
      'Packages/manifest.json',
    ];
    for (const file of tuples) {
      const { errors, changes } = run(block(file, 'x', 'y'), { [file]: 'x\n' });
      assert.equal(errors.length, 1, `${file} should be refused`);
      assert.match(errors[0], /is a protected Unity or project file/);
      assert.deepEqual(changes, []);
    }
    const missing = run(block('Assets/Scenes/Main.unity', 'x', 'y'), { 'a.cs': 'x\n' });
    assert.match(missing.errors[0], /is a protected Unity or project file/);
  });

  it('refuses a file the config added to the protected globs', () => {
    const parsed = parseEditBlocks(block('config/live.yaml', 'x', 'y'));
    const list = allowlist({ 'config/live.yaml': 'x\n' });
    const allowed = validateEditBlocks(parsed.blocks, list, CWD);
    assert.deepEqual(allowed.errors, []);
    const refused = validateEditBlocks(parsed.blocks, list, CWD, { extraProtectedEditGlobs: ['*config/*'] });
    assert.match(refused.errors[0], /is a protected Unity or project file \(\*config\/\*\)/);
  });

  it('refuses a path that leaves the working directory', () => {
    for (const file of ['../outside.cs', '/etc/passwd', 'sub/../../outside.cs']) {
      const { errors } = run(block(file, 'x', 'y'), { 'a.cs': 'x\n' });
      assert.equal(errors.length, 1, `${file} should be refused`);
      assert.match(errors[0], /must be a relative path inside the working directory|is not in the allow-list/);
    }
  });

  it('refuses SEARCH text that is not in the file, and says why', () => {
    assert.match(run(block('a.cs', 'missing', 'x'), { 'a.cs': 'class A {}\n' }).errors[0], /does not exist in the file/);
    assert.match(run(block('a.cs', '1| class A {}', 'x'), { 'a.cs': 'class A {}\n' }).errors[0], /includes the "N\| " line-number prefixes/);
    assert.match(run(block('a.cs', 'class A {\n}', 'x'), { 'a.cs': 'class A {\n\n}\n' }).errors[0], /indentation or blank lines are ignored/);
    assert.match(run(block('a.cs', 'class A {\nint y;\n}', 'x'), { 'a.cs': 'class A {\nint x;\n}\n' }).errors[0], /the first SEARCH line appears at line 1/);
  });

  it('refuses SEARCH text that matches more than once and names the lines', () => {
    const { errors } = run(block('a.cs', 'return;', 'break;'), { 'a.cs': 'a\nreturn;\nb\nreturn;\n' });
    assert.match(errors[0], /occurs 2 times \(lines 2, 4\)/);
  });

  it('refuses a block that changes nothing', () => {
    assert.match(run(block('a.cs', 'x', 'x'), { 'a.cs': 'x\n' }).errors[0], /identical; remove blocks that change nothing/);
    assert.match(run(block('a.cs', '', ''), { 'a.cs': '' }).errors[0], /both empty/);
  });

  it('refuses an empty SEARCH unless the file really is empty', () => {
    assert.match(run(block('a.cs', '', 'new'), { 'a.cs': 'x\n' }).errors[0], /only a file listed as \(empty\)/);
    const { changes, errors } = run(block('a.cs', '', 'new content'), { 'a.cs': '' });
    assert.deepEqual(errors, []);
    assert.equal(changes[0].newBytes.toString('utf8'), 'new content\n');
  });

  it('refuses an invisible control character the diff would not show', () => {
    const { errors } = run(block('a.cs', 'x', 'y\u202e'), { 'a.cs': 'x\n' });
    assert.match(errors[0], /invisible control character U\+202E/);
  });

  it('lets a control character through when the file already had it', () => {
    const { errors, changes } = run(block('a.cs', 'a\u0001b', 'a\u0001c'), { 'a.cs': 'a\u0001b\n' });
    assert.deepEqual(errors, []);
    assert.equal(changes.length, 1);
  });

  it('removes the line break of a line whose replacement is empty', () => {
    const { changes } = run(block('a.cs', 'gone', ''), { 'a.cs': 'keep\ngone\nkeep2\n' });
    assert.equal(changes[0].newText, 'keep\nkeep2\n');
  });

  it('reports that blocks parsed but changed nothing', () => {
    const { errors } = run(block('a.cs', 'x\n', 'x\n'), { 'a.cs': 'x\n' });
    assert.ok(errors.length > 0);
  });
});

describe('text encoding is preserved', () => {
  it('keeps CRLF line endings', () => {
    const { changes } = run(block('a.cs', 'old', 'new'), { 'a.cs': 'one\r\nold\r\ntwo\r\n' });
    assert.equal(changes[0].newBytes.toString('utf8'), 'one\r\nnew\r\ntwo\r\n');
  });

  it('keeps a BOM', () => {
    const { changes } = run(block('a.cs', 'old', 'new'), { 'a.cs': Buffer.from('\ufeffold\n', 'utf8') });
    assert.equal(changes[0].newBytes.toString('utf8'), '\ufeffnew\n');
  });

  it('keeps a missing final newline', () => {
    const { changes } = run(block('a.cs', 'old', 'new'), { 'a.cs': 'old' });
    assert.equal(changes[0].newBytes.toString('utf8'), 'new');
  });

  it('warns when it had to settle mixed line endings', () => {
    const { warnings, changes } = run(block('a.cs', 'old', 'new'), { 'a.cs': 'one\r\nold\ntwo\r\n' });
    assert.equal(changes.length, 1);
    assert.match(warnings[0], /mixed line endings/);
  });

  it('round-trips through decode and encode', () => {
    for (const text of ['a\nb\n', 'a\r\nb\r\n', '\ufeffa\n', 'a']) {
      const bytes = Buffer.from(text, 'utf8');
      const decoded = decodeTextFile(bytes);
      assert.equal(encodeTextFile(decoded, decoded.text).toString('utf8'), text);
    }
  });
});
