import assert from 'node:assert/strict';
import test from 'node:test';
import { getCompileCommand } from '../../../src/facts/compile-map.js';
import { buildProjectJson, FACTS_CAP, MAX_COMPILE_ROWS, renderFacts, validateProjectJson } from '../../../src/facts/render.js';
import { FACTS_GENERATOR_VERSION, getInputsHash } from '../../../src/facts/stale.js';
import { scanUnityProject } from '../../../src/unity/scan.js';
import { listFixtureProjects, loadFixtureProject } from '../unity/fixture-projects.mjs';

/**
 * @param {string} name
 * @returns {import('../../../src/unity/scan.js').ScanResult}
 */
function scanFixture(name) {
  const { root, view } = loadFixtureProject(name);
  return scanUnityProject(view, root, { env: {} });
}

const GOLDEN = [
  '# Project facts (opencode-unity init 0.1.0; edit if wrong; re-run init after package or asmdef changes)',
  '- Unity 6000.3, URP. VCS: git (writes denied; status/diff/log/show/blame allowed).',
  '- Tests: EditMode Game.Tests.EditMode (Assets/Game/Tests/EditMode); PlayMode Game.Tests.PlayMode (Assets/Game/Tests/PlayMode).',
  `- Compile check by folder (${getCompileCommand('<csproj>')}):`,
  '  Assets/Game/Tests/EditMode/ -> Game.Tests.EditMode.csproj',
  '  Assets/Game/Tests/PlayMode/ -> Game.Tests.PlayMode.csproj',
  '  Assets/Game/Editor/ -> Game.Editor.csproj',
  '  Assets/Plugins/ -> Assembly-CSharp-firstpass.csproj',
  '  Assets/Game/ -> Game.Runtime.csproj',
  '  other -> Assembly-CSharp.csproj',
  '- New, renamed or deleted .cs files are not in any .csproj until Unity regenerates project files.',
  '- UI: uGUI (2 scripts). Follow the screen you edit; ask before a new screen.',
  '- Input: Input System only (activeInputHandler 1). Never use UnityEngine.Input.',
  '- In use: UniTask, VContainer, Addressables. Do not add packages.',
  '- Naming: match the file. New files: private fields _camelCase (86% of 42), constants k_PascalCase (100% of 30).',
  '',
].join('\n');

test('the reference project renders the documented facts file', () => {
  const result = renderFacts(scanFixture('u6-urp-ugui-git'), { version: '0.1.0' });
  assert.equal(result.text, GOLDEN);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.truncated, false);
  assert.equal(result.length, result.text.length);
});

test('every fixture renders inside the cap, with no absolute path', () => {
  for (const name of listFixtureProjects()) {
    const result = renderFacts(scanFixture(name), { version: '0.1.0' });
    assert.ok(result.length <= FACTS_CAP, `${name} is ${result.length} characters`);
    assert.equal(/[A-Za-z]:[\\/]/.test(result.text), false, name);
    assert.equal(result.text.includes('\\'), false, name);
    assert.equal(result.text.startsWith('# Project facts (opencode-unity init 0.1.0;'), true, name);
  }
});

test('the editor agent line is added only when asked', () => {
  const scan = scanFixture('mcp-for-unity-installed');
  assert.equal(renderFacts(scan, { version: '0.1.0' }).text.includes('/ue <goal>'), false);
  assert.equal(renderFacts(scan, { version: '0.1.0', editorAgent: true }).text.includes('- Editor checks: /ue <goal>'), true);
});

test('missing project files and a missing .NET SDK replace the compile map', () => {
  const noProjects = renderFacts(scanFixture('no-csproj'), { version: '0.1.0' }).text;
  assert.match(noProjects, /Compile check unavailable: no \.csproj files yet/);
  assert.equal(noProjects.includes('-> Assembly-CSharp.csproj'), false);

  const { root, view } = loadFixtureProject('u6-urp-ugui-git');
  const noDotnet = renderFacts(scanUnityProject(view, root, { env: {}, dotnetSdks: [] }), { version: '0.1.0' }).text;
  assert.match(noDotnet, /Compile check unavailable: no \.NET SDK was found/);
});

test('stale project files add a line the agent must repeat', () => {
  const text = renderFacts(scanFixture('stale-csproj'), { version: '0.1.0' }).text;
  assert.match(text, /- Stale project files: 2 scripts or assemblies are in no \.csproj, for example Assets\/Tools\/Tools\.asmdef\./);
  assert.match(text, /Assets\/Tools\/ -> Game\.Tools\.csproj \(not generated\)/);
});

test('a project without tests or UI says so instead of inventing them', () => {
  const text = renderFacts(scanFixture('u6-hg-minimal'), { version: '0.1.0' }).text;
  assert.match(text, /- Tests: no test assemblies found; do not invent test projects\./);
  assert.match(text, /- UI: none detected\. Ask before adding UI\./);
  assert.match(text, /- Input: not detected in ProjectSettings\./);
  assert.match(text, /- Naming: match the file you edit\./);
});

/**
 * A project large enough to overflow the cap: many assemblies, libraries and large files.
 * @returns {import('../../../src/unity/scan.js').ScanResult}
 */
function overflowingScan() {
  const scan = scanFixture('u6-urp-ugui-git');
  for (let index = 0; index < 20; index += 1) {
    const assembly = `Game.Features.Subsystems.WithAVeryLongAssemblyName${index}`;
    scan.compileMap.unshift({
      prefix: `Assets/Game/Features/Subsystems/WithAnExtremelyLongFolderNameThatKeepsGoing${index}/`,
      assembly,
      csproj: `${assembly}.csproj`,
      command: getCompileCommand(`${assembly}.csproj`),
      source: 'asmdef',
      generated: true,
    });
  }
  scan.largeFiles = Array.from({ length: 5 }, (_, index) => ({
    path: `Assets/Game/Features/Subsystems/WithAnExtremelyLongFolderNameThatKeepsGoing${index}/HugeBehaviour${index}.cs`,
    lines: 2140 + index,
    truncated: false,
  }));
  return scan;
}

test('detail is dropped in the documented order until the facts fit', () => {
  const scan = overflowingScan();
  const full = renderFacts(scan, { version: '0.1.0', cap: 10_000 });
  assert.ok(full.length > FACTS_CAP);
  assert.match(full.text, /- Large files \(read by range\): Assets\/Game\/Features/);

  const capped = renderFacts(scan, { version: '0.1.0' });
  assert.ok(capped.length <= FACTS_CAP);
  assert.equal(capped.truncated, false);
  assert.deepEqual(capped.dropped, ['large files', 'libraries', 'naming details', 'UI counts', 'compile map rows']);
  assert.equal(capped.text.includes('Large files'), false);
  assert.equal(capped.text.includes('- In use:'), false);
  assert.match(capped.text, /- UI: uGUI\. Follow the screen you edit/);
  assert.match(capped.text, /- Naming: match the file\. New files: private fields _camelCase, constants k_PascalCase\./);
  assert.match(capped.text, /\(\+\d+ more folders; ask before compiling outside the ones listed\)/);
});

test('the compile map is capped at eight folders plus the default one', () => {
  const scan = overflowingScan();
  const rows = renderFacts(scan, { version: '0.1.0', cap: 10_000 })
    .text.split('\n')
    .filter((line) => line.startsWith('  Assets/'));
  assert.equal(rows.length, MAX_COMPILE_ROWS);
});

test('an impossible cap cuts at a line boundary and says so', () => {
  const result = renderFacts(scanFixture('u6-urp-ugui-git'), { version: '0.1.0', cap: 200 });
  assert.equal(result.truncated, true);
  assert.ok(result.length <= 200);
  assert.equal(result.text.endsWith('\n'), true);
  const tiny = renderFacts(scanFixture('u6-urp-ugui-git'), { version: '0.1.0', cap: 10 });
  assert.equal(tiny.text.length, 10);
});

test('project.json matches its schema for every fixture and holds no absolute path', () => {
  for (const name of listFixtureProjects()) {
    const { root, view } = loadFixtureProject(name);
    const scan = scanUnityProject(view, root, { env: {} });
    const project = buildProjectJson(scan, { version: '0.1.0', inputsHash: getInputsHash(view, root, { env: {} }) });
    assert.deepEqual(validateProjectJson(project), [], name);
    const text = JSON.stringify(project);
    assert.equal(/[A-Za-z]:[\\/]/.test(text), false, name);
    assert.equal(text.includes(root), false, name);
    assert.equal(project.generator.factsVersion, FACTS_GENERATOR_VERSION);
  }
});

test('project.json carries the fields the launcher and doctor need', () => {
  const { root, view } = loadFixtureProject('u6-urp-ugui-git');
  const scan = scanUnityProject(view, root, { env: {} });
  const project = buildProjectJson(scan, { version: '0.1.0', inputsHash: 'a'.repeat(64) });
  assert.deepEqual(project.unity, { version: '6000.3.8f1', stream: '6000.3', support: 'reference-tested', pipeline: 'URP' });
  assert.deepEqual(project.vcs.readOnlyAllow, ['git status *', 'git diff *', 'git log *', 'git show *', 'git blame *']);
  assert.deepEqual(project.vcs.writeDeny, ['git *', 'cm *', 'p4 *', 'svn *', 'hg *']);
  assert.equal(project.projectFiles.idePackage, 'com.unity.ide.visualstudio');
  assert.equal(project.compileMap.every((row) => row.command.startsWith('dotnet build ')), true);
  assert.deepEqual(
    project.assemblies.map((assembly) => `${assembly.name}:${assembly.isTest}:${assembly.testMode}`),
    [
      'Game.Editor:false:null',
      'Game.Runtime:false:null',
      'Game.Tests.EditMode:true:EditMode',
      'Game.Tests.PlayMode:true:PlayMode',
    ],
  );
  assert.equal(project.mcpForUnity.hubUrlSource, 'package-default');
  assert.equal(project.inputsHash, 'a'.repeat(64));
  const invalid = validateProjectJson({ ...project, schemaVersion: 2 });
  assert.equal(invalid.length > 0, true);
});
