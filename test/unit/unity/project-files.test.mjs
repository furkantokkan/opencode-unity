import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildCompileMap } from '../../../src/facts/compile-map.js';
import { detectAssemblies } from '../../../src/unity/assemblies.js';
import { createMemoryFsView } from '../../../src/unity/fs-view.js';
import { detectProjectFiles, findStaleness, parseCompileItems, parseDotnetSdks } from '../../../src/unity/project-files.js';
import { extensionOf, walkProject } from '../../../src/unity/walk.js';

const ROOT = process.platform === 'win32' ? 'C:\\project-file-tests' : '/project-file-tests';

const csproj = (items) =>
  `<Project>\n  <ItemGroup>\n${items.map((item) => `    <Compile Include="${item.split('/').join('\\')}" />`).join('\n')}\n  </ItemGroup>\n</Project>\n`;

/**
 * @param {Record<string, string>} tree
 */
function scanTree(tree) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
  const index = walkProject(view, ROOT);
  const assemblies = detectAssemblies(view, ROOT, index);
  const projectFiles = detectProjectFiles(view, ROOT, { packages: [] });
  const sourceFiles = index.files.filter((file) => extensionOf(file) === '.cs');
  const compileMap = buildCompileMap({
    definitions: assemblies.definitions,
    references: assemblies.references,
    sourceFiles,
    csprojNames: projectFiles.csproj.map((file) => file.name),
  });
  return { projectFiles, assemblies, sourceFiles, compileMap: compileMap.rows };
}

test('Compile items are read with Windows separators, escapes and attribute order', () => {
  const text = [
    '<Compile Include="Assets\\Game\\Player.cs" />',
    '<Compile Include="Assets\\Game\\A&amp;B.cs" />',
    '<Compile Include="Assets\\Game\\Space%20Name.cs" />',
    '<Compile Update="Assets\\Game\\Ignored.cs" />',
    '<Compile Condition="true" Include="Assets\\Game\\Conditional.cs" />',
    '<None Include="Assets\\Game\\Readme.txt" />',
  ].join('\n');
  assert.deepEqual(parseCompileItems(text), [
    'Assets/Game/Player.cs',
    'Assets/Game/A&B.cs',
    'Assets/Game/Space Name.cs',
    'Assets/Game/Conditional.cs',
  ]);
  assert.deepEqual(parseCompileItems('<Compile Include="" />'), []);
});

test('root .csproj, .sln and .slnx files are listed with the IDE package', () => {
  const view = createMemoryFsView({
    [path.join(ROOT, 'Assembly-CSharp.csproj')]: csproj(['Assets/A.cs']),
    [path.join(ROOT, 'Game.sln')]: 'solution',
    [path.join(ROOT, 'Game.slnx')]: 'solution',
    [path.join(ROOT, 'notes.txt')]: 'x',
    [path.join(ROOT, 'Assets/A.cs')]: '',
  });
  const packages = [{ id: 'com.unity.ide.visualstudio', version: '2.0.22', reference: '2.0.22', direct: true, embedded: false, folder: null }];
  const result = detectProjectFiles(view, ROOT, { packages });
  assert.deepEqual(result.csproj.map((file) => file.name), ['Assembly-CSharp.csproj']);
  assert.deepEqual(result.solutions, ['Game.sln', 'Game.slnx']);
  assert.equal(result.idePackage, 'com.unity.ide.visualstudio');
  assert.equal(result.generated, true);
  assert.equal(result.csproj[0].compileCount, 1);
  assert.ok(result.compileItems.has('assets/a.cs'));
});

test('an unreadable .csproj is reported and counted as not readable', () => {
  const view = createMemoryFsView({ [path.join(ROOT, 'Huge.csproj')]: 'x'.repeat(32 * 1024 * 1024) });
  const result = detectProjectFiles(view, ROOT);
  assert.deepEqual(result.warnings, ['Huge.csproj could not be read']);
  assert.equal(result.generated, false);
  assert.equal(result.csproj[0].readable, false);
});

test('staleness lists new scripts and assemblies with no project file', () => {
  const tree = {
    'Assets/Game/Game.Core.asmdef': '{ "name": "Game.Core" }',
    'Assets/Game/Old.cs': '',
    'Assets/Game/New.cs': '',
    'Assets/Tools/Tools.asmdef': '{ "name": "Game.Tools" }',
    'Assets/Tools/Exporter.cs': '',
    'Assets/Loose.cs': '',
    'Game.Core.csproj': csproj(['Assets/Game/Old.cs', 'Assets/Game/Deleted.cs']),
    'Assembly-CSharp.csproj': csproj(['Assets/Loose.cs']),
  };
  const { projectFiles, assemblies, sourceFiles, compileMap } = scanTree(tree);
  const staleness = findStaleness({ projectFiles, compileMap, definitions: assemblies.definitions, sourceFiles });
  assert.equal(staleness.stale, true);
  // The whole Game.Tools assembly is reported once, not once per script inside it.
  assert.deepEqual(staleness.examples, ['Assets/Tools/Tools.asmdef', 'Assets/Game/New.cs']);
  assert.equal(staleness.count, 2);
  assert.equal(staleness.missingAssemblies, 1);
  assert.equal(staleness.missingScripts, 1);
});

test('a project with no .csproj is not stale, only ungenerated', () => {
  const { projectFiles, assemblies, sourceFiles, compileMap } = scanTree({
    'Assets/Game/Game.asmdef': '{ "name": "Game" }',
    'Assets/Game/Player.cs': '',
  });
  assert.equal(projectFiles.generated, false);
  assert.deepEqual(findStaleness({ projectFiles, compileMap, definitions: assemblies.definitions, sourceFiles }), {
    stale: false,
    count: 0,
    examples: [],
    missingScripts: 0,
    missingAssemblies: 0,
  });
});

test('at most five stale examples are kept', () => {
  /** @type {Record<string, string>} */
  const tree = { 'Assembly-CSharp.csproj': csproj([]) };
  for (let index = 0; index < 8; index += 1) tree[`Assets/File${index}.cs`] = '';
  const { projectFiles, assemblies, sourceFiles, compileMap } = scanTree(tree);
  const staleness = findStaleness({ projectFiles, compileMap, definitions: assemblies.definitions, sourceFiles });
  assert.equal(staleness.count, 8);
  assert.equal(staleness.examples.length, 5);
});

test('dotnet --list-sdks output is parsed', () => {
  const stdout = ['8.0.404 [C:\\Program Files\\dotnet\\sdk]', '9.0.100 [C:\\Program Files\\dotnet\\sdk]', 'garbage'].join('\r\n');
  assert.deepEqual(parseDotnetSdks(stdout), ['8.0.404', '9.0.100']);
  assert.deepEqual(parseDotnetSdks(''), []);
});
