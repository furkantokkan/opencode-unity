import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeTree } from '../helpers/fixture-fs.mjs';
import { useSandbox } from '../helpers/sandbox.mjs';
import {
  ConfigError,
  DENYLIST_ENV,
  DENYLIST_FILE_ENV,
  SCRIPT_PATH,
  checkNoPersonalData,
  findBuiltInMatches,
  findDenylistMatches,
  formatFinding,
  isBinary,
  listRepoFiles,
  main,
  maskValue,
  normalizeForMatch,
  parseArgs,
  parseDenylist,
  scanPath,
} from '../../scripts/check-no-personal-data.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Planted values are assembled at runtime so this file never contains them literally.
const PLANTED_USER = ['plan', 'ted', 'user'].join('');
const PLANTED_NAME = ['Zed', 'Planted'].join(' ');
const PLANTED_STUDIO = ['Mock', 'Studio', 'Nine'].join('');
const PLANTED_EMAIL = `${PLANTED_USER}@${['corp', 'mail'].join('-')}.io`;
const BACKSLASH = '\\';

/** @param {string} text */
function rules(text) {
  return findBuiltInMatches(text).map((match) => match.rule);
}

/**
 * Collects writes from code under test.
 */
function captureStream() {
  /** @type {string[]} */
  const chunks = [];
  return { chunks, stream: /** @type {any} */ ({ write: (/** @type {string} */ text) => chunks.push(text) }) };
}

describe('check-no-personal-data built-in rules', () => {
  it('flags Windows home paths in every separator spelling', () => {
    assert.deepEqual(rules(['C:', 'Users', PLANTED_USER, 'repo'].join(BACKSLASH)), ['windows-home']);
    assert.deepEqual(rules(`C:/Users/${PLANTED_USER}/repo`), ['windows-home']);
    assert.deepEqual(rules(['"C:', '', 'Users', '', PLANTED_USER, '"'].join(BACKSLASH)), ['windows-home']);
    assert.deepEqual(rules(`d:/users/${PLANTED_USER}`), ['windows-home']);
    assert.deepEqual(rules(`/c/Users/${PLANTED_USER}/AppData`), ['windows-home']);
    assert.deepEqual(rules(`/mnt/c/Users/${PLANTED_USER}`), ['windows-home']);
  });

  it('flags POSIX home paths', () => {
    assert.deepEqual(rules(`cat /home/${PLANTED_USER}/.config/x`), ['posix-home']);
    assert.deepEqual(rules(`open /Users/${PLANTED_USER}/Library`), ['posix-home']);
  });

  it('allows placeholders, generic accounts and URLs', () => {
    for (const text of [
      'C:/Users/<home>/AppData',
      `C:${BACKSLASH}Users${BACKSLASH}<user>`,
      `C:${BACKSLASH}Users${BACKSLASH}%USERNAME%${BACKSLASH}x`,
      'C:/Users/$env:USERNAME/x',
      'C:/Users/*/AppData',
      'C:/Users/runneradmin/work',
      'C:/Users/Public/Documents',
      '/home/runner/work/repo',
      '/Users/Shared/x',
      '<home>/.config/opencode',
      'https://example.org/home/page',
      'https://example.org/Users/page',
    ]) {
      assert.deepEqual(rules(text), [], text);
    }
  });

  it('flags e-mail addresses outside reserved domains', () => {
    assert.deepEqual(rules(`contact ${PLANTED_EMAIL} now`), ['email']);
    for (const text of [
      'maintainer@example.com',
      'a.b+c@sub.example.org',
      'bot@ci.test',
      'x@host.invalid',
      'git@github.com:owner/repo.git',
      '@opencode-ai/plugin@1.18.31',
      'opencode-ai@latest',
      'pkg@1.2.3-beta.rc',
    ]) {
      assert.deepEqual(rules(text), [], text);
    }
  });

  it('masks matched values in details', () => {
    const [match] = findBuiltInMatches(`C:/Users/${PLANTED_USER}/x`);
    assert.ok(match.detail.includes(maskValue(PLANTED_USER)));
    assert.ok(!match.detail.includes(PLANTED_USER));
    assert.equal(match.column, 1);
    assert.equal(maskValue('ab'), '***');
  });
});

describe('check-no-personal-data denylist', () => {
  it('parses terms, comments and allow lines', () => {
    const denylist = parseDenylist(`# local only\r\n\r\n${PLANTED_NAME}\nallow: github.com/${PLANTED_USER}/opencode-unity\n${PLANTED_STUDIO}\n`, 'file');
    assert.deepEqual(denylist.terms.map((term) => term.entry), [1, 2]);
    assert.equal(denylist.terms[0].normalized, PLANTED_NAME.toLowerCase());
    assert.deepEqual(denylist.allows, [`github.com/${PLANTED_USER}/opencode-unity`]);
  });

  it('rejects terms shorter than three characters', () => {
    assert.throws(() => parseDenylist('ab', 'file'), ConfigError);
  });

  it('matches case-insensitively and across path separators', () => {
    const denylist = parseDenylist(`C:/Users/${PLANTED_USER}\n${PLANTED_STUDIO}`, 'file');
    assert.deepEqual(findDenylistMatches(['c:', 'users', PLANTED_USER.toUpperCase()].join(BACKSLASH + BACKSLASH), denylist).map((t) => t.entry), [1]);
    assert.deepEqual(findDenylistMatches(`the ${PLANTED_STUDIO.toLowerCase()} build`, denylist).map((t) => t.entry), [2]);
    assert.deepEqual(findDenylistMatches('nothing here', denylist), []);
  });

  it('removes allowed public strings before matching', () => {
    const denylist = parseDenylist(`${PLANTED_USER}\nallow: github.com/${PLANTED_USER}/opencode-unity`, 'file');
    assert.deepEqual(findDenylistMatches(`https://github.com/${PLANTED_USER}/opencode-unity#readme`, denylist), []);
    assert.equal(findDenylistMatches(`https://github.com/${PLANTED_USER}/other`, denylist).length, 1);
  });

  it('normalizes separators and case', () => {
    assert.equal(normalizeForMatch(`A${BACKSLASH}${BACKSLASH}B//C`), 'a/b/c');
  });

  it('matches names with or without diacritics, including the dotted and dotless i', () => {
    const denylist = parseDenylist(['Zed', 'Plan', 'ted'].join(''), 'file');
    for (const spelling of ['Zëd Plänted', 'ZED PLANTED', 'zed planted']) {
      assert.equal(findDenylistMatches(spelling.replace(' ', ''), denylist).length, 1, spelling);
    }
    const dotted = parseDenylist(['Kı', 'lıç'].join(''), 'file');
    assert.equal(findDenylistMatches(['KI', 'LIC'].join(''), dotted).length, 1);
    assert.equal(findDenylistMatches(['kİ', 'lİç'].join(''), dotted).length, 1);
  });

  it('parses the committed template without findings of its own', async () => {
    const template = await fs.readFile(path.join(REPO_ROOT, 'scripts', 'personal-data-denylist.example'), 'utf8');
    const denylist = parseDenylist(template, 'template');
    assert.ok(denylist.terms.length > 0);
    assert.ok(denylist.terms.every((term) => /placeholder/.test(term.normalized)));
    assert.deepEqual(template.split('\n').flatMap((line) => findBuiltInMatches(line)), []);
  });
});

describe('check-no-personal-data repository scan', () => {
  it('reports findings by entry number without printing denylist values', async (t) => {
    const sandbox = await useSandbox(t, 'genericity');
    const root = sandbox.path('repo');
    await writeTree(root, {
      'README.md': `# Demo\nBuilt by ${PLANTED_NAME}.\n`,
      'docs/guide.md': `Config lives in C:/Users/${PLANTED_USER}/AppData.\n`,
      'src/clean.js': 'export const home = "<home>";\n',
      'node_modules/dep/index.js': `// ${PLANTED_EMAIL}\n`,
      'assets/image.bin': Buffer.from([0, 1, 2, ...Buffer.from(PLANTED_NAME)]),
      '.personal-data-denylist': `${PLANTED_NAME}\n`,
    });
    const result = checkNoPersonalData({ root, env: {}, useGit: false });
    assert.equal(result.denylistTerms, 1);
    assert.deepEqual(result.findings.map((f) => [f.file, f.line, f.rule]), [
      ['README.md', 2, 'denylist'],
      ['docs/guide.md', 1, 'windows-home'],
    ]);
    const out = captureStream();
    const err = captureStream();
    assert.equal(main(['--root', root], { env: {}, stdout: out.stream, stderr: err.stream }), 1);
    const printed = out.chunks.join('') + err.chunks.join('');
    assert.ok(printed.includes('README.md:2 denylist: matches denylist entry 1'));
    assert.ok(!printed.includes(PLANTED_NAME));
    assert.ok(!printed.includes(PLANTED_USER));
  });

  it('reads the denylist from an explicit file and from the inline environment variable', async (t) => {
    const sandbox = await useSandbox(t, 'genericity');
    const root = sandbox.path('repo');
    const outsideList = sandbox.path('private-list.txt');
    await writeTree(root, { 'notes.md': `${PLANTED_STUDIO} and ${PLANTED_NAME}\n` });
    await fs.writeFile(outsideList, `${PLANTED_STUDIO}\n`);
    const fromFile = checkNoPersonalData({ root, env: { [DENYLIST_FILE_ENV]: outsideList }, useGit: false });
    assert.equal(fromFile.findings.length, 1);
    const both = checkNoPersonalData({ root, env: { [DENYLIST_ENV]: PLANTED_NAME }, denylistPath: outsideList, useGit: false });
    assert.deepEqual(both.findings.map((f) => f.detail), [
      'matches denylist entry 1 (private-list.txt)',
      `matches denylist entry 2 (${DENYLIST_ENV})`,
    ]);
    assert.throws(() => checkNoPersonalData({ root, denylistPath: sandbox.path('missing.txt'), useGit: false }), ConfigError);
  });

  it('refuses to run when git would commit the denylist file', async (t) => {
    const sandbox = await useSandbox(t, 'genericity');
    const root = sandbox.path('repo');
    await writeTree(root, { '.personal-data-denylist': `${PLANTED_NAME}\n`, 'a.md': 'clean\n' });
    execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
    assert.throws(() => checkNoPersonalData({ root, env: {} }), /would be committed/);

    await fs.writeFile(path.join(root, '.gitignore'), '.personal-data-denylist\n');
    const { files, viaGit } = listRepoFiles(root);
    assert.equal(viaGit, true);
    assert.deepEqual(files, ['.gitignore', 'a.md']);
    assert.equal(checkNoPersonalData({ root, env: {} }).findings.length, 0);
  });

  it('flags file and folder names that match the denylist', async (t) => {
    const sandbox = await useSandbox(t, 'genericity');
    const root = sandbox.path('repo');
    await writeTree(root, {
      [`test/fixtures/${PLANTED_STUDIO}-project/ProjectVersion.txt`]: 'm_EditorVersion: 6000.3.0f1\n',
      'clean.md': 'clean\n',
    });
    const result = checkNoPersonalData({ root, env: { [DENYLIST_ENV]: PLANTED_STUDIO }, useGit: false });
    assert.deepEqual(result.findings.map((f) => [f.file, f.line, f.rule]), [
      [`test/fixtures/${PLANTED_STUDIO}-project/ProjectVersion.txt`, 0, 'denylist'],
    ]);
    assert.equal(formatFinding(result.findings[0]), `test/fixtures/${PLANTED_STUDIO}-project/ProjectVersion.txt denylist: file path matches denylist entry 1 (${DENYLIST_ENV})`);
    assert.equal(formatFinding({ file: 'a.md', line: 3, column: 7, rule: 'email', detail: 'x' }), 'a.md:3:7 email: x');
    assert.equal(formatFinding({ file: 'a.md', line: 3, column: null, rule: 'denylist', detail: 'x' }), 'a.md:3 denylist: x');
    assert.deepEqual(scanPath('src/clean.js', parseDenylist(PLANTED_STUDIO, 'file')), []);
  });

  it('detects binary content', () => {
    assert.equal(isBinary(Buffer.from('text only')), false);
    assert.equal(isBinary(Buffer.from([65, 0, 66])), true);
  });

  it('parses arguments and rejects bad ones', () => {
    assert.deepEqual(parseArgs(['--root', 'x', '--denylist', 'y', '--json']), { root: 'x', denylistPath: 'y', json: true, help: false });
    assert.throws(() => parseArgs(['--root']), ConfigError);
    assert.throws(() => parseArgs(['--nope']), ConfigError);
    const err = captureStream();
    assert.equal(main(['--nope'], { env: {}, stdout: captureStream().stream, stderr: err.stream }), 2);
    assert.match(err.chunks.join(''), /Unknown argument/);
    const out = captureStream();
    assert.equal(main(['--help'], { env: {}, stdout: out.stream }), 0);
    assert.match(out.chunks.join(''), /Usage:/);
  });

  it('prints a JSON result and exits 0 when clean through the real script', async (t) => {
    const sandbox = await useSandbox(t, 'genericity');
    const root = sandbox.path('repo');
    await writeTree(root, { 'a.md': 'maintainer@example.com\n' });
    const child = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root, '--json'], { env: sandbox.env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const parsed = JSON.parse(child.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.scannedFiles, 1);
  });

  it('finds no personal data in this repository', () => {
    const result = checkNoPersonalData({ root: REPO_ROOT, env: process.env });
    assert.deepEqual(result.findings, []);
  });
});
