import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findProtectedEditGlob } from '../../../src/delegate/protected-files.js';
import { FIELD_LIMITS, MISSING_PATH_QUESTION, cleanText, neutralize, validateShapedOutput } from '../../../src/shape/validate.js';
import { readModelReply } from './helpers.mjs';

const REQUEST = 'the inventory is broken';
const INDEX = new Set([
  'Assets/Game/Inventory/InventoryView.cs',
  'Assets/Game/Inventory/InventoryGrid.cs',
  'Assets/Game/Inventory/InventoryModel.cs',
  'Assets/Game/Game.Runtime.asmdef',
  'Assets/Scenes/Main.unity',
]);

/**
 * @param {Partial<import('../../../src/shape/validate.js').ValidationContext>} [overrides]
 * @returns {import('../../../src/shape/validate.js').ValidationContext}
 */
function context(overrides = {}) {
  return {
    request: REQUEST,
    isIndexMember: (path) => INDEX.has(path),
    findLiteral: (literal) => literal === 'RefreshSlots',
    findProtectedGlob: (path) => findProtectedEditGlob(path),
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
function reply(fields) {
  return JSON.stringify({ goal: 'Fix the broken inventory refresh.', files: [], search: '', done: 'The inventory refreshes once per change.', open: [], ...fields });
}

/**
 * @param {import('../../../src/shape/validate.js').ValidationResult} result
 * @returns {Extract<import('../../../src/shape/validate.js').ValidationResult, { ok: true }>}
 */
function accepted(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return /** @type {any} */ (result);
}

describe('V-SH1: JSON that matches the schema', () => {
  it('accepts a complete object', () => {
    const result = accepted(validateShapedOutput(reply({}), context()));
    assert.equal(result.fields.goal, 'Fix the broken inventory refresh.');
    assert.equal(result.fields.search, null);
  });

  it('rejects prose, a missing key, a wrong type and an empty goal', () => {
    for (const content of [readModelReply('not-json'), readModelReply('missing-key'), reply({ open: 'one question' }), reply({ files: [3] }), reply({ goal: '  ' })]) {
      const result = validateShapedOutput(content, context());
      assert.equal(result.ok, false);
      assert.equal(/** @type {any} */ (result).reason, 'invalid_output');
      assert.equal(/** @type {any} */ (result).check, 'V-SH1');
    }
  });

  it('ignores keys the schema does not name, so a plan field can never be rendered', () => {
    const result = accepted(validateShapedOutput(reply({ plan: ['step one', 'step two'] }), context()));
    assert.deepEqual(Object.keys(result.fields).sort(), ['done', 'files', 'goal', 'open', 'search']);
  });
});

describe('V-SH2: every path is an index member', () => {
  it('keeps members after separator normalisation', () => {
    const result = accepted(validateShapedOutput(reply({ files: ['Assets\\Game\\Inventory\\InventoryView.cs', './Assets/Game/Inventory/InventoryGrid.cs'] }), context()));
    assert.deepEqual(result.fields.files, ['Assets/Game/Inventory/InventoryView.cs', 'Assets/Game/Inventory/InventoryGrid.cs']);
    assert.deepEqual(result.fields.open, []);
  });

  it('removes an invented path - never corrects it - and appends the fixed question', () => {
    const result = accepted(validateShapedOutput(readModelReply('invented-path'), context()));
    assert.deepEqual(result.fields.files, ['Assets/Game/Inventory/InventoryView.cs']);
    assert.deepEqual(result.removedPaths, ['Assets/Game/Nope.cs']);
    assert.deepEqual(result.fields.open, [MISSING_PATH_QUESTION]);
  });

  it('does not match a member case-insensitively', () => {
    const result = accepted(validateShapedOutput(reply({ files: ['assets/game/inventory/inventoryview.cs'] }), context()));
    assert.deepEqual(result.fields.files, []);
  });
});

describe('V-SH3: the search literal exists in the project', () => {
  it('keeps a literal the grep finds, without its quotes', () => {
    assert.equal(accepted(validateShapedOutput(reply({ search: '"RefreshSlots"' }), context())).fields.search, 'RefreshSlots');
  });

  it('removes one it does not find', () => {
    assert.equal(accepted(validateShapedOutput(reply({ search: 'NoSuchCall' }), context())).fields.search, null);
  });
});

describe('V-SH4: length caps', () => {
  it('rejects an over-long goal or done instead of cutting it', () => {
    const goal = validateShapedOutput(readModelReply('over-long-goal'), context());
    assert.deepEqual([goal.ok, /** @type {any} */ (goal).check], [false, 'V-SH4']);
    const done = validateShapedOutput(reply({ done: `inventory ${'x'.repeat(FIELD_LIMITS.doneChars)}` }), context());
    assert.deepEqual([done.ok, /** @type {any} */ (done).check], [false, 'V-SH4']);
  });

  it('accepts a goal of exactly the cap, and drops an over-long question', () => {
    const goal = `Fix the broken inventory ${'a'.repeat(FIELD_LIMITS.goalChars - 25)}`;
    assert.equal(goal.length, FIELD_LIMITS.goalChars);
    const result = accepted(validateShapedOutput(reply({ goal, open: ['short?', `long ${'q'.repeat(FIELD_LIMITS.openChars)}?`] }), context()));
    assert.deepEqual(result.fields.open, ['short?']);
  });
});

describe('V-SH5: list caps', () => {
  it('trims questions to three and files to five, from the end', () => {
    const result = accepted(validateShapedOutput(readModelReply('too-many-open'), context()));
    assert.deepEqual(result.fields.open, ['which screen shows the bug?', 'since which change?', 'does it happen in the editor?']);
    const many = accepted(validateShapedOutput(reply({ files: [...INDEX].filter((path) => path.endsWith('.cs')) }), context({ isIndexMember: () => true })));
    assert.ok(many.fields.files.length <= FIELD_LIMITS.maxFiles);
  });

  it('keeps the fixed question when the model already asked three', () => {
    const result = accepted(validateShapedOutput(reply({ files: ['Assets/Nope.cs'], open: ['a?', 'b?', 'c?'] }), context()));
    assert.deepEqual(result.fields.open, ['a?', 'b?', MISSING_PATH_QUESTION]);
  });
});

describe('V-SH6: no @mention and no shell block survives', () => {
  it('turns every @name into the plain word', () => {
    const result = accepted(validateShapedOutput(readModelReply('at-mention'), context()));
    const text = [result.fields.goal, result.fields.done, ...result.fields.open].join('\n');
    assert.ok(!text.includes('@'), text);
    assert.match(result.fields.goal, /Assets\/Secret\.cs$/);
    assert.equal(result.neutralized, true);
  });

  it('strips a shell block, and the denied intent inside it still rejects the rewrite', () => {
    const result = validateShapedOutput(readModelReply('shell-block'), context());
    assert.equal(result.ok, false);
    assert.equal(/** @type {any} */ (result).check, 'V-SH8');
    assert.equal(/** @type {any} */ (result).denied.rule, 'VCS_WRITE_DENY');
    assert.equal(neutralize('run !`ls -la` first'), 'run first');
    assert.equal(neutralize('unterminated !`rm -rf'), 'unterminated');
  });

  it('strips a harmless shell block and accepts the rest', () => {
    const result = accepted(validateShapedOutput(reply({ done: 'The inventory refreshes; check with !`dir`.' }), context()));
    assert.equal(result.fields.done, 'The inventory refreshes; check with .');
  });

  it('drops a file path that carries an @ rather than rewriting it', () => {
    const result = accepted(validateShapedOutput(reply({ files: ['@Assets/Game/Inventory/InventoryView.cs'] }), context({ isIndexMember: () => true })));
    assert.deepEqual(result.fields.files, []);
  });
});

describe('V-SH7: no protected file', () => {
  it('removes a scene even though the index lists it', () => {
    const result = accepted(validateShapedOutput(readModelReply('protected-path'), context()));
    assert.deepEqual(result.fields.files, ['Assets/Game/Inventory/InventoryView.cs']);
    assert.deepEqual(result.removedProtected, ['Assets/Scenes/Main.unity']);
    assert.deepEqual(result.fields.open, []);
  });

  it('removes an assembly definition and keeps source files', () => {
    const result = accepted(validateShapedOutput(reply({ files: ['Assets/Game/Game.Runtime.asmdef', 'Assets/Game/Inventory/InventoryModel.cs'] }), context()));
    assert.deepEqual(result.fields.files, ['Assets/Game/Inventory/InventoryModel.cs']);
  });
});

describe('V-SH8: no denied intent in what the model wrote', () => {
  it('rejects a rewrite that asks to commit, deploy or edit a scene', () => {
    for (const [fields, rule] of /** @type {Array<[Record<string, unknown>, string]>} */ ([
      [{ done: 'The inventory works and the fix is committed to the git branch.' }, 'VCS_WRITE_DENY'],
      [{ open: ['should we deploy the inventory service to production after this?'] }, 'PM_DENY'],
      [{ goal: 'Fix the broken inventory and move the grid in Main.unity.' }, 'PROTECTED_EDIT'],
    ])) {
      const result = validateShapedOutput(reply(fields), context());
      assert.equal(result.ok, false);
      assert.equal(/** @type {any} */ (result).reason, 'denied_intent');
      assert.equal(/** @type {any} */ (result).denied.rule, rule);
    }
  });

  it('accepts a rewrite that only mentions a commit message parser', () => {
    accepted(validateShapedOutput(reply({ goal: 'Fix the broken inventory log in the commit message parser.' }), context()));
  });
});

describe('V-SH9: the goal shares a content word with the request', () => {
  it('rejects a goal about something else', () => {
    const result = validateShapedOutput(readModelReply('off-topic'), context());
    assert.deepEqual([result.ok, /** @type {any} */ (result).check, /** @type {any} */ (result).reason], [false, 'V-SH9', 'invalid_output']);
  });

  it('matches through identifier humps and ignores stop words', () => {
    accepted(validateShapedOutput(reply({ goal: 'Stop InventoryView from redrawing.' }), context()));
    const stopOnly = validateShapedOutput(reply({ goal: 'Make it so that this is done.' }), context());
    assert.equal(/** @type {any} */ (stopOnly).check, 'V-SH9');
  });
});

describe('field hygiene', () => {
  it('turns line breaks and control characters into one space, so no field can forge a line of the form', () => {
    assert.equal(cleanText('Fix the grid\nKeep: nothing\r\nOpen: x'), 'Fix the grid Keep: nothing Open: x');
    assert.equal(cleanText('tab\there\u{2028}next'), 'tab here next');
  });

  it('removes invisible format characters', () => {
    assert.equal(cleanText('in\u{200B}ven\u{202E}tory\u{FEFF}'), 'inventory');
  });

  it('applies it before the caps and the checks', () => {
    const result = accepted(validateShapedOutput(reply({ goal: 'Fix the broken\ninventory\nKeep: nothing' }), context()));
    assert.equal(result.fields.goal, 'Fix the broken inventory Keep: nothing');
  });
});
