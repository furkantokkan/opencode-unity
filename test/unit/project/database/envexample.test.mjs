import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMemoryFsView, createNodeFsView } from '../../../../src/unity/fs-view.js';
import { createReadBudget } from '../../../../src/project/budget.js';
import { ENV_EXAMPLE_FILES, MAX_ENV_EXAMPLE_KEYS, parseKeyNames, readEnvExampleKeys } from '../../../../src/project/envexample.js';

const WORKSPACES = fileURLToPath(new URL('../../../fixtures/workspaces/', import.meta.url));
const ROOT = process.platform === 'win32' ? 'C:\\env-tests' : '/env-tests';

/** Every value in the hostile trees below is this string, so a leak is a substring search away. */
const CANARY = 'OCU-TEST-ENV-VALUE';

/**
 * @param {Record<string, string>} tree
 * @param {{ dir?: string, maxKeys?: number }} [options]
 */
function read(tree, { dir = '', maxKeys } = {}) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
  const budget = createReadBudget(view, ROOT);
  return { facts: readEnvExampleKeys(budget, { dir, ...(maxKeys === undefined ? {} : { maxKeys }) }), budget };
}

describe('key names, and nothing else', () => {
  it('keeps the names, sorted and deduplicated, and no value in any spelling', () => {
    const text = [
      '# a comment',
      '',
      `DATABASE_URL=postgres://user:${CANARY}@host/db`,
      `export API_TOKEN="${CANARY}"`,
      `PORT = ${CANARY}`,
      `QUOTED='${CANARY}'`,
      `WITH_EQUALS=a=${CANARY}`,
      `WITH_HASH=${CANARY} # trailing`,
      'DATABASE_URL=',
      `MULTILINE="${CANARY}`,
      `${CANARY}-continuation"`,
      'not a key name!=value',
      'NO_SEPARATOR',
      '=leading',
    ].join('\n');

    const { facts } = read({ '.env.example': text });
    assert.deepEqual(facts.keys, ['API_TOKEN', 'DATABASE_URL', 'MULTILINE', 'PORT', 'QUOTED', 'WITH_EQUALS', 'WITH_HASH']);
    assert.equal(JSON.stringify(facts).includes(CANARY), false, 'a value must never reach the facts');
  });

  it('takes nothing from a line whose left side is not a shell-style name', () => {
    assert.deepEqual(parseKeyNames('1_BAD=x\nWITH SPACE=x\nwith-dash=x\nGOOD_ONE=x'), ['GOOD_ONE']);
  });

  it('records a count and keeps at most the cap, sorted', () => {
    const text = Array.from({ length: MAX_ENV_EXAMPLE_KEYS + 4 }, (_, index) => `KEY_${String(index).padStart(2, '0')}=${CANARY}`).join('\n');
    const { facts } = read({ '.env.example': text });
    assert.equal(facts.total, MAX_ENV_EXAMPLE_KEYS + 4);
    assert.equal(facts.keys.length, MAX_ENV_EXAMPLE_KEYS);
    assert.equal(facts.truncated, true);
    assert.equal(facts.keys[0], 'KEY_00');
  });

  it('is absent, not empty, when no template exists', () => {
    const { facts, budget } = read({ 'package.json': '{}' });
    assert.deepEqual([facts.present, facts.file, facts.keys, facts.total], [false, null, [], 0]);
    assert.deepEqual(budget.state.opened, []);
  });
});

describe('which file is opened, and which is refused', () => {
  it('prefers .env.example, then .sample, then .template', () => {
    assert.deepEqual(ENV_EXAMPLE_FILES, ['.env.example', '.env.sample', '.env.template']);
    assert.equal(read({ '.env.example': 'A=', '.env.sample': 'B=', '.env.template': 'C=' }).facts.file, '.env.example');
    assert.equal(read({ '.env.sample': 'B=', '.env.template': 'C=' }).facts.file, '.env.sample');
    assert.equal(read({ '.env.template': 'C=' }).facts.file, '.env.template');
  });

  it('reads the template beside the component, not the one at the workspace root', () => {
    const { facts } = read({ '.env.example': 'ROOT_KEY=', 'functions/.env.example': 'COMPONENT_KEY=' }, { dir: 'functions' });
    assert.deepEqual(facts.keys, ['COMPONENT_KEY']);
    assert.equal(facts.file, 'functions/.env.example');
  });

  it('is refused before a handle is opened for every other .env spelling', () => {
    const { budget } = read({ '.env.example': 'A=' });
    for (const denied of ['.env', '.env.local', '.env.production', 'functions/.env']) {
      assert.equal(budget.readText(denied).status, 'denied', denied);
    }
    assert.deepEqual(budget.state.opened, ['.env.example']);
  });

  it('names the rule that makes the one permitted read legal', () => {
    const { facts } = read({ '.env.example': 'A=' });
    assert.deepEqual(facts.evidence, [{ fact: 'env-keys', signature: 'spec:37.9', file: '.env.example' }]);
  });
});

describe('the committed hostile fixture', () => {
  it('reads the template key names and never opens .env or .env.local', () => {
    const root = path.join(WORKSPACES, 'hostile-workspace');
    const budget = createReadBudget(createNodeFsView(), root);
    const facts = readEnvExampleKeys(budget, {});

    assert.deepEqual(facts.keys, ['API_TOKEN', 'DATABASE_URL', 'PORT']);
    assert.deepEqual(budget.state.opened, ['.env.example']);
    assert.equal(JSON.stringify(facts).includes('OCU-CANARY'), false);
  });
});
