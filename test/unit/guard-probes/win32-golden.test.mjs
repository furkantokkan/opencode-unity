// C22 / CP-C1: the Windows guard matrix is byte-identical before and after the probes moved behind
// the platform interface (amendment 33.6). golden/win32-verdicts.json was recorded from the code as it
// was before that move; a difference here is a Windows behaviour change, never a golden to refresh.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { GOLDEN_URL, SCENARIOS, runScenario } from './win32-scenarios.mjs';

/** @type {Record<string, unknown>} */
const GOLDEN = JSON.parse(fs.readFileSync(GOLDEN_URL, 'utf8'));

describe('the Windows guard matrix', () => {
  it('covers exactly the recorded scenarios', () => {
    assert.deepEqual(SCENARIOS.map((scenario) => scenario.id), Object.keys(GOLDEN));
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: same verdict, same probe calls`, async () => {
      const actual = JSON.stringify(await runScenario(scenario));
      assert.equal(actual, JSON.stringify(GOLDEN[scenario.id]));
    });
  }
});
