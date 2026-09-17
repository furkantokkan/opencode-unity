import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCompileMap,
  DEFAULT_ASSEMBLY,
  EDITOR_ASSEMBLY,
  EDITOR_FIRSTPASS_ASSEMBLY,
  FIRSTPASS_ASSEMBLY,
  getCompileCommand,
  getFallbackAssembly,
  listCompileCsprojs,
  lookupCompileRow,
} from '../../../src/facts/compile-map.js';

/**
 * @param {string} name
 * @param {string} folder
 */
const asmdef = (name, folder) => ({
  name,
  file: `${folder}/${name}.asmdef`,
  folder,
  csproj: `${name}.csproj`,
  guid: null,
  includePlatforms: [],
  excludePlatforms: [],
  defineConstraints: [],
  references: [],
  optionalUnityReferences: [],
  isTest: false,
  testMode: null,
});

/**
 * @param {object} input
 */
const build = ({ definitions = [], references = [], sourceFiles = [], csprojNames = [] }) =>
  buildCompileMap({ definitions, references, sourceFiles, csprojNames });

test('the compile command is the one the agent runs', () => {
  assert.equal(getCompileCommand('Game.csproj'), 'dotnet build Game.csproj -nologo -tl:off -v q "-clp:ErrorsOnly;NoSummary"');
});

test('special folders decide the assembly for scripts without an asmdef', () => {
  assert.deepEqual(getFallbackAssembly('Assets/Plugins/Vendor/Lib.cs'), { prefix: 'Assets/Plugins/', assembly: FIRSTPASS_ASSEMBLY });
  assert.deepEqual(getFallbackAssembly('Assets/Plugins/Editor/Tool.cs'), { prefix: 'Assets/Plugins/Editor/', assembly: EDITOR_FIRSTPASS_ASSEMBLY });
  assert.deepEqual(getFallbackAssembly('Assets/Standard Assets/Move.cs'), { prefix: 'Assets/Standard Assets/', assembly: FIRSTPASS_ASSEMBLY });
  assert.deepEqual(getFallbackAssembly('Assets/Pro Standard Assets/Glow.cs'), { prefix: 'Assets/Pro Standard Assets/', assembly: FIRSTPASS_ASSEMBLY });
  assert.deepEqual(getFallbackAssembly('Assets/Game/Editor/Deep/Tool.cs'), { prefix: 'Assets/Game/Editor/', assembly: EDITOR_ASSEMBLY });
  assert.deepEqual(getFallbackAssembly('Assets/Game/editor/Tool.cs'), { prefix: 'Assets/Game/editor/', assembly: EDITOR_ASSEMBLY });
  assert.deepEqual(getFallbackAssembly('Assets/Game/Player.cs'), { prefix: 'Assets/', assembly: DEFAULT_ASSEMBLY });
  assert.deepEqual(getFallbackAssembly('Assets/Game/Editor.cs'), { prefix: 'Assets/', assembly: DEFAULT_ASSEMBLY });
  assert.equal(getFallbackAssembly('Packages/com.example/Runtime/Tool.cs'), null);
});

test('rows come from asmdefs, asmrefs, special folders and the default assembly', () => {
  const { rows } = build({
    definitions: [asmdef('Game.Runtime', 'Assets/Game'), asmdef('Inventory', 'Assets/Modules/Inventory')],
    references: [{ file: 'Assets/Extensions/Inventory.asmref', folder: 'Assets/Extensions', reference: 'Inventory', assembly: 'Inventory' }],
    sourceFiles: ['Assets/Game/Player.cs', 'Assets/Plugins/Vendor/Lib.cs', 'Assets/Scripts/Boot.cs', 'Packages/com.x/Runtime/Skip.cs'],
    csprojNames: ['Game.Runtime.csproj', 'Assembly-CSharp.csproj'],
  });
  assert.deepEqual(
    rows.map((row) => `${row.prefix}|${row.assembly}|${row.source}|${row.generated}`),
    [
      'Assets/Modules/Inventory/|Inventory|asmdef|false',
      'Assets/Extensions/|Inventory|asmref|false',
      'Assets/Plugins/|Assembly-CSharp-firstpass|special-folder|false',
      'Assets/Game/|Game.Runtime|asmdef|true',
      'Assets/|Assembly-CSharp|default|true',
    ],
  );
  assert.deepEqual(listCompileCsprojs(rows), [
    'Assembly-CSharp-firstpass.csproj',
    'Assembly-CSharp.csproj',
    'Game.Runtime.csproj',
    'Inventory.csproj',
  ]);
});

test('an Editor folder inside an asmdef belongs to that assembly', () => {
  const { rows } = build({
    definitions: [asmdef('Inventory', 'Assets/Modules/Inventory')],
    sourceFiles: ['Assets/Modules/Inventory/Editor/ItemEditor.cs', 'Assets/Tools/Editor/Tool.cs'],
  });
  assert.equal(rows.some((row) => row.prefix === 'Assets/Modules/Inventory/Editor/'), false);
  assert.equal(lookupCompileRow(rows, 'Assets/Modules/Inventory/Editor/ItemEditor.cs')?.assembly, 'Inventory');
  assert.equal(lookupCompileRow(rows, 'Assets/Tools/Editor/Tool.cs')?.assembly, EDITOR_ASSEMBLY);
});

test('the longest prefix wins, ignoring case', () => {
  const { rows } = build({
    definitions: [asmdef('Game', 'Assets/Game'), asmdef('Game.Ui', 'Assets/Game/Ui')],
    sourceFiles: ['Assets/Game/Ui/Button.cs'],
  });
  assert.equal(lookupCompileRow(rows, 'Assets/Game/Ui/Button.cs')?.assembly, 'Game.Ui');
  assert.equal(lookupCompileRow(rows, 'assets/game/ui/button.cs')?.assembly, 'Game.Ui');
  assert.equal(lookupCompileRow(rows, 'Assets/Game/Player.cs')?.assembly, 'Game');
  assert.equal(lookupCompileRow(rows, 'Packages/com.x/Runtime/Skip.cs'), null);
});

test('two assemblies in one folder are a warning, and the first one wins', () => {
  const { rows, warnings } = build({
    definitions: [asmdef('First', 'Assets/Game'), asmdef('Second', 'Assets/Game')],
    sourceFiles: ['Assets/Game/Player.cs'],
  });
  assert.deepEqual(warnings, ['Assets/Game/ maps to both First and Second']);
  assert.equal(lookupCompileRow(rows, 'Assets/Game/Player.cs')?.assembly, 'First');
});

test('an unresolved asmref adds no row, and rows exist even with no sources', () => {
  const { rows } = build({
    references: [{ file: 'Assets/X/Y.asmref', folder: 'Assets/X', reference: 'GUID:dead', assembly: null }],
  });
  assert.deepEqual(rows.map((row) => row.prefix), ['Assets/']);
  assert.equal(rows[0].source, 'default');
});
