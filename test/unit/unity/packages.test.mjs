import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createMemoryFsView } from '../../../src/unity/fs-view.js';
import {
  BUILT_IN_PIPELINE,
  createLibraryUsageCollector,
  detectPackages,
  extractSemver,
  findIdePackage,
  findPackage,
  getNotablePackages,
  getRenderPipeline,
  MAX_NOTABLE_PACKAGES,
} from '../../../src/unity/packages.js';
import { walkProject } from '../../../src/unity/walk.js';

const ROOT = process.platform === 'win32' ? 'C:\\package-tests' : '/package-tests';

/**
 * @param {Record<string, string>} tree
 */
function detect(tree) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
  return detectPackages(view, ROOT, walkProject(view, ROOT));
}

test('manifest, lock and embedded packages are merged', () => {
  const result = detect({
    'Packages/manifest.json': JSON.stringify({ dependencies: { 'com.unity.addressables': '2.3.1', 'com.example.tools': 'file:com.example.tools' } }),
    'Packages/packages-lock.json': JSON.stringify({
      dependencies: {
        'com.unity.addressables': { version: '2.3.1', depth: 0 },
        'com.unity.textmeshpro': { version: '3.2.0', depth: 1 },
      },
    }),
    'Packages/com.example.tools/package.json': JSON.stringify({ name: 'com.example.tools', version: '1.2.3' }),
    'Assets/Keep.cs': '',
  });
  assert.equal(result.manifestFound, true);
  assert.equal(result.lockFound, true);
  assert.deepEqual(
    result.packages.map((item) => `${item.id}@${item.version}${item.direct ? '' : ' (transitive)'}`),
    ['com.example.tools@1.2.3', 'com.unity.addressables@2.3.1', 'com.unity.textmeshpro@3.2.0 (transitive)'],
  );
  assert.equal(findPackage(result.packages, 'com.example.tools')?.folder, 'Packages/com.example.tools');
  assert.equal(findPackage(result.packages, 'com.example.tools')?.embedded, true);
  assert.equal(findPackage(result.packages, 'nothing'), null);
});

test('a missing or broken manifest is a warning, never a throw', () => {
  const missing = detect({ 'Assets/Keep.cs': '' });
  assert.equal(missing.manifestFound, false);
  assert.deepEqual(missing.warnings, ['Packages/manifest.json not found']);
  const broken = detect({ 'Packages/manifest.json': '{ "dependencies": ', 'Packages/packages-lock.json': '{oops}' });
  assert.equal(broken.manifestFound, false);
  assert.equal(broken.lockFound, false);
  assert.equal(broken.warnings.length, 2);
  assert.deepEqual(broken.packages, []);
});

test('an embedded package without a name is reported', () => {
  const result = detect({ 'Packages/manifest.json': '{}', 'Packages/broken/package.json': '{"version":"1.0.0"}' });
  assert.deepEqual(result.warnings, ['Packages/broken/package.json has no package name']);
});

test('the render pipeline comes from direct dependencies only', () => {
  assert.equal(detect({ 'Packages/manifest.json': JSON.stringify({ dependencies: { 'com.unity.render-pipelines.universal': '17.3.0' } }) }).pipeline, 'URP');
  assert.equal(
    detect({ 'Packages/manifest.json': JSON.stringify({ dependencies: { 'com.unity.render-pipelines.high-definition': '14.0.11' } }) }).pipeline,
    'HDRP',
  );
  const transitive = detect({
    'Packages/manifest.json': JSON.stringify({ dependencies: { 'com.unity.ugui': '2.0.0' } }),
    'Packages/packages-lock.json': JSON.stringify({ dependencies: { 'com.unity.render-pipelines.universal': { version: '17.3.0', depth: 1 } } }),
  });
  assert.equal(transitive.pipeline, BUILT_IN_PIPELINE);
  assert.equal(getRenderPipeline([]), BUILT_IN_PIPELINE);
});

test('packages of note keep allow-list order and stop at eight', () => {
  const ids = [
    'com.unity.inputsystem',
    'com.unity.ugui',
    'com.unity.textmeshpro',
    'com.unity.test-framework',
    'com.unity.addressables',
    'com.unity.cinemachine',
    'com.unity.netcode.gameobjects',
    'com.unity.entities',
    'com.unity.localization',
    'com.unity.ide.rider',
  ];
  const packages = ids.map((id) => ({ id, version: '1.0.0', reference: '1.0.0', direct: true, embedded: false, folder: null }));
  const notable = getNotablePackages(packages);
  assert.equal(notable.length, MAX_NOTABLE_PACKAGES);
  assert.equal(notable[0].name, 'Input System');
  assert.equal(notable.at(-1)?.name, 'Entities');
  assert.equal(findIdePackage(packages), 'com.unity.ide.rider');
  assert.equal(findIdePackage([]), null);
});

test('versions are read from registry entries, git tags and embedded manifests', () => {
  assert.equal(extractSemver('2.3.1'), '2.3.1');
  assert.equal(extractSemver('v1.0.0'), '1.0.0');
  assert.equal(extractSemver('https://example.invalid/pkg.git?path=/Pkg#v10.1.0'), '10.1.0');
  assert.equal(extractSemver('file:../local'), null);
  assert.equal(extractSemver(undefined), null);
  assert.equal(extractSemver('1.2.3-preview.4'), '1.2.3-preview.4');
});

test('libraries are found through the manifest or a using directive', () => {
  const packages = [{ id: 'jp.hadashikick.vcontainer', version: '1.16.9', reference: '1.16.9', direct: true, embedded: false, folder: null }];
  const collector = createLibraryUsageCollector();
  collector.add('using Cysharp.Threading.Tasks;\nclass A { }\n');
  collector.add('using Cysharp.Threading.Tasks.Linq;\nclass B { }\n');
  collector.add('class C { private Awaitable _wait; }\n');
  collector.add('// using Zenject; in a comment still counts as text, so use a real directive\nusing Zenject;\n');
  assert.deepEqual(collector.result(packages), [
    { name: 'UniTask', package: false, files: 2 },
    { name: 'Awaitable', package: false, files: 1 },
    { name: 'VContainer', package: true, files: 0 },
    { name: 'Zenject', package: false, files: 1 },
  ]);
  assert.deepEqual(createLibraryUsageCollector().result([]), []);
});
