import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createMemoryFsView } from '../../../src/unity/fs-view.js';
import { countInputActionAssets, createInputUsageCollector, readActiveInputHandler, summarizeInput } from '../../../src/unity/input.js';
import { countUiDocuments, createUiCollector, isEditorPath, summarizeUi, usesUgui, usesUiToolkit } from '../../../src/unity/ui.js';

const ROOT = process.platform === 'win32' ? 'C:\\ui-input-tests' : '/ui-input-tests';

test('uGUI and UI Toolkit usage is detected from source text', () => {
  assert.equal(usesUgui('using UnityEngine.UI;\n'), true);
  assert.equal(usesUgui('using TMPro;\n'), true);
  assert.equal(usesUgui('private Canvas _canvas;'), true);
  assert.equal(usesUgui('private CanvasGroupHelper _helper;'), false);
  assert.equal(usesUiToolkit('using UnityEngine.UIElements;\n'), true);
  assert.equal(usesUiToolkit('private UIDocument _document;'), true);
  assert.equal(usesUiToolkit('private VisualElement _root;'), true);
  assert.equal(usesUiToolkit('using UnityEngine;\n'), false);
});

test('files under an Editor folder do not decide the UI system', () => {
  assert.equal(isEditorPath('Assets/Game/Editor/Tool.cs'), true);
  assert.equal(isEditorPath('Assets/Game/editor/Tool.cs'), true);
  assert.equal(isEditorPath('Assets/Game/Editor.cs'), false);
  const collector = createUiCollector();
  collector.add('Assets/Game/Editor/Inspector.cs', 'using UnityEngine.UIElements;');
  collector.add('Assets/Game/Hud.cs', 'using UnityEngine.UI;');
  assert.deepEqual(collector.counts(), { uguiScripts: 1, uiToolkitScripts: 0 });
});

test('UI documents are counted outside Editor folders', () => {
  assert.deepEqual(countUiDocuments(['Assets/UI/Menu.uxml', 'Assets/UI/Menu.uss', 'Assets/Editor/Tool.uxml', 'Assets/UI/Menu.cs']), {
    uxml: 1,
    uss: 1,
  });
});

test('the UI verdict follows the counts', () => {
  assert.equal(summarizeUi({ uguiScripts: 3, uiToolkitScripts: 0, uxml: 0, uss: 0 }).verdict, 'uGUI');
  assert.equal(summarizeUi({ uguiScripts: 0, uiToolkitScripts: 0, uxml: 2, uss: 1 }).verdict, 'UI Toolkit');
  assert.equal(summarizeUi({ uguiScripts: 3, uiToolkitScripts: 1, uxml: 0, uss: 0 }).verdict, 'mixed');
  assert.equal(summarizeUi({ uguiScripts: 0, uiToolkitScripts: 0, uxml: 0, uss: 0 }).verdict, 'none');
});

test('activeInputHandler is read from ProjectSettings without parsing the YAML', () => {
  const settings = 'PlayerSettings:\n  productName: Fixture\n  activeInputHandler: 2\n  gcIncremental: 1\n';
  const view = createMemoryFsView({ [path.join(ROOT, 'ProjectSettings/ProjectSettings.asset')]: settings });
  assert.deepEqual(readActiveInputHandler(view, ROOT), { value: 2, line: 'activeInputHandler: 2' });
  assert.deepEqual(readActiveInputHandler(createMemoryFsView({}), ROOT), { value: null, line: null });
  const noKey = createMemoryFsView({ [path.join(ROOT, 'ProjectSettings/ProjectSettings.asset')]: 'PlayerSettings:\n  productName: Fixture\n' });
  assert.deepEqual(readActiveInputHandler(noKey, ROOT), { value: null, line: null });
});

test('a truncated settings file never reports a half-read line', () => {
  const filler = 'PlayerSettings:\n'.padEnd(5 * 1024 * 1024, ' ');
  const view = createMemoryFsView({ [path.join(ROOT, 'ProjectSettings/ProjectSettings.asset')]: `${filler}\n  activeInputHandler: 1\n` });
  assert.equal(readActiveInputHandler(view, ROOT).value, null);
});

test('legacy input calls are counted per call and per file', () => {
  const collector = createInputUsageCollector();
  collector.add('void Update() { Input.GetKeyDown(KeyCode.A); Input.GetAxis("x"); }');
  collector.add('void Update() { PlayerInput.GetActions(); }');
  collector.add('void Update() { Input.GetButton("Fire"); }');
  assert.deepEqual(collector.counts(), { legacyCalls: 3, legacyFiles: 2 });
  assert.equal(countInputActionAssets(['Assets/Settings/Controls.inputactions', 'Assets/Player.cs']), 1);
});

test('the input verdict follows activeInputHandler', () => {
  const packages = [{ id: 'com.unity.inputsystem', version: '1.11.2', reference: '1.11.2', direct: true, embedded: false, folder: null }];
  const base = { packages, inputActions: 1, legacyCalls: 0, legacyFiles: 0 };
  assert.equal(summarizeInput({ ...base, activeInputHandler: 0 }).verdict, 'legacy');
  assert.equal(summarizeInput({ ...base, activeInputHandler: 1 }).verdict, 'input-system');
  assert.equal(summarizeInput({ ...base, activeInputHandler: 2 }).verdict, 'both');
  const unknown = summarizeInput({ ...base, activeInputHandler: null });
  assert.equal(unknown.verdict, 'unknown');
  assert.equal(unknown.package, true);
  assert.equal(summarizeInput({ ...base, packages: [], activeInputHandler: 1 }).package, false);
});
