import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catchError } from '../../helpers/catch-error.mjs';
import {
  ACTION_VERBS,
  MIN_REQUEST_CHARS,
  SHAPE_DEFAULTS,
  assertShapeableText,
  checkGates,
  contentWords,
  countOutcomes,
  evaluateReadiness,
  extractTokens,
  hasActionVerb,
  isIdentifierShaped,
  isMultiHump,
  isSnakeCase,
  resolveShapeSettings,
} from '../../../src/shape/verdict.js';
import { settingsWith } from './helpers.mjs';

describe('shape settings', () => {
  it('uses the defaults of amendment 36.8 when the config has no shape block', () => {
    assert.deepEqual(resolveShapeSettings({}), SHAPE_DEFAULTS);
    assert.deepEqual(resolveShapeSettings(undefined), SHAPE_DEFAULTS);
    assert.deepEqual(SHAPE_DEFAULTS, { mode: 'auto', maxInputChars: 2000, maxOutputTokens: 256, timeoutSec: 60, anchorCandidates: 5, grepTimeoutMs: 2000 });
  });

  it('takes each known key from the config and ignores mistyped values', () => {
    const settings = resolveShapeSettings({ shape: { mode: 'always', maxInputChars: 500, timeoutSec: 'soon', grepTimeoutMs: -1, extra: true } });
    assert.equal(settings.mode, 'always');
    assert.equal(settings.maxInputChars, 500);
    assert.equal(settings.timeoutSec, SHAPE_DEFAULTS.timeoutSec);
    assert.equal(settings.grepTimeoutMs, SHAPE_DEFAULTS.grepTimeoutMs);
    assert.equal(/** @type {any} */ (settings).extra, undefined);
    assert.equal(resolveShapeSettings({ shape: { mode: 'sometimes' } }).mode, 'auto');
    assert.deepEqual(resolveShapeSettings({ shape: ['auto'] }), SHAPE_DEFAULTS);
  });
});

describe('shape gates, in order', () => {
  it('G-a: a trimmed request under three characters is a usage error', async () => {
    assert.equal(MIN_REQUEST_CHARS, 3);
    for (const text of ['', '  ', 'ab', ' a \n']) {
      assert.equal(checkGates(text, settingsWith()).outcome, 'usage');
      const error = await catchError(() => assertShapeableText(text));
      assert.equal(error.exitCode, 1);
    }
    assert.doesNotThrow(() => assertShapeableText('abc'));
  });

  it('G-b: longer than maxInputChars passes through as too_long, before any other gate', () => {
    const text = `commit it ${'x'.repeat(30)}`;
    assert.deepEqual(checkGates(text, settingsWith({ maxInputChars: 20 })), { outcome: 'passthrough', reason: 'too_long', denied: null });
  });

  it('G-c: a denied intent passes through and names its rule, even with shaping switched off', () => {
    const result = checkGates('fix the crash and commit it', settingsWith({ mode: 'off' }));
    assert.equal(result.outcome, 'passthrough');
    assert.equal(result.reason, 'denied_intent');
    assert.equal(result.denied?.rule, 'VCS_WRITE_DENY');
  });

  it('G-d: mode off passes through as disabled', () => {
    assert.deepEqual(checkGates('add a null check', settingsWith({ mode: 'off' })), { outcome: 'passthrough', reason: 'disabled', denied: null });
  });

  it('leaves the verdict to readiness when every gate passed, including in mode always', () => {
    assert.equal(checkGates('add a null check', settingsWith()).outcome, 'open');
    assert.equal(checkGates('add a null check', settingsWith({ mode: 'always' })).outcome, 'open');
  });
});

describe('R1: the action verb', () => {
  it('finds a verb anywhere, in any case', () => {
    assert.equal(hasActionVerb('Fix the grid'), true);
    assert.equal(hasActionVerb('the RefreshSlots call allocates, cache the list'), true);
    assert.equal(hasActionVerb('why does the grid allocate'), true);
  });

  it('finds none in a subject or in another language', () => {
    assert.equal(hasActionVerb('the inventory is broken'), false);
    assert.equal(hasActionVerb('inventory grid'), false);
    assert.equal(hasActionVerb('Das Inventar in InventoryView flackert bei jedem Frame'), false);
  });

  it('keeps the list to English base forms', () => {
    for (const verb of ACTION_VERBS) assert.match(verb, /^[a-z]+$/);
    assert.equal(ACTION_VERBS.has('fixed'), false);
  });
});

describe('R5: outcomes are counted, never split', () => {
  it('counts numbered and bulleted list items', () => {
    assert.equal(countOutcomes('1. one\n2. two\n3) three\n4. four'), 4);
    assert.equal(countOutcomes('- one\n* two'), 2);
    assert.equal(countOutcomes('fix the grid and the list'), 1);
  });
});

describe('tokens', () => {
  it('keeps paths, names and identifiers and skips stop words and plain verbs', () => {
    const tokens = extractTokens('Fix the null check in Assets/Game/Inventory/InventoryView.cs, then rename RefreshSlots.');
    assert.deepEqual(tokens.map((token) => token.text), ['null', 'Assets/Game/Inventory/InventoryView.cs', 'RefreshSlots']);
  });

  it('marks quoted literals, and does not mistake an apostrophe for a quote', () => {
    const tokens = extractTokens(`don't touch the player's "slot_count" or \`Refresh()\``);
    assert.deepEqual(tokens.filter((token) => token.quoted).map((token) => token.text), ['slot_count', 'Refresh()']);
    assert.ok(!tokens.some((token) => token.text.includes("t touch")));
  });

  it('drops duplicates and tokens shorter than three characters', () => {
    const tokens = extractTokens('Grid grid Grid ab');
    assert.deepEqual(tokens.map((token) => token.text), ['Grid', 'grid']);
  });

  it('classifies identifier shapes', () => {
    assert.equal(isMultiHump('RefreshSlots'), true);
    assert.equal(isMultiHump('refreshSlots'), true);
    assert.equal(isMultiHump('HTTPClient'), true);
    assert.equal(isMultiHump('Refresh'), false);
    assert.equal(isSnakeCase('slot_count'), true);
    assert.equal(isSnakeCase('slot'), false);
    assert.equal(isIdentifierShaped('Game.Tests.EditMode'), true);
    assert.equal(isIdentifierShaped('Assets\\Game'), true);
    assert.equal(isIdentifierShaped('inventory'), false);
    assert.equal(isIdentifierShaped('e.g'), false);
  });

  it('evaluateReadiness returns R1, the tokens and R5 together', () => {
    const readiness = evaluateReadiness('add a null check in InventoryView.cs');
    assert.equal(readiness.hasVerb, true);
    assert.equal(readiness.outcomes, 1);
    assert.ok(readiness.tokens.some((token) => token.text === 'InventoryView.cs'));
  });
});

describe('content words (V-SH9)', () => {
  it('splits identifiers at their humps and skips short and stop words', () => {
    assert.deepEqual([...contentWords('the InventoryView is broken')].sort(), ['broken', 'inventory', 'view']);
    assert.deepEqual([...contentWords('HTTPClient fix')].sort(), ['client', 'http']);
  });
});
