import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { renderFacts } from '../../../src/facts/render.js';
import {
  NO_NEW_PACKAGES,
  PROTECTED_EDIT_SUMMARY,
  SHAPED_FORM_MAX_CHARS,
  readFactsRules,
  renderKeepClauses,
  renderShapedRequest,
} from '../../../src/shape/render.js';
import { FIELD_LIMITS } from '../../../src/shape/validate.js';
import { scanUnityProject } from '../../../src/unity/scan.js';
import { loadFixtureProject } from '../unity/fixture-projects.mjs';
import { SHAPE_FIXTURES_DIR } from './helpers.mjs';

const GOOD_FIELDS = Object.freeze({
  goal: 'Stop the inventory grid from re-allocating every frame.',
  files: ['Assets/Game/Inventory/InventoryView.cs', 'Assets/Game/Inventory/InventoryGrid.cs'],
  search: 'RefreshSlots',
  done: 'No per-frame allocation in the grid refresh path; Game.Runtime builds.',
  open: ['should empty slots still be rebuilt, or reused?'],
});

const FACTS = [
  '# Project facts',
  '- UI: uGUI (2 scripts). Follow the screen you edit; ask before a new screen.',
  '- Input: Input System only (activeInputHandler 1). Never use UnityEngine.Input.',
  '',
].join('\n');

/**
 * @param {string} name
 * @returns {string}
 */
function readGolden(name) {
  return fs.readFileSync(path.join(SHAPE_FIXTURES_DIR, 'golden', `${name}.txt`), 'utf8').replace(/\r?\n$/, '').replace(/\r\n/g, '\n');
}

describe('Keep: rendered locally, never by the model', () => {
  it('starts with the protected-edit summary, no new packages and no VCS writes', () => {
    assert.deepEqual(renderKeepClauses({ vcsKind: 'git', uiRule: null, inputRule: null }), [PROTECTED_EDIT_SUMMARY, NO_NEW_PACKAGES, 'no VCS writes']);
  });

  it('names the VCS when it is not git', () => {
    assert.equal(renderKeepClauses({ vcsKind: 'plastic', uiRule: null, inputRule: null })[2], 'no VCS writes (Unity Version Control)');
    assert.equal(renderKeepClauses({ vcsKind: 'perforce', uiRule: null, inputRule: null })[2], 'no VCS writes (Perforce)');
    assert.equal(renderKeepClauses({ vcsKind: null, uiRule: null, inputRule: null })[2], 'no VCS writes');
  });

  it('appends the UI and input rules exactly as facts.md words them', () => {
    const rules = readFactsRules(FACTS);
    assert.deepEqual(rules, {
      uiRule: 'UI: uGUI (2 scripts). Follow the screen you edit; ask before a new screen',
      inputRule: 'Input: Input System only (activeInputHandler 1). Never use UnityEngine.Input',
    });
    assert.deepEqual(renderKeepClauses({ vcsKind: 'git', ...rules }).slice(3), [rules.uiRule, rules.inputRule]);
  });

  it('finds both lines in what init really renders', () => {
    const fixture = loadFixtureProject('u6-urp-ugui-git');
    const facts = renderFacts(scanUnityProject(fixture.view, fixture.root, {})).text;
    const rules = readFactsRules(facts);
    assert.match(String(rules.uiRule), /^UI: /);
    assert.match(String(rules.inputRule), /^Input: /);
    assert.ok(facts.includes(`- ${rules.uiRule}.`));
  });

  it('reads nothing from a missing facts file or one without the lines', () => {
    assert.deepEqual(readFactsRules(null), { uiRule: null, inputRule: null });
    assert.deepEqual(readFactsRules('# Project facts\n- Naming: match the file.\n'), { uiRule: null, inputRule: null });
  });
});

describe('the shaped form', () => {
  it('matches the golden form for a git project with UI and input facts', () => {
    const rendered = renderShapedRequest(GOOD_FIELDS, renderKeepClauses({ vcsKind: 'git', ...readFactsRules(FACTS) }));
    assert.equal(rendered.text, readGolden('good-git-ugui-inputsystem'));
    assert.deepEqual(rendered.dropped, []);
    assert.equal(rendered.fields.keep, rendered.text.split('\n').find((line) => line.startsWith('Keep: '))?.slice('Keep: '.length));
  });

  it('matches the golden form for a Plastic project that was never initialised', () => {
    const rendered = renderShapedRequest(GOOD_FIELDS, renderKeepClauses({ vcsKind: 'plastic', uiRule: null, inputRule: null }));
    assert.equal(rendered.text, readGolden('good-plastic-no-facts'));
  });

  it('keeps the fixed label order and leaves empty lines out', () => {
    const rendered = renderShapedRequest({ goal: 'Fix the grid.', files: [], search: null, done: 'The grid works.', open: [] }, ['a', 'b', 'c']);
    assert.equal(rendered.text, 'Goal: Fix the grid.\nDone: The grid works.\nKeep: a; b; c');
  });

  it('is deterministic', () => {
    const keep = renderKeepClauses({ vcsKind: 'git', ...readFactsRules(FACTS) });
    assert.equal(renderShapedRequest(GOOD_FIELDS, keep).text, renderShapedRequest(GOOD_FIELDS, keep).text);
  });
});

describe('the 600-character cap and its drop order', () => {
  const longest = {
    goal: `Goal ${'g'.repeat(FIELD_LIMITS.goalChars - 5)}`,
    files: Array.from({ length: FIELD_LIMITS.maxFiles }, (_, index) => `Assets/Game/Very/Long/Folder/Name/Number${index}/Component${index}.cs`),
    search: 'SomeRatherLongIdentifierName',
    done: `Done ${'d'.repeat(FIELD_LIMITS.doneChars - 5)}`,
    open: Array.from({ length: FIELD_LIMITS.maxOpen }, (_, index) => `question ${index} ${'q'.repeat(FIELD_LIMITS.openChars - 12)}?`),
  };
  const keep = renderKeepClauses({ vcsKind: 'plastic', ...readFactsRules(FACTS) });

  it('always ends at or under the cap, keeping Goal, Done and the base Keep clauses', () => {
    const rendered = renderShapedRequest(longest, keep);
    assert.ok(rendered.text.length <= SHAPED_FORM_MAX_CHARS, String(rendered.text.length));
    assert.ok(rendered.text.startsWith(`Goal: ${longest.goal}\n`));
    assert.ok(rendered.text.includes(`Done: ${longest.done}`));
    assert.ok(rendered.text.includes(`Keep: ${keep.slice(0, 3).join('; ')}`));
  });

  it('drops the project rules first, then the search, then questions and files from the end', () => {
    const rendered = renderShapedRequest(longest, keep);
    assert.deepEqual(rendered.dropped.slice(0, 5), ['project rule', 'project rule', 'search', 'question', 'question']);
    assert.equal(rendered.fields.search, null);
    assert.ok(rendered.fields.open.length <= 1);
  });

  it('drops only as much as it has to', () => {
    const rendered = renderShapedRequest({ ...GOOD_FIELDS, goal: `Stop the grid ${'x'.repeat(120)}` }, keep);
    assert.ok(rendered.text.length <= SHAPED_FORM_MAX_CHARS);
    assert.deepEqual(rendered.dropped, ['project rule']);
    assert.ok(rendered.text.includes('UI: uGUI'));
  });
});
