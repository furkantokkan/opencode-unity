import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNodeFsView } from '../../../src/unity/fs-view.js';
import { isFirstPartySource, LARGE_FILE_LINES, MAX_LARGE_FILES, scanUnityProject } from '../../../src/unity/scan.js';
import { listFixtureProjects, loadFixtureProject, materializeFixtureProject } from './fixture-projects.mjs';

/**
 * @param {string} name
 * @param {{ env?: Record<string, string | undefined>, dotnetSdks?: string[] | null }} [options]
 */
function scanFixture(name, options = {}) {
  const { root, view } = loadFixtureProject(name);
  return scanUnityProject(view, root, { env: {}, ...options });
}

/**
 * @param {import('../../../src/unity/scan.js').ScanResult} scan
 */
const compileMapOf = (scan) => scan.compileMap.map((row) => `${row.prefix} -> ${row.csproj}${row.generated ? '' : ' (not generated)'}`);

test('every fixture project scans without a warning we did not plan for', () => {
  const names = listFixtureProjects();
  assert.deepEqual(names, [
    'dot-opencode-present',
    'mcp-for-unity-installed',
    'nested-agents-md',
    'no-csproj',
    'special-folders',
    'stale-csproj',
    'u2021-builtin-legacy-svn',
    'u2022-mixed-both-perforce',
    'u6-hg-minimal',
    'u6-uitk-inputsystem-plastic',
    'u6-urp-ugui-git',
  ]);
  for (const name of names) {
    const scan = scanFixture(name);
    assert.equal(scan.root.length > 0, true, name);
    assert.equal(scan.walk.truncated, false, name);
    assert.equal(scan.compileMap.length > 0, true, name);
  }
});

test('u6-urp-ugui-git: the reference shape of a Unity 6 project', () => {
  const scan = scanFixture('u6-urp-ugui-git');
  assert.equal(scan.projectName, 'u6-urp-ugui-git');
  assert.deepEqual(scan.unity, { editorVersion: '6000.3.8f1', stream: '6000.3', support: 'reference-tested', warnings: [] });
  assert.equal(scan.packages.pipeline, 'URP');
  assert.equal(scan.vcs.kind, 'git');
  assert.equal(scan.ui.verdict, 'uGUI');
  assert.equal(scan.input.verdict, 'input-system');
  assert.equal(scan.input.activeInputHandler, 1);
  assert.deepEqual(scan.tests.assemblies.map((assembly) => `${assembly.mode} ${assembly.name}`), [
    'EditMode Game.Tests.EditMode',
    'PlayMode Game.Tests.PlayMode',
  ]);
  assert.equal(scan.tests.testFramework.version, '1.4.5');
  assert.deepEqual(compileMapOf(scan), [
    'Assets/Game/Tests/EditMode/ -> Game.Tests.EditMode.csproj',
    'Assets/Game/Tests/PlayMode/ -> Game.Tests.PlayMode.csproj',
    'Assets/Game/Editor/ -> Game.Editor.csproj',
    'Assets/Plugins/ -> Assembly-CSharp-firstpass.csproj',
    'Assets/Game/ -> Game.Runtime.csproj',
    'Assets/ -> Assembly-CSharp.csproj',
  ]);
  assert.equal(scan.staleness.stale, false);
  assert.deepEqual(scan.librariesInUse, [
    { name: 'UniTask', package: true, files: 1 },
    { name: 'VContainer', package: true, files: 1 },
  ]);
  assert.deepEqual(scan.packages.notable.map((item) => item.name), [
    'Input System',
    'uGUI',
    'TextMeshPro',
    'Test Framework',
    'Addressables',
    'Visual Studio Editor',
  ]);
  assert.equal(scan.naming.categories.privateInstance.dominant, '_camel');
  assert.equal(scan.naming.categories.privateInstance.sampleSize, 42);
  assert.equal(scan.naming.categories.constants.dominant, 'k_Pascal');
  assert.deepEqual(scan.naming.serializeField, { serialized: 7, publicFields: 1, share: 0.875 });
  assert.equal(scan.naming.braces.dominant, 'Allman');
  assert.equal(scan.mcp.present, false);
  assert.equal(scan.opencodeDir, false);
  assert.equal(scan.local.expectedInstanceId.startsWith('u6-urp-ugui-git@'), true);
  assert.equal(scan.local.hubUrlSource, 'package-default');
});

test('third-party folders and cached packages never reach the sample', () => {
  const scan = scanFixture('u6-urp-ugui-git');
  // Assets/Plugins/Vendor/VendorWidget.cs has 12 m_Pascal fields and a uGUI using directive.
  assert.equal(scan.sources.files - scan.sources.firstParty, 1);
  assert.equal(scan.naming.categories.privateInstance.counts === undefined, true);
  assert.equal(scan.ui.uguiScripts, 2);
  assert.equal(isFirstPartySource('Assets/Plugins/Vendor/Lib.cs', []), false);
  assert.equal(isFirstPartySource('Assets/ThirdParty/Lib.cs', []), false);
  assert.equal(isFirstPartySource('Assets/TextMesh Pro/Lib.cs', []), false);
  assert.equal(isFirstPartySource('Assets/Game/Samples/Lib.cs', []), false);
  assert.equal(isFirstPartySource('Packages/com.example/Runtime/Lib.cs', []), false);
  assert.equal(isFirstPartySource('Assets/Game/Lib.cs', ['assets/game/']), false);
  assert.equal(isFirstPartySource('Assets/Game/Lib.cs', []), true);
});

test('u6-uitk-inputsystem-plastic: UI Toolkit, Plastic and .editorconfig rules', () => {
  const scan = scanFixture('u6-uitk-inputsystem-plastic');
  assert.equal(scan.ui.verdict, 'UI Toolkit');
  assert.deepEqual([scan.ui.uxml, scan.ui.uss, scan.ui.uiToolkitScripts], [1, 1, 1]);
  assert.equal(scan.vcs.kind, 'plastic');
  assert.equal(scan.input.inputActions, 1);
  assert.equal(scan.naming.categories.privateInstance.source, 'editorconfig');
  assert.equal(scan.naming.categories.privateInstance.dominant, 'm_Pascal');
  assert.equal(scan.naming.categories.constants.dominant, 'k_Pascal');
  assert.deepEqual(compileMapOf(scan), ['Assets/Scripts/Editor/ -> Assembly-CSharp-Editor.csproj', 'Assets/ -> Assembly-CSharp.csproj']);
});

test('u2022-mixed-both-perforce: HDRP, both input systems and mixed UI', () => {
  const scan = scanFixture('u2022-mixed-both-perforce');
  assert.equal(scan.unity.support, 'experimental');
  assert.equal(scan.packages.pipeline, 'HDRP');
  assert.equal(scan.ui.verdict, 'mixed');
  assert.equal(scan.input.verdict, 'both');
  assert.equal(scan.input.legacyCalls, 2);
  assert.equal(scan.vcs.kind, 'perforce');
  assert.deepEqual(scan.librariesInUse.map((library) => library.name), ['Zenject', 'Newtonsoft JSON']);
  assert.equal(scan.naming.categories.privateInstance.dominant, 'mixed');
  assert.ok(scan.warnings.some((warning) => warning.includes('2022.3 is experimental')));
});

test('u2021-builtin-legacy-svn: legacy input, legacy test assembly, K&R braces', () => {
  const scan = scanFixture('u2021-builtin-legacy-svn');
  assert.equal(scan.packages.pipeline, 'Built-in');
  assert.equal(scan.input.verdict, 'legacy');
  assert.equal(scan.vcs.kind, 'svn');
  assert.deepEqual(scan.tests.assemblies, [{ name: 'Legacy.Tests', folder: 'Assets/Tests', mode: 'EditMode' }]);
  assert.equal(scan.naming.categories.privateInstance.dominant, 'camel');
  assert.equal(scan.naming.braces.dominant, 'K&R');
  assert.equal(scan.naming.namespaces.share, 0);
});

test('u6-hg-minimal: no packages, no settings asset and no project files', () => {
  const scan = scanFixture('u6-hg-minimal');
  assert.equal(scan.vcs.kind, 'hg');
  assert.equal(scan.packages.manifestFound, false);
  assert.equal(scan.input.activeInputHandler, null);
  assert.equal(scan.input.verdict, 'unknown');
  assert.equal(scan.projectFiles.generated, false);
  assert.equal(scan.staleness.stale, false);
  assert.deepEqual(scan.warnings, ['Packages/manifest.json not found']);
});

test('no-csproj: the compile check is unavailable and no IDE package can regenerate', () => {
  const scan = scanFixture('no-csproj');
  assert.equal(scan.projectFiles.generated, false);
  assert.equal(scan.projectFiles.idePackage, null);
  assert.equal(scan.vcs.kind, 'none');
  assert.deepEqual(compileMapOf(scan), ['Assets/Core/ -> Game.Core.csproj (not generated)', 'Assets/ -> Assembly-CSharp.csproj (not generated)']);
});

test('stale-csproj: a new script and a whole new assembly are reported once each', () => {
  const scan = scanFixture('stale-csproj');
  assert.equal(scan.staleness.stale, true);
  assert.equal(scan.staleness.count, 2);
  assert.deepEqual(scan.staleness.examples, ['Assets/Tools/Tools.asmdef', 'Assets/Game/New.cs']);
  assert.equal(scan.projectFiles.idePackage, 'com.unity.ide.visualstudio');
});

test('special-folders: Unity assembly rules for Plugins, Editor and asmref folders', () => {
  const scan = scanFixture('special-folders');
  assert.deepEqual(compileMapOf(scan), [
    'Assets/Plugins/Vendor/Editor/ -> Assembly-CSharp-Editor-firstpass.csproj (not generated)',
    'Assets/Pro Standard Assets/ -> Assembly-CSharp-firstpass.csproj (not generated)',
    'Assets/Modules/Inventory/ -> Inventory.csproj',
    'Assets/Standard Assets/ -> Assembly-CSharp-firstpass.csproj (not generated)',
    'Assets/Scripts/Editor/ -> Assembly-CSharp-Editor.csproj (not generated)',
    'Assets/Extensions/ -> Inventory.csproj',
    'Assets/Plugins/ -> Assembly-CSharp-firstpass.csproj (not generated)',
    'Assets/Extras/ -> Inventory.csproj',
    'Assets/ -> Assembly-CSharp.csproj',
  ]);
  // The Editor folder inside an asmdef belongs to that assembly, not to Assembly-CSharp-Editor.
  assert.equal(scan.compileMap.some((row) => row.prefix === 'Assets/Modules/Inventory/Editor/'), false);
  assert.deepEqual(scan.assemblies.references.map((reference) => `${reference.folder} -> ${reference.assembly}`), [
    'Assets/Extensions -> Inventory',
    'Assets/Extras -> Inventory',
  ]);
  const files = scan.sources.files;
  assert.equal(files, 10, 'hidden folders, tilde folders and Library are not walked');
});

test('nested-agents-md: instruction files and an embedded package', () => {
  const scan = scanFixture('nested-agents-md');
  assert.deepEqual(scan.instructionFiles.map((file) => `${file.scope}:${file.path}`), [
    'upward:AGENTS.md',
    'nested:Assets/Game/AGENTS.md',
    'nested:Assets/Game/Combat/CLAUDE.md',
    'nested:Packages/com.example.tools/AGENTS.md',
  ]);
  assert.ok(scan.instructionFiles.every((file) => file.tokens > 0));
  assert.equal(scan.sources.firstParty, 1, 'the embedded package is not first-party code');
  assert.deepEqual(compileMapOf(scan), [
    'Packages/com.example.tools/Runtime/ -> Example.Tools.csproj',
    'Assets/ -> Assembly-CSharp.csproj',
  ]);
});

test('mcp-for-unity-installed: the package version comes from the git tag', () => {
  const scan = scanFixture('mcp-for-unity-installed');
  assert.deepEqual(scan.mcp, { present: true, version: '10.1.0', testedVersion: true, folder: null });
});

test('dot-opencode-present: the .opencode folder is reported and warned about', () => {
  const scan = scanFixture('dot-opencode-present');
  assert.equal(scan.opencodeDir, true);
  assert.equal(scan.vcs.kind, 'git');
  assert.deepEqual(scan.warnings, [
    'the project has an .opencode folder; OpenCode writes a .gitignore and installs node_modules there at every start',
  ]);
});

test('an untested MCP for Unity version is a warning', () => {
  const { root, view } = loadFixtureProject('mcp-for-unity-installed');
  assert.deepEqual(scanUnityProject(view, root, { env: {} }).warnings, []);
  const older = loadFixtureProject('mcp-for-unity-installed', {
    extra: {
      [path.join(root, 'Packages/manifest.json')]: JSON.stringify({ dependencies: { 'com.coplaydev.unity-mcp': '9.5.0' } }),
      [path.join(root, 'Packages/packages-lock.json')]: JSON.stringify({ dependencies: { 'com.coplaydev.unity-mcp': { version: '9.5.0', depth: 0 } } }),
    },
  });
  const scan = scanUnityProject(older.view, older.root, { env: {} });
  assert.equal(scan.mcp.testedVersion, false);
  assert.deepEqual(scan.warnings, ['MCP for Unity 9.5.0 is installed; only 10.1.0 was tested']);
});

test('the hub URL and instance id come from the environment and the project path', () => {
  const { root, view } = loadFixtureProject('mcp-for-unity-installed', {
    extra: {
      [path.join(process.platform === 'win32' ? 'C:\\home\\example' : '/home/example', '.config/opencode/opencode.json')]: JSON.stringify({
        mcp: { unityMCP: { type: 'remote', url: 'http://127.0.0.1:8099/mcp' } },
      }),
    },
  });
  const scan = scanUnityProject(view, root, { env: { USERPROFILE: process.platform === 'win32' ? 'C:\\home\\example' : '/home/example' } });
  assert.equal(scan.local.hubUrl, 'http://127.0.0.1:8099/mcp');
  assert.equal(scan.local.hubUrlSource, 'opencode-config');
  assert.equal(scan.local.hubLoopback, true);
  assert.equal(scan.local.editorWindowTitlePrefix, 'mcp-for-unity-installed - ');
});

test('scanning the same project twice gives the same result', () => {
  const first = scanFixture('u6-urp-ugui-git');
  const second = scanFixture('u6-urp-ugui-git');
  assert.deepEqual(second, first);
});

test('large files are listed by size, capped at five', () => {
  const { root, view } = loadFixtureProject('u6-hg-minimal', {});
  const scan = scanUnityProject(view, root, { env: {} });
  assert.deepEqual(scan.largeFiles, []);
  const big = loadFixtureProject('u6-hg-minimal', {
    extra: Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        path.join(root, `Assets/Scripts/Big${index}.cs`),
        `class Big${index} {\n${'    // line\n'.repeat(LARGE_FILE_LINES + index)}}\n`,
      ]),
    ),
  });
  const scanBig = scanUnityProject(big.view, big.root, { env: {} });
  assert.equal(scanBig.largeFiles.length, MAX_LARGE_FILES);
  assert.equal(scanBig.largeFiles[0].path, 'Assets/Scripts/Big5.cs');
  assert.ok(scanBig.largeFiles[0].lines > LARGE_FILE_LINES);
});

test('the .NET SDK result is carried through when the caller ran it', () => {
  assert.deepEqual(scanFixture('u6-hg-minimal').dotnet, { checked: false, present: false, sdks: [] });
  assert.deepEqual(scanFixture('u6-hg-minimal', { dotnetSdks: [] }).dotnet, { checked: true, present: false, sdks: [] });
  assert.deepEqual(scanFixture('u6-hg-minimal', { dotnetSdks: ['9.0.100'] }).dotnet, { checked: true, present: true, sdks: ['9.0.100'] });
});

test('the scanner works on the real filesystem and writes nothing', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-unity-scan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = materializeFixtureProject('u6-urp-ugui-git', path.join(directory, 'SampleGame'));
  const before = fs.readdirSync(root).sort();
  const scan = scanUnityProject(createNodeFsView(), path.join(root, 'Assets', 'Game'), { env: {} });
  assert.equal(scan.root, root);
  assert.equal(scan.projectName, 'SampleGame');
  assert.equal(scan.vcs.kind, 'git', 'the .git directory created for the test is found');
  assert.equal(scan.ui.verdict, 'uGUI');
  assert.equal(scan.staleness.stale, false);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
});

test('the walk cap is reported as a warning', () => {
  const { root, view } = loadFixtureProject('u6-urp-ugui-git');
  const scan = scanUnityProject(view, root, { env: {}, maxWalkEntries: 5 });
  assert.equal(scan.walk.truncated, true);
  assert.match(scan.warnings[0], /stopped early/);
});
