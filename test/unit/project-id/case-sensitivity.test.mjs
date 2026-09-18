// CP-D13: a project id folds case when the volume does, measured per root rather than read off
// `process.platform`. Every decision here is driven by an injected `statSync` and an injected platform,
// so the Windows rows, the macOS rows and the Linux rows all run on whichever machine runs the suite.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import nodeFs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildCaseProbePaths,
  clearCaseSensitivityCache,
  createCaseSensitivityCache,
  flipAsciiCase,
  foldIdentityPath,
  probeCaseInsensitive,
  resolveProjectIdentity,
  toAbsoluteProjectPath,
} from '../../../src/core/case-sensitivity.js';
import { sha256Hex, sha8 } from '../../../src/core/hash.js';
import { useSandbox } from '../../helpers/sandbox.mjs';

/**
 * @param {string} code
 * @returns {NodeJS.ErrnoException}
 */
function errnoError(code) {
  const error = /** @type {NodeJS.ErrnoException} */ (new Error(code));
  error.code = code;
  return error;
}

/**
 * A volume whose spelling rules are chosen by the test: `caseInsensitive` decides whether a lookup folds,
 * exactly as the real filesystem would.
 * @param {object} options
 * @param {Record<string, { ino: number | bigint, dev: number | bigint }>} options.entries
 * @param {boolean} options.caseInsensitive
 * @param {(filePath: string) => NodeJS.ErrnoException | null} [options.failFor]
 * @returns {{ statSync: (filePath: string) => { ino: number | bigint, dev: number | bigint }, calls: string[] }}
 */
function createVolume({ entries, caseInsensitive, failFor = () => null }) {
  const key = (/** @type {string} */ value) => (caseInsensitive ? value.toLowerCase() : value);
  const table = new Map(Object.entries(entries).map(([name, stat]) => [key(name), stat]));
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    statSync(filePath) {
      calls.push(filePath);
      const failure = failFor(filePath);
      if (failure) throw failure;
      const stat = table.get(key(filePath));
      if (!stat) throw errnoError('ENOENT');
      return stat;
    },
  };
}

describe('flipAsciiCase', () => {
  it('flips ASCII letters only, so the probe path differs in case and nothing else', () => {
    assert.equal(flipAsciiCase('MyGame'), 'mYgAME');
    assert.equal(flipAsciiCase('my-game.2026'), 'MY-GAME.2026');
    assert.equal(flipAsciiCase('1234'), '1234');
  });

  it('leaves non-ASCII alone, because its case mapping can change a string s length', () => {
    // 'ß'.toUpperCase() is two characters, which would probe a different name rather than a different case.
    assert.equal(flipAsciiCase('stra\u00dfe'), 'STRA\u00dfE');
    assert.equal(flipAsciiCase('\u4e0a\u6d77'), '\u4e0a\u6d77');
  });

  it('is its own inverse for ASCII, so the flip is deterministic', () => {
    assert.equal(flipAsciiCase(flipAsciiCase('Assets/MyGame')), 'Assets/MyGame');
  });
});

describe('buildCaseProbePaths', () => {
  it('flips the deepest segment that has a letter, on either platform', () => {
    assert.deepEqual(buildCaseProbePaths('C:\\Repos\\MyGame', { platform: 'win32' }), {
      subject: 'C:\\Repos\\MyGame',
      flipped: 'C:\\Repos\\mYgAME',
    });
    assert.deepEqual(buildCaseProbePaths('/home/dev/MyGame', { platform: 'linux' }), {
      subject: '/home/dev/MyGame',
      flipped: '/home/dev/mYgAME',
    });
  });

  it('walks up to the deepest ancestor that can be flipped when the leaf cannot be', () => {
    assert.deepEqual(buildCaseProbePaths('/srv/Games/2026/01', { platform: 'linux' }), {
      subject: '/srv/Games',
      flipped: '/srv/gAMES',
    });
  });

  it('returns null when no segment holds an ASCII letter, and at a filesystem root', () => {
    assert.equal(buildCaseProbePaths('/2026/01', { platform: 'linux' }), null);
    assert.equal(buildCaseProbePaths('/', { platform: 'linux' }), null);
    assert.equal(buildCaseProbePaths('C:\\', { platform: 'win32' }), null);
  });
});

describe('probeCaseInsensitive', () => {
  it('folds when both spellings reach the same entry', () => {
    const volume = createVolume({ caseInsensitive: true, entries: { '/Users/dev/MyGame': { ino: 11, dev: 7 } } });
    assert.deepEqual(probeCaseInsensitive('/Users/dev/MyGame', { fs: volume, platform: 'darwin', cache: createCaseSensitivityCache() }), {
      caseInsensitive: true,
      reason: 'same-inode',
      probedPath: '/Users/dev/mYgAME',
    });
  });

  it('does not fold when the flipped spelling is absent, which only a case-sensitive volume allows', () => {
    const volume = createVolume({ caseInsensitive: false, entries: { '/home/dev/MyGame': { ino: 11, dev: 7 } } });
    const result = probeCaseInsensitive('/home/dev/MyGame', { fs: volume, platform: 'linux', cache: createCaseSensitivityCache() });
    assert.deepEqual(result, { caseInsensitive: false, reason: 'flipped-absent', probedPath: '/home/dev/mYgAME' });
  });

  it('does not fold when both spellings exist as different directories', () => {
    const volume = createVolume({
      caseInsensitive: false,
      entries: { '/home/dev/MyGame': { ino: 11, dev: 7 }, '/home/dev/mYgAME': { ino: 12, dev: 7 } },
    });
    const result = probeCaseInsensitive('/home/dev/MyGame', { fs: volume, platform: 'linux', cache: createCaseSensitivityCache() });
    assert.deepEqual(result, { caseInsensitive: false, reason: 'distinct-inode', probedPath: '/home/dev/mYgAME' });
  });

  it('separates the volume from the entry: the same inode on another device is another entry', () => {
    const volume = createVolume({
      caseInsensitive: false,
      entries: { '/mnt/a/MyGame': { ino: 11, dev: 7 }, '/mnt/a/mYgAME': { ino: 11, dev: 8 } },
    });
    assert.equal(probeCaseInsensitive('/mnt/a/MyGame', { fs: volume, platform: 'linux', cache: createCaseSensitivityCache() }).caseInsensitive, false);
  });

  it('compares large inode numbers exactly, so two neighbours above 2^53 are still two entries', () => {
    const volume = createVolume({
      caseInsensitive: false,
      entries: { '/mnt/a/MyGame': { ino: 9007199254740993n, dev: 7n }, '/mnt/a/mYgAME': { ino: 9007199254740995n, dev: 7n } },
    });
    assert.equal(probeCaseInsensitive('/mnt/a/MyGame', { fs: volume, platform: 'linux', cache: createCaseSensitivityCache() }).reason, 'distinct-inode');
  });

  it('folds when the probe cannot see the volume: an unreadable flipped path is not evidence of anything', () => {
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ELOOP']) {
      const volume = createVolume({
        caseInsensitive: false,
        entries: { '/home/dev/MyGame': { ino: 11, dev: 7 } },
        failFor: (filePath) => (filePath.endsWith('mYgAME') ? errnoError(code) : null),
      });
      const result = probeCaseInsensitive('/home/dev/MyGame', { fs: volume, platform: 'linux', cache: createCaseSensitivityCache() });
      assert.deepEqual(result, { caseInsensitive: true, reason: 'stat-failed', probedPath: '/home/dev/mYgAME' }, code);
    }
  });

  it('folds when the project directory itself cannot be stat-ed, so `init` on a new path gets one id', () => {
    const volume = createVolume({ caseInsensitive: false, entries: {} });
    const result = probeCaseInsensitive('/home/dev/MyGame', { fs: volume, platform: 'linux', cache: createCaseSensitivityCache() });
    assert.deepEqual(result, { caseInsensitive: true, reason: 'stat-failed', probedPath: '/home/dev/mYgAME' });
  });

  it('folds when nothing can be flipped, and stats nothing', () => {
    const volume = createVolume({ caseInsensitive: false, entries: {} });
    const result = probeCaseInsensitive('/2026/01', { fs: volume, platform: 'linux', cache: createCaseSensitivityCache() });
    assert.deepEqual(result, { caseInsensitive: true, reason: 'no-cased-segment', probedPath: null });
    assert.deepEqual(volume.calls, []);
  });

  it('probes a root once', () => {
    const volume = createVolume({ caseInsensitive: true, entries: { '/Users/dev/MyGame': { ino: 11, dev: 7 } } });
    const cache = createCaseSensitivityCache();
    const first = probeCaseInsensitive('/Users/dev/MyGame', { fs: volume, platform: 'darwin', cache });
    const second = probeCaseInsensitive('/Users/dev/MyGame', { fs: volume, platform: 'darwin', cache });
    assert.deepEqual(second, first);
    assert.equal(volume.calls.length, 2, 'one subject stat and one flipped stat, not four');
  });

  it('keeps separate caches separate, so one test cannot answer another', () => {
    const insensitive = createVolume({ caseInsensitive: true, entries: { '/x/MyGame': { ino: 1, dev: 1 } } });
    const sensitive = createVolume({ caseInsensitive: false, entries: { '/x/MyGame': { ino: 1, dev: 1 } } });
    assert.equal(probeCaseInsensitive('/x/MyGame', { fs: insensitive, platform: 'darwin', cache: createCaseSensitivityCache() }).caseInsensitive, true);
    assert.equal(probeCaseInsensitive('/x/MyGame', { fs: sensitive, platform: 'linux', cache: createCaseSensitivityCache() }).caseInsensitive, false);
  });
});

describe('toAbsoluteProjectPath', () => {
  it('resolves against the given working directory and keeps the original case', () => {
    assert.equal(toAbsoluteProjectPath('MyGame', { platform: 'win32', cwd: 'C:\\Repos' }), 'C:\\Repos\\MyGame');
    assert.equal(toAbsoluteProjectPath('MyGame', { platform: 'linux', cwd: '/repos' }), '/repos/MyGame');
  });

  it('drops trailing separators without eating a filesystem root', () => {
    assert.equal(toAbsoluteProjectPath('C:\\Repos\\MyGame\\', { platform: 'win32', cwd: 'C:\\' }), 'C:\\Repos\\MyGame');
    assert.equal(toAbsoluteProjectPath('/repos/MyGame/', { platform: 'linux', cwd: '/' }), '/repos/MyGame');
    assert.equal(toAbsoluteProjectPath('C:\\', { platform: 'win32', cwd: 'C:\\' }), 'C:\\');
    assert.equal(toAbsoluteProjectPath('/', { platform: 'linux', cwd: '/' }), '/');
  });

  it('keeps a trailing backslash on POSIX, where it is part of the name and not a separator', () => {
    assert.equal(toAbsoluteProjectPath('/repos/odd\\', { platform: 'linux', cwd: '/' }), '/repos/odd\\');
  });
});

describe('foldIdentityPath', () => {
  it('folds only when asked', () => {
    assert.equal(foldIdentityPath('/Users/dev/MyGame', true), '/users/dev/mygame');
    assert.equal(foldIdentityPath('/Users/dev/MyGame', false), '/Users/dev/MyGame');
  });

  it('folds the same way under any locale, because the mapping is not locale-sensitive', () => {
    // A locale-sensitive fold would turn 'I' into a dotless i under tr-TR and give that machine its own id.
    assert.equal(foldIdentityPath('/repos/INPUT', true), '/repos/input');
  });
});

describe('resolveProjectIdentity and sha8 (the `<name>-<sha8>` id of spec 6.1)', () => {
  it('gives two spellings of one directory one id on a case-insensitive volume', () => {
    const entries = { '/Users/dev/Dev/MyGame': { ino: 11, dev: 7 } };
    const cache = createCaseSensitivityCache();
    const upper = resolveProjectIdentity('/Users/dev/Dev/MyGame', { fs: createVolume({ caseInsensitive: true, entries }), platform: 'darwin', cache });
    const lower = resolveProjectIdentity('/Users/dev/dev/mygame', { fs: createVolume({ caseInsensitive: true, entries }), platform: 'darwin', cache });
    assert.equal(upper.caseInsensitive, true);
    assert.equal(upper.identityPath, lower.identityPath);
    assert.equal(sha8(upper.identityPath), sha8(lower.identityPath));
    assert.equal(upper.absolutePath, '/Users/dev/Dev/MyGame', 'the unfolded path is still reported, for messages');
  });

  it('keeps two directories apart on a case-sensitive volume', () => {
    const entries = { '/home/dev/Dev/MyGame': { ino: 11, dev: 7 }, '/home/dev/dev/mygame': { ino: 12, dev: 7 } };
    const upper = resolveProjectIdentity('/home/dev/Dev/MyGame', { fs: createVolume({ caseInsensitive: false, entries }), platform: 'linux', cache: createCaseSensitivityCache() });
    const lower = resolveProjectIdentity('/home/dev/dev/mygame', { fs: createVolume({ caseInsensitive: false, entries }), platform: 'linux', cache: createCaseSensitivityCache() });
    assert.equal(upper.caseInsensitive, false);
    assert.notEqual(upper.identityPath, lower.identityPath);
    assert.notEqual(sha8(upper.identityPath), sha8(lower.identityPath));
  });

  it('folds an NTFS volume the same way, which is what the platform rule used to assume', () => {
    const volume = createVolume({ caseInsensitive: true, entries: { 'C:\\Repos\\MyGame': { ino: 0, dev: 0 } } });
    const identity = resolveProjectIdentity('C:\\Repos\\MyGame', { fs: volume, platform: 'win32', cwd: 'C:\\', cache: createCaseSensitivityCache() });
    assert.equal(identity.identityPath, 'c:\\repos\\mygame');
    assert.equal(identity.reason, 'same-inode');
  });

  it('skips the probe entirely when the caller already knows, so callers can stay pure', () => {
    const identity = resolveProjectIdentity('/home/dev/MyGame', { platform: 'linux', caseInsensitive: false });
    assert.deepEqual(identity, {
      absolutePath: '/home/dev/MyGame',
      identityPath: '/home/dev/MyGame',
      caseInsensitive: false,
      reason: 'given',
      probedPath: null,
    });
  });

  it('sha8 is the first 8 hex characters of the full digest', () => {
    assert.match(sha8('/home/dev/MyGame'), /^[0-9a-f]{8}$/);
    assert.equal(sha8('/home/dev/MyGame'), sha256Hex('/home/dev/MyGame').slice(0, 8));
  });
});

describe('probeCaseInsensitive on the real filesystem', () => {
  it('agrees with what the volume running this test actually does', async (t) => {
    const sandbox = await useSandbox(t, 'case-probe');
    const directory = sandbox.path('CaseProbe');
    await fsp.mkdir(directory, { recursive: true });

    const absolute = toAbsoluteProjectPath(directory);
    const result = probeCaseInsensitive(absolute, { cache: createCaseSensitivityCache() });
    assert.equal(result.probedPath, path.join(path.dirname(absolute), 'cASEpROBE'));
    assert.ok(['same-inode', 'distinct-inode', 'flipped-absent'].includes(result.reason), `undecided probe: ${result.reason}`);

    if (result.caseInsensitive) {
      const subject = nodeFs.statSync(directory);
      const flipped = nodeFs.statSync(/** @type {string} */ (result.probedPath));
      assert.equal(String(subject.ino), String(flipped.ino));
      assert.equal(String(subject.dev), String(flipped.dev));
    } else {
      assert.throws(() => nodeFs.statSync(/** @type {string} */ (result.probedPath)));
    }
  });

  it('exposes a process-wide cache that a test can clear', () => {
    clearCaseSensitivityCache();
    const volume = createVolume({ caseInsensitive: true, entries: { '/x/Cached': { ino: 1, dev: 1 } } });
    const first = probeCaseInsensitive('/x/Cached', { fs: volume, platform: 'darwin' });
    probeCaseInsensitive('/x/Cached', { fs: volume, platform: 'darwin' });
    assert.equal(volume.calls.length, 2, 'the second call came from the cache');
    clearCaseSensitivityCache();
    probeCaseInsensitive('/x/Cached', { fs: volume, platform: 'darwin' });
    assert.equal(volume.calls.length, 4);
    assert.equal(first.caseInsensitive, true);
    clearCaseSensitivityCache();
  });
});
