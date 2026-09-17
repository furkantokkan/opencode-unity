import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { detectAssemblies, findOwningAssembly } from '../../../src/unity/assemblies.js';
import { createMemoryFsView } from '../../../src/unity/fs-view.js';
import { classifyTestAssembly, isTestRunnerReference, summarizeTests } from '../../../src/unity/tests.js';
import { walkProject } from '../../../src/unity/walk.js';

const ROOT = process.platform === 'win32' ? 'C:\\assembly-tests' : '/assembly-tests';
const RUNTIME_GUID = '1111111111111111111111111111aaaa';

/**
 * @param {Record<string, string>} tree
 */
function detect(tree) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
  return detectAssemblies(view, ROOT, walkProject(view, ROOT));
}

const meta = (guid) => `fileFormatVersion: 2\nguid: ${guid}\n`;

test('an asmdef is parsed with its platforms, constraints and references', () => {
  const result = detect({
    'Assets/Game/Game.Runtime.asmdef': JSON.stringify({
      name: 'Game.Runtime',
      includePlatforms: ['Editor', 'WindowsStandalone64'],
      excludePlatforms: ['Android'],
      defineConstraints: ['UNITY_2022_3_OR_NEWER'],
      references: ['Unity.TextMeshPro'],
      optionalUnityReferences: [],
    }),
    'Assets/Game/Game.Runtime.asmdef.meta': meta(RUNTIME_GUID),
  });
  assert.deepEqual(result.warnings, []);
  const [definition] = result.definitions;
  assert.equal(definition.name, 'Game.Runtime');
  assert.equal(definition.folder, 'Assets/Game');
  assert.equal(definition.csproj, 'Game.Runtime.csproj');
  assert.equal(definition.guid, RUNTIME_GUID);
  assert.deepEqual(definition.includePlatforms, ['Editor', 'WindowsStandalone64']);
  assert.deepEqual(definition.excludePlatforms, ['Android']);
  assert.deepEqual(definition.references, ['Unity.TextMeshPro']);
  assert.equal(definition.isTest, false);
});

test('GUID references resolve through .meta files, in either file order', () => {
  const result = detect({
    'Assets/A/A.asmdef': JSON.stringify({ name: 'A', references: [`GUID:${RUNTIME_GUID}`] }),
    'Assets/A/A.asmdef.meta': meta('2222222222222222222222222222bbbb'),
    'Assets/Z/Runtime.asmdef': JSON.stringify({ name: 'Game.Runtime', references: [] }),
    'Assets/Z/Runtime.asmdef.meta': meta(RUNTIME_GUID),
    'Assets/Ref/Game.Runtime.asmref': JSON.stringify({ reference: `GUID:${RUNTIME_GUID}` }),
    'Assets/Ref2/ByName.asmref': JSON.stringify({ reference: 'Game.Runtime' }),
    'Assets/Ref3/Unknown.asmref': JSON.stringify({ reference: 'GUID:0000000000000000000000000000dead' }),
  });
  assert.deepEqual(result.definitions.find((item) => item.name === 'A')?.references, ['Game.Runtime']);
  assert.deepEqual(
    result.references.map((item) => `${item.folder} -> ${item.assembly}`),
    ['Assets/Ref -> Game.Runtime', 'Assets/Ref2 -> Game.Runtime', 'Assets/Ref3 -> null'],
  );
  assert.deepEqual(result.warnings, ['Assets/Ref3/Unknown.asmref references an unknown assembly (GUID:0000000000000000000000000000dead)']);
});

test('broken, nameless and duplicate definitions are warnings', () => {
  const result = detect({
    'Assets/Bad/Bad.asmdef': '{ "name": ',
    'Assets/None/None.asmdef': '{ "references": [] }',
    'Assets/Empty/Empty.asmref': '{ }',
    'Assets/One/One.asmdef': '{ "name": "Same" }',
    'Assets/Two/Two.asmdef': '{ "name": "Same" }',
  });
  assert.deepEqual(result.warnings, [
    'Assets/Bad/Bad.asmdef is not valid JSON',
    'Assets/Empty/Empty.asmref has no reference',
    'Assets/None/None.asmdef has no assembly name',
    'assembly name Same is used by more than one .asmdef',
  ]);
  assert.equal(result.definitions.length, 2);
});

test('the owning assembly is the longest matching folder', () => {
  const result = detect({
    'Assets/Game/Game.asmdef': '{ "name": "Game" }',
    'Assets/Game/Ui/Game.Ui.asmdef': '{ "name": "Game.Ui" }',
  });
  assert.equal(findOwningAssembly(result.definitions, 'Assets/Game/Ui/Button.cs')?.name, 'Game.Ui');
  assert.equal(findOwningAssembly(result.definitions, 'Assets/Game/Player.cs')?.name, 'Game');
  assert.equal(findOwningAssembly(result.definitions, 'Assets/Other/Player.cs'), null);
});

test('test assemblies are recognised by constraint, reference, GUID or legacy option', () => {
  const base = { includePlatforms: [], defineConstraints: [], references: [], optionalUnityReferences: [] };
  assert.deepEqual(classifyTestAssembly({ ...base, defineConstraints: ['UNITY_INCLUDE_TESTS'], includePlatforms: ['Editor'] }), {
    isTest: true,
    testMode: 'EditMode',
  });
  assert.deepEqual(classifyTestAssembly({ ...base, references: ['UnityEngine.TestRunner'] }), { isTest: true, testMode: 'PlayMode' });
  assert.deepEqual(classifyTestAssembly({ ...base, references: ['GUID:0ACC523941302664DB1F4E527237FEB3'] }), { isTest: true, testMode: 'PlayMode' });
  assert.deepEqual(classifyTestAssembly({ ...base, optionalUnityReferences: ['TestAssemblies'], includePlatforms: ['Editor'] }), {
    isTest: true,
    testMode: 'EditMode',
  });
  assert.deepEqual(classifyTestAssembly({ ...base, includePlatforms: ['Editor', 'Android'], references: ['UnityEditor.TestRunner'] }), {
    isTest: true,
    testMode: 'PlayMode',
  });
  assert.deepEqual(classifyTestAssembly(base), { isTest: false, testMode: null });
  assert.equal(isTestRunnerReference('Game.Runtime'), false);
  assert.equal(isTestRunnerReference('GUID:27619889b8ba8c24980f49ee34dbb44a'), true);
});

test('tests are summarised EditMode first, with the Test Framework version', () => {
  const result = detect({
    'Assets/Tests/PlayMode/Play.asmdef': JSON.stringify({ name: 'B.Tests.PlayMode', references: ['UnityEngine.TestRunner'] }),
    'Assets/Tests/EditMode/Edit.asmdef': JSON.stringify({ name: 'A.Tests.EditMode', includePlatforms: ['Editor'], defineConstraints: ['UNITY_INCLUDE_TESTS'] }),
    'Assets/Game/Game.asmdef': '{ "name": "Game" }',
  });
  const packages = [{ id: 'com.unity.test-framework', version: '1.4.5', reference: '1.4.5', direct: true, embedded: false, folder: null }];
  assert.deepEqual(summarizeTests(result.definitions, packages), {
    assemblies: [
      { name: 'A.Tests.EditMode', folder: 'Assets/Tests/EditMode', mode: 'EditMode' },
      { name: 'B.Tests.PlayMode', folder: 'Assets/Tests/PlayMode', mode: 'PlayMode' },
    ],
    testFramework: { present: true, version: '1.4.5' },
  });
  assert.deepEqual(summarizeTests([], []).testFramework, { present: false, version: null });
});
