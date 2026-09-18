// The sensitive-file detector of the delegate lane (spec 12.3). Amendment 38.9 makes this the shared
// detector once S32 lands; these tests describe what the delegate needs from it either way.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_SENSITIVE_PATTERNS,
  createSensitiveMatcher,
  globToRegExp,
  isUncPath,
  normalizeWindowsPath,
  toPosix,
} from '../../src/delegate/sensitive.js';
import { useSandbox } from '../helpers/sandbox.mjs';

const BASE = process.platform === 'win32' ? 'C:/project' : '/project';

/**
 * @param {string[]} [extraPatterns]
 * @param {NodeJS.Platform} [platform]
 */
function matcher(extraPatterns = [], platform = process.platform) {
  return createSensitiveMatcher({ extraPatterns, platform, realPath: () => null });
}

describe('sensitive patterns', () => {
  it('refuses the secret files spec 8.5.2 and 12.3 name', () => {
    const find = matcher();
    for (const [file, pattern] of [
      ['.env', '.env'],
      ['.env.local', '.env.*'],
      ['config/private.pem', '*.pem'],
      ['keys/signing.keystore', '*.keystore'],
      ['app/google-services.json', 'google-services*.json'],
      ['ci/my-service-account.json', '*service-account*.json'],
      ['home/.npmrc', '.npmrc'],
      ['home/.netrc', '.netrc'],
      ['home/.git-credentials', '*credentials*'],
      ['home/id_rsa', 'id_rsa*'],
      ['home/id_ed25519.pub', 'id_ed25519*'],
      ['secrets/aws-credentials.txt', '*credentials*'],
    ]) {
      assert.equal(find.find(`${BASE}/${file}`, BASE), pattern, `${file} should match ${pattern}`);
    }
  });

  it('lets ordinary project files through', () => {
    const find = matcher();
    for (const file of ['Assets/Scripts/Player.cs', 'README.md', 'package.json', 'Assets/environment/Rock.prefab']) {
      assert.equal(find.find(`${BASE}/${file}`, BASE), null, `${file} should be allowed`);
    }
  });

  it('matches a bare pattern against any path segment and a slashed pattern against the path', () => {
    const find = matcher(['build/**', 'dist']);
    assert.equal(find.find(`${BASE}/build/out/app.js`, BASE), 'build/**');
    assert.equal(find.find(`${BASE}/packages/dist/app.js`, BASE), 'dist');
    assert.equal(find.find(`${BASE}/src/build.js`, BASE), null);
  });

  it('ignores case, because .ENV holds the same secrets as .env', () => {
    assert.equal(matcher().find(`${BASE}/.ENV`, BASE), '.env');
  });

  it('takes the extra patterns from config.json', () => {
    assert.equal(matcher(['*.licence']).find(`${BASE}/a.licence`, BASE), '*.licence');
    assert.ok(matcher(['*.licence']).patterns.length === DEFAULT_SENSITIVE_PATTERNS.length + 1);
  });

  it('follows a link that points at a secret file', async (t) => {
    const sandbox = await useSandbox(t, 'sensitive-link');
    const real = path.join(sandbox.root, '.env');
    const link = path.join(sandbox.root, 'notes.txt');
    await fs.writeFile(real, 'TOKEN=1', 'utf8');
    try {
      await fs.symlink(real, link);
    } catch {
      return; // Creating a symlink needs a privilege this machine does not grant; the rule is unit-tested above.
    }
    const find = createSensitiveMatcher({ platform: process.platform });
    assert.equal(find.find(link, sandbox.root), '.env');
  });
});

describe('path normalization', () => {
  it('rewrites the Windows spellings that name the same file', () => {
    assert.equal(normalizeWindowsPath('\\\\?\\C:\\project\\.env', { platform: 'win32' }), 'C:/project/.env');
    assert.equal(normalizeWindowsPath('\\\\.\\C:\\project\\.env', { platform: 'win32' }), 'C:/project/.env');
    assert.equal(normalizeWindowsPath('\\\\?\\UNC\\server\\share\\x', { platform: 'win32' }), '//server/share/x');
    assert.equal(normalizeWindowsPath('\\\\localhost\\C$\\project\\.env', { platform: 'win32' }), 'C:/project/.env');
  });

  it('leaves a plain path alone', () => {
    assert.equal(normalizeWindowsPath('C:/project/a.cs', { platform: 'win32' }), 'C:/project/a.cs');
    assert.equal(normalizeWindowsPath('/home/user/a.cs', { platform: 'linux' }), '/home/user/a.cs');
  });

  it('sees through the NTFS alternate-stream spelling of a secret file', () => {
    const find = matcher([], 'win32');
    assert.equal(find.find('C:/project/.env:$DATA', 'C:/project'), '.env');
  });

  it('recognises a UNC path', () => {
    assert.equal(isUncPath('\\\\server\\share\\x'), true);
    assert.equal(isUncPath('//server/share/x'), true);
    assert.equal(isUncPath('C:/project'), false);
    assert.equal(isUncPath('/home/user'), false);
  });

  it('converts separators without touching the rest', () => {
    assert.equal(toPosix('a\\b\\c'), 'a/b/c');
  });
});

describe('globToRegExp', () => {
  it('keeps a single star inside one segment and lets ** cross segments', () => {
    assert.equal(globToRegExp('*.cs').test('Player.cs'), true);
    assert.equal(globToRegExp('*.cs').test('a/Player.cs'), false);
    assert.equal(globToRegExp('src/**/*.cs').test('src/a/b/Player.cs'), true);
    assert.equal(globToRegExp('src/**/*.cs').test('src/Player.cs'), true);
  });

  it('matches one character for ? and nothing else for a literal', () => {
    assert.equal(globToRegExp('a?.cs').test('ab.cs'), true);
    assert.equal(globToRegExp('a?.cs').test('abc.cs'), false);
    assert.equal(globToRegExp('a+b.cs').test('a+b.cs'), true);
    assert.equal(globToRegExp('a+b.cs').test('axb.cs'), false);
  });
});
