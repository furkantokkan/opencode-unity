// CP-D14: `project.json`, `facts.md` and `launch.json` are committed, so every path in them is relative
// and POSIX-separated whatever platform wrote them. A Windows-written `Assets\Scripts\Foo` does not
// resolve for the teammate on macOS, and `unity.facts-stale` hashes these paths - one separator flip
// would invalidate every `inputsHash` on the first cross-platform checkout. `local.json` is machine-local
// and keeps native separators.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildProjectJson, renderFacts } from '../../../src/facts/render.js';
import { collectStalenessInputs, getInputsHash } from '../../../src/facts/stale.js';
import { isProjectPath, joinProjectPath, toNativePath, toProjectPath, toRelativeProjectPath } from '../../../src/unity/fs-view.js';
import { scanUnityProject } from '../../../src/unity/scan.js';
import { listFixtureProjects, loadFixtureProject } from '../unity/fixture-projects.mjs';

describe('toProjectPath', () => {
  it('turns a Windows relative path into the committed form, on every platform', () => {
    assert.equal(toProjectPath('Assets\\Scripts\\Player.cs'), 'Assets/Scripts/Player.cs');
    assert.equal(toProjectPath('Assets/Scripts/Player.cs'), 'Assets/Scripts/Player.cs');
    assert.equal(toProjectPath('Assets\\Scripts/Mixed.cs'), 'Assets/Scripts/Mixed.cs');
  });

  it('drops the noise that makes two spellings of one path hash differently', () => {
    assert.equal(toProjectPath('./Assets/Scripts'), 'Assets/Scripts');
    assert.equal(toProjectPath('Assets//Scripts///Player.cs'), 'Assets/Scripts/Player.cs');
    assert.equal(toProjectPath('Assets/Scripts/'), 'Assets/Scripts');
    assert.equal(toProjectPath('.'), '');
    assert.equal(toProjectPath(''), '');
  });

  it('refuses every spelling of an absolute path, because P6 forbids them in a committed file', () => {
    for (const value of ['/home/dev/MyGame', 'C:\\Repos\\MyGame', 'C:/Repos/MyGame', '\\\\server\\share\\MyGame', '\\Assets']) {
      assert.throws(() => toProjectPath(value), /must be relative/, value);
    }
  });

  it('refuses a path that leaves the project root', () => {
    assert.throws(() => toProjectPath('../outside/Secret.cs'), /leaves the project root/);
    assert.throws(() => toProjectPath('Assets\\..\\..\\Secret.cs'), /leaves the project root/);
  });
});

describe('toRelativeProjectPath', () => {
  it('produces the same committed path from a Windows root and from a POSIX root', () => {
    assert.equal(
      toRelativeProjectPath('C:\\Repos\\MyGame', 'C:\\Repos\\MyGame\\Assets\\Scripts\\Player.cs', { platform: 'win32' }),
      'Assets/Scripts/Player.cs',
    );
    assert.equal(
      toRelativeProjectPath('/home/dev/MyGame', '/home/dev/MyGame/Assets/Scripts/Player.cs', { platform: 'linux' }),
      'Assets/Scripts/Player.cs',
    );
  });

  it('is empty at the root itself, which is what joinProjectPath expects', () => {
    assert.equal(toRelativeProjectPath('/home/dev/MyGame', '/home/dev/MyGame', { platform: 'linux' }), '');
  });

  it('refuses a path outside the root, including another drive', () => {
    assert.throws(() => toRelativeProjectPath('/home/dev/MyGame', '/home/dev/Other/x.cs', { platform: 'linux' }), /leaves the project root/);
    assert.throws(() => toRelativeProjectPath('C:\\Repos\\MyGame', 'D:\\Other\\x.cs', { platform: 'win32' }), /must be relative/);
  });
});

describe('toNativePath (local.json keeps native separators)', () => {
  it('spells a committed path for the local filesystem', () => {
    assert.equal(toNativePath('Assets/Scripts/Player.cs', { platform: 'win32' }), 'Assets\\Scripts\\Player.cs');
    assert.equal(toNativePath('Assets/Scripts/Player.cs', { platform: 'linux' }), 'Assets/Scripts/Player.cs');
    assert.equal(toNativePath('', { platform: 'win32' }), '');
  });

  it('round-trips through the committed form on either platform', () => {
    for (const platform of /** @type {NodeJS.Platform[]} */ (['win32', 'linux', 'darwin'])) {
      assert.equal(toProjectPath(toNativePath('Assets/Scripts/Player.cs', { platform })), 'Assets/Scripts/Player.cs');
    }
  });

  it('still resolves against a real root', () => {
    const root = process.platform === 'win32' ? 'C:\\Repos\\MyGame' : '/home/dev/MyGame';
    const committed = toRelativeProjectPath(root, joinProjectPath(root, 'Assets/Scripts/Player.cs'));
    assert.equal(committed, 'Assets/Scripts/Player.cs');
  });
});

describe('isProjectPath', () => {
  it('accepts a relative POSIX path and nothing else', () => {
    assert.equal(isProjectPath('Assets/Scripts/Player.cs'), true);
    assert.equal(isProjectPath('Packages'), true);
    for (const value of ['', 'Assets\\Scripts', '/Assets', 'C:/Assets', 'C:\\Assets', 'Assets//Scripts', 'Assets/./x', 'Assets/../x', 'Assets/']) {
      assert.equal(isProjectPath(value), false, value);
    }
  });

  it('rejects values that are not strings', () => {
    for (const value of [null, undefined, 42, {}, ['Assets']]) assert.equal(isProjectPath(value), false, String(value));
  });
});

/**
 * Every string anywhere in a value, with the key path that reached it.
 * @param {unknown} value
 * @param {string} [trail]
 * @returns {Array<[string, string]>}
 */
function collectStrings(value, trail = '') {
  if (typeof value === 'string') return [[trail, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectStrings(item, `${trail}[${index}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => collectStrings(item, trail ? `${trail}.${key}` : key));
}

describe('the scanner writes committed files in the committed form', () => {
  it('puts no backslash and no absolute path into project.json, for any fixture', () => {
    for (const name of listFixtureProjects()) {
      const { root, view } = loadFixtureProject(name);
      const scan = scanUnityProject(view, root, { env: {} });
      const document = buildProjectJson(scan, { inputsHash: getInputsHash(view, root) });
      for (const [key, value] of collectStrings(document)) {
        assert.ok(!value.includes('\\'), `${name}: ${key} carries a native separator: ${value}`);
        assert.ok(!/^(?:\/|[A-Za-z]:[/\\])/.test(value), `${name}: ${key} is absolute: ${value}`);
      }
    }
  });

  it('keeps the plain path fields in the exact committed form', () => {
    for (const name of listFixtureProjects()) {
      const { root, view } = loadFixtureProject(name);
      const scan = scanUnityProject(view, root, { env: {} });
      const document = buildProjectJson(scan, { inputsHash: '' });
      for (const assembly of document.assemblies) assert.ok(isProjectPath(assembly.folder), `${name}: ${assembly.folder}`);
      for (const file of document.largeFiles) assert.ok(isProjectPath(file.path), `${name}: ${file.path}`);
      // A compile-map prefix is a folder marker that keeps its trailing slash, so it is checked as a prefix.
      for (const row of document.compileMap) {
        assert.ok(row.prefix === '' || isProjectPath(row.prefix.replace(/\/$/, '')), `${name}: ${row.prefix}`);
      }
    }
  });

  it('puts no backslash into facts.md', () => {
    for (const name of listFixtureProjects()) {
      const { root, view } = loadFixtureProject(name);
      const facts = renderFacts(scanUnityProject(view, root, { env: {} }));
      assert.ok(!facts.text.includes('\\'), `${name}: facts.md carries a native separator`);
    }
  });

  it('hashes staleness inputs whose keys carry no separator of their own', () => {
    // The keys are the hash's preimage. A native separator in one would give the same checkout a different
    // `inputsHash` per platform, and every `start` after a cross-platform pull would offer `init --refresh`.
    for (const name of listFixtureProjects()) {
      const { root, view } = loadFixtureProject(name);
      for (const [key] of collectStalenessInputs(view, root, { env: {} })) {
        assert.ok(!key.includes('\\'), `${name}: staleness key carries a native separator: ${key}`);
      }
      assert.match(getInputsHash(view, root, { env: {} }), /^[0-9a-f]{64}$/);
    }
  });
});
