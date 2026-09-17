import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { createConsent, decideWithoutPrompt, formatQuestion, isAccepted, parseAnswer } from '../../../src/cli/consent.js';
import { CliError, EXIT } from '../../../src/cli/exit-codes.js';

/** @typedef {import('../../../src/cli/consent.js').ConsentItem} ConsentItem */

/** @type {ConsentItem[]} */
const ITEMS = [
  { id: 'model-pull', title: 'Pull the base model', detail: 'About 19 GiB', recommended: true },
  { id: 'profile-render', title: 'Render the profile', recommended: true },
  { id: 'ollama-env', title: 'Set Ollama server variables for your user', recommended: false },
  { id: 'skill-claude', title: 'Copy the delegate skill', recommended: false },
];

function createPromptSink() {
  const chunks = /** @type {string[]} */ ([]);
  return { write: (/** @type {string} */ text) => chunks.push(text), text: () => chunks.join('') };
}

/**
 * @param {readonly ConsentItem[]} items
 * @param {string} answers
 */
async function ask(items, answers) {
  const input = new PassThrough();
  input.end(answers);
  const prompts = createPromptSink();
  const consent = createConsent({ interactive: true, yes: false, getInput: () => input, prompts });
  const decisions = await consent.request(items);
  return { decisions, prompts: prompts.text() };
}

describe('non-interactive consent', () => {
  it('exits 9 without --yes and lists the items that need consent', async () => {
    const consent = createConsent({ interactive: false, yes: false });
    await assert.rejects(consent.request(ITEMS), (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, EXIT.CONSENT_REQUIRED);
      assert.equal(error.code, 'consent_required');
      assert.deepEqual(/** @type {any} */ (error.data).consents.map((/** @type {{ id: string }} */ item) => item.id), ['model-pull', 'profile-render']);
      assert.match(String(error.hint), /--yes/);
      return true;
    });
  });

  it('includes preselected default-No items in the consent list', () => {
    const items = ITEMS.map((item) => (item.id === 'ollama-env' ? { ...item, preselected: true } : item));
    assert.throws(() => decideWithoutPrompt(items, { yes: false }), /model-pull, profile-render, ollama-env/);
  });

  it('declines default-No items without asking when nothing needs consent', () => {
    const decisions = decideWithoutPrompt([ITEMS[2]], { yes: false });
    assert.deepEqual(decisions, [{ id: 'ollama-env', accepted: false, source: 'not_requested' }]);
  });

  it('--yes accepts only recommended items and explicitly preselected ones', async () => {
    const items = ITEMS.map((item) => (item.id === 'skill-claude' ? { ...item, preselected: true } : item));
    const decisions = await createConsent({ interactive: false, yes: true }).request(items);
    assert.deepEqual(decisions, [
      { id: 'model-pull', accepted: true, source: 'yes_flag' },
      { id: 'profile-render', accepted: true, source: 'yes_flag' },
      { id: 'ollama-env', accepted: false, source: 'not_requested' },
      { id: 'skill-claude', accepted: true, source: 'yes_flag' },
    ]);
    assert.equal(isAccepted(decisions, 'skill-claude'), true);
    assert.equal(isAccepted(decisions, 'ollama-env'), false);
    assert.equal(isAccepted(decisions, 'unknown'), false);
  });

  it('--yes skips prompts in interactive runs too', async () => {
    const consent = createConsent({ interactive: true, yes: true, getInput: () => assert.fail('must not read input') });
    const decisions = await consent.request(ITEMS);
    assert.equal(decisions.filter((decision) => decision.accepted).length, 2);
  });

  it('rejects malformed item lists', async () => {
    const consent = createConsent({ interactive: false, yes: true });
    await assert.rejects(consent.request([ITEMS[0], ITEMS[0]]), /Duplicate consent item/);
    await assert.rejects(consent.request([{ id: '', title: 'x', recommended: true }]), /need an id and a title/);
  });
});

describe('interactive consent', () => {
  it('Enter accepts recommended items and declines default-No items', async () => {
    const { decisions, prompts } = await ask(ITEMS, '\n\n\n\n');
    assert.deepEqual(decisions.map((decision) => [decision.id, decision.accepted, decision.source]), [
      ['model-pull', true, 'default'],
      ['profile-render', true, 'default'],
      ['ollama-env', false, 'default'],
      ['skill-claude', false, 'default'],
    ]);
    assert.match(prompts, /Pull the base model\n {2}About 19 GiB\nAccept\? \[Y\/n\] /);
    assert.match(prompts, /Set Ollama server variables for your user\nAccept\? \[y\/N\] /);
  });

  it('explicit answers win over the defaults, including CRLF input', async () => {
    const { decisions } = await ask(ITEMS, 'n\r\nNO\r\nyes\r\nY\r\n');
    assert.deepEqual(decisions.map((decision) => [decision.accepted, decision.source]), [
      [false, 'answer'],
      [false, 'answer'],
      [true, 'answer'],
      [true, 'answer'],
    ]);
  });

  it('a preselected default-No item defaults to yes', async () => {
    const { decisions, prompts } = await ask([{ ...ITEMS[2], preselected: true }], '\n');
    assert.deepEqual(decisions, [{ id: 'ollama-env', accepted: true, source: 'default' }]);
    assert.match(prompts, /\[Y\/n\]/);
  });

  it('asks again after an invalid answer and declines after three', async () => {
    const retried = await ask([ITEMS[0]], 'maybe\ny\n');
    assert.deepEqual(retried.decisions, [{ id: 'model-pull', accepted: true, source: 'answer' }]);
    assert.match(retried.prompts, /Please answer y or n: /);
    const exhausted = await ask([ITEMS[0], ITEMS[1]], 'a\nb\nc\n\n');
    assert.deepEqual(exhausted.decisions, [
      { id: 'model-pull', accepted: false, source: 'invalid_answer' },
      { id: 'profile-render', accepted: true, source: 'default' },
    ]);
  });

  it('declines the rest when input ends', async () => {
    const { decisions } = await ask(ITEMS, 'y\n');
    assert.deepEqual(decisions.map((decision) => [decision.accepted, decision.source]), [
      [true, 'answer'],
      [false, 'no_input'],
      [false, 'no_input'],
      [false, 'no_input'],
    ]);
  });
});

describe('answer parsing and questions', () => {
  it('parses yes, no, empty and other text', () => {
    assert.equal(parseAnswer('', true), true);
    assert.equal(parseAnswer('  ', false), false);
    assert.equal(parseAnswer('Y', false), true);
    assert.equal(parseAnswer('no', true), false);
    assert.equal(parseAnswer('sure', true), undefined);
  });

  it('shows the recommended answer in capitals', () => {
    assert.match(formatQuestion(ITEMS[1]), /\[Y\/n\] $/);
    assert.match(formatQuestion(ITEMS[3]), /\[y\/N\] $/);
  });
});
