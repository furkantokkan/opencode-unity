// The secret-path half of the shared detector, reached from its network home (spec 12.3). The delegate
// lane's own suite covers the same matcher from the other side; these cases are the ones the shared
// module has to keep true for both callers.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_SENSITIVE_PATTERNS,
  createSensitiveMatcher,
  globToRegExp,
  isUncPath,
  normalizeWindowsPath,
  toPosix,
} from '../../../src/network/sensitive.js';

const POSIX_BASE = '/workspace';
const WINDOWS_BASE = 'C:/workspace';

/**
 * @param {NodeJS.Platform} platform
 * @param {readonly string[]} [extraPatterns]
 */
function matcher(platform, extraPatterns = []) {
  return createSensitiveMatcher({ platform, extraPatterns, realPath: () => null });
}

describe('secret paths', () => {
  it('refuses the files spec 12.3 names, on both separator families', () => {
    for (const [platform, base] of /** @type {Array<[NodeJS.Platform, string]>} */ ([['linux', POSIX_BASE], ['win32', WINDOWS_BASE]])) {
      const find = matcher(platform);
      for (const [file, pattern] of [
        ['.env', '.env'],
        ['app/.env.production', '.env.*'],
        ['certs/server.pem', '*.pem'],
        ['android/release.keystore', '*.keystore'],
        ['app/google-services.json', 'google-services*.json'],
        ['ci/ops-service-account.json', '*service-account*.json'],
        ['functions/.runtimeconfig.json', '*.runtimeconfig.json'],
        ['home/.npmrc', '.npmrc'],
        ['home/.git-credentials', '*credentials*'],
        ['home/id_ed25519', 'id_ed25519*'],
      ]) {
        assert.equal(find.find(`${base}/${file}`, base), pattern, `${platform}: ${file}`);
      }
    }
  });

  it('lets ordinary Unity files through', () => {
    const find = matcher('linux');
    for (const file of [
      'Assets/Scripts/PlayerController.cs',
      'Assets/Art/environment/Rock.prefab',
      'ProjectSettings/ProjectVersion.txt',
      'functions/package.json',
      'Packages/manifest.json',
    ]) {
      assert.equal(find.find(`${POSIX_BASE}/${file}`, POSIX_BASE), null, file);
    }
  });

  it('refuses .env.example too, which PROTECTED_READ allows: a refused file is only a file the delegate leaves out', () => {
    assert.equal(matcher('linux').find(`${POSIX_BASE}/.env.example`, POSIX_BASE), '.env.*');
  });

  it('folds case, because .ENV holds the same secrets as .env', () => {
    const find = matcher('linux');
    assert.equal(find.find(`${POSIX_BASE}/.ENV`, POSIX_BASE), '.env');
    assert.equal(find.find(`${POSIX_BASE}/certs/Server.PEM`, POSIX_BASE), '*.pem');
  });

  it('follows the real path, so a junction cannot hide a secret file', () => {
    const find = createSensitiveMatcher({
      platform: 'linux',
      realPath: (target) => (target.endsWith('/link') ? `${POSIX_BASE}/.env` : target),
    });
    assert.equal(find.find(`${POSIX_BASE}/link`, POSIX_BASE), '.env');
  });

  it('accepts extra patterns without changing what the defaults report', () => {
    const find = matcher('linux', ['ops/**', 'deploy.json']);
    assert.deepEqual(find.patterns.slice(0, DEFAULT_SENSITIVE_PATTERNS.length), [...DEFAULT_SENSITIVE_PATTERNS]);
    assert.equal(find.find(`${POSIX_BASE}/ops/keys/notes.txt`, POSIX_BASE), 'ops/**');
    assert.equal(find.find(`${POSIX_BASE}/.env`, POSIX_BASE), '.env');
  });

  it('sees through the Windows spellings of one file', () => {
    const find = matcher('win32');
    for (const spelling of ['C:/workspace/.env', 'C:\\workspace\\.env', '//?/C:/workspace/.env', '\\\\.\\C:\\workspace\\.env']) {
      assert.equal(find.find(spelling, WINDOWS_BASE), '.env', spelling);
    }
  });

  it('sees through an alternate data stream on Windows', () => {
    const find = matcher('win32');
    assert.equal(find.find('C:/workspace/.env:hidden', WINDOWS_BASE), '.env');
    assert.equal(find.find('C:/workspace/.env::$DATA', WINDOWS_BASE), '.env');
  });
});

describe('path helpers the other lanes share', () => {
  it('toPosix rewrites backslashes only', () => {
    assert.equal(toPosix('a\\b/c'), 'a/b/c');
    assert.equal(toPosix('a/b/c'), 'a/b/c');
  });

  it('isUncPath knows a share from a device path', () => {
    assert.ok(isUncPath('\\\\server\\share\\file'));
    assert.ok(isUncPath('//server/share/file'));
    assert.ok(!isUncPath('C:/workspace'));
    assert.ok(!isUncPath('//?/C:/workspace'));
  });

  it('normalizeWindowsPath resolves the device, UNC and admin-share spellings', () => {
    assert.equal(normalizeWindowsPath('//?/C:/x'), 'C:/x');
    assert.equal(normalizeWindowsPath('//?/UNC/server/share/x'), '//server/share/x');
    assert.equal(normalizeWindowsPath('//localhost/C$/x', { platform: 'win32' }), 'C:/x');
    assert.equal(normalizeWindowsPath('//server/share/x', { platform: 'win32' }), '//server/share/x');
  });

  it('globToRegExp keeps ** a whole segment and * inside one', () => {
    assert.ok(globToRegExp('a/**/b').test('a/x/y/b'));
    assert.ok(!globToRegExp('a/*/b').test('a/x/y/b'));
    assert.ok(globToRegExp('*.env').test('local.env'));
    assert.ok(!globToRegExp('*.env').test('dir/local.env'));
    assert.ok(globToRegExp('.ENV', { ignoreCase: true }).test('.env'));
  });

  it('globToRegExp keeps ? a single character inside one segment', () => {
    assert.ok(globToRegExp('id_?sa').test('id_rsa'));
    assert.ok(!globToRegExp('id_?sa').test('id_dsa_extra'));
    assert.ok(!globToRegExp('a?b').test('a/b'));
  });
});

describe('the real path, when nothing is injected', () => {
  it('resolves a real directory and swallows a path that is not there', () => {
    // The default `realPath` is `fs.realpathSync.native`: the branch the delegate lane runs in
    // production, and the one that has to stay quiet when a caller names a file that does not exist.
    const find = createSensitiveMatcher({});
    const root = process.cwd();
    assert.equal(find.find(path.join(root, 'package.json'), root), null);
    assert.equal(find.find(path.join(root, 'no-such-directory', '.env'), root), '.env');
  });
});
