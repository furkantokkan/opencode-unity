import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DENIED_INTENT_GROUPS, describeDeniedIntent, findDeniedIntent, splitClauses } from '../../../src/shape/intent-deny.js';

/**
 * @param {string} text
 * @returns {string | null}
 */
function groupOf(text) {
  return findDeniedIntent(text)?.group ?? null;
}

describe('denied intent: every group', () => {
  /** @type {Record<string, string[]>} */
  const matches = {
    vcs_write: [
      'fix the crash and commit it',
      'commit the changes',
      'fix the crash, then push',
      'git push origin main',
      'merge the feature branch into main',
      'check in the fix to Plastic',
      'tag the release in git',
      'cherry-pick the fix',
      'revert the last changeset',
    ],
    deploy_release: [
      'deploy the functions',
      'fix the crash and deploy',
      'firebase deploy --only functions',
      'npm publish the shared package',
      'make a store build',
      'upload the build to Steam',
      'release version 1.2 to production',
      'ship it to testflight',
    ],
    network_write: [
      'send a POST to https://example.com/hook',
      'POST the scores to https://example.com/api/scores',
      'curl -X POST http://localhost:3000/x',
      'curl -d name=x http://localhost:3000/x',
      'call the webhook when the match ends',
      'send the report to Slack',
      'Invoke-RestMethod -Uri http://localhost:3000/x -Method Post',
    ],
    serialized_asset_edit: [
      'move the spawn point in Main.unity',
      'edit the Main scene',
      'change the player prefab',
      'update the manifest',
      'add a reference to Game.Core in Game.Runtime.asmdef',
      'set the gravity in ProjectSettings/DynamicsManager.asset',
      'rename the input actions',
    ],
    unity_process_control: ['open Unity and run the tests', 'restart the Unity editor', 'run the build in batch mode', 'build with -batchmode'],
    ollama_process_control: ['restart Ollama', 'stop the ollama server then start it'],
  };
  for (const [group, texts] of Object.entries(matches)) {
    for (const text of texts) {
      it(`${group}: "${text}"`, () => assert.equal(groupOf(text), group));
    }
  }

  it('names the rule that answers each group downstream', () => {
    assert.deepEqual(
      Object.fromEntries(DENIED_INTENT_GROUPS.map((group) => [group.id, group.rule])),
      {
        vcs_write: 'VCS_WRITE_DENY',
        deploy_release: 'PM_DENY',
        network_write: 'the network policy',
        serialized_asset_edit: 'PROTECTED_EDIT',
        unity_process_control: 'S12',
        ollama_process_control: 'S13',
      },
    );
    assert.equal(
      describeDeniedIntent(/** @type {any} */ (findDeniedIntent('fix the crash and commit it'))),
      'the request asks for a version-control write, which VCS_WRITE_DENY denies',
    );
  });
});

describe('denied intent: the near-miss corpus is not denied', () => {
  const nearMisses = [
    'fix the commit message parser in CommitLog.cs',
    "fix the deploy script's log format",
    'rename PostProcessor.cs',
    'release the lock after saving in SaveSystem.cs',
    'push it away from the wall in Knockback.cs',
    'fix the push notification crash on Android',
    'merge the two health functions in Health.cs',
    'add a scene loader',
    'add a fade when the scene loads',
    'fix the scene transition in SceneFader.cs',
    'add a null check in PlayerController.cs used by Main.unity',
    'start the Unity coroutine for loading',
    'add validation to the POST /scores route in src/server.ts',
    'delete the unused method in Inventory.cs',
    'publish the event on the event bus',
    'read the remote config value for the drop rate',
    'Stop the inventory grid from re-allocating every frame.',
  ];
  for (const text of nearMisses) {
    it(`"${text}"`, () => assert.equal(groupOf(text), null));
  }
});

describe('denied intent: matching discipline', () => {
  it('binds verb and object inside one clause, not across sentences', () => {
    assert.equal(groupOf('Fix the login bug. The branch name is in Settings.cs'), null);
    assert.equal(groupOf('fix the login bug and push the branch'), 'vcs_write');
  });

  it('is case-insensitive', () => {
    assert.equal(groupOf('FIX THE CRASH AND COMMIT IT'), 'vcs_write');
    assert.equal(groupOf('Deploy The Functions'), 'deploy_release');
  });

  it('keeps dotted names whole when it splits clauses', () => {
    assert.deepEqual(splitClauses('Fix Main.unity. Then commit; done!\nnext'), ['Fix Main.unity', 'Then commit', 'done', 'next']);
  });

  it('takes the first group in table order when several match', () => {
    assert.equal(groupOf('deploy the functions and commit it'), 'vcs_write');
  });
});
